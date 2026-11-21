import { cafeMenuPhoto } from '../db/cafe-menu-photos';
import type { DataTables, DataText, Reservation } from '../db/types';
import type { RecipeLine } from '../db/management-types';
import { addDays, isIsoDate, isTime, NOW, LEGACY_GRANT_EVALUATION_NOW, TODAY } from '../db/time';
import { DataQueryError, toBase, unitDimension } from '../derive/common';
import { deriveRecipeCost, deriveStock, deriveSuggestions, deriveOpenOrders, purchaseQuantityBase } from '../derive/stock';
import { maskCustomer, activeMember } from '../derive/members';
import { allocateReservation, BUSINESS_TIME } from '../derive/reservations';
import { askAgain, dateIsPast, findBookingDuplicate, findOrderDuplicate, findPhoneMatch, findSameName, findTaxDuplicate, nameExists, normalizeMemberPhone, normalizeName, phoneExists, plainText, refuse, slotHasPassed } from './management-guards';
import type { HandlerContext, HandlerResult } from './handlers';
import { selectMemberDeleteBlockers } from './member-guard';
import type { ManagementCommand, ManualInput, BookingInput } from './management-types';
import type { PosOptionGroup, PosRecipePart, PosReservationWrite } from '../../contracts/pos';
import { canonical } from '../../pos/domain/common';

export const rejected = (reason: string, field?: string, code: 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'PREVIEW_FAILURE' = 'VALIDATION'): HandlerResult => ({ ok: false, code, reason, messageKey: `data.management.error.${reason}`, ...(field ? { field } : {}) });
export const changed = (tables: DataTables, value?: unknown, noticeKey = 'data.management.notice.saved'): HandlerResult => ({ ok: true, tables, undoable: true, noticeKey, ...(value === undefined ? {} : { value }) });
/** API-244 attendance is part of the POS transaction, never a second dispatch. */
export function applyPosReservationWrite(t: DataTables, write: PosReservationWrite): HandlerResult {
  const before = t.reservation.filter((r):r is Reservation=>r.kind!=='pickup').find(r => r.reservationId === write.reservationId && !r.variant);
  if (!before || canonical(before) !== write.expectedFingerprint) return rejected('STALE_REVISION', undefined, 'CONFLICT');
  const change = t.reservationChange.find(c => c.changeId === write.changeId);
  if (write.undo ? !change : !!change) return rejected('UNDO_UNAVAILABLE', undefined, 'CONFLICT');
  if (write.undo && canonical(change!.after) !== canonical(before)) return rejected('UNDO_UNAVAILABLE', undefined, 'CONFLICT');
  if (write.undo ? before.status !== 'completed' || write.status !== 'confirmed' : before.status !== 'confirmed' || write.status !== 'completed') return rejected('STATE_CONFLICT', undefined, 'CONFLICT');
  const after = { ...before, status: write.status };
  return { ok: true, undoable: false, tables: { ...t, reservation: t.reservation.map(r => r === before ? after : r),
    reservationChange: write.undo ? t.reservationChange.filter(c => c.changeId !== write.changeId) : [...t.reservationChange, { changeId: write.changeId,
      reservationId: write.reservationId, at: write.at, kind: 'status', before, after }] } };
}
const absent = (field: string) => rejected('NOT_FOUND', field, 'NOT_FOUND');
const conflict = (reason: string, field?: string) => rejected(reason, field, 'CONFLICT');
const raw = (s: string): DataText => ({ raw: s.trim() });
const nonempty = (s: unknown): s is string => typeof s === 'string' && !!s.trim();
const phone = (s: unknown): s is string => typeof s === 'string' && /^\d{10,11}$/.test(s);
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const quantities = (n: unknown, unit: string, minimum = 0): n is number => typeof n === 'number' && n >= minimum && toBase(n, unit) !== null;
const replace = <T>(rows: readonly T[], row: T, next: T): readonly T[] => rows.map((r) => r === row ? next : r);
const categories = ['drink', 'dessert'];
// A base64 PNG of the editor's 512px canvas fits within this bound.
const maxMenuPhotoDataUrlLength = 2 * 1024 * 1024;
const menuPhotoDataUrl = /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}(?![\s\S])/;
const manualCategories = ['opening', 'closing', 'recipe', 'cleaning', 'new-staff', 'hygiene', 'store-info'];
const applicationStatuses = ['applied', 'reviewing', 'selected', 'rejected', 'completed'];
const forbidden = (value: object, allowed: readonly string[]) => Object.keys(value).find((key) => !allowed.includes(key));
const liveMenus = (t: DataTables) => t.menuItem.filter((m) => m.kind === 'menu' && !m.deletedAt);
const menuLabel = (m: DataTables['menuItem'][number]) => plainText(m.name, m.nameKey);
const liveIngredients = (t: DataTables) => t.inventoryItem.filter((i) => i.kind === 'ingredient' && !i.deletedAt);
const itemLabel = (i: DataTables['inventoryItem'][number]) => plainText(i.name, i.nameKey);
const liveSuppliers = (t: DataTables) => t.supplier.filter((s) => !s.deletedAt);
const supplierLabel = (s: DataTables['supplier'][number]) => plainText(s.name, s.nameKey);
const nonNegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
type Handlers = { [T in Exclude<ManagementCommand['type'], 'closing.closeDay' | 'closing.undoDay' | 'onboarding.setAnswers' | 'shop.updateSettings'>]: (ctx: HandlerContext, command: Extract<ManagementCommand, { type: T }>) => HandlerResult };
/** The first purchase-condition field that is wrong, so the error points at it. A price of 0 is allowed (free samples are a product choice). */
const purchaseProblem = (t: DataTables, p: { supplierId: string; minimumQty: number; orderStep: number; unitPrice: number; leadDays: number }): 'supplierId' | 'minimumQty' | 'orderStep' | 'unitPrice' | 'leadDays' | null =>
  !t.supplier.some((s) => s.supplierId === p.supplierId && !s.deletedAt) ? 'supplierId' : !(Number.isFinite(p.minimumQty) && p.minimumQty > 0) ? 'minimumQty' : !(Number.isFinite(p.orderStep) && p.orderStep > 0) ? 'orderStep'
    : !(integer(p.unitPrice) && p.unitPrice >= 0) ? 'unitPrice' : !(integer(p.leadDays) && p.leadDays >= 0) ? 'leadDays' : null;
