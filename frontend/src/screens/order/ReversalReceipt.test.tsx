import '@testing-library/jest-dom/vitest';
import '../../ui/test-setup';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { screenPresets } from '../../layout/presets';
import { UiProvider } from '../../ui';
import { PosProvider } from '../../pos/react';
import { setup as setupBase } from '../../pos/loyalty/test-setup';
import { selectPosDayTotals } from '../../pos/domain';
import { selectReceipt } from '../../pos/reversals';
import { ReversalReceipt } from './ReversalReceipt';
import { quotePaymentBill } from '../../pos/loyalty';
import { seedToday } from '../../data/db/generated/today';

function setup(paymentStyle?: 'prepaid' | 'postpaid') {
  const h = setupBase(paymentStyle);
  const add = (menuId = 'm-americano', qty = 1) => {
    const menu = h.pos.read().data.catalog.items.find(item => item.menuId === menuId)!;
    const optionIds = menu.groups.filter(group => group.required).map(group =>
      group.options.find(option => option.name === 'ICE')?.optionId ?? group.options.find(option => option.extraPrice === 0)!.optionId);
    return h.pos.execute({ type: 'cart.add', menuId, qty, optionIds, meta: h.meta() });
  };
  return { ...h, add };
}


afterEach(cleanup);

it('confirms the quoted cancellation once and keeps the correction on the original receipt', async () => {
  const h = setup(); h.add('m-americano', 3);
  const quote = quotePaymentBill(h.pos.read());
  expect(h.pos.beginApproval({ billId: quote.billId, quoteRevision: quote.revision,
    splits: [{ method: 'card', amount: 9000 }], meta: h.meta() }).ok).toBe(true);
  expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
  const paymentId = h.pos.read().pos.payments.at(-1)!.paymentId;
  const close = vi.fn();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={h.pos}><ReversalReceipt paymentId={paymentId} initialView="cancel" onClose={close}/></PosProvider></UiProvider>);
  const button = screen.getByRole('button', { name: '9,000원 취소하기' });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(selectPosDayTotals(h.pos.read().pos).revenue).toBe(seedToday.rollup.net), { timeout: 4000 });
  expect(h.pos.read().pos.cancellations.filter(c => c.paymentId === paymentId)).toHaveLength(1);
  expect(selectReceipt(h.pos.read(), { paymentId })?.corrections).toHaveLength(1);
});
