import type { PosApprovalAttempt, PosBillBeginApproval, PosFinishApproval, PosPayment, PosPlanningResult, PosReadSnapshot } from '../../contracts/pos';
import { canonical, checkMeta, commandKey, freezePos, makePlan, money, posFailure } from '../domain/common';
import { selectPosDayTotals } from '../domain/money';
import { quoteBill } from './selectors';

const payloadFor = (input: PosBillBeginApproval) => ({ billId: input.billId, splits: input.splits, quoteRevision: input.quoteRevision });
function validTotals(read: PosReadSnapshot, gross: number, payable: number, method: PosPayment['countedMethod']): boolean {
  const totals = selectPosDayTotals(read.pos);
  return [totals.gross + gross, totals.charged + payable, totals.revenue + payable, totals.byMethod[method] + payable].every(money);
}
export function planBillBeginApproval(read: PosReadSnapshot, input: PosBillBeginApproval): PosPlanningResult {
  if (input.meta.runId !== read.runId) return posFailure('STALE_RUN', 'CONFLICT');
  const payload = payloadFor(input), payloadFingerprint = canonical(payload), previous = read.posUi.approval;
  if (previous?.status === 'pending') {
    if (previous.scenario !== read.scenario || previous.closingGeneration !== read.data.closingGeneration) return posFailure('STALE_ATTEMPT', 'CONFLICT');
    if (previous.meta.idempotencyKey !== input.meta.idempotencyKey) return posFailure('APPROVAL_BUSY', 'CONFLICT');
    if (previous.payloadFingerprint !== payloadFingerprint) return posFailure('IDEMPOTENCY_MISMATCH', 'CONFLICT');
    return { ok: true, plan: { nextPos: read.pos, nextUi: read.posUi, result: { ok: true, status: 'pending', posRevision: read.posRevision, dataRevision: read.dataRevision,
      value: { attemptId: previous.attemptId, status: 'pending' }, duplicate: true } } };
  }
  const checked = checkMeta(read, input.meta, 'approval.begin', payload); if (checked) return checked;
  if (previous?.meta.idempotencyKey === input.meta.idempotencyKey && previous.status === 'failed') {
    if (previous.payloadFingerprint !== payloadFingerprint) return posFailure('IDEMPOTENCY_MISMATCH', 'CONFLICT');
    return previous.result && !previous.result.ok ? previous.result : posFailure('STALE_ATTEMPT', 'CONFLICT');
  }
  if (read.data.dayClosed) return posFailure('DAY_CLOSED', 'CONFLICT');
  if (read.scenario === 'empty' || read.scenario === 'error') return posFailure('DATA_UNAVAILABLE');
  if (read.settings.paymentStyle !== 'postpaid') return posFailure('PAYMENT_STYLE_REQUIRED', 'CONFLICT');
  const quote = quoteBill(read, input.billId);
  if (!quote.canSubmit) return posFailure(quote.issues[0].reason, 'VALIDATION', { quote });
  if (input.quoteRevision !== quote.revision) return posFailure('QUOTE_CHANGED', 'CONFLICT', { quote });
  if (input.splits.length !== 1 || !['card', 'easy_pay', 'cash'].includes(input.splits[0]?.method)) return posFailure('INVALID_METHOD');
  if (!money(input.splits[0].amount) || input.splits[0].amount <= 0 || input.splits[0].amount !== quote.remaining) return posFailure('SPLIT_TOTAL_MISMATCH');
  if (!validTotals(read, quote.gross, quote.payable, input.splits[0].method)) return posFailure('INVALID_AMOUNT');
  const attempt: PosApprovalAttempt = freezePos({ attemptId: `pos:attempt:${commandKey(input.meta, 'approval.begin')}`, runId: read.runId, meta: { ...input.meta },
    cartId: read.pos.cart.cartId, billId: input.billId, quoteRevision: input.quoteRevision, splits: input.splits.map(split => ({ ...split })),
    quoteFingerprint: quote.fingerprint, payloadFingerprint, scenario: read.scenario, closingGeneration: read.data.closingGeneration, status: 'pending' });
  return { ok: true, plan: { nextPos: read.pos, nextUi: { ...read.posUi, approval: attempt }, result: { ok: true, status: 'pending', posRevision: read.posRevision,
    dataRevision: read.dataRevision, value: { attemptId: attempt.attemptId, status: 'pending' } } } };
}
export function planBillFinishApproval(read: PosReadSnapshot, input: PosFinishApproval, now: string): PosPlanningResult {
  if (input.runId !== read.runId) return posFailure('STALE_RUN', 'CONFLICT');
  const attempt = read.posUi.approval;
  if (!attempt?.billId || attempt.attemptId !== input.attemptId || attempt.runId !== input.runId || attempt.quoteFingerprint !== input.expectedQuoteFingerprint) return posFailure('STALE_ATTEMPT', 'CONFLICT');
  if (attempt.closingGeneration !== read.data.closingGeneration || attempt.scenario !== read.scenario) return posFailure('STALE_ATTEMPT', 'CONFLICT');
  const payload = payloadFor({ billId: attempt.billId, splits: attempt.splits, quoteRevision: attempt.quoteRevision!, meta: attempt.meta });
  const prior = read.pos.commandLedger.find(record => record.key === commandKey(attempt.meta, 'approval.begin'));
  if (prior) return checkMeta(read, attempt.meta, 'approval.begin', payload)!;
  if (attempt.status !== 'pending') return posFailure('STALE_ATTEMPT', 'CONFLICT');
  if (read.data.dayClosed) return posFailure('DAY_CLOSED', 'CONFLICT');
  if (read.scenario === 'empty' || read.scenario === 'error') return posFailure('DATA_UNAVAILABLE');
  const quote = quoteBill(read, attempt.billId);
  if (!quote.canSubmit) return posFailure(quote.issues[0].reason, 'VALIDATION', { quote });
  if (quote.fingerprint !== attempt.quoteFingerprint) return posFailure('QUOTE_CHANGED', 'CONFLICT', { quote });
  const checked = checkMeta(read, attempt.meta, 'approval.begin', payload); if (checked) return checked;
  if (!['approved', 'failed'].includes(input.outcome)) return posFailure('INVALID_OUTCOME');
  if (input.outcome === 'failed' || read.scenario === 'payment-failure') return posFailure('APPROVAL_FAILED', 'PREVIEW_FAILURE');
  if (read.settings.paymentStyle !== 'postpaid') return posFailure('PAYMENT_STYLE_REQUIRED', 'CONFLICT');
  if (!validTotals(read, quote.gross, quote.payable, attempt.splits[0].method)) return posFailure('INVALID_AMOUNT');
  if (now.slice(0, 10) !== read.pos.businessDate) return posFailure('BUSINESS_DATE_MISMATCH');
  const billId = attempt.billId, bill = read.pos.bills.find(b => b.billId === billId)!;
  const paymentNo = read.pos.payments.length + 1, seq = read.pos.seq + 1, paymentId = `P-${String(paymentNo).padStart(3, '0')}`;
  const payment: PosPayment = { paymentId, billId, at: now, seq, transactionNo: `거래-${read.pos.businessDate.replaceAll('-', '')}-${String(paymentNo).padStart(4, '0')}`,
    approvalNo: `예시-${String(paymentNo).padStart(6, '0')}`, amount: quote.remaining, splits: attempt.splits, countedMethod: attempt.splits[0].method, status: 'paid', recognizedAt: now };
  const paid = { ...bill, status: 'paid' as const, settledAt: now, recognizedAt: now,
    settlementLines: quote.lines.map(l => ({ allocationId: l.lineId, menuId: l.menuId, qty: l.qty, basePriceAtSale: l.basePrice, optionPriceAtSale: l.optionPrice,
      unitCostAtSale: l.baseCost, optionCostAtSale: l.optionCost, discountAllocations: [], recognizedQty: l.qty })) };
  const nextPos = { ...read.pos, revision: read.posRevision + 1, seq,
    bills: read.pos.bills.map(b => b === bill ? paid : b), payments: [...read.pos.payments.map(p => p.billId === billId && p.status === 'paid' ? { ...p, recognizedAt: now } : p), payment],
    receipts: [...read.pos.receipts, { paymentId, billId }],
    tableSessions: bill.tableId ? [...read.pos.tableSessions.filter(s => s.tableId !== bill.tableId), { tableId: bill.tableId, billId, cleaning: true }] : read.pos.tableSessions };
  return makePlan(read, nextPos, { ...read.posUi, approval: { ...attempt, status: 'succeeded' } },
    { paymentId, billId, orderIds: quote.orderIds, remaining: 0, settled: true }, attempt.meta, 'approval.begin', payload);
}