function withReservation(ctx: HandlerContext, before: Reservation | null, after: Reservation, kind: DataTables['reservationChange'][number]['kind']): HandlerResult {
  const t = ctx.tables;
  return changed({ ...t, reservation: before ? replace(t.reservation, before, after) : [...t.reservation, after], reservationChange: [...t.reservationChange, { changeId: ctx.nextId('rvc'), reservationId: after.reservationId, at: `${TODAY}T${BUSINESS_TIME}`, kind, before, after }] }, { reservationId: after.reservationId, status: after.status, tableId: after.tableId ?? null, ...(after.allocationWarning ? { allocationWarning: after.allocationWarning } : {}) });
}
function booking(ctx: HandlerContext, input: BookingInput & { readonly confirmDuplicate?: boolean }, before: Reservation | null, patch?: Partial<BookingInput>): HandlerResult {
  const t = ctx.tables;
  if (input.memberId && input.guest || !input.memberId && !input.guest) return rejected('GUEST_OR_MEMBER', 'memberId');
  if (input.memberId && !activeMember(ctx.snapshot, input.memberId)) return absent('memberId');
  if (input.guest && (!before || patch?.guest !== undefined) && (!nonempty(input.guest.name) || input.guest.phone !== undefined && !phone(input.guest.phone))) return rejected('GUEST_INVALID', 'guest');
  if (!isIsoDate(input.date)) return rejected('DATE_INVALID', 'date');
  if (!isTime(input.time)) return rejected('TIME_INVALID', 'time');
  if (!integer(input.partySize) || input.partySize < 1) return rejected('PARTY_INVALID', 'partySize');
  if (input.tableChoice !== 'auto' && (!input.tableChoice || !nonempty(input.tableChoice.tableId))) return rejected('TABLE_INVALID', 'tableChoice');
  // A new slot is a promise about the future. Edits that keep the slot (party, request, table, name) stay allowed on any row.
  const slotChanged = !before || input.date !== before.date || input.time !== before.time;
  if (slotChanged && slotHasPassed(input.date, input.time)) return refuse('VALIDATION', 'BOOKING_PAST', dateIsPast(input.date) ? 'date' : 'time', { date: input.date, time: input.time });
  const member = t.memberProfile.find((m) => m.memberId === input.memberId);
  const customer = t.marketing.mktCustomer.find((c) => c.customerId === member?.customerId);
  const name = input.guest?.name;
  const identityChanged = !before || patch?.guest !== undefined || patch?.memberId !== undefined;
  const preserveGuestPhone = !!before && !before.memberId && !!input.guest && input.guest.phone === undefined;
  const display = maskCustomer(customer ?? { name: name ?? '', phone: input.guest?.phone, maskKey: 'data.management.guest' });
  if (!input.confirmDuplicate && (!before || slotChanged || identityChanged || input.partySize !== before.partySize)) {
    const similar = findBookingDuplicate(t, { ...(input.memberId ? { memberId: input.memberId } : {}), ...(input.guest ? { guest: input.guest } : {}), date: input.date, time: input.time, partySize: input.partySize }, before?.reservationId);
    if (similar) return askAgain('BOOKING_DUPLICATE', 'time', { reservationId: similar.reservationId, date: similar.date, time: similar.time, partySize: similar.partySize });
  }
  const candidate: Reservation = { kind:'visit', reservationId: before?.reservationId ?? ctx.nextId('rv'), nameKey: customer?.maskKey ?? 'data.management.guest', requestKey: null, source: before?.source ?? 'direct', status: 'confirmed', confirmedBy: 'auto', callId: before?.callId ?? null, proposedTime: null, variant: null,
    ...before, date: input.date, time: input.time, partySize: input.partySize,
    // The typed request replaces the seeded request key: clearing or rewriting it must clear both, or the old text reappears.
    ...(patch?.request !== undefined ? { requestKey: null } : {}),
    ...(identityChanged ? { memberId: input.memberId, nameKey: customer?.maskKey ?? 'data.management.guest', guestName: typeof display.name === 'string' ? { raw: display.name } : display.name, phone: preserveGuestPhone ? before?.phone : display.phone ? { raw: display.phone } : undefined } : {}),
    request: before && patch?.request === undefined ? before.request : input.request ? raw(input.request) : null,
    ...(!before || patch?.tableChoice !== undefined ? { assignmentMode: input.tableChoice === 'auto' ? 'auto' : 'manual' } : {}) };
  return finalize(candidate);
  function finalize(row: Reservation) {
    const allocationChanged = !before || patch?.date !== undefined || patch?.time !== undefined || patch?.partySize !== undefined || patch?.tableChoice !== undefined;
    const allocation = allocationChanged ? allocateReservation(t, row, input.tableChoice) : null;
    const next: Reservation = allocation ? { ...row, ...allocation, allocationWarning: allocation.allocationWarning, capacityOverride: false } : row;
    if (before && JSON.stringify({ ...before, ...next }) === JSON.stringify(before)) return changed(t);
    return withReservation(ctx, before, next, before ? 'updated' : 'created');
  }
}
function validateManual(input: Partial<ManualInput>): HandlerResult | null {
  if (input.title !== undefined && !nonempty(input.title)) return rejected('TITLE_REQUIRED', 'title');
  if (input.category !== undefined && !manualCategories.includes(input.category)) return rejected('CATEGORY_INVALID', 'category');
  if (input.section !== undefined && !['handover', 'store-info'].includes(input.section)) return rejected('SECTION_INVALID', 'section');
  if (input.steps !== undefined && (!Array.isArray(input.steps) || input.steps.some((s) => !nonempty(typeof s === 'string' ? s : s?.body) || typeof s !== 'string' && s.photoKey !== undefined && !/^floor-photo-[1-3]$/.test(s.photoKey)))) return rejected('STEPS_INVALID', 'steps');
  return null;
}

