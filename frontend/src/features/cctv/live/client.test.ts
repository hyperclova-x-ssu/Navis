import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LiveClient, LOST_MS, PING_MS, RECONNECTING_MS, SERVER_RETRY_MS} from './client';
import {encodeFrameMessage} from './frame';
import {liveCctvView} from './liveView';
import {fakeBitmap, fakeFetch, FakeSocket, frameHeader, zoneSet, type Route} from './testFakes';

const base = 'https://cnn.test:8443';
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

let now = 0;
let healthy = true;
const routes: Route = (_m, p) => {
  if (p === '/api/health') return healthy ? {status: 200, body: {ok: true, camera: 'none', zonesRevision: 1}} : 'throw';
  if (p === '/api/zones') return {status: 200, body: zoneSet()};
  return {status: 404};
};

function make(opts: {base?: string | null; decode?: (b: Blob) => Promise<ImageBitmap>} = {}) {
  const fetch = fakeFetch(routes);
  const c = new LiveClient({
    base: opts.base === undefined ? base : opts.base,
    fetch,
    WebSocket: FakeSocket as never,
    createImageBitmap: opts.decode ?? (async () => fakeBitmap(0)),
    now: () => now,
  });
  return {c, fetch};
}

const sock = () => FakeSocket.instances.at(-1)!;
const flush = () => vi.advanceTimersByTimeAsync(0);
async function advance(ms: number) {
  now += ms;
  await vi.advanceTimersByTimeAsync(ms);
}
async function connected(c: LiveClient, video = false) {
  const release = c.acquire({video});
  await flush();
  sock().open();
  await flush();
  return release;
}

it('projects a measured drink wait from live frames and resets it across a stale connection', async () => {
  const {c} = make();
  const release = await connected(c);
  const id = 'za0000001';
  const send = (captureT: number, occupied: boolean, hasCup = false) => {
    const header = frameHeader({captureT, frameId: captureT, persons: occupied ? [[0, 0, 0.05, 0.01, id]] : [],
      cups: hasCup ? [[0.02, 0, 0.03, 0.01]] : [], counts: {...frameHeader().counts, occupiedTables: occupied ? [id] : []}});
    sock().binary(encodeFrameMessage(header));
    return liveCctvView(c.getSnapshot()).tables.find(t => t.id === id)?.drinkWait;
  };
  send(100, false);
  expect(send(101, true)).toEqual({state: 'waiting', seconds: 0});
  expect(send(102, true, true)).toEqual({state: 'waiting', seconds: 1});
  expect(send(103, true, true)).toEqual({state: 'received', seconds: 1});
  await advance(RECONNECTING_MS);
  expect(liveCctvView(c.getSnapshot()).tables[0].drinkWait).toEqual({state: 'received', seconds: 1});
  expect(send(104, true)).toEqual({state: 'start-unknown', seconds: null});
  release();
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.reset();
  now = 0;
  healthy = true;
});
afterEach(() => vi.useRealTimers());

