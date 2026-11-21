/** 커뮤니티 (`community`, F-46): received offers by reply deadline, browse public offers; accept / decline / show interest (mock). */
import { useLayoutEffect, useRef, useState } from 'react';
import { koreanLang } from './fit';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useWidgetView } from '../../../data/react';
import type { OfferRow } from '../../../data/models/types';
import { ActionButton, DetailTabs, Icon, MasterDetail, PanelBody, StatusBadge, useUi } from '../../../ui';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, dateTime, rowCapacity, useT, type Translator } from './shared';

const ID = 'community';
type Tab = 'received' | 'browse';

function StatusOf({ t, offer }: { readonly t: Translator; readonly offer: OfferRow }) {
  if (offer.status === 'pending') return <StatusBadge semantic="waiting" label={t.t('widget.community.awaiting')} />;
  if (offer.status === 'accepted') return <StatusBadge kind="active" label={t.t('widget.community.accepted')} />;
  if (offer.status === 'declined') return <StatusBadge kind="reviewed" label={t.t('widget.community.declined')} />;
  return <StatusBadge semantic="warning" label={t.t('widget.community.expired')} />;
}

function Panel({ condition, width, height, shape, host }: WidgetPanelProps) {
  const t = useT();
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return <PanelStateView id={ID} view={view} shape={shape} width={width} host={host} />;
  const m = view.model;
  const primary = <PrimaryMetric id={ID} shape={shape} label={t.t('widget.community.pendingOffers')} value={t.format.number(m.pendingCount)} unit={t.t('widget.community.unit', { n: m.pendingCount })} />;
  const rows = m.pending.slice(0, shape === 'W' ? (textScale === 125 ? 1 : 2) : rowCapacity(shape, height, textScale));
  const list = rows.length === 0 ? null : (
    <FitList slot={`${ID}.list`} label={t.t('widget.community.pendingOffers')} resetKey={`${t.locale}|${width}x${height}|${textScale}|${rows.length}`}
      items={rows.map((o) => (
        <li key={o.offerId} className="mkt-row" data-slot={`${ID}.list.row`}>
          <span className="mkt-row__text"><span className="mkt-row__title" lang={koreanLang(t.t(o.titleKey))}>{t.t(o.titleKey)}</span><span className="mkt-row__sub">{t.t(o.fromStoreKey)}</span></span>
          {shape === 'W' ? <span className="mkt-row__value">{t.t('widget.community.awaiting')}</span> : <StatusOf t={t} offer={o} />}
        </li>
      ))} />
  );
  const extra = shape === 'S' || shape === 'L' ? (
    <p className="mkt-secondary" data-slot={`${ID}.metric.secondary`}>{t.t('widget.community.tabBrowse')} {m.publicOffers.length}{'\u00A0·\u00A0'}{t.t('widget.community.accepted')} {m.inProgress.length}</p>
  ) : null;
  return <PanelBody width={width} height={height} primary={primary} list={list} secondary={extra} />;
}

