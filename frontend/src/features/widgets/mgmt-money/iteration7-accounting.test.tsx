import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { AccountingPresentationProvider, LedgerDetail, type AccountingView } from './ledger';
import { MarginDetail } from './margin';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { TaxDetail } from './tax';
import type { WidgetHost } from '../../../contracts';
import { renderWithKit } from '../../../ui/test-utils';
import { CustomOrderProvider, type CustomOrderPort } from '../i7-custom/port';
import { createLegacyCustomOrderSeed } from '../../../data/iteration7/custom-orders/seed';
import { planCustomOrderCommand, type CustomOrderRead, type CustomPlanResult } from '../../../data/iteration7/custom-orders';
import { CustomSalesBreakdown } from '../i7-custom/accounting';

afterEach(cleanup);
/**
 * The 10/26 CO-001 fixture of this PRD 12.6 case (a 45,000원 cake that is ready, paid in advance): the cafe's own
 * custom orders are still at the quote stage, and this case needs one that can be handed over.
 */
function createCustomTestSource() {
  const seed = createLegacyCustomOrderSeed();
  let read: CustomOrderRead = { revision: 0, tables: { ...seed.tables, member: [{ memberId: 'M-0001' }] }, money: seed.money, businessDate: '2026-10-26', now: '2026-10-26T15:45:00' };
  const listeners = new Set<() => void>();
  const apply = (plan: CustomPlanResult) => {
    if (plan.ok && plan.changed) {
      read = { ...read, revision: read.revision + 1, tables: plan.tables, money: {
        settlements: [...read.money.settlements, ...plan.moneyEffects.settlements],
        payments: [...read.money.payments, ...plan.moneyEffects.payments],
        recognitions: [...read.money.recognitions, ...plan.moneyEffects.recognitions],
        corrections: [...read.money.corrections, ...plan.moneyEffects.corrections],
      } };
      listeners.forEach(listener => listener());
    }
    return plan;
  };
  const port: CustomOrderPort = {
    read: () => read, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch: command => apply(planCustomOrderCommand(read, command)),
    openSettlement: () => { throw new Error('The component test must inject its app-host boundary'); },
    openReversal: () => { throw new Error('The component test must inject its app-host boundary'); },
    members: [{ memberId: 'M-0001', label: '김○현' }],
  };
  return { port, apply };
}
describe('received custom sale display', () => {
  it('shows received sales once and unknown cost without presenting the advance as sales', () => {
    const { port } = createCustomTestSource();
    renderWithKit(<CustomOrderProvider port={port}><CustomSalesBreakdown period={{ start: '2026-10-26', end: '2026-10-26' }} /></CustomOrderProvider>);
    expect(screen.queryByRole('region', { name: '주문제작 수령 매출' })).not.toBeInTheDocument();
    act(() => { port.dispatch({ type: 'customOrder.receive', customOrderId: 'CO-001', idempotencyKey: 'handover' }); });
    const block = screen.getByRole('region', { name: '주문제작 수령 매출' });
    expect(within(block).getByText('원가 미등록')).toBeInTheDocument();
    expect(within(block).getByText('45,000원')).toBeInTheDocument();
    expect(within(block).getByText('레터링 생크림 케이크 1호')).toBeInTheDocument();
    act(() => { port.dispatch({ type: 'customOrder.receive', customOrderId: 'CO-001', idempotencyKey: 'second-handover' }); });
    expect(within(block).getAllByRole('row')).toHaveLength(2);
  });
  it('does not add the current handover to a previous reporting period', () => {
    const { port } = createCustomTestSource();
    port.dispatch({ type: 'customOrder.receive', customOrderId: 'CO-001', idempotencyKey: 'handover' });
    renderWithKit(<CustomOrderProvider port={port}><CustomSalesBreakdown period={{ start: '2026-10-19', end: '2026-10-25' }} /></CustomOrderProvider>);
    expect(screen.queryByText('45,000원')).not.toBeInTheDocument();
  });
});

