import { describe, expect, it } from 'vitest';
import type { PosReadSnapshot, PosTableState } from '../../../contracts/pos';
import { NOW, NOW_TIME, TODAY } from '../../db/time';
import type { CctvView } from '../../cctv/view';
import { createTableLayout } from '../../../layout/table-layout';
import { createPosSeed, createPosSeedCatalog, createPosUi } from '../../../pos/seed';
import {
  createLinkedOccupancyState, cctvOccupancyObservations, observeLinkedOccupancy, pruneCctvPosLinks,
  reconcileLinkedOccupancy, selectLinkedCctvZones, selectLinkedPosTableMap, selectLinkedTableStates, setCctvPosLink,
} from './index';
import type { LinkedOccupancyState, LinkedTableSettings } from './types';

const at = NOW;
function read(): PosReadSnapshot & { settings: LinkedTableSettings } {
  const seed = createPosSeed();
  const pos = { ...seed, orders: [], bills: [], payments: [], billAllocations: [], tableSessions: [] };
  return { runId: 'links', runRevision: 0, pos, posRevision: 0, posUi: createPosUi(), dataRevision: 0, scenario: 'normal',
    settings: { businessType: 'cafe', paymentStyle: 'postpaid', tableLayout: createTableLayout(), revision: 0, cctvPosLinks: [{ zoneId: 't2', tableId: 'T2' }] },
    data: { revision: 0, catalog: createPosSeedCatalog(), dayClosed: false, closingGeneration: 0 } };
}
function occupied(r = read(), elapsedNow = 0): LinkedOccupancyState {
  return observeLinkedOccupancy(r, createLinkedOccupancyState(), { zoneId: 't2', state: 'occupied', observedAt: at, elapsedNow });
}
function view(): CctvView {
  return { mode: 'mock', connection: null, frame: { kind: 'video', el: 'mock-video' }, persons: [], cups: [], inStore: 1, occupants: 1,
    change5m: 0, tables: ['t1', 't2', 't3'].map(id => ({ id, label: { key: id }, state: id === 't2' ? 'occupied' : 'empty', occupiedSeconds: 0 })),
    avgDwell: { kind: 'mock-minutes', minutes: 10 }, stale: false, zonesCount: 3 };
}

