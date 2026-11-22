import { describe, expect, it, vi } from 'vitest';
import type { PosReadSnapshot, PosTableView } from '../../../contracts/pos';
import { createTableLayout } from '../../../layout/table-layout';
import { createPosSeed, createPosUi } from '../../../pos/seed';
import { selectTableMap } from '../../../pos/tables/selectors';
import { createWidgetDataStore } from '../../db/store';
import { selectPosReservations } from '../../derive/reservations';
import { selectPosDataRead } from '../../pos/catalog';
import { createPosBridge } from '../02/bridge';
import { createPosRemote } from '../02/remote';
import { createPortTransport } from '../00/transport';
import { fakeBackend, reply } from '../00/testing';
import { firstOrderFor, seatNote } from './seat';
import { projectBooking } from './dto';
import { visit } from './testing';

const quote = { quoteRevision: 1, lines: [], gross: 4500, discount: 0, payable: 4500 };
const line = { menuId: 'm1', qty: 1, optionIds: [] as string[] };
const table = { tableId: 'server-table', expectedRevision: 3 };
const reservation = { reservationId: '5b0d1f0e-6a8e-4c43-9e61-7f1f3a2b9c11', sourceVersion: 4 };
const claimPath = `/reservations/${reservation.reservationId}/first-order-claim`;
const linkedReceipt = { resourceId: 'b1', revision: 1, receiptId: 'r1', affectedSources: ['pos.bills', 'pos.orders', 'pos.tables', 'voice-booking', 'reservations', 'calendar', 'briefing'], quote,
  orderId: 'o1', reservationId: reservation.reservationId, reservationLink: { billId: 'b1', orderId: 'o1', tableId: 'server-table' } };
const plainReceipt = { resourceId: 'b1', revision: 1, receiptId: 'r1', affectedSources: ['pos.bills', 'pos.orders', 'pos.tables'], quote, orderId: 'o1' };

function setup() {
  const backend = fakeBackend();
  const transport = createPortTransport(backend.fetch);
  const remote = createPosRemote({ transport, sleep: async () => {}, delaysMs: [0, 0] });
  return { backend, remote };
}

