import type { PosCart, PosCartCommand, PosCartQuote, PosCatalogItem, PosOption, PosPlanningResult, PosQuoteIssue, PosReadSnapshot } from '../../contracts/pos';
import { canonical, checkMeta, commandKey, freezePos, makePlan, money, posFailure, quantity, unchanged } from './common';

function recipeValid(read: PosReadSnapshot, parts: PosCatalogItem['recipeBase']): boolean {
  return parts.every(p => Number.isSafeInteger(p.quantityBase) && p.quantityBase > 0 && read.data.catalog.ingredients.some(i => i.itemId === p.itemId && i.unitDimension === p.unitDimension));
}
export function validatePosSelection(read: PosReadSnapshot, menuId: string, optionIds: readonly string[]): { readonly ok: true; readonly item: PosCatalogItem; readonly options: readonly PosOption[] } | ReturnType<typeof posFailure> {
  if (read.scenario === 'empty' || read.scenario === 'error') return posFailure('DATA_UNAVAILABLE');
  const item = read.data.catalog.items.find(m => m.menuId === menuId && !m.deletedAt);
  if (!item) return posFailure('ITEM_REMOVED', 'NOT_FOUND');
  if (item.saleStatus === 'sold_out') return posFailure('SOLD_OUT');
  if (!money(item.price) || item.unitCost !== null && !money(item.unitCost)) return posFailure('INVALID_AMOUNT');
  if (!recipeValid(read, item.recipeBase)) return posFailure('INVALID_RECIPE');
  if (new Set(optionIds).size !== optionIds.length) return posFailure('INVALID_OPTION');
  const allOptions = item.groups.flatMap(g => g.options.filter(o => !o.archivedAt));
  if (new Set(allOptions.map(o => o.optionId)).size !== allOptions.length) return posFailure('INVALID_OPTION');
  const options: PosOption[] = [];
  for (const id of [...optionIds].sort()) {
    const option = allOptions.find(o => o.optionId === id);
    if (!option || !item.groups.some(g => g.groupId === option.groupId && g.menuId === menuId && g.options.includes(option))) return posFailure('INVALID_OPTION');
    if (!money(option.extraPrice) || option.extraCost !== null && !money(option.extraCost)) return posFailure('INVALID_AMOUNT');
    if (!recipeValid(read, option.extraRecipe)) return posFailure('INVALID_RECIPE');
    options.push(option);
  }
  for (const group of item.groups) {
    if (group.menuId !== item.menuId) return posFailure('INVALID_OPTION');
    if (group.required && options.filter(o => o.groupId === group.groupId).length !== 1) return posFailure('REQUIRED_OPTION', 'VALIDATION', { groupId: group.groupId });
  }
  return { ok: true, item, options };
}
const quotes = new WeakMap<PosReadSnapshot, PosCartQuote>();
export function quoteCart(read: PosReadSnapshot, cartId = read.pos.cart.cartId): PosCartQuote {
  const cached = quotes.get(read); if (cached && cached.cartId === cartId) return cached;
  const cart = read.pos.cart, issues: PosQuoteIssue[] = [];
  if (cartId !== cart.cartId) issues.push({ reason: 'NOT_FOUND', messageKey: 'run.session.conflict' });
  if (read.scenario === 'empty' || read.scenario === 'error') issues.push({ reason: 'DATA_UNAVAILABLE', messageKey: 'order.menu.loadError' });
  if (!cart.lines.length) issues.push({ reason: 'EMPTY_CART', messageKey: 'order.cart.empty' });
  const lines = cart.lines.map(line => {
    const selection = validatePosSelection(read, line.menuId, line.selectedOptionIds);
    if (!selection.ok) issues.push({ reason: selection.reason, lineId: line.lineId, messageKey: selection.messageKey, ...(typeof selection.details?.groupId === 'string' ? { groupId: selection.details.groupId } : {}) });
    if (!quantity(line.qty)) issues.push({ reason: 'QTY_LIMIT', lineId: line.lineId, messageKey: 'order.cart.quantityLimit' });
    // Validation blocks submission, but must not remove selected prices from the display.
    const item = read.data.catalog.items.find(m => m.menuId === line.menuId && !m.deletedAt);
    const availableOptions = item?.groups.flatMap(g => g.options.filter(o => !o.archivedAt)) ?? [];
    const options = [...line.selectedOptionIds].sort().flatMap(id => {
      const option = availableOptions.find(o => o.optionId === id) ?? line.snapshot?.options.find(o => o.optionId === id);
      return option ? [option] : [];
    });
    const price = item?.price ?? line.snapshot?.basePrice ?? 0;
    const basePrice = money(price) ? price : 0;
    const optionPrice = options.reduce((n, o) => n + o.extraPrice, 0);
    const baseCost = item ? item.unitCost : line.snapshot?.baseCost ?? null;
    const optionCost = options.some(o => o.extraCost === null) ? null : options.reduce((n, o) => n + (o.extraCost ?? 0), 0);
    if (optionCost !== null && !money(optionCost) || baseCost !== null && optionCost !== null && !money(baseCost + optionCost)) issues.push({ reason: 'INVALID_AMOUNT', lineId: line.lineId, messageKey: 'run.session.conflict' });
    const unitPrice = basePrice + optionPrice, gross = unitPrice * line.qty;
    if (!money(unitPrice) || !money(gross)) issues.push({ reason: 'INVALID_AMOUNT', lineId: line.lineId, messageKey: 'run.session.conflict' });
    return { lineId: line.lineId, menuId: line.menuId, name: item?.name ?? line.snapshot?.name ?? '', qty: line.qty,
      basePrice, optionPrice, unitPrice, gross: money(gross) ? gross : 0,
      unitCost: baseCost === null || optionCost === null ? null : baseCost + optionCost,
      baseCost, optionCost, options, request: line.request, shortageItems: item?.shortageItems ?? [] };
  });
  if (read.data.dayClosed) issues.push({ reason: 'DAY_CLOSED', messageKey: 'order.closed.reason' });
  if (cart.lock) issues.push({ reason: 'BILL_LOCKED', messageKey: 'run.session.conflict' });
  const gross = lines.reduce((n, l) => n + l.gross, 0), totalQty = lines.reduce((n, l) => n + l.qty, 0);
  if (!money(gross) || !money(totalQty)) issues.push({ reason: 'INVALID_AMOUNT', messageKey: 'run.session.conflict' });
  const fingerprint = canonical({ cartId: cart.cartId, revision: cart.revision, type: cart.type, memo: cart.memo,
    lines: lines.map(l => ({ lineId: l.lineId, menuId: l.menuId, qty: l.qty, basePrice: l.basePrice, optionPrice: l.optionPrice,
      optionIds: cart.lines.find(c => c.lineId === l.lineId)!.selectedOptionIds, request: l.request })) });
  const quote = freezePos({ cartId, revision: cart.revision, fingerprint, lines, totalQty, gross: money(gross) ? gross : 0,
    discount: 0, payable: money(gross) ? gross : 0, canSubmit: !issues.length, issues });
  if (cartId === cart.cartId) quotes.set(read, quote);
  return quote;
}
const catalogs = new WeakMap<PosReadSnapshot, Map<string, ReturnType<typeof catalogView>>>();
function catalogView(read: PosReadSnapshot, category?: string, query = '') {
  const active = read.data.catalog.items.filter(m => !m.deletedAt);
  return freezePos({ status: read.scenario === 'error' ? 'error' as const : read.scenario === 'empty' ? 'empty' as const : 'ready' as const,
    items: read.scenario === 'empty' || read.scenario === 'error' ? [] : active.filter(m => (!category || category === 'all' || m.category === category) && m.name.includes(query.trim())),
    categories: [...new Set(active.map(m => m.category))] });
}
export function selectPosCatalog(read: PosReadSnapshot, input: { readonly category?: string; readonly query?: string } = {}) {
  let cache = catalogs.get(read); if (!cache) { cache = new Map(); catalogs.set(read, cache); }
  const key = canonical(input); let result = cache.get(key);
  if (!result) { result = catalogView(read, input.category, input.query); cache.set(key, result); }
  return result;
}
export function cartCommandPayload(command: PosCartCommand): unknown {
  const { meta: _meta, ...payload } = command;
  if (command.type === 'cart.add') return { ...payload, optionIds: [...command.optionIds].sort(), qty: command.qty ?? 1, request: command.request ?? '' };
  if (command.type === 'cart.replaceOptions') return { ...payload, optionIds: [...command.optionIds].sort() };
  return payload;
}
const sameLine = (a: PosCart['lines'][number], b: PosCart['lines'][number]) => a.menuId === b.menuId && a.request === b.request && canonical(a.selectedOptionIds) === canonical(b.selectedOptionIds);
export function planCartCommand(read: PosReadSnapshot, command: PosCartCommand): PosPlanningResult {
  const payload = cartCommandPayload(command), checked = checkMeta(read, command.meta, command.type, payload);
  if (checked) return checked;
  if (read.posUi.approval?.status === 'pending') return posFailure('APPROVAL_BUSY', 'CONFLICT');
  const before = read.pos.cart;
  if (before.lock) return posFailure('BILL_LOCKED', 'CONFLICT');
  let cart: PosCart = before;
  if (command.type === 'cart.add' || command.type === 'cart.replaceOptions') {
    const existing = command.type === 'cart.replaceOptions' ? before.lines.find(l => l.lineId === command.lineId) : undefined;
    if (command.type === 'cart.replaceOptions' && !existing) return posFailure('NOT_FOUND', 'NOT_FOUND');
    const menuId = command.type === 'cart.add' ? command.menuId : existing!.menuId;
    const selected = validatePosSelection(read, menuId, command.optionIds);
    if (!selected.ok) return selected;
    const qty = command.qty ?? existing?.qty ?? 1, request = command.request ?? existing?.request ?? '';
    if (!quantity(qty)) return posFailure('QTY_LIMIT');
    if ([...request].length > 100) return posFailure('TEXT_LIMIT');
    const line = { lineId: existing?.lineId ?? `${before.cartId}:line:${before.revision + 1}`, menuId,
      selectedOptionIds: [...command.optionIds].sort(), qty, request,
      snapshot: { name: selected.item.name, basePrice: selected.item.price, baseCost: selected.item.unitCost, options: selected.options } };
    const other = before.lines.find(l => l.lineId !== existing?.lineId && sameLine(l, line));
    if (other && !quantity(other.qty + qty)) return posFailure('QTY_LIMIT');
    if (other) cart = { ...before, lines: before.lines.filter(l => l.lineId !== existing?.lineId).map(l => l.lineId === other.lineId ? { ...l, qty: l.qty + qty, snapshot: line.snapshot } : l) };
    else cart = { ...before, lines: existing ? before.lines.map(l => l.lineId === existing.lineId ? line : l) : [...before.lines, line] };
  } else if (command.type === 'cart.clear') cart = { ...before, lines: [], memo: '' };
  else if (command.type === 'cart.type') {
    if (!['dine_in', 'takeout'].includes(command.orderType)) return posFailure('ORDER_TYPE_INVALID');
    cart = { ...before, type: command.orderType };
  } else if (command.type === 'cart.note') {
    if ([...command.text].length > 100) return posFailure('TEXT_LIMIT');
    if (command.lineId !== undefined && !before.lines.some(l => l.lineId === command.lineId)) return posFailure('NOT_FOUND', 'NOT_FOUND');
    cart = command.lineId === undefined ? { ...before, memo: command.text } : { ...before, lines: before.lines.map(l => l.lineId === command.lineId ? { ...l, request: command.text } : l) };
  } else {
    const line = before.lines.find(l => l.lineId === command.lineId);
    if (!line) return posFailure('NOT_FOUND', 'NOT_FOUND');
    const qty = command.type === 'cart.remove' ? 0 : command.qty;
    if (qty !== 0 && !quantity(qty)) return posFailure('QTY_LIMIT');
    cart = { ...before, lines: qty === 0 ? before.lines.filter(l => l.lineId !== line.lineId) : before.lines.map(l => l.lineId === line.lineId ? { ...l, qty } : l) };
  }
  if (canonical(cart) === canonical(before)) return unchanged(read, before);
  cart = freezePos({ ...cart, revision: before.revision + 1 });
  const key = commandKey(command.meta, command.type), token = `pos:cart:${key}`;
  return makePlan(read, { ...read.pos, revision: read.posRevision + 1, cart },
    { ...read.posUi, cartUndo: { token, commandKey: key, before, after: cart } }, cart, command.meta, command.type, payload, token);
}
export function planPosUndo(read: PosReadSnapshot, token: string): PosPlanningResult {
  if (read.posUi.approval?.status === 'pending') return posFailure('APPROVAL_BUSY', 'CONFLICT');
  const undo = read.posUi.cartUndo;
  if (!undo || undo.token !== token || read.pos.cart !== undo.after) return posFailure('UNDO_UNAVAILABLE', 'CONFLICT');
  const cart = { ...undo.before, revision: read.pos.cart.revision + 1 };
  const nextPos = { ...read.pos, revision: read.posRevision + 1, cart,
    commandLedger: read.pos.commandLedger.map(e => e.key === undo.commandKey ? { ...e, undone: true } : e) };
  return { ok: true, plan: freezePos({ nextPos, nextUi: { ...read.posUi, cartUndo: null },
    result: { ok: true, status: 'applied', posRevision: nextPos.revision, dataRevision: read.dataRevision + 1, value: cart } }) };
}
