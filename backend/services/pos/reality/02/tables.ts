import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '../../../../packages/contracts/events.ts';
import { appendOutbox, applyCommand } from '../../ledger.ts';
import { commandReceipt, integer, object, PosError, uuid, type PosTx } from '../../wire.ts';

type TableState = 'empty' | 'occupied' | 'cleaning' | 'archived';
type StoredTable = { tableId: string; label: string; seats: number; revision: number; state: TableState };
type Table = StoredTable & { billId: string | null; openedAt: Date | null; layoutTableId: string | null; lastBillId: string | null };
type TableChanged = EventEnvelope<'pos', 'pos.table_changed.v1', StoredTable>;
type SessionChanged = EventEnvelope<'pos', 'pos.table_session_changed.v1', {
  tableId: string; billId: string; state: 'occupied' | 'cleaning' | 'empty'; revision: number;
}>;

export const tableStates = ['empty', 'occupied', 'cleaning', 'archived'] as const;

const tableSelect = `SELECT t.table_id AS "tableId", t.label, t.seats, t.revision, t.state,
    s.bill_id AS "billId", s.opened_at AS "openedAt", t.layout_table_id AS "layoutTableId",
    last.bill_id AS "lastBillId" FROM pos.store_table t
  LEFT JOIN pos.table_session s ON (t.store_id, t.table_id) = (s.store_id, s.table_id) AND s.ended_at IS NULL
  LEFT JOIN LATERAL (SELECT bill_id FROM pos.table_session WHERE store_id = t.store_id AND table_id = t.table_id
    AND t.state = 'cleaning' AND ended_at IS NOT NULL ORDER BY open_ordinal DESC LIMIT 1) last ON true`;

export async function readTable({ db, storeId }: PosTx, tableId: string) {
  const { rows: [table] } = await db.query<Table>(`${tableSelect} WHERE t.store_id = $1 AND t.table_id = $2`, [storeId, tableId]);
  if (!table) throw new PosError(404, 'TABLE_NOT_FOUND');
  return table;
}

export async function listTables({ db, storeId }: PosTx, { cursor, limit, filter }: {
  cursor: string | null; limit: number; filter: TableState | null;
}) {
  const { rows } = await db.query<Table>(`${tableSelect} WHERE t.store_id = $1
    AND ($2::uuid IS NULL OR t.table_id > $2)
    AND (CASE WHEN $3::text IS NULL THEN t.state <> 'archived' ELSE t.state = $3 END)
    ORDER BY t.table_id LIMIT $4`, [storeId, cursor, filter, limit + 1]);
  return rows;
}

function label(value: unknown) {
  if (typeof value !== 'string') throw new PosError(400, 'INVALID_TABLE_LABEL');
  const cleaned = value.trim().normalize('NFC');
  if (!cleaned || [...cleaned].length > 40 || /[\p{Cc}\p{Cf}]/u.test(cleaned)) {
    throw new PosError(400, 'INVALID_TABLE_LABEL');
  }
  return cleaned;
}

async function tableChanged(tx: PosTx, table: StoredTable) {
  const { tableId, label, seats, revision, state } = table;
  await appendOutbox<TableChanged>(tx, 'pos.table_changed.v1', tableId, { tableId, label, seats, revision, state });
  return commandReceipt(tableId, revision, ['pos.tables']);
}

export function createTable(tx: PosTx, key: string, body: unknown) {
  const input = object(body, ['label', 'seats', 'layoutTableId']);
  const { layoutTableId } = input;
  if (layoutTableId !== undefined && (typeof layoutTableId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(layoutTableId))) {
    throw new PosError(400, 'INVALID_LAYOUT_TABLE');
  }
  const draft = { label: label(input.label), seats: integer(input.seats, 1, 30), layoutTableId };
  return applyCommand(tx, 'table.create', key, draft, async () => {
    if (layoutTableId !== undefined) {
      const { rows: [existing] } = await tx.db.query<{ tableId: string; revision: number }>(`
        SELECT table_id AS "tableId", revision FROM pos.store_table
        WHERE store_id = $1 AND layout_table_id = $2 AND state <> 'archived'`, [tx.storeId, layoutTableId]);
      if (existing) return commandReceipt(existing.tableId, existing.revision, ['pos.tables']);
    }
    const { rows: [table] } = await tx.db.query<StoredTable>(`
      INSERT INTO pos.store_table (store_id, table_id, label, seats, layout_table_id) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING RETURNING table_id AS "tableId", label, seats, state, revision
    `, [tx.storeId, randomUUID(), draft.label, draft.seats, draft.layoutTableId ?? null]);
    if (!table) throw new PosError(409, 'TABLE_LABEL_EXISTS');
    return tableChanged(tx, table);
  });
}

