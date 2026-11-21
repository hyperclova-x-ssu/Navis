/**
 * Public entry of the fake DB / widget models / data commands (API-09 v4, ADR-0003).
 * Non-React; the React adapter is `src/data/react.tsx`. The legacy v3 `read/normalize`
 * path (`src/data/index.ts`) was removed in W4 (T-055).
 */
export { createWidgetDataStore, type WidgetDataStore, type DataStoreOptions } from './db/store';
export { selectStaffSchedule } from './iteration7/staff/selectors';
export type * from './iteration7/staff/types';
export { selectWidget, readModel } from './models/select';
export { simulateMenuPrice } from './models/money';
export { previewVariants, resolveVariant, variantDefs, variantLabelKey, variantMessageKey, NORMAL_VARIANT, type VariantFamily } from './preview/variants';
export { NORMAL_PREVIEW } from './preview/selection';
export { DATA_WIDGET_IDS, MARKETING_WIDGET_IDS, ALL_DATA_WIDGET_IDS, isDataWidgetId, defaultCondition, supportedConditions, normalizeCondition, conditionKey, type DataWidgetId, type ConditionResult, type ConditionCode } from './conditions';
export { TODAY, NOW, NOW_TIME, LEGACY_BOOKING_VIEW_TIME, TOMORROW, YESTERDAY, WEEK_START, WEEK_END, MONTH_START, MINIMUM_WAGE } from './db/time';
export { resolveDataText, type Translate } from './text';
export { widgetFacts, posFacts, selectPosFacts, type ModelFact } from './facts';
export { dataBundle, previewVariantBundle, dataBundles, type DataMessageKey, type PreviewVariantMessageKey } from './messages';
export type { DataCommand, DataCommandType, DataCommandResult, DataErrorCode } from './commands/types';
export type { DataSnapshot, DataTables, SeedOverrides, DataText, UnitCode, TextParams, ExpenseCategory, Evidence, Channel, CalendarSource, ManualCategory, Mood, Material, Zone } from './db/types';
export type * from './models/types';
/* plan-2 marketing (API-09 v4.1, T-058): pure calculations shared by screens and Navis, and the model/command types. */
export { roundPercent, ratePercent, expiryDiscount, benefitComparison, QUIET_THRESHOLD_PERCENT, RECOMMENDED_EXPIRY_RATE, PUBLIC_ISSUE_LIMIT, EXTEND_DAYS, ENDING_SOON_DAYS, MIN_PROMO_PHOTOS } from './marketing/calc';
export { COUPON_BENEFIT_KINDS, benefitMax, benefitName, benefitPrice, benefitProblem, couponBenefit, expiryCouponName, expiryPostText, expirySmsBody } from './marketing/benefit';
export { isMarketingWidgetId, type MarketingWidgetId } from './marketing/ids';
export type * from './marketing/types';

export type * from './db/management-types';
export type * from './commands/management-types';
export { deriveRecipeCost, deriveUsage, deriveStock, selectStockHistory, deriveOpenOrders, deriveSuggestions } from './derive/stock';
export { selectPayments, selectClosing } from './derive/payments';
export { selectMembers, maskCustomer } from './derive/members';
export { selectReservations, deriveReservations, tableLayoutEnabled } from './derive/reservations';
export { selectPosBriefing, selectBriefing, selectCalendar, selectCameras, selectTaxPayments } from './derive/operations';
export { DataQueryError } from './derive/common';

export { readDemand, readMemberships, readInternalModel, type InternalModelId } from './models/select';
export { selectMenus } from './derive/menu';

export { demandFacts } from './facts';
export { resolveClosingVariant, previewViewContext } from './preview/variants';

/** API-212 settings source, shared by the setup screen and session coordinator. */
export const selectShopSettings = (snapshot: import('./db/types').DataSnapshot): import('../contracts').ShopSettings => snapshot.tables.shopSettings;

/** API-243 live management adapters for the POS runtime and closing readers. */
export { selectPosDataRead } from './pos/catalog';
export { selectPosCouponPerformance } from './pos/loyalty';
export { projectPosDay } from './pos/projection';
export { selectPosPayments } from './derive/payments';
export type { DataSessionInput } from './db/store';

export { selectPosClosing, selectPosClosingHistory, type PosClosingQuery, type PosClosingHistoryRow, type PosHistoricalDrawer } from './pos/closing';

export * from './iteration7/notices';
export * from './iteration7/environment';
export * from './iteration7/custom-orders';
export { initializeCustomPos, selectCustomOrderRead, selectM2DayTotals, selectM2Drawer } from './pos/projection';
