import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../../../infra/http.ts';
import { allowWorkloadReads, briefingReadPaths } from '../../../../packages/contracts/workload-read.ts';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import type { Booking } from '../../../../packages/naver/contracts/pn02/wire.ts';
import { createNaverTransport } from '../../../../packages/naver/transport/index.ts';
import { reserveClaim, withCustomerStore } from '../../claims.ts';
import { createCustomerNaver } from '../../naver/index.ts';
import { registerCalendarStaffRoutes } from '../07/routes.ts';
import { upsertBookingCandidate } from './records.ts';
import { bookingPosProjectionHandlers } from './projection.ts';
import { registerBookingRoutes, type BookingNaver } from './routes.ts';

const pool = dbPool('customer', 'runtime', 'test');
const gatewayToken = randomBytes(32).toString('hex');
const briefingToken = randomBytes(32).toString('hex');
const actorId = randomUUID();
const tableId = randomUUID();
const day = '2026-11-23';
const now = () => new Date('2026-11-23T04:00:00Z');
const linked: Booking = { bookingNumber: 'B-001', usageAt: day + 'T18:00:00+09:00', product: '저녁', status: 'requested',
  maskedName: '김*', maskedPhone: '010-****-0123', npayLinked: true, paymentAmount: 4500 };
let naverBooking = linked;
let providerCalls = 0;
let cancellation: unknown;

function app(naver?: BookingNaver, clock = now) {
  const service = createApp('customer', async () => {}, false);
  allowWorkloadReads(service, gatewayToken, briefingToken, '/internal/v1/customer/stores/:storeId', briefingReadPaths.customer, []);
  registerCalendarStaffRoutes(service, pool, gatewayToken, { now });
  registerBookingRoutes(service, pool, { gatewayToken, now: clock, readTables: async () => ({
    enabled: true, tables: [{ tableId, number: 1, label: 'T1', seats: 4 }],
  }), naver: naver ?? {
    bookings: async () => [naverBooking],
    booking: async () => naverBooking,
    bookingProducts: async () => [],
    bookingCommand: async (_ctx, card, _ref, command) => {
      providerCalls++;
      if (command.kind === 'cancel') {
        expect(card.extraConfirmed).toBe(true);
        cancellation = command;
      }
      naverBooking = { ...naverBooking, status: command.kind === 'cancel' ? 'cancelled' : 'confirmed' };
      return naverBooking;
    },
    smartCallSummary: async (_ctx, startDate, endDate) => ({
      period: { startDate, endDate }, channels: ['네이버 검색'],
      daily: [{ date: day, totalCalls: 1, connectedCalls: 0, arsCalls: 0, missedCalls: 1, busyCalls: 0,
        averageDurationSeconds: null, callsAtLeastTenSeconds: 0 }],
    }),
  } });
  return service;
}

const service = app();
const headers = (storeId: string, key: string = randomUUID(), actor = actorId) => ({
  authorization: `Bearer ${gatewayToken}`, 'x-navis-store-id': storeId, 'x-navis-user-id': actor,
  'x-navis-store-role': 'owner', 'idempotency-key': key,
});
const path = (storeId: string, tail: string) => `/internal/v1/customer/stores/${storeId}${tail}`;
const request = (store: string, method: 'GET' | 'POST' | 'PATCH', tail: string, payload?: object, key?: string) => service.inject({
  method, url: path(store, tail), headers: headers(store, key), payload,
});
const visit = (name: string, time = '15:00') => ({ guest: { name }, date: day, time, partySize: 4, tableChoice: 'auto' });