describe('LiveClient connection states (DATA_MODEL 12.6)', () => {
  it('not configured: server-down/not-configured and no fetch or socket', async () => {
    const {c, fetch} = make({base: null});
    c.acquire({video: true});
    await flush();
    expect(c.getSnapshot()).toMatchObject({connection: 'server-down', serverDown: 'not-configured'});
    expect(fetch.calls).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('health → socket → subscribe; camera none/waiting/connected map to states', async () => {
    const {c} = make();
    await connected(c);
    expect(sock().url).toBe('wss://cnn.test:8443/ws/view');
    expect(sock().binaryType).toBe('arraybuffer');
    expect(sock().sent[0]).toEqual({type: 'subscribe', video: false});
    expect(c.getSnapshot().connection).toBe('none');
    sock().text({type: 'status', camera: 'waiting', zonesRevision: 1, serverT: 5});
    expect(c.getSnapshot().connection).toBe('waiting');
    sock().text({type: 'status', camera: 'connected', zonesRevision: 1, serverT: 6});
    expect(c.getSnapshot().connection).toBe('phone-opened');
  });

  it('frame → live; 2 s → reconnecting (numbers kept, stale); 5 s → lost (hidden); new frame → live', async () => {
    const {c} = make();
    await connected(c);
    sock().text({type: 'status', camera: 'live', zonesRevision: 1, serverT: 6});
    sock().binary(encodeFrameMessage(frameHeader()));
    expect(c.getSnapshot().connection).toBe('live');
    await advance(RECONNECTING_MS - 250);
    expect(c.getSnapshot().connection).toBe('live');
    await advance(250);
    expect(c.getSnapshot().connection).toBe('reconnecting');
    let v = liveCctvView(c.getSnapshot());
    expect(v.stale).toBe(true);
    expect(v.inStore).toBe(2);
    // the server already says the camera closed: still reconnecting until 5 s
    sock().text({type: 'status', camera: 'waiting', zonesRevision: 1, serverT: 8});
    expect(c.getSnapshot().connection).toBe('reconnecting');
    await advance(LOST_MS - RECONNECTING_MS);
    expect(c.getSnapshot().connection).toBe('lost');
    v = liveCctvView(c.getSnapshot());
    expect(v.inStore).toBeNull();
    expect(v.occupants).toBeNull();
    expect(v.persons).toEqual([]);
    expect(v.frame).toBeNull();
    sock().binary(encodeFrameMessage(frameHeader({frameId: 9})));
    expect(c.getSnapshot().connection).toBe('live');
  });

  it('lost → retry() forgets the old session and follows the camera status again', async () => {
    const {c} = make();
    await connected(c);
    sock().binary(encodeFrameMessage(frameHeader()));
    await advance(LOST_MS);
    expect(c.getSnapshot().connection).toBe('lost');
    sock().text({type: 'status', camera: 'waiting', zonesRevision: 1, serverT: 8});
    c.retry();
    expect(c.getSnapshot().connection).toBe('waiting');
  });

  it('health fails → server-down/unreachable, retried every 3 s, then back', async () => {
    healthy = false;
    const {c, fetch} = make();
    c.acquire({video: false});
    await flush();
    expect(c.getSnapshot()).toMatchObject({connection: 'server-down', serverDown: 'unreachable'});
    await advance(SERVER_RETRY_MS);
    expect(fetch.calls.filter((x) => x.path === '/api/health')).toHaveLength(2);
    healthy = true;
    await advance(SERVER_RETRY_MS);
    sock().open();
    await flush();
    sock().text({type: 'status', camera: 'waiting', zonesRevision: 1, serverT: 1});
    expect(c.getSnapshot().connection).toBe('waiting');
    expect(c.getSnapshot().serverDown).toBeUndefined();
  });

  it('socket drop → server-down/unreachable and retry; close 4403 → bad-origin', async () => {
    const {c} = make();
    await connected(c);
    sock().drop(1006);
    expect(c.getSnapshot()).toMatchObject({connection: 'server-down', serverDown: 'unreachable'});
    await advance(SERVER_RETRY_MS);
    expect(FakeSocket.instances).toHaveLength(2);
    sock().drop(4403);
    expect(c.getSnapshot().serverDown).toBe('bad-origin');
  });

  it('health 403 → bad-origin', async () => {
    const c = new LiveClient({base, fetch: fakeFetch(() => ({status: 403, body: {error: {code: 'BAD_ORIGIN'}}})), WebSocket: FakeSocket as never, now: () => now});
    c.acquire({video: false});
    await flush();
    expect(c.getSnapshot()).toMatchObject({connection: 'server-down', serverDown: 'bad-origin'});
  });
});

describe('LiveClient socket sharing (ARCHITECTURE 14.6)', () => {
  it('one socket per page by reference count; video follows the consumers', async () => {
    const {c} = make();
    const r1 = await connected(c, false);
    const r2 = c.acquire({video: true});
    const r3 = c.acquire({video: true});
    expect(FakeSocket.instances).toHaveLength(1);
    expect(sock().sent.filter((m) => (m as {type: string}).type === 'subscribe')).toEqual([
      {type: 'subscribe', video: false},
      {type: 'subscribe', video: true},
    ]);
    r2();
    expect(sock().sent.at(-1)).not.toEqual({type: 'subscribe', video: false});
    r3();
    expect(sock().sent.at(-1)).toEqual({type: 'subscribe', video: false});
    r3(); // double release is ignored
    expect(c.refCount).toBe(1);
    r1();
    expect(c.refCount).toBe(0);
    expect(sock().closed).toBe(true);
  });

  it('ping every 2 s; pong gives e2eMs on the next frame', async () => {
    const {c} = make();
    now = 1000;
    await connected(c);
    const pings = () => sock().sent.filter((m) => (m as {type: string}).type === 'ping');
    expect(pings()).toHaveLength(1);
    await advance(PING_MS);
    expect(pings()).toHaveLength(2);
    const t = (pings()[1] as {t: number}).t; // 3.0 s local
    now += 20;
    sock().text({type: 'pong', t, serverT: t + 100.01}); // offset ≈ +100 s
    sock().binary(encodeFrameMessage(frameHeader({captureT: t + 100.02 - 0.3})));
    expect(c.getSnapshot().e2eMs).toBe(300);
    expect(liveCctvView(c.getSnapshot()).stats).toEqual({fps: 15, latencyMs: 50, e2eMs: 300});
  });

  it('a zones message re-reads GET /api/zones', async () => {
    const {c, fetch} = make();
    await connected(c);
    expect(c.getSnapshot().zones?.revision).toBe(1);
    sock().text({type: 'zones', revision: 2});
    await flush();
    expect(fetch.calls.filter((x) => x.path === '/api/zones')).toHaveLength(2);
  });
});

describe('LiveClient frames (newest only, bitmap close)', () => {
  it('decodes only the newest frame and closes replaced bitmaps', async () => {
    const resolvers: ((b: ImageBitmap) => void)[] = [];
    const decode = () => new Promise<ImageBitmap>((r) => resolvers.push(r));
    const {c} = make({decode});
    await connected(c, true);
    sock().binary(encodeFrameMessage(frameHeader({frameId: 1}), jpeg));
    sock().binary(encodeFrameMessage(frameHeader({frameId: 2}), jpeg));
    sock().binary(encodeFrameMessage(frameHeader({frameId: 3}), jpeg));
    expect(resolvers).toHaveLength(1); // 2 was replaced by 3 while 1 decoded
    const b1 = fakeBitmap(1);
    resolvers[0]!(b1);
    await flush();
    // frame 3 is waiting, so 1 is shown only if newest; it is older → closed, not shown
    expect(b1.closed).toBe(true);
    expect(resolvers).toHaveLength(2);
    const b3 = fakeBitmap(3);
    resolvers[1]!(b3);
    await flush();
    expect(c.getSnapshot().frame?.frameId).toBe(3);
    expect(c.getSnapshot().bitmap?.bitmap).toBe(b3);
    sock().binary(encodeFrameMessage(frameHeader({frameId: 4}), jpeg));
    const b4 = fakeBitmap(4);
    resolvers[2]!(b4);
    await flush();
    expect(b3.closed).toBe(true);
    expect(c.getSnapshot().bitmap?.bitmap).toBe(b4);
    const v = liveCctvView(c.getSnapshot());
    expect(v.frame).toEqual({kind: 'bitmap', bitmap: b4, w: 1280, h: 720});
  });

  it('video:false skips decoding and closes the last bitmap on release/stop', async () => {
    const decode = vi.fn(async () => fakeBitmap(1));
    const {c} = make({decode});
    const rv = await connected(c, true);
    sock().binary(encodeFrameMessage(frameHeader(), jpeg));
    await flush();
    const bmp = c.getSnapshot().bitmap!.bitmap as unknown as {closed: boolean};
    const rn = c.acquire({video: false});
    rv();
    expect(bmp.closed).toBe(true);
    sock().binary(encodeFrameMessage(frameHeader({frameId: 2}), jpeg));
    await flush();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().frame?.frameId).toBe(2);
    rn();
  });

  it('malformed binary messages are ignored', async () => {
    const {c} = make();
    await connected(c);
    sock().binary(new ArrayBuffer(2));
    expect(c.getSnapshot().frame).toBeNull();
    expect(c.getSnapshot().connection).toBe('none');
  });
});
