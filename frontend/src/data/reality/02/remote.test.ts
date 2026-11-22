import { describe, expect, it } from 'vitest';
import { PortError } from '../00/port';
import { createPortTransport } from '../00/transport';
import { fakeBackend, reply } from '../00/testing';
import type { PosOrderDto, PosQuoteDto } from './dto';
import { createPosRemote } from './remote';

const quote = (over: Partial<PosQuoteDto> = {}): PosQuoteDto => ({ quoteRevision: 1, lines: [], gross: 4500, discount: 0, payable: 4500, ...over });
const order = (n: number, remaining = 4500): PosOrderDto => ({
  orderId: `o${n}`, orderNo: n, billId: `b${n}`, businessDate: '2026-10-26', orderedAt: '2026-10-26T01:00:00.000Z', revision: 1, preparation: 'accepted', tableId: null,
  settlementId: `s${n}`, paymentId: `p${n}`, amount: 4500, remaining, lines: [],
});
const page = <T,>(items: T[]) => ({ items, nextCursor: null, asOf: '2026-10-26T06:45:00.000Z', sourceRevision: 17 });

function setup() {
  const backend = fakeBackend();
  backend.on('GET', '/pos/tables', () => page([]));
  const transport = createPortTransport(backend.fetch);
  const remote = createPosRemote({ transport, sleep: async () => {}, delaysMs: [0, 0] });
  return { backend, remote };
}
const line = { menuId: 'm1', qty: 1, optionIds: [] as string[] };

