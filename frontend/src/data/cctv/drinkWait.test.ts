import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {selectTableDrinkWait, type DrinkWaitFrame} from './drinkWait';
import {mockCctvView} from './view';
import type {Box, DetectionsFile} from './types';

const oldCup: Box = [0.1, 0.1, 0.14, 0.15];
const newCup: Box = [0.3, 0.1, 0.34, 0.15];
const frame = (t: number, occupancy: DrinkWaitFrame['tables'][number]['occupancy'], cups: readonly Box[] = []): DrinkWaitFrame => ({
  t, tables: [{id: 'table', occupancy, cups}],
});

function replay(...frames: DrinkWaitFrame[]) {
  let projection: ReturnType<typeof selectTableDrinkWait> | undefined;
  return frames.map(observation => {
    projection = selectTableDrinkWait(observation, projection);
    return projection.tables.get('table')?.display;
  });
}

describe('selectTableDrinkWait', () => {
  it('starts timing when a previously empty table is confirmed occupied', () => {
    expect(replay(frame(1, 'empty'), frame(2, 'occupied'), frame(3, 'occupied'))).toEqual([
      {state: 'inactive', seconds: null}, {state: 'waiting', seconds: 0}, {state: 'waiting', seconds: 1},
    ]);
  });

  it('locks the first sustained cup timestamp and ignores a passing cup', () => {
    const results = replay(frame(0, 'empty'), frame(1, 'occupied'), frame(2, 'occupied', [oldCup]), frame(3, 'occupied'),
      frame(4, 'occupied', [newCup]), frame(5, 'occupied', [newCup]), frame(6, 'occupied'), frame(7, 'occupied', [oldCup]));
    expect(results.slice(2)).toEqual([
      {state: 'waiting', seconds: 1}, {state: 'waiting', seconds: 2}, {state: 'waiting', seconds: 3},
      {state: 'received', seconds: 3}, {state: 'received', seconds: 3}, {state: 'received', seconds: 3},
    ]);
  });

  it('keeps a residual cup out of the wait even after a short loss of its box', () => {
    const results = replay(frame(0, 'empty', [oldCup]), frame(1, 'occupied'), frame(2, 'occupied', [oldCup]),
      frame(3, 'occupied', [oldCup, newCup]), frame(4, 'occupied', [newCup, oldCup]));
    expect(results.slice(2)).toEqual([
      {state: 'waiting', seconds: 1}, {state: 'waiting', seconds: 2}, {state: 'received', seconds: 2},
    ]);
  });

  it('preserves the session through occlusion and interrupts an empty streak', () => {
    const results = replay(frame(0, 'empty'), frame(1, 'occupied'), frame(2, 'empty'), frame(3, 'checking'),
      frame(4, 'empty'), frame(5, 'empty'), frame(6, 'occupied'));
    expect(results.slice(2)).toEqual([
      {state: 'checking', seconds: null}, {state: 'checking', seconds: null}, {state: 'checking', seconds: null},
      {state: 'checking', seconds: null}, {state: 'waiting', seconds: 5},
    ]);
  });

  it('ends after three seconds of clear-empty observations and starts a new clock for the next group', () => {
    const results = replay(frame(0, 'empty'), frame(1, 'occupied'), frame(2, 'empty'), frame(3, 'empty'),
      frame(4, 'empty'), frame(4.9, 'empty'), frame(5, 'empty'), frame(6, 'occupied'));
    expect(results.slice(5)).toEqual([{state: 'checking', seconds: null}, {state: 'inactive', seconds: null}, {state: 'waiting', seconds: 0}]);
  });

  it('leaves the elapsed time unmeasured when occupancy or a cup is present at first observation', () => {
    expect(replay(frame(1, 'occupied'), frame(2, 'occupied', [newCup]), frame(3, 'occupied', [newCup]))).toEqual([
      {state: 'start-unknown', seconds: null}, {state: 'start-unknown', seconds: null}, {state: 'received', seconds: null},
    ]);
    expect(replay(frame(1, 'empty'), frame(2, 'occupied', [newCup]), frame(3, 'occupied', [newCup])).at(-1)).toEqual({state: 'received', seconds: null});
  });

  it('uses fresh evidence after a stream gap and disregards duplicate frames', () => {
    const results = replay(frame(0, 'empty'), frame(1, 'occupied'), frame(2, 'occupied', [newCup]),
      frame(2, 'occupied', [newCup]), frame(1.8, 'empty'), frame(5, 'occupied'));
    expect(results.slice(2)).toEqual([
      {state: 'waiting', seconds: 1}, {state: 'waiting', seconds: 1}, {state: 'waiting', seconds: 1}, {state: 'start-unknown', seconds: null},
    ]);
  });
});

const sample = JSON.parse(readFileSync('public/cnn/store-sample-detections.json', 'utf8')) as DetectionsFile;

describe('86 second sample', () => {
  it('measures 14.4 s and 22.0 s between the CNN occupancy and cup detections', () => {
    expect(mockCctvView(sample, 85.4).tables.slice(0, 2).map(t => t.drinkWait)).toEqual([
      {state: 'received', seconds: 14.4}, {state: 'received', seconds: 22},
    ]);
  });

  it.each([
    [20, ['waiting', 'start-unknown', 'received'], [3.6, null, null]],
    [40, ['received', 'inactive', 'received'], [13.6, null, null]],
    [60, ['received', 'inactive', 'checking'], [13.6, null, null]],
    [80, ['received', 'waiting', 'inactive'], [13.6, 19.2, null]],
    [85.4, ['received', 'received', 'inactive'], [13.6, 22, null]],
  ])('replays reviewed observations by video time at %ss', (t, states, seconds) => {
    const tables = mockCctvView(sample, t, true).tables;
    expect(tables.map(table => table.drinkWait?.state)).toEqual(states);
    expect(tables.map(table => table.drinkWait?.seconds)).toEqual(seconds);
  });
});
