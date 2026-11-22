import { fromBase, isBaseUnit, toBase, unitDimension } from '../../../data/derive/common';
import { normalizeMenuCategory, type FeatureId, type Locale, type QueryCondition } from '../../../contracts';
import { rateOf } from '../../../data/models/util';
import { createTranslator } from '../../../i18n';
import { mgmtMoneyBundle } from '../../widgets/mgmt-money/messages';
import { handlers, type HandlerContext, type HandlerResult } from '../../../data/commands/handlers';
import type { DataCommand } from '../../../data/commands/types';
import { equalData } from '../../../data/db/inverse';
import { normalizeCondition, NORMAL_VARIANT, resolveDataText, selectMenus, selectWidget, simulateMenuPrice, supportedConditions, widgetFacts, type DataSnapshot, type DataText } from '../../../data/widget-data';
import { AGENT_MENU_EDIT_COMMANDS, validateAgentCommandArgs, validateAgentDraft, validateAgentMenuEditArgs, type AgentFact, type AgentHandleRef, type AgentMissingStatus, type AgentRecordMatch, type AgentWireArgs } from '../../../../shared/navis-agent-schema.mjs';
import { navisTranslator } from '../messages';
import type { SnapshotFact } from '../snapshot';
import { navisMoneySpans, normalizeNavisInput, normalizeNavisName, parseMenuCategoryChoice, parseNavisDate, parseNavisMoney, parseNavisNumber, parseNavisPeriod, parseNavisQuantity } from '../navis-input';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainRoute, LocalSlots, ReadToolAdapter, RecordAdapter, RecordSearch, RecordTargets } from './registry';

type MenuCommand = Extract<DataCommand, { type: 'menu.create' }>;
export type MenuDraft = Pick<MenuCommand, 'name' | 'category' | 'price' | 'memo'>;
export const isMenuPrice = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export interface MenuCreationPreview {
  readonly before: null;
  readonly after: {
    readonly name: string;
    readonly category: MenuDraft['category'];
    readonly price: number;
    readonly memo: string | null;
    readonly saleStatus: 'selling' | 'sold_out';
    readonly prepMin: number;
    readonly soldQty: number;
    readonly cost: number | null;
    readonly recipeCount: number;
    readonly optionCount: number;
    readonly hasPhoto: boolean;
  };
  readonly countBefore: number;
  readonly countAfter: number;
}

