import type { DetailRef, FeatureId, Locale, QueryCondition } from '../../../contracts';
import { handlers } from '../../../data/commands/handlers';
import type { DataCommand } from '../../../data/commands/types';
import { fromBase, toBase, unitDimension } from '../../../data/derive/common';
import { addDays, TODAY } from '../../../data/db/time';
import type { Channel, DataSnapshot, InventoryItem, UnitCode } from '../../../data/db/types';
import { deriveOpenOrders, readModel, resolveDataText, selectStockHistory } from '../../../data/widget-data';
import type { InventoryModel } from '../../../data/widget-data';
import { createTranslator } from '../../../i18n';
import { mgmtSupplyBundle } from '../../widgets/mgmt-supply/messages';
import { validateAgentCommandArgs, validateAgentPrefill, type AgentFact, type AgentMissingStatus, type AgentRecordMatch, type AgentWireArgs } from '../../../../shared/navis-agent-schema.mjs';
import { navisTranslator } from '../messages';
import { normalizeNavisInput, normalizeNavisName, parseNavisDate, parseNavisNumber, parseNavisPeriod, parseNavisQuantity } from '../navis-input';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainRoute, DomainTurnInput, LocalSlots, RecordAdapter } from './registry';

const featureId = 'inventory-booking' as const;
type InventoryCommand = Extract<DataCommand, { type: `inventory.${string}` }>;
type InventoryCommandName = InventoryCommand['type'];
export type InventoryItemPrefill = Partial<Pick<Extract<InventoryCommand, { type: 'inventory.createItem' }>, 'sku' | 'name' | 'unit' | 'stock' | 'threshold' | 'trackRestock'>>;
const unitCodes = ['pcs', 'kg', 'g', 'L', 'mL'] as const;
const isUnit = (unit: unknown): unit is typeof unitCodes[number] => unitCodes.some(candidate => candidate === unit);
const isText = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 120;
const isQuantity = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isFlag = (value: unknown): value is boolean => typeof value === 'boolean';
const isChannel = (value: unknown): value is Channel => value === 'store' || value === 'online';
const isLocale = (value: unknown): value is Locale => value === 'ko' || value === 'en' || value === 'zh-Hans' || value === 'zh-Hant';

const copy = {
  ko: {
    sku: '코드(SKU)', name: '이름', unit: '단위', stock: '현재 재고', threshold: '안전 재고', trackRestock: '보충 알림',
    trackExpiry: '당일 소진', on: '사용', off: '사용 안 함', history: '재고 변동 기록', opening: '시작 재고', daysLeft: '오늘 사용량 기준 남은 일수',
    usage: '사용량', received: '입고량', ending: '남은 재고', week: '최근 7일', unavailable: '확인할 재고 기록이 없어요',
    itemMissing: '등록된 품목이 없어요', stockQuestion: '현재 재고를 얼마나 기록할까요?', thresholdQuestion: '안전 재고를 얼마로 설정할까요?',
    qtyQuestion: '몇 개를 옮길까요?', skuQuestion: '품목 코드(SKU)를 무엇으로 할까요?', unitQuestion: '어떤 단위를 사용할까요?',
    unitMismatch: '품목의 단위를 확인해 주세요', packQuestion: '한 박스에 몇 개가 들어 있나요?', targetQuestion: '어느 품목을 말하는지 확인해 주세요',
    methodQuestion: '입고를 기록할까요, 현재 재고를 입력할까요?', directionQuestion: '어느 채널에서 어느 채널로 옮길까요?',
    referenced: '메뉴 레시피나 발주에 쓰는 품목이라 지울 수 없어요', retailOnly: '판매 상품만 채널 사이에서 옮길 수 있어요',
    ingredientOnly: '원자재 탭에서 관리하는 품목만 직접 고칠 수 있어요', unchanged: '이미 같은 값이에요', onShelf: '등록됨', deleted: '삭제됨',
  },
  en: {
    sku: 'SKU', name: 'Name', unit: 'Unit', stock: 'Current stock', threshold: 'Safety stock', trackRestock: 'Restock alerts',
    trackExpiry: 'Use today', on: 'On', off: 'Off', history: 'Stock history', opening: 'Opening stock', daysLeft: 'Days left at today’s usage',
    usage: 'Usage', received: 'Received', ending: 'Remaining stock', week: 'Last 7 days', unavailable: 'No stock history is available',
    itemMissing: 'No matching item', stockQuestion: 'How much current stock should I record?', thresholdQuestion: 'What safety stock should I use?',
    qtyQuestion: 'How many should I move?', skuQuestion: 'What SKU should I use?', unitQuestion: 'Which unit should I use?',
    unitMismatch: 'Check the unit for this item', packQuestion: 'How many units are in a box?', targetQuestion: 'Which item do you mean?',
    methodQuestion: 'Should I record a delivery or set the current stock?', directionQuestion: 'Which channels should I move the stock between?',
    referenced: 'This item is used in a recipe or purchase order and cannot be deleted', retailOnly: 'Only retail products can move between channels',
    ingredientOnly: 'Only items managed in the materials tab can be edited directly', unchanged: 'It already has that value', onShelf: 'Registered', deleted: 'Deleted',
  },
  'zh-Hans': {
    sku: '商品编码 (SKU)', name: '名称', unit: '单位', stock: '当前库存', threshold: '安全库存', trackRestock: '补货提醒',
    trackExpiry: '当日用完', on: '开启', off: '关闭', history: '库存变动记录', opening: '期初库存', daysLeft: '按今日用量计算的剩余天数',
    usage: '用量', received: '入库量', ending: '剩余库存', week: '最近 7 天', unavailable: '没有可查看的库存记录',
    itemMissing: '未找到已登记的品项', stockQuestion: '要记录多少当前库存？', thresholdQuestion: '安全库存设为多少？',
    qtyQuestion: '要移动多少件？', skuQuestion: '要使用哪个商品编码？', unitQuestion: '要使用哪个单位？',
    unitMismatch: '请确认此品项的单位', packQuestion: '一箱有多少件？', targetQuestion: '请确认是哪个品项',
    methodQuestion: '要记录入库，还是填写当前库存？', directionQuestion: '要从哪个渠道移到哪个渠道？',
    referenced: '配方或采购订单正在使用此品项，无法删除', retailOnly: '只有在售商品可以在渠道间移动',
    ingredientOnly: '仅可直接编辑原材料中的品项', unchanged: '已经是这个数值', onShelf: '已登记', deleted: '已删除',
  },
  'zh-Hant': {
    sku: '商品編碼 (SKU)', name: '名稱', unit: '單位', stock: '目前庫存', threshold: '安全庫存', trackRestock: '補貨提醒',
    trackExpiry: '當日用完', on: '開啟', off: '關閉', history: '庫存變動記錄', opening: '期初庫存', daysLeft: '按今日用量計算的剩餘天數',
    usage: '用量', received: '入庫量', ending: '剩餘庫存', week: '最近 7 天', unavailable: '沒有可查看的庫存記錄',
    itemMissing: '未找到已登記的品項', stockQuestion: '要記錄多少目前庫存？', thresholdQuestion: '安全庫存設為多少？',
    qtyQuestion: '要移動多少件？', skuQuestion: '要使用哪個商品編碼？', unitQuestion: '要使用哪個單位？',
    unitMismatch: '請確認此品項的單位', packQuestion: '一箱有多少件？', targetQuestion: '請確認是哪個品項',
    methodQuestion: '要記錄入庫，還是填寫目前庫存？', directionQuestion: '要從哪個渠道移到哪個渠道？',
    referenced: '配方或採購訂單正在使用此品項，無法刪除', retailOnly: '只有在售商品可以在渠道間移動',
    ingredientOnly: '僅可直接編輯原材料分頁中的品項', unchanged: '已經是這個數值', onShelf: '已登記', deleted: '已刪除',
  },
} as const;

