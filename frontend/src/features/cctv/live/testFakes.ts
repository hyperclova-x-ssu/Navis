/** T-072 test fakes: a scriptable WebSocket, a routed fetch, and FrameResult/ZoneSet builders. Tests only. */
import type {FrameResult} from './frame';
import type {ZoneSet} from './api';

export function frameHeader(p: Partial<FrameResult> = {}): FrameResult {
  return {
    type: 'frame',
    frameId: 1,
    detected: true,
    w: 1280,
    h: 720,
    captureT: 100,
    recvT: 100.02,
    doneT: 100.05,
    persons: [[0.1, 0.1, 0.2, 0.5, 'za0000001'], [0.5, 0.1, 0.6, 0.5, null]],
    cups: [[0.3, 0.3, 0.32, 0.33]],
    counts: {inStore: 2, occupants: 1, inStoreRaw: 2, occupantsRaw: 1, occupiedTables: ['za0000001'], tablesToClear: ['zb0000002']},
    change5m: 1,
    tableOccupiedSeconds: {za0000001: 42.5},
    avgOccupiedSeconds: 61.2,
    zonesRevision: 1,
    stats: {fps: 15, detectFps: 5, inferMs: 30, latencyMs: 50, dropped: 0},
    ...p,
  };
}

const mask = (n: number) => ({cols: 160 as const, rows: 90 as const, runs: [n, 12, 14400 - n - 12]});

export function zoneSet(p: Partial<ZoneSet> = {}): ZoneSet {
  return {
    revision: 1,
    savedAt: '2026-11-10T10:00:00Z',
    frameAspect: 1.778,
    zones: [
      {id: 'zb0000002', number: 2, source: 'drawn', mask: mask(200)},
      {id: 'za0000001', number: 1, source: 'suggested', mask: mask(0)},
      {id: 'zc0000003', number: 3, source: 'drawn', mask: mask(400)},
    ],
    ...p,
  };
}

export class FakeSocket {
  static instances: FakeSocket[] = [];
  static reset(): void {
    FakeSocket.instances = [];
  }
  binaryType: BinaryType = 'blob';
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  // server side
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  text(m: unknown): void {
    this.onmessage?.({data: JSON.stringify(m)} as MessageEvent);
  }
  binary(b: ArrayBuffer): void {
    this.onmessage?.({data: b} as MessageEvent);
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({code} as CloseEvent);
  }
}

export type Route = (method: string, path: string, body: unknown) => {status: number; body?: unknown} | 'hang' | 'throw';

export function fakeFetch(route: Route): typeof fetch & {calls: {method: string; path: string; body: unknown}[]} {
  const calls: {method: string; path: string; body: unknown}[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({method, path, body});
    const r = route(method, path, body);
    if (r === 'throw') throw new TypeError('Failed to fetch');
    if (r === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {status: r.status, headers: {'Content-Type': 'application/json'}});
  }) as typeof fetch & {calls: typeof calls};
  f.calls = calls;
  return f;
}

export function fakeBitmap(id: number): ImageBitmap & {closed: boolean; id: number} {
  const b = {id, width: 1280, height: 720, closed: false, close() { b.closed = true; }};
  return b as unknown as ImageBitmap & {closed: boolean; id: number};
}
