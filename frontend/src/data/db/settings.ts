import manifest from './generated/manifest.json';
import type { SettingsCommand } from '../commands/management-types';
import type { DataTables } from './types';
import { tableLayoutEnabled, revalidateReservations } from '../derive/reservations';
import type { HandlerResult } from '../commands/handlers';
import { rejected } from '../commands/management';
import type { PosState } from '../../contracts/pos';
import type { ShopSettings } from '../../contracts/session';
import { canonical } from '../../pos/domain/common';
import { normalizePosSettings, validatePosSettingsChange } from '../../pos/tables/preferences';

export function settingsChange(t: DataTables, command: SettingsCommand): HandlerResult {
  if (command.businessType !== null && !['cafe', 'restaurant', 'pub', 'beauty', 'retail', 'academy', 'fitness', 'other'].includes(command.businessType)) return rejected('BUSINESS_INVALID', 'businessType');
  if (!['prepaid', 'postpaid'].includes(command.paymentStyle)) return rejected('PAYMENT_STYLE_INVALID', 'paymentStyle');
  const layout = command.tableLayout === undefined ? t.shopSettings.tableLayout : command.tableLayout;
  if (layout) {
    if (layout.columns !== 9 || layout.rows !== 6 || !Array.isArray(layout.tables) || layout.tables.length < 1 || layout.tables.length > 20 || !Number.isSafeInteger(layout.revision) || layout.revision < 0 || !layout.layoutId) return rejected('TABLE_LAYOUT_INVALID', 'tableLayout');
    const ids = new Set(), numbers = new Set(), cells = new Set();
    for (const table of layout.tables) {
      if (!table.tableId || !Number.isSafeInteger(table.number) || table.number < 1 || !Number.isSafeInteger(table.seats) || table.seats < 1 || table.seats > 12 || !Number.isInteger(table.column) || table.column < 0 || table.column >= 9 || !Number.isInteger(table.row) || table.row < 0 || table.row >= 6 || ids.has(table.tableId) || numbers.has(table.number) || cells.has(`${table.column}:${table.row}`)) return rejected('TABLE_LAYOUT_INVALID', 'tableLayout');
      ids.add(table.tableId); numbers.add(table.number); cells.add(`${table.column}:${table.row}`);
    }
  }
  const settings = { ...t.shopSettings, ...normalizePosSettings({ ...t.shopSettings, businessType: command.businessType, paymentStyle: command.paymentStyle, tableLayout: layout, cctvPosLinks: command.cctvPosLinks ?? t.shopSettings.cctvPosLinks }) };
  if (canonical(settings) === canonical({ ...t.shopSettings, ...normalizePosSettings(t.shopSettings) })) return { ok: true, tables: t, undoable: false, value: { shopSettingsRevision: settings.revision, tableLayoutEnabled: tableLayoutEnabled(settings), totalSeats: tableLayoutEnabled(settings) ? layout!.tables.reduce((n, t) => n + t.seats, 0) : manifest.store.seats } };
  const enabled = tableLayoutEnabled(settings), first = enabled && !t.shopSettings.layoutActivated;
  const shopSettings = { ...settings, revision: settings.revision + 1, layoutActivated: settings.layoutActivated || enabled };
  const next = { ...t, shopSettings };
  return { ok: true, tables: { ...next, reservation: revalidateReservations(next, first) }, undoable: false, value: { shopSettingsRevision: shopSettings.revision, tableLayoutEnabled: enabled, totalSeats: enabled ? layout!.tables.reduce((n, t) => n + t.seats, 0) : manifest.store.seats } };
}

/** Internal coordinator path for POS preferences/layout, preserving the one settings source. */
export function posSettingsChange(t: DataTables, settings: ShopSettings, pos: PosState, pending: boolean): HandlerResult {
  if (settings.revision !== t.shopSettings.revision + 1) return rejected('STALE_REVISION', undefined, 'CONFLICT');
  const blocked = validatePosSettingsChange(pos, t.shopSettings, settings, pending); if (blocked) return blocked;
  const validated = settingsChange(t, { type: 'shop.updateSettings', businessType: settings.businessType, paymentStyle: settings.paymentStyle!, tableLayout: settings.tableLayout, cctvPosLinks: settings.cctvPosLinks });
  if (!validated.ok) return validated;
  const shopSettings = { ...validated.tables.shopSettings, revision: settings.revision, posPreferences: settings.posPreferences };
  const next = { ...validated.tables, shopSettings: { ...shopSettings, posPreferences: normalizePosSettings(shopSettings).posPreferences } };
  return { ok: true, tables: next, undoable: false };
}