export const inventoryCopy = copy;
const itemLabel = (item: Pick<InventoryItem, 'name' | 'nameKey'>, locale: Locale) => resolveDataText(navisTranslator(locale).t, item.name ?? { key: item.nameKey });
const supplyTranslator = (locale: Locale) => createTranslator(locale, mgmtSupplyBundle);
const channelLabel = (channel: Channel, locale: Locale) => supplyTranslator(locale).t(`widget.inventory-booking.channel.${channel}`);
const liveItems = (snapshot: DataSnapshot) => snapshot.tables.inventoryItem.filter(item => !item.deletedAt);
const stockHandle = (snapshot: DataSnapshot, index: number) => `stock-${snapshot.revision}-${index}`;
const stockItems = (snapshot: DataSnapshot) => snapshot.tables.inventoryItem;
function channelBalance(snapshot: DataSnapshot, itemId: string, channel: Channel) {
  const balance = snapshot.tables.inventoryStock.find(row => row.itemId === itemId && row.channel === channel)?.qty;
  return typeof balance === 'number' && Number.isSafeInteger(balance) && balance >= 0 ? balance : undefined;
}

function referencesItem(snapshot: DataSnapshot, itemId: string) {
  return snapshot.tables.recipeLine.some(line => line.itemId === itemId)
    || snapshot.tables.menuItem.some(menu => menu.optionGroups?.some(group => group.options.some(option => option.extraRecipe.some(line => line.itemId === itemId))))
    || deriveOpenOrders(snapshot, { date: TODAY }).open.some(order => order.lines.some(line => line.itemId === itemId && line.remaining > 0));
}

function stockMatches(snapshot: DataSnapshot, query: string, locale: Locale) {
  const key = normalizeNavisName(query);
  if (!key) return [];
  return stockItems(snapshot).flatMap((item, index) => {
    const sku = item.sku && normalizeNavisName(item.sku) === key;
    if (item.deletedAt && !sku) return [];
    const labels = [itemLabel(item, locale), itemLabel(item, 'ko')];
    const match = sku || labels.some(label => normalizeNavisName(label) === key) ? 'exact' as const
      : labels.some(label => key.length > 1 ? normalizeNavisName(label).includes(key)
          : label.split(/[^\p{L}\p{N}]+/u).some(word => normalizeNavisName(word) === key)) ? 'similar' as const : undefined;
    return match ? [{ item, handle: stockHandle(snapshot, index), match }] : [];
  });
}

function narrowStockMatches(snapshot: DataSnapshot, query: string, locale: Locale, operation?: 'move' | 'ingredient') {
  let matches = stockMatches(snapshot, query, locale);
  if (operation === 'move' && matches.some(result => result.item.kind === 'retail')) {
    matches = matches.filter(result => result.item.kind === 'retail');
  }
  if (operation === 'ingredient' && matches.some(result => result.item.kind === 'ingredient')) {
    matches = matches.filter(result => result.item.kind === 'ingredient');
  }
  const exact = matches.filter(result => result.match === 'exact');
  return exact.length ? exact : matches.length === 1 ? [{ ...matches[0], match: 'exact' as const }] : matches;
}

