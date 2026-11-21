import {NOW_TIME} from '../db/time';
import {SAMPLE_START_TIME} from './detections';
import type {FrameCounts, TableState} from './types';

/** Store sample at the starting frame, used while footage or detections are unavailable. */
export const CCTV_SNAPSHOT = Object.freeze({
  t: SAMPLE_START_TIME,
  asOf: NOW_TIME,
  inStore: 5,
  /** People using a table area (D-376/D-377). The file calls it `seated`. */
  occupants: 3,
  occupiedTables: Object.freeze(['t1', 't3']),
  tablesToClear: Object.freeze([] as string[]),
  tables: Object.freeze([
    Object.freeze({id: 't1', name: '왼쪽 나무 테이블'}),
    Object.freeze({id: 't2', name: '가운데 흰 테이블'}),
    Object.freeze({id: 't3', name: '주문대 옆 흰 테이블'}),
  ]),
  /** "Last 5 minutes" occupied seconds per table. */
  tableOccupiedSeconds: Object.freeze({t1: 68.6, t2: 46.4, t3: 60.0} as Readonly<Record<string, number>>),
  avgInStore: 4.57,
  totalVideoSeconds: 85.6,
});
export type CctvSnapshot = typeof CCTV_SNAPSHOT;

export const TABLE_COUNT = CCTV_SNAPSHOT.tables.length;

/** occupiedTables → occupied, tablesToClear → clear, otherwise empty. Never recomputed from persons. */
export function tableState(counts: Pick<FrameCounts, 'occupiedTables' | 'tablesToClear'>, id: string): TableState {
  if (counts.tablesToClear.includes(id)) return 'clear';
  if (counts.occupiedTables.includes(id)) return 'occupied';
  return 'empty';
}