function Detail({ condition, detailRef, host }: WidgetDetailProps) {
  const t = useT();
  const view = useWidgetView(ID, condition);
  const dispatch = useDataDispatch();
  const [tab, setTab] = useState<Tab>(detailRef.view === 'browse' ? 'browse' : 'received');
  const [pickedId, setPickedId] = useState<string | null>(detailRef.itemId ?? null);
  const entryRow = useRef<HTMLButtonElement>(null);
  const entryAction = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (detailRef.focus === 'action' || detailRef.itemId) (entryAction.current ?? entryRow.current)?.focus({ preventScroll: true });
  }, [detailRef.focus, detailRef.itemId, view.status]);
  if (view.status !== 'ready') return <DetailState id={ID} view={view} host={host} />;
  const m = view.model;
  // Received offers: waiting first by reply deadline, then in progress, then closed ones.
  const rank = (o: OfferRow) => (o.status === 'pending' ? 0 : o.status === 'accepted' ? 1 : 2);
  const received = [...m.received].sort((a, b) => rank(a) - rank(b) || a.respondBy.localeCompare(b.respondBy) || a.offerId.localeCompare(b.offerId));
  const list = tab === 'received' ? received : m.publicOffers;
  const selected = list.find((o) => o.offerId === pickedId) ?? list[0] ?? null;

  const act = (type: 'community.accept' | 'community.decline' | 'community.sendInterest', offerId: string) => {
    const result = dispatch({ type, offerId });
    if (result.ok && result.noticeKey) host.notify({ kind: 'success', messageKey: result.noticeKey, ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
  };

  const row = (o: OfferRow) => {
    const by = dateTime(t, o.respondBy);
    return (
      <li key={o.offerId} data-slot={`${ID}.list.row`}>
        <button type="button" className="mkt-pick" ref={selected?.offerId === o.offerId ? entryRow : undefined} aria-current={selected?.offerId === o.offerId} onClick={() => setPickedId(o.offerId)}>
          <span className="mkt-pick__top"><span className="mkt-pick__title">{t.t(o.titleKey)}</span></span>
          <span className="mkt-pick__sub">{t.t(o.fromStoreKey)}{'\u00A0·\u00A0'}{t.t(o.categoryKey)}</span>
          <span className="mkt-pick__badges"><StatusOf t={t} offer={o} /></span>
          {o.status === 'pending' ? <span className="mkt-pick__sub">{t.t('widget.community.respondBy', by)}</span> : null}
        </button>
      </li>
    );
  };

  const pane = () => {
    if (!selected) return <p className="mkt-meta">{t.t('widget.community.pickItem')}</p>;
    const o = selected;
    const by = dateTime(t, o.respondBy);
    return (
      <div className="mkt-detail" data-slot={`${ID}.card`}>
        <div className="mkt-card__badges"><StatusOf t={t} offer={o} /><StatusBadge semantic="none" label={t.t(o.categoryKey)} /></div>
        <h4 className="mkt-card__title">{t.t(o.titleKey)}</h4>
        <MetaLine>{t.t('widget.community.from', { store: t.t(o.fromStoreKey) })}</MetaLine>
        <h4 className="mkt-section">{t.t('widget.community.termsLabel')}</h4>
        <p className="mkt-quote">{t.t(o.termsKey)}</p>
        <p className="mkt-card__line">{t.t('widget.community.period', { period: t.format.dateRange(o.period.start, o.period.end) })}</p>
        <p className="mkt-card__line">{t.t('widget.community.respondBy', by)}</p>
        {o.status === 'accepted' && o.sharedContactKey ? <p className="mkt-ok" role="status"><Icon name="check" aria-hidden />{t.t('widget.community.contact', { contact: t.t(o.sharedContactKey) })}</p> : null}
        {o.visibility === 'direct' && o.status === 'pending' ? (
          <>
            {t.locale !== 'ko' ? <p className="mkt-meta">{t.t('widget.community.directHint')}</p> : null}
            <div className="mkt-reply-actions">
              <ActionButton ref={entryAction} onClick={() => act('community.accept', o.offerId)}>{t.locale === 'ko' ? t.t('widget.community.accept') : t.t('common.accept')}</ActionButton>
              <ActionButton variant="secondary" onClick={() => act('community.decline', o.offerId)}>{t.locale === 'ko' ? t.t('widget.community.decline') : t.t('common.decline')}</ActionButton>
            </div>
          </>
        ) : null}
        {o.visibility === 'public' ? (
          <>
            <p className="mkt-meta">{t.t('widget.community.publicHint')}</p>
            {o.interestSent ? <p className="mkt-ok" role="status"><Icon name="check" aria-hidden />{t.t('data.notice.interestSent')}</p>
              : <div className="mkt-reply-actions"><ActionButton ref={entryAction} onClick={() => act('community.sendInterest', o.offerId)}>{t.t('common.showInterest')}</ActionButton></div>}
          </>
        ) : null}
      </div>
    );
  };

  const tabs = [{ value: 'received' as const, label: t.t('widget.community.tabReceived') }, { value: 'browse' as const, label: t.t('widget.community.tabBrowse') }];
  return (
    <div className="mkt-detail">
      <MetaLine>{t.t('widget.community.summary', { n: m.pendingCount })}</MetaLine>
      <DetailTabs value={tab} onValueChange={(v) => { setTab(v); setPickedId(null); }} tabs={tabs} label={t.t('widget.community.tabLabel')} />
      <MasterDetail
        list={list.length === 0 ? <p className="mkt-meta">{tab === 'browse' ? t.t('widget.community.noPublic') : t.t('widget.community.noReceived')}</p> : <ul className="mkt-list" data-slot={`${ID}.list`}>{list.map(row)}</ul>}
        detail={pane()}
      />
    </div>
  );
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  return view.status === 'ready' ? t.t('widget.community.summary', { n: view.model.pendingCount }) : t.locale === 'ko' && view.variant === 'none' ? t.t('widget.community.state.none') : t.t(view.messageKey);
}

export const communityModule: WidgetModule = { id: ID, Panel, Detail, useSummary };
