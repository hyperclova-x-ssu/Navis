import { selectMoneyRead, selectM2DayTotals, selectM2Drawer } from './pos/projection';
import { selectAccountingDay } from './iteration7/accounting';
import { selectCustomAccounting } from './iteration7/custom-orders';
import { selectCustomOrderRead } from './pos/projection';
import { tableLinksEnabled, cctvPosLinks } from './iteration7/table-links';
import { selectTableMap } from '../pos/tables/selectors';
/**
 * Navis facts (DATA_MODEL 10.13, API-09 v4 `widgetFacts`). Values stay in stored units (won, not 만 원);
 * the assistant adds the localized `display`/`label` when it builds a request (API-10 v4, T-046).
 * `labelText` (when present) is a more specific label than `labelKey`; `text` holds a translatable
 * string value (keyword, schedule title, manual step) and `source` the origin (manual title).
 */
import type { DataText, UnitCode } from './db/types';
import type { WidgetView, ModelMap, Period } from './models/types';
import type { DataWidgetId } from './conditions';
import { addDays, TODAY } from './db/time';
import { selectNextTaxPayment } from './commands/management-guards';
import { readDemand } from './models/select';
import type { DataSnapshot } from './db/types';
import { marketingFactBuilders } from './marketing/facts';
import { CCTV_SNAPSHOT, TABLE_COUNT } from './cctv/snapshot';
import { TODAY_AVG_DWELL_MIN } from './cctv/dwell';
import { mockChange5m } from './cctv/view';
import type { PosReadSnapshot } from '../contracts/pos';
import { selectOrderSummary } from '../pos/status';
import { POS_NOW_TIME } from '../pos/clock';
import { selectPosDataRead } from './pos/catalog';
import type { StaffScheduleModel } from './iteration7/staff/types';

export interface ModelFact {
  readonly key: string;
  readonly value: number | string;
  readonly unit: UnitCode | '';
  readonly date?: string;
  readonly start?: string;
  readonly end?: string;
  readonly labelKey: string;
  readonly labelText?: DataText;
  readonly text?: DataText;
  readonly source?: DataText;
}

type Extra = Partial<Pick<ModelFact, 'date' | 'start' | 'end' | 'labelText' | 'text' | 'source'>>;
const fact = (key: string, value: number | string, unit: UnitCode | '', extra: Extra = {}, labelKey = `data.fact.${key}`): ModelFact => ({ key, value, unit, labelKey, ...extra });
const when = (p: Period): Extra => (p.start === p.end ? { date: p.start } : { start: p.start, end: p.end });
const today: Extra = { date: TODAY };

const staffFacts = (m: StaffScheduleModel): ModelFact[] => [
  fact('staff.today.working', m.today.workingCount, 'person', today),
  fact('staff.today.off', m.today.offCount, 'person', today),
  ...(m.today.nextHandoffAt ? [fact('staff.nextHandoff.time', m.today.nextHandoffAt, '', today)] : []),
  ...m.hourly.map(row => fact(`staff.hourly.${row.hour}.count`, row.staffCount, 'person', { date: row.date, labelText: { key: 'data.fact.staff.hourly.count', params: { hour: row.hour } } }, 'data.fact.staff.hourly.count')),
];

/** DATA_MODEL 12.7: mock CCTV facts, the fixed t=160 scene. Live values never go into facts (AC-1324), whatever the toggle says. */
const mockCctvFacts = (): ModelFact[] => {
  const change = mockChange5m(CCTV_SNAPSHOT.inStore);
  const used = CCTV_SNAPSHOT.occupiedTables.length;
  const toClear = CCTV_SNAPSHOT.tablesToClear.length;
  return [
    fact('cctv.inStore.now', CCTV_SNAPSHOT.inStore, 'person', today),
    fact('cctv.occupants.now', CCTV_SNAPSHOT.occupants, 'person', today),
    fact('cctv.tables.occupied', used, 'table', today),
    fact('cctv.tables.toClear', toClear, 'table', today),
    fact('cctv.tables.empty', TABLE_COUNT - used - toClear, 'table', today),
    // minutes have no unit code yet (UnitCode is R3/i18n owned): the value is minutes and the label key says so.
    fact('cctv.dwell.avgToday', TODAY_AVG_DWELL_MIN, '', today),
    ...(change !== null ? [fact('cctv.change5m', change, 'person', today)] : []),
  ];
};

