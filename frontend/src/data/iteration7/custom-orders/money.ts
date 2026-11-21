import { approved, businessDate, clock, emptyEffects, failure, fingerprint, guard, history, nonempty, positive, replaceOrder, success } from './shared';
import { customPaymentView, customPickup } from './selectors';
import { cancelLinkedOrder } from './commands';
import type { CustomCorrection, CustomFailure, CustomMethodAllocation, CustomOrderRead, CustomPlanResult, CustomReversalQuote, CustomSalesRecognition, CustomSettlement, CustomSettlementQuote, RealMethod } from './types';

const methods: readonly RealMethod[] = ['card', 'easy_pay', 'cash'];
const getOrder = (read: CustomOrderRead, id: string) => read.tables.customOrder.find(o => o.customOrderId === id);

export function quoteCustomSettlement(read: CustomOrderRead, input: { readonly customOrderId: string; readonly allocations: readonly CustomMethodAllocation[] }): CustomSettlementQuote {
  const order = getOrder(read, input.customOrderId), issues: CustomFailure[] = [];
  const paid = order ? customPaymentView(read, order) : null;
  const amountDue = Math.max(0, (order?.quoteAmount ?? 0) - (paid ? paid.amountSettled - paid.amountReturned : 0));
  if (!order) issues.push(failure('NOT_FOUND', 'customOrderId', 'NOT_FOUND'));
  else if (!approved(order)) issues.push(failure('APPROVAL_REQUIRED'));
  else if (!['payment_pending', 'in_production', 'production_complete'].includes(order.stage) || paid!.amountSettled > 0 || customPickup(read, order)?.status !== 'confirmed') issues.push(failure('QUOTE_CHANGED', 'stage', 'CONFLICT'));
  const totals = { card: 0, easy_pay: 0, cash: 0 };
  if (!Array.isArray(input.allocations)) issues.push(failure('INVALID_SETTLEMENT_KIND', 'allocations'));
  else for (const a of input.allocations as readonly CustomMethodAllocation[]) {
    if (!a || a.kind !== 'method' || !methods.includes(a.method)) { issues.push(failure('INVALID_SETTLEMENT_KIND', 'allocations')); break; }
    if (!Number.isSafeInteger(a.amount) || a.amount < 0 || !Number.isSafeInteger(totals[a.method] + a.amount)) { issues.push(failure('AMOUNT_POSITIVE_REQUIRED', 'allocations')); break; }
    totals[a.method] += a.amount;
  }
  const splits = methods.filter(method => totals[method] > 0).map(method => ({ method, amount: totals[method] }));
  const allocations: readonly CustomMethodAllocation[] = splits.map(s => ({ kind: 'method', ...s }));
  const total = splits.reduce((sum, s) => sum + s.amount, 0);
  if (!issues.length && (!positive(amountDue) || !Number.isSafeInteger(total) || total !== amountDue)) issues.push(failure('ALLOCATION_SUM_MISMATCH', 'allocations'));
  return { quoteId: `custom-settlement:${input.customOrderId}:${read.revision}:${fingerprint(allocations)}`, quoteRevision: read.revision, orderQuoteRevision: order?.quoteRevision ?? 0,
    target: { purpose: 'custom_order', customOrderId: input.customOrderId }, amountDue, allocations, realMethodSplits: splits,
    discounts: [], recognitionEffects: [], accountEffects: [], membershipEffects: [], remaining: amountDue - total, canSubmit: !issues.length, issues };
}

export function planCustomSettlement(read: CustomOrderRead, input: { readonly quote: CustomSettlementQuote; readonly settlementId: string; readonly paymentId: string; readonly idempotencyKey: string; readonly baseRevision?: number }): CustomPlanResult {
  const operation = { ...input, type: 'customOrder.settle' };
  const guarded = guard(read, operation); if (guarded) return guarded;
  const quote = input.quote;
  if (!quote || quote.quoteRevision !== read.revision || !quote.target) return failure('QUOTE_CHANGED', 'quoteRevision', 'CONFLICT');
  const current = quoteCustomSettlement(read, { customOrderId: quote.target.customOrderId, allocations: quote.allocations });
  if (fingerprint(current) !== fingerprint(quote)) return failure('QUOTE_CHANGED', 'quote', 'CONFLICT');
  if (!current.canSubmit) return current.issues[0];
  if (!nonempty(input.settlementId) || !nonempty(input.paymentId)) return failure('REQUIRED_FIELD', 'settlementId');
  if (read.money.settlements.some(s => s.settlementId === input.settlementId) || read.money.payments.some(p => p.paymentId === input.paymentId)) return failure('QUOTE_CHANGED', 'settlementId', 'CONFLICT');
  const order = getOrder(read, quote.target.customOrderId)!;
  const sourceRef = { kind: 'custom_order' as const, id: order.customOrderId };
  const settlement: CustomSettlement = { settlementId: input.settlementId, purpose: 'custom_order', sourceRef, billId: null, partId: null, memberId: order.memberId,
    at: clock(read), amount: quote.amountDue, allocations: quote.allocations.map(a => ({ ...a, allocationId: `${input.settlementId}:${a.method}` })), status: 'paid', paymentTiming: order.paymentTiming };
  const row = history(read, { ...order, settlementId: input.settlementId, stage: order.stage === 'payment_pending' ? 'in_production' : order.stage }, 'settled', String(quote.amountDue), input.settlementId);
  return success(read, operation, replaceOrder(read.tables, row), { customOrderId: order.customOrderId, settlementId: input.settlementId, paymentId: input.paymentId, stage: row.stage }, false,
    { ...emptyEffects(), settlements: [settlement], payments: [{ paymentId: input.paymentId, settlementId: input.settlementId, purpose: 'custom_order', sourceRef, at: clock(read), amount: quote.amountDue, splits: structuredClone(quote.realMethodSplits) }] });
}

