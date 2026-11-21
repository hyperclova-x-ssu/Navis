import type { PosCommandValue, PosDataChanges, PosOrder, PosPlanningResult, PosReadSnapshot, PosState, PosTableCollection, PosTableCommand, PosTablePatch, PosTableUndo } from '../../contracts/pos';
import { validateTableLayout } from '../../layout/table-layout';
import { quoteCart } from '../domain/cart';
import { canonical, checkMeta, commandKey, freezePos, makePlan, posFailure, unchanged } from '../domain/common';
import { normalizePosSettings, selectPosPreferences, tablesEnabled, validatePosSettingsChange } from './preferences';
import { isUnpaidBill, quoteBill, reservationInWindow } from './selectors';
import { isTransferCommand, transferTables } from './transfer';

const ids: Record<PosTableCollection, string> = { orders: 'orderId', bills: 'billId', billAllocations: 'allocationId', tableSessions: 'tableId', reservationPrompts: 'reservationId' };
function patches(before: PosState, after: PosState): PosTablePatch[] {
  const result: PosTablePatch[] = [];
  if (before.cart !== after.cart) result.push({ collection: 'cart', id: before.cart.cartId, before: before.cart, after: after.cart });
  for (const collection of Object.keys(ids) as PosTableCollection[]) {
    if (before[collection] === after[collection]) continue;
    const key = ids[collection];
    const left = new Map(before[collection].map(row => [(row as unknown as Record<string, unknown>)[key] as string, row]));
    const right = new Map(after[collection].map(row => [(row as unknown as Record<string, unknown>)[key] as string, row]));
    for (const id of new Set([...left.keys(), ...right.keys()])) {
      if (canonical(left.get(id)) !== canonical(right.get(id))) result.push({ collection, id, before: left.get(id), after: right.get(id) });
    }
  }
  return result;
}
export function tableCommandPayload(command: PosTableCommand): unknown { const { meta: _meta, ...payload } = command; return payload; }
function tablePlan(read: PosReadSnapshot, next: PosState, command: PosTableCommand, value: PosCommandValue, financial: boolean,
  dataChanges?: PosDataChanges, reservationUndo?: PosTableUndo['reservation'], noticeKey?: string): PosPlanningResult {
  const key = commandKey(command.meta, command.type), token = `pos:tables:${key}`;
  const changes = patches(read.pos, next);
  const undo = changes.length ? { token, commandKey: key, closingGeneration: read.data.closingGeneration, financial, patches: changes, ...(reservationUndo ? { reservation: reservationUndo } : {}) } : null;
  const result = makePlan(read, next, { ...read.posUi, ...(undo ? { tablesUndo: undo } : {}), ...(next.cart !== read.pos.cart ? { cartUndo: null } : {}) }, value,
    command.meta, command.type, tableCommandPayload(command), undo ? token : undefined);
  if (!result.ok) return result;
  const notified = noticeKey ? { ...result.plan.result, noticeKey } : result.plan.result;
  return { ok: true, plan: freezePos({ ...result.plan, result: notified,
    nextPos: notified === result.plan.result ? result.plan.nextPos : { ...result.plan.nextPos,
      commandLedger: result.plan.nextPos.commandLedger.map(record => record.result === result.plan.result ? { ...record, result: notified } : record) },
    ...(dataChanges ? { dataChanges } : {}) }) };
}
export function nextOrderNumber(pos: PosState): number {
  const used = pos.commandLedger.flatMap(record => {
    const value = record.result.value;
    return value && 'orderIds' in value ? value.orderIds.map(id => Number(id.replace(/^O-/, ''))) : [];
  });
  return Math.max(0, ...pos.orders.map(o => o.orderNo), ...used) + 1;
}
export function planTableCommand(read: PosReadSnapshot, command: PosTableCommand, now: string): PosPlanningResult {
  const checked = checkMeta(read, command.meta, command.type, tableCommandPayload(command)); if (checked) return checked;
  if (read.posUi.approval?.status === 'pending') return posFailure('APPROVAL_BUSY', 'CONFLICT');
  const pos = read.pos, next = { ...pos, revision: read.posRevision + 1 };
  if (isTransferCommand(command)) {
    if (read.scenario === 'empty' || read.scenario === 'error') return posFailure('DATA_UNAVAILABLE');
    try {
      const transferred = transferTables(read, command, now);
      return 'ok' in transferred ? transferred : tablePlan(read, transferred, command, null, false);
    } catch { return posFailure('QTY_ALLOCATION_INVALID'); }
  }
  if (command.type === 'table.saveLayout') {
    if (command.expectedSettingsRevision !== read.settings.revision) return posFailure('STALE_REVISION', 'CONFLICT');
    if (!validateTableLayout(command.layout)) return posFailure('TABLE_LAYOUT_INVALID');
    const settings = normalizePosSettings({ ...read.settings, tableLayout: command.layout, revision: read.settings.revision + 1 });
    const blocked = validatePosSettingsChange(pos, read.settings, settings); if (blocked) return blocked;
    if (canonical(command.layout) === canonical(read.settings.tableLayout)) return unchanged(read, null);
    return tablePlan(read, next, command, null, false, { settings });
  }
  if (command.type === 'pos.setPreferences') {
    if (command.startTab !== undefined && !['order', 'status', 'tables'].includes(command.startTab)
      || command.showStatus !== undefined && typeof command.showStatus !== 'boolean' || command.showTables !== undefined && typeof command.showTables !== 'boolean') return posFailure('INVALID_START_TAB');
    const preferences = selectPosPreferences(read.settings);
    const requested = { ...preferences, ...(command.startTab !== undefined ? { startTab: command.startTab, userChoseStart: true } : {}),
      ...(command.showStatus !== undefined ? { showStatus: command.showStatus } : {}), ...(command.showTables !== undefined ? { showTables: command.showTables } : {}) };
    if (command.startTab === 'tables' && (!tablesEnabled(read.settings) || !requested.showTables) || command.startTab === 'status' && !requested.showStatus) return posFailure('INVALID_START_TAB');
    const settings = normalizePosSettings({ ...read.settings, posPreferences: requested, revision: read.settings.revision + 1 });
    const blocked = validatePosSettingsChange(pos, read.settings, settings); if (blocked) return blocked;
    if (canonical(settings.posPreferences) === canonical(preferences)) return unchanged(read, null);
    return tablePlan(read, next, command, null, false, { settings }, undefined,
      requested.startTab !== settings.posPreferences!.startTab ? 'order.settings.startAdjusted' : undefined);
  }
  if (command.type === 'table.clean') {
    if (!read.settings.tableLayout?.tables.some(t => t.tableId === command.tableId)) return posFailure('INVALID_TABLE');
    const session = pos.tableSessions.find(s => s.tableId === command.tableId);
    if (!session?.cleaning || pos.bills.some(b => b.tableId === command.tableId && isUnpaidBill(b))) return posFailure('STATE_CONFLICT', 'CONFLICT');
    return tablePlan(read, { ...next, tableSessions: pos.tableSessions.map(s => s === session ? { tableId: s.tableId, cleaning: false } : s) }, command, null, false);
  }
  if (command.type === 'bill.requestPayment') {
    const bill = pos.bills.find(b => b.billId === command.billId);
    if (!bill) return posFailure('NOT_FOUND', 'NOT_FOUND');
    if (!isUnpaidBill(bill)) return posFailure('STATE_CONFLICT', 'CONFLICT');
    if (bill.requestedAt) return unchanged(read, null);
    return tablePlan(read, { ...next, bills: pos.bills.map(b => b === bill ? { ...b, requestedAt: now } : b),
      tableSessions: pos.tableSessions.map(s => s.tableId === bill.tableId ? { ...s, requestedAt: now } : s) }, command, null, false);
  }
  if (command.type === 'reservation.respond') {
    if (!['accept', 'defer'].includes(command.decision)) return posFailure('STATE_CONFLICT', 'CONFLICT');
    const prompt = pos.reservationPrompts.find(p => p.reservationId === command.reservationId && p.billId === command.billId);
    const reservation = read.data.reservations?.find(r => r.reservationId === command.reservationId);
    const bill = pos.bills.find(b => b.billId === command.billId);
    if (!prompt || prompt.decision !== 'pending' || !reservation || !bill || !isUnpaidBill(bill)
      || reservation.tableId !== bill.tableId || !reservationInWindow(reservation, now)) return posFailure('STATE_CONFLICT', 'CONFLICT');
    const accepting = command.decision === 'accept';
    const changeId = `pos:reservation:${commandKey(command.meta, command.type)}`;
    const dataChanges = accepting ? { reservation: { reservationId: reservation.reservationId, expectedFingerprint: reservation.fingerprint, status: 'completed' as const, changeId, at: now } } : undefined;
    const inverse = accepting ? { reservationId: reservation.reservationId, expectedFingerprint: reservation.completedFingerprint, status: 'confirmed' as const, changeId, at: now, undo: true } : undefined;
    return tablePlan(read, { ...next, reservationPrompts: pos.reservationPrompts.map(p => p === prompt ? { ...p, decision: accepting ? 'accepted' : 'declined' } : p),
      bills: accepting ? pos.bills.map(b => b === bill ? { ...b, reservationId: reservation.reservationId } : b) : pos.bills }, command, null, false, dataChanges, inverse);
  }
  if (read.data.dayClosed) return posFailure('DAY_CLOSED', 'CONFLICT');
  if (read.scenario === 'empty' || read.scenario === 'error') return posFailure('DATA_UNAVAILABLE');
  if (now.slice(0, 10) !== pos.businessDate) return posFailure('BUSINESS_DATE_MISMATCH');
  if (command.type === 'order.cancelUnpaid') {
    const order = pos.orders.find(o => o.orderId === command.orderId);
    if (!order) return posFailure('UNKNOWN_ORDER', 'NOT_FOUND');
    if (order.preparation === 'canceled') return posFailure('NOT_OPEN', 'CONFLICT');
    const allocationIds = new Set(order.lines.map(l => l.orderLineId));
    const billIds = new Set(pos.billAllocations.filter(a => allocationIds.has(a.orderLineId)).map(a => a.billId));
    if (!billIds.size || pos.bills.some(b => billIds.has(b.billId) && !isUnpaidBill(b))
      || pos.payments.some(p => billIds.has(p.billId) && p.status === 'paid')) return posFailure('USE_PAYMENT_REVERSAL', 'CONFLICT');
    const billAllocations = pos.billAllocations.filter(a => !allocationIds.has(a.orderLineId));
    const emptied = pos.bills.filter(b => billIds.has(b.billId) && !billAllocations.some(a => a.billId === b.billId));
    return tablePlan(read, { ...next, orders: pos.orders.map(o => o === order ? { ...o, preparation: 'canceled', lines: o.lines.map(l => ({ ...l, canceledQty: l.qty })) } : o), billAllocations,
      bills: pos.bills.map(b => emptied.includes(b) ? { ...b, status: 'void' } : b),
      tableSessions: pos.tableSessions.filter(s => !emptied.some(b => b.billId === s.billId)) }, command, null, true);
  }
  if (read.settings.paymentStyle !== 'postpaid') return posFailure('PAYMENT_STYLE_REQUIRED', 'CONFLICT');
  if (pos.cart.type === 'takeout') return posFailure('IMMEDIATE_PAYMENT_REQUIRED', 'CONFLICT');
  const quote = quoteCart(read, command.cartId);
  if (!quote.canSubmit) return posFailure(quote.issues[0].reason, 'VALIDATION', { quote });
  const targetId = command.billId ?? pos.cart.targetBillId;
  let bill = targetId ? pos.bills.find(b => b.billId === targetId) : undefined;
  if (targetId && !bill) return posFailure('NOT_FOUND', 'NOT_FOUND');
  if (bill && (!isUnpaidBill(bill) || bill.status === 'partial')) return posFailure('BILL_LOCKED', 'CONFLICT');
  const tableId = command.tableId ?? bill?.tableId ?? pos.cart.tableId ?? null;
  if (command.tableId && bill && bill.tableId !== command.tableId) return posFailure('INVALID_TABLE');
  if (tablesEnabled(read.settings)) {
    if (!tableId) return posFailure('TABLE_REQUIRED');
    if (!read.settings.tableLayout!.tables.some(t => t.tableId === tableId)) return posFailure('INVALID_TABLE');
    if (pos.tableSessions.some(s => s.tableId === tableId && s.cleaning)) return posFailure('STATE_CONFLICT', 'CONFLICT');
    bill ??= pos.bills.find(b => b.tableId === tableId && isUnpaidBill(b));
    if (bill?.status === 'partial') return posFailure('BILL_LOCKED', 'CONFLICT');
  } else if (tableId) return posFailure('INVALID_TABLE');
  const orderNo = nextOrderNumber(pos), orderId = `O-${String(orderNo).padStart(3, '0')}`, billId = bill?.billId ?? `B-${String(orderNo).padStart(3, '0')}`;
  const order: PosOrder = { orderId, orderNo, orderedAt: now, seq: pos.seq + 1, type: 'dine_in', originBillId: billId,
    lines: quote.lines.map((line, i) => ({ orderLineId: `${orderId}:L-${i + 1}`, menuId: line.menuId, nameAtOrder: line.name, qty: line.qty, unitPriceAtOrder: line.unitPrice,
      optionsAtOrder: line.options.map(o => ({ optionId: o.optionId, name: o.name, extraPrice: o.extraPrice, extraRecipe: o.extraRecipe })), request: line.request, canceledQty: 0 })),
    memo: pos.cart.memo, preparation: 'accepted', preparedAt: null, completedAt: null, completedInRun: false };
  const reservation = !bill && tableId ? read.data.reservations?.find(r => r.tableId === tableId && reservationInWindow(r, now) && !pos.reservationPrompts.some(p => p.reservationId === r.reservationId)) : undefined;
  const session = tableId ? { tableId, billId, cleaning: false, ...(bill?.requestedAt ? { requestedAt: bill.requestedAt } : {}) } : null;
  const result = tablePlan(read, { ...next, seq: order.seq, orders: [...pos.orders, order],
    bills: bill ? pos.bills : [...pos.bills, { billId, originOrderNo: orderNo, tableId, status: 'open', discounts: [], settlementLines: [] }],
    billAllocations: [...pos.billAllocations, ...order.lines.map(l => ({ allocationId: `${billId}:${l.orderLineId}`, billId, orderLineId: l.orderLineId, qty: l.qty }))],
    tableSessions: session ? [...pos.tableSessions.filter(s => s.tableId !== tableId), session] : pos.tableSessions,
    reservationPrompts: reservation ? [...pos.reservationPrompts, { reservationId: reservation.reservationId, billId, firstOrderId: orderId, decision: 'pending' }] : pos.reservationPrompts,
    cart: { cartId: pos.cart.cartId, revision: pos.cart.revision + 1, type: pos.cart.type, lines: [], memo: '', lock: null } },
  command, { billId, orderIds: [orderId], remaining: quote.payable + (bill ? quoteBill(read, billId).remaining : 0), settled: false }, true);
  return result.ok && tablesEnabled(read.settings) ? { ok: true, plan: { ...result.plan, nextUi: { ...result.plan.nextUi, tab: 'tables' } } } : result;
}