const nextTaxFact = (payments: ModelMap['tax']['payments']): ModelFact[] => {
  const next = selectNextTaxPayment(payments);
  return next ? [fact('tax.payment.next', next.amount, 'KRW', { date: next.dueOn, labelText: next.type })] : [];
};

const builders: { readonly [F in DataWidgetId]: (m: ModelMap[F]) => ModelFact[] } = {
  'credit-receivable': m => [fact('account.charge.total',m.chargeBalance,'KRW',today),fact('account.charge.members',m.chargeHolders,'person',today),fact('account.receivable.total',m.receivableBalance,'KRW',today),fact('account.receivable.members',m.receivableHolders,'person',today)],
  'notice-send': m => [fact('notice.unsentClosure.count',m.unsentCount,'count',today),fact('notice.sent.count',m.sentCount,'count',today),...(m.nextClosure?[fact('notice.nextClosure.date',m.nextClosure.startDate,'',{date:m.nextClosure.startDate})]:[]),...m.sent.map(row=>fact('notice.sent.recipientCount',row.recipientCount,'person',{date:row.sentAt.slice(0,10)}))],
  'store-environment': m => [...(m.current ? [fact('environment.temperature',m.current.temperatureC,'',{date:m.current.measuredAt.slice(0,10)}),fact('environment.humidity',m.current.humidityPct,'percent',{date:m.current.measuredAt.slice(0,10)}),fact('environment.measuredAt',m.current.measuredAt.slice(11),'',today)] : []),fact('environment.sensor.status',m.sensorStatus,'',today),fact('music.playing',m.music.playing?'재생 중':'일시 정지','',today),fact('music.volume',m.music.volumePct,'percent',today),...(m.music.track ? [fact('music.track',m.music.track.title,'',today)] : [])],
  'custom-order': m => [fact('custom.active.count',m.summary.inProgress,'count',today),fact('custom.approvalPending.count',m.summary.approvalPending,'count',today),fact('pickup.today.count',m.summary.todayPickup,'count',today),fact('pickup.tomorrow.count',m.summary.tomorrowPickup,'count',{date:'2026-10-27'}),fact('pickup.today.incomplete.count',m.summary.todayNotComplete,'count',today)],
  'staff-schedule': staffFacts,
  menu: (m) => [fact('menu.count', m.total, 'count')],
  members: (m) => [fact('members.count', m.total, 'person'), fact('memberships.active.count', m.membershipCount, 'count'), fact('memberships.endingThisWeek.count', m.endingThisWeekCount, 'count')],
  briefing: (m) => [fact('briefing.importantAlerts.count', m.importantAlerts.count, 'count', today),fact('briefing.arrival.count', m.arrival.length, 'count', today), ...m.arrival.map((i) => fact('briefing.arrival.item', i.value, i.unit, { ...today, text: { key: i.messageKey, params: i.params } }))],
  ledger: (m) => [
    fact('ledger.sales.net', m.sales.net, 'KRW', when(m.period)),
    ...(m.comparison ? [fact('ledger.sales.delta', m.comparison.delta.value, 'percent', { ...when(m.period) })] : []),
    fact('ledger.expenses.total', m.expenses.total, 'KRW', when(m.period)),
    ...m.expenses.byCategory.map((c) => fact('ledger.expenses.category', c.amount, 'KRW', { ...when(m.period), labelText: { key: c.categoryKey } })),
    ...(m.remaining !== null ? [fact('ledger.remaining', m.remaining, 'KRW', when(m.period))] : []),
    fact('ledger.evidence.missing', m.missingEvidenceCount, 'count', when(m.period)),
    fact('ledger.candidates.count', m.candidates.length, 'count', when(m.period)),
    ...(m.period.start !== m.period.end ? m.trend.map((d) => fact('ledger.sales.daily', d.net, 'KRW', { date: d.date })) : []),
  ],
  margin: (m) => [
    ...(m.rate !== null ? [fact('margin.rate', m.rate, 'percent', when(m.period))] : []),
    ...(m.comparison ? [fact('margin.rate.delta', m.comparison.delta.value, 'pp', when(m.period))] : []),
    fact('margin.sales.net', m.netSales, 'KRW', when(m.period)),
    ...(m.cost !== null ? [fact('margin.cost', m.cost, 'KRW', when(m.period))] : []),
    ...(m.grossProfit !== null ? [fact('margin.grossProfit', m.grossProfit, 'KRW', when(m.period))] : []),
    ...m.menus.filter((x) => x.rate !== null).map((x) => fact('margin.menu.rate', x.rate as number, 'percent', { ...when(m.period), labelText: { key: x.nameKey } })),
  ],
  tax: (m) => [fact('tax.review.count', m.reviewCount, 'count', m.period ? when(m.period) : {}),
    // The earliest unpaid due date, from the selector the 세무관리 panel and detail use (S2-040), never the table's first row.
    ...nextTaxFact(m.payments),
    ...(m.estimate ? [fact('tax.estimate', m.estimate.amount, 'KRW', { date: m.estimate.basisDate })] : [])],
  grants: (m) => [fact('grants.candidates.count', m.candidateCount, 'count', today), ...m.notices.filter((n) => n.isCandidate).map((n) => fact('grants.notice', n.applyEnd, '', { date: n.applyEndDate, text: { key: n.titleKey } }))],
  'customer-analysis': (m) => [
    fact('cctv.visits.total', m.totalVisits, 'visit', today),
    ...(m.peak ? [fact('cctv.peak.hour', m.peak.hour, 'hour', today), fact('cctv.peak.visits', m.peak.visits ?? 0, 'visit', today), ...(m.peak.staff !== null ? [fact('cctv.peak.staff', m.peak.staff, 'person', today)] : [])] : []),
    ...mockCctvFacts(),
  ],
  'voice-booking': (m) => [
    // Every date here follows the model's business date; tomorrow is that date + 1, never a typed calendar day.
    fact('pickup.today.count',m.pickupCount,'count',{ date: m.date }), fact('pickup.tomorrow.count',m.tomorrowPickupCount,'count',{ date: addDays(m.date, 1) }),
    fact('booking.today.count', m.todayCount, 'reservation', { date: m.date }), fact('booking.needsCheck.count', m.needsCheckCount, 'reservation', { date: m.date }), fact('booking.seats', m.seats, 'seat', { date: m.date }),
    ...m.slots.map((s) => fact('booking.slot', s.count, 'reservation', { date: m.date, labelText: { key: 'data.fact.booking.slotAt', params: { time: s.time, people: s.people } } })),
  ],
  calendar: (m) => [
    fact('calendar.today.count', m.todayCount, 'count', today), fact('calendar.week.count', m.weekCount, 'count', { start: m.week.start, end: m.week.end }),
    ...m.weekEntries.map((e) => fact('calendar.entry', e.time ?? '', '', { date: e.date, text: e.title })),
  ],
  'inventory-booking': (m) => [
    fact('inventory.restock.count', m.restockCount, 'item', { date: m.asOf }), fact('inventory.outOfStock.count', m.outOfStockCount, 'item', { date: m.asOf }),
    // One resolved record name per ingredient (typed name when created or renamed, seed key otherwise) for stock, threshold and use alike.
    ...m.ingredients.filter((i) => i.stock !== null).map((i) => fact('inventory.stock', i.stock as number, i.unit, { date: m.asOf, labelText: i.name ?? { key: i.nameKey } })),
    ...m.ingredients.filter((i) => i.threshold !== null).map((i) => fact('inventory.threshold', i.threshold as number, i.unit, { date: m.asOf, labelText: i.name ?? { key: i.nameKey } })),
    ...m.ingredients.map((i) => fact('inventory.usedToday', i.usedToday, i.unit, { date: m.asOf, labelText: i.name ?? { key: i.nameKey } })),
    fact('inventory.products.total', m.products.total, 'pcs', { date: m.asOf }), fact('inventory.products.store', m.products.byChannel.store, 'pcs', { date: m.asOf }), fact('inventory.products.online', m.products.byChannel.online, 'pcs', { date: m.asOf }),
  ],
  suppliers: (m) => [
    fact('suppliers.upcoming.count', m.upcomingCount, 'order', { start: m.window.start, end: m.window.end }), fact('suppliers.overdue.count', m.overdueCount, 'order', today),
    ...m.upcoming.flatMap((o) => o.lines.filter((l) => l.remaining > 0).map((l) => fact('suppliers.delivery', l.remaining, l.unit, { ...(o.dueDate ? { date: o.dueDate } : {}), labelText: { key: 'data.calendar.delivery', keyParams: { item: l.itemNameKey, supplier: o.supplierNameKey } } }))),
  ],
  manuals: (m) => [
    fact('manuals.published.count', m.publishedCount, 'count'),
    ...m.manuals.flatMap((x) => x.steps.map((s) => fact('manuals.step', `${x.manualId}#${s.stepNo}`, '', { text: s.body, source: x.title }))),
  ],
  'local-changes': (m) => [fact('localChanges.week.count', m.count, 'count', { start: m.week.start, end: m.week.end }), ...m.changes.map((c) => fact('localChanges.change', c.kind, '', { date: c.startDate, text: { key: c.titleKey } }))],
  'trade-area': (m) => [fact('tradeArea.peak.people', m.peak.people, 'person', { labelText: { key: 'data.fact.tradeArea.peakAt', params: { hour: m.peak.hour } } }), fact('tradeArea.peak.hour', m.peak.hour, 'hour'), ...m.top.slice(1).map((h) => fact('tradeArea.hour.people', h.people, 'person', { labelText: { key: 'data.fact.tradeArea.peakAt', params: { hour: h.hour } } }))],
  'local-trends': (m) => [fact('localTrends.notable.count', m.notableCount, 'count', { start: m.period.start, end: m.period.end }), ...m.keywords.map((k) => fact('localTrends.keyword', k.mentions, 'count', { start: m.period.start, end: m.period.end, text: { key: k.keywordKey } }))],
  'ai-response': (m) => [fact('inquiry.waiting.count', m.waitingCount, 'count', today), fact('inquiry.waiting.message', m.byType.message, 'count', today), fact('inquiry.waiting.review', m.byType.review, 'count', today), fact('inquiry.waiting.call', m.byType.call, 'count', today)],
  community: (m) => [fact('community.pending.count', m.pendingCount, 'count', today), ...m.pending.map((o) => fact('community.offer', o.respondBy, '', { date: o.respondBy.slice(0, 10), text: { key: o.titleKey } }))],
  // plan-2 (DATA_MODEL 10.15.6, T-058)
  ...marketingFactBuilders,
};

