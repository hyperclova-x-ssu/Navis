import { setup as setupMoney } from '../pos/loyalty/test-setup';
import { getPaymentBillId, quotePaymentBill } from '../pos/loyalty';
/** DATA_MODEL 10.14 data items: cross-widget flows through commands (AC-232·236~239·242·254·256·260·262·266·270·281·283). */
import { describe, expect, it, vi } from 'vitest';
import * as posSeed from '../pos/seed';
import { createSeedTables } from './db/seed';
import { LAST_MONTH_END, LAST_MONTH_START, NOW, TODAY, TOMORROW } from './db/time';
import { initializeCustomPos } from './pos/projection';
import type { Reservation } from './db/types';
import type { QueryCondition } from '../contracts';
import { createWidgetDataStore, selectWidget, type DataCommandResult, type ModelMap, readInternalModel, isDataWidgetId, type ModelOf, type WidgetDataStore } from './widget-data';

function modelOf<F extends keyof ModelMap>(store: WidgetDataStore, id: F, variant = 'normal', condition: QueryCondition = { kind: 'default' }): ModelOf<F> {
  if (!isDataWidgetId(id)) return readInternalModel(store.getSnapshot(), id, condition) as ModelOf<F>;
  const view = selectWidget(store.getSnapshot(), id, condition, variant);
  if (view.status !== 'ready') throw new Error(`${id}/${variant} not ready`);
  return view.model as ModelOf<F>;
}
const okResult = (r: DataCommandResult) => {
  if (!r.ok) throw new Error(`command failed: ${r.code} ${r.messageKey}`);
  return r;
};

const seed = createSeedTables();
const milk = seed.purchaseItem.find(row => row.itemId === 'i-milk')!;
const openingManual = seed.manual.find(row => row.category === 'opening')!;
const todayDelivery = seed.purchaseOrder.find(row => row.dueDate === TODAY && row.status === 'complete')!;
const [firstMessage, secondMessage] = seed.inquiryThread.filter(row => row.type === 'message' && row.status === 'waiting');
const waitingReview = seed.inquiryThread.find(row => row.type === 'review' && row.isPublic && row.status === 'waiting')!;

function milkDelivery() {
  const poId = 'po-test-milk';
  return createWidgetDataStore({
    inventoryItem: seed.inventoryItem.map(row => row.itemId === milk.itemId ? { ...row, restockThreshold: 24_000 } : row),
    purchaseOrder: [...seed.purchaseOrder, { poId, supplierId: milk.supplierId, dueDate: TODAY, expectedTime: '10:00', status: 'scheduled', variant: null }],
    purchaseOrderLine: [...seed.purchaseOrderLine, { poId, polId: 'pol-test-milk', itemId: milk.itemId, qtyOrdered: 12,
      unitPrice: milk.unitPrice, unitSnapshot: milk.purchaseUnit, basePerUnit: milk.basePerUnit }],
  });
}

function membershipScenario(kind: 'count' | 'period') {
  const pos = initializeCustomPos(posSeed.createPosSeed());
  const money = pos.money!;
  const count = money.memberships.find(row => row.membershipId === 'sample-pass-1')!;
  const memberships = kind === 'count' ? money.memberships.map(row => row === count ? { ...row, openingUses: 9 } : row) : [
    ...money.memberships, { ...count, membershipId: 'monthly-test', kind: 'period' as const, totalUses: null, dailyLimit: 1, validDays: 30, openingUses: 0 },
  ];
  const spy = vi.spyOn(posSeed, 'createPosSeed').mockReturnValueOnce({ ...pos, money: { ...money, memberships } });
  try { return setupMoney(); } finally { spy.mockRestore(); }
}

