import { useMemo } from 'react';
import type { FeatureId, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetDataStore } from '../../../data/react';
import { NoticeEditor, NoticePanel, type NoticeDraftInput, type NoticeDraftMemory, type NoticePort, type NoticeView } from './widget';
export { NoticeEditor, NoticePanel } from './widget';
export type { NoticeDraftInput, NoticeDraftMemory, NoticePort, NoticePreview, NoticeView } from './widget';

const keptByStore = new WeakMap<object, NoticeDraftInput>();
/** H5: what was typed in the window survives closing and reopening it. Kept per data store (as the coupon widgets do), so a new run starts clean. */
function useKeptDraft(): NoticeDraftMemory {
  const store = useWidgetDataStore();
  return useMemo(() => ({ read: () => keptByStore.get(store) ?? null, write: draft => { if (draft) keptByStore.set(store, draft); else keptByStore.delete(store); } }), [store]);
}

/** The shared composition supplies a hook backed by the current run's selectors and commands. */
export function createNoticeWidget(id: FeatureId, useNotice: () => { view: NoticeView; port: NoticePort }): WidgetModule {
  function Panel(props: WidgetPanelProps) { const { view, port } = useNotice(); return <NoticePanel view={view} width={props.width} height={props.height} onOpen={() => props.host.openDetail({ featureId: id })} onRetry={port.retry} />; }
  function Detail({ detailRef }: WidgetDetailProps) { const { view, port } = useNotice(); const memory = useKeptDraft(); return <NoticeEditor view={view} port={port} memory={memory} detailRef={detailRef} />; }
  function useSummary() { const { view } = useNotice(); return view.status === 'error' ? '공지 내역을 불러오지 못했어요' : `공지 미발송 ${view.status === 'ready' ? view.unsentCount : 0}건${view.status === 'ready' && view.nextClosure ? ` · ${view.nextClosure.title}` : ''}`; }
  return { id, Panel, Detail, useSummary };
}