/** M1 generates IDs from remaining rows. Account for undone postpaid orders at the composition boundary. */
export function preserveOrderSequence(read: PosReadSnapshot, planned: PosPlanningResult): PosPlanningResult {
  if (!planned.ok || planned.plan.nextPos === read.pos) return planned;
  const { plan } = planned, next = plan.nextPos;
  const order = next.orders.find(o => !read.pos.orders.some(before => before.orderId === o.orderId));
  if (!order) return planned;
  const number = nextOrderNumber(read.pos);
  if (order.orderNo >= number) return planned;
  const orderId = `O-${String(number).padStart(3, '0')}`, billId = `B-${String(number).padStart(3, '0')}`;
  const lineIds = new Map(order.lines.map((line, i) => [line.orderLineId, `${orderId}:L-${i + 1}`]));
  const allocations = next.billAllocations.filter(a => a.billId === order.originBillId);
  const allocationIds = new Map(allocations.map(a => [a.allocationId, `${billId}:${lineIds.get(a.orderLineId)}`]));
  const value = plan.result.value;
  if (!value || !('orderIds' in value)) return planned;
  const result = { ...plan.result, value: { ...value, billId, orderIds: [orderId] } };
  return { ok: true, plan: freezePos({ ...plan, result, nextPos: { ...next,
    orders: next.orders.map(o => o === order ? { ...o, orderId, orderNo: number, originBillId: billId, lines: o.lines.map(l => ({ ...l, orderLineId: lineIds.get(l.orderLineId)! })) } : o),
    bills: next.bills.map(b => b.billId === order.originBillId ? { ...b, billId, originOrderNo: number,
      settlementLines: b.settlementLines.map(l => ({ ...l, allocationId: allocationIds.get(l.allocationId)! })) } : b),
    billAllocations: next.billAllocations.map(a => a.billId === order.originBillId ? { ...a, billId, allocationId: allocationIds.get(a.allocationId)!, orderLineId: lineIds.get(a.orderLineId)! } : a),
    payments: next.payments.map(p => p.billId === order.originBillId ? { ...p, billId } : p),
    receipts: next.receipts.map(r => r.billId === order.originBillId ? { ...r, billId } : r),
    commandLedger: next.commandLedger.map(record => record.result === plan.result ? { ...record, result } : record),
  } }) };
}

