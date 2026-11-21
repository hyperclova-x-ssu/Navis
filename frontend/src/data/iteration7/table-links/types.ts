import type { ShopSettings } from '../../../contracts/session';
import type { PosTableMap, PosTableState, PosTableView } from '../../../contracts/pos';
import type { CctvTableView } from '../../cctv/view';

export interface CctvPosLink { readonly zoneId: string; readonly tableId: string }
/** Structural extension until the shared settings owner composes API-275. */
export type LinkedTableSettings = ShopSettings & { readonly cctvPosLinks?: readonly CctvPosLink[] };
export interface SetCctvPosLinkInput {
  readonly zoneId: string; readonly tableId: string | null; readonly baseRevision?: number; readonly idempotencyKey: string;
}
export type TableLinkFailureReason = 'UNKNOWN_ZONE' | 'UNKNOWN_TABLE' | 'LINK_IN_USE' | 'TABLE_LINK_DISABLED' | 'KEY_REQUIRED' | 'STALE_REVISION';
export type TableLinkResult =
  | { readonly ok: true; readonly status: 'applied' | 'unchanged'; readonly settings: LinkedTableSettings;
      readonly value: { readonly cctvPosLinks: readonly CctvPosLink[]; readonly revision: number } }
  | { readonly ok: false; readonly code: 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT'; readonly reason: TableLinkFailureReason;
      readonly messageKey: string; readonly details?: { readonly conflictingLinks: readonly CctvPosLink[] } };

export type LinkedOccupancy = 'occupied' | 'empty' | 'cups_left';
export interface LinkedOccupancyObservation {
  readonly zoneId: string; readonly state: LinkedOccupancy | null; readonly observedAt: string | null;
}
export interface ObserveLinkedOccupancyInput extends LinkedOccupancyObservation { readonly elapsedNow: number }
export interface SeatedWithoutOrder { readonly zoneId: string; readonly tableId: string; readonly since: number }
/** Run-local presentation only; never put this object in data tables or persisted settings. */
export interface LinkedOccupancyState {
  readonly observations: readonly LinkedOccupancyObservation[];
  readonly seatedWithoutOrder: readonly SeatedWithoutOrder[];
  readonly elapsedNow: number;
}
export interface LinkedTableView extends CctvPosLink {
  readonly occupancyState: LinkedOccupancy | null; readonly occupancyObservedAt: string | null;
  readonly linkedOrderStatus: PosTableState; readonly needsClearingBadge: boolean;
}
export interface SeatedWithoutOrderTask extends SeatedWithoutOrder {
  readonly id: string; readonly group: 'tasks'; readonly elapsedMs: number; readonly messageKey: string;
  readonly params: { readonly table: string; readonly n: number };
}
export interface LinkedTableStates {
  readonly tables: readonly LinkedTableView[];
  readonly seatedWithoutOrderTasks: readonly SeatedWithoutOrderTask[];
}
export interface LinkedTableQuery { readonly occupancy: LinkedOccupancyState; readonly elapsedNow: number }
export type LinkedPosTableView = PosTableView & Partial<{
  readonly linkedZoneId: string; readonly occupancyState: LinkedOccupancy | null;
  readonly occupancyObservedAt: string | null; readonly needsClearingBadge: boolean;
}>;
export type LinkedPosTableMap = Omit<PosTableMap, 'tables'> & {
  readonly tables: readonly LinkedPosTableView[]; readonly seatedWithoutOrderTasks: readonly SeatedWithoutOrderTask[];
};
export type LinkedCctvZone = CctvTableView & Partial<{
  readonly linkedTableId: string; readonly linkedOrderStatus: PosTableState; readonly needsClearingBadge: boolean;
}>;
