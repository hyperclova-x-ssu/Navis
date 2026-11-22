import type { DetailRef, FeatureId, Locale, QueryCondition } from '../../../contracts';
import { handlers } from '../../../data/commands/handlers';
import type { DataCommand } from '../../../data/commands/types';
import { fromBase, toBase, unitDimension } from '../../../data/derive/common';
import { purchaseQuantityBase } from '../../../data/derive/stock';
import { addDays, isIsoDate, TODAY } from '../../../data/db/time';
import type { DataSnapshot, DataText, UnitCode } from '../../../data/db/types';
import type { PurchasingReceipt } from '../../../data/reality/04/adapter';
import { deriveOpenOrders, deriveStock, readModel, resolveDataText } from '../../../data/widget-data';
import { createTranslator } from '../../../i18n';
import { validateAgentCommandArgs, validateAgentDraft, validateAgentPrefill, type AgentFact, type AgentRefusal } from '../../../../shared/navis-agent-schema.mjs';
import { mgmtSupplyBundle } from '../../widgets/mgmt-supply/messages';
import { navisTranslator } from '../messages';
import { navisMoneySpans, normalizeNavisInput, normalizeNavisName, parseNavisDate, parseNavisNumber, parseNavisQuantity } from '../navis-input';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainLookup, DomainRoute, DomainTurnInput, LocalSlots, RecordAdapter, RecordSearch, RecordTargets } from './registry';

const featureId = 'suppliers' as const;
type SupplierCommand = Extract<DataCommand, { type: `suppliers.${string}` }>;
type CommandName = SupplierCommand['type'];
type Order = ReturnType<typeof deriveOpenOrders>['orders'][number];
type OrderLine = Order['lines'][number];
type Purchase = DataSnapshot['tables']['purchaseItem'][number];
type Supplier = DataSnapshot['tables']['supplier'][number];
type SupplyKind = 'purchaseItem' | 'supplier' | 'purchaseOrder' | 'purchaseOrderLine';

const text = (locale: Locale) => {
  const { t, format } = navisTranslator(locale);
  const supply = createTranslator(locale, mgmtSupplyBundle).t;
  return { t, format, supply, name: (row: { name?: Parameters<typeof resolveDataText>[1]; nameKey: string }) => resolveDataText(t, row.name ?? { key: row.nameKey }),
    data: (value: Parameters<typeof resolveDataText>[1]) => resolveDataText(t, value),
    money: (amount: number) => format.money(amount, 'full'),
    orderCount: (count: number) => supply('widget.suppliers.incomingCount', { count }) };
};
const inLocale = (locale: Locale, ko: string, en: string, hans: string, hant: string) =>
  ({ ko, en, 'zh-Hans': hans, 'zh-Hant': hant })[locale];
const currentOrders = (snapshot: DataSnapshot) => deriveOpenOrders(snapshot, { date: TODAY });
const inventoryItem = (snapshot: DataSnapshot, itemId: string) => snapshot.tables.inventoryItem.find(row => row.itemId === itemId && !row.deletedAt);
const liveSuppliers = (snapshot: DataSnapshot) => snapshot.tables.supplier.filter(row => !row.deletedAt);
const purchaseUnit = (snapshot: DataSnapshot, purchase: Purchase) => purchase.purchaseUnit ?? inventoryItem(snapshot, purchase.itemId)?.unit ?? 'pcs';
const lineName = (line: { readonly itemName?: DataText; readonly itemNameKey: string }, locale: Locale) => text(locale).data(line.itemName ?? { key: line.itemNameKey });
const supplierName = (snapshot: DataSnapshot, id: string, locale: Locale) => {
  const row = snapshot.tables.supplier.find(supplier => supplier.supplierId === id);
  return row ? text(locale).name(row) : '—';
};
const orderName = (order: Order, locale: Locale) => order.lines.map(line => lineName(line, locale)).join(' · ');
const orderStatus = (order: Pick<Order, 'status'>, locale: Locale) => order.status === 'canceled'
  ? inLocale(locale, '취소', 'Canceled', '已取消', '已取消')
  : text(locale).supply(`widget.suppliers.status.${order.status}`);
const dateText = (date: string | null, locale: Locale) => date ? text(locale).format.date(date, 'short') : '—';
const receiptDate = (receipt: PurchasingReceipt) => receipt.businessDate ?? receipt.receivedAt.slice(0, 10);

function purchaseReferenced(snapshot: DataSnapshot, itemId: string) {
  return snapshot.tables.recipeLine.some(row => row.itemId === itemId) ||
    snapshot.tables.menuItem.some(menu => menu.optionGroups?.some(group => group.options.some(option => option.extraRecipe.some(line => line.itemId === itemId))));
}

function orderSummary(order: Pick<Order, 'supplierId' | 'dueDate' | 'status'> & { readonly lines: readonly (Pick<OrderLine, 'itemNameKey' | 'unit' | 'remaining' | 'ordered'> & { readonly itemName?: DataText })[] }, snapshot: DataSnapshot, locale: Locale) {
  const { format } = text(locale);
  return [order.lines.map(line => `${lineName(line, locale)} ${format.quantity(order.status === 'scheduled' || order.status === 'partial' ? line.remaining : line.ordered, line.unit)}`).join(' · '),
    supplierName(snapshot, order.supplierId, locale), dateText(order.dueDate, locale), orderStatus(order, locale)].join(' · ');
}

const keys = {
  upcoming: 'suppliers.upcoming.count', overdue: 'suppliers.overdue.count', overdueRow: 'suppliers.overdue.order',
  upcomingRow: 'suppliers.upcoming.order', monthCount: 'suppliers.month.count', monthTotal: 'suppliers.month.total',
  supplier: 'suppliers.supplier', history: 'suppliers.history.order', suggestions: 'suppliers.suggestions.count', suggestion: 'suppliers.suggestions.item',
  suggestionStatus: 'suppliers.suggestions.status',
} as const;

export function projectSupplierFacts(snapshot: DataSnapshot, feature: FeatureId, condition: QueryCondition, locale: Locale) {
  if (feature !== featureId) return;
  if (condition.kind !== 'default' && !(condition.kind === 'snapshot' && condition.asOf === TODAY)) return { status: 'unsupported_period' as const };
  const tr = text(locale), model = readModel(snapshot, featureId);
  const orders = currentOrders(snapshot);
  const available = (id: string) => inventoryItem(snapshot, id);
  const restock = deriveStock(snapshot, { date: TODAY }).rows.filter(row => row.needsRestock);
  const covered = restock.length > 0 && restock.every(row => orders.open.some(order => order.lines.some(line => line.itemId === row.itemId && line.remaining > 0)));
  const count = (key: string, label: string, value: number): AgentFact => ({ key, label, value, unit: 'order', display: tr.orderCount(value) });
  const row = (key: string, label: string, value: string, date?: string | null): AgentFact => ({ key, label, value, unit: 'text', display: value, ...(date ? { date } : {}) });
  const month = inLocale(locale, '이번 달 발주', 'Orders this month', '本月订单', '本月訂單');
  const proposals = inLocale(locale, '발주 제안', 'Order suggestions', '订购建议', '訂購建議');
  const overdue = tr.supply('widget.suppliers.group.overdue');
  const upcoming = tr.supply('widget.suppliers.incoming');
  const facts: AgentFact[] = [
    count(keys.upcoming, upcoming, model.upcomingCount),
    count(keys.overdue, overdue, model.overdueCount),
    count(keys.monthCount, month, model.monthCount),
    { key: keys.monthTotal, label: month, value: model.monthTotal, unit: 'KRW', display: tr.money(model.monthTotal) },
    count(keys.suggestions, proposals, model.suggestions.length),
    ...(!model.suggestions.length ? [row(keys.suggestionStatus, proposals, covered
      ? inLocale(locale, '모자란 품목은 이미 발주했어요', 'Shortages are already on order', '缺货品项已订购', '缺貨品項已訂購')
      : inLocale(locale, '지금 발주할 품목이 없어요', 'No items to order', '没有需要订购的品项', '沒有需要訂購的品項'))] : []),
    ...model.suppliers.map(supplier => row(keys.supplier, inLocale(locale, '발주사', 'Supplier', '供应商', '供應商'), tr.name(supplier))),
    ...model.overdue.map(order => row(keys.overdueRow, overdue, orderSummary(order, snapshot, locale), order.dueDate)),
    ...model.upcoming.map(order => row(keys.upcomingRow, upcoming, orderSummary(order, snapshot, locale), order.dueDate)),
    ...model.suggestions.flatMap(suggestion => {
      const item = available(suggestion.itemId);
      return item ? [row(keys.suggestion, proposals, [tr.name(item), tr.format.quantity(suggestion.qty, suggestion.unit), tr.money(suggestion.total),
        supplierName(snapshot, suggestion.supplierId, locale), dateText(suggestion.dueDate, locale)].join(' · '), suggestion.dueDate)] : [];
    }),
    ...orders.orders.filter(order => !order.open).reverse().slice(0, 25).map(order => row(keys.history,
      tr.supply('widget.suppliers.group.past'), orderSummary(order, snapshot, locale), order.dueDate)),
  ];
  return { facts };
}

type Row = { id: string; label: string; aliases?: readonly string[]; supplier?: string; supplierId?: string; dueDate?: string | null;
  orderLines?: Order['lines']; choice?: string; fields: Record<string, string | number | boolean> };