it('returns only reservation facts to the authenticated briefing workload', async () => {
  const store = randomUUID();
  const payload = { ...visit('Fixture Guest'), guest: { name: 'Fixture Guest', phone: '01012345678' } };
  expect((await request(store, 'POST', '/reservations', payload)).statusCode).toBe(201);
  const tail = '/reservations?source=local';
  expect((await request(store, 'GET', tail)).json().items[0]).toMatchObject({ guestName: payload.guest.name });
  const response = await service.inject({ url: path(store, tail), headers: { ...headers(store), authorization: `Bearer ${briefingToken}` } });
  expect(response.statusCode).toBe(200);
  expect(response.json().items).toEqual([{ reservationId: expect.any(String), date: day, time: '15:00',
    status: 'confirmed', partySize: 4, revision: 1 }]);
  const detail = '/reservations/' + response.json().items[0].reservationId;
  const canceled = (await request(store, 'POST', detail + '/transitions',
    { type: 'booking.cancel', expectedRevision: 1, confirmed: true })).json();
  expect((await request(store, 'GET', detail)).json()).toMatchObject({ status: 'canceled', phone: null });
  await request(store, 'POST', '/booking/receipts/' + canceled.receiptId + '/undo', {});
  expect((await request(store, 'GET', detail)).json()).toMatchObject({ status: 'confirmed', phone: null });
});

