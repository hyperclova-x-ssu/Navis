import type { PosBill, PosDiscount, PosDiscountInput, PosQuotedLine, PosReadSnapshot, PosSettlementLine } from '../../contracts/pos';
import { freezePos, money, posFailure } from '../domain/common';
import { allocatePosAmount } from '../domain/money';

/** Scope-specific benefits consume capacity before whole-bill discounts. */
export function allocateBillDiscounts(lines: readonly PosQuotedLine[], discounts: readonly PosDiscount[]): readonly PosSettlementLine[] {
  const capacity = new Map(lines.map(l => [l.lineId, l.gross]));
  const byLine = new Map(lines.map(l => [l.lineId, [] as { discountId: string; amount: number }[]]));
  for (const discount of [...discounts].sort((a, b) => Number(a.scope === 'bill') - Number(b.scope === 'bill') || a.discountId.localeCompare(b.discountId))) {
    const targets = lines.filter(l => discount.scope === 'bill' || discount.allocationId === l.lineId || discount.targetAllocationIds?.includes(l.lineId));
    const allocation = allocatePosAmount(discount.amount, targets.map(l => ({ id: l.lineId, amount: capacity.get(l.lineId)! })));
    for (const l of targets) {
      const amount = allocation[l.lineId];
      if (amount) byLine.get(l.lineId)!.push({ discountId: discount.discountId, amount });
      capacity.set(l.lineId, capacity.get(l.lineId)! - amount);
    }
  }
  return freezePos(lines.map(l => ({ allocationId: l.lineId, menuId: l.menuId, qty: l.qty, basePriceAtSale: l.basePrice, optionPriceAtSale: l.optionPrice,
    unitCostAtSale: l.baseCost, optionCostAtSale: l.optionCost, discountAllocations: byLine.get(l.lineId)!, recognizedQty: l.qty })));
}
const percentOf = (amount: number, percent: number) => Number(BigInt(amount) * BigInt(percent) / 100n);
export function quoteDiscount(read: PosReadSnapshot, bill: PosBill, lines: readonly PosQuotedLine[], input: PosDiscountInput, now: string) {
  const gross = lines.reduce((n, l) => n + l.gross, 0);
  const base = { discountId: `${bill.billId}:discount:${input.source}`, billId: bill.billId, source: input.source };
  if (input.source === 'direct') {
    if ((input.amount === undefined) === (input.percent === undefined) || input.amount !== undefined && (!money(input.amount) || input.amount === 0)
      || input.percent !== undefined && (!Number.isInteger(input.percent) || input.percent < 1 || input.percent > 100)) return posFailure('INVALID_AMOUNT');
    if ((input.memo?.length ?? 0) > 100) return posFailure('TEXT_LIMIT');
    return { ok: true as const, discount: { ...base, scope: 'bill' as const, amount: input.percent === undefined ? input.amount! : percentOf(gross, input.percent),
      ...(input.percent !== undefined ? { percent: input.percent } : {}), ...(input.memo ? { memo: input.memo } : {}) } };
  }
  const unavailable = (reason: string) => posFailure(input.source === 'coupon' ? 'COUPON_UNAVAILABLE' : 'PASS_UNAVAILABLE', 'VALIDATION', { reason });
  if (input.source === 'membership') {
    if (!bill.memberId) return unavailable('MEMBER_REQUIRED');
    const pass = read.data.loyalty?.passes.find(p => p.membershipId === input.membershipId);
    if (!pass || pass.memberId !== bill.memberId) return unavailable('PASS_MEMBER_MISMATCH');
    if (!pass.active || pass.startsOn > now.slice(0, 10) || pass.endsOn < now.slice(0, 10) || pass.usesLeft !== null && pass.usesLeft < 1) return unavailable('PASS_INACTIVE');
    if (pass.kind === 'morning' && Number(now.slice(11, 13)) >= 12) return unavailable('PASS_MORNING_ONLY');
    if (pass.dailyLimit !== null && pass.usedToday >= pass.dailyLimit) return unavailable('PASS_DAILY_LIMIT');
    const terms = read.pos.money?.memberships.find(membership => membership.membershipId === pass.membershipId);
    const menuIds = terms?.menuIds;
    const line = lines.find(l => {
      if (menuIds?.length) return menuIds.includes(l.menuId);
      if (pass.kind === 'americano') return l.menuId === 'm-americano';
      return ['morning', 'monthly'].includes(pass.kind)
        && read.data.catalog.items.some(menu => menu.menuId === l.menuId && menu.category === 'drink');
    });
    if (!line || !line.basePrice) return unavailable('PASS_MENU_REQUIRED');
    return { ok: true as const, discount: { ...base, scope: 'line' as const, amount: line.basePrice, allocationId: line.lineId, membershipId: pass.membershipId,
      useId: `pos:use:${bill.billId}:${pass.membershipId}` } };
  }
  // D-326: a presented issued code can keep its original terms after an early end or unpublish.
  const campaign = read.data.loyalty?.coupons.find(c => c.couponId === input.couponId);
  if (!campaign) return unavailable('COUPON_ENDED');
  const eligible = (c: typeof campaign.codes[number]) => c.active && !c.unpublished;
  const code = input.codeId ? campaign.codes.find(c => c.codeId === input.codeId)
    : campaign.codes.find(c => eligible(c) && !c.issuedTerms) ?? campaign.codes.find(eligible);
  const existingIssue = code?.issuedTerms;
  const coupon = existingIssue ? { ...campaign, ...existingIssue } : campaign;
  if ((campaign.status !== 'active' && !(campaign.status === 'ended' && input.codeId && existingIssue))
    || coupon.startsOn > now.slice(0, 10) || coupon.endsOn < now.slice(0, 10)) return unavailable('COUPON_ENDED');
  const hour = Number(now.slice(11, 13)) + Number(now.slice(14, 16)) / 60;
  const weekday = new Date(`${now.slice(0, 10)}T00:00:00Z`).getUTCDay();
  if (coupon.validHours?.length && !coupon.validHours.some(h => h.weekday === weekday && hour >= h.startHour && hour < h.endHour)) return unavailable('COUPON_HOURS');
  if (!code?.active) return unavailable('COUPON_CODE_INACTIVE');
  if (code.used >= code.issueCount) return unavailable('COUPON_EXHAUSTED');
  if (code.customerIds.length && !code.customerIds.some(id => read.data.loyalty?.members.some(m => m.memberId === bill.memberId && m.customerId === id))) return unavailable('COUPON_MEMBER_REQUIRED');
  const shot = coupon.targetMenuId === 'opt-extra-shot';
  const targets = coupon.targetMenuId ? lines.filter(l => shot ? l.options.some(o => o.optionId.endsWith(':shot')) : l.menuId === coupon.targetMenuId) : lines;
  if (!targets.length) return unavailable(shot ? 'COUPON_SHOT_REQUIRED' : 'COUPON_MENU_REQUIRED');
  const eligibleGross = targets.reduce((n, l) => n + l.gross, 0);
  let amount: number;
  if (coupon.benefitType === 'percent') {
    if (!Number.isInteger(coupon.benefitValue) || coupon.benefitValue < 1 || coupon.benefitValue > 100) return unavailable('COUPON_INVALID_BENEFIT');
    amount = percentOf(eligibleGross, coupon.benefitValue);
  } else if (coupon.benefitType === 'amount') amount = coupon.benefitValue;
  else if (coupon.benefitType === 'set_price') amount = eligibleGross - coupon.benefitValue;
  else amount = shot ? targets[0].options.find(o => o.optionId.endsWith(':shot'))!.extraPrice : targets[0].basePrice;
  if (!money(amount)) return unavailable('COUPON_INVALID_BENEFIT');
  return { ok: true as const, discount: { ...base, scope: coupon.targetMenuId ? 'line' as const : 'bill' as const, amount, couponId: coupon.couponId, codeId: code.codeId,
    ...(coupon.targetMenuId ? { targetAllocationIds: (coupon.benefitType === 'free_item' ? targets.slice(0, 1) : targets).map(l => l.lineId) } : {}) } };
}