const shortName = (name: string) => name.split(/\s+/u).at(-1) ?? name;
const normalize = (name: string) => normalizeNavisName(name).replace(/[·ㆍ]/gu, '');
const trimQuery = (query: string) => normalizeNavisInput(query).replace(/(?:으로|에서|에게|을|를|은|는|이|가|에)$/u, '').trim();
function nameMatches(query: string, name: string) {
  const input = normalize(query), key = normalize(name);
  if (!input || !key) return false;
  const terms = query.trim().split(/\s+/u).map(normalize);
  return input === key || input.length >= 2 && key.includes(input) ||
    terms.length > 1 && terms.every(term => term.length >= 2 && key.includes(term)) ||
    input.length === 1 && name.split(/[^\p{L}\p{N}]+/u).some(word => normalize(word) === input);
}

function supplierRows(snapshot: DataSnapshot, locale: Locale, kind: SupplyKind): Row[] {
  const tr = text(locale), orders = currentOrders(snapshot);
  if (kind === 'purchaseItem') {
    const suggested = new Set(readModel(snapshot, featureId).suggestions.map(row => row.purchaseItemId));
    return snapshot.tables.purchaseItem.flatMap(p => {
      const item = inventoryItem(snapshot, p.itemId);
      return item ? [{ id: p.purchaseItemId, label: tr.name(item), aliases: item.sku ? [item.sku] : undefined,
        supplierId: p.supplierId, supplier: supplierName(snapshot, p.supplierId, locale),
        fields: { unit: purchaseUnit(snapshot, p), minimumQty: p.minimumQty, unitPrice: p.unitPrice, orderStep: p.orderStep,
          leadDays: p.leadDays, referenced: purchaseReferenced(snapshot, p.itemId), suggested: suggested.has(p.purchaseItemId) } }] : [];
    });
  }
  if (kind === 'supplier') return liveSuppliers(snapshot).map(supplier => ({
    id: supplier.supplierId, label: tr.name(supplier), fields: {
      referenced: snapshot.tables.purchaseItem.some(p => p.supplierId === supplier.supplierId) || orders.open.some(o => o.supplierId === supplier.supplierId),
    },
  }));
  return orders.orders.flatMap<Row>(order => {
    const supplier = supplierName(snapshot, order.supplierId, locale);
    const fields = { status: order.status, open: order.open };
    const choice = `${supplier} · ${dateText(order.dueDate, locale)}`;
    return kind === 'purchaseOrder' ? [{ id: order.poId, label: orderName(order, locale), supplier, dueDate: order.dueDate, choice, orderLines: order.lines,
      aliases: [supplier, ...order.lines.map(line => lineName(line, locale))],
      fields: { ...fields, ...(order.dueDate ? { date: order.dueDate } : {}) } }]
      : order.lines.map(line => ({ id: line.polId, label: lineName(line, locale), supplier, dueDate: order.dueDate, choice, aliases: [supplier],
        fields: { ...fields, open: order.open && line.remaining > 0, unit: line.unit, remaining: line.remaining, unitPrice: line.unitPrice } }));
  });
}

function findRows(rows: readonly Row[], query: string, openFirst: boolean, locale: Locale = 'ko') {
  const [item, supplier, dueDate, orderQuantity] = query.split('\n');
  const wanted = trimQuery(item);
  const quantity = orderQuantity ? explicitQty(orderQuantity) : undefined;
  const scope = rows.filter(row => (!supplier || row.supplier && nameMatches(supplier, row.supplier)) && (!dueDate || row.dueDate === dueDate) &&
    (!orderQuantity || row.orderLines?.some(line => (nameMatches(wanted, lineName(line, locale)) || row.supplier && nameMatches(wanted, row.supplier)) &&
      toPurchaseQty(quantity, line.unit, line.basePerUnit) === line.ordered)));
  const names = (row: Row) => [row.label, ...(row.aliases ?? [])];
  const exact = scope.filter(row => names(row).some(name => normalize(name) === normalize(item)));
  const narrowed = exact.length ? exact : scope.filter(row => names(row).some(name => nameMatches(wanted, name)));
  const open = openFirst ? narrowed.filter(row => row.fields.open === true) : [];
  return open.length ? open : narrowed;
}

/** `aspect` is the requested fact, kept apart from the canonical `name` lookup slot; it is browser-local and never sent. */
type AspectSearch = RecordSearch & { readonly aspect?: string };
const handle = (kind: SupplyKind, snapshot: DataSnapshot, index: number) => `supply-${kind}-${snapshot.revision}-${index}`;
function lookupRows(input: RecordSearch, kind: SupplyKind) {
  const { snapshot, locale, command } = input;
  const query = input.querySlot === 'estimate' ? input.query.split('\n')[0] : input.query;
  const rows = supplierRows(snapshot, locale, kind);
  let matched = findRows(rows, query, !!command && (kind === 'purchaseOrder' || kind === 'purchaseOrderLine'), locale);
  // A read for a supplier's name lists the purchase rows tied to that supplier; commands never resolve through a supplier name.
  if (!matched.length && !query.includes('\n') && kind === 'purchaseItem' && !command && input.querySlot !== 'estimate') {
    const wanted = trimQuery(query);
    matched = rows.filter(row => row.supplier && nameMatches(wanted, row.supplier));
  }
  if (kind === 'purchaseOrder' && input.querySlot === 'receiptHistory') {
    const results = currentOrders(snapshot).orders;
    const last = (id: string) => results.find(order => order.poId === id)?.lines.flatMap(line => line.receipts)
      .reduce((date, receipt) => receipt.receivedAt > date ? receipt.receivedAt : date, '') ?? '';
    matched = matched.filter(row => last(row.id)).sort((a, b) => last(b.id).localeCompare(last(a.id))).slice(0, 1);
  }
  return matched.map(row => ({ row, handle: handle(kind, snapshot, rows.indexOf(row)) }));
}

function makeReader(kind: SupplyKind): RecordAdapter {
  return {
    kind,
    search(input) {
      const rows = lookupRows(input, kind);
      return rows.map(match => ({ handle: match.handle, match: rows.length === 1 ? 'exact' : 'similar',
        fields: match.row.fields, ...(!input.privateLookup ? { label: [match.row.label, input.command ? match.row.choice : undefined].filter(Boolean).join(' · ').slice(0, 180) } : {}) }));
    },
    resolve(input, selected) {
      return lookupRows(input, kind).find(row => row.handle === selected)?.row.id;
    },
    describe(match, locale, input) {
      if (!input) return;
      const found = lookupRows(input, kind).find(row => row.handle === match.handle)?.row;
      if (!found) return;
      const { snapshot, querySlot } = input;
      const tr = text(locale);
      if (kind === 'supplier') {
        const supplier = liveSuppliers(snapshot).find(row => row.supplierId === found.id)!;
        if (querySlot === 'contact') return [found.label, supplier.phoneMask].filter(Boolean).join(' · ');
        if (querySlot === 'products') return [found.label, ...snapshot.tables.purchaseItem.filter(row => row.supplierId === found.id)
          .flatMap(row => { const item = inventoryItem(snapshot, row.itemId); return item ? [tr.name(item)] : []; })].join(' · ');
        return found.label;
      }
      if (kind === 'purchaseOrder') {
        const order = currentOrders(snapshot).orders.find(order => order.poId === found.id);
        if (order && querySlot === 'receiptHistory') {
          const latest = order.lines.flatMap(line => line.receipts).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
          return latest ? [orderSummary(order, snapshot, locale), dateText(receiptDate(latest), locale)].join(' · ') : undefined;
        }
        return order && orderSummary(order, snapshot, locale);
      }
      if (kind !== 'purchaseItem') return;
      const purchase = snapshot.tables.purchaseItem.find(row => row.purchaseItemId === found.id)!;
      const unit = purchaseUnit(snapshot, purchase);
      if (querySlot === 'estimate') {
        const [, quantity, due] = input.query.split('\n');
        const qty = Number(quantity);
        if (!isIsoDate(due) || !Number.isSafeInteger(Math.round(qty * purchase.unitPrice)) || qty <= 0 ||
          purchaseQuantityBase(qty, unit, purchase.basePerUnit) === null) return;
        const summary = [`${found.label} ${tr.format.quantity(qty, unit)}`, tr.money(Math.round(qty * purchase.unitPrice)),
          supplierName(snapshot, purchase.supplierId, locale), dateText(due, locale)].join(' · ');
        const open = currentOrders(snapshot).open.some(order => order.lines.some(line => line.itemId === purchase.itemId && line.remaining > 0));
        const waiting = inLocale(locale, '이미 입고 대기 중인 발주가 있어요', 'An order is already awaiting delivery', '已有订单等待到货', '已有訂單等待到貨');
        return open ? `${summary}\n${waiting}` : summary;
      }
      // The canonical lookup slot is `name`; the requested fact travels as `aspect` (older callers still pass it as the slot).
      const asked = (input as AspectSearch).aspect ?? (querySlot === 'name' ? undefined : querySlot);
      const unitSymbol = tr.format.quantity(1, unit).replace(/^1\s*/u, '');
      const caption = {
        supplier: inLocale(locale, '발주사', 'Supplier', '供应商', '供應商'),
        unitPrice: inLocale(locale, '단가', 'Unit price', '单价', '單價'),
        minimumQty: inLocale(locale, '최소 주문', 'Minimum order', '最低订购量', '最低訂購量'),
        orderStep: inLocale(locale, '주문 단위', 'Order step', '订购单位', '訂購單位'),
        leadDays: inLocale(locale, '등록 납기', 'Registered lead time', '登记交货周期', '登記交貨週期'),
      };
      const facts = {
        supplier: supplierName(snapshot, purchase.supplierId, locale),
        unitPrice: `${tr.money(purchase.unitPrice)}/${unitSymbol}`,
        minimumQty: tr.format.quantity(purchase.minimumQty, unit),
        orderStep: tr.format.quantity(purchase.orderStep, unit),
        leadDays: tr.format.quantity(purchase.leadDays, 'day'),
      };
      const field = asked === 'products' ? 'supplier' : asked;
      if (field === 'supplier' || field === 'unitPrice' || field === 'minimumQty' || field === 'orderStep' || field === 'leadDays') {
        return `${found.label} · ${caption[field]} ${facts[field]}`;
      }
      // Without a named fact the answer is the row the purchase-items tab shows.
      return [found.label, ...(['supplier', 'unitPrice', 'minimumQty', 'orderStep', 'leadDays'] as const).map(key => `${caption[key]} ${facts[key]}`)].join(' · ');
    },
  };
}

