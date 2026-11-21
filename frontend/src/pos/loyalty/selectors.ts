import type { PosBill, PosDiscount, PosLoyaltyQuote, PosReadSnapshot, PosQuotedLine, PosSettlementLine } from '../../contracts/pos';
import { canonical, freezePos, posFailure } from '../domain/common';
import { quoteCart } from '../domain/cart';
import { quoteBill } from '../tables';
import { allocateBillDiscounts, quoteDiscount } from './discounts';
import { businessNow } from '../clock';
import { allocatePosAmount } from '../domain/money';
import { quoteMembershipUse } from '../../data/iteration7/memberships';
import { moneyReadBase } from '../../data/pos/projection';
import type { DataSnapshot } from '../../data/db/types';
import { nextOrderNumber } from '../tables/commands';

/** The ID also identifies a virtual prepaid bill before the first loyalty command. */
export function getPaymentBillId(read: PosReadSnapshot): string {
  const active = read.pos.cart.lock ?? read.pos.bills.find(b => b.cartId === read.pos.cart.cartId && b.status === 'open')?.billId;
  if (active) return active;
  const base = `B-${String(nextOrderNumber(read.pos)).padStart(3, '0')}`;
  let id = base, suffix = 1;
  while (read.pos.bills.some(b => b.billId === id)) id = `${base}-${++suffix}`;
  return id;
}
export function paymentBill(read: PosReadSnapshot, billId: string): PosBill | undefined {
  const existing = read.pos.bills.find(b => b.billId === billId);
  if (existing) {
    const reservation = read.data.reservations?.find(r => r.reservationId === existing.reservationId && r.status === 'completed');
    const memberId = reservation?.memberId;
    return !existing.memberLinkChosen && !existing.memberId && memberId && read.data.loyalty?.members.some(m => m.memberId === memberId)
      ? { ...existing, memberId } : existing;
  }
  if (billId !== getPaymentBillId(read) || read.settings.paymentStyle !== 'prepaid' && read.pos.cart.type !== 'takeout') return undefined;
  return { billId, cartId: read.pos.cart.cartId, originOrderNo: Math.max(0, ...read.pos.orders.map(o => o.orderNo)) + 1,
    tableId: null, status: 'open', discounts: [], settlementLines: [] };
}
/** Frozen transferred won allocations consume capacity before any untransferred benefits. */
function transferredSettlement(lines: readonly PosQuotedLine[], discounts: readonly PosDiscount[]): readonly PosSettlementLine[] {
  const capacity = new Map(lines.map(l => [l.lineId, l.gross]));
  const byLine = new Map(lines.map(l => [l.lineId, [] as { discountId: string; amount: number }[]]));
  const take = (id: string, discountId: string, amount: number) => {
    const available = capacity.get(id);
    if (available === undefined || !Number.isSafeInteger(amount) || amount < 0 || amount > available) throw new Error('INVALID_FIXED_DISCOUNT');
    capacity.set(id, available - amount);
    if (amount) byLine.get(id)!.push({ discountId, amount });
  };
  for (const d of discounts.filter(d => d.fixedAllocations)) {
    if (d.fixedAllocations!.reduce((n, a) => n + a.amount, 0) !== d.amount) throw new Error('INVALID_FIXED_DISCOUNT');
    for (const a of d.fixedAllocations!) take(a.allocationId, d.discountId, a.amount);
  }
  for (const d of discounts.filter(d => !d.fixedAllocations).sort((a, b) => Number(a.scope === 'bill') - Number(b.scope === 'bill') || a.discountId.localeCompare(b.discountId))) {
    const targets = lines.filter(l => d.scope === 'bill' || d.allocationId === l.lineId || d.targetAllocationIds?.includes(l.lineId));
    const amounts = allocatePosAmount(d.amount, targets.map(l => ({ id: l.lineId, amount: capacity.get(l.lineId)! })));
    for (const l of targets) take(l.lineId, d.discountId, amounts[l.lineId]);
  }
  return lines.map(l => ({ allocationId: l.lineId, menuId: l.menuId, qty: l.qty, basePriceAtSale: l.basePrice, optionPriceAtSale: l.optionPrice,
    unitCostAtSale: l.baseCost, optionCostAtSale: l.optionCost, discountAllocations: byLine.get(l.lineId)!, recognizedQty: l.qty }));
}
const cache = new WeakMap<PosReadSnapshot, Map<string, PosLoyaltyQuote>>();
const memberSearches = new WeakMap<PosReadSnapshot, Map<string, ReturnType<typeof searchMembers>>>();
function searchMembers(read: PosReadSnapshot, phoneSuffix: string) {
  if (!/^\d{4}$/.test(phoneSuffix)) return posFailure('PHONE_SUFFIX_INVALID');
  if (read.scenario === 'error' || read.scenario === 'empty') return posFailure('DATA_UNAVAILABLE');
  return freezePos({ ok: true as const, rows: (read.data.loyalty?.members ?? []).filter(m => m.phone.endsWith(phoneSuffix)) });
}
export function quotePaymentBill(read: PosReadSnapshot, billId = getPaymentBillId(read), now = businessNow()): PosLoyaltyQuote {
  let quotes = cache.get(read); if (!quotes) { quotes = new Map(); cache.set(read, quotes); }
  const key = canonical([billId, now]), hit = quotes.get(key); if (hit) return hit;
  const bill = paymentBill(read, billId);
  const base = bill?.cartId
    ? { ...quoteCart({ ...read, pos: { ...read.pos, cart: { ...read.pos.cart, lock: null } } }, bill.cartId), billId, orderIds: [] as string[], received: 0, remaining: 0 }
    : quoteBill(read, billId);
  const issues = [...base.issues];
  if (!bill) issues.unshift({ reason: 'NOT_FOUND', messageKey: 'run.session.conflict' });
  else if (!['open', 'partial'].includes(bill.status)) issues.unshift({ reason: 'STATE_CONFLICT', messageKey: 'run.session.conflict' });
  if (bill?.memberId && !read.data.loyalty?.members.some(m => m.memberId === bill.memberId)) issues.push({ reason: 'MEMBER_NOT_FOUND', messageKey: 'run.session.conflict' });
  const lines = bill?.splitPlan?.lines ?? base.lines;
  if (bill?.splitPlan && canonical(base.lines.map(l => [l.lineId, l.qty, l.unitPrice, l.options.map(o => o.optionId)])) !== canonical(lines.map(l => [l.lineId, l.qty, l.unitPrice, l.options.map(o => o.optionId)]))) {
    issues.push({ reason: 'QUOTE_CHANGED', messageKey: 'run.session.conflict' });
  }
  const discounts: PosDiscount[] = [];
  for (const old of bill?.discounts ?? []) {
    if (old.fixedAllocations || bill?.splitPlan && old.source==='membership' && read.pos.money?.uses.some(u=>u.useId===old.useId&&!u.canceledAt&&u.sourceRef.id===billId)) { discounts.push(old); continue; }
    const input = old.source === 'direct' ? { source: 'direct' as const, ...(old.percent === undefined ? { amount: old.amount } : { percent: old.percent }), memo: old.memo }
      : old.source === 'coupon' ? { source: 'coupon' as const, couponId: old.couponId!, codeId: old.codeId }
        : { source: 'membership' as const, membershipId: old.membershipId! };
    const checked = quoteDiscount(read, bill!, lines, input, now);
    if (!checked.ok) issues.push({ reason: checked.reason, messageKey: checked.messageKey, details: checked.details });
    let discount=bill?.splitPlan || !checked.ok ? old : { ...checked.discount, discountId: old.discountId };
    const snapshot=read.data.source as DataSnapshot|undefined;
    if(read.pos.money && snapshot?.tables && checked.ok && discount.source==='membership' && discount.membershipId && !bill?.splitPlan){
      const lineId=discount.allocationId??discount.targetAllocationIds?.[0],line=lines.find(l=>l.lineId===lineId);
      if(line){const source={sourceRef:{kind:'bill',id:billId},purpose:'sale' as const,billId,memberId:bill?.memberId??null,amountDue:base.gross,fingerprint:base.fingerprint,orderIds:base.orderIds,lines:lines.map(l=>({allocationId:l.lineId,orderLineId:l.lineId,menuId:l.menuId,category:read.data.catalog.items.find(m=>m.menuId===l.menuId)?.category,quantity:l.qty,unitPrice:l.unitPrice,unitCost:l.unitCost}))};
        const use=quoteMembershipUse({...moneyReadBase(snapshot),state:read.pos.money,now},{membershipId:discount.membershipId,source,allocationId:lineId!,quantity:1,useId:discount.useId});
        if(use.canSubmit)discount={...discount,amount:use.membershipDiscount,useId:use.useId};
      }
    }
    discounts.push(discount);
  }
  const discount = discounts.reduce((n, d) => n + d.amount, 0), gross = lines.reduce((n, l) => n + l.gross, 0);
  let settlementLines = bill?.splitPlan?.settlementLines ?? [];
  try { if (!bill?.splitPlan) settlementLines = discounts.some(d => d.fixedAllocations) ? transferredSettlement(lines, discounts) : allocateBillDiscounts(lines, discounts); }
  catch { issues.push({ reason: 'DISCOUNT_EXCEEDS_GROSS', messageKey: 'order.discount.exceeds' }); }
  const received = read.pos.money ? read.pos.money.settlements.filter(s=>s.purpose==='sale'&&s.billId===billId).reduce((n,s)=>n+s.amount-read.pos.money!.corrections.filter(c=>c.settlementId===s.settlementId).reduce((n,c)=>n+c.amount,0),0) : read.pos.payments.filter(p => p.billId === billId && p.status === 'paid').reduce((n, p) => n + p.amount, 0);
  const payable = gross - discount;
  const quote: PosLoyaltyQuote = freezePos({ ...base, billId, revision: read.posRevision, lines, gross, discount, payable, received, remaining: payable - received,
    discounts, settlementLines, parts: bill?.splitPlan?.parts ?? [], ...(bill?.memberId ? { memberId: bill.memberId } : {}),
    issues, canSubmit: issues.length === 0, fingerprint: canonical({ bill, lines, discounts, received, data: read.data.loyalty, cart: bill?.cartId ? read.pos.cart.revision : undefined }) });
  quotes.set(key, quote); return quote;
}
export function findPosMembers(read: PosReadSnapshot, { phoneSuffix }: { readonly phoneSuffix: string }) {
  let searches = memberSearches.get(read); if (!searches) { searches = new Map(); memberSearches.set(read, searches); }
  const hit = searches.get(phoneSuffix); if (hit) return hit;
  const result = searchMembers(read, phoneSuffix); searches.set(phoneSuffix, result); return result;
}
function discountOptions(read: PosReadSnapshot, billId: string, now: string) {
  const bill = paymentBill(read, billId), quote = quotePaymentBill(read, billId, now);
  const availability = (checked: ReturnType<typeof quoteDiscount>) => checked.ok ? { available: true as const, amount: checked.discount.amount }
    : { available: false as const, reason: String(checked.details?.reason ?? checked.reason) };
  return freezePos({ locked: !!bill?.splitPlan || bill?.status === 'partial' || !!bill?.discounts.some(d => d.fixedAllocations), memberRequired: !bill?.memberId,
    coupons: (read.data.loyalty?.coupons ?? []).map(c => ({ ...c, ...availability(quoteDiscount(read, bill ?? { billId, originOrderNo: 0, tableId: null, status: 'open', discounts: [], settlementLines: [] }, quote.lines, { source: 'coupon', couponId: c.couponId }, now)) })),
    passes: (read.data.loyalty?.passes ?? []).filter(p => !!bill?.memberId && p.memberId === bill.memberId).map(p => ({ ...p, ...availability(quoteDiscount(read, bill ?? { billId, originOrderNo: 0, tableId: null, status: 'open', discounts: [], settlementLines: [] }, quote.lines, { source: 'membership', membershipId: p.membershipId }, now)) })) });
}
const optionReads = new WeakMap<PosReadSnapshot, Map<string, ReturnType<typeof discountOptions>>>();
export function selectPosDiscountOptions(read: PosReadSnapshot, billId = getPaymentBillId(read), now = businessNow()) {
  let options = optionReads.get(read); if (!options) { options = new Map(); optionReads.set(read, options); }
  const key = canonical([billId, now]), hit = options.get(key); if (hit) return hit;
  const result = discountOptions(read, billId, now); options.set(key, result); return result;
}