describe('F02 POS remote', () => {
  it('reads the business day once per order and reuses a receipt until the order changes', async () => {
    const { backend, remote } = setup();
    let remaining = 4500;
    backend.on('GET', '/pos/orders', () => page([order(1, remaining)]));
    backend.on('GET', '/pos/bills', () => page([]));
    backend.on('GET', /^\/pos\/payments\/.+\/receipt$/, call => ({ paymentId: call.path.split('/')[3], remaining }));
    const first = await remote.load('2026-10-26');
    expect(first).toMatchObject({ complete: true, sourceRevision: 17 });
    expect(first.rows.receipts.get('p1')).toMatchObject({ remaining: 4500 });
    expect(backend.callsTo('GET', '/pos/orders')[0].query).toMatchObject({ businessDate: '2026-10-26', limit: '50' });
    expect(backend.callsTo('GET', '/pos/bills')[0].query.status).toBeUndefined();
    await remote.load('2026-10-26');
    expect(backend.callsTo('GET', /receipt$/)).toHaveLength(1);
    remaining = 0;
    expect((await remote.load('2026-10-26')).rows.receipts.get('p1')).toMatchObject({ remaining: 0 });
    expect(backend.callsTo('GET', /receipt$/)).toHaveLength(2);
  });

  it('refreshes a cached receipt when its provider linkage changes without a balance change', async () => {
    const { backend, remote } = setup();
    let links = {};
    backend.on('GET', '/pos/orders', () => page([{ ...order(1), ...links }]));
    backend.on('GET', '/pos/bills', () => page([]));
    backend.on('GET', /receipt$/, () => ({ paymentId: 'p1', remaining: 4500, ...links }));

    expect((await remote.load('2026-10-26')).rows.receipts.get('p1')).not.toHaveProperty('naverPayPaymentId');
    links = { source: 'naver', naverPayPaymentId: 'pN1' };
    expect((await remote.load('2026-10-26')).rows.receipts.get('p1')).toMatchObject(links);
    expect(backend.callsTo('GET', /receipt$/)).toHaveLength(2);
  });

  it('opens a table bill, appends a separate order with its revision and later pays the existing bill', async () => {
    const { backend, remote } = setup();
    backend.on('POST', '/pos/bills', () => ({ resourceId: 'b1', revision: 1, receiptId: 'r1', affectedSources: ['pos.bills'], quote: quote(), orderId: 'o1' }));
    backend.on('POST', '/pos/bills/b1/orders', () => ({ resourceId: 'b1', revision: 2, receiptId: 'r2', affectedSources: ['pos.orders'], quote: quote({ payable: 9000 }), orderId: 'o2' }));
    await remote.submitOrder({ lines: [line], key: 'order:1', table: { tableId: 'server-table', expectedRevision: 3 } });
    expect(backend.callsTo('POST', '/pos/bills')[0].body).toEqual({ type: 'dine_in', postpaid: true, table: { tableId: 'server-table', expectedRevision: 3 }, lines: [{ menuId: 'm1', qty: 1 }] });
    await remote.submitOrder({ lines: [line], key: 'order:2', bill: { billId: 'b1', expectedRevision: 1 } });
    expect(backend.callsTo('POST', '/pos/bills/b1/orders')[0].body).toEqual({ expectedRevision: 1, lines: [{ menuId: 'm1', qty: 1 }] });
    backend.on('POST', '/pos/settlement-quotes', () => ({ billId: 'b1', ...quote({ payable: 9000 }) }));
    backend.on('POST', '/pos/bills/b1/payments', () => ({ resourceId: 'p1', revision: 3, receiptId: 'r3', affectedSources: [], billId: 'b1', orderId: 'o1', paymentId: 'p1', settlementId: 's1' }));
    expect(await remote.checkout({ attemptId: 'a1', type: 'dine_in', lines: [], method: 'cash', expectedPayable: 9000, billId: 'b1' })).toMatchObject({ status: 'paid' });
    expect(backend.callsTo('POST', '/pos/bills')).toHaveLength(1);
  });

  it('quotes and records a member receivable with the account revision and accepts its settlement receipt ID', async () => {
    const { backend, remote } = setup();
    const allocations = [{ kind: 'receivable', amount: 4500 }];
    backend.on('POST', '/pos/bills', () => ({ resourceId: 'b1', revision: 1, receiptId: 'r1', affectedSources: [], quote: quote() }));
    backend.on('POST', '/pos/bills/b1/member-quote', () => ({ billId: 'b1', memberId: 'member', allocations, quoteRevision: 99, accountRevision: 3, amountDue: 4500, realAmount: 0, canSubmit: true, issues: [] }));
    backend.on('POST', '/pos/bills/b1/member-payments', () => ({ resourceId: 's1', revision: 4, receiptId: 'r2', affectedSources: ['members'], billId: 'b1', orderId: 'o1', settlementId: 's1' }));
    const paid = await remote.checkout({ attemptId: 'a1', type: 'takeout', lines: [line], method: 'cash', expectedPayable: 4500, member: { memberId: 'member', allocation: 'receivable' } });
    expect(paid).toMatchObject({ status: 'paid', receipt: { settlementId: 's1' } });
    expect(backend.callsTo('POST', '/pos/bills/b1/member-quote')[0].body).toEqual({ memberId: 'member', allocations });
    expect(backend.callsTo('POST', '/pos/bills/b1/member-payments')[0].body).toEqual({ memberId: 'member', allocations, quoteRevision: 99, accountRevision: 3 });
    expect(backend.callsTo('POST', '/pos/bills/b1/payments')).toHaveLength(0);
  });

  it('makes one bill and pays it once with keys named by the attempt', async () => {
    const { backend, remote } = setup();
    backend.on('POST', '/pos/bills', () => ({ resourceId: 'b1', revision: 1, receiptId: 'r1', affectedSources: ['pos.bills'], quote: quote() }));
    backend.on('POST', '/pos/bills/b1/payments', () => ({ resourceId: 'p1', revision: 1, receiptId: 'r2', affectedSources: ['pos.orders'], billId: 'b1', orderId: 'o1', paymentId: 'p1', settlementId: 's1' }));
    const result = await remote.checkout({ attemptId: 'a1', type: 'takeout', lines: [line], method: 'cash', expectedPayable: 4500 });
    expect(result).toMatchObject({ status: 'paid', receipt: { paymentId: 'p1', orderId: 'o1' } });
    const [bill] = backend.callsTo('POST', '/pos/bills'), [payment] = backend.callsTo('POST', '/pos/bills/b1/payments');
    expect(bill.headers.get('idempotency-key')).toBe('bill:a1');
    expect(payment.headers.get('idempotency-key')).toBe('payment:a1:1');
    expect(payment.body).toEqual({ method: 'cash', amount: 4500, quoteRevision: 1 });
  });

  it('stops before paying when the service amount differs from what the owner saw, then pays the same bill', async () => {
    const { backend, remote } = setup();
    backend.on('POST', '/pos/bills', () => ({ resourceId: 'b1', revision: 1, receiptId: 'r1', affectedSources: [], quote: quote({ payable: 5000, quoteRevision: 2 }) }));
    backend.on('POST', '/pos/settlement-quotes', () => ({ billId: 'b1', ...quote({ payable: 5000, quoteRevision: 2 }) }));
    backend.on('POST', '/pos/bills/b1/payments', () => ({ resourceId: 'p1', revision: 1, receiptId: 'r2', affectedSources: [], billId: 'b1', orderId: 'o1', paymentId: 'p1', settlementId: 's1' }));
    const changed = await remote.checkout({ attemptId: 'a1', type: 'takeout', lines: [line], method: 'cash', expectedPayable: 4500 });
    expect(changed).toMatchObject({ status: 'quote-changed', billId: 'b1', quote: { payable: 5000 } });
    expect(backend.callsTo('POST', '/pos/bills/b1/payments')).toHaveLength(0);
    const paid = await remote.checkout({ attemptId: 'a1', type: 'takeout', lines: [line], method: 'cash', expectedPayable: 5000, billId: 'b1' });
    expect(paid.status).toBe('paid');
    expect(backend.callsTo('POST', '/pos/bills')).toHaveLength(1);
    expect(backend.callsTo('POST', '/pos/bills/b1/payments')[0].body).toMatchObject({ amount: 5000, quoteRevision: 2 });
  });

  it('turns a QUOTE_CHANGED conflict at payment into a fresh quote and sends terminal numbers for card', async () => {
    const { backend, remote } = setup();
    backend.on('POST', '/pos/bills', () => ({ resourceId: 'b1', revision: 1, receiptId: 'r1', affectedSources: [], quote: quote() }));
    backend.on('POST', '/pos/settlement-quotes', () => ({ billId: 'b1', ...quote({ payable: 4800, quoteRevision: 3 }) }));
    backend.on('POST', '/pos/bills/b1/payments', () => reply(409, { ok: false, code: 'CONFLICT', reason: 'QUOTE_CHANGED' }));
    const result = await remote.checkout({ attemptId: 'a1', type: 'takeout', lines: [line], method: 'card', expectedPayable: 4500, terminal: { approvalNo: 'A77', at: '2026-10-26T15:40' } });
    expect(result).toMatchObject({ status: 'quote-changed', quote: { payable: 4800, quoteRevision: 3 } });
    expect(backend.callsTo('POST', '/pos/bills/b1/payments')[0].body).toMatchObject({ method: 'card', terminal: { approvalNo: 'A77', occurredAt: '2026-10-26T15:40:00+09:00' } });
  });

  it('refuses a card payment without terminal numbers before sending anything to pay', async () => {
    const { backend, remote } = setup();
    backend.on('POST', '/pos/bills', () => ({ resourceId: 'b1', revision: 1, receiptId: 'r1', affectedSources: [], quote: quote() }));
    await expect(remote.checkout({ attemptId: 'a1', type: 'takeout', lines: [line], method: 'card', expectedPayable: 4500 })).rejects.toMatchObject({ reason: 'TERMINAL_RECORD_REQUIRED' });
    expect(backend.callsTo('POST', '/pos/bills/b1/payments')).toHaveLength(0);
  });

  it('resends the same key after an unknown outcome and never records twice', async () => {
    const { backend, remote } = setup();
    let attempts = 0;
    backend.on('POST', '/pos/bills', () => ({ resourceId: 'b1', revision: 1, receiptId: 'r1', affectedSources: [], quote: quote() }));
    backend.on('POST', '/pos/bills/b1/payments', () => {
      attempts += 1;
      return attempts === 1 ? reply(503, { code: 'SERVICE_UNAVAILABLE' }) : { resourceId: 'p1', revision: 1, receiptId: 'r2', affectedSources: [], billId: 'b1', orderId: 'o1', paymentId: 'p1', settlementId: 's1' };
    });
    const result = await remote.checkout({ attemptId: 'a1', type: 'takeout', lines: [line], method: 'cash', expectedPayable: 4500 });
    expect(result.status).toBe('paid');
    const keys = backend.callsTo('POST', '/pos/bills/b1/payments').map(call => call.headers.get('idempotency-key'));
    expect(keys).toEqual(['payment:a1:1', 'payment:a1:1']);
  });

  it('reports a definite refusal as a PortError with the service reason', async () => {
    const { backend, remote } = setup();
    backend.on('POST', '/pos/bills', () => reply(409, { ok: false, code: 'CONFLICT', reason: 'DAY_CLOSED' }));
    const failure = await remote.checkout({ attemptId: 'a1', type: 'takeout', lines: [line], method: 'cash', expectedPayable: 4500 }).catch(error => error);
    expect(failure).toBeInstanceOf(PortError);
    expect(failure).toMatchObject({ code: 'CONFLICT', reason: 'DAY_CLOSED', outcomeUnknown: false });
  });

  it('quotes and confirms a correction with the token and the terminal return record', async () => {
    const { backend, remote } = setup();
    backend.on('POST', '/pos/payments/p1/reversal-quote', () => ({ quoteToken: 'tok', kind: 'cancel', amount: 4500, remaining: 4500, methods: [{ method: 'card', amount: 4500 }] }));
    backend.on('POST', '/pos/settlements/s1/corrections', () => ({ resourceId: 'c1', revision: 1, receiptId: 'r3', affectedSources: ['pos.sales'], paymentId: 'p1' }));
    const quoted = await remote.quoteReversal('p1', { kind: 'cancel' });
    expect(quoted.quoteToken).toBe('tok');
    await remote.correct('s1', { quoteToken: quoted.quoteToken, key: 'correction:k1', terminal: { approvalNo: 'R9', at: '2026-10-26T15:50' } });
    const [call] = backend.callsTo('POST', '/pos/settlements/s1/corrections');
    expect(call.body).toEqual({ quoteToken: 'tok', confirmed: true, terminal: { approvalNo: 'R9', occurredAt: '2026-10-26T15:50:00+09:00' } });
    expect(call.headers.get('idempotency-key')).toBe('correction:k1');
  });

  it('moves an order through preparation with its revision', async () => {
    const { backend, remote } = setup();
    backend.on('POST', '/pos/orders/o1/preparation', () => ({ resourceId: 'o1', revision: 2, receiptId: 'r4', affectedSources: ['pos.orders'] }));
    await remote.setPreparation('o1', 'preparing', 1, 'prep:k1');
    expect(backend.callsTo('POST', '/pos/orders/o1/preparation')[0].body).toEqual({ status: 'preparing', expectedRevision: 1 });
  });
});
