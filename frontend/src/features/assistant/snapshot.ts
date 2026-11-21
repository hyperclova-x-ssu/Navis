/** Full current-layer normal facts, with question-scoped other-layer and source-only context. */
import { getRegistry } from '../../catalog';
import type { DashboardLayerId, FeatureId, Locale, QueryCondition, RunState } from '../../contracts';
import { createWidgetDataStore, demandFacts, posFacts, isDataWidgetId, TOMORROW, selectMembers, selectMenus, selectTaxPayments, TODAY, normalizeCondition, NORMAL_VARIANT, resolveDataText, selectWidget, supportedConditions, widgetFacts, type ModelFact, type WidgetDataStore } from '../../data/widget-data';
import type { WidgetView } from '../../data/widget-data';
import type { DataSnapshot } from '../../data/db/types';
import type { AgentReadProjection, AgentRequest, AgentSearchArgs, AgentSearchProjection, AgentSourceId } from '../../../shared/navis-agent-schema.mjs';
import { agentCommandPolicy, isAgentNavigationCommand } from '../../../shared/navis-agent-schema.mjs';
import { daysBetween } from '../../data/db/time';
import { isMenuPrice, type MenuDraft } from './domains/menu';
import { createDomainRegistry, registeredDomains, type DomainRegistry } from './domains/registry';
import { navisMoneySpans, normalizeNavisInput, parseNavisDate, parseNavisMoney, parseNavisPeriod } from './navis-input';
import { inventoryIngredientKey } from './inventory-ingredients';
import { navisTranslator } from './messages';
import { norm, has, normalizedRules, CUSTOMERS, TOMORROW_WORDS, PAST_WORDS, WEEK_WORDS, REMOVED_WORDS, isPosQuestion, isDrawerQuestion, isDemandQuestion, matchWidget } from './question';
import { selectM2DayTotals } from '../../data/pos/projection';

export const MAX_CATALOG = 32;
const defaultCondition: QueryCondition = Object.freeze({ kind: 'default' });

/** Where views and facts come from. The default reads the data store; tests may inject facts. */
export interface WidgetFactSource {
  view(featureId: FeatureId, condition: QueryCondition): WidgetView<unknown>;
  facts(view: WidgetView<unknown>): readonly ModelFact[];
  readSource?(sourceId: 'demand' | 'pos'): readonly ModelFact[];
}
export function storeFactSource(store: WidgetDataStore): WidgetFactSource {
  return snapshotFactSource(store.getSnapshot);
}

function snapshotFactSource(getSnapshot: () => DataSnapshot): WidgetFactSource {
  return {
    view: (featureId, condition) => selectWidget(getSnapshot(), featureId, condition, NORMAL_VARIANT),
    facts: (view) => {
      const facts = widgetFacts(view);
      if (view.status !== 'ready') return facts;
      const snapshot = getSnapshot();
      // Only today's period can use today's receipt projection; historical deposits stay unavailable.
      const todayOnly = view.condition.kind === 'default' && (view.featureId === 'ledger' || view.featureId === 'briefing')
        || view.condition.kind === 'dateRange' && view.condition.start === TODAY && view.condition.end === TODAY
        || view.condition.kind === 'snapshot' && view.condition.asOf === TODAY;
      if (todayOnly && (view.featureId === 'ledger' || view.featureId === 'tax' || view.featureId === 'briefing')) {
        return [...facts, ...posFacts(snapshot).filter(fact => fact.key.startsWith('accounting.'))];
      }
      if (view.featureId === 'members') return [...facts, { key: 'members.regular.count', value: selectMembers(snapshot, {}).gradeCounts.regular, unit: 'person', labelKey: 'navis.fact.regularCount' }];
      if (view.featureId === 'menu') return [...facts, ...selectMenus(snapshot, {}).rows.flatMap((row): ModelFact[] => [
        ...(row.cost === null ? [] : [{ key: 'menu.cost', value: row.cost, unit: 'KRW' as const, labelKey: 'navis.fact.menuCost', labelText: row.name }]),
        ...(row.rate === null ? [] : [{ key: 'menu.marginRate', value: row.rate, unit: 'percent' as const, labelKey: 'navis.fact.menuMargin', labelText: row.name }]),
      ])];
      if (view.featureId === 'tax') return [...facts, ...selectTaxPayments(snapshot, { date: TODAY }).filter((p) => p.status === 'unpaid').map((p): ModelFact => ({ key: 'tax.payment', value: p.amount, unit: 'KRW', date: p.dueOn, labelKey: 'navis.fact.taxPayment', labelText: p.type }))];
      return facts;
    },
    readSource: sourceId => {
      const snapshot = getSnapshot();
      if (sourceId !== 'pos') return demandFacts(snapshot);
      const facts = posFacts(snapshot);
      if (!snapshot.pos) return facts;
      const totals = selectM2DayTotals(snapshot.pos);
      return [...facts, ...(['direct','coupon','membership'] as const).map(source => ({
        key:`pos.discount.${source}`,value:totals.discountBySource[source],unit:'KRW' as const,
        date:snapshot.pos!.businessDate,source:facts[0]?.source,labelKey:`navis.fact.discount.${source}`,
      }))];
    },
  };
}
let sharedStore: WidgetDataStore | null = null;
/** The seed store used when the host passes none (a run's own store is passed by the app shell). */
export function defaultStore(): WidgetDataStore { return (sharedStore ??= createWidgetDataStore()); }

