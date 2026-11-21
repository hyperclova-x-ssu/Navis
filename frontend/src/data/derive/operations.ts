import { selectNotices } from '../iteration7/notices';
import { selectStoreEnvironment, type EnvironmentVariant } from '../iteration7/environment';
import { selectCustomOrders, selectCustomCalendar } from '../iteration7/custom-orders';
import { selectCustomOrderRead, selectM2Drawer } from '../pos/projection';
import type { SeatedWithoutOrderTask } from '../iteration7/table-links';
import type { CalendarEntry } from '../models/types';
import type { CalendarCategory } from '../db/management-types';
import type { DetailRef } from '../../contracts';
import { addDays, dateOf, daysBetween, inRange, timeOf, weekdayOf } from '../db/time';
import { memoSelector, requireDate } from './common';
import { BUSINESS_CLOCK } from '../commands/business-clock';
import { selectNextTaxPayment } from '../commands/management-guards';
import { deriveOpenOrders, deriveStock } from './stock';
import { selectReservations } from './reservations';
import { selectClosing } from './payments';
import { posReadForFacts } from '../facts';
import { selectOrderSummary } from '../../pos/status';
import type { DataSnapshot } from '../db/types';
import type { PosReadSnapshot } from '../../contracts/pos';
import { handoffTimes, selectStaffSchedule } from '../iteration7/staff/selectors';

