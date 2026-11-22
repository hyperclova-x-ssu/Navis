/**
 * R1-F06: the Navis booking cards on the real data port. A card runs the widget's own command (`booking.confirm`, `booking.cancel`,
 * `booking.update` …); only the press executes it, it waits for the customer service's receipt, a provider-side action offers no
 * undo, and a booking the service would refuse (Npay-linked) gets no card at all.
 */
import { describe, expect, it } from 'vitest';
import { getRegistry } from '../../../catalog';
import { beginDashboard } from '../../../app/test-session';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { selectReservations } from '../../../data/derive/reservations';
import { createRealPort } from '../../../data/reality/00';
import { bookingAdapter } from '../../../data/reality/06/adapter';
import { bookingService, candidate, naver, visit } from '../../../data/reality/06/testing';
import { screenPresets } from '../../../layout';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { createAgentActions } from '../agent-actions';
import { bookingDomain } from './booking';

const future = { date: TODAY, time: '19:00' };
function rig() {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const runId = run.getState().runId;
  const service = bookingService({
    reservations: [
      naver('1001', { ...future, revision: 4 }),
      naver('1002', { ...future, time: '20:00', status: 'confirmed', partySize: 2, guestName: '이○○', phone: '010-****-1111', revision: 2,
        sourceMetadata: { kind: 'naver', bookingNumber: '1002', product: '런치 세트', npayLinked: true } }),
      naver('1006', { ...future, time: '16:00', status: 'completed', guestName: null, phone: null, revision: 8,
        sourceMetadata: { kind: 'naver', bookingNumber: '1006', product: '런치 세트', npayLinked: true, paymentAmount: 4500 } }),
      visit({ reservationId: 'rv-local', ...future, time: '21:00', guestName: '김하나', revision: 3 }),
    ],
    suggestions: [candidate('sg-1', { date: TODAY, time: '19:30', revision: 5 })],
  });
  const store = createWidgetDataStore(undefined, { runId });
  const port = createRealPort({ store, source: domain => domain === 'booking' ? 'http' : 'fixture', adapters: [bookingAdapter], fetch: service.backend.fetch, sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const actions = createAgentActions(store, undefined, run);
  let cards = 0;
  const card = (command: 'booking.confirm' | 'booking.cancel' | 'booking.update', id: string, extra: Record<string, unknown> = {}) => {
    const snapshot = store.getSnapshot();
    const targets = new Map([['visit-0', { kind: 'reservation', id }]]) as never;
    const prepared = actions.prepare({ command, args: { reservationId: { handle: 'visit-0' }, ...extra }, snapshotRevision: snapshot.revision,
      proposalId: `wire-${++cards}`, runId, layer: 'management', tier: command === 'booking.cancel' ? 'extra-confirm' : 'normal' } as never, {}, snapshot, () => true, targets, run.getState());
    return prepared;
  };
  return { run, store, port, service, actions, card };
}
const transitions = (service: ReturnType<typeof bookingService>, id: string) => service.backend.callsTo('POST', `/reservations/${encodeURIComponent(id)}/transitions`);

describe('a booking card on the real port', () => {
  it('projects NAVER and local origins from the service metadata for policy to distinguish cancellation', async () => {
    const t = rig();
    await t.port.load('booking');
    const reader = bookingDomain.reads.find(read => read.kind === 'reservation')!;
    const options = { snapshot: t.store.getSnapshot(), locale: 'ko' as const, privateLookup: true };
    const rows = reader.search({ ...options, query: '김하나' });
    expect(rows).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ origin: 'local' }) }));
    expect(reader.search({ ...options, query: '이○○' })).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ origin: 'naver' }) }));
    t.run.dispose();
  });
  it('confirms a NAVER booking only when pressed, waits for the receipt, and offers no undo for a provider action', async () => {
    const t = rig();
    await t.port.load('booking');
    const prepared = t.card('booking.confirm', 'naver-1001');
    if (prepared.kind !== 'proposal') throw new Error(`The booking card did not resolve (${prepared.kind})`);
    expect(transitions(t.service, 'naver-1001')).toHaveLength(0);
    const pending = prepared.proposal.confirm(t.store);
    expect(pending).toMatchObject({ pending: true });
    expect(selectReservations(t.store.getSnapshot(), { date: TODAY }).rows.find(row => row.reservationId === 'naver-1001')?.status).toBe('needs-check');
    const final = await prepared.proposal.settled();
    expect(final.frame).toMatchObject({ proposalId: prepared.proposal.id, outcome: 'applied' });
    expect(transitions(t.service, 'naver-1001')).toHaveLength(1);
    expect(transitions(t.service, 'naver-1001')[0].body).toEqual({ type: 'booking.confirm', expectedRevision: 4 });
    expect(final.undoToken).toBeUndefined();
    expect(selectReservations(t.store.getSnapshot(), { date: TODAY }).rows.find(row => row.reservationId === 'naver-1001')?.status).toBe('confirmed');
    // Pressing again is the same press: one request.
    expect(prepared.proposal.confirm(t.store)).toBe(final);
    expect(transitions(t.service, 'naver-1001')).toHaveLength(1);
  });

  it('accepts a phone request with the same command and never confirms it by words alone', async () => {
    const t = rig();
    await t.port.load('booking');
    const prepared = t.card('booking.confirm', 'sg-1');
    if (prepared.kind !== 'proposal') throw new Error(`The phone-request card did not resolve (${prepared.kind})`);
    expect(t.service.backend.callsTo('POST', /./u)).toHaveLength(0);
    prepared.proposal.confirm(t.store);
    const final = await prepared.proposal.settled();
    expect(final.frame).toMatchObject({ outcome: 'applied' });
    expect(transitions(t.service, 'sg-1')[0].body).toEqual({ type: 'booking.confirm', expectedRevision: 5 });
    expect(selectReservations(t.store.getSnapshot(), { date: TODAY }).rows.find(row => row.source === 'phone_ai')).toMatchObject({ status: 'confirmed', tableId: 'T3' });
  });

  it('gives no change card for an Npay-linked booking and explains why in words, without calling the service', async () => {
    const t = rig();
    await t.port.load('booking');
    const prepared = t.card('booking.update', 'naver-1002', { patch: { time: '20:30' } });
    expect(prepared.kind).not.toBe('proposal');
    const route = bookingDomain.route?.('1002 예약 시간 8시 반으로 바꿔줘', t.store.getSnapshot(), 'ko');
    expect(JSON.stringify(route)).not.toContain('"kind":"command"');
    expect(t.service.backend.callsTo('PATCH', /./u)).toHaveLength(0);
    expect(t.service.backend.callsTo('POST', /./u)).toHaveLength(0);
  });

  it('keeps the extra confirmation on a cancel card and the receipt undo of a local booking', async () => {
    const t = rig();
    await t.port.load('booking');
    const prepared = t.card('booking.cancel', 'rv-local');
    if (prepared.kind !== 'proposal') throw new Error(`The cancel card did not resolve (${prepared.kind})`);
    // The first press only asks the extra question: nothing is sent.
    expect(prepared.proposal.confirm(t.store)).toMatchObject({ requiresExtraConfirmation: true });
    expect(transitions(t.service, 'rv-local')).toHaveLength(0);
    prepared.proposal.confirm(t.store, prepared.proposal.id);
    const final = await prepared.proposal.settled();
    expect(final.frame).toMatchObject({ outcome: 'applied' });
    expect(transitions(t.service, 'rv-local')[0].body).toEqual({ type: 'booking.cancel', confirmed: true, expectedRevision: 3 });
    expect(final.undoToken).toMatch(/^real-undo:/);
    expect(selectReservations(t.store.getSnapshot(), { date: TODAY }).rows.find(row => row.reservationId === 'rv-local')?.status).toBe('canceled');
  });

  it('hands a NAVER cancel off to the widget: no card carries the reason or the refund terms, and nothing is sent', async () => {
    const t = rig();
    await t.port.load('booking');
    for (const id of ['naver-1001', 'naver-1002']) {
      expect(t.card('booking.cancel', id).kind).not.toBe('proposal');
    }
    const route = bookingDomain.route?.('오늘 7시 예약 취소해줘', t.store.getSnapshot(), 'ko');
    expect(route).toMatchObject({ kind: 'refusal', reason: 'widget_only', answer: expect.stringContaining('취소 사유'),
      alternative: { featureId: 'voice-booking', command: 'booking.cancel', draft: { reservationId: 'naver-1001' } } });
    // the hand-off opens the booking itself, ready for the owner's own words
    expect(bookingDomain.handoff?.('booking.cancel', { reservationId: 'naver-1001' })).toEqual({ featureId: 'voice-booking', itemId: 'naver-1001', focus: 'action' });
    expect(t.service.backend.callsTo('POST', /./u)).toHaveLength(0);
  });

  it('hands a completed Npay cancellation to the widget without offering a chat write', async () => {
    const t = rig();
    await t.port.load('booking');
    const route = bookingDomain.route?.('오늘 16:00 예약 취소해줘', t.store.getSnapshot(), 'ko');
    expect(route).toMatchObject({ kind: 'refusal', reason: 'widget_only',
      alternative: { featureId: 'voice-booking', command: 'booking.cancel', draft: { reservationId: 'naver-1006' } } });
    expect(t.card('booking.cancel', 'naver-1006').kind).not.toBe('proposal');
    expect(transitions(t.service, 'naver-1006')).toHaveLength(0);
  });

  it('leaves a local cancel as a card with its extra confirmation (it needs no reason or terms)', async () => {
    const t = rig();
    await t.port.load('booking');
    const route = bookingDomain.route?.('김하나 예약 취소해줘', t.store.getSnapshot(), 'ko');
    expect(JSON.stringify(route)).not.toContain('widget_only');
    expect(t.card('booking.cancel', 'rv-local').kind).toBe('proposal');
  });
});
