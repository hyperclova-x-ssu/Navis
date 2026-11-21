import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DetectionError, clearDetectionsCache, containRect, formatClock, loadDetections, pickFrame, validateDetections} from './detections';
import type {DetectionsFile} from './types';

const real = JSON.parse(readFileSync(resolve(process.cwd(), 'public/cnn/store-sample-detections.json'), 'utf8')) as DetectionsFile;
const counts = {inStore: 0, seated: 0, inStoreRaw: 0, seatedRaw: 0, occupiedTables: [], tablesToClear: []};
const mk = (ts: number[]) => ts.map(t => ({t, persons: [], cups: [], counts}));
const okResponse = (body: unknown) => ({ok: true, json: async () => body}) as Response;
afterEach(() => {clearDetectionsCache(); vi.unstubAllGlobals();});

describe('pickFrame', () => {
  const frames = mk([0, 0.2, 0.4, 0.6]);
  it('bounds', () => {
    expect(pickFrame(frames, -5).t).toBe(0);
    expect(pickFrame(frames, 0).t).toBe(0);
    expect(pickFrame(frames, 0.6).t).toBe(0.6);
    expect(pickFrame(frames, 99).t).toBe(0.6);
  });
  it('nearest and tie goes to the earlier frame', () => {
    expect(pickFrame(frames, 0.29).t).toBe(0.2);
    expect(pickFrame(frames, 0.31).t).toBe(0.4);
    expect(pickFrame(mk([0, 1]), 0.5).t).toBe(0);
  });
  it('seek back and forth', () => {
    expect(pickFrame(frames, 0.5).t).toBe(0.4);
    expect(pickFrame(frames, 0.1).t).toBe(0);
  });
  it('single frame, and real file near t=20', () => {
    expect(pickFrame(mk([3]), 100).t).toBe(3);
    expect(pickFrame(real.frames, 20.03).t).toBe(20);
  });
});

describe('validateDetections', () => {
  const clone = () => structuredClone(real);
  it('accepts the three-zone store sample with team footage attribution', () => {
    expect(validateDetections(real).frames.length).toBe(real.frameCount);
    expect(real.source).toBe('Team-recorded store sample');
    expect(real.tables.map(t => t.name)).toEqual(['왼쪽 나무 테이블', '가운데 흰 테이블', '주문대 옆 흰 테이블']);
  });
  it('keeps the store sample headcount and seated count aligned with its boxes', () => {
    for (const frame of real.frames) {
      expect(frame.counts.inStore, `headcount at ${frame.t}s`).toBe(frame.persons.length);
      expect(frame.counts.seated, `seated at ${frame.t}s`).toBe(frame.persons.filter(p => p[5] !== null).length);
    }
  });
  it('marks the counter table for clearing after the guest stands and resets it after pickup', () => {
    const counterClear = real.frames.filter(frame => frame.counts.tablesToClear.includes('t3'));
    expect(counterClear).toHaveLength(72);
    expect(counterClear[0].t).toBe(65.2);
    expect(counterClear.at(-1)!.t).toBe(79.4);
    expect(pickFrame(real.frames, 79.6).counts.tablesToClear).not.toContain('t3');
    expect(pickFrame(real.frames, 80).counts.tablesToClear).not.toContain('t3');
  });
  it('waits for cup observations after placement and retains cups between scans', () => {
    const hasCup = (frame: DetectionsFile['frames'][number], left: number, right: number) =>
      frame.cups.some(([x1, , x2]) => (x1 + x2) / 2 >= left && (x1 + x2) / 2 <= right);
    expect(hasCup(real.frames[0], 0.60, 0.64)).toBe(false);
    expect(hasCup(pickFrame(real.frames, 10), 0.60, 0.64)).toBe(true);
    expect(hasCup(pickFrame(real.frames, 80), 0.60, 0.64)).toBe(false);
    expect(real.frames.filter(f => f.t < 30).some(f => hasCup(f, 0.39, 0.43))).toBe(false);
    expect(real.frames.filter(f => f.t >= 33).every(f => hasCup(f, 0.39, 0.43))).toBe(true);
    expect(real.frames.filter(f => f.t < 82.8).some(f => hasCup(f, 0.49, 0.52))).toBe(false);
    expect(hasCup(real.frames.at(-1)!, 0.49, 0.52)).toBe(true);
  });
  it('counts visible people at startup and stabilizes changes through the clip', () => {
    expect(real.frames[0].counts.inStore).toBe(3);
    expect(pickFrame(real.frames, 1).counts.inStore).toBe(3);
    expect(pickFrame(real.frames, 20).counts.inStore).toBe(5);
    expect(pickFrame(real.frames, 80).counts.inStore).toBe(4);
    const changes = real.frames.filter((f, i) => i > 0 && f.counts.inStore !== real.frames[i - 1].counts.inStore);
    expect(changes.length * real.fps * 60 / real.frameCount).toBeLessThanOrEqual(4);
  });
  it('rejects bad shapes with FORMAT', () => {
    type Loose = {frames: any; tables: any; summary: any}; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cases: ((d: Loose) => void)[] = [
      d => {d.frames = 'x';},
      d => {d.frames = [];},
      d => {d.frames[5].t = -1;},
      d => {delete d.frames[3].counts.seated;},
      d => {d.frames[10].persons = [[1.5, 0, 0.5, 0.5, 1, null]];},
      d => {d.frames[2].cups = [[0, 0, 1]];},
      d => {d.tables = d.tables.slice(0, 2);},
      d => {d.tables[0].id = 'tx';},
      d => {d.summary = null;},
      d => {delete d.summary.smoothing;},
      d => {delete d.frames[4].counts.inStoreRaw;},
      d => {d.frames[4].counts.inStore = 2.5;},
    ];
    for (const mutate of cases) {
      const d = clone(); mutate(d as unknown as Loose);
      expect(() => validateDetections(d)).toThrowError(DetectionError);
      try {validateDetections(d);} catch (e) {expect((e as DetectionError).reason).toBe('FORMAT');}
    }
  });
});

