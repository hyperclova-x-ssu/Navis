// D-371: the owner's sentence may go to HyperCLOVA X for READ-ONLY intent classification when the browser routers cannot place it.
// The browser sends the sentence and its own widget list; the model returns an intent plan (widgets, period, item names). The plan is
// validated against the shared schema here again, turned into ordinary typed reads, and answered by the normal agent route. A write is
// never classified: cards still come only from the browser routers and still need the owner's press.
import type { DashboardLayerId, FeatureId, Locale, QueryCondition } from '../../contracts';
import type { DataSnapshot } from '../../data/db/types';
import { addDays, daysBetween } from '../../data/db/time';
import { TODAY } from '../../data/widget-data';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentRequest, validateIntentPlan, type IntentPlan, type IntentPlanPeriod } from '../../../shared/navis-agent-schema.mjs';
import type { DomainRoute } from './domains/registry';
import { routeClassifiedTrendOverview } from './domains/local';
import { getRegistry } from '../../catalog';
import { matchWidget, norm } from './question';
import { parseNavisPeriod } from './navis-input';
import { navisTranslator } from './messages';
import { calendarWeekFrom, catalogFor, conditionsOf, normalizeFor, PERIOD_LABELS, projectAgentWidget, readNavisCondition, type SnapshotFact } from './snapshot';

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
  'local-trends': '현재 인기 검색어 순위 · 4주 대비 검색 관심도 · 우리 메뉴 여부 · 가게 활용(상승 검색어로 홍보할 우리 메뉴). 현재 순위 기간은 default',
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

/** Widgets whose own domain reads any single day (the shift list and the reservation list), though their registry lists only today. */
const STATE_WIDGETS: ReadonlySet<string> = new Set(['tax', 'menu', 'members', 'suppliers', 'inventory-booking', 'credit-receivable', 'manuals', 'grants', 'store-environment', 'custom-order']);
const DAY_RANGE_WIDGETS: ReadonlySet<string> = new Set(['staff-schedule', 'voice-booking']);
const PERIOD_PHRASES: Record<string, string> = { week: '이번 주', lastWeek: '지난주', month: '이번 달', lastMonth: '지난달', last30: '최근 30일' };

/** The condition a widget really supports for a period, or undefined: today's value never stands in for another period. */
function periodCondition(featureId: FeatureId, period: Period, snapshot: DataSnapshot, perDay = false): QueryCondition | undefined {
  const businessDate = snapshot.pos?.businessDate ?? TODAY;
  const supported = conditionsOf(featureId, snapshot);
  if (period === 'today' || period === 'default') return supported[0] ?? { kind: 'default' };
  // A widget that shows its current state (due taxes, the menu list, members, stock) has no period: whatever period the model wrote reads that state.
  if (STATE_WIDGETS.has(featureId)) return supported[0] ?? { kind: 'default' };
  // A single day: the widget's own condition when it lists one, else the one-day range the widget accepts (staff shifts, reservations).
  const oneDay = (day: string): QueryCondition | undefined => DAY_RANGE_WIDGETS.has(featureId) ? { kind: 'dateRange', start: day, end: day }
    : normalizeFor(featureId, { kind: 'dateRange', start: day, end: day }) ?? undefined;
  if (period === 'tomorrow') return readNavisCondition(featureId, '내일', businessDate) ?? oneDay(addDays(businessDate, 1));
  const range = period === 'yesterday' ? { start: addDays(businessDate, -1), end: addDays(businessDate, -1) }
    : parseNavisPeriod(PERIOD_PHRASES[period], businessDate);
  if (!range) return undefined;
  const end = range.end > businessDate ? businessDate : range.end;
  // "이번 주" is the calendar week (Monday to today) for the ledger, the same as a plain "이번 주 매출"; a widget with only a rolling window keeps that window.
  const named = readNavisCondition(featureId, period === 'yesterday' ? '어제' : PERIOD_PHRASES[period], businessDate, period === 'week' && !perDay ? calendarWeekFrom(snapshot) : undefined);
  if (named && named.kind !== 'snapshot' && named !== supported[0]) return named;
  if (period === 'yesterday') {
    const day = oneDay(addDays(businessDate, -1));
    if (day) return day;
  }
  // The real ledger reads any day range inside the loaded finance coverage (the same rule as a plain "지난주 매출").
  const finance = snapshot.tables.realFinance;
  if (featureId === 'ledger' && finance && range.start >= finance.from && end <= finance.to) {
    return normalizeFor(featureId, { kind: 'dateRange', start: range.start, end }) ?? { kind: 'dateRange', start: range.start, end };
  }
  return undefined;
}

