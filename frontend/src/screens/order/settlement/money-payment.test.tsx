import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { useRef, useState } from 'react';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { SharedPosPaymentDialog } from './SharedPosPaymentDialog';
import type { SettlementAllocation, SettlementTarget } from '../../../data/iteration7/accounting';

afterEach(cleanup);
const sale: SettlementTarget = { purpose: 'sale', billId: 'bill-1' };

function Harness({ target = sale, memberId = 'M-0001', balance = 40000, amount = 4500, initial = [] }: {
  target?: SettlementTarget; memberId?: string | null; balance?: number; amount?: number; initial?: readonly SettlementAllocation[];
}) {
  const focus = useRef<HTMLButtonElement>(null);
  const [allocations, setAllocations] = useState(initial), [submitted, setSubmitted] = useState<readonly SettlementAllocation[][]>([]);
  const [phase, setPhase] = useState<'ready' | 'pending' | 'succeeded'>('ready');
  const quote = (rows: readonly SettlementAllocation[]) => {
    const remaining = amount - rows.reduce((sum, row) => sum + row.amount, 0);
    const exceeds = rows.some(row => row.kind === 'charge' && row.amount > balance);
    return { quoteId: 'q', quoteRevision: 1, amountDue: amount, allocations: rows, remaining,
      canSubmit: remaining === 0 && !exceeds, issues: exceeds ? [{ reason: 'CHARGE_BALANCE_EXCEEDED', details: { available: balance } }] : [],
    };
  };
  return <><output aria-label="submitted allocations">{JSON.stringify(submitted)}</output>
    <SharedPosPaymentDialog mode="money" open target={target} summary="아메리카노 ICE 1" quote={quote(allocations)} phase={{ status: phase }}
      member={memberId ? { memberId, label: '김○현', chargeBalance: balance, receivableBalance: 10000 } : null}
      tools={<button onClick={() => setPhase('succeeded')}>Complete approval</button>}
      returnFocusRef={focus} onAllocationsChange={rows => { setAllocations(rows); return quote(rows); }}
      onApprove={current => { setSubmitted(rows => [...rows, [...current.allocations]]); setPhase('pending'); return true; }}
      onReset={() => setPhase('ready')} onClose={() => undefined}/>
  </>;
}

describe('M3 controlled settlement allocations', () => {
  it('fills the card remainder after charge and another real method without losing account rows', () => {
    renderWithKit(<Harness/>, { reducedMotion: true });
    fireEvent.change(screen.getByRole('spinbutton', { name: '충전금 사용' }), { target: { value: '3000' } });
    fireEvent.click(screen.getByRole('button', { name: '여러 수단으로 내기' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '현금' }), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: '카드 남은 금액 넣기' }));
    expect(screen.getByRole('spinbutton', { name: '카드' })).toHaveValue(1000);
    expect(screen.getByRole('spinbutton', { name: '충전금 사용' })).toHaveValue(3000);
    fireEvent.click(screen.getByRole('button', { name: '결제하기' }));
    expect(screen.getByLabelText('submitted allocations')).toHaveTextContent('[[{"kind":"charge","amount":3000},{"kind":"method","method":"cash","amount":500},{"kind":"method","method":"card","amount":1000}]]');
    expect(screen.getByRole('button', { name: '카드 남은 금액 넣기' })).toBeDisabled();
  });
  it('pays only the real remainder after charge allocation, exactly once', () => {
    renderWithKit(<Harness/>, { reducedMotion: true });
    const methods = within(screen.getByRole('group', { name: '실제 결제 수단' }));
    expect(methods.getAllByRole('button')).toHaveLength(3);
    fireEvent.change(screen.getByRole('spinbutton', { name: '충전금 사용' }), { target: { value: '3000' } });
    fireEvent.click(methods.getByRole('button', { name: '카드' }));
    fireEvent.click(screen.getByRole('button', { name: '승인 중이에요' }));
    expect(screen.getByLabelText('submitted allocations')).toHaveTextContent('[[{"kind":"charge","amount":3000},{"kind":"method","method":"card","amount":1500}]]');
    expect(screen.getByRole('spinbutton', { name: '충전금 사용' })).toBeDisabled();
  });

  it('requires a member and explains the charge balance limit', () => {
    const rendered = renderWithKit(<Harness memberId={null}/>);
    expect(screen.getByRole('spinbutton', { name: '충전금 사용' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '외상 정산' })).toBeDisabled();
    expect(screen.getByText('회원을 먼저 연결해 주세요')).toBeInTheDocument();
    rendered.unmount();
    renderWithKit(<Harness balance={2000}/>);
    fireEvent.change(screen.getByRole('spinbutton', { name: '충전금 사용' }), { target: { value: '3000' } });
    fireEvent.click(screen.getByRole('button', { name: '카드' }));
    expect(screen.getByRole('alert')).toHaveTextContent('충전금 잔액 2,000원까지 쓸 수 있어요');
    expect(screen.getByLabelText('submitted allocations')).toHaveTextContent('[]');
  });

  it('confirms an entirely receivable share without creating a method allocation', () => {
    renderWithKit(<Harness/>);
    fireEvent.click(screen.getByRole('button', { name: '나머지 외상' }));
    expect(screen.getByRole('button', { name: '결제하기' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '결제하기' }));
    expect(screen.getByLabelText('submitted allocations')).toHaveTextContent('[[{"kind":"receivable","amount":4500}]]');
  });

  it.each([
    [{ purpose: 'charge_topup', memberId: 'M-0001', amount: 4500 }, '충전금 충전', '충전했어요'],
    [{ purpose: 'receivable_collection', memberId: 'M-0001', amount: 4500 }, '외상 수금', '외상을 수금했어요'],
    [{ purpose: 'membership_sale', memberId: 'M-0001', productId: 'product-1' }, '회원권 판매', '회원권을 판매했어요'],
  ] as const)('accepts mixed real methods for %s and shows its own result', (target, title, result) => {
    renderWithKit(<Harness target={target}/>);
    expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '정산 유형' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '여러 수단으로 내기' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '카드' }), { target: { value: '3000' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '현금' }), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: '결제하기' }));
    expect(screen.getByLabelText('submitted allocations')).toHaveTextContent('[[{"kind":"method","method":"card","amount":3000},{"kind":"method","method":"cash","amount":1500}]]');
    fireEvent.click(screen.getByRole('button', { name: 'Complete approval' }));
    expect(screen.getByRole('heading', { name: result })).toBeInTheDocument();
    expect(screen.queryByText(/주문 진행 상태/)).not.toBeInTheDocument();
  });

  it('retains a zero-value subscription use and submits no real method', () => {
    renderWithKit(<Harness amount={0} initial={[{ kind: 'membership_period', amount: 0, membershipId: 'pass-1', useId: 'use-1' }]}/>);
    fireEvent.click(screen.getByRole('button', { name: '0원으로 주문하기' }));
    expect(screen.getByLabelText('submitted allocations')).toHaveTextContent('[[{"kind":"membership_period","amount":0,"membershipId":"pass-1","useId":"use-1"}]]');
    expect(screen.queryByRole('button', { name: '카드' })).not.toBeInTheDocument();
  });
});