export interface SupplierOrderForm { readonly id: string; readonly qty: number; readonly dueDate?: string; readonly suggestionItemId?: string }
export function supplierDetailEntry(ref: DetailRef, snapshot: DataSnapshot) {
  const payload = ref.prefill?.kind === 'widget-draft' && ['ui.openDetail', 'suppliers.createOrder', 'supplier.sendOrder'].includes(ref.prefill.command)
    ? ref.prefill.fields : undefined;
  const fields = payload && validateAgentPrefill(featureId, payload) ? payload : undefined;
  const purchases = snapshot.tables.purchaseItem.filter(p => inventoryItem(snapshot, p.itemId));
  const purchase = purchases.find(p => p.purchaseItemId === fields?.purchaseItemId);
  const legacySupplierForm = ref.view === 'register' && !fields;
  const tab = ref.view === 'purchase-items' ? 'items' : ref.view === 'suppliers' || legacySupplierForm ? 'suppliers' : 'orders';
  const supplierForm = tab === 'suppliers' && (ref.focus === 'action' || legacySupplierForm);
  const orderForm: SupplierOrderForm | undefined = tab === 'orders' && (ref.view === 'register' || ref.focus === 'action') && purchases.length && (!fields?.purchaseItemId || purchase)
    ? { id: (purchase ?? purchases[0]).purchaseItemId,
      qty: purchase && typeof fields?.qty === 'number' ? fields.qty : (purchase ?? purchases[0]).minimumQty,
      ...(typeof fields?.dueDate === 'string' && fields.dueDate >= TODAY ? { dueDate: fields.dueDate } : {}) }
    : undefined;
  const orderId = tab === 'orders' && ref.itemId && currentOrders(snapshot).orders.some(order => order.poId === ref.itemId) ? ref.itemId : undefined;
  const purchaseItemId = tab === 'items' && purchases.some(p => p.purchaseItemId === ref.itemId) ? ref.itemId : undefined;
  const supplierId = tab === 'suppliers' && liveSuppliers(snapshot).some(s => s.supplierId === ref.itemId) ? ref.itemId : undefined;
  return { tab, supplierForm, ...(orderForm ? { orderForm } : {}), orderId, purchaseItemId, supplierId } as const;
}

type SupplierDraft = { readonly command: SupplierCommand; readonly locale: Locale };
const supplierKinds: readonly SupplyKind[] = ['purchaseItem', 'supplier', 'purchaseOrder', 'purchaseOrderLine'];
const targetKinds: Readonly<Record<string, string>> = {
  purchaseItemId: 'purchaseItem', supplierId: 'supplier', poId: 'purchaseOrder', polId: 'purchaseOrderLine',
  itemId: 'stock', suggestionItemId: 'stock',
};
const localText = (value: unknown): value is string => typeof value === 'string' && value.length <= 500 && !!value.trim();
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const slots = {
  name: localText, contact: localText, phone: localText, memo: (value: unknown) => value === null || typeof value === 'string' && value.length <= 500,
  minimumQty: finite, orderStep: finite, unitPrice: finite, leadDays: finite, qty: finite, date: localText, dueDate: localText,
};

function resolveSupplierArgs(wire: unknown, locals: LocalSlots, targets: RecordTargets, nested = false): Record<string, unknown> | undefined {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return;
  const args: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(wire)) {
    if (field === 'patch' && !nested) {
      const patch = resolveSupplierArgs(value, locals, targets, true);
      if (!patch) return;
      args.patch = patch;
    } else if (value && typeof value === 'object' && 'handle' in value && typeof value.handle === 'string') {
      const selected = targets.get(value.handle);
      if (!selected || selected.kind !== targetKinds[field]) return;
      args[field] = selected.id;
    } else if (value && typeof value === 'object' && 'slot' in value && value.slot === field && Object.hasOwn(locals, field)) {
      args[field] = locals[field];
    } else return;
  }
  return args;
}

function simulate(snapshot: DataSnapshot, command: SupplierCommand, idempotencyKey: string) {
  let seq = snapshot.seq;
  const ctx = { snapshot, tables: snapshot.tables, nextId: (prefix: string) => `navis-${prefix}-${++seq}` };
  switch (command.type) {
    case 'suppliers.createOrder': return handlers[command.type](ctx, { ...command, idempotencyKey });
    case 'suppliers.recordReceipt': return handlers[command.type](ctx, { ...command, idempotencyKey });
    case 'suppliers.createPurchaseItem': return handlers[command.type](ctx, { ...command, idempotencyKey });
    case 'suppliers.createSupplier': return handlers[command.type](ctx, { ...command, idempotencyKey });
    case 'suppliers.changeDueDate': return handlers[command.type](ctx, command);
    case 'suppliers.cancelOrder': return handlers[command.type](ctx, command);
    case 'suppliers.updatePurchaseItem': return handlers[command.type](ctx, command);
    case 'suppliers.deletePurchaseItem': return handlers[command.type](ctx, command);
    case 'suppliers.updateSupplier': return handlers[command.type](ctx, command);
    case 'suppliers.deleteSupplier': return handlers[command.type](ctx, command);
  }
}

function previewChanges(command: SupplierCommand, before: DataSnapshot, after: DataSnapshot, locale: Locale) {
  const tr = text(locale), fields: { label: string; before: string; after: string }[] = [];
  const add = (label: string, prior?: string, next?: string) => {
    const before = prior?.trim() || '—', after = next?.trim() || '—';
    if (before !== after) fields.push({ label, before, after });
  };
  const localized = (ko: string, en: string, hans: string, hant: string) => inLocale(locale, ko, en, hans, hant);
  const supplierLabel = localized('발주사', 'Supplier', '供应商', '供應商');
  const orderLabel = localized('발주 상태', 'Order status', '订单状态', '訂單狀態');
  const findPurchase = (snapshot: DataSnapshot) => snapshot.tables.purchaseItem.find(purchase =>
    'purchaseItemId' in command ? purchase.purchaseItemId === command.purchaseItemId : 'itemId' in command && purchase.itemId === command.itemId);
  function finish(target: string) { return { title: target, target, fields }; }
  if (command.type === 'suppliers.createPurchaseItem' || command.type === 'suppliers.updatePurchaseItem' || command.type === 'suppliers.deletePurchaseItem') {
    const a = findPurchase(before), b = findPurchase(after), row = b ?? a;
    if (!row) return;
    const item = inventoryItem(after, row.itemId);
    if (!item) return;
    const quantity = (p: Purchase | undefined, field: 'minimumQty' | 'orderStep') => p ? tr.format.quantity(p[field], purchaseUnit(after, p)) : undefined;
    add(supplierLabel, a && supplierName(before, a.supplierId, locale), b && supplierName(after, b.supplierId, locale));
    add(localized('단가', 'Unit price', '单价', '單價'), a && tr.money(a.unitPrice), b && tr.money(b.unitPrice));
    add(localized('최소 주문', 'Minimum order', '最低订购量', '最低訂購量'), quantity(a, 'minimumQty'), quantity(b, 'minimumQty'));
    add(localized('주문 단위', 'Order increment', '订购单位', '訂購單位'), quantity(a, 'orderStep'), quantity(b, 'orderStep'));
    add(localized('납기', 'Lead time', '交货周期', '交貨週期'), a && tr.format.quantity(a.leadDays, 'day'), b && tr.format.quantity(b.leadDays, 'day'));
    return finish(tr.name(item));
  }
  if (command.type === 'suppliers.createSupplier' || command.type === 'suppliers.updateSupplier' || command.type === 'suppliers.deleteSupplier') {
    const target = command.type === 'suppliers.createSupplier'
      ? liveSuppliers(after).find(row => !before.tables.supplier.some(old => old.supplierId === row.supplierId))?.supplierId
      : command.supplierId;
    const find = (snapshot: DataSnapshot) => liveSuppliers(snapshot).find(row => row.supplierId === target);
    const a = find(before), b = find(after);
    const value = (row: Supplier | undefined, field: 'contact' | 'memo') => {
      const source = row && (field === 'contact' ? row.contact ?? (row.contactKey ? { key: row.contactKey } : undefined) : row.memo);
      return source ? tr.data(source) : undefined;
    };
    add(supplierLabel, a && tr.name(a), b && tr.name(b));
    add(localized('담당', 'Contact person', '联系人', '聯絡人'), value(a, 'contact'), value(b, 'contact'));
    add(tr.supply('widget.suppliers.contact'), a?.phoneMask, b?.phoneMask);
    if (a?.phone !== b?.phone && a?.phoneMask === b?.phoneMask && b?.phone) {
      add(tr.supply('widget.suppliers.contact'), undefined, b.phoneMask);
    }
    add(localized('메모', 'Note', '备注', '備註'), value(a, 'memo'), value(b, 'memo'));
    return a || b ? finish(tr.name(b ?? a!)) : undefined;
  }
  const orderId = command.type === 'suppliers.createOrder'
    ? after.tables.purchaseOrder.find(row => !before.tables.purchaseOrder.some(old => old.poId === row.poId))?.poId
    : command.type === 'suppliers.recordReceipt' ? before.tables.purchaseOrderLine.find(row => row.polId === command.polId)?.poId : command.poId;
  const a = currentOrders(before).orders.find(row => row.poId === orderId);
  const b = currentOrders(after).orders.find(row => row.poId === orderId);
  if (!b) return;
  add(orderLabel, a && orderStatus(a, locale), orderStatus(b, locale));
  add(tr.supply('widget.suppliers.due'), dateText(a?.dueDate ?? null, locale), dateText(b.dueDate, locale));
  if (command.type === 'suppliers.createOrder') {
    add(supplierLabel, undefined, supplierName(after, b.supplierId, locale));
    add(tr.supply('widget.suppliers.col.ordered'), undefined, b.lines.map(line => tr.format.quantity(line.ordered, line.unit)).join(' · '));
    add(localized('총 주문 금액', 'Order total', '订单总额', '訂單總額'), undefined, tr.money(b.total));
  }
  if (command.type === 'suppliers.recordReceipt') {
    const beforeLine = a?.lines.find(line => line.polId === command.polId), line = b.lines.find(line => line.polId === command.polId);
    if (!beforeLine || !line) return;
    add(tr.supply('widget.suppliers.col.received'), undefined, tr.format.quantity(command.qty, line.unit));
    add(tr.supply('widget.suppliers.col.remaining'), tr.format.quantity(beforeLine.remaining, line.unit), tr.format.quantity(line.remaining, line.unit));
    const stock = (state: DataSnapshot) => deriveStock(state, { date: TODAY }).rows.find(row => row.itemId === line.itemId);
    const first = stock(before), last = stock(after);
    add(localized('현재 재고', 'Current stock', '当前库存', '目前庫存'),
      first && tr.format.quantity(first.stock, first.unit), last && tr.format.quantity(last.stock, last.unit));
    add(localized('지출 후보', 'Expense candidate', '待确认支出', '待確認支出'), undefined, tr.money(Math.round(command.qty * line.unitPrice)));
  }
  return finish(orderName(b, locale));
}

