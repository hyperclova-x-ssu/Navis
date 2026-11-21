import type {Box, DetectionFailure, DetectionFrame, DetectionsFile} from './types';

export const DETECTIONS_URL = '/cnn/store-sample-detections.json';
export const VIDEO_URL = '/cnn/store-sample.mp4';
export const SAMPLE_START_TIME = 20;
const TABLE_IDS = ['t1', 't2', 't3', 't4'];

export class DetectionError extends Error {
  constructor(readonly reason: Exclude<DetectionFailure, 'VIDEO'>, message?: string) { super(message ?? reason); this.name = 'DetectionError'; }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => isNum(v) && v >= 0 && Number.isInteger(v);
const unit = (v: unknown) => isNum(v) && v >= 0 && v <= 1;
const isBox = (v: unknown): v is Box => Array.isArray(v) && v.length === 4 && v.every(unit);
const isStrings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');

/** Whole-file check: one bad frame fails the whole file (no partial display). */
export function validateDetections(raw: unknown): DetectionsFile {
  const bad = (why: string): never => { throw new DetectionError('FORMAT', why); };
  const d = raw as Partial<DetectionsFile> | null;
  if (!d || typeof d !== 'object') return bad('not an object');
  if (!Array.isArray(d.frames) || d.frames.length === 0) return bad('frames');
  if (!Array.isArray(d.tables) || d.tables.length < 3 || d.tables.length > TABLE_IDS.length || !d.tables.every((table, i) => table?.id === TABLE_IDS[i])) return bad('tables');
  for (const t of d.tables) {
    if (typeof t.name !== 'string' || !Array.isArray(t.polygon) || t.polygon.length < 3 || !t.polygon.every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every(unit))) return bad('table polygon');
  }
  const s = d.summary;
  if (!s || typeof s !== 'object' || !isNum(s.avgInStore) || !s.tableOccupiedSeconds || typeof s.tableOccupiedSeconds !== 'object') return bad('summary');
  if (!s.smoothing || typeof s.smoothing !== 'object') return bad('summary.smoothing');
  let prev = -Infinity;
  for (const f of d.frames as DetectionFrame[]) {
    if (!f || !isNum(f.t) || f.t < 0 || f.t < prev) return bad('t order');
    prev = f.t;
    const c = f.counts;
    if (!c || !isCount(c.inStore) || !isCount(c.seated) || !isCount(c.inStoreRaw) || !isCount(c.seatedRaw) || !isStrings(c.occupiedTables) || !isStrings(c.tablesToClear)) return bad('counts');
    if (!Array.isArray(f.persons) || !f.persons.every((p: readonly unknown[]) => Array.isArray(p) && p.length === 6 && isBox(p.slice(0, 4)) && isNum(p[4]) && (p[5] === null || typeof p[5] === 'string'))) return bad('persons');
    if (!Array.isArray(f.cups) || !f.cups.every(isBox)) return bad('cups');
  }
  return d as DetectionsFile;
}

let cache: DetectionsFile | null = null;
export function clearDetectionsCache(): void { cache = null; }

const abortError = () => new DOMException('aborted', 'AbortError');
const isAbort = (e: unknown) => (e as {name?: string} | null)?.name === 'AbortError';

async function fetchDetections(signal: AbortSignal, url: string): Promise<DetectionsFile> {
  let body: unknown;
  try {
    const res = await fetch(url, {signal});
    if (!res.ok) throw new DetectionError('NETWORK', `HTTP ${res.status}`);
    try { body = await res.json(); } catch (e) {
      if (isAbort(e) || signal.aborted) throw e;
      throw new DetectionError('FORMAT', 'json');
    }
  } catch (e) {
    if (e instanceof DetectionError) throw e;
    if (isAbort(e) || signal.aborted) throw abortError();
    throw new DetectionError('NETWORK');
  }
  if (signal.aborted) throw abortError();
  return validateDetections(body);
}

let inflight: {promise: Promise<DetectionsFile>; ac: AbortController; users: number} | null = null;

/** API-13: one fetch per run (cached); simultaneous callers (several panels + the detail) share one request. Failures are not cached so "다시 불러오기" retries. */
export async function loadDetections(signal: AbortSignal, url: string = DETECTIONS_URL): Promise<DetectionsFile> {
  if (signal.aborted) throw abortError();
  if (url !== DETECTIONS_URL) return fetchDetections(signal, url); // a custom URL (dev failure check) bypasses the run cache
  if (cache) return cache;
  if (!inflight) {
    const ac = new AbortController();
    const entry = {ac, users: 0, promise: undefined as unknown as Promise<DetectionsFile>};
    entry.promise = fetchDetections(ac.signal, url).then(
      f => { cache = f; if (inflight === entry) inflight = null; return f; },
      e => { if (inflight === entry) inflight = null; throw e; });
    inflight = entry;
  }
  const entry = inflight;
  entry.users++;
  return new Promise<DetectionsFile>((resolve, reject) => {
    const onAbort = () => {
      entry.users--;
      if (entry.users <= 0 && inflight === entry) { inflight = null; entry.ac.abort(); }
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, {once: true});
    entry.promise.then(
      f => { signal.removeEventListener('abort', onAbort); resolve(f); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/** |t − currentTime| minimum by binary search; equal distance picks the earlier frame. */
export function pickFrame<T extends {readonly t: number}>(frames: readonly T[], currentTime: number): T {
  if (frames.length === 0) throw new RangeError('no frames');
  let lo = 0, hi = frames.length - 1;
  if (currentTime <= frames[0].t) return frames[0];
  if (currentTime >= frames[hi].t) return frames[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= currentTime) lo = mid; else hi = mid;
  }
  return currentTime - frames[lo].t <= frames[hi].t - currentTime ? frames[lo] : frames[hi];
}

/** Rectangle where an object-fit:contain video is actually drawn (letterbox excluded). */
export function containRect(boxW: number, boxH: number, videoW: number, videoH: number) {
  if (boxW <= 0 || boxH <= 0 || videoW <= 0 || videoH <= 0) return {x: 0, y: 0, width: 0, height: 0};
  const scale = Math.min(boxW / videoW, boxH / videoH), width = videoW * scale, height = videoH * scale;
  return {x: (boxW - width) / 2, y: (boxH - height) / 2, width, height};
}

/** mm:ss, real shop clock is never shown (API-13 5). */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds)), m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
