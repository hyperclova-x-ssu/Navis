/**
 * Public entry of the mgmt-supply widget group (API-201): 캘린더 · 재고 · 발주.
 * The registry (`src/features/widgets/registry.ts`, T-054) globs `./*\/index.ts` and reads `widgets`.
 */
import type { WidgetModule } from '../../../contracts';
import { calendarWidget } from './calendar';
import { inventoryWidget } from './inventory';
import { suppliersWidget } from './suppliers';

export const widgets: readonly WidgetModule[] = Object.freeze([calendarWidget, inventoryWidget, suppliersWidget]);
export { mgmtSupplyBundle, mgmtSupplyR2Review } from './messages';
