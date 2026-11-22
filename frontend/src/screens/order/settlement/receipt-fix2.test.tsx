import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { setup as setupBase } from '../../../pos/loyalty/test-setup';
import { getPaymentBillId } from '../../../pos/loyalty';
import { PosProvider } from '../../../pos/react';
import { selectCashReceiptTotals } from '../../../pos/reversals';
import { renderWithKit } from '../../../ui/test-utils';
import { PosReceiptHost } from '../../../app/pos-host';
import { SessionActionsProvider } from '../../../app/session-actions';
import type { RootReceiptEntry } from '../../../app/pos-host';

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

function pay(h: ReturnType<typeof setup>, billId: string, method: 'card' | 'cash') {
  const money = h.actions.money;
  const amount = money.quoteSale({ billId, allocations: [] }).amountDue;
  const quote = money.quoteSale({ billId, allocations: [{ kind: 'method', method, amount }] });
  expect(money.beginApproval({ quote, idempotencyKey: `fix2-sale:${billId}` }).ok).toBe(true);
  const pending = money.approval()!;
  expect(money.finishApproval({ runId: pending.runId, attemptId: pending.attemptId, outcome: 'approved' }).ok).toBe(true);
  money.dismissApproval();
  return money.read().state.settlements.at(-1)!;
}

function receiptHost(h: ReturnType<typeof setup>, entry: RootReceiptEntry) {
  const jobs: (() => void)[] = [];
  const mounted = renderWithKit(<SessionActionsProvider value={h.actions}><PosProvider value={h.pos}>
    <PosReceiptHost entry={entry} onClose={() => {}} scheduler={{ schedule: callback => { jobs.push(callback); return jobs.length; }, cancel: () => {} }}/>
  </PosProvider></SessionActionsProvider>, { store: h.data, reducedMotion: true });
  return { ...mounted, finish: () => act(() => jobs.at(-1)!()) };
}

it('FIX-2 cancels only the unprepared added latte from a mixed postpaid receipt entered as cancel, then refunds its prepared Americano', () => {
  const h = setup('postpaid');
  expect(h.add('m-americano').ok).toBe(true);
  expect(h.pos.execute({ type: 'bill.submitOrder', cartId: h.pos.read().pos.cart.cartId, meta: h.meta() }).ok).toBe(true);
  const billId = h.pos.read().pos.bills.find(row => row.status === 'open')!.billId;
  const americanoOrder = h.pos.read().pos.orders.at(-1)!;
  expect(h.add('m-cafe-latte').ok).toBe(true);
  expect(h.pos.execute({ type: 'bill.submitOrder', billId, cartId: h.pos.read().pos.cart.cartId, meta: h.meta() }).ok).toBe(true);
  const latteOrder = h.pos.read().pos.orders.at(-1)!;
  const original = pay(h, billId, 'card');
  expect(h.pos.execute({ type: 'order.start', orderId: americanoOrder.orderId, meta: h.meta() }).ok).toBe(true);
  let mounted = receiptHost(h, { settlementId: original.settlementId, view: 'receipt' });
  expect(screen.getByRole('button', { name: '결제 취소하기' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '환불하기' })).toBeInTheDocument();
  mounted.unmount();
  mounted = receiptHost(h, { settlementId: original.settlementId, view: 'cancel' });
  fireEvent.click(screen.getByRole('radio', { name: '품목 고르기' }));
  const preparedLine = screen.getByRole('checkbox', { name: /아메리카노/ });
  expect(preparedLine).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(preparedLine);
  expect(preparedLine).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: /카페라떼/ }));
  expect(screen.getByRole('button', { name: '취소 확정하기' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '취소 확정하기' }));
  mounted.finish();
  expect(screen.getByText('취소했어요')).toBeInTheDocument();
  expect(h.actions.money.read().state.corrections.at(-1)).toMatchObject({ kind: 'cancel', amount: 3800 });
  expect(h.actions.money.receipt({ settlementId: original.settlementId })!.remainingRefundable).toBe(3000);
  expect(h.pos.read().pos.orders.find(row => row.orderId === latteOrder.orderId)!.lines[0]).toMatchObject({ qty: 1, canceledQty: 1 });
  mounted.unmount();
  mounted = receiptHost(h, { settlementId: original.settlementId, view: 'receipt' });
  expect(screen.queryByRole('button', { name: '결제 취소하기' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '환불하기' }));
  fireEvent.click(screen.getByRole('button', { name: '환불 확정하기' }));
  mounted.finish();
  expect(screen.getByText('환불했어요')).toBeInTheDocument();
  expect(h.actions.money.read().state.corrections.at(-1)).toMatchObject({ kind: 'refund', amount: 3000 });
  expect(h.pos.read().pos.orders.find(row => row.orderId === americanoOrder.orderId)!.lines[0]).toMatchObject({ qty: 1, canceledQty: 0 });
});

