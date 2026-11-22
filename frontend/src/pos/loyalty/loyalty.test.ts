import { describe, expect, it } from 'vitest';
import { readModel, selectMembers } from '../../data/widget-data';
import { selectPosDayTotals } from '../domain';
import { allocateBillDiscounts, findPosMembers, getPaymentBillId, quotePaymentBill, selectPosDiscountOptions } from './index';
import { setup as setupBase } from './test-setup';
import { projectPosLoyalty } from '../../data/pos/loyalty';
import { planLoyaltyCommand } from './commands';
import { planPaymentBegin, planPaymentFinish } from './approval';
import { POS_BUSINESS_DATE, POS_NOW } from '../clock';
import { seedToday } from '../../data/db/generated/today';
import { seedOperations } from '../../data/db/generated/operations';
import { addDays } from '../../data/db/time';

const cafeCoupon = seedOperations.coupons.find(coupon => coupon.status === 'active')!;

function setup(paymentStyle?: 'prepaid' | 'postpaid') {
  const h = setupBase(paymentStyle);
  const add = (menuId = 'm-americano', qty = 1) => {
    const menu = h.pos.read().data.catalog.items.find(item => item.menuId === menuId)!;
    const optionIds = menu.groups.filter(group => group.required).map(group =>
      group.options.find(option => option.name === 'ICE')?.optionId ?? group.options.find(option => option.extraPrice === 0)!.optionId);
    return h.pos.execute({ type: 'cart.add', menuId, qty, optionIds, meta: h.meta() });
  };
  return { ...h, add };
}

