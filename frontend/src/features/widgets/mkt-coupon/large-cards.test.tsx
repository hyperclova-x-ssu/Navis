/**
 * LARGE-CARDS-3 (D-333): on the large card sizes the coupon panels show more of the real data they already have
 * (more list rows, the columns/lines the smaller sizes drop) and never write a row the data does not have.
 */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureId, WidgetHost } from '../../../contracts';
import { createWidgetDataStore, selectWidget, TODAY, type CouponStatusModel, type CustomerGroupsModel, type ExpiryCouponModel, type SlotCouponModel, type WidgetDataStore } from '../../../data/widget-data';
import { panelShape } from '../../../ui';
import { renderWithKit, type KitRenderOptions } from '../../../ui/test-utils';
import { widgets } from './index';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const host = (): WidgetHost => ({ layer: 'marketing', openClosing: () => true, resetPreview: () => {}, openLinked: () => {}, openDetail: () => {}, notify: () => {}, acknowledgeBriefing: () => {} });
function panel(id: FeatureId, width: 1 | 2 | 3 | 4, height: 1 | 2 | 3 | 4, options: KitRenderOptions = {}) {
  const Panel = widgets.find((w) => w.id === id)!.Panel;
  return renderWithKit(<Panel featureId={id} condition={{ kind: 'default' }} width={width} height={height} shape={panelShape(width, height)} presetId="A" editing={false} host={host()} />, options);
}
const modelOf = <T,>(id: FeatureId, store: WidgetDataStore = createWidgetDataStore(), variant = 'normal'): T => {
  const view = selectWidget(store.getSnapshot(), id, { kind: 'default' }, variant);
  if (view.status !== 'ready') throw new Error(`${id} is ${view.status}`);
  return view.model as T;
};
const rows = () => Array.from(document.querySelectorAll('.mkt-rows > li'));
const rowText = (li: Element) => (li.textContent ?? '').replace(/ /g, ' ').replace(/⁠/g, '');
const shortKo = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${'일월화수목금토'[d.getUTCDay()]})`; };
const seed = (key: string) => key.replace(/^seed:/, '');

/** The cafe seed plus one slot coupon that already covers every quiet slot except the first `keep`. */
function storeWithSlotsHandled(keep: number): WidgetDataStore {
  const base = createWidgetDataStore();
  const marketing = base.getSnapshot().tables.marketing;
  const open = modelOf<SlotCouponModel>('slot-coupon', base).openSlots;
  const sent = { ...marketing.coupon[0]!, couponId: 'zz-slot-sent', origin: 'slot' as const, originRef: { slotIds: open.slice(keep).map((s) => s.slotId) } };
  return createWidgetDataStore({ marketing: { ...marketing, coupon: [...marketing.coupon, sent] } });
}

describe('빈 시간 단골 쿠폰 (24) on large cards', () => {
  const lines = () => rows().filter((li) => li.hasAttribute('data-row-id')).map(rowText);
  it('lists every open quiet slot at 4x4, three at 2x2 and 4x2, and no filler beyond the data', () => {
    const m = modelOf<SlotCouponModel>('slot-coupon');
    expect(m.openSlots.length).toBe(9);
    panel('slot-coupon', 2, 2);
    expect(lines()).toHaveLength(3);
    cleanup(); panel('slot-coupon', 4, 2);
    expect(lines()).toHaveLength(3);
    cleanup(); panel('slot-coupon', 4, 3);
    expect(lines()).toHaveLength(6);
    cleanup(); panel('slot-coupon', 4, 4);
    expect(lines()).toHaveLength(m.openSlots.length);
    cleanup();
    panel('slot-coupon', 4, 4, { store: storeWithSlotsHandled(2) });
    expect(lines()).toHaveLength(2);
  });
  it('names the matching regulars on the slot rows that have some (large only), and never on a slot without', () => {
    const m = modelOf<SlotCouponModel>('slot-coupon');
    const withRegulars = m.openSlots.filter((s) => s.regularIds.length > 0);
    expect(withRegulars.length).toBeGreaterThan(0);
    panel('slot-coupon', 4, 4);
    const withText = lines().filter((line) => /단골 \d+명/.test(line));
    expect(withText).toHaveLength(withRegulars.length);
    expect(withText[0]).toContain(`단골 ${withRegulars[0]!.regularIds.length}명`);
    cleanup(); panel('slot-coupon', 2, 2);
    expect(lines().filter((line) => /단골 \d+명/.test(line))).toHaveLength(0);
    cleanup(); panel('slot-coupon', 4, 4, { preview: { family: 'normal', overrides: { 'slot-coupon': 'no-regulars' } } });
    expect(lines().filter((line) => /단골 \d+명/.test(line))).toHaveLength(0);
  });
  it('marks the rows past the small-size budget so a tight card drops them before anything else', () => {
    panel('slot-coupon', 4, 4);
    const extra = rows().filter((li) => li.hasAttribute('data-mkt-extra'));
    expect(extra).toHaveLength(6);
    expect(extra.every((li) => li.hasAttribute('data-row-id'))).toBe(true);
  });
});

describe('당일 소진 쿠폰 (25) on large cards', () => {
  it('adds the other sell-today items and the money lines of the suggested discount at 4x4 only', () => {
    const m = modelOf<ExpiryCouponModel>('expiry-coupon');
    const target = m.target!; const others = m.items.filter((it) => it.itemId !== target.itemId);
    expect(others.length).toBe(1);
    panel('expiry-coupon', 4, 4);
    const text = rows().map(rowText);
    expect(text.some((line) => line.includes(seed(others[0]!.nameKey)) && line.includes(`${others[0]!.qty}개`) && line.includes('오늘까지'))).toBe(true);
    const calc = target.atRecommended!;
    expect(text.some((line) => line.includes(`할인가 ${calc.discountedPrice.toLocaleString('en-US')}원`) && line.includes(`개당 남는 돈 ${calc.marginEach.toLocaleString('en-US')}원`) && line.includes(`모두 팔면 남는 돈 ${calc.ifAllSold.toLocaleString('en-US')}원`))).toBe(true);
    expect(text.some((line) => line.includes(`못 팔면 원가 ${calc.lossIfDiscarded.toLocaleString('en-US')}원`))).toBe(true);
    cleanup(); panel('expiry-coupon', 2, 2);
    expect(rows().map(rowText).join('|')).not.toMatch(/오늘까지|할인가|못 팔면/);
    cleanup(); panel('expiry-coupon', 4, 2);
    expect(rows().map(rowText).join('|')).not.toMatch(/오늘까지|할인가|못 팔면/);
  });
  it('writes no money lines when the cost is not known (partial sample state), but still lists the other items', () => {
    panel('expiry-coupon', 4, 4, { preview: { family: 'normal', overrides: { 'expiry-coupon': 'partial' } } });
    const text = rows().map(rowText).join('|');
    expect(text).not.toMatch(/할인가|못 팔면/);
    expect(text).toContain('오늘까지');
  });
});

describe('진행 중인 쿠폰 (28) on large cards', () => {
  it('lists the coupons that ended this month and writes how the month total adds up, at 4x4 only', () => {
    const m = modelOf<CouponStatusModel>('coupon-status');
    expect(m.ended.length).toBeGreaterThan(0);
    panel('coupon-status', 4, 4);
    const text = rows().map(rowText);
    const ended = m.ended[0]!; const name = (ended.name as { raw: string }).raw;
    expect(text).toContain(`${name} · ${ended.issued}장 중 ${ended.used}장 사용 · ${shortKo(ended.endsOn)} · 끝남`);
    expect(text).toContain(`이번 달 사용 ${m.monthUsed}장 = 진행 중 ${m.runningUsed}장 + 끝난 쿠폰 ${m.endedUsed}장`);
    cleanup(); panel('coupon-status', 2, 2);
    expect(rows().map(rowText).join('|')).not.toContain('끝남');
    expect(rows().map(rowText)).toContain(`이번 달 사용 ${m.monthUsed}장`);
    cleanup(); panel('coupon-status', 4, 2);
    expect(rows().map(rowText).join('|')).not.toContain('끝남');
  });
  it('shows no ended-coupon line when none ended this month', () => {
    const base = createWidgetDataStore();
    const marketing = base.getSnapshot().tables.marketing;
    const store = createWidgetDataStore({ marketing: { ...marketing, coupon: marketing.coupon.filter((c) => c.status !== 'ended' && c.endsOn >= TODAY) } });
    panel('coupon-status', 4, 4, { store });
    expect(rows().map(rowText).join('|')).not.toContain('종료');
  });
});

describe('손님 그룹 (29) on large cards', () => {
  const churnLines = () => rows().filter((li) => li.hasAttribute('data-row-id') && li.getAttribute('data-row-id')!.length > 12).map(rowText);
  it('lists up to nine customers who may leave at 4x4, six at 4x3, three at 2x2, each with their usual visit cycle', () => {
    const m = modelOf<CustomerGroupsModel>('customer-groups');
    expect(m.churnRisk.length).toBeGreaterThan(9);
    panel('customer-groups', 4, 4);
    expect(churnLines()).toHaveLength(9);
    const first = m.churnRisk[0]!;
    expect(churnLines()[0]).toContain(`마지막 방문 ${shortKo(first.lastVisit)}`);
    expect(churnLines()[0]).toContain(`평소 ${first.usualCycleDays}일마다`);
    cleanup(); panel('customer-groups', 4, 3);
    expect(churnLines()).toHaveLength(6);
    cleanup(); panel('customer-groups', 2, 2);
    expect(churnLines()).toHaveLength(3);
    expect(churnLines().join('|')).not.toContain('평소');
  });
  it('never lists more customers than the data has', () => {
    const base = createWidgetDataStore();
    const marketing = base.getSnapshot().tables.marketing;
    const keep = new Set(modelOf<CustomerGroupsModel>('customer-groups', base).churnRisk.slice(0, 2).map((c) => c.customerId));
    const store = createWidgetDataStore({ marketing: { ...marketing, mktVisit: marketing.mktVisit.filter((v) => keep.has(v.customerId)) } });
    expect(modelOf<CustomerGroupsModel>('customer-groups', store).churnRisk.length).toBe(2);
    panel('customer-groups', 4, 4, { store });
    expect(churnLines()).toHaveLength(2);
  });
});