const keysRequired: readonly CommandName[] = ['suppliers.createOrder', 'suppliers.createPurchaseItem', 'suppliers.createSupplier', 'suppliers.recordReceipt'];
function makeCommand(commandName: CommandName, allowLocalScheduling: boolean): CommandAdapter<SupplierCommand, SupplierDraft> {
  return {
    command: commandName, featureId, slots,
    resolve(wire, locals, _snapshot, targets) {
      if (!validateAgentDraft(commandName, wire)) return;
      const args = resolveSupplierArgs(wire, locals, targets);
      if (!args || !validateAgentCommandArgs(commandName, args)) return;
      const locale = locals.navisLocale;
      return { command: { type: commandName, ...args } as SupplierCommand,
        locale: locale === 'en' || locale === 'zh-Hans' || locale === 'zh-Hant' ? locale : 'ko' };
    },
    preflight({ command, locale }, { snapshot, idempotencyKey }) {
      const newPrice = command.type === 'suppliers.createPurchaseItem' ? command.unitPrice
        : command.type === 'suppliers.updatePurchaseItem' ? command.patch.unitPrice : undefined;
      if (newPrice !== undefined && newPrice <= 0) return { kind: 'invalid', field: 'unitPrice' };
      if (command.type === 'suppliers.createOrder') {
        if (!allowLocalScheduling) return { kind: 'invalid' };
        const purchase = snapshot.tables.purchaseItem.find(row => row.purchaseItemId === command.purchaseItemId);
        if (purchase && purchase.unitPrice <= 0) return { kind: 'invalid', field: 'unitPrice' };
        if (command.suggestionItemId) {
          const suggestion = readModel(snapshot, featureId).suggestions.find(row =>
            row.itemId === command.suggestionItemId && row.purchaseItemId === command.purchaseItemId);
          if (!suggestion || suggestion.qty !== command.qty || suggestion.dueDate !== command.dueDate) {
            return { kind: 'conflict', field: 'suggestionItemId' };
          }
        }
      }
      if (command.type === 'suppliers.changeDueDate' && currentOrders(snapshot).open.find(order => order.poId === command.poId)?.dueDate === command.date) return { kind: 'unchanged' };
      const outcome = simulate(snapshot, command, idempotencyKey);
      if (!outcome.ok) return { kind: outcome.code === 'CONFLICT' ? 'conflict' : 'invalid', field: outcome.field, messageKey: outcome.messageKey };
      if (outcome.tables === snapshot.tables) return { kind: 'unchanged' };
      const preview = previewChanges(command, snapshot, { ...snapshot, tables: outcome.tables }, locale);
      if (!preview?.fields.length) return { kind: 'unchanged' };
      const dispatch = keysRequired.includes(command.type) ? { ...command, idempotencyKey } : command;
      return { kind: 'ready', command: dispatch, preview };
    },
    undoToken: result => result.undoToken,
  };
}

const negated = /하지\s*마|말아|하지\s*않|무시|ignore\s+|\b(?:don't|never|do not)\b/iu;
const supplierWords = /거래처|공급처|발주사/u;
const orderWords = /발주|주문|시켜/u;
const intakeWords = /입고|도착|들어오|들어왔|받았|받아|왔어|왔다|오는/u;
const editWords = /바꿔|바꾸|수정|변경|고쳐|올려|미뤄|미룰|낮춰|해\s*줘|으로$|로$|받을래|뒤에\s*와|올랐|시킬게/u;
const removeWords = /삭제|지워|없애|빼\s*줘/u;
const addWords = /추가|등록|새로|만들|넣어/u;
const question = /얼마|몇|뭐|어디|알려|있나|있어\?|해\?/u;
const supplierList = /발주사\s*(?:어디|목록)|거래처\s*(?:목록|뭐)/u;
const openWords = /열어|띄워|보여|화면|출처|어디서\s*고치|탭/u;

function mention(names: readonly string[], raw: string) {
  const core = normalize(raw);
  const aliases = names.flatMap(name => {
    const words = name.split(/[\s·ㆍ]+/u).filter(Boolean);
    const meaningful = words.filter(word => ([...word].length >= 2 || word === '컵') && !['세트', '수량'].includes(word));
    return [name, ...meaningful];
  });
  return [...new Set(aliases)].sort((a, b) => normalize(b).length - normalize(a).length)
    .find(name => {
      if (shortName(name) !== name || /[·ㆍ]/u.test(name)) return core.includes(normalize(name));
      const escaped = name.replace(/[.*+?^$${}()|[\]\\]/gu, '\\$&');
      return new RegExp(`(?:^|[^\\p{L}\\d])${escaped}(?=$|[^\\p{L}\\d]|은|는|이|가|을|를|에|부터|값)`, 'iu').test(raw);
    });
}
function itemMention(snapshot: DataSnapshot, value: string, locale: Locale) {
  const tr = text(locale);
  return mention(snapshot.tables.inventoryItem.filter(row => !row.deletedAt).flatMap(row => [tr.name(row), ...(row.sku ? [row.sku] : [])]), value);
}
function supplierMention(snapshot: DataSnapshot, value: string, locale: Locale) {
  return mention(liveSuppliers(snapshot).map(row => text(locale).name(row)), value);
}
const namedSupplier = (snapshot: DataSnapshot, value: string, locale: Locale) =>
  supplierMention(snapshot, value.split(/(?:이름(?:을)?\s+|→)/u)[0], locale) ?? value.match(/(?:[A-Z]|에이|비|씨|디)(?:유통|로스터리|포장|베이커리|농산)/iu)?.[0];
function explicitQty(value: string) {
  const half = /(?<![\p{L}\d])([일이삼사오육칠팔구십백천]+|한|두|세|네|\d+)\s*리터\s*반/u.exec(value);
  const whole = half && parseNavisNumber(half[1]);
  return typeof whole === 'number' ? { value: whole + 0.5, unit: 'L' as const } : parseNavisQuantity(value);
}
function toPurchaseQty(amount: ReturnType<typeof explicitQty>, unit: UnitCode, basePerUnit?: number) {
  if (!amount) return;
  if (amount.unit === unit) return amount.value;
  if (amount.unit !== 'pcs' && amount.unit !== 'g' && amount.unit !== 'kg' && amount.unit !== 'mL' && amount.unit !== 'L') return;
  if (unitDimension(amount.unit) !== unitDimension(unit)) return;
  const base = toBase(amount.value, amount.unit);
  return base === null ? undefined : basePerUnit ? base / basePerUnit : fromBase(base, unit);
}
const pastDate = (value: string) => /지난\s*주|저번\s*주/u.test(value);
const explicitDate = /\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}[-./]\d{1,2}|[월화수목금토일]요일|어제|그저께|오늘|내일|모레|글피|(?:이번|다음|지난|저번)\s*달/u;
const withoutDecimalQty = (value: string) => value.replace(/(?<![\d.])\d+\.\d+\s*(?:리터|밀리리터|개|kg|mL|L|g\b)/giu, '');
const destinationDate = (value: string) => parseNavisDate(withoutDecimalQty(value), TODAY);
const readWidget = (...factKeys: string[]): DomainTurnInput => ({ intent: { kind: 'read', featureId }, factKeys });
const readRecord = (recordKind: SupplyKind, querySlot: string, query: string): DomainTurnInput =>
  ({ intent: { kind: 'read', recordKind, querySlot }, slots: { [querySlot]: query } });
