import { seedCatalog, seedHistory, seedMembers, seedOperations, seedSupplement, seedToday } from '../db/cafe-fixtures';
import { inRange, LAST_MONTH_START, LAST_MONTH_END, MONTH_START, NOW, TODAY } from '../db/time';
import type { CouponRoute, PromoLocale } from './types';
/**
 * Marketing seed (DATA_MODEL 10.15.2 “시드가 지켜야 할 값”). Deterministic rows only; every documented
 * number is pinned by `marketing/seed.test.ts`. Customers are card-based visit histories (one visit per
 * business day); groups and slot regulars are computed from them, never stored.
 */
import { addDays, dateRange, weekdayOf } from '../db/time';
import { catalogForSource, promoTablesFromCatalog } from './promo';
import type { Coupon, CouponCode, CouponRedemptionAgg, CouponTarget, MarketingTables, MktCustomer, MktVisit } from './types';

const PEOPLE = ['kim', 'lee', 'park', 'choi', 'jung', 'kang', 'cho', 'yoon', 'jang', 'lim'] as const;
const mask = (n: number): string => `data.person.${PEOPLE[(n - 1) % PEOPLE.length]}`;
const cid = (n: number): string => `mc-${String(n).padStart(2, '0')}`;

/** The 4 weeks before today used for “최근 4주” (09-29 … 10-25 for visits). */
const RECENT = dateRange('2026-09-29', '2026-10-25');
const datesOn = (weekday: number): string[] => RECENT.filter((d) => weekdayOf(d) === weekday);

function customers(): { mktCustomer: MktCustomer[]; mktVisit: MktVisit[] } {
  const rows: MktCustomer[] = [];
  const visits: MktVisit[] = [];
  const add = (n: number, consentSms: boolean, consentNight: boolean, days: readonly (readonly [string, number])[]) => {
    rows.push({ customerId: cid(n), maskKey: mask(n), consentSms, consentNight, variant: null });
    for (const [businessDate, hour] of days) visits.push({ customerId: cid(n), businessDate, hour });
  };
  // 1) 빈 시간 맞춤 단골 5명(모두 동의): every Tuesday 10–12 in the last 4 weeks; mc-03·04 also Wed 16, mc-04·05 also Thu 16.
  const tuesdays = datesOn(2), wednesdays = datesOn(3), thursdays = datesOn(4);
  for (let n = 1; n <= 5; n++) {
    const days: [string, number][] = tuesdays.map((d) => [d, n % 2 === 1 ? 10 : 11]);
    if (n === 3 || n === 4) days.push([wednesdays[1], 16], [wednesdays[2], 16]);
    if (n === 4 || n === 5) days.push([thursdays[1], 16], [thursdays[2], 16]);
    add(n, true, n <= 2, days);
  }
  // 2) 나머지 단골 33명: 4 visits in the last 4 weeks on Fri/Sat/Sun/Wed, never in a quiet slot; 19 of them consent.
  const weekdays = [5, 6, 7, 3], hours = [8, 9, 13, 14, 18, 19];
  for (let i = 0; i < 33; i++) {
    const n = 6 + i;
    add(n, n <= 24, n % 3 === 0, datesOn(weekdays[i % 4]).map((d) => [d, hours[i % 6]] as const));
  }
  // 3) 떠날 수 있는 손님 7명(동의 5): 4 visits at a steady cycle, last visit more than cycle + 14 days ago.
  const churn: readonly (readonly [string, number])[] = [['2026-09-21', 7], ['2026-09-14', 7], ['2026-09-11', 10], ['2026-09-07', 14], ['2026-09-24', 7], ['2026-09-04', 10], ['2026-08-31', 14]];
  churn.forEach(([last, cycle], i) => {
    const n = 39 + i;
    add(n, n <= 43, false, [3, 2, 1, 0].map((k) => [addDays(last, -cycle * k), [9, 13, 17][i % 3]] as const));
  });
  // 4) 첫 방문 12명: one visit each in October.
  for (let i = 0; i < 12; i++) { const n = 46 + i; add(n, i % 2 === 0, false, [[addDays('2026-10-02', i * 2), [12, 15, 17][i % 3]]]); }
  // 5) 그 밖의 손님 4명: two visits two weeks apart (no group).
  for (let i = 0; i < 4; i++) { const n = 58 + i; add(n, i % 2 === 1, false, [['2026-10-10', 15 + i], ['2026-10-24', 15 + i]]); }
  // 예시 상태 `consent-mixed` 전용: Tuesday-slot visitors without marketing consent.
  for (const [id, key] of [['mc-v1', 'data.person.cho'], ['mc-v2', 'data.person.yoon']] as const) {
    rows.push({ customerId: id, maskKey: key, consentSms: false, consentNight: false, variant: 'consent-mixed' });
    for (const d of tuesdays.slice(1, 3)) visits.push({ customerId: id, businessDate: d, hour: 10 });
  }
  return { mktCustomer: rows, mktVisit: visits };
}