const stockReader: RecordAdapter = {
  kind: 'stock',
  search({ snapshot, query, locale, privateLookup }) {
    return narrowStockMatches(snapshot, query, locale).map(({ item, handle, match }): AgentRecordMatch => {
      const store = item.kind === 'retail' ? channelBalance(snapshot, item.itemId, 'store') : undefined;
      const online = item.kind === 'retail' ? channelBalance(snapshot, item.itemId, 'online') : undefined;
      const fields = { kind: item.kind, unit: item.unit, ...(item.sku ? { sku: item.sku } : {}),
        ...(privateLookup && item.kind === 'ingredient' ? { referenced: referencesItem(snapshot, item.itemId) } : {}),
        ...(store === undefined ? {} : { store }), ...(online === undefined ? {} : { online }) };
      return { handle, match, fields, ...(!privateLookup && !item.deletedAt ? { label: itemLabel(item, locale) } : {}) };
    });
  },
  resolve({ snapshot, query, locale }, handle) {
    const match = narrowStockMatches(snapshot, query, locale).find(result => result.handle === handle && !result.item.deletedAt);
    return match?.item.itemId;
  },
  describe(match) {
    return typeof match.fields?.sku === 'string' ? match.fields.sku : undefined;
  },
};

const quantityText = (value: number | null, unit: UnitCode, locale: Locale) =>
  value === null ? '—' : navisTranslator(locale).format.quantity(value, unit);

export function projectInventoryFacts(snapshot: DataSnapshot, feature: FeatureId, condition: QueryCondition, locale: Locale):
  { facts: readonly AgentFact[] } | { status: AgentMissingStatus } | undefined {
  if (feature !== featureId) return;
  const date = snapshot.pos?.businessDate ?? TODAY;
  const weekStart = addDays(date, -6);
  const week = condition.kind === 'dateRange' && condition.start === weekStart && condition.end === date;
  if (date !== TODAY || (condition.kind === 'snapshot' && condition.asOf !== date)
    || (condition.kind === 'dateRange' && !week && (condition.start !== date || condition.end !== date))) {
    return { status: 'unsupported_period' as const };
  }
  const model = readModel(snapshot, featureId);
  if (!model.ingredients.length && !model.products.items.length) return { status: 'missing' as const };
  const t = copy[locale], tr = navisTranslator(locale), supply = supplyTranslator(locale);
  const facts: AgentFact[] = [];
  const fact = (key: string, value: number | string, unit: UnitCode | 'day' | '', label: string, period: Pick<AgentFact, 'date' | 'start' | 'end'> = { date }) =>
    facts.push({ key, value, unit, label, display: typeof value === 'string' ? value : unit && unit !== 'day' ? tr.format.quantity(value, unit) : tr.format.number(value), ...period });
  if (week) {
    const period = { start: weekStart, end: date };
    for (const item of model.ingredients) {
      const name = itemLabel(item, locale);
      const days = selectStockHistory(snapshot, { itemId: item.itemId, period: 'last7days' }).dayGroups;
      for (const kind of ['receive', 'usage'] as const) {
        const movements = days.flatMap(day => day.rows.filter(row => row.kind === kind));
        if (movements.length) fact(`inventory.stockHistory.${item.itemId}.${kind}`, movements.reduce((sum, row) => sum + Math.abs(row.delta), 0), item.unit,
          `${name} · ${t.week} · ${kind === 'receive' ? t.received : t.usage}`, period);
      }
    }
    return facts.length ? { facts } : { status: 'missing' as const };
  }
  fact('inventory.restock.count', model.restockCount, 'item', supply.t('widget.inventory-booking.restockNeeded'));
  fact('inventory.outOfStock.count', model.outOfStockCount, 'item', supply.t('widget.inventory-booking.outBadge'));
  const products = model.products.items;
  for (const channel of ['store', 'online'] as const) {
    if (products.length && products.every(item => channelBalance(snapshot, item.itemId, channel) !== undefined)) {
      fact(`inventory.products.${channel}`, model.products.byChannel[channel], 'pcs', channelLabel(channel, locale));
    }
  }
  if (products.length && products.every(item => channelBalance(snapshot, item.itemId, 'store') !== undefined && channelBalance(snapshot, item.itemId, 'online') !== undefined)) {
    fact('inventory.products.total', model.products.total, 'pcs', supply.t('widget.inventory-booking.productsTotal'));
  }
  for (const item of model.ingredients) {
    const name = itemLabel(item, locale);
    if (item.sku) fact(`inventory.item.sku.${item.itemId}`, item.sku, '', `${name} · ${t.sku}`);
    const hasOpening = snapshot.tables.stockOpening.some(row => row.itemId === item.itemId && row.businessDate === date);
    const hasInitial = snapshot.tables.stockAdjustment.some(row => row.itemId === item.itemId && row.reason === 'initial' && row.at.startsWith(date));
    const hasBalance = hasOpening || hasInitial;
    if (hasBalance && item.stock !== null) fact(`inventory.stock.${item.itemId}`, item.stock, item.unit, `${name} · ${t.stock}`);
    if (item.threshold !== null) fact(`inventory.threshold.${item.itemId}`, item.threshold, item.unit, `${name} · ${t.threshold}`);
    if (item.usedToday > 0) fact(`inventory.usedToday.${item.itemId}`, item.usedToday, item.unit, `${name} · ${t.usage}`);
    fact(`inventory.item.tracking.${item.itemId}.restock`, item.trackRestock ? t.on : t.off, '', `${name} · ${t.trackRestock}`);
    fact(`inventory.item.tracking.${item.itemId}.expiry`, item.trackExpiry ? t.on : t.off, '', `${name} · ${t.trackExpiry}`);
    if (hasBalance && item.stock !== null && item.usedToday > 0) {
      fact(`inventory.daysLeft.${item.itemId}`, Math.floor(item.stock / item.usedToday), 'day', `${name} · ${t.daysLeft}`);
    }
    for (const menu of item.usingMenus) {
      const current = snapshot.tables.menuItem.find(row => row.menuId === menu.menuId && !row.deletedAt);
      if (current) fact(`inventory.usingMenus.${item.itemId}`, resolveDataText(tr.t, current.name ?? { key: current.nameKey }), '', name);
    }
    const group = selectStockHistory(snapshot, { itemId: item.itemId, period: 'today' }).dayGroups[0];
    if (hasOpening) fact(`inventory.stockHistory.${item.itemId}.opening`, group.opening, item.unit, `${name} · ${t.opening}`);
    for (const kind of ['receive', 'usage'] as const) {
      const movements = group.rows.filter(row => row.kind === kind);
      if (movements.length) fact(`inventory.stockHistory.${item.itemId}.${kind}`, movements.reduce((sum, row) => sum + Math.abs(row.delta), 0), item.unit, `${name} · ${kind === 'receive' ? t.received : t.usage}`);
    }
    if (hasBalance) fact(`inventory.stockHistory.${item.itemId}.ending`, group.endingDisplay, item.unit, `${name} · ${t.ending}`);
  }
  for (const item of model.products.items) {
    const record = snapshot.tables.inventoryItem.find(row => row.itemId === item.itemId);
    if (!record) continue;
    const name = itemLabel(record, locale);
    if (record.sku) fact(`inventory.item.sku.${item.itemId}`, record.sku, '', `${name} · ${t.sku}`);
    for (const channel of ['store', 'online'] as const) {
      const balance = channelBalance(snapshot, item.itemId, channel);
      if (balance === undefined) continue;
      const label = `${name} · ${channelLabel(channel, locale)}`;
      fact(`product.channelBalance.${item.itemId}.${channel}`, balance, item.unit, label);
      if (record.lowStockPerChannel !== null && item.lowChannels.includes(channel)) {
        fact(`product.channelLow.${item.itemId}.${channel}`, balance, item.unit, label);
      }
    }
  }
  return { facts };
}