describe('delivery flow (AC-236~239, F-25)', () => {
  it('8 L of 12 L covers the milk shortage, keeps the delivery open and creates only a ledger candidate', () => {
    const store = milkDelivery();
    const first = okResult(store.dispatch({ type: 'suppliers.recordReceipt', polId: 'pol-test-milk', qty: 8, idempotencyKey: 'rcv-1' }));
    expect(first.undoToken).toBeTruthy();
    expect(first.noticeKey).toBe('data.notice.receiptRecorded');
    const inv = modelOf(store, 'inventory-booking');
    expect(inv.ingredients.find((i) => i.itemId === 'i-milk')?.stock).toBe(28_400);
    expect(inv.restockCount).toBe(0);
    expect(inv.outOfStockCount).toBe(0);
    const sup = modelOf(store, 'suppliers');
    expect(sup.upcomingCount).toBe(1);
    expect(sup.upcoming[0].lines[0]).toMatchObject({ ordered: 12, received: 8, remaining: 4 });
    expect(sup.upcoming[0].status).toBe('partial');
    expect(modelOf(store, 'briefing').arrival.find((i) => i.featureId === 'inventory-booking')?.value).toBeUndefined();
    expect(modelOf(store, 'calendar').todayEntries.some((e) => e.sourceId === 'po-test-milk')).toBe(true);
    // ledger: candidate 8 × 2,900 shown, totals unchanged until confirmed (AC-239)
    const ledger = modelOf(store, 'ledger');
    expect(ledger.expenses.total).toBe(110_000);
    expect(ledger.candidates).toHaveLength(1);
    expect(ledger.candidates[0]).toMatchObject({ amount: 23_200, status: 'candidate', supplierId: milk.supplierId });
    okResult(store.dispatch({ type: 'ledger.confirmCandidate', expenseId: ledger.candidates[0].expenseId }));
    const after = modelOf(store, 'ledger');
    expect(after.expenses.total).toBe(133_200);
    expect(after.remaining).toBe(698_020);
    expect(after.candidates).toHaveLength(0);
  });
  it('the same idempotency key twice applies once (AC-238)', () => {
    const store = milkDelivery();
    const first = okResult(store.dispatch({ type: 'suppliers.recordReceipt', polId: 'pol-test-milk', qty: 8, idempotencyKey: 'same' }));
    const revision = store.getSnapshot().revision;
    const second = okResult(store.dispatch({ type: 'suppliers.recordReceipt', polId: 'pol-test-milk', qty: 8, idempotencyKey: 'same' }));
    expect(second.duplicate).toBe(true);
    expect(second.revision).toBe(first.revision);
    expect(store.getSnapshot().revision).toBe(revision);
    expect(modelOf(store, 'inventory-booking').ingredients.find((i) => i.itemId === 'i-milk')?.stock).toBe(28_400);
    expect(modelOf(store, 'suppliers').upcoming[0].lines[0].remaining).toBe(4);
    expect(modelOf(store, 'ledger').candidates).toHaveLength(1);
  });
  it('receiving the remaining 4 L completes the order and removes the calendar entry and briefing purchase alert', () => {
    const store = milkDelivery();
    okResult(store.dispatch({ type: 'suppliers.recordReceipt', polId: 'pol-test-milk', qty: 8, idempotencyKey: 'a' }));
    expect(modelOf(store, 'calendar').todayEntries.some(e => e.sourceId === 'po-test-milk')).toBe(true);
    okResult(store.dispatch({ type: 'suppliers.recordReceipt', polId: 'pol-test-milk', qty: 4, idempotencyKey: 'b' }));
    expect(modelOf(store, 'inventory-booking').ingredients.find((i) => i.itemId === 'i-milk')?.stock).toBe(32_400);
    const sup = modelOf(store, 'suppliers');
    expect(sup.upcomingCount).toBe(0);
    expect(sup.past.some((o) => o.poId === 'po-test-milk' && o.status === 'complete')).toBe(true);
    const cal = modelOf(store, 'calendar');
    expect(cal.monthEntries.some(e => e.sourceId === 'po-test-milk')).toBe(false);
    expect(cal.todayCount).toBe(3);
    expect(cal.weekCount).toBe(8);
    expect(modelOf(store, 'briefing').arrival.find(i => i.featureId === 'calendar')?.value).toBe(3);
    expect(modelOf(store, 'briefing').importantAlerts.groups.flatMap(group => group.items).some(item => item.id === 'order:po-test-milk')).toBe(false);
  });
  it('rejects receipts above the remaining quantity or below 1 without changing state', () => {
    const store = milkDelivery();
    const before = store.getSnapshot();
    expect(store.dispatch({ type: 'suppliers.recordReceipt', polId: 'pol-test-milk', qty: 13, idempotencyKey: 'x' })).toEqual({ ok: false, code: 'VALIDATION', field: 'qty', messageKey: 'data.error.qtyOverRemaining' });
    expect(store.dispatch({ type: 'suppliers.recordReceipt', polId: 'pol-test-milk', qty: 0, idempotencyKey: 'y' })).toMatchObject({ ok: false, code: 'VALIDATION', field: 'qty' });
    expect(store.dispatch({ type: 'suppliers.recordReceipt', polId: 'nope', qty: 1, idempotencyKey: 'z' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(store.dispatch({ type: 'suppliers.recordReceipt', polId: 'pol-test-milk', qty: 1, idempotencyKey: '' })).toMatchObject({ ok: false, code: 'VALIDATION', field: 'idempotencyKey' });
    expect(store.getSnapshot()).toBe(before);
  });
  it('changing the due date moves the calendar delivery (AC-232·273)', () => {
    const store = milkDelivery();
    okResult(store.dispatch({ type: 'suppliers.changeDueDate', poId: 'po-test-milk', date: TOMORROW }));
    const cal = modelOf(store, 'calendar');
    expect(cal.todayEntries.some((e) => e.sourceId === 'po-test-milk')).toBe(false);
    expect(cal.weekEntries.find((e) => e.sourceId === 'po-test-milk')?.date).toBe(TOMORROW);
    expect(cal.todayCount).toBe(3);
  });
});

describe('money commands (AC-242·246·248)', () => {
  it('recording 30,000 supplies → expenses 140,000, supplies 30,000, remaining 691,220, undoable', () => {
    const store = createWidgetDataStore();
    const r = okResult(store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount: 30_000 }));
    const l = modelOf(store, 'ledger');
    expect(l.expenses.total).toBe(140_000);
    expect(l.expenses.byCategory.find((c) => c.category === 'supplies')?.amount).toBe(30_000);
    expect(l.remaining).toBe(691_220);
    expect(l.expenses.items.find((e) => e.expenseId === (r.value as { expenseId: string }).expenseId)?.evidence).toBe('receipt');
    okResult(store.undo(r.undoToken as string));
    expect(modelOf(store, 'ledger').expenses.total).toBe(110_000);
  });
  it('validates amount, date and category', () => {
    const store = createWidgetDataStore();
    expect(store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount: 0 })).toMatchObject({ ok: false, code: 'VALIDATION', field: 'amount' });
    expect(store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount: 12.5 })).toMatchObject({ ok: false, field: 'amount' });
    expect(store.dispatch({ type: 'ledger.recordExpense', date: '2026-13-01', category: 'supplies', amount: 100 })).toMatchObject({ ok: false, field: 'date' });
    expect(store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'snacks' as never, amount: 100 })).toMatchObject({ ok: false, field: 'category' });
  });
  it('an expense recorded without evidence becomes a tax item; checking items 1 → 0 shows the estimate', () => {
    const expense = seed.expense.find(row => row.businessDate === TODAY)!;
    const store = createWidgetDataStore({ taxReview: seed.taxReview.map(row => row.refId === expense.expenseId ? row : { ...row, status: 'checked' }) });
    okResult(store.dispatch({ type: 'tax.markChecked', refId: expense.expenseId }));
    let tax = modelOf(store, 'tax');
    expect(tax.reviewCount).toBe(0);
    expect(tax.estimate).toMatchObject({ basisDate: TODAY, assumptionKey: 'data.tax.assumption' });
    expect(store.dispatch({ type: 'tax.markChecked', refId: expense.expenseId })).toMatchObject({ ok: false, code: 'CONFLICT' });
    okResult(store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'other', amount: 9_000, evidence: 'none' }));
    tax = modelOf(store, 'tax');
    expect(tax.reviewCount).toBe(1);
    expect(tax.estimate).toBeNull();
  });
  it('tax export previews without changing state and keeps the pending undo', () => {
    const store = createWidgetDataStore();
    const recorded = okResult(store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount: 1_000 }));
    const before = store.getSnapshot();
    const r = okResult(store.dispatch({ type: 'tax.export', period: { start: LAST_MONTH_START, end: LAST_MONTH_END } }));
    expect(r.noticeKey).toBe('data.notice.exported');
    expect(r.undoToken).toBeUndefined();
    expect(r.value).toMatchObject({ missingEvidence: 73 });
    expect(store.getSnapshot()).toBe(before);
    expect(store.dispatch({ type: 'tax.export', period: { start: '2026-08-01', end: '2026-08-31' } })).toMatchObject({ ok: false, field: 'period' });
    expect(store.undo(recorded.undoToken as string).ok).toBe(true);
  });
  it('marking a support notice reviewed: 2 → 1 candidates', () => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'grants.markReviewed', noticeId: 'sample-grant-1' }));
    expect(modelOf(store, 'grants').candidateCount).toBe(1);
  });
});

