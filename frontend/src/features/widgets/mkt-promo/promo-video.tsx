/**
 * AI 홍보 영상 (promo-video, T-083, D-80·D-81·D-82): the panel's five states (SCR-50: 만들기 전 · 만드는 중 · 완성 · 올린 뒤 ·
 * 만들지 못함, plus the few-photos empty state) and the detail = the create window (promo-window.tsx). Every state reads the
 * one `promo_video` source (DATA_MODEL 10.16.8); the job watcher (promo-session.ts) keeps it moving with or without this panel.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { FitProbe, PROMO_FIT } from './fit';
import type { FeatureId, QueryCondition, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import type { PromoStage, PromoVideoModel } from '../../../data/widget-data';
import { useWidgetView } from '../../../data/react';
import { validateAgentPrefill } from '../../../../shared/navis-agent-schema.mjs';
import { ActionButton, Icon, MetricFit, PanelAction, PanelState } from '../../../ui';
import { usePromoSession } from './promo-hooks';
import { STAGES } from './promo-session';
import { PromoWindow } from './promo-window';
import { text, useFit, useT } from './shared';
import './widget.css';
import './promo.css';

const FEATURE_ID = 'promo-video' as const;
export const CREATE_REF = { featureId: FEATURE_ID, view: 'create', focus: 'action' } as const;
/** Rows the roomy panel lists before `외 n개`. */
const CATALOG_ROWS = 4;

/** SCR-50 B 4-cell bar: done cells, the current cell, the rest (no percent, no motion beyond M-45's 120 ms fill). */
export function StageBar({ stage, label }: { readonly stage: PromoStage | null; readonly label: string }) {
  const current = stage ? STAGES.indexOf(stage) : 0;
  return (
    <span className="pv-bar" role="img" aria-label={label}>
      {STAGES.map((s, i) => <span key={s} className="pv-bar__cell" data-state={i < current ? 'done' : i === current ? 'current' : 'left'} />)}
    </span>
  );
}

function placeName(t: ReturnType<typeof useT>, route: string | null): string {
  return t.t(`promo.place.${route ?? 'clip'}`);
}