export function confirm(value: unknown) {
  if (value !== true) throw new PosError(400, 'CONFIRMATION_REQUIRED');
}

export function changeTable(tx: PosTx, key: string, tableId: string, body: unknown, archive = false) {
  const input = object(body, archive ? ['expectedRevision', 'confirmed'] : ['expectedRevision', 'label', 'seats', 'state']);
  if (archive) confirm(input.confirmed);
  if (input.state !== undefined && input.state !== 'empty') throw new PosError(400, 'INVALID_TABLE_STATE');
  const change = {
    tableId, expectedRevision: integer(input.expectedRevision, 1),
    label: input.label === undefined ? undefined : label(input.label),
    seats: input.seats === undefined ? undefined : integer(input.seats, 1, 30),
    state: archive ? 'archived' : input.state,
  } as const;
  if (change.label === undefined && change.seats === undefined && change.state === undefined) {
    throw new PosError(400, 'INVALID_REQUEST');
  }
  return applyCommand(tx, archive ? 'table.archive' : 'table.change', key, change, async () => {
    const table = await readTable(tx, tableId);
    if (table.revision !== change.expectedRevision) throw new PosError(409, 'STALE_REVISION', { revision: table.revision });
    if (table.state === 'archived') throw new PosError(404, 'TABLE_NOT_FOUND');
    if (table.state === 'occupied' || (archive && table.state === 'cleaning')) throw new PosError(409, 'TABLE_BUSY');
    const updatedLabel = change.label ?? table.label;
    const duplicate = await tx.db.query(`SELECT 1 FROM pos.store_table
      WHERE store_id = $1 AND table_id <> $2 AND state <> 'archived' AND lower(label) = lower($3)`,
    [tx.storeId, tableId, updatedLabel]);
    if (duplicate.rowCount) throw new PosError(409, 'TABLE_LABEL_EXISTS');
    const { rows: [updated] } = await tx.db.query<StoredTable>(`UPDATE pos.store_table
      SET label = $3, seats = $4, state = $5, revision = revision + 1 WHERE store_id = $1 AND table_id = $2
      RETURNING table_id AS "tableId", label, seats, state, revision`,
    [tx.storeId, tableId, updatedLabel, change.seats ?? table.seats, change.state ?? table.state]);
    return tableChanged(tx, updated);
  });
}

export function parseTableRef(value: unknown) {
  if (value === undefined) return null;
  const input = object(value, ['tableId', 'expectedRevision']);
  return { tableId: uuid(input.tableId), expectedRevision: integer(input.expectedRevision, 1) };
}

export async function activeTableId({ db, storeId }: PosTx, billId: string) {
  const { rows: [session] } = await db.query<{ tableId: string }>(`
    SELECT table_id AS "tableId" FROM pos.table_session WHERE store_id = $1 AND bill_id = $2 AND ended_at IS NULL
  `, [storeId, billId]);
  return session?.tableId ?? null;
}

async function setSessionState(tx: PosTx, tableId: string, billId: string, state: 'empty' | 'occupied' | 'cleaning') {
  const { rows: [{ revision }] } = await tx.db.query<{ revision: number }>(`UPDATE pos.store_table
    SET state = $3, revision = revision + 1 WHERE store_id = $1 AND table_id = $2 RETURNING revision`,
  [tx.storeId, tableId, state]);
  await appendOutbox<SessionChanged>(tx, 'pos.table_session_changed.v1', tableId, { tableId, billId, state, revision });
}

export async function openTableSession(tx: PosTx, reference: NonNullable<ReturnType<typeof parseTableRef>>, billId: string,
  openedAt = tx.at) {
  const table = await readTable(tx, reference.tableId);
  if (table.revision !== reference.expectedRevision) throw new PosError(409, 'STALE_REVISION', { revision: table.revision });
  if (table.state !== 'empty') throw new PosError(409, 'TABLE_BUSY');
  await tx.db.query(`INSERT INTO pos.table_session (store_id, bill_id, table_id, opened_at) VALUES ($1, $2, $3, $4)`,
    [tx.storeId, billId, table.tableId, openedAt]);
  await setSessionState(tx, table.tableId, billId, 'occupied');
}

export async function endTableSession(tx: PosTx, billId: string, state: 'empty' | 'cleaning') {
  const { rows: [session] } = await tx.db.query<{ tableId: string }>(`UPDATE pos.table_session
    SET ended_at = $3 WHERE store_id = $1 AND bill_id = $2 AND ended_at IS NULL RETURNING table_id AS "tableId"`,
  [tx.storeId, billId, tx.at]);
  if (!session) return false;
  await setSessionState(tx, session.tableId, billId, state);
  return true;
}
