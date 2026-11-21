/** DATA_MODEL 10.9 “시드가 지켜야 할 값” — every row pinned through the public models. */
import { describe, expect, it } from 'vitest';
import type { QueryCondition } from '../contracts';
import { createWidgetDataStore, selectWidget, selectStaffSchedule, simulateMenuPrice, type ModelMap, readInternalModel, isDataWidgetId, type ModelOf } from './widget-data';
import { addDays, LAST_WEEK_SAME_DAY, MINIMUM_WAGE, MONTH_START, TODAY, TOMORROW, WEEK_END, WEEK_START, YESTERDAY } from './db/time';
import manifest from './db/generated/manifest.json';
import { seedCatalog } from './db/generated/catalog';
import { seedHistory } from './db/generated/history';
import { seedOperations } from './db/generated/operations';
import { seedSupplement } from './db/generated/supplement';
import { seedToday } from './db/generated/today';

const snapshot = createWidgetDataStore().getSnapshot();
function model<F extends keyof ModelMap>(id: F, condition: QueryCondition = { kind: 'default' }): ModelOf<F> {
  if (!isDataWidgetId(id)) return readInternalModel(snapshot, id, condition) as ModelOf<F>;
  const view = selectWidget(snapshot, id, condition, 'normal');
  if (view.status !== 'ready') throw new Error(`${id} not ready: ${view.status}`);
  return view.model as ModelOf<F>;
}

describe('seed: money (AC-234·242·244·246·248)', () => {
  it('matches the cafe sales methods and the prior Tuesday at the same cutoff', () => {

    const ledger = model('ledger');
    expect(ledger.period).toEqual({ start: TODAY, end: TODAY });
    const { gross, discount, refund, net, byMethod } = seedToday.rollup;
    expect(ledger.sales).toEqual({ gross, discount, refund, net, byMethod: { card: byMethod.card, cash: byMethod.cash, easyPay: byMethod.easy_pay } });
    expect(ledger.comparison).toEqual({ baseNet: 882_160, base: { start: LAST_WEEK_SAME_DAY, end: LAST_WEEK_SAME_DAY }, delta: { value: -5.8, kind: 'percent' } });
    for (const row of snapshot.tables.dailySales) {
      expect(row.card + row.cash + row.easyPay, row.businessDate).toBe(row.gross - row.discount - row.refund);
    }
  });
  it('menu totals equal the day’s net sales on every day', () => {
    const byDate = new Map<string, number>();
    for (const row of snapshot.tables.menuDaily) byDate.set(row.businessDate, (byDate.get(row.businessDate) ?? 0) + row.netSales);
    for (const row of snapshot.tables.dailySales) expect(byDate.get(row.businessDate), row.businessDate).toBe(row.gross - row.discount - row.refund);
  });
  it('matches cafe cost, margin and same-cutoff comparison, with the current latte recipe', () => {
    const margin = model('margin');
    expect(margin.netSales).toBe(831_220);
    expect(margin.cost).toBe(244_333);
    expect(margin.grossProfit).toBe(586_887);
    expect(margin.rate).toBe(70.6);
    expect(margin.comparison?.baseRate).toBe(71);
    expect(margin.comparison?.delta).toEqual({ value: -0.4, kind: 'pp' });
    expect(margin.costMissing).toBe(false);
    expect(margin.menus.every((m) => !m.costMissing)).toBe(true);
    const latte = margin.menus.find((m) => m.menuId === 'm-cafe-latte');
    expect(latte?.price).toBe(3_800);
    expect(latte?.unitCost).toBe(1_278);
    expect(latte?.recipe.reduce((s, p) => s + p.cost, 0)).toBe(1_278);
    expect(simulateMenuPrice({ price: 3_800, unitCost: 1_278 })).toMatchObject({ profit: 2_522, rate: 66.4 });
    expect(simulateMenuPrice({ price: 3_800, unitCost: 2_000 }, { price: 3_800, unitCost: 1_278 })).toEqual({ profit: 1_800, rate: 47.4, profitDelta: -722, rateDelta: -19 });
    expect(simulateMenuPrice({ price: 0, unitCost: 100 })).toBeNull();
    // default sort: margin rate ascending
    const rates = margin.menus.map((m) => m.rate ?? -1);
    expect([...rates].sort((a, b) => a - b)).toEqual(rates);
  });
  it('reconciles confirmed cafe expenses and the monthly tax queue', () => {

    const ledger = model('ledger');
    expect(ledger.expenses.total).toBe(110_000);
    expect(ledger.expenses.byCategory.map(c => [c.category, c.amount])).toEqual([['ingredients', 110_000]]);
    expect(ledger.missingEvidenceCount).toBe(1);
    expect(ledger.remaining).toBe(721_220);
    expect(ledger.candidates).toEqual([]);
    const tax = model('tax');
    expect(tax.period).toEqual({ start: MONTH_START, end: TODAY });
    const unchecked = seedOperations.expenses.filter(row => row.businessDate >= MONTH_START && row.businessDate <= TODAY && row.taxCheck === 'needs-check');
    expect(tax.reviewCount).toBe(unchecked.length);
    expect(tax.items).toHaveLength(unchecked.length);
    expect(tax.items[0]).toMatchObject({ refId: unchecked[0].expenseId, amount: unchecked[0].amount, status: 'needs-check' });
    expect(tax.estimate).toBeNull();
  });
  it('two open, unreviewed support candidates from the cafe supplement', () => {
    const grants = model('grants');
    expect(grants.candidateCount).toBe(2);
    expect(grants.notices.map((n) => n.applyEnd)).toEqual(seedSupplement.grants.map(row => `${row.applyEnd}T18:00`));
    expect(grants.notices.every((n) => n.isCandidate && n.reviewStatus === 'before')).toBe(true);
  });
});