/* 쿠폰 원본: 진행 중 3장(20+30+8 발행, 4+7+2 사용) + 이번 달 끝난 2장(62 발행, 15 사용). */
const coupons: readonly Coupon[] = [
  { couponId: 'c-tue-shot', name: { key: 'data.marketing.coupon.tuesdayShot' }, benefitType: 'free_item', benefitValue: 0, targetMenuId: 'opt-extra-shot', validHours: [{ weekday: 2, startHour: 10, endHour: 12 }], startsOn: '2026-10-13', endsOn: '2026-10-28', status: 'active', origin: 'manual', originRef: null, maxDiscountRate: null, createdAt: '2026-10-13T09:00' },
  { couponId: 'c-first-visit', name: { key: 'data.marketing.coupon.firstVisit' }, benefitType: 'percent', benefitValue: 10, targetMenuId: null, validHours: null, startsOn: '2026-10-08', endsOn: '2026-11-07', status: 'active', origin: 'manual', originRef: null, maxDiscountRate: null, createdAt: '2026-10-08T09:00' },
  { couponId: 'c-thanks-back', name: { key: 'data.marketing.coupon.thanksBack' }, benefitType: 'amount', benefitValue: 1_000, targetMenuId: null, validHours: null, startsOn: '2026-10-16', endsOn: '2026-11-15', status: 'active', origin: 'manual', originRef: null, maxDiscountRate: null, createdAt: '2026-10-16T09:00' },
  { couponId: 'c-autumn', name: { key: 'data.marketing.coupon.autumnTasting' }, benefitType: 'percent', benefitValue: 10, targetMenuId: null, validHours: null, startsOn: '2026-10-01', endsOn: '2026-10-12', status: 'ended', origin: 'manual', originRef: null, maxDiscountRate: null, createdAt: '2026-10-01T09:00' },
  { couponId: 'c-rainy', name: { key: 'data.marketing.coupon.rainyLatte' }, benefitType: 'amount', benefitValue: 500, targetMenuId: 'm-latte', validHours: null, startsOn: '2026-10-05', endsOn: '2026-10-18', status: 'ended', origin: 'manual', originRef: null, maxDiscountRate: null, createdAt: '2026-10-05T09:00' },
];
/** [codeId, couponId, code, route, issued, used, activatedAt] — route totals 35·12 / 33·7 / 16·3 / 36·6 = 120·28. */
const codeSeed: readonly (readonly [string, string, string, CouponCode['route'], number, number, string])[] = [
  ['cc-tue-pn', 'c-tue-shot', 'PN-TUE10', 'place_news', 10, 3, '2026-10-13T09:10'],
  ['cc-tue-bl', 'c-tue-shot', 'BL-TUE10', 'blog', 10, 1, '2026-10-14T10:00'],
  ['cc-first-pn', 'c-first-visit', 'PN-HELLO', 'place_news', 10, 4, '2026-10-08T09:10'],
  ['cc-first-bl', 'c-first-visit', 'BL-HELLO', 'blog', 10, 2, '2026-10-09T10:00'],
  ['cc-first-cl', 'c-first-visit', 'CL-HELLO', 'clip', 10, 1, '2026-10-10T11:00'],
  ['cc-thanks-sms', 'c-thanks-back', 'SM-THANKS', 'sms', 8, 2, '2026-10-16T11:00'],
  ['cc-autumn-pn', 'c-autumn', 'PN-AUTUMN', 'place_news', 15, 5, '2026-10-01T09:10'],
  ['cc-autumn-bl', 'c-autumn', 'BL-AUTUMN', 'blog', 13, 4, '2026-10-01T10:00'],
  ['cc-autumn-cl', 'c-autumn', 'CL-AUTUMN', 'clip', 6, 2, '2026-10-02T11:00'],
  ['cc-rainy-sms', 'c-rainy', 'SM-RAINY', 'sms', 28, 4, '2026-10-05T11:00'],
];
const couponCodes: readonly CouponCode[] = codeSeed.map(([codeId, couponId, code, route, issueCount, , activatedAt]) => ({ codeId, couponId, code, route, issueCount, videoId: null, activatedAt }));
/** Fixed usage (Q-35); 3,500원 average discount → 98,000 this month. */
const redemptionAgg: readonly CouponRedemptionAgg[] = codeSeed.map(([codeId, , , , , used]) => ({ codeId, used, discountSum: used * 3_500 }));
/** ‘다시 와 주셔서 고마워요 쿠폰’ was texted to 8 consenting regulars. */
const thanksTargets: readonly CouponTarget[] = Array.from({ length: 8 }, (_, i) => ({ couponId: 'c-thanks-back', codeId: 'cc-thanks-sms', customerId: cid(6 + i), reason: 'regular', sendId: `ms-thanks-${i + 1}` }));

