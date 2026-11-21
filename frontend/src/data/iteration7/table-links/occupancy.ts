import type { PosReadSnapshot } from '../../../contracts/pos';
import { cctvPosLinks, tableLinksEnabled } from './settings';
import type { LinkedOccupancyState, ObserveLinkedOccupancyInput, SeatedWithoutOrder } from './types';

export const createLinkedOccupancyState = (): LinkedOccupancyState => ({ observations: [], seatedWithoutOrder: [], elapsedNow: 0 });
const validElapsed = (value: number) => Number.isFinite(value) && value >= 0;

/** Run this in the same session action as order, link, preference or source changes. */
export function reconcileLinkedOccupancy(read: PosReadSnapshot, previous: LinkedOccupancyState, elapsedNow: number,
  activeZoneIds?: readonly string[]): LinkedOccupancyState {
  if (!validElapsed(elapsedNow)) return previous;
  const now = Math.max(previous.elapsedNow, elapsedNow);
  const observations = activeZoneIds === undefined ? previous.observations : previous.observations.filter(o => activeZoneIds.includes(o.zoneId));
  const occupied = new Set(observations.filter(o => o.state === 'occupied').map(o => o.zoneId));
  const openTables = new Set(read.pos.bills.filter(b => b.status === 'open' || b.status === 'partial').map(b => b.tableId));
  const tableIds = new Set(read.settings.tableLayout?.tables.map(t => t.tableId));
  const seatedWithoutOrder: SeatedWithoutOrder[] = tableLinksEnabled(read.settings) ? cctvPosLinks(read.settings)
    .filter(l => tableIds.has(l.tableId) && occupied.has(l.zoneId) && !openTables.has(l.tableId))
    .map(l => previous.seatedWithoutOrder.find(t => t.zoneId === l.zoneId && t.tableId === l.tableId) ?? { ...l, since: now }) : [];
  if (now === previous.elapsedNow && observations.length === previous.observations.length
    && seatedWithoutOrder.length === previous.seatedWithoutOrder.length && seatedWithoutOrder.every((t, i) => t === previous.seatedWithoutOrder[i])) return previous;
  return { observations, seatedWithoutOrder, elapsedNow: now };
}

/** Store only the current anonymous state; camera timestamps never drive the monotonic demo clock. */
export function observeLinkedOccupancy(read: PosReadSnapshot, previous: LinkedOccupancyState, input: ObserveLinkedOccupancyInput): LinkedOccupancyState {
  if (!validElapsed(input.elapsedNow) || typeof input.zoneId !== 'string' || !input.zoneId.trim()
    || ![null, 'occupied', 'empty', 'cups_left'].includes(input.state)
    || input.state !== null && (typeof input.observedAt !== 'string' || !Number.isFinite(Date.parse(input.observedAt)))) return previous;
  const observation = { zoneId: input.zoneId, state: input.state, observedAt: input.state === null ? null : input.observedAt };
  const observations = [...previous.observations.filter(o => o.zoneId !== input.zoneId), observation];
  return reconcileLinkedOccupancy(read, { ...previous, observations }, input.elapsedNow);
}
