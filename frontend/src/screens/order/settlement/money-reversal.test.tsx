import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { useRef, useState } from 'react';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { SharedPosReversalDialog } from './SharedPosReversalDialog';

afterEach(cleanup);
describe('M3 original-source reversal presentation', () => {
  it.each([
    ['TOPUP_ALREADY_USED', '이미 사용한 충전금이라 전체 취소할 수 없어요'],
    ['RECEIVABLE_ALREADY_COLLECTED', '이미 수금한 외상이 있어요 · 수금 취소·환불을 먼저 해 주세요'],
  ])('blocks %s with its approved Korean reason', (reason, explanation) => {
    const quote = { quoteId: 'q', quoteRevision: 1, kind: 'cancel' as const, amount: 4500, remainingRefundable: 4500,
      realMethodReturns: [], accountEffects: [], membershipEffects: [], recognitionEffects: [], canSubmit: false, issues: [{ reason }] };
    renderWithKit(<SharedPosReversalDialog mode="money" open quote={quote} phase={{ status: 'ready' }} returnFocusRef={{ current: null }} onConfirm={() => { throw new Error('Blocked quote submitted'); }} onClose={() => undefined}/>);
    expect(screen.getByRole('alert')).toHaveTextContent(explanation);
    expect(screen.getByRole('button', { name: '취소 확정하기' })).toBeDisabled();
  });

  it('shows the real return and each original account/use effect before one confirmation', () => {
    function Harness() {
      const focus = useRef<HTMLButtonElement>(null), [pending, setPending] = useState(false), [count, setCount] = useState(0);
      const quote = { quoteId: 'q', quoteRevision: 1, kind: 'refund' as const, amount: 4500, remainingRefundable: 4500,
        realMethodReturns: [{ method: 'card' as const, amount: 1500 }],
        accountEffects: [{ account: 'charge' as const, amount: 3000 }, { account: 'receivable' as const, amount: -1000 }],
        membershipEffects: [{ useId: 'use-1', canceledAt: '2026-10-26T15:45' }], recognitionEffects: [{ recognitionId: 'sale-1', amount: -4500 }], canSubmit: true, issues: [] };
      return <><output aria-label="confirmations">{count}</output><SharedPosReversalDialog mode="money" open quote={quote} phase={{ status: pending ? 'pending' : 'ready' }} returnFocusRef={focus}
        onClose={() => undefined} onConfirm={() => { setPending(true); setCount(n => n + 1); return true; }}/></>;
    }
    renderWithKit(<Harness/>, { reducedMotion: true });
    expect(screen.getByText('충전금 잔액 3,000원이 돌아가요')).toBeInTheDocument();
    expect(screen.getByText('미수금 1,000원이 줄어들어요')).toBeInTheDocument();
    expect(screen.getByText('회원권 1회가 돌아가요')).toBeInTheDocument();
    expect(screen.getByText('카드')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '환불 확정하기' }));
    fireEvent.click(screen.getByRole('button', { name: '처리 중이에요' }));
    expect(screen.getByLabelText('confirmations')).toHaveTextContent('1');
  });
});