describe('first order of a seated reservation (B06 seam)', () => {
  it('claims the booking at its revision first, then opens the bill with the claim command key as its idempotency key', async () => {
    const { backend, remote } = setup();
    backend.on('POST', claimPath, () => ({ claimId: 'c1', kind: 'reservation_first_order', sourceId: reservation.reservationId, sourceVersion: 4, state: 'held', commandKey: 'pos-key-1' }));
    backend.on('POST', '/pos/bills', () => linkedReceipt);
    const receipt = await remote.submitOrder({ lines: [line], key: 'order:1', table, reservation });
    const claim = backend.callsTo('POST', claimPath);
    expect(claim).toHaveLength(1);
    expect(claim[0].body).toEqual({ sourceVersion: 4 });
    expect(claim[0].headers.get('idempotency-key')).toBe('claim:order:1');
    const bill = backend.callsTo('POST', '/pos/bills');
    expect(bill).toHaveLength(1);
    expect(bill[0].headers.get('idempotency-key')).toBe('pos-key-1');
    expect(bill[0].body).toEqual({ type: 'dine_in', postpaid: true, table, reservationId: reservation.reservationId, lines: [{ menuId: 'm1', qty: 1 }] });
    expect(receipt.reservationLink).toMatchObject({ orderId: 'o1' });
    expect(receipt.reservationSkipped).toBeUndefined();
  });

  it('asks the service to reconcile a claim whose bind is not confirmed yet and never orders on a private key', async () => {
    const { backend, remote } = setup();
    backend.on('POST', claimPath, () => ({ claimId: 'c1', state: 'held' }));
    let reconciled = 0;
    backend.on('POST', '/claims/c1/reconcile', () => ({ claimId: 'c1', state: 'held', ...(++reconciled >= 2 ? { commandKey: 'pos-key-2' } : {}) }));
    backend.on('POST', '/pos/bills', () => linkedReceipt);
    await remote.submitOrder({ lines: [line], key: 'order:2', table, reservation });
    expect(backend.callsTo('POST', '/claims/c1/reconcile')).toHaveLength(2);
    expect(backend.callsTo('POST', '/claims/c1/reconcile')[0].body).toEqual({});
    expect(backend.callsTo('POST', '/pos/bills')[0].headers.get('idempotency-key')).toBe('pos-key-2');
  });

  it('keeps the same keys for an unknown outcome: no bill is made on an unconfirmed bind, and the next press resends the same requests', async () => {
    const { backend, remote } = setup();
    backend.on('POST', claimPath, () => ({ claimId: 'c1', state: 'held' }));
    backend.on('POST', '/claims/c1/reconcile', () => ({ claimId: 'c1', state: 'held' }));
    backend.on('POST', '/pos/bills', () => plainReceipt);
    await expect(remote.submitOrder({ lines: [line], key: 'order:3', table, reservation })).rejects.toMatchObject({ reason: 'CLAIM_NOT_CONFIRMED', outcomeUnknown: true });
    expect(backend.callsTo('POST', '/pos/bills')).toHaveLength(0);
    expect(backend.callsTo('POST', claimPath)[0].headers.get('idempotency-key')).toBe('claim:order:3');
    backend.on('POST', '/claims/c1/reconcile', () => ({ claimId: 'c1', state: 'held', commandKey: 'pos-key-3' }));
    await remote.submitOrder({ lines: [line], key: 'order:3', table, reservation });
    expect(backend.callsTo('POST', claimPath)[1].headers.get('idempotency-key')).toBe('claim:order:3');
    expect(backend.callsTo('POST', '/pos/bills')).toHaveLength(1);
  });

  it.each([
    ['the booking changed', { status: 409, body: { code: 'CONFLICT', reason: 'STALE_SOURCE_VERSION' } }, 'STALE_SOURCE_VERSION'],
    ['it left its window', { status: 409, body: { code: 'CONFLICT', reason: 'RESERVATION_OUTSIDE_WINDOW' } }, 'RESERVATION_OUTSIDE_WINDOW'],
    ['it is already claimed', { status: 409, body: { code: 'CONFLICT', reason: 'RESERVATION_CLAIM_PENDING' } }, 'RESERVATION_CLAIM_PENDING'],
    ['it is gone', { status: 404, body: { code: 'NOT_FOUND', reason: 'SOURCE_NOT_FOUND' } }, 'SOURCE_NOT_FOUND'],
  ])('places an ordinary table order and says the booking was not linked when %s', async (_name, refusal, reason) => {
    const { backend, remote } = setup();
    backend.on('POST', claimPath, () => reply(refusal.status, refusal.body));
    backend.on('POST', '/pos/bills', () => plainReceipt);
    const receipt = await remote.submitOrder({ lines: [line], key: 'order:4', table, reservation });
    expect(backend.callsTo('POST', '/pos/bills')).toHaveLength(1);
    expect(backend.callsTo('POST', '/pos/bills')[0].headers.get('idempotency-key')).toBe('order:4');
    expect(backend.callsTo('POST', '/pos/bills')[0].body).toEqual({ type: 'dine_in', postpaid: true, table, lines: [{ menuId: 'm1', qty: 1 }] });
    expect(receipt.reservationSkipped).toBe(reason);
    expect(receipt.reservationLink).toBeUndefined();
  });

  it('lets the booking go again when POS refuses the claimed bill for good', async () => {
    const { backend, remote } = setup();
    backend.on('POST', claimPath, () => ({ claimId: 'c1', state: 'held', commandKey: 'pos-key-5' }));
    backend.on('POST', '/pos/bills', () => reply(409, { code: 'CONFLICT', reason: 'RESERVATION_CLAIM_MISMATCH' }));
    backend.on('POST', '/claims/c1/abort', () => ({ claimId: 'c1', state: 'released' }));
    await expect(remote.submitOrder({ lines: [line], key: 'order:5', table, reservation })).rejects.toMatchObject({ reason: 'RESERVATION_CLAIM_MISMATCH' });
    expect(backend.callsTo('POST', '/claims/c1/abort')).toHaveLength(1);
  });

  it('does not abort a claim whose bill outcome is unknown: the resend must reach the same order', async () => {
    const { backend, remote } = setup();
    backend.on('POST', claimPath, () => ({ claimId: 'c1', state: 'held', commandKey: 'pos-key-6' }));
    backend.on('POST', '/pos/bills', () => reply(503, { code: 'SERVICE_UNAVAILABLE' }));
    await expect(remote.submitOrder({ lines: [line], key: 'order:6', table, reservation })).rejects.toMatchObject({ outcomeUnknown: true });
    expect(backend.callsTo('POST', '/claims/c1/abort')).toHaveLength(0);
    expect(backend.callsTo('POST', '/pos/bills').every(call => call.headers.get('idempotency-key') === 'pos-key-6')).toBe(true);
  });

  it('never claims for a later order of an open bill', async () => {
    const { backend, remote } = setup();
    backend.on('POST', '/pos/bills/b1/orders', () => plainReceipt);
    await remote.submitOrder({ lines: [line], key: 'order:7', bill: { billId: 'b1', expectedRevision: 1 }, reservation });
    expect(backend.callsTo('POST', claimPath)).toHaveLength(0);
  });

  it('a lost session is not read as "this booking cannot be claimed"', async () => {
    const { backend, remote } = setup();
    backend.on('POST', claimPath, () => reply(403, { code: 'STORE_FORBIDDEN' }));
    backend.on('POST', '/pos/bills', () => plainReceipt);
    await expect(remote.submitOrder({ lines: [line], key: 'order:8', table, reservation })).rejects.toMatchObject({ code: 'STORE_FORBIDDEN' });
    expect(backend.callsTo('POST', '/pos/bills')).toHaveLength(0);
  });
});

