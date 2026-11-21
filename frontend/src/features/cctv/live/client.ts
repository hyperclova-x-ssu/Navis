/**
 * T-072 live client (API-14·17, DATA_MODEL 12.6 연결 상태 판정). One per page: consumers `acquire({video})` and
 * the `/ws/view` socket opens on the first and closes on the last (reference count). `subscribe {video}` follows
 * whether any consumer wants video.
 *
 * Connection rules:
 * - no `VITE_CNN_SERVER_URL` → `server-down/not-configured`, nothing is called.
 * - health fails or the socket can't open / drops → `server-down/unreachable` (403 or close 4403 → `bad-origin`),
 *   retried every 3 s; when it comes back the state follows the server status again.
 * - status.camera none/waiting/connected/live → `none`/`waiting`/`phone-opened`/`live`.
 * - after a frame: 2 s without a frame → `reconnecting` (numbers kept, stale), 5 s → `lost` (hidden) — even if the
 *   server already says the camera closed. `lost` stays until a new frame or `retry()`.
 *
 * Frames: header parsed, JPEG decoded with `createImageBitmap`, only the newest frame is decoded and shown;
 * the previous bitmap is `close()`d when replaced. ping every 2 s, pong → clock offset → `e2eMs`.
 */
import type {LiveConnection, ServerDownReason} from '../../../data/cctv';
import {fetchHealth, getZones, type CameraState, type HttpDeps, type ZoneSet} from './api';
import {ClockSync} from './clock';
import {socketUrl} from './config';
import {parseFrameMessage, type FrameResult} from './frame';
import type {DrinkWaitProjection} from '../../../data/cctv/drinkWait';
import {projectLiveDrinkWait} from './liveDrinkWait';

export const RECONNECTING_MS = 2000;
export const LOST_MS = 5000;
export const SERVER_RETRY_MS = 3000;
export const PING_MS = 2000;
const TICK_MS = 250;

export interface LiveBitmap { readonly bitmap: ImageBitmap; readonly w: number; readonly h: number }

export interface LiveSnapshot {
  readonly connection: LiveConnection;
  readonly serverDown?: ServerDownReason;
  readonly camera: CameraState | null;
  readonly frame: FrameResult | null;
  readonly drinkWait?: DrinkWaitProjection;
  readonly bitmap: LiveBitmap | null;
  readonly zones: ZoneSet | null;
  readonly zonesAspectMismatch: boolean;
  readonly e2eMs: number | null;
}

type WsLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  binaryType: BinaryType;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
};

export interface LiveClientDeps {
  readonly base: string | null;
  readonly fetch?: typeof fetch;
  readonly WebSocket?: new (url: string) => WsLike;
  readonly createImageBitmap?: (blob: Blob) => Promise<ImageBitmap>;
  /** ms clock for staleness (default performance.now). */
  readonly now?: () => number;
}

const EMPTY: LiveSnapshot = {connection: 'none', camera: null, frame: null, bitmap: null, zones: null, zonesAspectMismatch: false, e2eMs: null};

export class LiveClient {
  private snap: LiveSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private refs = 0;
  private videoRefs = 0;
  private ws: WsLike | null = null;
  private wsOpen = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt: number | null = null;
  private decoding = false;
  private pending: {header: FrameResult; jpeg: Uint8Array; drinkWait?: DrinkWaitProjection} | null = null;
  private drinkWait: DrinkWaitProjection | undefined;
  private drinkWaitRevision: number | undefined;
  private generation = 0;
  private zonesLoading = false;
  private readonly clock = new ClockSync();
  private readonly http: HttpDeps;
  private readonly now: () => number;

  constructor(private readonly deps: LiveClientDeps) {
    this.http = {base: deps.base, fetch: deps.fetch};
    this.now = deps.now ?? (() => performance.now());
  }

  getSnapshot = (): LiveSnapshot => this.snap;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  get refCount(): number {
    return this.refs;
  }