export function PromoVideoPanel({ featureId, condition, shape, width, height, host }: WidgetPanelProps) {
  const t = useT();
  usePromoSession();
  const view = useWidgetView(FEATURE_ID, condition);
  const fit = useFit();
  const reasonId = useId();
  const name = t.t('widget.promo-video.title');
  const open = () => host.openDetail(CREATE_REF);
  if (view.status === 'error') {
    return <div className="mp-root" data-widget={featureId} data-shape={shape} data-state="error"><PanelState tone="error" shape={shape} message={t.locale === 'ko' && (shape === 'Q' || (shape === 'W' && width <= 2)) ? t.t('widget.promo-video.state.error.short') : t.t(view.messageKey)} shortMessage={t.t('widget.promo-video.state.error.short')} action={{ label: t.t('common.retry'), widgetName: name, onPress: () => host.resetPreview() }} /></div>;
  }
  if (view.status === 'empty') {
    // F: fewer than 5 photos — the sentence is the reason; the button stays visible but disabled (AC-344).
    return (
      <div className="mp-root pv-panel" data-widget={featureId} data-shape={shape} data-state="empty" data-promo-state="few-photos" data-slot="promo-video.empty">
        <PanelState shape={shape} message={t.t(view.messageKey)} shortMessage={view.messageKey === 'data.state.promo-video.few-photos' ? t.t('widget.promo-video.state.few-photos.short') : undefined}>
          <span className="ui-sr-only" lang={t.locale} id={reasonId}>{t.t(view.messageKey)}</span>
          <div className="ui-panel-action-slot"><ActionButton variant="secondary" className="ui-panel-action" disabled aria-disabled="true" aria-describedby={reasonId}>{t.t('marketing.makeVideo')}</ActionButton></div>
        </PanelState>
      </div>
    );
  }
  const model = view.model;
  /** A cafe has dozens of menus: the roomy panel lists the ones with photos first, a few rows, then `외 n개` (SCREENS 3.1 row limit). */
  const catalogMenus = [...model.menus].sort((a, b) => Number(b.hasPhotos) - Number(a.hasPhotos));
  const wide = shape !== 'Q';
  const roomy = width >= 3 && height >= 2 && t.locale === 'ko';
  const minStage = fit.large && shape === 'Q' ? 1 : 0;
  const root = (state: string, body: ReactNode, action: ReactNode, extra?: Record<string, string>) => (
    <div className={`mp-root pv-panel ${wide ? 'pv-panel--wide' : ''}`} data-widget={featureId} data-shape={shape} data-state="ready" data-promo-state={state} data-roomy={roomy ? 'true' : undefined} {...extra}>
      <FitProbe order={PROMO_FIT} />
      <div className="pv-panel__body" lang="ko">{body}</div>
      {roomy ? <section className="pv-panel__catalog" data-slot="promo-video.catalog" aria-label={t.t('promo.sum.menu')}>
        {state !== 'before' ? <p className="pv-panel__catalog-count">{t.t('widget.promo-video.materials.sr', { n: model.photoCount })}</p> : null}
        <p className="pv-panel__label">{t.t('promo.sum.menu')}</p>
        <ul>
          {catalogMenus.slice(0, CATALOG_ROWS).map((menu) => <li key={menu.menuId}>{menu.hasPhotos ? t.t('widget.promo-video.ready', { menu: text(t, menu.name) }) : <>{text(t, menu.name)}{'\u00a0·\u00a0'}{t.t('promo.menu.noPhotos')}</>}</li>)}
          {catalogMenus.length > CATALOG_ROWS ? <li key="more" className="pv-panel__more" data-slot="promo-video.catalog.more">{t.t('common.moreItems', { n: catalogMenus.length - CATALOG_ROWS })}</li> : null}
        </ul>
      </section> : null}
      <div lang={state === 'before' ? undefined : 'ko'} className="pv-panel__action">{action}</div>
    </div>
  );
  const current = model.current;
  switch (model.state) {
    case 'making': {
      const step = t.t(`promo.stage.${current?.stage ?? 'look'}`);
      return root('making', (
        <>
          <span className="ui-sr-only">{t.t('widget.promo-video.makingName', { step })}</span>
          <p className="pv-panel__title" aria-hidden="true">{t.t('widget.promo-video.making')}</p>
          <p className="pv-panel__step" aria-hidden="true" data-slot="promo-video.stage">{step}</p>
          <StageBar stage={current?.stage ?? 'look'} label={t.t('widget.promo-video.bar', { n: (current?.stage ? STAGES.indexOf(current.stage) : 0) + 1 })} />
          {wide && current ? <p className="pv-panel__meta" data-slot="promo-video.meta">{t.t('widget.promo-video.makingMeta', { s: current.lengthSec, n: current.photoCount })}</p> : null}
        </>
      ), null);
    }
    case 'done':
      return root('done', (
        <p className="pv-panel__line pv-panel__line--done"><Icon name="check" aria-hidden /> <span>{wide && current ? t.t('widget.promo-video.doneW', { s: current.lengthSec }) : t.t('widget.promo-video.done')}</span></p>
      ), <PanelAction label={t.t('promo.btn.view')} widgetName={name} onPress={open} />);
    case 'failed': {
      const reason = current?.failReason ? t.t(`promo.fail.${current.failReason}`) : '';
      return root('failed', (
        <>
          <p className="pv-panel__line pv-panel__line--failed"><Icon name="warning" aria-hidden /> <span>{t.t('widget.promo-video.failed')}</span></p>
          {wide && reason ? <p className="pv-panel__reason" data-slot="promo-video.reason">{reason}</p> : null}
        </>
      ), <PanelAction label={t.t('promo.btn.retry')} widgetName={name} onPress={open} />);
    }
    case 'posted': {
      const place = placeName(t, model.lastPostedRoute);
      const desc = `${t.t('widget.promo-video.postedTo', { place })}${model.lastPostedCounting ? t.t('widget.promo-video.counting') : ''}`;
      return root('posted', (
        <>
          <span data-slot="promo-video.metric.value" className="mp-key"><MetricFit value={t.format.number(model.postedCount)} unit={t.t('widget.promo-video.postedUnit')} stacked={false} minStage={minStage} /></span>
          {t.locale === 'ko' ? <span className="pv-panel__label" data-slot="promo-video.metric.label">{t.t('widget.promo-video.postedLabel')}</span> : null}
          {wide ? <p className="pv-panel__desc" data-slot="promo-video.posted">{desc}</p> : <span className="ui-sr-only">{desc}</span>}
        </>
      ), <PanelAction label={t.t(wide ? 'promo.btn.newLong' : 'promo.btn.new')} widgetName={name} onPress={open} />, { 'data-posted': 'true' });
    }
    default:
      return root('before', (
        <>
          <span data-slot="promo-video.metric.value" className="mp-key pv-panel__materials" lang="ko">
            <span className="pv-panel__number" aria-hidden="true"><MetricFit value={t.format.number(model.materialsCount)} unit={t.t('widget.promo-video.materials.unit')} stacked={false} minStage={minStage} /></span>
            <span className="pv-panel__label" aria-hidden="true">{t.t('widget.promo-video.materials.label')}</span>
            <span className="ui-sr-only">{t.t('widget.promo-video.materials.sr', { n: model.materialsCount })}</span>
          </span>
          {wide && !roomy && model.firstMenu ? <p className="pv-panel__desc mp-desc" data-slot="promo-video.ready">{t.t('widget.promo-video.ready', { n: model.photoCount, menu: text(t, model.firstMenu.name) })}</p> : null}
        </>
      ), <PanelAction label={t.t('marketing.makeVideo')} widgetName={name} onPress={open} />);
  }
}