describe('API-275 canonical settings planner', () => {
  it('starts empty and accepts an explicit association with unrelated identifiers', () => {
    const settings = { ...read().settings, cctvPosLinks: [] };
    const result = setCctvPosLink(settings, { zoneId: 'camera-west', tableId: 'T2', idempotencyKey: 'link' }, ['camera-west']);
    expect(result).toMatchObject({ ok: true, status: 'applied', value: { revision: 1, cctvPosLinks: [{ zoneId: 'camera-west', tableId: 'T2' }] } });
    expect(settings).toMatchObject({ revision: 0, cctvPosLinks: [] });
    expect(selectLinkedTableStates({ ...read(), settings }, { occupancy: occupied(), elapsedNow: 700_000 }).tables).toEqual([]);
  });

  it('repeats the same association without incrementing settings and unlinks explicitly', () => {
    const settings = read().settings;
    expect(setCctvPosLink(settings, { zoneId: 't2', tableId: 'T2', idempotencyKey: 'retry' }, ['t2'])).toMatchObject({ ok: true, status: 'unchanged', settings });
    expect(setCctvPosLink(settings, { zoneId: 't2', tableId: null, idempotencyKey: 'unlink' }, ['t2'])).toMatchObject({ ok: true, value: { cctvPosLinks: [], revision: 1 } });
  });

  it.each([
    ['t2', 'T3', 'LINK_IN_USE'], ['t3', 'T2', 'LINK_IN_USE'], ['missing', 'T1', 'UNKNOWN_ZONE'], ['t3', 'missing', 'UNKNOWN_TABLE'],
  ])('rejects %s → %s with %s without stealing an endpoint', (zoneId, tableId, reason) => {
    const settings = read().settings;
    const before = JSON.stringify(settings);
    expect(setCctvPosLink(settings, { zoneId, tableId, idempotencyKey: 'bad' }, ['t2', 't3'])).toMatchObject({ ok: false, reason });
    expect(JSON.stringify(settings)).toBe(before);
  });

  it('reports both conflicting endpoints for a rejected replacement', () => {
    expect(setCctvPosLink(read().settings, { zoneId: 't3', tableId: 'T2', idempotencyKey: 'collision' }, ['t2', 't3']))
      .toMatchObject({ ok: false, reason: 'LINK_IN_USE', details: { conflictingLinks: [{ zoneId: 't2', tableId: 'T2' }] } });
  });

  it('guards key and optimistic revision before publishing a settings change', () => {
    expect(setCctvPosLink(read().settings, { zoneId: 't3', tableId: 'T3', idempotencyKey: '' }, ['t3'])).toMatchObject({ ok: false, reason: 'KEY_REQUIRED' });
    expect(setCctvPosLink(read().settings, { zoneId: 't3', tableId: 'T3', idempotencyKey: 'stale', baseRevision: 2 }, ['t3'])).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
  });

  it.each(['prepaid', 'hidden'] as const)('hides all linked output and refuses writes for %s mode', mode => {
    const r = read(), before = occupied(r);
    const settings = mode === 'prepaid' ? { ...r.settings, paymentStyle: 'prepaid' as const }
      : { ...r.settings, posPreferences: { startTab: 'order' as const, showTables: false, showStatus: true, userChoseStart: true } };
    const disabled = { ...r, settings };
    expect(setCctvPosLink(settings, { zoneId: 't2', tableId: null, idempotencyKey: 'off' }, ['t2'])).toMatchObject({ ok: false, reason: 'TABLE_LINK_DISABLED' });
    expect(selectLinkedTableStates(disabled, { occupancy: before, elapsedNow: 700_000 })).toEqual({ tables: [], seatedWithoutOrderTasks: [] });
    expect(reconcileLinkedOccupancy(disabled, before, 700_000).seatedWithoutOrder).toEqual([]);
    expect(settings.cctvPosLinks).toEqual([{ zoneId: 't2', tableId: 'T2' }]);
  });

  it('prunes deleted zones and tables without retargeting the surviving association', () => {
    const settings = { ...read().settings, cctvPosLinks: [{ zoneId: 't2', tableId: 'T2' }, { zoneId: 'removed', tableId: 'T1' }, { zoneId: 't3', tableId: 'removed' }] };
    expect(pruneCctvPosLinks(settings, ['t2', 't3'])).toMatchObject({ revision: 1, cctvPosLinks: [{ zoneId: 't2', tableId: 'T2' }] });
    const state = reconcileLinkedOccupancy(read(), occupied(), 700_000, []);
    expect(state.observations).toEqual([]);
    expect(state.seatedWithoutOrder).toEqual([]);
  });
});

