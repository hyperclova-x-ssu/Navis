/**
 * plan-2 marketing widgets served by the data module (DATA_MODEL 10.15.1, D-64). No imports: the
 * condition source reads this list.
 */
export const MARKETING_WIDGET_IDS = [
  'marketing-today', 'slot-coupon', 'expiry-coupon', 'promo-video', 'coupon-status', 'customer-groups', 'marketing-performance',
] as const;

export type MarketingWidgetId = (typeof MARKETING_WIDGET_IDS)[number];

const idSet: ReadonlySet<string> = new Set(MARKETING_WIDGET_IDS);
export const isMarketingWidgetId = (id: unknown): id is MarketingWidgetId => typeof id === 'string' && idSet.has(id);
