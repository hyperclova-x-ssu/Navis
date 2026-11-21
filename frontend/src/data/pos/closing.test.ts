import { expect, it } from 'vitest';
import { setup as setupBase } from '../../pos/loyalty/test-setup';
import { getPaymentBillId, quotePaymentBill } from '../../pos/loyalty';
import { selectPosClosing, selectPosClosingHistory } from './closing';
import { deriveUsage, readModel, selectPosDataRead, selectPosPayments, selectPosBriefing } from '../widget-data';
import { selectReceipt } from '../../pos/reversals';
import { storeFactSource } from '../../features/assistant/snapshot';
import { POS_BUSINESS_DATE, POS_NOW } from '../../pos/clock';
import { seedClosingHistory } from '../db/generated/closing-history';
import { seedToday } from '../db/generated/today';

function setup(paymentStyle?: 'prepaid' | 'postpaid') {
  const h = setupBase(paymentStyle);
  const add = (menuId = 'm-americano', qty = 1) => {
    const menu = h.pos.read().data.catalog.items.find(item => item.menuId === menuId)!;
    const optionIds = menu.groups.filter(group => group.required).map(group =>
      group.options.find(option => option.name === 'ICE')?.optionId ?? group.options.find(option => option.extraPrice === 0)!.optionId);
    return h.pos.execute({ type: 'cart.add', menuId, qty, optionIds, meta: h.meta() });
  };
  return { ...h, add };
}


const query = { date: POS_BUSINESS_DATE, scenario: 'normal' as const };
it('projects drawer → close → late undo, freezes totals and adds/removes only today history', () => {
  const h = setup(), original = h.data.getSnapshot();
  const past = original.tables.dailySales.filter(d => d.businessDate !== query.date);
  const before = selectPosClosing(h.pos.read(), query);
  expect(before.totals).toMatchObject({ gross: seedToday.rollup.gross, discount: seedToday.rollup.discount, revenue: seedToday.rollup.net, discountBySource: seedToday.rollup.discountBySource });
  expect(Math.abs(before.totals.refund)).toBe(seedToday.rollup.refund);
  const history = selectPosClosingHistory(original, { scenario: 'normal' });
  expect(history.map(r => r.businessDate)).toEqual(seedClosingHistory.map(r => r.businessDate).sort().reverse());
  expect(history.reduce((n, r) => n + r.revenue, 0)).toBe(past.reduce((sum, row) => sum + (row.recognizedNet ?? row.gross - row.discount - row.refund), 0));
  for (const row of history) {
    expect(Object.values(row.byMethod).reduce((a, n) => a + n, 0)).toBe(row.revenue);
    const source = past.find(d => d.businessDate === row.businessDate)!;
    expect(row.revenue).toBe(source.recognizedNet ?? source.gross - source.discount - source.refund);
  }
  const closedSeed = seedClosingHistory.find(row => row.businessDate === history[1].businessDate)!;
  expect(history[1]).toMatchObject({ cashDrawer: { opening: closedSeed.drawerSnapshot.opening, difference: closedSeed.drawerSnapshot.difference }, closedAt: closedSeed.closedAt });
  // A card-only sale leaves the expected cash drawer unchanged.
  h.add(); const billId = getPaymentBillId(h.pos.read()), q = quotePaymentBill(h.pos.read(), billId);
  h.pos.beginApproval({ billId, quoteRevision: q.revision, splits: [{ method: 'card', amount: 3000 }], meta: h.meta() });
  expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
  expect(h.pos.execute({ type: 'drawer.set', actual: 173000, memo: '잔돈 확인', meta: h.meta() }).ok).toBe(true);
  expect(selectPosClosing(h.data.getSnapshot(), query).drawer).toMatchObject({ expected: 256900, actual: 173000, difference: -83900 });
  expect(selectPosBriefing(h.pos.read()).drawer).toMatchObject({ expected: 256900, difference: -83900 });
  expect(storeFactSource(h.data).readSource!('pos')).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'pos.cash.expected', value: 256900 }), expect.objectContaining({ key: 'pos.cash.difference', value: -83900 }), expect.objectContaining({ key: 'pos.cash.checked', value: 1 })]));
  const close = h.data.dispatch({ type: 'closing.closeDay', ...query, expectedGeneration: 0, idempotencyKey: 'close' });
  expect(close.ok).toBe(true); if (!close.ok) return;
  const closed = selectPosClosing(h.data.getSnapshot(), query);
  expect(closed.history[0]).toMatchObject({ businessDate: query.date, revenue: 834220, closedAt: POS_NOW, cashDrawer: { difference: -83900 } });
  expect(h.pos.execute({ type: 'drawer.set', actual: 0, meta: h.meta() })).toMatchObject({ ok: false, reason: 'DAY_CLOSED' });
  const dayClosing = h.data.getSnapshot().tables.dayClosing.at(-1)!;
  h.data.dispatch({ type: 'ledger.recordExpense', date: query.date, category: 'supplies', amount: 30000 });
  const orderId = h.pos.read().pos.orders.at(-1)!.orderId;
  expect(h.pos.execute({ type: 'order.complete', orderId, meta: h.meta() }).ok).toBe(true);
  expect(h.data.getSnapshot().tables.dayClosing.at(-1)).toBe(dayClosing);
  expect(selectPosClosing(h.data.getSnapshot(), query).drawer).toEqual(closed.drawer);
  expect(h.data.undo(close.undoToken!)).toMatchObject({ ok: true });
  expect(selectPosClosingHistory(h.data.getSnapshot(), { scenario: 'normal' })).toHaveLength(history.length);
  expect(readModel(h.data.getSnapshot(), 'ledger').expenses.total).toBe(readModel(original, 'ledger').expenses.total + 30000);
  expect(h.pos.read().pos.orders.find(o => o.orderId === orderId)?.preparation).toBe('completed');
  expect(h.data.getSnapshot().tables.dailySales.filter(d => d.businessDate !== query.date)).toEqual(past);
  expect(h.data.dispatch({ type: 'closing.closeDay', ...query, expectedGeneration: 1, idempotencyKey: 'close-again' })).toMatchObject({ ok: true });
  expect(h.data.undo(close.undoToken!)).toMatchObject({ ok: false, reason: 'STALE_CLOSING' });
  expect(selectPosDataRead(h.data.getSnapshot()).storeDisplayName).toBe(selectPosDataRead(original).storeDisplayName);
});

