// REAL-PLAN F12: D-327 over the service. The arrival card opens at most once per business day; the service's acknowledgement (explicit confirmation)
// keeps it closed in a new browser or session, its arrival day replaces the local weekday rule when present, and with none the current gate stays.
import { describe, expect, it } from 'vitest';
import { createBriefingDayGate, briefingDayStorageKey, type BriefingServerDay } from '../../../state/briefing-day';
import type { PortTransport } from '../00';
import { PortError } from '../00';
import { createServerArrival } from './arrival';
import { briefingBody, briefingDay, briefingSession } from './testing';

const storeId = 'store-1';
const memory = () => { const map = new Map<string, string>(); return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } }; };
const gate = (storage: ReturnType<typeof memory>, server?: () => BriefingServerDay | null | undefined, now = `${briefingDay}T09:30`) =>
  createBriefingDayGate({ briefingStorage: storage, storeId, businessNow: () => now, briefingServer: server });

describe('arrival gate with the service', () => {
  it('waits while the service answer is not known and decides nothing', () => {
    const storage = memory();
    const server: { answer?: BriefingServerDay | null } = {};
    const g = gate(storage, () => server.answer);
    expect(g.claim('run-1')).toBe(false);
    expect(g.settled('run-1')).toBe(false);
    expect(storage.map.size).toBe(0);
    server.answer = { arrivalDay: briefingDay, acknowledgedDay: null };
    expect(g.claim('run-1')).toBe(true);
    expect(storage.map.get(briefingDayStorageKey(storeId))).toBe(briefingDay);
    expect(g.claim('run-1')).toBe(false);
  });

  it('keeps the card closed in a new browser once the service holds the acknowledgement of that day', () => {
    const storage = memory(); // a new browser: nothing recorded locally
    const g = gate(storage, () => ({ arrivalDay: briefingDay, acknowledgedDay: briefingDay }));
    expect(g.claim('run-2')).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  it('uses the service arrival day for the once-per-day record and ignores an acknowledgement of another day', () => {
    const storage = memory();
    const g = gate(storage, () => ({ arrivalDay: '2026-11-18', acknowledgedDay: briefingDay }));
    expect(g.claim('run-3')).toBe(true);
    expect(storage.map.get(briefingDayStorageKey(storeId))).toBe('2026-11-18');
  });

  it('keeps the current gate while the service has no authoritative weekly opening times, and still honors its acknowledgement of the same day', () => {
    const open = memory();
    expect(gate(open, () => ({ arrivalDay: null, acknowledgedDay: null })).claim('run-4')).toBe(true);
    expect(open.map.get(briefingDayStorageKey(storeId))).toBe(briefingDay);
    const acknowledged = memory();
    expect(gate(acknowledged, () => ({ arrivalDay: null, acknowledgedDay: briefingDay })).claim('run-5')).toBe(false);
    expect(gate(memory(), () => ({ arrivalDay: null, acknowledgedDay: '2026-11-16' })).claim('run-6')).toBe(true);
  });

  it('falls back to the local rule alone when there is no service answer to wait for', () => {
    expect(gate(memory(), () => null).claim('run-7')).toBe(true);
    expect(gate(memory()).claim('run-8')).toBe(true);
  });
});

describe('server arrival reader', () => {
  const transport = (request: PortTransport['request']): PortTransport => ({ storeId: async () => storeId, request, reset: () => undefined });
  const settle = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

  it('asks once, answers unknown until the read finishes, then the arrival day and the acknowledged day', async () => {
    const { state } = briefingSession();
    state.acknowledgement = { acknowledgedAt: `${briefingDay}T08:00:00Z`, receiptId: 'r-1' };
    let calls = 0;
    const read = createServerArrival(transport(async request => { calls += 1; expect(request).toMatchObject({ method: 'GET', path: '/insight/briefings' }); return briefingBody(state) as never; }));
    expect(read()).toBeUndefined();
    expect(read()).toBeUndefined();
    await settle();
    expect(read()).toEqual({ arrivalDay: briefingDay, acknowledgedDay: briefingDay });
    expect(read()).toEqual({ arrivalDay: briefingDay, acknowledgedDay: briefingDay });
    expect(calls).toBe(1);
  });

  it('reports no acknowledged day when the owner has not confirmed, and no arrival day when the service has no weekly hours', async () => {
    const { state } = briefingSession();
    state.arrivalDay = null;
    const read = createServerArrival(transport(async () => briefingBody(state) as never));
    read();
    await settle();
    expect(read()).toEqual({ arrivalDay: null, acknowledgedDay: null });
  });

  it('gives up waiting when the read fails, so the card is never held back forever', async () => {
    const read = createServerArrival(transport(async () => { throw new PortError(503, 'SERVICE_UNAVAILABLE'); }));
    read();
    await settle();
    expect(read()).toBeNull();
  });
});
