/**
 * Shared marketing derivations used by the projectors and the commands, so every surface reads the
 * same coupon source and the same customer groups (ARCHITECTURE 11.13.4). Pure functions of the tables.
 */
import { addDays, dateOf, daysBetween, inRange, TODAY, TOMORROW, weekdayOf } from '../db/time';
import type { DataText } from '../db/types';
import { maskCustomer } from '../derive/members';
import type { Period } from '../models/types';
import { ENDING_SOON_DAYS } from './calc';
import { PROMO_REFERENCE_IDS } from '../../../shared/promo-references.mjs';
import type {
  Coupon, CouponCode, CouponRoute, CouponRow, CustomerGroupId, MarketingTables, MktCustomer, MktVisit, PromoLocale, PromoReferenceId, PromoVideo, SegmentRule, VideoConcept, VideoMood,
} from './types';

/* 고정 기본값 (DATA_MODEL 10.15.2, PRD 2.4.10, Q-41) */
export const ROUTES: readonly CouponRoute[] = ['place_news', 'blog', 'clip', 'sms'];
const ROUTE_KEY: Readonly<Record<CouponRoute, string>> = { place_news: 'placeNews', blog: 'blog', clip: 'clip', sms: 'sms' };
const ROUTE_CODE: Readonly<Record<CouponRoute, string>> = { place_news: 'PN', blog: 'BL', clip: 'CL', sms: 'SM' };
export const routeNameKey = (route: CouponRoute): string => `data.marketing.route.${ROUTE_KEY[route]}`;
export const newCode = (route: CouponRoute, seq: string): string => `${ROUTE_CODE[route]}-${seq.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
/** The slot window (DATA_MODEL 10.15.1): tomorrow and the six days after it. It is not a calendar week, so labels say the dates or ‘내일부터 7일’. */
export const SLOT_WINDOW: Period = { start: TOMORROW, end: addDays(TOMORROW, 6) };
/** Slot coupons expire six days after the quiet-hours window closes (Q-41). */
export const SLOT_COUPON_ENDS = addDays(SLOT_WINDOW.end, 6);
/** Reach-out coupons last 14 days (기본값, not documented elsewhere). */
export const GROUP_COUPON_DAYS = 14;
export const SLOT_MENU_ID = 'm-cafe-latte';
export const SHOT_OPTION_ID = 'opt-extra-shot';
export const DEFAULT_VIDEO_COUPON = 'c-tue-shot';
const DEFAULT_RULE: SegmentRule = { businessType: 'cafe', regularVisits: 4, regularDays: 28, churnGapDays: 14 };
/** Numbers follow the café rule whatever the business type (PRD 2.4.10 F-52 기본값). */
export const ruleOf = (m: MarketingTables): SegmentRule => m.segmentRule.find((r) => r.businessType === 'cafe') ?? DEFAULT_RULE;

/**
 * The one display alias of a customer. 손님 그룹, 빈 시간 쿠폰 and the 회원 views all join on `customerId`, and the 회원 views
 * show `maskCustomer` (masked real name, or the sample alias key when the customer has no name), so every marketing row reads it too.
 */
export function customerAlias(customer: MktCustomer): DataText {
  const { name } = maskCustomer(customer);
  return typeof name === 'string' ? { raw: name } : name;
}

/** Customers visible in a sample state: normal rows plus that variant's own rows. */
export const customersOf = (m: MarketingTables, variant: string): MktCustomer[] => m.mktCustomer.filter((c) => !c.deletedAt && (c.variant === null || c.variant === variant));
function visitsByCustomer(m: MarketingTables): Map<string, MktVisit[]> {
  const out = new Map<string, MktVisit[]>();
  for (const v of m.mktVisit) if (!(out.get(v.customerId) ?? []).some((x) => x.businessDate === v.businessDate)) out.set(v.customerId, [...(out.get(v.customerId) ?? []), v]);
  for (const list of out.values()) list.sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  return out;
}

export interface Segment {
  readonly customer: MktCustomer;
  readonly visitCount: number;
  readonly recentVisits: number;
  readonly lastVisit: string;
  readonly daysSinceLast: number;
  readonly usualCycleDays: number | null;
  readonly group: CustomerGroupId | null;
}
/**
 * Card-based groups (F-52, cafe): first visit = 1 visit; regular = ≥ 4 visits in the last 28 days;
 * may leave = usual cycle + 14 days passed. Checked in that order so the groups never overlap.
 */
export function segments(m: MarketingTables, variant = 'normal'): Segment[] {
  const rule = ruleOf(m);
  const visits = visitsByCustomer(m);
  const recentFrom = addDays(TODAY, -(rule.regularDays - 1));
  const out: Segment[] = [];
  for (const customer of customersOf(m, variant)) {
    const own = visits.get(customer.customerId) ?? [];
    if (own.length === 0) continue;
    const first = own[0].businessDate, last = own[own.length - 1].businessDate;
    const usualCycleDays = own.length >= 2 ? Math.round(daysBetween(first, last) / (own.length - 1)) : null;
    const recentVisits = own.filter((v) => inRange(v.businessDate, recentFrom, TODAY)).length;
    const daysSinceLast = daysBetween(last, TODAY);
    const group: CustomerGroupId | null = own.length === 1 ? 'first-visit'
      : recentVisits >= rule.regularVisits ? 'regular'
        : usualCycleDays !== null && daysSinceLast > usualCycleDays + rule.churnGapDays ? 'churn-risk' : null;
    out.push({ customer, visitCount: own.length, recentVisits, lastVisit: last, daysSinceLast, usualCycleDays, group });
  }
  return out;
}
/** Q-264: only automatic regulars follow POS visits; other marketing cohorts retain their baseline. */
export function marketingCohorts(m: MarketingTables, variant = 'normal'): Segment[] {
  const baseline = { ...m, mktVisit: m.mktVisit.filter(v => !v.posContribution) };
  const stable = segments(baseline, variant).filter(s => s.group !== 'regular');
  const regular = segments(m, variant).filter(s => s.group === 'regular');
  return [...stable, ...regular];
}
/** Regulars with marketing consent: the audience of a sell-today text (24). */
export const consentingRegulars = (m: MarketingTables): Segment[] => segments(m).filter((s) => s.group === 'regular' && s.customer.consentSms);

/**
 * Who an ending-soon reminder reaches: the customers the coupon was texted to (its target rows) who are still known and still consent.
 * The reminder form and the `coupon.notifyEnding` command both read this one list, so the count shown is the count sent; an empty list blocks the reminder.
 */
export function reminderAudience(m: MarketingTables, couponId: string): string[] {
  const reachable = new Set(m.mktCustomer.filter((c) => !c.deletedAt && c.consentSms).map((c) => c.customerId));
  const audience = new Set<string>();
  for (const target of m.couponTarget) if (target.couponId === couponId && reachable.has(target.customerId)) audience.add(target.customerId);
  return [...audience];
}

/** Customers who came ≥ 2 times on this weekday within these hours in the last 4 weeks (consent not checked here). */
export function slotVisitors(m: MarketingTables, slot: { readonly weekday: number; readonly startHour: number; readonly endHour: number }, variant: string): { customer: MktCustomer; lastVisit: string }[] {
  const recentFrom = addDays(TODAY, -(ruleOf(m).regularDays - 1));
  const baseline = m.mktVisit.filter(v => !v.posContribution);
  const sample = variant === 'consent-mixed' ? m.slotConsentSampleVisits ?? [] : [];
  const visits = visitsByCustomer({ ...m, mktVisit: [...baseline, ...sample] });
  return customersOf(m, variant).flatMap((customer) => {
    const hits = (visits.get(customer.customerId) ?? []).filter((v) => inRange(v.businessDate, recentFrom, TODAY) && weekdayOf(v.businessDate) === slot.weekday && v.hour >= slot.startHour && v.hour < slot.endHour);
    return hits.length >= 2 ? [{ customer, lastVisit: hits[hits.length - 1].businessDate }] : [];
  });
}

/* 쿠폰 원본 → 줄 */
const usedOf = (m: MarketingTables, codeId: string): number => m.couponRedemptionAgg.find((a) => a.codeId === codeId)?.used ?? 0;
export const isActiveCode = (c: CouponCode): boolean => c.activatedAt !== null;
export const isEndedCoupon = (c: Coupon): boolean => c.status === 'ended' || c.endsOn < TODAY;
export function couponRow(m: MarketingTables, coupon: Coupon, missingUsage = false, usage = usedOf): CouponRow {
  const codes = m.couponCode.filter((c) => c.couponId === coupon.couponId);
  const active = codes.filter(isActiveCode);
  const daysLeft = daysBetween(TODAY, coupon.endsOn);
  const ended = isEndedCoupon(coupon);
  return {
    couponId: coupon.couponId, name: coupon.name, status: ended ? 'ended' : coupon.status, origin: coupon.origin, benefitType: coupon.benefitType, benefitValue: coupon.benefitValue,
    startsOn: coupon.startsOn, endsOn: coupon.endsOn, daysLeft, endingSoon: !ended && coupon.status === 'active' && daysLeft >= 0 && daysLeft <= ENDING_SOON_DAYS,
    issued: active.reduce((s, c) => s + c.issueCount, 0),
    used: missingUsage ? null : active.reduce((s, c) => s + usage(m, c.codeId), 0),
    routes: codes.map((c) => ({ codeId: c.codeId, code: c.code, route: c.route, routeNameKey: routeNameKey(c.route), issued: c.issueCount, used: usage(m, c.codeId), active: isActiveCode(c), videoId: c.videoId })),
    reminderRecipients: reminderAudience(m, coupon.couponId).length,
    canNotify: !ended && coupon.status === 'active', canPause: !ended && coupon.status === 'active', canResume: !ended && coupon.status === 'paused', canExtend: !ended,
  };
}
export const codeUsed = usedOf;
export const createdToday = (c: Coupon): boolean => dateOf(c.createdAt) === TODAY;

/* 영상 분위기·컨셉 (PRD 목록 유지; 템플릿·장면 표는 D-80으로 삭제, 영상은 서버가 만든다) */
export const MOODS: readonly VideoMood[] = ['warm', 'clean', 'lively', 'elegant'];
export const CONCEPTS: readonly VideoConcept[] = ['review-roundup', 'behind-the-scenes', 'todays-deal', 'new-item', 'day-at-shop'];
export const REFERENCE_IDS: readonly PromoReferenceId[] = PROMO_REFERENCE_IDS;
export const LENGTHS: readonly (10 | 15 | 30)[] = [10, 15, 30];
export const LOCALES: readonly PromoLocale[] = ['ko', 'en', 'zh-Hans', 'zh-Hant'];
export const videoCode = (m: MarketingTables, v: PromoVideo): CouponCode | undefined => m.couponCode.find((c) => c.videoId === v.videoId);