describe('what the order screen claims and says', () => {
  const uuid = '3f6c0a52-5b0e-4f5c-9c5b-0d6b8a1a2b3c';
  const snapshot = (date = '2026-11-21', time = '18:00') => {
    const store = createWidgetDataStore();
    const projected = projectBooking({ reservations: [visit({ reservationId: 'rv-1', date, time, tableId: uuid, revision: 9 }), visit({ reservationId: 'rv-2', tableId: null, revision: 2 })],
      suggestions: [], calls: [], changes: [], products: [], tables: [{ tableId: uuid, label: '창가 1', layoutTableId: 'T1' }], asOf: '2026-11-21T09:00:00.000Z', pickups: [] });
    return { ...store.getSnapshot(), tables: { ...store.getSnapshot().tables, ...projected.tables } };
  };
  const view = (patch: Partial<PosTableView>, id = 'rv-1'): PosTableView => ({ tableId: 'T1', number: 1, seats: 4, state: 'reserved', billIds: [], total: 0, elapsed: 0, orderCount: 0,
    reservation: { reservationId: id, date: '2026-11-21', time: '18:00', partySize: 2, tableId: 'T1', status: 'confirmed', name: '김하나', fingerprint: 'f', completedFingerprint: 'g' }, ...patch });

  it('claims the booking due at an empty reserved table with its current revision', () => {
    expect(firstOrderFor(snapshot(), view({}), false)).toEqual({ reservationId: 'rv-1', sourceVersion: 9 });
  });
  it.each([
    ['2026-11-21', '23:30', '2026-11-22T00:35', 'reserved', 'rv-1'],
    ['2026-11-21', '23:30', '2026-11-22T01:30', 'empty', null],
    ['2026-11-22', '00:15', '2026-11-21T23:44', 'empty', 'rv-1'],
    ['2026-11-22', '00:15', '2026-11-21T23:45', 'reserved', 'rv-1'],
    ['2026-11-22', '04:45', '2026-11-22T04:59', 'reserved', 'rv-1'],
    ['2026-11-22', '04:45', '2026-11-22T05:00', 'empty', null],
    ['2026-11-22', '05:15', '2026-11-22T04:59', 'empty', null],
    ['2026-11-22', '05:15', '2026-11-22T05:00', 'reserved', 'rv-1'],
  ] as const)('shows the %s %s reservation at %s as %s', (date, time, at, state, reservationId) => {
    const data = snapshot(date, time);
    const pos = createPosSeed();
    const read: PosReadSnapshot = { runId: 'booking-window', runRevision: 0, posRevision: pos.revision, posUi: createPosUi(),
      pos: { ...pos, bills: [], tableSessions: [] }, dataRevision: data.revision, scenario: 'normal',
      settings: { ...data.tables.shopSettings, businessType: 'cafe', paymentStyle: 'postpaid', tableLayout: createTableLayout() },
      data: { ...selectPosDataRead(data), reservations: selectPosReservations(data, {}) } };
    const table = selectTableMap(read, at).tables.find(row => row.tableId === 'T1');
    expect(table).toMatchObject({ state, reservation: reservationId ? { reservationId } : null });
    expect(firstOrderFor(data, table, false)).toEqual(state === 'reserved' ? { reservationId: 'rv-1', sourceVersion: 9 } : undefined);
  });
  it.each([
    ['a table that already has a bill', view({}), true],
    ['a table that is not reserved right now', view({ state: 'empty' }), false],
    ['a table without a booking', view({ reservation: null }), false],
    ['a booking the service revision of which is unknown', view({}, 'rv-unknown'), false],
  ])('claims nothing for %s', (_name, tableView, hasBill) => {
    expect(firstOrderFor(snapshot(), tableView, hasBill)).toBeUndefined();
  });
  it('says whether the booking followed the order', () => {
    expect(seatNote({ reservationLink: { billId: 'b', orderId: 'o', tableId: 't' } }, true)).toContain('방문 완료');
    expect(seatNote({ reservationSkipped: 'STALE_SOURCE_VERSION' }, true)).toContain('이어지지 않았어요');
    expect(seatNote({}, false)).toBe('');
  });
});

