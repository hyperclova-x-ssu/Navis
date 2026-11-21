/**
 * The 7 marketing projections (DATA_MODEL 10.15.3). Each builder reads plan-1 models through
 * `ctx.read` (normal variant, same snapshot) and the marketing tables of the same snapshot; the
 * marketing-today builder reuses the other builders, so there are no copies and no second count.
 */
import { createTranslator } from '../../i18n/translator';
import type { DetailRef, QueryCondition } from '../../contracts';
import { periodOf } from '../conditions';
import { dateOf, inRange, MONTH_START, TODAY, weekdayOf } from '../db/time';
import type { DemandHourRow, StateNote, WidgetView } from '../models/types';
import { note, ready, type ModelContext, type Projector } from '../models/util';
import { variantMessageKey } from '../preview/variants';
import { couponBenefit, expiryPostText } from './benefit';
import { benefitComparison, expiryDiscount, MIN_PROMO_PHOTOS, PUBLIC_ISSUE_LIMIT, QUIET_THRESHOLD_PERCENT, ratePercent, RECOMMENDED_EXPIRY_RATE, roundPercent, SECOND_DISCOUNT_HOURS } from './calc';
import {
  codeUsed, consentingRegulars, CONCEPTS, couponRow, createdToday, customerAlias, customersOf, isActiveCode, isEndedCoupon, MOODS, routeNameKey, ROUTES, ruleOf, marketingCohorts,
  SHOT_OPTION_ID, SLOT_COUPON_ENDS, SLOT_MENU_ID, SLOT_WINDOW, slotVisitors, videoCode,
} from './derive';
import type { MarketingWidgetId } from './ids';
import { PROMO_MENU_NAME } from './promo';
import { MARKETING_VARIANTS } from './variants';
import type {
  CouponRoute, CouponStatusModel, CustomerGroupId, CustomerGroupsModel, ExpiryCouponModel, ExpiryItem, GroupCustomer, MarketingModelMap, MarketingPerformanceModel, MarketingTodayModel, PerfRouteLine, PerfRouteRow,
  PromoCurrent, PromoMenuModel, PromoMenuRow, PromoPhotoRow, PromoVideo, PromoVideoModel, PromoWidgetState, QuietSlot, SlotBenefitId, SlotCouponModel, SlotRecipient, TodayCell,
} from './types';

/** An empty view in the words of a sample-state variant (normal data can be empty too, e.g. croissant 0). */
function emptyAs<F extends MarketingWidgetId>(id: F, variant: string, state: string): WidgetView<MarketingModelMap[F], F> {
  const actionKey = MARKETING_VARIANTS[id].find((v) => v.id === state)?.actionKey;
  return { status: 'empty', featureId: id, variant, messageKey: variantMessageKey(id, state), ...(actionKey ? { actionKey } : {}) };
}
const tables = (ctx: ModelContext) => ctx.snapshot.tables.marketing;