type PurchaseAspect = 'unitPrice' | 'minimumQty' | 'orderStep' | 'leadDays' | 'supplier' | 'products' | 'summary';
/** A purchase-item fact read: the wire lookup is always `name`, the asked fact is the local `aspect`. */
const readPurchaseItem = (query: string, aspect: PurchaseAspect, extra: { readonly browse?: boolean; readonly missing: string }): DomainTurnInput & { readonly aspect: PurchaseAspect } => ({
  intent: { kind: 'read', recordKind: 'purchaseItem', querySlot: 'name' }, slots: { name: query }, aspect,
  ...(extra.browse ? { browse: true } : {}), onMissing: { answer: extra.missing },
});
/** A receipt that names no known order is refused after a scoped lookup, but only when the reviewed selector finds zero order rows. */
function unmatchedReceipt(snapshot: DataSnapshot, locale: Locale, value: string, supplier: string | undefined, fallback: string | undefined): DomainRoute {
  const noOrder = inLocale(locale, '해당 발주 내역이 없어요', 'No matching order', '未找到该订单', '未找到該訂單');
  const subject = receiptSubject(value, supplier) ?? fallback;
  if (subject && !findRows(supplierRows(snapshot, locale, 'purchaseOrder'), subject, true, locale).length) {
    return { ...readRecord('purchaseOrder', 'name', subject), onMissing: { answer: noOrder, reason: 'invalid_target' } };
  }
  return refuse('invalid_target', noOrder);
}
/** First plain word of a receipt phrase once the supplier, the quantity and the receipt verbs are removed. */
function receiptSubject(value: string, supplier: string | undefined) {
  const rest = (supplier ? value.replace(supplier, ' ') : value).replace(/\d[\d.,]*\s*[가-힣A-Za-z]*/gu, ' ')
    .replace(/입고|처리|확인|기록|도착했어|도착|왔어|받았어|됐어|했어|해\s*줘|일부|전부|먼저/gu, ' ');
  return rest.split(/\s+/u).map(token => token.replace(/(?<=[가-힣]{2})(?:은|는|이|가|을|를)$/u, '')).find(token => [...token].length >= 2);
}

const lookup = (kind: DomainLookup['kind'], querySlot: string, ...bind: string[]): DomainLookup => ({ kind, querySlot, ...(bind.length ? { bind } : {}) });
function turn(command: CommandName, locale: Locale, values: LocalSlots, queries: LocalSlots, lookups: readonly DomainLookup[], patch = false): DomainTurnInput {
  const refs = Object.fromEntries(Object.keys(values).map(field => [field, { slot: field }]));
  const args = patch ? { patch: refs } : refs;
  return { intent: { kind: 'command', command, args, ...(lookups[0] ? { querySlot: lookups[0].querySlot } : {}) },
    slots: { ...values, ...queries, navisLocale: locale }, lookups };
}
function clarify(field: string, answer: string, resume?: (value: string) => DomainRoute | undefined): DomainRoute {
  return { kind: 'clarification', field, answer, resume };
}
function refuse(reason: AgentRefusal['reason'], answer: string): DomainRoute {
  return { kind: 'refusal', reason, answer };
}

function editSupplier(snapshot: DataSnapshot, value: string, locale: Locale, name: string | undefined): DomainRoute {
  const l = (ko: string, en: string, hans: string, hant: string) => inLocale(locale, ko, en, hans, hant);
  const commandLookup = lookup('supplier', 'target', 'supplierId');
  if (removeWords.test(value)) {
    if (!name) return clarify('supplierId', l('어느 발주사를 지울까요?', 'Which supplier?', '要删除哪个供应商？', '要刪除哪個供應商？'));
    const rows = findRows(supplierRows(snapshot, locale, 'supplier'), name, false);
    if (!rows.length) return refuse('invalid_target', l('등록된 발주사가 없어요', 'Supplier not found', '未找到供应商', '未找到供應商'));
    return turn('suppliers.deleteSupplier', locale, {}, { target: name }, [commandLookup]);
  }
  const newSupplier = addWords.test(value.split(/메모/u)[0]) && supplierWords.test(value) && !/전화번호.*바꿔/u.test(value);
  const contact = value.match(/담당(?:자)?[은를]?\s+([^\s]+?)(?:으로|로)?(?=\s|$)/u)?.[1] ?? (newSupplier ? value.match(/추가\s+([^\s]+)\s+0\d/u)?.[1] : undefined);
  const phone = value.match(/(?<!\d)0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}(?!\d)/u)?.[0].replace(/\D/gu, '');
  const memo = value.match(/메모(?:에|는)?\s*:?\s*(?:['‘“"]([^'’”"]+)['’”"]|(.+))/u);
  const note = (memo?.[1] ?? memo?.[2])?.replace(/\s+(?:남겨|적어|써)\s*줘.*$/u, '').trim();
  if (newSupplier) {
    const selected = name ?? value.match(/(?:새\s*)?(?:발주사|거래처)\s+([^\s]+)\s+(?:추가|등록)/u)?.[1];
    if (!selected) return clarify('name', l('발주사 이름이 뭐예요?', 'What is the supplier name?', '供应商叫什么？', '供應商叫什麼？'),
      next => editSupplier(snapshot, value, locale, next));
    if (findRows(supplierRows(snapshot, locale, 'supplier'), selected, false).some(row => normalize(row.label) === normalize(selected))) {
      return clarify('duplicate', l('이미 등록된 발주사예요', 'That supplier already exists', '供应商已登记', '供應商已登記'));
    }
    if (!contact) return clarify('contact', l('담당자 이름이 뭐예요?', 'Who is the contact?', '联系人是谁？', '聯絡人是誰？'),
      next => editSupplier(snapshot, `${value} 담당자 ${next}`, locale, selected));
    if (!phone) return clarify('phone', l('연락처가 뭐예요?', 'What is the phone number?', '电话号码是什么？', '電話號碼是什麼？'),
      next => editSupplier(snapshot, `${value} 연락처 ${next}`, locale, selected));
    return turn('suppliers.createSupplier', locale, { name: selected, contact, phone, ...(note ? { memo: note } : {}) }, { target: selected }, [lookup('supplier', 'target')]);
  }
  if (!name) return clarify('supplierId', l('어느 발주사를 고칠까요?', 'Which supplier?', '要修改哪个供应商？', '要修改哪個供應商？'));
  const replacement = value.match(/(?:이름(?:을)?\s+|→\s*)([^\s]+?)(?:으로|로)?(?=\s|$)/u)?.[1];
  const patch = { ...(contact ? { contact } : {}), ...(phone ? { phone } : {}), ...(note ? { memo: note } : {}),
    ...(replacement && !/변경|바꿔|수정/u.test(replacement) ? { name: replacement } : {}) };
  if (!Object.keys(patch).length) return clarify('patch', l('무엇을 고칠까요?', 'What should I change?', '要修改什么？', '要修改什麼？'));
  if (!findRows(supplierRows(snapshot, locale, 'supplier'), name, false).length) {
    return refuse('invalid_target', l('등록된 발주사가 없어요', 'Supplier not found', '未找到供应商', '未找到供應商'));
  }
  return turn('suppliers.updateSupplier', locale, patch, { target: name },
    [commandLookup, ...(patch.name ? [lookup('supplier', 'name')] : [])], true);
}

function purchaseValues(value: string) {
  const money = navisMoneySpans(value).at(-1)?.value;
  const minimum = value.match(/(?:최소(?:\s*주문(?:\s*수량)?)?|MOQ)\s*(?:을|이|는)?\s*([\d,.]+)(?![\d,.])/iu)?.[1];
  const step = (value.match(/(?:주문\s*)?단위\s*(?:를|는)?\s*([\d,.]+)(?![\d,.])/u) ?? value.match(/([\d,.]+)\s*개\s*단위/u))?.[1];
  const lead = value.match(/(\d+)\s*일/u)?.[1];
  const slash = value.match(/\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*일/u);
  return { unitPrice: slash ? Number(slash[1]) : /원\s*반/u.test(value) ? undefined : money,
    minimumQty: slash ? Number(slash[2]) : minimum ? parseNavisNumber(minimum) : undefined,
    orderStep: slash ? Number(slash[3]) : step ? parseNavisNumber(step) : undefined,
    leadDays: slash ? Number(slash[4]) : lead ? Number(lead) : undefined };
}

