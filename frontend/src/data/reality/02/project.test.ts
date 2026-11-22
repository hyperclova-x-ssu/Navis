import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POS_BUSINESS_DATE } from '../../../pos/clock';
import { setup } from '../../../pos/loyalty/test-setup';
import { selectOrderSummary } from '../../../pos/status';
import { selectPaymentRemaining, selectReceipt } from '../../../pos/reversals';
import { selectPosDayTotals } from '../../../pos/domain/money';
import type { PosPlan, PosReadSnapshot } from '../../../contracts/pos';
import type { PosBillDto, PosOrderDto, PosReceiptDto, PosSaleLineDto } from './dto';
import { readModel } from '../../widget-data';
import { projectPosState } from './project';

const ids = { menu: '8d1f3c36-0d3c-4d0e-9a3a-000000000001', option: '8d1f3c36-0d3c-4d0e-9a3a-0000000000a1' };
const line = (n: number, over: Partial<PosSaleLineDto> = {}): PosSaleLineDto => ({
  orderLineId: `00000000-0000-4000-8000-00000000010${n}`, allocationId: `00000000-0000-4000-8000-00000000020${n}`, menuId: ids.menu, name: '아메리카노', qty: 2,
  basePrice: 3000, baseCost: 800, optionPrice: 500, optionCost: 300, recipeVersion: 'v1', gross: 7000, discount: 0, amount: 7000,
  options: [{ optionId: ids.option, name: '샷 추가', extraPrice: 500, extraCost: 300, recipeVersion: 'v1' }], ...over,
});
const day = POS_BUSINESS_DATE;
const order = (n: number, over: Partial<Omit<PosOrderDto, 'paymentId' | 'settlementId'>> = {}): PosOrderDto & { paymentId: string; settlementId: string } => ({
  orderId: `00000000-0000-4000-8000-0000000003${n}0`, orderNo: n, billId: `00000000-0000-4000-8000-0000000004${n}0`, businessDate: day,
  orderedAt: `${day}T01:1${n}:00.000Z`, revision: 1, preparation: 'accepted', tableId: null, settlementId: `00000000-0000-4000-8000-0000000005${n}0`,
  paymentId: `00000000-0000-4000-8000-0000000006${n}0`, amount: 7000, remaining: 7000, lines: [line(n)], ...over,
});
const bill = (o: PosOrderDto, type: 'dine_in' | 'takeout' = 'takeout'): PosBillDto => ({
  billId: o.billId, businessDate: day, status: 'paid', revision: 2, type, createdAt: o.orderedAt, recognizedAt: o.orderedAt, tableId: o.tableId,
  quote: { quoteRevision: 1, lines: o.lines, gross: 7000, discount: 0, payable: 7000 },
});
const receipt = (o: PosOrderDto, over: Partial<PosReceiptDto> = {}): PosReceiptDto => ({
  paymentId: o.paymentId, settlementId: o.settlementId!, billId: o.billId, storeName: '시험 카페', orderNos: [o.orderNo], transactionNo: `TX-${o.orderNo}`,
  approvalNo: `AP-${o.orderNo}`, at: o.orderedAt, channel: 'terminal_record', terminal: { approvalNo: 'A1234', receiptNo: null, occurredAt: o.orderedAt },
  amount: 7000, gross: 7000, discount: 0, remaining: 7000, status: 'paid', splits: [{ method: 'card', amount: 7000 }],
  lines: o.lines.map(l => ({ orderLineId: l.orderLineId, menuId: l.menuId, name: l.name, qty: l.qty, options: l.options, request: '', gross: l.gross, discount: l.discount, amount: l.amount })),
  currentPrepared: false, reversalLines: o.lines.map(l => ({ allocationId: l.allocationId, orderLineId: l.orderLineId, menuId: l.menuId, name: l.name, quantity: l.qty, prepared: false })),
  corrections: [], ...over,
});

function hydrate(rows: { orders: PosOrderDto[]; receipts: PosReceiptDto[]; types?: Record<string, 'dine_in' | 'takeout'> }, clearCart = false) {
  const h = setup();
  const base = h.pos.read();
  const nextPos = projectPosState(base.pos, {
    orders: rows.orders, bills: rows.orders.map(o => bill(o, rows.types?.[o.orderId])), receipts: new Map(rows.receipts.map(r => [r.paymentId ?? r.settlementId, r])),
  }, { clearCart });
  const plan: PosPlan = { nextPos, nextUi: base.posUi, result: { ok: true, status: 'applied', posRevision: nextPos.revision, dataRevision: base.dataRevision + 1, value: null } };
  const result = h.actions.commit(plan, base);
  return { h, result, read: h.pos.read() as PosReadSnapshot };
}

