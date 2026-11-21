import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {CCTV_SNAPSHOT, tableState} from './snapshot';
import {pickFrame} from './detections';
import type {DetectionsFile} from './types';

const readSample = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), `public/cnn/${name}-detections.json`), 'utf8')) as DetectionsFile;
const file = readSample('store-sample');

// The Café benchmark detections come from a third-party research dataset and are not redistributed here.
describe.skipIf(!existsSync(resolve(process.cwd(), 'public/cnn/cafe17-detections.json')))('Café experiment smoothing summary', () => {
  it('has summary.smoothing and integer counts', () => {
    const cafe = readSample('cafe17');
    expect(cafe.summary.smoothing).toBeTruthy();
    for (const f of cafe.frames) for (const k of ['inStore', 'seated', 'inStoreRaw', 'seatedRaw'] as const) expect(Number.isInteger(f.counts[k])).toBe(true);
  });
});

describe('CctvSnapshot constant matches the detections file at t=20', () => {
  const frame = pickFrame(file.frames, CCTV_SNAPSHOT.t);
  it('uses the frame closest to t=20', () => {
    expect(CCTV_SNAPSHOT.t).toBe(20);
    expect(CCTV_SNAPSHOT.asOf).toBe('15:45');
    expect(frame.t).toBe(20);
  });
  it('counts equal the frame counts', () => {
    expect(CCTV_SNAPSHOT.inStore).toBe(frame.counts.inStore);
    expect(CCTV_SNAPSHOT.occupants).toBe(frame.counts.seated); // file name for occupants
    expect([...CCTV_SNAPSHOT.occupiedTables]).toEqual(frame.counts.occupiedTables);
    expect([...CCTV_SNAPSHOT.tablesToClear]).toEqual(frame.counts.tablesToClear);
  });
  it('table names, occupied seconds and average equal the file summary', () => {
    expect(CCTV_SNAPSHOT.tables.map(t => [t.id, t.name])).toEqual(file.tables.map(t => [t.id, t.name]));
    for (const t of file.tables) expect(CCTV_SNAPSHOT.tableOccupiedSeconds[t.id]).toBe(file.summary.tableOccupiedSeconds[t.id]);
    expect(CCTV_SNAPSHOT.totalVideoSeconds).toBe(file.frameCount / file.fps);
    expect(CCTV_SNAPSHOT.avgInStore).toBe(file.summary.avgInStore);
  });
  it('derives table states from the file frame (not a table in the docs)', () => {
    const states = CCTV_SNAPSHOT.tables.map(t => tableState(CCTV_SNAPSHOT, t.id));
    expect(states).toEqual(file.tables.map(t => tableState(frame.counts, t.id)));
  });
});
