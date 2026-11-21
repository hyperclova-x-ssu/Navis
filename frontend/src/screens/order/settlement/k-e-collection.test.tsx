import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { useRef } from 'react';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { SharedPosPaymentDialog } from './SharedPosPaymentDialog';
import type { SettlementTarget } from '../../../data/iteration7/accounting';

/** K-E 10: the 외상 수금 dialog says how much of the 외상 is being collected, never the internal transaction id. */
afterEach(cleanup);
const target: SettlementTarget = { purpose: 'receivable_collection', memberId: 'M-0005', amount: 5000 } as SettlementTarget;

function Harness({ sources, balance }: { sources: readonly { txnId: string; amount: number }[]; balance: number }) {
  const focus = useRef<HTMLButtonElement>(null);
  const quote = { quoteId: 'q', quoteRevision: 1, amountDue: 5000, allocations: [], remaining: 5000, canSubmit: false, issues: [], collectionSources: sources };
  return <SharedPosPaymentDialog mode="money" open target={target} summary="외상 수금" quote={quote} phase={{ status: 'ready' }}
    member={{ memberId: 'M-0005', label: '가○손님0005', chargeBalance: 0, receivableBalance: balance }}
    returnFocusRef={focus} onAllocationsChange={() => quote} onApprove={() => true} onReset={() => undefined} onClose={() => undefined} />;
}

it('writes "외상 10,000원 중 5,000원" for a partial collection and no transaction id', () => {
  renderWithKit(<Harness sources={[{ txnId: 'seed-debt', amount: 5000 }]} balance={10000} />, { reducedMotion: true });
  const section = screen.getByRole('region', { name: '수금할 외상 내역' });
  expect(section).toHaveTextContent('외상 10,000원 중 5,000원');
  expect(section).not.toHaveTextContent('seed-debt');
});

it('writes one line with the summed amount when several debts are collected, and plain "외상 N원" when everything is collected', () => {
  renderWithKit(<Harness sources={[{ txnId: 'seed-debt', amount: 2000 }, { txnId: 'sample-opening:receivable:M-0005', amount: 3000 }]} balance={12000} />, { reducedMotion: true });
  expect(screen.getByRole('region', { name: '수금할 외상 내역' })).toHaveTextContent('외상 12,000원 중 5,000원');
  cleanup();
  renderWithKit(<Harness sources={[{ txnId: 'seed-debt', amount: 5000 }]} balance={5000} />, { reducedMotion: true });
  const full = screen.getByRole('region', { name: '수금할 외상 내역' });
  expect(full).toHaveTextContent('외상 5,000원');
  expect(full).not.toHaveTextContent('중');
});