export function createLegacyMarketingSeed(): MarketingTables {
  const { mktCustomer, mktVisit } = customers();
  return {
    coupon: coupons,
    couponCode: couponCodes,
    couponTarget: thanksTargets,
    messageSend: [],
    couponReminder: [],
    couponRedemptionAgg: redemptionAgg,
    perfFixed: [
      { period: 'this-month', revenueCoupon: 481_000, revenueAttributed: 143_000, cost: 116_000, discount: 98_000, returnRate: 31 },
      { period: 'last-month', revenueCoupon: 410_000, revenueAttributed: 133_000, cost: 104_000, discount: 87_000, returnRate: 33 },
    ],
    perfRouteFixed: [
      { period: 'last-month', route: 'place_news', issued: 30, used: 9 },
      { period: 'last-month', route: 'blog', issued: 25, used: 4 },
      { period: 'last-month', route: 'clip', issued: 10, used: 1 },
      { period: 'last-month', route: 'sms', issued: 35, used: 5 },
    ],
    mktCustomer,
    mktVisit,
    segmentRule: [
      { businessType: 'cafe', regularVisits: 4, regularDays: 28, churnGapDays: 14 },
      { businessType: 'beauty', regularVisits: 3, regularDays: 90, churnGapDays: 14 },
    ],
    ...promoTablesFromCatalog(catalogForSource()),
    promoVideo: [],
    expiryForecast: [{ itemId: 'it-croissant', menuId: 'm-croissant', expectedSalesUntilClose: 0 }],
  };
}

export const seedCouponDays = [...seedHistory.days, seedToday.rollup];

export function seedCouponTotals(start = seedMembers.start, end = TODAY) {
  const totals = new Map<string, { used: number; discount: number; revenue: number; cost: number }>();
  for (const day of seedCouponDays) if (day.date >= start && day.date <= end) for (const [id, used, discount, revenue, cost] of day.coupons) {
    const row = totals.get(id) ?? { used: 0, discount: 0, revenue: 0, cost: 0 };
    totals.set(id, { used: row.used + used, discount: row.discount + discount, revenue: row.revenue + revenue, cost: row.cost + cost });
  }
  return totals;
}