// A time range such as "08:00~16:30" inside a fact, and the parts of the day a hint can name (hours, end exclusive).
const RANGE = /(\d{1,2}):(\d{2})\s*[~–-]\s*(\d{1,2}):(\d{2})/u;
const DAYPARTS: Readonly<Record<string, readonly [number, number]>> = { 새벽: [0, 6], 아침: [6, 10], 오전: [0, 12], 점심: [11, 14], 오후: [12, 24], 저녁: [17, 24], 밤: [20, 24] };
const HOUR = /(?:^|\s)(\d{1,2}):00(?!\d|\s*[~–-])/u;
const rangeOf = (fact: SnapshotFact): readonly [number, number] | undefined => {
  const text = `${fact.label} ${fact.display}`;
  const match = RANGE.exec(text);
  if (match) return [Number(match[1]) + Number(match[2]) / 60, Number(match[3]) + Number(match[4]) / 60];
  // An hourly row ("시간대별 매출 12:00") covers that hour.
  const hour = fact.key.endsWith('.hourly') ? HOUR.exec(text) : null;
  return hour ? [Number(hour[1]), Number(hour[1]) + 1] : undefined;
};
/** Words that name a kind of fact rather than an item: the fact keys that hold them. */
const KEY_HINTS: readonly (readonly [RegExp, RegExp])[] = [
  [/피크|붐비|바쁜\s*시간|많이\s*오는\s*시간/u, /\.peak(?:\.|$)/u],
  [/일별|요일별|하루별|날짜별/u, /\.daily$/u],
  [/시간대별|시간별/u, /\.hourly$/u],
];
const keyHint = (hint: string): RegExp | undefined => KEY_HINTS.find(([words]) => words.test(hint))?.[1];
const TIME_WORDS = /몇\s*시|언제|시간|까지/u;
export const asksTime = (text: string): boolean => TIME_WORDS.test(text);

/**
 * Keeps the facts a read should show: the ones whose label or text names a hint (every named item gets its own first matches before any item
 * shows more), whose kind a hint names (peak, per day, per hour), or whose time range overlaps a named part of the day (오전·오후·점심·저녁),
 * else the first four. No repeats, at most six. `prefer` puts rates (percent) or counts first within an item, an exact name before a longer one that
 * contains it, and `timeWords` puts facts with a time range first when nothing is named.
 */
export interface KeepOptions { readonly timeWords?: boolean; readonly prefer?: 'percent' | 'count' }
export const keepHinted = (hints: readonly string[], options: KeepOptions = {}) => (facts: readonly SnapshotFact[]): readonly SnapshotFact[] => {
  const dayparts = hints.map(hint => DAYPARTS[hint.trim()]).filter((part): part is readonly [number, number] => !!part);
  const kinds = hints.map(keyHint).filter((pattern): pattern is RegExp => !!pattern);
  const wanted = hints.filter(hint => !DAYPARTS[hint.trim()] && !keyHint(hint)).map(norm).filter(Boolean);
  const seen = new Set<string>();
  const unique = (rows: readonly SnapshotFact[]) => rows.filter(fact => !seen.has(`${fact.label}|${fact.display}`) && !!seen.add(`${fact.label}|${fact.display}`));
  const inDaypart = (rows: readonly SnapshotFact[]) => dayparts.length ? rows.filter(fact => {
    const range = rangeOf(fact);
    return !!range && dayparts.some(([from, to]) => range[0] < to && range[1] > from);
  }) : rows;
  if (!wanted.length) {
    if (kinds.length) return unique(facts.filter(fact => kinds.some(pattern => pattern.test(fact.key)))).slice(0, MAX_ANSWER_FACTS);
    if (dayparts.length) return unique(inDaypart(facts)).slice(0, MAX_ANSWER_FACTS);
    const ordered = options.timeWords ? [...facts.filter(rangeOf), ...facts.filter(fact => !rangeOf(fact))] : facts;
    return unique(ordered).slice(0, MAX_ANSWER_FACTS);
  }
  const rank = (hint: string) => (fact: SnapshotFact) => (norm(fact.label) === hint ? 0 : 2) + (options.prefer && (options.prefer === 'percent' ? fact.unit === 'percent' : fact.unit === 'count') ? 0 : 1);
  const perHint = wanted.map(hint => inDaypart(facts).filter(fact => norm(`${fact.label} ${fact.display}`).includes(hint))
    .map((fact, order) => ({ fact, order })).sort((a, b) => rank(hint)(a.fact) - rank(hint)(b.fact) || a.order - b.order).map(({ fact }) => fact));
  const picked: SnapshotFact[] = [];
  for (let depth = 0; depth < MAX_ANSWER_FACTS; depth++) for (const rows of perHint) if (rows[depth]) picked.push(rows[depth]);
  const named = unique(picked).slice(0, MAX_ANSWER_FACTS);
  return named.length ? named : unique(inDaypart(facts)).slice(0, 4);
};