const cache = new WeakMap<object, readonly ModelFact[]>();
/** Facts of a ready view (empty/error views have none). Memoized per view object. */
export function widgetFacts(view: WidgetView<unknown>): readonly ModelFact[] {
  if (view.status !== 'ready') return [];
  const hit = cache.get(view);
  if (hit) return hit;
  const build = builders[view.featureId as DataWidgetId] as ((m: unknown) => ModelFact[]) | undefined;
  const list = Object.freeze((build ? build(view.model) : []).map((f) => Object.freeze(f)));
  cache.set(view, list);
  return list;
}

export function demandFacts(snapshot: DataSnapshot): readonly ModelFact[] {
  const m = readDemand(snapshot);
  return [
    ...m.days.map((d) => fact('demand.expected.total', d.expected, 'person', { date: d.date })),
    ...m.day.bands.map((b) => fact('demand.expected.band', b.expected, 'person', { date: m.day.date, labelText: { key: b.bandKey } })),
    ...(m.day.lastWeek ? [fact('demand.lastWeek.actual', m.day.lastWeek.actual, 'person', { date: m.day.lastWeek.date }), fact('demand.delta', m.day.lastWeek.delta.value, 'person', { date: m.day.date })] : []),
    fact('demand.busy.start', m.day.busy.startHour, 'hour', { date: m.day.date }), fact('demand.busy.end', m.day.busy.endHour, 'hour', { date: m.day.date }),
  ];
}