it('exposes mixed method portions, original transaction/order IDs and drawer facts from the same projection', () => {
  const h = setup(); h.add('m-americano', 2);
  const quote = quotePaymentBill(h.pos.read());
  expect(h.pos.beginApproval({ billId: quote.billId, quoteRevision: quote.revision,
    splits: [{ method: 'card', amount: 4000 }, { method: 'cash', amount: 2000 }], meta: h.meta() }).ok).toBe(true);
  expect(h.finish().ok).toBe(true);
  const payment = h.pos.read().pos.payments.at(-1)!;
  const order = h.pos.read().pos.orders.at(-1)!;
  const s = h.data.getSnapshot();
  const cash = selectPosClosing(s, { ...query, method: 'cash' });
  expect(cash.rows).toHaveLength(seedToday.pos.payments.filter(p => p.splits.some(part => part.method === 'cash')).length + 1);
  expect(cash.rows.reduce((n, r) => n + r.visibleAmount, 0)).toBe(58900);
  const mixed = selectPosClosing(s, { ...query, mixed: true });
  expect(mixed.rows).toHaveLength(1);
  expect(mixed.rows[0]).toMatchObject({ net: 6000, visibleAmount: 6000, transactionNo: payment.transactionNo, orderNos: [order.orderNo] });
  expect(selectPosPayments(s, { date: query.date, method: 'card' }).rows.reduce((n, r) => n + r.visibleAmount, 0)).toBe(561050);
  expect(storeFactSource(h.data).readSource!('pos')).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'pos.cash.expected', value: 258900 }),
    expect.objectContaining({ key: 'pos.cash.checked', value: 0 }),
  ]));
  expect(selectPosClosing(s, { ...query, scenario: 'empty' })).toMatchObject({ totals: { revenue: 0 }, drawer: { expected: 200000, approvedCash: 0 }, rows: [], history: [] });
});

