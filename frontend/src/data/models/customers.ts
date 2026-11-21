import { deriveStock } from '../derive/stock';
import { selectReservations } from '../derive/reservations';
import { selectCameras } from '../derive/operations';
import { membershipActive } from '../derive/members';
import type { DataTables, DemandBand } from '../db/types';
import { addDays, daysBetween, dateOf, dateRange, inRange, MONTH_START, LEGACY_BOOKING_VIEW_TIME, TODAY, TOMORROW, WEEK_END, WEEK_START } from '../db/time';
import type { CctvHourRow, DemandDayRow, DemandHourRow, DemandModel, MembershipRow, MembershipsModel, ReservationRow, VoiceBookingModel } from './types';
import { note, ready, sum, type Projector } from './util';
import { belowPercent, QUIET_THRESHOLD_PERCENT, roundPercent } from '../marketing/calc';
import { staffCountAt } from '../iteration7/staff/selectors';

/** Roster staff working at the start of the given hour. */
export const staffAt = staffCountAt;

/* CCTV 손님분석 */
export const projectCustomerAnalysis: Projector<'customer-analysis'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const noShifts = variant === 'no-shifts';
  const hours: CctvHourRow[] = t.cctvHourly.filter((r) => r.businessDate === TODAY).sort((a, b) => a.hour - b.hour).map((r) => {
    let visits = r.entries, status = r.status;
    if (variant === 'no-entries') visits = 0;
    if ((variant === 'gaps' || variant === 'camera-disconnected') && r.hour === 12) { visits = null; status = 'none'; }
    if (variant === 'gaps' && r.hour === 13) { visits = 9; status = 'partial'; }
    return { hour: r.hour, visits, status, staff: noShifts ? null : staffAt(t, TODAY, r.hour), reviewMarked: r.reviewMarked };
  });
  const counted = hours.filter((h) => h.visits !== null && h.status === 'ok');
  const peak = counted.reduce<CctvHourRow | null>((best, h) => ((h.visits ?? 0) > (best?.visits ?? 0) ? h : best), null);
  const past = dateRange(addDays(TODAY, -7), addDays(TODAY, -1)).map((date) => ({ date, visits: sum(t.cctvHourly.filter((r) => r.businessDate === date).map((r) => r.entries ?? 0)) }));
  const totalVisits = sum(hours.map((h) => h.visits ?? 0));
  return ready('customer-analysis', condition, variant, {
    cameras: selectCameras(ctx.snapshot, { cameraDisconnected: variant === 'camera-disconnected' }),
    date: TODAY,
    coverage: { startHour: hours[0]?.hour ?? 10, endHour: (hours[hours.length - 1]?.hour ?? 14) + 1 },
    totalVisits, hours, peak, gapHours: hours.filter((h) => h.status !== 'ok').map((h) => h.hour),
    trend: [...past, { date: TODAY, visits: totalVisits }], staffSourceKey: noShifts ? null : 'data.source.roster',
  }, variant === 'gaps' ? [note('customer-analysis', 'gaps')] : noShifts ? [note('customer-analysis', 'no-shifts')] : undefined);
};

