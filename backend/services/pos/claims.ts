import { readCommand } from './ledger.ts';
import { approvalCommand } from './sales.ts';
import { fingerprint, integer, object, PosError, uuid, validKey, type PosTx } from './wire.ts';

type Claim = {
  claimId: string;
  commandKey: string;
  kind: 'reservation_first_order' | 'membership_use';
  sourceId: string;
  sourceVersion: number;
  reservationBinding?: { actorId: string; tableId: string | null; expiresAt: string };
};

export const operatingBillCommand = 'bill.create_record';
const fields = `claim_id AS "claimId", command_key AS "commandKey", kind, source_id AS "sourceId", source_version AS "sourceVersion",
  reservation_actor_id AS "reservationActorId", reservation_table_id AS "reservationTableId", reservation_expires_at AS "reservationExpiresAt"`;
type ClaimRow = Omit<Claim, 'reservationBinding'> & { reservationActorId: string | null; reservationTableId: string | null; reservationExpiresAt: Date | null };
function projectClaim({ reservationActorId, reservationTableId, reservationExpiresAt, ...claim }: ClaimRow): Claim {
  return { ...claim, ...(reservationActorId && reservationExpiresAt && { reservationBinding: {
    actorId: reservationActorId, tableId: reservationTableId, expiresAt: reservationExpiresAt.toISOString(),
  } }) };
}

export function parseClaim(value: unknown): Claim {
  const body = object(value, ['claimId', 'commandKey', 'kind', 'sourceId', 'sourceVersion', 'reservationBinding']);
  if (!validKey(body.commandKey) || (body.kind !== 'reservation_first_order' && body.kind !== 'membership_use')) {
    throw new PosError(400, 'INVALID_REQUEST');
  }
  let reservationBinding: Claim['reservationBinding'];
  if (body.reservationBinding !== undefined) {
    const binding = object(body.reservationBinding, ['actorId', 'tableId', 'expiresAt']);
    if (body.kind !== 'reservation_first_order' || typeof binding.expiresAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(binding.expiresAt) || !Number.isFinite(Date.parse(binding.expiresAt))) {
      throw new PosError(400, 'INVALID_REQUEST');
    }
    reservationBinding = { actorId: uuid(binding.actorId), tableId: binding.tableId === null ? null : uuid(binding.tableId),
      expiresAt: new Date(binding.expiresAt).toISOString() };
  }
  return {
    claimId: uuid(body.claimId), commandKey: body.commandKey, kind: body.kind,
    sourceId: uuid(body.sourceId), sourceVersion: integer(body.sourceVersion, 1, 2_147_483_647),
    ...(reservationBinding && { reservationBinding }),
  };
}

/** Bind a source version to a POS command. Customer remains authoritative for reservation and use state. */
export async function linkClaim(tx: PosTx, claim: Claim) {
  const { rows } = await tx.db.query<ClaimRow>(`
    SELECT ${fields}
    FROM pos.customer_claim WHERE store_id = $1 AND (claim_id = $2 OR command_key = $3)
  `, [tx.storeId, claim.claimId, claim.commandKey]);
  if (rows.length) {
    if (rows.length === 1) {
      const previous = projectClaim(rows[0]);
      if (fingerprint(previous) === fingerprint(claim)) return previous;
    }
    throw new PosError(409, 'CLAIM_MISMATCH');
  }
  if (await readCommand(tx, approvalCommand, claim.commandKey) || await readCommand(tx, operatingBillCommand, claim.commandKey)) {
    throw new PosError(409, 'COMMAND_ALREADY_STARTED');
  }

  const binding = claim.reservationBinding;
  if (binding) await tx.db.query('INSERT INTO pos.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [tx.storeId]);

  await tx.db.query(`
    INSERT INTO pos.customer_claim (store_id, claim_id, command_key, kind, source_id, source_version,
      reservation_actor_id, reservation_table_id, reservation_expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [tx.storeId, claim.claimId, claim.commandKey, claim.kind, claim.sourceId, claim.sourceVersion,
    binding?.actorId ?? null, binding?.tableId ?? null, binding?.expiresAt ?? null]);
  return claim;
}

export async function assertReservationBinding(tx: PosTx, key: string, id: string | undefined, tableId: string | null) {
  const { rows: [row] } = await tx.db.query<ClaimRow>(
    `SELECT ${fields} FROM pos.customer_claim WHERE store_id = $1 AND command_key = $2 AND reservation_actor_id IS NOT NULL`,
    [tx.storeId, key]);
  if (!row) {
    if (id) throw new PosError(409, 'RESERVATION_CLAIM_REQUIRED');
    return null;
  }
  if (id !== row.sourceId || row.reservationActorId !== tx.actorId || row.reservationTableId !== tableId) {
    throw new PosError(409, 'RESERVATION_CLAIM_MISMATCH');
  }
  if (!row.reservationExpiresAt || row.reservationExpiresAt <= tx.at) throw new PosError(409, 'RESERVATION_CLAIM_EXPIRED');
  if (await readCommand(tx, approvalCommand, key)) throw new PosError(409, 'COMMAND_ABORTED');
  return { claimId: row.claimId, reservationId: row.sourceId, sourceVersion: row.sourceVersion };
}

type LinkedOrder = { orderId: string; billId: string; tableId: string | null };
type OperatingReceipt = { reservationLink?: LinkedOrder };

export async function commandOutcome(tx: PosTx, key: string) {
  const linked = (await readCommand<OperatingReceipt>(tx, operatingBillCommand, key))?.receipt?.reservationLink;
  if (linked) return { status: 'linked', result: linked };
  const command = await readCommand(tx, approvalCommand, key);
  return { status: command?.status ?? 'missing', result: command?.terminalReceipt ?? null };
}

export async function abortCommand(tx: PosTx, key: string, claimId: string) {
  const { rowCount } = await tx.db.query(`
    SELECT 1 FROM pos.customer_claim WHERE store_id = $1 AND claim_id = $2 AND command_key = $3
  `, [tx.storeId, claimId, key]);
  if (!rowCount) throw new PosError(409, 'CLAIM_MISMATCH');

  const linked = (await readCommand<OperatingReceipt>(tx, operatingBillCommand, key))?.receipt?.reservationLink;
  if (linked) return { status: 'linked', result: linked };
  const command = await readCommand(tx, approvalCommand, key);
  if (command && command.status !== 'pending') return commandOutcome(tx, key);

  const result = new PosError(409, 'COMMAND_ABORTED').result;
  await tx.db.query(`
    INSERT INTO pos.command_ledger (store_id, command_type, command_key, status, terminal_receipt)
    VALUES ($1, $2, $3, 'aborted', $4)
    ON CONFLICT (store_id, command_type, command_key) DO UPDATE
    SET status = 'aborted', terminal_receipt = EXCLUDED.terminal_receipt
    WHERE pos.command_ledger.status = 'pending'
  `, [tx.storeId, approvalCommand, key, result]);
  return { status: 'aborted', result };
}
