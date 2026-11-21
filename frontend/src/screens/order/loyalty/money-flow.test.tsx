import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { setup } from '../../../pos/loyalty/test-setup';
import { getPaymentBillId, quotePaymentBill } from '../../../pos/loyalty';
import { PosProvider } from '../../../pos/react';
import { renderWithKit } from '../../../ui/test-utils';
import { quoteSettlement } from '../../../data/iteration7/accounting/settlement';
import type { MoneyRead, SettlementQuote } from '../../../data/iteration7/accounting/types';
import { SettlementUiProvider, type SettlementUiPort } from '../settlement/port';
import { LoyaltyCheckout } from './Checkout';

afterEach(cleanup);
it('routes an ordinary POS charge+card checkout through the controlled money coordinator', () => {
  const h = setup(); h.add();
  const billId = getPaymentBillId(h.pos.read());
  expect(h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0001', meta: h.meta() }).ok).toBe(true);
  const money: MoneyRead = {
    runId: h.pos.read().runId, revision: 1, generation: 0, businessDate: '2026-10-26', now: '2026-10-26T15:45', scenario: 'normal', dayClosed: false,
    members: [{ memberId: 'M-0001', name: '김○현', phone: '010-****-7310' }], products: [],
    state: { settlements: [], payments: [], recognitions: [], memberships: [], uses: [], corrections: [], attempt: null, commands: [],
      accountTxns: [{ txnId: 'opening', memberId: 'M-0001', account: 'charge', kind: 'opening', amount: 40000, at: '2026-10-26T09:00', settlementId: null, allocationId: null, originalTxnId: null, sourceRef: null, reason: '' }] },
    sources: [{ sourceRef: { kind: 'bill', id: billId }, purpose: 'sale', billId, memberId: 'M-0001', amountDue: 4500, fingerprint: 'source-1', orderIds: [],
      lines: [{ allocationId: 'line-1', orderLineId: 'order-line-1', menuId: 'm-americano', quantity: 1, unitPrice: 4500, unitCost: 1500 }] }],
  };
  const approved: SettlementQuote[] = [];
  const ready = { billId, phase: { status: 'ready' as const } };
  const port: SettlementUiPort = {
    read: () => ready, subscribe: () => () => undefined,
    member: () => ({ memberId: 'M-0001', label: '김○현', chargeBalance: 40000, receivableBalance: 0 }),
    quoteSale: input => quoteSettlement(money, { target: { purpose: 'sale', billId: input.billId, partId: input.partId }, allocations: input.allocations }),
    approve: quote => { approved.push(quote); return true; }, reset: () => undefined,
    quotePartialCancellation: () => { throw new Error('No partial payment'); }, cancelPartial: () => false,
  };
  renderWithKit(<SettlementUiProvider value={port}><PosProvider value={h.pos}><LoyaltyCheckout open billId={billId} summary="아메리카노 ICE 1" returnFocusRef={{ current: null }} onClose={() => undefined} onComplete={() => undefined}/></PosProvider></SettlementUiProvider>, { reducedMotion: true });
  fireEvent.change(screen.getByRole('spinbutton', { name: '충전금 사용' }), { target: { value: '3000' } });
  fireEvent.click(screen.getByRole('button', { name: '카드' }));
  fireEvent.click(screen.getByRole('button', { name: '카드' }));
  expect(approved).toHaveLength(1);
  expect(approved[0].allocations).toEqual([{ kind: 'method', method: 'card', amount: 1500 }, { kind: 'charge', amount: 3000, allocationId: undefined }]);
  expect(h.pos.read().posUi.approval).toBeNull();
  expect(quotePaymentBill(h.pos.read(), billId).received).toBe(0);
});

it('previews account-only split cancellation and delegates it once without using the legacy payment list', () => {
  const h = setup(); h.add();
  const billId = getPaymentBillId(h.pos.read()), approved: string[][] = [];
  const ready = { billId, phase: { status: 'ready' as const } };
  const partial = { quoteId: 'abandon-1', quoteRevision: 1, settlementIds: ['share-1'], kind: 'cancel' as const, amount: 4500, remainingRefundable: 4500,
    realMethodReturns: [], accountEffects: [{ account: 'charge' as const, amount: 4500 }], membershipEffects: [], recognitionEffects: [], canSubmit: true, issues: [] };
  const port: SettlementUiPort = {
    read: () => ready, subscribe: () => () => undefined, member: () => null,
    quoteSale: () => { throw new Error('No sale quote belongs to partial cancellation'); },
    approve: () => { throw new Error('No payment approval belongs to partial cancellation'); }, reset: () => undefined,
    quotePartialCancellation: () => partial,
    cancelPartial: quote => { approved.push([...quote.settlementIds]); return true; },
  };
  renderWithKit(<SettlementUiProvider value={port}><PosProvider value={h.pos}><LoyaltyCheckout startCancel open billId={billId} summary="아메리카노 ICE 1" returnFocusRef={{ current: null }} onClose={() => undefined} onComplete={() => undefined}/></PosProvider></SettlementUiProvider>, { reducedMotion: true });
  expect(screen.getByText('충전금 잔액 4,500원이 돌아가요')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '취소 확정하기' }));
  fireEvent.click(screen.getByRole('button', { name: '취소 확정하기' }));
  expect(approved).toEqual([['share-1']]);
});
