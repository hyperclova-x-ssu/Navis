import { unitDimension } from '../../../data/derive/common';
import type { FeatureId, Locale, QueryCondition } from '../../../contracts';
import { createTranslator } from '../../../i18n';
import { mgmtMoneyBundle } from '../../widgets/mgmt-money/messages';
import { handlers, type HandlerContext, type HandlerResult } from '../../../data/commands/handlers';
import type { DataCommand } from '../../../data/commands/types';
import { equalData } from '../../../data/db/inverse';
import { normalizeCondition, NORMAL_VARIANT, resolveDataText, selectMenus, selectWidget, simulateMenuPrice, supportedConditions, widgetFacts, type BaseUnit, type DataSnapshot, type DataText } from '../../../data/widget-data';
import { AGENT_MENU_EDIT_COMMANDS, validateAgentCommandArgs, validateAgentDraft, validateAgentMenuEditArgs, type AgentFact, type AgentHandleRef, type AgentMissingStatus, type AgentRecordMatch, type AgentWireArgs } from '../../../../shared/navis-agent-schema.mjs';
import { navisTranslator } from '../messages';
import { navisMoneySpans, normalizeNavisInput, normalizeNavisName, parseNavisDate, parseNavisMoney, parseNavisNumber, parseNavisPeriod, parseNavisQuantity } from '../navis-input';
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
    if (wire.category !== 'drink' && wire.category !== 'dessert') return undefined;
    if ('memo' in wire ? !menuSlots.memo(memo) || !isRef(wire.memo, 'memo') : memo !== undefined) return undefined;
    return { name, price, category: wire.category, ...(menuSlots.memo(memo) ? { memo } : {}) };
  },
  preflight(draft, { snapshot, proposalId, idempotencyKey }) {
    const args = { name: draft.name.trim(), category: draft.category, price: draft.price, ...(draft.memo?.trim() ? { memo: draft.memo } : {}) };
    if (!validateAgentCommandArgs('menu.create', args)) return { kind: 'invalid' };
    const before = selectMenus(snapshot, {});
    const key = normalizeNavisName(args.name);
    const ko = navisTranslator('ko');
    if (!key || before.rows.some(row => normalizeNavisName(row.name ? resolveDataText(ko.t, row.name) : ko.t(row.nameKey)) === key)) {
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
          name: created.name.raw, category: command.category, price: created.price,
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
    const read = readNamedQuery(query);
    const key = normalizeNavisName(read?.name ?? query);
    const choices = catalogRows(input).flatMap((row, index): AgentRecordMatch[] => {
      const label = menuLabel(tr, row);
      const candidate = normalizeNavisName(label);
      const match = candidate && (candidate === key || inputAliases.get(row.menuId)?.includes(key)) ? 'exact' as const
        : key.length > 1 && candidate.length > 1 && (candidate.includes(key) || key.includes(candidate)) ? 'similar' as const : undefined;
      if (!match) return [];
      const identity = { handle: menuHandle(index, input.querySlot), match };
      if (privateLookup && (!command || command === 'menu.create')) return [identity];
      const category = row.category === 'drink' || row.category === 'dessert' ? row.category : undefined;
      const fields = { kind: row.kind === 'retail' ? 'retail' : 'menu', status: row.saleStatus ?? 'selling' };
      return [privateLookup ? { ...identity, fields } : { ...identity, label, price: row.price, ...(category ? { category } : {}), fields }];
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
    if (aspect === 'sold' && active) detail = soldDisplay(tr, active);
    if (aspect === 'cost' && active) detail = active.cost === null ? marginText(locale).t('widget.margin.missingCost') : tr.format.money(active.cost, 'full');
    if (aspect === 'status' && active) detail = tr.t(menuKey(active.saleStatus));
    return input && match.label && detail ? `${match.label} ${detail}` : detail;
  },
};

function fact(key: string, label: string, value: number | string, unit: string, display: string,
  scope: Pick<AgentFact, 'date' | 'start' | 'end' | 'source'> = {}): AgentFact {
  return { key, label: label.slice(0, 250), value: typeof value === 'string' ? value.slice(0, 500) : value, unit, display: display.slice(0, 500), ...scope };
}

const soldDisplay = (tr: ReturnType<typeof navisTranslator>, row: MenuRow) =>
  row.category === 'drink' ? `${tr.format.number(row.soldQty)}${tr.locale === 'en' ? ' ' : ''}${tr.t(menuKey('menuCups'))}`
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
  const top = rows.filter(row => row.soldQty > 0).reduce<MenuRow | undefined>((best, row) => !best || row.soldQty > best.soldQty ? row : best, undefined);
  const facts = [
    fact('menu.count', tr.t(menuKey('count')), total, 'count', tr.format.count(total, 'count'), { source }),
    fact('menu.soldOut.count', tr.t(menuKey('sold_out')), soldOut.length, 'count', tr.format.count(soldOut.length, 'count'), { source }),
  ];
  if (top) facts.push(fact('menu.soldQty.top', menuLabel(tr, top), top.soldQty, top.category === 'drink' ? 'cup' : 'count', soldDisplay(tr, top), { date, source }));
  for (const row of rows) {
    const label = menuLabel(tr, row);
    const category = row.category === 'drink' || row.category === 'dessert' ? tr.t(menuKey(row.category)) : undefined;
    const details = [money(row.price), category, tr.t(menuKey(row.saleStatus)), soldDisplay(tr, row), row.memo && resolveDataText(tr.t, row.memo)];
    facts.push(fact('menu.row', label, row.price, 'KRW', details.filter(Boolean).join(' · '), { date, source }));
    facts.push(fact('menu.price', label, row.price, 'KRW', money(row.price), { source }));
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
    if (row.contribution !== null) facts.push(fact('margin.menu.contribution', label, row.contribution, 'KRW', money(row.contribution), { ...range, source }));
  }
  for (const point of model.trend) {
    if (point.rate !== null) facts.push(fact('margin.rate.daily', tr.format.date(point.date, 'short'), point.rate, 'percent', percentage(point.rate), { date: point.date, source }));
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
  }
  return { title: label, target: label, fields };
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
        if ((name === undefined || name.trim() === menuLabel(tr, before)) && (category === undefined || category === before.category)
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

type NamedRead = { readonly name: string; readonly aspect: 'price' | 'memo' | 'sold' | 'cost' | 'status' };
function readNamedQuery(text: string): NamedRead | undefined {
  const clean = text.replace(/[.?!。？！]+$/u, '');
  const patterns = [
    [/^(.+?)\s*메모(?:에|는|가)?\s*(?:뭐라고|뭐가|뭐야|알려|보여|있어|읽어|$)/u, 'memo'],
    [/^(.+?)\s*(?:오늘\s*(?:판매량|몇\s*(?:잔|개)\s*(?:팔렸|나갔|팔았))|몇\s*(?:잔|개)\s*(?:팔렸|나갔|팔았))/u, 'sold'],
    [/^(.+?)\s*원가(?:가|는)?\s*(?:얼마|알려|보여)/u, 'cost'],
    [/^(.+?)\s*(?:지금\s*)?(?:팔아|판매해|팔고 있|품절이야)/u, 'status'],
    [/^(.+?)\s*(?:얼마야|가격\s*(?:알려\s*(?:줘|주세요))?)$/u, 'price'],
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
const editTurn = (command: MenuEdit['type'], name: string, args: AgentWireArgs = {}, slots: LocalSlots = {}): DomainRoute => ({
  intent: { kind: 'command', command, querySlot: 'name', args },
  slots: { name, ...slots },
  lookups: [
    { kind: 'menu', querySlot: 'name', bind: ['menuId'], ...(command === 'menu.setRecipe' ? { readingBind: ['menuId'] } : {}) },
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
  const bare = /([+-]?(?:\d[\d,]*(?:\.\d+)?)(?:\s*[천만])?)\s*(?:원|won|韩元|韓元|으로|로|쯤|까지|ㄱ|$)/iu.exec(text);
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
  const absent = (): DomainRoute => ({ kind: 'refusal', reason: 'invalid_target', answer: t(menuKey('menuNotFound')) });
  const menuMention = /메뉴|판매가|\bmenu\b|菜单|菜單/iu.test(unquoted);
  const commandVerb = /(?:바[꿔꽈]|고쳐|남겨|올[려리]|내[려리]|낮춰|줄여|늘려|변경|수정|지워|삭제|없애|빼|인상|인하|더\s*받|판매\s*중단|해\s*(?:줘|주|부러)|으로\s*ㄱ)|\b(?:set|change|update|make|mark|raise|lower|remove|delete|up|down)\b|(?:改成|改為|改为|设为|設為)/iu;
  const negation = /(?:하지|바꾸지|올리지|지우지|변경하지)\s*마|\b(?:do not|don't|never)\b|不要|别|別/iu;
  if (negation.test(unquoted)) return undefined;
  if ((menuMention || row) && /지워|삭제|없애|\bdelete\b|删除|刪除/iu.test(unquoted) &&
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
  const asksMargin = /마진|\bmargin\b|毛利/iu.test(unquoted);
  if (asksMargin && /(?:하면|이면|되면|올리면|받으면|어떻게|how)/iu.test(unquoted) && (actualName || menuMention)) {
    if (!actualName) return clarify('name', 'chooseMenu');
    let amount = menuAmount(unquoted);
    const isCost = /원가|\bcost\b|成本/iu.test(unquoted);
    if (amount === undefined) return clarify(isCost ? 'cost' : 'price', isCost ? 'menuCostQuestion' : 'priceQuestion');
    if ((!isCost && !isMenuPrice(amount)) || amount < 0 || !Number.isSafeInteger(amount)) return clarify('price', 'priceInvalid');
    if (!isCost && row && /원\s*(?:올리면|내리면)/u.test(unquoted)) amount = row.price + (/내리면/u.test(unquoted) ? -amount : amount);
    const field = isCost ? 'cost' : 'price';
    return {
      intent: { kind: 'read', tool: 'simulate_menu_price' },
      slots: { name: actualName, [field]: amount },
      lookups: [{ kind: 'menu', querySlot: 'name', bind: ['menu'] }],
      reading: { tool: 'simulate_menu_price', args: { menu: unbound, [field]: ref(field) } },
    };
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
  if (/(?:제일|가장)\s*(?:많이|잘)\s*(?:팔렸|나간|나가)|오늘\s*베스트\s*메뉴|베스트셀러\s*메뉴/u.test(unquoted)) return readMenuTurn('menu', ['menu.soldQty.top']);
  if (/(?:메뉴판|전체\s*메뉴).*가격|메뉴\s*가격(?:표|.*(?:쭉|전부|모두|목록))/u.test(unquoted)) return readMenuTurn('menu', ['menu.price']);
  if (/(?:디저트|빵\s*종류).*(?:뭐|알려|있어)/u.test(unquoted)) return readMenuTurn('menu', ['menu.dessert.price']);
  const edit = commandVerb.test(unquoted) || /품절(?:로)?(?:\s*[.!?]?$)|다시\s*판매/u.test(unquoted);
  if (row && !edit && /레시피|얼마나\s*들어/u.test(unquoted)) {
    return { intent: { kind: 'read', tool: 'get_recipe' }, slots: { name: actualName },
      lookups: [{ kind: 'menu', querySlot: 'name', bind: ['menuId'] }], reading: { tool: 'get_recipe', args: { menuId: unbound } } };
  }
  if (!edit) {
    const query = readNamedQuery(clean);
    if (!query || query.aspect === 'cost' || !row && !menuReader.search({ snapshot, locale, query: clean, privateLookup: false }).length) return undefined;
    return { intent: { kind: 'read', recordKind: 'menu', querySlot: 'name' }, slots: { name: clean } };
  }
  if (/사진|\bphoto\b/iu.test(unquoted) && (row || menuMention)) {
    return { kind: 'refusal', reason: 'widget_only', alternative: {
      featureId: 'menu', command: 'menu.setPhoto', draft: row ? { menuId: row.menuId } : {},
    } };
  }
  const recipeEdit = /레시피/u.test(unquoted) ||
    !/재고|발주|입고|보충/u.test(unquoted) && /(?:우유|원두|시럽|컵).*?(?:줄여|늘려|넣어|빼|바꿔)/u.test(unquoted);
  if (recipeEdit) {
    if (!row || !actualName) return menuMention || /레시피|라[테떼]/u.test(unquoted) ? clarify('name', 'chooseMenu') : undefined;
    const lines = row.recipeLines.map(({ recipeLineId, itemId, quantity, unit }) => ({ recipeLineId, itemId, quantity, unit }));
    const phrase = normalizeNavisName(unquoted);
    const ingredients = snapshot.tables.inventoryItem.filter(item => item.kind === 'ingredient' && !item.deletedAt).map(item => ({
      item, terms: menuLabel(tr, item).split(/[\s·]+/u).map(normalizeNavisName).filter(term => term.length >= 2 || term === '컵'),
    }));
    const existing = ingredients.filter(({ item, terms }) => lines.some(line => line.itemId === item.itemId) && terms.some(term => phrase.includes(term)));
    const options = existing.length ? existing : ingredients.filter(({ terms }) => terms.some(term => phrase.includes(term)));
    const ranked = options.map(entry => ({ ...entry, length: Math.max(...entry.terms.filter(term => phrase.includes(term)).map(term => term.length)) })).sort((a, b) => b.length - a.length);
    const ingredient = ranked[0];
    if (!ingredient || ranked[1]?.length === ingredient.length) return clarify('itemId', 'menuIngredientQuestion');
    const itemId = ingredient.item.itemId;
    const stated = unquoted.replace(/(?<=\d)\s*(?:미리|밀리)(?!리터)/gu, ' mL');
    const quantity = parseNavisQuantity(stated);
    const trailing = /(?:^|\s)(\d+(?:\.\d+)?)\s*(?:으로|로)?$/u.exec(stated)?.[1];
    const priorLine = lines.find(line => line.itemId === itemId);
    const amount = quantity?.value ?? (trailing && priorLine ? parseNavisNumber(trailing) : undefined);
    const specifiedUnit = quantity?.unit ?? priorLine?.unit;
    if (/빼|삭제|지워/u.test(unquoted)) {
      if (!lines.some(line => line.itemId === itemId)) return answer('unchanged');
      return editTurn('menu.setRecipe', actualName, { lines: ref('lines') }, { lines: lines.filter(line => line.itemId !== itemId) });
    }
    if (amount === undefined || !specifiedUnit || !['pcs', 'g', 'kg', 'mL', 'L'].includes(specifiedUnit)) return clarify('quantity', 'menuQuantityQuestion');
    const unit = specifiedUnit as BaseUnit;
    if (unitDimension(unit) !== unitDimension(ingredient.item.unit) || amount <= 0) {
      return { kind: 'refusal', reason: 'invalid_target', answer: t(menuKey('menuUnitMismatch')) };
    }
    const updated = lines.some(line => line.itemId === itemId)
      ? lines.map(line => line.itemId === itemId ? { ...line, quantity: amount, unit } : line)
      : [...lines, { itemId, quantity: amount, unit }];
    return editTurn('menu.setRecipe', actualName, { lines: ref('lines') }, { lines: updated });
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
    || !!actualName && menuAmount(unquoted) !== undefined && !/메모|분류|이름|품절/u.test(unquoted);
  const otherEdit = /품절|다시\s*판매|판매\s*중단|sold out|售罄|메모|이름|분류|메뉴.*(?:지워|삭제)/iu.test(unquoted);
  if (!priceChange && !otherEdit) return undefined;
  const inferred = /^(.+?)\s*(?:메뉴\s*)?(?:가격|판매가|가걱|값|품절|이름|분류|메모|다시\s*판매|\d)/u.exec(unquoted)?.[1].trim();
  const name = actualName ?? inferred;
  if (!name && /^(?:가격|판매가)\s*(?:올려|내려|바꿔|변경)/u.test(unquoted)) {
    return clarify('name', 'chooseMenu', value => menuRoute(`${value} ${clean}`, snapshot, locale));
  }
  if (!name || /^(?:그거|이거|아니|방금|아까|똑같이|가격|응)(?:\s|$)/u.test(name)) return undefined;
  const candidates = menuReader.search({ snapshot, locale, query: name, privateLookup: false }).filter(item => item.fields?.kind === 'menu');
  if (!row && !candidates.length) return menuMention || /품절|다시\s*판매/u.test(unquoted) ? absent() : undefined;
  if (/품절|sold out|售罄/iu.test(unquoted) || /다시\s*판매|판매\s*중단/u.test(unquoted)) {
    const status = /다시\s*판매/u.test(unquoted) ? 'selling' : 'sold_out';
    if (row?.saleStatus === status) return { kind: 'answer', answer: `${t(menuKey('unchanged'))} ${t(menuKey(status))}` };
    return editTurn('menu.setSaleStatus', name, { status });
  }
  if (/메뉴.*(?:지워|삭제)/u.test(unquoted)) return editTurn('menu.delete', name);
  if (/메모/u.test(unquoted)) {
    const memo = [...clean.matchAll(quote)][0]?.[1] ?? /메모.*?[:：]\s*(.+)$/u.exec(clean)?.[1]?.trim();
    if (/지워|삭제|비워|없애/u.test(unquoted)) return row && !row.memo ? answer('menuNoMemo') : editTurn('menu.update', name, { patch: { memo: null } });
    return memo ? editTurn('menu.update', name, { patch: { memo: ref('memo') } }, { memo }) : clarify('memo', 'menuMemoQuestion');
  }
  if (/이름/u.test(unquoted)) {
    const newName = [...clean.matchAll(quote)][0]?.[1] ?? /이름(?:을|은)?\s*(.+?)(?:으?로)\s*(?:바꿔|변경|해)/u.exec(clean)?.[1]?.trim();
    if (!newName) return clarify('name', 'nameQuestion');
    if (row && normalizeNavisName(newName) === normalizeNavisName(name)) return answer('unchanged');
    return editTurn('menu.update', name, { patch: { name: ref('newName') } }, { newName });
  }
  if (/분류/u.test(unquoted)) {
    const category = /음료|drink/iu.test(unquoted) ? 'drink' : /디저트|dessert/iu.test(unquoted) ? 'dessert' : undefined;
    return category ? editTurn('menu.update', name, { patch: { category } }) : clarify('category', 'categoryQuestion');
  }
  const changePrice = (price: number): DomainRoute => row?.price === price
    ? { kind: 'answer', answer: `${t(menuKey('unchanged'))} ${tr.format.money(price, 'full')}` }
    : editTurn('menu.update', name, { patch: { price: ref('price') } }, { price });
  const askPrice = (label: string, supplied?: number): Extract<DomainRoute, { kind: 'clarification' }> => {
    const reply = clarify('price', label, value => {
      const price = menuAmount(value) ?? parseNavisMoney(value);
      return isMenuPrice(price) ? changePrice(price) : askPrice('priceInvalid');
    });
    const current = supplied ?? row?.price;
    return current !== undefined
      ? { ...reply, answer: `${tr.format.money(current, 'full')} · ${reply.answer}` } : reply;
  };
  if (/사이|범위|정도|쯤|\baround\b/iu.test(unquoted)) return askPrice('menuExactPrice', menuAmount(unquoted));
  if (navisMoneySpans(unquoted).length > 1 && !/\b(?:actually|instead)\b|아니|말고|정정/iu.test(unquoted)) return askPrice('menuExactPrice');
  const percentText = /([\d.]+|[일이삼사오육칠팔구십]+)\s*(?:%|퍼센트|프로)/u.exec(unquoted)?.[1];
  const percent = percentText && parseNavisNumber(percentText);
  if (typeof percent === 'number') {
    if (!row) return clarify('name', 'chooseMenu');
    const delta = row.price * percent / 100;
    const next = row.price + (/내려|낮춰|인하|lower|\bdown\b/iu.test(unquoted) ? -delta : delta);
    if (!isMenuPrice(next)) return askPrice('menuExactPrice');
    if (next % 100 !== 0) {
      const reply = askPrice('menuExactPrice', next);
      return { ...reply, answer: `${reply.answer} · ${tr.format.money(Math.round(next / 100) * 100, 'full')}` };
    }
    return changePrice(next);
  }
  let price = menuAmount(unquoted);
  if (price === undefined) return askPrice('priceQuestion');
  if (row && /올려|내려|낮춰|인상|인하|더\s*받|\b(?:raise|lower|up|down)\b/iu.test(unquoted)
    && !/(?:원\s*(?:으로|에|까지)|\bto\s*[\d,])/iu.test(unquoted)) {
    price = row.price + (/내려|낮춰|인하|lower|\bdown\b/iu.test(unquoted) ? -price : price);
  }
  return isMenuPrice(price) ? changePrice(price) : askPrice('priceInvalid');
}

export const menuDomain = { commands: [menuCommandAdapter], reads: [menuReader] } satisfies DomainAdapter;

export const menuAgentDomain = {
  ...menuDomain,
  featureIds: ['menu', 'margin'],
  commands: [...menuDomain.commands, ...AGENT_MENU_EDIT_COMMANDS.map(menuEditAdapter)],
  tools: [getRecipe, simulatePrice],
  projectWidget: projectMenuWidget,
  route: menuRoute,
  navigation: menuNavigation,
  handoff(command, draft) {
    if (command !== 'menu.setPhoto') return undefined;
    return { featureId: 'menu', view: 'options', focus: 'action', ...(typeof draft.menuId === 'string' ? { itemId: draft.menuId } : {}) };
  },
} satisfies DomainAdapter;