describe('after a linked first order', () => {
  it('reads the booking list and the calendar again now and after the relay delay, and not for an ordinary order', async () => {
    const reload = vi.fn();
    const later: (() => void)[] = [];
    const remote = { ...setup().remote };
    const submit = vi.fn();
    const bridge = createPosBridge({ remote: { ...remote, submitOrder: submit, load: async () => ({ rows: { orders: [], bills: [], tables: [], receipts: new Map() }, asOf: '2026-11-21T09:00:00.000Z', sourceRevision: 1, complete: true }) } as never,
      read: () => ({ pos: { cart: { cartId: 'c', revision: 1, lines: [], type: 'dine_in' }, businessDate: '2026-11-21', orders: [], bills: [], tableSessions: [] } }) as never,
      commit: () => ({ ok: true }) as never, reload, schedule: callback => { later.push(callback); return later.length; }, cancel: () => {} });
    submit.mockResolvedValueOnce(plainReceipt);
    await bridge.submitOrder({ key: 'k1' });
    expect(reload).not.toHaveBeenCalled();
    submit.mockResolvedValueOnce(linkedReceipt);
    await bridge.submitOrder({ key: 'k2' });
    expect(reload).toHaveBeenCalledWith(expect.arrayContaining(['booking', 'staff']));
    expect(later).toHaveLength(2);
    later.forEach(callback => callback());
    expect(reload).toHaveBeenCalledTimes(3);
  });
});