/** API-251: normal facts read the immutable POS reference published with this data revision. */
export function posReadForFacts(snapshot: DataSnapshot): PosReadSnapshot | null {
  if (!snapshot.pos) return null;
  return { runId: snapshot.runId ?? '', runRevision: snapshot.revision, pos: snapshot.pos, posRevision: snapshot.pos.revision,
    posUi: { tab: 'order', approval: null, cartUndo: null }, dataRevision: snapshot.revision,
    settings: snapshot.tables.shopSettings, scenario: 'normal', data: selectPosDataRead(snapshot) };
}
export function selectPosFacts(read: PosReadSnapshot): readonly ModelFact[] {
  const summary = selectOrderSummary(read), totals = selectM2DayTotals(read.pos), drawer = selectM2Drawer(read.pos);
  const source=read.data.source as DataSnapshot | undefined;
  const accounting=source?.tables ? selectAccountingDay(selectMoneyRead(source),{date:read.pos.businessDate}):null;
  const custom=source?.tables ? selectCustomAccounting(selectCustomOrderRead(source)) : null;
  const map=new Map(selectTableMap(read).tables.map(t=>[t.tableId,t]));
  const links=tableLinksEnabled(read.settings) ? cctvPosLinks(read.settings) : [];
  const linked=links.filter(l=>map.has(l.tableId));
  const date = read.pos.businessDate, asOf = { key: 'data.pos.asOf', params: { date, time: POS_NOW_TIME } };
  const f = (key: string, value: number | string, unit: ModelFact['unit'] = ''): ModelFact => fact(key, value, unit, { date, source: asOf,...(key.startsWith('pos.method.')?{labelText:{raw:key.endsWith('.card')?'카드 판매분':key.endsWith('.cash')?'현금 판매분':'간편결제 판매분'}}:{}) }, `data.pos.fact.${key}`);
  return [f('orders.today.count', summary.todayCount, 'order'), f('orders.open.count', summary.openCount, 'order'),
    f('orders.missing.count', summary.missingCount, 'order'), f('orders.slow.count', summary.slowCount, 'order'),
    ...(summary.avgWaitMin === null ? [] : [f('orders.avgWait.minutes', summary.avgWaitMin)]),
    ...summary.openList.filter(row => row.isMissing).flatMap(row => [
      f('orders.missing.no', row.no), f('orders.missing.content', row.menuText),
      f('orders.missing.orderedAt', row.orderedAt.slice(11)), f('orders.missing.elapsed.minutes', row.elapsedMin),
    ]),
    f('pos.payments.count', totals.paymentCount, 'count'), f('pos.refunds.count', totals.refundCount, 'count'),
    ...(['gross', 'discount', 'refund', 'net'] as const).map(key => f(`pos.sales.${key}`, key === 'net' ? totals.revenue : totals[key], 'KRW')),
    ...(['opening', 'approvedCash', 'cashPayments', 'pendingCash', 'cashReturned', 'in', 'out'] as const).map(key => f(`pos.drawer.${key}`, drawer[key], 'KRW')),
    { ...f('pos.drawer.actual', drawer.actual ?? 'unconfirmed', drawer.actual === null ? '' : 'KRW'), ...(drawer.actual === null ? { text: { key: 'data.pos.drawer.unconfirmed' } } : {}) },
    f('pos.cash.expected', drawer.expected, 'KRW'),
    f('pos.cash.checked', drawer.actual === null ? 0 : 1),
    ...(drawer.difference === null ? [] : [f('pos.cash.difference', drawer.difference, 'KRW')]),
    ... (accounting ? Object.entries({card:accounting.sales.byRealMethodSale.card,easyPay:accounting.sales.byRealMethodSale.easy_pay,cash:accounting.sales.byRealMethodSale.cash,charge:accounting.sales.chargeUsed,receivable:accounting.sales.receivableCreated,countPass:accounting.sales.membershipCount,subscription:accounting.sales.subscriptionDaily,expiry:accounting.sales.membershipExpiry,customPickup:accounting.sales.customPickup}).map(([key,value])=>f(`accounting.sales.${key}`,value,'KRW')) : [f('accounting.sales.customPickup',totals.customPickup,'KRW')]),
    f('accounting.deposits.total',totals.deposits.total,'KRW'),
    f('accounting.deposits.card',totals.deposits.byMethod.card,'KRW'),
    f('accounting.deposits.easyPay',totals.deposits.byMethod.easy_pay,'KRW'),
    f('accounting.deposits.cash',totals.deposits.byMethod.cash,'KRW'),
    ...(accounting ? Object.entries(accounting.deposits.byPurpose).map(([key,value])=>f(`accounting.deposits.purpose.${key}`,value,'KRW')) : [f('accounting.deposits.purpose.custom_order',custom?.realDeposits ?? 0,'KRW')]),
    f('tables.linked.count',linked.length,'count'),
    f('tables.seatedNoOrder.count',linked.filter(l=>CCTV_SNAPSHOT.occupiedTables.some(id=>id===l.zoneId) && map.get(l.tableId)?.state==='empty').length,'count'),
    f('tables.needsClearing.count',linked.filter(l=>CCTV_SNAPSHOT.tablesToClear.some(id=>id===l.zoneId) && ['empty','cleaning'].includes(map.get(l.tableId)?.state ?? '')).length,'count'),
    f('pos.method.card', totals.byMethod.card, 'KRW'), f('pos.method.easyPay', totals.byMethod.easy_pay, 'KRW'), f('pos.method.cash', totals.byMethod.cash, 'KRW'),
  ];
}
export function posFacts(snapshot: DataSnapshot): readonly ModelFact[] {
  const read = posReadForFacts(snapshot); return read ? selectPosFacts(read) : [];
}