export function usePromoVideoSummary({ condition }: { readonly featureId: FeatureId; readonly condition: QueryCondition }): string {
  const t = useT();
  const view = useWidgetView(FEATURE_ID, condition);
  if (view.status !== 'ready') return t.t(view.messageKey);
  return summaryOf(t, view.model);
}

function summaryOf(t: ReturnType<typeof useT>, model: PromoVideoModel): string {
  const current = model.current;
  switch (model.state) {
    case 'making': return t.t('widget.promo-video.makingName', { step: t.t(`promo.stage.${current?.stage ?? 'look'}`) });
    case 'done': return t.t('widget.promo-video.done');
    case 'failed': return t.t('widget.promo-video.failed');
    case 'posted': return t.t('promo.posted.line', { n: model.postedCount, place: placeName(t, model.lastPostedRoute) });
    default: return t.t('widget.promo-video.materials.sr', { n: model.materialsCount });
  }
}

export function PromoVideoDetail({ condition, detailRef, host }: WidgetDetailProps) {
  const t = useT();
  const view = useWidgetView(FEATURE_ID, condition);
  const [session, state] = usePromoSession();
  // N18 handoff: a Navis entry can name the step tab (`prefill.tab`) and ask for the action focus; the window opens on that step.
  const fields = detailRef.prefill?.kind === 'widget-draft' && validateAgentPrefill(FEATURE_ID, detailRef.prefill.fields) ? detailRef.prefill.fields : undefined;
  const wantedTab = typeof fields?.tab === 'number' && fields.tab >= 0 && fields.tab <= 3 ? fields.tab as 0 | 1 | 2 | 3 : undefined;
  useEffect(() => { if (wantedTab !== undefined) session.setDraft({ tab: wantedTab }); }, [session, wantedTab]);
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || detailRef.focus !== 'action' || (wantedTab !== undefined && state.draft.tab !== wantedTab)) return;
    focused.current = true;
    document.querySelector<HTMLElement>('.pv-win [role="tab"][aria-selected="true"]')?.focus();
  }, [detailRef.focus, wantedTab, state.draft.tab]);
  if (view.status === 'error') return <div className="mp-detail" data-widget="promo-video" data-state="error"><PanelState tone="error" message={t.locale === 'ko' ? t.t('widget.promo-video.state.error.short') : t.t(view.messageKey)} action={{ label: t.t('common.retry'), widgetName: t.t('widget.promo-video.title'), onPress: () => host.resetPreview() }} /></div>;
  if (view.status === 'empty') {
    return <div className="mp-detail pv-win" data-widget="promo-video" data-state="empty"><p className="pv-empty" role="status">{t.t(view.messageKey)}</p></div>;
  }
  return <PromoWindow model={view.model} host={host} />;
}

export const promoVideoModule: WidgetModule = {
  id: FEATURE_ID,
  Panel: PromoVideoPanel,
  Detail: PromoVideoDetail,
  useSummary: usePromoVideoSummary,
};
