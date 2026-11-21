import type { PosBill, PosBillAllocation, PosDiscount, PosReadSnapshot, PosOrder, PosOrderTransferEvent, PosState, PosTableCommand } from '../../contracts/pos';
import { posFailure, quantity, canonical } from '../domain/common';
import { distributePosAmount } from '../domain/money';
import { quotePaymentBill } from '../loyalty/selectors';
import { isUnpaidBill, selectTableMap } from './selectors';

export type TableTransferKind = 'move' | 'merge' | 'separate';
type TransferCommand = Extract<PosTableCommand, { type: 'bill.moveTable' | 'bill.mergeTables' | 'bill.separateTable' }>;
export const isTransferCommand = (command: PosTableCommand): command is TransferCommand => ['bill.moveTable', 'bill.mergeTables', 'bill.separateTable'].includes(command.type);
const hasPayment = (read: PosReadSnapshot, bill: PosBill) => bill.status === 'partial' || read.pos.payments.some(p => p.billId === bill.billId && p.status === 'paid');

/** Shared by the picker and the final command: invalid tiles remain focusable with a reason. */
export function tableTransferReason(read: PosReadSnapshot, kind: TableTransferKind, billId: string, targetTableId: string): string | null {
  const map = selectTableMap(read), source = read.pos.bills.find(b => b.billId === billId);
  if (!map.enabled || !source?.tableId || !isUnpaidBill(source) || !map.tables.some(t => t.tableId === source.tableId)) return 'STATE_CONFLICT';
  if (kind !== 'move' && hasPayment(read, source)) return 'PARTIAL_BILL_LOCKED';
  if (kind !== 'move' && source.splitPlan) return 'BILL_LOCKED';
  const table = map.tables.find(t => t.tableId === targetTableId);
  if (!table) return 'INVALID_TABLE';
  if (table.tableId === source.tableId) return 'NO_DESTINATION';
  if (kind === 'merge') {
    const target = read.pos.bills.find(b => b.billId === table.billIds[0]);
    if (target && hasPayment(read, target)) return 'PARTIAL_BILL_LOCKED';
    if (target?.splitPlan) return 'BILL_LOCKED';
    return target && (table.state === 'occupied' || table.state === 'payment_pending') && table.billIds.length === 1 ? null : 'NO_DESTINATION';
  }
  return table.state === 'empty' || kind === 'move' && table.state === 'reserved' ? null : 'NO_DESTINATION';
}

/** Snapshot each benefit once. Subsequent transfers consume these amounts directly. */
function fixedDiscounts(read: PosReadSnapshot, bill: PosBill): readonly PosDiscount[] {
  if (!bill.discounts.length) return [];
  if (bill.discounts.every(d => d.fixedAllocations)) return bill.discounts;
  const quote = quotePaymentBill(read, bill.billId);
  if (!quote.canSubmit) throw new Error('INVALID_DISCOUNT_QUOTE');
  const settlementLines = quote.settlementLines;
  return quote.discounts.map(d => d.fixedAllocations ? d : { ...d, ...(quote.memberId ? { contributionMemberId: quote.memberId } : {}), contributionAllocationIds: read.pos.billAllocations.filter(a => a.billId === bill.billId).map(a => a.allocationId), fixedAllocations: settlementLines.flatMap(l =>
    l.discountAllocations.filter(a => a.discountId === d.discountId).map(a => ({ allocationId: l.allocationId, amount: a.amount }))) });
}
function combineDiscounts(discounts: readonly PosDiscount[], billId: string): readonly PosDiscount[] {
  const result = new Map<string, PosDiscount>();
  for (const d of discounts) {
    const old = result.get(d.discountId);
    result.set(d.discountId, { ...d, billId, amount: (old?.amount ?? 0) + d.amount,
      contributionAllocationIds: [...new Set([...(old?.contributionAllocationIds ?? []), ...(d.contributionAllocationIds ?? [])])],
      fixedAllocations: [...(old?.fixedAllocations ?? []), ...(d.fixedAllocations ?? [])] });
  }
  return [...result.values()];
}

