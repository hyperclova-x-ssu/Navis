/** Full current-layer normal facts, with question-scoped other-layer and source-only context. */
import { getRegistry } from '../../catalog';
import type { DashboardLayerId, FeatureId, Locale, QueryCondition, RunState } from '../../contracts';
import { createWidgetDataStore, demandFacts, posFacts, isDataWidgetId, TOMORROW, selectMembers, selectMenus, selectTaxPayments, TODAY, normalizeCondition, NORMAL_VARIANT, resolveDataText, selectWidget, supportedConditions, widgetFacts, type ModelFact, type WidgetDataStore } from '../../data/widget-data';
import type { WidgetView } from '../../data/widget-data';
import { conditionKey } from '../../data/conditions';
import type { DataSnapshot } from '../../data/db/types';
import type { AgentReadProjection, AgentRequest, AgentSearchArgs, AgentSearchProjection, AgentSourceId } from '../../../shared/navis-agent-schema.mjs';
import { agentCommandPolicy, isAgentNavigationCommand } from '../../../shared/navis-agent-schema.mjs';
import { addDays, daysBetween } from '../../data/db/time';
import { isMenuPrice, type MenuDraft } from './domains/menu';
import { createDomainRegistry, registeredDomains, type DomainRegistry, type DomainTurnInput } from './domains/registry';
import { navisMoneySpans, normalizeNavisInput, parseMenuCategoryChoice, parseNavisDate, parseNavisMoney, parseNavisPeriod } from './navis-input';
import { inventoryIngredientKey } from './inventory-ingredients';
import { navisTranslator } from './messages';
import { norm, has, normalizedRules, CUSTOMERS, TOMORROW_WORDS, PAST_WORDS, WEEK_WORDS, REMOVED_WORDS, isPosQuestion, isDrawerQuestion, isDemandQuestion, matchWidget } from './question';
import { selectM2DayTotals } from '../../data/pos/projection';
import { unreadableDomain, unreadableSource, unreadableWidget } from './real-gate';
import { realStock, stockDate } from '../../data/reality/03/stock-projection';
import { peakOrderFacts, recentOrderFacts } from './domains/recent-orders';

export const MAX_CATALOG = 32;
const defaultCondition: QueryCondition = Object.freeze({ kind: 'default' });

/** Where views and facts come from. The default reads the data store; tests may inject facts. */
export interface WidgetFactSource {
  view(featureId: FeatureId, condition: QueryCondition): WidgetView<unknown>;
  facts(view: WidgetView<unknown>): readonly ModelFact[];
  readSource?(sourceId: 'demand' | 'pos'): readonly ModelFact[];
}
export function storeFactSource(store: WidgetDataStore): WidgetFactSource {
  const source = snapshotFactSource(store.getSnapshot);
  return {
    view: (featureId, condition) => unreadableWidget(store, featureId)
      ? { featureId, status: 'error', variant: NORMAL_VARIANT, messageKey: 'data.real.error.SOURCE_UNAVAILABLE' }
      : source.view(featureId, condition),
    facts: view => !unreadableWidget(store, view.featureId) ? source.facts(view, !unreadableDomain(store, 'pos')) : [],
    readSource: sourceId => unreadableSource(store, sourceId) ? [] : source.readSource(sourceId),
  };
}