describe('API-275 read joins preserve POS status and independent entities', () => {
  it.each(['empty', 'reserved', 'occupied', 'payment_pending', 'cleaning'] as const)('retains POS %s priority with CCTV cups_left', status => {
    const r = read();
    const hasBill = status === 'occupied' || status === 'payment_pending';
    const withStatus: PosReadSnapshot = { ...r,
      pos: { ...r.pos, bills: hasBill ? [{ billId: 'open', originOrderNo: 1, tableId: 'T2', status: 'open', discounts: [], settlementLines: [], ...(status === 'payment_pending' ? { requestedAt: at } : {}) }] : [],
        tableSessions: status === 'cleaning' ? [{ tableId: 'T2', cleaning: true }] : [] },
      data: { ...r.data, reservations: status === 'reserved' ? [{ reservationId: 'visit', tableId: 'T2', date: TODAY, time: NOW_TIME, status: 'confirmed', fingerprint: 'r', completedFingerprint: 'done', name: 'Guest', partySize: 2 }] : [] } };
    const occupancy = observeLinkedOccupancy(withStatus, createLinkedOccupancyState(), { zoneId: 't2', state: 'cups_left', observedAt: at, elapsedNow: 0 });
    const joined = selectLinkedTableStates(withStatus, { occupancy, elapsedNow: 0 });
    expect(joined.tables).toEqual([{ zoneId: 't2', tableId: 'T2', occupancyState: 'cups_left', occupancyObservedAt: at,
      linkedOrderStatus: status satisfies PosTableState, needsClearingBadge: status === 'empty' || status === 'cleaning' }]);
    const map = selectLinkedPosTableMap(withStatus, { occupancy, elapsedNow: 0 });
    expect(map.tables.find(t => t.tableId === 'T2')).toMatchObject({ state: status, occupancyState: 'cups_left', needsClearingBadge: status === 'empty' || status === 'cleaning' });
    expect(map.tables.find(t => t.tableId === 'T4')).not.toHaveProperty('occupancyState');
    const zones = selectLinkedCctvZones(view(), joined);
    expect(zones.find(t => t.id === 't2')).toMatchObject({ linkedTableId: 'T2', linkedOrderStatus: status });
    expect(zones.find(t => t.id === 't1')).not.toHaveProperty('linkedTableId');
    expect(withStatus.pos).toEqual({ ...r.pos, bills: withStatus.pos.bills, tableSessions: withStatus.pos.tableSessions });
  });

  it('removes both cup badges when cups disappear without clearing the POS cleaning flag', () => {
    const r = read(), cleaning = { ...r, pos: { ...r.pos, tableSessions: [{ tableId: 'T2', cleaning: true }] } };
    let occupancy = observeLinkedOccupancy(cleaning, createLinkedOccupancyState(), { zoneId: 't2', state: 'cups_left', observedAt: at, elapsedNow: 0 });
    expect(selectLinkedTableStates(cleaning, { occupancy, elapsedNow: 0 }).tables[0].needsClearingBadge).toBe(true);
    occupancy = observeLinkedOccupancy(cleaning, occupancy, { zoneId: 't2', state: 'empty', observedAt: at, elapsedNow: 1 });
    const joined = selectLinkedTableStates(cleaning, { occupancy, elapsedNow: 1 });
    expect(joined.tables[0]).toMatchObject({ occupancyState: 'empty', linkedOrderStatus: 'cleaning', needsClearingBadge: false });
    expect(selectLinkedCctvZones(view(), joined).find(t => t.id === 't2')).toMatchObject({ needsClearingBadge: false });
    expect(cleaning.pos.tableSessions[0].cleaning).toBe(true);
  });

  it('represents missing observations as unavailable rather than empty', () => {
    expect(selectLinkedTableStates(read(), { occupancy: createLinkedOccupancyState(), elapsedNow: 0 }).tables[0])
      .toMatchObject({ occupancyState: null, occupancyObservedAt: null, needsClearingBadge: false });
  });
});

