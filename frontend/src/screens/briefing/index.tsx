import { useContext, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { FeatureId, RunStore } from '../../contracts';
import { useBundle } from '../../i18n';
import { dataBundles, resolveDataText, TODAY } from '../../data/widget-data';
import { PosContext } from '../../pos/react';
import { orderStatusRuntime } from '../../pos/runtime';
import { useWidgetDataStore, useWidgetView } from '../../data/react';
import { recordBriefingAcknowledgement } from '../../data/reality/12/ack';
import { sectionWithheld } from '../../data/reality/12/overlay';
import { ActionButton, BriefingCard, ContentRecovery, Icon, InlineError, motionTokens, OverlayExitSurface, ScrollArea } from '../../ui';
import { FullscreenToggle } from '../../ui/components/overlays';
import {arrivalBundle} from './arrival-messages';
import { briefingBundle } from './messages';
import { WithheldLines, type BriefingCopy } from './real';
import './briefing.css';

export interface BriefingOverlayProps {
  readonly run: RunStore;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  /** Focus key restored when a source detail opened from an item closes. Default `panel:{featureId}`. */
  readonly detailFocusKey?: (featureId: FeatureId) => string;
  /** Development-only AC-143 injection; ignored by production builds. */
  readonly verification?: { readonly failContent: boolean; readonly onRetry: () => void };
}

const defaultFocusKey = (featureId: FeatureId) => `panel:${featureId}`;

function useBriefingT() { return useBundle(briefingBundle,arrivalBundle, ...dataBundles); }

/** The arrival items come from the briefing model (priority order, at most 3); pressing one opens its source detail. */
function BriefingContent({ run, failContent, detailFocusKey, onRetry }: { readonly run: RunStore; readonly failContent: boolean; readonly detailFocusKey: (featureId: FeatureId) => string; readonly onRetry?: () => void }) {
  const { t, format } = useBriefingT(), runtime = useContext(PosContext), pos = runtime ? orderStatusRuntime(runtime) : null;
  const view = useWidgetView('briefing');
  // K-E 9: the failure sample (and a real load error) is a state, not an exception: nothing is thrown, so the console stays clean. The title and close stay (the card is outside this body).
  if (failContent || view.status === 'error') return <InlineError onRetry={() => { onRetry?.(); if (view.status === 'error') run.actions.resetWidgetPreview('briefing'); }} />;
  const model = view.status === 'ready' ? view.model : null;
  const copy: BriefingCopy = { t: (key, params) => t(key as never, params as never), date: (iso, style) => format.date(iso, style), time: hhmm => format.time(hhmm) };
  const open = (ref: import('../../data/derive/operations').AlertItem['ref']) => {
    if ('sourceId' in ref) { pos?.openPos({ tab: 'status', orderId: ref.orderId, forceVisible: true }); return; }
    const token=run.actions.closeOverlay('button');if(token)run.actions.finishOverlayExit(token);
    run.actions.openDetailRef(ref,detailFocusKey(ref.featureId));
  };
  return <ScrollArea role="region" aria-label={t('briefing.region')} className="briefing-content"><div className="briefing-summary">
    <time className="briefing-date" dateTime={TODAY}>{format.date(TODAY,'long')}</time>
    {!model?<p className="briefing-empty">{t('data.state.briefing.none')}</p>:<>
      <section><h3>{t('arrival.schedule')}</h3>{sectionWithheld(model,'schedule') ? <WithheldLines copy={copy} model={model} sections={['schedule']} /> : <><ActionButton variant="ghost" onClick={()=>open({featureId:'calendar'})}>{t('arrival.todaySchedule',{n:model.schedules.todayCount})}<Icon name="chevron-right" aria-hidden /></ActionButton><p lang="ko">{t(model.staff.today.nextHandoffAt ? 'briefing.staffHandoff' : 'briefing.staffCount', { n: model.staff.today.workingCount, time: model.staff.today.nextHandoffAt ?? '' })}</p>{model.schedules.todayEntries.map(entry=><p key={entry.id}>{format.date(entry.date,'short')} {resolveDataText(t,entry.title)}</p>)}</>}</section>
      <section><h3>{t('arrival.reservations')}</h3>{sectionWithheld(model,'reservations') ? null : <><ActionButton variant="ghost" onClick={()=>open({featureId:'voice-booking'})}>{t('arrival.todayReservations',{count:model.reservations.count,people:model.reservations.partyTotal})}<Icon name="chevron-right" aria-hidden /></ActionButton>{model.reservations.completedCount > 0 ? <p lang="ko">{t('data.pos.completedVisits',{n:model.reservations.completedCount})}</p> : null}<p>{t('arrival.changes',{n:model.reservations.changes})}</p></>}{sectionWithheld(model,'pickups') ? null : <><ActionButton variant="ghost" lang="ko" onClick={()=>open({featureId:'voice-booking'})}>{t('briefing.pickupToday',{n:model.custom.summary.todayPickup})}<Icon name="chevron-right" aria-hidden /></ActionButton><p lang="ko">{t('briefing.customPending',{n:model.custom.summary.approvalPending,m:model.custom.summary.todayNotComplete})}</p></>}<WithheldLines copy={copy} model={model} sections={['reservations','pickups']} /></section>
      <section><h3>{t('arrival.alerts',{n:model.importantAlerts.count})}</h3><ul className="briefing-list" aria-label={t('arrival.alerts',{n:model.importantAlerts.count})}>{model.importantAlerts.groups.map(group=><li key={group.id}><h4>{t(`arrival.${group.id}`)}</h4>{group.items.map(item=><ActionButton key={item.id} variant="ghost" className="briefing-item" data-feature-id={'sourceId' in item.ref ? undefined : item.ref.featureId} onClick={()=>open(item.ref)}><span className="briefing-item__text">{t(item.messageKey,item.params)}</span><Icon name="chevron-right"/></ActionButton>)}</li>)}</ul><WithheldLines copy={copy} model={model} sections={['purchasing','stock','tax','tasks']} /></section>
    </>}
  </div></ScrollArea>;
}

/**
 * REAL-PLAN F12: the explicit acknowledgement made outside the detail (the Navis card `ui.acknowledgeBriefing`, which only sets the run flag) also
 * reaches the service. Only the run's own `pending → dismissed` step counts; closing the arrival card (`visible → dismissed`) is not a confirmation,
 * and a day the service already holds sends nothing. Over fixture the helper does nothing.
 */
function useAcknowledgementSync(run: RunStore) {
  const store = useWidgetDataStore();
  useEffect(() => run.subscribe((state, previous) => {
    if (previous.briefing !== 'pending' || state.briefing !== 'dismissed' || previous.overlay.type === 'briefing') return;
    void recordBriefingAcknowledgement(store).then(result => {
      if (result && !result.ok) run.actions.showNotice({ kind: 'error', messageKey: result.messageKey, featureId: 'briefing' });
    });
  }), [run, store]);
}

/** One presentation per run; the shared store owns coaching, safe time and idle. */
export function BriefingOverlay({ run, returnFocusRef, detailFocusKey = defaultFocusKey, verification }: BriefingOverlayProps) {
  const state = useSyncExternalStore(run.subscribe, run.getState);
  useAcknowledgementSync(run);
  const { t } = useBriefingT();
  const [announcement, setAnnouncement] = useState('');
  const announcementTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(announcementTimer.current), []);
  const failContent = import.meta.env.DEV && verification?.failContent === true;
  const body = <ContentRecovery resetKey={state.runId} onRetry={import.meta.env.DEV ? verification?.onRetry : undefined}><BriefingContent run={run} failContent={failContent} detailFocusKey={detailFocusKey} onRetry={import.meta.env.DEV ? verification?.onRetry : undefined} /></ContentRecovery>;
  const title = t('briefing.title'), description = t('briefing.description');
  if (state.overlay.type === 'briefing') {
    return <BriefingCard open title={title} description={description} returnFocusRef={returnFocusRef} fullscreen={state.detailDialogFullscreen}
      headerAction={<><FullscreenToggle fullscreen={state.detailDialogFullscreen} onChange={value => { run.actions.setDetailDialogFullscreen(value); clearTimeout(announcementTimer.current); setAnnouncement(''); const message = t(value ? 'briefing.fullscreenDone' : 'briefing.restoreDone'); announcementTimer.current = setTimeout(() => setAnnouncement(message), state.reducedMotion ? 0 : motionTokens.duration.fly); }} accessibleLabel={t(state.detailDialogFullscreen ? 'briefing.restoreLabel' : 'briefing.fullscreenLabel')} /><span className="ui-sr-only" aria-live="polite">{announcement}</span></>}
      closeLabel={t('common.close')} onClose={reason => run.actions.closeOverlay(reason)} popupClassName="briefing-dialog">
      {body}
    </BriefingCard>;
  }
  if (state.overlay.type === 'none' && state.exitingOverlay?.type === 'briefing' && state.exitPendingToken) {
    return <OverlayExitSurface token={state.exitPendingToken} kind={state.detailDialogFullscreen ? 'fullscreen' : 'briefing'} style={{ transform: 'none' }} onComplete={run.actions.finishOverlayExit}>
      <header className="ui-overlay-header">
        <div className="ui-overlay-heading"><h2 className="ui-dialog-title">{title}</h2><p className="ui-dialog-description">{description}</p></div>
        <span className="briefing-exit-close"><Icon name="close" /></span>
      </header>
      <div className="ui-overlay-body">{body}</div>
    </OverlayExitSurface>;
  }
  return null;
}