describe('customer commands (AC-250·254·256)', () => {
  it('using the last count-pass use reduces the active count and same-day cancellation restores it', () => {
    const h = membershipScenario('count'), store = h.data;
    expect(store.dispatch({type:'memberships.useOnce',membershipId:'sample-pass-3',idempotencyKey:'no-context'})).toMatchObject({ok:false,reason:'POS_CONTEXT_REQUIRED'});
    okResult(coveredUse(h,'sample-pass-3','u1'));
    expect(modelOf(store, 'memberships').memberships.find((m) => m.membershipId === 'sample-pass-3')?.usesLeft).toBe(3);
    const last = okResult(coveredUse(h,'sample-pass-1','u2'));
    const m = modelOf(store, 'memberships');
    expect(m.activeCount).toBe(2);
    expect(m.uses[0]).toMatchObject({ membershipId: 'sample-pass-1', cancelable: true });
    expect(coveredUse(h,'sample-pass-1','u3')).toMatchObject({ ok: false });
    okResult(store.dispatch({ type: 'memberships.cancelUse', useId: (last.value as { useId: string }).useId }));
    const back = modelOf(store, 'memberships');
    expect(back.activeCount).toBe(3);
    expect(back.memberships.find((x) => x.membershipId === 'sample-pass-1')?.usesLeft).toBe(1);
    const earlierUse = store.getSnapshot().tables.membershipUse.find(row => row.canceledAt === null && row.usedAt < TODAY)!;
    expect(store.dispatch({ type: 'memberships.cancelUse', useId: earlierUse.useId })).toMatchObject({ ok: false, code: 'VALIDATION', messageKey: 'data.error.cancelSameDayOnly' });
  });
  it('a monthly pass can be used once per day', () => {
    const h = membershipScenario('period');
    okResult(coveredUse(h,'monthly-test','p1'));
    expect(coveredUse(h,'monthly-test','p2')).toMatchObject({ ok: false, reason:'PASS_DAILY_LIMIT' });
  });
  it('special state: confirm the over-capacity group or propose a new time (AC-256)', () => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'booking.confirm', reservationId: 'sample-booking-over-capacity' }));
    let v = modelOf(store, 'voice-booking', 'needs-confirmation');
    expect([v.todayCount, v.needsCheckCount]).toEqual([5, 1]);
    expect(modelOf(store, 'voice-booking').todayCount).toBe(4);
    const other = createWidgetDataStore();
    okResult(other.dispatch({ type: 'booking.propose', reservationId: 'sample-booking-over-capacity', time: '18:00' }));
    v = modelOf(other, 'voice-booking', 'needs-confirmation');
    expect([v.todayCount, v.needsCheckCount]).toEqual([4, 1]);
    expect(v.reservations.find((r) => r.reservationId === 'sample-booking-over-capacity')).toMatchObject({ status: 'proposed', proposedTime: '18:00', counts: false });
    expect(other.dispatch({ type: 'booking.confirm', reservationId: 'sample-booking-1' })).toMatchObject({ ok: false, code: 'CONFLICT' });
  });
  it('no-show only for confirmed reservations before the business cutoff', () => {
    const completed = seed.reservation.find((row): row is Reservation => row.kind === 'visit' && row.status === 'completed')!;
    const store = createWidgetDataStore({ reservation: seed.reservation.map(row => row === completed ? { ...completed, status: 'confirmed' } : row) });
    okResult(store.dispatch({ type: 'booking.markNoShow', reservationId: completed.reservationId }));
    expect(store.dispatch({ type: 'booking.markNoShow', reservationId: 'sample-booking-1' })).toMatchObject({ ok: false, messageKey: 'data.error.notYetTime' });
    expect(modelOf(store, 'voice-booking').reservations.find((r) => r.reservationId === completed.reservationId)?.status).toBe('no-show');
  });
  it('peak hour marked for review', () => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'cctv.markPeakForReview', date: TODAY, hour: 9 }));
    expect(modelOf(store, 'customer-analysis').peak?.reviewMarked).toBe(true);
  });
});