/** Exact integer largest-remainder allocation; ties follow card/easy_pay/cash contract order. */
function allocateReturns(amount: number, available: Readonly<Record<RealMethod, number>>) {
  const total = methods.reduce((sum, method) => sum + available[method], 0);
  if (!positive(total)) return [];
  const rows = methods.map((method, index) => {
    const product = BigInt(amount) * BigInt(available[method]);
    return { method, index, amount: Number(product / BigInt(total)), remainder: product % BigInt(total) };
  });
  let remaining = amount - rows.reduce((sum, r) => sum + r.amount, 0);
  const ranked = [...rows].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const row of ranked) if (remaining > 0 && row.amount < available[row.method]) { row.amount++; remaining--; }
  return rows.filter(r => r.amount > 0).map(({ method, amount: value }) => ({ method, amount: value }));
}

export function quoteCustomReversal(read: CustomOrderRead, input: { readonly customOrderId: string; readonly kind: 'cancellation' | 'refund'; readonly amount?: number }): CustomReversalQuote {
  const order = getOrder(read, input.customOrderId), issues: CustomFailure[] = [];
  const settlement = order ? read.money.settlements.find(s => s.settlementId === order.settlementId && s.sourceRef.id === order.customOrderId) : undefined;
  const corrections = settlement ? read.money.corrections.filter(c => c.settlementId === settlement.settlementId) : [];
  const available = { card: 0, easy_pay: 0, cash: 0 };
  for (const a of settlement?.allocations ?? []) available[a.method] += a.amount;
  for (const c of corrections) for (const s of c.realMethodReturns) available[s.method] -= s.amount;
  const remainingRefundable = available.card + available.easy_pay + available.cash;
  const amount = input.amount ?? remainingRefundable;
  if (!order || !settlement) issues.push(failure('NOT_FOUND', !order ? 'customOrderId' : 'settlementId', 'NOT_FOUND'));
  else if (input.kind !== 'cancellation' && input.kind !== 'refund') issues.push(failure('REQUIRED_FIELD', 'kind'));
  else if (input.kind === 'cancellation' && order.stage === 'received_by_customer') issues.push(failure('INVALID_STAGE_TRANSITION', 'kind'));
  else if (!positive(amount) || amount > remainingRefundable) issues.push(failure('REFUND_LIMIT', 'amount'));
  const realMethodReturns = !issues.length ? allocateReturns(amount, available) : [];
  const original = read.money.recognitions.find(r => r.source === 'custom_pickup' && r.sourceId === input.customOrderId && r.originalRecognitionId === null);
  const recognitionEffects: CustomSalesRecognition[] = original && !issues.length ? [{ recognitionId: `custom-return:${input.customOrderId}:${read.revision}`, source: 'custom_pickup', sourceId: input.customOrderId,
    businessDate: businessDate(read), at: clock(read), amount: -amount, cost: null, settlementCategory: 'custom_pickup', originalRecognitionId: original.recognitionId }] : [];
  return { quoteId: `custom-reversal:${input.customOrderId}:${read.revision}:${input.kind}:${amount}`, quoteRevision: read.revision, customOrderId: input.customOrderId, settlementId: settlement?.settlementId ?? '', kind: input.kind, amount,
    remainingRefundable, realMethodReturns, recognitionEffects, canSubmit: !issues.length, issues };
}

export function planCustomReversal(read: CustomOrderRead, input: { readonly quote: CustomReversalQuote; readonly idempotencyKey: string; readonly cancelOrder?: boolean; readonly baseRevision?: number }): CustomPlanResult {
  const operation = { ...input, type: 'customOrder.reverse' };
  const guarded = guard(read, operation); if (guarded) return guarded;
  const quote = input.quote;
  if (!quote || quote.quoteRevision !== read.revision) return failure('QUOTE_CHANGED', 'quoteRevision', 'CONFLICT');
  const current = quoteCustomReversal(read, { customOrderId: quote.customOrderId, kind: quote.kind, amount: quote.amount });
  if (fingerprint(current) !== fingerprint(quote)) return failure('QUOTE_CHANGED', 'quote', 'CONFLICT');
  if (!current.canSubmit) return current.issues[0];
  const order = getOrder(read, quote.customOrderId)!;
  if (input.cancelOrder && (order.stage === 'received_by_customer' || quote.amount !== quote.remainingRefundable)) return failure('INVALID_STAGE_TRANSITION', 'cancelOrder');
  const correctionId = `custom-correction:${order.customOrderId}:${read.revision}`;
  if (read.money.corrections.some(c => c.correctionId === correctionId) || quote.recognitionEffects.some(r => read.money.recognitions.some(x => x.recognitionId === r.recognitionId))) return failure('QUOTE_CHANGED', 'correctionId', 'CONFLICT');
  const correction: CustomCorrection = { correctionId, settlementId: quote.settlementId, customOrderId: order.customOrderId, kind: quote.kind, at: clock(read), amount: quote.amount,
    realMethodReturns: structuredClone(quote.realMethodReturns), recognitionEffects: structuredClone(quote.recognitionEffects) };
  const refunded = history(read, order, quote.kind === 'refund' ? 'refunded' : 'canceled', String(quote.amount), correctionId);
  const tables = input.cancelOrder ? cancelLinkedOrder(read, refunded) : replaceOrder(read.tables, refunded);
  return success(read, operation, tables, { customOrderId: order.customOrderId, correctionId, stage: input.cancelOrder ? 'canceled' : order.stage }, false,
    { ...emptyEffects(), corrections: [correction], recognitions: structuredClone(quote.recognitionEffects) });
}