/** Revert only the command's write set; sequence/other domains/closing history are preserved. */
export function planTableUndo(read: PosReadSnapshot, token: string): PosPlanningResult {
  const undo = read.posUi.tablesUndo;
  if (!undo || undo.token !== token) return posFailure('UNDO_UNAVAILABLE', 'CONFLICT');
  if (read.posUi.approval?.status === 'pending') return posFailure('APPROVAL_BUSY', 'CONFLICT');
  if (undo.financial && (read.data.dayClosed || read.data.closingGeneration !== undo.closingGeneration)) return posFailure('DAY_CLOSED', 'CONFLICT');
  const next = { ...read.pos };
  for (const patch of undo.patches) {
    if (patch.collection === 'cart') {
      if (canonical(next.cart) !== canonical(patch.after)) return posFailure('UNDO_UNAVAILABLE', 'CONFLICT');
      next.cart = { ...patch.before as PosState['cart'], revision: next.cart.revision + 1 };
    } else {
      const key = ids[patch.collection], rows = next[patch.collection] as readonly unknown[];
      const row = rows.find(r => (r as Record<string, unknown>)[key] === patch.id);
      if (canonical(row) !== canonical(patch.after)) return posFailure('UNDO_UNAVAILABLE', 'CONFLICT');
      const restored = row === undefined ? [...rows, patch.before] : rows.flatMap(r => r !== row ? [r] : patch.before === undefined ? [] : [patch.before]);
      // Each collection keeps its own element type; the discriminator/id pair was checked above.
      Object.assign(next, { [patch.collection]: restored });
    }
  }
  const reservation = undo.reservation;
  if (reservation && read.data.reservations?.find(r => r.reservationId === reservation.reservationId)?.fingerprint !== reservation.expectedFingerprint) return posFailure('UNDO_UNAVAILABLE', 'CONFLICT');
  const tableIds = new Set(read.settings.tableLayout?.tables.map(t => t.tableId));
  if (next.bills.some(b => isUnpaidBill(b) && b.tableId && !tableIds.has(b.tableId))
    || next.tableSessions.some(s => (s.billId || s.cleaning) && !tableIds.has(s.tableId))) return posFailure('UNDO_UNAVAILABLE', 'CONFLICT');
  next.revision = read.posRevision + 1;
  next.commandLedger = read.pos.commandLedger.map(record => record.key === undo.commandKey ? { ...record, undone: true } : record);
  return { ok: true, plan: freezePos({ nextPos: next, nextUi: { ...read.posUi, tablesUndo: null },
    ...(reservation ? { dataChanges: { reservation } } : {}), result: { ok: true, status: 'applied', posRevision: next.revision, dataRevision: read.dataRevision + 1, value: null } }) };
}