export const selectCalendar = memoSelector((q: { readonly date: string; readonly start?: string; readonly end?: string; readonly sourceFailed?: boolean }) => JSON.stringify(q), (s, q) => {
  requireDate(q.date); if (q.start) requireDate(q.start); if (q.end) requireDate(q.end);
  const t = s.tables, entries: CalendarEntry[] = [];
  const add = (entry: Omit<CalendarEntry, 'categoryId'> & { categoryId: CalendarCategory }) => { if (t.categoryVisibility[entry.categoryId]) entries.push(entry); };
  if (t.calendarSettings.direct) for (const e of t.calendarEvent) add({ id: `direct:${e.eventId}`, source: 'direct', sourceId: e.eventId, kind: e.kind, date: e.date, time: e.time, title: e.title, memo: e.memo, ref: null, editable: true, categoryId: e.categoryId ?? 'store-operations' });
  if (t.calendarSettings.delivery) for (const o of deriveOpenOrders(s, { date: q.date }).open) if (o.dueDate) add({ id: `delivery:${o.poId}`, source: 'delivery', sourceId: o.poId, kind: 'event', date: o.dueDate, time: o.expectedTime, title: { key: 'data.calendar.delivery', keyParams: { item: o.lines[0]?.itemNameKey ?? '', supplier: o.supplierNameKey } }, memo: null, ref: { featureId: 'suppliers', view: 'order', itemId: o.poId }, editable: false, categoryId: 'purchasing' });
  if (t.calendarSettings.reservation) for (const date of new Set(t.reservation.map((r) => r.date))) for (const r of selectReservations(s, { date }).rows.filter((r) => r.counts)) add({ id: `reservation:${r.reservationId}`, source: 'reservation', sourceId: r.reservationId, kind: 'event', date, time: r.time, title: { key: 'data.calendar.reservation', params: { party: r.partySize }, keyParams: { name: r.nameKey } }, memo: null, ref: { featureId: 'voice-booking', itemId: r.reservationId }, editable: false, categoryId: 'store-operations' });
  const staffEntries: CalendarEntry[] = [];
  if (t.calendarSettings.shift && t.categoryVisibility['store-operations']) for (const date of new Set(t.staffSchedule.map(r => r.date))) {
    const own = selectStaffSchedule(s, { startDate: date, endDate: date });
    for (const time of handoffTimes(own.rows)) add({ id: `shift:${date}@${time}`, source: 'shift', sourceFeatureId: 'staff-schedule', sourceId: `${date}@${time}`, kind: 'event', date, time, title: { key: 'data.calendar.shiftChange' }, memo: null, ref: { featureId: 'staff-schedule', view: 'date', itemId: date }, editable: false, categoryId: 'store-operations' });
    for (const row of own.rows) staffEntries.push({ id: `shift:${row.scheduleId}`, source: 'shift', sourceFeatureId: 'staff-schedule', sourceId: row.scheduleId, kind: 'event', date, time: row.start,
      title: { key: row.kind === 'work' ? 'data.staff.calendar.work' : 'data.staff.calendar.off', params: { name: own.staff.find(person => person.staffId === row.staffId)!.name, start: row.start ?? '', end: row.end ?? '' } }, memo: null,
      ref: { featureId: 'staff-schedule', view: 'schedule', itemId: row.scheduleId }, editable: false, categoryId: 'store-operations' });
  }
  if (t.calendarSettings.deadline && !q.sourceFailed) {
    for (const p of t.taxPayment.filter((p) => p.status === 'unpaid')) add({ id: `tax:${p.taxPaymentId}`, source: 'deadline', sourceId: p.taxPaymentId, kind: 'event', date: p.dueOn, time: null, title: p.type, memo: null, ref: { featureId: 'tax', itemId: p.taxPaymentId }, editable: false, categoryId: 'tax-admin' });
    for (const n of t.grantNotice) if (!t.grantApplication.some((a) => a.noticeId === n.noticeId)) add({ id: `deadline:${n.noticeId}`, source: 'deadline', sourceId: n.noticeId, kind: 'event', date: dateOf(n.applyEnd), time: timeOf(n.applyEnd), title: { key: 'data.calendar.grantDeadline', keyParams: { title: n.titleKey } }, memo: null, ref: { featureId: 'grants', itemId: n.noticeId }, editable: false, categoryId: 'tax-admin' });
    for (const o of t.partnershipOffer.filter((o) => o.status === 'pending' && o.visibility === 'direct')) add({ id: `deadline:${o.offerId}`, source: 'deadline', sourceId: o.offerId, kind: 'event', date: dateOf(o.respondBy), time: timeOf(o.respondBy), title: { key: 'data.calendar.offerDeadline', keyParams: { title: o.titleKey } }, memo: null, ref: { featureId: 'community', itemId: o.offerId }, editable: false, categoryId: 'store-operations' });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.id.localeCompare(b.id));
  const weekStart = addDays(q.date, 1 - weekdayOf(q.date)), weekEnd = addDays(weekStart, 6);
  const first = `${q.date.slice(0, 7)}-01`, nextMonth = Number(first.slice(5, 7)) === 12 ? `${Number(first.slice(0, 4)) + 1}-01-01` : `${first.slice(0, 4)}-${String(Number(first.slice(5, 7)) + 1).padStart(2, '0')}-01`;
  const gridStart = addDays(first, 1 - weekdayOf(first)), last = addDays(nextMonth, -1), gridEnd = addDays(last, 7 - weekdayOf(last));
  const todayEntries = entries.filter((e) => e.date === q.date), weekEntries = entries.filter((e) => inRange(e.date, weekStart, weekEnd));
  const custom = selectCustomOrders({...selectCustomOrderRead(s),businessDate:q.date});
  const pickupEntries: CalendarEntry[] = t.calendarSettings.pickup !== false && t.categoryVisibility['store-operations'] ? selectCustomCalendar(selectCustomOrderRead(s)).map(e=>({id:e.eventId,source:'pickup',sourceFeatureId:'custom-order',sourceId:e.reservationId,kind:'event',date:e.date,time:e.time,title:{raw:e.title},memo:null,ref:{featureId:'custom-order',itemId:e.customOrderId},editable:false,categoryId:'store-operations'})) : [];
  return { pickupEntries:pickupEntries.filter(e=>inRange(e.date,q.start ?? gridStart,q.end ?? gridEnd)), pickupCount:custom.summary.todayPickup, tomorrowPickupCount:custom.summary.tomorrowPickup, staffEntries: staffEntries.filter(e => inRange(e.date, q.start ?? gridStart, q.end ?? gridEnd)), today: q.date, entries: entries.filter((e) => inRange(e.date, q.start ?? gridStart, q.end ?? gridEnd)), todayEntries, todayCount: todayEntries.length, weekEntries, weekCount: weekEntries.length, week: { start: weekStart, end: weekEnd }, month: { month: q.date.slice(0, 7), gridStart, gridEnd }, monthEntries: entries.filter((e) => inRange(e.date, gridStart, gridEnd)), upcoming: entries.filter((e) => (e.date > q.date || e.date === q.date && e.time !== null && e.time >= BUSINESS_CLOCK.time) && e.date <= weekEnd), visibility: t.calendarSettings, categoryVisibility: t.categoryVisibility, connected: t.integration.calendar };
});
export const selectCameras = memoSelector(
  (q: { readonly cameraDisconnected?: boolean; readonly reservationVariant?: string }) => String(!!q.cameraDisconnected),
  (s, q) => {
    const cameras = s.tables.cctvCamera;
    if (!q.cameraDisconnected || cameras.some(camera => camera.connection === 'disconnected')) return cameras;
    return cameras.map((camera, index) => index === cameras.length - 1
      ? { ...camera, connection: 'disconnected' as const, operation: 'stopped' as const }
      : camera);
  },
);
export const selectTaxPayments = memoSelector((q: { readonly date: string }) => q.date, (s, q) => { requireDate(q.date); return s.tables.taxPayment.map((p) => ({ ...p, overdue: p.status === 'unpaid' && p.dueOn < q.date })); });
/** The next payment to make: earliest due unpaid row (ties by amount, then id). The 세무관리 panel, its detail, the briefing and the Navis fact all read this one selector (S2-040). */
export { selectNextTaxPayment };
export interface AlertItem { readonly id: string; readonly messageKey: string; readonly params?: Readonly<Record<string, string | number>>; readonly ref: DetailRef | { readonly sourceId: 'pos'; readonly orderId: string } }
export interface AlertGroup { readonly id: 'purchasing' | 'stock' | 'tax' | 'tasks'; readonly items: readonly AlertItem[]; readonly ref: DetailRef }
export interface BriefingViewContext { readonly cameraDisconnected?: boolean; readonly reservationVariant?: string; readonly partial?: boolean; readonly environmentVariant?: string; readonly linkedTableTasks?: readonly SeatedWithoutOrderTask[] }
export const selectBriefing = memoSelector((q: { readonly date: string; readonly viewContext?: BriefingViewContext }) => JSON.stringify(q), (s, q) => {
  requireDate(q.date);
  const t = s.tables, stock = deriveStock(s, q), orders = deriveOpenOrders(s, q), calendar = selectCalendar(s, q);
  const purchasing = orders.open.filter((o) => o.overdue || o.dueDate === q.date).map((o) => ({ id: `order:${o.poId}`, messageKey: o.overdue ? 'data.management.alert.overdue' : 'data.management.alert.delivery', ref: { featureId: 'suppliers' as const, itemId: o.poId } }));
  const stockItems: AlertItem[] = stock.restockCount ? [{ id: 'stock:restock', messageKey: 'data.briefing.restock', params: { count: stock.restockCount }, ref: { featureId: 'inventory-booking' } }] : [];
  const tax = selectTaxPayments(s, q).filter((p) => p.status === 'unpaid' && daysBetween(q.date, p.dueOn) <= 30).map((p) => ({ id: `tax:${p.taxPaymentId}`, messageKey: 'data.management.alert.tax', ref: { featureId: 'tax' as const, itemId: p.taxPaymentId } }));
  const tasks: AlertItem[] = [];
  for (const c of selectNotices(s,{},q.date).upcomingUnsentClosures) tasks.push({id:`closure:${c.eventId}`,messageKey:'data.i7.alert.closure',params:{date:c.startDate.slice(5).replace('-','/'),kind:c.kind==='temporary'?'임시 휴무':'정기 휴무'},ref:{featureId:'notice-send',itemId:c.eventId}});
  for (const a of selectStoreEnvironment(s,(q.viewContext?.environmentVariant ?? 'normal') as EnvironmentVariant).alerts) tasks.push({id:`environment:${a.reason}`,messageKey:a.messageKey,ref:{featureId:'store-environment'}});
  for (const a of q.viewContext?.linkedTableTasks ?? []) tasks.push({...a,ref:{featureId:'customer-analysis',itemId:a.zoneId}});
  const custom = selectCustomOrders({...selectCustomOrderRead(s),businessDate:q.date});
  const posRead = posReadForFacts(s), pos = posRead ? selectPosBriefing(posRead) : null;
  if (pos?.missing) tasks.push({ id: 'pos:missing', messageKey: 'data.pos.missingTask', params: { count: pos.missingCount, no: pos.missing.no, item: pos.missing.menuText, n: pos.missing.elapsedMin }, ref: { sourceId: 'pos', orderId: pos.missing.id } });
  for (const m of t.manual.filter((m) => m.isPublished && m.category === 'opening' && m.section !== 'store-info')) {
    const steps = t.manualStep.filter((st) => st.manualId === m.manualId), done = steps.filter((st) => t.checklistLog.some((l) => l.date === q.date && l.manualId === m.manualId && l.stepNo === st.stepNo)).length;
    if (done < steps.length) tasks.push({ id: `manual:${m.manualId}`, messageKey: 'data.management.alert.checklist', params: { done, total: steps.length }, ref: { featureId: 'manuals', itemId: m.manualId } });
  }
  for (const n of t.grantNotice) if (dateOf(n.applyEnd) >= q.date && dateOf(n.applyEnd) <= addDays(q.date, 7) && n.applyStart <= `${q.date}T${BUSINESS_CLOCK.time}` && !t.grantApplication.some((a) => a.noticeId === n.noticeId) && !t.grantReview.some((r) => r.noticeId === n.noticeId && r.reviewStatus === 'reviewed')) tasks.push({ id: `grant:${n.noticeId}`, messageKey: 'data.management.alert.grant', ref: { featureId: 'grants', itemId: n.noticeId } });
  for (const c of selectCameras(s, q.viewContext ?? {})) if (c.connection === 'disconnected') tasks.push({ id: `camera:${c.cameraId}`, messageKey: 'data.management.alert.camera', ref: { featureId: 'customer-analysis', itemId: c.cameraId } });
  const groups: AlertGroup[] = [
    { id: 'purchasing', items: purchasing, ref: { featureId: 'suppliers' } }, { id: 'stock', items: stockItems, ref: { featureId: 'inventory-booking' } }, { id: 'tax', items: tax, ref: { featureId: 'tax' } }, { id: 'tasks', items: tasks, ref: { featureId: 'manuals' } },
  ].filter((g) => g.items.length > 0) as AlertGroup[];
  const received = q.viewContext?.partial ? groups.filter((g) => g.id !== 'tax') : groups;
  return { custom, staff: selectStaffSchedule(s, { startDate: q.date, endDate: q.date }), schedules: calendar, reservations: { ...selectReservations(s, { date: q.date, variant: q.viewContext?.reservationVariant }), completedCount: s.tables.reservation.filter(row => row.kind !== 'pickup' && row.date === q.date && row.status === 'completed').length }, importantAlerts: { count: received.reduce((sum, group) => sum + group.items.length, 0), groups: received }, closingSummary: { ...selectClosing(s, { date: q.date, scenario: 'normal' }), drawer: pos?.drawer ?? null }, tomorrowReservations: selectReservations(s, { date: addDays(q.date, 1) }) };
});

export function selectPosBriefing(read: PosReadSnapshot) {
  const summary = selectOrderSummary(read);
  const source = read.data.source as DataSnapshot | undefined;
  const closing = source?.tables ? selectClosing(source, { date: read.pos.businessDate, scenario: 'normal' }) : null;
  const drawer = closing?.status === 'closed' && closing.drawerSnapshot ? closing.drawerSnapshot : selectM2Drawer(read.pos);
  return { missingCount: summary.missingCount, missing: summary.openList.find(row => row.isMissing) ?? null, drawer };
}
