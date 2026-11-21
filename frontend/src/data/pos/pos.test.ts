import { setup as setupBase } from '../../pos/loyalty/test-setup';
import { getPaymentBillId, quotePaymentBill } from '../../pos/loyalty';
import { describe, expect, it, vi } from 'vitest';
import { createPosSeed } from '../../pos/seed';
import type { PosState } from '../../contracts/pos';
import { createWidgetDataStore, deriveStock, deriveUsage, readModel, projectPosDay, selectPosDataRead, selectPosPayments, selectPayments, selectStockHistory, TODAY } from '../widget-data';

import * as widgetData from '../widget-data';
import manifest from '../db/generated/manifest.json';
import { seedToday } from '../db/generated/today';
import { seedHistory } from '../db/generated/history';
import { createLegacySeedTables } from '../db/legacy-seed';
import { createSeedTables } from '../db/seed';
import { POS_NOW } from '../../pos/clock';
import { YESTERDAY } from '../db/time';

const createStore = createWidgetDataStore;

function setupMoney(paymentStyle?: 'prepaid' | 'postpaid') {
  const h = setupBase(paymentStyle);
  const add = (menuId = 'm-americano', qty = 1) => {
    const menu = h.pos.read().data.catalog.items.find(item => item.menuId === menuId)!;
    const optionIds = menu.groups.filter(group => group.required).map(group =>
      group.options.find(option => option.name === 'ICE')?.optionId ?? group.options.find(option => option.extraPrice === 0)!.optionId);
    return h.pos.execute({ type: 'cart.add', menuId, qty, optionIds, meta: h.meta() });
  };
  return { ...h, add };
}


