import { readCommand } from './ledger.ts';
import { approvalCommand } from './sales.ts';
import { fingerprint, integer, object, PosError, uuid, validKey, type PosTx } from './wire.ts';

type Claim = {
  claimId: string;
  commandKey: string;
  kind: 'reservation_first_order' | 'membership_use';
  sourceId: string;
  sourceVersion: number;
};

export function parseClaim(value: unknown): Claim {
  const body = object(value, ['claimId', 'commandKey', 'kind', 'sourceId', 'sourceVersion']);
  if (!validKey(body.commandKey) || (body.kind !== 'reservation_first_order' && body.kind !== 'membership_use')) {
    throw new PosError(400, 'INVALID_REQUEST');
  }
  return {
    claimId: uuid(body.claimId), commandKey: body.commandKey, kind: body.kind,
    sourceId: uuid(body.sourceId), sourceVersion: integer(body.sourceVersion, 1, 2_147_483_647),
  };
}

/** Bind a source version to a POS command. Customer remains authoritative for reservation and use state. */
export async function linkClaim(tx: PosTx, claim: Claim) {
  const { rows } = await tx.db.query<Claim>(`
    SELECT claim_id AS "claimId", command_key AS "commandKey", kind, source_id AS "sourceId", source_version AS "sourceVersion"
    FROM pos.customer_claim WHERE store_id = $1 AND (claim_id = $2 OR command_key = $3)
  `, [tx.storeId, claim.claimId, claim.commandKey]);
  if (rows.length) {
    if (rows.length === 1 && fingerprint(rows[0]) === fingerprint(claim)) return rows[0];
    throw new PosError(409, 'CLAIM_MISMATCH');
  }
  if (await readCommand(tx, approvalCommand, claim.commandKey)) throw new PosError(409, 'COMMAND_ALREADY_STARTED');

  await tx.db.query(`
    INSERT INTO pos.customer_claim (store_id, claim_id, command_key, kind, source_id, source_version)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [tx.storeId, claim.claimId, claim.commandKey, claim.kind, claim.sourceId, claim.sourceVersion]);
  return claim;
}

export async function commandOutcome(tx: PosTx, key: string) {
  const command = await readCommand(tx, approvalCommand, key);
  return { status: command?.status ?? 'missing', result: command?.terminalReceipt ?? null };
}

export async function abortCommand(tx: PosTx, key: string, claimId: string) {
  const { rowCount } = await tx.db.query(`
    SELECT 1 FROM pos.customer_claim WHERE store_id = $1 AND claim_id = $2 AND command_key = $3
  `, [tx.storeId, claimId, key]);
  if (!rowCount) throw new PosError(409, 'CLAIM_MISMATCH');

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
