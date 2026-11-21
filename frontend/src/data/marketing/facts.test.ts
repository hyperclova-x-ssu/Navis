/** Navis facts of the 7 marketing widgets (DATA_MODEL 10.15.6, AC-321 numbers). */
import { LAST_MONTH_END, LAST_MONTH_START, addDays, MONTH_START, TODAY } from '../db/time';
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore, readModel, MARKETING_WIDGET_IDS, selectWidget, widgetFacts, type ModelFact } from '../widget-data';

const store = createWidgetDataStore();
const facts = (id: Parameters<typeof selectWidget>[1], condition: Parameters<typeof selectWidget>[2] = { kind: 'default' }) => widgetFacts(selectWidget(store.getSnapshot(), id, condition, 'normal'));
const one = (list: readonly ModelFact[], key: string) => list.filter((f) => f.key === key);
const UNITS = new Set(['KRW', 'percent', 'pp', 'person', 'visit', 'reservation', 'order', 'item', 'pcs', 'L', 'kg', 'seat', 'table', 'count', 'level', 'hour', 'day', '']);

describe('marketing facts', () => {
  it('every widget has facts with `{widget}.{metric}` keys, unit codes and data label keys', () => {
    for (const id of MARKETING_WIDGET_IDS) {
      const list = facts(id);
      expect(list.length, id).toBeGreaterThan(0);
      for (const f of list) {
        expect(f.key).toMatch(/^[a-zA-Z]+\.[a-zA-Z.]+$/);
        expect(UNITS.has(f.unit), `${f.key} ${f.unit}`).toBe(true);
        expect(f.labelKey).toBe(`data.fact.${f.key}`);
      }
    }
  });
  it('the cafe marketing facts preserve exact units, dates, labels and totals', () => {
    expect(one(facts('slot-coupon'), 'slot.quietHours.count')[0]).toMatchObject({ value: 9, unit: 'count' });
    expect(one(facts('slot-coupon'), 'slot.regulars.count')[0]).toMatchObject({ value: 1, unit: 'person' });
    expect(one(facts('slot-coupon'), 'slot.benefit.kept').map((f) => f.value)).toEqual([2_142, 2_022]);
    expect(one(facts('expiry-coupon'), 'expiry.item.qty')[0]).toMatchObject({ value: 6, unit: 'pcs', date: TODAY, labelText: { key: 'seed:바스크 치즈케이크(조각)' } });
    expect(one(facts('expiry-coupon'), 'expiry.discount.max')[0]).toMatchObject({ value: 51.6, unit: 'percent' });
    expect(one(facts('expiry-coupon'), 'expiry.discount.recommended')[0]).toMatchObject({ value: 40, unit: 'percent' });
    expect(one(facts('promo-video'), 'video.materials')[0]).toMatchObject({ value: store.getSnapshot().tables.marketing.promoPhoto.length });
    expect(one(facts('promo-video'), 'video.praiseReviews')[0]).toMatchObject({ value: 31 });
    expect(one(facts('coupon-status'), 'coupons.active')[0]).toMatchObject({ value: 1 });
    expect(one(facts('coupon-status'), 'coupons.used.month')[0]).toMatchObject({ value: 365, start: MONTH_START, end: TODAY });
    expect(one(facts('coupon-status'), 'coupons.used.running')[0]).toMatchObject({ value: 223 });
    expect(one(facts('customer-groups'), 'groups.churnRisk')[0]).toMatchObject({ value: 29, unit: 'person' });
    expect(one(facts('marketing-performance'), 'perf.rate')[0]).toMatchObject({ value: 75, unit: 'percent', start: MONTH_START, end: TODAY });
    expect(one(facts('marketing-performance'), 'perf.revenue')[0]).toMatchObject({ value: 1_739_400, unit: 'KRW' });
    expect(one(facts('marketing-performance'), 'perf.profit')[0]).toMatchObject({ value: 1_139_685, unit: 'KRW' });
    expect(one(facts('marketing-performance'), 'perf.bestRoute')[0]).toMatchObject({ value: 75, labelText: { key: 'data.marketing.route.sms' } });
    expect(one(facts('marketing-today'), 'todayPromo.quietHours.regulars')[0]).toMatchObject({ value: 1, date: addDays(TODAY, 3), labelText: { key: 'data.fact.slot.quietHours.at', params: { start: 9, end: 10 } } });
    expect(one(facts('marketing-today'), 'todayPromo.replies.waiting')[0]).toMatchObject({ value: 48 });
  });
  it('facts follow the same snapshot after the cafe slot send', () => {
    const s = createWidgetDataStore();
    const slot = readModel(s.getSnapshot(), 'slot-coupon').openSlots.find(row => row.regularIds.length > 0)!;
    expect(s.dispatch({ type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: slot.regularIds, benefit: 'percent-10', idempotencyKey: 'f' }).ok).toBe(true);
    const list = widgetFacts(selectWidget(s.getSnapshot(), 'marketing-performance', { kind: 'default' }, 'normal'));
    expect(one(list, 'perf.rate')[0].value).toBe(74);
    expect(one(list, 'perf.issued')[0].value).toBe(300);
    expect(one(widgetFacts(selectWidget(s.getSnapshot(), 'coupon-status', { kind: 'default' }, 'normal')), 'coupons.active')[0].value).toBe(2);
  });
  it('last month facts carry that period; empty and error views have none', () => {
    expect(one(facts('marketing-performance', { kind: 'dateRange', start: LAST_MONTH_START, end: LAST_MONTH_END }), 'perf.rate')[0]).toMatchObject({ value: 58, start: LAST_MONTH_START, end: LAST_MONTH_END });
    const snap = store.getSnapshot();
    for (const id of MARKETING_WIDGET_IDS) expect(widgetFacts(selectWidget(snap, id, { kind: 'default' }, 'error'))).toEqual([]);
    expect(widgetFacts(selectWidget(snap, 'slot-coupon', { kind: 'default' }, 'no-slots'))).toEqual([]);
  });
});
