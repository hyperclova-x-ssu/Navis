/**
 * Test support for the money widgets: every expected number comes from the same selectors the widgets read
 * (`selectWidget`, `selectPayments`, `selectClosing`), so a seed change moves the tests with the data and a
 * widget that computes its own number fails against the selector.
 */
import { createWidgetDataStore, selectClosing, selectPayments, selectWidget, TODAY, type BriefingModel, type LedgerModel, type MarginModel } from '../../../data/widget-data';
import type { QueryCondition } from '../../../contracts';
import type { WidgetDataStore } from '../../../data/db/store';

const DEFAULT: QueryCondition = { kind: 'default' };
const model = <T,>(view: { readonly status: string; readonly model?: T }, id: string): T => {
  if (view.status !== 'ready' || !view.model) throw new Error(`${id} is not ready`);
  return view.model;
};
export const ledgerOf = (store: WidgetDataStore = createWidgetDataStore(), condition: QueryCondition = DEFAULT): LedgerModel => model(selectWidget(store.getSnapshot(), 'ledger', condition, 'normal') as never, 'ledger');
export const marginOf = (store: WidgetDataStore = createWidgetDataStore(), condition: QueryCondition = DEFAULT): MarginModel => model(selectWidget(store.getSnapshot(), 'margin', condition, 'normal') as never, 'margin');
export const briefingOf = (store: WidgetDataStore = createWidgetDataStore(), condition: QueryCondition = DEFAULT): BriefingModel => model(selectWidget(store.getSnapshot(), 'briefing', condition, 'normal') as never, 'briefing');
export const paymentsOf = (store: WidgetDataStore = createWidgetDataStore(), sort: 'asc' | 'desc' = 'desc') => selectPayments(store.getSnapshot(), { date: TODAY, scenario: 'normal', sort: { field: 'time', direction: sort } }).rows;
export const closingOf = (store: WidgetDataStore = createWidgetDataStore(), date: string = TODAY) => selectClosing(store.getSnapshot(), { date, scenario: 'normal' });

const grouped = (n: number, digits = 0) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** `1,284,000원` (a negative amount uses the minus sign, DS 6.1). */
export const won = (n: number) => `${n < 0 ? '−' : ''}${grouped(n)}원`;
/** The number part of `128.4만 원`, rounded the way the compact money format rounds. */
export const man = (n: number) => `${n < 0 ? '−' : ''}${grouped(Math.round(Math.abs(n) / 1000) / 10, 1)}`;
/** `128.4만 원` */
export const manWon = (n: number) => `${man(n)}만 원`;
export const percent = (n: number, digits = 1) => `${n.toFixed(digits)}%`;

/** The menu name as a customer sees it. */
export const menuLabel = (store: WidgetDataStore, menuId: string): string => {
  const menu = store.getSnapshot().tables.menuItem.find(item => item.menuId === menuId);
  const name = menu?.name;
  return name && 'raw' in name ? name.raw : '';
};

/** Orders the first purchasable item for today and returns the line to receive: what `suppliers.recordReceipt` needs (the cafe day has no open order of its own). */
export const openReceipt = (store: WidgetDataStore) => {
  const item = store.getSnapshot().tables.purchaseItem[0]!;
  const qty = item.minimumQty;
  const result = store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: item.purchaseItemId, qty, dueDate: TODAY, idempotencyKey: `order-${item.purchaseItemId}` });
  if (!result.ok) throw new Error(`order refused: ${result.messageKey}`);
  return { polId: (result.value as { polId: string }).polId, qty };
};

/** A store whose grant list also has one program closing in four days, the case the briefing alerts list (the cafe's own deadline is further off). */
export const storeWithUrgentGrant = () => {
  const base = createWidgetDataStore().getSnapshot().tables.grantNotice;
  const notice = { ...base[0]!, noticeId: 'urgent-grant', applyStart: `${TODAY}T00:00`, applyEnd: `${addDays(TODAY, 4)}T18:00` };
  return { store: createWidgetDataStore({ grantNotice: [...base, notice] }), noticeId: notice.noticeId };
};
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The opening checklist the briefing counts: its manual and the steps not yet checked today. */
export const openingChecklist = (store: WidgetDataStore) => {
  const tables = store.getSnapshot().tables;
  const manual = tables.manual.find(row => row.isPublished && row.category === 'opening' && row.section !== 'store-info')!;
  const steps = tables.manualStep.filter(step => step.manualId === manual.manualId).map(step => step.stepNo);
  const open = steps.filter(stepNo => !tables.checklistLog.some(log => log.date === TODAY && log.manualId === manual.manualId && log.stepNo === stepNo));
  return { manualId: manual.manualId, open };
};

/** The cafe store plus one unsent temporary closure a week ahead (the notices test fixture): the briefing lists it as a task. */
export const storeWithClosure = () => {
  const tables = createWidgetDataStore().getSnapshot().tables;
  const day = addDays(TODAY, 7), title = `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} 임시 휴무`;
  const event = { eventId: 'closure-test', revision: 1, kind: 'event' as const, categoryId: 'store-operations' as const, date: day, time: null, title: { raw: title }, memo: { raw: '매장 내부 정비로 하루 쉬어요' }, storeClosure: { kind: 'temporary' as const, endDate: day } };
  const draft = { noticeId: 'notice-closure-1', kind: 'temporary_closure' as const, title, body: '매장 내부 정비로 하루 쉬어요', startDate: day, endDate: day, closureEventId: event.eventId, closureRevision: 1, audience: 'all_contactable' as const, groupIds: [], contentClass: 'informational' as const, revision: 1 };
  return { store: createWidgetDataStore({ calendarEvent: [...tables.calendarEvent, event], noticeDraft: [...tables.noticeDraft, draft] } as never), day };
};

/** All four alert groups at once: the closure task, an order due today and an item that ran out (the cafe day on its own has two groups). */
export const storeWithAllAlerts = () => {
  const { store, day } = storeWithClosure();
  const item = store.getSnapshot().tables.purchaseItem[0]!;
  store.dispatch({ type: 'inventory.updateItem', itemId: item.itemId, stock: 0 });
  const order = store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: item.purchaseItemId, qty: item.minimumQty, dueDate: TODAY, idempotencyKey: 'alerts-order' });
  if (!order.ok) throw new Error(`order refused: ${order.messageKey}`);
  return { store, day };
};
