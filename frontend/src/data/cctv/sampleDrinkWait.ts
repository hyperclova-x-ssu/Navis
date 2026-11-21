import {pickFrame} from './detections';
import {detectDrinkWaitFrame, selectTableDrinkWait, type DrinkWaitFrame, type DrinkWaitProjection} from './drinkWait';
import type {Box, DetectionTable, DetectionsFile} from './types';

function contains(polygon: DetectionTable['polygon'], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[j];
    if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside;
  }
  return inside;
}

const detected = new WeakMap<DetectionsFile, readonly DrinkWaitProjection[]>();
const reviewed = new WeakMap<DetectionsFile, readonly DrinkWaitProjection[]>();

/** Reviewed events for the bundled clip, from CCTV_ORDER_WAIT §10. CNN boxes lag physical contact and departure.
 * Keep the original boxes and counts for video rendering. These observations feed only the session projection.
 */
function reviewedObservations(frames: readonly DrinkWaitFrame[]): readonly DrinkWaitFrame[] {
  const boxAt = (id: string, t: number): readonly Box[] => pickFrame(frames, t).tables.find(table => table.id === id)?.cups ?? [];
  const leftCup = boxAt('t1', 31.4);
  const centreCup = boxAt('t2', 84);
  const rightCup = boxAt('t3', 2);
  return frames.map(frame => ({...frame, tables: frame.tables.map(table => {
    const {t} = frame;
    switch (table.id) {
      case 't1': return {...table, occupancy: t >= 16.4 ? 'occupied' : 'empty', cups: t >= 30 ? leftCup : []};
      case 't2': return {...table, occupancy: t <= 20 || (t >= 41 && t < 43) || t >= 60.8 ? 'occupied' : 'empty', cups: t >= 82.8 ? centreCup : []};
      case 't3': return {...table, occupancy: t < 59.6 ? 'occupied' : 'empty', cups: t < 73 ? rightCup : []};
      default: return table;
    }
  })}));
}

export function sampleDrinkWait(file: DetectionsFile, time: number, useReviewedSample: boolean): DrinkWaitProjection {
  const cache = useReviewedSample ? reviewed : detected;
  let timeline = cache.get(file);
  if (!timeline) {
    const zones = file.tables.map(({id, polygon}) => ({id, contains: (x: number, y: number) => contains(polygon, x, y)}));
    const detections = file.frames.map(frame => {
      const personZones = new Set(frame.persons.flatMap(person => person[5] === null ? [] : [person[5]]));
      return detectDrinkWaitFrame(frame.t, zones, frame.counts.occupiedTables, personZones, frame.cups);
    });
    const observations = useReviewedSample ? reviewedObservations(detections) : detections;
    const projections: DrinkWaitProjection[] = [];
    for (const frame of observations) projections.push(selectTableDrinkWait(frame, projections.at(-1)));
    timeline = projections;
    cache.set(file, timeline);
  }
  return pickFrame(timeline, time);
}
