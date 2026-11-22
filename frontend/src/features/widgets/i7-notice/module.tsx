import { useMemo } from 'react';
import type { FeatureId, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetDataStore, useRealRetry } from '../../../data/react';
import { useInboxHttp } from '../../../data/reality/15/hooks';
import { smsSchedules, useHttpNotice, useHttpNoticeView } from './real';
import { dataBundle } from '../../../data/messages';
import { useBundle } from '../../../i18n';
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
  function useView() {
    const fixture = useNotice();
    const http = useInboxHttp();
    const realView = useHttpNoticeView();
    return { fixture, http, view: http ? realView : fixture.view };
  }
  function Panel(props: WidgetPanelProps) { const { view, fixture, http } = useView(); const retryInbox = useRealRetry('inbox'); return <NoticePanel view={view} width={props.width} height={props.height} onOpen={() => props.host.openDetail({ featureId: id })} onRetry={http ? retryInbox : fixture.port.retry} onScheduled={() => props.host.openDetail({ featureId: id, view: 'scheduled' })} />; }
  function Detail({ detailRef, host }: WidgetDetailProps) {
    const { view, fixture, http } = useView();
    const { port, inbox, command } = useHttpNotice(host);
    const { t } = useBundle(dataBundle);
    const memory = useKeptDraft();
    if (view.status === 'loading') return <p role="status">{t('data.real.loading')}</p>;
    return <NoticeEditor view={view} port={http ? port : fixture.port} memory={memory} detailRef={detailRef} deliveryChannels={http}
      schedules={http ? smsSchedules(inbox, command, t) : undefined}
      deleteNews={http ? async noticeId => !!(await command.send({ type: 'notice.deleteNews', noticeId, idempotencyKey: `notice:${crypto.randomUUID()}` }))?.ok : undefined} />;
  }
  function useSummary() { const { view } = useView(); return view.status === 'loading' ? '공지 내역을 불러오고 있어요' : view.status === 'error' ? '공지 내역을 불러오지 못했어요' : `공지 미발송 ${view.status === 'ready' ? view.unsentCount : 0}건${view.status === 'ready' && view.nextClosure ? ` · ${view.nextClosure.title}` : ''}`; }
  return { id, Panel, Detail, useSummary };
}
