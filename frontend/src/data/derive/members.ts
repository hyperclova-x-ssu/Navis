import type { DataSnapshot, DataText } from '../db/types';
import type { MemberGrade } from '../db/management-types';
import { addDays, dateOf, TODAY, WEEK_END, WEEK_START } from '../db/time';
import { memoSelector } from './common';

export function maskCustomer(customer: { readonly name?: string; readonly phone?: string; readonly maskedName?: string; readonly phoneLast4?: string; readonly maskKey: string }): { name: string | DataText; phone: string } {
  const letters = [...(customer.name ?? '')];
  const name = !letters.length ? { key: customer.maskKey } : letters.length <= 2 ? `${letters[0]}○` : `${letters[0]}${'○'.repeat(letters.length - 2)}${letters.at(-1)}`;
  const phone = customer.phone ? `${customer.phone.startsWith('02') ? customer.phone.slice(0, 2) : customer.phone.slice(0, 3)}-****-${customer.phone.slice(-4)}` : '';
  return { name: letters.length ? name : customer.maskedName ?? name, phone: phone || (customer.phoneLast4 ? `010-****-${customer.phoneLast4}` : '') };
}
export function membershipActive(s: DataSnapshot, membershipId: string): boolean {
  const m = s.tables.membership.find((m) => m.membershipId === membershipId);
  if (!m) return false;
  const customer = s.tables.marketing.mktCustomer.find((c) => c.customerId === m.customerId);
  const product = s.tables.membershipProduct.find((p) => p.productId === m.productId);
  return (!m.customerId || !!customer && !customer.deletedAt && s.tables.memberProfile.some((p) => p.customerId === m.customerId)) && m.status === 'active' && m.endsOn >= TODAY && (product?.kind === 'period' || (m.usesLeft ?? 0) > 0);
}
function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string | undefined): Map<string | undefined, T[]> {
  const groups = new Map<string | undefined, T[]>();
  for (const row of rows) { const key = keyOf(row), own = groups.get(key); if (own) own.push(row); else groups.set(key, [row]); }
  return groups;
}
/** Join once per snapshot; filtering and sorting never repeat the 126-customer joins. */
const memberBase = memoSelector(() => 'members', (s) => {
  const t = s.tables, gradeCounts = { regular: 0, frequent: 0, occasional: 0, inactive: 0 };
  const customers = new Map(t.marketing.mktCustomer.map((c) => [c.customerId, c]));
  const visitsByCustomer = groupBy(t.marketing.mktVisit, (v) => v.customerId);
  const membershipsByCustomer = groupBy(t.membership, (m) => m.customerId);
  const reservationsByMember = groupBy(t.reservation.filter((r):r is import('../db/types').Reservation=>r.kind!=='pickup').filter((r) => !r.variant), (r) => r.memberId);
  const notesByMember = groupBy(t.memberNote, (n) => n.memberId);
  const targetsByCustomer = groupBy(t.marketing.couponTarget, (c) => c.customerId);
  const coupons = new Map(t.marketing.coupon.map((c) => [c.couponId, c]));
  const products = new Map(t.membershipProduct.map((p) => [p.productId, p]));
  const uses = groupBy(t.membershipUse, (u) => u.membershipId);
  const sends = groupBy(t.marketing.messageSend, (send) => send.sendId);
  const from = addDays(TODAY, -27);
  const rows = t.memberProfile.flatMap((p) => {
    const c = customers.get(p.customerId);
    if (!c || c.deletedAt || c.variant !== null) return [];
    const visits = [...new Set((visitsByCustomer.get(c.customerId) ?? []).filter((v) => v.businessDate <= TODAY).map((v) => v.businessDate))].sort();
    const recentVisits = visits.filter((d) => d >= from).length;
    const automaticGrade: MemberGrade = recentVisits >= 4 ? 'regular' : recentVisits >= 2 ? 'frequent' : recentVisits || !visits.length ? 'occasional' : 'inactive';
    const grade = p.gradeOverride ?? automaticGrade;
    const paidBills = new Set(s.pos?.bills.filter(b => b.status === 'paid' && (b.memberId === p.memberId || b.discounts.some(d => d.contributionMemberId === p.memberId))).map(b => b.billId) ?? []);
    const lastPayment = s.pos?.payments.filter(payment => payment.status === 'paid' && payment.recognizedAt && paidBills.has(payment.billId)).sort((a, b) => b.seq - a.seq)[0] ?? null;
    gradeCounts[grade]++;
    const memberships = (membershipsByCustomer.get(c.customerId) ?? []).map((m) => {
      const product = products.get(m.productId);
      return { ...m, active: m.status === 'active' && m.endsOn >= TODAY && (product?.kind === 'period' || (m.usesLeft ?? 0) > 0), product, uses: uses.get(m.membershipId) ?? [], endingThisWeek: m.endsOn >= WEEK_START && m.endsOn <= WEEK_END };
    });
    return [{ ...p, ...maskCustomer(c), consentSms: c.consentSms, automaticGrade, grade, manuallyGraded: p.gradeOverride !== null, recentVisits, visitCount: visits.length, lastVisit: visits.at(-1) ?? null, lastPayment, visits, memberships,
      reservations: reservationsByMember.get(p.memberId) ?? [], coupons: (targetsByCustomer.get(c.customerId) ?? []).map((target) => ({ ...target, coupon: coupons.get(target.couponId), sends: sends.get(target.sendId) ?? [] })), notes: notesByMember.get(p.memberId) ?? [], couponRef: { featureId: 'customer-groups' as const, itemId: c.customerId, focus: 'action' as const } }];
  }).sort((a, b) => (a.memberCode ?? a.memberId).localeCompare(b.memberCode ?? b.memberId));
  return { rows, total: rows.length, gradeCounts, membershipCount: rows.reduce((n, r) => n + r.memberships.filter((m) => m.active).length, 0), endingThisWeekCount: rows.reduce((n, r) => n + r.memberships.filter((m) => m.active && m.endingThisWeek).length, 0) };
});
export const selectMembers = memoSelector((q: { readonly query?: string; readonly grade?: MemberGrade }) => JSON.stringify(q), (s, q) => {
  const base = memberBase(s, undefined);
  const query = q.query?.trim().toLocaleLowerCase() ?? '';
  if (!query && !q.grade) return base;
  const customers = new Map(s.tables.marketing.mktCustomer.map((c) => [c.customerId, c]));
  return { ...base, rows: base.rows.filter((r) => {
    const c = customers.get(r.customerId)!;
    return (!q.grade || r.grade === q.grade) && (!query || (c.name ?? c.maskedName ?? '').toLocaleLowerCase().includes(query) || (c.phone ?? c.phoneLast4 ?? '').slice(-4).includes(query) || (r.memberCode ?? '').toLowerCase().includes(query));
  }) };
});
export const activeMember = (s: DataSnapshot, memberId: string) => s.tables.memberProfile.find((m) => m.memberId === memberId && s.tables.marketing.mktCustomer.some((c) => c.customerId === m.customerId && !c.deletedAt));
export const cancelableUse = (at: string) => dateOf(at) === TODAY;
