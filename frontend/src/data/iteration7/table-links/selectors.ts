import type { PosReadSnapshot } from '../../../contracts/pos';
import { selectTableMap } from '../../../pos/tables/selectors';
import type { CctvView } from '../../cctv/view';
import { reconcileLinkedOccupancy } from './occupancy';
import { cctvPosLinks, tableLinksEnabled } from './settings';
import type { LinkedCctvZone, LinkedPosTableMap, LinkedTableQuery, LinkedTableStates, LinkedTableView, ObserveLinkedOccupancyInput } from './types';

export function selectLinkedTableStates(read: PosReadSnapshot, query: LinkedTableQuery): LinkedTableStates {
  if (!tableLinksEnabled(read.settings)) return { tables: [], seatedWithoutOrderTasks: [] };
  const state = reconcileLinkedOccupancy(read, query.occupancy, query.elapsedNow);
  const observations = new Map(state.observations.map(o => [o.zoneId, o]));
  const posTables = new Map(selectTableMap(read).tables.map(t => [t.tableId, t]));
  const tables: LinkedTableView[] = cctvPosLinks(read.settings).flatMap(link => {
    const pos = posTables.get(link.tableId);
    if (!pos) return [];
    const observation = observations.get(link.zoneId), occupancyState = observation?.state ?? null;
    return [{ ...link, occupancyState, occupancyObservedAt: observation?.observedAt ?? null, linkedOrderStatus: pos.state,
      needsClearingBadge: occupancyState === 'cups_left' && (pos.state === 'cleaning' || pos.state === 'empty') }];
  });
  const seatedWithoutOrderTasks = state.seatedWithoutOrder.filter(t => state.elapsedNow - t.since > 600_000)
    .map(t => ({ ...t, id: `seated-no-order:${t.tableId}`, group: 'tasks' as const, elapsedMs: state.elapsedNow - t.since,
      messageKey: 'data.tableLinks.task.seatedWithoutOrder', params: { table: t.tableId, n: 10 } }));
  return { tables, seatedWithoutOrderTasks };
}

/** Association properties are absent on unlinked or inactive POS tables. */
export function selectLinkedPosTableMap(read: PosReadSnapshot, query: LinkedTableQuery): LinkedPosTableMap {
  const map = selectTableMap(read), joined = selectLinkedTableStates(read, query), byTable = new Map(joined.tables.map(t => [t.tableId, t]));
  return { ...map, tables: map.tables.map(table => {
    const link = byTable.get(table.tableId);
    return link ? { ...table, linkedZoneId: link.zoneId, occupancyState: link.occupancyState,
      occupancyObservedAt: link.occupancyObservedAt, needsClearingBadge: link.needsClearingBadge } : table;
  }), seatedWithoutOrderTasks: joined.seatedWithoutOrderTasks };
}

/** Keep the existing CCTV drawing model; add reciprocal fields only to associated zones. */
export function selectLinkedCctvZones(view: CctvView, joined: LinkedTableStates): readonly LinkedCctvZone[] {
  const byZone = new Map(joined.tables.map(t => [t.zoneId, t]));
  return view.tables.map(zone => {
    const link = byZone.get(zone.id);
    return link ? { ...zone, linkedTableId: link.tableId, linkedOrderStatus: link.linkedOrderStatus, needsClearingBadge: link.needsClearingBadge } : zone;
  });
}

/** Consume the already filtered reader, including its stale/connection guards; never copy image/person data. */
export function cctvOccupancyObservations(view: CctvView, observedAt: string, elapsedNow: number): readonly ObserveLinkedOccupancyInput[] {
  const reliable = !view.stale && (view.mode === 'mock' || view.connection === 'live') && view.inStore !== null && view.occupants !== null;
  return view.tables.map(zone => ({ zoneId: zone.id, state: !reliable ? null : zone.state === 'clear' ? 'cups_left' : zone.state,
    observedAt: reliable ? observedAt : null, elapsedNow }));
}
