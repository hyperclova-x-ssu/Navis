/**
 * Sample-state variants (DATA_MODEL 10.12, SCR-29). A variant only changes that widget's own view;
 * other models, Navis facts, briefing and calendar always read the normal variant.
 */
import type { FeatureId, PreviewFamily, PreviewSelection } from '../../contracts';
import { ALL_DATA_WIDGET_IDS, isDataWidgetId, type DataWidgetId } from '../conditions';
import { MARKETING_VARIANTS } from '../marketing/variants';

export type VariantFamily = Exclude<PreviewFamily, 'normal'>;
/** `empty`: generic empty view with `messageKey`/`actionKey`; `custom`: the widget projector builds it (ready + notes, or empty + partial). */
export interface VariantDef { readonly id: string; readonly family: VariantFamily; readonly mode: 'empty' | 'custom' | 'error'; readonly actionKey?: string }

const E = (id: string, actionKey?: string): VariantDef => ({ id, family: 'empty', mode: 'empty', ...(actionKey ? { actionKey } : {}) });
const S = (id: string, mode: 'empty' | 'custom' = 'custom', actionKey?: string): VariantDef => ({ id, family: 'special', mode, ...(actionKey ? { actionKey } : {}) });
const C = (id: string, family: VariantFamily = 'empty'): VariantDef => ({ id, family, mode: 'custom' });
const ERR: VariantDef = { id: 'error', family: 'error', mode: 'error', actionKey: 'data.action.retry' };

/** Order inside a family = DATA_MODEL 10.12 column order (first = what the family picks). */
const table: Readonly<Record<DataWidgetId, readonly VariantDef[]>> = {
  'credit-receivable': [E('empty'),ERR],
  'notice-send': [E('empty'), ERR],
  'store-environment': [E('empty'),S('out_of_range'),S('sensor_disconnected'),ERR],
  'custom-order': [E('empty'),ERR],
  'staff-schedule': [E('no-staff', 'data.staff.action.add'), ERR],
  menu: [E('no-menus', 'data.management.action.addMenu'), ERR],
  members: [E('no-members', 'data.management.action.addMember'), ERR],
  briefing: [E('none'), S('partial'), ERR],
  ledger: [E('no-sales'), S('no-expenses'), ERR],
  margin: [E('no-sales'), S('missing-cost'), S('zero-net', 'empty'), ERR],
  tax: [C('all-checked'), S('missing-data'), ERR],
  grants: [E('none'), S('needs-check'), ERR],
  // 비어 있음 = no camera connected ('카메라 연결이 필요해요', LOCALES 11 / AC-1075); 0건 (`no-entries`) is its own sample.
  'customer-analysis': [E('no-cameras', 'data.action.connect'), C('no-entries'), S('camera-disconnected'), S('gaps'), S('no-coverage', 'empty'), S('no-shifts'), ERR],
  'voice-booking': [E('none'), S('needs-confirmation'), E('phone-disconnected', 'data.action.connect'), ERR],
  calendar: [E('none', 'data.action.addEvent'), S('source-failed'), ERR],
  'inventory-booking': [E('no-items', 'data.action.registerItem'), S('partial-data'), S('partial-zero'), S('needs-review', 'empty'), C('no-restock'), C('no-products'), ERR],
  suppliers: [E('no-suppliers', 'data.action.registerSupplier'), S('overdue'), C('no-upcoming'), ERR],
  manuals: [E('none', 'data.action.createManual'), ERR],
  'local-changes': [E('none'), S('region-unsupported', 'empty'), ERR],
  'trade-area': [E('none'), S('region-unsupported', 'empty'), ERR],
  'local-trends': [E('insufficient'), S('region-unsupported', 'empty'), ERR],
  'ai-response': [E('none'), S('channel-disconnected', 'empty', 'data.action.connect'), S('send-failure'), ERR],
  community: [E('none', 'data.action.browseOffers'), ERR],
  // plan-2 (DATA_MODEL 10.15.5, T-058)
  ...MARKETING_VARIANTS,
};

export const NORMAL_VARIANT = 'normal';
export const variantMessageKey = (id: DataWidgetId, variant: string): string => `data.state.${id}.${variant}`;
export const variantLabelKey = (id: DataWidgetId, variant: string): string => `preview.variant.${id}.${variant}`;

export function variantDefs(id: DataWidgetId): readonly VariantDef[] {
  return table[id];
}
export function findVariant(id: DataWidgetId, variant: string): VariantDef | undefined {
  return table[id].find((v) => v.id === variant);
}

const listCache = new Map<DataWidgetId, readonly { id: string; family: VariantFamily; labelKey: string }[]>();
/** API-09 v4 `previewVariants`: every non-normal variant of the widget in table order. */
export function previewVariants(featureId: FeatureId): readonly { readonly id: string; readonly family: VariantFamily; readonly labelKey: string }[] {
  if (!isDataWidgetId(featureId)) return [];
  let list = listCache.get(featureId);
  if (!list) {
    list = Object.freeze(table[featureId].map((v) => Object.freeze({ id: v.id, family: v.family, labelKey: variantLabelKey(featureId, v.id) })));
    listCache.set(featureId, list);
  }
  return list;
}

/** API-09 v4 `resolveVariant`: overrides[id] → family's first variant → first `empty` variant → normal. */
export function resolveVariant(featureId: FeatureId, preview: PreviewSelection | null | undefined): string {
  if (!isDataWidgetId(featureId) || !preview) return NORMAL_VARIANT;
  const override = preview.overrides?.[featureId];
  if (override === NORMAL_VARIANT) return NORMAL_VARIANT;
  if (typeof override === 'string' && findVariant(featureId, override)) return override;
  if (preview.family === NORMAL_VARIANT) return NORMAL_VARIANT;
  const defs = table[featureId];
  return (defs.find((v) => v.family === preview.family) ?? defs.find((v) => v.family === 'empty'))?.id ?? NORMAL_VARIANT;
}

export const ALL_VARIANTS: readonly (readonly [DataWidgetId, VariantDef])[] = ALL_DATA_WIDGET_IDS.flatMap((id) => table[id].map((v) => [id, v] as const));

export function resolveClosingVariant(preview: PreviewSelection | null | undefined): 'normal' | 'no-payments' | 'error' {
  if (preview?.closing) return preview.closing;
  return preview?.family === 'empty' ? 'no-payments' : preview?.family === 'error' ? 'error' : 'normal';
}
export function previewViewContext(preview: PreviewSelection | null | undefined) {
  return { cameraDisconnected: resolveVariant('customer-analysis', preview) === 'camera-disconnected', environmentVariant: resolveVariant('store-environment', preview), reservationVariant: resolveVariant('voice-booking', preview) };
}
