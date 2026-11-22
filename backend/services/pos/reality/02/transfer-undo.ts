import type { BillDraft, SaleLine } from '../../catalog.ts';
import { applyCommand, openDay } from '../../ledger.ts';
import { assertNoPendingApproval, readBill, billOrderIds } from '../../sales.ts';
import { commandReceipt, object, PosError, type PosTx } from '../../wire.ts';
import { activeTableId, endTableSession, openTableSession, readTable } from './tables.ts';

export const transferSources = ['pos.bills', 'pos.orders', 'pos.tables'];
export type TransferKind = 'move' | 'merge' | 'separate';
export const transferCommand = { move: 'bill.move_table', merge: 'bill.merge_tables', separate: 'bill.separate_table' } as const;

type PriorBill = { billId: string; draft: BillDraft | null; tableId: string | null; openedAt: Date | null };
type Effect = {
  kind: TransferKind;
  day: string;
  eventId: string;
  orderIds: string[];
  before: PriorBill[];
  after: { billId: string; revision: number; status: string; tableId: string | null }[];
  tables: { tableId: string; revision: number }[];
};

export async function captureTransferBill(tx: PosTx, billId: string, draft: BillDraft, tableId: string): Promise<PriorBill> {
  const { openedAt } = await readTable(tx, tableId);
  return { billId, draft, tableId, openedAt };
}

export async function saveTransferReceipt<T extends ReturnType<typeof commandReceipt>>(tx: PosTx, key: string, receipt: T,
  effect: Omit<Effect, 'after' | 'tables'>, tableIds: string[]) {
  const after = [];
  for (const { billId } of effect.before) {
    const { revision, status } = await readBill(tx, billId);
    after.push({ billId, revision, status, tableId: await activeTableId(tx, billId) });
  }
  const tables = [];
  for (const tableId of tableIds) {
    const { revision } = await readTable(tx, tableId);
    tables.push({ tableId, revision });
  }
  const undoUntil = new Date(tx.at.getTime() + 6000).toISOString();
  await tx.db.query(`INSERT INTO pos.table_transfer_receipt
    (store_id, receipt_id, actor_id, command_type, command_key, undo_until, effect) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [tx.storeId, receipt.receiptId, tx.actorId, transferCommand[effect.kind], key, undoUntil, { ...effect, after, tables } satisfies Effect]);
  return { ...receipt, undoUntil };
}

export async function insertAllocations(tx: PosTx, billId: string, lines: SaleLine[]) {
  await tx.db.query(`INSERT INTO pos.bill_allocation (store_id, bill_id, allocation_id, order_line_id, quantity)
    SELECT $1, $2, line."allocationId", line."orderLineId", line.qty
    FROM jsonb_to_recordset($3::jsonb) AS line("allocationId" uuid, "orderLineId" uuid, qty integer)`,
  [tx.storeId, billId, JSON.stringify(lines)]);
}

export function undoTransfer(tx: PosTx, key: string, receiptId: string, body: unknown) {
  object(body, []);
  return applyCommand(tx, 'bill.undo_transfer', key, { receiptId }, async () => {
    const { rows: [row] } = await tx.db.query<{ undoUntil: Date; commandKey: string; effect: Effect; status: string }>(`
      SELECT r.undo_until AS "undoUntil", r.command_key AS "commandKey", r.effect, c.status
      FROM pos.table_transfer_receipt r JOIN pos.command_ledger c USING (store_id, command_type, command_key)
      WHERE r.store_id = $1 AND r.receipt_id = $2 AND r.actor_id = $3`,
    [tx.storeId, receiptId, tx.actorId]);
    if (!row) throw new PosError(404, 'RECEIPT_NOT_FOUND');
    if (row.status !== 'committed') throw new PosError(409, 'COMMAND_UNDONE');
    if (row.undoUntil <= tx.at) throw new PosError(409, 'UNDO_EXPIRED');
    const { effect } = row;
    if (await openDay(tx) !== effect.day) throw new PosError(409, 'DAY_CLOSED');
    for (const after of effect.after) {
      const bill = await readBill(tx, after.billId);
      if (bill.revision !== after.revision || bill.status !== after.status) throw new PosError(409, 'UNDO_UNAVAILABLE');
      await assertNoPendingApproval(tx, after.billId);
    }
    for (const table of effect.tables) {
      if ((await readTable(tx, table.tableId)).revision !== table.revision) throw new PosError(409, 'UNDO_UNAVAILABLE');
    }

    const changes = effect.before.flatMap((before, index) =>
      before.tableId !== effect.after[index].tableId ? [{ before, current: effect.after[index].tableId }] : []);
    for (const { before, current } of changes) {
      if (current) await endTableSession(tx, before.billId, 'empty');
    }
    for (const { before } of changes) {
      if (!before.tableId) continue;
      const { revision } = await readTable(tx, before.tableId);
      await openTableSession(tx, { tableId: before.tableId, expectedRevision: revision }, before.billId,
        before.openedAt ? new Date(before.openedAt) : tx.at);
    }
    if (effect.kind !== 'move') {
      await tx.db.query('DELETE FROM pos.bill_allocation WHERE store_id = $1 AND bill_id = ANY($2::uuid[])',
        [tx.storeId, effect.before.map(bill => bill.billId)]);
    }
    for (const { billId, draft } of effect.before) {
      await tx.db.query(`UPDATE pos.bill SET status = $3, draft = coalesce($4, draft),
        revision = revision + 1 + (status <> 'open' AND $3 = 'open')::integer
        WHERE store_id = $1 AND bill_id = $2`, [tx.storeId, billId, draft ? 'open' : 'void', draft]);
      if (effect.kind !== 'move' && draft) await insertAllocations(tx, billId, draft.quote.lines);
    }
    await tx.db.query(`UPDATE pos.pos_order o SET revision = revision + 1,
      status_history = coalesce((SELECT jsonb_agg(entry ORDER BY ord) FROM jsonb_array_elements(o.status_history)
        WITH ORDINALITY AS h(entry, ord) WHERE entry->>'eventId' <> $3), '[]'::jsonb)
      WHERE store_id = $1 AND order_id = ANY($2::uuid[])`, [tx.storeId, effect.orderIds, effect.eventId]);
    await tx.db.query(`UPDATE pos.command_ledger SET status = 'aborted'
      WHERE store_id = $1 AND command_type = $2 AND command_key = $3`, [tx.storeId, transferCommand[effect.kind], row.commandKey]);
    const { billId, draft } = effect.before[0];
    return { ...commandReceipt(billId, effect.after[0].revision + (effect.after[0].status === 'open' ? 1 : 2), transferSources),
      quote: draft?.quote, orderIds: await billOrderIds(tx, billId) };
  });
}