/* 빈 시간 단골 쿠폰 */
const monthDay = (iso: string) => [Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
const [startMonth, startDay] = monthDay(SLOT_WINDOW.start);
const [endMonth, endDay] = monthDay(SLOT_WINDOW.end);
const [untilMonth, untilDay] = monthDay(SLOT_COUPON_ENDS);
const enDate = createTranslator('en').format.date;
const slotDates = {
  startMonth, startDay, endMonth, endDay, untilMonth, untilDay,
  startEn: enDate(SLOT_WINDOW.start, 'monthDay'), endEn: enDate(SLOT_WINDOW.end, 'monthDay'), untilEn: enDate(SLOT_COUPON_ENDS, 'monthDay'),
};
function quietSlots(ctx: ModelContext, variant: string): QuietSlot[] {
  const m = tables(ctx);
  const sentSlots = new Set(m.coupon.filter((c) => c.origin === 'slot').flatMap((c) => c.originRef?.slotIds ?? []));
  const days = ctx.read('demand').hourly.filter((d) => inRange(d.date, SLOT_WINDOW.start, SLOT_WINDOW.end));
  const slots: QuietSlot[] = [];
  for (const day of days) {
    let run: DemandHourRow[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const startHour = run[0].hour, endHour = run[run.length - 1].hour + 1, weekday = weekdayOf(day.date);
      const expected = run.reduce((s, h) => s + h.expected, 0), average = run.reduce((s, h) => s + h.average, 0);
      const slotId = `slot-${day.date}-${startHour}`;
      const regularIds = slotVisitors(m, { weekday, startHour, endHour }, variant).filter((v) => v.customer.consentSms).map((v) => v.customer.customerId);
      slots.push({ slotId, date: day.date, weekday, startHour, endHour, expected, average, percent: roundPercent((expected / average) * 100), hours: run.map((h) => ({ hour: h.hour, expected: h.expected, average: h.average, percent: h.percent })), handled: sentSlots.has(slotId), regularIds });
      run = [];
    };
    for (const h of day.hours) { if (h.belowUsual && (run.length === 0 || run[run.length - 1].hour === h.hour - 1)) run.push(h); else { flush(); if (h.belowUsual) run.push(h); } }
    flush();
  }
  return slots;
}
export function buildSlotCoupon(ctx: ModelContext, variant = 'normal'): SlotCouponModel | null {
  const m = tables(ctx);
  const found = quietSlots(ctx, variant);
  if (found.length === 0) return null;
  // ‘보낼 단골이 없어요’ sample state: the slots stay, nobody matches them.
  const slots = variant === 'no-regulars' ? found.map((s) => ({ ...s, regularIds: [] })) : found;
  const openSlots = slots.filter((s) => !s.handled);
  const byId = new Map<string, SlotRecipient>();
  if (variant !== 'no-regulars') for (const slot of openSlots) for (const { customer, lastVisit } of slotVisitors(m, slot, variant)) {
    const prev = byId.get(customer.customerId);
    byId.set(customer.customerId, {
      customerId: customer.customerId, name: customerAlias(customer), consentSms: customer.consentSms, consentNight: customer.consentNight, selectable: customer.consentSms,
      reasonKey: customer.consentSms ? null : 'data.marketing.error.noConsent', slotIds: [...(prev?.slotIds ?? []), slot.slotId], lastVisit: prev && prev.lastVisit && prev.lastVisit > lastVisit ? prev.lastVisit : lastVisit,
    });
  }
  const recipients = [...byId.values()].sort((a, b) => Number(b.selectable) - Number(a.selectable) || a.customerId.localeCompare(b.customerId));
  const latte = ctx.read('margin').menus.find((x) => x.menuId === SLOT_MENU_ID);
  const shotCost = ctx.snapshot.tables.menuOption.find((o) => o.optionId === SHOT_OPTION_ID)?.cost ?? null;
  const menu = { menuId: SLOT_MENU_ID, nameKey: latte?.nameKey ?? 'data.menu.latte', price: latte?.price ?? 0, unitCost: latte?.unitCost ?? 0, shotCost: shotCost ?? 0 };
  const benefits = benefitComparison(menu, shotCost);
  const bodies: Record<SlotBenefitId, SlotCouponModel['message']['body']> = {
    'free-shot': { key: 'data.marketing.sms.slotFreeShot', params: slotDates },
    'percent-10': { key: 'data.marketing.sms.slotPercent', params: { ...slotDates, p: 10 } },
    'amount-500': { key: 'data.marketing.sms.slotAmount', params: { ...slotDates, amount: 500 } },
  };
  const regularsCount = recipients.filter((r) => r.selectable).length;
  return {
    window: SLOT_WINDOW, thresholdPercent: QUIET_THRESHOLD_PERCENT, slots, openSlots, slotCount: openSlots.length, regularsCount, recipients, menu, benefits,
    message: { body: bodies[benefits.recommendedId], bodies }, endsOn: SLOT_COUPON_ENDS,
    sent: m.coupon.filter((c) => c.origin === 'slot').map((c) => couponRow(m, c)), canSend: openSlots.length > 0 && regularsCount > 0,
  };
}
const projectSlotCoupon: Projector<'slot-coupon'> = (ctx, condition, variant) => {
  const model = buildSlotCoupon(ctx, variant);
  if (!model) return emptyAs('slot-coupon', variant, 'no-slots');
  const notes: StateNote[] = variant === 'consent-mixed' || variant === 'no-regulars' ? [note('slot-coupon', variant)] : [];
  return ready('slot-coupon', condition, variant, model, notes);
};

/* 당일 소진 쿠폰 */
export function buildExpiryCoupon(ctx: ModelContext, variant = 'normal'): ExpiryCouponModel {
  const m = tables(ctx);
  const inventory = ctx.read('inventory-booking');
  const menus = ctx.read('margin').menus;
  const costKnown = variant !== 'partial';
  const items: ExpiryItem[] = inventory.ingredients.flatMap((row) => {
    const forecast = m.expiryForecast.find((f) => f.itemId === row.itemId);
    const menu = forecast ? menus.find((x) => x.menuId === forecast.menuId) : undefined;
    if (!row.trackExpiry || row.expiresOn !== TODAY || row.stock === null || !forecast || !menu || menu.unitCost === null) return [];
    const stock = Math.min(row.stock, forecast.quantityExpiring ?? row.stock);
    const qty = stock - forecast.expectedSalesUntilClose;
    if (qty <= 0) return [];
    const limits = expiryDiscount(menu.price, menu.unitCost, 0, qty);
    const recommendedRate = Math.min(RECOMMENDED_EXPIRY_RATE, limits.maxSliderRate);
    return [{
      itemId: row.itemId, nameKey: row.nameKey, unit: row.unit, stock, qty, expiresOn: row.expiresOn, menuId: menu.menuId, price: menu.price,
      unitCost: costKnown ? menu.unitCost : null, maxRatePercent: costKnown ? limits.maxRatePercent : null, maxSliderRate: costKnown ? limits.maxSliderRate : null,
      recommendedRate: costKnown ? recommendedRate : null, atRecommended: costKnown ? expiryDiscount(menu.price, menu.unitCost, recommendedRate, qty) : null,
      handled: m.coupon.some((c) => c.origin === 'expiry' && c.originRef?.itemId === row.itemId && createdToday(c)),
    }];
  });
  const created = m.coupon.filter((c) => c.origin === 'expiry' && createdToday(c));
  const target = items[0] ?? null;
  return {
    items, target,
    routes: { sms: { recipients: consentingRegulars(m).length }, placeNews: { issueLimit: PUBLIC_ISSUE_LIMIT } },
    secondDiscountHoursBeforeClose: SECOND_DISCOUNT_HOURS,
    created: created.map((c) => couponRow(m, c)),
    pendingPosts: m.couponCode.filter((code) => !isActiveCode(code) && code.route !== 'sms' && created.some((c) => c.couponId === code.couponId)).map((code) => {
      const coupon = created.find((c) => c.couponId === code.couponId)!;
      const benefit = couponBenefit(coupon) ?? { kind: 'percent' as const, value: coupon.benefitValue };
      return { codeId: code.codeId, couponId: code.couponId, code: code.code, route: code.route, post: expiryPostText(items.find((i) => i.itemId === coupon.originRef?.itemId)?.nameKey ?? 'data.item.croissant', benefit, code.code) };
    }),
    canCreate: target !== null && costKnown,
  };
}
const projectExpiryCoupon: Projector<'expiry-coupon'> = (ctx, condition, variant) => {
  const model = buildExpiryCoupon(ctx, variant);
  if (!model.target) return emptyAs('expiry-coupon', variant, 'none');
  return ready('expiry-coupon', condition, variant, model, variant === 'partial' ? [note('expiry-coupon', 'partial')] : undefined);
};

/* AI 홍보 영상 (DATA_MODEL 10.16.8) */
/** The `few-photos` sample state shows 4 photos on this widget only (variants apply to the widget's own display, 11.7). */
const FEW_PHOTOS = 4;
const menuModel = (m: PromoMenuRow, photos: readonly PromoPhotoRow[]): PromoMenuModel => {
  const own = photos.filter((p) => p.menuId === m.menuId);
  return { menuId: m.menuId, name: PROMO_MENU_NAME[m.menuId] ? { key: PROMO_MENU_NAME[m.menuId] } : { raw: m.names.ko }, names: m.names, photos: own, hasPhotos: own.length > 0 };
};
const currentOf = (v: PromoVideo): PromoCurrent => ({
  videoId: v.videoId, jobId: v.jobId, status: v.status, stage: v.stage, stageState: v.stageState, lookCount: v.lookCount, lengthSec: v.input.lengthSec,
  photoCount: v.input.photoIds.length, failReason: v.failReason, result: v.result, retryCount: v.retryCount,
});
export function buildPromoVideo(ctx: ModelContext, variant = 'normal'): PromoVideoModel {
  const m = tables(ctx);
  const all = [...m.promoPhoto].sort((a, b) => a.order - b.order);
  const photos = variant === 'few-photos' ? all.slice(0, FEW_PHOTOS) : all;
  const menus = [...m.promoMenu].sort((a, b) => a.order - b.order).map((row) => menuModel(row, photos));
  const rows = m.promoVideo;
  const latest = rows[rows.length - 1] ?? null;
  const posted = rows.filter((v) => v.status === 'posted').sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? '') || b.videoId.localeCompare(a.videoId, undefined, { numeric: true }));
  const canMake = photos.length >= MIN_PROMO_PHOTOS;
  const state: PromoWidgetState = latest ? latest.status : canMake ? 'before' : 'few-photos';
  return {
    materialsCount: photos.length, praiseCount: ctx.read('ai-response').praiseCount, photoCount: photos.length, canMake, minPhotos: MIN_PROMO_PHOTOS, menus, firstMenu: menus.find((x) => x.hasPhotos) ?? null,
    store: m.promoStore[0] ?? null, state, current: latest ? currentOf(latest) : null, postedCount: posted.length,
    lastPostedRoute: posted[0]?.postedRoute ?? null, lastPostedCounting: posted[0]?.postedRoute === 'clip',
    moods: MOODS, concepts: CONCEPTS, postRoutes: ['clip', 'reels', 'shorts'],
    videos: rows.map((v) => ({ ...currentOf(v), input: v.input, postedRoute: v.postedRoute, postedAt: v.postedAt, createdAt: v.createdAt })),
  };
}
const projectPromoVideo: Projector<'promo-video'> = (ctx, condition, variant) => {
  const model = buildPromoVideo(ctx, variant);
  if (model.state === 'few-photos') return emptyAs('promo-video', variant, 'few-photos');
  return ready('promo-video', condition, variant, model);
};

