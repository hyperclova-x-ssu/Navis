/**
 * T-073 table zones: server shape (DATA_MODEL 12.2, API-18) and editor draft shape (DATA_MODEL 12.3).
 * Coordinates are camera-frame 0..1; the mask is a 160 x 90 row-major grid.
 */
export const GRID = Object.freeze({ cols: 160, rows: 90 } as const);
export const CELLS = GRID.cols * GRID.rows; // 14,400
export const MIN_ZONE_CELLS = 12;
export const MAX_ZONES = 32;
export const ROW_BAND = 0.05;
export const UNDO_LIMIT = 50;
export const ERASER_RADIUS = 0.02; // frame-width units
export const DEFAULT_ASPECT = 16 / 9;
/** DS 13.1 zone tokens (zone.long-press, zone.draw-threshold, zone.min-size). */
export const zoneTokens = Object.freeze({ longPressMs: 500, reducedLongPressMs: 400, drawThresholdPx: 8, minSizeOfHeight: 0.04, tapMaxMs: 250 });
// tapMaxMs [추정, R5]: a release after this long (ring visibly filling) cancels instead of tapping (SCREENS 9.6 ②).

export type ZoneId = string;
export type ZoneSource = 'suggested' | 'drawn';
/** Server shapes are T-072's (live/api.ts), one definition for the app. */
export type { MaskRle, Zone, ZoneSet } from '../live/api';

export interface DraftZone { readonly id: ZoneId; readonly number: number; readonly source: ZoneSource; readonly adopted: boolean; readonly cells: Uint8Array }
export interface DraftZoneSet { readonly baseRevision: number; readonly frameAspect: number | null; readonly zones: readonly DraftZone[] }

export type Point = readonly [x: number, y: number];
export type EditOp =
  | { readonly kind: 'adopt'; readonly id: ZoneId }
  | { readonly kind: 'remove'; readonly id: ZoneId }
  | { readonly kind: 'draw'; readonly path: readonly Point[] }
  | { readonly kind: 'erase'; readonly path: readonly Point[]; readonly radius: number };