export function inventoryDetailEntry(ref: DetailRef, model?: InventoryModel) {
  const tab = ref.view === 'products' ? 'products' as const : 'ingredients' as const;
  const register = tab === 'ingredients' && (ref.view === 'register' || ref.focus === 'action');
  const draft = ref.prefill;
  const fields = draft?.kind === 'widget-draft' && (draft.command === 'inventory.createItem' || draft.command === 'ui.openDetail') ? draft.fields : undefined;
  let prefill: InventoryItemPrefill | undefined;
  if (register && fields && validateAgentPrefill(featureId, fields)) {
    const { sku, name, unit, stock, threshold, trackRestock } = fields;
    const safeQuantity = (value: unknown) => isQuantity(value) && toBase(value, isUnit(unit) ? unit : 'pcs') !== null ? value : undefined;
    prefill = { sku: isText(sku) ? sku : undefined, name: isText(name) ? name : undefined,
      unit: isUnit(unit) ? unit : undefined, stock: safeQuantity(stock), threshold: safeQuantity(threshold),
      trackRestock: isFlag(trackRestock) ? trackRestock : undefined };
  }
  const itemId = tab === 'ingredients' && model?.ingredients.some(row => row.itemId === ref.itemId) ? ref.itemId : undefined;
  return { tab, register, itemId, prefill };
}

type InventoryDraft = { readonly command: InventoryCommand; readonly locale: Locale };

const inventorySlots = { sku: isText, name: isText, stock: isQuantity, threshold: isQuantity, qty: (value: unknown) => isQuantity(value) && Number.isSafeInteger(value) && value > 0 };

function resolveInventoryCommand(type: InventoryCommandName, wire: unknown, slots: LocalSlots, targets: Parameters<CommandAdapter['resolve']>[3]): InventoryDraft | undefined {
  if (!wire || typeof wire !== 'object') return;
  const args: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(wire)) {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && 'slot' in value && value.slot === field) {
      args[field] = slots[field];
    } else if (field === 'itemId' && value && typeof value === 'object' && 'handle' in value && typeof value.handle === 'string') {
      const target = targets.get(value.handle);
      if (target?.kind !== 'stock') return;
      args.itemId = target.id;
    } else if (field === 'unit' && isUnit(value) || (field === 'from' || field === 'to') && isChannel(value)
      || (field === 'trackRestock' || field === 'trackExpiry') && isFlag(value)) args[field] = value;
    else return;
  }
  if (!validateAgentCommandArgs(type, args)) return;
  const command = { type, ...args } as InventoryCommand;
  return { command, locale: isLocale(slots.navisLocale) ? slots.navisLocale : 'ko' };
}

function inventoryPreview(command: InventoryCommand, snapshot: DataSnapshot, after: DataSnapshot, createdItemId: string | undefined, locale: Locale) {
  const itemId = command.type === 'inventory.createItem' ? createdItemId : command.itemId;
  const original = liveItems(snapshot).find(item => item.itemId === itemId);
  const changed = liveItems(after).find(item => item.itemId === itemId);
  const target = changed ?? original;
  if (!target) return;
  const tr = navisTranslator(locale), t = copy[locale], supply = supplyTranslator(locale);
  const before = readModel(snapshot, featureId), next = readModel(after, featureId);
  const fields: { label: string; before: string; after: string }[] = [];
  const add = (label: string, first: string, second: string) => {
    if (first !== second) fields.push({ label, before: first, after: second });
  };
  const amount = (value?: number | null) => quantityText(value ?? null, target.unit, locale);
  const a = before.ingredients.find(row => row.itemId === itemId), b = next.ingredients.find(row => row.itemId === itemId);
  if (command.type === 'inventory.moveChannel') {
    const a = before.products.items.find(row => row.itemId === itemId), b = next.products.items.find(row => row.itemId === itemId);
    if (!a || !b || a.total !== b.total || a[command.from] - command.qty !== b[command.from] || a[command.to] + command.qty !== b[command.to]) return;
    for (const channel of [command.from, command.to]) add(channelLabel(channel, locale), amount(a[channel]), amount(b[channel]));
  } else if (command.type === 'inventory.deleteItem') {
    add(t.name, t.onShelf, t.deleted);
  } else {
    if (command.type === 'inventory.createItem') {
      add(t.sku, '—', command.sku);
      add(t.unit, '—', command.unit);
    }
    add(t.name, a ? itemLabel(a, locale) : '—', b ? itemLabel(b, locale) : '—');
    add(t.stock, amount(command.type === 'inventory.updateItem' && command.stock === 0 && a && a.raw < 0 ? a.raw : a?.stock), amount(b?.stock));
    add(t.threshold, amount(a?.threshold), amount(b?.threshold));
    add(t.trackRestock, a ? (a.trackRestock ? t.on : t.off) : '—', b ? (b.trackRestock ? t.on : t.off) : '—');
    if (command.type === 'inventory.setTracking' && a && b) add(t.trackExpiry, a.trackExpiry ? t.on : t.off, b.trackExpiry ? t.on : t.off);
    const count = (n: number) => tr.format.count(n, 'item');
    add(supply.t('widget.inventory-booking.restockNeeded'), count(before.restockCount), count(next.restockCount));
    add(supply.t('widget.inventory-booking.outBadge'), count(before.outOfStockCount), count(next.outOfStockCount));
  }
  const name = itemLabel(target, locale);
  return { title: name, target: name, fields };
}

