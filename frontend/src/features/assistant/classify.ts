// D-371: the owner's sentence may go to HyperCLOVA X for READ-ONLY intent classification when the browser routers cannot place it.
// The browser sends the sentence and its own widget list; the model returns an intent plan (widgets, period, item names). The plan is
// validated against the shared schema here again, turned into ordinary typed reads, and answered by the normal agent route. A write is
// never classified: cards still come only from the browser routers and still need the owner's press.
import type { DashboardLayerId, FeatureId, Locale, QueryCondition } from '../../contracts';
import type { DataSnapshot } from '../../data/db/types';
import { addDays } from '../../data/db/time';
import { TODAY } from '../../data/widget-data';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentRequest, validateIntentPlan, type IntentPlan, type IntentPlanPeriod } from '../../../shared/navis-agent-schema.mjs';
import type { DomainRoute } from './domains/registry';
import { getRegistry } from '../../catalog';
import { norm } from './question';
import { parseNavisPeriod } from './navis-input';
import { navisTranslator } from './messages';
import { catalogFor, conditionsOf, normalizeFor, PERIOD_LABELS, projectAgentWidget, readNavisCondition, type SnapshotFact } from './snapshot';

export type { IntentPlan };
type Period = IntentPlanPeriod;

const MAX_LABELS = 6;
const MAX_ANSWER_FACTS = 6;
let listed: { readonly key: string; readonly lines: readonly string[] } | undefined;

/** What each widget holds, in the owner's words. The widget's own search words are added from the registry. */
const WIDGET_NOTES: Partial<Record<string, string>> = {
  ledger: '기간별 매출·지출·순이익', margin: '메뉴별 판매 수량·원가·마진율', menu: '메뉴 이름·판매가·품절', 'voice-booking': '예약 건수·인원·상태(확정·대기·취소)',
  'staff-schedule': '근무자·근무 시간·휴무', 'inventory-booking': '재료 재고량·보충 필요·유통기한', suppliers: '거래처·발주·입고 예정', tax: '세금 납부 일정·금액',
  members: '단골·회원 수·회원권', briefing: '오늘 할 일·알림·예약·세금', 'customer-analysis': '방문이 많은 시간·방문 수', calendar: '일정·할 일',
};

/** One "id|name|notes, search words and fact labels" line per widget of the layer, from the browser's own registry and data. Cached per run, layer and language. */
export function widgetLines(snapshot: DataSnapshot, locale: Locale, layer: DashboardLayerId): readonly string[] {
  const key = `${snapshot.runId}|${layer}|${locale}`;
  if (listed?.key === key) return listed.lines;
  const tr = navisTranslator(locale);
  const registry = new Map(getRegistry('A').map(entry => [entry.id as string, entry]));
  const lines = catalogFor(locale, layer, snapshot).map(entry => {
    let labels: string[] = [];
    try {
      const facts = projectAgentWidget(snapshot, entry.id, entry.conditions[0] ?? { kind: 'default' }, locale).facts ?? [];
      labels = [...new Set(facts.map(fact => fact.label.trim()).filter(label => label && label.length <= 16))].slice(0, MAX_LABELS);
    } catch { /* A widget without a readable default shows only its name. */ }
    const registration = registry.get(entry.id);
    const words = registration?.aliasesKey && tr.has(registration.aliasesKey) ? tr.t(registration.aliasesKey).split('|').map(word => word.trim()).filter(Boolean) : [];
    const note = WIDGET_NOTES[entry.id];
    const detail = [note, words.length ? `검색어 ${words.join('/')}` : '', labels.length ? `항목 ${labels.join(',')}` : ''].filter(Boolean).join(' · ');
    return `${entry.id}|${entry.name}|${detail}`.slice(0, 400);
  }).slice(0, 64);
  listed = { key, lines };
  return lines;
}

export interface ClassifyContext {
  readonly fetcher: (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status'> & Partial<Pick<Response, 'body' | 'headers'>>>;
  readonly snapshot: DataSnapshot; readonly locale: Locale; readonly layer: DashboardLayerId;
  readonly text: string; readonly previous?: string; readonly signal?: AbortSignal;
}

/** Parses the small SSE body: the plan frame, or null for an error frame, a bad plan or any transport problem. */
export function readPlanFrames(body: string): IntentPlan | null {
  let event = '', plan: IntentPlan | null = null, failed = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      try {
        const data = JSON.parse(line.slice(5).trim()) as { plan?: unknown };
        if (event === 'intent_plan' && validateIntentPlan(data.plan)) plan = data.plan;
        if (event === 'error') failed = true;
      } catch { failed = true; }
    }
  }
  return failed ? null : plan;
}

