/**
 * Navis facts of the 7 marketing widgets (DATA_MODEL 10.15.6). Keys are `{widget}.{metric}` in the same
 * camelCase form as the plan-1 facts (`slot.quietHours.count`, not the hyphenated example), values stay in
 * stored units (won, whole percent), labels are `data.fact.*` keys.
 */
import { MONTH_START, TODAY } from '../db/time';
import type { UnitCode } from '../db/types';
import type { ModelFact } from '../facts';
import type { MarketingWidgetId } from './ids';
import { routeNameKey } from './derive';
import type { MarketingModelMap } from './types';

type Extra = Partial<Pick<ModelFact, 'date' | 'start' | 'end' | 'labelText' | 'text' | 'source'>>;
const fact = (key: string, value: number | string, unit: UnitCode | '', extra: Extra = {}): ModelFact => ({ key, value, unit, labelKey: `data.fact.${key}`, ...extra });
const today: Extra = { date: TODAY };

export const marketingFactBuilders: { readonly [F in MarketingWidgetId]: (m: MarketingModelMap[F]) => ModelFact[] } = {
  'marketing-today': (m) => [
    fact('todayPromo.cells.count', m.cells.length, 'count', today),
    ...m.cells.map((c) => c.kind === 'quiet-hours' ? fact('todayPromo.quietHours.regulars', c.params.regulars, 'person', { date: c.quietSlot.date, labelText: { key: 'data.fact.slot.quietHours.at', params: { start: c.quietSlot.startHour, end: c.quietSlot.endHour } } })
      : c.kind === 'expiry' ? fact('todayPromo.expiry.qty', c.params.count, 'pcs', { ...today, labelText: { key: c.itemNameKey } })
        : c.kind === 'replies' ? fact('todayPromo.replies.waiting', c.params.count, 'count', today)
          : fact('todayPromo.video.materials', c.params.photos, 'count', today)),
  ],
  'slot-coupon': (m) => [
    fact('slot.quietHours.count', m.slotCount, 'count', { start: m.window.start, end: m.window.end }),
    fact('slot.regulars.count', m.regularsCount, 'person', { start: m.window.start, end: m.window.end }),
    ...m.openSlots.map((s) => fact('slot.quietHours.expected', s.expected, 'person', { date: s.date, labelText: { key: 'data.fact.slot.quietHours.at', params: { start: s.startHour, end: s.endHour } } })),
    ...m.openSlots.map((s) => fact('slot.quietHours.percent', s.percent, 'percent', { date: s.date, labelText: { key: 'data.fact.slot.quietHours.at', params: { start: s.startHour, end: s.endHour } } })),
    ...m.benefits.options.map((o) => fact('slot.benefit.kept', o.marginPerCoupon, 'KRW', { labelText: o.name })),
  ],
  'expiry-coupon': (m) => m.items.flatMap((i) => [
    fact('expiry.item.qty', i.qty, i.unit, { date: i.expiresOn, labelText: { key: i.nameKey } }),
    ...(i.maxRatePercent !== null ? [fact('expiry.discount.max', i.maxRatePercent, 'percent', today)] : []),
    ...(i.recommendedRate !== null ? [fact('expiry.discount.recommended', i.recommendedRate, 'percent', today)] : []),
    ...(i.atRecommended ? [fact('expiry.price.discounted', i.atRecommended.discountedPrice, 'KRW', today), fact('expiry.margin.each', i.atRecommended.marginEach, 'KRW', today)] : []),
  ]).concat([fact('expiry.sms.recipients', m.routes.sms.recipients, 'person', today)]),
  'promo-video': (m) => [
    fact('video.materials', m.materialsCount, 'count', today), fact('video.photos', m.photoCount, 'count', today),
    fact('video.praiseReviews', m.praiseCount, 'count', today), fact('video.posted.count', m.postedCount, 'count', today),
  ],
  'coupon-status': (m) => [
    fact('coupons.active', m.activeCount, 'count', today), fact('coupons.paused', m.pausedCount, 'count', today), fact('coupons.endingSoon', m.endingSoonCount, 'count', today),
    ...(m.monthUsed !== null ? [fact('coupons.used.month', m.monthUsed, 'count', { start: MONTH_START, end: TODAY })] : []),
    fact('coupons.used.running', m.runningUsed, 'count', today),
    ...m.rows.map((r) => fact('coupons.coupon.used', r.used ?? 0, 'count', { labelText: r.name, ...today })),
  ],
  'customer-groups': (m) => [
    fact('groups.churnRisk', m.counts['churn-risk'], 'person', today), fact('groups.firstVisit', m.counts['first-visit'], 'person', today),
    fact('groups.regular', m.counts.regular, 'person', today), fact('groups.reachOut', m.reachOut.count, 'person', today),
  ],
  'marketing-performance': (m) => [
    ...(m.rate !== null ? [fact('perf.rate', m.rate, 'percent', { start: m.period.start, end: m.period.end })] : []),
    ...(m.rateDelta ? [fact('perf.rate.delta', m.rateDelta.value, 'pp', { start: m.period.start, end: m.period.end })] : []),
    fact('perf.issued', m.issued, 'count', { start: m.period.start, end: m.period.end }), fact('perf.used', m.used, 'count', { start: m.period.start, end: m.period.end }),
    fact('perf.revenue', m.revenue.total, 'KRW', { start: m.period.start, end: m.period.end }),
    ...(m.revenueDelta ? [fact('perf.revenue.delta', m.revenueDelta.value, 'KRW', { start: m.period.start, end: m.period.end })] : []),
    fact('perf.profit', m.profit, 'KRW', { start: m.period.start, end: m.period.end }),
    ...(m.returnRate === null ? [] : [fact('perf.returnRate', m.returnRate, 'percent', { start: m.period.start, end: m.period.end })]),
    ...m.routes.filter((r) => r.rate !== null).map((r) => fact('perf.route.rate', r.rate as number, 'percent', { start: m.period.start, end: m.period.end, labelText: { key: routeNameKey(r.route) } })),
    ...(m.best?.rate != null ? [fact('perf.bestRoute', m.best.rate, 'percent', { start: m.period.start, end: m.period.end, labelText: { key: m.best.nameKey } })] : []),
  ],
};
