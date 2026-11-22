import { randomUUID } from 'node:crypto';
import { apportion, parseBill, quoteBill, quoteFromLines, type BillDraft, type ReadPosCatalog, type SaleLine } from '../../catalog.ts';
import { applyCommand, nextBusinessSequence, openDay } from '../../ledger.ts';
import { assertNoPendingApproval, billOrderIds, insertOrder, readBill } from '../../sales.ts';
import { commandReceipt, integer, object, PosError, uuid, type PosTx } from '../../wire.ts';
import { activeTableId, endTableSession, openTableSession, parseTableRef } from './tables.ts';
import { captureTransferBill, insertAllocations, saveTransferReceipt, transferCommand,
  transferSources as sources, type TransferKind } from './transfer-undo.ts';

type Bill = Awaited<ReturnType<typeof readBill>>;

async function editableBill(tx: PosTx, billId: string, revision: number) {
  const bill = await readBill(tx, billId);
  const currentRevision = bill.revision + Number(bill.status !== 'open');
  if (currentRevision !== revision) throw new PosError(409, 'STALE_REVISION', { revision: currentRevision });
  if (bill.status !== 'open') throw new PosError(409, 'BILL_LOCKED');
  if (await openDay(tx) !== bill.day) throw new PosError(409, 'DAY_CLOSED');
  await assertNoPendingApproval(tx, billId);
  const tableId = await activeTableId(tx, billId);
  if (!bill.draft.postpaid) {
    // An existing B02 table bill can have a draft and no accepted order.
    if (!tableId) throw new PosError(409, 'BILL_LOCKED');
    await acceptOrder(tx, billId, bill.day, bill.draft.quote.lines);
    bill.draft.postpaid = true;
  }
  return { ...bill, tableId };
}

export async function acceptOrder(tx: PosTx, billId: string, day: string, lines: SaleLine[]) {
  return insertOrder(tx, billId, day, lines, await nextBusinessSequence(tx, day));
}

async function updateDraft(tx: PosTx, billId: string, draft: BillDraft) {
  await tx.db.query('UPDATE pos.bill SET draft = $3, revision = revision + 1 WHERE store_id = $1 AND bill_id = $2',
    [tx.storeId, billId, draft]);
}

function checkSize(lines: BillDraft['request']['lines']) {
  if (lines.length > 100 || new Set(lines.map(line => line.menuId)).size > 25) throw new PosError(400, 'ORDER_LIMIT');
}

export function appendOrder(tx: PosTx, key: string, billId: string, body: unknown, readCatalog?: ReadPosCatalog) {
  const input = object(body, ['expectedRevision', 'lines']);
  const expectedRevision = integer(input.expectedRevision, 1);
  const { lines } = parseBill({ type: 'dine_in', lines: input.lines });
  return applyCommand(tx, 'bill.submit_order', key, { billId, expectedRevision, lines }, async () => {
    const { day, draft } = await editableBill(tx, billId, expectedRevision);
    const request = { ...draft.request, lines: [...draft.request.lines, ...lines] };
    checkSize(request.lines);
    const quote = await quoteBill(tx, request, draft.quote, readCatalog, draft.fixedDiscounts);
    const orderId = await acceptOrder(tx, billId, day, quote.lines.slice(draft.request.lines.length));
    await updateDraft(tx, billId, { ...draft, request, quote });
    return { ...commandReceipt(billId, expectedRevision + 1, sources), quote, orderId, orderIds: await billOrderIds(tx, billId) };
  });
}

function destination(input: unknown) {
  const table = parseTableRef(input);
  if (!table) throw new PosError(400, 'TABLE_REQUIRED');
  return table;
}

async function history(tx: PosTx, orderIds: string[], kind: TransferKind,
  fromTableId: string, toTableId: string, sourceBillId: string, targetBillId: string) {
  const eventId = randomUUID();
  const events = JSON.stringify([{ eventId, kind, at: tx.at, fromTableId, toTableId, sourceBillId, targetBillId }]);
  await tx.db.query(`UPDATE pos.pos_order SET status_history = status_history || $3::jsonb, revision = revision + 1
    WHERE store_id = $1 AND order_id = ANY($2::uuid[])`, [tx.storeId, orderIds, events]);
  return eventId;
}