function commandAdapter(type: InventoryCommandName): CommandAdapter<InventoryCommand, InventoryDraft> {
  return {
    command: type, featureId, slots: inventorySlots,
    resolve: (wire, slots, _snapshot, targets) => resolveInventoryCommand(type, wire, slots, targets),
    preflight({ command, locale }, { snapshot, idempotencyKey }) {
      // Map the discriminated command to the same handlers used by the detail widget.
      let seq = snapshot.seq;
      const context = { snapshot, tables: snapshot.tables, nextId: (prefix: string) => `navis-${prefix}-${++seq}` };
      const dispatch = command.type === 'inventory.createItem' ? { ...command, idempotencyKey } : command;
      if (dispatch.type === 'inventory.moveChannel' && (channelBalance(snapshot, dispatch.itemId, dispatch.from) === undefined ||
        channelBalance(snapshot, dispatch.itemId, dispatch.to) === undefined)) return { kind: 'invalid', field: 'itemId' };
      let simulated;
      switch (dispatch.type) {
        case 'inventory.createItem': simulated = handlers[dispatch.type](context, dispatch); break;
        case 'inventory.updateItem': simulated = handlers[dispatch.type](context, dispatch); break;
        case 'inventory.moveChannel': simulated = handlers[dispatch.type](context, dispatch); break;
        case 'inventory.deleteItem': simulated = handlers[dispatch.type](context, dispatch); break;
        case 'inventory.setTracking': simulated = handlers[dispatch.type](context, dispatch); break;
      }
      if (!simulated.ok) return { kind: simulated.code === 'CONFLICT' ? 'conflict' : 'invalid', field: simulated.field, messageKey: simulated.messageKey };
      const value = simulated.value;
      const itemId = value && typeof value === 'object' && 'itemId' in value && typeof value.itemId === 'string' ? value.itemId : undefined;
      const preview = inventoryPreview(dispatch, snapshot, { ...snapshot, tables: simulated.tables }, itemId, locale);
      if (!preview) return { kind: 'invalid' };
      if (!preview.fields.length) return { kind: 'unchanged' };
      return { kind: 'ready', command: dispatch, preview, ...(dispatch.type === 'inventory.deleteItem' ? { tier: 'extra-confirm' as const } : {}) };
    },
    undoToken: result => result.undoToken,
  };
}

type LocalRoute = Exclude<DomainRoute, DomainTurnInput>;

const thresholdWords = /안전\s*재고|보충\s*기준|기준(?:\s*재고|은|을)?/u;
const rewriteWords = /바꿔|수정|맞춰|고쳐|설정|올려|낮춰|변경|해줘|놔줘/u;
const transferWords = /옮겨|옮기|이동|보내|(?:매장|온라인)\s*(?:→|->|으로|쪽|거)/u;
const removeWords = /삭제|지워|없애/u;
const stockWords = /재고|수량|품목|입고|입출고|안전재고/u;
const createWords = /추가|등록|넣어/u;
const readWords = /알려|남았|얼마|몇|보기|있나|있어\?|기록|내역|코드|sku|쓰는|만들어|못\s*팔아|변화|줄었|떨어져|버텨|쓸\s*수/iu;
const methodWords = /들어왔|입고됐|받았|왔네|더\s*(?:있어|넣어)|추가됐/u;
const packUnits = ['box', 'pack', 'tray'] as const;

function spokenQuantity(text: string) {
  const normalized = text.replace(/키로/gu, '킬로').replace(/(?:미리|밀리)(?!리터)/gu, '밀리리터');
  const parsed = parseNavisQuantity(normalized);
  if (parsed) return { ...parsed, value: (normalized.includes('마이너스') ? -1 : 1) * parsed.value + (/\s반(?:으?로|\s|$)/u.test(normalized) ? 0.5 : 0) };
  const candidates = normalized.match(/(?:^|\s)([+-]?[0-9][\d,.]*|[영공일이삼사오육칠팔구십백천만]+)(?=\s|으?로|$)/gu) ?? [];
  const value = candidates.length === 1 ? parseNavisNumber(candidates[0]) : undefined;
  return value === undefined ? undefined : { value, unit: undefined };
}

function inItemUnit(amount: NonNullable<ReturnType<typeof spokenQuantity>>, unit: UnitCode) {
  const source = amount.unit === 'sheet' && unit === 'pcs' ? 'pcs' : amount.unit ?? unit;
  if (unitDimension(source) !== unitDimension(unit)) return { field: 'unit' as const };
  const base = amount.value >= 0 ? toBase(amount.value, source) : null;
  return base === null ? { field: 'quantity' as const } : { value: fromBase(base, unit) };
}