describe('API-243 POS management projection', () => {
  it('projects the cafe payments and keeps historical sales and management inputs', () => {
    const s = createWidgetDataStore().getSnapshot();
    expect(s.pos).toBeDefined();
    const latest = seedToday.pos.payments.at(-1)!;
    expect(s.tables.payment.find(p => p.paymentId === latest.paymentId)).toMatchObject({ time: latest.at.slice(11, 16), gross: latest.amount });
    const payments = selectPayments(s, { date: TODAY, scenario: 'normal' });
    expect(payments.rows.slice(0, 4).map(p => [p.time, p.net])).toEqual(
      seedToday.pos.payments.slice(-4).reverse().map(p => [p.at.slice(11, 16), p.amount]),
    );
    expect(payments.totals).toMatchObject({ gross: 859500, discount: 28280, refund: -0, net: 831220,
      paymentCount: manifest.counts.payments, refundCount: 0, byMethod: { card: 557050, easy_pay: 217270, cash: 56900 },
      methodCounts: { card: 103, easy_pay: 39, cash: 11 } });
    expect(Object.fromEntries(s.tables.menuDaily.filter(m => m.businessDate === TODAY).map(m => [m.menuId, m.qty])))
      .toEqual(Object.fromEntries(seedToday.rollup.menu.map(([menuId, qty]) => [menuId, qty])));
    expect(readModel(s, 'margin')).toMatchObject({ netSales: 831220, cost: 244333, grossProfit: 586887 });
    expect(readModel(s, 'ledger')).toMatchObject({ netProfit: 721220, profitRate: 86.8 });
    expect(readModel(s, 'members')).toMatchObject({ total: manifest.counts.members });
    expect(readModel(s, 'voice-booking')).toMatchObject({ todayCount: s.tables.reservation.filter(row => row.date === TODAY && row.kind !== 'pickup' && !row.variant && row.status !== 'canceled' && row.status !== 'proposed').length });
    expect(readModel(s, 'grants')).toMatchObject({ candidateCount: 2, inProgressCount: 0 });
    const stock = deriveStock(s, { date: TODAY }).rows;
    for (const row of seedToday.stock) expect(stock.find(item => item.itemId === row.itemId)?.rawBase).toBe(row.onHand);
    expect(deriveUsage(s, { date: TODAY }).usageRows.every(r => r.asOf === latest.at.slice(11, 16))).toBe(true);
    expect(readModel(s, 'inventory-booking').products.items).toEqual([]);
    const historical = s.tables.dailySales.find(r => r.businessDate === YESTERDAY)!;
    expect(historical.recognizedNet).toBe(seedHistory.days.find(day => day.date === YESTERDAY)?.net);
  });

  it('allocates multi-menu discounts once and reads mixed method amounts without duplicating sales', () => {
    const h = setupMoney(); h.add(); h.add('m-cafe-latte');
    const billId = getPaymentBillId(h.pos.read());
    expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'direct', amount: 1001 }, meta: h.meta() }).ok).toBe(true);
    const quote = quotePaymentBill(h.pos.read(), billId);
    expect(h.pos.beginApproval({ billId, quoteRevision: quote.revision, splits: [{ method: 'card', amount: 3799 }, { method: 'cash', amount: 2000 }], meta: h.meta() }).ok).toBe(true);
    expect(h.finish().ok).toBe(true);
    const s = h.data.getSnapshot();
    const day = projectPosDay({ pos: s.pos!, data: s, scenario: 'normal', date: TODAY });
    expect(day.menuDailyToday.reduce((n, m) => n + m.netSales, 0)).toBe(837019);
    expect(day.menuDailyToday.reduce((n, m) => n + (m.totalCost ?? 0), 0)).toBe(246135);
    const mixed = selectPosPayments(s, { date: TODAY, method: 'cash', onlyMixed: true });
    expect(mixed.rows).toHaveLength(1);
    expect(mixed.rows[0]).toMatchObject({ net: 5799, visibleAmount: 2000 });
    expect(mixed.totals.net).toBe(837019);
  });

  it('quotes current option prices and recipe costs without changing settled cost', () => {
    const data = createWidgetDataStore(), s = data.getSnapshot();
    const original = selectPosDataRead(s);
    const latte = original.catalog.items.find(m => m.menuId === 'm-cafe-latte')!;
    expect(latte).toMatchObject({ price: 3800, unitCost: 1278, shortageItems: [] });
    expect(latte.groups.flatMap(g => g.options).filter(o => o.extraPrice > 0)).toEqual([expect.objectContaining({ name: '오트 귀리우유', extraPrice: 600, extraCost: 0, extraRecipe: [] })]);
    const options = { groupId: 'test-extra-milk', menuId: latte.menuId, name: '우유 추가', required: false, options: [
      { optionId: 'test-extra-milk:100mL', groupId: 'test-extra-milk', name: '우유 100 mL', extraPrice: 500, extraCost: null,
        extraRecipe: [{ itemId: 'i-milk', quantityBase: 100, unitDimension: 'mL' as const }] },
    ] };
    expect(data.dispatch({ type: 'menu.setOptions', menuId: latte.menuId, groups: [...latte.groups, options] }).ok).toBe(true);
    const withOption = selectPosDataRead(data.getSnapshot());
    const optionCost = (read: typeof original) => read.catalog.items.find(m => m.menuId === latte.menuId)!.groups
      .flatMap(group => group.options).find(option => option.optionId === options.options[0].optionId)?.extraCost;
    expect(optionCost(withOption)).toBe(290);
    expect(selectPosDataRead(s)).toBe(original);
    const purchaseItemId = s.tables.purchaseItem.find(row => row.itemId === 'i-milk')!.purchaseItemId;
    expect(data.dispatch({ type: 'suppliers.updatePurchaseItem', purchaseItemId, patch: { unitPrice: 4000 } }).ok).toBe(true);
    const updated = selectPosDataRead(data.getSnapshot());
    expect(updated.catalog.items.find(m => m.menuId === latte.menuId)?.unitCost).toBe(1564);
    expect(optionCost(updated)).toBe(400);
    expect(readModel(data.getSnapshot(), 'margin').cost).toBe(244333);
  });

  it('projects retail sale differences once and preserves run CRUD and online stock', () => {
    const legacy = createLegacySeedTables();
    const store = vi.spyOn(widgetData, 'createWidgetDataStore').mockImplementationOnce((seed, options) => {
      const cafe = createSeedTables();
      return createStore({ ...seed,
        menuItem: [...cafe.menuItem, legacy.menuItem.find(row => row.menuId === 'm-beans200')!],
        inventoryItem: [...cafe.inventoryItem, legacy.inventoryItem.find(row => row.itemId === 'it-beans200')!],
        inventoryStock: [...cafe.inventoryStock, ...legacy.inventoryStock.filter(row => row.itemId === 'it-beans200')],
      }, options);
    });
    const h = (() => {
      try { return setupMoney(); } finally { store.mockRestore(); }
    })();
    const data = h.data, before = data.getSnapshot();
    expect(before.pos).toBeDefined();
    expect(h.pos.execute({type:'cart.add',menuId:'m-beans200',optionIds:[],meta:h.meta()}).ok).toBe(true);
    const quote=h.actions.money.quoteSale({billId:getPaymentBillId(h.pos.read()),allocations:[{kind:'method',method:'card',amount:12000}]});
    expect(h.actions.money.beginApproval({quote,idempotencyKey:'retail'}).ok).toBe(true);
    const pending=h.actions.money.approval()!;
    expect(h.actions.money.finishApproval({runId:pending.runId,attemptId:pending.attemptId,outcome:'approved'}).ok).toBe(true);
    h.actions.money.dismissApproval();
    expect(readModel(data.getSnapshot(), 'inventory-booking').products.items[0]).toMatchObject({ store: 119, online: 40, sales7d: { store: 35, online: 18 } });
    const result = data.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'operations', amount: 100 });
    expect(result.ok).toBe(true);
    expect(readModel(data.getSnapshot(), 'inventory-booking').products.items[0]).toMatchObject({ store: 119, online: 40, sales7d: { store: 35 } });
    expect(deriveUsage(data.getSnapshot(), { date: TODAY }).byItem['i-bean-house']).toBe(2358);
  });

  it('recomputes current recipe quotes while keeping historical usage and costs frozen through CRUD and undo', () => {
    const data = createWidgetDataStore(), before = data.getSnapshot();
    expect(before.pos).toBeDefined();
    const recipe = before.tables.recipeLine.filter(r => r.menuId === 'm-americano');
    const result = data.dispatch({ type: 'menu.setRecipe', menuId: 'm-americano', lines: recipe.map(r => ({ ...r, quantity: r.itemId === 'i-bean-house' ? 30 : r.quantity })) });
    expect(result.ok).toBe(true);
    const s = data.getSnapshot();
    expect(s.pos).toBe(before.pos);
    expect(deriveUsage(s, { date: TODAY }).byItem['i-bean-house']).toBe(2358);
    expect(selectPosDataRead(s).catalog.items.find(m => m.menuId === 'm-americano')?.unitCost).toBe(800);
    expect(readModel(s, 'margin').cost).toBe(244333);
    if (!result.ok || !result.undoToken) throw new Error('Missing recipe undo');
    expect(data.undo(result.undoToken).ok).toBe(true);
    expect(deriveUsage(data.getSnapshot(), { date: TODAY }).byItem['i-bean-house']).toBe(2358);
    expect(data.getSnapshot().pos).toBe(before.pos);
  });

  it('aggregates paid option recipes into stable usage rows and keeps cost-at-sale', () => {
    expect(typeof projectPosDay).toBe('function');
    const data = createWidgetDataStore(), s = data.getSnapshot(), seed = createPosSeed();
    const order = seed.orders.find(o => o.lines.some(l => l.menuId === 'm-cafe-latte'))!;
    const next: PosState = { ...seed, orders: seed.orders.map(o => o !== order ? o : { ...o, lines: o.lines.map(l => l.menuId !== 'm-cafe-latte' ? l : { ...l, optionsAtOrder: [...l.optionsAtOrder, { optionId: 'extra-test', name: '추가', extraPrice: 500, extraRecipe: [{ itemId: 'i-milk', quantityBase: 100, unitDimension: 'mL' }] }] }) }) };
    const day = projectPosDay({ pos: next, data: s, scenario: 'normal', date: TODAY });
    const qty = order.lines.find(l => l.menuId === 'm-cafe-latte')!.qty;
    expect(day.usage.byItem['i-milk']).toBe(21960 + 100 * qty);
    expect(day.usage.usageRows.filter(r => r.menuId === 'm-cafe-latte' && r.itemId === 'i-milk')).toHaveLength(1);
    expect(day.menuDailyToday.reduce((n, m) => n + m.qty * (m.unitCost ?? 0), 0)).toBe(244333);
  });

  it('keeps unpaid receipts out of revenue, menu sales and usage, with independent empty reads', () => {
    expect(typeof projectPosDay).toBe('function');
    const s = createWidgetDataStore().getSnapshot(), seed = createPosSeed(), first = seed.bills[0];
    const pos: PosState = { ...seed, bills: seed.bills.map(b => b !== first ? b : { ...b, status: 'partial', recognizedAt: undefined }) };
    const day = projectPosDay({ pos, data: s, scenario: 'normal', date: TODAY });
    expect(day.pendingReceived).toBe(seed.payments.find(p => p.billId === first.billId)!.amount);
    expect(day.methodTotals.paymentCount).toBe(seed.payments.length - 1);
    const empty = projectPosDay({ pos, data: s, scenario: 'empty', date: TODAY });
    expect(empty.paymentRows).toEqual([]); expect(empty.dailySalesToday.gross).toBe(0);
    expect(s.tables.payment).toHaveLength(seed.payments.length);
  });

  it('validates future reservations, future grants and coupon sends on the cafe business clock', () => {
    const base = createWidgetDataStore().getSnapshot();
    const grants = base.tables.grantNotice.map((n, i) => i === 0 ? { ...n, applyStart: `${TODAY}T16:15` } : n);
    const data = createWidgetDataStore({ reservation: base.tables.reservation.map((r, i) => i === 0 ? { ...r, time: '16:00', status: 'confirmed' } : r), grantNotice: grants });
    expect(readModel(data.getSnapshot(), 'voice-booking').reservations.find(r => r.reservationId === base.tables.reservation[0].reservationId)!.canMarkNoShow).toBe(false);
    expect(readModel(data.getSnapshot(), 'grants').notices.find(n => n.noticeId === grants[0].noticeId)?.isCandidate).toBe(false);
    expect(data.dispatch({ type: 'grants.apply', noticeId: grants[0].noticeId, idempotencyKey: 'grant' }).ok).toBe(false);
    const snapshot = data.getSnapshot();
    const slot = readModel(snapshot, 'slot-coupon').slots.find(row => !row.handled)!;
    const recipient = snapshot.tables.marketing.mktCustomer.find(row => row.consentSms && !row.deletedAt && row.variant === null)!;
    const send = { type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: [recipient.customerId], benefit: 'amount-500', idempotencyKey: 'send' } as const;
    expect(data.dispatch({ ...send, sendAt: `${TODAY}T15:15` })).toMatchObject({ ok: false, code: 'VALIDATION', field: 'send_at' });
    expect(data.dispatch({ ...send, sendAt: `${TODAY}T16:15` }).ok).toBe(true);
    const close = data.dispatch({ type: 'closing.closeDay', date: TODAY, scenario: 'normal', expectedGeneration: 0, idempotencyKey: 'close' });
    expect(close).toMatchObject({ ok: true, value: { closedAt: POS_NOW } });
    if (!close.ok || !close.undoToken) throw new Error('Missing closing undo');
    expect(data.undo(close.undoToken)).toMatchObject({ ok: true, value: { reopenedAt: POS_NOW } });
    expect(selectStockHistory(data.getSnapshot(), { itemId: 'i-bean-house', period: 'today' }).dayGroups[0].rows.find(r => r.kind === 'usage')?.asOf).toBe('15:42');
  });
});