/* 진행 중인 쿠폰 */
export function buildCouponStatus(ctx: ModelContext, variant = 'normal'): CouponStatusModel {
  const m = tables(ctx);
  const partial = variant === 'partial';
  const usedInMonth: typeof codeUsed = (marketing, codeId) =>
    Math.max(0, codeUsed(marketing, codeId) - (marketing.couponUsageBeforeMonth?.[codeId] ?? 0));
  const rows = m.coupon.filter((c) => !isEndedCoupon(c)).map((c) => couponRow(m, c, false, usedInMonth)).sort((a, b) => a.endsOn.localeCompare(b.endsOn) || a.couponId.localeCompare(b.couponId));
  // ‘일부 자료 없음’: the usage of the last ended coupon is missing.
  const endedCoupons = m.coupon.filter((c) => isEndedCoupon(c) && inRange(c.endsOn, MONTH_START, TODAY));
  const ended = endedCoupons.map((c, i) => couponRow(m, c, partial && i === endedCoupons.length - 1, usedInMonth)).sort((a, b) => b.endsOn.localeCompare(a.endsOn) || a.couponId.localeCompare(b.couponId));
  const runningUsed = rows.reduce((s, r) => s + (r.used ?? 0), 0);
  const endedUsed = ended.some((r) => r.used === null) ? null : ended.reduce((s, r) => s + (r.used ?? 0), 0);
  const runningIssued = rows.reduce((s, r) => s + r.issued, 0), endedIssued = ended.reduce((s, r) => s + r.issued, 0);
  const monthIssued = m.couponUsageBeforeMonth ? m.couponCode.filter(code => code.activatedAt && inRange(dateOf(code.activatedAt), MONTH_START, TODAY))
    .reduce((sum, code) => sum + code.issueCount, 0) : runningIssued + endedIssued;
  return {
    // Running means status ‘active’; a paused coupon stays in `rows` (it can be resumed) but is counted apart.
    activeCount: rows.filter((r) => r.status === 'active').length, pausedCount: rows.filter((r) => r.status === 'paused').length, endingSoonCount: rows.filter((r) => r.endingSoon).length, rows, ended,
    runningUsed, runningIssued, endedUsed, endedIssued, monthUsed: endedUsed === null ? null : runningUsed + endedUsed, monthIssued,
  };
}
const projectCouponStatus: Projector<'coupon-status'> = (ctx, condition, variant) => {
  const model = buildCouponStatus(ctx, variant);
  if (model.rows.length === 0) return emptyAs('coupon-status', variant, 'none');
  return ready('coupon-status', condition, variant, model, variant === 'partial' ? [note('coupon-status', 'partial')] : undefined);
};

