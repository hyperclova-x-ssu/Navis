/**
 * Widget condition source (DATA_MODEL 10.7, API-09 v4). State, widgets and Navis read conditions from here
 * (the iteration-3 query normalizer was removed in W4, T-055).
 */
import type { FeatureId, QueryCondition } from '../contracts';
import { addDays, isIsoDate, LAST_MONTH_END, LAST_MONTH_START, MONTH_START, TODAY, TOMORROW } from './db/time';
import { MARKETING_WIDGET_IDS } from './marketing/ids';

/** Active management (13) and original marketing (5); demand remains an internal reader. */
export const DATA_WIDGET_IDS = [
  'menu','inventory-booking','suppliers','ledger','margin','tax','members',
  'customer-analysis','manuals','grants','calendar','voice-booking','briefing','credit-receivable','staff-schedule','notice-send','store-environment','custom-order',
  'local-changes','trade-area','local-trends','ai-response','community',
] as const satisfies readonly FeatureId[];

/** plan-2 marketing widgets (7, T-058, DATA_MODEL 10.15.1). */
export { MARKETING_WIDGET_IDS };
/** Every widget the data module serves: 18 + 7 = 25 (API-200). Registration tables are keyed by these. */
export const ALL_DATA_WIDGET_IDS = [...DATA_WIDGET_IDS, ...MARKETING_WIDGET_IDS] as const satisfies readonly FeatureId[];

export type DataWidgetId = (typeof ALL_DATA_WIDGET_IDS)[number];

const idSet: ReadonlySet<string> = new Set(ALL_DATA_WIDGET_IDS);
export const isDataWidgetId = (id: unknown): id is DataWidgetId => typeof id === 'string' && idSet.has(id);

interface Range { readonly start: string; readonly end: string }
interface ConditionSpec {
  /** The concrete period that `{kind:'default'}` means (a dateRange equal to it normalizes to default). */
  readonly defaultRange?: Range;
  readonly ranges: readonly Range[];
  readonly snapshot?: string;
}

const none: ConditionSpec = { ranges: [] };
const today: Range = { start: TODAY, end: TODAY };

const specs: Readonly<Record<DataWidgetId, ConditionSpec>> = {
  briefing: { defaultRange: today, ranges: [] },
  ledger: { defaultRange: today, ranges: [{ start: addDays(TODAY, -6), end: TODAY }, { start: addDays(TODAY, -29), end: TODAY }, { start: MONTH_START, end: TODAY }] },
  margin: { defaultRange: today, ranges: [{ start: addDays(TODAY, -6), end: TODAY }, { start: addDays(TODAY, -29), end: TODAY }] },
  tax: { defaultRange: { start: MONTH_START, end: TODAY }, ranges: [{ start: LAST_MONTH_START, end: LAST_MONTH_END }] },
  grants: none,
  'customer-analysis': { defaultRange: today, ranges: [] },
  menu: none,
  members: none,
  'credit-receivable': none,
  'notice-send': none,
  'store-environment': none,
  'custom-order': none,
  'staff-schedule': { defaultRange: today, ranges: [] },
  'voice-booking': { defaultRange: today, ranges: [] },
  calendar: { defaultRange: today, ranges: [] },
  'inventory-booking': { ranges: [], snapshot: TODAY },
  suppliers: { defaultRange: { start: TODAY, end: addDays(TODAY, 6) }, ranges: [] },
  manuals: none,
  'local-changes': { defaultRange: { start: TODAY, end: addDays(TODAY, 6) }, ranges: [] },
  'trade-area': none,
  'local-trends': none,
  'ai-response': none,
  community: none,
  // plan-2 (DATA_MODEL 10.15.1, API-09 v4.1): defaults only, plus last month for marketing results.
  'marketing-today': { defaultRange: today, ranges: [] },
  'slot-coupon': { defaultRange: { start: TOMORROW, end: addDays(TOMORROW, 6) }, ranges: [] },
  'expiry-coupon': { defaultRange: today, ranges: [] },
  'promo-video': none,
  'coupon-status': { defaultRange: today, ranges: [] },
  'customer-groups': none,
  'marketing-performance': { defaultRange: { start: MONTH_START, end: TODAY }, ranges: [{ start: LAST_MONTH_START, end: LAST_MONTH_END }] },
};

const DEFAULT: QueryCondition = Object.freeze({ kind: 'default' });
const frozen = <T extends object>(value: T): T => Object.freeze(value);

export function defaultCondition(id: DataWidgetId): QueryCondition {
  const snapshot = specs[id].snapshot;
  return snapshot ? frozen({ kind: 'snapshot', asOf: snapshot }) : DEFAULT;
}

export function supportedConditions(id: DataWidgetId): readonly QueryCondition[] {
  return frozen([defaultCondition(id), ...specs[id].ranges.map((r) => frozen({ kind: 'dateRange' as const, start: r.start, end: r.end }))]);
}

export type ConditionCode = 'UNKNOWN_FEATURE' | 'UNSUPPORTED_CONDITION' | 'INVALID_CONDITION';
export type ConditionResult = { readonly ok: true; readonly value: QueryCondition } | { readonly ok: false; readonly code: ConditionCode };

/** Normalizes a widget condition. Unsupported periods are rejected, never replaced by another period. */
export function normalizeCondition(id: FeatureId | string, condition: QueryCondition): ConditionResult {
  if (!isDataWidgetId(id)) return { ok: false, code: 'UNKNOWN_FEATURE' };
  const c = condition as Partial<{ kind: string; start: unknown; end: unknown; asOf: unknown }> | null;
  if (!c || typeof c !== 'object') return { ok: false, code: 'INVALID_CONDITION' };
  const spec = specs[id];
  if (c.kind === 'default') return { ok: true, value: defaultCondition(id) };
  if (c.kind === 'dateRange') {
    if (!isIsoDate(c.start) || !isIsoDate(c.end) || c.start > c.end) return { ok: false, code: 'INVALID_CONDITION' };
    const { start, end } = c;
    if (spec.defaultRange && spec.defaultRange.start === start && spec.defaultRange.end === end) return { ok: true, value: defaultCondition(id) };
    const match = spec.ranges.find((r) => r.start === start && r.end === end);
    return match ? { ok: true, value: frozen({ kind: 'dateRange', start, end }) } : { ok: false, code: 'UNSUPPORTED_CONDITION' };
  }
  if (c.kind === 'snapshot') {
    if (!isIsoDate(c.asOf)) return { ok: false, code: 'INVALID_CONDITION' };
    return spec.snapshot === c.asOf ? { ok: true, value: defaultCondition(id) } : { ok: false, code: 'UNSUPPORTED_CONDITION' };
  }
  return { ok: false, code: 'INVALID_CONDITION' };
}

/** Stable memo key for a normalized condition. */
export function conditionKey(condition: QueryCondition): string {
  if (condition.kind === 'dateRange') return `range:${condition.start}~${condition.end}`;
  if (condition.kind === 'snapshot') return `snapshot:${condition.asOf}`;
  return 'default';
}

/** The concrete date period a normalized condition covers (for models). */
export function periodOf(id: DataWidgetId, condition: QueryCondition): Range | null {
  if (condition.kind === 'dateRange') return { start: condition.start, end: condition.end };
  if (condition.kind === 'snapshot') return { start: condition.asOf, end: condition.asOf };
  return specs[id].defaultRange ?? null;
}
