import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {CCTV_SNAPSHOT} from './snapshot';
import {mockChange5m, mockCctvView, mockTableKey} from './view';
import type {DetectionsFile} from './types';

const file = JSON.parse(readFileSync(resolve(process.cwd(), 'public/cnn/store-sample-detections.json'), 'utf8')) as DetectionsFile;

describe('mockCctvView (DATA_MODEL 12.6/12.7)', () => {
  const v = mockCctvView(file, CCTV_SNAPSHOT.t);
  it('is a mock view with the video element and no connection', () => {
    expect(v).toMatchObject({mode: 'mock', connection: null, frame: {kind: 'video', el: 'mock-video'}, stale: false});
    expect(v.serverDown).toBeUndefined();
    expect(v.stats).toBeUndefined();
  });
  it('numbers equal the t=20 scene; occupants come from the file\'s `seated`', () => {
    expect(v.inStore).toBe(CCTV_SNAPSHOT.inStore);
    expect(v.occupants).toBe(CCTV_SNAPSHOT.occupants);
    expect(v.avgDwell).toEqual({kind: 'mock-minutes', minutes: 39});
    expect(v.zonesCount).toBe(3);
  });
  it('5-minute change uses the café baseline at 15:40', () => {
    expect(v.change5m).toBe(-1);
    expect(mockChange5m(4)).toBe(-2);
    expect(mockChange5m(5)).toBe(-1);
    expect(mockChange5m(6)).toBe(0);
  });
  it('tables: file order, key labels, states from counts, seconds from the summary, polygons kept', () => {
    expect(v.tables.map(t => [t.id, t.state])).toEqual([['t1', 'occupied'], ['t2', 'empty'], ['t3', 'occupied']]);
    expect(v.tables[0].label).toEqual({key: mockTableKey('t1')});
    expect(v.tables[0].occupiedSeconds).toBe(file.summary.tableOccupiedSeconds.t1);
    expect(v.tables[0].polygon?.length).toBeGreaterThanOrEqual(3);
    expect(v.tables.every(t => t.rings === undefined)).toBe(true);
  });
  it('persons are plain boxes without track ids, and the view follows the playing time', () => {
    expect(v.persons.every(p => p.length === 4)).toBe(true);
    const early = mockCctvView(file, 0);
    expect(early.inStore).toBe(file.frames[0].counts.inStore);
    expect(mockCctvView(file, 9999).inStore).toBe(file.frames[file.frames.length - 1].counts.inStore);
  });
});