function withLines(lines: SaleLine[]): BillDraft {
  const quote = quoteFromLines(lines);
  const request = { type: 'dine_in', discount: quote.discount, lines: lines.map(line => ({
    menuId: line.menuId, qty: line.qty, optionIds: line.options.map(option => option.optionId),
  })) } as const;
  checkSize(request.lines);
  return { request, quote, postpaid: true, fixedDiscounts: true };
}

function requireSourceTable(bill: Bill & { tableId: string | null }) {
  if (!bill.tableId) throw new PosError(409, 'STATE_CONFLICT');
  return bill.tableId;
}

export function moveBill(tx: PosTx, key: string, billId: string, body: unknown) {
  const input = object(body, ['expectedRevision', 'table']);
  const expectedRevision = integer(input.expectedRevision, 1);
  const table = destination(input.table);
  return applyCommand(tx, transferCommand.move, key, { billId, expectedRevision, table }, async () => {
    const bill = await editableBill(tx, billId, expectedRevision);
    const from = requireSourceTable(bill);
    if (from === table.tableId) throw new PosError(409, 'NO_DESTINATION');
    const prior = await captureTransferBill(tx, billId, bill.draft, from);
    await endTableSession(tx, billId, 'empty');
    await openTableSession(tx, table, billId);
    await updateDraft(tx, billId, bill.draft);
    const orderIds = await billOrderIds(tx, billId);
    const eventId = await history(tx, orderIds, 'move', from, table.tableId, billId, billId);
    const receipt = { ...commandReceipt(billId, expectedRevision + 1, sources), quote: bill.draft.quote, orderIds };
    return saveTransferReceipt(tx, key, receipt, { kind: 'move', day: bill.day, eventId, orderIds, before: [prior] },
      [from, table.tableId]);
  });
}

export function mergeBills(tx: PosTx, key: string, billId: string, body: unknown) {
  const input = object(body, ['expectedRevision', 'targetBillId', 'targetExpectedRevision']);
  const expectedRevision = integer(input.expectedRevision, 1);
  const targetBillId = uuid(input.targetBillId);
  const targetExpectedRevision = integer(input.targetExpectedRevision, 1);
  if (billId === targetBillId) throw new PosError(409, 'NO_DESTINATION');
  return applyCommand(tx, transferCommand.merge, key, { billId, expectedRevision, targetBillId, targetExpectedRevision }, async () => {
    const source = await editableBill(tx, billId, expectedRevision);
    const target = await editableBill(tx, targetBillId, targetExpectedRevision);
    const from = requireSourceTable(source);
    const to = requireSourceTable(target);
    const draft = withLines([...target.draft.quote.lines, ...source.draft.quote.lines]);
    const priorSource = await captureTransferBill(tx, billId, source.draft, from);
    const priorTarget = await captureTransferBill(tx, targetBillId, target.draft, to);
    await tx.db.query('UPDATE pos.bill_allocation SET bill_id = $3 WHERE store_id = $1 AND bill_id = $2',
      [tx.storeId, billId, targetBillId]);
    await tx.db.query("UPDATE pos.bill SET status = 'void' WHERE store_id = $1 AND bill_id = $2", [tx.storeId, billId]);
    await endTableSession(tx, billId, 'empty');
    await updateDraft(tx, targetBillId, draft);
    const orderIds = await billOrderIds(tx, targetBillId);
    const eventId = await history(tx, orderIds, 'merge', from, to, billId, targetBillId);
    const receipt = { ...commandReceipt(targetBillId, targetExpectedRevision + 1, sources), quote: draft.quote, orderIds };
    return saveTransferReceipt(tx, key, receipt, { kind: 'merge', day: source.day, eventId, orderIds,
      before: [priorSource, priorTarget] }, [from, to]);
  });
}

