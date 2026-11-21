import {detectDrinkWaitFrame, selectTableDrinkWait, type DrinkWaitProjection} from '../../../data/cctv/drinkWait';
import {decodeRle} from '../zones/mask';
import type {ZoneSet} from './api';
import type {FrameResult} from './frame';

const zoneMasks = new WeakMap<ZoneSet, readonly {id: string; contains: (x: number, y: number) => boolean}[]>();

function areas(zones: ZoneSet) {
  const cached = zoneMasks.get(zones);
  if (cached) return cached;
  const decoded = zones.zones.flatMap(({id, mask}) => {
    try {
      const cells = decodeRle(mask);
      const contains = (x: number, y: number) => {
        const col = Math.min(mask.cols - 1, Math.floor(x * mask.cols));
        const row = Math.min(mask.rows - 1, Math.floor(y * mask.rows));
        return cells[row * mask.cols + col] === 1;
      };
      return [{id, contains}];
    } catch {
      return [];
    }
  });
  zoneMasks.set(zones, decoded);
  return decoded;
}

export function projectLiveDrinkWait(frame: FrameResult, zones: ZoneSet, previous?: DrinkWaitProjection): DrinkWaitProjection | undefined {
  if (!frame.detected || !Number.isFinite(frame.captureT)) return previous;
  const personZones = new Set<string>();
  for (const person of frame.persons) {
    if (typeof person?.[4] === 'string') personZones.add(person[4]);
  }
  const observation = detectDrinkWaitFrame(frame.captureT, areas(zones), frame.counts.occupiedTables, personZones, frame.cups);
  return selectTableDrinkWait(observation, previous);
}