function snapshotFactSource(getSnapshot: () => DataSnapshot): Omit<Required<WidgetFactSource>, 'facts'> & {
  facts(view: WidgetView<unknown>, includePos?: boolean): readonly ModelFact[];
} {
  return {
    view: (featureId, condition) => selectWidget(getSnapshot(), featureId, condition, NORMAL_VARIANT),
    facts: (view, includePos = true) => {
      const facts = widgetFacts(view);
      if (view.status !== 'ready') return facts;
      const snapshot = getSnapshot();
      // Only today's period can use today's receipt projection; historical deposits stay unavailable.
      const todayOnly = view.condition.kind === 'default' && (view.featureId === 'ledger' || view.featureId === 'briefing')
        || view.condition.kind === 'dateRange' && view.condition.start === TODAY && view.condition.end === TODAY
        || view.condition.kind === 'snapshot' && view.condition.asOf === TODAY;
      if (includePos && todayOnly && (view.featureId === 'ledger' || view.featureId === 'tax' || view.featureId === 'briefing')) {
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
const menuMemo = /(?:\s+\(?|\()메모(?:는|를)?(?:\s*:\s*|\s+)/u;

export function isMenuCreateRequest(text: string): boolean {
  const value = normalizeNavisInput(text).split(menuMemo, 1)[0].replace(/["“'‘][^"”'’]+["”'’]/gu, ' ');
  if (!createMenuVerb.test(value) || helpOrLayout.test(value) || notARequest.test(value)
    || /(?:화면|폼|양식|창)\s*(?:열어|보여|띄워)|\bopen\b/iu.test(value)) return false;
  // "카페라떼 메뉴에 샷 추가 옵션 500원 저장해줘" edits a part (option, recipe) of an existing menu; it is not a new menu.
  if (/옵션|추가금|레시피/u.test(value)) return false;
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
  const explicit = /(?:분류|카테고리)(?:는|를)?\s*[:：]?\s*([^\s,]+)/iu.exec(name)?.[1];
  const category = parseMenuCategoryChoice(explicit ?? name);
  if (category) return category;
  if (/(?:디저트|\bdesserts?\b|甜点|甜點)/iu.test(name)) return 'dessert';
  if (/(?:음료|\b(?:drinks?|beverage)\b|饮品|飲品)/iu.test(name)) return 'beverage';
  if (/(?:쿠키|마들렌|케이크|스콘|브라우니|크루아상)/u.test(name)) return 'dessert';
  if (/(?:아메리[카까]노|에스프레소|콜드브루|마[키끼]|카페\s*라[테떼]|커피|\b(?:americano|espresso|coffee)\b|咖啡)/iu.test(name)) return 'coffee';
  if (/(?:캐모마일|홍차|녹차|밀크티|(?:^|\s)티(?:\s|$)|\btea\b|茶)/iu.test(name)) return 'tea';
  return /(?:라[테떼]|에이드|스무디|주스|\b(?:latte|smoothie|juice)\b)/iu.test(name) ? 'beverage' : undefined;
}

export function parseMenuCreateInput(text: string): MenuCreateInput | null {
  if (!isMenuCreateRequest(text) || text.length > 300 || /[\r\n]/u.test(text)) return null;
  const phrase = text.trim();
  const memoStart = menuMemo.exec(phrase);
  const memo = memoStart && phrase.slice(memoStart.index + memoStart[0].length)
    .replace(/\)?(?:으로\s*(?:해줘|해주세요))?$/u, '').replace(/^["'“‘]|["'”’]$/gu, '').trim();
  const body = normalizeNavisInput(memoStart ? phrase.slice(0, memoStart.index) : phrase).replace(/[.!。！]+$/u, '');
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
  name = name.replace(/(?:분류|카테고리)(?:는|를)?\s*[:：]?\s*(?:커피|티|차|음료|디저트|coffee|tea|beverage|drinks?|desserts?|咖啡|茶|饮品|飲品|甜点|甜點)/giu, ' ')
    .replace(/(?:^|\s)(?:디저트|음료|desserts?|beverage|drinks?)(?:을|를)?(?=\s|$)|甜点|甜點|饮品|飲品/giu, ' ')
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

export function catalogFor(locale: Locale, layer?: DashboardLayerId, snapshot?: DataSnapshot): CatalogEntry[] {
  const tr = navisTranslator(locale);
  return getRegistry('A').filter(r => layer === undefined || r.layer === layer).slice(0, MAX_CATALOG)
    .map(r => ({ id: r.id, name: tr.has(r.nameKey) ? tr.t(r.nameKey) : r.label, layer: r.layer, conditions: conditionsOf(r.id, snapshot) }));
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

/** A recognized plain question compiled to one typed read. `unsupported` means the period has no widget condition: no tool is called. */
export interface PlainRead {
  readonly intent: Extract<AgentRequest['intent'], { kind: 'read' }>;
  readonly factKeys?: readonly string[];
  /** Keeps the facts the question asks for (largest, lowest or empty rows); every other fact stays out of the answer. */
  readonly narrow?: (facts: readonly SnapshotFact[]) => readonly SnapshotFact[];
  readonly unsupported?: { readonly featureId: FeatureId; readonly condition: QueryCondition; readonly answer?: string };
  /** For an ordered read list (`intent.reads`): which facts each read keeps, by position. */
  readonly parts?: readonly PlainReadPart[];
  /** Two typed values from the read list that the answer compares (same unit, exact equality). */
  readonly compare?: readonly [string, string];
}
export interface PlainReadPart { readonly factKeys?: readonly string[]; readonly narrow?: PlainRead['narrow'] }

const WRITE_OR_LAYOUT = /(?:추가|등록|삭제|지워|바꿔|변경|수정|올려|내려|보내|발송|열어|보여|띄워|이동|가줘|취소|빼\s*줘|놔\s*줘|넣어|저장|처리|하자|해\s*줘$)/u;
const extreme = (order: 'min' | 'max') => (facts: readonly SnapshotFact[]): readonly SnapshotFact[] => {
  const numbers = facts.flatMap(fact => typeof fact.value === 'number' ? [fact.value] : []);
  if (!numbers.length) return [];
  const best = order === 'max' ? Math.max(...numbers) : Math.min(...numbers);
  return facts.filter(fact => fact.value === best);
};
const emptyStock = (facts: readonly SnapshotFact[]) => facts.filter(fact => fact.key === 'inventory.outOfStock.count' || fact.key.startsWith('inventory.stock.') && fact.value === 0);
const itemOf = (value: string) => /^([가-힣A-Za-z0-9]{2,12})\s+(?:언제|입고|발주|납품|배송|도착)/u.exec(value)?.[1];
/** The open delivery rows that name the asked item; with none, the upcoming and overdue counts say that nothing is open. */
const deliveriesOf = (item: string | undefined) => (facts: readonly SnapshotFact[]) => {
  const rows = facts.filter(fact => /^suppliers\.(?:upcoming\.order|overdue\.order|delivery)$/u.test(fact.key)
    && (!item || `${fact.label} ${fact.display}`.includes(item)));
  return rows.length ? rows : facts.filter(fact => fact.key === 'suppliers.upcoming.count' || fact.key === 'suppliers.overdue.count');
};
const rateOf = (fact: SnapshotFact) => /(\d+(?:\.\d+)?)%/u.exec(fact.display)?.[1];
/** The lowest margin rate per menu (ties stay together): the typed `margin.menu.rate` facts, or the percent shown on each menu row. */
const lowestMargin = (facts: readonly SnapshotFact[]): readonly SnapshotFact[] => {
  const typed = facts.filter(fact => fact.key === 'margin.menu.rate' && typeof fact.value === 'number');
  const rows = typed.length ? typed.map(fact => ({ fact, rate: fact.value as number }))
    : facts.filter(fact => fact.key === 'margin.menu.row').flatMap(fact => { const rate = rateOf(fact); return rate === undefined ? [] : [{ fact, rate: Number(rate) }]; });
  const lowest = Math.min(...rows.map(row => row.rate));
  return rows.filter(row => row.rate === lowest).map(row => row.fact);
};
const readOf = (featureId: FeatureId, condition: QueryCondition): PlainRead['intent'] => ({ kind: 'read', featureId, condition });
const fullMoney = (facts: readonly SnapshotFact[]): readonly SnapshotFact[] => facts.map(fact =>
  fact.unit === 'KRW' && typeof fact.value === 'number' ? { ...fact, display: navisTranslator('ko').format.money(fact.value, 'full') } : fact);
const widgetRead = (featureId: FeatureId) => ({ name: 'get_widget' as const, args: { featureId, condition: { kind: 'default' as const } } });
const labelKey = (value: string) => norm(value).replace(/라떼/gu, '라테');
/** Filter a per-menu fact by name. A bare 라떼 refers to the café latte. */
const namedMargin = (item: string, keys: readonly string[]) => (facts: readonly SnapshotFact[]): readonly SnapshotFact[] => {
  const wanted = labelKey(item) === '라테' ? '카페라테' : labelKey(item);
  const matches = facts.filter(fact => keys.includes(fact.key) && labelKey(fact.label).includes(wanted));
  const exact = matches.filter(fact => labelKey(fact.label) === wanted);
  return exact.length ? exact : matches;
};

const salePeriodPhrase = /\d{4}[-./]\d{2}[-./]\d{2}(?:부터|까지)?|(?:최근|지난)?\s*\d{1,3}\s*일(?:간|\s*동안)?|일\s*주일|(?:최근\s*)?한\s*달|(?:이번|지난|저번|다음)\s*(?:주|달)|오늘|어제|그제|내일|[~～]/gu;

function saleMarginRead(value: string, businessDate: string): PlainRead | undefined {
  if (!/원가|마진|남는\s*비율/u.test(value)) return;
  const period = parseNavisPeriod(value, businessDate);
  const date = parseNavisDate(value, businessDate);
  if (!period && !date && !/판매\s*(?:원가|마진율?|남는\s*비율)|팔린/u.test(value)) return;
  const question = value.replace(salePeriodPhrase, '').replace(/(?:판매(?:한)?|팔린)\s*(?:기준\s*)?/gu, '').replace(/\s+/gu, ' ').trim();
  const match = /^(.*?)\s*((?:원가\s*(?:랑|와|하고|및)\s*)?(?:마진율?|남는\s*비율)|원가)(?:이|은|는|을)?\s*(?:얼마(?:야|예요)?|몇\s*(?:퍼센트|퍼|%)|알려\s*(?:줘|주세요))?$/u.exec(question);
  if (!match) return;
  const item = match[1].trim().replace(/의$/u, '');
  if (!item || /^(?:전체|가게|매장|우리|평균|총)$|매출|가격|레시피|한\s*잔|현재|지금/u.test(item)) return;
  const keys = [
    ...(match[2].startsWith('원가') ? ['margin.menu.salesCost'] : []),
    ...(match[2] !== '원가' ? ['margin.menu.salesRate'] : []),
  ];
  const range = period ?? (date ? { start: date, end: date } : undefined);
  const condition: QueryCondition = range && (range.start !== businessDate || range.end !== businessDate)
    ? { kind: 'dateRange', ...range } : defaultCondition;
  const intent = readOf('margin', condition);
  if (!normalizeCondition('margin', condition).ok) return { intent, unsupported: { featureId: 'margin', condition } };
  return { intent, factKeys: keys, ...(!/^(?:메뉴|메뉴별|품목별)$/u.test(item) && { narrow: namedMargin(item, keys) }) };
}

/** The menu names a "which is pricier" question mentions, kept in the order asked (a bare 라떼 is the café latte). */
const namedMenuPrices = (names: readonly string[]) => (facts: readonly SnapshotFact[]): readonly SnapshotFact[] =>
  names.flatMap(name => {
    const wanted = labelKey(name) === '라테' ? '카페라테' : labelKey(name);
    const prices = facts.filter(fact => fact.key === 'menu.price');
    const exact = prices.filter(fact => labelKey(fact.label) === wanted);
    return (exact.length ? exact : prices.filter(fact => labelKey(fact.label).includes(wanted))).slice(0, 1);
  });
const MENU_PAIR = /^(.{1,14}?)\s*(?:이랑|랑|하고|과|와)\s+(.{1,14}?)\s*(?:중에서?|중|가격)?\s*(?:뭐가|어느\s*게|어떤\s*게|누가|뭐)?\s*(?:더\s*)?(?:비싸|싸\b|싼|가격\s*(?:비교|차이))/u;
/**
 * Menu price chains: "아메리카노 가격 알려줘" → "카페라떼는?" → "둘 중에 뭐가 더 비싸?". The follow-ups are rewritten into full questions from the
 * menus asked about so far (`trail`, newest last); `rememberMenuPriceQuestion` keeps that trail and any other question starts a new one.
 */
export function menuPriceFollowUp(text: string, trail: readonly string[]): string | undefined {
  const value = normalizeNavisInput(text).replace(/[.!?。！？]+$/u, '').trim();
  const bare = /^(?:그럼|그러면|그리고|아니면)?\s*(.{1,14}?)\s*(?:은|는|도|건)$/u.exec(value)?.[1]?.trim();
  if (bare && trail.length && !/^(?:오늘|내일|어제|이번|지난|저번|둘|그거|이거|저거)/u.test(bare) && !PERIOD_ONLY.test(bare)) return `${bare} 가격 알려줘`;
  if (trail.length >= 2 && /^(?:그럼\s*)?(?:둘|두\s*(?:개|메뉴)?)\s*(?:중에서?|중)?\s*(?:뭐가|어느\s*게|어떤\s*게|누가)?\s*(?:더\s*)?(?:비싸|싸)/u.test(value)) {
    return `${trail.at(-2)}랑 ${trail.at(-1)} 중에 뭐가 더 비싸?`;
  }
  return undefined;
}
export function rememberMenuPriceQuestion(text: string, trail: string[]): void {
  const value = normalizeNavisInput(text).replace(/[.!?。！？]+$/u, '').trim();
  const asked = /^(.{1,14}?)\s*(?:의\s*)?(?:가격|값)(?:\s*(?:이|은|는))?\s*(?:얼마|알려|뭐)/u.exec(value)?.[1]?.trim();
  if (asked && !/매출|마진|원가|지출|세금|재고/u.test(asked)) trail.push(asked);
  else if (!MENU_PAIR.test(value)) trail.length = 0;
  if (trail.length > 4) trail.splice(0, trail.length - 4);
}
const PERIOD_ONLY = /^(?:이번|지난|저번|다음)\s*(?:주|달)|^이달$|^최근\s*\d|^일주일$|^한\s*달$/u;

const NAV_VERBS = /열어|보여|띄워|이동|가줘|위젯|패널|대시보드|보드|추가|등록|삭제|지워|바꿔|변경|수정|취소|환불|줄여|키워|늘려|확대|축소|크게|작게|\d\s*(?:x|×|곱하기|by)\s*\d|읽었|읽음|봤어|확인했|처리/u;
const RECENT_ORDER_WORDS = /(?:최근|방금|아까|좀\s*전|막)\s*(?:에\s*)?(?:결제|주문|계산)|^주문\s*(?:좀\s*)?확인(?:해\s*줘|해줘|해\s*주세요|\s*좀)?$|^(?:새\s*)?주문\s*(?:들어왔|왔)(?:어|어요|나|니)?$|결제\s*(?:된|한)\s*거\s*(?:있|없|좀|뭐|알려)|커넥트|키오스크/u;
const BRIEFING_WORDS = /브리핑\s*(?:좀\s*)?(?:해|알려|들려|뭐|있)|^브리핑$|(?:오늘|지금)\s*(?:뭐|무엇)\s*(?:해야|할|챙|신경)|뭐\s*해야\s*(?:될|할|하는|돼|되)\s*(?:거|것|일)|챙길\s*(?:거|것)|신경\s*쓸|놓친|급한\s*(?:거|것|일)/u;
const STATUS_WORDS = /^(?:(?:요즘|요새|최근|오늘)\s*)?(?:(?:우리\s*)?(?:가게|장사|매장)\s*)?(?:어때|어떄|어떻게\s*(?:돼|되고|돌아가)|잘\s*(?:돼|되고|돌아가)|괜찮|상황\s*(?:어때|알려)|돌아가는\s*상황)$/u;
/** The ledger's daily net sales for the named dates, each date's money in full ("831,220원"), the newest first. */
const dailyOf = (dates: readonly string[]) => (facts: readonly SnapshotFact[]): readonly SnapshotFact[] =>
  fullMoney(dates.flatMap(date => facts.filter(fact => fact.key === 'ledger.sales.daily' && fact.date === date)));
const labelOf = (fact: SnapshotFact) => norm(fact.label).replace(/라떼/gu, '라테');
/** The lowest "days left at today's use" among the stock items (all ties), or only the asked item's. */
const lowestDaysLeft = (item?: string) => (facts: readonly SnapshotFact[]): readonly SnapshotFact[] => {
  const days = facts.filter(fact => fact.key.startsWith('inventory.daysLeft.') && typeof fact.value === 'number'
    && (!item || labelOf(fact).includes(norm(item).replace(/라떼/gu, '라테'))));
  if (!days.length || item) return days.slice(0, 3);
  const least = Math.min(...days.map(fact => fact.value as number));
  return days.filter(fact => fact.value === least).slice(0, 3);
};
const STOCK_LOW = /(?:제일|가장|젤)\s*(?:적게|조금)\s*남|거의\s*(?:다\s*)?(?:떨어|바닥)|곧\s*(?:다\s*)?떨어|얼마\s*안\s*남|떨어져\s*가|먼저\s*떨어/u;
// Only the hedged wording ("원두 언제쯤 떨어질 것 같아?"); "컵 언제 떨어져?" and "우유 며칠 쓸 수 있어?" are the inventory domain's reviewed answers.
const STOCK_ITEM_DAYS = /^(.{1,12}?)\s*(?:은|는|이|가)?\s*(?:언제쯤|언제\s*까지|얼마나\s*(?:버텨|버틸|갈))/u;
const BUSIEST = /(?:제일|가장|젤)\s*(?:붐비|바쁜|바쁠|바빠|손님\s*(?:많은|많이)|주문\s*(?:많은|많이))\s*(?:시간|때)/u;
const STATUS_LOOSE = /(?:장사|가게|매장)\s*(?:는\s*)?잘\s*(?:돼|되고|되는|돌아가)|(?:^|[?,]\s*)이상한\s*(?:거|것|점)\s*(?:없|있)(?:어|나|니)/u;
const UNSUPPORTED_PAST = '이 기간의 자료는 제공되지 않아요. 지난주·지난달·작년 매출은 따로 볼 수 없고, 볼 수 있는 기간은 오늘, 최근 7일, 최근 30일, 이번 달이에요.';
const YESTERDAY_KEYS = ['briefing.yesterday.sales.net', 'briefing.yesterday.sales.delta'] as const;
const BRIEFING_KEYS = ['briefing.importantAlerts.count', 'briefing.alert.item', 'briefing.arrival.item', 'briefing.reservations.today',
  'briefing.closing.netSales', 'briefing.tomorrow.reservations'] as const;
/** A fixed bundle of reads for one owner question: each part keeps the facts it names. */
const bundle = (parts: readonly { readonly read: ReturnType<typeof widgetRead> | { readonly name: 'get_widget'; readonly args: { readonly featureId: FeatureId; readonly condition: QueryCondition } };
  readonly factKeys: readonly string[]; readonly narrow?: PlainRead['narrow'] }[]): PlainRead => ({
  intent: { kind: 'read', reads: parts.map(part => part.read) },
  parts: parts.map(({ factKeys, narrow }) => ({ factKeys, ...(narrow && { narrow }) })),
});
function ownerQuestionRead(value: string, businessDate: string, stockDate: string): PlainRead | undefined {
  const asksSales = /매출|벌었|장사|판매액/u.test(value);
  if (RECENT_ORDER_WORDS.test(value) && !NAV_VERBS.test(value.replace(/주문\s*확인(?:해\s*줘|해줘)?$/u, '')) && !/예약|발주|메뉴|재고|쿠폰|세금|세무|리뷰|공지/u.test(value)) {
    return { intent: { kind: 'read', sourceId: 'pos', condition: defaultCondition }, factKeys: ['orders.recent.row', 'orders.open.count'] };
  }
  if (BRIEFING_WORDS.test(value) && !NAV_VERBS.test(value) && !/매출|재고|예약|쿠폰|세금|세무|리뷰|공지|발주|직원|근무/u.test(value.replace(/브리핑/gu, ''))) {
    return { intent: readOf('briefing', defaultCondition), factKeys: [...BRIEFING_KEYS] };
  }
  const pair = MENU_PAIR.exec(value);
  if (pair && !/매출|마진|지출|재고|쿠폰/u.test(value) && !NAV_VERBS.test(value)) {
    return { intent: readOf('menu', defaultCondition), factKeys: ['menu.price'], narrow: namedMenuPrices([pair[1].trim(), pair[2].trim()]) };
  }
  if (STOCK_LOW.test(value) && !/입고|발주|배송|메뉴|쿠폰/u.test(value) && /재고|재료|원두|우유|시럽|파우더|소스|컵|떨어|남은/u.test(value)) {
    return { intent: readOf('inventory-booking', { kind: 'snapshot', asOf: stockDate }), narrow: lowestDaysLeft() };
  }
  const stockItem = STOCK_ITEM_DAYS.exec(value)?.[1]?.trim();
  if (stockItem && !/입고|발주|배송|예약|손님|매출|쿠폰|세금/u.test(value) && !/^(?:오늘|내일|언제|그거|이거|저거|그럼)$/u.test(stockItem)) {
    return { intent: readOf('inventory-booking', { kind: 'snapshot', asOf: stockDate }), narrow: lowestDaysLeft(stockItem) };
  }
  if (BUSIEST.test(value) && !/상권|유동|지나가|동네|주변|카메라|CCTV|cctv/u.test(value)) {
    return { intent: { kind: 'read', sourceId: 'pos', condition: defaultCondition }, factKeys: ['orders.peak.hour'] };
  }
  if (STATUS_WORDS.test(value) || STATUS_LOOSE.test(value)) {
    const alerts = /이상|문제/u.test(value);
    const week = readNavisCondition('ledger', '이번 주', businessDate);
    return bundle([
      { read: widgetRead('ledger'), factKeys: ['ledger.sales.net'], narrow: fullMoney },
      ...(week ? [{ read: { name: 'get_widget' as const, args: { featureId: 'ledger' as FeatureId, condition: week } }, factKeys: ['ledger.sales.net'], narrow: fullMoney }] : []),
      { read: widgetRead('briefing'), factKeys: alerts ? [...YESTERDAY_KEYS, 'briefing.importantAlerts.count', 'briefing.alert.item'] : [...YESTERDAY_KEYS] },
    ]);
  }
  if (asksSales && /오늘/u.test(value) && /어제/u.test(value) && !/같은\s*요일|지난\s*(?:주|달)|저번|작년/u.test(value) && !NAV_VERBS.test(value)) {
    // Today and yesterday are two rows of the ledger's rolling week (the reviewed read for S1-273).
    const week = readNavisCondition('ledger', '이번 주', businessDate);
    if (week) return { intent: readOf('ledger', week), factKeys: ['ledger.sales.daily'], narrow: dailyOf([businessDate, addDays(businessDate, -1)]) };
  }
  if (asksSales && /오늘/u.test(value) && /(?:지난|저번)\s*주\s*같은\s*요일/u.test(value) && !NAV_VERBS.test(value)) {
    return { intent: readOf('ledger', defaultCondition), factKeys: ['ledger.sales.net', 'ledger.sales.delta', 'ledger.sales.base', 'ledger.closing.status'], narrow: fullMoney };
  }
  if (asksSales && /오늘/u.test(value) && (/비교|대비|보다|차이|늘었|줄었|올랐|내렸|같은\s*요일/u.test(value) || /어제/u.test(value)) && !NAV_VERBS.test(value)) {
    if (/지난\s*(?:주|달)(?!\s*같은)|저번\s*(?:주|달)|작년/u.test(value.replace(/지난\s*주\s*같은\s*요일/gu, ''))) {
      return { intent: readOf('ledger', defaultCondition), unsupported: { featureId: 'ledger', condition: { kind: 'dateRange', start: addDays(businessDate, -13), end: addDays(businessDate, -7) }, answer: UNSUPPORTED_PAST } };
    }
    return bundle([
      { read: widgetRead('ledger'), factKeys: ['ledger.sales.net'], narrow: fullMoney },
      { read: widgetRead('briefing'), factKeys: [...YESTERDAY_KEYS] },
    ]);
  }
  return undefined;
}

/**
 * "그럼 지난주는?", "이번 달은?": a bare period after a sales or margin read asks the same metric for that period. The question is
 * rewritten as a full one ("지난주 매출") and read like any other, so a period the widgets lack gets the same honest answer.
 */
export function periodFollowUp(text: string, last: { readonly intent?: AgentRequest['intent'] } | undefined): string | undefined {
  const intent = last?.intent;
  if (!intent || intent.kind !== 'read') return;
  const own = 'featureId' in intent ? intent.featureId : undefined;
  const features = new Set<string>([own, ...(('reads' in intent ? intent.reads : undefined) ?? []).map(read => (read.args as { featureId?: string } | undefined)?.featureId)]
    .filter((id): id is string => typeof id === 'string'));
  const sales = features.has('ledger'), margin = features.has('margin');
  if (!sales && !margin) return;
  const value = normalizeNavisInput(text).replace(/[.!?。！？]+$/u, '').trim();
  const asked = /^(?:그럼|그러면|그렇다면|그리고|아니면)?\s*((?:이번|지난|저번)\s*(?:주|달)|이달|최근\s*\d{1,3}\s*일|한\s*달|일주일)\s*(?:은|는|엔|에는|도|꺼|것)?\s*(?:얼마(?:야|예요|였어)?|어때|어땠어|알려\s*(?:줘|주세요))?$/u.exec(value)?.[1];
  if (!asked) return;
  return `${asked} ${sales ? '매출' : ''}${sales && margin ? ' ' : ''}${margin ? '마진' : ''}`;
}

export function coveredWeekSales(text: string, finance: DataSnapshot['tables']['realFinance']): DomainTurnInput | undefined {
  if (!finance || !/^(?:이번|지난|저번)\s*주(?:의)?\s*매출(?:은|이|을)?\s*(?:얼마(?:야|예요|였어)?|알려\s*(?:줘|주세요)|보여\s*(?:줘|주세요))?[.!?。！？]*$/u.test(text)) return;
  const period = parseNavisPeriod(text, finance.today);
  if (!period) return;
  const end = period.end > finance.today ? finance.today : period.end;
  if (period.start < finance.from || end > finance.to) return;
  return { intent: readOf('ledger', { kind: 'dateRange', start: period.start, end }), factKeys: ['ledger.sales.net'], narrow: fullMoney };
}

const METRIC_WORDS = /매출|판매|마진율?|지출|순이익|손익|수익|벌었|번\s*돈/gu;
const METRIC_FILLER = /(?:우리\s*)?(?:가게|매장)|알려\s*(?:줘|주세요)|보여\s*(?:줘|주세요)|얼마(?:야|예요|였어|나)?|나갔(?:어|어요)?|썼(?:어|어요)?|벌었(?:어|어요)?|어때|뭐야|몇|하고|이랑|[은는이가도랑과와의및,.?!~]/gu;
export const PERIOD_LABELS: Partial<Record<FeatureId, string>> = {
  ledger: '오늘, 최근 7일, 최근 30일, 이번 달', margin: '오늘, 최근 7일, 최근 30일',
};
/**
 * "이번 달 지출", "이번 주 매출이랑 마진", "최근 30일 마진": plain metric words plus a stated period. Each metric reads its widget at
 * the period that widget really supports (never today's value standing in for another period); a period the widget lacks says which ones exist.
 */
function periodMetricRead(value: string, businessDate: string): PlainRead | undefined {
  if (/차이|비교|대비|같(?!이)|똑같|안\s*맞|다른|달라|어제|그제|내일/u.test(value)) return;
  const period = parseNavisPeriod(value, businessDate);
  if (!period || !METRIC_WORDS.test(value)) { METRIC_WORDS.lastIndex = 0; return; }
  METRIC_WORDS.lastIndex = 0;
  const rest = value.replace(salePeriodPhrase, ' ').replace(METRIC_WORDS, ' ').replace(METRIC_FILLER, ' ').replace(/\s+/gu, '');
  if (rest) return;
  const wants = (pattern: RegExp) => pattern.test(value);
  const sales = wants(/매출|판매|벌었|번\s*돈|수익|손익|순이익/u), expenses = wants(/지출|손익|순이익/u), margin = wants(/마진/u);
  const reads: { featureId: FeatureId; keys: string[]; money: boolean }[] = [];
  if (sales || (!margin && !expenses)) reads.push({ featureId: 'ledger', keys: ['ledger.sales.net'], money: true });
  if (expenses) {
    const ledger = reads.find(read => read.featureId === 'ledger');
    if (ledger) ledger.keys.push('ledger.expenses.total'); else reads.push({ featureId: 'ledger', keys: ['ledger.expenses.total'], money: true });
  }
  if (margin) reads.push({ featureId: 'margin', keys: ['margin.rate'], money: false });
  const resolved = reads.map(read => ({ ...read, condition: readNavisCondition(read.featureId, value, businessDate) }));
  const missing = resolved.find(read => !read.condition || read.condition.kind === 'snapshot');
  // A margin-only question about a period the margin widget lacks keeps the menu domain's reviewed answer (A-3 S2-010).
  if (missing?.featureId === 'margin' && resolved.length === 1) return;
  if (missing) {
    const asked = value.replace(/\s+/gu, ' ');
    return { intent: readOf(missing.featureId, defaultCondition), unsupported: { featureId: missing.featureId, condition: { kind: 'dateRange', ...period },
      // The reviewed unsupported-period phrase leads (A-3 S1-277, S8-028); the supported periods follow.
      answer: `이 기간의 자료는 제공되지 않아요. ${/이번\s*달|이달/u.test(asked) && missing.featureId === 'margin' ? '마진은 이번 달 전체로는 볼 수 없고, ' : ''}볼 수 있는 기간은 ${PERIOD_LABELS[missing.featureId]}이에요.` } };
  }
  if (resolved.length === 1) {
    const [only] = resolved;
    return { intent: readOf(only.featureId, only.condition!), factKeys: only.keys, ...(only.money && { narrow: fullMoney }) };
  }
  return {
    intent: { kind: 'read', reads: resolved.map(read => ({ name: 'get_widget' as const, args: { featureId: read.featureId, condition: read.condition! } })) },
    parts: resolved.map(read => ({ factKeys: read.keys, ...(read.money && { narrow: fullMoney }) })),
  };
}

/**
 * Typed reads for plain Korean questions that the widget domains do not own. Writes, layout and navigation words are never read here,
 * and a period without a widget condition stays local (no tool) so the reply can say which period is missing.
 */
export function plainReadQuery(text: string, businessDate: string, stockBusinessDate = businessDate): PlainRead | undefined {
  const value = normalizeNavisInput(text).replace(/[.!?。！？]+$/u, '').trim();
  if (/^메뉴판\s*보여\s*(?:줘|주세요)?$/u.test(value)) {
    return { intent: readOf('menu', defaultCondition), factKeys: ['menu.count', 'menu.price'] };
  }
  if (value && value.length <= 80) {
    const owner = ownerQuestionRead(value, businessDate, stockBusinessDate);
    if (owner) return owner;
  }
  if (!value || value.length > 80 || WRITE_OR_LAYOUT.test(value)) return undefined;
  // "이번 주 매출": the ledger shows today and a rolling seven days, so both are read, in that order (S8-016).
  if (/이번\s*주/u.test(value) && /매출|벌었|장사\s*(?:어때|얼마)/u.test(value) && !/지난|다음|마진|재고|세금|지출|비교/u.test(value)) {
    const week = readNavisCondition('ledger', value, businessDate);
    if (week?.kind === 'dateRange') {
      const part = { factKeys: ['ledger.sales.net'], narrow: fullMoney };
      return { intent: { kind: 'read', reads: [widgetRead('ledger'), { name: 'get_widget', args: { featureId: 'ledger', condition: week } }] }, parts: [part, part] };
    }
  }
  if (/(?:주문\s*제작|케이크|맞춤\s*주문).*(?:선금|선입금|미리\s*결제|예약금|들어온\s*돈|받은\s*(?:돈|거|금액)|얼마\s*받)/u.test(value)) {
    return { intent: { kind: 'read', sourceId: 'pos', condition: { kind: 'default' } },
      factKeys: ['accounting.deposits.purpose.custom_order', 'accounting.sales.customPickup'] };
  }
  if (/(?:품절|떨어진|바닥난)\s*(?:된\s*)?(?:재료|원재료|원료)|^다\s*떨어진\s*(?:거|것)|재고\s*0\s*인?\s*(?:거|것|품목)?$/u.test(value)) {
    return { intent: readOf('inventory-booking', { kind: 'snapshot', asOf: stockBusinessDate }),
      narrow: emptyStock };
  }
  if (/(?:입고|들어와|들어오|발주\s*한\s*거|배송|도착|납품)/u.test(value) && /(?:언제|예정|와요|와$)/u.test(value) && itemOf(value)) {
    return { intent: readOf('suppliers', { kind: 'default' }), narrow: deliveriesOf(itemOf(value)) };
  }
  if (/(?:제일|가장|젤)\s*(?:큰|많은)?\s*지출|지출\s*(?:1위|일위|순위)|(?:제일|가장)\s*많이\s*(?:나간|쓴)|돈이?\s*(?:제일|가장)\s*많이/u.test(value)) {
    return { intent: readOf('ledger', { kind: 'default' }), factKeys: ['ledger.expenses.category'], narrow: extreme('max') };
  }
  const margin = /마진/u.test(value), sales = /매출|손익|가계부/u.test(value);
  const saleMargin = saleMarginRead(value, businessDate);
  if (saleMargin) return saleMargin;
  const periodMetric = periodMetricRead(value, businessDate);
  if (periodMetric) return periodMetric;
  if (margin && sales && /같(?!이)|똑같|안\s*맞|다른|달라|차이/u.test(value)) {
    return { intent: { kind: 'read', reads: [widgetRead('margin'), widgetRead('ledger')] },
      parts: [{ factKeys: ['margin.sales.net'], narrow: fullMoney }, { factKeys: ['ledger.sales.net'], narrow: fullMoney }], compare: ['margin.sales.net', 'ledger.sales.net'] };
  }
  if (margin && /매출/u.test(value) && !/메뉴|낮|꼴찌|최저/u.test(value)) {
    return { intent: { kind: 'read', reads: [widgetRead('ledger'), widgetRead('margin')] },
      parts: [{ factKeys: ['ledger.sales.net'], narrow: fullMoney }, { factKeys: ['margin.rate'] }] };
  }
  if (/충전금.*(?:결제|사용|쓴|썼)|충전금\s*사용액/u.test(value)) {
    return { intent: { kind: 'read', sourceId: 'pos', condition: { kind: 'default' } }, factKeys: ['accounting.sales.charge'] };
  }
  if (/마진(?:율)?\s*(?:이\s*)?(?:제일|가장)?\s*(?:낮|꼴찌|최저|적)|남는\s*(?:게|거|것)\s*(?:없|적)|(?:이익|마진)\s*(?:이\s*)?(?:제일|가장)\s*(?:낮|적)/u.test(value)) {
    return { intent: readOf('margin', { kind: 'default' }), narrow: lowestMargin };
  }
  const named = /^(.+?)\s*(?:마진(?:율)?|남는\s*비율)\s*(?:이|은|는)?\s*(?:얼마(?:야|예요)?|몇\s*(?:퍼센트|퍼|%)|알려\s*(?:줘|주세요))?$/u.exec(value)?.[1]?.trim();
  const cleanName = !!named && named.split(/\s+/u).length <= 2
    && !/^(?:오늘|어제|이번|지난|전체|우리|가게|매장|평균|총)|매출|메뉴|원가|가격|판매가|재고|[천만]원|\d|(?:랑|이랑|하고|과|와|면)$/u.test(named);
  if (named && cleanName) {
    return { intent: readOf('margin', { kind: 'default' }), narrow: namedMargin(named, ['margin.menu.rate']) };
  }
  if (/^(?:오늘\s*매출|매출\s*매출)\s*(?:알려\s*(?:줘|주세요)|얼마(?:야|예요)?)$/u.test(value)) return { intent: readOf('ledger', { kind: 'default' }), factKeys: ['ledger.sales.net'] };
  if (/(?:세금|세무|부가세)/u.test(value) && parseNavisPeriod(value, businessDate)) {
    const period = parseNavisPeriod(value, businessDate)!;
    const condition = readNavisCondition('tax', value, businessDate);
    if (condition) return { intent: readOf('tax', condition) };
    return { intent: readOf('tax', { kind: 'default' }), unsupported: { featureId: 'tax', condition: { kind: 'dateRange', start: period.start, end: period.end } } };
  }
  return undefined;
}

export const assistantDomains = createDomainRegistry(registeredDomains);

const MEMBER_FACT_WIDGET: Readonly<Record<string, FeatureId>> = {
  charge: 'credit-receivable', receivable: 'credit-receivable', balance: 'credit-receivable', chargeHistory: 'credit-receivable', lastVisit: 'members',
};
const SUGGESTION_FACTS = ['suppliers.suggestions.item', 'suppliers.suggestions.status'];

/**
 * A routed single read that depends on a second source is sent as its ordered pair (B27): a member's fact is looked up first and then the
 * widget that owns it; an order suggestion reads the stock shortage first and then the suppliers widget. Any other turn is returned as is.
 */
export function orderedRead(turn: DomainTurnInput, businessDate: string): DomainTurnInput {
  const { intent } = turn;
  if (intent.kind !== 'read' || intent.reads) return turn;
  const widget = (featureId: FeatureId, condition: QueryCondition) => ({ name: 'get_widget' as const, args: { featureId, condition } });
  const featureId = intent.recordKind === 'member' && intent.querySlot && !intent.tool ? MEMBER_FACT_WIDGET[intent.querySlot] : undefined;
  if (featureId && intent.recordKind && intent.querySlot) {
    return { ...turn, intent: { kind: 'read', reads: [{ name: 'search_records', args: { kind: intent.recordKind, querySlot: intent.querySlot } },
      widget(featureId, { kind: 'default' })] }, readParts: [{}, { context: true }] };
  }
  if (intent.featureId === 'suppliers' && !intent.recordKind && turn.factKeys?.some(key => SUGGESTION_FACTS.includes(key))) {
    return { ...turn, intent: { kind: 'read', reads: [widget('inventory-booking', { kind: 'snapshot', asOf: businessDate }), widget('suppliers', intent.condition ?? { kind: 'default' })] },
      readParts: [{ factKeys: ['inventory.restock.count'] }, { factKeys: turn.factKeys }] };
  }
  return turn;
}

export type AgentReadEvidence =
  | { readonly tool: 'get_widget'; readonly args: { readonly featureId: FeatureId; readonly condition: QueryCondition }; readonly status: 'ready' | 'missing' | 'unavailable' | 'unsupported_period'; readonly facts: readonly SnapshotFact[] }
  | { readonly tool: 'get_source'; readonly args: { readonly sourceId: AgentSourceId; readonly condition: QueryCondition }; readonly status: 'ready' | 'missing' | 'unavailable' | 'unsupported_period'; readonly facts: readonly SnapshotFact[] }
  | { readonly tool: AgentReadProjection['tool']; readonly args: AgentReadProjection['args']; readonly status: 'ready' | 'missing' | 'unavailable' | 'unsupported_period'; readonly facts: readonly SnapshotFact[] }
  | { readonly tool: 'search_records'; readonly args: AgentSearchArgs; readonly status: 'ready' | 'missing' | 'unavailable'; readonly matches: AgentSearchProjection['matches'];
      /** The local cursor of the next page of candidates, when there is one (B22). */
      readonly nextCursor?: string;
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
  const catalog = (sourceOnly ? [] : catalogFor(locale, undefined, snapshot)).filter(entry => !scope.size || scope.has(entry.id)).map(entry => ({
    ...entry,
    conditions: [...new Map([
      ...entry.conditions,
      ...(entry.id === 'inventory-booking' && realStock(snapshot) ? []
        : projection.snapshot.flatMap(row => 'featureId' in row && row.featureId === entry.id && 'facts' in row ? [row.condition] : [])),
    ].map(condition => [JSON.stringify(condition), condition])).values()],
  }));
  return { runId: snapshot.runId, snapshotRevision: snapshot.revision, businessDate: snapshot.pos?.businessDate ?? TODAY,
    locale, layer, intent, slots, catalog, ...projection };
}

export function projectAgentWidget(snapshot: DataSnapshot, featureId: FeatureId, condition: QueryCondition, locale: Locale, domains = assistantDomains): Extract<AgentReadEvidence, { tool: 'get_widget' }> {
  const args = { featureId, condition };
  if (featureId === 'inventory-booking' && realStock(snapshot) && !conditionsOf(featureId, snapshot).some(supported =>
    conditionKey(supported) === conditionKey(condition))) {
    // The unreadable-domain gate can otherwise label a stale date unavailable before checking the source period.
    return { tool: 'get_widget', args, status: 'unsupported_period', facts: [] };
  }
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

/** Commands whose preview needs current widget facts (B29): a shift handoff, and an order that comes from a stock suggestion. */
export function commandSnapshotEntry(snapshot: DataSnapshot, intent: Extract<AgentRequest['intent'], { kind: 'command' }>, locale: Locale,
  domains = assistantDomains): AgentRequest['snapshot'][number] | undefined {
  // A clarify-only request for the ledger candidates reads the ledger widget first (B20 selector).
  const wanted = intent.command === 'staff.moveHandoff' || intent.command === 'suppliers.createOrder' && !!intent.args && 'suggestionItemId' in intent.args
    || intent.clarify === 'expenseId';
  const featureId = wanted ? agentCommandPolicy(intent.command, intent.args).featureId : undefined;
  if (!featureId || !getRegistry('A').some(entry => entry.id === featureId)) return undefined;
  const projected = projectAgentWidget(snapshot, featureId as FeatureId, { kind: 'default' }, locale, domains);
  return { ...projected.args, ...(projected.status === 'ready' ? { facts: projected.facts } : { status: projected.status }) };
}

export function projectAgentSource(snapshot: DataSnapshot, sourceId: AgentSourceId, condition: QueryCondition, locale: Locale,
  domains = assistantDomains, run?: RunState): Extract<AgentReadEvidence, { tool: 'get_source' }> {
  const args = { sourceId, condition };
  if (domains.sourceUnavailable(sourceId) || sourceId !== 'pos' && sourceId !== 'demand') return { tool: 'get_source', args, status: 'unavailable', facts: [] };
  const facts = snapshotFactSource(() => snapshot).readSource!(sourceId);
  const scoped = facts.filter(fact => condition.kind === 'default' ||
    (condition.kind === 'snapshot' ? fact.date === condition.asOf : !!fact.date && fact.date >= condition.start && fact.date <= condition.end));
  const closing = domains.projectSource(snapshot, sourceId, condition, locale, run) ?? [];
  // The newest orders belong to today's POS read only (a past day or another period has its own ledger).
  const recent = sourceId === 'pos' && condition.kind === 'default' ? [...recentOrderFacts(snapshot, locale), ...peakOrderFacts(snapshot, locale)] : [];
  const extended = [...closing, ...recent];
  const status = scoped.length || extended.length ? 'ready' : condition.kind === 'default' ? 'missing' : 'unsupported_period';
  return { tool: 'get_source', args, status, facts: [...scoped.map(fact => localizeFact(fact, locale)), ...extended] };
}

/** A projected lookup page holds at most five candidates (B22). */
export const SEARCH_PAGE_SIZE = 5;

/**
 * "라떼 오늘 판매량", "라떼 원가가 얼마야": a bare 라떼 (not part of a flavored name such as 바닐라라떼) asked for its sold count, cost, margin
 * or memo, with no exact match, names the one plain 카페라떼. It becomes the exact candidate. A price question, or with none or several such
 * menus, chooses nothing and the owner is asked which menu.
 */
const PLAIN_LATTE_FACT = /판매량|몇\s*(?:잔|개)|팔(?:렸|았|린)|나갔|원가|재료값|한\s*잔\s*만드|마진|메모/u;
function plainLatte(matches: readonly AgentSearchProjection['matches'][number][], query: string) {
  if (matches.length < 2 || matches.some(match => match.match === 'exact')) return undefined;
  const text = normalizeNavisInput(query);
  if (!PLAIN_LATTE_FACT.test(text) || !/(?:^|\s)라[떼테](?=\s|$|[은는이가을를의도?])/u.test(text)) return undefined;
  const plain = matches.filter(match => match.label && labelKey(match.label) === '카페라테' && match.fields?.kind !== 'retail');
  return plain.length === 1 ? { ...plain[0], match: 'exact' as const } : undefined;
}

/**
 * One local page of a record lookup. Handles are the adapter's own; the local cursor is the offset of the page's first candidate.
 * `wireSearchPage` turns a page into what the server sees. Exact candidates come before similar ones.
 */
export function projectAgentSearch(
  registry: DomainRegistry, snapshot: DataSnapshot, args: AgentSearchArgs, query: string, locale: Locale, privateLookup = false, command?: string,
  aspect?: string,
): AgentSearchProjection {
  const reader = registry.reader(args.kind);
  const found = reader?.search({ snapshot, locale, query, privateLookup, command, querySlot: args.querySlot, ...(aspect ? { aspect } : {}) }) ?? [];
  const sorted = [...found.filter(match => match.match === 'exact'), ...found.filter(match => match.match !== 'exact')];
  // A read of a bare 라떼 means the plain café latte; a write still asks which menu.
  const plain = args.kind === 'menu' && !privateLookup && !command ? plainLatte(sorted, query) : undefined;
  const matches = plain ? [plain] : sorted;
  const offset = args.cursor === undefined ? 0 : /^\d+$/u.test(args.cursor) ? Number(args.cursor) : -1;
  // A cursor is valid only at a page boundary that still has candidates; anything else is a stale or foreign token.
  const valid = offset >= 0 && offset % SEARCH_PAGE_SIZE === 0 && (offset === 0 || offset < matches.length);
  const page = valid ? matches.slice(offset, offset + SEARCH_PAGE_SIZE) : [];
  const next = offset + SEARCH_PAGE_SIZE;
  return { kind: args.kind, querySlot: args.querySlot, ...(args.cursor !== undefined ? { cursor: args.cursor } : {}), matches: page,
    ...(valid && next < matches.length ? { nextCursor: String(next) } : {}),
    ...(!reader || reader.unavailable || !valid ? { status: 'unavailable' as const } : matches.length ? {} : { status: 'missing' as const }),
  };
}

export interface LookupKey {
  readonly runId: string;
  readonly revision: number;
  readonly kind: AgentSearchArgs['kind'];
  readonly querySlot: string;
  readonly query: string;
}
/** Opaque wire tokens of one local lookup. The adapter handles and offsets they stand for never leave the browser. */
export interface LookupTokens {
  readonly binding: string;
  handle(local: string): string;
  cursor(local: string): string;
}

/**
 * Mints one random queryBinding per lookup, with random handles and cursors that map back to the local ones. The tokens stay the same while
 * the run, snapshot revision, record kind, query slot and query text stay the same, and a new lookup mints new ones (B22).
 */
export function createLookupScope(random: () => string = () => crypto.randomUUID()) {
  const entries = new Map<string, { readonly runId: string; readonly revision: number; readonly tokens: LookupTokens }>();
  return {
    tokens({ runId, revision, kind, querySlot, query }: LookupKey): LookupTokens {
      for (const [id, entry] of entries) if (entry.runId !== runId || entry.revision !== revision) entries.delete(id);
      const id = JSON.stringify([kind, querySlot, query]);
      const known = entries.get(id);
      if (known) return known.tokens;
      const handles = new Map<string, string>(), cursors = new Map<string, string>();
      const mint = (table: Map<string, string>, prefix: string, local: string) => {
        let wire = table.get(local);
        if (!wire) table.set(local, wire = `${prefix}-${random()}`);
        return wire;
      };
      const tokens: LookupTokens = { binding: `q-${random()}`, handle: local => mint(handles, 'r', local), cursor: local => mint(cursors, 'c', local) };
      entries.set(id, { runId, revision, tokens });
      return tokens;
    },
    clear() { entries.clear(); },
  };
}

/**
 * The page as the server sees it: random handles and cursors, the lookup's queryBinding, nothing of the adapter's own tokens.
 * A candidate's `ownerHandle` names another lookup's candidate (a note's member): `reference` gives that lookup's wire handle.
 */
export function wireSearchPage(page: AgentSearchProjection, tokens: LookupTokens, reference?: (local: string) => string | undefined): AgentSearchProjection {
  const { cursor, nextCursor, matches, ...rest } = page;
  const wireMatch = (match: AgentSearchProjection['matches'][number]): AgentSearchProjection['matches'][number] => {
    const fields = match.fields as Record<string, unknown> | undefined;
    const owner = fields?.ownerHandle;
    const wireFields = typeof owner === 'string' ? { ...match, fields: { ...fields, ownerHandle: reference?.(owner) ?? tokens.handle(owner) } } : match;
    return { ...wireFields, handle: tokens.handle(match.handle) } as AgentSearchProjection['matches'][number];
  };
  return { ...rest, matches: matches.map(wireMatch), queryBinding: tokens.binding,
    ...(cursor !== undefined ? { cursor: tokens.cursor(cursor) } : {}), ...(nextCursor !== undefined ? { nextCursor: tokens.cursor(nextCursor) } : {}) };
}

/** The initial write turn shares catalog metadata, slot names and scoped lookup handles. */
export function buildMenuAgentRequest(snapshot: DataSnapshot, draft: LocalMenuDraft, locale: Locale, layer: DashboardLayerId, domains = assistantDomains, tokens?: LookupTokens): AgentRequest | null {
  const page = projectAgentSearch(domains, snapshot, { kind: 'menu', querySlot: 'name' }, draft.name, locale, true);
  return buildAgentRequest(snapshot, { kind: 'menu.create', category: draft.category }, locale, layer,
    ['name', ...(isMenuPrice(draft.price) ? ['price'] : []), ...(draft.memo ? ['memo'] : [])],
    { snapshot: [], searches: [tokens ? wireSearchPage(page, tokens) : page] }, domains);
}

export function conditionsOf(featureId: FeatureId, snapshot?: DataSnapshot): readonly QueryCondition[] {
  if (featureId === 'inventory-booking' && snapshot && realStock(snapshot)) {
    const date = stockDate(snapshot);
    return [{ kind: 'snapshot', asOf: date }, { kind: 'dateRange', start: date, end: date },
      { kind: 'dateRange', start: addDays(date, -6), end: date }, defaultCondition];
  }
  const taxDate = featureId === 'tax' ? snapshot?.tables.realTax?.today : undefined;
  if (taxDate) return [...supportedConditions('tax'), { kind: 'dateRange', start: taxDate, end: taxDate }];
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