describe('operations commands (AC-226·258·260·262·264·266·268·270)', () => {
  it('saving a layout draft preserves current seats and applying it changes only floor-plan seats', () => {
    const store = createWidgetDataStore();
    const draft = okResult(store.dispatch({ type: 'floorPlan.saveDraftLayout', name: '창가 넓게', tables: [{ zone: 'window', seats: 2 }, { zone: 'center', seats: 4 }], aisleCm: 80 }));
    expect(modelOf(store, 'floor-plan').seatCount).toBe(30);
    expect(modelOf(store, 'voice-booking').seats).toBe(30);
    const r = okResult(store.dispatch({ type: 'floorPlan.applyLayout', layoutId: (draft.value as { layoutId: string }).layoutId }));
    expect(r.params).toEqual({ seats: 6 });
    expect(modelOf(store, 'floor-plan').seatCount).toBe(6);
    expect(modelOf(store, 'voice-booking').seats).toBe(30);
    expect(modelOf(store, 'voice-booking').slots[0].seatsFree).toBe(29);
  });
  it('moving 20 from store to online → 160 / 88, total 248 (undoable)', () => {
    const retail = (itemId: string) => ({ itemId, nameKey: 'data.item.beans200', kind: 'retail' as const, unit: 'pcs' as const,
      restockThreshold: null, trackRestock: false, lowStockPerChannel: 30, sales7d: null, updatedAt: NOW, trackExpiry: false, expiresOn: null });
    const store = createWidgetDataStore({
      inventoryItem: [...seed.inventoryItem, retail('test-beans-pack'), retail('test-drip-pack')],
      inventoryStock: [...seed.inventoryStock,
        { itemId: 'test-beans-pack', channel: 'store', qty: 120 }, { itemId: 'test-beans-pack', channel: 'online', qty: 40 },
        { itemId: 'test-drip-pack', channel: 'store', qty: 60 }, { itemId: 'test-drip-pack', channel: 'online', qty: 28 }],
    });
    const r = okResult(store.dispatch({ type: 'inventory.moveChannel', itemId: 'test-beans-pack', from: 'store', to: 'online', qty: 20 }));
    const p = modelOf(store, 'inventory-booking').products;
    expect(p.byChannel).toEqual({ store: 160, online: 88 });
    expect(p.total).toBe(248);
    expect(r.undoToken).toBeTruthy();
    expect(store.dispatch({ type: 'inventory.moveChannel', itemId: 'test-beans-pack', from: 'online', to: 'store', qty: 61 })).toEqual({ ok: false, code: 'VALIDATION', field: 'qty', messageKey: 'data.error.moveOverStock.online' });
    expect(store.dispatch({ type: 'inventory.moveChannel', itemId: 'i-milk', from: 'store', to: 'online', qty: 1 })).toMatchObject({ ok: false, field: 'itemId' });
  });
  it('editing stock and threshold updates the restock count immediately', () => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-milk', threshold: 25_000 }));
    expect(modelOf(store, 'inventory-booking').restockCount).toBe(1);
    expect(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-milk', stock: -1 })).toMatchObject({ ok: false, field: 'stock' });
  });
  it('calendar: adding an event and to-do updates ordering and the reservation source adds rows', () => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'calendar.addEvent', title: '거래처 전화', date: TODAY, time: '16:00' }));
    let c = modelOf(store, 'calendar');
    expect(c.todayCount).toBe(4);
    expect(c.todayEntries.map((e) => e.time)).toEqual(['12:00', '16:00', '16:30', '17:00']);
    expect(c.todayEntries[1].title).toEqual({ raw: '거래처 전화' });
    okResult(store.dispatch({ type: 'calendar.addTodo', title: '포스터 인쇄' }));
    c = modelOf(store, 'calendar');
    expect(c.todayCount).toBe(5);
    expect(c.todayEntries[4]).toMatchObject({ kind: 'todo', time: null });
    const visible = store.dispatch({ type: 'calendar.setSourceVisible', source: 'reservation', visible: true });
    expect(visible).toMatchObject({ ok: true });
    expect((visible as { undoToken?: string }).undoToken).toBeUndefined();
    expect(modelOf(store, 'calendar').todayCount).toBe(9);
    expect(store.dispatch({ type: 'calendar.addEvent', title: '  ', date: TODAY })).toMatchObject({ ok: false, field: 'title', messageKey: 'data.error.titleRequired' });
  });
  it('calendar: only direct entries are editable/deletable', () => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'calendar.updateEvent', eventId: 'sample-calendar-1', time: '17:30' }));
    expect(modelOf(store, 'calendar').todayEntries.find((e) => e.sourceId === 'sample-calendar-1')?.time).toBe('17:30');
    expect(store.dispatch({ type: 'calendar.deleteEvent', eventId: todayDelivery.poId })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    okResult(store.dispatch({ type: 'calendar.deleteEvent', eventId: 'sample-calendar-1' }));
    expect(modelOf(store, 'calendar').todayCount).toBe(2);
  });
  it('job post: wage 10,319 rejected on hourly_wage, 10,320 accepted, copy marks copied', () => {
    const store = createWidgetDataStore();
    const s = modelOf(store, 'hiring').suggestion;
    expect(store.dispatch({ type: 'hiring.saveDraft', ...s, hourlyWage: 10_319 })).toEqual({ ok: false, code: 'VALIDATION', field: 'hourly_wage', messageKey: 'data.error.wageBelowMinimum' });
    expect(store.dispatch({ type: 'hiring.markCopied' })).toMatchObject({ ok: false, code: 'CONFLICT' });
    const saved = okResult(store.dispatch({ type: 'hiring.saveDraft', ...s, hourlyWage: 10_320 }));
    expect(saved.undoToken).toBeUndefined();
    expect(modelOf(store, 'hiring').draftStatus).toBe('draft');
    okResult(store.dispatch({ type: 'hiring.markCopied' }));
    expect(modelOf(store, 'hiring').draft).toMatchObject({ status: 'copied', hourlyWage: 10_320 });
  });
  it('manuals: checklist toggles today’s progress; draft from memo stays out until saved (5 → 6)', () => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'manuals.toggleStep', manualId: openingManual.manualId, stepNo: 4 }));
    expect(modelOf(store, 'manuals').todayChecklist.find((c) => c.manualId === openingManual.manualId)?.done).toBe(1);
    okResult(store.dispatch({ type: 'manuals.toggleStep', manualId: openingManual.manualId, stepNo: 4 }));
    expect(modelOf(store, 'manuals').todayChecklist.find((c) => c.manualId === openingManual.manualId)?.done).toBe(0);
    const draft = okResult(store.dispatch({ type: 'manuals.createDraftFromMemo', memo: '우유는 받자마자 냉장고에' }));
    expect(modelOf(store, 'manuals').publishedCount).toBe(5);
    expect(modelOf(store, 'manuals').drafts).toHaveLength(1);
    okResult(store.dispatch({ type: 'manuals.saveDraft', draftId: (draft.value as { draftId: string }).draftId }));
    const m = modelOf(store, 'manuals');
    expect(m.publishedCount).toBe(6);
    expect(m.drafts).toHaveLength(0);
    expect(m.manuals.find(row => row.manualId.startsWith('mn-'))?.steps.map(step => step.body)).toEqual([{ raw: '우유는 받자마자 냉장고에' }]);
    expect(store.dispatch({ type: 'manuals.createDraftFromMemo', memo: ' ' })).toMatchObject({ ok: false, field: 'memo' });
  });
  it('interior: choose mood/materials and save memo', () => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'interior.select', mood: 'bright-white', materials: ['tile', 'plant'] }));
    okResult(store.dispatch({ type: 'interior.saveMemo', memo: '입구 쪽을 밝게' }));
    const i = modelOf(store, 'interior');
    expect(i.previewAssetKey).toBe('interior-bright-white');
    expect(i.materials.map((m) => m.id)).toEqual(['tile', 'plant']);
    expect(i.memo).toEqual({ raw: '입구 쪽을 밝게' });
    expect(store.dispatch({ type: 'interior.select', mood: 'neon' as never, materials: ['wood'] })).toMatchObject({ ok: false, field: 'mood' });
  });
});

