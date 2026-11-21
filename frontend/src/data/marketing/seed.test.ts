/** DATA_MODEL 10.15.2 “시드가 지켜야 할 값” — every row pinned through the public models (T-058). */
import { describe, expect, it } from 'vitest';
import type { QueryCondition } from '../../contracts';
import { createWidgetDataStore, readModel, selectWidget, type ModelMap, readInternalModel, isDataWidgetId, type ModelOf } from '../widget-data';
import { addDays, dateRange, LAST_MONTH_END, LAST_MONTH_START, LAST_WEEK_SAME_DAY, MONTH_START, TODAY, TOMORROW, weekdayOf, WEEK_END, WEEK_START } from '../db/time';
import manifest from '../db/generated/manifest.json';
import { seedHistory } from '../db/generated/history';
import { seedToday } from '../db/generated/today';

const snapshot = createWidgetDataStore().getSnapshot();
function model<F extends keyof ModelMap>(id: F, condition: QueryCondition = { kind: 'default' }): ModelOf<F> {
  if (!isDataWidgetId(id)) return readInternalModel(snapshot, id, condition) as ModelOf<F>;
  const view = selectWidget(snapshot, id, condition, 'normal');
  if (view.status !== 'ready') throw new Error(`${id} not ready: ${view.status}`);
  return view.model as ModelOf<F>;
}

describe('shared seed: demand hours (R2 RELAY ①, AC-288·316)', () => {
  it('tomorrow bands stay 65 + 111 + 35 = 211 and every band equals the sum of its hours (expected and 4-week average)', () => {
    const demand = model('demand');
    expect(demand.day.expected).toBe(211);
    expect(demand.day.bands.map((b) => b.expected)).toEqual([65, 111, 35]);
    const t = snapshot.tables;
    for (const { date, hours } of demand.hourly) for (const band of ['morning', 'afternoon', 'evening'] as const) {
      const row = t.demandForecast.find((r) => r.targetDate === date && r.band === band)!;
      const own = hours.filter((h) => h.band === band);
      expect(own.reduce((s, h) => s + h.expected, 0), `${date} ${band}`).toBe(row.expected);
      expect(own.reduce((s, h) => s + h.average, 0), `${date} ${band} avg`).toBe(row.baseline);
    }
    expect(demand.hourly.map((d) => d.date)).toEqual(dateRange(TODAY, addDays(TOMORROW, 6)));
    expect(demand.day.hourly.map((h) => h.hour)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  });
  it('ten hours fall below 60% of the same weekday/hour average', () => {
    const below = model('demand').hourly.flatMap((d) => d.hours.filter((h) => h.belowUsual).map((h) => `${d.date}@${h.hour}`));
    expect(below).toEqual([[0, 21], [1, 15], [2, 17], [2, 19], [3, 9], [3, 21], [4, 19], [5, 18], [6, 19], [7, 21]]
      .map(([offset, hour]) => `${addDays(TODAY, offset)}@${hour}`));
    for (const d of model('demand').hourly) for (const h of d.hours) expect(h.expected * 100 >= h.average * 60, `${d.date}@${h.hour}`).toBe(!h.belowUsual);
    const wed = model('demand').day.hourly.filter(h => h.hour === 15 || h.hour === 16);
    expect(wed.map((h) => [h.expected, h.average, h.percent])).toEqual([[6, 15, 40], [26, 18, 144]]);
  });
  it('the week view carries the same hourly rows per day', () => {
    const week = model('demand', { kind: 'dateRange', start: WEEK_START, end: WEEK_END });
    expect(week.days.find((d) => d.date === TOMORROW)?.hourly.find((h) => h.hour === 15)).toMatchObject({ expected: 6, average: 15, percent: 40, belowUsual: true });
  });
});

describe('slot-coupon seed (AC-288·289)', () => {
  it('nine cafe quiet slots share the forecast and match one consenting regular', () => {
    const s = model('slot-coupon');
    expect(s.window).toEqual({ start: TOMORROW, end: addDays(TOMORROW, 6) });
    expect(s.slots.map((x) => [x.date, weekdayOf(x.date), x.startHour, x.endHour])).toEqual([[0, 3, 15, 16], [1, 4, 17, 18], [1, 4, 19, 20], [2, 5, 9, 10], [2, 5, 21, 22], [3, 6, 19, 20], [4, 7, 18, 19], [5, 1, 19, 20], [6, 2, 21, 22]]
      .map(([offset, weekday, start, end]) => [addDays(TOMORROW, offset), weekday, start, end]));
    expect(s.slotCount).toBe(9);
    expect(s.regularsCount).toBe(1);
    expect(s.recipients).toHaveLength(1);
    expect(s.recipients.every((r) => r.selectable && r.consentSms && ('raw' in r.name ? r.name.raw.length > 0 : r.name.key.startsWith('data.person.')))).toBe(true);
    expect(s.slots.map(slot => slot.regularIds.length)).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0]);
    const demand = model('demand');
    for (const slot of s.slots) for (const h of slot.hours) {
      expect(demand.hourly.find((d) => d.date === slot.date)?.hours.find((x) => x.hour === h.hour)).toMatchObject({ expected: h.expected, average: h.average });
    }
    expect(s.slots.map((x) => [x.expected, x.average, x.percent])).toEqual([[6, 15, 40], [8, 14, 57], [3, 6, 50], [8, 16, 50], [0, 1, 0], [2, 6, 33], [4, 7, 57], [4, 7, 57], [0, 3, 0]]);
    expect(s.slots.every((x) => x.percent < 60)).toBe(true);
    expect(s.endsOn).toBe('2026-11-30');
    expect(s.canSend).toBe(true);
  });
  it('latte benefit comparison uses cafe costs and recommends 10% over 500 won off', () => {
    const s = model('slot-coupon');
    expect(s.menu).toEqual({ menuId: 'm-cafe-latte', nameKey: 'seed:카페라떼', price: 3_800, unitCost: 1_278, shotCost: 0 });
    expect(s.benefits.options.map((o) => o.marginPerCoupon)).toEqual([2_142, 2_022]);
    expect(s.benefits.recommendedId).toBe('percent-10');
    expect(s.benefits.differenceVsNext).toBe(120);
    expect(s.message.body).toMatchObject({ key: 'data.marketing.sms.slotPercent', params: { p: 10, startMonth: 11, startDay: 18, endDay: 24, untilDay: 30 } });
  });
});

