import type { PosCancellation, PosMethodSplit, PosReadSnapshot, PosRefund, PosReversalCommand, PosReversalInput, PosPlanningResult } from '../../contracts/pos';
import { canonical, checkMeta, makePlan, unchanged } from '../domain/common';
import { distributePosAmount } from '../domain/money';
import { calculateReversal, reversalFailure as posFailure } from './quote';
import { selectPaymentRemaining } from './balances';
import { maskReceiptIdentifier, selectReceipt } from './receipt';

/** Never store the raw cash-receipt identifier in an idempotency fingerprint. */
export function reversalCommandPayload(command: PosReversalCommand) {
  if (command.type === 'cashReceipt.issue') return { type: command.type, paymentId: command.paymentId, kind: command.kind, maskedIdentifier: maskReceiptIdentifier(command.kind, command.identifier) };
  const { meta: _meta, ...payload } = command; return payload;
}
export function planReversalCommand(read: PosReadSnapshot, command: PosReversalCommand, now: string): PosPlanningResult {
  const payload = reversalCommandPayload(command), checked = checkMeta(read, command.meta, command.type, payload); if (checked) return checked;
  if (read.scenario === 'error' || read.scenario === 'empty') return posFailure('DATA_UNAVAILABLE');
  if (read.posUi.approval?.status === 'pending') return posFailure('APPROVAL_BUSY', 'CONFLICT');
  if (command.type === 'receipt.showAgain') {
    if (!selectReceipt(read, { paymentId: command.paymentId })) return posFailure('NOT_FOUND', 'NOT_FOUND');
    const result = unchanged(read, null);
    return result.ok ? { ok: true, plan: { ...result.plan, result: { ...result.plan.result, noticeKey: 'order.receipt.showAgainDone' } } } : result;
  }
  const seq = read.pos.seq + 1, base = { ...read.pos, seq, revision: read.posRevision + 1 };
  if (command.type === 'cashReceipt.issue') {
    if (!['income', 'business'].includes(command.kind) || !(command.kind === 'income' ? /^\d{10,11}$/ : /^\d{10}$/).test(command.identifier)) return {
      ...posFailure('IDENTIFIER_INVALID'), field: 'identifier', messageKey: command.kind === 'income' ? 'order.receipt.incomeInvalid' : 'order.receipt.businessInvalid',
    };
    const balance = selectPaymentRemaining(read.pos, command.paymentId);
    if (!balance) return posFailure('NOT_FOUND', 'NOT_FOUND');
    const cashAmount = balance.methods.find(m => m.method === 'cash')?.amount ?? 0;
    if (cashAmount <= 0) return posFailure('NO_CASH_PORTION');
    if (read.pos.cashReceipts.some(r => r.paymentId === command.paymentId && r.status === 'issued')) return posFailure('ALREADY_ISSUED');
    const cashReceiptId = `CR:${read.pos.businessDate}:${seq}`;
    return makePlan(read, { ...base, cashReceipts: [...read.pos.cashReceipts, { cashReceiptId, paymentId: command.paymentId, kind: command.kind, maskedIdentifier: maskReceiptIdentifier(command.kind, command.identifier), cashAmount, status: 'issued', issuedAt: now }] }, read.posUi,
      { cashReceiptId, paymentId: command.paymentId }, command.meta, command.type, payload);
  }
  if (command.type === 'cashReceipt.cancel') {
    const receipt = read.pos.cashReceipts.find(r => r.cashReceiptId === command.cashReceiptId);
    if (!receipt) return posFailure('NOT_FOUND', 'NOT_FOUND');
    if (!receipt.issuedAt.startsWith(read.pos.businessDate)) return posFailure('NOT_SAME_DAY');
    if (receipt.status === 'canceled') return unchanged(read, { cashReceiptId: receipt.cashReceiptId, paymentId: receipt.paymentId });
    return makePlan(read, { ...base, cashReceipts: read.pos.cashReceipts.map(r => r === receipt ? { ...r, status: 'canceled' } : r) }, read.posUi,
      { cashReceiptId: receipt.cashReceiptId, paymentId: receipt.paymentId }, command.meta, command.type, payload);
  }
  if (command.confirmed !== true) return posFailure('CONFIRMATION_REQUIRED');
  const previous = read.pos.commandLedger.find(r => !r.undone && r.fingerprint === canonical(payload));
  if (previous) return { ok: true, plan: { nextPos: read.pos, nextUi: read.posUi, result: { ...previous.result, duplicate: true } } };
  if (read.data.dayClosed) return posFailure('DAY_CLOSED');
  let input: PosReversalInput;
  try {
    const token = JSON.parse(command.quoteToken);
    if (token.version !== 1 || token.runId !== read.runId || !token.input || typeof token.input.paymentId !== 'string') return posFailure('QUOTE_CHANGED', 'CONFLICT');
    if (token.posRevision !== read.posRevision || token.dataRevision !== read.dataRevision || token.generation !== read.data.closingGeneration || token.scenario !== read.scenario) return posFailure('QUOTE_CHANGED', 'CONFLICT');
    input = token.input;
    if (input.lines !== undefined && !Array.isArray(input.lines) || input.methodAmounts !== undefined && !Array.isArray(input.methodAmounts)) return posFailure('INVALID_SELECTION');
    const calculation = calculateReversal(read, input);
    if (calculation.quote.quoteToken !== command.quoteToken) return posFailure('QUOTE_CHANGED', 'CONFLICT');
  } catch { return posFailure('INVALID_QUOTE'); }
  const { quote, cancelRows, refundRows, cancelAmount } = calculateReversal(read, input);
  if (!quote.canSubmit) return posFailure(quote.issues[0].reason, 'VALIDATION', quote.issues[0].details);
  if (read.scenario === 'payment-failure') return posFailure('REVERSAL_FAILED', 'PREVIEW_FAILURE');
  const payment = read.pos.payments.find(p => p.paymentId === input.paymentId)!;
  const cancelMethods: PosMethodSplit[] = [], refundMethods: PosMethodSplit[] = [];
  // A mixed basket may return retail to stock while refunding made food in the same transaction.
  let cancelLeft = cancelAmount;
  const distributed = distributePosAmount(cancelAmount, quote.methods.map(s => ({ id: s.method, amount: s.amount })));
  for (const method of quote.methods) {
    const amount = Math.min(cancelLeft, distributed[method.method]); cancelLeft -= amount;
    if (amount) cancelMethods.push({ ...method, amount });
    if (method.amount - amount) refundMethods.push({ ...method, amount: method.amount - amount });
  }
  const cancellationId = `C:${read.pos.businessDate}:${seq}`, refundId = `R:${read.pos.businessDate}:${seq}`;
  const cancellation: PosCancellation = { cancellationId, paymentId: payment.paymentId, billId: payment.billId, at: now, seq, amount: cancelAmount, methodAmounts: cancelMethods, allocations: cancelRows, reason: '', restockRetail: !!input.restockRetail };
  const refund: PosRefund = { refundId, paymentId: payment.paymentId, billId: payment.billId, at: now, seq, amount: refundRows.reduce((n, r) => n + r.amount, 0), methodAmounts: refundMethods, lineAmounts: refundRows, reason: '' };
  const cancellations = cancelRows.length ? [...read.pos.cancellations, cancellation] : read.pos.cancellations;
  const refunds = refundRows.length ? [...read.pos.refunds, refund] : read.pos.refunds;
  const fullyCanceled = cancelRows.length > 0 && !refundRows.length && read.pos.refunds.every(r => r.paymentId !== payment.paymentId) && quote.amount === quote.remaining;
  const payments = fullyCanceled ? read.pos.payments.map(p => p === payment ? { ...p, status: 'canceled' as const } : p) : read.pos.payments;
  const next = { ...base, cancellations, refunds,
    payments,
    orders: read.pos.orders.map(o => {
      const lines = o.lines.map(l => ({ ...l, canceledQty: l.canceledQty + cancelRows.filter(a => a.lineId === l.orderLineId).reduce((n, a) => n + a.qty, 0) }));
      const billIds = new Set(read.pos.billAllocations.filter(a => lines.some(l => l.orderLineId === a.orderLineId)).map(a => a.billId));
      const canceled = lines.every(l => l.canceledQty === l.qty) && payments.filter(p => billIds.has(p.billId)).every(p => p.status === 'canceled');
      return lines.every((l, i) => l.canceledQty === o.lines[i].canceledQty) && !canceled ? o : { ...o, lines, preparation: canceled ? 'canceled' as const : o.preparation };
    }),
    cashReceipts: fullyCanceled ? read.pos.cashReceipts.map(r => r.paymentId === payment.paymentId && r.status === 'issued' ? { ...r, status: 'canceled' as const } : r) : read.pos.cashReceipts };
  return makePlan(read, next, read.posUi, { correctionId: cancelRows.length ? cancellationId : refundId, paymentId: payment.paymentId }, command.meta, command.type, payload);
}