/* 손님예측 */
const BANDS: readonly DemandBand[] = ['morning', 'afternoon', 'evening'];
const bandOf = (hour: number): DemandBand => (hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening');
/** plan-2 (T-058): 1-hour expected vs same weekday/hour average, with the ‘평소의 60% 미만’ flag (AC-316). */
const hourlyOf = (t: DataTables, date: string): DemandHourRow[] => t.demandHourly.filter((r) => r.targetDate === date).sort((a, b) => a.hour - b.hour).map((r) => ({
  hour: r.hour, band: bandOf(r.hour), expected: r.expected, average: r.average,
  percent: r.average > 0 ? roundPercent((r.expected / r.average) * 100) : 0, belowUsual: belowPercent(r.expected, r.average, QUIET_THRESHOLD_PERCENT),
}));
function demandDay(t: DataTables, date: string): DemandDayRow {
  const rows = BANDS.map((band) => t.demandForecast.find((r) => r.targetDate === date && r.band === band));
  const meta = t.demandDay.find((d) => d.targetDate === date);
  const expected = sum(rows.map((r) => r?.expected ?? 0));
  const lastWeekDate = addDays(date, -7);
  const actual = t.demandActual.find((a) => a.date === lastWeekDate);
  return {
    date, expected,
    bands: BANDS.map((band, i) => ({ band, bandKey: `data.band.${band}`, expected: rows[i]?.expected ?? 0 })),
    busy: { startHour: meta?.busyStart ?? 13, endHour: meta?.busyEnd ?? 15 },
    basis: { baseline: sum(rows.map((r) => r?.baseline ?? 0)), weather: sum(rows.map((r) => r?.adjWeather ?? 0)), event: sum(rows.map((r) => r?.adjEvent ?? 0)), weatherKey: meta?.weatherKey ?? 'data.weather.clear', eventKey: meta?.eventKey ?? null },
    lastWeek: actual ? { date: lastWeekDate, actual: actual.total, delta: { value: expected - actual.total, kind: 'count', unit: 'person' } } : null,
    hourly: hourlyOf(t, date),
  };
}

export const projectDemand: Projector<'demand'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const week = condition.kind === 'dateRange';
  const day = demandDay(t, TOMORROW);
  const suggestions: DemandModel['suggestions'][number][] = [];
  if (day.expected > day.basis.baseline) {
    const restock = deriveStock(ctx.snapshot, { date: TODAY }).restockCount;
    if (restock > 0) suggestions.push({ targetFeatureId: 'inventory-booking', messageKey: 'data.demand.prep.restock', params: { count: restock } });

  }
  const model: DemandModel = {
    view: week ? 'week' : 'day', day,
    days: week ? dateRange(WEEK_START, WEEK_END).map((d) => demandDay(t, d)) : [day],
    suggestions,
    history: t.demandActual.map((a) => ({ date: a.date, forecast: sum(t.demandForecast.filter((r) => r.targetDate === a.date).map((r) => r.expected)), actual: a.total })),
    basisKey: 'data.demand.basis',
    hourly: [...new Set(t.demandHourly.map((r) => r.targetDate))].sort().map((date) => ({ date, hours: hourlyOf(t, date) })),
    quietThresholdPercent: QUIET_THRESHOLD_PERCENT,
  };
  return ready('demand', condition, variant, model);
};

/* 회원권 */
const isActive = (t: DataTables, m: DataTables['membership'][number]): boolean => {
  return membershipActive({ revision: 0, seq: 0, tables: t }, m.membershipId);
};
export const projectMemberships: Projector<'memberships'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const liveUses = t.membershipUse.filter((u) => u.canceledAt === null);
  const row = (m: DataTables['membership'][number]): MembershipRow => {
    const product = t.membershipProduct.find((p) => p.productId === m.productId);
    const kind = product?.kind ?? 'count';
    const own = liveUses.filter((u) => u.membershipId === m.membershipId).map((u) => u.usedAt).sort();
    const usedToday = own.some((u) => dateOf(u) === TODAY);
    const active = isActive(t, m);
    return {
      membershipId: m.membershipId, customerKey: m.customerKey, productId: m.productId, productNameKey: product?.nameKey ?? '', kind, startsOn: m.startsOn, endsOn: m.endsOn, usesLeft: m.usesLeft,
      lastUsedAt: own[own.length - 1] ?? null, endingThisWeek: active && inRange(m.endsOn, WEEK_START, WEEK_END), endingSoon: active && daysBetween(TODAY, m.endsOn) <= 7,
      canUse: active && (kind === 'count' ? (m.usesLeft ?? 0) >= 1 : !(product?.dailyLimit && usedToday)),
    };
  };
  const memberships = t.membership.filter((m) => isActive(t, m)).sort((a, b) => a.endsOn.localeCompare(b.endsOn) || a.membershipId.localeCompare(b.membershipId)).map(row);
  const endingThisWeek = memberships.filter((m) => m.endingThisWeek);
  const sold = t.membership.filter((m) => inRange(m.startsOn, MONTH_START, TODAY));
  const model: MembershipsModel = {
    activeCount: memberships.length,
    byProduct: t.membershipProduct.map((p) => ({ productId: p.productId, nameKey: p.nameKey, kind: p.kind, uses: p.uses, validDays: p.validDays, dailyLimit: p.dailyLimit, price: p.price, activeCount: memberships.filter((m) => m.productId === p.productId).length })),
    endingThisWeekCount: endingThisWeek.length, endingThisWeek, endingSoon: memberships.filter((m) => m.endingSoon), memberships,
    uses: [...t.membershipUse].sort((a, b) => b.usedAt.localeCompare(a.usedAt) || b.useId.localeCompare(a.useId)).map((u) => {
      const m = t.membership.find((x) => x.membershipId === u.membershipId);
      return { useId: u.useId, membershipId: u.membershipId, customerKey: m?.customerKey ?? '', productNameKey: t.membershipProduct.find((p) => p.productId === m?.productId)?.nameKey ?? '', usedAt: u.usedAt, canceledAt: u.canceledAt, cancelable: u.canceledAt === null && dateOf(u.usedAt) === TODAY };
    }),
    month: { sold: sold.length, soldAmount: sum(sold.map((m) => t.membershipProduct.find((p) => p.productId === m.productId)?.price ?? 0)), used: liveUses.filter((u) => inRange(dateOf(u.usedAt), MONTH_START, TODAY)).length },
  };
  return ready('memberships', condition, variant, model);
};

