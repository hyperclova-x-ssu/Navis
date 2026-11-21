import {CCTV_SNAPSHOT, TODAY_AVG_DWELL_MIN, mockChange5m, mockCctvView, mockTableKey, tableState} from '../../../data/cctv';
import type {CctvView, DetectionsFile} from '../../../data/cctv';

/** The store sample’s starting scene as a `CctvView`, shown until the detections file is ready or when it failed (AC-1327). */
export function snapshotView(): CctvView {
  const counts = {occupiedTables: CCTV_SNAPSHOT.occupiedTables, tablesToClear: CCTV_SNAPSHOT.tablesToClear};
  return {
    mode: 'mock', connection: null, frame: {kind: 'video', el: 'mock-video'}, persons: [], cups: [],
    inStore: CCTV_SNAPSHOT.inStore, occupants: CCTV_SNAPSHOT.occupants, change5m: mockChange5m(CCTV_SNAPSHOT.inStore),
    tables: CCTV_SNAPSHOT.tables.map((t) => ({id: t.id, label: {key: mockTableKey(t.id)}, state: tableState(counts, t.id), occupiedSeconds: CCTV_SNAPSHOT.tableOccupiedSeconds[t.id] ?? null})),
    avgDwell: {kind: 'mock-minutes', minutes: TODAY_AVG_DWELL_MIN}, stale: false, zonesCount: CCTV_SNAPSHOT.tables.length,
  };
}

/** Playing view when the file is there, otherwise the fixed scene. */
export function viewFor(file: DetectionsFile | null, time: number, useReviewedSample: boolean): CctvView {
  return file ? mockCctvView(file, time, useReviewedSample) : snapshotView();
}