export interface SnapshotFact { readonly key: string; readonly value: number | string; readonly unit: string; readonly date?: string; readonly start?: string; readonly end?: string; readonly label: string; readonly display: string; readonly text?: string; readonly source?: string }
export type SnapshotEntry = { readonly featureId: FeatureId; readonly condition: QueryCondition; readonly facts: readonly SnapshotFact[] } | { readonly featureId: FeatureId; readonly condition: QueryCondition; readonly unavailable: true } | { readonly sourceId: 'demand' | 'pos'; readonly condition: QueryCondition; readonly facts: readonly SnapshotFact[]; readonly candidateAllowed: false };
export interface CatalogEntry { readonly id: FeatureId; readonly name: string; readonly layer: DashboardLayerId; readonly conditions: readonly QueryCondition[] }
export interface AssistantContext { readonly snapshot: readonly SnapshotEntry[]; readonly catalog: readonly CatalogEntry[] }

export type LocalMenuDraft = Omit<MenuDraft, 'price'> & { readonly price?: number };

const createMenuVerb = /(?:추가|등록|넣어|넣고)|\b(?:add|put|create)\b|添加|加入|新增/iu;
const helpOrLayout = /(?:방법|하는\s*법|어떻게|추천|위젯|패널|대시보드|보드)|\b(?:how|recommend|widget|panel|dashboard|board)\b|怎么|怎麼|如何|小组件|小工具|仪表板|儀表板/iu;
const notARequest = /(?:하지\s*마|말아|하지\s*않)|\b(?:don't|do not|never)\b|不要|别|別/iu;
const koreanMenu = /(?:신\s*)?메뉴(?:판)?(?:에|로)?/u;
const koreanVerb = /(?:추가|등록)(?:하는데|해서|하고|해\s*(?:주(?:세요|십시오|라)|줘요?)?|\s*부탁(?:해요|해)?|할래)?|넣(?:어\s*(?:주(?:세요|십시오|라)|줘요?)?|고|어주세요)/u;
const genericName = /^(?:하나|한\s*(?:개|가지|종류)|새(?:로운)?|새로운\s*거|하나만|한\s*개만|이거|그거|것|거|상품|이름|메뉴|a new item|one|一个|一個|新项目|新項目)$/iu;

export function isMenuCreateRequest(text: string): boolean {
  const value = normalizeNavisInput(text).replace(/["“'‘][^"”'’]+["”'’]/gu, ' ');
  if (!createMenuVerb.test(value) || helpOrLayout.test(value) || notARequest.test(value)) return false;
  if (/메뉴에|신\s*메뉴|\b(?:to|in|on)\s+(?:the\s+)?menu\b|菜单|菜單/iu.test(value)) return true;
  // Keep unqualified legacy suggestions such as “메뉴 추가” on their original path.
  return koreanMenu.test(value) && (navisMoneySpans(value).length > 0 || /메뉴\s*(?:하나|한\s*개|새로)/u.test(value));
}

export type MenuCreateInput = Partial<LocalMenuDraft> & { readonly invalidPrice?: true };

export function readMenuName(text: string): string | undefined {
  const name = normalizeNavisInput(text).replace(/^["'“‘]|["'”’]$/gu, '').trim();
  if (!name || name.length > 120 || !/\p{L}/u.test(name) || /[!?;。！？；]/u.test(name) || genericName.test(name)
    || koreanMenu.test(name) || /(?:얼마|알려|보여|뭐야|했어|있어|없어|해주세요|해줘)/u.test(name) || createMenuVerb.test(name) || helpOrLayout.test(name) || navisMoneySpans(name).length) return undefined;
  return name;
}

export function readMenuCategory(name: string): MenuDraft['category'] | undefined {
  return /(?:디저트|\bdessert\b|甜点|甜點)/iu.test(name) ? 'dessert'
    : /(?:음료|\bdrink\b|饮品|飲品|아메리[카까]노|마키|라[테떼]|커피|쿠키)/iu.test(name) ? 'drink' : undefined;
}

export function parseMenuCreateInput(text: string): MenuCreateInput | null {
  if (!isMenuCreateRequest(text) || text.length > 300 || /[\r\n]/u.test(text)) return null;
  const phrase = normalizeNavisInput(text).replace(/[.!。！]+$/u, '');
  const memoStart = /\s*\(?메모(?:는|를)?\s*:?\s*/u.exec(phrase);
  const memo = memoStart && phrase.slice(memoStart.index + memoStart[0].length)
    .replace(/\)?(?:으로\s*(?:해줘|해주세요))?$/u, '').replace(/^["'“‘]|["'”’]$/gu, '').trim();
  const body = memoStart ? phrase.slice(0, memoStart.index).trim() : phrase;
  const english = /^(?:please\s+)?(?:add|put|create)\s+(.+?)\s+(?:to|in|on)\s+(?:the\s+)?menu$/iu.exec(body);
  const chinese = /^(?:请|請)?(?:把)?(.+?)(?:加入|添加到|加到|新增到)(?:菜单|菜單)$/u.exec(body)
    ?? /^(?:请|請)?(?:在)?(?:菜单|菜單)(?:中|里|裡)?(?:添加|加入|新增)(.+)$/u.exec(body);
  const korean = koreanMenu.test(body) && koreanVerb.test(body);
  if (!korean && !english && !chinese) return null;
  if (/(?:그리고|하고 나서|;|；|&|\band then\b)/iu.test(body)) return null;

  const content = korean ? body.replace(koreanMenu, ' ').replace(koreanVerb, ' ') : (english?.[1] ?? chinese?.[1] ?? '');
  const amounts = navisMoneySpans(content);
  const bare = amounts.length ? null : /(?:^|\s)([+-]?[\d,.]+|[0-9]+(?:\.[0-9]+)?[천만])\s*$/u.exec(content);
  const price = amounts.length === 1 ? amounts[0].value : bare ? parseNavisMoney(bare[1]) : undefined;
  const verbalFraction = /원\s*반/u.test(content);
  let name = content;
  for (const amount of [...amounts].reverse()) name = name.slice(0, amount.start) + ' ' + name.slice(amount.end);
  if (bare) name = name.slice(0, bare.index);
  const category = readMenuCategory(name);
  name = name.replace(/(?:^|\s)(?:디저트|음료|dessert|drink)(?:을|를)?(?=\s|$)|甜点|甜點|饮品|飲品/giu, ' ')
    .replace(/(?:^|\s)(?:공짜로|무료로|하나만|하나|한\s*개|새로|마이너스|반(?:에)?)(?=\s|$)/gu, ' ').trim();
  if (korean) name = name.replace(/([가-힣"'])\s*[을를]$/u, '$1');
  const label = readMenuName(name);
  return {
    ...(label ? { name: label } : {}), ...(category ? { category } : {}),
    ...(price !== undefined ? { price } : {}),
    ...((price !== undefined && !isMenuPrice(price) || verbalFraction || amounts.length > 1 || bare && price === undefined) ? { invalidPrice: true } : {}),
    ...(memo ? { memo } : {}),
  };
}

export function readMenuDraft(text: string): LocalMenuDraft | null {
  const parsed = parseMenuCreateInput(text);
  if (!parsed?.name || !parsed.category) return null;
  const { name, category, memo, price } = parsed;
  return { name, category, ...(memo ? { memo } : {}), ...(isMenuPrice(price) ? { price } : {}) };
}

/** Map a spoken time window to the exact condition supported by the widget. */
export function readNavisCondition(featureId: FeatureId, text: string, businessDate: string): QueryCondition | null {
  const available = conditionsOf(featureId);
  const date = parseNavisDate(text, businessDate);
  const period = parseNavisPeriod(text, businessDate);
  const ranges = available.filter(condition => condition.kind === 'dateRange');
  const snapshots = available.filter(condition => condition.kind === 'snapshot');
  if (period) {
    const exact = ranges.find(condition => condition.start === period.start && condition.end === period.end);
    if (exact) return exact;
    // Ledger and margin expose a rolling 7-day report as the available weekly comparison.
    if ((featureId === 'ledger' || featureId === 'margin') && /이번\s*주/u.test(text)) {
      return ranges.find(condition => daysBetween(condition.start, condition.end) === 6 && condition.end === businessDate) ?? null;
    }
    return null;
  }
  if (date) {
    if (date === businessDate && available[0].kind === 'default') return available[0];
    return snapshots.find(condition => condition.asOf === date)
      ?? ranges.filter(condition => condition.start <= date && date <= condition.end)
        .sort((a, b) => daysBetween(a.start, a.end) - daysBetween(b.start, b.end))[0] ?? null;
  }
  return snapshots.find(condition => condition.asOf === businessDate) ?? available[0];
}

function catalogFor(locale: Locale, layer?: DashboardLayerId): CatalogEntry[] {
  const tr = navisTranslator(locale);
  return getRegistry('A').filter(r => layer === undefined || r.layer === layer).slice(0, MAX_CATALOG)
    .map(r => ({ id: r.id, name: tr.has(r.nameKey) ? tr.t(r.nameKey) : r.label, layer: r.layer, conditions: conditionsOf(r.id) }));
}

const widgetStatusFacts: Partial<Record<FeatureId, readonly string[]>> = {
  'inventory-booking': ['inventory.restock.count', 'inventory.outOfStock.count'],
  menu: ['menu.count'],
  margin: ['margin.sales.net', 'margin.rate', 'margin.coverage'],
  calendar: ['calendar.today.count', 'calendar.entries.count', 'calendar.todo.count'],
  tax: ['tax.review.count'],
};

export function widgetStatusQuery(text: string) {
  const value = normalizeNavisInput(text).replace(/[.!?。！？]+$/u, '');
  const topic = /^(?:오늘\s*)?(.+?)(?:은|는|이|가)?\s*(?:상태(?:가)?\s*(?:어때|알려\s*(?:줘|주세요)|보여\s*(?:줘|주세요))|(?:왜\s*)?비어\s*있(?:어|는데\s*왜\s*그래)|(?:오류|에러)\s*났어|일부\s*없어)$/u.exec(value)?.[1];
  if (!topic) return undefined;
  const featureId = matchWidget(topic) ?? (topic === '세무관리' ? 'tax' : null);
  const factKeys = featureId && widgetStatusFacts[featureId];
  return featureId && factKeys ? { featureId, factKeys } : undefined;
}

export const assistantDomains = createDomainRegistry(registeredDomains);

export type AgentReadEvidence =
  | { readonly tool: 'get_widget'; readonly args: { readonly featureId: FeatureId; readonly condition: QueryCondition }; readonly status: 'ready' | 'missing' | 'unavailable' | 'unsupported_period'; readonly facts: readonly SnapshotFact[] }
  | { readonly tool: 'get_source'; readonly args: { readonly sourceId: AgentSourceId; readonly condition: QueryCondition }; readonly status: 'ready' | 'missing' | 'unavailable' | 'unsupported_period'; readonly facts: readonly SnapshotFact[] }
  | { readonly tool: AgentReadProjection['tool']; readonly args: AgentReadProjection['args']; readonly status: 'ready' | 'missing' | 'unavailable' | 'unsupported_period'; readonly facts: readonly SnapshotFact[] }
  | { readonly tool: 'search_records'; readonly args: AgentSearchArgs; readonly status: 'ready' | 'missing' | 'unavailable'; readonly matches: AgentSearchProjection['matches'];
      readonly display?: ReadonlyMap<string, string>; readonly browse?: boolean };

export function buildAgentRequest(
  snapshot: DataSnapshot, intent: AgentRequest['intent'], locale: Locale, layer: DashboardLayerId, slots: readonly string[],
  projection: Pick<AgentRequest, 'snapshot' | 'searches'> = { snapshot: [], searches: [] },
  domains = assistantDomains,
): AgentRequest | null {
  if (!snapshot.runId) return null;
  const scope = new Set<string>(projection.snapshot.flatMap(row => 'featureId' in row ? [row.featureId] : []));
  if (intent.kind === 'read') {
    if (intent.featureId) scope.add(intent.featureId);
    for (const feature of domains.readFeatures(intent.tool, intent.recordKind)) scope.add(feature);
  } else if (intent.kind === 'menu.create') scope.add('menu');
  else if (intent.kind === 'command' && !isAgentNavigationCommand(intent.command)) {
    const feature = agentCommandPolicy(intent.command, intent.args).featureId;
    if (feature) scope.add(feature);
  }
  const sourceOnly = intent.kind === 'read' && !!intent.sourceId && !intent.featureId;
  const catalog = (sourceOnly ? [] : catalogFor(locale)).filter(entry => !scope.size || scope.has(entry.id)).map(entry => ({
    ...entry,
    conditions: [...new Map([
      ...entry.conditions,
      ...projection.snapshot.flatMap(row => 'featureId' in row && row.featureId === entry.id && 'facts' in row ? [row.condition] : []),
    ].map(condition => [JSON.stringify(condition), condition])).values()],
  }));
  return { runId: snapshot.runId, snapshotRevision: snapshot.revision, businessDate: snapshot.pos?.businessDate ?? TODAY,
    locale, layer, intent, slots, catalog, ...projection };
}

export function projectAgentWidget(snapshot: DataSnapshot, featureId: FeatureId, condition: QueryCondition, locale: Locale, domains = assistantDomains): Extract<AgentReadEvidence, { tool: 'get_widget' }> {
  const args = { featureId, condition };
  const domain = domains.projectWidget(snapshot, featureId, condition, locale);
  if (domain && !(featureId === 'menu' && 'status' in domain && domain.status === 'missing')) return { tool: 'get_widget', args, ...('facts' in domain
    ? { facts: domain.facts, status: domain.facts.length ? 'ready' : 'missing' }
    : { facts: [], status: domain.status }) };
  const supported = normalizeFor(featureId, condition);
  if (!supported) return { tool: 'get_widget', args, status: 'unsupported_period', facts: [] };
  const source = snapshotFactSource(() => snapshot);
  const view = source.view(featureId, supported);
  const rawFacts: readonly ModelFact[] = view.status === 'ready' ? (featureId === 'menu' ? widgetFacts(view) : source.facts(view))
    : featureId === 'menu' && view.status === 'empty' ? [{ key: 'menu.count', value: 0, unit: 'count', labelKey: 'data.fact.menu.count' }] : [];
  const facts = rawFacts.map(fact => localizeFact(fact, locale));
  const status = facts.length ? 'ready' : view.status === 'error' ? 'unavailable' : 'missing';
  return { tool: 'get_widget', args, status, facts };
}

export function projectAgentSource(snapshot: DataSnapshot, sourceId: AgentSourceId, condition: QueryCondition, locale: Locale,
  domains = assistantDomains, run?: RunState): Extract<AgentReadEvidence, { tool: 'get_source' }> {
  const args = { sourceId, condition };
  if (sourceId !== 'pos' && sourceId !== 'demand') return { tool: 'get_source', args, status: 'unavailable', facts: [] };
  const facts = snapshotFactSource(() => snapshot).readSource!(sourceId);
  const scoped = facts.filter(fact => condition.kind === 'default' ||
    (condition.kind === 'snapshot' ? fact.date === condition.asOf : !!fact.date && fact.date >= condition.start && fact.date <= condition.end));
  const extended = domains.projectSource(snapshot, sourceId, condition, locale, run) ?? [];
  const status = scoped.length || extended.length ? 'ready' : condition.kind === 'default' ? 'missing' : 'unsupported_period';
  return { tool: 'get_source', args, status, facts: [...scoped.map(fact => localizeFact(fact, locale)), ...extended] };
}

export function projectAgentSearch(
  registry: DomainRegistry, snapshot: DataSnapshot, args: AgentSearchArgs, query: string, locale: Locale, privateLookup = false, command?: string,
): AgentSearchProjection {
  const matches = registry.reader(args.kind)?.search({ snapshot, locale, query, privateLookup, command, querySlot: args.querySlot }) ?? [];
  // The cursor is accepted only by the turn that issued it. This port projects its first page.
  return { kind: args.kind, querySlot: args.querySlot, matches: args.cursor ? [] : matches.slice(0, 5),
    ...(!registry.reader(args.kind) || args.cursor ? { status: 'unavailable' as const } : matches.length ? {} : { status: 'missing' as const }),
  };
}

/** The initial write turn shares catalog metadata, slot names and scoped lookup handles. */
export function buildMenuAgentRequest(snapshot: DataSnapshot, draft: LocalMenuDraft, locale: Locale, layer: DashboardLayerId, domains = assistantDomains): AgentRequest | null {
  return buildAgentRequest(snapshot, { kind: 'menu.create', category: draft.category }, locale, layer,
    ['name', ...(isMenuPrice(draft.price) ? ['price'] : []), ...(draft.memo ? ['memo'] : [])],
    { snapshot: [], searches: [projectAgentSearch(domains, snapshot, { kind: 'menu', querySlot: 'name' }, draft.name, locale, true)] }, domains);
}

export function conditionsOf(featureId: FeatureId): readonly QueryCondition[] {
  return isDataWidgetId(featureId) ? supportedConditions(featureId) : [defaultCondition];
}

/** One fact with the language's display string (numbers via the formatters, text via the data bundle). */
export function localizeFact(fact: ModelFact, locale: Locale): SnapshotFact {
  const tr = navisTranslator(locale);
  const t = (key: string, params?: Record<string, string | number>) => tr.t(key, params);
  const text = fact.text ? resolveDataText(t, fact.text) : undefined;
  const source = fact.source ? resolveDataText(t, fact.source) : undefined;
  const label = fact.labelText ? resolveDataText(t, fact.labelText) : tr.has(fact.labelKey) ? tr.t(fact.labelKey) : fact.key;
  const f = tr.format;
  let display: string;
  if (typeof fact.value === 'number') {
    display = fact.unit === '' ? f.number(fact.value) : fact.unit === 'KRW' ? f.money(fact.value, 'compact') : f.count(fact.value, fact.unit);
  } else {
    display = text ?? fact.value;
  }
  return {
    key: fact.key, value: fact.value, unit: fact.unit,
    ...(fact.date ? { date: fact.date } : {}), ...(fact.start ? { start: fact.start } : {}), ...(fact.end ? { end: fact.end } : {}),
    label, display, ...(text ? { text } : {}), ...(source ? { source } : {}),
  };
}

/** Resolve a requested period only from the data module's supported conditions. */
function questionCondition(id: FeatureId, text: string): QueryCondition | null {
  const conditions = conditionsOf(id), key = norm(text);
  const dates = text.match(/\d{4}[-./]\d{2}[-./]\d{2}/gu)?.map(date => date.replace(/[./]/gu, '-'));
  if (dates?.length) return dates.length <= 2 ? normalizeFor(id, dates.length === 1 && conditions[0].kind === 'snapshot' ? { kind: 'snapshot', asOf: dates[0] } : { kind: 'dateRange', start: dates[0], end: dates.at(-1)! }) : null;
  if (/\d{4}[-./]\d/u.test(key) || has(key, ['내일', 'tomorrow', '明天', '明日'])) return null;
  if (has(key, PAST_WORDS)) return null;
  if (has(key, WEEK_WORDS) && (id === 'ledger' || id === 'margin')) return conditions.find(c => c.kind === 'dateRange') ?? null;
  return conditions[0];
}

/** Keep item facts together, while excluding the unrelated rows of the same widget. */
function questionFacts(id: FeatureId, facts: readonly ModelFact[], text: string): readonly ModelFact[] {
  const key = norm(text), normalizeItem = (value: string) => norm(value).replace(/라떼/gu, '라테');
  const itemKey = normalizeItem(text);
  const labels = (fact: ModelFact) => (['ko', 'en', 'zh-Hans', 'zh-Hant'] as const).map(locale => normalizeItem(localizeFact(fact, locale).label));
  const matching = facts.filter(f => f.labelText && labels(f).some(label => label.length > 1 && itemKey.includes(label)));
  if (id === 'inventory-booking') {
    if (matching.length) return matching;
    const requested = ['data.item.milk', 'data.item.beans'].filter(ingredient =>
      (['ko', 'en', 'zh-Hans', 'zh-Hant'] as const).some(locale => itemKey.includes(normalizeItem(navisTranslator(locale).t(ingredient)))));
    if (requested.length) return facts.filter(fact => requested.includes(inventoryIngredientKey(fact.labelText) ?? ''));
  }
  if (id === 'menu') return matching.length ? matching.filter(f => f.key === 'menu.cost' || f.key === 'menu.marginRate') : facts.filter(f => f.key === 'menu.count');
  if (id === 'members') return has(key, ['단골']) ? facts.filter(f => f.key === 'members.regular.count') : facts.filter(f => f.key !== 'members.regular.count');
  if (id === 'manuals') {
    const steps = facts.filter(f => f.key === 'manuals.step');
    const terms = text.toLocaleLowerCase().split(/\s+/u).map(norm).filter(term => term.length > 1 && !['매뉴얼', 'manual', 'manuals', '手册', '手冊', '작성'].includes(term));
    const relevant = steps.filter(f => terms.some(term => (['ko', 'en', 'zh-Hans', 'zh-Hant'] as const).some(locale => norm(localizeFact(f, locale).source ?? '').includes(term))));
    return terms.length ? relevant : steps;
  }
  if (id === 'ledger' && normalizedRules.some(([topic, words]) => topic === 'ledger' && words.some(word => key.includes(word)))) {
    const finance = has(key, ['입금', '충전', '외상', '미수금', '회원권', '구독']);
    return facts.filter(f => f.key.startsWith('ledger.sales.') || finance && f.key.startsWith('accounting.'));
  }
  return facts;
}

/** Preserve question intent independently of how much current-layer context is sent. */
export function questionContext(text: string) {
  const key = norm(text), registry = getRegistry('A');
  const clauses = text.split(/[,;，；]|그리고|및|[과와]\s+|\s+and\s+|\s+&\s+/iu).filter(clause => norm(clause));
  const demand = has(key, CUSTOMERS) && has(key, TOMORROW_WORDS), pos = isPosQuestion(text), drawer = isDrawerQuestion(text);
  const topics = new Set(normalizedRules.filter(([, words]) => words.some(word => key.includes(word))).map(([id]) => id));
  const namesById = new Map(registry.map(registration => [registration.id, [registration.label, ...(['ko', 'en', 'zh-Hans', 'zh-Hant'] as const).map(locale => navisTranslator(locale).t(registration.nameKey))]]));
  const matchesTopic = (id: FeatureId, clause: string) => {
    const normalized = norm(clause);
    return normalizedRules.some(([topic, words]) => topic === id && words.some(word => normalized.includes(word))) || namesById.get(id)?.some(name => normalized.includes(norm(name))) || matchWidget(clause) === id;
  };
  const topicText = (id: FeatureId) => clauses.filter(clause => matchesTopic(id, clause)).join(' ') || text;
  for (const registration of registry) if (clauses.some(clause => matchesTopic(registration.id, clause))) topics.add(registration.id);
  if ((demand || pos) && !clauses.some(clause => matchesTopic('customer-analysis', clause) && !isDemandQuestion(clause) && !isPosQuestion(clause))) topics.delete('customer-analysis');
  // The specific aggregate member question wins over the generic regular-customer topic.
  if (topics.has('menu') && !normalizedRules.some(([id, words]) => id === 'margin' && words.filter(word => !['원가', '成本'].includes(word)).some(word => key.includes(word)))) topics.delete('margin');
  if (topics.has('members') && has(key, ['단골몇명', '회원몇명'])) topics.delete('customer-groups');
  if (!key || has(key, REMOVED_WORDS)) topics.clear();
  return { clauses, demand, pos, drawer, topics, topicText };
}

export function buildAssistantContext(options: { readonly text?: string; readonly layer?: DashboardLayerId; readonly source?: WidgetFactSource; readonly store?: WidgetDataStore; readonly locale?: Locale } = {}): AssistantContext {
  const { text = '', layer = 'management', locale = 'ko' } = options;
  const source = options.source ?? storeFactSource(options.store ?? defaultStore()), key = norm(text);
  const registry = getRegistry('A');
  const catalog = catalogFor(locale, layer);
  const snapshot: SnapshotEntry[] = [];
  const { clauses, demand, pos, drawer, topics, topicText } = questionContext(text);
  const activeIds = new Set(catalog.map(entry => entry.id));
  const recognized = !!key && !has(key, REMOVED_WORDS);
  for (const registration of registry) {
    const currentLayer = activeIds.has(registration.id);
    if (!currentLayer && (!recognized || !topics.has(registration.id))) continue;
    const requested = currentLayer ? undefined : questionCondition(registration.id, topicText(registration.id));
    if (requested === null) { snapshot.push({ featureId: registration.id, condition: conditionsOf(registration.id)[0], unavailable: true }); continue; }
    const conditions = currentLayer ? conditionsOf(registration.id) : [requested!];
    for (const condition of conditions) {
      const view = source.view(registration.id, condition);
      const normalFacts = view.status === 'ready' ? source.facts(view) : [];
      const facts = currentLayer ? normalFacts : questionFacts(registration.id, normalFacts, topicText(registration.id));
      snapshot.push(facts.length ? { featureId: registration.id, condition, facts: facts.map(f => localizeFact(f, locale)) } : { featureId: registration.id, condition, unavailable: true });
    }
  }
  if (!recognized) return { snapshot, catalog };
  if (source.readSource) {
    for (const sourceId of ['demand', 'pos'] as const) {
      if (sourceId === 'demand' ? !demand : !pos && !drawer) continue;
      const sourceText = clauses.filter(clause => sourceId === 'demand' ? isDemandQuestion(clause) : isPosQuestion(clause) || isDrawerQuestion(clause)).join(' ') || text;
      const sourceDates = sourceText.match(/\d{4}[-./]\d{2}[-./]\d{2}/gu)?.map(date => date.replace(/[./]/gu, '-'));
      const facts = source.readSource(sourceId).filter(f => has(norm(sourceText), PAST_WORDS) || sourceDates?.some(date => date !== f.date) ? false : sourceId === 'demand' ? f.date === TOMORROW && (f.key === 'demand.expected.total' || f.key === 'demand.expected.band') : drawer && pos ? f.key.startsWith('pos.cash.') || f.key.startsWith('orders.') : drawer ? f.key.startsWith('pos.cash.') : f.key.startsWith('orders.'));
      snapshot.push({ sourceId, condition: defaultCondition, facts: facts.map(f => localizeFact(f, locale)), candidateAllowed: false });
    }
  }
  return { snapshot, catalog };
}

/** The widget's own normalized condition (data widgets via the data module, others default only), or null. */
export function normalizeFor(featureId: FeatureId, condition: QueryCondition): QueryCondition | null {
  if (!getRegistry('A').some((entry) => entry.id === featureId) || !condition || typeof condition !== 'object' || Array.isArray(condition)) return null;
  const keys = Object.keys(condition);
  if (condition.kind === 'default' ? keys.length !== 1 : condition.kind === 'snapshot' ? keys.length !== 2 || !keys.includes('asOf') : condition.kind === 'dateRange' ? keys.length !== 3 || !keys.includes('start') || !keys.includes('end') : true) return null;
  if (isDataWidgetId(featureId)) { const n = normalizeCondition(featureId, condition); return n.ok ? n.value : null; }
  return condition && typeof condition === 'object' && condition.kind === 'default' ? conditionsOf(featureId)[0] : null;
}

/** Store facts as the iteration-3 `WidgetData` shape with ready-to-show text: key = label, value = display. */
export function displayData(featureId: FeatureId, condition: QueryCondition, facts: readonly SnapshotFact[]): import('../../contracts').WidgetData {
  return { featureId, sourceKey: `widget:${featureId}`, condition, facts: facts.map((f) => ({ key: f.label, value: f.display, unit: '', ...(f.date ? { date: f.date } : {}) })) };
}