describe('shared seed: menu prices and plan-1 invariants (AC-292·293·317)', () => {
  it('reconciles menu prices, margin, and recorded gross including options', () => {

    const margin = model('margin');
    const menu = (id: string) => margin.menus.find(m => m.menuId === id)!;
    expect([menu('m-saltbread').price, menu('m-saltbread').unitCost]).toEqual([3_200, 1_418]);
    expect([menu('m-americano').price, menu('m-americano').unitCost]).toEqual([3_000, 524]);
    expect([menu('m-cafe-latte').price, menu('m-cafe-latte').unitCost]).toEqual([3_800, 1_278]);
    expect([margin.netSales, margin.cost, margin.grossProfit, margin.rate]).toEqual([831_220, 244_333, 586_887, 70.6]);
    const week = model('margin', { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY });
    expect(week.netSales).toBe(6_706_290);
    const previous = seedHistory.days.find(day => day.date === LAST_WEEK_SAME_DAY)!;
    for (const day of [seedToday.rollup, previous]) {
      const sales = snapshot.tables.dailySales.find(row => row.businessDate === day.date)!;
      expect(day.menu.reduce((n, row) => n + row[2], 0)).toBe(sales.gross);
      expect(snapshot.tables.menuDaily.filter(row => row.businessDate === day.date).reduce((n, row) => n + row.netSales, 0))
        .toBe(sales.gross - sales.discount - sales.refund);
      expect(snapshot.tables.menuDaily.filter(row => row.businessDate === day.date).reduce((n, row) => n + (row.totalCost ?? 0), 0))
        .toBe(day.menu.reduce((n, row) => n + row[5], 0));
    }
    expect(snapshot.tables.menuOption).toEqual([]);
  });
});