// PRD 12.6 input, independent of the presentation implementation (only its day follows the business date).
const m3 = {
  status: 'ready' as const,
  period: { start: TODAY, end: TODAY },
  summary: {
    sales: {
      total: 1284000, byRealMethodSale: { card: 864336, easy_pay: 298000, cash: 74000 },
      chargeUsed: 15000, receivableCreated: 10000, membershipCount: 8000, subscriptionDaily: 14664,
      membershipExpiry: 0, customPickup: 0, refund: 10000, gross: 1315000, discount: 35664,
      discountBySource: { membership: 15500, coupon: 2500, direct: 17664 },
    },
    deposits: {
      total: 1386336, byMethod: { card: 959336, easy_pay: 338000, cash: 89000 },
      byPurpose: { sale: 1236336, charge_topup: 50000, receivable_collection: 15000, membership_sale: 40000, custom_order: 45000 },
      grossReceived: 1396336, returned: 10000, pendingReceived: 0,
    },
    orderCount: 94, realPaymentCount: 90,
  },
  transactions: [
    { id: 'funding-1', at: `${TODAY}T10:15:00`, purpose: 'charge_topup' as const, kind: 'receipt' as const, amount: 50000, salesAmount: 0, methods: [{ method: 'card' as const, amount: 50000 }], settlementKinds: [], settlementId: 'settlement-1', paymentId: 'payment-1' },
    { id: 'refund-1', at: `${TODAY}T14:00:00`, purpose: 'sale' as const, kind: 'refund' as const, amount: -10000, salesAmount: -10000, methods: [{ method: 'card' as const, amount: -10000 }], settlementKinds: [], settlementId: 'original-1', paymentId: 'original-payment-1', originalId: 'original-1' },
  ],
  unknownCostSales: [],
};
const fixture: AccountingView = m3;
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };

describe('M3 financial presentation', () => {
  it.each(['ko', 'en', 'zh-Hans'] as const)('separates actual receipts from recognized sales and settlement kinds in %s', locale => {
    renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} {...{ accounting: m3 }} />, { locale });
    const sales = screen.getByRole('region', { name: '오늘 매출' });
    expect(within(sales).getByText((_,node) => node?.textContent === '1,284,000원', {selector:'.ui-pos-money--display'})).toBeInTheDocument();
    const methods = within(sales).getByRole('table', { name: '판매분 결제 수단' });
    expect(within(methods).getByText('864,336원')).toBeInTheDocument();
    expect(within(methods).queryByText('충전금 사용액')).not.toBeInTheDocument();
    const settlements = within(sales).getByRole('table', { name: '정산 유형별 매출' });
    expect(within(settlements).getByText('15,000원')).toBeInTheDocument();
    expect(within(settlements).getByText('14,664원')).toBeInTheDocument();
    const deposits = screen.getByRole('region', { name: '실제 입금' });
    expect(within(deposits).getByText((_,node) => node?.textContent === '1,386,336원', {selector:'.ui-pos-money--display'})).toBeInTheDocument();
    expect(within(deposits).getByText('959,336원')).toBeInTheDocument();
    expect(within(deposits).getByText('89,000원')).toBeInTheDocument();
    expect(within(deposits).queryByText('충전금 사용액')).not.toBeInTheDocument();
    expect(within(deposits).getByText('충전금 충전액')).toBeInTheDocument();
  });
  it('takes authoritative totals including corrections without recomputing or subtracting refunds twice', () => {
    const accounting = { ...m3, summary: { ...m3.summary, sales: { ...m3.summary.sales, total: 1274000, byRealMethodSale: { ...m3.summary.sales.byRealMethodSale, card: 854336 }, refund: 20000 }, deposits: { ...m3.summary.deposits, total: 1376336, byMethod: { ...m3.summary.deposits.byMethod, card: 949336 }, byPurpose: { ...m3.summary.deposits.byPurpose, sale: 1226336 }, returned: 20000 } } };
    renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} {...{ accounting }} />);
    expect(within(screen.getByRole('region', { name: '오늘 매출' })).getByText((_,node) => node?.textContent === '1,274,000원', {selector:'.ui-pos-money--display'})).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '실제 입금' })).getByText((_,node) => node?.textContent === '1,376,336원', {selector:'.ui-pos-money--display'})).toBeInTheDocument();
  });
  it('shows non-sale receipts, signed refunds and opens the original receipt', async () => {
    const onOpenAccountingReceipt = vi.fn();
    renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} {...{ accounting: m3, onOpenAccountingReceipt }} />);
    const grid = screen.getByRole('grid', { name: '결제 · 입금 내역' });
    expect(within(grid).getByText('충전금 충전액')).toBeInTheDocument();
    const refund = grid.querySelector('[data-grid-row-id="refund-1"]')!.closest('tr')!;
    expect(refund).toHaveTextContent('−10,000원');
    await userEvent.click(within(refund).getByRole('button', { name: '영수증 보기' }));
    expect(onOpenAccountingReceipt).toHaveBeenCalledWith(m3.transactions[1]);
  });
  it('shows tax amounts without an example chip (D-329) and uses the supplied reporting period', () => {
    const accounting = { ...m3, period: { start: `${TODAY.slice(0, 8)}01`, end: TODAY } };
    renderWithKit(<TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={host} {...{ accounting }} />);
    const split = screen.getByRole('region', { name: '매출 · 실제 입금' });
    expect(within(split).queryByText('예시')).toBeNull();
    expect(within(split).getByText((_,node) => node?.textContent === '1,284,000원', {selector:'.ui-pos-money--display'})).toBeInTheDocument();
    expect(within(split).getByText((_,node) => node?.textContent === '1,386,336원', {selector:'.ui-pos-money--display'})).toBeInTheDocument();
  });
  it.each(['loading', 'empty', 'error', 'unavailable'] as const)('does not retain previous figures when accounting is %s', status => {
    const accounting = { period: m3.period, status };
    renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} {...{ accounting }} />);
    const block = screen.getByRole('region', { name: '매출 · 실제 입금' });
    expect(block).not.toHaveTextContent('1,284,000');
    expect(block).not.toHaveTextContent('1,386,336');
  });
});

