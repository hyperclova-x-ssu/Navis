import type { DetailRef, FeatureId, Locale, QueryCondition } from '../../../contracts';
import { handlers } from '../../../data/commands/handlers';
import type { DataCommand } from '../../../data/commands/types';
import { fromBase, toBase, unitDimension } from '../../../data/derive/common';
import { addDays, TODAY } from '../../../data/db/time';
import type { Channel, DataSnapshot, InventoryItem, UnitCode } from '../../../data/db/types';
import { deriveOpenOrders, readModel, resolveDataText, selectStockHistory } from '../../../data/widget-data';
import type { InventoryModel } from '../../../data/widget-data';
import { realStock, stockDate } from '../../../data/reality/03/stock-projection';
import { baseQuantity, type StockItemDto } from '../../../data/reality/03/stock-dto';
import { createTranslator } from '../../../i18n';
import { mgmtSupplyBundle } from '../../widgets/mgmt-supply/messages';
import { validateAgentCommandArgs, validateAgentPrefill, type AgentFact, type AgentMissingStatus, type AgentRecordMatch, type AgentWireArgs } from '../../../../shared/navis-agent-schema.mjs';
import { navisTranslator } from '../messages';
import { normalizeNavisInput, normalizeNavisName, parseNavisDate, parseNavisNumber, parseNavisPeriod, parseNavisQuantity } from '../navis-input';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainRoute, DomainTurnInput, LocalSlots, RecordAdapter } from './registry';

const featureId = 'inventory-booking' as const;
type InventoryCommand = Extract<DataCommand, { type: 'inventory.createItem' | 'inventory.updateItem' | 'inventory.moveChannel' | 'inventory.deleteItem' | 'inventory.setTracking' }>;
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
    usage: '사용량', received: '입고량', ending: '남은 재고', week: '최근 7일', lowChannelCount: '재고가 부족한 판매 채널', daysLeftNone: '오늘 사용량이 없어 계산할 수 없어요', unavailable: '확인할 재고 기록이 없어요',
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
    usage: 'Usage', received: 'Received', ending: 'Remaining stock', week: 'Last 7 days', lowChannelCount: 'Retail channels below their threshold', daysLeftNone: 'No usage today, so it cannot be calculated', unavailable: 'No stock history is available',
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
    usage: '用量', received: '入库量', ending: '剩余库存', week: '最近 7 天', lowChannelCount: '库存不足的在售渠道', daysLeftNone: '今日没有用量，无法计算', unavailable: '没有可查看的库存记录',
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
    usage: '用量', received: '入庫量', ending: '剩餘庫存', week: '最近 7 天', lowChannelCount: '庫存不足的在售渠道', daysLeftNone: '今日沒有用量，無法計算', unavailable: '沒有可查看的庫存記錄',
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
const stockLabelText = (text: string) => text.replace(/(\d)\s*(?:그램|g(?![a-z]))/giu, '$1g');
function channelBalance(snapshot: DataSnapshot, itemId: string, channel: Channel) {
  const balance = snapshot.tables.inventoryStock.find(row => row.itemId === itemId && row.channel === channel)?.qty;
  return typeof balance === 'number' && Number.isSafeInteger(balance) && balance >= 0 ? balance : undefined;
}

function referencesItem(snapshot: DataSnapshot, itemId: string) {
  const server = realStock(snapshot)?.items.find(item => item.itemId === itemId);
  if (server) return server.referenced;
  return snapshot.tables.recipeLine.some(line => line.itemId === itemId)
    || snapshot.tables.menuItem.some(menu => menu.optionGroups?.some(group => group.options.some(option => option.extraRecipe.some(line => line.itemId === itemId))))
    || deriveOpenOrders(snapshot, { date: TODAY }).open.some(order => order.lines.some(line => line.itemId === itemId && line.remaining > 0));
}