const menuSlots = {
  name: (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 120,
  price: isMenuPrice,
  memo: (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 1000,
};

const isRef = (value: unknown, slot: string): boolean => !!value && typeof value === 'object'
  && Object.keys(value).length === 1 && 'slot' in value && value.slot === slot;

export const menuCommandAdapter: CommandAdapter<MenuCommand, MenuDraft, MenuCreationPreview> = {
  command: 'menu.create', featureId: 'menu', slots: menuSlots,
  resolve(wire, { name, price, memo }) {
    if (!wire || typeof wire !== 'object' || !('name' in wire) || !('price' in wire) || !('category' in wire)) return undefined;
    if (!isRef(wire.name, 'name') || !isRef(wire.price, 'price') || !menuSlots.name(name) || !menuSlots.price(price)) return undefined;
    const category = wire.category === 'drink' ? 'drink' : normalizeMenuCategory(wire.category);
    if (!category) return undefined;
    if ('memo' in wire ? !menuSlots.memo(memo) || !isRef(wire.memo, 'memo') : memo !== undefined) return undefined;
    return { name, price, category, ...(menuSlots.memo(memo) ? { memo } : {}) };
  },
  preflight(draft, { snapshot, proposalId, idempotencyKey }) {
    const args = { name: draft.name.trim(), category: draft.category, price: draft.price, ...(draft.memo?.trim() ? { memo: draft.memo } : {}) };
    if (!validateAgentCommandArgs('menu.create', args)) return { kind: 'invalid' };
    const before = selectMenus(snapshot, {});
    const key = normalizeNavisName(args.name);
    const ko = navisTranslator('ko');
    if (!key || before.rows.some(row => normalizeNavisName(menuLabel(ko, row)) === key)) {
      return { kind: 'unchanged', field: 'name' };
    }
    const command: MenuCommand = { type: 'menu.create', ...args, baseRevision: snapshot.revision, idempotencyKey };
    const previewId = `navis-preview:${proposalId}`;
    const simulated = handlers['menu.create']({ snapshot, tables: snapshot.tables, nextId: () => previewId }, command);
    if (!simulated.ok) return { kind: 'invalid', field: simulated.field, messageKey: simulated.messageKey };
    const after = selectMenus({ ...snapshot, tables: simulated.tables }, {});
    const created = after.rows.find(row => row.menuId === previewId);
    if (!created || !created.name || !('raw' in created.name)) return { kind: 'invalid' };
    return {
      kind: 'ready', command: Object.freeze(command),
      preview: Object.freeze({
        before: null, countBefore: before.rows.length, countAfter: after.rows.length,
        after: Object.freeze({
          name: created.name.raw, category: normalizeMenuCategory(command.category), price: created.price,
          memo: created.memo && 'raw' in created.memo ? created.memo.raw : null,
          saleStatus: created.saleStatus, prepMin: created.prepMin, soldQty: created.soldQty,
          cost: created.cost, recipeCount: created.recipe.length, optionCount: created.optionGroups.length,
          hasPhoto: Boolean(created.photoKey || created.customPhotoUrl),
        }),
      }),
    };
  },
  undoToken: result => result.undoToken,
};

type MenuRow = ReturnType<typeof selectMenus>['rows'][number];
type MenuEdit = Extract<DataCommand, { type: typeof AGENT_MENU_EDIT_COMMANDS[number] }>;
type MenuEditDraft = { readonly command: MenuEdit; readonly locale: Locale };
type AgentProjection = { readonly facts: readonly AgentFact[] } | { readonly status: AgentMissingStatus };
const missing = { status: 'missing' } as const;
const defaultCondition = { kind: 'default' } as const;
const menuKey = (field: string) => `common.navis.agent.${field}`;
const menuLabel = (tr: ReturnType<typeof navisTranslator>, row: { readonly nameKey: string; readonly name?: DataText }) =>
  resolveDataText(tr.t, row.name ?? { key: row.nameKey });
const activeMenu = (snapshot: DataSnapshot, id: string | undefined) => selectMenus(snapshot, {}).rows.find(row => row.menuId === id);

function catalogRows({ snapshot, privateLookup, command }: RecordSearch) {
  const menus = selectMenus(snapshot, {}).rows;
  return privateLookup || command ? menus : [...menus, ...snapshot.tables.menuItem.filter(row => row.kind === 'retail' && !row.deletedAt)];
}

function menuHandle(index: number, querySlot?: string) {
  return querySlot === 'newName' ? `menu-rename-${index}` : `menu-${index}`;
}

const menuReader: RecordAdapter = {
  kind: 'menu',
  search(input) {
    const { query, locale, privateLookup, command } = input;
    const tr = navisTranslator(locale);
    const read = privateLookup || command ? undefined : readNamedQuery(query);
    const key = normalizeNavisName(read?.name ?? query);
    const choices = catalogRows(input).flatMap((row, index): AgentRecordMatch[] => {
      const label = menuLabel(tr, row);
      const candidate = normalizeNavisName(label);
      const match = candidate && (candidate === key || inputAliases.get(row.menuId)?.includes(key)) ? 'exact' as const
        : key.length > 1 && candidate.length > 1 && (candidate.includes(key) || key.includes(candidate)) ? 'similar' as const : undefined;
      if (!match) return [];
      const identity = { handle: menuHandle(index, input.querySlot), match };
      if (privateLookup && (!command || command === 'menu.create')) return [identity];
      const category = normalizeMenuCategory(row.category);
      const fields = { kind: row.kind === 'retail' ? 'retail' : 'menu', status: row.saleStatus ?? 'selling' };
      return [privateLookup ? { ...identity, fields } : { ...identity, label, price: row.price, ...(category ? { category } : {}),
        fields: { ...fields, ...(category ? { category } : {}), ...(row.seasonal ? { seasonal: true } : {}) } }];
    });
    const exact = choices.filter(record => record.match === 'exact');
    return exact.length ? exact : choices;
  },
  resolve(input, handle) {
    return catalogRows(input).find((_, index) => menuHandle(index, input.querySlot) === handle)?.menuId;
  },
  describe(match, locale, input) {
    const tr = navisTranslator(locale);
    const aspect = input && readNamedQuery(input.query)?.aspect;
    const index = /^menu-(\d+)/u.exec(match.handle)?.[1];
    const row = input && index !== undefined ? catalogRows(input)[Number(index)] : undefined;
    const active = input && row ? activeMenu(input.snapshot, row.menuId) : undefined;
    let detail = match.price === undefined ? undefined : tr.format.money(match.price, 'full');
    if (aspect === 'memo' && active) detail = active.memo ? resolveDataText(tr.t, active.memo) : tr.t(menuKey('menuNoMemo'));
    if (aspect === 'sold' && active) detail = active.sourceCost ? '판매량을 불러올 수 없어요' : soldDisplay(tr, active);
    if (aspect === 'cost' && active) detail = active.cost === null ? marginText(locale).t('widget.margin.missingCost') : tr.format.money(active.cost, 'full');
    if (aspect === 'costAndMargin' && active) {
      const margin = marginText(locale).t;
      detail = active.cost === null ? margin('widget.margin.missingCost')
        : [`${margin('widget.margin.unitCost')} ${tr.format.money(active.cost, 'full')}`,
          `${margin('widget.margin.col.profit')} ${tr.format.money(active.price - active.cost, 'full')}`,
          active.rate === null ? undefined : `${margin('widget.margin.col.rate')} ${tr.format.percent(active.rate, 1)}`].filter(Boolean).join(' · ');
    }
    if (aspect === 'status' && active) detail = tr.t(menuKey(active.saleStatus));
    return input && match.label && detail ? `${match.label} ${detail}` : detail;
  },
};

function fact(key: string, label: string, value: number | string, unit: string, display: string,
  scope: Pick<AgentFact, 'date' | 'start' | 'end' | 'source'> = {}): AgentFact {
  return { key, label: label.slice(0, 250), value: typeof value === 'string' ? value.slice(0, 500) : value, unit, display: display.slice(0, 500), ...scope };
}

const soldDisplay = (tr: ReturnType<typeof navisTranslator>, row: MenuRow) =>
  row.category !== 'dessert' ? `${tr.format.number(row.soldQty)}${tr.locale === 'en' ? ' ' : ''}${tr.t(menuKey('menuCups'))}`
    : tr.format.count(row.soldQty, 'count');

const recipeFacts = (tr: ReturnType<typeof navisTranslator>, row: MenuRow) => row.recipeLines.map(line => fact(
  'menu.recipe.line', resolveDataText(tr.t, line.name), line.quantity, line.unit, tr.format.quantity(line.quantity, line.unit),
  { source: tr.t('widget.menu.title') },
));

function menuFacts(snapshot: DataSnapshot, rows: readonly MenuRow[], locale: Locale, date: string): readonly AgentFact[] {
  const tr = navisTranslator(locale);
  const money = (n: number) => tr.format.money(n, 'full');
  const source = tr.t('widget.menu.title');
  const total = rows.length;
  const soldOut = rows.filter(row => row.saleStatus === 'sold_out');
  const top = rows.filter(row => !row.sourceCost && row.soldQty > 0).reduce<MenuRow | undefined>((best, row) => !best || row.soldQty > best.soldQty ? row : best, undefined);
  const facts = [
    fact('menu.count', tr.t(menuKey('count')), total, 'count', tr.format.count(total, 'count'), { source }),
    fact('menu.soldOut.count', tr.t(menuKey('sold_out')), soldOut.length, 'count', tr.format.count(soldOut.length, 'count'), { source }),
  ];
  if (top) facts.push(fact('menu.soldQty.top', menuLabel(tr, top), top.soldQty, top.category === 'dessert' ? 'count' : 'cup', soldDisplay(tr, top), { date, source }));
  for (const row of rows) {
    facts.push(fact('menu.price', menuLabel(tr, row), row.price, 'KRW', money(row.price), { source }));
  }
  for (const row of rows) {
    const label = menuLabel(tr, row);
    const category = normalizeMenuCategory(row.category);
    const details = [money(row.price), category && tr.t(menuKey(category)), row.seasonal && tr.t(menuKey('seasonal')),
      tr.t(menuKey(row.saleStatus)), !row.sourceCost && soldDisplay(tr, row), row.memo && resolveDataText(tr.t, row.memo)];
    facts.push(fact('menu.row', label, row.price, 'KRW', details.filter(Boolean).join(' · '), { date, source }));
    if (row.category === 'dessert') facts.push(fact('menu.dessert.price', label, row.price, 'KRW', money(row.price), { source }));
    const options = row.optionGroups.flatMap(group => group.options.map(option => `${option.name} ${money(option.extraPrice)}`));
    if (options.length) facts.push(fact('menu.option', label, options.length, 'count', options.join(' · '), { source }));
    if (row.saleStatus === 'sold_out') facts.push(fact('menu.soldOut.row', label, row.saleStatus, '', tr.t(menuKey('sold_out')), { source }));
  }
  // Retail prices are searchable, separate from the registered menu tally.
  for (const row of snapshot.tables.menuItem) {
    if (row.kind === 'retail' && !row.deletedAt) facts.push(fact('menu.retail.price', menuLabel(tr, row), row.price, 'KRW', money(row.price)));
  }
  return facts;
}

const marginText = (locale: Locale) => createTranslator<string>(locale, mgmtMoneyBundle);
const periodScope = (start: string, end: string) => start === end ? { date: start } : { start, end };

export function projectMenuWidget(snapshot: DataSnapshot, featureId: FeatureId, condition: QueryCondition, locale: Locale): AgentProjection | undefined {
  if (featureId !== 'menu' && featureId !== 'margin') return undefined;
  const normalized = normalizeCondition(featureId, condition);
  if (!normalized.ok) return { status: 'unsupported_period' };
  if (featureId === 'menu') {
    const view = selectWidget(snapshot, 'menu', normalized.value, NORMAL_VARIANT);
    if (view.status === 'error') return { status: 'unavailable' };
    if (view.status !== 'ready') return missing;
    return { facts: menuFacts(snapshot, view.model.rows, locale, view.model.date).slice(0, 128) };
  }
  const view = selectWidget(snapshot, 'margin', normalized.value, NORMAL_VARIANT);
  if (view.status === 'error') return { status: 'unavailable' };
  if (view.status !== 'ready' || !view.model.menus.length) return missing;
  const tr = navisTranslator(locale);
  const t = marginText(locale).t;
  const model = view.model;
  const range = periodScope(model.period.start, model.period.end);
  const money = (n: number) => tr.format.money(n, 'full');
  const percentage = (n: number) => tr.format.percent(n, 1);
  const source = tr.t('widget.margin.title');
  const facts = widgetFacts(view).filter(row => row.key !== 'margin.menu.rate').map(row => fact(
    row.key, tr.t(row.labelKey), row.value, row.unit, typeof row.value === 'number'
      ? row.unit === 'KRW' ? money(row.value) : row.unit === 'pp' ? tr.format.delta(row.value, 'pp') : percentage(row.value)
      : row.value, { ...range, source },
  ));
  const coverage = model.costMissing ? t('widget.margin.missingCost')
    : model.rate === null ? tr.t('data.state.margin.no-sales') : percentage(model.rate);
  const coverageKey = model.costMissing ? 'missing_cost' : !model.netSales ? 'no_sales' : 'complete';
  facts.push(fact('margin.coverage', source, coverageKey, '', coverage, { ...range, source }));
  const top = model.menus.filter(row => row.qty > 0 && row.contribution !== null).sort((a, b) => b.contribution! - a.contribution!)[0];
  if (top?.contribution != null) facts.push(fact('margin.menu.contribution.top', menuLabel(tr, top), top.contribution, 'KRW', money(top.contribution), { ...range, source }));
  const kinds = new Map(snapshot.tables.menuItem.map(row => [row.menuId, row.kind]));
  if (snapshot.tables.realFinance) {
    for (const row of model.menus) {
      if (row.qty === 0 || row.cost === null || row.grossProfit === null) continue;
      const label = menuLabel(tr, row);
      facts.push(fact('margin.menu.salesCost', label, row.cost, 'KRW', money(row.cost), { ...range, source }));
      const rate = rateOf(row.grossProfit, row.netSales);
      if (rate !== null) facts.push(fact('margin.menu.salesRate', label, rate, 'percent', percentage(rate), { ...range, source }));
    }
  }
  // Units sold per menu for the period, the ten best sellers first, ahead of the per-menu rows so the 128-fact wire cap (192 facts with real finance rows) never drops them (CHAT-REAL-DEV: "제일 잘 팔리는 메뉴" reads the margin rows, which every data mode has).
  const dessertIds = new Set(snapshot.tables.menuItem.filter(item => item.category === 'dessert').map(item => item.menuId));
  for (const row of [...model.menus].sort((a, b) => b.qty - a.qty || a.menuId.localeCompare(b.menuId)).slice(0, 10)) {
    if (row.qty <= 0) continue;
    const display = dessertIds.has(row.menuId) ? tr.format.count(row.qty, 'count') : `${tr.format.number(row.qty)}${tr.locale === 'en' ? ' ' : ''}${tr.t(menuKey('menuCups'))}`;
    facts.push(fact('margin.menu.qty', menuLabel(tr, row), row.qty, 'count', display, { ...range, source }));
  }
  for (const row of model.menus) {
    const label = menuLabel(tr, row);
    const cost = row.unitCost === null ? t('widget.margin.missingCost') : money(row.unitCost);
    const rate = row.rate === null ? t('widget.margin.unknown') : percentage(row.rate);
    const kind = kinds.get(row.menuId) === 'retail' ? 'retail' : 'menu';
    const kindLabel = tr.t(kind === 'retail' ? 'common.inventoryTab.products' : 'widget.menu.title');
    const details = [money(row.price), cost, row.unitMargin === null ? undefined : money(row.unitMargin), rate, tr.format.count(row.qty, 'count'), kindLabel];
    facts.push(fact('margin.menu.row', label, row.price, 'KRW', details.filter(Boolean).join(' · '), { ...range, source }));
    if (row.unitCost !== null) facts.push(fact('margin.menu.unitCost', label, row.unitCost, 'KRW', money(row.unitCost), { date: model.period.end, source }));
    if (row.unitMargin !== null) facts.push(fact('margin.menu.unitMargin', label, row.unitMargin, 'KRW', money(row.unitMargin), { date: model.period.end, source }));
    // A typed rate per named menu, next to its row. The row display keeps its own rate text.
    if (row.rate !== null) facts.push(fact('margin.menu.rate', label, row.rate, 'percent', percentage(row.rate), { ...range, source }));
  }
  for (const point of model.trend) {
    if (point.rate !== null) facts.push(fact('margin.rate.daily', tr.format.date(point.date, 'short'), point.rate, 'percent', percentage(point.rate), { date: point.date, source }));
  }
  // Per-menu contribution follows the trend, best sellers first, so the wire cap trims the slowest sellers instead of the trend or a named rate.
  for (const row of [...model.menus].sort((a, b) => b.qty - a.qty)) {
    if (row.contribution !== null) facts.push(fact('margin.menu.contribution', menuLabel(tr, row), row.contribution, 'KRW', money(row.contribution), { ...range, source }));
  }
  return { facts: facts.slice(0, 128) };
}

function targetMenu(targets: RecordTargets, handle: string) {
  const target = targets.get(handle);
  return target?.kind === 'menu' ? target.id : undefined;
}

const getRecipe: ReadToolAdapter<'get_recipe'> = {
  tool: 'get_recipe',
  read(snapshot, { menuId }, locale, _slots, targets) {
    const row = activeMenu(snapshot, targetMenu(targets, menuId.handle));
    return row?.recipeLines.length ? { facts: recipeFacts(navisTranslator(locale), row) } : missing;
  },
};

const simulatePrice: ReadToolAdapter<'simulate_menu_price'> = {
  tool: 'simulate_menu_price',
  read(snapshot, { menu, price, cost }, locale, slots, targets) {
    const row = activeMenu(snapshot, targetMenu(targets, menu.handle));
    if (!row || !price && !cost) return missing;
    const nextPrice = price ? slots[price.slot] : row.price;
    const nextCost = cost ? slots[cost.slot] : row.cost;
    if (!isMenuPrice(nextPrice) || typeof nextCost !== 'number' || !Number.isSafeInteger(nextCost) || nextCost < 0) return missing;
    const result = simulateMenuPrice({ price: nextPrice, unitCost: nextCost }, row.cost === null ? undefined : { price: row.price, unitCost: row.cost });
    if (!result) return missing;
    const tr = navisTranslator(locale);
    const t = marginText(locale).t;
    const source = t('widget.margin.notActual');
    const money = (n: number) => tr.format.money(n, 'full');
    return { facts: [
      fact('margin.simulation.price', t('widget.margin.simPrice'), nextPrice, 'KRW', money(nextPrice), { source }),
      fact('margin.simulation.unitCost', t('widget.margin.simCost'), nextCost, 'KRW', money(nextCost), { source }),
      fact('margin.simulation.unitMargin', t('widget.margin.simProfit'), result.profit, 'KRW', money(result.profit), { source }),
      fact('margin.simulation.rate', t('widget.margin.simRate'), result.rate, 'percent', `${tr.format.percent(result.rate, 1)} · ${source}`, { source }),
      ...(result.profitDelta === undefined ? [] : [fact('margin.simulation.unitMarginDelta', t('widget.margin.simDiff'), result.profitDelta, 'KRW', money(result.profitDelta), { source })]),
      ...(result.rateDelta === undefined ? [] : [fact('margin.simulation.rateDelta', t('widget.margin.simDiff'), result.rateDelta, 'pp', tr.format.delta(result.rateDelta, 'pp'), { source })]),
    ] };
  },
};

function expandMenuWire(value: unknown, slots: LocalSlots, targets: RecordTargets): unknown {
  if (!value || typeof value !== 'object') return value;
  if ('slot' in value && typeof value.slot === 'string') return slots[value.slot];
  if ('handle' in value && typeof value.handle === 'string') return targetMenu(targets, value.handle);
  return Object.fromEntries(Object.entries(value).map(([field, child]) => [field, expandMenuWire(child, slots, targets)]));
}

function presentEdit(locale: Locale, command: MenuEdit, before: MenuRow, after: MenuRow | undefined) {
  const tr = navisTranslator(locale);
  const t = tr.t;
  const none = t(menuKey('none'));
  const label = menuLabel(tr, before);
  const money = (value: number | null | undefined) => value == null ? none : tr.format.money(value, 'full');
  const fields: { label: string; before: string; after: string }[] = [];
  function add(field: string, from: string, to: string) {
    if (from !== to) fields.push({ label: t(menuKey(field)), before: from, after: to });
  }
  if (!after) add('name', label, none);
  else {
    add('name', label, menuLabel(tr, after));
    add('category', before.category ? t(menuKey(before.category)) : none, after.category ? t(menuKey(after.category)) : none);
    add('price', money(before.price), money(after.price));
    add('memo', before.memo ? resolveDataText(t, before.memo) : none, after.memo ? resolveDataText(t, after.memo) : none);
    add('saleStatus', t(menuKey(before.saleStatus)), t(menuKey(after.saleStatus)));
    if (command.type === 'menu.setRecipe') {
      const previous = new Map(before.recipeLines.map(line => [line.itemId, line]));
      const next = new Map(after.recipeLines.map(line => [line.itemId, line]));
      const quantity = (line: MenuRow['recipeLines'][number] | undefined) => line ? tr.format.quantity(line.quantity, line.unit) : none;
      for (const itemId of new Set([...previous.keys(), ...next.keys()])) {
        const oldLine = previous.get(itemId), newLine = next.get(itemId);
        const from = quantity(oldLine), to = quantity(newLine);
        const ingredient = newLine ?? oldLine;
        if (ingredient && from !== to) fields.push({ label: resolveDataText(t, ingredient.name), before: from, after: to });
      }
    }
    if (command.type === 'menu.setOptions') {
      const currentPrices = new Map(before.optionGroups.flatMap(group => group.options.map(option => [option.optionId, option.extraPrice])));
      for (const group of after.optionGroups) for (const option of group.options) {
        const previous = currentPrices.get(option.optionId);
        if (previous !== option.extraPrice) fields.push({ label: option.name, before: money(previous), after: money(option.extraPrice) });
      }
    }
    add('cost', money(before.cost), money(after.cost));
    if (command.type === 'menu.setRecipe' && before.rate !== after.rate) {
      const percentage = (rate: number | null) => rate === null ? none : tr.format.percent(rate, 1);
      fields.push({ label: marginText(locale).t('widget.margin.col.rate'), before: percentage(before.rate), after: percentage(after.rate) });
    }
  }
  // C-13: a primary button names what it changes. A single edited field of the menu itself gives "<field> 바꾸기" ("판매가 바꾸기"); several fields, or the
  // recipe and option editors, keep the generic wording of the card.
  const own = new Set([t(menuKey('name')), t(menuKey('category')), t(menuKey('price')), t(menuKey('memo')), t(menuKey('saleStatus'))]);
  const edited = fields.filter(field => own.has(field.label));
  const single = locale === 'ko' && after && command.type !== 'menu.setRecipe' && command.type !== 'menu.setOptions' && edited.length === 1 && fields.length <= 2 ? edited[0].label : undefined;
  return { title: label, target: label, ...(single ? { confirmLabel: `${single} 바꾸기` } : {}), fields };
}

function menuEditAdapter(type: MenuEdit['type']): CommandAdapter<MenuEdit, MenuEditDraft, ReturnType<typeof presentEdit>> {
  return {
    command: type,
    featureId: 'menu',
    slots: {
      ...menuSlots,
      newName: menuSlots.name,
      memo: (value: unknown) => typeof value === 'string' && value.length <= 1000,
      lines: Array.isArray,
      groups: Array.isArray,
    },
    resolve(wire, slots, _snapshot, targets) {
      if (!validateAgentDraft(type, wire)) return undefined;
      const args = expandMenuWire(wire, slots, targets);
      if (!validateAgentMenuEditArgs(type, args)) return undefined;
      return { command: { ...(args as Omit<MenuEdit, 'type'>), type } as MenuEdit,
        locale: slots.navisLocale === 'en' || slots.navisLocale === 'zh-Hans' || slots.navisLocale === 'zh-Hant' ? slots.navisLocale : 'ko' };
    },
    preflight(draft, { snapshot, proposalId, idempotencyKey }) {
      const { command: input, locale } = draft;
      const { type: commandType, ...args } = input;
      if (commandType !== type || !validateAgentMenuEditArgs(type, args)) return { kind: 'invalid' };
      const before = activeMenu(snapshot, input.menuId);
      if (!before) return { kind: 'invalid', field: 'menuId' };
      if (input.type === 'menu.update') {
        const tr = navisTranslator(locale);
        const { name, category, price, memo } = input.patch;
        if ((name === undefined || name.trim() === menuLabel(tr, before)) && (category === undefined || normalizeMenuCategory(category) === normalizeMenuCategory(before.category))
          && (price === undefined || price === before.price)
          && (memo === undefined || (memo?.trim() || null) === (before.memo ? resolveDataText(tr.t, before.memo) : null))) return { kind: 'unchanged' };
      }
      if (input.type === 'menu.setOptions') {
        // Navis can change one option price. Removals and changes to other
        // option fields belong to the full editor.
        let priceChanges = 0;
        const original = new Map(before.optionGroups.flatMap(group => group.options.map(option => [option.optionId, option.extraPrice])));
        const copyWithOriginalPrices = input.groups.map(group => ({
          ...group,
          options: group.options.map(option => {
            const extraPrice = original.get(option.optionId);
            if (extraPrice !== option.extraPrice) priceChanges++;
            return { ...option, extraPrice };
          }),
        }));
        if (priceChanges > 1 || !equalData(before.optionGroups, copyWithOriginalPrices)) return { kind: 'invalid', field: 'groups' };
        if (!priceChanges) return { kind: 'unchanged', field: 'groups' };
      }
      const command = { ...input, baseRevision: snapshot.revision, idempotencyKey };
      const simulate = handlers[type] as (context: HandlerContext, command: MenuEdit) => HandlerResult;
      let sequence = 0;
      const simulated = simulate({ snapshot, tables: snapshot.tables, nextId: () => `navis-preview-${proposalId}-${++sequence}` }, command);
      if (!simulated.ok) return { kind: 'invalid', field: simulated.field, messageKey: simulated.messageKey };
      if (equalData(simulated.tables.menuItem, snapshot.tables.menuItem)
        && equalData(simulated.tables.recipeLine, snapshot.tables.recipeLine)) return { kind: 'unchanged' };
      const after = activeMenu({ ...snapshot, tables: simulated.tables }, input.menuId);
      const preview = presentEdit(locale, command, before, after);
      const outlier = command.type === 'menu.update' && command.patch.price !== undefined
        && (command.patch.price < before.price * 0.2 || command.patch.price > before.price * 5);
      return outlier
        ? { kind: 'ready', command, preview: { ...preview, title: `${preview.target} · ${navisTranslator(locale).t(menuKey('menuPriceOutlier'))}` }, tier: 'extra-confirm' }
        : { kind: 'ready', command, preview };
    },
    undoToken: result => result.undoToken,
  };
}

const inputAliases = new Map<string, readonly string[]>(([
  ['m-americano', ['아메리까노', 'americano', '美式咖啡']],
  ['m-cafe-latte', ['카패라테', '까페라떼', '카페레테', '카폐라테', 'cafe latte', '咖啡拿铁', '咖啡拿鐵']],
  ['m-coldbrew', ['콜드브루', 'cold brew']],
  ['m-vanilla-latte', ['바닐라라테', 'vanilla latte', '香草拿铁', '香草拿鐵']],
  ['m-caramel-macchiato', ['caramel macchiato', '焦糖玛奇朵', '焦糖瑪奇朵']],
] as const).map(([id, aliases]) => [id, aliases.map(normalizeNavisName)]));

type NamedRead = { readonly name: string; readonly aspect: 'price' | 'memo' | 'sold' | 'cost' | 'costAndMargin' | 'status' };
function readNamedQuery(text: string): NamedRead | undefined {
  const clean = text.replace(/[.?!。？！]+$/u, '');
  const patterns = [
    [/^(.+?)\s*메모(?:에|는|가)?\s*(?:뭐라고|뭐가|뭐야|알려|보여|있어|읽어|$)/u, 'memo'],
    [/^(.+?)\s*(?:오늘\s*(?:판매량|몇\s*(?:잔|개)\s*(?:팔렸|나갔|팔았))|몇\s*(?:잔|개)\s*(?:팔렸|나갔|팔았))/u, 'sold'],
    [/^(.+?)\s*(?:원가|재료값)(?:와|하고|이랑|랑|과)\s*마진/u, 'costAndMargin'],
    [/^(.+?)\s*(?:원가(?:가|는)?\s*(?:얼마|알려|보여|$)|한\s*잔\s*만드(?:는\s*데|는데)\s*얼마)/u, 'cost'],
    [/^(.+?)\s*(?:지금\s*)?(?:팔아|판매해|팔고 있|품절이야|메뉴\s*있어)/u, 'status'],
    [/^(.+?)\s*(?:(?:가격|판매가)(?:이|가|은|는|을)?\s*(?:얼마(?:야|였지|예요)|알려\s*(?:줘|주세요))?|얼마야|얼마였지)$/u, 'price'],
  ] as const;
  for (const [pattern, aspect] of patterns) {
    const name = pattern.exec(clean)?.[1].trim();
    if (name && !/(?:메뉴|원가|마진|매출|세금|오늘|이번|어제|내일|그거|아까)/u.test(name)) return { name, aspect };
  }
  return undefined;
}

function mentionedMenu(snapshot: DataSnapshot, locale: Locale, text: string) {
  const tr = navisTranslator(locale);
  const normalized = normalizeNavisName(text);
  const matches = selectMenus(snapshot, {}).rows.flatMap(row =>
    [normalizeNavisName(menuLabel(tr, row)), ...(inputAliases.get(row.menuId) ?? [])]
      .flatMap(key => {
        const position = key ? normalized.indexOf(key) : -1;
        return position < 0 ? [] : [{ row, key, position }];
      }));
  matches.sort((a, b) => a.position - b.position || b.key.length - a.key.length);
  const first = matches[0];
  return first && !matches.some(match => match.position === first.position
    && match.key.length === first.key.length && match.row.menuId !== first.row.menuId) ? first.row : undefined;
}

const ref = (slot: string) => ({ slot });
const unbound: AgentHandleRef = { handle: 'unbound-menu' };
const editTurn = (command: MenuEdit['type'], name: string, args: AgentWireArgs = {}, slots: LocalSlots = {}, selected?: string): DomainRoute => ({
  intent: { kind: 'command', command, querySlot: 'name', args },
  slots: { name, ...slots },
  lookups: [
    { kind: 'menu', querySlot: 'name', bind: ['menuId'], ...(selected ? { selected } : {}),
      ...(command === 'menu.setRecipe' ? { readingBind: ['menuId'] } : {}) },
    ...(command === 'menu.update' && typeof slots.newName === 'string' ? [{ kind: 'menu' as const, querySlot: 'newName' }] : []),
  ],
  ...(command === 'menu.setRecipe' ? { reading: { tool: 'get_recipe', args: { menuId: unbound } } } : {}),
});

function readMenuTurn(featureId: 'menu' | 'margin', factKeys: readonly string[], condition: QueryCondition = defaultCondition): DomainRoute {
  return { intent: { kind: 'read', featureId, condition }, factKeys };
}

function menuAmount(text: string): number | undefined {
  const spans = navisMoneySpans(text);
  if (spans.length) return spans.at(-1)?.value;
  const bare = /(?<![\d.,+-])([+-]?(?:\d[\d,]*(?:\.\d+)?(?:\s*[천백만](?:\s*\d+\s*[천백십])*)?|[일이삼사오육칠팔구십백천만]+))\s*(?:원|won|韩元|韓元|으로|로|쯤|까지|ㄱ|$)/iu.exec(text);
  return bare ? parseNavisMoney(bare[1]) : undefined;
}

function menuPeriod(text: string, snapshot: DataSnapshot): QueryCondition | undefined {
  const supported = supportedConditions('margin');
  if (/(?:7\s*일|일주일|주간)/u.test(text)) return supported[1];
  if (/(?:30\s*일|최근\s*한\s*달)/u.test(text)) return supported[2];
  const businessDate = snapshot.pos?.businessDate ?? '';
  const date = parseNavisDate(text, businessDate);
  const period = parseNavisPeriod(text, businessDate);
  if (date && date !== businessDate) return { kind: 'dateRange', start: date, end: date };
  return period && (period.start !== businessDate || period.end !== businessDate) ? { kind: 'dateRange', ...period } : undefined;
}

function menuNavigation(text: string, snapshot: DataSnapshot, locale: Locale): DomainDetail | undefined {
  if (!/(?:열어|화면|자세히|상세|마진.*보기|메뉴에서.*보여|등록\s*폼|\bopen\b|打开|打開)/iu.test(text)) return undefined;
  const row = mentionedMenu(snapshot, locale, text);
  const featureId = /마진|\bmargin\b|毛利/iu.test(text) ? 'margin' : /메뉴|레시피|옵션|\bmenu\b|菜单|菜單/iu.test(text) || row ? 'menu' : undefined;
  if (!featureId) return undefined;
  if (featureId === 'menu' && /(?:메뉴\s*(?:새로\s*)?(?:추가|등록)|\badd\b.*\bmenu\b)/iu.test(text)) {
    return { args: { featureId, view: 'register' } };
  }
  const condition = featureId === 'margin' ? menuPeriod(text, snapshot) : undefined;
  if (condition && !normalizeCondition('margin', condition).ok) return undefined;
  const view = featureId === 'margin' ? /(?:시뮬레이터|계산기|바꿔\s*보기)/u.test(text) ? 'simulator' : 'items'
    : /레시피/u.test(text) ? 'recipe' : /옵션/u.test(text) ? 'options' : row ? 'item' : 'list';
  const focus = view === 'recipe' || view === 'options' || view === 'simulator' ? 'action' : undefined;
  const priceText = view === 'simulator' ? /(?:판매가|가격)\s*([\d,.]+)/u.exec(text)?.[1] : undefined;
  const costText = view === 'simulator' ? /원가\s*([\d,.]+)/u.exec(text)?.[1] : undefined;
  const price = priceText && parseNavisNumber(priceText);
  const cost = costText && parseNavisNumber(costText);
  const prefill = {
    ...(isMenuPrice(price) ? { price } : {}),
    ...(typeof cost === 'number' && Number.isSafeInteger(cost) && cost >= 0 ? { cost } : {}),
  };
  const hasPrefill = row && Object.keys(prefill).length > 0;
  const route = {
    args: { featureId, view, ...(row ? { itemId: row.menuId } : {}), ...(condition ? { condition } : {}),
      ...(focus ? { focus } : {}), ...(hasPrefill ? { prefill } : {}) },
    ...(row ? { target: { kind: 'menu' as const, id: row.menuId }, querySlot: 'name' } : {}),
    ...(hasPrefill ? { local: true } : {}),
  };
  return route;
}

const alreadyDeleted: Readonly<Record<Locale, string>> = {
  ko: '이미 삭제된 메뉴예요', en: 'That menu item is already deleted.', 'zh-Hans': '这个菜单商品已经删除了。', 'zh-Hant': '這個菜單商品已經刪除了。',
};
const menuRecipeQuantity = /(?:우유|원두|시럽|컵)(?:\s*양)?\s*[+-]?\d.*(?:[로gL]|그램|리터|밀리|미리|개)\s*[.!?]?$/iu;
const ingredientOffScope = /재고|발주|입고|보충/u;
const menuCatalogQuestion = /^(?:우리(?:\s*가게)?\s*)?메뉴(?:는|가)?\s*(?:우리(?:\s*가게)?\s*)?(?:뭐\s*뭐|어떤\s*것(?:들)?이?)\s*있(?:어(?:요)?|지|나요|습니까)?[.?!]*$/u;
const menuCatalogRequest = /^(?:메뉴\s*(?:다|전부|모두)\s*알려|메뉴판\s*보여)\s*(?:줘|주세요)?[.?!]*$/u;

const BEST_SELLER = /(?:제일|가장|젤)\s*(?:잘|많이)\s*(?:팔[리렸린려]|나가|나간)|잘\s*(?:팔리|팔려|나가)|많이\s*(?:팔[리렸린려]|나가|나간)|인기\s*(?:있는\s*)?(?:메뉴|상품|음료)|베스트\s*(?:셀러|메뉴)?|판매\s*(?:순위|랭킹|1위)|(?:매출|판매)\s*(?:상위|TOP|top)/u;
const COUNT_WORDS: Readonly<Record<string, number>> = { 한: 1, 하나: 1, 일: 1, 두: 2, 둘: 2, 이: 2, 세: 3, 셋: 3, 삼: 3, 네: 4, 넷: 4, 사: 4, 다섯: 5, 오: 5 };
/** How many menus a "best seller" question asks for: a stated number lists that many, a bare "제일 …" asks for one, anything else three. */
function bestSellerCount(text: string): { readonly n: number; readonly listed: boolean } {
  const digits = /(?:상위|TOP|top)\s*(\d{1,2})|(\d{1,2})\s*(?:개|가지|위|등)/u.exec(text);
  const words = /(한|하나|두|둘|세|셋|네|넷|다섯)\s*(?:개|가지|위|등)/u.exec(text);
  const n = digits ? Number(digits[1] ?? digits[2]) : words ? COUNT_WORDS[words[1]] : undefined;
  if (n && n >= 1 && n <= 10) return { n, listed: n > 1 };
  return /(?:제일|가장|젤|1위|일위)/u.test(text) ? { n: 1, listed: false } : { n: 3, listed: true };
}
function bestSellerPeriod(text: string): 'today' | 'week' | 'month' {
  if (/(?:30\s*일|이번\s*달|이달|한\s*달|월간)/u.test(text)) return 'month';
  if (/(?:요즘|최근|이번\s*주|금주|일주일|7\s*일|주간|요새)/u.test(text)) return 'week';
  return /오늘|금일|지금까지/u.test(text) ? 'today' : 'week';
}
const topByValue = (n: number) => (facts: readonly SnapshotFact[]): readonly SnapshotFact[] =>
  [...facts].filter(fact => typeof fact.value === 'number').sort((a, b) => (b.value as number) - (a.value as number)).slice(0, n);

function menuRoute(text: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const tr = navisTranslator(locale);
  const t = tr.t;
  const clean = normalizeNavisInput(text);
  const quote = /["“'‘「『]([^"”'’」』]+)["”'’」』]/gu;
  const unquoted = clean.replace(quote, ' ');
  const row = mentionedMenu(snapshot, locale, unquoted);
  const actualName = row && menuLabel(tr, row);
  const answer = (field: string): DomainRoute => ({ kind: 'answer', answer: t(menuKey(field)) });
  const clarify = (field: string, label: string, resume?: (value: string) => DomainRoute | undefined): Extract<DomainRoute, { kind: 'clarification' }> =>
    ({ kind: 'clarification', field, answer: t(menuKey(label)), ...(resume ? { resume } : {}) });
  const chooseMenu = (query: string, resume: (menu: MenuRow, name: string, selected?: string) => DomainRoute): DomainRoute => {
    const search = { snapshot, locale, query, privateLookup: false, command: 'menu.update' } as const;
    const matches = menuReader.search(search);
    if (matches.length === 1 && matches[0].match === 'exact') {
      const menu = activeMenu(snapshot, menuReader.resolve?.(search, matches[0].handle));
      if (menu) return resume(menu, query, matches[0].handle);
    }
    if (!matches.length) return clarify('menuId', 'chooseMenu', value => chooseMenu(value, resume));
    const choices = matches.slice(0, 5);
    return {
      ...clarify('menuId', 'chooseMenu', value => {
        if (!choices.some(choice => choice.handle === value)) return undefined;
        const menu = activeMenu(snapshot, menuReader.resolve?.(search, value));
        return menu ? resume(menu, query, value) : undefined;
      }),
      choices: choices.flatMap(({ handle, label, category, price }) => label ? [{
        id: handle, label,
        detail: [category && t(menuKey(category)), price === undefined ? undefined : tr.format.money(price, 'full')].filter(Boolean).join(' · '),
      }] : []),
    };
  };
  const absent = (): DomainRoute => ({ kind: 'refusal', reason: 'invalid_target', answer: t(menuKey('menuNotFound')) });
  const menuMention = /메뉴|판매가|\bmenu\b|菜单|菜單/iu.test(unquoted);
  const commandVerb = /(?:바[꿔꽈까]|밖꿔|고쳐|남겨|올[려리]|내[려리]|낮춰|줄여|늘려|변경|변겅|수정|손봐|설정|지워|삭제|없애|빼|넣어|인상|인하|더\s*받|품절\s*처리|판매\s*중단|해\s*(?:줘|주|부러|줄래|줄\s*수\s*있)|으로\s*ㄱ)|\b(?:set|change|update|make|mark|raise|lower|remove|delete|up|down)\b|(?:改成|改為|改为|设为|設為|涨到|漲到)/iu;
  const negation = /(?:하지|바꾸지|올리지|지우지|변경하지)\s*마|\b(?:do not|don't|never)\b|不要|别|別/iu;
  const edit = commandVerb.test(unquoted) || /품절(?:로)?(?:\s*[.!?]?$)|다시\s*판매|판매\s*재개|품절\s*풀어/u.test(unquoted);
  if (negation.test(unquoted)) return undefined;
  if ((menuMention || row) && !/메모|레시피|재료|옵션/u.test(unquoted) && /지워|삭제|없애|\bdelete\b|删除|刪除/iu.test(unquoted) &&
    (/모두|전부|전체|한꺼번에|한\s*번에|싹|(?:^|\s)다\s|두\s*(?:개|건)|둘\s*다|\b(?:all|every|both)\b|全部|所有/iu.test(unquoted) ||
      unquoted.split(/(?:이랑|하고|및|[과와랑])\s+|[,·]\s*/u).filter(part => {
        const query = part.replace(/\s*(?:메뉴\s*)?(?:지워|삭제|없애).*$/u, '').trim();
        return menuReader.search({ snapshot, locale, query, privateLookup: true, command: 'menu.delete' }).length;
      }).length > 1)) {
    return { kind: 'refusal', reason: 'unsupported' };
  }
  if (menuNavigation(clean, snapshot, locale)) return undefined;
  if (/(?:방법|하는\s*법)/u.test(unquoted) || !/마진|\bmargin\b|毛利/iu.test(unquoted) && /어떻게|\bhow\b/iu.test(unquoted)) {
    if (menuMention && /추가|등록|add/iu.test(unquoted)) return answer('manualRoute');
    return undefined;
  }
  // Leave create parsing and its follow-ups with the existing N00 entry.
  if (/(?:메뉴에|신\s*메뉴|\b(?:to|on) (?:the )?menu\b|菜单|菜單)/iu.test(unquoted) && /추가|등록|넣|add|create|加入|添加|新增/iu.test(unquoted)
    && !/(?:레시피|옵션|价格|價格)/u.test(unquoted)) return undefined;
  const query = !edit && readNamedQuery(clean);
  if (query && (row || menuReader.search({ snapshot, locale, query: clean, privateLookup: false }).length)) {
    return { intent: { kind: 'read', recordKind: 'menu', querySlot: 'name' }, slots: { name: clean } };
  }
  const asksMargin = /마진|\bmargin\b|毛利/iu.test(unquoted);
  const isCost = /원가|\bcost\b|成本/iu.test(unquoted);
  const hypothetical = /(?:되면|올리면|오르면|내리면|받으면|이면)|계산\s*해/u.test(unquoted);
  const simulationAmount = hypothetical ? menuAmount(unquoted) : undefined;
  const simulationQuery = /^(.*?)\s*(?:원가|가격|판매가|값|[+-]?\d)/u.exec(unquoted)?.[1].trim() ?? '';
  if (hypothetical && (asksMargin || isCost || simulationAmount !== undefined) && (actualName
    || simulationQuery && menuReader.search({ snapshot, locale, query: simulationQuery, privateLookup: false }).length)) {
    const field = isCost ? 'cost' : 'price';
    const simulate = (amount: number, name: string, selected?: string): DomainRoute => ({
      intent: { kind: 'read', tool: 'simulate_menu_price' }, slots: { name, [field]: amount },
      lookups: [{ kind: 'menu', querySlot: 'name', bind: ['menu'], ...(selected ? { selected } : {}) }],
      reading: { tool: 'simulate_menu_price', args: { menu: unbound, [field]: ref(field) } },
    });
    const valid = (amount: number | undefined): amount is number => isCost ? amount === 0 || isMenuPrice(amount) : isMenuPrice(amount);
    const withMenu = (amount: number, relative: boolean): DomainRoute => {
      const estimate = (menu: MenuRow, name: string, selected?: string) => {
        const next = relative ? menu.price + (/내리면/u.test(unquoted) ? -amount : amount) : amount;
        return valid(next) ? simulate(next, name, selected) : askAmount('priceInvalid');
      };
      return row && actualName ? estimate(row, actualName) : chooseMenu(simulationQuery, estimate);
    };
    const askAmount = (label: string): DomainRoute => clarify(field, label, value => {
      const amount = menuAmount(value) ?? parseNavisMoney(value);
      return valid(amount) ? withMenu(amount, false) : askAmount('priceInvalid');
    });
    if (simulationAmount === undefined) return askAmount(isCost ? 'menuCostQuestion' : 'priceQuestion');
    if (!valid(simulationAmount)) return askAmount('priceInvalid');
    return withMenu(simulationAmount, !isCost && /원\s*(?:올리면|내리면)/u.test(unquoted));
  }
  if (/(?:제일|가장).*남겼|(?:이익|마진).*?(?:1등|가장\s*큰|제일\s*큰)/u.test(unquoted)) return readMenuTurn('margin', ['margin.menu.contribution.top']);
  if (asksMargin && !commandVerb.test(unquoted)) {
    const period = menuPeriod(clean, snapshot);
    if (/(?:어제|지난달|이번\s*달|이번\s*주|저번\s*달)/u.test(clean) || period && !normalizeCondition('margin', period).ok) {
      return { kind: 'answer', answer: `${t(menuKey('unsupportedPeriod'))} ${marginText(locale).t('widget.ledger.periodLabel')} ${t(menuKey('menuMarginPeriods'))}` };
    }
    if (/추이|흐름|요즘.*마진|\btrend\b/iu.test(unquoted)) return readMenuTurn('margin', ['margin.rate.daily'], period ?? supportedConditions('margin')[1]);
    if (/왜|안\s*나와/u.test(unquoted)) return readMenuTurn('margin', ['margin.coverage'], period);
    return readMenuTurn('margin', ['margin.rate', 'margin.sales.net', 'margin.cost', 'margin.grossProfit'], period);
  }
  if (/^(?:우리\s*가게\s*)?(?:메뉴\s*(?:총\s*)?몇\s*개|메뉴\s*수)/u.test(unquoted)) return readMenuTurn('menu', ['menu.count']);
  if (!commandVerb.test(unquoted) && /(?:품절).*있어|품절(?:된)?\s*메뉴|못\s*파는\s*메뉴|\bsold out\b.*\b(any|which)\b/iu.test(unquoted)) {
    return readMenuTurn('menu', ['menu.soldOut.count', 'menu.soldOut.row']);
  }
  if (!edit && BEST_SELLER.test(unquoted) && !/(?:추천|아이디어|방법|어떻게|왜)/u.test(unquoted)) {
    const count = bestSellerCount(unquoted);
    const stated = bestSellerPeriod(unquoted);
    // The menu widget's own sold tally exists only for the fixture clock; a plain "today's best seller" keeps that older answer there.
    if (!snapshot.tables.realFinance && !count.listed && stated === 'today') return readMenuTurn('menu', ['menu.soldQty.top']);
    const supported = supportedConditions('margin');
    const condition = stated === 'today' ? supported[0] : stated === 'month' ? supported[2] : supported[1];
    return { intent: { kind: 'read', featureId: 'margin', condition }, factKeys: ['margin.menu.qty'], narrow: topByValue(count.n) };
  }
  if (/(?:제일|가장)\s*(?:많이|잘)\s*(?:팔렸|팔린|나간|나가)|오늘\s*베스트\s*메뉴|베스트셀러\s*메뉴/u.test(unquoted)) return readMenuTurn('menu', ['menu.soldQty.top']);
  if (!edit && (menuCatalogQuestion.test(unquoted) || menuCatalogRequest.test(unquoted))) {
    return readMenuTurn('menu', ['menu.count', 'menu.price']);
  }
  if (/(?:메뉴판|전체\s*메뉴).*가격|메뉴\s*가격(?:표|.*(?:쭉|전부|모두|목록))/u.test(unquoted)) return readMenuTurn('menu', ['menu.price']);
  if (/(?:디저트|빵\s*종류).*(?:뭐|알려|있어)/u.test(unquoted)) return readMenuTurn('menu', ['menu.dessert.price']);
  if (row && !edit && /레시피|얼마나\s*들어|재료\s*(?:가\s*)?뭐/u.test(unquoted)) {
    return { intent: { kind: 'read', tool: 'get_recipe' }, slots: { name: actualName },
      lookups: [{ kind: 'menu', querySlot: 'name', bind: ['menuId'] }], reading: { tool: 'get_recipe', args: { menuId: unbound } } };
  }
  const compactRecipeEdit = menuRecipeQuantity.test(unquoted);
  const recipeTarget = /^(.+?)(?:\s*레시피)?에(?:는)?\s+(?=.+?(?:추가|넣어|더해|\d\s*(?:mL|g|밀리|미리|그램|리터)))/iu.exec(unquoted)?.[1];
  // A recipe line carries a quantity of an ingredient; a won amount on the line is a price (an option or a surcharge), not a recipe.
  const recipeAddition = !!recipeTarget && !ingredientOffScope.test(unquoted) && navisMoneySpans(unquoted).length === 0
    && menuReader.search({ snapshot, locale, query: recipeTarget, privateLookup: false }).length > 0;
  // "가격 그대로 4,500원" states the intended price, so it follows the same same-value check as an explicit change.
  const statedPrice = !!row && /(?:가격|값|판매가)\s*(?:은|는)?\s*(?:그대로|똑같이)/u.test(unquoted) && menuAmount(unquoted) !== undefined;
  const compactPriceEdit = /(?:가격|값|판매가).+?(?:으로|로)\s*[.!?]?$/u.test(unquoted) || !!row && /원\s*으로\s*[.!?]?$/u.test(unquoted) || statedPrice;
  const freePrice = !!row && /(?:공짜|무료)(?:\s*으?로)?\s*(?:해\s*(?:줘|주)|바꿔|변경)/u.test(unquoted);
  const unspecifiedPrice = !!row && /원\s*중에\s*알아서\s*[.!?]?$/u.test(unquoted);
  const compactOtherEdit = /사진.*(?:올릴게|업로드)|이름\s*(?:[→:]|.+(?:으?로)\s*[.!?]?$)|메모(?:는|를|에)\s+.+으로\s*$/u.test(unquoted);
  if (!edit && !compactRecipeEdit && !compactPriceEdit && !recipeAddition && !compactOtherEdit && !unspecifiedPrice) return undefined;
  if (/사진|\bphoto\b/iu.test(unquoted) && (row || menuMention)) {
    return { kind: 'refusal', reason: 'widget_only', alternative: {
      featureId: 'menu', command: 'menu.setPhoto', draft: row ? { menuId: row.menuId } : {},
    } };
  }
  const recipeEdit = /레시피|재료에서/u.test(unquoted) || !ingredientOffScope.test(unquoted)
    && (recipeAddition || compactRecipeEdit || /(?:우유|원두|시럽|컵).*?(?:줄여|늘려|넣어|빼|바꿔|삭제)/u.test(unquoted));
  if (recipeEdit) {
    const recipeQuery = recipeTarget ?? /^(.+?)\s*(?:레시피|재료에서|우유|원두|시럽|컵)/u.exec(unquoted)?.[1].trim() ?? '';
    if (!row && !menuMention && !/레시피/u.test(unquoted)
      && !menuReader.search({ snapshot, locale, query: recipeQuery, privateLookup: false }).length) return undefined;
    const phrase = normalizeNavisName(unquoted.slice(recipeQuery.length));
    const ingredients = snapshot.tables.inventoryItem.filter(item => item.kind === 'ingredient' && !item.deletedAt).map(item => ({
      item, terms: menuLabel(tr, item).split(/[\s·]+/u).map(normalizeNavisName).filter(term => term.length >= 2 || term === '컵'),
    }));
    const changeRecipe = (menu: MenuRow, name: string, selected?: string): DomainRoute => {
      const lines = menu.recipeLines.map(({ recipeLineId, itemId, quantity, unit }) => ({ recipeLineId, itemId, quantity, unit }));
      const propose = (next: Extract<MenuEdit, { type: 'menu.setRecipe' }>['lines']) =>
        editTurn('menu.setRecipe', name, { lines: ref('lines') }, { lines: next }, selected);
      const changeIngredient = (ingredient: typeof ingredients[number]['item'], stated: string, relative: boolean): DomainRoute => {
        const itemId = ingredient.itemId;
        const priorLine = lines.find(line => line.itemId === itemId);
        if (/빼|삭제|지워/u.test(unquoted)) return priorLine ? propose(lines.filter(line => line.itemId !== itemId)) : answer('unchanged');
        const spoken = stated.replace(/(?<=\d)\s*(?:미리|밀리)(?!리터)/gu, ' mL');
        const target = spoken.split(/\d\s*(?:[a-z]+|그램|리터|개)?\s*에서\s*/iu).at(-1) ?? spoken;
        const quantity = parseNavisQuantity(target);
        const bare = /(?:^|\s)([+-]?\d+(?:\.\d+)?)\s*(?:으로|로)?\s*[.!?]?$/u.exec(target)?.[1];
        const amount = quantity?.value ?? (bare && priorLine ? parseNavisNumber(bare) : undefined);
        const specifiedUnit = quantity?.unit ?? priorLine?.unit;
        const askQuantity = () => clarify('quantity', 'menuQuantityQuestion', value => changeIngredient(ingredient, value, relative));
        if (amount === undefined || !specifiedUnit) return askQuantity();
        const unit = specifiedUnit;
        const base = toBase(amount, unit);
        if (!isBaseUnit(unit) || unitDimension(unit) !== unitDimension(ingredient.unit) || base === null || base <= 0) {
          return { kind: 'refusal', reason: 'invalid_target', answer: t(menuKey('menuUnitMismatch')) };
        }
        if (relative && !priorLine) return askQuantity();
        const next = relative && priorLine ? (toBase(priorLine.quantity, priorLine.unit) ?? 0) + (/줄여/u.test(unquoted) ? -base : base) : base;
        if (next <= 0 || !Number.isSafeInteger(next)) return askQuantity();
        const quantityInUnit = fromBase(next, unit);
        return propose(priorLine
          ? lines.map(line => line.itemId === itemId ? { ...line, quantity: quantityInUnit, unit } : line)
          : [...lines, { itemId, quantity: quantityInUnit, unit }]);
      };
      const relative = /줄여|늘려/u.test(unquoted) &&
        !/\d\s*(?:[a-z]+|그램|미리|밀리(?:리터)?|리터|개)?\s*(?:으로|로|에서)/iu.test(unquoted);
      const findIngredient = (key: string, stated: string): DomainRoute => {
        const ranked = ingredients.map(({ item, terms }) => ({
          item, length: Math.max(0, ...terms.filter(term => key.includes(term)).map(term => term.length)),
          existing: lines.some(line => line.itemId === item.itemId),
        })).filter(item => item.length > 0)
          .sort((a, b) => b.length - a.length || Number(b.existing) - Number(a.existing));
        const [first, second] = ranked;
        if (!first && recipeAddition) return { kind: 'refusal', reason: 'invalid_target' };
        if (!first || second?.length === first.length && second.existing === first.existing) {
          return clarify('itemId', 'menuIngredientQuestion', value => findIngredient(normalizeNavisName(value), stated));
        }
        return changeIngredient(first.item, stated, relative);
      };
      return findIngredient(phrase, unquoted);
    };
    return row && actualName ? changeRecipe(row, actualName) : chooseMenu(recipeQuery, changeRecipe);
  }
  if (/옵션/u.test(unquoted) && actualName && row) {
    const price = menuAmount(unquoted);
    // Option edits carry every active group and option. The command handler
    // retains archived group/option tombstones from the current snapshot.
    const key = normalizeNavisName(unquoted);
    const choices = row.optionGroups.flatMap(group => group.options.filter(option => key.includes(normalizeNavisName(option.name))).map(option => option.optionId));
    if (choices.length !== 1 || price === undefined || price < 0 || !Number.isSafeInteger(price)) return clarify('option', 'menuOptionQuestion');
    const groups = row.optionGroups.map(group => ({ ...group, options: group.options.map(option => option.optionId === choices[0] ? { ...option, extraPrice: price } : option) }));
    return editTurn('menu.setOptions', actualName, { groups: ref('groups') }, { groups: structuredClone(groups) as unknown as LocalSlots[string] });
  }

  const priceChange = /(?:가격|판매가|price|값|가걱|올려|내려|인상|인하|더\s*받|\bup\b|\bdown\b|价格|價格)/iu.test(unquoted)
    || (freePrice || unspecifiedPrice || menuAmount(unquoted) !== undefined) && !/메모|분류|이름|품절/u.test(unquoted);
  const archive = !/메모|레시피|재료|옵션/u.test(unquoted)
    ? /^(.+?)(?:\s*메뉴)?(?:을|를)?\s*(?:지워|삭제)(?:\s*(?:해)?\s*(?:줘|주세요|줘요))?[.!?]?$/u.exec(unquoted)?.[1].trim()
    : undefined;
  const otherEdit = /품절|다시\s*판매|판매\s*(?:중단|재개)|sold out|售罄|메모|이름|분류|카테고리/iu.test(unquoted) || archive;
  if (!priceChange && !otherEdit) return undefined;
  const inferred = /^(.*?)\s*(?:메뉴\s*)?(?:가격|판매가|가걱|값|품절|이름|분류|카테고리|메모|다시\s*판매|판매\s*재개|지워|삭제|[+-]?\d)/u.exec(unquoted)?.[1].trim();
  const name = archive ?? actualName ?? inferred;
  if (!name && /^(?:가격|판매가|값)(?:\s|$)/u.test(unquoted)) {
    return clarify('menuId', 'chooseMenu', value => menuRoute(`${value} ${clean}`, snapshot, locale));
  }
  if (!name || /^(?:그거|이거|아니|방금|아까|똑같이|가격|응)(?:\s|$)/u.test(name)) return undefined;
  const candidates = menuReader.search({ snapshot, locale, query: name, privateLookup: false }).filter(item => item.fields?.kind === 'menu');
  if (archive && !candidates.some(candidate => candidate.match === 'exact')) {
    // An exact local tombstone is a finished delete: say so without a card, before any active-menu routing.
    const gone = normalizeNavisName(archive);
    if (gone && snapshot.tables.menuItem.some(item => item.kind !== 'retail' && item.deletedAt
      && (normalizeNavisName(menuLabel(tr, item)) === gone || inputAliases.get(item.menuId)?.includes(gone)))) {
      return { kind: 'answer', answer: alreadyDeleted[locale] };
    }
    return menuMention && !row ? absent() : undefined;
  }
  if (!row && !candidates.length) return menuMention || /품절|다시\s*판매|판매\s*재개|분류|카테고리/u.test(unquoted) ? absent() : undefined;
  if (archive) return editTurn('menu.delete', name);
  if (/메모/u.test(unquoted)) {
    const memo = [...clean.matchAll(quote)][0]?.[1] ?? /메모.*?[:：]\s*(.+)$/u.exec(clean)?.[1]?.trim()
      ?? /메모(?:는|를|에)?\s+(.+?)(?:으?로)\s*[.!?]?$/u.exec(clean)?.[1]?.trim();
    if (/지워|삭제|비워|없애/u.test(unquoted)) return row && !row.memo ? answer('menuNoMemo') : editTurn('menu.update', name, { patch: { memo: null } });
    return memo ? editTurn('menu.update', name, { patch: { memo: ref('memo') } }, { memo }) : clarify('memo', 'menuMemoQuestion');
  }
  if (/이름/u.test(unquoted)) {
    const newName = [...clean.matchAll(quote)][0]?.[1]
      ?? /이름(?:을|은)?\s*(.+?)(?:으?로)(?:\s*(?:바꿔|변경|수정|해)|\s*[.!?]?$)/u.exec(clean)?.[1]?.trim()
      ?? /이름\s*[→:]\s*(.+)$/u.exec(clean)?.[1]?.trim()
      ?? /(.+?)(?:으?로)\s*이름\s*변경/u.exec(clean)?.[1]?.replace(/^[^\s]+(?:을|를)\s*/u, '').trim();
    const rename = (menu: MenuRow, targetName: string, selected?: string): DomainRoute => {
      const propose = (value: string) => value.trim() === menuLabel(tr, menu)
        ? answer('unchanged')
        : editTurn('menu.update', targetName, { patch: { name: ref('newName') } }, { newName: value }, selected);
      return newName ? propose(newName)
        : clarify('newName', 'nameQuestion', value => menuSlots.name(value) ? propose(value) : undefined);
    };
    const target = /^(.+?)(?:을|를)\s+.+?(?:으?로)\s*이름\s*(?:변경|수정|바꿔|바꾸)/u.exec(unquoted)?.[1].trim()
      ?? /^(.+?)\s*(?:메뉴\s*)?이름\s*(?:을|은)?\s*\S/u.exec(unquoted)?.[1].trim();
    const named = target && menuReader.search({ snapshot, locale, query: target, privateLookup: false, command: 'menu.update' }).length ? target : undefined;
    // No menu can take a name another menu already has, so the agent refuses before the owner has to pick among similar menus.
    const taken = !!newName && menuReader.search({ snapshot, locale, query: newName, privateLookup: false, command: 'menu.update' })
      .some(match => match.match === 'exact');
    const lone = (query: string) => {
      const found = menuReader.search({ snapshot, locale, query, privateLookup: false, command: 'menu.update' });
      return found.length === 1 && found[0].match === 'exact';
    };
    if (taken && !lone(named ?? name)) {
      return editTurn('menu.update', named ?? name, { patch: { name: ref('newName') } }, { newName: newName! });
    }
    if (named) return chooseMenu(named, rename);
    return row ? rename(row, name) : chooseMenu(name, rename);
  }
  if (/분류|카테고리/u.test(unquoted)) {
    const value = /(?:분류|카테고리)(?:를|는|을)?\s*(커피|티|차|음료|디저트|coffee|tea|beverage|drinks?|desserts?|咖啡|茶|饮品|飲品|甜点|甜點)/iu.exec(unquoted)?.[1]
      ?? /(커피|티|차|음료|디저트)로/iu.exec(unquoted)?.[1];
    const category = value && parseMenuCategoryChoice(value);
    return category ? editTurn('menu.update', name, { patch: { category } }) : clarify('category', 'categoryQuestion');
  }
  if (/품절|sold out|售罄/iu.test(unquoted) || /다시\s*판매|판매\s*(?:중단|재개)/u.test(unquoted)) {
    const status = /다시\s*판매|판매\s*재개|품절\s*풀어/u.test(unquoted) ? 'selling' : 'sold_out';
    const unchanged: DomainRoute = { kind: 'answer', answer: `${t(menuKey('unchanged'))} ${t(menuKey(status))}` };
    if (row?.saleStatus === status) return unchanged;
    // When every menu the name could mean is already in that state, any choice would be a no-op.
    if (!row && candidates.length && candidates.every(candidate => candidate.fields?.status === status)) return unchanged;
    return editTurn('menu.setSaleStatus', name, { status });
  }
  const changePrice = (price: number, menu = row, targetName = name, selected?: string): DomainRoute => menu?.price === price
    ? { kind: 'answer', answer: `${t(menuKey('unchanged'))} ${tr.format.money(price, 'full')}` }
    : editTurn('menu.update', targetName, { patch: { price: ref('price') } }, { price }, selected);
  const askPrice = (
    label: string, supplied?: number, menu = row, targetName = name, selected?: string,
  ): Extract<DomainRoute, { kind: 'clarification' }> => {
    const reply = clarify('price', label, value => {
      const price = parseNavisMoney(value);
      return isMenuPrice(price) ? changePrice(price, menu, targetName, selected) : askPrice('priceInvalid', undefined, menu, targetName, selected);
    });
    const current = supplied ?? menu?.price;
    return current !== undefined
      ? { ...reply, answer: `${tr.format.money(current, 'full')} · ${reply.answer}` } : reply;
  };
  const money = navisMoneySpans(unquoted);
  if (/사이|범위|정도|쯤|안팎|중에\s*알아서|\baround\b/iu.test(unquoted)) return askPrice('menuExactPrice', menuAmount(unquoted));
  if (new Set(money.map(span => span.value)).size > 1 && !/\b(?:actually|instead)\b|아니|말고|정정|잠깐/iu.test(unquoted)) {
    return askPrice('menuExactPrice');
  }
  const percentMatch = /([\d.]+|[일이삼사오육칠팔구십]+)\s*(%|퍼센트|프로|할)/u.exec(unquoted);
  const percentValue = percentMatch ? parseNavisNumber(percentMatch[1]) : undefined;
  const percent = percentValue === undefined ? undefined : percentValue * (percentMatch?.[2] === '할' ? 10 : 1);
  const amount = menuAmount(unquoted);
  const decrease = /내려|낮춰|인하|lower|\bdown\b/iu.test(unquoted);
  const relative = /올려|내려|낮춰|인상|인하|더\s*받|\b(?:raise|lower|up|down)\b/iu.test(unquoted)
    && !/(?:원\s*(?:으로|에|까지)|\d\s*(?:으로|로)|\bto\s*[\d,])/iu.test(unquoted);
  if (percent !== undefined || relative && amount !== undefined && amount > 0) {
    const adjust = (menu: MenuRow, targetName: string, selected?: string): DomainRoute => {
      const delta = percent === undefined ? amount! : menu.price * percent / 100;
      const next = menu.price + (decrease ? -delta : delta);
      if (!isMenuPrice(next)) return askPrice('menuExactPrice', undefined, menu, targetName, selected);
      if (percent !== undefined && next % 100 !== 0) {
        const reply = askPrice('menuExactPrice', next, menu, targetName, selected);
        return { ...reply, answer: `${reply.answer} · ${tr.format.money(Math.round(next / 100) * 100, 'full')}` };
      }
      return changePrice(next, menu, targetName, selected);
    };
    return row ? adjust(row, name) : chooseMenu(name, adjust);
  }
  if (/공짜|무료|\d\s*전\s*(?:으로|로|$)/u.test(unquoted)) return askPrice('priceInvalid');
  if (amount === undefined) return askPrice('priceQuestion');
  if (!isMenuPrice(amount)) return askPrice('priceInvalid');
  return row ? changePrice(amount) : chooseMenu(name, (menu, targetName, selected) => changePrice(amount, menu, targetName, selected));
}

export const menuDomain = { commands: [menuCommandAdapter], reads: [menuReader] } satisfies DomainAdapter;

export const menuAgentDomain = {
  ...menuDomain,
  featureIds: ['menu', 'margin'],
  commands: [...menuDomain.commands, ...AGENT_MENU_EDIT_COMMANDS.map(menuEditAdapter)],
  tools: [getRecipe, simulatePrice],
  projectWidget: projectMenuWidget,
  routePresentation(text, snapshot, locale) {
    // A shorthand recipe edit can also contain a manual or stock lookup keyword.
    if (menuRecipeQuantity.test(text) && !ingredientOffScope.test(text)) return menuRoute(text, snapshot, locale);
  },
  route: menuRoute,
  navigation: menuNavigation,
  handoff(command, draft) {
    if (command !== 'menu.setPhoto') return undefined;
    return { featureId: 'menu', view: 'options', focus: 'action', ...(typeof draft.menuId === 'string' ? { itemId: draft.menuId } : {}) };
  },
} satisfies DomainAdapter;
