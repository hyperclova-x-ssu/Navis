/**
 * T-043 message bundles (API-12 MessageBundle shape; prefixes `data.*` and `preview.variant.*`,
 * ARCHITECTURE 11.6). Plain objects — the data module never runs i18n code (type-only import).
 */
import type { MessageBundle } from '../../i18n';
import { posDataBundle } from './pos';
import { customOrderGuardRows, iteration7DataKorean, iteration7VariantKorean } from './iteration7';
import { managementBundle, managementVariantLabels, managementKoreanOverrides } from './management';
import { DATA_WIDGET_IDS, type DataWidgetId } from '../conditions';
import { ALL_VARIANTS, variantLabelKey } from '../preview/variants';
import { sourcedRows, VARIANT_ERROR_LABEL, VARIANT_NEEDS_REVIEW_LABEL, VARIANT_PARTIAL_LABEL, widgetNames, type Row } from './sourced';
import { errorTemplates, variantLabelRows, writtenRows } from './written';
import { MARKETING_WIDGET_IDS, isMarketingWidgetId, type MarketingWidgetId } from '../marketing/ids';
import { marketingSourcedRows, marketingVariantLabelRows, marketingWidgetNames, marketingWrittenRows } from '../marketing/messages';

type Lang = 'ko' | 'en' | 'zh-Hans' | 'zh-Hant';
const LANGS: readonly Lang[] = ['ko', 'en', 'zh-Hans', 'zh-Hant'];

/** Korean object particle 을/를 by the final syllable (local helper; no i18n runtime import). */
const objectParticle = (word: string): string => {
  const code = word.charCodeAt(word.length - 1);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? '을' : '를';
};
const SPECIFIC_ERRORS: ReadonlySet<DataWidgetId> = new Set(['inventory-booking', 'suppliers','credit-receivable','notice-send','store-environment','custom-order']);
const generatedErrorRows: Readonly<Record<string, Row>> = Object.fromEntries(
  DATA_WIDGET_IDS.filter((id): id is Exclude<typeof id, 'menu' | 'members'> => id !== 'menu' && id !== 'members' && !SPECIFIC_ERRORS.has(id)).map((id) => {
    const [ko, en, hans, hant] = widgetNames[id];
    return [`data.state.${id}.error`, [errorTemplates.ko(ko, objectParticle(ko)), errorTemplates.en(en), errorTemplates['zh-Hans'](hans), errorTemplates['zh-Hant'](hant)] as Row];
  }),
);

/** plan-2 (T-058): the same generated error sentence for the 7 marketing widgets (LOCALES 4.1 names). */
const marketingErrorRows: Readonly<Record<string, Row>> = Object.fromEntries(MARKETING_WIDGET_IDS.map((id) => {
  const [ko, en, hans, hant] = marketingWidgetNames[id];
  return [`data.state.${id}.error`, [errorTemplates.ko(ko, objectParticle(ko)), errorTemplates.en(en), errorTemplates['zh-Hans'](hans), errorTemplates['zh-Hant'](hant)] as Row];
}));

const variantRows: Readonly<Record<string, Row>> = Object.fromEntries(ALL_VARIANTS.filter(([id, v]) => !['credit-receivable','notice-send','store-environment','custom-order'].includes(id) && id !== 'staff-schedule' && id !== 'menu' && id !== 'members' && v.id !== 'camera-disconnected' && v.id !== 'partial-data').map(([id, v]) => {
  const short = `${id}.${v.id}`;
  const row: Row | undefined = v.id === 'error' ? VARIANT_ERROR_LABEL
    : short === 'tax.missing-data' || (isMarketingWidgetId(id) && v.id === 'partial') ? VARIANT_PARTIAL_LABEL
      : short === 'inventory-booking.needs-review' ? VARIANT_NEEDS_REVIEW_LABEL
        : ({ ...variantLabelRows, ...marketingVariantLabelRows } as Readonly<Record<string, Row>>)[short];
  if (!row) throw new Error(`Missing sample-state label for ${short}`);
  return [variantLabelKey(id, v.id), row];
}));

