import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { useRef, useState } from 'react';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { quoteCustomReversal, planCustomReversal, quoteCustomSettlement, planCustomSettlement, selectCustomOrders } from '../../../data/iteration7/custom-orders';
import { createCustomTestSource } from '../../../features/widgets/i7-custom/test-source';
import { SharedPosReversalDialog } from './SharedPosReversalDialog';

afterEach(cleanup);
describe('shared custom reversal confirmation', () => {
  it('keeps the paid order unchanged until one confirmed original-method return', () => {
    const source = createCustomTestSource();
    // CO-001 is already approved in the café seed: pay and reverse the order that is still waiting for its first quote.
    const order = source.port.read().tables.customOrder.find(row => row.quoteRevision === 0);
    if (!order) throw new Error('Missing reversal fixture order');
    const customOrderId = order.customOrderId;
    const quoteAmount = 45_600;
    expect(source.port.dispatch({ type: 'customOrder.quote', customOrderId, quoteAmount,
      proposedPickupAt: order.desiredPickupAt, idempotencyKey: 'quote' }).ok).toBe(true);
    expect(source.port.dispatch({ type: 'customOrder.recordDecision', customOrderId, quoteRevision: 1,
      decision: 'approved', paymentTiming: 'advance', idempotencyKey: 'approve' }).ok).toBe(true);
    const quote = quoteCustomSettlement(source.port.read(), { customOrderId,
      allocations: [{ kind: 'method', method: 'card', amount: quoteAmount }] });
    expect(source.apply(planCustomSettlement(source.port.read(), { quote, settlementId: 'custom-paid', paymentId: 'custom-card', idempotencyKey: 'pay' })).ok).toBe(true);
    expect(source.port.dispatch({ type: 'customOrder.setStage', customOrderId, nextStage: 'production_complete', idempotencyKey: 'complete' }).ok).toBe(true);
    function Harness() {
      const trigger = useRef<HTMLButtonElement>(null), [open, setOpen] = useState(true), [done, setDone] = useState(false);
      const quote = quoteCustomReversal(source.port.read(), { customOrderId, kind: 'cancellation' });
      return <SharedPosReversalDialog open={open} quote={quote} phase={done ? { status: 'succeeded' } : { status: 'ready' }} returnFocusRef={trigger} cancelOrder onClose={() => setOpen(false)} onConfirm={() => {
        const result = source.apply(planCustomReversal(source.port.read(), { quote, cancelOrder: true, idempotencyKey: 'confirm' }));
        if (result.ok) setDone(true);
        return result.ok;
      }} />;
    }
    renderWithKit(<Harness />);
    expect(selectCustomOrders(source.port.read()).orders.find(row => row.customOrderId === customOrderId)?.stage).toBe('production_complete');
    expect(screen.getByText('카드')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '취소 확정하기' }));
    expect(selectCustomOrders(source.port.read()).orders.find(row => row.customOrderId === customOrderId)).toMatchObject({ stage: 'canceled', payment: { status: 'canceled' } });
    expect(source.port.read().money.corrections).toHaveLength(1);
    expect(screen.getByText('취소했어요')).toBeInTheDocument();
  });
});