function findMention(text: string, snapshot: DataSnapshot, locale: Locale, forMove: boolean) {
  const normalized = normalizeNavisName(text);
  const items = liveItems(snapshot);
  const named = items.flatMap(item => {
    const label = itemLabel(item, locale);
    if (label.length > 1 && normalized.includes(normalizeNavisName(label))) return [{ item, term: label }];
    if (item.sku && normalized.includes(normalizeNavisName(item.sku))) return [{ item, term: item.sku }];
    return [];
  }).sort((a, b) => b.term.length - a.term.length);
  if (named[0]) return { query: named[0].term, matches: [named[0].item], tail: text.slice(text.lastIndexOf(named[0].term) + named[0].term.length) };
  const aliases = items.flatMap(item => {
    const label = itemLabel(item, locale);
    return label.match(/\p{L}+/gu) ?? [];
  });
  const mentions = [...new Set(aliases)].flatMap(term => {
    const pattern = new RegExp(`(?:^|[\\s,.])${term}(?=\\s|[,.!?]|$|은|는|을|를|이|가|으로)`, 'gu');
    return [...text.matchAll(pattern)].map(match => ({ term, end: match.index + match[0].length }));
  }).sort((a, b) => b.term.length - a.term.length || b.end - a.end);
  const mention = mentions[0];
  if (!mention) return;
  const matches = narrowStockMatches(snapshot, mention.term, locale, forMove ? 'move' : undefined).map(match => match.item);
  const query = matches.length === 1 && forMove ? itemLabel(matches[0], locale) : mention.term;
  return { query, matches, tail: text.slice(mention.end) };
}

function inventoryCommandTurn(command: InventoryCommandName, snapshot: DataSnapshot, locale: Locale, values: LocalSlots, item?: InventoryItem, literals: AgentWireArgs = {}, query?: string): DomainTurnInput {
  const lookupQuery = item ? itemLabel(item, locale) : query;
  const querySlot = item && 'name' in values ? 'target' : 'name';
  const handle = item && stockHandle(snapshot, stockItems(snapshot).indexOf(item));
  const args = { ...literals, ...Object.fromEntries(Object.keys(values).map(field => [field, { slot: field }])),
    ...(handle ? { itemId: { handle } } : {}) };
  return { intent: { kind: 'command', command, args, ...(lookupQuery ? { querySlot } : {}) },
    slots: { ...values, ...(lookupQuery ? { [querySlot]: lookupQuery } : {}), navisLocale: locale },
    ...(lookupQuery ? { lookups: [{ kind: 'stock', querySlot, ...(item ? { bind: ['itemId'] } : {}) }] } : {}) };
}

export function inventoryNavigation(raw: string, snapshot: DataSnapshot, locale: Locale): DomainDetail | undefined {
  const text = normalizeNavisInput(raw);
  if (/하지\s*마|말아\s*줘|무시|ignore\s+|\b(?:don't|never|do not)\b|[“”"'‘’]/iu.test(text)) return;
  const form = /재고|품목|새\s*재료/u.test(text) && /추가|등록/u.test(text) && /화면|창|폼/u.test(text);
  if (form) return { args: { featureId, view: 'register', focus: 'action' } };
  const products = /판매\s*상품|상품\s*탭|온라인\s*재고/u.test(text) && /열어|화면|탭|보여/u.test(text);
  if (products && !/부족한|모자란/u.test(text)) return { args: { featureId, view: 'products' } };
  const requestedDate = parseNavisDate(text, TODAY);
  if (!/입고\s*내역\s*보여|(?:변동\s*기록|입출고).*(?:열어|화면)/u.test(text)
    || /일주일|7\s*일/u.test(text) || requestedDate && requestedDate !== TODAY) return;
  const matches = findMention(text, snapshot, locale, false)?.matches;
  if (matches?.length !== 1 || matches[0].kind !== 'ingredient') return;
  const [{ itemId }] = matches;
  return { args: { featureId, view: 'history', itemId }, target: { kind: 'stock', id: itemId } };
}