function editPurchase(snapshot: DataSnapshot, value: string, locale: Locale, item: string, supplier: string | undefined): DomainRoute {
  const l = (ko: string, en: string, hans: string, hant: string) => inLocale(locale, ko, en, hans, hant);
  const rows = findRows(supplierRows(snapshot, locale, 'purchaseItem'), item, false);
  const query = { name: item };
  const target = lookup('purchaseItem', 'name', 'purchaseItemId');
  if (/발주\s*품목/u.test(value) && removeWords.test(value)) {
    if (rows.length === 1 && rows[0].fields.referenced) return refuse('invalid_target',
      l('레시피에 쓰는 발주 품목이라 지울 수 없어요', 'A recipe uses this purchase item', '食谱使用此采购品项', '食譜使用此採購品項'));
    return turn('suppliers.deletePurchaseItem', locale, {}, query, [target]);
  }
  const creating = /발주\s*품목/u.test(value) && addWords.test(value);
  const fields = purchaseValues(value);
  const priceQuestion = l('단가를 얼마로 할까요?', 'What unit price?', '单价是多少？', '單價是多少？');
  const supplierLookup = lookup('supplier', 'supplierId', ...(creating ? ['supplierId'] : ['patch', 'supplierId']));
  if (creating) {
    if (rows.length && rows.some(row => normalize(row.label) === normalize(item)) || rows.length === 1 && item === shortName(rows[0].label)) {
      return refuse('duplicate', l('이미 등록된 발주 품목이에요', 'This purchase item already exists', '采购品项已登记', '採購品項已登記'));
    }
    if (!supplier || !findRows(supplierRows(snapshot, locale, 'supplier'), supplier, false).length) {
      return clarify('supplierId', l('어느 발주사에서 받을까요?', 'Which supplier?', '从哪个供应商订购？', '從哪個供應商訂購？'),
        next => editPurchase(snapshot, value, locale, item, next));
    }
    if (fields.unitPrice === undefined || !Number.isSafeInteger(fields.unitPrice) || fields.unitPrice <= 0) return clarify('unitPrice', priceQuestion);
    if (fields.minimumQty === undefined) return clarify('minimumQty', l('최소 주문 수량은 얼마예요?', 'What is the minimum quantity?', '最低订购量是多少？', '最低訂購量是多少？'));
    if (fields.orderStep === undefined) return clarify('orderStep', l('주문 단위는 얼마예요?', 'What is the order increment?', '订购单位是多少？', '訂購單位是多少？'));
    if (fields.leadDays === undefined) return clarify('leadDays', l('입고까지 며칠 걸려요?', 'How many days to delivery?', '几天到货？', '幾天到貨？'));
    return turn('suppliers.createPurchaseItem', locale, fields, { ...query, supplierId: supplier },
      [lookup('stock', 'name', 'itemId'), lookup('purchaseItem', 'name'), supplierLookup]);
  }
  if (supplier && (supplierWords.test(value) || /받을래/u.test(value))) {
    if (!findRows(supplierRows(snapshot, locale, 'supplier'), supplier, false).length) return refuse('invalid_target',
      l('등록된 발주사가 없어요', 'Supplier not found', '未找到供应商', '未找到供應商'));
    return turn('suppliers.updatePurchaseItem', locale, {}, { ...query, supplierId: supplier }, [target, supplierLookup], true);
  }
  if (/단가|우유값/u.test(value)) {
    if (fields.unitPrice === undefined || !Number.isSafeInteger(fields.unitPrice) || fields.unitPrice <= 0) return clarify('unitPrice', priceQuestion,
      next => editPurchase(snapshot, `${item} 단가 ${next.replace(/원$/u, '')}원으로 변경`, locale, item, undefined));
    return turn('suppliers.updatePurchaseItem', locale, { unitPrice: fields.unitPrice }, query, [target], true);
  }
  for (const name of ['minimumQty', 'orderStep', 'leadDays'] as const) {
    const amount = fields[name];
    if (amount !== undefined) return turn('suppliers.updatePurchaseItem', locale, { [name]: amount }, query, [target], true);
  }
  return clarify('patch', l('어떤 발주 조건을 고칠까요?', 'Which purchase condition?', '要修改哪个采购条件？', '要修改哪個採購條件？'));
}

function routeOrder(snapshot: DataSnapshot, value: string, locale: Locale, item: string | undefined, supplier: string | undefined, allowLocalScheduling: boolean,
  correction: { qty?: string; date?: string } = {}): DomainRoute {
  const tr = text(locale);
  const l = (ko: string, en: string, hans: string, hant: string) => inLocale(locale, ko, en, hans, hant);
  const askItem = l('어느 품목을 발주할까요?', 'Which item should I order?', '要订购哪个品项？', '要訂購哪個品項？');
  const askQty = l('수량이 얼마예요?', 'What quantity?', '数量是多少？', '數量是多少？');
  const missing = l('등록된 발주 품목이 없어요', 'Purchase item not found', '未找到采购品项', '未找到採購品項');
  const fromSuggestion = /제안/u.test(value);
  if (fromSuggestion) {
    const suggestions = readModel(snapshot, featureId).suggestions.filter(row => {
      const stock = inventoryItem(snapshot, row.itemId);
      return !item || stock && nameMatches(item, tr.name(stock));
    });
    if (!suggestions.length) return readWidget(keys.suggestionStatus);
    if (suggestions.length > 1) return clarify('purchaseItem', askItem, next => routeOrder(snapshot, value, locale, next, supplier, allowLocalScheduling));
    const [suggestion] = suggestions;
    const stock = inventoryItem(snapshot, suggestion.itemId);
    if (!stock) return refuse('invalid_target', missing);
    const name = tr.name(stock);
    if (!allowLocalScheduling) return readWidget(keys.suggestion);
    return turn('suppliers.createOrder', locale, { qty: suggestion.qty, dueDate: suggestion.dueDate }, { name },
      [lookup('purchaseItem', 'name', 'purchaseItemId'), lookup('stock', 'name', 'suggestionItemId')]);
  }
  if (!item) {
    if (!supplier && /^\S+\s+.+(?:발주|주문|시켜)/u.test(value) && !/^(?:새|그냥|한|발주|주문)/u.test(value)) return refuse('invalid_target', missing);
    return clarify('purchaseItem', askItem, next => routeOrder(snapshot, value, locale, next, supplier, allowLocalScheduling));
  }
  const query = supplier ? `${item}\n${supplier}` : item;
  const filtered = findRows(supplierRows(snapshot, locale, 'purchaseItem'), query, false);
  if (!filtered.length) return refuse('invalid_target', missing);
  if (filtered.length > 1) return clarify('purchaseItem', askItem, next => routeOrder(snapshot, value, locale, next, supplier, allowLocalScheduling));
  const purchase = snapshot.tables.purchaseItem.find(p => p.purchaseItemId === filtered[0].id)!;
  if (purchase.unitPrice <= 0) return refuse('unavailable', '발주 품목의 단가를 확인해 주세요');
  const unit = purchaseUnit(snapshot, purchase), qty = toPurchaseQty(explicitQty(correction.qty ?? value), unit, purchase.basePerUnit);
  const resume = (next: string) => routeOrder(snapshot, value, locale, item, supplier, allowLocalScheduling, { ...correction, qty: next });
  if (!qty || qty < 0 || purchaseQuantityBase(qty, unit, purchase.basePerUnit) === null || !Number.isSafeInteger(Math.round(qty * purchase.unitPrice))) return clarify('qty', askQty, resume);
  const dateInput = correction.date ?? value;
  const dueDate = destinationDate(dateInput);
  if (dueDate && dueDate < TODAY || pastDate(dateInput)) return refuse('invalid_target', l('지난 날짜로 발주할 수 없어요', 'Choose a current or future date', '请选择今天或将来的日期', '請選擇今天或將來的日期'));
  const min = tr.format.quantity(purchase.minimumQty, unit), step = tr.format.quantity(purchase.orderStep, unit);
  if (qty < purchase.minimumQty) return clarify('qty', l(`최소 ${min}부터 주문할 수 있어요`, `Minimum order: ${min}`, `最低订购量：${min}`, `最低訂購量：${min}`), resume);
  if (Math.abs(qty / purchase.orderStep - Math.round(qty / purchase.orderStep)) > 1e-9) {
    return clarify('qty', l(`${step} 단위로 주문해 주세요`, `Order in increments of ${step}`, `请按 ${step} 的倍数订购`, `請按 ${step} 的倍數訂購`), resume);
  }
  if (!dueDate && (correction.date || explicitDate.test(withoutDecimalQty(dateInput)))) return clarify('dueDate',
    l('입고 예정일을 언제로 바꿀까요?', 'What is the new due date?', '到货日期改到哪天？', '到貨日期改到哪天？'),
    next => routeOrder(snapshot, value, locale, item, supplier, allowLocalScheduling, { ...correction, date: next }));
  const due = dueDate ?? addDays(TODAY, purchase.leadDays);
  const explicitEstimate = /초안|얼마|견적|하면|하면요/u.test(value);
  if (!allowLocalScheduling || explicitEstimate) {
    return readRecord('purchaseItem', 'estimate', `${normalizeNavisInput(filtered[0].label)}\n${qty}\n${due}`);
  }
  return turn('suppliers.createOrder', locale, { qty, dueDate: due }, { name: supplier ? `${filtered[0].label}\n${supplier}` : filtered[0].label },
    [lookup('purchaseItem', 'name', 'purchaseItemId')]);
}

