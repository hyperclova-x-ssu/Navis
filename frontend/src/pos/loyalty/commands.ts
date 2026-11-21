import type { PosBill, PosLoyaltyCommand, PosPlanningResult, PosReadSnapshot } from '../../contracts/pos';
import { canonical, checkMeta, makePlan, posFailure, unchanged } from '../domain/common';
import { buildSplitPlan } from './splits';
import { paymentBill, quotePaymentBill } from './selectors';
import { allocateBillDiscounts, quoteDiscount } from './discounts';
import { settlePaymentBill } from './settlement';

export const loyaltyCommandPayload = (command: PosLoyaltyCommand) => { const { meta: _meta, ...payload } = command; return payload; };
export function planLoyaltyCommand(read: PosReadSnapshot, command: PosLoyaltyCommand, now: string): PosPlanningResult {
  const payload = loyaltyCommandPayload(command), checked = checkMeta(read, command.meta, command.type, payload); if (checked) return checked;
  if (read.posUi.approval?.status === 'pending') return posFailure('APPROVAL_BUSY', 'CONFLICT');
  if (read.data.dayClosed) return posFailure('DAY_CLOSED', 'CONFLICT');
  if (read.scenario === 'error' || read.scenario === 'empty') return posFailure('DATA_UNAVAILABLE');
  const bill = paymentBill(read, command.billId);
  if (!bill) return posFailure('NOT_FOUND', 'NOT_FOUND');
  if (!['open', 'partial'].includes(bill.status)) return posFailure('STATE_CONFLICT', 'CONFLICT');
  const quote = quotePaymentBill(read, bill.billId, now);
  const payments = read.pos.payments.filter(p => p.billId === bill.billId && p.status === 'paid');
  const save = (next: PosBill, extra: Partial<PosReadSnapshot['pos']> = {}, value: Parameters<typeof makePlan>[3] = null) => makePlan(read,
    { ...read.pos, ...extra, revision: read.posRevision + 1, bills: [...read.pos.bills.filter(b => b.billId !== bill.billId), next] },
    { ...read.posUi, cartUndo: null, tablesUndo: null }, value, command.meta, command.type, payload);
  if (command.type === 'bill.clearSplit') {
    if (payments.length) return posFailure('BILL_LOCKED', 'CONFLICT');
    if (bill.cartId) {
      if (!read.pos.bills.some(b => b.billId === bill.billId)) return unchanged(read, null);
      return makePlan(read, { ...read.pos, revision: read.posRevision + 1, bills: read.pos.bills.filter(b => b.billId !== bill.billId) }, read.posUi, null, command.meta, command.type, payload);
    }
    if (!bill.splitPlan) return unchanged(read, null);
    const { splitPlan: _plan, ...next } = bill;
    return save(next);
  }
  if (command.type === 'bill.cancelPartial') {
    if (!command.confirmed) return posFailure('CONFIRMATION_REQUIRED');
    if (!payments.length || bill.status !== 'partial') return posFailure('STATE_CONFLICT', 'CONFLICT');
    if (read.scenario === 'payment-failure') return posFailure('REVERSAL_FAILED', 'PREVIEW_FAILURE');
    let seq = read.pos.seq;
    const cancellations = payments.map(p => ({ cancellationId: `pos:partial:${p.paymentId}`, paymentId: p.paymentId, billId: bill.billId, at: now, seq: ++seq,
      amount: p.amount, methodAmounts: p.splits, allocations: [], reason: 'partial', restockRetail: false }));
    const { splitPlan: _split, requestedAt: _requested, ...retained } = bill;
    return save({ ...retained, status: bill.cartId ? 'void' : 'open' }, { seq, cancellations: [...read.pos.cancellations, ...cancellations],
      payments: read.pos.payments.map(p => payments.includes(p) ? { ...p, status: 'canceled' as const } : p),
      cart: read.pos.cart.lock === bill.billId ? { ...read.pos.cart, lock: null, revision: read.pos.cart.revision + 1 } : read.pos.cart,
      tableSessions: read.pos.tableSessions.map(s => s.billId === bill.billId
        ? { tableId: s.tableId, ...(bill.cartId ? {} : { billId: bill.billId }), cleaning: false } : s) });
  }
  if (command.type === 'bill.confirmZero') {
    if (!quote.canSubmit) return posFailure(quote.issues[0].reason, 'VALIDATION', { quote });
    if (quote.payable !== 0 || payments.length) return posFailure('ZERO_AMOUNT_REQUIRED');
    return settlePaymentBill(read, bill, quote, now, command.meta, command.type, payload);
  }
  if (command.type === 'bill.split') {
    if (payments.length) return posFailure('BILL_LOCKED', 'CONFLICT');
    if (!quote.canSubmit) return posFailure(quote.issues[0].reason, 'VALIDATION', { quote });
    const result = buildSplitPlan(quote, command); if (!result.ok) return result;
    return save({ ...bill, discounts: quote.discounts, splitPlan: result.plan });
  }
  if (bill.splitPlan || payments.length || bill.discounts.some(d => d.fixedAllocations)) return posFailure('BILL_LOCKED', 'CONFLICT');
  if (command.type === 'bill.member') {
    if (command.memberId !== null && !read.data.loyalty?.members.some(m => m.memberId === command.memberId)) return posFailure('MEMBER_NOT_FOUND', 'NOT_FOUND');
    if ((bill.memberId ?? null) === command.memberId) return unchanged(read, null);
    // A pass is tied to its member; remove it together when that member is disconnected.
    const next = { ...bill, memberLinkChosen: true, memberId: command.memberId ?? undefined, discounts: bill.discounts.filter(d => d.source !== 'membership') };
    for (const d of next.discounts.filter(d => d.source === 'coupon')) {
      const check = quoteDiscount(read, next, quote.lines, { source: 'coupon', couponId: d.couponId!, codeId: d.codeId }, now);
      if (!check.ok) return check;
    }
    return save(next);
  }
  if (command.type === 'bill.removeDiscount') {
    if (!bill.discounts.some(d => d.discountId === command.discountId)) return unchanged(read, null);
    return save({ ...bill, discounts: bill.discounts.filter(d => d.discountId !== command.discountId) });
  }
  if (bill.discounts.some(d => d.source === command.discountInput.source)) return posFailure('DISCOUNT_ALREADY_APPLIED');
  const discount = quoteDiscount(read, bill, quote.lines, command.discountInput, now); if (!discount.ok) return discount;
  const discounts = [...quote.discounts, discount.discount];
  try { allocateBillDiscounts(quote.lines, discounts); } catch { return posFailure('DISCOUNT_EXCEEDS_GROSS'); }
  if (discounts.reduce((n, d) => n + d.amount, 0) > quote.gross) return posFailure('DISCOUNT_EXCEEDS_GROSS');
  if (canonical(discounts) === canonical(bill.discounts)) return unchanged(read, null);
  return save({ ...bill, discounts });
}