export type DataMessageKey = keyof typeof sourcedRows | keyof typeof writtenRows | keyof typeof marketingSourcedRows | keyof typeof marketingWrittenRows | keyof typeof customOrderGuardRows | `data.state.${DataWidgetId | MarketingWidgetId}.error`;
export type PreviewVariantMessageKey = `preview.variant.${string}`;

function toBundle<K extends string>(id: string, rows: Readonly<Record<string, Row>>): MessageBundle<K> {
  const pick = (index: number) => Object.freeze(Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row[index]]))) as Readonly<Record<K, string>>;
  const [ko, en, hans, hant] = LANGS.map((_, i) => pick(i));
  return Object.freeze({ id, ko, en, 'zh-Hans': hans, 'zh-Hant': hant });
}

/** `data.*`: fake-data names, bodies, states, notices, errors, fact labels. */
export const dataBundle: MessageBundle<DataMessageKey> = withKorean(toBundle('data', { ...sourcedRows, ...writtenRows, ...generatedErrorRows, ...marketingSourcedRows, ...marketingWrittenRows, ...marketingErrorRows, ...customOrderGuardRows }), { ...managementKoreanOverrides, ...iteration7DataKorean });
/** `preview.variant.*`: sample-state variant names for SCR-29. */
export const previewVariantBundle: MessageBundle<PreviewVariantMessageKey> = withKorean(toBundle('preview.variant', variantRows), { ...managementVariantLabels, ...iteration7VariantKorean });
/** Both T-043 bundles (for translators that load every data string, e.g. Navis request assembly). */
export const dataBundles: readonly MessageBundle<string>[] = [dataBundle, previewVariantBundle, managementBundle, posDataBundle];

/**
 * “R2 검토 필요 문구 수”: en + zh-Hans + zh-Hant strings T-043 wrote (not taken verbatim from
 * LOCALES / plan-1 / DS 11.7). Generated per-widget errors come from 3 written templates.
 */
const written = { rows: Object.keys(writtenRows).length, variantLabels: Object.keys(variantLabelRows).length, generatedErrors: Object.keys(generatedErrorRows).length };
export const r2Review = Object.freeze({
  writtenRows: written.rows,
  variantLabelRows: written.variantLabels,
  generatedErrorRows: written.generatedErrors,
  strings: (written.rows + written.variantLabels + written.generatedErrors) * 3,
});
/** T-058 “R2 검토 필요 문구 수” (en + zh-Hans + zh-Hant of the rows T-058 wrote; generated marketing errors use T-043's templates). */
export const marketingR2Review = Object.freeze({
  writtenRows: Object.keys(marketingWrittenRows).length,
  variantLabelRows: Object.keys(marketingVariantLabelRows).length,
  generatedErrorRows: Object.keys(marketingErrorRows).length,
  strings: (Object.keys(marketingWrittenRows).length + Object.keys(marketingVariantLabelRows).length + Object.keys(marketingErrorRows).length) * 3,
});
/** Every T-058 row (sourced, written, generated) — for overlap checks in tests. */
export const marketingRowKeys: readonly string[] = [...Object.keys(marketingSourcedRows), ...Object.keys(marketingWrittenRows), ...Object.keys(marketingErrorRows)];

function withKorean<K extends string>(bundle: MessageBundle<K>, ko: Readonly<Record<string, string>>): MessageBundle<K> {
  const drop = (rows: Readonly<Partial<Record<K, string>>> | undefined) => Object.fromEntries(Object.entries(rows ?? {}).filter(([key]) => !Object.hasOwn(ko, key)));
  return Object.freeze({ ...bundle, ko: { ...bundle.ko, ...ko }, en: drop(bundle.en), 'zh-Hans': drop(bundle['zh-Hans']), 'zh-Hant': drop(bundle['zh-Hant']) }) as MessageBundle<K>;
}
