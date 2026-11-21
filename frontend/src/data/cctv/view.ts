/**
 * DATA_MODEL 12.6: the one screen model of the CCTV widget. The screens draw a `CctvView` and never know the mode;
 * mock mode builds it here from the playing detections frame, live mode (T-072) from a server `FrameResult`.
 * Text is never built here: labels are message keys, numbers stay numbers.
 */
import {changeFor} from './buckets';
import {pickFrame} from './detections';
import {TODAY_AVG_DWELL_MIN} from './dwell';
import type {TableDrinkWait} from './drinkWait';
import {sampleDrinkWait} from './sampleDrinkWait';
import type {Box, DetectionsFile} from './types';
import {tableState} from './snapshot';

export type CctvMode = 'mock' | 'live';
export type LiveConnection = 'none' | 'waiting' | 'phone-opened' | 'live' | 'reconnecting' | 'lost' | 'server-down';
export type ServerDownReason = 'not-configured' | 'unreachable' | 'bad-origin';

export interface CctvLabel { readonly key: string; readonly params?: Readonly<Record<string, string | number>> }
export type CctvTableState = 'occupied' | 'clear' | 'empty';

export interface CctvTableView {
  readonly id: string;
  readonly label: CctvLabel;
  readonly state: CctvTableState;
  readonly drinkWait?: TableDrinkWait;
  /** Seconds this table was in use during the last 5 minutes; null = unknown. */
  readonly occupiedSeconds: number | null;
  /** Mock: polygon from the file (0~1). */
  readonly polygon?: readonly (readonly [number, number])[];
  /** Live: outline rings from the zone mask (0~1). */
  readonly rings?: readonly (readonly [number, number])[][];
}

export type CctvFrame =
  | {readonly kind: 'video'; readonly el: 'mock-video'}
  | {readonly kind: 'bitmap'; readonly bitmap: ImageBitmap; readonly w: number; readonly h: number}
  | null;

export interface CctvView {
  readonly mode: CctvMode;
  readonly connection: LiveConnection | null;
  readonly serverDown?: ServerDownReason;
  readonly frame: CctvFrame;
  readonly persons: readonly Box[];
  readonly cups: readonly Box[];
  /** null = hide the number (live but not connected, AC-1330). */
  readonly inStore: number | null;
  /** People using a table area (D-376/D-377). */
  readonly occupants: number | null;
  /** Signed people count versus 5 minutes ago; null = show "—" (live only; mock always has one). */
  readonly change5m: number | null;
  readonly tables: readonly CctvTableView[];
  readonly avgDwell: {readonly kind: 'mock-minutes'; readonly minutes: number} | {readonly kind: 'live-seconds'; readonly seconds: number | null};
  /** Reconnecting: keep the numbers but they are not current. */
  readonly stale: boolean;
  readonly stats?: {readonly fps: number; readonly latencyMs: number; readonly e2eMs: number | null};
  /** Live: 0 means "set your table areas". */
  readonly zonesCount: number;
}

/** Message key of a mock table name (names are file data, cnn D-59; texts live in `cctv.mockTable.*`). */
export const mockTableKey = (id: string): string => `cctv.mockTable.${id}`;

/** Signed change between the frame headcount and the camera baseline five minutes before the demo clock. */
export function mockChange5m(inStore: number): number | null {
  const c = changeFor(inStore);
  if (!c) return null;
  return c.direction === 'up' ? c.count : c.direction === 'down' ? -c.count : 0;
}

/** Mock `CctvView` for the playing time (seconds). Reduced motion passes the video’s fixed preview time. */
export function mockCctvView(file: DetectionsFile, time: number, useReviewedSample = false): CctvView {
  const frame = pickFrame(file.frames, time);
  const c = frame.counts;
  const waits = sampleDrinkWait(file, time, useReviewedSample);
  return {
    mode: 'mock',
    connection: null,
    frame: {kind: 'video', el: 'mock-video'},
    persons: frame.persons.map((p) => [p[0], p[1], p[2], p[3]] as const),
    cups: frame.cups,
    inStore: c.inStore,
    occupants: c.seated, // the file's `seated` is the occupants count (D-377)
    change5m: mockChange5m(c.inStore),
    tables: file.tables.map((t) => ({
      id: t.id,
      label: {key: mockTableKey(t.id)},
      state: tableState(c, t.id),
      drinkWait: waits.tables.get(t.id)?.display,
      occupiedSeconds: file.summary.tableOccupiedSeconds[t.id] ?? null,
      polygon: t.polygon,
    })),
    avgDwell: {kind: 'mock-minutes', minutes: TODAY_AVG_DWELL_MIN},
    stale: false,
    zonesCount: file.tables.length,
  };
}