/* 손님 그룹 */
export function buildCustomerGroups(ctx: ModelContext): CustomerGroupsModel {
  const m = tables(ctx);
  const rule = ruleOf(m);
  const segs = marketingCohorts(m);
  const row = (s: (typeof segs)[number]): GroupCustomer => ({
    customerId: s.customer.customerId, name: customerAlias(s.customer), visitCount: s.visitCount, lastVisit: s.lastVisit, daysSinceLast: s.daysSinceLast, usualCycleDays: s.usualCycleDays,
    consentSms: s.customer.consentSms, selectable: s.customer.consentSms, reasonKey: s.customer.consentSms ? null : 'data.marketing.error.noConsent',
  });
  const of = (id: CustomerGroupId) => segs.filter((s) => s.group === id).map(row);
  const churnRisk = of('churn-risk').sort((a, b) => a.lastVisit.localeCompare(b.lastVisit) || a.customerId.localeCompare(b.customerId));
  const firstVisit = of('first-visit').sort((a, b) => b.lastVisit.localeCompare(a.lastVisit) || a.customerId.localeCompare(b.customerId));
  const regular = of('regular').sort((a, b) => b.lastVisit.localeCompare(a.lastVisit) || a.customerId.localeCompare(b.customerId));
  const recipientIds = churnRisk.filter((c) => c.selectable).map((c) => c.customerId);
  return {
    rule: { businessType: rule.businessType, regularVisits: rule.regularVisits, regularDays: rule.regularDays, churnGapDays: rule.churnGapDays },
    groups: [
      { id: 'churn-risk', nameKey: 'data.marketing.group.churnRisk', count: churnRisk.length, customers: churnRisk },
      { id: 'first-visit', nameKey: 'data.marketing.group.firstVisit', count: firstVisit.length, customers: firstVisit },
      { id: 'regular', nameKey: 'data.marketing.group.regular', count: regular.length, customers: regular },
    ],
    counts: { 'churn-risk': churnRisk.length, 'first-visit': firstVisit.length, regular: regular.length },
    churnRisk, reachOut: { recipientIds, blockedIds: churnRisk.filter((c) => !c.selectable).map((c) => c.customerId), count: recipientIds.length },
    basisKey: 'data.marketing.groups.basis', sent: m.coupon.filter((c) => c.origin === 'group').map((c) => couponRow(m, c)), canReachOut: recipientIds.length > 0,
  };
}
const projectCustomerGroups: Projector<'customer-groups'> = (ctx, condition, variant) => {
  if (customersOf(tables(ctx), 'normal').length === 0) return emptyAs('customer-groups', variant, 'no-history');
  return ready('customer-groups', condition, variant, buildCustomerGroups(ctx), variant === 'partial' ? [note('customer-groups', 'partial')] : undefined);
};

