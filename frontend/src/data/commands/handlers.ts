/**
 * Command handlers: validate → new tables. Failures never change state. Undoable flags follow
 * DATA_MODEL 10.11 (‘(예시)’-only completions and settings toggles are not undoable).
 */
import type { CalendarSource, Channel, DataTables, DataText, Evidence, ExpenseCategory, ManualCategory, Material, Zone } from '../db/types';
import { dateOf, isIsoDate, isTime, MINIMUM_WAGE, NOW, TODAY } from '../db/time';
import { normalizeCondition } from '../conditions';
import { selectWidget } from '../models/select';
import type { DataSnapshot } from '../db/types';
import { MATERIALS, MOODS } from '../models/store';
import type { DataCommand, DataCommandType, DataErrorCode } from './types';
import { managementHandlers, rejected, changed, transitionBooking } from './management';
import { askAgain, dateIsPast, findExpenseDuplicate, findSameName, nameExists, plainText, refuse } from './management-guards';
import { selectCctvReviewTarget } from './management-guards'; // N19
import { isExpenseDayClosed } from './management-guards'; // D-326
import { deriveStock, purchaseQuantityBase } from '../derive/stock';
import { toBase } from '../derive/common';
import { membershipActive as linkedMembershipActive } from '../derive/members';
import { marketingHandlers } from '../marketing/commands';
import { noticeHandlers } from '../iteration7/notices';
import { environmentHandlers } from '../iteration7/environment';
import type { CustomOrderCommand } from '../iteration7/custom-orders';
import { staffHandlers } from '../iteration7/staff/commands';
import { staffCalendarClock } from '../iteration7/staff/clock';
import { guardCalendarWrite } from './calendar-guard';
import { checkCommunityResponse, checkInquiryReply, planInquiryDraft, type CommunityResponseCommand, type InquiryDraftCommand, type InquiryReplyCommand } from './reply-guard'; // N17

export interface HandlerContext { readonly snapshot: DataSnapshot; readonly tables: DataTables; nextId(prefix: string): string }
export type HandlerResult =
  | { readonly ok: true; readonly tables: DataTables; readonly undoable: boolean; readonly noticeKey?: string; readonly params?: Readonly<Record<string, string | number>>; readonly value?: unknown }
  | { readonly ok: false; readonly code: DataErrorCode; readonly field?: string; readonly messageKey: string; readonly reason?: string; readonly details?: Readonly<Record<string, unknown>> };

const fail = (code: DataErrorCode, messageKey: string, field?: string): HandlerResult => (field ? { ok: false, code, field, messageKey } : { ok: false, code, messageKey });
const notFound = (field?: string) => fail('NOT_FOUND', 'data.error.notFound', field);
const done = () => fail('CONFLICT', 'data.error.alreadyDone');
const ok = (tables: DataTables, undoable: boolean, noticeKey?: string, params?: Readonly<Record<string, string | number>>, value?: unknown): HandlerResult =>
  ({ ok: true, tables, undoable, ...(noticeKey ? { noticeKey } : {}), ...(params ? { params } : {}), ...(value !== undefined ? { value } : {}) });
const patch = <T>(rows: readonly T[], match: (row: T) => boolean, change: (row: T) => T): T[] => rows.map((row) => (match(row) ? change(row) : row));
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const raw = (value: string): DataText => ({ raw: value });
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = ['ingredients', 'operations', 'supplies', 'labor', 'rent', 'other'];
const EVIDENCE: readonly Evidence[] = ['receipt', 'tax-invoice', 'card', 'none'];
const SOURCES: readonly CalendarSource[] = ['pickup', 'delivery', 'reservation', 'shift', 'deadline', 'direct'];
const CHANNELS: readonly Channel[] = ['store', 'online'];
const ZONES: readonly Zone[] = ['window', 'center', 'bar'];
// N14 manual drafts follow the manual editor's limits.
const MANUAL_CATEGORIES: readonly ManualCategory[] = ['opening', 'closing', 'recipe', 'cleaning', 'new-staff', 'hygiene', 'store-info'];
const MAX_DRAFT_STEPS = 5;
const MAX_DRAFT_LENGTH = 700;
const memoDraftTitle = (memo: string) => Array.from(text(memo).split('\n')[0]).slice(0, 40).join('').trim();
// End N14 draft limits.

type Handler<T extends DataCommandType> = (ctx: HandlerContext, command: Extract<DataCommand, { type: T }>) => HandlerResult;
type Handlers = { readonly [T in Exclude<DataCommandType, CustomOrderCommand['type'] | import('../reality/05/commands').MemberRealCommand['type'] | import('../reality/09/commands').MoneyRealCommand['type'] | import('../reality/08/commands').CustomRealCommand['type'] | import('../reality/06/commands').BookingRealCommand['type'] | 'grants.syncNotices' | 'closing.closeDay' | 'closing.undoDay' | 'onboarding.setAnswers' | 'shop.updateSettings'>]: Handler<T> };

const membershipActive = (t: DataTables, membershipId: string) => {
  const m = t.membership.find((x) => x.membershipId === membershipId);
  const product = m ? t.membershipProduct.find((p) => p.productId === m.productId) : undefined;
  return { m, product, active: !!m && linkedMembershipActive({ revision: 0, seq: 0, tables: t }, membershipId) };
};
const remainingOf = (t: DataTables, polId: string): number => {
  const line = t.purchaseOrderLine.find((l) => l.polId === polId);
  return line ? line.qtyOrdered - t.receipt.filter((r) => r.polId === polId).reduce((s, r) => s + r.qty, 0) : 0;
};
const poOpen = (t: DataTables, poId: string): boolean => {
  const po = t.purchaseOrder.find((p) => p.poId === poId);
  return !!po && po.status !== 'complete' && po.status !== 'canceled';
};

