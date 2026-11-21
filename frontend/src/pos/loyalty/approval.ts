import type { PosApprovalAttempt, PosApprovalInput, PosFinishApproval, PosPayment, PosPlanningResult, PosReadSnapshot } from '../../contracts/pos';
import { canonical, checkMeta, commandKey, freezePos, money, posFailure } from '../domain/common';
import { selectPosDayTotals } from '../domain/money';
import { normalizeMethodSplits } from './splits';
import { getPaymentBillId, paymentBill, quotePaymentBill } from './selectors';
import { approvalPayload, settlePaymentBill } from './settlement';

export function planPaymentBegin(read: PosReadSnapshot, input: PosApprovalInput, now: string): PosPlanningResult {
  if (input.meta.runId !== read.runId) return posFailure('STALE_RUN', 'CONFLICT');
  const payload = approvalPayload(input), payloadFingerprint = canonical(payload), prior = read.posUi.approval;
  if (prior?.status === 'pending') {
    if (prior.scenario !== read.scenario || prior.closingGeneration !== read.data.closingGeneration) return posFailure('STALE_ATTEMPT', 'CONFLICT');
    if (prior.meta.idempotencyKey !== input.meta.idempotencyKey) return posFailure('APPROVAL_BUSY', 'CONFLICT');
    if (prior.payloadFingerprint !== payloadFingerprint) return posFailure('IDEMPOTENCY_MISMATCH', 'CONFLICT');
    return { ok: true, plan: { nextPos: read.pos, nextUi: read.posUi, result: { ok: true, status: 'pending', posRevision: read.posRevision, dataRevision: read.dataRevision, duplicate: true, value: { attemptId: prior.attemptId, status: 'pending' } } } };
  }
  const checked = checkMeta(read, input.meta, 'approval.begin', payload); if (checked) return checked;
  if (prior?.meta.idempotencyKey === input.meta.idempotencyKey && prior.status === 'failed') return prior.payloadFingerprint !== payloadFingerprint
    ? posFailure('IDEMPOTENCY_MISMATCH', 'CONFLICT') : prior.result && !prior.result.ok ? prior.result : posFailure('STALE_ATTEMPT', 'CONFLICT');
  if (read.data.dayClosed) return posFailure('DAY_CLOSED', 'CONFLICT');
  if (read.scenario === 'empty' || read.scenario === 'error') return posFailure('DATA_UNAVAILABLE');
  const billId = 'billId' in input ? input.billId : getPaymentBillId(read), bill = paymentBill(read, billId);
  if (!bill) return posFailure('NOT_FOUND', 'NOT_FOUND');
  if (!bill.cartId && read.settings.paymentStyle !== 'postpaid') return posFailure('PAYMENT_STYLE_REQUIRED', 'CONFLICT');
  if ('cartId' in input && input.cartId !== read.pos.cart.cartId) return posFailure('NOT_FOUND', 'NOT_FOUND');
  const quote = quotePaymentBill(read, billId, now);
  if (!quote.canSubmit) return posFailure(quote.issues[0].reason, 'VALIDATION', { ...quote.issues[0].details, quote });
  const revision = 'cartId' in input ? read.pos.cart.revision : quote.revision;
  if (input.quoteRevision !== revision) return posFailure('QUOTE_CHANGED', 'CONFLICT', { quote });
  if (quote.payable === 0) return posFailure('ZERO_CONFIRM_REQUIRED');
  const part = input.partId ? quote.parts.find(p => p.partId === input.partId) : quote.parts.find(p => p.status === 'unpaid');
  if (bill.splitPlan && (!part || part.status !== 'unpaid') || !bill.splitPlan && input.partId) return posFailure('PART_UNAVAILABLE');
  const normalized = normalizeMethodSplits(input.splits, part?.amount ?? quote.remaining); if (!normalized.ok) return normalized;
  const totals = selectPosDayTotals(read.pos);
  if (![totals.gross + quote.gross, totals.revenue + quote.payable, totals.charged + quote.payable,
    ...normalized.splits.map(s => totals.byMethod[s.method] + s.amount)].every(money)) return posFailure('INVALID_AMOUNT');
  const attempt: PosApprovalAttempt = freezePos({ attemptId: `pos:attempt:${commandKey(input.meta, 'approval.begin')}`, runId: read.runId, meta: input.meta,
    cartId: read.pos.cart.cartId, billId, ...(part ? { partId: part.partId } : {}), quoteRevision: input.quoteRevision, approvalInput: input,
    splits: normalized.splits, payloadFingerprint, quoteFingerprint: quote.fingerprint, scenario: read.scenario, closingGeneration: read.data.closingGeneration, status: 'pending' });
  return { ok: true, plan: { nextPos: read.pos, nextUi: { ...read.posUi, approval: attempt }, result: { ok: true, status: 'pending', posRevision: read.posRevision, dataRevision: read.dataRevision, value: { attemptId: attempt.attemptId, status: 'pending' } } } };
}
export function planPaymentFinish(read: PosReadSnapshot, input: PosFinishApproval, now: string): PosPlanningResult {
  if (input.runId !== read.runId) return posFailure('STALE_RUN', 'CONFLICT');
  const attempt = read.posUi.approval;
  if (!attempt?.billId || !attempt.approvalInput || attempt.attemptId !== input.attemptId || attempt.runId !== input.runId || attempt.quoteFingerprint !== input.expectedQuoteFingerprint) return posFailure('STALE_ATTEMPT', 'CONFLICT');
  if (attempt.closingGeneration !== read.data.closingGeneration || attempt.scenario !== read.scenario) return posFailure('STALE_ATTEMPT', 'CONFLICT');
  const payload = approvalPayload(attempt.approvalInput);
  const checked = checkMeta(read, attempt.meta, 'approval.begin', payload); if (checked) return checked;
  if (attempt.status !== 'pending') return posFailure('STALE_ATTEMPT', 'CONFLICT');
  if (read.data.dayClosed) return posFailure('DAY_CLOSED', 'CONFLICT');
  if (read.scenario === 'error' || read.scenario === 'empty') return posFailure('DATA_UNAVAILABLE');
  if (!['approved', 'failed'].includes(input.outcome)) return posFailure('INVALID_OUTCOME');
  const quote = quotePaymentBill(read, attempt.billId, now);
  if (!quote.canSubmit) return posFailure(quote.issues[0].reason, 'VALIDATION', { ...quote.issues[0].details, quote });
  if (quote.fingerprint !== attempt.quoteFingerprint) return posFailure('QUOTE_CHANGED', 'CONFLICT', { quote });
  if (input.outcome === 'failed' || read.scenario === 'payment-failure') return posFailure('APPROVAL_FAILED', 'PREVIEW_FAILURE');
  if (now.slice(0, 10) !== read.pos.businessDate) return posFailure('BUSINESS_DATE_MISMATCH');
  const bill = paymentBill(read, attempt.billId)!;
  const amount = attempt.splits.reduce((n, s) => n + s.amount, 0), seq = read.pos.seq + 1, number = read.pos.payments.length + 1;
  const normalized = normalizeMethodSplits(attempt.splits, amount); if (!normalized.ok) return normalized;
  const payment: PosPayment = { paymentId: `P-${String(number).padStart(3, '0')}`, billId: bill.billId, ...(attempt.partId ? { partId: attempt.partId } : {}),
    at: now, seq, transactionNo: `거래-${read.pos.businessDate.replaceAll('-', '')}-${String(number).padStart(4, '0')}`, approvalNo: `예시-${String(number).padStart(6, '0')}`,
    amount, splits: normalized.splits, countedMethod: normalized.countedMethod, status: 'paid', recognizedAt: null };
  return settlePaymentBill(read, bill, quote, now, attempt.meta, 'approval.begin', payload, payment, { ...read.posUi, approval: { ...attempt, status: 'succeeded' } });
}
