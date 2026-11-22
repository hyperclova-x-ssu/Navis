import type { CctvPosLink, LinkedTableView } from '../../../data/iteration7/table-links';
import type { TableSettingsPanelProps } from '../../../ui/components/table-grid-editor';
import type { ZoneEditorProps } from './ZoneEditor';

/** The session supplies the API-275 joined projection; this module owns no state. */
export type LinkedTableDisplay = LinkedTableView & { readonly tableLabel?: string };
export function linkedOccupancyText(link: LinkedTableDisplay): string {
  return link.occupancyState === 'occupied' ? '사람 있음' : link.occupancyState === 'empty' ? '빈 자리' : link.occupancyState === 'cups_left' ? '치울 컵' : '상태 확인 불가';
}

/** Derive both controlled pickers from the same canonical settings and active endpoints. */
export function createLinkPickers({ enabled, zones, tables, links, onSet }: {
  enabled: boolean;
  zones: readonly { id: string; label: string }[];
  tables: readonly { id: string; label: string }[];
  links: readonly CctvPosLink[];
  onSet: (zoneId: string, tableId: string | null) => void;
}): { zone: NonNullable<ZoneEditorProps['linkPicker']>; table: NonNullable<TableSettingsPanelProps['linkPicker']> } {
  const forZone = (id: string) => links.find(link => link.zoneId === id);
  const forTable = (id: string) => links.find(link => link.tableId === id);
  return {
    zone: {
      disabled: !enabled,
      enabledFor: id => zones.some(zone => zone.id === id),
      valueFor: id => forZone(id)?.tableId ?? null,
      optionsFor: id => tables.filter(table => forZone(id) ? forZone(id)?.tableId === table.id : !forTable(table.id)).map(table => ({ value: table.id, label: table.label })),
      onChange: (id, tableId) => { if (enabled && zones.some(zone => zone.id === id)) onSet(id, tableId); },
    },
    table: {
      disabled: !enabled,
      valueFor: id => forTable(id)?.zoneId ?? null,
      optionsFor: id => zones.filter(zone => forTable(id) ? forTable(id)?.zoneId === zone.id : !forZone(zone.id)).map(zone => ({ value: zone.id, label: zone.label })),
      onChange: (id, zoneId) => { if (!enabled || !tables.some(table => table.id === id)) return; const zone = zoneId ?? forTable(id)?.zoneId; if (zone) onSet(zone, zoneId ? id : null); },
    },
  };
}