export async function requestIntentPlan(context: ClassifyContext): Promise<IntentPlan | null> {
  const { fetcher, snapshot, locale, layer, text, previous, signal } = context;
  if (!snapshot.runId) return null;
  const body = {
    runId: snapshot.runId, snapshotRevision: snapshot.revision, locale, layer, businessDate: snapshot.pos?.businessDate ?? TODAY,
    intent: { kind: 'classify', text: text.slice(0, 240), widgets: widgetLines(snapshot, locale, layer), ...(previous && { previous: previous.slice(0, 300) }) },
    slots: [], catalog: [], snapshot: [], searches: [],
  };
  if (!validateAgentRequest(body)) return null;
  try {
    const response = await fetcher('/api/navis/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL },
      body: JSON.stringify(body), signal,
    });
    if (!response.ok || response.headers?.get(AGENT_PROTOCOL_HEADER) !== AGENT_PROTOCOL || !response.body) return null;
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > 16_384) { void reader.cancel().catch(() => {}); return null; }
    }
    return readPlanFrames(text);
  } catch { return null; }
}

const PERIOD_PHRASES: Record<string, string> = { week: '이번 주', lastWeek: '지난주', month: '이번 달', lastMonth: '지난달', last30: '최근 30일' };

/** The condition a widget really supports for a period, or undefined: today's value never stands in for another period. */
function periodCondition(featureId: FeatureId, period: Period, snapshot: DataSnapshot): QueryCondition | undefined {
  const businessDate = snapshot.pos?.businessDate ?? TODAY;
  const supported = conditionsOf(featureId, snapshot);
  if (period === 'today' || period === 'default') return supported[0] ?? { kind: 'default' };
  if (period === 'tomorrow') return readNavisCondition(featureId, '내일', businessDate) ?? undefined;
  const range = period === 'yesterday' ? { start: addDays(businessDate, -1), end: addDays(businessDate, -1) }
    : parseNavisPeriod(PERIOD_PHRASES[period], businessDate);
  if (!range) return undefined;
  const end = range.end > businessDate ? businessDate : range.end;
  const named = readNavisCondition(featureId, period === 'yesterday' ? '어제' : PERIOD_PHRASES[period], businessDate);
  if (named && named.kind !== 'snapshot' && named !== supported[0]) return named;
  // The real ledger reads any day range inside the loaded finance coverage (the same rule as a plain "지난주 매출").
  const finance = snapshot.tables.realFinance;
  if (featureId === 'ledger' && finance && range.start >= finance.from && end <= finance.to) {
    return normalizeFor(featureId, { kind: 'dateRange', start: range.start, end }) ?? { kind: 'dateRange', start: range.start, end };
  }
  return undefined;
}

/** Keeps the facts whose label or text names one of the hints (the first four when none does), without repeats, at most six per read. */
const matching = (hints: readonly string[], facts: readonly SnapshotFact[]): readonly SnapshotFact[] => {
  const wanted = hints.map(norm).filter(Boolean);
  return wanted.length ? facts.filter(fact => wanted.some(hint => norm(`${fact.label} ${fact.display}`).includes(hint))) : facts;
};
export const keepHinted = (hints: readonly string[]) => (facts: readonly SnapshotFact[]): readonly SnapshotFact[] => {
  const wanted = hints.map(norm).filter(Boolean);
  const seen = new Set<string>();
  const unique = (rows: readonly SnapshotFact[]) => rows.filter(fact => !seen.has(`${fact.label}|${fact.display}`) && !!seen.add(`${fact.label}|${fact.display}`));
  if (!wanted.length) return unique(facts).slice(0, MAX_ANSWER_FACTS);
  // Every named item gets its own first matches, so a comparison of two items shows both before any item shows more.
  const perHint = wanted.map(hint => facts.filter(fact => norm(`${fact.label} ${fact.display}`).includes(hint)));
  const picked: SnapshotFact[] = [];
  for (let depth = 0; depth < MAX_ANSWER_FACTS; depth++) for (const rows of perHint) if (rows[depth]) picked.push(rows[depth]);
  const named = unique(picked).slice(0, MAX_ANSWER_FACTS);
  return named.length ? named : unique(facts).slice(0, 4);
};

