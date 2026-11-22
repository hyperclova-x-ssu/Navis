/**
 * mkt-promo widget folder (T-060, API-13 v4.1; promo-video T-083, API-13 v4.4): 오늘 할 홍보 · AI 홍보 영상. (마케팅 성과 left the catalog in D-365.)
 * The registry (T-054) collects `widgets` with import.meta.glob on each folder's index.ts; the bundle is the folder's own message set.
 */
import type { WidgetModule } from '../../../contracts';
import { marketingTodayModule } from './marketing-today';
import { promoVideoModule } from './promo-video';
import { mktPromoBundle } from './messages';

export const widgets: readonly WidgetModule[] = Object.freeze([marketingTodayModule, promoVideoModule]);
export const bundles = Object.freeze([mktPromoBundle]);
export { mktPromoBundle, mktPromoR2Review, MKT_PROMO_KO_ONLY_KEYS } from './messages';
export { promoSession } from './promo-session';