/* 음성 예약확정 */
const counts = (status: string): boolean => status !== 'canceled' && status !== 'proposed';
export const projectVoiceBooking: Projector<'voice-booking'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const selectedDate = condition.kind === 'dateRange' ? condition.start : condition.kind === 'snapshot' ? condition.asOf : TODAY;
  const selected = selectReservations(ctx.snapshot, { date: selectedDate, variant });
  const seats = selected.totalSeats;
  const visible = <R extends { readonly variant: string | null }>(r: R) => r.variant === null || r.variant === variant;
  const rows = selected.rows;
  const live = rows.filter((r) => counts(r.status));
  const times = [...new Set(live.map((r) => r.time))];
  const slots = times.map((time) => {
    const own = live.filter((r) => r.time === time);
    const people = sum(own.map((r) => r.partySize));
    return { time, count: own.length, people, seatsFree: seats - people };
  });
  const reservations: ReservationRow[] = rows.map((r) => ({
    reservationId: r.reservationId, date: r.date, time: r.time, partySize: r.partySize, nameKey: r.nameKey, requestKey: r.requestKey, source: r.source, status: r.status, confirmedBy: r.confirmedBy, callId: r.callId, proposedTime: r.proposedTime,
    overSeats: counts(r.status) && (slots.find((s) => s.time === r.time)?.people ?? 0) > seats, counts: counts(r.status),
    canConfirm: r.status === 'needs-check', canPropose: r.status === 'needs-check', canMarkNoShow: r.status === 'confirmed' && r.time < LEGACY_BOOKING_VIEW_TIME,
  }));
  const model: VoiceBookingModel = {
    ...selected, pickupCount:ctx.snapshot.tables.reservation.filter(r=>r.kind==='pickup' && r.date===selectedDate && r.status==='confirmed').length, tomorrowPickupCount:ctx.snapshot.tables.reservation.filter(r=>r.kind==='pickup' && r.date===addDays(selectedDate,1) && r.status==='confirmed').length, date: selectedDate, todayCount: live.length, needsCheckCount: rows.filter((r) => r.status === 'needs-check').length, seats, slots, reservations,
    calls: t.callLog.filter(visible).sort((a, b) => a.time.localeCompare(b.time)).map((c) => ({ callId: c.callId, time: c.time, summary: c.summary, extracted: c.extracted, reservationId: t.reservation.find((r) => r.kind !== 'pickup' && r.callId === c.callId)?.reservationId ?? null })),
    connected: t.integration.phone,
  };
  return ready('voice-booking', condition, variant, model);
};
