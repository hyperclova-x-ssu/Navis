import manifest from '../db/generated/manifest.json';
import type { DataTables, Reservation } from '../db/types';
import type { ShopSettings } from '../db/management-types';
import { isIsoDate, isTime } from '../db/time';
import { maskCustomer } from './members';
import { memoSelector, requireDate } from './common';
import { BUSINESS_CLOCK, slotHasPassed, slotIsLater } from '../commands/business-clock';
import type { PosReservationRead } from '../../contracts/pos';
import { canonical, freezePos } from '../../pos/domain/common';

/** The reservation view's "now" is the business clock (15:45), the same as the POS scenario clock. */
export const BUSINESS_TIME = BUSINESS_CLOCK.time;
export const tableLayoutEnabled = (settings: Pick<ShopSettings, 'businessType' | 'paymentStyle' | 'tableLayout'>): boolean => settings.paymentStyle === 'postpaid' && ['cafe', 'restaurant', 'pub'].includes(settings.businessType ?? '') && !!settings.tableLayout;
export const reservationCounts = (status: string) => status !== 'canceled' && status !== 'proposed';
const occupies = (r: Pick<Reservation, 'status' | 'tableId'>) => ['confirmed', 'completed', 'no-show'].includes(r.status) && !!r.tableId;
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const overlaps = (a: string, b: string) => minutes(a) < minutes(b) + 120 && minutes(b) < minutes(a) + 120;
export function allocateReservation(t: DataTables, candidate: Reservation, choice: 'auto' | { readonly tableId: string }): { tableId: string | null; allocationWarning?: string; status: 'confirmed' | 'needs-check' } {
  const others = t.reservation.filter((r): r is Reservation => r.kind !== 'pickup').filter((r) => r.reservationId !== candidate.reservationId && r.date === candidate.date && !r.variant);
  if (tableLayoutEnabled(t.shopSettings)) {
    const tables = [...(t.shopSettings.tableLayout?.tables ?? [])].sort((a, b) => a.seats - b.seats || a.number - b.number);
    const valid = tables.filter((table) => table.seats >= candidate.partySize && !others.some((r) => occupies(r) && r.tableId === table.tableId && overlaps(r.time, candidate.time)));
    const found = choice === 'auto' ? valid[0] : valid.find((t) => t.tableId === choice.tableId);
    return found ? { tableId: found.tableId, status: 'confirmed' } : { tableId: null, status: 'needs-check', allocationWarning: 'NO_MATCHING_TABLE' };
  }
  const party = others.filter((r) => reservationCounts(r.status) && r.time === candidate.time).reduce((n, r) => n + r.partySize, candidate.partySize);
  return party <= manifest.store.seats ? { tableId: null, status: 'confirmed' } : { tableId: null, status: 'needs-check', allocationWarning: 'SEAT_LIMIT' };
}
/** First enable assigns only confirmed unassigned rows; later edits retain IDs and validate. */
export function revalidateReservations(t: DataTables, firstActivation: boolean): DataTables['reservation'] {
  if (!tableLayoutEnabled(t.shopSettings)) return t.reservation;
  let next = t.reservation;
  for (const r of [...next].filter((r): r is Reservation => r.kind !== 'pickup').filter((r) => !r.variant).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.reservationId.localeCompare(b.reservationId))) {
    if (!['confirmed', 'completed', 'no-show'].includes(r.status)) continue;
    if (firstActivation && r.status === 'confirmed' && !r.tableId) {
      const allocation = allocateReservation({ ...t, reservation: next }, r, 'auto');
      next = next.map((x) => x.reservationId === r.reservationId ? { ...x, tableId: allocation.tableId, allocationWarning: allocation.allocationWarning } : x);
    } else if (r.tableId) {
      const allocation = allocateReservation({ ...t, reservation: next }, r, { tableId: r.tableId });
      next = next.map((x) => x.reservationId === r.reservationId ? { ...x, allocationWarning: allocation.allocationWarning } : x);
    }
  }
  return next;
}
export const selectReservations = memoSelector((q: { readonly date: string; readonly variant?: string }) => `${q.date}:${q.variant ?? 'normal'}`, (s, q) => {
  requireDate(q.date);
  const t = s.tables;
  const rows = t.reservation.filter((r): r is Reservation => r.kind !== 'pickup').filter((r) => r.date === q.date && (!r.variant || r.variant === q.variant)).sort((a, b) => a.time.localeCompare(b.time) || a.reservationId.localeCompare(b.reservationId)).map((r) => {
    const member = t.memberProfile.find((m) => m.memberId === r.memberId);
    const customer = t.marketing.mktCustomer.find((c) => c.customerId === member?.customerId);
    return { ...r, name: r.guestName ?? (customer ? maskCustomer(customer).name : { key: r.nameKey }), phone: r.phone ?? (customer ? { raw: maskCustomer(customer).phone } : null), counts: reservationCounts(r.status), canConfirm: r.status === 'needs-check', canPropose: r.status === 'needs-check', canMarkNoShow: r.status === 'confirmed' && slotHasPassed(r.date, r.time), canMarkCompleted: r.status === 'confirmed' && slotHasPassed(r.date, r.time) };
  });
  const live = rows.filter((r) => r.counts);
  const timeGroups = [...new Set(live.map((r) => r.time))].sort().map((time) => ({ time, count: live.filter((r) => r.time === time).length, partyTotal: live.filter((r) => r.time === time).reduce((n, r) => n + r.partySize, 0) }));
  const at = timeGroups.find((g) => slotIsLater(q.date, g.time))?.time ?? null;
  const enabled = tableLayoutEnabled(t.shopSettings);
  const occupied = new Set(rows.filter((r) => at && occupies(r) && overlaps(r.time, at) && !r.allocationWarning).map((r) => r.tableId));
  const tables = t.shopSettings.tableLayout?.tables ?? [];
  const availability = enabled ? { at, kind: 'tables' as const, value: tables.filter((table) => !occupied.has(table.tableId)).length } : { at, kind: 'seats' as const, value: Math.max(0, manifest.store.seats - (at ? timeGroups.find((g) => g.time === at)?.partyTotal ?? 0 : 0)) };
  return { date: q.date, rows, count: live.length, partyTotal: live.reduce((n, r) => n + r.partySize, 0), needsCheckCount: rows.filter((r) => r.status === 'needs-check').length, changes: t.reservationChange.filter((c) => c.at.startsWith(q.date)).length, timeGroups, availability, tableLayoutEnabled: enabled, totalSeats: enabled ? tables.reduce((n, t) => n + t.seats, 0) : manifest.store.seats };
});
export const deriveReservations = selectReservations;
export const validReservationDate = (date: string, time: string) => isIsoDate(date) && isTime(time);

/** POS and the reservation view share one business clock (15:45); see commands/business-clock.ts. */
export const selectPosReservations = memoSelector(() => 'pos', (snapshot): readonly PosReservationRead[] => freezePos(snapshot.tables.reservation.filter((r):r is Reservation=>r.kind!=='pickup').filter(r => !r.variant).map(r => {
  const member = snapshot.tables.memberProfile.find(m => m.memberId === r.memberId);
  const customer = snapshot.tables.marketing.mktCustomer.find(c => c.customerId === member?.customerId);
  const name = r.guestName ?? (customer ? maskCustomer(customer).name : { key: r.nameKey });
  return { reservationId: r.reservationId, date: r.date, time: r.time, partySize: r.partySize, tableId: r.tableId ?? null,
    status: r.status, ...(r.memberId ? { memberId: r.memberId } : {}), name: typeof name === 'string' ? name : 'raw' in name ? name.raw : name,
    ...(r.allocationWarning ? { allocationWarning: r.allocationWarning } : {}), fingerprint: canonical(r), completedFingerprint: canonical({ ...r, status: 'completed' }) };
})));