it('M3 receipt filters show only the selected real-method share of a mixed receipt', async () => {
  const accounting = { ...m3, transactions: [{ ...m3.transactions[0]!, id: 'mixed', purpose: 'sale' as const, amount: 4500, salesAmount: 4500, methods: [{ method: 'card' as const, amount: 1500 }, { method: 'cash' as const, amount: 3000 }] }] };
  renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} accounting={accounting} />);
  await userEvent.click(screen.getByRole('radio', { name: '카드' }));
  const grid = screen.getByRole('grid', { name: '결제 · 입금 내역' });
  expect(grid.querySelector('[data-grid-column-id="amount"][data-grid-row-id="mixed"]')).toHaveTextContent('1,500원');
});

it('C-07 shows a public transaction number and hides internal keys in the ledger', () => {
  const original = m3.transactions[0]!;
  const accounting = { ...m3, transactions: [
    { ...original, id: 'legacy:dc24bb57-f465-5be0-bb22-20f6acb759ef' },
    { ...original, id: 'b', transactionNo: 'legacy:dc24bb57-f465-5be0-bb22-20f6acb759ef' },
    { ...original, id: 'c', transactionNo: 'TX-0007' },
  ] };
  renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} accounting={accounting} />);
  const grid = screen.getByRole('grid', { name: '결제 · 입금 내역' });
  expect(within(grid).getAllByRole('gridcell', { name: /거래번호, —$/ })).toHaveLength(2);
  expect(within(grid).getByRole('gridcell', { name: /거래번호, TX-0007$/ })).toBeVisible();
});

