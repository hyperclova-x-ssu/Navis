import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setup as setupBase } from '../../../pos/loyalty/test-setup';
import { getPaymentBillId } from '../../../pos/loyalty';
import { PosProvider } from '../../../pos/react';
import { renderWithKit } from '../../../ui/test-utils';
import { PosReceiptHost } from '../../../app/pos-host';
import { SessionActionsProvider } from '../../../app/session-actions';

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

function sale({ prepared = false, discount = false, ledger = false } = {}) {
  const h = setup();
  expect(h.add('m-americano', 2).ok).toBe(true);
  expect(h.add('m-cafe-latte', 1).ok).toBe(true);
  const billId = getPaymentBillId(h.pos.read());
  expect(h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0012', meta: h.meta() }).ok).toBe(true);
  if (discount) expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'direct', amount: 1000 }, meta: h.meta() }).ok).toBe(true);
  const money = h.actions.money;
  const due = money.quoteSale({ billId, allocations: [] }).amountDue;
  const quote = money.quoteSale({ billId, allocations: [{ kind: 'charge', amount: 3000 }, { kind: 'method', method: 'card', amount: due - 3000 }] });
  expect(money.beginApproval({ quote, idempotencyKey: 'review-sale' }).ok).toBe(true);
  const pending = money.approval()!;
  expect(money.finishApproval({ runId: pending.runId, attemptId: pending.attemptId, outcome: 'approved' }).ok).toBe(true);
  const original = money.read().state.settlements.at(-1)!;
  const payment = money.read().state.payments.find(row => row.settlementId === original.settlementId)!;
  if (prepared) expect(h.pos.execute({ type: 'order.start', orderId: h.pos.read().pos.orders.at(-1)!.orderId, meta: h.meta() }).ok).toBe(true);
  money.dismissApproval();
  const jobs: (() => void)[] = [], reverse = vi.spyOn(money, 'reverse');
  const entry = ledger ? { settlementId: original.settlementId, view: 'receipt' as const } : { paymentId: payment.paymentId, view: 'receipt' as const };
  renderWithKit(<SessionActionsProvider value={h.actions}><PosProvider value={h.pos}><PosReceiptHost entry={entry} onClose={() => {}} scheduler={{ schedule: callback => { jobs.push(callback); return jobs.length; }, cancel: () => {} }}/></PosProvider></SessionActionsProvider>, { store: h.data, reducedMotion: true });
  return { ...h, money, original, jobs, reverse };
}

it.each([false, true])('RV-3 canonical receipt selects one of two Americanos and commits its original allocations once (prepared=%s)', prepared => {
  const h = sale({ prepared });
  fireEvent.click(screen.getByRole('button', { name: prepared ? '환불하기' : '결제 취소하기' }));
  fireEvent.click(screen.getByRole('radio', { name: '품목 고르기' }));
  expect(screen.getByRole('button', { name: prepared ? '환불 확정하기' : '취소 확정하기' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /아메리카노/ }));
  const quantity = screen.getByRole('spinbutton', { name: /아메리카노.*수량/ });
  expect(quantity).toHaveAttribute('max', '2');
  fireEvent.change(quantity, { target: { value: '3' } });
  expect(screen.getByRole('button', { name: prepared ? '환불 확정하기' : '취소 확정하기' })).toBeDisabled();
  fireEvent.change(quantity, { target: { value: '1' } });
  const confirm = screen.getByRole('button', { name: prepared ? '환불 확정하기' : '취소 확정하기' });
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(quantity).toBeDisabled();
  act(() => h.jobs.at(-1)!());
  expect(h.reverse).toHaveBeenCalledTimes(1);
  const submitted = h.reverse.mock.calls[0]![0].quote;
  const americano = h.original.sourceSnapshot!.lines.find(line => line.menuId === 'm-americano')!;
  expect(submitted.input.lines).toEqual([{ allocationId: americano.allocationId, quantity: 1 }]);
  expect(submitted.input.amount).toBeUndefined();
  expect(submitted.amount).toBe(3000);
  expect(submitted.realMethodReturns.reduce((sum, row) => sum + row.amount, 0) + submitted.accountEffects.reduce((sum, row) => sum + row.amount, 0)).toBe(3000);
  expect(h.money.receipt({ settlementId: h.original.settlementId })!.remainingRefundable).toBe(6800);
  expect(screen.getByText(prepared ? '환불했어요' : '취소했어요')).toBeInTheDocument();
});

it('RV-3 preserves the whole-bill discount restriction on the canonical receipt', () => {
  sale({ discount: true });
  fireEvent.click(screen.getByRole('button', { name: '결제 취소하기' }));
  expect(screen.queryByRole('radio', { name: '품목 고르기' })).not.toBeInTheDocument();
  expect(screen.getByText('주문 전체에 할인이 들어가 있어 전체 취소만 할 수 있어요')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '취소 확정하기' })).toBeEnabled();
});

it('RV-4 offers and completes a refund from the ledger receipt when the paid order starts preparation', () => {
  const h = sale({ ledger: true });
  expect(h.original.sourceSnapshot!.prepared).toBe(false);
  expect(screen.getByRole('button', { name: '결제 취소하기' })).toBeInTheDocument();
  act(() => { expect(h.pos.execute({ type: 'order.start', orderId: h.pos.read().pos.orders.at(-1)!.orderId, meta: h.meta() }).ok).toBe(true); });
  expect(screen.queryByRole('button', { name: '결제 취소하기' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '환불하기' }));
  fireEvent.click(screen.getByRole('button', { name: '환불 확정하기' }));
  act(() => h.jobs.at(-1)!());
  expect(h.reverse.mock.calls[0]![0].quote.kind).toBe('refund');
  expect(screen.getByText('환불했어요')).toBeInTheDocument();
  expect(h.money.receipt({ settlementId: h.original.settlementId })!.remainingRefundable).toBe(0);
  expect(h.pos.read().pos.orders.at(-1)!.preparation).toBe('preparing');
});