/* 마케팅 성과 */
const routeRows = (counts: ReadonlyMap<CouponRoute, { issued: number; used: number }>, routes: readonly CouponRoute[], lines: readonly (PerfRouteLine & { readonly route: CouponRoute })[] = []): PerfRouteRow[] =>
  routes.map((route) => { const c = counts.get(route) ?? { issued: 0, used: 0 }; return { route, nameKey: routeNameKey(route), issued: c.issued, used: c.used, rate: ratePercent(c.used, c.issued), lines: lines.flatMap(({ route: lineRoute, ...line }) => lineRoute === route ? [line] : []) }; });
const bestOf = (rows: readonly PerfRouteRow[]): PerfRouteRow | null => rows.reduce<PerfRouteRow | null>((best, r) => (r.rate !== null && (best === null || (best.rate ?? -1) < r.rate) ? r : best), null);
export function buildPerformance(ctx: ModelContext, condition: QueryCondition, variant = 'normal'): MarketingPerformanceModel {
  const m = tables(ctx);
  const period = periodOf('marketing-performance', condition) ?? { start: MONTH_START, end: TODAY };
  const lastMonth = period.start !== MONTH_START;
  const missingRoutes: CouponRoute[] = variant === 'partial' ? ['blog'] : [];
  const routesShown = ROUTES.filter((r) => !missingRoutes.includes(r));
  const fixedOf = (p: 'this-month' | 'last-month') => m.perfFixed.find((f) => f.period === p) ?? { period: p, revenueCoupon: 0, revenueAttributed: 0, cost: 0, discount: 0, returnRate: null };
  const lastCounts = new Map(m.perfRouteFixed.map((r) => [r.route, { issued: r.issued, used: r.used }]));
  const lastRoutes = routeRows(lastCounts, ROUTES);
  const lastRate = ratePercent(lastRoutes.reduce((s, r) => s + r.used, 0), lastRoutes.reduce((s, r) => s + r.issued, 0));
  const codes = m.couponCode.filter((c) => c.activatedAt !== null && inRange(dateOf(c.activatedAt), period.start, period.end));
  const counts = lastMonth ? lastCounts : new Map(ROUTES.map((route) => {
    const own = codes.filter((c) => c.route === route);
    return [route, { issued: own.reduce((s, c) => s + c.issueCount, 0), used: own.reduce((s, c) => s + codeUsed(m, c.codeId), 0) }] as const;
  }));
  // The route lines come from the very `codes` the route counts add up (this period's activated codes, ended coupons included), so lines sum to the row and the row to the metric.
  const lines = lastMonth ? [] : codes.map((code) => {
    const coupon = m.coupon.find((c) => c.couponId === code.couponId);
    return { route: code.route, codeId: code.codeId, couponId: code.couponId, name: coupon?.name ?? { raw: code.code }, status: coupon ? couponRow(m, coupon).status : 'ended' as const, issued: code.issueCount, used: codeUsed(m, code.codeId) };
  });
  const routes = routeRows(counts, routesShown, lines);
  const issued = routes.reduce((s, r) => s + r.issued, 0), used = routes.reduce((s, r) => s + r.used, 0);
  const rate = ratePercent(used, issued);
  const fixed = fixedOf(lastMonth ? 'last-month' : 'this-month'), prev = fixedOf('last-month');
  const revenue = { total: fixed.revenueCoupon + fixed.revenueAttributed, coupon: fixed.revenueCoupon, attributed: fixed.revenueAttributed };
  const best = bestOf(routes);
  const couponIds = [...new Set(codes.map((c) => c.couponId))];
  return {
    period, periodKind: lastMonth ? 'last-month' : 'this-month', issued, used, rate,
    rateDelta: !lastMonth && rate !== null && lastRate !== null ? { value: rate - lastRate, kind: 'pp' } : null,
    revenue, revenueDelta: lastMonth ? null : { value: revenue.total - (prev.revenueCoupon + prev.revenueAttributed), kind: 'count', unit: 'KRW' },
    cost: fixed.cost, discount: fixed.discount, profit: revenue.total - fixed.cost - (m.promoStore[0]?.sourceId === 'cafe' ? 0 : fixed.discount),
    returnRate: fixed.returnRate, returnRateDelta: lastMonth || fixed.returnRate === null || prev.returnRate === null ? null : { value: fixed.returnRate - prev.returnRate, kind: 'pp' },
    routes, missingRoutes, best,
    byCoupon: lastMonth ? [] : m.coupon.filter((c) => couponIds.includes(c.couponId)).map((c) => {
      const own = codes.filter((x) => x.couponId === c.couponId);
      const i = own.reduce((s, x) => s + x.issueCount, 0), u = own.reduce((s, x) => s + codeUsed(m, x.codeId), 0);
      return { couponId: c.couponId, name: c.name, status: couponRow(m, c).status, issued: i, used: u, rate: ratePercent(u, i) };
    }),
    byVideo: lastMonth ? [] : m.promoVideo.filter((v) => v.status === 'posted').map((v) => {
      const code = videoCode(m, v);
      const i = code && isActiveCode(code) ? code.issueCount : 0, u = code ? codeUsed(m, code.codeId) : 0;
      return { videoId: v.videoId, couponId: code?.couponId ?? null, postedRoute: v.postedRoute, issued: i, used: u, rate: ratePercent(u, i) };
    }),
    insight: !lastMonth && best && best.route !== 'sms' ? { bestRoute: best.route, compareRoute: 'sms' } : null,
    recentIssued: lastMonth ? 0 : codes.filter((c) => c.activatedAt !== null && dateOf(c.activatedAt) === TODAY).reduce((s, c) => s + c.issueCount, 0),
    basisKey: 'data.marketing.perf.basis',
  };
}
const projectPerformance: Projector<'marketing-performance'> = (ctx, condition, variant) => {
  const model = buildPerformance(ctx, condition, variant);
  if (model.issued === 0 && model.used === 0) return emptyAs('marketing-performance', variant, 'no-redemptions');
  return ready('marketing-performance', condition, variant, model, variant === 'partial' ? [note('marketing-performance', 'partial')] : undefined);
};