describe('expiry-coupon seed (AC-292·293·317)', () => {
  it('expires two cafe products today and derives the Basque cake discount and loss', () => {

    const inv = model('inventory-booking').ingredients.find(i => i.itemId === 'i-basque-cake')!;
    expect(inv).toMatchObject({ stock: 18, trackExpiry: true, expiresOn: TODAY, trackRestock: false, needsRestock: false });
    const e = model('expiry-coupon');
    expect(e.items.map(row => [row.itemId, row.qty])).toEqual([['i-basque-cake', 6], ['i-saltbread', 10]]);
    expect(e.target).toMatchObject({ itemId: 'i-basque-cake', nameKey: 'seed:바스크 치즈케이크(조각)', stock: 8, qty: 6, expiresOn: TODAY, price: 5_200, unitCost: 2_518, maxRatePercent: 51.6, maxSliderRate: 51, recommendedRate: 40, handled: false });
    expect(e.target?.atRecommended).toMatchObject({ discountedPrice: 3_120, marginEach: 602, ifAllSold: 3_612, lossIfDiscarded: 15_108 });
    expect(e).not.toHaveProperty('set');
    expect(e.routes).toEqual({ sms: { recipients: 151 }, placeNews: { issueLimit: 10 } });
    expect(e.canCreate).toBe(true);
  });
  it('cafe sell-today examples do not add a restock need or retail stock', () => {
    const inv = model('inventory-booking');
    expect(inv.restockCount).toBe(0);
    expect(inv.products.total).toBe(0);
  });
  it('reducing an expiring batch updates the coupon without creating a reorder or a stockout alert', () => {
    const store = createWidgetDataStore();
    const itemId = 'i-basque-cake';
    expect(store.dispatch({ type: 'inventory.updateItem', itemId, stock: 4 })).toMatchObject({ ok: true });
    expect(readModel(store.getSnapshot(), 'expiry-coupon').items.find(row => row.itemId === itemId)?.qty).toBe(2);
    expect(readModel(store.getSnapshot(), 'inventory-booking').restockItems.some(row => row.itemId === itemId)).toBe(false);
    expect(store.dispatch({ type: 'inventory.updateItem', itemId, stock: 0 })).toMatchObject({ ok: true });
    const snapshot = store.getSnapshot();
    expect(readModel(snapshot, 'expiry-coupon').items.some(row => row.itemId === itemId)).toBe(false);
    expect(readModel(snapshot, 'inventory-booking').outOfStockCount).toBe(0);
    expect(readModel(snapshot, 'suppliers').suggestions.some(row => row.itemId === itemId)).toBe(false);
  });
});

describe('promo-video seed (AC-323·324·326·327·344, D-80)', () => {
  it('cafe promo projects its own menus and selectable assets with no previous videos', () => {

    const v = model('promo-video');
    const { promoStore, promoMenu, promoPhoto } = snapshot.tables.marketing;
    expect([v.materialsCount, v.photoCount, v.canMake, v.state]).toEqual([promoPhoto.length, promoPhoto.length, promoPhoto.length >= 5, 'before']);
    expect(v.menus.map(row => [row.menuId, row.photos.length, row.hasPhotos])).toEqual(promoMenu.map(row => {
      const count = promoPhoto.filter(photo => photo.menuId === row.menuId).length;
      return [row.menuId, count, count > 0];
    }));
    expect(v.firstMenu?.menuId).toBe(v.menus.find(row => row.hasPhotos)?.menuId);
    expect(v.store).toMatchObject({ name: manifest.store.name, location: manifest.store.address });
    expect(promoPhoto.some(photo => photo.photoId === promoStore[0].exteriorPhotoId)).toBe(false);
    expect([v.current, v.postedCount, v.videos]).toEqual([null, 0, []]);
  });
  it('a finished praise review stays in the review panel without becoming photo material', () => {

    const seed = snapshot.tables;
    const review = seed.inquiryThread.find(row => row.type === 'review' && row.isPublic)!;
    const store = createWidgetDataStore({ inquiryThread: seed.inquiryThread.map(row => row === review ? { ...row, sentiment: 'positive', status: 'done' } : row) });
    const updated = store.getSnapshot();
    const ai = readModel(updated, 'ai-response');
    expect(ai.praiseCount).toBe(31);
    expect(readModel(updated, 'promo-video').praiseCount).toBe(31);
    expect(ai.threads.find(row => row.threadId === review.threadId)).toMatchObject({ sentiment: 'positive', status: 'done' });
    expect(ai.priority.some(row => row.threadId === review.threadId)).toBe(false);
    expect(ai.waitingCount).toBe(47);
    expect(readModel(updated, 'promo-video').materialsCount).toBe(seed.marketing.promoPhoto.length);
  });
});