describe('seed: customers (AC-225·235·250·252·254·256)', () => {
  it('180 sample visits, a 09:00 peak and staffing from the roster', () => {
    const cctv = model('customer-analysis');
    expect(cctv.totalVisits).toBe(180);
    expect(cctv.coverage).toEqual({ startHour: 8, endHour: 16 });
    expect(cctv.peak).toMatchObject({ hour: 9, visits: 37, staff: 2 });
    // PRD 12.3 F-277 / 12.7: the staff schedule owns CCTV work data.
    const staff = selectStaffSchedule(snapshot, { startDate: cctv.date, endDate: cctv.date });
    expect(staff.hourly.find(row => row.hour === 9)?.staffCount).toBe(2);
  });
  it('tomorrow demand uses last Wednesday and the Monday-start week', () => {

    const demand = model('demand');
    const lastWednesday = seedHistory.days.find(row => row.date === addDays(TOMORROW, -7))!;
    expect(demand.day.date).toBe(TOMORROW);
    expect(demand.day.expected).toBe(lastWednesday.orders);
    expect(demand.day.bands.map(b => b.expected)).toEqual([65, 111, 35]);
    expect(demand.day.lastWeek).toEqual({ date: lastWednesday.date, actual: lastWednesday.orders, delta: { value: 0, kind: 'count', unit: 'person' } });
    expect(demand.day.busy).toEqual({ startHour: 12, endHour: 13 });
    expect(demand.suggestions).toEqual([]);
    expect(snapshot.tables.shift.filter(s => s.date === TOMORROW && s.start <= '13:00' && s.end > '13:00')).toHaveLength(2);
    const week = model('demand', { kind: 'dateRange', start: WEEK_START, end: WEEK_END });
    expect(week.view).toBe('week');
    expect(week.days).toHaveLength(7);
  });
  it('matches the sample active passes and separates current-week expiry', () => {

    const m = model('memberships');
    const passes = seedSupplement.activePasses;
    expect(m.activeCount).toBe(passes.length);
    expect(m.byProduct.reduce((s, p) => s + p.activeCount, 0)).toBe(passes.length);
    expect(m.endingThisWeekCount).toBe(1);
    expect(m.endingThisWeek.map(row => [row.membershipId, row.usesLeft])).toEqual([[passes[1].membershipId, passes[1].usesLeft]]);
    expect(m.endingSoon.map(row => row.endsOn)).toEqual([passes[1].endsOn]);
  });
  it('projects the cafe reservations and shows an over-capacity sample only in the special state', () => {

    const v = model('voice-booking');
    expect(v.todayCount).toBe(seedToday.bookings.length + seedSupplement.bookings.length);
    expect(v.needsCheckCount).toBe(1);
    expect(v.seats).toBe(manifest.store.seats);
    expect(v.slots.map(s => [s.time, s.count, s.people])).toEqual([['13:49', 1, 1], ['17:30', 1, 3], ['18:00', 1, 4], ['19:30', 1, 2]]);
    expect(v.reservations.map(row => row.status)).toEqual(['completed', 'confirmed', 'confirmed', 'needs-check']);
    const special = selectWidget(snapshot, 'voice-booking', { kind: 'default' }, 'needs-confirmation');
    if (special.status !== 'ready') throw new Error('special not ready');
    expect(special.model.todayCount).toBe(v.todayCount + 1);
    expect(special.model.needsCheckCount).toBe(v.needsCheckCount + 1);
    expect(special.model.reservations.find(row => row.reservationId === 'sample-booking-over-capacity')).toMatchObject({
      status: 'needs-check', partySize: 31, overSeats: true, canConfirm: true,
    });
  });
});

