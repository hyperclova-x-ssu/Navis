// Public review A-2: "주문 확인해줘" / "최근 결제된 거 있어?" answered "진행 중 0건" while the order status screen listed NAVER orders in progress. The
// NAVER orders come from the same service read the screen uses; the answer states how many are open, and which.
import { describe, expect, it } from 'vitest';
import { lastPaidDayFact, naverOrderFacts, npayApprovalFacts } from './naver-orders';

const order = (orderNumber: string, status: 'received' | 'preparing' | 'picked-up', preparationMinutes: number | null = null) => ({
  orderNumber, status, preparationMinutes, revision: 1, preparingAt: null, pickedUpAt: null, actions: { prepare: false, pickup: false },
});

describe('NAVER orders as facts of an order answer', () => {
  it('counts the orders not yet picked up and names each one with its state', () => {
    const facts = naverOrderFacts([order('order-01', 'received'), order('N-2026-0042', 'preparing', 12), order('order-03', 'picked-up')], '2026-11-17');
    expect(facts[0]).toMatchObject({ key: 'orders.naver.open.count', value: 2, display: '2건', unit: 'order', date: '2026-11-17' });
    expect(facts[0].label).toBe('네이버 주문 진행 중');
    expect(facts.slice(1).map(fact => `${fact.label} · ${fact.display}`)).toEqual(['네이버 주문 1 · 접수', '네이버 주문 N-2026-0042 · 준비 중 12분']);
    expect(facts.every(fact => fact.key.startsWith('orders.naver.'))).toBe(true);
  });
  it('says zero when every order was picked up, and nothing when there are no NAVER orders at all', () => {
    expect(naverOrderFacts([order('order-01', 'picked-up')], '2026-11-17').map(fact => fact.display)).toEqual(['0건']);
    expect(naverOrderFacts([], '2026-11-17')).toEqual([]);
    expect(naverOrderFacts(undefined, '2026-11-17')).toEqual([]);
  });
  it('caps the listed orders at three', () => {
    const rows = Array.from({ length: 6 }, (_, index) => order(`order-0${index}`, 'received'));
    const facts = naverOrderFacts(rows, '2026-11-17');
    expect(facts[0].value).toBe(6);
    expect(facts).toHaveLength(4);
  });
});

describe('the latest day with sales when today has none', () => {
  const days = { '2026-11-20': { sales: { total: 0 } }, '2026-11-19': { sales: { total: 482000 } }, '2026-11-18': { sales: { total: 120000 } } };
  it('names that day with its weekday and sales, so a quiet day still gets a real answer', () => {
    expect(lastPaidDayFact(days as never, '2026-11-22')).toMatchObject({ key: 'orders.lastPaid.day', label: '가장 최근 결제가 있었던 날', value: 482000, date: '2026-11-19' });
    expect(lastPaidDayFact(days as never, '2026-11-22')?.display).toBe('11월 19일(목) · 매출 482,000원');
  });
  it('gives nothing when no earlier day had sales', () => {
    expect(lastPaidDayFact({ '2026-11-20': { sales: { total: 0 } } } as never, '2026-11-22')).toBeUndefined();
    expect(lastPaidDayFact(undefined, '2026-11-22')).toBeUndefined();
  });
});

describe('Npay approvals as facts of a payment answer', () => {
  const line = (kind: 'approval' | 'cancellation', payDate: string, paySettleAmount: number) => ({ kind, payDate, paySettleAmount });
  it('names each approval with its date and amount, and what was canceled of it', () => {
    const facts = npayApprovalFacts([
      { page: {}, items: [line('approval', '20261115', 4500), line('cancellation', '20261116', -500)] },
      { page: {}, items: [line('approval', '20261117', 3000)] },
    ] as never);
    expect(facts.map(fact => `${fact.key} · ${fact.label} · ${fact.display} · ${fact.date}`)).toEqual([
      'payments.npay.row · 네이버페이 승인 · 11월 15일(일) · 네이버페이 · 4,500원 · 승인 · 취소 500원 · 2026-11-15',
      'payments.npay.row · 네이버페이 승인 · 11월 17일(화) · 네이버페이 · 3,000원 · 승인 · 2026-11-17',
    ]);
    expect(facts.map(fact => fact.value)).toEqual([4500, 3000]);
  });
  it('leaves out a payment that has no approval line, and says nothing without payments', () => {
    expect(npayApprovalFacts([{ page: {}, items: [line('cancellation', '20261116', -500)] }] as never)).toEqual([]);
    expect(npayApprovalFacts([])).toEqual([]);
  });
});
