/**
 * Analysis answers (SCR-23): numbers come from the data store's facts (the same ones the widgets show),
 * words and formats from the setting's language (D-55). Recognizes the request in all four languages.
 */
import type { FeatureId, Locale, PanelSpec, QueryCondition } from '../../contracts';
import { TODAY } from '../../data/widget-data';
import { addDays, dateRange } from '../../data/db/time';
import { navisTranslator } from './messages';
import { inventoryIngredientKey } from './inventory-ingredients';
import { norm } from './simple';
import { defaultStore, localizeFact, normalizeFor, storeFactSource, type WidgetFactSource } from './snapshot';

export interface AnalysisMetric { label: string; value: number | string; /** Text for the card, formatted for the language. */ display: string; unit: string; factKeys: readonly string[] }
export interface AnalysisAnswer { kind: 'analysis'; sourceKey: string; condition: QueryCondition; periodLabel: string; metrics: readonly AnalysisMetric[]; interpretation: string; suggestions: readonly PanelSpec[] }
type AnalysisResult = { ok: true; answer: AnalysisAnswer } | { ok: false; code: 'DATA_UNAVAILABLE' | 'UNSUPPORTED_CONDITION' | 'INVALID_CONDITION' | 'UNRECOGNIZED'; periodLabel?: string };
export interface AnalysisOptions { readonly locale?: Locale; readonly source?: WidgetFactSource }

const WEEK = { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY } as const;
const w = (...words: string[]) => words.map(norm);
const ANALYZE = w('분석', 'analy', '分析');
const SALES = w('매출', 'sales', 'revenue', '销售', '銷售', '营业', '營業', '收入');
const LAST7 = w('최근7일', '최근일주일', 'last7', 'past7', '最近7天', '最近七天', '近7天', '近七天');
const STOCK = w('재고', 'stock', 'inventory', '库存', '庫存');
const LOW = w('부족', 'low', 'short', '不足');
const CUSTOMER = w('손님', '고객', 'customer', 'guest', 'visitor', '客人', '顾客', '顧客', '访客', '訪客');
const BUSY = w('많은', 'busy', 'busiest', 'peak', '多', '高峰');
const TIME = w('시간', 'hour', 'time', 'when', '时', '時');
const PERIOD = w('지난', '이번', '최근', 'last', 'this', '上', '这', '這', '本', '昨', '去年');
const any = (key: string, words: readonly string[]) => words.some((word) => key.includes(word));

type Kind = 'ledger' | 'inventory' | 'customer';
type Classified = { kind: Kind } | { code: 'UNSUPPORTED_CONDITION' | 'INVALID_CONDITION' } | null;
function classify(text: string): Classified {
  const key = norm(text);
  const dates = text.match(/\d{4}-\d{2}-\d{2}/gu) ?? [];
  const invalid = dates.some((date) => { const d = new Date(`${date}T00:00:00Z`); return Number.isNaN(d.valueOf()) || d.toISOString().slice(0, 10) !== date; });
  const hasPeriod = dates.length > 0 || any(key, PERIOD);
  let kind: Kind | null = null; let supported = false;
  if (any(key, ANALYZE) && any(key, SALES)) { kind = 'ledger'; supported = any(key, LAST7) && !dates.length; }
  else if (any(key, STOCK) && any(key, LOW)) { kind = 'inventory'; supported = !hasPeriod; }
  else if (any(key, CUSTOMER) && any(key, BUSY) && any(key, TIME)) { kind = 'customer'; supported = !hasPeriod; }
  if (!kind) return null;
  if (invalid) return { code: 'INVALID_CONDITION' };
  return supported ? { kind } : { code: 'UNSUPPORTED_CONDITION' };
}
export function isAnalysisRequest(text: string) { return classify(text) !== null; }
const FEATURE: Record<Kind, FeatureId> = { ledger: 'ledger', inventory: 'inventory-booking', customer: 'customer-analysis' };

