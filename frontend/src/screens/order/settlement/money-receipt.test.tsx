import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { setup } from '../../../pos/loyalty/test-setup';
import { PosProvider } from '../../../pos/react';
import { renderWithKit } from '../../../ui/test-utils';
import { selectMoneyReceipt } from '../../../data/iteration7/accounting/selectors';
import { quoteMoneyReversal } from '../../../data/iteration7/accounting/reversals';
import type { MoneyRead, MoneyReversalQuote } from '../../../data/iteration7/accounting/types';
import { ReversalReceipt } from '../ReversalReceipt';

afterEach(cleanup);
it('opens an account-only settlement receipt without a payment or approval number and reverses by settlementId', () => {
  const h = setup();
  const money: MoneyRead = {
    runId: h.pos.read().runId, revision: 1, generation: 0, businessDate: '2026-10-26', now: '2026-10-26T15:45', scenario: 'normal', dayClosed: false,
    members: [{ memberId: 'M-0001', name: '김○현', phone: '010-****-7310' }], products: [], sources: [],
    state: { payments: [], recognitions: [], memberships: [], uses: [], corrections: [], attempt: null, commands: [],
      settlements: [{ settlementId: 'settlement-1', sourceRef: { kind: 'bill', id: 'bill-1' }, purpose: 'sale', billId: 'bill-1', partId: null, memberId: 'M-0001', at: '2026-10-26T15:45', amount: 4500, status: 'paid', allocations: [{ allocationId: 'a-1', kind: 'charge', amount: 4500 }] }],
      accountTxns: [{ txnId: 'use-1', memberId: 'M-0001', account: 'charge', kind: 'use', amount: -4500, at: '2026-10-26T15:45', settlementId: 'settlement-1', allocationId: 'a-1', originalTxnId: null, sourceRef: { kind: 'bill', id: 'bill-1' }, reason: '' }] },
  };
  const confirmed: MoneyReversalQuote[] = [];
  renderWithKit(<PosProvider value={h.pos}><ReversalReceipt settlementId="settlement-1" initialView="receipt" onClose={() => undefined} money={{ receipt: selectMoneyReceipt(money, { settlementId: 'settlement-1' }), phase: { status: 'ready' }, quoteReversal: input => quoteMoneyReversal(money, input), onConfirm: quote => { confirmed.push(quote); return true; }, onReset: () => undefined }}/></PosProvider>, { reducedMotion: true });
  expect(screen.getByText('정산 거래번호')).toBeInTheDocument();
  expect(screen.getByText('충전금 사용')).toBeInTheDocument();
  expect(screen.getByText('실제 입금')).toBeInTheDocument();
  expect(screen.queryByText('승인번호')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '결제 취소하기' }));
  expect(screen.getByText('충전금 잔액 4,500원이 돌아가요')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '취소 확정하기' }));
  fireEvent.click(screen.getByRole('button', { name: '취소 확정하기' }));
  expect(confirmed).toHaveLength(1);
  expect(confirmed[0].settlementId).toBe('settlement-1');
  expect(confirmed[0].realMethodReturns).toEqual([]);
});

it('K-E 10: writes the order number (never a settlement id) and says how much of the 외상 is collected', () => {
  const h = setup();
  const base = { runId: h.pos.read().runId, revision: 1, generation: 0, businessDate: '2026-10-26', now: '2026-10-26T15:45', scenario: 'normal' as const, dayClosed: false, members: [], products: [], sources: [] };
  const settlement = (settlementId: string, billId: string | null) => ({ settlementId, sourceRef: { kind: 'bill', id: billId ?? 'none' }, purpose: 'sale', billId, partId: null, memberId: null, at: '2026-10-26T15:45', amount: 4500, status: 'paid', allocations: [] });
  const state = (settlementId: string, billId: string | null) => ({ payments: [], recognitions: [], memberships: [], uses: [], corrections: [], attempt: null, commands: [], settlements: [settlement(settlementId, billId)], accountTxns: [] });
  const show = (settlementId: string, billId: string | null) => {
    const money = { ...base, state: state(settlementId, billId) } as unknown as MoneyRead;
    renderWithKit(<PosProvider value={h.pos}><ReversalReceipt settlementId={settlementId} initialView="receipt" onClose={() => undefined} money={{ receipt: selectMoneyReceipt(money, { settlementId }), phase: { status: 'ready' }, quoteReversal: () => null as unknown as MoneyReversalQuote, onReset: () => undefined, onReverse: () => undefined } as never} /></PosProvider>);
  };
  show('seed:B-029', 'B-029');
  expect(screen.getByText('정산 거래번호').nextElementSibling).toHaveTextContent('B-029');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('seed:');
  cleanup();
  show('settlement:run-1:funding:abc', null);
  expect(screen.queryByText('정산 거래번호')).not.toBeInTheDocument();
  expect(screen.getByRole('dialog')).not.toHaveTextContent(/settlement:|funding:/);
});