  /** Starts (first consumer) and returns the release function. */
  acquire(opts: {video: boolean}): () => void {
    this.refs += 1;
    if (opts.video) this.videoRefs += 1;
    if (this.refs === 1) this.start();
    else if (opts.video && this.videoRefs === 1) this.sendSubscribe();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs -= 1;
      if (opts.video) {
        this.videoRefs -= 1;
        if (this.videoRefs === 0 && this.refs > 0) {
          this.sendSubscribe();
          this.dropBitmap();
        }
      }
      if (this.refs === 0) this.stop();
    };
  }

  /** "다시 시도"/"다시 연결하기": server-down → try now; lost → forget the old frames (back to the QR flow). */
  retry(): void {
    if (this.refs === 0) return;
    if (this.snap.connection === 'server-down') {
      this.clearRetry();
      this.connect();
      return;
    }
    this.lastFrameAt = null;
    this.drinkWait = undefined;
    this.dropBitmap();
    this.set({frame: null, drinkWait: undefined, e2eMs: null});
    this.evaluate();
  }

  /** A new pairing was made (QR shown): forget the lost session like `retry()`. */
  notePaired(): void {
    if (this.snap.connection === 'lost' || this.snap.connection === 'reconnecting') this.retry();
  }

  /** Re-reads the saved zones (after a PUT, or on a `zones` message). */
  refreshZones(): void {
    if (this.zonesLoading || !this.http.base) return;
    this.zonesLoading = true;
    const gen = this.generation;
    void getZones(this.http).then((r) => {
      this.zonesLoading = false;
      if (gen !== this.generation) return;
      if (r.ok) this.set({zones: r.value});
    });
  }

  /** Puts a saved set in directly (PUT success) without waiting for the socket notice. */
  setZones(z: ZoneSet): void {
    this.set({zones: z});
  }

  // ---- lifecycle ----

  private start(): void {
    this.generation += 1;
    if (!this.deps.base) {
      this.set({...EMPTY, connection: 'server-down', serverDown: 'not-configured'});
      return;
    }
    this.connect();
  }

  private stop(): void {
    this.generation += 1;
    this.clearRetry();
    this.stopTimers();
    this.closeSocket();
    this.dropBitmap();
    this.pending = null;
    this.lastFrameAt = null;
    this.drinkWait = undefined;
    this.clock.reset();
    this.snap = EMPTY;
    this.emit();
  }

  private connect(): void {
    const gen = this.generation;
    void fetchHealth(this.http).then((r) => {
      if (gen !== this.generation || this.refs === 0) return;
      if (!r.ok) {
        this.serverDown(r.code === 'BAD_ORIGIN' ? 'bad-origin' : 'unreachable');
        return;
      }
      this.set({camera: r.value.camera ?? null});
      this.openSocket();
    });
  }

  private openSocket(): void {
    const Ctor = this.deps.WebSocket ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike);
    let ws: WsLike;
    try {
      ws = new Ctor(socketUrl(this.deps.base!, '/ws/view'));
    } catch {
      this.serverDown('unreachable');
      return;
    }
    this.ws = ws;
    this.drinkWait = undefined;
    this.wsOpen = false;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.wsOpen = true;
      this.sendSubscribe();
      this.sendPing();
      this.startTimers();
      this.refreshZones();
      if (this.snap.connection === 'server-down') this.set({serverDown: undefined});
      this.evaluate();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') this.onText(ev.data);
      else if (ev.data instanceof ArrayBuffer) this.onBinary(ev.data);
    };
    ws.onerror = () => {};
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsOpen = false;
      this.stopTimers();
      if (this.refs === 0) return;
      this.serverDown(ev.code === 4403 ? 'bad-origin' : 'unreachable');
    };
  }

  private serverDown(reason: ServerDownReason): void {
    this.closeSocket();
    this.stopTimers();
    this.set({connection: 'server-down', serverDown: reason});
    this.clearRetry();
    const gen = this.generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (gen === this.generation && this.refs > 0) this.connect();
    }, SERVER_RETRY_MS);
  }

  // ---- messages ----

  private onText(raw: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.type === 'status') {
      const camera = m.camera as CameraState;
      this.set({camera, zonesAspectMismatch: m.zonesAspectMismatch === true});
      const rev = typeof m.zonesRevision === 'number' ? m.zonesRevision : null;
      if (rev !== null && this.snap.zones && this.snap.zones.revision !== rev) this.refreshZones();
      this.evaluate();
    } else if (m.type === 'zones') {
      if (!this.snap.zones || this.snap.zones.revision !== m.revision) this.refreshZones();
    } else if (m.type === 'pong') {
      this.clock.addPong(Number(m.t), Number(m.serverT), this.now() / 1000);
    }
  }

  private onBinary(buf: ArrayBuffer): void {
    const p = parseFrameMessage(buf);
    if (!p) return;
    const now = this.now();
    const zones = this.snap.zones;
    const revision = p.header.zonesRevision;
    if (revision !== this.drinkWaitRevision || (this.lastFrameAt !== null && now - this.lastFrameAt >= RECONNECTING_MS)) this.drinkWait = undefined;
    this.lastFrameAt = now;
    this.drinkWaitRevision = revision;
    if (zones && zones.revision !== revision) this.refreshZones();
    this.drinkWait = zones?.revision === revision && zones && !this.snap.zonesAspectMismatch
      ? projectLiveDrinkWait(p.header, zones, this.drinkWait)
      : undefined;
    if (!p.jpeg || this.videoRefs === 0) {
      this.set({frame: p.header, drinkWait: this.drinkWait, e2eMs: this.clock.e2eMs(now / 1000, p.header.captureT)});
      this.evaluate();
      return;
    }
    // newest only: while one decode runs, keep just the latest waiting frame
    this.pending = {header: p.header, jpeg: p.jpeg, drinkWait: this.drinkWait};
    this.evaluate();
    if (!this.decoding) void this.decodeNext();
  }

  private async decodeNext(): Promise<void> {
    const next = this.pending;
    if (!next) return;
    this.pending = null;
    this.decoding = true;
    const gen = this.generation;
    const decode = this.deps.createImageBitmap ?? ((b: Blob) => globalThis.createImageBitmap(b));
    const bmp: ImageBitmap | null = await decode(new Blob([next.jpeg as BlobPart], {type: 'image/jpeg'})).catch(() => null);
    this.decoding = false;
    if (gen !== this.generation || this.videoRefs === 0) {
      bmp?.close();
    } else if (bmp) {
      const old = this.snap.bitmap;
      const waiting = this.pending as {header: FrameResult} | null; // set by onBinary during the await
      if (waiting && waiting.header.frameId > next.header.frameId) {
        // a newer frame is already waiting: skip drawing this one
        bmp.close();
      } else {
        this.set({
          frame: next.header,
          drinkWait: next.drinkWait,
          bitmap: {bitmap: bmp, w: next.header.w || bmp.width, h: next.header.h || bmp.height},
          e2eMs: this.clock.e2eMs(this.now() / 1000, next.header.captureT),
        });
        old?.bitmap.close();
      }
    }
    if (this.pending) void this.decodeNext();
  }

  // ---- state ----

  /** Connection from server status + frame age. */
  private evaluate(): void {
    if (this.snap.connection === 'server-down' && !this.wsOpen) return;
    let c: LiveConnection;
    if (this.lastFrameAt !== null) {
      const age = this.now() - this.lastFrameAt;
      c = age < RECONNECTING_MS ? 'live' : age < LOST_MS ? 'reconnecting' : 'lost';
      if (c === 'lost' && this.snap.connection !== 'lost') this.dropBitmap();
    } else {
      const cam = this.snap.camera;
      c = cam === 'live' || cam === 'connected' ? 'phone-opened' : cam === 'waiting' ? 'waiting' : 'none';
    }
    if (c !== this.snap.connection || this.snap.serverDown) this.set({connection: c, serverDown: undefined});
  }

  private set(patch: Partial<LiveSnapshot>): void {
    this.snap = {...this.snap, ...patch};
    this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  private dropBitmap(): void {
    const b = this.snap.bitmap;
    if (!b) return;
    this.snap = {...this.snap, bitmap: null};
    b.bitmap.close();
    this.emit();
  }

  // ---- socket helpers ----

  private sendSubscribe(): void {
    if (this.ws && this.wsOpen) this.ws.send(JSON.stringify({type: 'subscribe', video: this.videoRefs > 0}));
  }

  private sendPing(): void {
    if (this.ws && this.wsOpen) this.ws.send(JSON.stringify({type: 'ping', t: Math.round(this.now()) / 1000}));
  }

  private startTimers(): void {
    this.stopTimers();
    this.pingTimer = setInterval(() => this.sendPing(), PING_MS);
    this.tickTimer = setInterval(() => this.evaluate(), TICK_MS);
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.pingTimer = this.tickTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.wsOpen = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }
}