beforeAll(() => runMigrations('customer', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test'), 30_000);
afterAll(async () => {
  await service.close();
  await pool.end();
});

it('serializes table contention, re-reads a changed visit and updates calendar atomically', async () => {
  const store = randomUUID(), key = randomUUID();
  const [one, two] = await Promise.all([
    request(store, 'POST', '/reservations', visit('첫 손님'), key),
    request(store, 'POST', '/reservations', visit('다른 손님')),
  ]);
  expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
  expect([one.json().status, two.json().status].sort()).toEqual(['confirmed', 'needs-check']);
  expect((await request(store, 'POST', '/reservations', visit('첫 손님'), key)).json()).toEqual(one.json());
  expect((await request(store, 'POST', '/reservations', visit('재시도'), key)).json()).toMatchObject({ reason: 'IDEMPOTENCY_MISMATCH' });
  const confirmed = one.json().status === 'confirmed' ? one.json() : two.json();
  const detail = '/reservations/' + confirmed.reservationId;
  const revised = await request(store, 'PATCH', detail, { patch: { time: '17:00' }, expectedRevision: 1 });
  expect(revised.json()).toMatchObject({ status: 'confirmed', revision: 2, tableId });
  expect((await request(store, 'PATCH', detail, { patch: { time: '18:00' }, expectedRevision: 1 })).json())
    .toMatchObject({ reason: 'STALE_REVISION' });

  const reloaded = app();
  try {
    const read = await reloaded.inject({ url: path(store, detail), headers: headers(store, undefined, randomUUID()) });
    expect(read.json()).toMatchObject({ revision: 2, time: '17:00', tableId });
    expect((await request(store, 'GET', '/calendar/projections')).json().items).toEqual([
      expect.objectContaining({ sourceId: confirmed.reservationId, time: '17:00' }),
    ]);
    expect((await request(randomUUID(), 'GET', detail)).statusCode).toBe(404);
  } finally {
    await reloaded.close();
  }
  const canceled = { type: 'booking.cancel', expectedRevision: 2 };
  expect((await request(store, 'POST', detail + '/transitions', canceled)).json()).toMatchObject({ reason: 'CONFIRMATION_REQUIRED' });
  const canceledReceipt = (await request(store, 'POST', detail + '/transitions', { ...canceled, confirmed: true })).json();
  expect(canceledReceipt).toMatchObject({ revision: 3, status: 'canceled', undoUntil: expect.any(String) });
  expect((await request(store, 'POST', '/booking/receipts/' + canceledReceipt.receiptId + '/undo', {})).json())
    .toMatchObject({ status: 'confirmed', revision: 4 });
  const { rows } = await withCustomerStore(pool, store, db => db.query(
    'SELECT payload FROM customer.outbox WHERE event_type = $1 ORDER BY store_seq', ['customer.reservation_changed.v1']));
  expect(rows).toHaveLength(5);
  expect(JSON.stringify(rows)).not.toMatch(/첫 손님|다른 손님/);
});

it('keeps AiCall intake in a scoped pending candidate until explicit owner confirmation', async () => {
  const store = randomUUID();
  const input = { storeId: store, dedupeKey: 'a'.repeat(64), usageAt: day + 'T16:00:00+09:00', partySize: 2, contact: '01000000123' };
  await Promise.all([upsertBookingCandidate(pool, input), upsertBookingCandidate(pool, input)]);
  const { items: [candidate] } = (await request(store, 'GET', '/reservation-suggestions')).json();
  expect(candidate).toMatchObject({ status: 'pending', partySize: 2, phoneMasked: '010-****-0123', revision: 1 });
  expect(JSON.stringify(candidate)).not.toContain(input.contact);
  expect((await request(store, 'GET', '/reservations?source=local')).json().items).toEqual([]);
  const tail = '/reservations/' + candidate.suggestionId + '/transitions';
  const denied = await service.inject({ method: 'POST', url: path(store, tail), payload: { type: 'booking.confirm', expectedRevision: 1 },
    headers: { ...headers(store), 'x-navis-store-role': 'viewer' } });
  expect(denied.statusCode).toBe(403);
  const accepted = (await request(store, 'POST', tail, { type: 'booking.confirm', expectedRevision: 1 })).json();
  expect(accepted).toMatchObject({ status: 'confirmed', reservationId: candidate.suggestionId });
  expect((await request(store, 'GET', '/reservation-suggestions')).json().items[0]).toMatchObject({ status: 'accepted' });
  expect((await request(store, 'GET', '/call-records')).json().items).toEqual([
    expect.objectContaining({ date: day, totalCalls: 1, missedCalls: 1 }),
  ]);
});

it('projects the linked POS order once, removes it from active calendar, and accepts a replay', async () => {
  const storeId = randomUUID(), billId = randomUUID(), orderId = randomUUID();
  const created = (await request(storeId, 'POST', '/reservations', visit('가상 예약자', '13:15'))).json();
  const reservationId = created.reservationId;
  const claim = await withCustomerStore(pool, storeId, db => reserveClaim(db, storeId, 'reservation_first_order',
    { sourceId: reservationId, sourceVersion: created.revision, actorId, requestKey: randomUUID() }, day, now()));
  const envelope = { storeId, scopeKey: storeId, aggregateId: reservationId, eventId: randomUUID(),
    producer: 'pos' as const, schemaVersion: 1, storeSeq: '1', eventType: 'pos.reservation_order_linked.v1',
    occurredAt: now().toISOString(), payload: { claimId: claim.claimId, reservationId, sourceVersion: created.revision, billId, orderId, tableId } };
  const handler = bookingPosProjectionHandlers['pos.reservation_order_linked.v1'];
  await withCustomerStore(pool, storeId, db => handler(db, envelope));
  await withCustomerStore(pool, storeId, db => handler(db, envelope));
  expect((await request(storeId, 'GET', '/reservations/' + reservationId)).json()).toMatchObject({ status: 'completed', revision: 2 });
  expect((await request(storeId, 'GET', '/calendar/projections')).json().items).toEqual([]);
});

it.each([
  [day, '23:30', '2026-11-24T00:35', day, true],
  [day, '23:30', '2026-11-24T01:30', day, false],
  ['2026-11-24', '00:15', `${day}T23:44`, day, false],
  ['2026-11-24', '00:15', `${day}T23:45`, day, true],
  ['2026-11-24', '04:45', '2026-11-24T04:59', day, true],
  ['2026-11-24', '04:45', '2026-11-24T05:00', '2026-11-24', false],
  ['2026-11-24', '05:15', '2026-11-24T04:59', day, false],
  ['2026-11-24', '05:15', '2026-11-24T05:00', '2026-11-24', true],
] as const)('checks the first-order window for %s %s at %s (business date %s, claimable %s)', async (date, time, local, businessDate, allowed) => {
  const storeId = randomUUID();
  const response = await request(storeId, 'POST', '/reservations', { ...visit('영업일 예약', time), date });
  expect(response.statusCode).toBe(201);
  const { reservationId, revision } = response.json();
  const result = withCustomerStore(pool, storeId, db => reserveClaim(db, storeId, 'reservation_first_order',
    { sourceId: reservationId, sourceVersion: revision, actorId, requestKey: randomUUID() }, businessDate, new Date(`${local}:00+09:00`)));
  if (allowed) await expect(result).resolves.toMatchObject({ state: 'held', sourceId: reservationId });
  else await expect(result).rejects.toMatchObject({ status: 409, reason: 'RESERVATION_OUTSIDE_WINDOW' });
});

it('records an alternate time as an undoable candidate proposal without making a booking or a provider call', async () => {
  const storeId = randomUUID();
  await upsertBookingCandidate(pool, { storeId, dedupeKey: 'b'.repeat(64), usageAt: day + 'T16:00:00+09:00', partySize: 2 }, now());
  const suggestion = (await request(storeId, 'GET', '/reservation-suggestions?status=pending')).json().items[0];
  const proposed = (await request(storeId, 'POST', '/reservations/' + suggestion.suggestionId + '/transitions',
    { type: 'booking.propose', expectedRevision: 1, time: '17:00' })).json();
  expect(proposed).toMatchObject({ status: 'proposed', undoUntil: expect.any(String) });
  expect((await request(storeId, 'GET', '/reservation-suggestions')).json().items[0])
    .toMatchObject({ status: 'proposed', proposedTime: '17:00', time: '16:00', revision: 2 });
  expect((await request(storeId, 'GET', '/reservations?source=local')).json().items).toEqual([]);
  expect((await request(storeId, 'POST', '/booking/receipts/' + proposed.receiptId + '/undo', {})).json())
    .toMatchObject({ status: 'pending', revision: 3 });
});

it.each([
  ['confirmed', { type: 'amount', value: 4500 }],
  ['completed', { type: 'full' }],
  ['completed', { type: 'rate', value: 100 }],
  ['completed', { type: 'amount', value: 4500 }],
] as const)('requires second confirmation and valid refund terms for %s Npay bookings (%j)', async (status, refund) => {
  const store = randomUUID();
  naverBooking = { ...linked, status };
  const callsBefore = providerCalls;
  const { items: [booking] } = (await request(store, 'GET', '/reservations?date=' + day)).json();
  expect(booking).toMatchObject({ reservationId: 'naver-B-001', status, partySize: null,
    phone: status === 'confirmed' ? '010-****-0123' : null,
    actions: { change: false, confirm: false, cancel: true, cancelRequiresRefund: true, cancelUndoable: false },
    sourceMetadata: { npayLinked: true, bookingNumber: linked.bookingNumber, paymentAmount: 4500 } });
  const detail = '/reservations/' + encodeURIComponent(booking.reservationId);
  expect((await request(store, 'PATCH', detail, { patch: { time: '19:00' }, expectedRevision: booking.revision })).json())
    .toMatchObject({ reason: 'NPAY_LINKED_BOOKING' });
  const cancel = { type: 'booking.cancel', expectedRevision: booking.revision };
  expect((await request(store, 'POST', detail + '/transitions', cancel)).statusCode).toBe(409);
  expect((await request(store, 'POST', detail + '/transitions', { ...cancel, confirmed: true })).json())
    .toMatchObject({ reason: 'CANCEL_REASON_REQUIRED' });
  expect((await request(store, 'POST', detail + '/transitions',
    { ...cancel, confirmed: true, cancelReason: '방문 일정 변경', refund: { type: 'rate', value: 101 } })).statusCode).toBe(400);
  const reason = { ...cancel, confirmed: true, cancelReason: ' 방문 일정 변경 ' };
  expect((await request(store, 'POST', detail + '/transitions', { ...reason, refund, expectedRevision: booking.revision + 1 })).json())
    .toMatchObject({ reason: 'STALE_REVISION' });
  expect((await request(store, 'POST', detail + '/transitions', reason)).json()).toMatchObject({ reason: 'REFUND_REQUIRED' });
  expect((await request(store, 'POST', detail + '/transitions', { ...reason, refund: { type: 'amount', value: 4501 } })).json())
    .toMatchObject({ reason: 'INVALID_REFUND_TERMS' });
  expect(providerCalls).toBe(callsBefore);
  const key = randomUUID(), payload = { ...reason, refund };
  const reply = await request(store, 'POST', detail + '/transitions', payload, key);
  expect(reply.json()).toMatchObject({ status: 'canceled', undoable: false });
  expect(reply.json()).not.toHaveProperty('undoUntil');
  expect((await request(store, 'POST', detail + '/transitions', payload, key)).json()).toEqual(reply.json());
  expect(providerCalls).toBe(callsBefore + 1);
  expect(cancellation).toEqual({ kind: 'cancel', cancelReason: '방문 일정 변경', refund });
  expect((await request(store, 'GET', detail)).json()).toMatchObject({ status: 'canceled' });
  expect((await request(store, 'POST', '/booking/receipts/' + reply.json().receiptId + '/undo', {})).json())
    .toMatchObject({ reason: 'UNDO_UNAVAILABLE' });
});

it('keeps completed non-Npay NAVER bookings ineligible for cancellation', async () => {
  const store = randomUUID();
  naverBooking = { ...linked, status: 'completed', npayLinked: false, paymentAmount: undefined };
  const callsBefore = providerCalls;
  const detail = '/reservations/naver-' + linked.bookingNumber;
  const booking = (await request(store, 'GET', detail)).json();
  expect(booking.actions.cancel).toBe(false);
  expect((await request(store, 'POST', detail + '/transitions', {
    type: 'booking.cancel', expectedRevision: booking.revision, confirmed: true, cancelReason: '손님 요청',
  })).json()).toMatchObject({ reason: 'BOOKING_TRANSITION' });
  expect(providerCalls).toBe(callsBefore);
});

it('reuses the durable provider key after a lost response and records one confirmed effect', async () => {
  const storeId = randomUUID();
  let booking = { ...linked, npayLinked: false, paymentAmount: undefined };
  let remoteKey: string | null = null;
  let effects = 0;
  const binding = { grade: 'O', mode: 'fake', storeId, providerAccount: 'synthetic' } as const;
  const transport = createNaverTransport({ fakeOnly: true, async fetcher() { throw new Error('Network use in fake-only test'); }, bindings: [
    { ...binding, operation: 'pn02.bookings.read', method: 'GET', route: /\/partner-assumed\/v1\/bookings\/B-001/,
      handler: () => Response.json(booking) },
    { ...binding, operation: 'pn02.bookings.confirm', method: 'POST', route: /\/partner-assumed\/v1\/bookings\/B-001\/confirm/,
      handler(scope) {
        const key = scope.headers.get('idempotency-key');
        expect(key).toBeTruthy();
        if (remoteKey) {
          expect(key).toBe(remoteKey);
          return Response.json(booking);
        }
        remoteKey = key;
        booking = { ...booking, status: 'confirmed' };
        effects++;
        throw new Error('Synthetic lost response after commit');
      } },
  ] });
  const service = app(createCustomerNaver(transport));
  try {
    const url = path(storeId, '/reservations/naver-B-001');
    const current = await service.inject({ url, headers: headers(storeId) });
    expect(current.statusCode).toBe(200);
    const command = { method: 'POST' as const, url: url + '/transitions', headers: headers(storeId), payload: {
      type: 'booking.confirm', expectedRevision: current.json().revision,
    } };
    const accepted = await service.inject(command);
    expect(accepted.json()).toMatchObject({ reason: 'BOOKING_PROVIDER_OUTCOME_UNKNOWN' });
    const newSession = { ...command, headers: headers(storeId, randomUUID(), randomUUID()) };
    expect((await service.inject(newSession)).json()).toMatchObject({ reason: 'STALE_REVISION' });
    const recovered = (await service.inject(command)).json();
    expect(recovered).toMatchObject({ status: 'confirmed' });
    expect((await service.inject(command)).json()).toEqual(recovered);
    expect(effects).toBe(1);
  } finally {
    await service.close();
  }
});

it('expires an unobserved provider attempt after a fresh read and keeps cancellation confirmation', async () => {
  const store = randomUUID();
  let clock = now();
  let booking = { ...linked, npayLinked: false, paymentAmount: undefined };
  const writes: string[] = [];
  const fake = app({
    bookings: async () => [booking],
    booking: async () => booking,
    bookingCommand: async (_scope, card, _ref, effect) => {
      writes.push(card.key);
      if (effect.kind === 'confirm') throw new Error('Synthetic timeout before applying the command');
      expect(card.extraConfirmed).toBe(true);
      booking = { ...booking, status: 'cancelled' };
      return booking;
    },
    bookingProducts: async () => [],
    smartCallSummary: async () => { throw new Error('Unexpected SmartCall read'); },
  }, () => clock);
  try {
    const url = path(store, '/reservations/naver-B-001');
    const expectedRevision = (await fake.inject({ url, headers: headers(store) })).json().revision;
    const transition = (payload: object, requestHeaders = headers(store, randomUUID(), randomUUID())) => fake.inject({
      method: 'POST', url: url + '/transitions', headers: requestHeaders, payload,
    });
    const original = { type: 'booking.confirm', expectedRevision };
    const originalHeaders = headers(store, randomUUID(), randomUUID());
    expect((await transition(original, originalHeaders)).json())
      .toMatchObject({ reason: 'BOOKING_PROVIDER_OUTCOME_UNKNOWN' });
    const cancel = { type: 'booking.cancel', expectedRevision, cancelReason: '손님 요청' };
    expect((await transition({ ...cancel, confirmed: true })).json()).toMatchObject({ reason: 'BOOKING_PROVIDER_PENDING' });
    clock = new Date(clock.getTime() + 5 * 60_000);
    expect((await transition(cancel)).json()).toMatchObject({ reason: 'CONFIRMATION_REQUIRED' });
    expect((await transition(original, originalHeaders)).json()).toMatchObject({ reason: 'BOOKING_PROVIDER_RETRY' });
    expect(writes).toHaveLength(1);
    expect((await transition({ ...cancel, confirmed: true })).json()).toMatchObject({ status: 'canceled' });
    expect(new Set(writes).size).toBe(2);
  } finally {
    await fake.close();
  }
});

it('keeps only the latest pickup projection and never treats a pickup as a party', async () => {
  const storeId = randomUUID(), orderId = randomUUID(), reservationId = randomUUID();
  const handler = bookingPosProjectionHandlers['pos.custom_pickup_changed.v1'];
  for (const [revision, status] of [[2, 'completed'], [1, 'confirmed']] as const) {
    const event = { storeId, scopeKey: storeId, aggregateId: orderId, eventId: randomUUID(), producer: 'pos', schemaVersion: 1,
      storeSeq: String(revision), eventType: 'pos.custom_pickup_changed.v1', occurredAt: now().toISOString(), payload: { revision,
      pickupProjection: { kind: 'pickup', reservationId, customOrderId: orderId, date: day, time: '15:00', status, updatedAt: now().toISOString() } } };
    await withCustomerStore(pool, storeId, db => handler(db, event as Parameters<typeof handler>[1]));
  }
  expect((await request(storeId, 'GET', '/reservation-pickups')).json().items).toEqual([
    expect.objectContaining({ reservationId, customOrderId: orderId, status: 'completed', revision: 2 }),
  ]);
  expect((await request(storeId, 'GET', '/reservations?source=local')).json().items).toEqual([]);
});
