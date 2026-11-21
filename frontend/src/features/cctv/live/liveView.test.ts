import {act, renderHook} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {LiveSnapshot} from './client';
import {LiveClient} from './client';
import {setLiveClientForTest, useLiveCctvView, useLiveConnection, requestPairing} from './hooks';
import {liveCctvView, noOutline} from './liveView';
import {fakeFetch, FakeSocket, frameHeader, zoneSet} from './testFakes';

const snap = (p: Partial<LiveSnapshot>): LiveSnapshot => ({
  connection: 'live',
  camera: 'live',
  frame: frameHeader(),
  bitmap: null,
  zones: zoneSet(),
  zonesAspectMismatch: false,
  e2eMs: null,
  ...p,
});

describe('liveCctvView (DATA_MODEL 12.6)', () => {
  it('tables in zone number order, labelled 테이블 N, state from server counts', () => {
    const v = liveCctvView(snap({}), noOutline);
    expect(v.mode).toBe('live');
    expect(v.tables.map((t) => t.id)).toEqual(['za0000001', 'zb0000002', 'zc0000003']);
    expect(v.tables[0]).toMatchObject({label: {key: 'cctv.table.n', params: {n: 1}}, state: 'occupied', occupiedSeconds: 42.5, rings: []});
    expect(v.tables[1]!.state).toBe('clear');
    expect(v.tables[2]).toMatchObject({state: 'empty', occupiedSeconds: null});
    expect(v).toMatchObject({inStore: 2, occupants: 1, change5m: 1, avgDwell: {kind: 'live-seconds', seconds: 61.2}, zonesCount: 3, stale: false});
    expect(v.persons).toEqual([[0.1, 0.1, 0.2, 0.5], [0.5, 0.1, 0.6, 0.5]]);
  });

  it('default outline comes from the zone mask (T-073 zoneOutline)', () => {
    const rings = liveCctvView(snap({})).tables[0]!.rings!;
    expect(rings.length).toBeGreaterThan(0);
    for (const ring of rings) for (const [x, y] of ring) expect(x >= 0 && x <= 1 && y >= 0 && y <= 1).toBe(true);
  });

  it('a custom outline function is used as given', () => {
    const outline = vi.fn(() => [[[0, 0], [1, 0], [1, 1]]] as [number, number][][]);
    const s = snap({});
    liveCctvView(s, outline);
    expect(outline).toHaveBeenCalledTimes(3);
    expect(liveCctvView(s, outline).tables[0]!.rings).toHaveLength(1);
  });

  it('no zones → zonesCount 0; waiting → numbers null; change5m null passes through', () => {
    expect(liveCctvView(snap({zones: zoneSet({zones: []})})).zonesCount).toBe(0);
    const w = liveCctvView(snap({connection: 'waiting'}));
    expect(w).toMatchObject({inStore: null, occupants: null, change5m: null, frame: null, connection: 'waiting'});
    expect(w.tables.every((t) => t.state === 'empty')).toBe(true);
    expect(liveCctvView(snap({frame: frameHeader({change5m: null, avgOccupiedSeconds: null})})).change5m).toBeNull();
    expect(liveCctvView(snap({connection: 'server-down', serverDown: 'unreachable'})).serverDown).toBe('unreachable');
  });
});

describe('hooks', () => {
  afterEach(() => {
    setLiveClientForTest(null);
    vi.unstubAllEnvs();
  });

  it('useLiveConnection holds the socket while mounted; requestPairing maps errors', async () => {
    FakeSocket.reset();
    const f = fakeFetch((_m, p) => (p === '/api/health' ? {status: 200, body: {ok: true, camera: 'waiting', zonesRevision: 0}} : {status: 429}));
    const c = new LiveClient({base: 'https://cnn.test', fetch: f, WebSocket: FakeSocket as never});
    setLiveClientForTest(c);
    const h = renderHook(() => useLiveConnection());
    const v = renderHook(() => useLiveCctvView({video: true}));
    expect(c.refCount).toBe(2);
    await act(async () => {});
    act(() => FakeSocket.instances[0]!.open());
    expect(h.result.current.connection).toBe('waiting');
    expect(v.result.current.connection).toBe('waiting');
    h.unmount();
    v.unmount();
    expect(c.refCount).toBe(0);
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    vi.stubEnv('VITE_CNN_SERVER_URL', '');
    expect(await requestPairing({replace: false, lang: 'ko'})).toMatchObject({ok: false, code: 'NOT_CONFIGURED'});
  });

  it('enabled:false holds no socket', () => {
    const c = new LiveClient({base: 'https://cnn.test', fetch: fakeFetch(() => 'hang'), WebSocket: FakeSocket as never});
    setLiveClientForTest(c);
    renderHook(() => useLiveCctvView({video: true, enabled: false}));
    expect(c.refCount).toBe(0);
  });
});