describe('loadDetections', () => {
  it('loads once and caches', async () => {
    const f = vi.fn(async () => okResponse(real)); vi.stubGlobal('fetch', f);
    const a = await loadDetections(new AbortController().signal);
    const b = await loadDetections(new AbortController().signal);
    expect(a).toBe(b); expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls as unknown[][])[0][0]).toBe('/cnn/store-sample-detections.json');
  });
  it('maps failures: network, http, format', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {throw new TypeError('x');}));
    await expect(loadDetections(new AbortController().signal)).rejects.toMatchObject({reason: 'NETWORK'});
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: false, status: 404}) as Response));
    await expect(loadDetections(new AbortController().signal)).rejects.toMatchObject({reason: 'NETWORK'});
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({frames: [{t: 1}]})));
    await expect(loadDetections(new AbortController().signal)).rejects.toMatchObject({reason: 'FORMAT'});
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, json: async () => {throw new SyntaxError('bad');}}) as unknown as Response));
    await expect(loadDetections(new AbortController().signal)).rejects.toMatchObject({reason: 'FORMAT'});
  });
  it('failures are not cached, so retry works', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {throw new TypeError('x');}));
    await expect(loadDetections(new AbortController().signal)).rejects.toBeDefined();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(real)));
    await expect(loadDetections(new AbortController().signal)).resolves.toBeDefined();
  });
  it('abort rejects with AbortError and does not populate the cache', async () => {
    const ac = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))));
    const p = loadDetections(ac.signal); ac.abort();
    await expect(p).rejects.toMatchObject({name: 'AbortError'});
    const f = vi.fn(async () => okResponse(real)); vi.stubGlobal('fetch', f);
    await loadDetections(new AbortController().signal);
    expect(f).toHaveBeenCalledTimes(1);
    const pre = new AbortController(); pre.abort();
    await expect(loadDetections(pre.signal)).rejects.toMatchObject({name: 'AbortError'});
  });
});

describe('shared in-flight request', () => {
  it('several simultaneous callers (panels) fetch once', async () => {
    const f = vi.fn(async () => okResponse(real)); vi.stubGlobal('fetch', f);
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => loadDetections(new AbortController().signal)));
    expect(a).toBe(b); expect(b).toBe(c); expect(f).toHaveBeenCalledTimes(1);
  });
  it('one caller aborting does not cancel the others; all aborting cancels the fetch', async () => {
    let aborted = false;
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((resolve, reject) => {
      init.signal!.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
      setTimeout(() => resolve(okResponse(real)), 20);
    })));
    const a = new AbortController(), b = new AbortController();
    const pa = loadDetections(a.signal), pb = loadDetections(b.signal);
    a.abort();
    await expect(pa).rejects.toMatchObject({name: 'AbortError'});
    await expect(pb).resolves.toBeDefined();
    expect(aborted).toBe(false);
    clearDetectionsCache();
    const c = new AbortController(), d = new AbortController();
    const pc = loadDetections(c.signal), pd = loadDetections(d.signal);
    c.abort(); d.abort();
    await expect(pc).rejects.toBeDefined(); await expect(pd).rejects.toBeDefined();
    expect(aborted).toBe(true);
  });
});

describe('helpers', () => {
  it('containRect letterboxes 16:9 inside a taller box', () => {
    expect(containRect(800, 600, 960, 540)).toEqual({x: 0, y: 75, width: 800, height: 450});
    expect(containRect(1600, 450, 960, 540)).toEqual({x: 400, y: 0, width: 800, height: 450});
    expect(containRect(0, 0, 960, 540)).toEqual({x: 0, y: 0, width: 0, height: 0});
  });
  it('formatClock', () => {
    expect(formatClock(160)).toBe('02:40');
    expect(formatClock(344.1)).toBe('05:44');
    expect(formatClock(-3)).toBe('00:00');
  });
});
