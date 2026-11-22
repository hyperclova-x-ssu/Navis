import { expect, it } from 'vitest';
import { createPortTransport } from '../00/transport';
import { fakeBackend, reply } from '../00/testing';
import { createPosRemote, type CheckoutInput } from '../02/remote';

const quote = { quoteRevision: 1, gross: 4500, discount: 450, payable: 4050, lines: [] };
const receipt = { resourceId: 'bill-1', revision: 1, receiptId: 'bill-receipt', affectedSources: [] };
const input: CheckoutInput & { coupon: { code: string; customerId: string; discount: number } } = {
  attemptId: 'one', type: 'takeout', lines: [{ menuId: 'menu-1', qty: 1, optionIds: [] }],
  method: 'cash', expectedPayable: 4050, coupon: { code: 'SM-TEST', customerId: 'customer-1', discount: 450 },
};

function setup() {
  const backend = fakeBackend();
  const remote = createPosRemote({ transport: createPortTransport(backend.fetch), sleep: async () => {}, delaysMs: [0] });
  backend.on('POST', '/pos/bills', () => ({ ...receipt, quote }));
  backend.on('POST', '/marketing/coupon-redemptions', () => ({ ...receipt, resourceId: 'claim-1', redemption: { state: 'held' } }));
  backend.on('POST', '/pos/bills/bill-1/payments', () => ({ ...receipt, billId: 'bill-1', paymentId: 'pay-1' }));
  backend.on('POST', '/marketing/coupon-redemptions/claim-1/reconcile', () => ({ state: 'committed' }));
  return { backend, remote };
}

it('creates the discounted bill, holds the coupon before taking payment and reconciles afterward', async () => {
  const { backend, remote } = setup();
  await expect(remote.checkout(input)).resolves.toMatchObject({ status: 'paid' });
  expect(backend.calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual([
    '/pos/bills', '/marketing/coupon-redemptions', '/pos/bills/bill-1/payments', '/marketing/coupon-redemptions/claim-1/reconcile',
  ]);
  expect(backend.callsTo('POST', '/pos/bills')[0].body).toMatchObject({ discount: 450 });
  expect(backend.callsTo('POST', '/marketing/coupon-redemptions')[0].body).toMatchObject({
    code: 'SM-TEST', billId: 'bill-1', customerId: 'customer-1',
  });
});

it('blocks all payment when the coupon claim is refused after preview', async () => {
  const { backend, remote } = setup();
  backend.on('POST', '/marketing/coupon-redemptions', () => reply(409, { code: 'CONFLICT', reason: 'COUPON_PAUSED' }));
  await expect(remote.checkout(input)).rejects.toMatchObject({ reason: 'COUPON_PAUSED' });
  expect(backend.callsTo('POST', '/pos/bills/bill-1/payments')).toHaveLength(0);
});
