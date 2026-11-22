import { useRef, useState, useSyncExternalStore } from 'react';
import type { ShopSettings } from '../../../contracts';
import { tableLinksEnabled } from '../../../data/iteration7/table-links';
import { useDataExecute, useDomainState, useWidgetDataStore } from '../../../data/react';
import { dataBundles } from '../../../data/widget-data';
import { useBundle } from '../../../i18n';
import { createLinkPickers, type LinkedTableDisplay } from './linked-ui';

export function useRealCctvLinks(settings: ShopSettings, overlay: object) {
  const store = useWidgetDataStore();
  const scope = useDomainState('cctv');
  const { tables } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { t } = useBundle(...dataBundles);
  const execute = useDataExecute();
  const busy = useRef(false);
  const [problem, setProblem] = useState<{ insight: typeof tables.realInsight; text: string }>();
  const [staged, setStaged] = useState<{ insight: typeof tables.realInsight; overlay: object; zoneId: string; tableId: string | null }>();
  const insight = tables.realInsight;
  const enabled = tableLinksEnabled(settings);
  const posTables = enabled ? insight?.tables ?? [] : [];
  const zones = (insight?.zones ?? []).map((zone, index) => ({ id: zone.zoneId, label: zone.label ?? `구역 ${index + 1}` }));
  const links = insight?.links ?? [];
  const tableBySettingsId = new Map(posTables.map(row => [row.layoutTableId ?? row.tableId, row.tableId]));
  const ready = scope.status === 'ready' && scope.complete && enabled && !!insight?.tables && !scope.pending;
  const proposed = staged?.overlay === overlay && staged.insight === insight ? staged : undefined;
  const save = async (zoneId: string, tableId: string | null) => {
    const zone = insight?.zones.find(row => row.zoneId === zoneId);
    const previous = links.find(link => link.zoneId === zoneId)?.tableId ?? null;
    if (!ready || !zone || busy.current || previous === tableId) return;
    busy.current = true;
    setProblem(undefined);
    try {
      const result = await execute({ type: 'cctv.setTableLink', zoneId, tableId, expectedRevision: zone.linkRevision,
        ...(tableId === null ? { confirmed: true } : {}) });
      if (!result.ok) setProblem({ insight: store.getSnapshot().tables.realInsight, text: t(result.messageKey) });
    } finally {
      busy.current = false;
    }
  };
  const options = { enabled, zones, links, tables: posTables.map(row => ({ id: row.tableId, label: row.label })) };
  const { zone } = createLinkPickers({ ...options, onSet: (zoneId, tableId) => {
    if (!ready || (links.find(link => link.zoneId === zoneId)?.tableId ?? null) === tableId) return;
    setStaged({ insight, overlay, zoneId, tableId });
  } });
  const { table } = createLinkPickers({ ...options, onSet: (zoneId, tableId) => {
    const label = tableId === null ? 'CCTV 구역과 POS 테이블의 연결을 해제할까요?' : 'CCTV 구역을 이 POS 테이블에 연결할까요?';
    if (ready && window.confirm(label)) void save(zoneId, tableId);
  } });
  const error = problem && problem.insight === insight ? problem.text : undefined;
  const linkedTables = links.flatMap((link): LinkedTableDisplay[] => {
    const table = posTables.find(row => row.tableId === link.tableId);
    if (!table || table.state === 'archived') return [];
    return [{ zoneId: link.zoneId, tableId: table.layoutTableId ?? table.tableId, tableLabel: table.label, linkedOrderStatus: table.state,
      occupancyState: null, occupancyObservedAt: null, needsClearingBadge: false }];
  });
  return {
    real: scope.mode === 'http',
    tablePicker: {
      disabled: table.disabled,
      valueFor: (id: string) => table.valueFor(tableBySettingsId.get(id) ?? id),
      optionsFor: (id: string) => tableBySettingsId.has(id) ? table.optionsFor(tableBySettingsId.get(id)!) : [],
      onChange: (id: string, value: string | null) => { if (ready) table.onChange(tableBySettingsId.get(id) ?? id, value); },
    },
    cctv: {
      linkPicker: zone,
      linkBusy: !ready,
      linkZones: zones, linkedTables, linkError: error ?? (enabled && insight?.tables === null ? 'POS 테이블을 불러오지 못했어요' : undefined),
      linkConfirm: proposed && {
        label: proposed.tableId === null ? '연결 해제하기' : '테이블 연결하기',
        text: `${zones.find(row => row.id === proposed.zoneId)?.label} · ${posTables.find(row => row.tableId === (proposed.tableId ?? links.find(link => link.zoneId === proposed.zoneId)?.tableId))?.label}`,
        onPress: () => { setStaged(undefined); void save(proposed.zoneId, proposed.tableId); },
        onCancel: () => setStaged(undefined),
      },
    },
  };
}