describe('T-249 member and discount calculations', () => {
  it('preserves cafe visits, coupon uses and discount attribution and exposes masked members only', () => {
    const h = setup(), read = h.pos.read();
    const member = read.data.loyalty!.members.find(row => row.memberId === 'M-0012')!;
    expect(selectPosDayTotals(read.pos).discountBySource).toEqual({ membership: 0, coupon: 19000, direct: 9280 });
    expect(readModel(h.data.getSnapshot(), 'coupon-status')).toMatchObject({ monthUsed: 365, runningUsed: 223 });
    expect(read.pos.bills.filter(b => b.memberId).length).toBe(seedToday.pos.bills.filter(bill => bill.memberId).length);
    expect(findPosMembers(read, { phoneSuffix: member.phone.slice(-4) })).toMatchObject({ ok: true, rows: [{ memberId: member.memberId, name: '가○손님0012', phone: '010-****-0011', grade: member.grade, recentVisits: member.recentVisits }] });
    expect(findPosMembers(read, { phoneSuffix: '9999' })).toMatchObject({ ok: true, rows: [] });
    expect(findPosMembers(read, { phoneSuffix: '12a' })).toMatchObject({ ok: false, reason: 'PHONE_SUFFIX_INVALID' });
  });

  it('validates direct amounts, computes percentages in whole won and creates a zero-won order without a payment', () => {
    const h = setup(); h.add();
    const billId = getPaymentBillId(h.pos.read());
    expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'direct', amount: 5000 }, meta: h.meta() })).toMatchObject({ ok: false, reason: 'DISCOUNT_EXCEEDS_GROSS' });
    expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'direct', percent: 100 }, meta: h.meta('zero-discount') })).toMatchObject({ ok: true });
    expect(quotePaymentBill(h.pos.read(), billId)).toMatchObject({ gross: 3000, discount: 3000, payable: 0 });
    const command = { type: 'bill.confirmZero' as const, billId, meta: h.meta('zero') };
    expect(h.pos.execute(command)).toMatchObject({ ok: true, value: { settled: true, orderIds: ['O-154'] } });
    expect(h.pos.execute(command)).toMatchObject({ ok: true, duplicate: true });
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ gross: 862500, discount: 31280, revenue: seedToday.rollup.net, paymentCount: 153 });
    expect(h.pos.read().pos.cart.lines).toHaveLength(0);
    expect(readModel(h.data.getSnapshot(), 'menu').rows.find(r => r.menuId === 'm-americano')).toMatchObject({ soldQty: 63 });
    expect(readModel(h.data.getSnapshot(), 'margin')).toMatchObject({ cost: 244857, netSales: seedToday.rollup.net });
  });

  it('validates coupon hours, active codes, target items, and exhausted issue counts', () => {
    const h = setup(); h.add(); const read = h.pos.read(), billId = getPaymentBillId(read);
    const active = read.data.loyalty!.coupons.find(coupon => coupon.status === 'active')!;
    const withCoupon = (patch: Partial<typeof active>) => ({
      ...read, data: { ...read.data, loyalty: { ...read.data.loyalty!, coupons: [{ ...active, ...patch }] } },
    });
    const offHours = withCoupon({ validHours: [{ weekday: 2, startHour: 8, endHour: 10 }] });
    expect(selectPosDiscountOptions(offHours, billId).coupons[0]).toMatchObject({ available: false, reason: 'COUPON_HOURS' });
    expect(planLoyaltyCommand(offHours, { type: 'bill.setDiscount', billId,
      discountInput: { source: 'coupon', couponId: active.couponId }, meta: h.meta() }, POS_NOW))
      .toMatchObject({ ok: false, reason: 'COUPON_UNAVAILABLE', details: { reason: 'COUPON_HOURS' } });
    expect(selectPosDiscountOptions(withCoupon({ targetMenuId: 'm-saltbread' }), billId).coupons[0])
      .toMatchObject({ available: false, reason: 'COUPON_MENU_REQUIRED' });
    expect(selectPosDiscountOptions(withCoupon({ codes: active.codes.map(code => ({ ...code, active: false })) }), billId).coupons[0])
      .toMatchObject({ available: false, reason: 'COUPON_CODE_INACTIVE' });
    const exhausted = { ...read, data: { ...read.data, loyalty: { ...read.data.loyalty!, coupons: read.data.loyalty!.coupons.map(c => c.couponId === cafeCoupon.couponId ? { ...c, codes: c.codes.map(code => ({ ...code, used: code.issueCount })) } : c) } } };
    expect(selectPosDiscountOptions(exhausted, billId).coupons.find(c => c.couponId === cafeCoupon.couponId)).toMatchObject({ available: false, reason: 'COUPON_EXHAUSTED' });
    h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'coupon', couponId: cafeCoupon.couponId }, meta: h.meta() });
    const selected = h.pos.read(), unavailable = { ...selected, data: { ...selected.data, loyalty: { ...selected.data.loyalty!, coupons: exhausted.data.loyalty.coupons } } };
    expect(planPaymentBegin(unavailable, { billId, quoteRevision: selected.posRevision, splits: [{ method: 'card', amount: 2000 }], meta: h.meta() }, POS_NOW)).toMatchObject({ ok: false, reason: 'COUPON_UNAVAILABLE', details: { reason: 'COUPON_EXHAUSTED' } });
  });

  it.each(['coupon.endEarly', 'coupon.unpublish'] as const)('honors a presented issued code through the original end date after %s', type => {
    const h = setup();
    const item = readModel(h.data.getSnapshot(), 'expiry-coupon').target!;
    expect(h.data.dispatch({ type: 'coupon.createExpiry', itemId: item.itemId, benefit: { kind: 'percent', value: 40 },
      route: 'place_news', idempotencyKey: 'loyalty-create-expiry' }).ok).toBe(true);
    const { codeId, couponId } = h.data.getSnapshot().tables.marketing.couponCode.at(-1)!;
    expect(h.data.dispatch({ type: 'coupon.markPosted', codeId, idempotencyKey: 'loyalty-post-expiry' }).ok).toBe(true);
    expect(h.data.dispatch({ type: 'coupon.extend', couponId }).ok).toBe(true);
    const { endsOn } = h.data.getSnapshot().tables.marketing.coupon.find(coupon => coupon.couponId === couponId)!;
    expect(endsOn > POS_BUSINESS_DATE).toBe(true);
    expect(h.add(item.menuId).ok).toBe(true);
    const idempotencyKey = 'loyalty-close-expiry';
    expect(h.data.dispatch(type === 'coupon.endEarly' ? { type, couponId, idempotencyKey } : { type, codeId, idempotencyKey }).ok).toBe(true);

    const read = h.pos.read(), billId = getPaymentBillId(read);
    const select = (date: string, code?: string) => planLoyaltyCommand(read, { type: 'bill.setDiscount', billId,
      discountInput: { source: 'coupon', couponId, ...(code && { codeId: code }) }, meta: h.meta() }, `${date}T15:45`);
    const redemption = select(endsOn, codeId);
    if (!redemption.ok) throw new Error(JSON.stringify(redemption));
    expect(redemption.plan.nextPos.bills.find(bill => bill.billId === billId)?.discounts).toEqual([
      expect.objectContaining({ source: 'coupon', couponId, codeId, amount: Math.floor(item.price * 0.4) }),
    ]);
    expect(select(addDays(endsOn, 1), codeId)).toMatchObject({ ok: false, details: { reason: 'COUPON_ENDED' } });
    expect(select(endsOn)).toMatchObject({ ok: false, reason: 'COUPON_UNAVAILABLE' });
  });

  it('offers the cafe latte count pass only for its configured menu', () => {
    const h = setup(); h.add('m-cafe-latte');
    const billId = getPaymentBillId(h.pos.read());
    expect(h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0024', meta: h.meta() }).ok).toBe(true);
    expect(selectPosDiscountOptions(h.pos.read(), billId).passes.find(pass => pass.membershipId === 'sample-pass-2'))
      .toMatchObject({ available: true });
    const h2 = setup(); h2.add('m-americano');
    const otherBill = getPaymentBillId(h2.pos.read());
    expect(h2.pos.execute({ type: 'bill.member', billId: otherBill, memberId: 'M-0024', meta: h2.meta() }).ok).toBe(true);
    expect(selectPosDiscountOptions(h2.pos.read(), otherBill).passes.find(pass => pass.membershipId === 'sample-pass-2'))
      .toMatchObject({ available: false, reason: 'PASS_MENU_REQUIRED' });
  });

  it('validates member pass ownership, morning and daily limits, and consumes exactly one base-price use', () => {
    const h = setup(); h.add(); h.add('m-cafe-latte'); h.add('m-basque-cake'); const billId = getPaymentBillId(h.pos.read());
    const member = selectMembers(h.data.getSnapshot(), {}).rows.find(r => r.memberId === 'M-0012')!;
    const membershipId = member.memberships.find(m => m.membershipId === 'sample-pass-1')!.membershipId;
    expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'membership', membershipId }, meta: h.meta() })).toMatchObject({ ok: false, reason: 'PASS_UNAVAILABLE', details: { reason: 'MEMBER_REQUIRED' } });
    expect(h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0012', meta: h.meta() }).ok).toBe(true);
    expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'membership', membershipId }, meta: h.meta('pass') }).ok).toBe(true);
    const q = quotePaymentBill(h.pos.read(), billId);
    expect(q).toMatchObject({ gross: 12000, discount: 300, payable: 11700 });
    expect(h.pos.beginApproval({ billId, quoteRevision: q.revision, splits: [{ method: 'card', amount: 9000 }], meta: h.meta('pay') }).ok).toBe(true);
    expect(h.finish()).toMatchObject({ ok: true });
    expect(h.finish()).toMatchObject({ ok: true, duplicate: true });
    expect(selectMembers(h.data.getSnapshot(), {}).rows.find(r => r.memberId === 'M-0012')).toMatchObject({ recentVisits: member.recentVisits + 1, lastVisit: POS_BUSINESS_DATE });
    expect(h.data.getSnapshot().tables.membership.find(m => m.membershipId === membershipId)?.usesLeft).toBe(6);
    expect(h.data.getSnapshot().tables.membershipUse.filter(u => u.useId.startsWith('pos:'))).toHaveLength(1);
  });

  it('allocates line discounts first, then proportionally allocates whole-bill discounts without losing a won', () => {
    const h = setup(); h.add('m-americano', 2); h.add('m-cafe-latte');
    const q = quotePaymentBill(h.pos.read(), getPaymentBillId(h.pos.read()));
    const result = allocateBillDiscounts(q.lines, [
      { discountId: 'direct', billId: q.billId, source: 'direct', scope: 'bill', amount: 1001 },
      { discountId: 'pass', billId: q.billId, source: 'membership', scope: 'line', amount: 3000, allocationId: q.lines[0].lineId },
    ]);
    expect(result.reduce((n, l) => n + l.discountAllocations.reduce((a, d) => a + d.amount, 0), 0)).toBe(4001);
    expect(result.map(l => l.discountAllocations.find(d => d.discountId === 'direct')?.amount)).toEqual([442, 559]);
  });

  it('deduplicates an existing same-day visit and preserves baseline evidence when POS contributions are removed', () => {
    const h = setup(), s = h.data.getSnapshot(), pos = h.pos.read().pos;
    const baselineVisit = s.tables.marketing.mktVisit.find(v => v.businessDate === POS_BUSINESS_DATE && !v.posContribution
      && s.tables.memberProfile.some(member => member.customerId === v.customerId))!;
    const { memberId } = s.tables.memberProfile.find(member => member.customerId === baselineVisit.customerId)!;
    const before = selectMembers(s, {}).rows.find(row => row.memberId === memberId)!.recentVisits;
    const sameDay = (tables: typeof s.tables) => tables.marketing.mktVisit.filter(v =>
      v.customerId === baselineVisit.customerId && v.businessDate === POS_BUSINESS_DATE);
    const extra = { billId: 'test-member-bill', originOrderNo: 154, tableId: null, memberId, status: 'paid' as const,
      discounts: [], settlementLines: [], recognizedAt: POS_NOW };
    const next = { ...pos, bills: [...pos.bills, extra] };
    const projected = projectPosLoyalty(s.tables, next, pos);
    expect(sameDay(projected)).toEqual([baselineVisit]);
    expect(selectMembers({ ...s, pos: next, tables: projected }, {}).rows.find(r => r.memberId === memberId)?.recentVisits).toBe(before);
    expect(sameDay(projectPosLoyalty(projected, pos, next))).toEqual([baselineVisit]);
  });

  it('rejects morning/daily pass limits, invalid ownership and unsupported menus without writes', () => {
    const h = setup(); h.add(); const billId = getPaymentBillId(h.pos.read());
    h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0012', meta: h.meta() });
    const read = h.pos.read(), real = read.data.loyalty!.passes.find(p => p.memberId === 'M-0012')!;
    const withPass = (changes: Partial<typeof real>) => ({ ...read, pos: { ...read.pos, money: undefined }, data: { ...read.data, loyalty: { ...read.data.loyalty!, passes: [{ ...real, ...changes }] } } });
    expect(selectPosDiscountOptions(withPass({ kind: 'morning' }), billId).passes[0]).toMatchObject({ available: false, reason: 'PASS_MORNING_ONLY' });
    expect(selectPosDiscountOptions(withPass({ kind: 'monthly', dailyLimit: 1, usedToday: 1 }), billId).passes[0]).toMatchObject({ available: false, reason: 'PASS_DAILY_LIMIT' });
    expect(selectPosDiscountOptions(withPass({ kind: 'unsupported' }), billId).passes[0]).toMatchObject({ available: false, reason: 'PASS_MENU_REQUIRED' });
    const result = planLoyaltyCommand(withPass({ memberId: 'M-0002' }), { type: 'bill.setDiscount', billId, discountInput: { source: 'membership', membershipId: real.membershipId }, meta: h.meta() }, POS_NOW);
    expect(result).toMatchObject({ ok: false, reason: 'PASS_UNAVAILABLE', details: { reason: 'PASS_MEMBER_MISMATCH' } });
  });

  it('prelinks an accepted reservation member and preserves an explicit disconnection', () => {
    const h = setup('postpaid'), read = h.pos.read();
    const source = read.pos.bills[0];
    const bill = { ...source, billId: 'test-reservation', status: 'open' as const, memberId: undefined, memberLinkChosen: undefined, reservationId: 'reservation-test', discounts: [] };
    const linked = { ...read, pos: { ...read.pos, bills: [...read.pos.bills, bill], billAllocations: [...read.pos.billAllocations,
      ...read.pos.billAllocations.filter(a => a.billId === source.billId).map(a => ({ ...a, billId: bill.billId, allocationId: `test:${a.allocationId}` }))] },
      data: { ...read.data, reservations: [{ ...read.data.reservations![0], reservationId: 'reservation-test', memberId: 'M-0002', status: 'completed' }] } };
    expect(quotePaymentBill(linked, bill.billId).memberId).toBe('M-0002');
    const result = planLoyaltyCommand(linked, { type: 'bill.member', billId: bill.billId, memberId: null, meta: h.meta() }, POS_NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(quotePaymentBill({ ...linked, pos: result.plan.nextPos, posRevision: result.plan.nextPos.revision }, bill.billId).memberId).toBeUndefined();
  });

  it('recognizes existing postpaid orders after the last item share and retains allocations when partial money is canceled', () => {
    const h = setup('postpaid'); h.add('m-americano'); h.add('m-cafe-latte');
    h.pos.execute({ type: 'bill.submitOrder', cartId: h.pos.read().pos.cart.cartId, meta: h.meta() });
    let read = h.pos.read();
    const bill = read.pos.bills.find(b => b.status === 'open')!;
    const q = quotePaymentBill(read, bill.billId);
    const command = { type: 'bill.split' as const, billId: bill.billId, kind: 'items' as const,
      parts: q.lines.map(l => ({ lineQtyAllocations: [{ allocationId: l.lineId, qty: l.qty }] })), meta: h.meta() };
    const split = planLoyaltyCommand(read, command, POS_NOW);
    if (!split.ok) throw new Error(split.reason);
    read = { ...read, pos: split.plan.nextPos, posUi: split.plan.nextUi, posRevision: split.plan.nextPos.revision };
    const parts = quotePaymentBill(read, bill.billId).parts;
    for (const [i, part] of parts.entries()) {
      const begin = planPaymentBegin(read, { billId: bill.billId, partId: part.partId, quoteRevision: read.posRevision,
        splits: [{ method: 'cash', amount: part.amount }], meta: h.meta() }, POS_NOW);
      if (!begin.ok) throw new Error(begin.reason);
      read = { ...read, posUi: begin.plan.nextUi };
      const attempt = read.posUi.approval!;
      const end = planPaymentFinish(read, { runId: read.runId, attemptId: attempt.attemptId, expectedQuoteFingerprint: attempt.quoteFingerprint, outcome: 'approved' }, POS_NOW);
      if (!end.ok) throw new Error(end.reason);
      read = { ...read, pos: end.plan.nextPos, posRevision: end.plan.nextPos.revision, posUi: end.plan.nextUi };
      if (i === 0) {
        const cancel = planLoyaltyCommand(read, { type: 'bill.cancelPartial', billId: bill.billId, confirmed: true, meta: h.meta() }, POS_NOW);
        if (!cancel.ok) throw new Error(cancel.reason);
        expect(cancel.plan.nextPos.billAllocations).toEqual(read.pos.billAllocations);
        expect(cancel.plan.nextPos.orders.at(-1)?.preparation).toBe('accepted');
        expect(selectPosDayTotals(cancel.plan.nextPos)).toMatchObject({ revenue: seedToday.rollup.net, pendingReceived: 0 });
      }
    }
    expect(read.pos.orders).toHaveLength(154);
    expect(selectPosDayTotals(read.pos)).toMatchObject({ revenue: 838020, paymentCount: 155, pendingReceived: 0 });
  });
});