describe('F02 server rows → PosState', () => {
  // An operating store starts empty: the café sample day never mixes with the service's records.
  beforeEach(() => { vi.stubEnv('VITE_NAVIS_DATA_SOURCE', 'http'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('replaces the sale rows with the service records and keeps them readable through the existing selectors', () => {
    const o = order(1), { result, read } = hydrate({ orders: [o], receipts: [receipt(o)] });
    expect(result.ok).toBe(true);
    expect(read.pos.orders.map(x => x.orderNo)).toEqual([1]);
    expect(read.pos.payments).toHaveLength(1);
    expect(read.pos.cashReceipts).toEqual([]);
    const view = selectReceipt(read, { paymentId: o.paymentId })!;
    expect(view).toMatchObject({ amount: 7000, gross: 7000, remaining: 7000, status: 'paid', transactionNo: 'TX-1', approvalNo: 'A1234', orderNos: [1] });
    // The slip number the owner copied from the terminal is shown as the approval number; a cash sale keeps the service's own number.
    expect(hydrate({ orders: [o], receipts: [receipt(o, { terminal: null })] }).read.pos.payments[0].approvalNo).toBe('AP-1');
    expect(view.lines[0]).toMatchObject({ name: '아메리카노', qty: 2, amount: 7000 });
    expect(view.lines[0].options.map(option => option.name)).toEqual(['샷 추가']);
    const summary = selectOrderSummary(read, { filter: 'all' });
    expect(summary.counts.all).toBe(1);
    expect(summary.rows[0]).toMatchObject({ orderNo: 1, paymentStatus: 'paid' });
    expect(selectPosDayTotals(read.pos)).toMatchObject({ paymentCount: 1, gross: 7000, revenue: 7000, byMethod: { card: 7000, cash: 0 } });
  });

  it('clears the cart only when asked and never keeps the seeded sales', () => {
    const o = order(1);
    const kept = hydrate({ orders: [o], receipts: [receipt(o)] });
    expect(kept.read.pos.cart.revision).toBe(0);
    const cleared = hydrate({ orders: [o], receipts: [receipt(o)] }, true);
    expect(cleared.read.pos.cart).toMatchObject({ lines: [], revision: 1 });
    expect(hydrate({ orders: [], receipts: [] }).read.pos.orders).toEqual([]);
  });

  it('projects the Connect marker from the order source', () => {
    const orders = [order(1, { source: 'connect' }), order(2, { source: 'naver' }), order(3)];
    const { read } = hydrate({ orders, receipts: orders.map(o => receipt(o)) });

    expect(read.pos.orders.map(o => o.memo)).toEqual(['커넥트', '', '']);
  });

  it('keeps order type, discount and cost from the service', () => {
    const o = order(1, { lines: [line(1, { discount: 500, amount: 6500 })], amount: 6500, remaining: 6500 });
    const r = receipt(o, { amount: 6500, discount: 500 }), { read } = hydrate({ orders: [o], receipts: [r], types: { [o.orderId]: 'dine_in' } });
    expect(read.pos.orders[0].type).toBe('dine_in');
    expect(read.pos.bills[0].discounts).toMatchObject([{ source: 'direct', amount: 500 }]);
    expect(selectPosDayTotals(read.pos)).toMatchObject({ discount: 500, revenue: 6500 });
    expect(read.pos.bills[0].settlementLines[0]).toMatchObject({ basePriceAtSale: 3000, optionPriceAtSale: 500, unitCostAtSale: 800, optionCostAtSale: 300 });
  });

  it('shows a fully canceled sale as canceled with nothing left to return', () => {
    const o = order(1), correction = { correctionId: '00000000-0000-4000-8000-0000000007a0', kind: 'cancel' as const, at: o.orderedAt, seq: 5, amount: 7000, methods: [{ method: 'card' as const, amount: 7000 }], restockRetail: false };
    const r = receipt(o, { status: 'canceled', remaining: 0, reversalLines: [], corrections: [correction] });
    const { read } = hydrate({ orders: [o], receipts: [r] });
    expect(read.pos.orders[0]).toMatchObject({ preparation: 'canceled', lines: [{ canceledQty: 2 }] });
    expect(read.pos.payments[0].status).toBe('canceled');
    expect(selectPaymentRemaining(read.pos, o.paymentId)!.remaining).toBe(0);
    expect(selectReceipt(read, { paymentId: o.paymentId })).toMatchObject({ status: 'canceled', remaining: 0 });
    expect(selectOrderSummary(read, { filter: 'canceled' }).counts.canceled).toBe(1);
  });

  it('keeps a partial refund and its remaining amount', () => {
    const o = order(1, { preparation: 'completed' });
    const refund = { correctionId: '00000000-0000-4000-8000-0000000007b0', kind: 'refund' as const, at: o.orderedAt, seq: 6, amount: 3500, methods: [{ method: 'card' as const, amount: 3500 }], restockRetail: false };
    const r = receipt(o, { status: 'partially_refunded', remaining: 3500, corrections: [refund], currentPrepared: true });
    const { read } = hydrate({ orders: [o], receipts: [r] });
    expect(selectReceipt(read, { paymentId: o.paymentId })).toMatchObject({ status: 'partially_refunded', remaining: 3500 });
    expect(read.pos.refunds).toHaveLength(1);
    expect(selectPosDayTotals(read.pos).refund).toBe(3500);
  });

  it('feeds the ledger and day sales through the money source, once per re-read, and keeps other money rows', () => {
    const o = order(1), rows = { orders: [o], receipts: [receipt(o)] };
    const first = hydrate(rows);
    expect(first.h.data.getSnapshot().tables.dailySales.find(d => d.businessDate === day)).toMatchObject({ gross: 7000, card: 7000, cash: 0 });
    expect(readModel(first.h.data.getSnapshot(), 'ledger').sales).toMatchObject({ net: 7000, byMethod: { card: 7000 } });
    // Re-reading the same day (and a day with a refund) replaces, never adds.
    const again = projectPosState(first.read.pos, { orders: [o], bills: [bill(o)], receipts: new Map([[o.paymentId, receipt(o)]]) });
    expect(again.money!.payments.filter(p => p.paymentId === o.paymentId)).toHaveLength(1);
    expect(again.money!.settlements.filter(s => s.billId === o.billId)).toHaveLength(1);
    expect(again.money).not.toBe(first.read.pos.money);
    const refund = { correctionId: '00000000-0000-4000-8000-0000000007c0', kind: 'refund' as const, at: o.orderedAt, seq: 7, amount: 2000, methods: [{ method: 'card' as const, amount: 2000 }], restockRetail: false };
    const refunded = projectPosState(first.read.pos, { orders: [o], bills: [bill(o)], receipts: new Map([[o.paymentId, receipt(o, { status: 'partially_refunded', remaining: 5000, corrections: [refund] })]]) });
    expect(refunded.money!.corrections).toHaveLength(1);
    expect(refunded.money!.payments).toHaveLength(1);
  });

  it('refuses rows without a receipt instead of inventing a payment method', () => {
    const h = setup();
    expect(() => projectPosState(h.pos.read().pos, { orders: [order(1)], bills: [], receipts: new Map() })).toThrow(/MISSING_RECEIPT/);
  });

  it('keeps open table orders separate and recognizes their shared receivable once without recording a cash deposit', () => {
    const h = setup(), before = h.pos.read().pos;
    const a = order(1, { tableId: 'server-table' }), b = order(2, { billId: a.billId, tableId: 'server-table' });
    const billRow = { ...bill(a, 'dine_in'), orderIds: [a.orderId, b.orderId], quote: { quoteRevision: 2, lines: [...a.lines, ...b.lines], payable: 14000, gross: 14000, discount: 0 } };
    const table = { tableId: 'server-table', layoutTableId: 'T1', label: 'T1', seats: 2, revision: 2, billId: a.billId, openedAt: a.orderedAt };
    const pending = projectPosState(before, {
      orders: [a, b].map(row => ({ ...row, paymentId: null, settlementId: null })),
      bills: [{ ...billRow, status: 'open', recognizedAt: null }], receipts: new Map(), tables: [{ ...table, state: 'occupied' }],
    });
    expect(pending.bills).toMatchObject([{ billId: a.billId, tableId: 'T1', status: 'open' }]);
    expect(pending.tableSessions).toEqual([{ tableId: 'T1', billId: a.billId, cleaning: false }]);
    expect(pending.payments).toHaveLength(0);

    const value = receipt(a, { paymentId: null, memberId: 'member', containsMemberValue: true, memberAllocations: [{ kind: 'receivable', amount: 14000 }],
      amount: 14000, remaining: 14000, realAmount: 0, splits: [], orderNos: [1, 2], terminal: null });
    const paid = projectPosState(pending, {
      orders: [a, b].map(row => ({ ...row, paymentId: null, settlementId: a.settlementId })),
      bills: [billRow], receipts: new Map([[a.settlementId, value]]), tables: [{ ...table, state: 'cleaning', billId: null, lastBillId: a.billId }],
    });
    expect(paid.bills).toMatchObject([{ billId: a.billId, memberId: 'member', status: 'paid' }]);
    expect(paid.money?.settlements).toHaveLength(1);
    expect(paid.money?.payments).toEqual([]);
    expect(paid.money?.recognitions.map(row => [row.settlementCategory, row.amount])).toEqual([['receivable', 7000], ['receivable', 7000]]);
    expect(selectPosDayTotals(paid)).toMatchObject({ revenue: 14000, charged: 0, paymentCount: 0 });
  });
});