describe('marketing commands (AC-275·281·283)', () => {
  it('acknowledging a change folds it but keeps the weekly count', () => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'localChanges.acknowledge', changeId: 'sample-local-1' }));
    const l = modelOf(store, 'local-changes');
    expect(l.count).toBe(3);
    expect(l.foldedCount).toBe(1);
    expect(l.openChanges).toHaveLength(2);
    expect(modelOf(store, 'briefing').arrival.some((i) => i.featureId === 'local-changes')).toBe(false);
    expect(modelOf(store, 'briefing').importantAlerts.count).toBe(2);
  });
  it('sending a message lowers the waiting count (once per key, not undoable); a review is posted; send-failure keeps it waiting', () => {
    const store = createWidgetDataStore();
    const sent = okResult(store.dispatch({ type: 'inquiry.send', threadId: firstMessage.threadId, idempotencyKey: 's1' }));
    expect(sent.noticeKey).toBe('data.notice.sent');
    expect(sent.undoToken).toBeUndefined();
    expect(modelOf(store, 'ai-response').waitingCount).toBe(47);
    expect(store.dispatch({ type: 'inquiry.send', threadId: firstMessage.threadId, idempotencyKey: 's1' })).toMatchObject({ ok: true, duplicate: true });
    expect(store.dispatch({ type: 'inquiry.send', threadId: waitingReview.threadId, idempotencyKey: 's2' })).toMatchObject({ ok: false, field: 'threadId' });
    okResult(store.dispatch({ type: 'inquiry.post', threadId: waitingReview.threadId, idempotencyKey: 's3' }));
    expect(modelOf(store, 'ai-response').byType).toEqual({ message: 6, review: 39, call: 1 });
    const before = store.getSnapshot();
    expect(store.dispatch({ type: 'inquiry.send', threadId: secondMessage.threadId, idempotencyKey: 's4', previewVariant: 'send-failure' })).toEqual({ ok: false, code: 'PREVIEW_FAILURE', messageKey: 'data.error.sendFailed' });
    expect(store.getSnapshot()).toBe(before);
    expect(modelOf(store, 'ai-response').waitingCount).toBe(46);
  });
  it('community: viewing changes nothing; accept 2 → 1 with shared contact; interest on received and public offers, accept only on received', () => {
    const direct = seed.partnershipOffer[0];
    const store = createWidgetDataStore({ partnershipOffer: [direct,
      { ...direct, offerId: 'test-direct' }, { ...direct, offerId: 'test-public', visibility: 'public' },
    ] });
    expect(modelOf(store, 'community').pendingCount).toBe(2);
    okResult(store.dispatch({ type: 'community.accept', offerId: direct.offerId }));
    let c = modelOf(store, 'community');
    expect(c.pendingCount).toBe(1);
    expect(c.inProgress[0]).toMatchObject({ offerId: direct.offerId, status: 'accepted', sharedContactKey: 'data.offer.contact.phone' });
    // PAR-3: interest goes to a received (direct) offer as well as to a public one, as the service does; accept/decline stay for received offers.
    okResult(store.dispatch({ type: 'community.sendInterest', offerId: 'test-direct' }));
    expect(store.dispatch({ type: 'community.accept', offerId: 'test-public' })).toMatchObject({ ok: false, messageKey: 'data.error.directOnly' });
    okResult(store.dispatch({ type: 'community.sendInterest', offerId: 'test-public' }));
    c = modelOf(store, 'community');
    expect(c.publicOffers[0].interestSent).toBe(true);
    expect(modelOf(store, 'calendar').weekEntries.some((e) => e.sourceId === direct.offerId)).toBe(false);
    okResult(store.dispatch({ type: 'community.decline', offerId: 'test-direct' }));
    expect(modelOf(store, 'community').pendingCount).toBe(0);
  });
});

