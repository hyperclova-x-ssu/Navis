import type { PosApprovalAttempt, PosApprovalCompletion, PosBeginApproval, PosBill, PosFinishApproval, PosOrder, PosPayment, PosPlanningResult, PosReadSnapshot } from '../../contracts/pos';
import { canonical, checkMeta, commandKey, freezePos, makePlan, money, posFailure } from './common';
import { quoteCart } from './cart';
import { selectPosDayTotals } from './money';

const beginPayload = (input: PosBeginApproval) => ({ cartId: input.cartId, splits: input.splits, quoteRevision: input.quoteRevision });
function safeRecognition(read: PosReadSnapshot, gross: number, payable: number, method: PosPayment['countedMethod']): boolean {
  const totals = selectPosDayTotals(read.pos);
  return [totals.gross + gross, totals.charged + payable, totals.revenue + payable, totals.byMethod[method] + payable].every(money);
}
export function planBeginApproval(read: PosReadSnapshot, input: PosBeginApproval): PosPlanningResult {
  if (input.meta.runId !== read.runId) return posFailure('STALE_RUN', 'CONFLICT');
  const payload = beginPayload(input), payloadFingerprint = canonical(payload), previous = read.posUi.approval;
  if (previous?.status === 'pending') {
    if (previous.closingGeneration !== read.data.closingGeneration || previous.scenario !== read.scenario) return posFailure('STALE_ATTEMPT', 'CONFLICT');
    if (previous.meta.idempotencyKey !== input.meta.idempotencyKey) return posFailure('APPROVAL_BUSY', 'CONFLICT');
    if (previous.payloadFingerprint !== payloadFingerprint) return posFailure('IDEMPOTENCY_MISMATCH', 'CONFLICT');
    return { ok: true, plan: { nextPos: read.pos, nextUi: read.posUi, result: { ok: true, status: 'pending', posRevision: read.posRevision, dataRevision: read.dataRevision, value: { attemptId: previous.attemptId, status: 'pending' }, duplicate: true } } };
  }
  const checked = checkMeta(read, input.meta, 'approval.begin', payload);
  if (checked) return checked;
  if (previous?.meta.idempotencyKey === input.meta.idempotencyKey) {
    if (previous.payloadFingerprint !== payloadFingerprint) return posFailure('IDEMPOTENCY_MISMATCH', 'CONFLICT');
    if (previous.status === 'failed') return previous.result && !previous.result.ok ? previous.result : posFailure('STALE_ATTEMPT', 'CONFLICT');
  }
  if (read.data.dayClosed) return posFailure('DAY_CLOSED', 'CONFLICT');
  if (read.scenario === 'error' || read.scenario === 'empty') return posFailure('DATA_UNAVAILABLE');
  if (read.settings.paymentStyle !== 'prepaid') return posFailure('PAYMENT_STYLE_REQUIRED', 'CONFLICT');
  const quote = quoteCart(read, input.cartId);
  if (!quote.canSubmit) return posFailure(quote.issues[0].reason, 'VALIDATION', { quote });
  if (input.quoteRevision !== quote.revision) return posFailure('QUOTE_CHANGED', 'CONFLICT', { quote });
  if (input.splits.length !== 1 || !['card', 'easy_pay', 'cash'].includes(input.splits[0]?.method)) return posFailure('INVALID_METHOD');
  if (!money(input.splits[0].amount) || input.splits[0].amount <= 0 || input.splits[0].amount !== quote.payable) return posFailure('SPLIT_TOTAL_MISMATCH');
  if (!safeRecognition(read, quote.gross, quote.payable, input.splits[0].method)) return posFailure('INVALID_AMOUNT');
  const attempt: PosApprovalAttempt = freezePos({ attemptId: `pos:attempt:${commandKey(input.meta, 'approval.begin')}`,
    runId: read.runId, meta: { ...input.meta }, cartId: input.cartId, splits: input.splits.map(s => ({ ...s })),
    quoteFingerprint: quote.fingerprint, payloadFingerprint, scenario: read.scenario, closingGeneration: read.data.closingGeneration, status: 'pending' });
  return { ok: true, plan: { nextPos: read.pos, nextUi: { ...read.posUi, approval: attempt },
    result: { ok: true, status: 'pending', posRevision: read.posRevision, dataRevision: read.dataRevision, value: { attemptId: attempt.attemptId, status: 'pending' } } } };
}
export function planFinishApproval(read: PosReadSnapshot, input: PosFinishApproval, now: string): PosPlanningResult {
  if (input.runId !== read.runId) return posFailure('STALE_RUN', 'CONFLICT');
  const attempt = read.posUi.approval;
  if (!attempt || attempt.runId !== input.runId || attempt.attemptId !== input.attemptId || attempt.quoteFingerprint !== input.expectedQuoteFingerprint) return posFailure('STALE_ATTEMPT', 'CONFLICT');
  if (attempt.closingGeneration !== read.data.closingGeneration) return posFailure('STALE_ATTEMPT', 'CONFLICT');
  const payload = { cartId: attempt.cartId, splits: attempt.splits, quoteRevision: read.pos.cart.revision };
  // Completion callbacks consult the original record before optimistic revision checks.
  const entry = read.pos.commandLedger.find(e => e.key === commandKey(attempt.meta, 'approval.begin'));
  if (entry) {
    if (entry.scenario !== read.scenario) return posFailure('STALE_ATTEMPT', 'CONFLICT');
    if (entry.undone) return posFailure('COMMAND_UNDONE', 'CONFLICT');
    return { ok: true, plan: { nextPos: read.pos, nextUi: read.posUi, result: { ...entry.result, duplicate: true } } };
  }
  if (attempt.status !== 'pending') return posFailure('STALE_ATTEMPT', 'CONFLICT');
  if (read.data.dayClosed) return posFailure('DAY_CLOSED', 'CONFLICT');
  if (read.scenario === 'error' || read.scenario === 'empty') return posFailure('DATA_UNAVAILABLE');
  const quote = quoteCart(read, attempt.cartId);
  if (!quote.canSubmit) return posFailure(quote.issues[0].reason, 'VALIDATION', { quote });
  if (quote.fingerprint !== attempt.quoteFingerprint) return posFailure('QUOTE_CHANGED', 'CONFLICT', { quote });
  const checked = checkMeta(read, attempt.meta, 'approval.begin', payload);
  if (checked) return checked;
  if (input.outcome !== 'approved' && input.outcome !== 'failed') return posFailure('INVALID_OUTCOME');
  if (input.outcome === 'failed' || attempt.scenario === 'payment-failure' || read.scenario === 'payment-failure') return posFailure('APPROVAL_FAILED', 'PREVIEW_FAILURE');
  if (attempt.scenario !== read.scenario) return posFailure('STALE_ATTEMPT', 'CONFLICT');
  if (read.settings.paymentStyle !== 'prepaid') return posFailure('PAYMENT_STYLE_REQUIRED', 'CONFLICT');
  if (!safeRecognition(read, quote.gross, quote.payable, attempt.splits[0].method)) return posFailure('INVALID_AMOUNT');
  if (now.slice(0, 10) !== read.pos.businessDate) return posFailure('BUSINESS_DATE_MISMATCH');
  const orderNo = Math.max(0, ...read.pos.orders.map(o => o.orderNo)) + 1;
  const paymentNo = read.pos.payments.length + 1, seq = read.pos.seq + 1;
  const orderId = `O-${String(orderNo).padStart(3, '0')}`, billId = `B-${String(orderNo).padStart(3, '0')}`, paymentId = `P-${String(paymentNo).padStart(3, '0')}`;
  const order: PosOrder = { orderId, orderNo, orderedAt: now, seq, type: read.pos.cart.type, originBillId: billId,
    lines: quote.lines.map((l, i) => ({ orderLineId: `${orderId}:L-${i + 1}`, menuId: l.menuId, nameAtOrder: l.name, qty: l.qty,
      unitPriceAtOrder: l.unitPrice, optionsAtOrder: l.options.map(o => ({ optionId: o.optionId, name: o.name, extraPrice: o.extraPrice, extraRecipe: o.extraRecipe })), request: l.request, canceledQty: 0 })),
    memo: read.pos.cart.memo, preparation: 'accepted', preparedAt: null, completedAt: null, completedInRun: false };
  const allocations = order.lines.map(l => ({ allocationId: `${billId}:${l.orderLineId}`, billId, orderLineId: l.orderLineId, qty: l.qty }));
  const bill: PosBill = { billId, originOrderNo: orderNo, tableId: null, status: 'paid', settledAt: now, recognizedAt: now, discounts: [],
    settlementLines: quote.lines.map((l, i) => ({ allocationId: allocations[i].allocationId, menuId: l.menuId, qty: l.qty,
      basePriceAtSale: l.basePrice, optionPriceAtSale: l.optionPrice, unitCostAtSale: l.baseCost, optionCostAtSale: l.optionCost, discountAllocations: [], recognizedQty: l.qty })) };
  const payment: PosPayment = { paymentId, billId, at: now, seq,
    transactionNo: `거래-${read.pos.businessDate.replaceAll('-', '')}-${String(paymentNo).padStart(4, '0')}`,
    approvalNo: `예시-${String(paymentNo).padStart(6, '0')}`, amount: quote.payable, splits: attempt.splits,
    countedMethod: attempt.splits[0].method, status: 'paid', recognizedAt: now };
  const value: PosApprovalCompletion = { paymentId, billId, orderIds: [orderId], remaining: 0, settled: true };
  const nextPos = { ...read.pos, revision: read.posRevision + 1, seq, orders: [...read.pos.orders, order], bills: [...read.pos.bills, bill],
    billAllocations: [...read.pos.billAllocations, ...allocations], payments: [...read.pos.payments, payment],
    receipts: [...read.pos.receipts, { paymentId, billId }],
    cart: { cartId: read.pos.cart.cartId, revision: read.pos.cart.revision + 1, type: read.pos.cart.type, memo: '', lines: [], lock: null } };
  const nextUi = { ...read.posUi, cartUndo: null, approval: { ...attempt, status: 'succeeded' as const } };
  return makePlan(read, nextPos, nextUi, value, attempt.meta, 'approval.begin', payload);
}
