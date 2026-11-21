import type { PosFailure, PosQuoteIssue, PosReadSnapshot, PosReversalInput, PosReversalQuote } from '../../contracts/pos';
import { canonical, freezePos, money, posFailure } from '../domain/common';
import { allocatePosAmount } from '../domain/money';
import { paymentLineBalances, selectPaymentRemaining } from './balances';

const portion = (amount: number, qty: number, totalQty: number) => qty === totalQty ? amount : Number(BigInt(amount) * BigInt(qty) / BigInt(totalQty));
const reversalCopy = new Set(['DAY_CLOSED', 'WHOLE_BILL_DISCOUNT', 'REFUND_LIMIT', 'USE_REFUND', 'REVERSAL_FAILED', 'EMPTY_SELECTION']);
export function reversalFailure(reason: string, code: PosFailure['code'] = 'VALIDATION', details?: PosFailure['details']): PosFailure {
  const failure = posFailure(reason, code, details);
  return reversalCopy.has(reason) ? { ...failure, messageKey: `order.reversal.${reason}` } : failure;
}
export function calculateReversal(read: PosReadSnapshot, input: PosReversalInput) {
  const issues: PosQuoteIssue[] = [];
  const issue = (reason: string, details?: Readonly<Record<string, unknown>>) => issues.push({ reason, messageKey: reversalFailure(reason).messageKey, ...(details ? { details } : {}) });
  const payment = read.pos.payments.find(p => p.paymentId === input.paymentId), bill = read.pos.bills.find(b => b.billId === payment?.billId);
  const balance = selectPaymentRemaining(read.pos, input.paymentId), rows = paymentLineBalances(read.pos, input.paymentId);
  if (read.data.dayClosed) issue('DAY_CLOSED');
  else if (read.scenario === 'error' || read.scenario === 'empty') issue('DATA_UNAVAILABLE');
  else if (!payment || !bill) issue('NOT_FOUND');
  else if (payment.status === 'canceled' || !balance?.remaining) issue('ALREADY_REVERSED');
  else if (!payment.recognizedAt || bill.status !== 'paid') issue('NOT_RECOGNIZED');
  if (input.kind !== 'cancel' && input.kind !== 'refund') issue('VALIDATION');
  if (input.lines && input.amount !== undefined || input.kind === 'cancel' && input.amount !== undefined || input.lines && (!input.lines.length || new Set(input.lines.map(l => l.orderLineId)).size !== input.lines.length)) issue('INVALID_SELECTION');
  if (input.lines?.some(l => !Number.isSafeInteger(l.qty) || l.qty <= 0 || !rows.some(r => r.orderLineId === l.orderLineId))) issue('INVALID_SELECTION');
  const selected = rows.filter(r => !input.lines || input.lines.some(l => l.orderLineId === r.orderLineId));
  const cancelRows: { allocationId: string; lineId: string; qty: number; gross: number; discount: number; cost: number | null; discountAllocations: { discountId: string; amount: number }[] }[] = [];
  const refundRows: { orderLineId: string; qty: number; amount: number }[] = [];
  for (const row of selected) {
    const order = read.pos.orders.find(o => o.lines.some(l => l.orderLineId === row.orderLineId));
    const retail = read.data.catalog.items.find(m => m.menuId === row.menuId)?.kind === 'retail';
    const cancel = input.kind === 'cancel' || !!input.restockRetail && retail;
    const requested = input.lines?.find(l => l.orderLineId === row.orderLineId)?.qty;
    const availableQty = cancel ? row.qty : row.qty - row.refundedQty;
    const qty = requested ?? availableQty;
    if (!Number.isSafeInteger(qty) || qty < 0 || qty > availableQty) { issue('QTY_LIMIT'); continue; }
    if (cancel && order?.preparation !== 'accepted' && !(input.restockRetail && retail)) issue('USE_REFUND');
    if (!cancel && order?.preparation === 'accepted') issue('USE_CANCEL');
    if (cancel) {
      const gross = portion(row.gross, qty, row.qty), discountAllocations = row.discountAllocations.map(d => ({ ...d, amount: portion(d.amount, qty, row.qty) }));
      const discount = discountAllocations.reduce((n, d) => n + d.amount, 0);
      if (gross - discount > row.net) issue('REFUND_LIMIT', { remaining: balance?.remaining ?? 0 });
      cancelRows.push({ allocationId: row.allocationId, lineId: row.orderLineId, qty, gross, discount, cost: row.unitCost === null ? null : row.unitCost * qty, discountAllocations });
    } else {
      const amount = requested === undefined ? row.net : portion(row.net, qty, availableQty);
      refundRows.push({ orderLineId: row.orderLineId, qty: input.amount === undefined ? qty : 0, amount });
    }
  }
  if (input.restockRetail && !selected.some(r => read.data.catalog.items.find(m => m.menuId === r.menuId)?.kind === 'retail')) issue('RETAIL_REQUIRED');
  const cancelAmount = cancelRows.reduce((n, r) => n + r.gross - r.discount, 0);
  if (input.amount !== undefined && (!money(input.amount) || input.amount <= 0 || input.amount > (balance?.remaining ?? 0))) issue('REFUND_LIMIT', { remaining: balance?.remaining ?? 0 });
  if (input.amount !== undefined && cancelRows.length) issue('INVALID_SELECTION');
  if (input.amount !== undefined && money(input.amount) && input.amount <= refundRows.reduce((n, r) => n + r.amount, 0)) {
    const amounts = allocatePosAmount(input.amount, refundRows.map(r => ({ id: r.orderLineId, amount: r.amount })));
    for (const row of refundRows) row.amount = amounts[row.orderLineId];
  }
  const amount = input.amount ?? cancelAmount + refundRows.reduce((n, r) => n + r.amount, 0);
  if (!money(amount) || amount <= 0) issue('EMPTY_SELECTION');
  if (amount > (balance?.remaining ?? 0)) issue('REFUND_LIMIT', { remaining: balance?.remaining ?? 0 });
  if (cancelRows.length && bill?.discounts.some(d => d.scope === 'bill') && (amount !== balance?.remaining || cancelRows.some(a => a.qty !== rows.find(r => r.allocationId === a.allocationId)!.qty) || cancelRows.length !== rows.length)) issue('WHOLE_BILL_DISCOUNT');
  let methods = input.methodAmounts ? [...input.methodAmounts] : balance?.methods.filter(s => s.amount > 0) ?? [];
  if (input.methodAmounts) {
    if (!methods.length || new Set(methods.map(s => s.method)).size !== methods.length || methods.some(s => !money(s.amount) || s.amount <= 0 || s.amount > (balance?.methods.find(m => m.method === s.method)?.amount ?? 0)) || methods.reduce((n, s) => n + s.amount, 0) !== amount) issue('METHOD_LIMIT', { remaining: balance?.remaining ?? 0 });
  } else if (amount !== balance?.remaining) {
    if (methods.length > 1) issue('METHOD_REQUIRED');
    else methods = methods.map(s => ({ ...s, amount }));
  }
  const hasRefund = refundRows.some(r => r.amount > 0);
  const restoresBill = !!cancelRows.length && !hasRefund && amount === balance?.remaining && !!bill
    && !read.pos.refunds.some(r => r.paymentId === payment?.paymentId)
    && read.pos.payments.filter(p => p.billId === bill.billId && p.paymentId !== payment?.paymentId).every(p => p.status === 'canceled');
  // Match the committed loyalty contributions: refunds and zero-won recognized bills keep a use alive.
  // Transferred fragments retain coupon discountId/codeId and membership useId, even at zero discount.
  const otherLiveDiscounts = read.pos.bills.filter(other => other.billId !== bill?.billId && other.status === 'paid' && other.recognizedAt
    && (!read.pos.payments.some(p => p.billId === other.billId) || read.pos.payments.some(p => p.billId === other.billId && p.status === 'paid'))).flatMap(other => other.discounts);
  const restoresCoupon = restoresBill && bill!.discounts.some(d => d.source === 'coupon' && !!d.codeId
    && !otherLiveDiscounts.some(other => other.source === 'coupon' && other.codeId === d.codeId && other.discountId === d.discountId));
  const restoresMembership = restoresBill && bill!.discounts.some(d => d.source === 'membership' && !!d.membershipId && !!d.useId
    && !otherLiveDiscounts.some(other => other.source === 'membership' && !!other.membershipId && other.useId === d.useId));
  const kind = cancelRows.length && !hasRefund ? 'cancel' as const : input.kind;
  const quote: PosReversalQuote = freezePos({ quoteToken: canonical({ version: 1, runId: read.runId, posRevision: read.posRevision, dataRevision: read.dataRevision, generation: read.data.closingGeneration, scenario: read.scenario, input }),
    amount, kind, methods, remaining: balance?.remaining ?? 0, salesEffect: cancelRows.length ? 'restore' : 'keep', stockEffect: cancelRows.length ? 'restore' : 'keep',
    couponEffect: restoresCoupon ? 'restore' : 'keep', membershipEffect: restoresMembership ? 'restore' : 'keep',
    canSubmit: issues.length === 0, issues,
    lines: selected.map(r => ({ orderLineId: r.orderLineId, menuId: r.menuId, name: read.pos.orders.flatMap(o => o.lines).find(l => l.orderLineId === r.orderLineId)!.nameAtOrder,
      qty: cancelRows.find(a => a.lineId === r.orderLineId)?.qty ?? refundRows.find(a => a.orderLineId === r.orderLineId)?.qty ?? 0,
      amount: cancelRows.filter(a => a.lineId === r.orderLineId).reduce((n, a) => n + a.gross - a.discount, 0) + refundRows.filter(a => a.orderLineId === r.orderLineId).reduce((n, a) => n + a.amount, 0) })) });
  return { quote, cancelRows, refundRows: refundRows.filter(r => r.amount > 0), cancelAmount };
}

/** No side effects: closing the confirmation discards this value. */
export function quoteReversal(read: PosReadSnapshot, input: PosReversalInput): PosReversalQuote {
  return calculateReversal(read, input).quote;
}
