import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../db/store';
import { selectCustomOrders } from '../../iteration7/custom-orders';
import { selectCustomOrderRead } from '../../pos/projection';
import { createRealPort } from '../00';
import { fakeBackend, reply } from '../00/testing';
import { customAdapter } from './adapter';
import { customService as service, PNG, textField as field } from './testing';

afterEach(() => vi.unstubAllGlobals());

function session(backend: ReturnType<typeof fakeBackend>) {
  const store = createWidgetDataStore(undefined, { runId: 'custom-http' });
  const port = createRealPort({ store, source: domain => domain === 'custom' ? 'http' : 'fixture', adapters: [customAdapter], fetch: backend.fetch, sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  return { store, port };
}
const model = (store: ReturnType<typeof createWidgetDataStore>) => selectCustomOrders(selectCustomOrderRead(store.getSnapshot()));

describe('custom orders over HTTP (B08)', () => {
  it('replaces the seed with the service rows and shows nothing it did not return', async () => {
    const { backend } = service();
    const { store, port } = session(backend);
    expect((await port.load('custom')).status).toBe('ready');
    expect(model(store)).toMatchObject({ templates: [], orders: [] });
    expect(store.getSnapshot().tables.realCustom).toMatchObject({ pickups: [], payments: {} });
  });

  it('creates an order with a reference photo, quotes, approves, records the deposit, readies and hands over; a new session reads the same rows', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:photo-1') }));
    const { backend, orders } = service();
    const { store, port } = session(backend);
    await port.load('custom');
    const saved = await store.execute({ type: 'customTemplate.save', name: '케이크 주문서', fields: [field], idempotencyKey: 'template-1' });
    expect(saved).toMatchObject({ ok: true, value: { templateId: 'tpl-1' } });
    expect(backend.callsTo('POST', '/pos/custom-templates')[0].body).toEqual({ name: '케이크 주문서', fields: [field] });
    expect(model(store).templates.map(template => template.templateId)).toEqual(['tpl-1']);

    const create = { type: 'customOrder.create', templateId: 'tpl-1', answers: { note: '축하해요' }, channel: 'phone', memberId: null, guest: { name: '가나다', phone: '010-1234-5678' },
      productLabel: '45,000원 케이크', options: [], quantity: 1, request: '', desiredPickupAt: '2026-11-21T17:00', referencePhotoKeys: [PNG], idempotencyKey: 'order-1' } as const;
    const outcomes = await Promise.all([store.execute(create), store.execute(create)]);
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[0]).toMatchObject({ ok: true, value: { customOrderId: 'order-1', orderNo: 1 } });
    expect(outcomes[0]).toMatchObject({ ok: true, value: { receiptId: 'receipt-2' } });
    expect(backend.callsTo('POST', '/pos/custom-orders')).toHaveLength(1);
    const body = backend.callsTo('POST', '/pos/custom-orders')[0].body as { referencePhotoKeys: string[]; expectedRevision: number };
    expect(body.referencePhotoKeys).toEqual(['photo-1']);
    expect(JSON.stringify(body)).not.toContain('data:image');
    expect(body.expectedRevision).toBe(1);
    expect(backend.callsTo('POST', '/files')).toHaveLength(1);
    const customOrderId = (outcomes[0] as { value: { customOrderId: string } }).value.customOrderId;

    expect(await store.execute({ type: 'customOrder.quote', customOrderId, quoteAmount: 45000, proposedPickupAt: '2026-11-21T17:00', idempotencyKey: 'quote-1' })).toMatchObject({ ok: true });
    expect(backend.callsTo('POST', `/pos/custom-orders/${customOrderId}/transitions`)[0].body).toEqual({ type: 'customOrder.quote', quoteAmount: 45000, proposedPickupAt: '2026-11-21T17:00', expectedRevision: 1 });
    expect(model(store).orders[0]).toMatchObject({ stage: 'approval_pending', quoteAmount: 45000, orderNo: 1 });

    const approved = await store.execute({ type: 'customOrder.recordDecision', customOrderId, quoteRevision: 1, decision: 'approved', paymentTiming: 'advance', idempotencyKey: 'decision-1' });
    expect(approved).toMatchObject({ ok: true, value: { pickupReservationId: 'pickup-1' } });
    expect(model(store).orders[0]).toMatchObject({ stage: 'payment_pending', confirmedPickupAt: '2026-11-21T17:00', pickup: { reservationId: 'pickup-1', status: 'confirmed' } });

    const paid = await store.execute({ type: 'customOrder.recordPayment', customOrderId, quoteId: 'quote-token', allocations: [{ kind: 'method', method: 'cash', amount: 45000 }], expectedRevision: 3, idempotencyKey: 'pay-1' });
    expect(paid).toMatchObject({ ok: true, value: { settlementId: 'settlement-1' } });
    expect(backend.callsTo('POST', `/pos/custom-orders/${customOrderId}/payments`)[0].body).toEqual({ quoteId: 'quote-token', allocations: [{ kind: 'method', method: 'cash', amount: 45000 }], expectedRevision: 3 });
    expect(model(store).orders[0].payment).toMatchObject({ status: 'paid', amountSettled: 45000, realDeposits: 45000 });

    await store.execute({ type: 'customOrder.setStage', customOrderId, nextStage: 'in_production', idempotencyKey: 'stage-1' });
    await store.execute({ type: 'customOrder.setStage', customOrderId, nextStage: 'production_complete', idempotencyKey: 'stage-2' });
    const picked = await store.execute({ type: 'customOrder.receive', customOrderId, idempotencyKey: 'receive-1' });
    expect(picked).toMatchObject({ ok: true, value: { recognitionId: 'recognition-1' } });
    expect(backend.callsTo('POST', `/pos/custom-orders/${customOrderId}/transitions`).at(-1)!.body).toMatchObject({ type: 'customOrder.receive', confirmed: true });
    expect(orders[0].stage).toBe('received_by_customer');

    const next = session(backend);
    await next.port.load('custom');
    expect(model(next.store).orders[0]).toMatchObject({ customOrderId, stage: 'received_by_customer', referencePhotoKeys: ['photo-1'], payment: { status: 'paid' } });
    expect(selectCustomOrderRead(next.store.getSnapshot()).tables.reservation.filter(row => row.kind === 'pickup')).toHaveLength(1);
  });

  it('moves a pickup through the pickup route with the order revision and refuses a stale one', async () => {
    const { backend } = service();
    const { store, port } = session(backend);
    await port.load('custom');
    await store.execute({ type: 'customTemplate.save', name: '주문서', fields: [field], idempotencyKey: 't' });
    const created = await store.execute({ type: 'customOrder.create', templateId: 'tpl-1', answers: { note: 'a' }, channel: 'visit', memberId: null, guest: { name: '가나', phone: '01012345678' },
      productLabel: '쿠키', options: [], quantity: 1, request: '', referencePhotoKeys: [], desiredPickupAt: '2026-11-21T15:00', idempotencyKey: 'o' });
    const customOrderId = (created as { value: { customOrderId: string } }).value.customOrderId;
    await store.execute({ type: 'customOrder.quote', customOrderId, quoteAmount: 10000, proposedPickupAt: '2026-11-21T15:00', idempotencyKey: 'q' });
    await store.execute({ type: 'customOrder.recordDecision', customOrderId, quoteRevision: 1, decision: 'approved', paymentTiming: 'on_pickup', idempotencyKey: 'd' });
    const reservationId = model(store).orders[0].pickup!.reservationId;
    const moved = await store.execute({ type: 'pickup.reschedule', reservationId, date: '2026-11-21', time: '18:00', idempotencyKey: 'move' });
    expect(moved).toMatchObject({ ok: true });
    expect(backend.callsTo('POST', `/pos/custom-pickups/${reservationId}/transitions`)[0].body).toEqual({ type: 'pickup.reschedule', date: '2026-11-21', time: '18:00', expectedRevision: 3 });
    expect(model(store).orders[0].pickup).toMatchObject({ time: '18:00' });
    const reads = backend.callsTo('GET', '/pos/custom-orders').length;
    // Another tab changed the order meanwhile: this press is refused with no effect, and the rows are re-read.
    backend.on('POST', `/pos/custom-pickups/${reservationId}/transitions`, () => reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' }));
    expect(await store.execute({ type: 'pickup.cancel', reservationId, idempotencyKey: 'cancel' })).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'STALE_REVISION' });
    expect(backend.callsTo('GET', '/pos/custom-orders').length).toBeGreaterThan(reads);
    // The move bumped the order revision to 4; the cancel is sent against what the browser last read.
    expect(backend.callsTo('POST', `/pos/custom-pickups/${reservationId}/transitions`).at(-1)!.body).toEqual({ type: 'pickup.cancel', confirmed: true, expectedRevision: 4 });
  });

  it('keeps a missing quote revision from sending a write and sends the template undo to the custom receipt route', async () => {
    const { backend } = service();
    const { store, port } = session(backend);
    await port.load('custom');
    expect(await store.execute({ type: 'customOrder.quote', customOrderId: 'unknown', quoteAmount: 1000, proposedPickupAt: '2026-11-21T15:00', idempotencyKey: 'q' }))
      .toMatchObject({ ok: false, reason: 'STALE_REVISION' });
    expect(backend.callsTo('POST', /transitions/)).toHaveLength(0);
    const saved = await store.execute({ type: 'customTemplate.save', name: '주문서', fields: [field], idempotencyKey: 't' });
    if (!saved.ok || !saved.undoToken) throw Error('the template save has no undo');
    expect(await port.undo(saved.undoToken)).toMatchObject({ ok: true });
    expect(backend.callsTo('POST', '/pos/custom-receipts/receipts/receipt-1/undo')).toHaveLength(1);
  });

  it('clears every custom row when access ends', async () => {
    const { backend } = service();
    const { store, port } = session(backend);
    await store.execute({ type: 'customTemplate.save', name: '주문서', fields: [field], idempotencyKey: 't' }).catch(() => undefined);
    await port.load('custom');
    expect(model(store).templates).toHaveLength(1);
    backend.on('GET', '/pos/custom-templates', () => reply(403, { code: 'STORE_FORBIDDEN' }));
    await port.retry('custom');
    const cleared = store.getSnapshot().tables;
    expect(cleared.realCustom).toBeUndefined();
    expect(cleared.customOrder).toEqual([]);
    expect(cleared.customTemplate).toEqual([]);
  });
});