function changeOrder(snapshot: DataSnapshot, value: string, locale: Locale, item: string | undefined, supplier: string | undefined,
  correction: { qty?: string; date?: string } = {}): DomainRoute {
  const l = (ko: string, en: string, hans: string, hant: string) => inLocale(locale, ko, en, hans, hant);
  const cancel = /취소|캔슬|없던\s*걸로/u.test(value);
  const source = value.match(/^(.*?)\s*(?:들어오는|오는)\s/u);
  const sourceDate = source && destinationDate(source[1]);
  const dateInput = correction.date ?? (source && sourceDate ? value.slice(source[0].length) : value);
  const dateChange = /날짜|입고일|예정일|도착일|날로|미뤄|미룰|변경|바꿔|수정/u.test(value) ||
    (destinationDate(dateInput) !== undefined || pastDate(dateInput)) && editWords.test(value);
  const query = item ?? supplier ?? value.match(/^([^\s]+)\s+(?:\S+\s+)*(?:발주|주문)/u)?.[1];
  const kind = cancel || dateChange ? 'purchaseOrder' : 'purchaseOrderLine';
  if (!cancel && /시간|(?:오전|오후)\s*\d|\d+\s*시/u.test(value) && /바꿔|수정|변경|미뤄/u.test(value)) {
    return refuse('unsupported', l('입고 예정일만 바꿀 수 있어요', 'Only the due date can be changed', '可修改到货日期', '可修改到貨日期'));
  }
  if (!query) return clarify('name', l('어느 발주 건인가요?', 'Which order?', '是哪笔订单？', '是哪筆訂單？'),
    next => changeOrder(snapshot, value, locale, next, supplier));
  const amount = explicitQty(correction.qty ?? value);
  const supplierFilter = item ? supplier ?? '' : '';
  const scope = cancel && amount ? `${query}\n${supplierFilter}\n${sourceDate ?? ''}\n${value}`
    : sourceDate ? `${query}\n${supplierFilter}\n${sourceDate}` : supplierFilter ? `${query}\n${supplierFilter}` : query;
  const matching = findRows(supplierRows(snapshot, locale, kind), scope, false, locale);
  const active = matching.filter(row => row.fields.open);
  const repeat = /한\s*번\s*더|또\s*기록|같은\s*입고/u.test(value);
  if (repeat && kind === 'purchaseOrderLine' && matching.some(row => {
    const line = snapshot.tables.purchaseOrderLine.find(candidate => candidate.polId === row.id);
    const unit = line?.unitSnapshot ?? (line && inventoryItem(snapshot, line.itemId)?.unit);
    const qty = unit && toPurchaseQty(amount, unit, line?.basePerUnit);
    return snapshot.tables.receipt.some(receipt => receipt.polId === row.id && receiptDate(receipt) === TODAY && (!amount || receipt.qty === qty));
  })) {
    return { kind: 'answer', answer: l('이미 입고를 기록했어요', 'Delivery already recorded', '已记录到货', '已記錄到貨') };
  }
  if (!active.length) {
    if (matching.length) return refuse('invalid_target', l('이미 끝난 발주예요', 'This order is closed', '订单已结束', '訂單已結束'));
    // A receipt with no order row is refused after a scoped lookup; cancel and date changes keep the local refusal.
    return kind === 'purchaseOrderLine' ? unmatchedReceipt(snapshot, locale, value, supplier, query)
      : refuse('invalid_target', l('해당 발주 내역이 없어요', 'No matching order', '未找到该订单', '未找到該訂單'));
  }
  const target = { name: scope };
  if (cancel) return turn('suppliers.cancelOrder', locale, {}, target, [lookup(kind, 'name', 'poId')]);
  if (dateChange) {
    const date = destinationDate(dateInput) ?? (!correction.date && /하루\s*미/u.test(dateInput) && active.length === 1 && typeof active[0].fields.date === 'string'
      ? addDays(active[0].fields.date, 1) : undefined);
    if (pastDate(dateInput) || date && date < TODAY) return refuse('invalid_target', l('지난 날짜로 바꿀 수 없어요', 'Choose a current or future date', '请选择今天或将来的日期', '請選擇今天或將來的日期'));
    if (!date) return clarify('date', l('입고 예정일을 언제로 바꿀까요?', 'What is the new due date?', '到货日期改到哪天？', '到貨日期改到哪天？'),
      next => changeOrder(snapshot, value, locale, item, supplier, { date: next }));
    if (active.length === 1 && active[0].fields.date === date) return { kind: 'answer', answer: l('이미 같은 날짜예요', 'The due date is already set', '日期已经相同', '日期已經相同') };
    return turn('suppliers.changeDueDate', locale, { date }, target, [lookup('purchaseOrder', 'name', 'poId')]);
  }
  const receiptQty = (row: Row) => {
    const line = snapshot.tables.purchaseOrderLine.find(line => line.polId === row.id);
    const unit = line?.unitSnapshot ?? (line && inventoryItem(snapshot, line.itemId)?.unit);
    return unit && toPurchaseQty(amount, unit, line?.basePerUnit);
  };
  const quantities = new Set(active.map(receiptQty));
  if (quantities.size > 1 || new Set(active.map(row => row.fields.unit)).size > 1) {
    return clarify('purchaseOrderLine', l('어느 발주 건인가요?', 'Which order?', '是哪笔订单？', '是哪筆訂單？'));
  }
  const line = active.length === 1 ? snapshot.tables.purchaseOrderLine.find(line => line.polId === active[0].id) : undefined;
  const unit = line?.unitSnapshot ?? (line ? inventoryItem(snapshot, line.itemId)?.unit : undefined);
  const [qty] = quantities;
  const remaining = active.length === 1 && typeof active[0].fields.remaining === 'number' ? active[0].fields.remaining : undefined;
  if (qty === undefined || qty < 1 || remaining !== undefined && qty > remaining) {
    const answer = qty !== undefined && remaining !== undefined && qty > remaining && unit
      ? l(`남은 수량은 ${text(locale).format.quantity(remaining, unit)}예요`, `Remaining: ${text(locale).format.quantity(remaining, unit)}`,
        `剩余：${text(locale).format.quantity(remaining, unit)}`, `剩餘：${text(locale).format.quantity(remaining, unit)}`)
      : l('얼마나 받았어요?', 'How much arrived?', '收到了多少？', '收到了多少？');
    return clarify('qty', answer, next => changeOrder(snapshot, value, locale, item, supplier, { qty: next }));
  }
  return turn('suppliers.recordReceipt', locale, { qty }, target, [lookup('purchaseOrderLine', 'name', 'polId')]);
}

export function supplierNavigation(input: string, snapshot: DataSnapshot, locale: Locale): DomainDetail | null | undefined {
  const value = normalizeNavisInput(input);
  if (supplierList.test(value) && !/열어|화면|탭/u.test(value)) return null;
  if (!openWords.test(value) || negated.test(value) || !/발주|입고|거래처|공급처|도착|들어오.*주문|오는.*보여/u.test(value)) return;
  if (/지난\s*발주|발주\s*끝난|완료된\s*발주/u.test(value) && !/탭|화면|열어/u.test(value)) return null;
  const item = itemMention(snapshot, value, locale), supplier = namedSupplier(snapshot, value, locale);
  if (/추가|새\s*발주|입력창|등록/u.test(value)) {
    if (supplierWords.test(value)) return { args: { featureId, view: 'register' } };
    if (item) {
      const [purchase, ...others] = findRows(supplierRows(snapshot, locale, 'purchaseItem'), item, false);
      if (purchase && !others.length) {
        const row = snapshot.tables.purchaseItem.find(p => p.purchaseItemId === purchase.id)!;
        const qty = toPurchaseQty(explicitQty(value), purchaseUnit(snapshot, row), row.basePerUnit);
        const dueDate = destinationDate(value);
        const prefill = { purchaseItemId: row.purchaseItemId, ...(qty && qty > 0 ? { qty } : {}), ...(dueDate && dueDate >= TODAY ? { dueDate } : {}) };
        return { args: { featureId, view: 'register', prefill } };
      }
    }
    const purchase = snapshot.tables.purchaseItem.find(p => inventoryItem(snapshot, p.itemId));
    return { args: purchase ? { featureId, view: 'register', prefill: { purchaseItemId: purchase.purchaseItemId } } : { featureId, view: 'orders' } };
  }
  if (/품목\s*탭|발주\s*품목.*(?:열어|상세)/u.test(value)) {
    const purchases = item ? findRows(supplierRows(snapshot, locale, 'purchaseItem'), item, false) : [];
    const purchase = purchases.length === 1 ? purchases[0] : undefined;
    return purchase ? { args: { featureId, view: 'purchase-items', itemId: purchase.id }, target: { kind: 'purchaseItem', id: purchase.id } }
      : { args: { featureId, view: 'purchase-items' } };
  }
  if (/발주사\s*탭|거래처\s*목록\s*화면|(?:발주사|거래처).*상세/u.test(value)) {
    const suppliers = supplier ? findRows(supplierRows(snapshot, locale, 'supplier'), supplier, false) : [];
    const row = suppliers.length === 1 ? suppliers[0] : undefined;
    return row ? { args: { featureId, view: 'suppliers', itemId: row.id }, target: { kind: 'supplier', id: row.id } }
      : { args: { featureId, view: 'suppliers' } };
  }
  const query = item ?? supplier;
  const overdue = /늦은|지연|밀린/u.test(value);
  if ((query || overdue) && /상세|열어|출처|어디서\s*고치|오늘|내일|오는|입고\s*예정|지연된/u.test(value)) {
    const { open, orders } = currentOrders(snapshot);
    const matches = overdue ? open.filter(order => order.overdue) : open.filter(order =>
      (!item || order.lines.some(line => nameMatches(item, lineName(line, locale)))) &&
      (!supplier || nameMatches(supplier, supplierName(snapshot, order.supplierId, locale))));
    const explicit = /오늘|내일|모레/u.test(value) ? destinationDate(value) : undefined;
    const selected = matches.filter(order => !explicit || order.dueDate === explicit);
    const history = item && /상세/u.test(value) ? orders.filter(order => order.lines.some(line => nameMatches(item, lineName(line, locale)))) : [];
    const order = selected.length === 1 ? selected[0] : !selected.length && history.length === 1 ? history[0] : undefined;
    if (order) return { args: { featureId, view: 'order', itemId: order.poId }, target: { kind: 'purchaseOrder', id: order.poId } };
    if (!selected.length || selected.length > 1) return { args: { featureId, view: 'orders' } };
  }
  if (/발주\s*(?:내역\s*)?(?:탭|상세|관리\s*화면)/u.test(value)) return { args: { featureId, view: 'orders' } };
}