describe('seed: operations (AC-213·231·235·236·258·262·266·268~270·273)', () => {
  it('projects the cafe layout and its 30 seats across the three zones', () => {

    const f = model('floor-plan');
    expect(f.seatCount).toBe(manifest.store.seats);
    expect(f.tableCount).toBe(seedCatalog.tables.length);
    expect(f.zones.map(z => [z.zone, z.seats])).toEqual([['window', 8], ['center', 16], ['bar', 6]]);
    expect(f.layouts).toEqual([expect.objectContaining({ layoutId: seedCatalog.layout.layoutId, isCurrent: true, seatCount: 30, aisleWarning: false, aisleCm: 100 })]);
    expect(f.aisleMinCm).toBe(90);
  });
  it('projects direct, shift and deadline entries with received deliveries and visits outside the agenda', () => {

    const c = model('calendar');
    expect(c.visibility.reservation).toBe(false);
    expect(c.todayCount).toBe(3);
    expect(c.todayEntries.map(e => [e.time, e.source])).toEqual([['12:00', 'shift'], ['16:30', 'direct'], ['17:00', 'shift']]);
    expect(c.monthEntries.some(entry => entry.source === 'delivery')).toBe(false);
    expect(c.weekCount).toBe(8);
    const week = c.weekEntries.map(e => [e.date, e.source, e.sourceId]);
    expect(week).toEqual(expect.arrayContaining([
      [TODAY, 'direct', 'sample-calendar-1'],
      [TODAY, 'shift', `${TODAY}@17:00`], [addDays(TODAY, 2), 'deadline', 'sample-community-1'],
    ]));
  });
  it('puts the approved café order on the calendar once, while the unapproved order has no pickup', () => {
    const orders = model('custom-order');
    expect(orders.orders.find(order => order.customOrderId === 'CO-001')).toMatchObject({
      productLabel: '카페라떼', quantity: 12, quoteAmount: 45_600, customerDecision: 'approved', stage: 'in_production',
      payment: { status: 'unpaid' }, confirmedPickupAt: '2026-11-18T10:30',
    });
    expect(orders.orders.find(order => order.customOrderId === 'CO-002')?.pickup).toBeNull();
    const calendar = model('calendar');
    expect([calendar.pickupCount, calendar.tomorrowPickupCount]).toEqual([0, 1]);
    expect(calendar.pickupEntries).toMatchObject([{
      date: '2026-11-18', time: '10:30', source: 'pickup', editable: false, sourceId: 'PICKUP-CO-001',
      ref: { featureId: 'custom-order', itemId: 'CO-001' },
    }]);
  });
  it('keeps milk and beans above their cafe reorder thresholds', () => {

    const inv = model('inventory-booking');
    expect(inv.restockCount).toBe(0);
    expect(inv.outOfStockCount).toBe(0);
    expect(inv.restockItems).toEqual([]);
    expect(inv.ingredients.find(i => i.itemId === 'i-milk')).toMatchObject({ stock: 20_400, threshold: 12_000, trackRestock: true, needsRestock: false, nextDelivery: null });
    expect(inv.ingredients.find(i => i.itemId === 'i-bean-house')).toMatchObject({ stock: 5_688, threshold: 4_000, trackRestock: true, needsRestock: false, nextDelivery: null });
  });
  it('the cafe has no separately tracked retail stock on either channel', () => {

    const p = model('inventory-booking').products;
    expect(p.total).toBe(0);
    expect(p.byChannel).toEqual({ store: 0, online: 0 });
    expect(p.items).toEqual([]);
    expect(p.lowCount).toBe(0);
  });
  it('completed cafe deliveries stay outside upcoming and overdue orders', () => {

    const s = model('suppliers');
    expect(s.upcomingCount).toBe(0);
    expect(s.overdueCount).toBe(0);
    expect(s.upcoming).toEqual([]);
    expect(seedOperations.purchaseOrders.some(order => order.dueDate === TODAY && order.status === 'complete')).toBe(true);
  });
  it('published cafe manuals have opening and closing checklists with no initial progress', () => {

    const m = model('manuals');
    expect(m.publishedCount).toBe(5);
    expect(m.todayChecklist.find(c => 'raw' in c.title && c.title.raw === '오픈 체크리스트')).toMatchObject({ done: 0, total: 5 });
    expect(m.manuals.some(x => x.category === 'closing')).toBe(true);
    expect(m.manuals.map(x => x.manualId)).toEqual(seedOperations.manuals.filter(row => row.isPublished).map(row => row.manualId).sort());
  });
  it('minimum wage basis is 10,320 and cafe help hours are weekdays 12–14', () => {
    const h = model('hiring');
    expect(h.minimumWage).toBe(10_320);
    expect(MINIMUM_WAGE).toBe(10_320);
    expect(h.helpHours).toEqual({ weekdays: [1, 2, 3, 4, 5], startHour: 12, endHour: 14, level: 4 });
    expect(h.draftStatus).toBe('none');
    expect(h.suggestion.hourlyWage).toBeGreaterThanOrEqual(10_320);
  });
});