/* 오늘 할 홍보 */
const action = (ref: DetailRef): DetailRef => ({ ...ref, focus: 'action' });
export function buildMarketingToday(ctx: ModelContext, variant = 'normal'): MarketingTodayModel | null {
  const cells: TodayCell[] = [];
  const slotCoupon = buildSlotCoupon(ctx);
  const slot = slotCoupon?.openSlots.find(s => s.regularIds.length > 0) ?? slotCoupon?.openSlots[0];
  const expiry = buildExpiryCoupon(ctx).items.find((i) => !i.handled);
  if (slot) cells.push({ slot: 'now', kind: 'quiet-hours', sourceFeatureId: 'slot-coupon', params: { regulars: slotCoupon?.regularsCount ?? 0 }, quietSlot: { slotId: slot.slotId, date: slot.date, weekday: slot.weekday, startHour: slot.startHour, endHour: slot.endHour }, ref: action({ featureId: 'slot-coupon', view: 'send' }) });
  else if (expiry) cells.push({ slot: 'now', kind: 'expiry', sourceFeatureId: 'expiry-coupon', params: { count: expiry.qty }, itemNameKey: expiry.nameKey, ref: action({ featureId: 'expiry-coupon' }) });
  // ‘일부 자료 없음’: the reply source could not be read, so that cell is left out with a note.
  const waiting = ctx.read('ai-response').waitingCount;
  if (variant !== 'partial' && waiting > 0) cells.push({ slot: 'today', kind: 'replies', sourceFeatureId: 'ai-response', params: { count: waiting }, ref: action({ featureId: 'ai-response' }) });
  const video = buildPromoVideo(ctx);
  if (video.canMake && video.postedCount === 0) cells.push({ slot: 'week', kind: 'video', sourceFeatureId: 'promo-video', params: { photos: video.photoCount }, ref: action({ featureId: 'promo-video', view: 'create' }) });
  if (cells.length === 0) return null;
  const first = cells[0].ref;
  const tapTarget: DetailRef = first.view ? { featureId: first.featureId, view: first.view } : { featureId: first.featureId };
  return { cells, folded: (['now', 'today', 'week'] as const).filter((s) => !cells.some((c) => c.slot === s)), tapTarget };
}
const projectMarketingToday: Projector<'marketing-today'> = (ctx, condition, variant) => {
  const model = buildMarketingToday(ctx, variant);
  if (!model) return emptyAs('marketing-today', variant, 'none');
  return ready('marketing-today', condition, variant, model, variant === 'partial' ? [note('marketing-today', 'partial')] : undefined);
};

export const marketingProjectors: { readonly [F in MarketingWidgetId]: Projector<F> } = {
  'marketing-today': projectMarketingToday,
  'slot-coupon': projectSlotCoupon,
  'expiry-coupon': projectExpiryCoupon,
  'promo-video': projectPromoVideo,
  'coupon-status': projectCouponStatus,
  'customer-groups': projectCustomerGroups,
  'marketing-performance': projectPerformance,
};