/** Commands that exist only over HTTP (REAL-PLAN): the fixture store has no such record to change. */
const realOnly = (): HandlerResult => ({ ok: false, code: 'CONFLICT', reason: 'REAL_ONLY', messageKey: 'data.real.error.SOURCE_UNAVAILABLE' });

export const handlers: Handlers = {
  'tax.attachEvidence': realOnly,
  'tax.detachEvidence': realOnly,
  'promo.addPhoto': realOnly,
  'promo.saveDraft': realOnly,
  'promo.publishPlaceNews': realOnly,
  'promo.publishClip': realOnly,
  'promo.attestLink': realOnly,
  'inventory.registerBatch': realOnly,
  'inventory.discardBatch': realOnly,
  ...staffHandlers,
  ...noticeHandlers,
  ...environmentHandlers,
  // D-326 reversible edits and publication withdrawal.
  'ledger.updateExpense': ({ tables: t }, c) => {
    const expense = t.expense.find(row => row.expenseId === c.expenseId && row.status === 'confirmed');
    if (!expense) return notFound('expenseId');
    const date = c.date === undefined ? expense.businessDate : c.date;
    const category = c.category === undefined ? expense.category : c.category;
    const amount = c.amount === undefined ? expense.amount : c.amount;
    if (!isIsoDate(date)) return fail('VALIDATION', 'data.error.dateInvalid', 'date');
    if (date > TODAY) return refuse('VALIDATION', 'EXPENSE_DATE_FUTURE', 'date', { businessDate: TODAY });
    if (isExpenseDayClosed(t, expense.businessDate) || isExpenseDayClosed(t, date)) {
      return { ...refuse('CONFLICT', 'DAY_CLOSED', 'date'), messageKey: 'data.management.error.EXPENSE_DAY_CLOSED' };
    }
    if (!EXPENSE_CATEGORIES.includes(category)) return fail('VALIDATION', 'data.error.categoryInvalid', 'category');
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail('VALIDATION', 'data.error.amountInvalid', 'amount');
    if (c.memo !== undefined && typeof c.memo !== 'string') return refuse('VALIDATION', 'READ_ONLY_FIELD', 'memo');
    const memoChanged = c.memo !== undefined && c.memo.trim() !== plainText(expense.memo);
    const value = { expenseId: expense.expenseId };
    if (date === expense.businessDate && category === expense.category && amount === expense.amount && !memoChanged) {
      return ok(t, false, undefined, undefined, value);
    }
    const memo = memoChanged ? (c.memo!.trim() ? raw(c.memo!.trim()) : null) : expense.memo;
    const updated = { ...expense, businessDate: date, category, amount, memo };
    return ok({ ...t, expense: t.expense.map(row => row === expense ? updated : row) }, true, 'data.management.notice.saved', undefined, value);
  },
  'manuals.setPublished': ({ tables: t }, c) => {
    if (c.published !== false) return refuse('VALIDATION', 'READ_ONLY_FIELD', 'published');
    const manual = t.manual.find(row => row.manualId === c.manualId);
    if (!manual) return notFound('manualId');
    const value = { manualId: manual.manualId };
    if (!manual.isPublished) return ok(t, false, undefined, undefined, value);
    return ok({ ...t, manual: t.manual.map(row => row === manual ? { ...row, isPublished: false, updatedAt: NOW } : row) },
      true, 'data.management.notice.saved', undefined, value);
  },
  // End D-326.
  'ledger.recordExpense': ({ tables: t, nextId }, c) => {
    if (!isIsoDate(c.date)) return fail('VALIDATION', 'data.error.dateInvalid', 'date');
    if (!EXPENSE_CATEGORIES.includes(c.category)) return fail('VALIDATION', 'data.error.categoryInvalid', 'category');
    if (!isInt(c.amount) || c.amount <= 0) return fail('VALIDATION', 'data.error.amountInvalid', 'amount');
    const evidence = c.evidence ?? 'receipt';
    if (!EVIDENCE.includes(evidence)) return fail('VALIDATION', 'data.error.evidenceInvalid', 'evidence');
    if (c.supplierId !== undefined && !t.supplier.some((s) => s.supplierId === c.supplierId)) return notFound('supplierId');
    // Past dates are an explicit historical entry and stay allowed; money not spent yet is not an expense.
    if (c.date > TODAY) return refuse('VALIDATION', 'EXPENSE_DATE_FUTURE', 'date', { businessDate: TODAY });
    const memo = text(c.memo);
    const same = c.confirmDuplicate ? undefined : findExpenseDuplicate(t.expense, { date: c.date, category: c.category, amount: c.amount, supplierId: c.supplierId ?? null, memo });
    if (same) return askAgain('LIKELY_DUPLICATE_EXPENSE', 'amount', { expenseId: same.expenseId, date: same.businessDate, category: same.category, amount: same.amount });
    const expenseId = nextId('e-new');
    return ok({ ...t, expense: [...t.expense, { expenseId, businessDate: c.date, category: c.category, amount: c.amount, supplierId: c.supplierId ?? null, receiptId: null, evidence, status: 'confirmed', memo: memo ? raw(memo) : null }] },
      true, 'data.notice.expenseRecorded', { amount: c.amount }, { expenseId });
  },
  'ledger.confirmCandidate': ({ tables: t }, c) => {
    const e = t.expense.find((x) => x.expenseId === c.expenseId);
    if (!e) return notFound('expenseId');
    if (e.status !== 'candidate') return done();
    return ok({ ...t, expense: patch(t.expense, (x) => x.expenseId === c.expenseId, (x) => ({ ...x, status: 'confirmed' })) }, true, 'data.notice.candidateConfirmed', { amount: e.amount });
  },
  'tax.markChecked': ({ tables: t }, c) => {
    const e = t.expense.find((x) => x.expenseId === c.refId && x.status === 'confirmed' && x.evidence === 'none');
    if (!e) return notFound('refId');
    if (t.taxReview.some((r) => r.refId === c.refId && r.status === 'checked')) return done();
    const others = t.taxReview.filter((r) => r.refId !== c.refId);
    return ok({ ...t, taxReview: [...others, { refType: 'expense', refId: c.refId, status: 'checked' }] }, true, 'data.notice.taxChecked');
  },
  'tax.export': ({ snapshot, tables: t }, c) => {
    const period = c.period;
    const normalized = period && typeof period === 'object' ? normalizeCondition('tax', { kind: 'dateRange', start: period.start, end: period.end }) : null;
    if (!normalized?.ok) return fail('VALIDATION', 'data.error.periodRequired', 'period');
    const view = selectWidget(snapshot, 'tax', normalized.value, 'normal');
    return ok(t, false, 'data.notice.exported', undefined, view.status === 'ready' ? view.model.exportPreview : undefined);
  },
  'grants.markReviewed': ({ tables: t }, c) => {
    if (!t.grantNotice.some((n) => n.noticeId === c.noticeId)) return notFound('noticeId');
    if (t.grantReview.some((r) => r.noticeId === c.noticeId && r.reviewStatus === 'reviewed')) return done();
    return ok({ ...t, grantReview: [...t.grantReview.filter((r) => r.noticeId !== c.noticeId), { noticeId: c.noticeId, reviewStatus: 'reviewed' }] }, true, 'data.notice.grantReviewed');
  },
  // N19 CCTV review.
  'cctv.markPeakForReview': ({ tables: t }, c) => {
    const target = selectCctvReviewTarget(t, c.date, c.hour);
    if ('reason' in target) {
      return target.reason === 'outside_hours'
        ? refuse('VALIDATION', 'CCTV_TODAY_ONLY', c.date !== TODAY ? 'date' : 'hour', { businessDate: TODAY })
        : notFound('hour');
    }
    const { row } = target;
    if (row.reviewMarked) return done();
    return ok({ ...t, cctvHourly: patch(t.cctvHourly, (r) => r === row, (r) => ({ ...r, reviewMarked: true })) }, true, 'data.notice.peakMarked', { hour: c.hour });
  },
  // End N19 CCTV review.
  'memberships.useOnce': ({ tables: t, nextId }, c) => {
    const { m, product, active } = membershipActive(t, c.membershipId);
    if (!m || !product) return notFound('membershipId');
    if (!active) return fail('CONFLICT', 'data.error.membershipInactive', 'membershipId');
    if (product.kind === 'count' && (m.usesLeft ?? 0) < 1) return fail('VALIDATION', 'data.error.noUsesLeft', 'membershipId');
    if (product.kind === 'period' && product.dailyLimit && t.membershipUse.some((u) => u.membershipId === m.membershipId && u.canceledAt === null && dateOf(u.usedAt) === TODAY))
      return fail('VALIDATION', 'data.error.dailyLimit', 'membershipId');
    const useId = nextId('mu');
    const usesLeft = product.kind === 'count' ? (m.usesLeft ?? 0) - 1 : null;
    return ok({ ...t, membership: patch(t.membership, (x) => x.membershipId === m.membershipId, (x) => ({ ...x, usesLeft })), membershipUse: [...t.membershipUse, { useId, membershipId: m.membershipId, usedAt: NOW, canceledAt: null }] },
      true, 'data.notice.membershipUsed', usesLeft === null ? undefined : { usesLeft }, { useId });
  },
  'memberships.cancelUse': ({ tables: t }, c) => {
    const use = t.membershipUse.find((u) => u.useId === c.useId);
    if (!use) return notFound('useId');
    if (use.canceledAt !== null) return done();
    if (dateOf(use.usedAt) !== TODAY) return fail('VALIDATION', 'data.error.cancelSameDayOnly', 'useId');
    const { m, product } = membershipActive(t, use.membershipId);
    if (!m || !product || m.customerId && (!t.memberProfile.some((p) => p.customerId === m.customerId) || !t.marketing.mktCustomer.some((c) => c.customerId === m.customerId && !c.deletedAt))) return fail('CONFLICT', 'data.error.membershipInactive', 'membershipId');
    return ok({
      ...t,
      membershipUse: patch(t.membershipUse, (u) => u.useId === c.useId, (u) => ({ ...u, canceledAt: NOW })),
      membership: product?.kind === 'count' && m ? patch(t.membership, (x) => x.membershipId === m.membershipId, (x) => ({ ...x, usesLeft: (x.usesLeft ?? 0) + 1 })) : t.membership,
    }, true, 'data.notice.membershipUseCanceled');
  },
  'booking.confirm': (ctx, c) => transitionBooking(ctx, c.reservationId, 'confirmed'),
  'booking.propose': (ctx, c) => transitionBooking(ctx, c.reservationId, 'proposed', c.time),
  'booking.markNoShow': (ctx, c) => transitionBooking(ctx, c.reservationId, 'no-show'),
  'calendar.addEvent': ({ tables: t, nextId }, c) => {
    const title = text(c.title);
    if (!title) return fail('VALIDATION', 'data.error.titleRequired', 'title');
    if (!isIsoDate(c.date)) return fail('VALIDATION', 'data.error.dateInvalid', 'date');
    if (c.time != null && !isTime(c.time)) return fail('VALIDATION', 'data.error.timeInvalid', 'time');
    if (c.categoryId !== undefined && !['store-operations', 'purchasing', 'tax-admin'].includes(c.categoryId)) return rejected('CATEGORY_INVALID', 'categoryId');
    const closure = c.storeClosure;
    if (closure && ((c.categoryId ?? 'store-operations') !== 'store-operations' || !['regular','temporary'].includes(closure.kind) || !isIsoDate(closure.endDate) || closure.endDate < c.date)) return fail('VALIDATION','data.notices.error.INVALID_DATE_RANGE','storeClosure');
    const blocked = guardCalendarWrite(t, c); if (blocked) return blocked;
    const eventId = nextId('ev');
    const memo = text(c.memo);
    return ok({ ...t, calendarEvent: [...t.calendarEvent, { eventId, revision: 1, storeClosure: c.storeClosure ?? null, categoryId: c.categoryId ?? 'store-operations', kind: 'event', title: raw(title), date: c.date, time: c.time ?? null, memo: memo ? raw(memo) : null }] }, true, 'data.notice.calendarAdded', undefined, { eventId });
  },
  'calendar.addTodo': ({ tables: t, nextId }, c) => {
    const title = text(c.title);
    if (!title) return fail('VALIDATION', 'data.error.titleRequired', 'title');
    const date = c.date ?? staffCalendarClock(t).date;
    if (!isIsoDate(date)) return fail('VALIDATION', 'data.error.dateInvalid', 'date');
    const blocked = guardCalendarWrite(t, c); if (blocked) return blocked;
    const eventId = nextId('todo');
    const memo = text(c.memo);
    return ok({ ...t, calendarEvent: [...t.calendarEvent, { eventId, kind: 'todo', title: raw(title), date, time: null, memo: memo ? raw(memo) : null }] }, true, 'data.notice.calendarAdded', undefined, { eventId });
  },
  'calendar.updateEvent': ({ tables: t }, c) => {
    if (c.eventId.startsWith('shift:') || t.staffSchedule.some(r => r.scheduleId === c.eventId)) return { ok: false, code: 'CONFLICT', reason: 'READ_ONLY_SOURCE', messageKey: 'data.staff.error.READ_ONLY_SOURCE' };
    const e = t.calendarEvent.find((x) => x.eventId === c.eventId);
    if (!e) return c.eventId.includes(':') ? rejected('AUTO_EVENT_READ_ONLY', 'eventId', 'CONFLICT') : notFound('eventId');
    if (c.title !== undefined && !text(c.title)) return fail('VALIDATION', 'data.error.titleRequired', 'title');
    if (c.date !== undefined && !isIsoDate(c.date)) return fail('VALIDATION', 'data.error.dateInvalid', 'date');
    if (c.time != null && !isTime(c.time)) return fail('VALIDATION', 'data.error.timeInvalid', 'time');
    if (c.categoryId !== undefined && !['store-operations', 'purchasing', 'tax-admin'].includes(c.categoryId)) return rejected('CATEGORY_INVALID', 'categoryId');
    const closure = c.storeClosure === undefined ? e.storeClosure : c.storeClosure;
    if (closure && (e.kind !== 'event' || (c.categoryId ?? e.categoryId ?? 'store-operations') !== 'store-operations' || !['regular','temporary'].includes(closure.kind) || !isIsoDate(closure.endDate) || closure.endDate < (c.date ?? e.date))) return fail('VALIDATION','data.notices.error.INVALID_DATE_RANGE','storeClosure');
    const changed = (c.title !== undefined && text(c.title) !== ('raw' in e.title ? e.title.raw : '')) || (c.date !== undefined && c.date !== e.date) || (c.time !== undefined && c.time !== e.time) || (c.memo !== undefined && text(c.memo) !== (e.memo && 'raw' in e.memo ? e.memo.raw : '')) || (c.categoryId !== undefined && c.categoryId !== e.categoryId) || JSON.stringify(closure) !== JSON.stringify(e.storeClosure);
    const blocked = guardCalendarWrite(t, c); if (blocked) return blocked;
    if (!changed) return ok(t,false);
    return ok({ ...t, calendarEvent: patch(t.calendarEvent, (x) => x === e, (x) => ({
      ...x, revision:(x.revision ?? 0)+1, storeClosure:closure, ...(c.categoryId !== undefined ? { categoryId: c.categoryId } : {}), ...(c.title !== undefined ? { title: raw(text(c.title)) } : {}), ...(c.date !== undefined ? { date: c.date } : {}), ...(c.time !== undefined ? { time: c.time } : {}),
      ...(c.memo !== undefined ? { memo: text(c.memo) ? raw(text(c.memo)) : null } : {}),
    })) }, true, 'data.notice.calendarUpdated');
  },
  'calendar.deleteEvent': ({ tables: t }, c) => {
    if (c.eventId.startsWith('shift:') || t.staffSchedule.some(r => r.scheduleId === c.eventId)) return { ok: false, code: 'CONFLICT', reason: 'READ_ONLY_SOURCE', messageKey: 'data.staff.error.READ_ONLY_SOURCE' };
    if (!t.calendarEvent.some((x) => x.eventId === c.eventId)) return c.eventId.includes(':') ? rejected('AUTO_EVENT_READ_ONLY', 'eventId', 'CONFLICT') : notFound('eventId');
    return ok({ ...t, calendarEvent: t.calendarEvent.filter((x) => x.eventId !== c.eventId) }, true, 'data.notice.calendarDeleted');
  },
  'calendar.setSourceVisible': ({ tables: t }, c) => {
    if (!SOURCES.includes(c.source) || typeof c.visible !== 'boolean') return fail('VALIDATION', 'data.error.sourceInvalid', 'source');
    if (t.calendarSettings[c.source] === c.visible) return ok(t, false);
    return ok({ ...t, calendarSettings: { ...t.calendarSettings, [c.source]: c.visible } }, false);
  },
  'inventory.moveChannel': ({ tables: t, nextId }, c) => {
    const item = t.inventoryItem.find((i) => i.itemId === c.itemId);
    if (!item) return notFound('itemId');
    if (item.kind !== 'retail') return fail('VALIDATION', 'data.error.notRetail', 'itemId');
    if (!CHANNELS.includes(c.from) || !CHANNELS.includes(c.to) || c.from === c.to) return fail('VALIDATION', 'data.error.channelInvalid', 'to');
    const have = t.inventoryStock.find((s) => s.itemId === c.itemId && s.channel === c.from)?.qty ?? 0;
    if (!isInt(c.qty) || c.qty < 1) return fail('VALIDATION', 'data.error.qtyMin', 'qty');
    if (c.qty > have) return fail('VALIDATION', `data.error.moveOverStock.${c.from}`, 'qty');
    const stock = t.inventoryStock.map((s) => (s.itemId !== c.itemId ? s : s.channel === c.from ? { ...s, qty: (s.qty ?? 0) - c.qty } : s.channel === c.to ? { ...s, qty: (s.qty ?? 0) + c.qty } : s));
    const ref = nextId('mv');
    return ok({ ...t, inventoryStock: stock, inventoryTxn: [...t.inventoryTxn, { txnId: `${ref}-out`, itemId: c.itemId, type: 'move', qty: -c.qty, channel: c.from, ref, idempotencyKey: null, at: NOW }, { txnId: `${ref}-in`, itemId: c.itemId, type: 'move', qty: c.qty, channel: c.to, ref, idempotencyKey: null, at: NOW }] },
      true, 'data.notice.channelMoved', { qty: c.qty });
  },
  'inventory.updateItem': ({ snapshot, tables: t, nextId }, c) => {
    const item = t.inventoryItem.find((i) => i.itemId === c.itemId && !i.deletedAt);
    if (!item) return notFound('itemId');
    if (item.kind !== 'ingredient') return fail('VALIDATION', 'data.error.notIngredient', 'itemId');
    const field = Object.keys(c).find((key) => !['type', 'itemId', 'name', 'stock', 'threshold', 'baseRevision'].includes(key));
    if (field) return rejected('READ_ONLY_FIELD', field);
    if (c.name !== undefined && !text(c.name)) return rejected('NAME_REQUIRED', 'name');
    const sameName = c.name !== undefined ? findSameName(t.inventoryItem.filter((i) => i.kind === 'ingredient' && !i.deletedAt), (i) => plainText(i.name, i.nameKey), c.name, (i) => i.itemId === item.itemId) : undefined;
    if (sameName) return nameExists(sameName.itemId);
    if (c.stock === undefined && c.threshold === undefined && c.name === undefined) return fail('VALIDATION', 'data.error.numberInvalid', 'stock');
    if (c.stock !== undefined && (!isNum(c.stock) || c.stock < 0)) return rejected('NUMBER_INVALID', 'stock');
    if (c.threshold !== undefined && (!isNum(c.threshold) || c.threshold < 0)) return rejected('NUMBER_INVALID', 'threshold');
    if (c.stock !== undefined && toBase(c.stock, item.unit) === null) return rejected('UNIT_PRECISION', 'stock');
    if (c.threshold !== undefined && toBase(c.threshold, item.unit) === null) return rejected('UNIT_PRECISION', 'threshold');
    const before = deriveStock(snapshot, { date: TODAY }).rows.find((r) => r.itemId === c.itemId)!;
    const deltaBase = c.stock === undefined ? 0 : toBase(c.stock, item.unit)! - before.rawBase;
    const adjustmentId = deltaBase ? nextId('adjust') : undefined;
    return changed({ ...t,
      inventoryItem: patch(t.inventoryItem, (i) => i === item, (i) => ({ ...i, ...(c.name !== undefined ? { name: raw(text(c.name)) } : {}), ...(c.threshold !== undefined ? { restockThreshold: c.threshold } : {}) })),
      stockAdjustment: adjustmentId ? [...t.stockAdjustment, { adjustmentId, itemId: c.itemId, at: NOW, seq: Number(adjustmentId.split('-').at(-1)), deltaBase, reason: 'cell-edit' }] : t.stockAdjustment,
    }, { itemId: c.itemId, currentStock: c.stock ?? before.display, ...(adjustmentId ? { adjustmentId } : {}) }, 'data.notice.itemUpdated');
  },
  'suppliers.recordReceipt': ({ tables: t, nextId }, c) => {
    const line = t.purchaseOrderLine.find((l) => l.polId === c.polId);
    if (!line) return notFound('polId');
    if (!poOpen(t, line.poId)) return done();
    if (!isNum(c.qty) || c.qty < 1) return fail('VALIDATION', 'data.error.qtyMin', 'qty');
    const remaining = remainingOf(t, c.polId);
    if (c.qty > remaining) return fail('VALIDATION', 'data.error.qtyOverRemaining', 'qty');
    const po = t.purchaseOrder.find((p) => p.poId === line.poId)!;
    const item = t.inventoryItem.find((i) => i.itemId === line.itemId);
    if (!item || purchaseQuantityBase(c.qty, line.unitSnapshot ?? item.unit, line.basePerUnit) === null) return rejected('UNIT_PRECISION', 'qty');
    const receiptId = nextId('rc');
    const expenseId = nextId('e-rc');
    const receipt = [...t.receipt, { receiptId, polId: c.polId, qty: c.qty, receivedAt: NOW, seq: Number(receiptId.split('-').at(-1)), idempotencyKey: c.idempotencyKey }];
    const allReceived = t.purchaseOrderLine.filter((l) => l.poId === po.poId).every((l) => l.qtyOrdered - receipt.filter((r) => r.polId === l.polId).reduce((s, r) => s + r.qty, 0) <= 0);
    return ok({
      ...t, receipt,
      purchaseOrder: patch(t.purchaseOrder, (p) => p === po, (p) => ({ ...p, status: allReceived ? 'complete' : 'partial' })),
      expense: [...t.expense, { expenseId, businessDate: TODAY, category: 'ingredients', amount: Math.round(c.qty * line.unitPrice), supplierId: po.supplierId, receiptId, evidence: 'tax-invoice', status: 'candidate', memo: { key: 'data.expense.memo.delivery', keyParams: { item: item?.nameKey ?? '' } } }],
    }, true, 'data.notice.receiptRecorded', { qty: c.qty }, { receiptId, expenseId });
  },
  'suppliers.changeDueDate': ({ tables: t }, c) => {
    if (!t.purchaseOrder.some((p) => p.poId === c.poId)) return notFound('poId');
    if (!isIsoDate(c.date)) return fail('VALIDATION', 'data.error.dateInvalid', 'date');
    if (!poOpen(t, c.poId)) return done();
    if (dateIsPast(c.date)) return refuse('VALIDATION', 'DUE_DATE_PAST', 'date', { businessDate: TODAY });
    return ok({ ...t, purchaseOrder: patch(t.purchaseOrder, (p) => p.poId === c.poId, (p) => ({ ...p, dueDate: c.date })) }, true, 'data.notice.dueDateChanged', { date: c.date });
  },
  'hiring.saveDraft': ({ tables: t }, c) => {
    if (!Array.isArray(c.days) || c.days.length === 0 || !c.days.every((d) => isInt(d) && d >= 1 && d <= 7)) return fail('VALIDATION', 'data.error.daysRequired', 'days');
    if (!isTime(c.start) || !isTime(c.end) || c.start >= c.end) return fail('VALIDATION', 'data.error.timeRangeInvalid', 'end');
    if (!isInt(c.hourlyWage) || c.hourlyWage < MINIMUM_WAGE) return fail('VALIDATION', 'data.error.wageBelowMinimum', 'hourly_wage');
    if (!Array.isArray(c.tasks) || c.tasks.length === 0) return fail('VALIDATION', 'data.error.tasksRequired', 'tasks');
    if (!c.contact) return fail('VALIDATION', 'data.error.contactRequired', 'contact');
    return ok({ ...t, jobPostDraft: { days: [...c.days].sort(), start: c.start, end: c.end, tasks: c.tasks, hourlyWage: c.hourlyWage, contact: c.contact, status: 'draft' } }, false, 'data.notice.draftSaved');
  },
  'hiring.markCopied': ({ tables: t }) => {
    if (!t.jobPostDraft) return fail('CONFLICT', 'data.error.noDraft');
    return ok({ ...t, jobPostDraft: { ...t.jobPostDraft, status: 'copied' } }, false, 'data.notice.copied');
  },
  // N14 manual checklist and draft lifecycle.
  'manuals.toggleStep': ({ tables: t }, c) => {
    const manual = t.manual.find((m) => m.manualId === c.manualId && m.isPublished);
    if (!manual || !t.manualStep.some((s) => s.manualId === c.manualId && s.stepNo === c.stepNo)) return notFound('stepNo');
    // Only opening/closing handover manuals are checklists (same rule as `ManualRow.checklist`).
    if (manual.section === 'store-info' || manual.category !== 'opening' && manual.category !== 'closing') return refuse('CONFLICT', 'NOT_CHECKLIST', 'manualId', { manualId: manual.manualId, category: manual.category });
    if (c.checked !== undefined && typeof c.checked !== 'boolean') return fail('VALIDATION', 'data.error.stepsRequired', 'checked');
    const checked = t.checklistLog.some((l) => l.date === TODAY && l.manualId === c.manualId && l.stepNo === c.stepNo);
    // A requested state that already holds is kept as it is: saying "1번 했어" twice must not uncheck step 1.
    if (c.checked !== undefined && c.checked === checked) return ok(t, false);
    return ok({ ...t, checklistLog: checked ? t.checklistLog.filter((l) => !(l.date === TODAY && l.manualId === c.manualId && l.stepNo === c.stepNo)) : [...t.checklistLog, { date: TODAY, manualId: c.manualId, stepNo: c.stepNo }] },
      true, checked ? 'data.notice.stepUnchecked' : 'data.notice.stepChecked');
  },
  'manuals.createDraftFromMemo': ({ tables: t, nextId }, c) => {
    const memo = text(c.memo);
    if (!memo) return fail('VALIDATION', 'data.error.memoRequired', 'memo');
    if (c.section !== undefined && !['handover', 'store-info'].includes(c.section)) return rejected('SECTION_INVALID', 'section');
    const title = memoDraftTitle(memo);
    const cautions = text(c.cautions);
    if (title.length + memo.length + cautions.length > MAX_DRAFT_LENGTH) return rejected('STEPS_INVALID', 'memo');
    const section = c.section ?? 'handover';
    const draftId = nextId('md');
    return ok({ ...t, manualDraft: [...t.manualDraft, { draftId, memo, section, cautions: raw(cautions), title: raw(title), category: section === 'store-info' ? 'store-info' : 'cleaning', steps: [raw(memo)], status: 'draft' }] },
      true, 'data.notice.draftCreated', undefined, { draftId });
  },
  'manuals.saveDraft': ({ tables: t, nextId }, c) => {
    const draft = t.manualDraft.find((d) => d.draftId === c.draftId);
    if (!draft) return notFound('draftId');
    if (draft.status !== 'draft') return done();
    if (c.steps !== undefined && !Array.isArray(c.steps)) return fail('VALIDATION', 'data.error.stepsRequired', 'steps');
    if (c.category !== undefined && !MANUAL_CATEGORIES.includes(c.category)) return fail('VALIDATION', 'data.error.categoryInvalid', 'category');
    if (c.section !== undefined && !['handover', 'store-info'].includes(c.section)) return rejected('SECTION_INVALID', 'section');
    const legacyDraft = 'key' in draft.title && draft.title.key === 'data.manual.draft.title';
    const title = c.title !== undefined ? raw(text(c.title)) : legacyDraft ? raw(memoDraftTitle(draft.memo)) : draft.title;
    const titleText = plainText(title).trim();
    if (!titleText) return fail('VALIDATION', 'data.error.titleRequired', 'title');
    const steps = c.steps ? c.steps.map((s) => raw(text(s))) : legacyDraft ? [raw(text(draft.memo))] : draft.steps;
    const stepText = steps.map(step => plainText(step).trim());
    if (!stepText.length || stepText.some(step => !step)) return fail('VALIDATION', 'data.error.stepsRequired', 'steps');
    const cautions = c.cautions === undefined ? draft.cautions : raw(text(c.cautions));
    if (steps.length > MAX_DRAFT_STEPS || titleText.length + stepText.join('').length + plainText(cautions).length > MAX_DRAFT_LENGTH) return rejected('STEPS_INVALID', 'steps');
    const manualId = nextId('mn');
    return ok({
      ...t,
      manual: [...t.manual, { manualId, section: c.section ?? draft.section ?? 'handover', cautions, title, category: c.category ?? draft.category, isPublished: true, updatedAt: NOW }],
      manualStep: [...t.manualStep, ...steps.map((body, i) => ({ manualId, stepNo: i + 1, body }))],
      manualDraft: patch(t.manualDraft, (d) => d === draft, (d) => ({ ...d, status: 'saved' })),
    }, true, 'data.notice.manualSaved', undefined, { manualId });
  },
  'manuals.discardDraft': ({ tables: t }, c) => {
    const draft = t.manualDraft.find(row => row.draftId === c.draftId);
    if (!draft) return notFound('draftId');
    if (draft.status !== 'draft') return done();
    return ok({ ...t, manualDraft: t.manualDraft.filter(row => row !== draft) }, true, 'data.management.notice.deleted');
  },
  // End N14 manuals.
  'interior.select': ({ tables: t }, c) => {
    if (!MOODS.includes(c.mood)) return fail('VALIDATION', 'data.error.moodInvalid', 'mood');
    if (!Array.isArray(c.materials) || c.materials.length === 0 || !c.materials.every((m) => MATERIALS.includes(m)) || new Set(c.materials).size !== c.materials.length) return fail('VALIDATION', 'data.error.materialsInvalid', 'materials');
    return ok({ ...t, interiorPlan: { ...t.interiorPlan, mood: c.mood, materials: [...c.materials] as Material[] } }, true, 'data.notice.interiorChanged');
  },
  'interior.saveMemo': ({ tables: t }, c) => {
    if (typeof c.memo !== 'string') return fail('VALIDATION', 'data.error.memoRequired', 'memo');
    const memo = text(c.memo);
    return ok({ ...t, interiorPlan: { ...t.interiorPlan, memo: memo ? raw(memo) : null } }, true, 'data.notice.memoSaved');
  },
  'floorPlan.saveDraftLayout': ({ tables: t, nextId }, c) => {
    if (!Array.isArray(c.tables) || c.tables.length === 0 || !c.tables.every((x) => ZONES.includes(x.zone) && isInt(x.seats) && x.seats >= 1 && x.seats <= 12)) return fail('VALIDATION', 'data.error.layoutInvalid', 'tables');
    if (!isNum(c.aisleCm) || c.aisleCm < 0) return fail('VALIDATION', 'data.error.numberInvalid', 'aisleCm');
    const layoutId = nextId('lay');
    const name = text(c.name);
    return ok({
      ...t,
      floorLayout: [...t.floorLayout, { layoutId, name: name ? raw(name) : { key: 'data.layout.draft' }, isCurrent: false, aisleCm: c.aisleCm }],
      tableSpot: [...t.tableSpot, ...c.tables.map((x, i) => ({ tableId: `${layoutId}-t${i + 1}`, layoutId, zone: x.zone, seats: x.seats }))],
    }, true, 'data.notice.layoutSaved', undefined, { layoutId });
  },
  'floorPlan.applyLayout': ({ tables: t }, c) => {
    const layout = t.floorLayout.find((l) => l.layoutId === c.layoutId);
    if (!layout) return notFound('layoutId');
    if (layout.isCurrent) return done();
    const seats = t.tableSpot.filter((s) => s.layoutId === c.layoutId).reduce((sum, s) => sum + s.seats, 0);
    return ok({ ...t, floorLayout: t.floorLayout.map((l) => ({ ...l, isCurrent: l.layoutId === c.layoutId })) }, true, 'data.notice.layoutApplied', { seats });
  },
  'floorPlan.generateFromPhotos': ({ tables: t }) => ok({ ...t, floorSpace: { ...t.floorSpace, planGenerated: true } }, true, 'data.notice.planGenerated'),
  'inquiry.create': realOnly,
  'inquiry.import': realOnly,
  'inquiry.editReply': realOnly,
  'inquiry.deleteReply': realOnly,
  'notice.deleteNews': realOnly,
  'localChanges.create': realOnly,
  'community.create': realOnly,
  'briefing.acknowledge': realOnly,
  'localChanges.acknowledge': ({ tables: t }, c) => {
    const change = t.localChange.find((x) => x.changeId === c.changeId);
    if (!change) return notFound('changeId');
    if (change.ackedAt !== null) return done();
    return ok({ ...t, localChange: patch(t.localChange, (x) => x === change, (x) => ({ ...x, ackedAt: NOW })) }, true, 'data.notice.changeAcked');
  },
  // N20 reopens one already-folded record and creates its own receipt.
  'localChanges.unacknowledge': ({ tables: t }, c) => {
    const change = t.localChange.find((x) => x.changeId === c.changeId);
    if (!change) return notFound('changeId');
    if (change.ackedAt === null) return done();
    return ok({ ...t, localChange: patch(t.localChange, (x) => x === change, (x) => ({ ...x, ackedAt: null })) }, true, 'data.notice.changeReopened');
  },
  // End N20 reopen handler.
  // N17 handler entry points. These update only the local store.
  'reply.draft': saveInquiryDraft,
  'inquiry.saveDraft': saveInquiryDraft,
  'inquiry.send': replyTo,
  'inquiry.post': replyTo,
  'community.accept': respond,
  'community.decline': respond,
  'community.sendInterest': respond,
  // End N17 handlers.
  // plan-2 (DATA_MODEL 10.15.4, T-058)
  ...marketingHandlers,
  ...managementHandlers,
};