const matching = (hints: readonly string[], facts: readonly SnapshotFact[]): readonly SnapshotFact[] => {
  const wanted = hints.filter(hint => !DAYPARTS[hint.trim()] && !keyHint(hint)).map(norm).filter(Boolean);
  return wanted.length ? facts.filter(fact => wanted.some(hint => norm(`${fact.label} ${fact.display}`).includes(hint))) : facts;
};

const RATE_WORDS = /마진율|비율|퍼센트|%|이익률|율\b/u;
const COUNT_WORDS = /몇\s*(?:잔|개|건|명|번)|많이\s*팔|판매\s*량|수량/u;
const DIFF_CUE = /빼면|뺀|빼고|남(?:아|는|았|을|으)|차감/u;
const SUM_CUE = /합치면|합쳐|합친|더하면|더한|합계|합산|다\s*합/u;
const RATIO_CUE = /몇\s*(?:퍼센트|%|프로)|비율|차지/u;
const SALES_HINT = /매출|수입|판매|벌/u;

/**
 * The model sometimes reads the two amounts a sentence combines but forgets to say how ("빼면", "합치면", "몇 퍼센트"). The cue words of the
 * sentence decide the operation; a single read that names two items is split into one read per item. Anything else is left as it is.
 */
const LOW_DAY = /(?:제일|가장)\s*(?:한가|적|낮|못|안\s*팔|조용)/u;
const HIGH_DAY = /(?:제일|가장)\s*(?:바쁜|바빴|붐|많이|높|잘)/u;
const DAY_WORDS = /요일|(?:이번|지난)\s*주.*날|날이|하루|일별/u;

export function inferCompute(plan: IntentPlan, text: string): IntentPlan {
  if (plan.kind !== 'read' || plan.compute) return plan;
  // "이번 주에 제일 한가했던 요일": the lowest (or highest) of the per-day figures of one read.
  if (plan.reads.length === 1 && DAY_WORDS.test(text) && (LOW_DAY.test(text) || HIGH_DAY.test(text))) {
    return { ...plan, compute: { op: LOW_DAY.test(text) ? 'min' : 'max', left: 0, right: 0 } };
  }
  const op = RATIO_CUE.test(text) ? 'ratio' : DIFF_CUE.test(text) ? 'diff' : SUM_CUE.test(text) ? 'sum' : undefined;
  if (!op) return plan;
  const reads = plan.reads.length === 1 && (plan.reads[0].hints?.length ?? 0) === 2
    ? plan.reads[0].hints!.map(hint => ({ ...plan.reads[0], hints: [hint] })) : plan.reads;
  if (reads.length !== 2) return plan;
  const salesIndex = reads.findIndex(read => (read.hints ?? []).some(hint => SALES_HINT.test(hint)));
  // A difference starts from sales; a share has sales as the divisor; a sum keeps the given order.
  const [left, right] = op === 'diff' && salesIndex === 1 ? [1, 0] : op === 'ratio' && salesIndex === 0 ? [1, 0] : [0, 1];
  return { ...plan, reads, compute: { op, left, right } };
}

