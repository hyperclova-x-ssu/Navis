/**
 * T-072 live `CctvView` (DATA_MODEL 12.6) from a client snapshot. Server counts are used as they are (AC-1342);
 * the app only adds the connection state, `e2eMs`, zone labels (`테이블 N`) and outline rings (T-073 `zoneOutline`).
 * live/reconnecting: numbers shown (reconnecting = stale, picture frozen). Anything else: numbers and boxes hidden.
 */
import type {CctvTableState, CctvTableView, CctvView} from '../../../data/cctv';
import type {MaskRle} from './api';
import {decodeRle, displayRings} from '../zones/mask';
import type {LiveSnapshot} from './client';

type Rings = (readonly [number, number])[][];
export type ZoneOutlineFn = (mask: MaskRle) => Rings;

/** Empty rings (tests, or a consumer that draws no outline). */
export const noOutline: ZoneOutlineFn = () => [];

/** Screen outline (T-076): RLE mask → cells → small parts dropped → marching-squares rings → simplified and smoothed (0~1). Display only. */
export const maskOutline: ZoneOutlineFn = (mask) => displayRings(decodeRle(mask));

const ringCache = new WeakMap<MaskRle, Rings>();

function ringsFor(mask: MaskRle, outline: ZoneOutlineFn): Rings {
  if (outline === noOutline) return [];
  const cached = outline === maskOutline;
  let r = cached ? ringCache.get(mask) : undefined;
  if (!r) {
    try {
      r = outline(mask);
    } catch {
      r = []; // malformed mask from the server: no outline, numbers still shown
    }
    if (cached) ringCache.set(mask, r);
  }
  return r;
}

export function liveCctvView(s: LiveSnapshot, outline: ZoneOutlineFn = maskOutline): CctvView {
  const showNumbers = s.connection === 'live' || s.connection === 'reconnecting';
  const f = showNumbers ? s.frame : null;
  const waits = f && f.zonesRevision === s.zones?.revision && !s.zonesAspectMismatch ? s.drinkWait?.tables : undefined;
  const zones = [...(s.zones?.zones ?? [])].sort((a, b) => a.number - b.number);
  const clear = new Set(f?.counts.tablesToClear ?? []);
  const occupied = new Set(f?.counts.occupiedTables ?? []);
  const tables: CctvTableView[] = zones.map((z) => {
    const state: CctvTableState = clear.has(z.id) ? 'clear' : occupied.has(z.id) ? 'occupied' : 'empty';
    return {
      id: z.id,
      label: {key: 'cctv.table.n', params: {n: z.number}},
      state,
      drinkWait: waits?.get(z.id)?.display,
      occupiedSeconds: f ? (f.tableOccupiedSeconds[z.id] ?? null) : null,
      rings: ringsFor(z.mask, outline),
    };
  });
  return {
    mode: 'live',
    connection: s.connection,
    ...(s.serverDown ? {serverDown: s.serverDown} : {}),
    frame: showNumbers && s.bitmap ? {kind: 'bitmap', bitmap: s.bitmap.bitmap, w: s.bitmap.w, h: s.bitmap.h} : null,
    persons: f ? f.persons.map((p) => [p[0], p[1], p[2], p[3]] as const) : [],
    cups: f ? f.cups : [],
    inStore: f ? f.counts.inStore : null,
    occupants: f ? f.counts.occupants : null,
    change5m: f ? f.change5m : null,
    tables,
    avgDwell: {kind: 'live-seconds', seconds: f ? f.avgOccupiedSeconds : null},
    stale: s.connection === 'reconnecting',
    ...(f ? {stats: {fps: f.stats.fps, latencyMs: f.stats.latencyMs, e2eMs: s.e2eMs}} : {}),
    zonesCount: zones.length,
  };
}