// API-277 / PRD 12.6: uses require a real covered menu; the shared coordinator owns money.
function coveredUse(h:ReturnType<typeof setupMoney>,membershipId:string,key:string):DataCommandResult {
  h.pos.execute({type:'cart.clear',meta:h.meta()});
  const menu = h.pos.read().data.catalog.items.find(item => item.menuId === 'm-americano')!;
  const optionIds = menu.groups.filter(group => group.required).map(group => group.options[0].optionId);
  expect(h.pos.execute({ type: 'cart.add', menuId: menu.menuId, optionIds, meta: h.meta() })).toMatchObject({ ok: true });
  const pass=h.actions.money.read().state.memberships.find(m=>m.membershipId===membershipId)!;
  const billId=getPaymentBillId(h.pos.read());
  const member=h.pos.execute({type:'bill.member',billId,memberId:pass.memberId,meta:h.meta()});if(!member.ok)return member;
  const allocationId=quotePaymentBill(h.pos.read(),billId).lines[0].lineId;
  const begin=h.data.dispatch({type:'memberships.useOnce',membershipId,billId,allocationId,quantity:1,idempotencyKey:key});if(!begin.ok)return begin;
  const pending=h.actions.money.approval()!;
  const end=h.actions.money.finishApproval({runId:pending.runId,attemptId:pending.attemptId,outcome:'approved'});if(!end.ok)return end;h.actions.money.dismissApproval();
  const use=h.actions.money.read().state.uses.find(u=>u.sourceRef.id===billId&&!u.canceledAt)!;
  return {ok:true,revision:h.data.getSnapshot().revision,value:{useId:use.useId}};
}