const won = (value: number) => `${Math.round(value).toLocaleString('ko-KR')}원`;
const COMPUTE_LABELS = { sum: '합계', diff: '차이', ratio: '비율' } as const;

/** The first money or percent amount among the facts a read keeps. */
const firstAmount = (facts: readonly SnapshotFact[]) => facts.find(fact => typeof fact.value === 'number' && (fact.unit === 'KRW' || fact.unit === 'percent' || fact.unit === 'count'));

/** One derived fact (sum, difference or ratio of two reads' first amounts), or undefined when either amount is missing or unusable. */
function derivedFact(compute: NonNullable<Extract<IntentPlan, { kind: 'read' }>['compute']>, amounts: readonly (SnapshotFact | undefined)[]): SnapshotFact | undefined {
  if (compute.op === 'min' || compute.op === 'max') return undefined; // the extreme day is picked from the shown facts (see extremeFact)
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

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
/** The lowest or highest of the per-day rows (`*.daily`), shown with its weekday. At least two days are needed. */
function extremeFact(op: 'min' | 'max', facts: readonly SnapshotFact[], window?: string): SnapshotFact | undefined {
  const days = facts.filter(fact => fact.key.endsWith('.daily') && typeof fact.value === 'number' && fact.date);
  if (days.length < 2) return undefined;
  const pick = days.reduce((best, fact) => (op === 'min' ? (fact.value as number) < (best.value as number) : (fact.value as number) > (best.value as number)) ? fact : best);
  const [, , month, day] = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(pick.date!) ?? [];
  const weekday = WEEKDAY[new Date(`${pick.date}T00:00:00Z`).getUTCDay()];
  return { key: `derived.${op}`, label: `${window ? `${window} 중 ` : ''}${op === 'min' ? '가장 낮은 날' : '가장 높은 날'}`, value: pick.value, unit: pick.unit, date: pick.date,
    display: `${Number(month)}월 ${Number(day)}일(${weekday}요일) ${pick.display}` };
}

/** The plan period an earlier read used, so a follow-up ("그 중에…", "그럼 …") can keep it: the inverse of `periodCondition`. */
export function periodNameOf(condition: QueryCondition, businessDate: string): Period | 'default' {
  if (condition.kind === 'default') return 'default';
  if (condition.kind === 'snapshot') return condition.asOf === businessDate ? 'today' : 'default';
  const { start, end } = condition;
  if (start === end) return start === businessDate ? 'today' : start === addDays(businessDate, 1) ? 'tomorrow' : start === addDays(businessDate, -1) ? 'yesterday' : 'default';
  const first = parseNavisPeriod('이번 달', businessDate), lastWeek = parseNavisPeriod('지난주', businessDate), lastMonth = parseNavisPeriod('지난달', businessDate);
  if (end === businessDate && daysBetween(start, end) === 6) return 'week';
  if (lastWeek && start === lastWeek.start && end === lastWeek.end) return 'lastWeek';
  if (lastMonth && start === lastMonth.start && end === lastMonth.end) return 'lastMonth';
  if (end === businessDate && first && start === first.start) return 'month';
  if (end === businessDate && daysBetween(start, end) === 29) return 'last30';
  const monday = parseNavisPeriod('이번 주', businessDate);
  if (end === businessDate && monday && start === monday.start) return 'week';
  return 'default';
}

export interface LastRead { readonly featureId: string; readonly condition: QueryCondition }

/** The browser-side turn for a plan: ordinary typed reads (at most four, no repeats), or a short question back. */
export function planToRoute(planned: IntentPlan, snapshot: DataSnapshot, locale: Locale = 'ko', last: readonly LastRead[] = [], text = ''): DomainRoute | undefined {
  const plan = text ? inferCompute(planned, text) : planned;
  if (plan.kind === 'clarify') return { kind: 'answer', answer: plan.ask };
  if (plan.kind !== 'read') return undefined;
  const current = plan.reads.find(read => read.featureId === 'local-trends'
    && (read.period === 'default' || read.period === 'today' || read.period === 'week'));
  const namedWidget = matchWidget(text);
  // A follow-up keeps its verified ranking scope when the planner merely adds unscoped neighborhood context.
  const keepsTrendScope = last.length === 1 && last[0].featureId === 'local-trends' && (!namedWidget || namedWidget === 'local-trends')
    && plan.reads.every(read => read === current ||
      (read.featureId === 'local-changes' || read.featureId === 'trade-area') && read.period === 'default' && !read.hints?.length);
  if (!plan.compute && current && (plan.reads.length === 1 || keepsTrendScope)) {
    const overview = routeClassifiedTrendOverview(snapshot, locale, current.hints ?? [], text);
    if (overview) return overview;
  }
  const missing: FeatureId[] = [];
  // Reads of the same widget and period share one wire read; their hints are the union and each plan read keeps its own picks.
  const wire: { featureId: FeatureId; condition: QueryCondition; hints: string[] }[] = [];
  // The lowest or highest day needs the widget's per-day rows, which only its rolling windows carry (a custom range gives totals): that window is read and named.
  const perDay = plan.kind === 'read' && (plan.compute?.op === 'min' || plan.compute?.op === 'max');
  const slot = plan.reads.map(read => {
    const featureId = read.featureId as FeatureId;
    // A follow-up that stays on the widget it just read ("그 중에 오전은?") keeps that read's own period when the widget has none for the new one.
    const condition = periodCondition(featureId, read.period, snapshot, perDay)
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
  // A widget that keeps only its current state has no history to compare: two periods of it ("지난주보다 늘었어?") cannot be answered.
  const stateReads = new Map<string, Set<string>>();
  for (const read of plan.reads) if (STATE_WIDGETS.has(read.featureId)) stateReads.set(read.featureId, new Set([...(stateReads.get(read.featureId) ?? []), read.period]));
  if ([...stateReads.values()].some(periods => periods.size > 1)) {
    return { kind: 'answer', answer: '이 자료는 지금 상태만 있고 기간별 기록은 남기지 않아서 지난 기간과 비교할 수 없어요. 지금 값은 해당 화면에서 볼 수 있어요.' };
  }
  const amounts = plan.reads.map((read, index) => {
    const target = wire[slot[index]];
    try {
      return firstAmount(matching(read.hints ?? [], projectAgentWidget(snapshot, target.featureId, target.condition, locale).facts ?? []));
    } catch { return undefined; }
  });
  const derived = plan.compute ? derivedFact(plan.compute, amounts) : undefined;
  const timeWords = asksTime(text);
  const prefer = RATE_WORDS.test(text) ? 'percent' as const : COUNT_WORDS.test(text) ? 'count' as const : undefined;
  const extreme = plan.compute && (plan.compute.op === 'min' || plan.compute.op === 'max') ? plan.compute.op : undefined;
  const parts = wire.map((read, index) => {
    const keep = keepHinted(read.hints, { timeWords, ...(prefer && { prefer }) });
    if (extreme) return { narrow: (facts: readonly SnapshotFact[]) => {
      const span = read.condition.kind === 'dateRange' ? read.condition : undefined;
      const window = span && read.condition !== undefined && read.featureId && /week/u.test(String(plan.reads.find(item => item.featureId === read.featureId)?.period))
        ? `최근 7일(${span.start.slice(5).replace('-', '/')}~${span.end.slice(5).replace('-', '/')})` : undefined;
      const found = extremeFact(extreme, facts, window);
      return found ? [found, ...facts.filter(fact => fact.key.endsWith('.daily')).slice(0, MAX_ANSWER_FACTS - 1)] : keep(facts);
    } };
    return { narrow: index === wire.length - 1 && derived ? (facts: readonly SnapshotFact[]) => [...keep(facts), derived] : keep };
  });
  if (wire.length === 1) return { intent: { kind: 'read', featureId: wire[0].featureId, condition: wire[0].condition }, narrow: parts[0].narrow };
  return { intent: { kind: 'read', reads: wire.map(({ featureId, condition }) => ({ name: 'get_widget' as const, args: { featureId, condition } })) }, readParts: parts };
}
