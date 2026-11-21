import { afterEach, describe, expect, it } from 'vitest';
import type { BusinessType } from '../../contracts';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { createTableLayout } from '../../layout/table-layout';
import { testTime } from '../../layout/test-policy';
import { createRunStore } from '../../state';
import { createWidgetDataStore, deriveStock, deriveUsage, readModel, selectReservations } from '../../data/widget-data';
import { createSessionActions, createSessionGate } from '../../app/session-actions';
import { quoteCart, selectPosDayTotals } from '../domain';
import { selectOrderSummary } from '../status';
import { planTableCommand, quoteBill, selectTableMap, selectUnpaidBills, selectPosPreferences } from './index';
import { POS_BUSINESS_DATE, POS_NOW } from '../clock';
import { seedToday } from '../../data/db/generated/today';

const dispose: (() => void)[] = [];
afterEach(() => { dispose.splice(0).forEach(fn => fn()); });
function setup(businessType: BusinessType = 'cafe', layout = true) {
  const gate = createSessionGate();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: testTime, clock: () => 0, theme: 'light', sessionGate: gate });
  const cafeRows = createWidgetDataStore().getSnapshot().tables.reservation;
  const booking = cafeRows.find(row => row.reservationId === 'sample-booking-1')!;
  if (booking.kind === 'pickup') throw new Error('Expected a visit booking');
  const reservation = [
    ...cafeRows.map(row => row.kind !== 'pickup' && row.tableId === 'T4' ? { ...row, tableId: 'T3' } : row),
    { ...booking, reservationId: 'test-visit-now', tableId: 'T4', time: '14:30', partySize: 2 },
    { ...booking, reservationId: 'test-visit-later', tableId: 'T5', time: '17:00', partySize: 2 },
    { ...booking, reservationId: 'test-visit-large', tableId: 'T6', time: '19:00', partySize: 6 },
  ];
  const data = createWidgetDataStore({ reservation }, { runId: run.getState().runId, sessionGate: gate, pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const actions = createSessionActions(run, data, gate), pos = actions.pos;
  run.actions.setOnboardingAnswer({ businessType });
  run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
  if (run.getState().onboarding.step === 'tables') {
    if (layout) run.actions.saveOnboardingTables(createTableLayout()); else run.actions.skipOnboardingTables();
  }
  expect(actions.completeOnboarding(null).ok).toBe(true);
  run.actions.skipWidgetCoaches();
  dispose.push(() => { pos.dispose(); run.dispose(); });
  let sequence = 0;
  const meta = (key = `test-${++sequence}`) => ({ runId: run.getState().runId, idempotencyKey: key });
  const add = (menuId = 'm-americano', qty = 1) => {
    const menu = pos.read().data.catalog.items.find(item => item.menuId === menuId)!;
    const optionIds = menu.groups.filter(group => group.required).map(group =>
      group.options.find(option => option.name === 'HOT')?.optionId ?? group.options.find(option => option.extraPrice === 0)!.optionId);
    return pos.execute({ type: 'cart.add', menuId, qty, optionIds, meta: meta() });
  };
  const submit = (tableId?: string, billId?: string, key?: string) => pos.execute({ type: 'bill.submitOrder', cartId: pos.read().pos.cart.cartId, tableId, billId, meta: meta(key) });
  const finish = (outcome: 'approved' | 'failed' = 'approved') => {
    const attempt = run.getState().posUi.approval!;
    return pos.finishApproval({ runId: run.getState().runId, attemptId: attempt.attemptId, expectedQuoteFingerprint: attempt.quoteFingerprint, outcome });
  };
  const close = (scenario: 'normal' | 'empty' = 'normal') => data.dispatch({ type: 'closing.closeDay', date: POS_BUSINESS_DATE, scenario, expectedGeneration: 0, idempotencyKey: `close-${scenario}` });
  return { gate, run, data, actions, pos, meta, add, submit, finish, close };
}

describe('T-245 postpaid state and atomic table settlement', () => {
  it('accepts separate orders into one bill without sales, then recognizes everything once on full payment', () => {
    const h = setup();
    h.add(); h.add('m-cafe-latte');
    expect(h.submit('T2', undefined, 'first')).toMatchObject({ ok: true, value: { billId: 'B-154', orderIds: ['O-154'], settled: false } });
    const accepted = h.pos.read().pos;
    expect(accepted.orders.at(-1)).toMatchObject({ orderNo: 154, preparation: 'accepted', orderedAt: POS_NOW });
    expect(accepted.cart.lines).toHaveLength(0);
    expect(selectPosDayTotals(accepted)).toMatchObject({ revenue: seedToday.rollup.net, paymentCount: 153, pendingBillCount: 1 });
    expect(deriveUsage(h.data.getSnapshot(), { date: POS_BUSINESS_DATE }).byItem['i-bean-house']).toBe(2358);
    expect(deriveStock(h.data.getSnapshot(), { date: POS_BUSINESS_DATE }).rows.find(row => row.itemId === 'i-basque-cake')?.stock).toBe(18);
    expect(readModel(h.data.getSnapshot(), 'menu').rows.find(row => row.menuId === 'm-americano')).toMatchObject({ soldQty: 62 });
    expect(h.submit('T2', undefined, 'first')).toMatchObject({ ok: true, duplicate: true });
    h.add('m-basque-cake');
    expect(h.submit('T2', 'B-154')).toMatchObject({ ok: true, value: { billId: 'B-154', orderIds: ['O-155'] } });
    expect(h.pos.read().pos.bills).toHaveLength(154);
    expect(h.pos.read().pos.billAllocations.filter(a => a.billId === 'B-154').reduce((n, a) => n + a.qty, 0)).toBe(3);
    expect(h.pos.execute({ type: 'bill.requestPayment', billId: 'B-154', meta: h.meta() })).toMatchObject({ ok: true });
    expect(h.close()).toMatchObject({ ok: false, reason: 'UNPAID_BILLS', details: { count: 1, billIds: ['B-154'], received: 0 } });
    expect(h.close('empty')).toMatchObject({ ok: false, reason: 'UNPAID_BILLS' });
    const before = h.pos.read().pos;
    let notifications = 0;
    const off = h.data.subscribe(() => {
      notifications++;
      expect(h.run.getState().pos).toBe(h.data.getSnapshot().pos);
      expect(h.run.getState().transactionId).toBe(h.data.getSnapshot().transactionId);
      expect(readModel(h.data.getSnapshot(), 'ledger').sales.net).toBe(843220);
    });
    expect(h.pos.beginApproval({ billId: 'B-154', quoteRevision: before.revision, splits: [{ method: 'card', amount: 12000 }], meta: h.meta('pay') })).toMatchObject({ ok: true, status: 'pending' });
    expect(h.pos.dismissApproval()).toBe(false);
    expect(h.finish()).toMatchObject({ ok: true, value: { billId: 'B-154', orderIds: ['O-154', 'O-155'], remaining: 0, settled: true } });
    expect(notifications).toBe(1); off();
    expect(h.finish()).toMatchObject({ ok: true, duplicate: true });
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: 843220, paymentCount: 154, pendingBillCount: 0, byMethod: { card: 569050 }, methodCounts: { card: 104 } });
    expect(selectOrderSummary(h.pos.read()).rows.filter(row => row.no >= 154).map(row => [row.paymentStatus, row.tableIds])).toEqual([['paid', ['T2']], ['paid', ['T2']]]);
    expect(h.pos.read().pos.tableSessions.find(s => s.tableId === 'T2')).toMatchObject({ cleaning: true });
    const settings = h.pos.read().settings, layout = { ...settings.tableLayout!, revision: 1, tables: settings.tableLayout!.tables.filter(t => t.tableId !== 'T2') };
    expect(h.actions.updateSettings({ ...settings, tableLayout: layout, revision: settings.revision + 1 })).toMatchObject({ ok: false, reason: 'TABLE_IN_USE' });
    expect(readModel(h.data.getSnapshot(), 'menu').rows.find(row => row.menuId === 'm-basque-cake')).toMatchObject({ soldQty: 4 });
    expect(deriveStock(h.data.getSnapshot(), { date: POS_BUSINESS_DATE }).rows.find(row => row.itemId === 'i-basque-cake')?.stock).toBe(17);
    expect(h.pos.execute({ type: 'table.clean', tableId: 'T2', meta: h.meta() })).toMatchObject({ ok: true });
    expect(h.close()).toMatchObject({ ok: true });
  });

  it('rejects missing tables and bad quantities with no publication', () => {
    const h = setup(); h.add();
    const before = h.run.getState(), data = h.data.getSnapshot();
    expect(h.submit()).toMatchObject({ ok: false, reason: 'TABLE_REQUIRED' });
    expect(h.submit('T99')).toMatchObject({ ok: false, reason: 'INVALID_TABLE' });
    expect(h.add('m-americano', 100)).toMatchObject({ ok: false, reason: 'QTY_LIMIT' });
    expect(h.run.getState()).toBe(before); expect(h.data.getSnapshot()).toBe(data);
  });

  it('preserves unpaid orders and inventory on failed approval and retries with a fresh key', () => {
    const h = setup(); h.add(); h.submit('T2');
    h.run.actions.setPosPreview('payment-failure');
    const before = h.pos.read().pos;
    expect(h.pos.beginApproval({ billId: 'B-154', quoteRevision: before.revision, splits: [{ method: 'card', amount: 3000 }], meta: h.meta('fail') })).toMatchObject({ ok: true });
    expect(h.finish()).toMatchObject({ ok: false, reason: 'APPROVAL_FAILED' });
    expect(h.pos.read().pos).toBe(before);
    h.run.actions.setPosPreview('normal');
    expect(h.pos.beginApproval({ billId: 'B-154', quoteRevision: before.revision, splits: [{ method: 'card', amount: 3000 }], meta: h.meta('retry') })).toMatchObject({ ok: true });
    expect(h.finish()).toMatchObject({ ok: true });
  });

  it('keeps tableless additional orders in the selected bill and takeout requires immediate approval', () => {
    const h = setup('beauty'); h.add();
    expect(h.submit()).toMatchObject({ ok: true, value: { billId: 'B-154' } });
    h.add('m-basque-cake');
    expect(h.submit(undefined, 'B-154')).toMatchObject({ ok: true, value: { billId: 'B-154', orderIds: ['O-155'] } });
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: seedToday.rollup.net, pendingBillCount: 1 });
    h.pos.execute({ type: 'cart.type', orderType: 'takeout', meta: h.meta() }); h.add('m-basque-cake');
    expect(h.submit()).toMatchObject({ ok: false, reason: 'IMMEDIATE_PAYMENT_REQUIRED' });
    expect(h.pos.beginApproval({ cartId: h.pos.read().pos.cart.cartId, quoteRevision: quoteCart(h.pos.read()).revision, splits: [{ method: 'cash', amount: 5200 }], meta: h.meta() })).toMatchObject({ ok: true });
    expect(h.finish()).toMatchObject({ ok: true, value: { orderIds: ['O-156'] } });
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: 836420, pendingBillCount: 1 });
  });

  it('blocks settings changes and deleting occupied tables through both public settings paths', () => {
    const h = setup(); h.add(); h.submit('T2');
    const settings = h.run.getState().shopSettings;
    expect(h.actions.updateSettings({ ...settings, paymentStyle: 'prepaid', revision: settings.revision + 1 })).toMatchObject({ ok: false, reason: 'UNPAID_BILLS' });
    const layout = { ...settings.tableLayout!, revision: 1, tables: settings.tableLayout!.tables.filter(t => t.tableId !== 'T2') };
    expect(h.pos.execute({ type: 'table.saveLayout', layout, expectedSettingsRevision: settings.revision, meta: h.meta() })).toMatchObject({ ok: false, reason: 'TABLE_IN_USE' });
    expect(h.actions.updateSettings({ ...settings, tableLayout: layout, revision: settings.revision + 1 })).toMatchObject({ ok: false, reason: 'TABLE_IN_USE' });
    expect(h.pos.execute({ type: 'pos.setPreferences', showTables: false, meta: h.meta() })).toMatchObject({ ok: false, reason: 'UNPAID_BILLS' });
  });

  it('accepts and undoes reservation attendance atomically without changing the booking and guest counts', () => {
    const h = setup(); h.add('m-americano', 2); h.submit('T4');
    const prompt = h.pos.read().pos.reservationPrompts.find(row => row.reservationId === 'test-visit-now')!;
    expect(prompt).toMatchObject({ billId: 'B-154', firstOrderId: 'O-154', decision: 'pending' });
    let publications = 0;
    const off = h.data.subscribe(() => {
      publications++;
      expect(h.data.getSnapshot().pos).toBe(h.run.getState().pos);
      expect(h.pos.read().pos.reservationPrompts.find(row => row.reservationId === 'test-visit-now')!.decision).toBe('accepted');
      expect(selectReservations(h.data.getSnapshot(), { date: POS_BUSINESS_DATE })).toMatchObject({ count: 7, partyTotal: 20 });
    });
    const result = h.pos.execute({ type: 'reservation.respond', reservationId: prompt.reservationId, billId: prompt.billId, decision: 'accept', meta: h.meta('attend') });
    expect(result).toMatchObject({ ok: true }); off(); expect(publications).toBe(1);
    expect(h.data.getSnapshot().tables.reservation.find(r => r.reservationId === prompt.reservationId)?.status).toBe('completed');
    const changes = h.data.getSnapshot().tables.reservationChange;
    expect(changes.at(-1)).toMatchObject({ reservationId: prompt.reservationId, at: POS_NOW, kind: 'status' });
    expect(h.pos.undo(result.ok ? result.undoToken! : '')).toMatchObject({ ok: true });
    expect(h.data.getSnapshot().tables.reservation.find(r => r.reservationId === prompt.reservationId)?.status).toBe('confirmed');
    expect(h.data.getSnapshot().tables.reservationChange).toHaveLength(changes.length - 1);
    expect(h.pos.read().pos.reservationPrompts.find(row => row.reservationId === 'test-visit-now')!.decision).toBe('pending');
  });

  it('does not prompt again after defer or add a member visit for attendance', () => {
    const h = setup(); const visits = h.data.getSnapshot().tables.marketing.mktVisit;
    h.add(); h.submit('T4'); const prompt = h.pos.read().pos.reservationPrompts.find(row => row.reservationId === 'test-visit-now')!;
    expect(h.pos.execute({ type: 'reservation.respond', reservationId: prompt.reservationId, billId: prompt.billId, decision: 'defer', meta: h.meta() })).toMatchObject({ ok: true });
    h.add(); h.submit('T4');
    expect(h.pos.read().pos.reservationPrompts.filter(row => row.reservationId === prompt.reservationId)).toHaveLength(1);
    expect(h.pos.read().pos.reservationPrompts.find(row => row.reservationId === 'test-visit-now')!.decision).toBe('declined');
    expect(h.data.getSnapshot().tables.marketing.mktVisit).toEqual(visits);
  });

  it('normalizes start preferences, preserves explicit choices, and changes tabs only on layer entry', () => {
    const h = setup(); h.run.actions.switchLayer('orders-payment');
    expect(h.pos.read().posUi.tab).toBe('tables');
    expect(h.pos.execute({ type: 'pos.setPreferences', startTab: 'status', meta: h.meta() })).toMatchObject({ ok: true });
    expect(h.pos.read().posUi.tab).toBe('tables');
    h.run.actions.switchLayer('management'); h.run.actions.switchLayer('orders-payment');
    expect(h.pos.read().posUi.tab).toBe('status');
    expect(h.pos.execute({ type: 'pos.setPreferences', showStatus: false, meta: h.meta() })).toMatchObject({ ok: true });
    expect(h.run.getState().shopSettings.posPreferences).toMatchObject({ startTab: 'order', userChoseStart: true, showStatus: false });
    expect(h.data.getSnapshot().tables.shopSettings.posPreferences).toEqual(h.run.getState().shopSettings.posPreferences);
    const s = h.run.getState().shopSettings;
    expect(h.actions.updateSettings({ ...s, paymentStyle: 'prepaid', revision: s.revision + 1 })).toMatchObject({ ok: true });
    expect(h.run.getState().shopSettings.tableLayout).toEqual(s.tableLayout);
    expect(h.run.getState().shopSettings.posPreferences?.startTab).toBe('order');
  });

  it('updates the shared layout and reservation warnings while preserving reservation status and totals', () => {
    const h = setup(); const settings = h.pos.read().settings, layout = settings.tableLayout!;
    const next = { ...layout, revision: layout.revision + 1, tables: [...layout.tables.map(t => t.tableId === 'T6' ? { ...t, seats: 2 } : t), { tableId: 'T7', number: 7, seats: 2, column: 1, row: 5 }] };
    expect(h.pos.execute({ type: 'table.saveLayout', layout: next, expectedSettingsRevision: settings.revision, meta: h.meta() })).toMatchObject({ ok: true });
    expect(h.pos.read().settings.tableLayout).toEqual(next);
    const r = selectReservations(h.data.getSnapshot(), { date: POS_BUSINESS_DATE });
    expect(r).toMatchObject({ count: 7, partyTotal: 20, totalSeats: 18 });
    expect(r.rows.find(row => row.tableId === 'T6')).toMatchObject({ status: 'confirmed', allocationWarning: 'NO_MATCHING_TABLE' });
  });

  it('derives reserved windows and live bill priority without treating historical paid bills as occupied', () => {
    const h = setup(); const read = h.pos.read();
    expect(selectTableMap(read)).toBe(selectTableMap(read));
    expect(selectUnpaidBills(read)).toBe(selectUnpaidBills(read));
    expect(selectTableMap(read).tables.map(t => [t.tableId, t.state])).toEqual([
      ['T1', 'empty'], ['T2', 'empty'], ['T3', 'empty'], ['T4', 'reserved'], ['T5', 'empty'], ['T6', 'empty'],
    ]);
    expect(selectTableMap(read).tables.find(t => t.tableId === 'T5')?.reservation?.time).toBe('17:00');
    expect(selectTableMap(read, `${POS_BUSINESS_DATE}T13:59`).tables.find(t => t.tableId === 'T4')?.state).toBe('empty');
    expect(selectTableMap(read, `${POS_BUSINESS_DATE}T14:00`).tables.find(t => t.tableId === 'T4')?.state).toBe('reserved');
    expect(selectTableMap(read, `${POS_BUSINESS_DATE}T16:30`).tables.find(t => t.tableId === 'T4')?.state).toBe('empty');
    h.add(); h.submit('T4');
    expect(selectTableMap(h.pos.read()).tables.find(t => t.tableId === 'T4')).toMatchObject({ state: 'occupied', total: 3000, elapsed: 0, orderCount: 1 });
    const requested = h.pos.execute({ type: 'bill.requestPayment', billId: 'B-154', meta: h.meta() });
    expect(selectTableMap(h.pos.read()).tables.find(t => t.tableId === 'T4')?.state).toBe('payment_pending');
    expect(h.pos.undo(requested.ok ? requested.undoToken! : '')).toMatchObject({ ok: true });
    expect(selectTableMap(h.pos.read()).tables.find(t => t.tableId === 'T4')?.state).toBe('occupied');
    const pos = h.pos.read().pos;
    const partial = { ...h.pos.read(), pos: { ...pos, bills: pos.bills.map(b => b.billId === 'B-154' ? { ...b, status: 'partial' as const } : b) } };
    expect(selectTableMap(partial).tables.find(t => t.tableId === 'T4')?.state).toBe('payment_pending');
  });

  it('cancels only an unpaid order allocation and undoes without reverting unrelated edits', () => {
    const h = setup(); h.add(); h.submit('T2'); h.add('m-basque-cake'); h.submit('T2');
    const canceled = h.pos.execute({ type: 'order.cancelUnpaid', orderId: 'O-154', meta: h.meta('cancel') });
    expect(canceled).toMatchObject({ ok: true });
    expect(quoteBill(h.pos.read(), 'B-154')).toMatchObject({ totalQty: 1, payable: 5200, orderIds: ['O-155'] });
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: seedToday.rollup.net, pendingBillCount: 1 });
    h.data.dispatch({ type: 'menu.update', menuId: 'm-cookie-choco', patch: { price: 3200 } });
    expect(h.pos.undo(canceled.ok ? canceled.undoToken! : '')).toMatchObject({ ok: true });
    expect(quoteBill(h.pos.read(), 'B-154')).toMatchObject({ payable: 8200, totalQty: 2 });
    expect(h.data.getSnapshot().tables.menuItem.find(m => m.menuId === 'm-cookie-choco')?.price).toBe(3200);
    expect(h.pos.execute({ type: 'order.cancelUnpaid', orderId: 'O-154', meta: h.meta('cancel') })).toMatchObject({ ok: false, reason: 'COMMAND_UNDONE' });
  });

  it('never reuses an undone order number for immediate takeout', () => {
    const h = setup(); h.add(); const submitted = h.submit('T2');
    expect(h.pos.undo(submitted.ok ? submitted.undoToken! : '')).toMatchObject({ ok: true });
    expect(selectPosDayTotals(h.pos.read().pos).pendingBillCount).toBe(0);
    h.pos.execute({ type: 'cart.type', orderType: 'takeout', meta: h.meta() });
    expect(h.pos.beginApproval({ cartId: h.pos.read().pos.cart.cartId, quoteRevision: h.pos.read().pos.cart.revision, splits: [{ method: 'card', amount: 3000 }], meta: h.meta() })).toMatchObject({ ok: true });
    expect(h.finish()).toMatchObject({ ok: true, value: { orderIds: ['O-155'], billId: 'B-155' } });
  });

  it('counts an immediate pending approval as one closing blocker and protects settings', () => {
    const h = setup(); h.pos.execute({ type: 'cart.type', orderType: 'takeout', meta: h.meta() }); h.add();
    h.pos.beginApproval({ cartId: h.pos.read().pos.cart.cartId, quoteRevision: h.pos.read().pos.cart.revision, splits: [{ method: 'card', amount: 3000 }], meta: h.meta() });
    expect(h.close()).toMatchObject({ ok: false, reason: 'UNPAID_BILLS', details: { count: 1, billIds: [] } });
    const settings = h.pos.read().settings;
    expect(h.actions.updateSettings({ ...settings, paymentStyle: 'prepaid', revision: settings.revision + 1 })).toMatchObject({ ok: false, reason: 'UNPAID_BILLS' });
  });

  it('keeps attendance and its undo when data prepare fails, and rejects undo after a booking edit', () => {
    const h = setup(); h.add(); h.submit('T4'); const prompt = h.pos.read().pos.reservationPrompts.find(row => row.reservationId === 'test-visit-now')!;
    const command = { type: 'reservation.respond' as const, reservationId: prompt.reservationId, billId: prompt.billId, decision: 'accept' as const, meta: h.meta() };
    const read = h.pos.read(), plan = planTableCommand(read, command, POS_NOW);
    expect(plan.ok).toBe(true);
    const failing = createSessionActions(h.run, { ...h.data, session: { ...h.data.session, prepare: () => ({ ok: false, code: 'CONFLICT', reason: 'DATA_PREPARE_FAILED', messageKey: 'run.session.conflict' }) } }, h.gate);
    const beforeRun = h.run.getState(), beforeData = h.data.getSnapshot();
    if (!plan.ok) throw new Error(plan.reason);
    expect(failing.commit(plan.plan, read)).toMatchObject({ ok: false, reason: 'DATA_PREPARE_FAILED' });
    expect(h.run.getState()).toBe(beforeRun); expect(h.data.getSnapshot()).toBe(beforeData); failing.pos.dispose();
    const accepted = h.pos.execute(command); expect(accepted.ok).toBe(true);
    expect(h.data.dispatch({ type: 'booking.cancel', reservationId: prompt.reservationId })).toMatchObject({ ok: true });
    expect(h.pos.undo(accepted.ok ? accepted.undoToken! : '')).toMatchObject({ ok: false, reason: 'UNDO_UNAVAILABLE' });
  });

  it('keeps explicit start choices when enabling tables and corrects a hidden automatic start', () => {
    const h = setup('cafe', false); const s = h.pos.read().settings;
    expect(selectPosPreferences(s).startTab).toBe('order');
    h.pos.execute({ type: 'pos.setPreferences', startTab: 'status', meta: h.meta() });
    const settings = h.pos.read().settings;
    expect(h.actions.updateSettings({ ...settings, tableLayout: createTableLayout(), revision: settings.revision + 1 })).toMatchObject({ ok: true });
    expect(selectPosPreferences(h.pos.read().settings).startTab).toBe('status');
    expect(h.pos.execute({ type: 'pos.setPreferences', startTab: 'tables', meta: h.meta() })).toMatchObject({ ok: true });
    expect(h.pos.execute({ type: 'pos.setPreferences', showTables: false, meta: h.meta('hide') })).toMatchObject({ ok: true, noticeKey: 'order.settings.startAdjusted' });
    const first = h.pos.execute({ type: 'pos.setPreferences', showTables: false, meta: h.meta('hide') });
    expect(first).toMatchObject({ ok: true, duplicate: true, noticeKey: 'order.settings.startAdjusted' });
    expect(first.ok && first.transactionId).toBeDefined();
  });

  it('rejects a monetary undo after closing', () => {
    const h = setup(); h.add(); h.submit('T2');
    const canceled = h.pos.execute({ type: 'order.cancelUnpaid', orderId: 'O-154', meta: h.meta() });
    expect(canceled).toMatchObject({ ok: true }); expect(h.close()).toMatchObject({ ok: true });
    expect(h.pos.undo(canceled.ok ? canceled.undoToken! : '')).toMatchObject({ ok: false, reason: 'DAY_CLOSED' });
    expect(selectPosDayTotals(h.pos.read().pos).pendingBillCount).toBe(0);
  });

  it('revalidates bill prices at the approval callback without changing sales or inventory', () => {
    const h = setup(); h.add(); h.submit('T2'); const before = h.pos.read().pos;
    const quote = quoteBill(h.pos.read(), 'B-154');
    h.pos.beginApproval({ billId: quote.billId, quoteRevision: quote.revision, splits: [{ method: 'card', amount: quote.remaining }], meta: h.meta() });
    expect(h.data.dispatch({ type: 'menu.update', menuId: 'm-americano', patch: { price: 5000 } })).toMatchObject({ ok: true });
    const data = h.data.getSnapshot();
    expect(h.finish()).toMatchObject({ ok: false, reason: 'QUOTE_CHANGED' });
    expect(h.pos.read().pos).toBe(before); expect(h.data.getSnapshot()).toBe(data);
    expect(h.pos.read().pos.orders.at(-1)?.lines[0].unitPriceAtOrder).toBe(3000);
    expect(quoteBill(h.pos.read(), 'B-154').remaining).toBe(5000);
  });
});
