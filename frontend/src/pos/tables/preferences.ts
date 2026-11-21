import type { PosPreferences, ShopSettings } from '../../contracts/session';
import type { PosState } from '../../contracts/pos';
import { posFailure } from '../domain/common';
import type { LinkedTableSettings } from '../../data/iteration7/table-links/types';

export const tablesEnabled = (settings: ShopSettings): boolean => settings.paymentStyle === 'postpaid'
  && ['cafe', 'restaurant', 'pub'].includes(settings.businessType ?? '') && !!settings.tableLayout;

export function selectPosPreferences(settings: ShopSettings): PosPreferences {
  const saved = settings.posPreferences;
  const showStatus = saved?.showStatus ?? true, showTables = saved?.showTables ?? true;
  const defaultTab = tablesEnabled(settings) && showTables ? 'tables' : 'order';
  const requested = saved?.userChoseStart ? saved.startTab : defaultTab;
  const startTab = requested === 'status' && !showStatus || requested === 'tables' && (!tablesEnabled(settings) || !showTables) ? 'order' : requested;
  return { startTab, userChoseStart: saved?.userChoseStart ?? false, showStatus, showTables };
}
export function normalizePosSettings<T extends ShopSettings>(settings: T): T & { readonly posPreferences: PosPreferences } {
  const links = (settings as LinkedTableSettings).cctvPosLinks;
  const tableIds = new Set(settings.tableLayout?.tables.map(t => t.tableId));
  const retained = links?.filter(link => tableIds.has(link.tableId));
  return { ...settings, posPreferences: selectPosPreferences(settings),
    ...(links ? { cctvPosLinks: retained!.length === links.length ? links : retained } : {}) };
}

/** Also called by both settings prepare paths; disabled controls are not the guard. */
export function validatePosSettingsChange(pos: PosState, before: ShopSettings, after: ShopSettings, approvalPending = false) {
  const unpaid = pos.bills.some(b => b.status === 'open' || b.status === 'partial');
  if ((unpaid || approvalPending) && (before.paymentStyle !== after.paymentStyle || before.businessType !== after.businessType
    || tablesEnabled(before) && !tablesEnabled(after) || selectPosPreferences(before).showTables && !selectPosPreferences(after).showTables)) {
    return posFailure('UNPAID_BILLS', 'CONFLICT');
  }
  const protectedIds = new Set([
    ...pos.bills.filter(b => b.status === 'open' || b.status === 'partial').flatMap(b => b.tableId ? [b.tableId] : []),
    ...pos.tableSessions.filter(s => s.cleaning).map(s => s.tableId),
  ]);
  if ([...protectedIds].some(id => !after.tableLayout?.tables.some(t => t.tableId === id))) return posFailure('TABLE_IN_USE', 'CONFLICT');
  return null;
}