/** Defends fixed amounts at checkout; quote/settlement now consume them directly. */
export function transferredDiscountsMatch(read: PosReadSnapshot, billId: string): boolean {
  const bill = read.pos.bills.find(b => b.billId === billId);
  if (!bill?.discounts.some(d => d.fixedAllocations)) return true;
  const quote = quotePaymentBill(read, billId);
  const expected = bill.discounts.flatMap(d => (d.fixedAllocations ?? []).map(a => [d.discountId, a.allocationId, a.amount])).sort();
  const actual = quote.settlementLines.flatMap(l => l.discountAllocations.map(a => [a.discountId, l.allocationId, a.amount])).sort();
  return bill.discounts.reduce((n, d) => n + d.amount, 0) === quote.discount && canonical(expected) === canonical(actual);
}

export function transferTables(read: PosReadSnapshot, command: TransferCommand, now: string): PosState | ReturnType<typeof posFailure> {
  const pos = read.pos, sourceId = command.type === 'bill.mergeTables' ? command.sourceBillId : command.billId;
  const source = pos.bills.find(b => b.billId === sourceId);
  const target = command.type === 'bill.mergeTables' ? pos.bills.find(b => b.billId === command.targetBillId) : undefined;
  // Partial-state checks precede destination validation, including the merge's second endpoint.
  if (command.type !== 'bill.moveTable' && [source, target].some(b => b && hasPayment(read, b))) return posFailure('PARTIAL_BILL_LOCKED', 'CONFLICT');
  if (!source || command.type === 'bill.mergeTables' && !target) return posFailure('NOT_FOUND', 'NOT_FOUND');
  const targetTableId = command.type === 'bill.mergeTables' ? target?.tableId : command.targetTableId;
  if (!targetTableId) return posFailure('INVALID_TABLE');
  const kind = command.type === 'bill.moveTable' ? 'move' : command.type === 'bill.mergeTables' ? 'merge' : 'separate';
  const reason = tableTransferReason(read, kind, sourceId, targetTableId);
  if (reason) return posFailure(reason, 'CONFLICT');
  const affectedLines = new Set(pos.billAllocations.filter(a => a.billId === sourceId || kind === 'merge' && a.billId === target?.billId).map(a => a.orderLineId));
  const history = (targetBillId: string, movedLines?: ReadonlySet<string>): readonly PosOrder[] => {
    const event: PosOrderTransferEvent = {
      eventId: `${command.type}:${command.meta.idempotencyKey}`, kind, at: now, fromTableId: source.tableId!, toTableId: targetTableId,
      sourceBillId: sourceId, targetBillId,
    };
    return pos.orders.map(order => order.lines.some(l => (movedLines ?? affectedLines).has(l.orderLineId))
      ? { ...order, statusHistory: [...(order.statusHistory ?? []), event] } : order);
  };
  const next = { ...pos, revision: read.posRevision + 1, seq: pos.seq + 1 };
  if (command.type === 'bill.moveTable') return { ...next, orders: history(sourceId),
    bills: pos.bills.map(b => b === source ? { ...b, tableId: targetTableId } : b),
    tableSessions: [...pos.tableSessions.filter(s => s.tableId !== source.tableId && s.tableId !== targetTableId), { tableId: targetTableId, billId: sourceId, cleaning: false, ...(source.requestedAt ? { requestedAt: source.requestedAt } : {}) }],
  };
  if (command.type === 'bill.mergeTables') {
    if (!target || !isUnpaidBill(target)) return posFailure('STATE_CONFLICT', 'CONFLICT');
    const discounts = combineDiscounts([...fixedDiscounts(read, target), ...fixedDiscounts(read, source)], target.billId);
    const requestedAt = target.requestedAt ?? source.requestedAt;
    return { ...next, orders: history(target.billId), bills: pos.bills.map(b => b === source ? { ...b, status: 'void', discounts: [] } : b === target ? { ...b, memberId: b.memberId ?? source.memberId, discounts, ...(requestedAt ? { requestedAt } : {}) } : b),
      billAllocations: pos.billAllocations.map(a => a.billId === sourceId ? { ...a, billId: target.billId } : a),
      tableSessions: [...pos.tableSessions.filter(s => s.tableId !== source.tableId && s.tableId !== targetTableId), { tableId: targetTableId, billId: target.billId, cleaning: false, ...(requestedAt ? { requestedAt } : {}) }],
    };
  }
  const allocations = pos.billAllocations.filter(a => a.billId === sourceId), wanted = new Map<string, number>();
  for (const line of command.lines) {
    const available = allocations.filter(a => a.orderLineId === line.orderLineId).reduce((n, a) => n + a.qty, 0);
    if (wanted.has(line.orderLineId) || !quantity(line.qty) || line.qty > available) return posFailure('QTY_ALLOCATION_INVALID');
    wanted.set(line.orderLineId, line.qty);
  }
  const total = [...wanted.values()].reduce((n, nQty) => n + nQty, 0);
  if (!total || total >= allocations.reduce((n, a) => n + a.qty, 0)) return posFailure('QTY_ALLOCATION_INVALID');
  // Bill IDs have their own namespace; separating does not consume an order number.
  const baseId = `${sourceId}:table`, existingIds = new Set(pos.bills.map(b => b.billId));
  let suffix = 1; while (existingIds.has(`${baseId}:${suffix}`)) suffix++;
  const billId = `${baseId}:${suffix}`, moved: PosBillAllocation[] = [], kept: PosBillAllocation[] = [];
  const portions = new Map<string, { allocationId: string; moved: number; kept: number }>();
  for (const a of allocations) {
    const qty = Math.min(wanted.get(a.orderLineId) ?? 0, a.qty);
    wanted.set(a.orderLineId, (wanted.get(a.orderLineId) ?? 0) - qty);
    const allocationId = `${billId}:${a.allocationId}`;
    portions.set(a.allocationId, { allocationId, moved: qty, kept: a.qty - qty });
    if (qty) moved.push({ ...a, allocationId, billId, qty });
    if (qty < a.qty) kept.push({ ...a, qty: a.qty - qty });
  }
  const discounts = fixedDiscounts(read, source), left: PosDiscount[] = [], right: PosDiscount[] = [];
  for (const discount of discounts) {
    const stay: { allocationId: string; amount: number }[] = [], go: { allocationId: string; amount: number }[] = [];
    for (const allocation of discount.fixedAllocations ?? []) {
      const part = portions.get(allocation.allocationId);
      if (!part) return posFailure('QTY_ALLOCATION_INVALID');
      const divided = distributePosAmount(allocation.amount, [{ id: 'move', amount: part.moved }, { id: 'stay', amount: part.kept }]);
      if (divided.stay) stay.push({ allocationId: allocation.allocationId, amount: divided.stay });
      if (divided.move) go.push({ allocationId: part.allocationId, amount: divided.move });
    }
    const scope = discount.contributionAllocationIds ?? (discount.fixedAllocations ?? []).map(a => a.allocationId);
    const stayScope = scope.filter(id => portions.get(id)?.kept);
    const goScope = scope.flatMap(id => portions.get(id)?.moved ? [portions.get(id)!.allocationId] : []);
    for (const [entries, contributionAllocationIds, id, list] of [[stay, stayScope, sourceId, left], [go, goScope, billId, right]] as const) {
      if (entries.length || discount.source !== 'direct' && contributionAllocationIds.length) list.push({ ...discount, billId: id,
        amount: entries.reduce((n, a) => n + a.amount, 0), contributionAllocationIds, fixedAllocations: entries });
    }
  }
  return { ...next, orders: history(billId, new Set(moved.map(a => a.orderLineId))), bills: [...pos.bills.map(b => b === source ? { ...b, discounts: left } : b),
    { billId, originOrderNo: source.originOrderNo, tableId: targetTableId, status: 'open', discounts: right, settlementLines: [], ...(source.memberId ? { memberId: source.memberId } : {}), memberLinkChosen: source.memberLinkChosen }],
    billAllocations: [...pos.billAllocations.filter(a => a.billId !== sourceId), ...kept, ...moved],
    tableSessions: [...pos.tableSessions.filter(s => s.tableId !== targetTableId), { tableId: targetTableId, billId, cleaning: false }],
  };
}

/** Transfer undo owns history only; a later preparation update must survive. */
export function preserveTransferOrderProgress(read: PosReadSnapshot, token: string): PosReadSnapshot {
  const undo = read.posUi.tablesUndo;
  if (!undo || undo.token !== token) return read;
  const patches = undo.patches.map(patch => {
    if (patch.collection !== 'orders' || !patch.before || !patch.after) return patch;
    const before = patch.before as PosOrder, after = patch.after as PosOrder;
    if (canonical({ ...before, statusHistory: after.statusHistory }) !== canonical(after)) return patch;
    const current = read.pos.orders.find(o => o.orderId === patch.id);
    if (!current || canonical(current.statusHistory) !== canonical(after.statusHistory)) return patch;
    return { ...patch, after: current, before: { ...current, statusHistory: before.statusHistory } };
  });
  return { ...read, posUi: { ...read.posUi, tablesUndo: { ...undo, patches } } };
}