describe('coupon source seed (AC-299·305·306)', () => {
  it('separates the running campaign, ended campaigns and November coupon activity', () => {

    const c = model('coupon-status');
    const active = snapshot.tables.marketing.coupon.find(row => row.status === 'active')!;
    expect(c.rows.map(r => [r.couponId, r.used, r.issued, r.daysLeft, r.endingSoon])).toEqual([[active.couponId, 223, 299, 13, false]]);
    expect(c.rows.map(r => r.name)).toEqual([{ raw: '오후 한산시간 디저트 1,000원 할인' }]);
    expect([c.activeCount, c.endingSoonCount, c.runningUsed, c.runningIssued, c.endedUsed, c.endedIssued, c.monthUsed, c.monthIssued]).toEqual([1, 0, 223, 299, 142, 299, 365, 299]);
  });
  it('November uses the SMS route and the active campaign has no Clip code yet', () => {
    const p = model('marketing-performance');
    expect(p.routes.map((r) => [r.route, r.issued, r.used, r.rate])).toEqual([['place_news', 0, 0, null], ['blog', 0, 0, null], ['clip', 0, 0, null], ['sms', 299, 223, 75]]);
    expect(model('coupon-status').rows[0].routes.some((r) => r.route === 'clip')).toBe(false);
  });
  it('November results reconcile issued cohort, revenue, cost and route comparison', () => {

    const p = model('marketing-performance');
    expect(p.period).toEqual({ start: MONTH_START, end: TODAY });
    expect([p.issued, p.used, p.rate, p.rateDelta]).toEqual([299, 223, 75, { value: 17, kind: 'pp' }]);
    expect(p.revenue).toEqual({ total: 1_739_400, coupon: 1_739_400, attributed: 0 });
    expect(p.revenueDelta).toEqual({ value: -36_905, kind: 'count', unit: 'KRW' });
    expect([p.cost, p.discount, p.profit, p.returnRate, p.returnRateDelta]).toEqual([599_715, 336_600, 1_139_685, null, null]);
    expect([p.best?.route, p.best?.rate]).toEqual(['sms', 75]);
    expect(p.insight).toBeNull();
    expect(p.recentIssued).toBe(0);
    const active = snapshot.tables.marketing.coupon.find(row => row.status === 'active')!;
    expect(p.byCoupon.map(row => [row.couponId, row.issued, row.used])).toEqual([[active.couponId, 299, 223]]);
  });
  it('October is a closed reporting period without an earlier comparison', () => {
    const p = model('marketing-performance', { kind: 'dateRange', start: LAST_MONTH_START, end: LAST_MONTH_END });
    expect([p.periodKind, p.rate, p.revenue.total, p.returnRate, p.rateDelta, p.revenueDelta, p.byCoupon]).toEqual(['last-month', 58, 1_776_305, null, null, null, []]);
  });
});

describe('customer-groups seed (AC-302·303)', () => {
  it('29 may leave (18 consenting), 2 first-visit and 250 regulars — disjoint, card-based', () => {
    const g = model('customer-groups');
    expect(g.counts).toEqual({ 'churn-risk': 29, 'first-visit': 2, regular: 250 });
    expect(g.groups.map((x) => [x.id, x.count, x.customers.length])).toEqual([['churn-risk', 29, 29], ['first-visit', 2, 2], ['regular', 250, 250]]);
    const ids = g.groups.flatMap((x) => x.customers.map((c) => c.customerId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(g.reachOut.count).toBe(18);
    expect(g.reachOut.blockedIds).toHaveLength(11);
    expect(g.churnRisk.every((c) => c.usualCycleDays !== null && c.daysSinceLast > c.usualCycleDays + 14)).toBe(true);
    expect(g.churnRisk.map((c) => c.lastVisit)).toEqual([...g.churnRisk.map((c) => c.lastVisit)].sort());
    expect(g.rule).toEqual({ businessType: 'cafe', regularVisits: 4, regularDays: 28, churnGapDays: 14 });
    expect(g.basisKey).toBe('data.marketing.groups.basis');
    expect(model('customer-analysis').totalVisits).toBe(180);
  });
});

describe('marketing-today seed (AC-285·286)', () => {
  it('today promotion cells show cafe replies, quiet slots and available photo recommendations', () => {

    const t = model('marketing-today');
    const photos = snapshot.tables.marketing.promoPhoto.length;
    expect(t.cells.map(c => [c.slot, c.kind, c.params])).toEqual([
      ['now', 'quiet-hours', { regulars: 1 }], ['today', 'replies', { count: 48 }],
      ...(photos >= 5 ? [['week', 'video', { photos }]] : []),
    ]);
    expect(t.cells.map(c => c.ref)).toEqual([
      { featureId: 'slot-coupon', view: 'send', focus: 'action' }, { featureId: 'ai-response', focus: 'action' },
      ...(photos >= 5 ? [{ featureId: 'promo-video', view: 'create', focus: 'action' }] : []),
    ]);
    expect(t.cells[0].kind === 'quiet-hours' && t.cells[0].quietSlot).toEqual({ slotId: 'slot-2026-11-20-9', date: addDays(TODAY, 3), weekday: 5, startHour: 9, endHour: 10 });
    expect(t.tapTarget).toEqual({ featureId: 'slot-coupon', view: 'send' });
    expect(t.folded).toEqual(photos >= 5 ? [] : ['week']);
    expect(readModel(snapshot, 'ai-response').waitingCount).toBe(48);
  });
});