function stockMatches(snapshot: DataSnapshot, query: string, locale: Locale) {
  const key = normalizeNavisName(stockLabelText(query));
  if (!key) return [];
  return stockItems(snapshot).flatMap((item, index) => {
    const sku = item.sku && normalizeNavisName(item.sku) === key;
    if (item.deletedAt && !sku) return [];
    const labels = [itemLabel(item, locale), itemLabel(item, 'ko')].map(stockLabelText);
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
      const server = realStock(snapshot)?.items.find(record => record.itemId === item.itemId);
      const unit = server ? server.unit : item.unit;
      const fields = { kind: item.kind, ...(unit ? { unit } : {}), ...(item.sku ? { sku: item.sku } : {}),
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
  const source = realStock(snapshot);
  const date = source?.businessDate ?? snapshot.pos?.businessDate ?? TODAY;
  const weekStart = addDays(date, -6);
  const week = condition.kind === 'dateRange' && condition.start === weekStart && condition.end === date;
  if ((!source && date !== TODAY) || (condition.kind === 'snapshot' && condition.asOf !== date)
    || (condition.kind === 'dateRange' && !week && (condition.start !== date || condition.end !== date))) {
    return { status: 'unsupported_period' as const };
  }
  const model = readModel(snapshot, featureId);
  if (!model.ingredients.length && !model.products.items.length) return { status: 'missing' as const };
  const t = copy[locale], tr = navisTranslator(locale), supply = supplyTranslator(locale);
  const facts: AgentFact[] = [];
  const fact = (key: string, value: number | string, unit: UnitCode | 'day' | 'item' | '', label: string, period: Pick<AgentFact, 'date' | 'start' | 'end'> = { date }) =>
    facts.push({ key, value, unit, label, display: typeof value === 'string' ? value : unit ? tr.format.quantity(value, unit) : tr.format.number(value), ...period });
  const movementQuantity = (rows: readonly { delta: number }[], item: InventoryModel['ingredients'][number], kind: 'receive' | 'usage') => {
    if (!source || kind === 'receive') return rows.reduce((sum, row) => sum + Math.abs(row.delta), 0);
    return fromBase(Math.max(0, -rows.reduce((sum, row) => sum + (toBase(row.delta, item.unit) ?? 0), 0)), item.unit);
  };
  if (week) {
    const period = { start: weekStart, end: date };
    for (const item of model.ingredients) {
      const name = itemLabel(item, locale);
      const days = selectStockHistory(snapshot, { itemId: item.itemId, period: 'last7days' }).dayGroups;
      for (const kind of ['receive', 'usage'] as const) {
        const movements = days.flatMap(day => day.rows.filter(row => row.kind === kind));
        if (movements.length) fact(`inventory.stockHistory.${item.itemId}.${kind}`, movementQuantity(movements, item, kind), item.unit,
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
    const hasBalance = source ? item.stock !== null : hasOpening || hasInitial;
    if (hasBalance && item.stock !== null) fact(`inventory.stock.${item.itemId}`, item.stock, item.unit, `${name} · ${t.stock}`);
    if (item.threshold !== null) fact(`inventory.threshold.${item.itemId}`, item.threshold, item.unit, `${name} · ${t.threshold}`);
    if (item.usedToday > 0) fact(`inventory.usedToday.${item.itemId}`, item.usedToday, item.unit, `${name} · ${t.usage}`);
    fact(`inventory.item.tracking.${item.itemId}.restock`, item.trackRestock ? t.on : t.off, '', `${name} · ${t.trackRestock}`);
    fact(`inventory.item.tracking.${item.itemId}.expiry`, item.trackExpiry ? t.on : t.off, '', `${name} · ${t.trackExpiry}`);
    if (hasBalance && item.stock !== null && item.usedToday > 0) {
      fact(`inventory.daysLeft.${item.itemId}`, Math.floor(item.stock / item.usedToday), 'day', `${name} · ${t.daysLeft}`);
    } else if (hasBalance && item.stock !== null) {
      // No usage today means no days-left estimate; saying so differs from silence and from a measured 0.
      fact(`inventory.daysLeft.none.${item.itemId}`, t.daysLeftNone, '', `${name} · ${t.daysLeft}`);
    }
    for (const menu of item.usingMenus) {
      const current = snapshot.tables.menuItem.find(row => row.menuId === menu.menuId && !row.deletedAt);
      if (current) fact(`inventory.usingMenus.${item.itemId}`, resolveDataText(tr.t, current.name ?? { key: current.nameKey }), '', name);
    }
    const group = selectStockHistory(snapshot, { itemId: item.itemId, period: 'today' }).dayGroups[0];
    if (!group) continue;
    if (hasOpening) fact(`inventory.stockHistory.${item.itemId}.opening`, group.opening, item.unit, `${name} · ${t.opening}`);
    for (const kind of ['receive', 'usage'] as const) {
      const movements = group.rows.filter(row => row.kind === kind);
      if (movements.length) fact(`inventory.stockHistory.${item.itemId}.${kind}`, movementQuantity(movements, item, kind), item.unit, `${name} · ${kind === 'receive' ? t.received : t.usage}`);
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
      const label = `${name} · ${channelLabel(channel, locale)}`;
      if (balance === undefined) {
        if (source) fact(`product.channelBalance.${item.itemId}.${channel}`, '확인할 수 없어요', '', label);
        continue;
      }
      fact(`product.channelBalance.${item.itemId}.${channel}`, balance, item.unit, label);
      if (record.lowStockPerChannel !== null && item.lowChannels.includes(channel)) {
        fact(`product.channelLow.${item.itemId}.${channel}`, balance, item.unit, label);
      }
    }
  }
  // A measured count requires a balance for every item with a threshold in the requested channel.
  const thresholds = products.filter(item => snapshot.tables.inventoryItem.find(row => row.itemId === item.itemId)?.lowStockPerChannel != null);
  const low = facts.filter(row => row.key.startsWith('product.channelLow.'));
  const known = (channel: Channel) => thresholds.length > 0
    && thresholds.every(item => channelBalance(snapshot, item.itemId, channel) !== undefined);
  for (const channel of ['store', 'online'] as const) {
    if (known(channel)) fact(`inventory.products.lowChannel.count.${channel}`, low.filter(row => row.key.endsWith(`.${channel}`)).length, 'item', t.lowChannelCount);
  }
  if (known('store') && known('online')) fact('inventory.products.lowChannel.count', low.length, 'item', t.lowChannelCount);
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

function stockPreviewSnapshot(snapshot: DataSnapshot, tables: DataSnapshot['tables'], command: InventoryCommand, itemId?: string): DataSnapshot {
  const source = realStock(snapshot);
  if (!source || command.type === 'inventory.moveChannel' || command.type === 'inventory.deleteItem') return { ...snapshot, tables };
  const targetId = command.type === 'inventory.createItem' ? itemId : command.itemId;
  const simulated = tables.inventoryItem.find(item => item.itemId === targetId);
  if (!simulated) return { ...snapshot, tables };
  const current = source.items.find(item => item.itemId === targetId);
  const balance = (value: number) => {
    const availableQuantityBase = String(toBase(value, simulated.unit));
    return { openingQuantityBase: current?.stock?.openingQuantityBase ?? availableQuantityBase, usedQuantityBase: current?.stock?.usedQuantityBase ?? '0',
      availableQuantityBase, rawQuantityBase: availableQuantityBase, deficitQuantityBase: '0' };
  };
  let items: readonly StockItemDto[] = source.items;
  if (command.type === 'inventory.createItem') {
    const unit = simulated.unit;
    items = [...items, { itemId: simulated.itemId, sku: simulated.sku ?? null, name: command.name, kind: 'ingredient', unit,
      baseUnit: unitDimension(unit) === 'mass' ? 'g' : unitDimension(unit) === 'volume' ? 'mL' : 'pcs',
      thresholdBase: String(toBase(command.threshold, unit)), trackRestock: simulated.trackRestock, trackExpiry: false, expiresOn: null,
      stock: balance(command.stock), onlineStock: null, referenced: false, businessDate: source.businessDate, updatedAt: null, revision: 1 }];
  } else if (current && command.type === 'inventory.updateItem' && command.stock !== undefined) {
    items = items.map(item => item === current ? { ...item, stock: balance(command.stock!) } : item);
  }
  return { ...snapshot, tables: { ...tables, realStock: [{ ...source, items }] } };
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
      const source = realStock(snapshot);
      if (source && dispatch.type !== 'inventory.createItem') {
        const item = source.items.find(item => item.itemId === dispatch.itemId);
        if (!item?.unit && dispatch.type !== 'inventory.deleteItem') return { kind: 'invalid', field: 'itemId' };
        const reserved = source.batches.filter(batch => batch.itemId === dispatch.itemId && !batch.discardedAt)
          .reduce((sum, batch) => sum + (baseQuantity(batch.remainingQuantityBase) ?? 0), 0);
        if ((dispatch.type === 'inventory.deleteItem' && (item?.referenced || reserved > 0)) ||
          (dispatch.type === 'inventory.updateItem' && dispatch.stock !== undefined && item?.unit && (toBase(dispatch.stock, item.unit) ?? 0) < reserved)) {
          return { kind: 'conflict', field: dispatch.type === 'inventory.deleteItem' ? 'itemId' : 'stock' };
        }
      }
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
      const preview = inventoryPreview(dispatch, snapshot, stockPreviewSnapshot(snapshot, simulated.tables, dispatch, itemId), itemId, locale);
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
const negativeStockQuestion = '현재 재고는 0 이상이어야 해요. 얼마로 기록할까요?';
const missingProduct = '확인할 수 있는 매장 자료가 없어요.';
const skuPattern = /\b[A-Z]{2,}[A-Z0-9]*-[A-Z0-9-]+\b/iu;
const spokenDigits = '영일이삼사오육칠팔구';

function spokenQuantity(text: string) {
  const normalized = text.replace(/키로/gu, '킬로').replace(/(?:미리|밀리)(?!리터)/gu, '밀리리터')
    .replace(/(?<![\p{L}\d])([영공일이삼사오육칠팔구십백천만]+)점([영공일이삼사오육칠팔구]+)(?=\s|킬로|리터|밀리리터|그램|개)/gu,
      (value, integer: string, fraction: string) => {
        const whole = parseNavisNumber(integer);
        return whole === undefined ? value : `${whole}.${[...fraction].map(digit => digit === '공' ? 0 : spokenDigits.indexOf(digit)).join('')}`;
      });
  const negative = /마이너스\s*(?=[\d영공일이삼사오육칠팔구십백천만])/u.test(normalized);
  const parsed = parseNavisQuantity(normalized);
  if (parsed) {
    const half = /\s반(?:으?로|\s|$)/u.test(normalized) ? 0.5 : 0;
    return { ...parsed, value: (negative || parsed.value < 0 ? -1 : 1) * (Math.abs(parsed.value) + half) };
  }
  const candidates = normalized.match(/(?:^|\s)([+-]?[0-9][\d,.]*|[영공일이삼사오육칠팔구십백천만]+)(?=\s|으?로|$)/gu) ?? [];
  const value = candidates.length === 1 ? parseNavisNumber(candidates[0]) : undefined;
  return value === undefined ? undefined : { value: negative ? -Math.abs(value) : value, unit: undefined };
}

function inItemUnit(amount: NonNullable<ReturnType<typeof spokenQuantity>>, unit: UnitCode):
  { value: number } | { field: 'packSize' | 'unit' | 'quantity' } {
  if (unit === 'pcs' && packUnits.some(unit => unit === amount.unit)) return { field: 'packSize' };
  const source = amount.unit === 'sheet' && unit === 'pcs' ? 'pcs' : amount.unit ?? unit;
  if (unitDimension(source) !== unitDimension(unit)) return { field: 'unit' };
  const base = amount.value >= 0 ? toBase(amount.value, source) : null;
  return base === null ? { field: 'quantity' } : { value: fromBase(base, unit) };
}

function transferDirection(text: string) {
  const target = /(?:→|->)\s*(온라인|매장)|(온라인|매장)(?=\s*(?:으로|쪽))/u.exec(text);
  const source = /(온라인|매장)(?=\s*(?:에서|거|→|->))/u.exec(text)?.[1];
  const destination = target?.[1] ?? target?.[2];
  const to = destination === '온라인' ? 'online' : destination === '매장' ? 'store' : undefined;
  const from = source === '온라인' ? 'online' : source === '매장' ? 'store' : to === 'online' ? 'store' : 'online';
  return { from, to } as const;
}

function transferQuantity(text: string) {
  const qty = spokenQuantity(text);
  return qty?.unit === 'pcs' && Number.isSafeInteger(qty.value) && qty.value > 0 ? qty.value : undefined;
}

function findMention(text: string, snapshot: DataSnapshot, locale: Locale, forMove: boolean) {
  const normalized = normalizeNavisName(text);
  const items = liveItems(snapshot);
  const named = items.flatMap(item => [itemLabel(item, locale), itemLabel(item, 'ko'), item.sku]
    .flatMap(label => {
      const term = label && stockLabelText(label);
      if (!term || term.length < 2 || !normalized.includes(normalizeNavisName(term))) return [];
      const pattern = term.split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s*');
      const match = new RegExp(`(?<![\\p{L}\\d])${pattern}(?=$|[\\s,.!?→]|->|은|는|을|를|이|가|으?로)`, 'iu').exec(text);
      return match ? [{ term: match[0], end: match.index + match[0].length }] : [];
    })).sort((a, b) => b.term.length - a.term.length);
  if (named[0]) {
    const { term, end } = named[0];
    const matches = narrowStockMatches(snapshot, term, locale, forMove ? 'move' : undefined)
      .filter(match => !match.item.deletedAt).map(match => match.item);
    return { query: term, matches, tail: text.slice(end) };
  }
  const aliases = items.flatMap(item => {
    const label = itemLabel(item, locale);
    return label.match(/\p{L}+/gu) ?? [];
  });
  const mentions = [...new Set(aliases)].flatMap(term => {
    const pattern = new RegExp(`(?:^|[\\s,.])${term}(?=\\s|[,.!?]|$|은|는|을|를|이|가|으로)`, 'gu');
    return [...text.matchAll(pattern)].map(match => {
      const end = match.index + match[0].length;
      return { term, end, stockScope: /^(?:은|는|을|를)?\s+(?:재고|수량|품목)/u.test(text.slice(end)) };
    });
  }).sort((a, b) => Number(b.stockScope) - Number(a.stockScope) || b.term.length - a.term.length || b.end - a.end);
  const mention = mentions[0];
  if (!mention) return;
  let matches = narrowStockMatches(snapshot, mention.term, locale, forMove ? 'move' : undefined).map(match => match.item);
  // The café uses unqualified 원두 for regular beans when every other ingredient is explicitly decaf.
  if (!forMove && mention.term === '원두' && matches.some(item => item.kind === 'ingredient')) {
    const ingredients = matches.filter(item => item.kind === 'ingredient');
    const regular = ingredients.filter(item => !itemLabel(item, 'ko').includes('디카페인'));
    matches = regular.length ? regular : ingredients;
  }
  const query = matches.length === 1 && forMove ? itemLabel(matches[0], locale) : mention.term;
  return { query, matches, tail: text.slice(mention.end) };
}

function inventoryCommandTurn(command: InventoryCommandName, snapshot: DataSnapshot, locale: Locale, values: LocalSlots, item?: InventoryItem, literals: AgentWireArgs = {}, query?: string): DomainTurnInput {
  const label = item ? itemLabel(item, locale) : query;
  const lookupQuery = item?.sku && label && narrowStockMatches(snapshot, label, locale).length > 1 ? item.sku : label;
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
  const today = stockDate(snapshot);
  const requestedDate = parseNavisDate(text, today);
  if (!/입고\s*내역\s*보여|(?:변동\s*기록|입출고).*(?:열어|화면)/u.test(text)
    || /일주일|7\s*일/u.test(text) || requestedDate && requestedDate !== today) return;
  const matches = findMention(text, snapshot, locale, false)?.matches;
  if (matches?.length !== 1 || matches[0].kind !== 'ingredient') return;
  const [{ itemId }] = matches;
  return { args: { featureId, view: 'history', itemId }, target: { kind: 'stock', id: itemId } };
}

export function readInventoryTurn(raw: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const text = stockLabelText(normalizeNavisInput(raw));
  const t = copy[locale];
  const clarify = (field: string, answer: string, resume?: (value: string) => DomainRoute | undefined): LocalRoute =>
    ({ kind: 'clarification', field, answer, ...(resume ? { resume } : {}) });
  const refuse = (reason: 'unsupported' | 'invalid_target', answer: string): LocalRoute => ({ kind: 'refusal', reason, answer });
  const answer = (value: string): LocalRoute => ({ kind: 'answer', answer: value });
  const today = stockDate(snapshot);
  const date = parseNavisDate(text, today);
  const period = parseNavisPeriod(text, today);
  const requested: QueryCondition = period ? { kind: 'dateRange', ...period } : { kind: 'snapshot', asOf: date ?? today };
  const read = (keys: readonly string[], condition: QueryCondition = requested): DomainTurnInput => {
    const projection = projectInventoryFacts(snapshot, featureId, condition, locale);
    const factKeys = projection && 'facts' in projection
      ? projection.facts.filter(fact => keys.some(key => key.endsWith('.') ? fact.key.startsWith(key) : fact.key === key)).map(fact => fact.key) : [];
    return { intent: { kind: 'read', featureId, condition }, factKeys };
  };
  const lookup = (name: string): DomainTurnInput =>
    ({ intent: { kind: 'read', recordKind: 'stock', querySlot: 'name' }, slots: { name } });
  const lookupMissing = (name: string, missingAnswer = missingProduct, reason?: 'invalid_target'): DomainTurnInput => ({
    ...lookup(name), onMissing: { answer: missingAnswer, reason },
  });

  if (/하지\s*마|말아\s*줘|무시|ignore\s+|\b(?:don't|never|do not)\b|[“”"'‘’]/iu.test(text)) return;
  if (/가격|판매가|단가/u.test(text) && !stockWords.test(text)) return;
  if (/레시피|라[테떼]에|메뉴에/u.test(text) && createWords.test(text)) return;
  if (inventoryNavigation(text, snapshot, locale)) return;
  const sku = skuPattern.exec(text)?.[0];
  const unitDeclaration = /단위\s*([\p{L}]+)/u.exec(text);
  const declaredAmount = unitDeclaration && spokenQuantity(text.slice(unitDeclaration.index + unitDeclaration[0].length));
  const describedItem = sku && (/^재고에\s+\p{L}+\s/u.test(text) || /품목\s*코드/u.test(text)
    || declaredAmount) && !readWords.test(text.replace(/품목\s*코드/gu, ''));
  const creating = (stockWords.test(text) || /재료에/u.test(text) || sku) && createWords.test(text) || describedItem;
  if (creating && !methodWords.test(text)) {
    if (/(?:^|\s|재고)(?:위젯|패널|(?:대시)?보드)(?:을|를|에)?(?=\s|[.?!]|추가|등록|넣어|$)/u.test(text)) return;
    const name = /^(?:재고(?:에)?\s+(?:품목\s+)?|재료에\s+)?([\p{L}][\p{L}\d-]{0,119})/u.exec(text)?.[1];
    if (!name || /^(?:품목|재고|새)$/u.test(name)) return;
    const declaredUnit = unitDeclaration?.[1];
    const afterSku = sku ? text.slice(text.indexOf(sku) + sku.length) : text;
    const unitValue = declaredUnit ?? /(?<![\p{L}\d])(?:mL|kg|L|g|pcs|리터|그램|킬로|개|박스)(?![\p{L}])/iu.exec(afterSku)?.[0];
    const measured = spokenQuantity(afterSku.split(/(?:안전\s*재고|보충\s*기준|기준)/u)[0]);
    const unit = unitValue ? parseNavisQuantity(`1${unitValue}`)?.unit : measured?.unit;
    const stock = /재고\s+([+-]?[\d.]+)/u.exec(text)?.[1] ?? /[+-]?\d[\d.]*/u.exec(afterSku)?.[0];
    const threshold = /기준\s*([\d.]+)/u.exec(text)?.[1];
    const off = /알림.*(?:없|필요\s*없|끔)|알림\s*없이/u.test(text);
    if (!isUnit(unit)) return clarify('unit', t.unitQuestion, value => readInventoryTurn(declaredUnit ? text.replace(`단위 ${declaredUnit}`, `단위 ${value}`) : `${text} 단위 ${value}`, snapshot, locale));
    if (!sku || stockItems(snapshot).some(item => item.sku?.toUpperCase() === sku.toUpperCase())) return clarify('sku', t.skuQuestion, value => readInventoryTurn(sku ? text.replace(sku, value) : `${text} 코드 ${value}`, snapshot, locale));
    if (narrowStockMatches(snapshot, name, locale, 'ingredient').length) return clarify('duplicate', t.targetQuestion);
    const initial = measured && (stock === undefined || measured.unit) ? measured
      : stock === undefined ? undefined : { value: Number(stock), unit: undefined };
    const converted = initial && inItemUnit(initial, unit);
    if (!converted || 'field' in converted) return clarify('stock', t.stockQuestion);
    const safe = threshold === undefined ? off ? 0 : undefined : Number(threshold);
    if (!isQuantity(safe) || toBase(safe, unit) === null) return clarify('threshold', t.thresholdQuestion);
    return inventoryCommandTurn('inventory.createItem', snapshot, locale, { sku, name, stock: converted.value, threshold: safe }, undefined, { unit, ...(off ? { trackRestock: false } : {}) }, name);
  }

  const packaged = /^([\p{L}]+\s*\d+(?:[.,]\d+)?\s*(?:kg|g))(?=$|\s|[.!?])/iu.exec(text)?.[1];
  const packageTail = packaged ? text.slice(packaged.length).trim() : '';
  const packagedTransfer = /매장|온라인/u.test(packageTail) && !stockWords.test(text)
    && !readWords.test(text) && spokenQuantity(packageTail)?.unit === 'pcs';
  const moving = (transferWords.test(text) || packagedTransfer) && !/재고\s*(?:각각|알려)|부족한|몇\s*개\s*있어/u.test(text);
  const retailRequest = packaged && (moving || /재고|매장|온라인/u.test(packageTail) && !/^재고\s*(?:맞춰|설정)/u.test(packageTail));
  if (packaged && !retailRequest && /얼마/u.test(text)) return;
  const channelMove = moving ? transferDirection(text) : undefined;
  const moveComplete = channelMove?.to && channelMove.from !== channelMove.to;
  const lookupMissingTransfer = (name: string, targetTail: string) =>
    lookupMissing(name, missingProduct, moveComplete && transferQuantity(targetTail) !== undefined ? 'invalid_target' : undefined);
  const packageCandidates = retailRequest ? stockMatches(snapshot, packaged, locale) : [];
  const retailMatches = packageCandidates.filter(candidate => candidate.match === 'exact' && candidate.item.kind === 'retail');
  if (retailRequest && !retailMatches.length) {
    if (moving && packageCandidates.length) return refuse('invalid_target', missingProduct);
    if (moving) return lookupMissingTransfer(packaged, packageTail);
    return rewriteWords.test(text) && !packageCandidates.length ? lookupMissing(packaged) : { ...read([]), onMissing: { answer: missingProduct } };
  }
  const mention = retailRequest
    ? { query: packaged, matches: retailMatches.map(match => match.item), tail: packageTail }
    : findMention(text, snapshot, locale, moving);
  const item = mention?.matches.length === 1 ? mention.matches[0] : undefined;
  const moveTarget = moving && /매장|온라인/u.test(text)
    ? /^(\p{L}+(?:\s+\p{L}+){0,2}?)\s+(?=(?:온라인|매장)(?:\s|에서|으로|쪽|거|->|→)|\d+\s*개)/u.exec(text)?.[1] : undefined;
  const stockTarget = /^(\p{L}+(?:\s+\p{L}+){0,2}?)\s+(?=(?:재고|부족하면|보충\s*기준|안전\s*재고)(?:\s|$))/u.exec(text)?.[1];
  const missingTarget = moveTarget ?? (rewriteWords.test(text) || thresholdWords.test(text) ? stockTarget : undefined);
  if (missingTarget && !/^(?:오늘|어제|내일|지금)\s/u.test(missingTarget)
    && !/매출|쿠폰|문자|공지|회원|예약|위젯|패널/u.test(missingTarget)
    && !spokenQuantity(missingTarget)
    && !stockMatches(snapshot, missingTarget, locale).length) {
    if (moving) return lookupMissingTransfer(missingTarget, text.slice(missingTarget.length));
    return thresholdWords.test(text) ? lookupMissing(missingTarget, copy.ko.itemMissing, 'invalid_target') : lookupMissing(missingTarget);
  }
  if (moving && mention && mention.matches.every(candidate => candidate.kind !== 'retail')) return refuse('unsupported', t.retailOnly);
  if (!item && mention && mention.matches.length > 1 && (moving || stockWords.test(text) || rewriteWords.test(text))) {
    return clarify('target', t.targetQuestion, value => {
      const match = narrowStockMatches(snapshot, value, locale);
      if (match.length !== 1 || !mention.matches.some(candidate => candidate.itemId === match[0].item.itemId)) return undefined;
      const selected = match[0].item;
      return readInventoryTurn(text.replace(mention.query, selected.sku ?? itemLabel(selected, locale)), snapshot, locale);
    });
  }
  if (!item) {
    if (/부족한|모자란/u.test(text) && /온라인|채널|판매\s*상품/u.test(text)) {
      // Separate a measured zero (channels exist and none is low) from a store with no retail rows at all.
      const projected = projectInventoryFacts(snapshot, featureId, requested, locale);
      const facts = projected && 'facts' in projected ? projected.facts : [];
      const channel = /온라인/u.test(text) ? 'online' : undefined;
      const low = facts.filter(fact => fact.key.startsWith('product.channelLow.') && (!channel || fact.key.endsWith(`.${channel}`)));
      if (low.length) return read(low.map(fact => fact.key));
      const count = channel ? `inventory.products.lowChannel.count.${channel}` : 'inventory.products.lowChannel.count';
      if (facts.some(fact => fact.key === count)) return read([count]);
      return { ...read([]), onMissing: { answer: missingProduct } };
    }
    if (/^(?:(?:지금|현재|오늘)\s*)?(?:재고|품절|보충)/u.test(text) && /부족|보충|품절|어때/u.test(text) && !rewriteWords.test(text)) {
      return read(['inventory.restock.count', 'inventory.outOfStock.count']);
    }
    // Names that belong to other widgets or to a date are never treated as an unknown stock item.
    const otherSubject = /매출|발주|쿠폰|예약|위젯|마진|레시피|최근|어제|지난|오늘|내일|지금|현재|전체|모든|이번|손님|회원|자리|좌석|테이블|직원|알바|메뉴|포인트|티켓|이용권/u;
    const query = /^([\p{L}\d -]+?)\s+재고(?=\s|[?？]|$)(.*)$/u.exec(text);
    if (query && (readWords.test(query[2]) || /[?？]/u.test(query[2])) && !rewriteWords.test(text)
      && !/매출|발주|쿠폰|예약|위젯|마진|레시피|최근|어제|지난/u.test(text)) return lookupMissing(query[1], t.itemMissing);
    // A bare "<name> 재고" and "<name> 몇 개 남았어" read the same stock lookup; an unregistered name is reported as not registered, never as zero.
    const bare = /^([\p{L}\d -]+?)\s+재고$/u.exec(text) ?? /^([\p{L}\d-]+)\s+(?:몇\s*개|얼마나)\s*(?:나\s*)?(?:남았|있)/u.exec(text);
    if (bare && !rewriteWords.test(text) && !otherSubject.test(bare[1]) && [...bare[1].trim()].length >= 2) {
      return lookupMissing(bare[1].trim(), t.itemMissing);
    }
    if (stockWords.test(text) && readWords.test(text) && !rewriteWords.test(text) && !/^재고|(?:매출|발주|쿠폰|예약|위젯|마진|레시피)/u.test(text)) return answer(t.itemMissing);
    return;
  }
  const tail = mention?.tail.trim() ?? text;
  const isHistory = /입출고|입고.*내역|재고.*변동|어떻게\s*줄|재고.*변화|들어오고\s*나갔|사용\s*내역/u.test(text);
  if (isHistory) {
    const week = /일주일|7\s*일/u.test(text);
    return read([`inventory.stockHistory.${item.itemId}.`], week ? { kind: 'dateRange', start: addDays(today, -6), end: today } : undefined);
  }
  if (/코드|\bsku\b/iu.test(text)) return lookup(itemLabel(item, locale));
  if (/쓰는\s*메뉴|못\s*(?:팔|만들)/u.test(tail) && !rewriteWords.test(tail)) return read([`inventory.usingMenus.${item.itemId}`]);
  if (/언제\s*떨어|며칠|하루\s*버텨/u.test(text)) return read([`inventory.stock.${item.itemId}`, `inventory.daysLeft.${item.itemId}`, `inventory.daysLeft.none.${item.itemId}`]);
  if (/사용량|얼마나\s*썼/u.test(tail)) return;
  if (moving || removeWords.test(text)) {
    if (channelMove) {
      if (item.kind !== 'retail' || item.unit !== 'pcs') return refuse('unsupported', t.retailOnly);
      const { from, to } = channelMove;
      const qty = transferQuantity(tail);
      if (qty === undefined) return clarify('qty', t.qtyQuestion);
      if (!to || from === to) return clarify('direction', t.directionQuestion);
      const available = channelBalance(snapshot, item.itemId, from), destinationBalance = channelBalance(snapshot, item.itemId, to);
      if (available === undefined || destinationBalance === undefined) return refuse('invalid_target', t.unavailable);
      if (qty > available || !Number.isSafeInteger(destinationBalance + qty)) return clarify('qty', t.qtyQuestion);
      return inventoryCommandTurn('inventory.moveChannel', snapshot, locale, { qty }, item, { from, to });
    }
    if (item.kind !== 'ingredient') return refuse('unsupported', t.ingredientOnly);
    if (referencesItem(snapshot, item.itemId)) return refuse('invalid_target', t.referenced);
    return inventoryCommandTurn('inventory.deleteItem', snapshot, locale, {}, item);
  }
  if (methodWords.test(text) && !rewriteWords.test(text)) return clarify('method', t.methodQuestion);
  const tracking = /알림|추적|당일\s*소진/u.test(tail) && /켜|꺼|끄|끔|중지|해제/u.test(tail);
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
  const threshold = thresholdMatch ? spokenQuantity(tail.slice(thresholdMatch.index + thresholdMatch[0].length)) : undefined;
  const thresholdRequest = threshold && /^부족하면\s*알려/u.test(stockText);
  const asksForRead = readWords.test(tail) || /[?？]$/u.test(tail) && !rewriteWords.test(tail);
  const shorthandAmount = stock?.unit && /^(?:마이너스\s*)?[+-]?(?:\d|[영공일이삼사오육칠팔구십백천만한두세네반열])/u.test(tail)
    && !/발주|구매|주문|레시피|쿠폰/u.test(tail);
  const explicitUpdate = rename || thresholdRequest || !asksForRead && (thresholdMatch || rewriteWords.test(tail)
    || stockWords.test(tail) && stock || shorthandAmount);
  if (!explicitUpdate) {
    if (!readWords.test(text) && !stockWords.test(text)) return;
    const channel = /매장/u.test(tail) === /온라인/u.test(tail) ? undefined : /매장/u.test(tail) ? 'store' : 'online';
    return item.kind === 'retail' ? read([`product.channelBalance.${item.itemId}.${channel ?? ''}`])
      : read([`inventory.stock.${item.itemId}`, ...(thresholdMatch ? [`inventory.threshold.${item.itemId}`] : [])]);
  }
  if (item.kind !== 'ingredient') return refuse('unsupported', t.ingredientOnly);
  type Amounts = Record<'stock' | 'threshold', ReturnType<typeof spokenQuantity>>;
  const buildUpdate = (amounts: Amounts): DomainRoute => {
    const resumeAmount = (field: keyof Amounts) => (value: string) => {
      const corrected = spokenQuantity(value);
      if (!corrected || 'field' in inItemUnit(corrected, item.unit)) return undefined;
      return buildUpdate({ ...amounts, [field]: corrected });
    };
    const values: Record<string, string | number> = rename ? { name: rename } : {};
    for (const field of ['stock', 'threshold'] as const) {
      const amount = amounts[field];
      if (!amount) continue;
      const converted = inItemUnit(amount, item.unit);
      if ('value' in converted) {
        values[field] = converted.value;
        continue;
      }
      if (converted.field === 'packSize') return clarify('packSize', t.packQuestion);
      if (converted.field === 'unit') return clarify('unit', `${t.unitMismatch} (${item.unit})`, resumeAmount(field));
      const prompt = field === 'threshold' ? t.thresholdQuestion : amount.value < 0 ? negativeStockQuestion : t.stockQuestion;
      return clarify(field, prompt, resumeAmount(field));
    }
    if (!Object.keys(values).length && !thresholdMatch) return clarify('stock', t.stockQuestion, resumeAmount('stock'));
    if (thresholdMatch && values.threshold === undefined) return clarify('threshold', t.thresholdQuestion, resumeAmount('threshold'));
    const before = readModel(snapshot, featureId).ingredients.find(row => row.itemId === item.itemId);
    const name = itemLabel(item, locale);
    if (before && Object.entries(values).every(([field, value]) => field === 'name' ? value === name : field === 'stock' ? before.stock !== null && value === before.raw : value === before.threshold)) {
      return answer(t.unchanged);
    }
    if (values.name === name) delete values.name;
    return inventoryCommandTurn('inventory.updateItem', snapshot, locale, values, item);
  }
  return buildUpdate({ stock, threshold });
}

export const inventoryDomain = {
  commands: (['inventory.createItem', 'inventory.updateItem', 'inventory.moveChannel', 'inventory.deleteItem', 'inventory.setTracking'] as const).map(commandAdapter),
  reads: [stockReader],
  route: readInventoryTurn,
  projectWidget: projectInventoryFacts,
  navigation: inventoryNavigation,
} satisfies DomainAdapter;