const won = (value: number) => `${Math.round(value).toLocaleString('ko-KR')}원`;
const COMPUTE_LABELS = { sum: '합계', diff: '차이', ratio: '비율' } as const;

/** The first money or percent amount among the facts a read keeps. */
const firstAmount = (facts: readonly SnapshotFact[]) => facts.find(fact => typeof fact.value === 'number' && (fact.unit === 'KRW' || fact.unit === 'percent' || fact.unit === 'count'));

/** One derived fact (sum, difference or ratio of two reads' first amounts), or undefined when either amount is missing or unusable. */
function derivedFact(compute: NonNullable<Extract<IntentPlan, { kind: 'read' }>['compute']>, amounts: readonly (SnapshotFact | undefined)[]): SnapshotFact | undefined {
  const left = amounts[compute.left], right = amounts[compute.right];
  if (!left || !right || typeof left.value !== 'number' || typeof right.value !== 'number') return undefined;
  const money = left.unit === 'KRW' && right.unit === 'KRW';
  if (compute.op === 'ratio') {
    if (right.value === 0) return undefined;
    const percent = Math.round(left.value / right.value * 1000) / 10;
    return { key: 'derived.ratio', label: `${left.label} ÷ ${right.label}`, value: percent, unit: 'percent', display: `${percent}%` };
  }
  if (!money) return undefined;
  const value = compute.op === 'sum' ? left.value + right.value : left.value - right.value;
  return { key: `derived.${compute.op}`, label: `${left.label} ${compute.op === 'sum' ? '+' : '−'} ${right.label} ${COMPUTE_LABELS[compute.op]}`, value, unit: 'KRW', display: won(value) };
}

export interface LastRead { readonly featureId: string; readonly condition: QueryCondition }

/** The browser-side turn for a plan: ordinary typed reads (at most four, no repeats), or a short question back. */
export function planToRoute(plan: IntentPlan, snapshot: DataSnapshot, locale: Locale = 'ko', last: readonly LastRead[] = []): DomainRoute | undefined {
  if (plan.kind === 'clarify') return { kind: 'answer', answer: plan.ask };
  if (plan.kind !== 'read') return undefined;
  const missing: FeatureId[] = [];
  // Reads of the same widget and period share one wire read; their hints are the union and each plan read keeps its own picks.
  const wire: { featureId: FeatureId; condition: QueryCondition; hints: string[] }[] = [];
  const slot = plan.reads.map(read => {
    const featureId = read.featureId as FeatureId;
    // A follow-up that stays on the widget it just read ("그 중에 오전은?") keeps that read's own period when the widget has none for the new one.
    const condition = periodCondition(featureId, read.period, snapshot)
      ?? (read.period === 'tomorrow' || read.period === 'default' ? last.find(item => item.featureId === featureId)?.condition : undefined);
    if (!condition) { missing.push(featureId); return -1; }
    const key = JSON.stringify(condition);
    const found = wire.findIndex(item => item.featureId === featureId && JSON.stringify(item.condition) === key);
    const hints = [...(read.hints ?? [])];
    if (found >= 0) { wire[found].hints.push(...hints); return found; }
    wire.push({ featureId, condition, hints });
    return wire.length - 1;
  });
  if (missing.length) {
    return { kind: 'answer', answer: `이 기간의 자료는 제공되지 않아요. 볼 수 있는 기간은 ${PERIOD_LABELS[missing[0]] ?? '오늘'}이에요.` };
  }
  if (!wire.length) return undefined;
  const amounts = plan.reads.map((read, index) => {
    const target = wire[slot[index]];
    try {
      return firstAmount(matching(read.hints ?? [], projectAgentWidget(snapshot, target.featureId, target.condition, locale).facts ?? []));
    } catch { return undefined; }
  });
  const derived = plan.compute ? derivedFact(plan.compute, amounts) : undefined;
  const parts = wire.map((read, index) => {
    const keep = keepHinted(read.hints);
    return { narrow: index === wire.length - 1 && derived ? (facts: readonly SnapshotFact[]) => [...keep(facts), derived] : keep };
  });
  if (wire.length === 1) return { intent: { kind: 'read', featureId: wire[0].featureId, condition: wire[0].condition }, narrow: parts[0].narrow };
  return { intent: { kind: 'read', reads: wire.map(({ featureId, condition }) => ({ name: 'get_widget' as const, args: { featureId, condition } })) }, readParts: parts };
}
