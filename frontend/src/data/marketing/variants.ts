/**
 * Sample-state variants of the 7 marketing widgets (DATA_MODEL 10.15.5, SCR-43·8.8). Same shape and
 * family order as `preview/variants.ts`; a variant only changes that widget's own view.
 */
import type { VariantDef } from '../preview/variants';
import type { MarketingWidgetId } from './ids';

const E = (id: string, actionKey?: string): VariantDef => ({ id, family: 'empty', mode: 'empty', ...(actionKey ? { actionKey } : {}) });
const S = (id: string): VariantDef => ({ id, family: 'special', mode: 'custom' });
/** Extra variant chosen through `overrides` (listed under `empty`, built by the projector). */
const X = (id: string): VariantDef => ({ id, family: 'empty', mode: 'custom' });
const ERR: VariantDef = { id: 'error', family: 'error', mode: 'error', actionKey: 'data.action.retry' };

export const MARKETING_VARIANTS: Readonly<Record<MarketingWidgetId, readonly VariantDef[]>> = {
  'marketing-today': [E('none', 'data.marketing.action.viewActiveCoupons'), S('partial'), ERR],
  'slot-coupon': [E('no-slots'), S('consent-mixed'), X('no-regulars'), ERR],
  'expiry-coupon': [E('none'), S('partial'), ERR],
  'promo-video': [E('few-photos'), ERR],
  'coupon-status': [E('none', 'data.marketing.action.viewTodayPromotions'), S('partial'), ERR],
  'customer-groups': [E('no-history'), S('partial'), ERR],
  'marketing-performance': [E('no-redemptions'), S('partial'), ERR],
};