export function readInventoryTurn(raw: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const text = normalizeNavisInput(raw).replace(/원두\s*200\s*그램/gu, '원두 200g').replace(/원두200g/gu, '원두 200g');
  const t = copy[locale];
  const clarify = (field: string, answer: string, resume?: (value: string) => DomainRoute | undefined): LocalRoute =>
    ({ kind: 'clarification', field, answer, ...(resume ? { resume } : {}) });
  const refuse = (reason: 'unsupported' | 'invalid_target', answer: string): LocalRoute => ({ kind: 'refusal', reason, answer });
  const answer = (value: string): LocalRoute => ({ kind: 'answer', answer: value });
  const date = parseNavisDate(text, TODAY);
  const period = parseNavisPeriod(text, TODAY);
  const requested: QueryCondition = period ? { kind: 'dateRange', ...period } : { kind: 'snapshot', asOf: date ?? TODAY };
  const read = (keys: readonly string[], condition: QueryCondition = requested): DomainTurnInput => {
    const projection = projectInventoryFacts(snapshot, featureId, condition, locale);
    const factKeys = projection && 'facts' in projection
      ? projection.facts.filter(fact => keys.some(key => key.endsWith('.') ? fact.key.startsWith(key) : fact.key === key)).map(fact => fact.key) : [];
    return { intent: { kind: 'read', featureId, condition }, factKeys };
  };
  const lookup = (name: string): DomainTurnInput =>
    ({ intent: { kind: 'read', recordKind: 'stock', querySlot: 'name' }, slots: { name } });

  if (/하지\s*마|말아\s*줘|무시|ignore\s+|\b(?:don't|never|do not)\b|[“”"'‘’]/iu.test(text)) return;
  if (/레시피|라[테떼]에|메뉴에/u.test(text) && createWords.test(text)) return;
  if (inventoryNavigation(text, snapshot, locale)) return;
  const creating = (stockWords.test(text) || /재료에|\b[A-Z]{2,}-[A-Z0-9]+\b/u.test(text)) && createWords.test(text) && !methodWords.test(text);
  if (creating) {
    if (/(?:^|\s|재고)(?:위젯|패널|(?:대시)?보드)(?:을|를|에)?(?=\s|[.?!]|추가|등록|넣어|$)/u.test(text)) return;
    const sku = /\b[A-Z]{2,}[A-Z0-9]*-[A-Z0-9-]+\b/iu.exec(text)?.[0];
    const name = /^(?:재고(?:에|\s*품목)?\s+|재료에\s+)?([\p{L}][\p{L}\d-]{0,119})/u.exec(text)?.[1];
    if (!name || /^(?:품목|재고|새)$/u.test(name)) return;
    const declaredUnit = /단위\s*([\p{L}]+)/u.exec(text)?.[1];
    const unitValue = declaredUnit ?? /(?<![\p{L}\d])(?:mL|kg|L|g|pcs|리터|그램|킬로|개)(?![\p{L}])/iu.exec(text)?.[0];
    const unit = unitValue && parseNavisQuantity(`1${unitValue}`)?.unit;
    const stock = /재고\s+([\d.]+)/u.exec(text)?.[1] ?? (sku && new RegExp(`${sku}[^0-9]+([0-9.]+)`, 'iu').exec(text)?.[1]);
    const threshold = /기준\s*([\d.]+)/u.exec(text)?.[1];
    const off = /알림.*(?:없|필요\s*없|끔)|알림\s*없이/u.test(text);
    if (!isUnit(unit)) return clarify('unit', t.unitQuestion, value => readInventoryTurn(declaredUnit ? text.replace(`단위 ${declaredUnit}`, `단위 ${value}`) : `${text} 단위 ${value}`, snapshot, locale));
    if (!sku || stockItems(snapshot).some(item => item.sku?.toUpperCase() === sku.toUpperCase())) return clarify('sku', t.skuQuestion, value => readInventoryTurn(sku ? text.replace(sku, value) : `${text} 코드 ${value}`, snapshot, locale));
    if (narrowStockMatches(snapshot, name, locale, 'ingredient').length) return clarify('duplicate', t.targetQuestion);
    const initial = stock === undefined ? undefined : Number(stock);
    if (!isQuantity(initial) || toBase(initial, unit) === null) return clarify('stock', t.stockQuestion);
    const safe = threshold === undefined ? off ? 0 : undefined : Number(threshold);
    if (!isQuantity(safe) || toBase(safe, unit) === null) return clarify('threshold', t.thresholdQuestion);
    return inventoryCommandTurn('inventory.createItem', snapshot, locale, { sku, name, stock: initial, threshold: safe }, undefined, { unit, ...(off ? { trackRestock: false } : {}) }, name);
  }

  const moving = transferWords.test(text) && !/재고\s*(?:각각|알려)|부족한|몇\s*개\s*있어/u.test(text);
  const mention = findMention(text, snapshot, locale, moving);
  const item = mention?.matches.length === 1 ? mention.matches[0] : undefined;
  if (!item && mention && mention.matches.length > 1 && (moving || stockWords.test(text) || rewriteWords.test(text))) {
    return clarify('target', t.targetQuestion, value => {
      const match = narrowStockMatches(snapshot, value, locale);
      if (match.length !== 1 || !mention.matches.some(candidate => candidate.itemId === match[0].item.itemId)) return undefined;
      return readInventoryTurn(text.replace(mention.query, itemLabel(match[0].item, locale)), snapshot, locale);
    });
  }
  if (!item) {
    if (/부족한|모자란/u.test(text) && /온라인|채널|판매\s*상품/u.test(text)) return read(['product.channelLow.']);
    if (/^(?:재고|품절|보충)/u.test(text) && /부족|보충|품절|어때/u.test(text) && !rewriteWords.test(text)) {
      return read(['inventory.restock.count', 'inventory.outOfStock.count']);
    }
    const query = /^([\p{L}\d -]+?)\s+재고(?=\s|[?？]|$)(.*)$/u.exec(text);
    if (query && (readWords.test(query[2]) || /[?？]/u.test(query[2])) && !rewriteWords.test(text)
      && !/매출|발주|쿠폰|예약|위젯|마진|레시피|최근|어제|지난/u.test(text)) return lookup(query[1]);
    if (stockWords.test(text) && readWords.test(text) && !rewriteWords.test(text) && !/^재고|(?:매출|발주|쿠폰|예약|위젯|마진|레시피)/u.test(text)) return answer(t.itemMissing);
    return;
  }
  const tail = mention?.tail.trim() ?? text;
  const isHistory = /입출고|입고.*내역|재고.*변동|어떻게\s*줄|재고.*변화|들어오고\s*나갔|사용\s*내역/u.test(text);
  if (isHistory) {
    const week = /일주일|7\s*일/u.test(text);
    return read([`inventory.stockHistory.${item.itemId}.`], week ? { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY } : undefined);
  }
  if (/코드|\bsku\b/iu.test(text)) return lookup(itemLabel(item, locale));
  if (/쓰는\s*메뉴|못\s*(?:팔|만들)/u.test(tail) && !rewriteWords.test(tail)) return read([`inventory.usingMenus.${item.itemId}`]);
  if (/언제\s*떨어|며칠|하루\s*버텨/u.test(text)) return read([`inventory.stock.${item.itemId}`, `inventory.daysLeft.${item.itemId}`]);
  if (/사용량|얼마나\s*썼/u.test(tail)) return;
  if (moving || removeWords.test(text)) {
    if (moving) {
      if (item.kind !== 'retail' || item.unit !== 'pcs') return refuse('unsupported', t.retailOnly);
      const destination = /(?:→|->)\s*(온라인|매장)|(?:온라인|매장)(?=\s*(?:으로|쪽))/u.exec(text)?.[0];
      const source = /(온라인|매장)(?=\s*(?:에서|거|→|->))/u.exec(text)?.[1];
      const to = destination?.includes('온라인') ? 'online' : destination?.includes('매장') ? 'store' : undefined;
      const from = source === '온라인' ? 'online' : source === '매장' ? 'store' : to === 'online' ? 'store' : 'online';
      const qty = spokenQuantity(tail);
      if (!qty || qty.unit !== 'pcs' || !Number.isSafeInteger(qty.value) || qty.value <= 0) return clarify('qty', t.qtyQuestion);
      if (!to || from === to) return clarify('direction', t.directionQuestion);
      const available = channelBalance(snapshot, item.itemId, from), destinationBalance = channelBalance(snapshot, item.itemId, to);
      if (available === undefined || destinationBalance === undefined) return refuse('invalid_target', t.unavailable);
      if (qty.value > available || !Number.isSafeInteger(destinationBalance + qty.value)) return clarify('qty', t.qtyQuestion);
      return inventoryCommandTurn('inventory.moveChannel', snapshot, locale, { qty: qty.value }, item, { from, to });
    }
    if (item.kind !== 'ingredient') return refuse('unsupported', t.ingredientOnly);
    if (referencesItem(snapshot, item.itemId)) return refuse('invalid_target', t.referenced);
    return inventoryCommandTurn('inventory.deleteItem', snapshot, locale, {}, item);
  }
  if (methodWords.test(text) && !rewriteWords.test(text)) return clarify('method', t.methodQuestion);
  const tracking = /알림|추적|당일\s*소진/u.test(tail) && /켜|꺼|끄|중지|해제|끄기/u.test(tail);
  if (tracking && item.kind === 'ingredient') {
    const enabled = /켜/u.test(tail);
    const field = /당일\s*소진/u.test(tail) ? 'trackExpiry' : 'trackRestock';
    return enabled === item[field] ? answer(t.unchanged)
      : inventoryCommandTurn('inventory.setTracking', snapshot, locale, {}, item, { [field]: enabled });
  }

  const thresholdMatch = thresholdWords.exec(tail);
  const rename = (/(?:품목\s*)?이름(?:을|은)?\s*([\p{L}\d ][\p{L}\d ]*?)\s*(?:으?로|변경)/u.exec(tail)?.[1]
    ?? /^(?:→|->)\s*([\p{L}\d ]+?)\s*이름\s*변경/u.exec(tail)?.[1])?.trim();
  const stockText = thresholdMatch ? tail.slice(0, thresholdMatch.index) : tail;
  const stock = spokenQuantity(stockText);
  const explicitUpdate = rename || (thresholdMatch || rewriteWords.test(text)) && !readWords.test(tail)
    || stock && stockWords.test(text) && !readWords.test(text);
  if (!explicitUpdate) {
    if (!readWords.test(text) && !stockWords.test(text)) return;
    return item.kind === 'retail' ? read([`product.channelBalance.${item.itemId}.`])
      : read([`inventory.stock.${item.itemId}`, ...(thresholdMatch ? [`inventory.threshold.${item.itemId}`] : [])]);
  }
  if (item.kind !== 'ingredient') return refuse('unsupported', t.ingredientOnly);
  const amounts = { stock, threshold: thresholdMatch ? spokenQuantity(tail.slice(thresholdMatch.index + thresholdMatch[0].length)) : undefined };
  const values: Record<string, string | number> = rename ? { name: rename } : {};
  for (const field of ['stock', 'threshold'] as const) {
    const amount = amounts[field];
    if (!amount) continue;
    if (amount.unit && packUnits.some(unit => unit === amount.unit)) return clarify('packSize', t.packQuestion);
    const converted = inItemUnit(amount, item.unit);
    if ('field' in converted) return converted.field === 'unit'
      ? clarify('unit', `${t.unitMismatch} (${item.unit})`)
      : clarify(field, field === 'stock' ? t.stockQuestion : t.thresholdQuestion);
    values[field] = converted.value;
  }
  const resumeAmount = (field: 'stock' | 'threshold') => (value: string) => {
    const quantity = spokenQuantity(value);
    const converted = quantity && inItemUnit(quantity, item.unit);
    if (!converted || 'field' in converted) return undefined;
    return inventoryCommandTurn('inventory.updateItem', snapshot, locale, { ...values, [field]: converted.value }, item);
  };
  if (!Object.keys(values).length && !thresholdMatch) return clarify('stock', t.stockQuestion, resumeAmount('stock'));
  if (thresholdMatch && values.threshold === undefined) return clarify('threshold', t.thresholdQuestion, resumeAmount('threshold'));
  const before = readModel(snapshot, featureId).ingredients.find(row => row.itemId === item.itemId);
  if (before && Object.entries(values).every(([field, value]) => field === 'name' ? value === itemLabel(item, locale) : field === 'stock' ? value === before.raw : value === before.threshold)) {
    return answer(t.unchanged);
  }
  if (values.name === itemLabel(item, locale)) delete values.name;
  return inventoryCommandTurn('inventory.updateItem', snapshot, locale, values, item);
}

export const inventoryDomain = {
  commands: (['inventory.createItem', 'inventory.updateItem', 'inventory.moveChannel', 'inventory.deleteItem', 'inventory.setTracking'] as const).map(commandAdapter),
  reads: [stockReader],
  route: readInventoryTurn,
  projectWidget: projectInventoryFacts,
  navigation: inventoryNavigation,
} satisfies DomainAdapter;