// N17 persistence helpers for the same data commands used by the detail widget.
function saveInquiryDraft({ tables }: HandlerContext, command: InquiryDraftCommand): HandlerResult {
  const plan = planInquiryDraft(tables, command);
  if (!plan.ok) return plan;
  const { thread, draft } = plan;
  const inquiryThread = patch(tables.inquiryThread, row => row === thread, row => ({
    ...row, replyDraft: draft,
  }));
  return ok({ ...tables, inquiryThread }, true, 'data.notice.replyDraftSaved');
}

function replyTo({ tables }: HandlerContext, command: InquiryReplyCommand): HandlerResult {
  const checked = checkInquiryReply(tables, command);
  if (!checked.ok) return checked;
  const inquiryThread = patch(tables.inquiryThread, row => row === checked.thread, row => ({
    ...row, status: 'done' as const, ...(command.body !== undefined ? { sentReplyBody: command.body } : {}),
  }));
  return ok({ ...tables, inquiryThread }, false, command.type === 'inquiry.post' ? 'data.notice.posted' : 'data.notice.sent');
}

function respond({ snapshot, tables }: HandlerContext, command: CommunityResponseCommand): HandlerResult {
  const checked = checkCommunityResponse(snapshot, command);
  if (!checked.ok) return checked;
  const { offer } = checked;
  if (command.type === 'community.sendInterest') {
    return ok({ ...tables, offerInterest: [...tables.offerInterest, { offerId: offer.offerId, sentAt: NOW }] }, true, 'data.notice.interestSent');
  }
  const accepted = command.type === 'community.accept';
  const status: typeof offer.status = accepted ? 'accepted' : 'declined';
  const partnershipOffer = patch(tables.partnershipOffer, row => row === offer, row => ({
    ...row, status, sharedContactKey: accepted ? 'data.offer.contact.phone' : null,
  }));
  return ok({ ...tables, partnershipOffer }, true, accepted ? 'data.notice.offerAccepted' : 'data.notice.offerDeclined');
}
// End N17 persistence.
