import { describe, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../db/store';
import { selectReservations } from '../../derive/reservations';
import { createRealPort } from '../00';
import { bookingAdapter } from './adapter';
import { asOf, bookingService, candidate, naver, undoUntil, visit } from './testing';

const day = '2026-11-21';
function session(service: ReturnType<typeof bookingService>) {
  const store = createWidgetDataStore(undefined, { runId: 'booking-http' });
  const port = createRealPort({ store, source: domain => domain === 'booking' ? 'http' : 'fixture', adapters: [bookingAdapter], fetch: service.backend.fetch, sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  return { store, port };
}
const rows = (store: ReturnType<typeof createWidgetDataStore>, date = day) => selectReservations(store.getSnapshot(), { date }).rows;
const transitionsOf = (service: ReturnType<typeof bookingService>, id: string) => service.backend.callsTo('POST', `/reservations/${encodeURIComponent(id)}/transitions`);
const create = { type: 'booking.create', guest: { name: '새 손님', phone: '01012345678' }, date: day, time: '20:00', partySize: 3, request: '창가', tableChoice: 'auto', idempotencyKey: 'create-1' } as const;

describe('booking over HTTP (B06)', () => {
  it('replaces the seed with the service rows and shows nothing it did not return', async () => {
    const service = bookingService();
    const { store, port } = session(service);
    expect((await port.load('booking')).status).toBe('ready');
    expect(rows(store)).toEqual([]);
    expect(store.getSnapshot().tables.callLog).toEqual([]);
    expect(store.getSnapshot().tables.realBooking).toMatchObject({ meta: {}, calls: [], products: [] });
  });

  it('asks for a bounded window and projects visit rows, a NAVER booking without a party and pending AiCall candidates', async () => {
    const service = bookingService({
      reservations: [visit({ reservationId: 'rv-1', tableId: 'T2', request: '아기 의자' }), naver('1001'), naver('1002', { status: 'confirmed', partySize: 2, sourceMetadata: { kind: 'naver', bookingNumber: '1002', product: '런치', npayLinked: true } })],
      suggestions: [candidate('sg-1'), candidate('sg-2', { status: 'accepted', reservationId: 'rv-1' }), candidate('sg-3', { status: 'declined' })],
      calls: [{ date: day, totalCalls: 5, connectedCalls: 3, arsCalls: 1, missedCalls: 1, busyCalls: 0, averageDurationSeconds: 42, callsAtLeastTenSeconds: 3 }],
      products: [{ name: '저녁 코스' }],
    });
    const { store, port } = session(service);
    await port.load('booking');
    const query = service.backend.callsTo('GET', '/reservations')[0].query;
    expect(query).toMatchObject({ startDate: '2026-10-18', endDate: '2027-02-15', limit: '200' });
    expect(service.backend.callsTo('GET', '/reservation-suggestions')[0].query.status).toBeUndefined();
    const list = rows(store);
    expect(list.map(row => row.reservationId).sort()).toEqual(['naver-1001', 'naver-1002', 'rv-1', 'sg-1']);
    expect(list.find(row => row.reservationId === 'rv-1')).toMatchObject({ tableId: 'T2', status: 'confirmed', source: 'direct', name: { raw: '김하나' } });
    // a NAVER booking without a party is never given one; it holds no seat
    expect(list.find(row => row.reservationId === 'naver-1001')).toMatchObject({ partySize: 0, status: 'needs-check', canConfirm: true, tableId: null });
    expect(selectReservations(store.getSnapshot(), { date: day }).partyTotal).toBe(2 + 0 + 2 + 4);
    // a pending candidate is a waiting phone request; accepted and declined ones are not rows
    expect(list.find(row => row.reservationId === 'sg-1')).toMatchObject({ source: 'phone_ai', status: 'needs-check', partySize: 4, canConfirm: true, phone: { raw: '010-****-4321' } });
    expect(list.some(row => row.reservationId === 'sg-2' || row.reservationId === 'sg-3')).toBe(false);
    const real = store.getSnapshot().tables.realBooking!;
    // the service's eligibility travels with the row: the widget draws only what it says
    expect(real.meta['naver-1001']).toEqual({ origin: 'naver', bookingNumber: '1001', product: '저녁 코스', npayLinked: false, partyKnown: false, revision: 1,
      actions: { change: true, confirm: true, cancel: true, cancelRequiresRefund: false, cancelUndoable: false } });
    expect(real.meta['naver-1002'].actions).toEqual({ change: false, confirm: false, cancel: true, cancelRequiresRefund: true, cancelUndoable: false });
    expect(real.meta['naver-1002']).toMatchObject({ npayLinked: true, partyKnown: true });
    expect(real.meta['sg-1']).toMatchObject({ origin: 'call', candidate: { phoneMasked: '010-****-4321' } });
    // SmartCall is aggregates only: the daily rows, their period and channels, nothing per call
    expect(real.calls).toEqual([{ date: day, totalCalls: 5, connectedCalls: 3, arsCalls: 1, missedCalls: 1, busyCalls: 0, averageDurationSeconds: 42, callsAtLeastTenSeconds: 3 }]);
    expect(real.callPeriod).toEqual({ startDate: day, endDate: day });
    expect(real.callChannels).toEqual(['네이버 검색']);
    expect(real.products).toEqual([{ name: '저녁 코스' }]);
    expect(store.getSnapshot().tables.callLog).toEqual([]);
  });

  it('shows the POS table label and keeps the service UUID for edits and claims', async () => {
    const uuid = '3f6c0a52-5b0e-4f5c-9c5b-0d6b8a1a2b3c', other = '9a1d3c52-1b0e-4f5c-9c5b-0d6b8a1a2b3d';
    const service = bookingService({
      reservations: [visit({ reservationId: 'rv-1', tableId: uuid, revision: 6 }), visit({ reservationId: 'rv-2', tableId: other, time: '19:00' })],
      tables: [{ tableId: uuid, label: '창가 1', seats: 4, layoutTableId: 'T1' }],
    });
    const { store, port } = session(service);
    await port.load('booking');
    expect(service.backend.callsTo('GET', '/pos/tables')).toHaveLength(1);
    expect(service.backend.callsTo('GET', '/pos/tables')[0].query.limit).toBe('50');
    const list = rows(store);
    // the row keeps the layout id the POS table map and the booking selects speak; the UUID never reaches a screen
    expect(list.find(row => row.reservationId === 'rv-1')?.tableId).toBe('T1');
    const { meta } = store.getSnapshot().tables.realBooking!;
    expect(meta['rv-1']).toMatchObject({ tableUuid: uuid, tableLabel: '창가 1', revision: 6 });
    // a UUID the POS list does not know keeps its UUID for commands but has no label to show
    expect(meta['rv-2']).toEqual(expect.objectContaining({ tableUuid: other }));
    expect(meta['rv-2'].tableLabel).toBeUndefined();
  });

  it('still shows the bookings, as partial, when the POS table list cannot be read', async () => {
    const service = bookingService({ reservations: [visit({ reservationId: 'rv-1' })] });
    service.backend.on('GET', '/pos/tables', () => ({ status: 503, body: { code: 'SERVICE_UNAVAILABLE' } }));
    const { store, port } = session(service);
    const state = await port.load('booking');
    expect(rows(store).map(row => row.reservationId)).toEqual(['rv-1']);
    expect(state.complete).toBe(false);
  });

  it('keeps custom-order pickups that other domains own and drops every fixture visit', async () => {
    const service = bookingService({ reservations: [visit({ reservationId: 'rv-1' })] });
    const { store, port } = session(service);
    const pickups = store.getSnapshot().tables.reservation.filter(row => row.kind === 'pickup');
    expect(pickups.length).toBeGreaterThan(0);
    await port.load('booking');
    const after = store.getSnapshot().tables.reservation;
    expect(after.filter(row => row.kind === 'pickup')).toEqual(pickups);
    expect(after.filter(row => row.kind !== 'pickup').map(row => row.reservationId)).toEqual(['rv-1']);
  });

  it('keeps the bookings when a side read fails and says the list is partial', async () => {
    const service = bookingService({ reservations: [visit({ reservationId: 'rv-1' })] });
    service.backend.on('GET', '/booking-products', () => ({ status: 503, body: { code: 'SERVICE_UNAVAILABLE' } }));
    const { store, port } = session(service);
    const state = await port.load('booking');
    expect(rows(store).map(row => row.reservationId)).toEqual(['rv-1']);
    expect(state.complete).toBe(false);
  });

  it('creates a booking once with its key, shows the server table decision, and a new session reads the same row', async () => {
    const service = bookingService();
    const { store, port } = session(service);
    await port.load('booking');
    const outcomes = await Promise.all([store.execute(create), store.execute(create)]);
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[0]).toMatchObject({ ok: true, value: { resourceId: 'rv-1' }, undoToken: expect.stringContaining('real-undo:') });
    const calls = service.backend.callsTo('POST', '/reservations');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('idempotency-key')).toBe('create-1');
    expect(calls[0].body).toEqual({ guest: { name: '새 손님', phone: '01012345678' }, date: day, time: '20:00', partySize: 3, request: '창가', tableChoice: 'auto' });
    expect(rows(store).map(row => row.reservationId)).toEqual(['rv-1']);

    const next = session(service);
    await next.port.load('booking');
    expect(rows(next.store)[0]).toMatchObject({ reservationId: 'rv-1', partySize: 3, name: { raw: '새 손님' } });
  });

  it('refuses a similar booking with the existing one named, and books it only when the owner insists', async () => {
    const service = bookingService({ reservations: [visit({ reservationId: 'rv-seed', guestName: '새 손님', time: '20:00' })] });
    const { store, port } = session(service);
    await port.load('booking');
    const refused = await store.execute(create);
    expect(refused).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'BOOKING_DUPLICATE', messageKey: 'data.management.error.BOOKING_DUPLICATE', details: { reservationId: 'rv-seed' } });
    expect(rows(store)).toHaveLength(1);
    const forced = await store.execute({ ...create, idempotencyKey: 'create-2', confirmDuplicate: true });
    expect(forced).toMatchObject({ ok: true });
    expect(service.backend.callsTo('POST', '/reservations')[1].body).toMatchObject({ confirmDuplicate: true });
    expect(rows(store)).toHaveLength(2);
  });

  it('turns an invalid party into a field error without a receipt', async () => {
    const service = bookingService();
    const { port, store } = session(service);
    await port.load('booking');
    expect(await store.execute({ ...create, partySize: 0 })).toMatchObject({ ok: false, code: 'VALIDATION', reason: 'PARTY_INVALID', field: 'partySize', messageKey: 'data.management.error.PARTY_INVALID' });
  });

  it('confirms a NAVER booking with its revision through the transition route; the result is the re-read row and has no undo', async () => {
    const service = bookingService({ reservations: [naver('1001', { revision: 4 })] });
    const { store, port } = session(service);
    await port.load('booking');
    const result = await store.execute({ type: 'booking.confirm', reservationId: 'naver-1001' });
    expect(result).toMatchObject({ ok: true, value: { revision: 5, resourceId: 'naver-1001' } });
    expect((result as { undoToken?: string }).undoToken).toBeUndefined();
    const call = service.backend.callsTo('POST', '/reservations/naver-1001/transitions')[0];
    expect(call.body).toEqual({ type: 'booking.confirm', expectedRevision: 4 });
    expect(rows(store).find(row => row.reservationId === 'naver-1001')).toMatchObject({ status: 'confirmed' });
    expect(service.backend.callsTo('GET', '/reservations')).toHaveLength(2);
  });

  it('cancels only with the extra confirmation flag; a local cancel can be undone before its deadline', async () => {
    const service = bookingService({ reservations: [visit({ reservationId: 'rv-1', revision: 2 })] });
    const { store, port } = session(service);
    await port.load('booking');
    const cancelled = await store.execute({ type: 'booking.cancel', reservationId: 'rv-1' });
    expect(cancelled).toMatchObject({ ok: true, undoToken: expect.stringContaining('real-undo:') });
    expect(service.backend.callsTo('POST', '/reservations/rv-1/transitions')[0].body).toEqual({ type: 'booking.cancel', confirmed: true, expectedRevision: 2 });
    expect(rows(store)[0].status).toBe('canceled');
    const undone = await port.undo((cancelled as { undoToken: string }).undoToken);
    expect(undone).toMatchObject({ ok: true });
    expect(service.undone).toHaveLength(1);
    expect(rows(store)[0].status).toBe('confirmed');
  });

  describe('NAVER cancellation terms (D-347 PN02)', () => {
    const linked = (patch: { paymentAmount?: number; status?: 'confirmed' | 'needs-check' } = {}) => naver('1002', { status: patch.status ?? 'confirmed', partySize: 2, revision: 3,
      sourceMetadata: { kind: 'naver', bookingNumber: '1002', product: '런치', npayLinked: true, ...(patch.paymentAmount === undefined ? {} : { paymentAmount: patch.paymentAmount }) } });
    const cancel = (service: ReturnType<typeof bookingService>) => transitionsOf(service, 'naver-1002');

    it('needs the owner-entered reason and sends nothing without it', async () => {
      const service = bookingService({ reservations: [naver('1001')] });
      const { store, port } = session(service);
      await port.load('booking');
      for (const cancelReason of [undefined, '', '   ']) {
        expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1001', ...(cancelReason === undefined ? {} : { cancelReason }) }))
          .toMatchObject({ ok: false, code: 'VALIDATION', reason: 'CANCEL_REASON_REQUIRED', field: 'cancelReason' });
      }
      expect(transitionsOf(service, 'naver-1001')).toHaveLength(0);
      expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1001', cancelReason: ' 사정이 생겼어요 ' })).toMatchObject({ ok: true });
      expect(transitionsOf(service, 'naver-1001')[0].body).toEqual({ type: 'booking.cancel', confirmed: true, cancelReason: '사정이 생겼어요', expectedRevision: 1 });
    });

    it('requires refund terms for a confirmed Npay-linked booking and forwards them as entered', async () => {
      for (const refund of [{ type: 'full' }, { type: 'rate', value: 50 }, { type: 'amount', value: 12000 }] as const) {
        const service = bookingService({ reservations: [linked({ paymentAmount: 30000 })] });
        const { store, port } = session(service);
        await port.load('booking');
        expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1002', cancelReason: '휴무' }))
          .toMatchObject({ ok: false, reason: 'REFUND_TERMS_REQUIRED', field: 'refund' });
        expect(cancel(service)).toHaveLength(0);
        expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1002', cancelReason: '휴무', refund })).toMatchObject({ ok: true });
        expect(cancel(service)[0].body).toEqual({ type: 'booking.cancel', confirmed: true, cancelReason: '휴무', refund, expectedRevision: 3 });
      }
    });

    it('refuses malformed terms before any request, and an amount above the payment amount or without one', async () => {
      const service = bookingService({ reservations: [linked({ paymentAmount: 30000 })] });
      const { store, port } = session(service);
      await port.load('booking');
      for (const refund of [{ type: 'rate', value: 101 }, { type: 'rate', value: -1 }, { type: 'amount', value: 1.5 }, { type: 'amount', value: -5 }, { type: 'amount', value: 30001 }, { type: 'full', value: 3 }] as const) {
        expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1002', cancelReason: '휴무', refund: refund as never }))
          .toMatchObject({ ok: false, reason: 'INVALID_REFUND_TERMS', field: 'refund' });
      }
      expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1002', cancelReason: '휴무', refund: { type: 'amount', value: 30000 } })).toMatchObject({ ok: true });
      expect(cancel(service)).toHaveLength(1);
      const unknown = bookingService({ reservations: [linked()] });
      const next = session(unknown);
      await next.port.load('booking');
      // no payment amount from the provider: an amount refund cannot be checked, so it is refused; full and rate still work
      expect(await next.store.execute({ type: 'booking.cancel', reservationId: 'naver-1002', cancelReason: '휴무', refund: { type: 'amount', value: 1000 } })).toMatchObject({ ok: false, reason: 'INVALID_REFUND_TERMS' });
      expect(await next.store.execute({ type: 'booking.cancel', reservationId: 'naver-1002', cancelReason: '휴무', refund: { type: 'rate', value: 10 } })).toMatchObject({ ok: true });
    });

    it('sends no refund for a booking that is not confirmed, or not Npay-linked', async () => {
      for (const booking of [linked({ status: 'needs-check' }), naver('1002', { status: 'confirmed', partySize: 2, revision: 3 })]) {
        const service = bookingService({ reservations: [booking] });
        const { store, port } = session(service);
        await port.load('booking');
        expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1002', cancelReason: '휴무', refund: { type: 'full' } }))
          .toMatchObject({ ok: false, reason: 'REFUND_NOT_APPLICABLE', field: 'refund' });
        expect(cancel(service)).toHaveLength(0);
        expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1002', cancelReason: '휴무' })).toMatchObject({ ok: true });
        expect(cancel(service)[0].body).toEqual({ type: 'booking.cancel', confirmed: true, cancelReason: '휴무', expectedRevision: 3 });
      }
    });

    it('cancels a completed Npay-linked booking only with refund terms, follows the service on what is refundable, and gives no undo (B06-3)', async () => {
      const completed = (patch: Partial<Parameters<typeof naver>[1]> = {}) => naver('1006', { status: 'completed', partySize: null, revision: 7, guestName: null, phone: null,
        sourceMetadata: { kind: 'naver', bookingNumber: '1006', product: '런치', npayLinked: true, paymentAmount: 4500 }, ...patch });
      for (const refund of [{ type: 'full' }, { type: 'rate', value: 100 }, { type: 'amount', value: 4500 }] as const) {
        const service = bookingService({ reservations: [completed()] });
        const { store, port } = session(service);
        await port.load('booking');
        expect(store.getSnapshot().tables.realBooking!.meta['naver-1006'].actions).toMatchObject({ cancel: true, cancelRequiresRefund: true, cancelUndoable: false });
        expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1006', cancelReason: '정산 오류' }))
          .toMatchObject({ ok: false, reason: 'REFUND_TERMS_REQUIRED', field: 'refund' });
        expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1006', cancelReason: '정산 오류', refund: { type: 'amount', value: 4501 } }))
          .toMatchObject({ ok: false, reason: 'INVALID_REFUND_TERMS' });
        expect(transitionsOf(service, 'naver-1006')).toHaveLength(0);
        const done = await store.execute({ type: 'booking.cancel', reservationId: 'naver-1006', cancelReason: '정산 오류', refund });
        expect(done).toMatchObject({ ok: true });
        // the provider has no inverse of a cancel: the receipt carries no deadline, so no undo token exists
        expect((done as { undoToken?: string }).undoToken).toBeUndefined();
        expect(transitionsOf(service, 'naver-1006')[0].body).toEqual({ type: 'booking.cancel', confirmed: true, cancelReason: '정산 오류', refund, expectedRevision: 7 });
        expect(service.reservations.get('naver-1006')).toMatchObject({ status: 'canceled' });
        // after the re-read the booking is cancelled and the service offers nothing more
        expect(store.getSnapshot().tables.realBooking!.meta['naver-1006'].actions).toMatchObject({ cancel: false, cancelUndoable: false });
      }
      // the service decides what needs a refund: its `cancelRequiresRefund` wins over the status and the Npay flag
      const service = bookingService({ reservations: [naver('1007', { status: 'confirmed', partySize: 2, actions: { change: true, confirm: false, cancel: true, cancelRequiresRefund: true, cancelUndoable: false } })] });
      const { store, port } = session(service);
      await port.load('booking');
      expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1007', cancelReason: '휴무' })).toMatchObject({ ok: false, reason: 'REFUND_TERMS_REQUIRED' });
    });

    it('leaves a finished booking that is not Npay-linked to the service: nothing to cancel, a status refusal', async () => {
      const service = bookingService({ reservations: [naver('1008', { status: 'completed', partySize: null })] });
      const { store, port } = session(service);
      await port.load('booking');
      expect(store.getSnapshot().tables.realBooking!.meta['naver-1008'].actions).toMatchObject({ cancel: false });
      expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1008', cancelReason: '휴무' })).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'BOOKING_TRANSITION' });
      expect(service.reservations.get('naver-1008')).toMatchObject({ status: 'completed' });
    });

    it('reports a provider refusal as a conflict', async () => {
      const service = bookingService({ reservations: [linked({ paymentAmount: 30000 })] });
      const { store, port } = session(service);
      await port.load('booking');
      service.control.refuseCancel = true;
      expect(await store.execute({ type: 'booking.cancel', reservationId: 'naver-1002', cancelReason: '휴무', refund: { type: 'full' } })).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'BOOKING_PROVIDER_REFUSED' });
    });

    it('leaves a local cancel exactly as it was: no reason, no refund', async () => {
      const service = bookingService({ reservations: [visit({ reservationId: 'rv-1', revision: 2 })] });
      const { store, port } = session(service);
      await port.load('booking');
      expect(await store.execute({ type: 'booking.cancel', reservationId: 'rv-1' })).toMatchObject({ ok: true });
      expect(transitionsOf(service, 'rv-1')[0].body).toEqual({ type: 'booking.cancel', confirmed: true, expectedRevision: 2 });
    });
  });

  it('refuses a change of an Npay-linked booking and keeps its row as it was', async () => {
    const service = bookingService({ reservations: [naver('1002', { status: 'confirmed', partySize: 2, sourceMetadata: { kind: 'naver', bookingNumber: '1002', product: '런치', npayLinked: true } })] });
    const { store, port } = session(service);
    await port.load('booking');
    const result = await store.execute({ type: 'booking.update', reservationId: 'naver-1002', patch: { time: '19:00' } });
    expect(result).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'NPAY_LINKED_BOOKING', messageKey: 'data.management.error.BOOKING_TRANSITION' });
    expect(rows(store)[0].time).toBe('18:00');
  });

  it('reads a stale revision as a conflict, re-reads, and lets the owner press again', async () => {
    const service = bookingService({ reservations: [naver('1001', { revision: 1 })] });
    const { store, port } = session(service);
    await port.load('booking');
    service.reservations.set('naver-1001', { ...service.reservations.get('naver-1001')!, revision: 2 });
    const stale = await store.execute({ type: 'booking.confirm', reservationId: 'naver-1001' });
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'STALE_REVISION' });
    const again = await store.execute({ type: 'booking.confirm', reservationId: 'naver-1001' });
    expect(again).toMatchObject({ ok: true });
  });

  it('accepts an AiCall candidate only when the owner confirms it; the new booking has a table and the candidate is gone', async () => {
    const service = bookingService({ suggestions: [candidate('sg-1', { revision: 3 })] });
    const { store, port } = session(service);
    await port.load('booking');
    expect(service.backend.callsTo('POST', /transitions/u)).toHaveLength(0);
    const result = await store.execute({ type: 'booking.confirm', reservationId: 'sg-1' });
    expect(result).toMatchObject({ ok: true });
    expect(service.backend.callsTo('POST', '/reservations/sg-1/transitions')[0].body).toEqual({ type: 'booking.confirm', expectedRevision: 3 });
    expect((result as { undoToken?: string }).undoToken).toBeUndefined();
    const list = rows(store);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: 'phone_ai', status: 'confirmed', tableId: 'T3', partySize: 4 });
    expect(list.some(row => row.reservationId === 'sg-1')).toBe(false);
  });

  it('declines a candidate with the extra confirmation and removes it from the list', async () => {
    const service = bookingService({ suggestions: [candidate('sg-1')] });
    const { store, port } = session(service);
    await port.load('booking');
    expect(await store.execute({ type: 'booking.declineSuggestion', reservationId: 'sg-1' })).toMatchObject({ ok: true });
    expect(service.backend.callsTo('POST', '/reservations/sg-1/transitions')[0].body).toEqual({ type: 'booking.declineSuggestion', confirmed: true, expectedRevision: 1 });
    expect(rows(store)).toEqual([]);
  });

  it('proposes another time and marks a past visit complete', async () => {
    const service = bookingService({ reservations: [naver('1001'), visit({ reservationId: 'rv-1', date: '2026-11-17', time: '12:00', revision: 7 })] });
    const { store, port } = session(service);
    await port.load('booking');
    expect(await store.execute({ type: 'booking.propose', reservationId: 'naver-1001', time: '19:30' })).toMatchObject({ ok: true });
    expect(service.backend.callsTo('POST', '/reservations/naver-1001/transitions')[0].body).toEqual({ type: 'booking.propose', time: '19:30', expectedRevision: 1 });
    expect(rows(store).find(row => row.reservationId === 'naver-1001')).toMatchObject({ status: 'proposed', proposedTime: '19:30' });
    expect(await store.execute({ type: 'booking.markCompleted', reservationId: 'rv-1' })).toMatchObject({ ok: true });
    expect(rows(store, '2026-11-17')[0].status).toBe('completed');
  });

  it('fails the domain, not the screen, when the booking list cannot be read, and keeps the last rows after a failed refresh', async () => {
    const service = bookingService({ reservations: [visit({ reservationId: 'rv-1' })] });
    const { store, port } = session(service);
    await port.load('booking');
    service.control.failList = true;
    const state = await port.load('booking', { force: true });
    expect(state.status).toBe('stale');
    expect(rows(store).map(row => row.reservationId)).toEqual(['rv-1']);
    expect(undoUntil > asOf).toBe(true);
  });
  it('proposes another time for a phone request as a local record: it leaves the counts, shows 제안함, and the proposal can be undone', async () => {
    const service = bookingService({ suggestions: [candidate('sg-1', { revision: 2, phoneMasked: null })] });
    const { store, port } = session(service);
    await port.load('booking');
    expect(rows(store)[0]).toMatchObject({ status: 'needs-check', counts: true });
    expect(rows(store)[0].phone).toBeNull();
    const result = await store.execute({ type: 'booking.propose', reservationId: 'sg-1', time: '20:30' });
    expect(result).toMatchObject({ ok: true, undoToken: expect.stringContaining('real-undo:') });
    expect(transitionsOf(service, 'sg-1')[0].body).toEqual({ type: 'booking.propose', time: '20:30', expectedRevision: 2 });
    expect(service.backend.callsTo('GET', '/reservation-suggestions')[0].query.status).toBeUndefined();
    expect(rows(store)[0]).toMatchObject({ reservationId: 'sg-1', status: 'proposed', proposedTime: '20:30', counts: false });
    expect(selectReservations(store.getSnapshot(), { date: day }).count).toBe(0);
    expect(await port.undo((result as { undoToken: string }).undoToken)).toMatchObject({ ok: true });
    expect(rows(store)[0]).toMatchObject({ status: 'needs-check', counts: true });
  });

  it('says the NAVER side was only partly read, or not at all, instead of showing a quiet empty day', async () => {
    const service = bookingService({ reservations: [visit({ reservationId: 'rv-1' })] });
    service.control.naver = 'partial';
    const { store, port } = session(service);
    const state = await port.load('booking');
    expect(state.complete).toBe(false);
    expect(store.getSnapshot().tables.realBooking?.sourceStatus).toEqual({ naver: 'partial' });
    service.control.naver = 'ready';
    expect((await port.load('booking', { force: true })).complete).toBe(true);
    expect(store.getSnapshot().tables.realBooking?.sourceStatus).toEqual({ naver: 'ready' });
  });
});