export async function analyzeText(text: string, options: AnalysisOptions = {}): Promise<AnalysisResult> {
  const locale = options.locale ?? 'ko';
  const source = options.source ?? storeFactSource(defaultStore());
  const tr = navisTranslator(locale); const f = tr.format;
  const hit = classify(text);
  if (!hit) return { ok: false, code: 'UNRECOGNIZED' };
  if ('code' in hit) return { ok: false, code: hit.code };
  const featureId = FEATURE[hit.kind];
  const condition = normalizeFor(featureId, hit.kind === 'ledger' ? WEEK : { kind: 'default' });
  if (!condition) return { ok: false, code: 'UNSUPPORTED_CONDITION' };
  const date = condition.kind === 'snapshot' ? condition.asOf : TODAY;
  const periodLabel = hit.kind === 'ledger' ? f.dateRange(WEEK.start, WEEK.end)
    : tr.t(hit.kind === 'inventory' ? 'navis.analysis.asOf' : 'navis.analysis.today', { date: f.date(date, 'monthDay') });
  const unavailable = { ok: false as const, code: 'DATA_UNAVAILABLE' as const, periodLabel };
  const view = source.view(featureId, condition);
  const facts = view.status === 'ready' ? source.facts(view) : [];
  if (!facts.length) return unavailable;
  const shown = facts.map((fact) => localizeFact(fact, locale));
  const get = (key: string, labelKey?: string) => {
    const i = facts.findIndex((fact) => fact.key === key && (!labelKey || (inventoryIngredientKey(fact.labelText) === labelKey)));
    return i < 0 ? undefined : { raw: facts[i], shown: shown[i] };
  };
  const num = (x: { raw: { value: number | string } } | undefined) => (x && typeof x.raw.value === 'number' && Number.isFinite(x.raw.value) ? x.raw.value : undefined);
  const metric = (label: string, value: number | string, display: string, unit: string, ...factKeys: string[]): AnalysisMetric => ({ label, value, display, unit, factKeys });
  let metrics: AnalysisMetric[]; let interpretation: string;
  if (hit.kind === 'ledger') {
    const days = facts.filter((fact) => fact.key === 'ledger.sales.daily' && fact.date && fact.date >= WEEK.start && fact.date <= WEEK.end).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    const expectedDays = dateRange(WEEK.start, WEEK.end);
    if (days.length !== expectedDays.length || days.some((fact, i) => typeof fact.value !== 'number' || fact.date !== expectedDays[i])) return unavailable;
    const total = days.reduce((sum, fact) => sum + (fact.value as number), 0);
    const peak = days.reduce((a, b) => ((b.value as number) > (a.value as number) ? b : a));
    const day = f.date(peak.date!, 'monthDay');
    metrics = [
      metric(tr.t('navis.analysis.total'), total, f.money(total, 'compact'), 'KRW', 'ledger.sales.daily'),
      metric(tr.t('navis.analysis.average'), Math.round(total / 7), f.money(Math.round(total / 7), 'compact'), 'KRW', 'ledger.sales.daily'),
      metric(tr.t('navis.analysis.peakDay', { date: day }), peak.value, f.money(peak.value as number, 'compact'), 'KRW', 'ledger.sales.daily'),
    ];
    interpretation = tr.t('navis.analysis.ledgerNote', { date: day });
  } else if (hit.kind === 'inventory') {
    const restock = get('inventory.restock.count'); const milk = get('inventory.stock', 'data.item.milk'); const beans = get('inventory.stock', 'data.item.beans');
    if (!restock || !milk || !beans || [restock, milk, beans].some((x) => num(x) === undefined)) return unavailable;
    metrics = [
      metric(tr.t('navis.analysis.restock'), num(restock)!, restock.shown.display, restock.raw.unit, 'inventory.restock.count'),
      ...[milk, beans].map((x) => metric(x.shown.label, num(x)!, x.shown.display, x.raw.unit, 'inventory.stock')),
    ];
    interpretation = tr.t('navis.analysis.inventoryNote');
  } else {
    const visits = get('cctv.visits.total'); const hour = get('cctv.peak.hour'); const staff = get('cctv.peak.staff');
    if (!visits || !hour || !staff || [visits, hour, staff].some((x) => num(x) === undefined)) return unavailable;
    const h = num(hour)!;
    metrics = [
      metric(tr.t('navis.analysis.visits'), num(visits)!, visits.shown.display, visits.raw.unit, 'cctv.visits.total'),
      metric(tr.t('navis.analysis.busyHour'), h, f.hourRange(h, h + 1), 'hour', 'cctv.peak.hour'),
      metric(tr.t('navis.analysis.staff'), num(staff)!, staff.shown.display, staff.raw.unit, 'cctv.peak.staff'),
    ];
    interpretation = tr.t('navis.analysis.customerNote');
  }
  return { ok: true, answer: { kind: 'analysis', sourceKey: `widget:${featureId}`, condition, periodLabel, metrics, interpretation, suggestions: [{ featureId, width: hit.kind === 'ledger' ? 2 : 1, height: 1, condition }] } };
}
