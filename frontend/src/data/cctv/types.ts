/**
 * DATA_MODEL 13 detections file (cnn format kept as is, so `seated`/`seatedRaw` stay here).
 * Screens never read them: `view.ts` maps them to `occupants` (D-376/D-377).
 */
export type Box = readonly [x1: number, y1: number, x2: number, y2: number];
export type PersonBox = readonly [x1: number, y1: number, x2: number, y2: number, trackId: number, seatedTableId: string | null];
export interface DetectionTable { readonly id: string; readonly name: string; readonly polygon: readonly (readonly [number, number])[] }
export interface FrameCounts { readonly inStore: number; readonly seated: number; readonly inStoreRaw?: number; readonly seatedRaw?: number; readonly occupiedTables: readonly string[]; readonly tablesToClear: readonly string[] }
export interface DetectionFrame { readonly t: number; readonly persons: readonly PersonBox[]; readonly cups: readonly Box[]; readonly counts: FrameCounts }
export interface DetectionsSummary { readonly avgInStore: number; readonly maxInStore: number; readonly tableOccupiedSeconds: Readonly<Record<string, number>>; readonly tablesToClearEvents: readonly unknown[]; readonly smoothing?: Readonly<Record<string, unknown>> }
export interface DetectionsFile {
  readonly source: string; readonly fps: number; readonly frameCount: number; readonly width: number; readonly height: number;
  readonly tables: readonly DetectionTable[]; readonly frames: readonly DetectionFrame[]; readonly summary: DetectionsSummary;
}
export type DetectionFailure = 'NETWORK' | 'FORMAT' | 'VIDEO';
export type DetectionLoad =
  | {readonly status: 'idle' | 'loading' | 'ready'; readonly file?: DetectionsFile}
  | {readonly status: 'error'; readonly reason: DetectionFailure};
export type TableState = 'occupied' | 'clear' | 'empty';