it('M3 provider publishes the five PRD12.6 cumulative deltas without widget-owned arithmetic', () => {
  const renderLedger = (view: AccountingView) => <AccountingPresentationProvider value={{ views: [view] }}><LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} /></AccountingPresentationProvider>;
  const { rerender } = renderWithKit(renderLedger(fixture));
  const cases = [
    { sales: 1284000, deposits: 1436336, card: 1009336, cash: 89000, chargeTopup: 100000, chargeUsed: 15000, receivableCreated: 10000, collected: 15000, custom: 0 },
    { sales: 1288500, deposits: 1436336, card: 1009336, cash: 89000, chargeTopup: 100000, chargeUsed: 19500, receivableCreated: 10000, collected: 15000, custom: 0 },
    { sales: 1293500, deposits: 1436336, card: 1009336, cash: 89000, chargeTopup: 100000, chargeUsed: 19500, receivableCreated: 15000, collected: 15000, custom: 0 },
    { sales: 1293500, deposits: 1446336, card: 1009336, cash: 99000, chargeTopup: 100000, chargeUsed: 19500, receivableCreated: 15000, collected: 25000, custom: 0 },
    { sales: 1338500, deposits: 1446336, card: 1009336, cash: 99000, chargeTopup: 100000, chargeUsed: 19500, receivableCreated: 15000, collected: 25000, custom: 45000 },
  ];
  for (const next of cases) {
    rerender(renderLedger({ ...m3, summary: { ...m3.summary, sales: { ...m3.summary.sales, total: next.sales, chargeUsed: next.chargeUsed, receivableCreated: next.receivableCreated, customPickup: next.custom }, deposits: { ...m3.summary.deposits, total: next.deposits, byMethod: { ...m3.summary.deposits.byMethod, card: next.card, cash: next.cash }, byPurpose: { ...m3.summary.deposits.byPurpose, charge_topup: next.chargeTopup, receivable_collection: next.collected } } } }));
    const sales = within(screen.getByRole('region', { name: '오늘 매출' }));
    const deposits = within(screen.getByRole('region', { name: '실제 입금' }));
    expect(sales.getByText((_,node) => node?.textContent === `${next.sales.toLocaleString('ko-KR')}원`, {selector:'.ui-pos-money--display'})).toBeInTheDocument();
    expect(deposits.getByText((_,node) => node?.textContent === `${next.deposits.toLocaleString('ko-KR')}원`, {selector:'.ui-pos-money--display'})).toBeInTheDocument();
  }
});
it('M3 period navigation cannot reuse today receipts for an earlier ledger period', async () => {
  renderWithKit(<AccountingPresentationProvider value={{ views: [fixture] }}><LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} /></AccountingPresentationProvider>);
  await userEvent.click(screen.getByRole('radio', { name: '최근 7일' }));
  const region = screen.getByRole('region', { name: '매출 · 실제 입금' });
  expect(within(region).getByText('이 날짜의 실제 입금 자료가 없어요')).toBeInTheDocument();
  expect(region).not.toHaveTextContent('1,386,336');
});
it('M3 custom handover cost stays unknown and does not mutate menu quantities, inventory or margin', () => {
  const store = createWidgetDataStore();
  const before = store.getSnapshot();
  const accounting = { ...m3, unknownCostSales: [{ recognitionId: 'custom-received', sourceId: 'CO-001', amount: 45000, cost: null, label: '레터링 생크림 케이크 1호' }] };
  renderWithKit(<MarginDetail featureId="margin" condition={{ kind: 'default' }} detailRef={{ featureId: 'margin' }} host={host} accounting={accounting} />, { store });
  const custom = screen.getByRole('region', { name: '주문제작 수령 매출' });
  expect(within(custom).getByText('45,000원')).toBeInTheDocument();
  expect(within(custom).getAllByText('원가 미등록')).toHaveLength(2);
  expect(store.getSnapshot()).toBe(before);
});
it('M3 error retry stays Korean on an English screen', async () => {
  const retry = vi.fn();
  renderWithKit(<AccountingPresentationProvider value={{ views: [{ period: m3.period, status: 'error' }], onRetry: retry }}><LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} /></AccountingPresentationProvider>, { locale: 'en' });
  await userEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
  expect(retry).toHaveBeenCalledTimes(1);
});
