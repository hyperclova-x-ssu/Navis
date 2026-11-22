// REAL-PLAN F12: the briefing domain reads B12's insight projection and records the owner's explicit acknowledgement once.
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../widget-data';
import { createRealPort } from '../00';
import { reply } from '../00/testing';
import { briefingAdapter } from './adapter';
import { recordBriefingAcknowledgement } from './ack';
import { ackKey, briefingBody, briefingDay, briefingSession, type BriefingBackendState } from './testing';

describe('briefing HTTP port', () => {
  it('reads the business day, the arrival day, the acknowledgement and every named source with its origin, state and period', async () => {
    const { store, port, backend } = briefingSession();
    expect(await port.load('briefing')).toMatchObject({ status: 'ready', complete: true });
    const read = store.getSnapshot().tables.realBriefing!;
    expect(backend.callsTo('GET', '/insight/briefings')).toHaveLength(1);
    expect(read).toMatchObject({ businessDay: briefingDay, arrivalDay: briefingDay, acknowledgement: null, sourceRevision: 8 });
    expect(read.sources.map(source => [source.key, source.state])).toEqual(expect.arrayContaining([
      ['finance', 'ready'], ['purchasing', 'partial'], ['cctv', 'unavailable'], ['reservations', 'not-connected'], ['tax', 'not-connected'], ['manualsGrants', 'ready'],
    ]));
    expect(read.sources).toHaveLength(20);
    expect(read.sources.find(source => source.key === 'finance')).toMatchObject({ origin: 'pos', provider: false, period: { from: briefingDay, to: briefingDay }, sourceRevision: 8 });
    expect(read.sources.find(source => source.key === 'manualsGrants')).toMatchObject({ sourceRevision: '5' });
    expect(read.sources.find(source => source.key === 'smartCall')).toMatchObject({ origin: 'naver-smartcall', provider: true, period: { from: '2026-11-10', to: '2026-11-16' } });
    expect(read.sources.find(source => source.key === 'stock')).toMatchObject({ period: null });
  });

  it('keeps an unknown state as unavailable, never as ready, and a missing period as no period', async () => {
    const { store, port, state } = briefingSession();
    state.sources = { staffLater: { origin: 'customer', state: 'ok' as never, period: { from: 'soon', to: 'later' }, data: { working: 2 } } };
    await port.load('briefing');
    expect(store.getSnapshot().tables.realBriefing!.sources).toEqual([expect.objectContaining({ key: 'staffLater', state: 'unavailable', period: null, asOf: null, sourceRevision: null })]);
  });

  it('treats an answer that is not the envelope as a failed read, not an empty briefing', async () => {
    const { store, port, backend } = briefingSession();
    backend.on('GET', '/insight/briefings', () => ({ businessDay: 'today', sources: [] }));
    expect(await port.load('briefing')).toMatchObject({ status: 'error' });
    expect(store.getSnapshot().tables.realBriefing).toBeUndefined();
  });

  it('keeps arrivalDay null when the server has no authoritative weekly opening times', async () => {
    const { store, port, state } = briefingSession();
    state.arrivalDay = null;
    await port.load('briefing');
    expect(store.getSnapshot().tables.realBriefing).toMatchObject({ businessDay: briefingDay, arrivalDay: null });
  });

  it('sends one acknowledgement from the explicit command, waits for the receipt, re-reads it and a new session shows the same one with no second write', async () => {
    const { store, port, backend, state, open } = briefingSession();
    await port.load('briefing');
    const pending = port.execute({ type: 'briefing.acknowledge', businessDay: briefingDay, idempotencyKey: ackKey(briefingDay) });
    // Double press while pending: the same promise, still one request.
    const again = port.execute({ type: 'briefing.acknowledge', businessDay: briefingDay, idempotencyKey: ackKey(briefingDay) });
    const result = await pending;
    expect(await again).toBe(result);
    expect(result).toMatchObject({ ok: true });
    expect(backend.callsTo('POST', `/insight/briefings/${briefingDay}/ack`)).toHaveLength(1);
    const call = backend.callsTo('POST', `/insight/briefings/${briefingDay}/ack`)[0]!;
    expect(call.body).toEqual({});
    expect(call.headers.get('idempotency-key')).toBe(ackKey(briefingDay));
    expect(state.acknowledgement).toEqual({ acknowledgedAt: expect.any(String), receiptId: 'ack-receipt-1' });
    expect(store.getSnapshot().tables.realBriefing!.acknowledgement).toEqual(state.acknowledgement);
    // Reload / new session: a fresh store and port read the same acknowledgement and write nothing.
    const next = open();
    await next.port.load('briefing');
    expect(next.store.getSnapshot().tables.realBriefing!.acknowledgement).toEqual(state.acknowledgement);
    expect(backend.callsTo('POST', /\/ack$/)).toHaveLength(1);
  });

  it('re-reads after an acknowledgement even when the receipt names a source this domain does not list', async () => {
    const { store, port, state, backend } = briefingSession();
    state.affectedSources = ['somewhere-else'];
    await port.load('briefing');
    expect(await recordBriefingAcknowledgement(store)).toEqual({ ok: true, recorded: true });
    expect(store.getSnapshot().tables.realBriefing!.acknowledgement).not.toBeNull();
    // A second press (or a card replay) finds it acknowledged and writes nothing.
    expect(await recordBriefingAcknowledgement(store)).toEqual({ ok: true, recorded: false });
    expect(backend.callsTo('POST', /\/ack$/)).toHaveLength(1);
  });

  it('resends the same key after an unknown outcome and never records a second acknowledgement', async () => {
    const { port, backend, state } = briefingSession();
    await port.load('briefing');
    let attempts = 0;
    const original = backend.fetch;
    const flaky: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/ack') && ++attempts === 1) {
        await original(input, init); // the server stored it, the answer was lost
        throw new TypeError('network down');
      }
      return original(input, init);
    };
    const lossy = createRealPort({ store: createWidgetDataStore(), fetch: flaky, source: () => 'http', adapters: [briefingAdapter], sleep: async () => {}, reconcileDelaysMs: [0] });
    await lossy.load('briefing');
    expect(await lossy.execute({ type: 'briefing.acknowledge', businessDay: briefingDay, idempotencyKey: ackKey(briefingDay) })).toMatchObject({ ok: true });
    expect(state.acknowledgements).toBe(1);
    expect(backend.callsTo('POST', /\/ack$/).map(call => call.headers.get('idempotency-key'))).toEqual([ackKey(briefingDay), ackKey(briefingDay)]);
  });

  it('answers a stale or closed acknowledgement with the server reason and leaves the read untouched', async () => {
    const { store, port, backend } = briefingSession();
    await port.load('briefing');
    backend.on('POST', /\/ack$/, () => reply(409, { code: 'BRIEFING_DAY_CHANGED', reason: 'BRIEFING_DAY_CHANGED' }));
    const result = await port.execute({ type: 'briefing.acknowledge', businessDay: briefingDay, idempotencyKey: ackKey(briefingDay) });
    expect(result).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'BRIEFING_DAY_CHANGED', messageKey: 'briefing.error.dayChanged' });
    expect(store.getSnapshot().tables.realBriefing!.acknowledgement).toBeNull();
  });

  it('shows an error state with no rows when the projection cannot be read, and clears the rows when access ends', async () => {
    const { store, port, backend } = briefingSession();
    backend.on('GET', '/insight/briefings', () => reply(503, { code: 'SERVICE_UNAVAILABLE' }));
    expect(await port.load('briefing')).toMatchObject({ status: 'error' });
    expect(store.getSnapshot().tables.realBriefing).toBeUndefined();
    backend.on('GET', '/insight/briefings', () => briefingBody({ arrivalDay: null, acknowledgement: null, sources: {}, affectedSources: [], acknowledgements: 0 } as BriefingBackendState));
    await port.retry('briefing');
    expect(store.getSnapshot().tables.realBriefing).toBeDefined();
    port.reset();
    expect(store.getSnapshot().tables.realBriefing).toBeUndefined();
  });

  it('is real only: the fixture store has no acknowledgement command of its own', async () => {
    const store = createWidgetDataStore();
    expect(store.dispatch({ type: 'briefing.acknowledge', businessDay: briefingDay, idempotencyKey: ackKey(briefingDay) })).toMatchObject({ ok: false, reason: 'REAL_ONLY' });
  });
});
