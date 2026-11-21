import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { useRef, useState } from 'react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { quoteCustomSettlement } from '../../../data/iteration7/custom-orders';
import { createCustomTestSource } from '../../../features/widgets/i7-custom/test-source';
import { SharedPosPaymentDialog, type SettlementPaymentPhase, type RealAllocation } from './SharedPosPaymentDialog';

afterEach(cleanup);
const customOrderId = 'CO-002';
function Harness({ fail = false }: { fail?: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [phase, setPhase] = useState<SettlementPaymentPhase>({ status: 'ready' });
  const [allocations, setAllocations] = useState<readonly RealAllocation[]>([]);
  const [submitted, setSubmitted] = useState(0);
  const [{ source, order }] = useState(() => {
    const source = createCustomTestSource();
    const order = source.port.read().tables.customOrder.find(row => row.customOrderId === customOrderId);
    if (!order) throw new Error(`Missing payment fixture order ${customOrderId}`);
    expect(source.port.dispatch({ type: 'customOrder.quote', customOrderId, quoteAmount: 65000, proposedPickupAt: order.desiredPickupAt, idempotencyKey: 'quote' }).ok).toBe(true);
    expect(source.port.dispatch({ type: 'customOrder.recordDecision', customOrderId, quoteRevision: 1, decision: 'approved', paymentTiming: 'on_pickup', idempotencyKey: 'approve' }).ok).toBe(true);
    return { source, order };
  });
  return <><button ref={button} onClick={() => setOpen(true)}>결제 받기</button><output aria-label="승인 요청 수">{submitted}</output>
    <SharedPosPaymentDialog open={open} target={{ purpose: 'custom_order', customOrderId }} summary={order.productLabel} returnFocusRef={button}
      quote={quoteCustomSettlement(source.port.read(), { customOrderId, allocations })}
      phase={phase} onAllocationsChange={next => { setAllocations(next); return quoteCustomSettlement(source.port.read(), { customOrderId, allocations: next }); }} onApprove={() => { setSubmitted(n => n + 1); setPhase(fail ? { status: 'failed', reason: 'APPROVAL_FAILED' } : { status: 'pending' }); return true; }}
      onReset={() => setPhase({ status: 'ready' })} onClose={() => setOpen(false)} />
  </>;
}
describe('shared controlled POS payment', () => {
  it('opens without submitting and restores the management trigger on dismissal', async () => {
    renderWithKit(<Harness />, { reducedMotion: true });
    const trigger = screen.getByRole('button', { name: '결제 받기' });
    trigger.focus(); fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('승인 요청 수')).toHaveTextContent('0');
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it('submits mixed real methods once and blocks close while approval is pending', () => {
    renderWithKit(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '결제 받기' }));
    fireEvent.click(screen.getByRole('button', { name: '여러 수단으로 내기' }));
    fireEvent.change(screen.getByLabelText('카드'), { target: { value: '45000' } });
    fireEvent.change(screen.getByLabelText('현금'), { target: { value: '20000' } });
    fireEvent.click(screen.getByRole('button', { name: '결제하기' }));
    fireEvent.click(screen.getByRole('button', { name: '승인 중이에요' }));
    expect(screen.getByLabelText('승인 요청 수')).toHaveTextContent('1');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.keyUp(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('충전금')).not.toBeInTheDocument();
  });
  it('offers retry and a different method after failure without implying completion', () => {
    renderWithKit(<Harness fail />);
    fireEvent.click(screen.getByRole('button', { name: '결제 받기' }));
    fireEvent.click(screen.getByRole('button', { name: '카드' }));
    expect(screen.getByRole('alert')).toHaveTextContent('결제를 완료하지 못했어요');
    fireEvent.click(screen.getByRole('button', { name: '다른 결제 수단' }));
    fireEvent.click(screen.getByRole('button', { name: '현금' }));
    expect(screen.getByLabelText('승인 요청 수')).toHaveTextContent('2');
  });
});