function selection(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new PosError(400, 'QTY_ALLOCATION_INVALID');
  const lines = value.map(row => {
    const line = object(row, ['orderLineId', 'qty']);
    return { orderLineId: uuid(line.orderLineId), qty: integer(line.qty, 1, 99, 'QTY_ALLOCATION_INVALID') };
  }).sort((a, b) => a.orderLineId.localeCompare(b.orderLineId));
  if (new Set(lines.map(line => line.orderLineId)).size !== lines.length) throw new PosError(400, 'QTY_ALLOCATION_INVALID');
  return lines;
}

function fragment(line: SaleLine, qty: number, discount: number, allocationId: string) {
  const gross = (line.basePrice + line.optionPrice) * qty;
  return { ...line, allocationId, qty, gross, discount, amount: gross - discount };
}

export function splitBill(tx: PosTx, key: string, billId: string, body: unknown) {
  const input = object(body, ['expectedRevision', 'table', 'lines']);
  const expectedRevision = integer(input.expectedRevision, 1);
  const table = destination(input.table);
  const lines = selection(input.lines);
  return applyCommand(tx, transferCommand.separate, key, { billId, expectedRevision, table, lines }, async () => {
    const bill = await editableBill(tx, billId, expectedRevision);
    const from = requireSourceTable(bill);
    if (from === table.tableId) throw new PosError(409, 'NO_DESTINATION');
    const requested = new Map(lines.map(({ orderLineId, qty }) => [orderLineId, qty]));
    const kept: SaleLine[] = [];
    const moved: SaleLine[] = [];
    const changes: { allocationId: string; qty: number }[] = [];
    for (const line of bill.draft.quote.lines) {
      const qty = Math.min(line.qty, requested.get(line.orderLineId) ?? 0);
      if (!qty) {
        kept.push(line);
        continue;
      }
      requested.set(line.orderLineId, requested.get(line.orderLineId)! - qty);
      const remaining = line.qty - qty;
      const [going, staying] = apportion(line.discount, [{ id: 'move', weight: qty }, { id: 'stay', weight: remaining }]);
      moved.push(fragment(line, qty, going, randomUUID()));
      if (remaining) kept.push(fragment(line, remaining, staying, line.allocationId));
      changes.push({ allocationId: line.allocationId, qty: remaining });
    }
    if (!kept.length || !moved.length || [...requested.values()].some(Boolean)) throw new PosError(400, 'QTY_ALLOCATION_INVALID');
    const source = withLines(kept);
    const target = withLines(moved);
    const prior = await captureTransferBill(tx, billId, bill.draft, from);
    const newBillId = randomUUID();
    await tx.db.query(`INSERT INTO pos.bill (store_id, bill_id, business_date, draft, created_at)
      VALUES ($1, $2, $3, $4, $5)`, [tx.storeId, newBillId, bill.day, target, tx.at]);
    await openTableSession(tx, table, newBillId);
    await tx.db.query(`UPDATE pos.bill_allocation SET quantity = batch.qty
      FROM jsonb_to_recordset($3::jsonb) AS batch("allocationId" uuid, qty integer)
      WHERE store_id = $1 AND bill_id = $2 AND allocation_id = batch."allocationId" AND batch.qty > 0`,
    [tx.storeId, billId, JSON.stringify(changes)]);
    await tx.db.query('DELETE FROM pos.bill_allocation WHERE store_id = $1 AND bill_id = $2 AND allocation_id = ANY($3::uuid[])',
      [tx.storeId, billId, changes.filter(line => !line.qty).map(line => line.allocationId)]);
    await insertAllocations(tx, newBillId, moved);
    await updateDraft(tx, billId, source);
    const orderIds = await billOrderIds(tx, newBillId);
    const eventId = await history(tx, orderIds, 'separate', from, table.tableId, billId, newBillId);
    const receipt = { ...commandReceipt(newBillId, 1, sources), quote: target.quote, orderIds, sourceRevision: expectedRevision + 1 };
    return saveTransferReceipt(tx, key, receipt, { kind: 'separate', day: bill.day, eventId, orderIds,
      before: [prior, { billId: newBillId, draft: null, tableId: null, openedAt: null }] }, [from, table.tableId]);
  });
}