it('SCR-248 restores show-again, cash issuance, masked status and issue cancellation on an M3 sale, including RV-5 full reversal', () => {
  const h = setup();
  expect(h.add('m-americano').ok).toBe(true);
  const original = pay(h, getPaymentBillId(h.pos.read()), 'cash');
  const paymentId = h.actions.money.receipt({ settlementId: original.settlementId })!.paymentId!;
  const mounted = receiptHost(h, { paymentId, view: 'receipt' });
  const payment = h.pos.read().pos.payments.find(row => row.paymentId === paymentId)!;
  expect(payment.transactionNo).toMatch(/^거래-\d{8}-\d{4}$/u);
  expect(screen.getByText('정산 거래번호').nextElementSibling).toHaveTextContent(payment.transactionNo);
  expect(screen.getByRole('dialog')).not.toHaveTextContent(original.billId!);
  fireEvent.click(screen.getByRole('button', { name: '영수증 다시 보기' }));
  expect(screen.getByRole('status')).toHaveTextContent('영수증을 다시 보여 드렸어요');
  fireEvent.click(screen.getByRole('button', { name: '현금영수증 발행하기' }));
  fireEvent.change(screen.getByRole('textbox', { name: '휴대폰 번호' }), { target: { value: '123' } });
  fireEvent.click(screen.getByRole('button', { name: '발행하기' }));
  expect(screen.getByText('휴대폰 번호를 숫자 10~11자리로 넣어 주세요')).toBeInTheDocument();
  expect(selectCashReceiptTotals(h.pos.read().pos)).toEqual({ count: 0, amount: 0 });
  fireEvent.change(screen.getByRole('textbox', { name: '휴대폰 번호' }), { target: { value: '01012345678' } });
  fireEvent.click(screen.getByRole('button', { name: '발행하기' }));
  expect(screen.getByRole('status')).toHaveTextContent('현금영수증을 발행했어요');
  expect(screen.getByText('현금영수증 소득공제 · 010-****-5678')).toBeInTheDocument();
  expect(selectCashReceiptTotals(h.pos.read().pos)).toEqual({ count: 1, amount: 3000 });
  fireEvent.click(screen.getByRole('button', { name: '발행 취소' }));
  expect(screen.getByRole('status')).toHaveTextContent('현금영수증 발행을 취소했어요');
  expect(selectCashReceiptTotals(h.pos.read().pos)).toEqual({ count: 0, amount: 0 });
  fireEvent.click(screen.getByRole('button', { name: '현금영수증 발행하기' }));
  fireEvent.click(screen.getByRole('radio', { name: '지출증빙' }));
  fireEvent.change(screen.getByRole('textbox', { name: '사업자 번호' }), { target: { value: '1234567890' } });
  fireEvent.click(screen.getByRole('button', { name: '발행하기' }));
  expect(screen.getByText('현금영수증 지출증빙 · 123-**-**890')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '결제 취소하기' }));
  fireEvent.click(screen.getByRole('button', { name: '취소 확정하기' }));
  mounted.finish();
  expect(selectCashReceiptTotals(h.pos.read().pos)).toEqual({ count: 0, amount: 0 });
  mounted.unmount();
  receiptHost(h, { settlementId: original.settlementId, view: 'receipt' });
  expect(screen.getByText('현금영수증 발행을 취소했어요')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '현금영수증 발행하기' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '발행 취소' })).not.toBeInTheDocument();
});