export function createMarketingSeed(): MarketingTables {
  const all = seedCouponTotals();
  const current = seedCouponTotals(MONTH_START, TODAY);
  const previous = seedCouponTotals(LAST_MONTH_START, LAST_MONTH_END);
  const couponCode: CouponCode[] = seedOperations.couponCodes.map(row => ({
    ...row, route: row.route === 'sms' ? 'sms' : 'place_news', videoId: null,
    activatedAt: row.activatedAt.slice(0, 16) <= NOW ? row.activatedAt : null,
  }));
  const routes: readonly CouponRoute[] = ['place_news', 'blog', 'clip', 'sms'];
  const promo = promoTablesFromCatalog(catalogForSource('cafe'));
  const promoNames = new Map(promo.promoMenu.map(menu => [menu.menuId, menu.names]));
  const promoMenus = seedCatalog.menu.map(({ menuId, name }, order) => ({
    menuId, order, names: promoNames.get(menuId) ?? { ko: name, en: name, 'zh-Hans': name, 'zh-Hant': name } satisfies Record<PromoLocale, string>,
  }));
  const mktCustomer: MktCustomer[] = seedMembers.members.map(row => ({
    customerId: row.customerId, maskKey: `seed:${row.maskedName}`, maskedName: row.maskedName, phoneLast4: row.phoneLast4,
    consentSms: row.consentSms, consentNight: row.consentNight, variant: null,
  }));
  const mktVisit: MktVisit[] = seedMembers.members.flatMap(row => row.visits.map(visit => ({
    customerId: row.customerId, businessDate: addDays(seedMembers.start, Math.floor(visit / 24)), hour: visit % 24,
  })));
  // The cafe has no non-consenting matches for Friday's 09:00 quiet slot. For the preview only,
  // give one extra matching visit to two non-consenting seeded people who already came once.
  const recentFridays = dateRange(addDays(TODAY, -27), TODAY).filter(date => weekdayOf(date) === 5);
  const slotConsentSampleVisits = mktCustomer.filter(customer => !customer.consentSms).flatMap(({ customerId }) => {
    const visits = mktVisit.filter(visit => visit.customerId === customerId);
    if (visits.filter(v => v.hour === 9 && recentFridays.includes(v.businessDate)).length !== 1) return [];
    const businessDate = recentFridays.find(date => !visits.some(v => v.businessDate === date));
    return businessDate ? [{ customerId, businessDate, hour: 9 }] : [];
  }).slice(0, 2);
  return {
    coupon: seedOperations.coupons.map(row => ({
      ...row, name: { raw: row.name }, benefitType: row.kind === 'percent' ? 'percent' : 'amount', benefitValue: row.value,
      targetMenuId: null, validHours: null, status: row.status === 'active' ? 'active' : row.status === 'ended' ? 'ended' : 'paused',
      origin: 'manual', originRef: null, maxDiscountRate: null, createdAt: `${row.startsOn}T12:00`,
    })),
    couponCode, couponTarget: [], messageSend: [], couponReminder: [],
    couponRedemptionAgg: couponCode.map(c => ({ codeId: c.codeId, used: all.get(c.codeId)?.used ?? 0, discountSum: all.get(c.codeId)?.discount ?? 0 })),
    couponUsageBeforeMonth: Object.fromEntries(couponCode.map(code => [code.codeId, (all.get(code.codeId)?.used ?? 0) - (current.get(code.codeId)?.used ?? 0)])),
    perfFixed: ([['this-month', current], ['last-month', previous]] as const).map(([period, totals]) => {
      const rows = [...totals.values()];
      return { period, revenueCoupon: rows.reduce((sum, row) => sum + row.revenue, 0), revenueAttributed: 0,
        cost: rows.reduce((sum, row) => sum + row.cost, 0), discount: rows.reduce((sum, row) => sum + row.discount, 0), returnRate: null };
    }),
    perfRouteFixed: routes.map(route => {
      const own = couponCode.filter(row => row.route === route && row.activatedAt && inRange(row.activatedAt.slice(0, 10), LAST_MONTH_START, LAST_MONTH_END));
      return { period: 'last-month', route, issued: own.reduce((n, row) => n + row.issueCount, 0), used: own.reduce((n, row) => n + (previous.get(row.codeId)?.used ?? 0), 0) };
    }),
    mktCustomer, mktVisit, slotConsentSampleVisits,
    segmentRule: [{ businessType: 'cafe', regularVisits: 4, regularDays: 28, churnGapDays: 14 }],
    ...promo,
    promoStore: promo.promoStore.map(store => ({ ...store, name: seedCatalog.store.name, location: seedCatalog.store.address })),
    promoMenu: promoMenus,
    promoVideo: [], promoDrafts: seedSupplement.promos,
    expiryForecast: seedSupplement.expiryBatches.map(row => ({ itemId: row.itemId, menuId: row.menuId, expectedSalesUntilClose: 2, quantityExpiring: row.quantityBase })),
  };
}