function routeSupplier(input: string, snapshot: DataSnapshot, locale: Locale, allowLocalScheduling: boolean): DomainRoute | undefined {
  const value = normalizeNavisInput(input);
  if (negated.test(value) || /^(?:["'“‘])/u.test(value) || /위젯|패널|대시보드|보드/u.test(value)) return;
  if (supplierNavigation(value, snapshot, locale)) return;
  const item = itemMention(snapshot, value, locale), supplier = namedSupplier(snapshot, value, locale);
  const price = /(?:발주\s*)?단가|우유값|얼마에\s*받아/u.test(value);
  const purchaseCondition = /최소|MOQ|주문\s*단위|(?:몇|\d+)\s*개\s*단위|발주\s*품목|리드타임|소요일|납기|주문하면\s*\d+\s*일\s*뒤에/u.test(value);
  const isOrder = orderWords.test(value), isIntake = intakeWords.test(value);
  const l = (ko: string, en: string, hans: string, hant: string) => inLocale(locale, ko, en, hans, hant);
  if (/전송|보내\s*줘|공급처에\s*연락/u.test(value) && isOrder) {
    return { kind: 'refusal', reason: 'widget_only', alternative: { featureId, command: 'supplier.sendOrder' },
      answer: l('발주 화면에서 진행해 주세요', 'Continue in the orders screen', '请在采购页面操作', '請在採購頁面操作') };
  }
  if (/입고\s*확인\s*필요|안\s*들어온|지연된\s*발주|늦은\s*발주/u.test(value)) return readWidget(keys.overdue, keys.overdueRow);
  if (/이번\s*달/u.test(value) && isOrder && /얼마|총액|몇\s*건/u.test(value)) return readWidget(keys.monthCount, keys.monthTotal);
  if (isOrder && /제안|해야\s*(?:할|돼)|발주할\s*거/u.test(value) && (question.test(value) || !/해줘|넣어|주문해/u.test(value))) {
    return readWidget(keys.suggestion, keys.suggestionStatus);
  }
  if (supplierList.test(value)) return readWidget(keys.supplier);
  if (/지난\s*발주|발주\s*끝난|완료된\s*발주/u.test(value)) return readWidget(keys.history);
  if ((isOrder || isIntake) && /언제\s*(?:들어왔|받았)/u.test(value)) {
    const target = item ?? value.split(/\s+발주/u)[0];
    return readRecord('purchaseOrder', 'receiptHistory', target);
  }
  if (/예정/u.test(value) && isIntake && question.test(value)) return readWidget(keys.upcoming, keys.upcomingRow);
  if (/연락처|전화(?:번호)?|번호/u.test(value) && (supplier || supplierWords.test(value)) && !editWords.test(value) && !addWords.test(value) && !/0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}/u.test(value)) {
    return supplier ? readRecord('supplier', 'contact', supplier)
      : clarify('supplierId', l('어느 발주사 연락처를 볼까요?', 'Which supplier’s number?', '要查看哪个供应商的号码？', '要查看哪個供應商的號碼？'),
        next => readRecord('supplier', 'contact', next));
  }
  const unregisteredItem = l('등록된 발주 품목이 없어요', 'No registered purchase item', '没有已登记的采购品项', '沒有已登記的採購品項');
  if (/어디서\s*받|거래처가\s*어디|발주사가\s*어디/u.test(value) && item) {
    // Rows that share one supplier are all listed with it; the wire lookup stays the purchase item.
    const rows = findRows(supplierRows(snapshot, locale, 'purchaseItem'), item, false);
    // "거래처가 어디고 언제 주문해야 해?" also asks about timing: show the supplier with price, minimum and lead time (the item's whole line).
    const timing = /언제|며칠|얼마나\s*걸|몇\s*일/u.test(value);
    return readPurchaseItem(item, timing ? 'summary' : 'supplier', { browse: rows.length > 1, missing: unregisteredItem });
  }
  if (supplier && /뭐\s*받|공급\s*품목/u.test(value)) {
    const registered = liveSuppliers(snapshot).some(row => nameMatches(supplier, text(locale).name(row)));
    return readPurchaseItem(supplier, 'products', { browse: true, missing: registered ? unregisteredItem
      : l('등록된 발주사가 없어요', 'No registered supplier', '没有已登记的供应商', '沒有已登記的供應商') });
  }
  if ((item || /^\S+\s+(?:최소|MOQ)/u.test(value)) && (price || purchaseCondition) && (question.test(value) && !/\d+\s*일\s*뒤에/u.test(value) || !editWords.test(value) && !addWords.test(value) && !removeWords.test(value) && !/\d/u.test(value))) {
    const field = price ? 'unitPrice' : /최소|MOQ/u.test(value) ? 'minimumQty' : /납기|리드타임|소요일/u.test(value) ? 'leadDays' : 'orderStep';
    return readPurchaseItem(item ?? value.split(/\s/u)[0], field, { missing: unregisteredItem });
  }
  if (item && (price || purchaseCondition || supplier && (supplierWords.test(value) || /받을래/u.test(value))) &&
    (price || addWords.test(value) || removeWords.test(value) || editWords.test(value) || /\d/u.test(value))) return editPurchase(snapshot, value, locale, item, supplier);
  if (!/발주\s*품목/u.test(value) && (supplier || supplierWords.test(value)) && (supplierWords.test(value) && addWords.test(value) && !/물건\s*주문/u.test(value) || removeWords.test(value) || /메모|담당|연락처|전화|번호|이름/u.test(value))) {
    return editSupplier(snapshot, value, locale, supplier);
  }
  if (isOrder && /도착하게|도착으로|입고로|주문\s*입고일/u.test(value) && !/취소|바꿔|미뤄|변경/u.test(value)) {
    return routeOrder(snapshot, value, locale, item, supplier, allowLocalScheduling);
  }
  const hasOpenOrder = (item || supplier) && currentOrders(snapshot).open.some(order =>
    (!item || order.lines.some(line => nameMatches(item, lineName(line, locale)))) &&
    (!supplier || nameMatches(supplier, supplierName(snapshot, order.supplierId, locale))));
  const amount = isOrder || isIntake ? explicitQty(value) : undefined;
  const purchaseQty = amount && ['pcs', 'tray', 'box', 'kg', 'g', 'L', 'mL'].includes(amount.unit);
  const cancelOrder = isOrder && /취소|캔슬|없던\s*걸로/u.test(value) && (/발주/u.test(value) || hasOpenOrder || supplier || purchaseQty);
  const receiptRequest = /입고.*(?:처리|기록|확인|한\s*번\s*더)|(?:일부|전부|부분)\s*입고|같은\s*입고|(?:먼저|전부|다)\s*(?:받았|들어왔|왔어|도착했)|나머지.*아직/u.test(value);
  const trackedReceipt = (hasOpenOrder || supplier) && (/도착했|들어왔|받았|왔어|왔다|입고\s*됐/u.test(value) ||
    amount && /입고/u.test(value) && !explicitDate.test(withoutDecimalQty(value)));
  const deliveryEdit = /입고\s*(?:일(?!부)|시간|날짜|오전|오후|\d+\s*시)|도착\s*(?:일|시간)|미뤄|미룰/u.test(value) ||
    explicitDate.test(withoutDecimalQty(value)) && /도착|입고|오는/u.test(value) && editWords.test(value);
  if (cancelOrder || isIntake && (item || supplier) && (deliveryEdit || !/[?？]$/u.test(value) && (receiptRequest || trackedReceipt))) {
    return changeOrder(snapshot, value, locale, item, supplier);
  }
  if (!item && /발주\s*품목/u.test(value) && addWords.test(value)) {
    return refuse('invalid_target', l('먼저 재고 품목을 등록해 주세요', 'Register the inventory item first', '请先登记库存品项', '請先登記庫存品項'));
  }
  if (!item && isIntake && /입고\s*(?:일|처리|확인|기록)|입고일|도착일|받았어|왔어/u.test(value) && (supplier || explicitQty(value) || /입고|도착일/u.test(value))) {
    return unmatchedReceipt(snapshot, locale, value, supplier, undefined);
  }
  if (isOrder && (item || supplier || /발주|제안/u.test(value) || purchaseQty && /주문\s*(?:넣어|해\s*줘)/u.test(value)) &&
    !/어떻게|방법|하는\s*법/u.test(value)) {
    return routeOrder(snapshot, value, locale, item, supplier, allowLocalScheduling);
  }
}

export function createSuppliersDomain({ allowLocalScheduling = false }: { readonly allowLocalScheduling?: boolean } = {}) {
  const commands: readonly CommandName[] = [
    'suppliers.createPurchaseItem', 'suppliers.updatePurchaseItem', 'suppliers.deletePurchaseItem',
    'suppliers.createSupplier', 'suppliers.updateSupplier', 'suppliers.deleteSupplier',
    'suppliers.createOrder', 'suppliers.changeDueDate', 'suppliers.cancelOrder', 'suppliers.recordReceipt',
  ];
  return {
    featureIds: [featureId],
    commands: commands.filter(command => command !== 'suppliers.createOrder' || allowLocalScheduling).map(command => makeCommand(command, allowLocalScheduling)),
    reads: supplierKinds.map(makeReader),
    projectWidget: projectSupplierFacts,
    navigation: supplierNavigation,
    route: (value: string, snapshot: DataSnapshot, locale: Locale) => routeSupplier(value, snapshot, locale, allowLocalScheduling),
    handoff(command: string, fields: Readonly<Record<string, unknown>>): DetailRef | undefined {
      if (!['suppliers.createOrder', 'supplier.sendOrder'].includes(command)) return;
      return { featureId, view: 'orders', focus: 'action',
        ...(validateAgentPrefill(featureId, fields) ? { prefill: { kind: 'widget-draft', command, fields } } : {}) };
    },
  } satisfies DomainAdapter;
}

export const suppliersDomain = createSuppliersDomain({ allowLocalScheduling: true });
