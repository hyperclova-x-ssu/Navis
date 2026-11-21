/**
 * T-072 `/ws/view` binary frame (API-17): `[u32 BE header length][header JSON = FrameResult][JPEG or 0 bytes]`.
 * Types follow DATA_MODEL 12.4 exactly; anything malformed returns null (the frame is skipped, never thrown).
 */
import type {Box} from '../../../data/cctv';

export type LivePersonBox = readonly [x1: number, y1: number, x2: number, y2: number, zoneId: string | null];

export interface FrameCountsLive {
  readonly inStore: number;
  readonly occupants: number;
  readonly inStoreRaw: number;
  readonly occupantsRaw: number;
  readonly occupiedTables: readonly string[];
  readonly tablesToClear: readonly string[];
}

export interface FrameResult {
  readonly type: 'frame';
  readonly frameId: number;
  readonly detected: boolean;
  readonly w: number;
  readonly h: number;
  readonly captureT: number;
  readonly recvT: number;
  readonly doneT: number;
  readonly persons: readonly LivePersonBox[];
  readonly cups: readonly Box[];
  readonly counts: FrameCountsLive;
  readonly change5m: number | null;
  readonly tableOccupiedSeconds: Readonly<Record<string, number>>;
  readonly avgOccupiedSeconds: number | null;
  readonly zonesRevision: number;
  readonly stats: {readonly fps: number; readonly detectFps: number; readonly inferMs: number; readonly latencyMs: number; readonly dropped: number};
}

export interface ParsedFrame {
  readonly header: FrameResult;
  /** JPEG bytes, or null when the server sent 0 bytes (`subscribe {video:false}`). */
  readonly jpeg: Uint8Array | null;
}

const MAX_HEADER = 64 * 1024; // socket text limit (공통 약속 v5)

function isFrameResult(v: unknown): v is FrameResult {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const c = o.counts as Record<string, unknown> | undefined;
  return (
    o.type === 'frame' &&
    typeof o.frameId === 'number' &&
    typeof o.captureT === 'number' &&
    Array.isArray(o.persons) &&
    Array.isArray(o.cups) &&
    !!c &&
    typeof c.inStore === 'number' &&
    typeof c.occupants === 'number' &&
    Array.isArray(c.occupiedTables) &&
    Array.isArray(c.tablesToClear) &&
    !!o.stats &&
    typeof o.stats === 'object'
  );
}

export function parseFrameMessage(buf: ArrayBuffer): ParsedFrame | null {
  if (buf.byteLength < 4) return null;
  const len = new DataView(buf).getUint32(0, false);
  if (len === 0 || len > MAX_HEADER || 4 + len > buf.byteLength) return null;
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len)));
  } catch {
    return null;
  }
  if (!isFrameResult(header)) return null;
  const rest = buf.byteLength - 4 - len;
  return {header, jpeg: rest > 0 ? new Uint8Array(buf, 4 + len, rest) : null};
}

/** Tests and dev fakes: builds a binary frame message. */
export function encodeFrameMessage(header: unknown, jpeg: Uint8Array = new Uint8Array(0)): ArrayBuffer {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + jpeg.length);
  new DataView(out.buffer).setUint32(0, h.length, false);
  out.set(h, 4);
  out.set(jpeg, 4 + h.length);
  return out.buffer;
}