it('keeps menu DataCommand undo, archived option recipes and frozen POS receipt/tax fields through close and undo', () => {
  const h = setup(), originalGroups = h.pos.read().data.catalog.items.find(m => m.menuId === 'm-cafe-latte')!.groups;
  const syrup = { groupId: 'closing-syrup', menuId: 'm-cafe-latte', name: '시럽', required: false, options: [
    { optionId: 'closing-syrup:vanilla', groupId: 'closing-syrup', name: '바닐라', extraPrice: 300, extraCost: null,
      extraRecipe: [{ itemId: 'i-vanilla-syrup', quantityBase: 10, unitDimension: 'mL' as const }] },
  ] };
  expect(h.data.dispatch({ type: 'menu.setOptions', menuId: 'm-cafe-latte', groups: [...originalGroups, syrup], baseRevision: h.data.getSnapshot().revision }).ok).toBe(true);
  expect(h.pos.execute({ type: 'cart.add', menuId: 'm-cafe-latte', optionIds: [originalGroups.find(group => group.name === '온도')!.options.find(option => option.name === 'ICE')!.optionId, 'closing-syrup:vanilla'], meta: h.meta() }).ok).toBe(true);
  const q = quotePaymentBill(h.pos.read());
  expect(q.payable).toBe(4100);
  h.pos.beginApproval({ billId: q.billId, quoteRevision: q.revision, splits: [{ method: 'card', amount: 4100 }], meta: h.meta() });
  expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
  const paid = h.pos.read().pos, settlement = paid.bills.at(-1)!.settlementLines;
  const archive = h.data.dispatch({ type: 'menu.setOptions', menuId: 'm-cafe-latte', groups: originalGroups, baseRevision: h.data.getSnapshot().revision });
  expect(archive.ok).toBe(true); if (!archive.ok) return;
  expect(h.data.getSnapshot().tables.menuItem.find(m => m.menuId === 'm-cafe-latte')?.optionGroups?.find(g => g.groupId === syrup.groupId)).toMatchObject({ archivedAt: expect.any(String), options: [{ extraRecipe: [{ quantityBase: 10 }] }] });
  expect(deriveUsage(h.data.getSnapshot(), { date: query.date }).byItem['i-vanilla-syrup']).toBe(665);
  const paymentId = paid.payments.at(-1)!.paymentId;
  const sourceReceipt = selectReceipt(h.pos.read(), { paymentId });
  expect(sourceReceipt).toMatchObject({ amount: 4100, storeName: h.pos.read().data.storeDisplayName });
  expect(readModel(h.data.getSnapshot(), 'tax').exportPreview.cashReceipts).toEqual({ count: 0, amount: 0 });
  h.pos.execute({ type: 'drawer.set', actual: null, meta: h.meta() });
  const closed = h.data.dispatch({ type: 'closing.closeDay', ...query, expectedGeneration: 0, idempotencyKey: 'archive-close' });
  expect(closed.ok).toBe(true); if (!closed.ok) return;
  expect(h.data.undo(closed.undoToken!).ok).toBe(true);
  expect(h.data.undo(archive.undoToken!).ok).toBe(true);
  expect(h.pos.read().pos.bills.at(-1)!.settlementLines).toEqual(settlement);
  expect(h.pos.read().pos.payments).toEqual(paid.payments);
  expect(selectReceipt(h.pos.read(), { paymentId })).toEqual(sourceReceipt);
  expect(deriveUsage(h.data.getSnapshot(), { date: query.date }).byItem['i-vanilla-syrup']).toBe(665);
  expect(selectPosDataRead(h.data.getSnapshot()).catalog.items.find(m => m.menuId === 'm-cafe-latte')?.groups.some(g => g.groupId === syrup.groupId)).toBe(true);
});

it('keeps empty closing history and undo isolated from the normal ledger and past closings', () => {
  const h = setup(), normal = selectPosClosing(h.pos.read(), query);
  const close = h.data.dispatch({ type: 'closing.closeDay', ...query, scenario: 'empty', expectedGeneration: 0, idempotencyKey: 'empty-close' });
  expect(close.ok).toBe(true); if (!close.ok) return;
  const empty = selectPosClosing(h.pos.read(), { ...query, scenario: 'empty' });
  expect(empty.history).toHaveLength(1);
  expect(empty.history[0]).toMatchObject({ businessDate: query.date, revenue: 0, paymentCount: 0, cashDrawer: { actual: null, difference: null } });
  expect(selectPosClosing(h.pos.read(), query)).toMatchObject({ status: 'open', totals: normal.totals, drawer: normal.drawer, history: normal.history });
  expect(h.data.undo(close.undoToken!).ok).toBe(true);
  expect(selectPosClosingHistory(h.data.getSnapshot(), { scenario: 'empty' })).toEqual([]);
});