export const managementHandlers: Handlers = {
  'menu.create': ({ tables: t, nextId }, c) => {
    if (!nonempty(c.name)) return rejected('MENU_NAME_REQUIRED', 'name');
    if (!categories.includes(c.category)) return rejected('CATEGORY_INVALID', 'category');
    if (!integer(c.price) || c.price <= 0) return rejected('PRICE_INVALID', 'price');
    const same = findSameName(liveMenus(t), menuLabel, c.name);
    if (same) return nameExists(same.menuId);
    const menuId = nextId('m-new');
    return changed({ ...t, menuItem: [...t.menuItem, { menuId, kind: 'menu', nameKey: 'data.management.customMenu', name: raw(c.name), category: c.category, categoryKey: `data.management.category.${c.category}`, price: c.price, memo: c.memo?.trim() ? raw(c.memo) : null, recipe: [], prepMin: 3, saleStatus: 'selling', photoKey: null, optionGroups: [], costEffectiveFrom: TODAY }] }, { menuId });
  },
  'menu.update': ({ tables: t }, c) => {
    const m = t.menuItem.find((m) => m.menuId === c.menuId && m.kind === 'menu' && !m.deletedAt);
    if (!m) return absent('menuId');
    const p = c.patch;
    const field = forbidden(p, ['name', 'category', 'price', 'memo']);
    if (field) return rejected('READ_ONLY_FIELD', field);
    if (p.name !== undefined && !nonempty(p.name)) return rejected('MENU_NAME_REQUIRED', 'name');
    if (p.category !== undefined && !categories.includes(p.category)) return rejected('CATEGORY_INVALID', 'category');
    if (p.price !== undefined && (!integer(p.price) || p.price <= 0)) return rejected('PRICE_INVALID', 'price');
    const same = p.name !== undefined ? findSameName(liveMenus(t), menuLabel, p.name, (other) => other.menuId === m.menuId) : undefined;
    if (same) return nameExists(same.menuId);
    const next = { ...m, ...(p.name !== undefined ? { name: raw(p.name) } : {}), ...(p.category !== undefined ? { category: p.category } : {}), ...(p.price !== undefined ? { price: p.price } : {}), ...(p.memo !== undefined ? { memo: p.memo?.trim() ? raw(p.memo) : null } : {}) };
    return changed({ ...t, menuItem: replace(t.menuItem, m, next) }, { menuId: m.menuId });
  },
  'menu.delete': ({ tables: t }, c) => {
    const m = t.menuItem.find((m) => m.menuId === c.menuId && m.kind === 'menu' && !m.deletedAt);
    return m ? changed({ ...t, menuItem: replace(t.menuItem, m, { ...m, deletedAt: NOW }) }, { menuId: m.menuId }, 'data.management.notice.deleted') : absent('menuId');
  },
  'menu.setOptions': ({ tables: t }, c) => {
    const menu = t.menuItem.find(m => m.menuId === c.menuId && m.kind === 'menu' && !m.deletedAt);
    if (!menu) return absent('menuId');
    if (!Array.isArray(c.groups)) return rejected('INVALID_OPTION', 'groups');
    const previous = menu.optionGroups ?? [];
    const allGroups = t.menuItem.flatMap(m => m.optionGroups ?? []);
    const allOptions = allGroups.flatMap(g => g.options);
    const ids = new Set<string>();
    const next: PosOptionGroup[] = [];
    for (const [i, group] of c.groups.entries()) {
      const field = `groups.${i}`;
      if (!group || !nonempty(group.groupId) || ids.has(group.groupId) || group.menuId !== c.menuId || typeof group.required !== 'boolean' || !Array.isArray(group.options)) return rejected('INVALID_OPTION', field);
      const oldGroup = allGroups.find(g => g.groupId === group.groupId);
      if (group.archivedAt || oldGroup && (oldGroup.menuId !== c.menuId || oldGroup.archivedAt)) return rejected('INVALID_OPTION', `${field}.groupId`);
      ids.add(group.groupId);
      if (!nonempty(group.name)) return rejected('EMPTY_NAME', `${field}.name`);
      if (group.required && !group.options.length) return rejected('REQUIRED_GROUP_EMPTY', `${field}.required`);
      const options: PosOptionGroup['options'][number][] = [];
      for (const [j, option] of group.options.entries()) {
        const path = `${field}.options.${j}`;
        if (!option || !nonempty(option.optionId) || ids.has(option.optionId) || option.groupId !== group.groupId || !Array.isArray(option.extraRecipe)) return rejected('INVALID_OPTION', path);
        const oldOption = allOptions.find(o => o.optionId === option.optionId);
        if (option.archivedAt || oldOption && (oldOption.groupId !== group.groupId || oldOption.archivedAt)) return rejected('INVALID_OPTION', `${path}.optionId`);
        ids.add(option.optionId);
        if (!nonempty(option.name)) return rejected('EMPTY_NAME', `${path}.name`);
        if (!integer(option.extraPrice) || option.extraPrice < 0) return rejected('NEGATIVE_AMOUNT', `${path}.extraPrice`);
        const ingredients = new Set<string>();
        for (const part of option.extraRecipe) {
          const item = part && t.inventoryItem.find(item => item.itemId === part.itemId && item.kind === 'ingredient' && !item.deletedAt);
          if (!item) return absent(`${path}.extraRecipe.itemId`);
          if (ingredients.has(part.itemId)) return rejected('INVALID_OPTION', `${path}.extraRecipe`);
          ingredients.add(part.itemId);
          const dimension = unitDimension(item.unit);
          const expected = dimension === 'mass' ? 'g' : dimension === 'volume' ? 'mL' : 'pcs';
          if (part.unitDimension !== expected || !integer(part.quantityBase) || part.quantityBase <= 0) return rejected('UNIT_MISMATCH', `${path}.extraRecipe`);
        }
        options.push({ optionId: option.optionId, groupId: group.groupId, name: option.name.trim(), extraPrice: option.extraPrice, extraCost: null, extraRecipe: option.extraRecipe.map((p: PosRecipePart) => ({ itemId: p.itemId, quantityBase: p.quantityBase, unitDimension: p.unitDimension })) });
      }
      // Removed IDs are tombstones: projection reads the last recipe, and later edits cannot reuse them.
      options.push(...(oldGroup?.options ?? []).filter(old => !options.some(o => o.optionId === old.optionId)).map(old => old.archivedAt ? old : { ...old, archivedAt: NOW }));
      next.push({ groupId: group.groupId, menuId: c.menuId, name: group.name.trim(), required: group.required, options });
    }
    const deleted = previous.some(g => !g.archivedAt && (!next.some(n => n.groupId === g.groupId) || g.options.some(o => !o.archivedAt && !c.groups.some(n => n.options.some(v => v.optionId === o.optionId)))));
    next.push(...previous.filter(old => !next.some(g => g.groupId === old.groupId)).map(old => old.archivedAt ? old : { ...old, archivedAt: NOW, options: old.options.map(o => o.archivedAt ? o : { ...o, archivedAt: NOW }) }));
    return changed({ ...t, menuItem: replace(t.menuItem, menu, { ...menu, optionGroups: next }) }, { menuId: c.menuId }, deleted ? 'data.management.notice.deleted' : 'data.management.notice.saved');
  },
  'menu.setSaleStatus': ({ tables: t }, c) => {
    const menu = t.menuItem.find(m => m.menuId === c.menuId && m.kind === 'menu' && !m.deletedAt);
    if (!menu) return absent('menuId');
    if (!['selling', 'sold_out'].includes(c.status)) return rejected('STATUS_INVALID', 'status');
    return changed({ ...t, menuItem: replace(t.menuItem, menu, { ...menu, saleStatus: c.status }) }, { menuId: c.menuId, status: c.status });
  },
  'menu.setPhoto': ({ tables: t }, c) => {
    const menu = t.menuItem.find(m => m.menuId === c.menuId && m.kind === 'menu' && !m.deletedAt);
    if (!menu) return absent('menuId');
    if (c.photoKey !== null && (typeof c.photoKey !== 'string' || !/^menu-photo-0[1-8]$/.test(c.photoKey) || c.photoKey.length !== 13)) return rejected('UNKNOWN_PHOTO', 'photoKey');
    const upload = c.customPhotoUrl;
    const seededPhoto = upload !== undefined && upload === cafeMenuPhoto(menu.menuId);
    if (upload !== undefined && (c.photoKey !== null || typeof upload !== 'string' ||
      (!seededPhoto && (upload.length > maxMenuPhotoDataUrlLength || !menuPhotoDataUrl.test(upload))))) return rejected('UNKNOWN_PHOTO', 'customPhotoUrl');
    // A built-in selection keeps the upload available in the picker. Clearing removes both.
    const customPhotoUrl = c.photoKey === null ? upload ?? null : menu.customPhotoUrl ?? null;
    const value = { menuId: c.menuId, photoKey: c.photoKey };
    if ((menu.photoKey ?? null) === c.photoKey && (menu.customPhotoUrl ?? null) === customPhotoUrl) return changed(t, value);
    return changed({ ...t, menuItem: replace(t.menuItem, menu, { ...menu, photoKey: c.photoKey, customPhotoUrl }) }, value);
  },
  'menu.setRecipe': (ctx, c) => {
    const t = ctx.tables, menu = t.menuItem.find((m) => m.menuId === c.menuId && m.kind === 'menu' && !m.deletedAt);
    if (!menu) return absent('menuId');
    if (!Array.isArray(c.lines) || new Set(c.lines.map((r) => r.itemId)).size !== c.lines.length) return rejected('DUPLICATE_INGREDIENT', 'lines');
    const lines: RecipeLine[] = [];
    const usedIds = new Set<string>();
    for (const r of c.lines) {
      const item = t.inventoryItem.find((i) => i.itemId === r.itemId && i.kind === 'ingredient' && !i.deletedAt);
      if (!item) return absent('itemId');
      if (r.recipeLineId && t.recipeLine.some((old) => old.recipeLineId === r.recipeLineId && (old.menuId !== c.menuId || old.itemId !== r.itemId))) return rejected('RECIPE_LINE_INVALID', 'recipeLineId');
      if (unitDimension(r.unit) !== unitDimension(item.unit) || !quantities(r.quantity, r.unit) || r.quantity <= 0) return rejected('UNIT_PRECISION', 'quantity');
      const recipeLineId = r.recipeLineId ?? t.recipeLine.find((old) => old.menuId === c.menuId && old.itemId === r.itemId)?.recipeLineId ?? ctx.nextId('recipe');
      if (usedIds.has(recipeLineId)) return rejected('RECIPE_LINE_INVALID', 'recipeLineId');
      usedIds.add(recipeLineId);
      lines.push({ recipeLineId, menuId: c.menuId, itemId: r.itemId, quantity: r.quantity, unit: r.unit });
    }
    const previous = t.recipeLine.filter((r) => r.menuId === c.menuId);
    if (JSON.stringify(previous) === JSON.stringify(lines)) return changed(t, { menuId: c.menuId, cost: deriveRecipeCost(ctx.snapshot, c.menuId).cost });
    let inserted = false;
    const recipeLine = t.recipeLine.flatMap((r) => {
      if (r.menuId !== c.menuId) return [r];
      if (inserted) return [];
      inserted = true; return lines;
    });
    if (!inserted) recipeLine.push(...lines);
    const next = { ...t, recipeLine };
    const snapshot = { ...ctx.snapshot, tables: next };
    return changed(next, { menuId: c.menuId, cost: deriveRecipeCost(snapshot, c.menuId).cost, usageSummary: deriveStock(snapshot, { date: TODAY }) });
  },
  'inventory.createItem': ({ tables: t, nextId }, c) => {
    if (!nonempty(c.sku) || t.inventoryItem.some((i) => i.sku === c.sku.trim())) return rejected('SKU_INVALID', 'sku');
    if (!nonempty(c.name)) return rejected('NAME_REQUIRED', 'name');
    const sameItem = findSameName(liveIngredients(t), itemLabel, c.name);
    if (sameItem) return nameExists(sameItem.itemId);
    if (!nonNegative(c.stock)) return rejected('NUMBER_INVALID', 'stock');
    if (!nonNegative(c.threshold)) return rejected('NUMBER_INVALID', 'threshold');
    if (!quantities(c.stock, c.unit)) return rejected('UNIT_PRECISION', 'stock');
    if (!quantities(c.threshold, c.unit)) return rejected('UNIT_PRECISION', 'threshold');
    if (c.trackRestock !== undefined && typeof c.trackRestock !== 'boolean') return rejected('NUMBER_INVALID', 'trackRestock');
    const itemId = nextId('it'), adjustmentId = nextId('adjust');
    return changed({ ...t, inventoryItem: [...t.inventoryItem, { itemId, sku: c.sku.trim(), nameKey: 'data.management.customItem', name: raw(c.name), kind: 'ingredient', unit: c.unit, restockThreshold: c.threshold, trackRestock: c.trackRestock ?? true, lowStockPerChannel: null, sales7d: null, updatedAt: NOW, trackExpiry: false, expiresOn: null }], stockAdjustment: [...t.stockAdjustment, { adjustmentId, itemId, at: NOW, seq: Number(adjustmentId.split('-').at(-1)), deltaBase: toBase(c.stock, c.unit)!, reason: 'initial' }] }, { itemId, adjustmentId });
  },
  'inventory.deleteItem': (ctx, c) => {
    const t = ctx.tables, item = t.inventoryItem.find((i) => i.itemId === c.itemId && !i.deletedAt && i.kind === 'ingredient');
    if (!item) return absent('itemId');
    if (t.recipeLine.some((r) => r.itemId === c.itemId) || t.menuItem.some(m => m.optionGroups?.some(g => g.options.some(o => o.extraRecipe.some(p => p.itemId === c.itemId)))) || deriveOpenOrders(ctx.snapshot, { date: TODAY }).open.some((o) => o.lines.some((l) => l.itemId === c.itemId && l.remaining > 0))) return conflict('REFERENCED_ITEM', 'itemId');
    return changed({ ...t, inventoryItem: replace(t.inventoryItem, item, { ...item, deletedAt: NOW }), purchaseItem: t.purchaseItem.filter((p) => p.itemId !== item.itemId) }, { itemId: c.itemId }, 'data.management.notice.deleted');
  },
  'inventory.setTracking': ({ tables }, command) => {
    const { itemId, trackRestock, trackExpiry } = command;
    const item = liveIngredients(tables).find(row => row.itemId === itemId);
    if (!item) return absent('itemId');
    if (Object.keys(command).some(key => !['type', 'itemId', 'trackRestock', 'trackExpiry', 'baseRevision'].includes(key))) return rejected('READ_ONLY_FIELD');
    if ((trackRestock === undefined && trackExpiry === undefined) || (trackRestock !== undefined && typeof trackRestock !== 'boolean')) {
      return rejected('NUMBER_INVALID', 'trackRestock');
    }
    if (trackExpiry !== undefined && typeof trackExpiry !== 'boolean') return rejected('NUMBER_INVALID', 'trackExpiry');
    const next = { ...item, trackRestock: trackRestock ?? item.trackRestock, trackExpiry: trackExpiry ?? item.trackExpiry };
    return changed({ ...tables, inventoryItem: replace(tables.inventoryItem, item, next) }, { itemId }, 'data.notice.itemUpdated');
  },
  'suppliers.updatePurchaseItem': ({ tables: t }, c) => {
    const p = t.purchaseItem.find((p) => p.purchaseItemId === c.purchaseItemId);
    if (!p) return absent('purchaseItemId');
    const field = forbidden(c.patch, ['supplierId', 'minimumQty', 'unitPrice', 'orderStep', 'leadDays']);
    if (field) return rejected('READ_ONLY_FIELD', field);
    const next = { ...p, ...c.patch };
    const problem = purchaseProblem(t, next);
    if (problem) return rejected('PURCHASE_INVALID', problem);
    return changed({ ...t, purchaseItem: replace(t.purchaseItem, p, next) }, { purchaseItemId: p.purchaseItemId });
  },
  'suppliers.createPurchaseItem': ({ tables: t, nextId }, c) => {
    if (!t.inventoryItem.some((i) => i.itemId === c.itemId && i.kind === 'ingredient' && !i.deletedAt)) return absent('itemId');
    if (t.purchaseItem.some((p) => p.itemId === c.itemId)) return conflict('PURCHASE_ITEM_EXISTS', 'itemId');
    const problem = purchaseProblem(t, c);
    if (problem) return rejected('PURCHASE_INVALID', problem);
    const purchaseItemId = nextId('pi');
    return changed({ ...t, purchaseItem: [...t.purchaseItem, { purchaseItemId, itemId: c.itemId, supplierId: c.supplierId, minimumQty: c.minimumQty, orderStep: c.orderStep, unitPrice: c.unitPrice, leadDays: c.leadDays }] }, { purchaseItemId });
  },
  'suppliers.deletePurchaseItem': ({ tables: t }, c) => {
    const p = t.purchaseItem.find((p) => p.purchaseItemId === c.purchaseItemId);
    if (!p) return absent('purchaseItemId');
    if (t.recipeLine.some((r) => r.itemId === p.itemId) || t.menuItem.some(m => m.optionGroups?.some(g => g.options.some(o => o.extraRecipe.some(r => r.itemId === p.itemId))))) return conflict('REFERENCED_ITEM', 'purchaseItemId');
    return changed({ ...t, purchaseItem: t.purchaseItem.filter((x) => x !== p) }, { purchaseItemId: p.purchaseItemId });
  },
  'suppliers.createSupplier': ({ tables: t, nextId }, c) => {
    if (!nonempty(c.name) || !nonempty(c.contact) || !nonempty(c.phone)) return rejected('SUPPLIER_INVALID', 'name');
    const sameSupplier = findSameName(liveSuppliers(t), supplierLabel, c.name);
    if (sameSupplier) return nameExists(sameSupplier.supplierId);
    const supplierId = nextId('sup');
    return changed({ ...t, supplier: [...t.supplier, { supplierId, name: raw(c.name), contact: raw(c.contact), phone: c.phone, phoneMask: c.phone.replace(/\d(?=\d{4})/g, '*'), nameKey: 'data.management.customSupplier', contactKey: 'data.management.contact', memo: c.memo ? raw(c.memo) : null }] }, { supplierId });
  },
  'suppliers.updateSupplier': ({ tables: t }, c) => {
    const p = t.supplier.find((s) => s.supplierId === c.supplierId && !s.deletedAt);
    if (!p) return absent('supplierId');
    const field = forbidden(c.patch, ['name', 'contact', 'phone', 'memo']);
    if (field) return rejected('READ_ONLY_FIELD', field);
    for (const field of ['name', 'contact', 'phone'] as const) if (c.patch[field] !== undefined && !nonempty(c.patch[field])) return rejected('SUPPLIER_INVALID', field);
    const sameSupplier = c.patch.name !== undefined ? findSameName(liveSuppliers(t), supplierLabel, c.patch.name, (other) => other.supplierId === p.supplierId) : undefined;
    if (sameSupplier) return nameExists(sameSupplier.supplierId);
    const next = { ...p, ...(c.patch.name !== undefined ? { name: raw(c.patch.name) } : {}), ...(c.patch.contact !== undefined ? { contact: raw(c.patch.contact) } : {}), ...(c.patch.phone !== undefined ? { phone: c.patch.phone, phoneMask: c.patch.phone.replace(/\d(?=\d{4})/g, '*') } : {}), ...(c.patch.memo !== undefined ? { memo: c.patch.memo ? raw(c.patch.memo) : null } : {}) };
    return changed({ ...t, supplier: replace(t.supplier, p, next) }, { supplierId: p.supplierId });
  },
  'suppliers.deleteSupplier': (ctx, c) => {
    const t = ctx.tables, p = t.supplier.find((s) => s.supplierId === c.supplierId && !s.deletedAt);
    if (!p) return absent('supplierId');
    if (t.purchaseItem.some((p) => p.supplierId === c.supplierId) || deriveOpenOrders(ctx.snapshot, { date: TODAY }).open.some((o) => o.supplierId === c.supplierId)) return conflict('REFERENCED_SUPPLIER', 'supplierId');
    return changed({ ...t, supplier: replace(t.supplier, p, { ...p, deletedAt: NOW }) }, { supplierId: p.supplierId });
  },
  'suppliers.createOrder': (ctx, c) => {
    const t = ctx.tables, p = t.purchaseItem.find((p) => p.purchaseItemId === c.purchaseItemId);
    if (!p) return absent('purchaseItemId');
    const item = t.inventoryItem.find((i) => i.itemId === p.itemId && !i.deletedAt);
    if (!item) return absent('itemId');
    if (c.suggestionItemId !== undefined && (c.suggestionItemId !== p.itemId || !deriveSuggestions(ctx.snapshot, { date: TODAY }).some((s) => s.itemId === p.itemId))) return conflict('STALE_SUGGESTION', 'suggestionItemId');
    const unit = p.purchaseUnit ?? item.unit;
    if (purchaseQuantityBase(c.qty, unit, p.basePerUnit) === null || c.qty <= 0) return rejected('ORDER_QTY_INVALID', 'qty');
    if (c.qty < p.minimumQty) return refuse('VALIDATION', 'ORDER_QTY_MIN', 'qty', { minimum: p.minimumQty, unit });
    if (Math.abs(c.qty / p.orderStep - Math.round(c.qty / p.orderStep)) > 1e-9) return refuse('VALIDATION', 'ORDER_QTY_STEP', 'qty', { step: p.orderStep, unit });
    const dueDate = c.dueDate ?? addDays(TODAY, p.leadDays);
    if (!isIsoDate(dueDate)) return rejected('DATE_INVALID', 'dueDate');
    // A scheduled order is a promise about the future: an arrival day before the business date is an instantly overdue order.
    if (dateIsPast(dueDate)) return refuse('VALIDATION', 'DUE_DATE_PAST', 'dueDate', { businessDate: TODAY });
    const repeated = c.confirmDuplicate ? undefined : findOrderDuplicate(t, { supplierId: p.supplierId, itemId: p.itemId, qty: c.qty, dueDate });
    if (repeated) return askAgain('LIKELY_DUPLICATE_ORDER', 'qty', { poId: repeated.poId, dueDate });
    const poId = ctx.nextId('po'), polId = ctx.nextId('pol');
    return changed({ ...t, purchaseOrder: [...t.purchaseOrder, { poId, supplierId: p.supplierId, orderedOn: TODAY, dueDate, expectedTime: null, status: 'scheduled', variant: null }], purchaseOrderLine: [...t.purchaseOrderLine, { polId, poId, itemId: p.itemId, qtyOrdered: c.qty, unitPrice: p.unitPrice, itemNameSnapshot: item.name ?? { key: item.nameKey }, unitSnapshot: unit, ...(p.basePerUnit !== undefined ? { basePerUnit: p.basePerUnit } : {}) }] }, { poId, polId, total: Math.round(c.qty * p.unitPrice), dueDate }, 'data.management.notice.orderCreated');
  },
  'suppliers.cancelOrder': ({ tables: t }, c) => {
    const po = t.purchaseOrder.find((p) => p.poId === c.poId);
    if (!po) return absent('poId');
    if (!['scheduled', 'partial'].includes(po.status)) return conflict('ORDER_CLOSED', 'poId');
    return changed({ ...t, purchaseOrder: replace(t.purchaseOrder, po, { ...po, status: 'canceled' }) }, { poId: po.poId });
  },
  'members.create': ({ tables: t, nextId }, c) => {
    if (forbidden(c, ['type', 'name', 'phone', 'idempotencyKey', 'baseRevision'])) return rejected('READ_ONLY_FIELD');
    if (!nonempty(c.name) || !phone(c.phone)) return rejected('MEMBER_INVALID', !nonempty(c.name) ? 'name' : 'phone');
    const sameNumber = findPhoneMatch(t, c.phone);
    if (sameNumber) return phoneExists(sameNumber);
    const n = Math.max(0, ...t.memberProfile.map((m) => Number(m.memberId.slice(2)))) + 1;
    const memberId = `M-${String(n).padStart(4, '0')}`, customerId = nextId('mc-new');
    return changed({ ...t, memberProfile: [...t.memberProfile, { memberId, customerId, joinedOn: TODAY, gradeOverride: null }], marketing: { ...t.marketing, mktCustomer: [...t.marketing.mktCustomer, { customerId, name: c.name.trim(), phone: c.phone, maskKey: 'data.management.exampleMember', consentSms: false, consentNight: false, variant: null }] } }, { memberId, customerId });
  },
  'members.update': (ctx, c) => {
    const p = activeMember(ctx.snapshot, c.memberId), t = ctx.tables;
    if (!p) return absent('memberId');
    const field = forbidden(c, ['type', 'memberId', 'name', 'phone', 'baseRevision']);
    if (field) return rejected('READ_ONLY_FIELD', field);
    if (c.name !== undefined && !nonempty(c.name) || c.phone !== undefined && !phone(c.phone)) return rejected('MEMBER_INVALID', c.name !== undefined && !nonempty(c.name) ? 'name' : 'phone');
    // The member's own number never counts, and a number another row already shares (older data) is not this edit's doing.
    const own = t.marketing.mktCustomer.find((x) => x.customerId === p.customerId);
    const sameNumber = c.phone !== undefined && c.phone !== normalizeMemberPhone(own?.phone ?? '')
      ? findPhoneMatch(t, c.phone, p.customerId) : null;
    if (sameNumber) return phoneExists(sameNumber);
    return changed({ ...t, marketing: { ...t.marketing, mktCustomer: t.marketing.mktCustomer.map((x) => x.customerId === p.customerId ? { ...x, ...(c.name !== undefined ? { name: c.name.trim() } : {}), ...(c.phone !== undefined ? { phone: c.phone } : {}) } : x) } }, { memberId: p.memberId });
  },
  'members.delete': (ctx, c) => {
    const p = activeMember(ctx.snapshot, c.memberId), t = ctx.tables;
    if (!p) return absent('memberId');
    // F-1: archiving would hide 충전금·외상·이용 중 회원권 from the roster while their transactions remain.
    const open = selectMemberDeleteBlockers(ctx.snapshot, p.memberId);
    if (open.blocked) return { ...conflict('MEMBER_HAS_OPEN_BALANCE', 'memberId'), details: { memberId: p.memberId, charge: open.charge, receivable: open.receivable, passes: open.passes } } as HandlerResult;
    return changed({ ...t, marketing: { ...t.marketing, mktCustomer: t.marketing.mktCustomer.map((x) => x.customerId === p.customerId ? { ...x, deletedAt: NOW } : x) } }, { memberId: p.memberId }, 'data.management.notice.deleted');
  },
  'members.setGrade': (ctx, c) => {
    const p = activeMember(ctx.snapshot, c.memberId), t = ctx.tables;
    if (!p) return absent('memberId');
    if (c.grade !== null && !['regular', 'frequent', 'occasional', 'inactive'].includes(c.grade)) return rejected('GRADE_INVALID', 'grade');
    return changed({ ...t, memberProfile: replace(t.memberProfile, p, { ...p, gradeOverride: c.grade }) }, { memberId: p.memberId });
  },
  'members.addNote': (ctx, c) => {
    if (!activeMember(ctx.snapshot, c.memberId)) return absent('memberId');
    if (!nonempty(c.body)) return rejected('NOTE_REQUIRED', 'body');
    const noteId = ctx.nextId('note');
    return changed({ ...ctx.tables, memberNote: [...ctx.tables.memberNote, { noteId, memberId: c.memberId, body: raw(c.body), updatedAt: NOW }] }, { noteId });
  },
  'members.updateNote': (ctx, c) => {
    const n = ctx.tables.memberNote.find((n) => n.noteId === c.noteId && n.memberId === c.memberId);
    if (!activeMember(ctx.snapshot, c.memberId) || !n) return absent('noteId');
    if (!nonempty(c.body)) return rejected('NOTE_REQUIRED', 'body');
    return changed({ ...ctx.tables, memberNote: replace(ctx.tables.memberNote, n, { ...n, body: raw(c.body), updatedAt: NOW }) }, { noteId: n.noteId });
  },
  'members.deleteNote': (ctx, c) => {
    const n = ctx.tables.memberNote.find((n) => n.noteId === c.noteId && n.memberId === c.memberId);
    return activeMember(ctx.snapshot, c.memberId) && n ? changed({ ...ctx.tables, memberNote: ctx.tables.memberNote.filter((x) => x !== n) }, { noteId: n.noteId }) : absent('noteId');
  },
  'booking.create': (ctx, c) => booking(ctx, c, null),
  'booking.update': (ctx, c) => {
    const r = ctx.tables.reservation.filter((r):r is Reservation=>r.kind!=='pickup').find((r) => r.reservationId === c.reservationId);
    if (!r) return absent('reservationId');
    if (['canceled', 'completed', 'no-show'].includes(r.status)) return conflict('BOOKING_TRANSITION', 'reservationId');
    const field = forbidden(c.patch, ['memberId', 'guest', 'date', 'time', 'partySize', 'request', 'tableChoice']);
    if (field) return rejected('READ_ONLY_FIELD', field);
    const guestName = r.guestName && 'raw' in r.guestName ? r.guestName.raw : '';
    return booking(ctx, { date: r.date, time: r.time, partySize: r.partySize, ...(r.memberId ? { memberId: r.memberId } : { guest: { name: guestName } }), tableChoice: r.assignmentMode === 'manual' && r.tableId ? { tableId: r.tableId } : 'auto', ...c.patch, ...(c.patch.guest ? { memberId: undefined } : c.patch.memberId ? { guest: undefined } : {}), ...(c.confirmDuplicate ? { confirmDuplicate: true } : {}) }, r, c.patch);
  },
  'booking.cancel': (ctx, c) => {
    const r = ctx.tables.reservation.filter((r):r is Reservation=>r.kind!=='pickup').find((r) => r.reservationId === c.reservationId);
    if (!r) return absent('reservationId');
    if (r.status === 'canceled') return changed(ctx.tables);
    return withReservation(ctx, r, { ...r, status: 'canceled', tableId: null, capacityOverride: false }, 'canceled');
  },
  'booking.markCompleted': (ctx, c) => transitionBooking(ctx, c.reservationId, 'completed'),
  'tax.createPayment': ({ tables: t, nextId }, c) => {
    const type = c.taxType;
    if (!nonempty(type)) return rejected('TAX_TYPE_REQUIRED', 'taxType');
    if (!integer(c.amount) || c.amount <= 0) return rejected('AMOUNT_INVALID', 'amount');
    if (!isIsoDate(c.dueOn)) return rejected('DATE_INVALID', 'dueOn');
    // Past due dates stay allowed (recording overdue debt); only an identical obligation is surfaced first.
    const sameTax = c.confirmDuplicate ? undefined : findTaxDuplicate(t.taxPayment, { type, amount: c.amount, dueOn: c.dueOn });
    if (sameTax) return askAgain('TAX_PAYMENT_EXISTS', 'taxType', { taxPaymentId: sameTax.taxPaymentId, type: plainText(sameTax.type), amount: sameTax.amount, dueOn: sameTax.dueOn, status: sameTax.status });
    const taxPaymentId = nextId('tp');
    return changed({ ...t, taxPayment: [...t.taxPayment, { taxPaymentId, type: raw(type), amount: c.amount, dueOn: c.dueOn, paidOn: null, status: 'unpaid', evidence: 'none' }] }, { taxPaymentId });
  },
  'tax.updatePayment': ({ tables: t }, c) => {
    const row = t.taxPayment.find((p) => p.taxPaymentId === c.taxPaymentId);
    if (!row) return absent('taxPaymentId');
    const p = c.patch;
    const field = forbidden(p, ['type', 'amount', 'dueOn', 'paidOn', 'status']);
    if (field) return rejected('READ_ONLY_FIELD', field);
    if (p.type !== undefined && !nonempty(p.type) || p.amount !== undefined && (!integer(p.amount) || p.amount <= 0)) return rejected('AMOUNT_INVALID', 'amount');
    const next = { ...row, ...p, type: p.type !== undefined ? raw(p.type) : row.type };
    if (!isIsoDate(next.dueOn) || !['paid', 'unpaid'].includes(next.status) || next.status === 'paid' && !isIsoDate(next.paidOn) || next.paidOn !== null && !isIsoDate(next.paidOn)) return rejected('DATE_INVALID', 'paidOn');
    return changed({ ...t, taxPayment: replace(t.taxPayment, row, { ...next, paidOn: next.status === 'unpaid' ? null : next.paidOn }) }, { taxPaymentId: row.taxPaymentId });
  },
  'tax.deletePayment': ({ tables: t }, c) => t.taxPayment.some((p) => p.taxPaymentId === c.taxPaymentId) ? changed({ ...t, taxPayment: t.taxPayment.filter((p) => p.taxPaymentId !== c.taxPaymentId) }, { taxPaymentId: c.taxPaymentId }) : absent('taxPaymentId'),
  'tax.markPaid': ({ tables: t }, c) => {
    const p = t.taxPayment.find((p) => p.taxPaymentId === c.taxPaymentId);
    return p ? changed({ ...t, taxPayment: replace(t.taxPayment, p, { ...p, status: 'paid', paidOn: p.paidOn ?? TODAY }) }, { taxPaymentId: p.taxPaymentId }) : absent('taxPaymentId');
  },
  'tax.setEvidence': ({ tables: t }, c) => {
    const p = t.taxPayment.find((p) => p.taxPaymentId === c.taxPaymentId);
    if (!p) return absent('taxPaymentId');
    if (!['example', 'none'].includes(c.evidence)) return rejected('EVIDENCE_INVALID', 'evidence');
    return changed({ ...t, taxPayment: replace(t.taxPayment, p, { ...p, evidence: c.evidence }) }, { taxPaymentId: p.taxPaymentId });
  },
  'calendar.setCategoryVisible': ({ tables: t }, c) => {
    if (!Object.hasOwn(t.categoryVisibility, c.categoryId) || typeof c.visible !== 'boolean') return rejected('CATEGORY_INVALID', 'categoryId');
    return changed({ ...t, categoryVisibility: { ...t.categoryVisibility, [c.categoryId]: c.visible } });
  },
  // N14 grant application records are local. The window controls recording; it cannot establish eligibility.
  'grants.apply': ({ tables: t, nextId }, c) => {
    const n = t.grantNotice.find((n) => n.noticeId === c.noticeId);
    if (!n) return absent('noticeId');
    if (n.applyStart > LEGACY_GRANT_EVALUATION_NOW || n.applyEnd < LEGACY_GRANT_EVALUATION_NOW || t.grantApplication.some((a) => a.noticeId === c.noticeId)) return conflict('APPLICATION_EXISTS', 'noticeId');
    const applicationId = nextId('ga');
    return changed({ ...t, grantApplication: [...t.grantApplication, { applicationId, noticeId: c.noticeId, appliedOn: TODAY, status: 'applied', resultMemo: null }] }, { applicationId });
  },
  'grants.updateApplication': ({ tables: t }, c) => {
    const a = t.grantApplication.find((a) => a.applicationId === c.applicationId);
    if (!a) return absent('applicationId');
    if (c.status !== undefined && !applicationStatuses.includes(c.status)) return rejected('STATUS_INVALID', 'status');
    const status = c.status ?? a.status;
    const resultMemo = c.resultMemo?.trim() ? raw(c.resultMemo) : null;
    const memoChanged = c.resultMemo !== undefined && plainText(resultMemo) !== plainText(a.resultMemo);
    const value = { applicationId: a.applicationId };
    if (status === a.status && !memoChanged) return { ok: true, tables: t, undoable: false, value };
    return changed({ ...t, grantApplication: replace(t.grantApplication, a, { ...a, status, resultMemo: memoChanged ? resultMemo : a.resultMemo }) }, value);
  },
  'grants.deleteApplication': ({ tables: t }, c) => t.grantApplication.some((a) => a.applicationId === c.applicationId) ? changed({ ...t, grantApplication: t.grantApplication.filter((a) => a.applicationId !== c.applicationId) }, { applicationId: c.applicationId }) : absent('applicationId'),
  // End N14 grants.
  'manuals.create': ({ tables: t, nextId }, c) => {
    const invalid = validateManual(c);
    if (invalid) return invalid;
    if (!nonempty(c.title) || !c.category || !c.section) return rejected('TITLE_REQUIRED', 'title');
    // Ask before a second document with the same title (e.g. a second 마감 정리); the owner can still insist.
    const sameTitle = c.confirmDuplicate ? undefined : t.manual.find((m) => normalizeName(plainText(m.title)) === normalizeName(c.title));
    if (sameTitle) return askAgain('MANUAL_TITLE_EXISTS', 'title', { manualId: sameTitle.manualId });
    const manualId = nextId('mn');
    return changed({ ...t, manual: [...t.manual, { manualId, title: raw(c.title), category: c.category, section: c.section, cautions: raw(c.cautions ?? ''), isPublished: true, updatedAt: NOW }], manualStep: [...t.manualStep, ...(c.steps ?? []).map((s, i) => ({ manualId, stepNo: i + 1, body: raw(typeof s === 'string' ? s : s.body), ...(typeof s !== 'string' && s.photoKey ? { photoKey: s.photoKey } : {}) }))] }, { manualId });
  },
  'manuals.update': ({ tables: t }, c) => {
    const m = t.manual.find((m) => m.manualId === c.manualId);
    if (!m) return absent('manualId');
    const field = forbidden(c.patch, ['title', 'category', 'section', 'steps', 'cautions']);
    if (field) return rejected('READ_ONLY_FIELD', field);
    const invalid = validateManual(c.patch);
    if (invalid) return invalid;
    const p = c.patch;
    const steps = p.steps ? [...t.manualStep.filter((s) => s.manualId !== m.manualId), ...p.steps.map((s, i) => ({ manualId: m.manualId, stepNo: i + 1, body: raw(typeof s === 'string' ? s : s.body), ...(typeof s !== 'string' && s.photoKey ? { photoKey: s.photoKey } : {}) }))] : t.manualStep;
    return changed({ ...t, manual: replace(t.manual, m, { ...m, ...(p.title !== undefined ? { title: raw(p.title) } : {}), ...(p.category ? { category: p.category } : {}), ...(p.section ? { section: p.section } : {}), ...(p.cautions !== undefined ? { cautions: raw(p.cautions) } : {}), updatedAt: NOW }), manualStep: steps, checklistLog: p.steps ? t.checklistLog.filter((l) => l.manualId !== m.manualId || l.stepNo <= p.steps!.length) : t.checklistLog }, { manualId: m.manualId });
  },
  'manuals.delete': ({ tables: t }, c) => t.manual.some((m) => m.manualId === c.manualId) ? changed({ ...t, manual: t.manual.filter((m) => m.manualId !== c.manualId), manualStep: t.manualStep.filter((s) => s.manualId !== c.manualId), checklistLog: t.checklistLog.filter((l) => l.manualId !== c.manualId) }, { manualId: c.manualId }, 'data.management.notice.deleted') : absent('manualId'),
};
export function transitionBooking(ctx: HandlerContext, reservationId: string, status: 'confirmed' | 'proposed' | 'no-show' | 'completed', proposedTime?: string): HandlerResult {
  const r = ctx.tables.reservation.filter((r):r is Reservation=>r.kind!=='pickup').find((r) => r.reservationId === reservationId);
  if (!r) return absent('reservationId');
  if (status === 'confirmed' || status === 'proposed') {
    if (r.status !== 'needs-check') return conflict('BOOKING_TRANSITION', 'reservationId');
    if (status === 'proposed' && !isTime(proposedTime)) return rejected('TIME_INVALID', 'time');
    const allocation = status === 'confirmed' ? allocateReservation(ctx.tables, r, r.assignmentMode === 'manual' && r.tableId ? { tableId: r.tableId } : 'auto') : null;
    return withReservation(ctx, r, { ...r, status, confirmedBy: status === 'confirmed' ? 'person' : r.confirmedBy, tableId: allocation?.tableId ?? null, allocationWarning: allocation?.allocationWarning, capacityOverride: status === 'confirmed' && allocation?.status === 'needs-check', proposedTime: proposedTime ?? null }, 'status');
  }
  if (r.status !== 'confirmed') return conflict('BOOKING_TRANSITION', 'reservationId');
  if (!slotHasPassed(r.date, r.time)) return { ok: false, code: 'CONFLICT', messageKey: 'data.error.notYetTime', reason: 'NOT_YET_TIME', field: 'reservationId' };
  return withReservation(ctx, r, { ...r, status }, 'status');
}
// Query validation errors never escape a command boundary.
export const queryFailure = (e: unknown): HandlerResult => { if (e instanceof DataQueryError) return rejected(e.code, e.field, e.code); throw e; };
