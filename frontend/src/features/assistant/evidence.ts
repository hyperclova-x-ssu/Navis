import { validateAgentDetailRef, type AgentSourceId } from '../../../shared/navis-agent-schema.mjs';
import { getRegistration } from '../../catalog';
import type { DetailRef, FeatureId, QueryCondition } from '../../contracts';
import { normalizeCondition } from '../../data/conditions';
import { isIsoDate, isTime } from '../../data/db/time';
import type { Translator } from '../../i18n';
import { destinationOpenLabel } from './destinations';
import { navisTranslator } from './messages';
import type { AgentReadEvidence, SnapshotFact } from './snapshot';

export interface VerifiedAnswerFact {
  readonly fact: SnapshotFact;
  /** Store-local metadata from the producing read or calculation. */
  readonly timeRange?: { readonly start: string; readonly end: string };
  readonly asOf?: string;
}

type EvidenceDestination = Pick<DetailRef, 'featureId' | 'view' | 'date' | 'condition'>;

export interface EvidenceRow {
  readonly source: string;
  readonly periodLabel: string;
  readonly destination?: EvidenceDestination;
  readonly openLabel?: string;
}

const format = navisTranslator('ko').format;
const sourceNames: Readonly<Record<AgentSourceId, string>> = {
  pos: '주문/결제', demand: '손님 예측 자료', 'promo-estimate': '홍보 영상 예상 자료', 'promo-references': '홍보 영상 참고 자료',
};

// These detail entries open a viewing surface without a draft, prefill, or action focus.
const readOnlyViews: Partial<Record<FeatureId, string | true>> = {
  menu: 'list',
  'custom-order': true,
  'inventory-booking': 'ingredients',
  suppliers: 'orders',
  ledger: 'sales',
  margin: 'items',
  tax: 'checks',
  'credit-receivable': 'history',
  members: 'list',
  'customer-analysis': true,
  'store-environment': 'sensor',
  manuals: 'handover',
  grants: 'notices',
  'staff-schedule': 'week',
  calendar: 'day',
  'voice-booking': 'date',
  briefing: 'alerts',
  'local-changes': 'open',
  'trade-area': true,
  'local-trends': 'keywords',
  'ai-response': 'message',
  community: 'received',
  'notice-send': 'history',
  'coupon-status': 'active',
  'customer-groups': 'regular',
};

function widgetDestination(featureId: FeatureId, fact: SnapshotFact, condition: QueryCondition): EvidenceDestination | undefined {
  let view = readOnlyViews[featureId];
  if (!view) return;
  if (featureId === 'ledger' && fact.key.startsWith('ledger.evidence.')) view = 'evidence';
  if (featureId === 'ledger' && fact.key.startsWith('ledger.expense')) view = 'expenses';
  if (featureId === 'ai-response' && (fact.key.startsWith('inquiry.reviews.') ||
    ['inquiry.waiting.review', 'inquiry.rating', 'inquiry.praise'].includes(fact.key))) view = 'review';
  const destination = { featureId, ...(view === true ? {} : { view }) };
  if (!validateAgentDetailRef(destination)) return;
  if (condition.kind === 'default') return destination;
  if (condition.kind === 'dateRange' && condition.start === condition.end) {
    const dated = { ...destination, date: condition.start };
    if (validateAgentDetailRef(dated)) return dated;
  }
  const normalized = normalizeCondition(featureId, condition);
  if (!normalized.ok) return;
  if (normalized.value.kind !== 'dateRange') return destination;
  const scoped = { ...destination, condition: normalized.value };
  return validateAgentDetailRef(scoped) ? scoped : undefined;
}

function dateRange(start: string, end: string): string {
  if (start === end) return format.date(start, 'monthDay');
  if (start.slice(0, 4) === end.slice(0, 4)) return format.dateRange(start, end);
  return `${start.slice(0, 4)}년 ${format.date(start, 'monthDay')}~${end.slice(0, 4)}년 ${format.date(end, 'monthDay')}`;
}

function periodLabel({ fact, timeRange, asOf }: VerifiedAnswerFact, condition?: QueryCondition): string | undefined {
  if (asOf && isIsoDate(asOf)) return `${format.date(asOf, 'monthDay')} 기준`;
  if (asOf?.length === 16 && asOf[10] === 'T' && isIsoDate(asOf.slice(0, 10)) && isTime(asOf.slice(11))) {
    return `${format.date(asOf.slice(0, 10), 'monthDay')} ${format.time(asOf.slice(11))} 기준`;
  }
  if (timeRange && isTime(timeRange.start) && (isTime(timeRange.end) || timeRange.end === '24:00') && timeRange.start < timeRange.end) {
    const { start, end } = timeRange;
    const hours = start.endsWith(':00') && end.endsWith(':00')
      ? format.hourRange(Number(start.slice(0, 2)), Number(end.slice(0, 2)))
      : `${format.time(start)}~${format.time(end)}`;
    return isIsoDate(fact.date) ? `${format.date(fact.date, 'monthDay')} · ${hours}` : hours;
  }
  if (isIsoDate(fact.start) && isIsoDate(fact.end) && fact.start <= fact.end) return dateRange(fact.start, fact.end);
  if (isIsoDate(fact.date)) return `${format.date(fact.date, 'monthDay')}${condition?.kind === 'snapshot' ? ' 기준' : ''}`;
  if (condition?.kind === 'snapshot' && isIsoDate(condition.asOf)) return `${format.date(condition.asOf, 'monthDay')} 기준`;
  if (condition?.kind === 'dateRange' && isIsoDate(condition.start) && isIsoDate(condition.end) && condition.start <= condition.end) {
    return dateRange(condition.start, condition.end);
  }
}

/** Pass the original fact objects resolved by the final answer's validation. Fact keys can repeat within a read. */
export function selectVerifiedEvidence(
  reads: readonly AgentReadEvidence[], supportingFacts: readonly VerifiedAnswerFact[], translator: Translator,
): readonly EvidenceRow[] {
  const verified = new Map(supportingFacts.map(entry => [entry.fact, entry]));
  const rows = new Map<string, EvidenceRow>();
  for (const read of reads) {
    if (read.status !== 'ready' || read.tool === 'search_records') continue;
    const widget = read.tool === 'get_widget' ? getRegistration(read.args.featureId) : undefined;
    const title = widget && translator.t(widget.nameKey);
    const sourceName = read.tool === 'get_source' ? sourceNames[read.args.sourceId] : title;
    const condition = read.tool === 'get_widget' || read.tool === 'get_source' ? read.args.condition : undefined;
    for (const fact of read.facts) {
      const verifiedFact = verified.get(fact);
      if (!verifiedFact) continue;
      const period = periodLabel(verifiedFact, condition);
      if (!period) continue;
      const destination = read.tool === 'get_widget' && widget ? widgetDestination(widget.id, fact, read.args.condition) : undefined;
      const openLabel = destination && destinationOpenLabel(destination, translator);
      const source = openLabel ? title : fact.source?.trim() || sourceName;
      if (!source) continue;
      const row: EvidenceRow = { source, periodLabel: period, ...(destination && openLabel ? { destination, openLabel } : {}) };
      rows.set(JSON.stringify(row), row);
    }
  }
  return [...rows.values()];
}