describe('API-275 monotonic anonymous eligibility', () => {
  it.each([[540_000, 0], [600_000, 0], [600_001, 1]] as const)('at %d elapsed milliseconds exposes %d tasks', (elapsedNow, count) => {
    const tasks = selectLinkedTableStates(read(), { occupancy: occupied(), elapsedNow }).seatedWithoutOrderTasks;
    expect(tasks).toHaveLength(count);
    if (count) expect(tasks[0]).toMatchObject({ group: 'tasks', tableId: 'T2', params: { table: 'T2', n: 10 } });
  });

  it('repeated frames and video timestamp loops do not restart the elapsed clock', () => {
    const r = read();
    let state = occupied(r, 100);
    state = observeLinkedOccupancy(r, state, { zoneId: 't2', state: 'occupied', observedAt: '2026-10-26T15:40', elapsedNow: 600_101 });
    expect(state.seatedWithoutOrder).toEqual([{ zoneId: 't2', tableId: 'T2', since: 100 }]);
    expect(selectLinkedTableStates(r, { occupancy: state, elapsedNow: 600_101 }).seatedWithoutOrderTasks).toHaveLength(1);
    expect(observeLinkedOccupancy(r, state, { zoneId: 't2', state: 'occupied', observedAt: at, elapsedNow: 50 }).elapsedNow).toBe(600_101);
  });

  it.each(['empty', 'cups_left', null] as const)('departure or lost source %s clears eligibility immediately', next => {
    const r = read(), state = observeLinkedOccupancy(r, occupied(), { zoneId: 't2', state: next, observedAt: next ? at : null, elapsedNow: 700_000 });
    expect(state.seatedWithoutOrder).toEqual([]);
    expect(selectLinkedTableStates(r, { occupancy: state, elapsedNow: 700_000 }).seatedWithoutOrderTasks).toEqual([]);
  });

  it('starts eligibility after the previous order ends, rather than at the earlier occupied observation', () => {
    const r = read(), ordering = { ...r, pos: { ...r.pos, bills: [{ billId: 'open', originOrderNo: 1, tableId: 'T2', status: 'partial' as const, discounts: [], settlementLines: [] }] } };
    const seated = occupied(ordering);
    expect(seated.seatedWithoutOrder).toEqual([]);
    const waiting = reconcileLinkedOccupancy(r, seated, 700_000);
    expect(waiting.seatedWithoutOrder).toEqual([{ zoneId: 't2', tableId: 'T2', since: 700_000 }]);
    expect(selectLinkedTableStates(r, { occupancy: waiting, elapsedNow: 700_001 }).seatedWithoutOrderTasks).toEqual([]);
    expect(reconcileLinkedOccupancy(ordering, waiting, 800_000).seatedWithoutOrder).toEqual([]);
  });

  it('resets on unlink and inactive mode, then starts a new eligible period on relink', () => {
    const r = read(), state = occupied();
    const unlinked = { ...r, settings: { ...r.settings, cctvPosLinks: [] } };
    const cleared = reconcileLinkedOccupancy(unlinked, state, 700_000);
    expect(cleared.seatedWithoutOrder).toEqual([]);
    expect(reconcileLinkedOccupancy(r, cleared, 800_000).seatedWithoutOrder).toEqual([{ zoneId: 't2', tableId: 'T2', since: 800_000 }]);
    const off = reconcileLinkedOccupancy({ ...r, settings: { ...r.settings, paymentStyle: 'prepaid' } }, state, 700_000);
    expect(reconcileLinkedOccupancy(r, off, 800_000).seatedWithoutOrder[0].since).toBe(800_000);
  });

  it('ignores invalid observation input and excludes unlinked zones from tasks', () => {
    const r = read(), state = occupied();
    expect(observeLinkedOccupancy(r, state, { zoneId: 't2', state: 'occupied', observedAt: at, elapsedNow: NaN })).toBe(state);
    const unlinked = observeLinkedOccupancy(r, createLinkedOccupancyState(), { zoneId: 't4', state: 'occupied', observedAt: at, elapsedNow: 0 });
    expect(selectLinkedTableStates(r, { occupancy: unlinked, elapsedNow: 700_000 }).seatedWithoutOrderTasks).toEqual([]);
  });
});

describe('existing CCTV source adapter', () => {
  it('copies only anonymous states, mapping clear to cups_left without recording boxes', () => {
    const v = view();
    const rows = cctvOccupancyObservations({ ...v, tables: v.tables.map(t => t.id === 't3' ? { ...t, state: 'clear' } : t) }, at, 15);
    expect(rows).toEqual([
      { zoneId: 't1', state: 'empty', observedAt: at, elapsedNow: 15 },
      { zoneId: 't2', state: 'occupied', observedAt: at, elapsedNow: 15 },
      { zoneId: 't3', state: 'cups_left', observedAt: at, elapsedNow: 15 },
    ]);
  });

  it.each(['reconnecting', 'lost', 'none'] as const)('treats %s live data as unavailable', connection => {
    const rows = cctvOccupancyObservations({ ...view(), mode: 'live', connection, stale: connection === 'reconnecting' }, at, 1);
    expect(rows.every(row => row.state === null && row.observedAt === null)).toBe(true);
  });

  it('treats a live connection without reliable counts as unavailable', () => {
    expect(cctvOccupancyObservations({ ...view(), mode: 'live', connection: 'live', inStore: null, occupants: null }, at, 1)[1].state).toBeNull();
    expect(cctvOccupancyObservations({ ...view(), mode: 'live', connection: 'live' }, at, 1)[1].state).toBe('occupied');
  });
});
