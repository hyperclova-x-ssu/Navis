import { selectPosPreferences, tablesEnabled } from '../../../pos/tables/preferences';
import type { CctvPosLink, LinkedTableSettings, SetCctvPosLinkInput, TableLinkFailureReason, TableLinkResult } from './types';

const EMPTY_LINKS: readonly CctvPosLink[] = Object.freeze([]);
export const cctvPosLinks = (settings: LinkedTableSettings): readonly CctvPosLink[] => settings.cctvPosLinks ?? EMPTY_LINKS;
export const tableLinksEnabled = (settings: LinkedTableSettings): boolean => tablesEnabled(settings) && selectPosPreferences(settings).showTables;
const failure = (reason: TableLinkFailureReason, conflictingLinks?: readonly CctvPosLink[]): TableLinkResult => ({ ok: false, reason,
  code: reason === 'UNKNOWN_ZONE' || reason === 'UNKNOWN_TABLE' ? 'NOT_FOUND' : reason === 'KEY_REQUIRED' ? 'VALIDATION' : 'CONFLICT',
  messageKey: `data.tableLinks.error.${reason}`, ...(conflictingLinks ? { details: { conflictingLinks } } : {}) });

/** Pure settings planner. The existing coordinator owns keyed replay and atomic publication. */
export function setCctvPosLink(settings: LinkedTableSettings, input: SetCctvPosLinkInput, activeZoneIds: readonly string[]): TableLinkResult {
  if (!tableLinksEnabled(settings)) return failure('TABLE_LINK_DISABLED');
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) return failure('KEY_REQUIRED');
  if (input.baseRevision !== undefined && input.baseRevision !== settings.revision) return failure('STALE_REVISION');
  if (typeof input.zoneId !== 'string' || !input.zoneId.trim() || !activeZoneIds.includes(input.zoneId)) return failure('UNKNOWN_ZONE');
  if (input.tableId !== null && (typeof input.tableId !== 'string' || !settings.tableLayout?.tables.some(t => t.tableId === input.tableId))) return failure('UNKNOWN_TABLE');
  const links = cctvPosLinks(settings), existing = links.find(l => l.zoneId === input.zoneId);
  if (input.tableId !== null) {
    const collisions = links.filter(l => (l.zoneId === input.zoneId || l.tableId === input.tableId) && (l.zoneId !== input.zoneId || l.tableId !== input.tableId));
    if (collisions.length) return failure('LINK_IN_USE', collisions);
  }
  const unchanged = input.tableId === null ? !existing : existing?.tableId === input.tableId;
  if (unchanged) return { ok: true, status: 'unchanged', settings, value: { cctvPosLinks: links, revision: settings.revision } };
  const nextLinks = input.tableId === null ? links.filter(l => l.zoneId !== input.zoneId) : [...links, { zoneId: input.zoneId, tableId: input.tableId }];
  const next = { ...settings, cctvPosLinks: nextLinks, revision: settings.revision + 1 };
  return { ok: true, status: 'applied', settings: next, value: { cctvPosLinks: nextLinks, revision: next.revision } };
}

/** Call on source-zone removal; layout commands also prune via normalizePosSettings. */
export function pruneCctvPosLinks(settings: LinkedTableSettings, activeZoneIds?: readonly string[]): LinkedTableSettings {
  const links = cctvPosLinks(settings), tables = new Set(settings.tableLayout?.tables.map(t => t.tableId));
  const zones = activeZoneIds === undefined ? undefined : new Set(activeZoneIds);
  const next = links.filter(l => tables.has(l.tableId) && (!zones || zones.has(l.zoneId)));
  return next.length === links.length ? settings : { ...settings, cctvPosLinks: next, revision: settings.revision + 1 };
}