describe('seed: marketing (AC-275·277·279·281·283)', () => {
  it('48 waiting cafe inquiries across messages, reviews and calls', () => {
    const a = model('ai-response');
    expect(a.waitingCount).toBe(48);
    expect(a.byType).toEqual({ message: 7, review: 40, call: 1 });
    expect(a.priority).toHaveLength(a.waitingCount);
    expect(a.autoReply.every((r) => !r.enabled)).toBe(true);
  });
  it('projects the cafe neighborhood changes in start-date order', () => {

    const l = model('local-changes');
    const changes = [...seedSupplement.localChanges].sort((a, b) => a.startDate.localeCompare(b.startDate));
    expect(l.count).toBe(changes.length);
    expect(l.changes.map(c => [c.titleKey, c.kind, c.sameCategory])).toEqual(changes.map(c => [`seed:${c.title}`, c.kind, false]));
  });
  it('sample foot traffic ranks 18:00 first, then 12:00', () => {
    const t = model('trade-area');
    expect(t.peak).toEqual({ hour: 18, people: 395 });
    expect(t.top).toEqual([{ hour: 18, people: 395 }, { hour: 12, people: 365 }]);
  });
  it('three notable cafe keywords, each with a comparison', () => {
    const t = model('local-trends');
    expect(t.notableCount).toBe(3);
    expect(t.notable.map((k) => k.keywordKey)).toEqual(['seed:보늬밤 라떼', 'seed:숭실대 디저트', 'seed:상도동 카공']);
    expect(t.keywords.every(k => !k.noComparison)).toBe(true);
  });
  it('one direct cafe offer awaits a reply', () => {

    const c = model('community');
    expect(c.pendingCount).toBe(1);
    expect(c.pending.map(o => [o.titleKey, o.respondBy])).toEqual([['seed:북클럽 모임 공동 안내', '2026-11-19T18:00']]);
    expect(c.publicOffers).toHaveLength(3);
  });
});

describe('seed: briefing reads the other models (AC-231·240)', () => {
  it('arrival shows the cafe schedule and closing reconciles with ledger', () => {
    const b = model('briefing');
    expect(b.arrival.map((i) => [i.featureId, i.value])).toEqual([['calendar', 3]]);
    expect(b.arrival.map((i) => i.ref.featureId)).toEqual(['calendar']);
    expect(b.closing).toEqual({ netSales: 831_220, remaining: 721_220});
    expect(b.yesterday.date).toBe(YESTERDAY);
    expect(b.yesterday.netSales).toBe(1_077_440);
  });
});
