/** 동네 변화 알림 (`local-changes`, F-42): kind badge · distance · same category · source · updated; “확인했어요” folds a change (count stays). */
import { useEffect, useRef, useState } from 'react';
import { koreanLang } from './fit';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useWidgetView } from '../../../data/react';
import type { LocalChangeRow } from '../../../data/models/types';
import { ActionButton, PanelBody, StatusBadge, useUi } from '../../../ui';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, dateTime, labelOrNull, rowCapacity, useT, type Translator } from './shared';

const ID = 'local-changes';

/** The change type is a text-only kind chip (DS 6.1: an icon only ever carries one state meaning, so ⚠ is not “공사”). */
const KindChip = ({ label }: { readonly label: string }) => <StatusBadge semantic="none" label={label} />;

function whenOf(t: Translator, c: LocalChangeRow): string {
  return c.endDate && c.endDate !== c.startDate ? t.format.dateRange(c.startDate, c.endDate) : t.format.date(c.startDate, 'short');
}
/** The descriptive “when” label if the data has one, then the formatted date (never a raw ISO date). */
function whenText(t: Translator, c: LocalChangeRow): string {
  const label = labelOrNull(t, c.whenKey);
  return label ? `${label}\u00A0·\u00A0${whenOf(t, c)}` : whenOf(t, c);
}

function Panel({ condition, width, height, shape, host }: WidgetPanelProps) {
  const t = useT();
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return <PanelStateView id={ID} view={view} shape={shape} width={width} host={host} />;
  const m = view.model;
  const rows = m.openChanges.slice(0, rowCapacity(shape, height, textScale));
  const compact = shape === 'W';
  const primary = (
    <PrimaryMetric id={ID} shape={shape} label={t.t('widget.local-changes.thisWeek')} value={t.format.number(m.count)} unit={t.t('widget.local-changes.unit', { n: m.count })}
      secondary={m.foldedCount > 0 ? t.t('widget.local-changes.folded', { n: m.foldedCount }) : null} />
  );
  const list = rows.length === 0 ? null : (
    <FitList slot={`${ID}.list`} label={t.t('widget.local-changes.openList')} resetKey={`${t.locale}|${width}x${height}|${textScale}|${rows.length}`}
      items={rows.map((c) => (
        <li key={c.changeId} className="mkt-row" data-slot={`${ID}.list.row`}>
          <span className="mkt-row__text">
            <span className="mkt-row__title" lang={koreanLang(t.t(c.titleKey))}>{t.t(c.titleKey)}</span>
            <span className="mkt-row__sub">{compact ? `${t.t(c.kindKey)}\u00A0·\u00A0${whenText(t, c)}` : whenText(t, c)}</span>
          </span>
          {compact ? null : <KindChip label={t.t(c.kindKey)} />}
        </li>
      ))} />
  );
  return <PanelBody width={width} height={height} primary={primary} list={list} />;
}

function Detail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useT();
  const view = useWidgetView(ID, condition);
  const dispatch = useDataDispatch();
  // A chat hand-off opens the folded list, or the folded row it names, already expanded.
  const [showFolded, setShowFolded] = useState(() => detailRef.view === 'folded'
    || (view.status === 'ready' && view.model.changes.some((c) => c.acked && c.changeId === detailRef.itemId)));
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const wanted = detailRef.itemId;
  useEffect(() => { if (wanted) list.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [wanted, showFolded]);
  if (view.status !== 'ready') return <DetailState id={ID} view={view} host={host} />;
  const m = view.model;
  const acknowledge = (changeId: string) => {
    const result = dispatch({ type: 'localChanges.acknowledge', changeId });
    if (result.ok) host.notify({ kind: 'success', messageKey: result.noticeKey ?? 'data.notice.changeAcked', ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
    heading.current?.focus();
  };
  const card = (c: LocalChangeRow, folded: boolean) => {
    const updated = dateTime(t, c.updatedAt);
    return (
      <li key={c.changeId} className="mkt-card" data-slot={`${ID}.list.row`} aria-current={c.changeId === wanted ? 'true' : undefined}>
        <div className="mkt-card__badges">
          <KindChip label={t.t(c.kindKey)} />
          {c.sameCategory ? <StatusBadge semantic="info" label={t.t('widget.local-changes.sameCategory')} /> : null}
          {folded ? <StatusBadge kind="checked" /> : null}
        </div>
        <h4 className="mkt-card__title">{t.t(c.titleKey)}</h4>
        <p className="mkt-card__line">{whenText(t, c)}</p>
        <p className="mkt-card__line">{t.t('widget.local-changes.distance', { m: t.format.number(c.distanceM) })}</p>

        {t.locale !== 'ko' && c.inDemandForecast ? <p className="mkt-card__line">{t.t('widget.local-changes.reflected')}</p> : null}
        <p className="mkt-card__meta">{t.t('widget.local-changes.source', { source: t.t(c.sourceKey) })}{'\u00A0·\u00A0'}{t.t('widget.local-changes.updated', updated)}</p>
        {folded ? null : <ActionButton variant="secondary" onClick={() => acknowledge(c.changeId)}>{t.t('common.gotIt')}<span className="ui-sr-only"> {t.t(c.titleKey)}</span></ActionButton>}
      </li>
    );
  };
  const folded = m.changes.filter((c) => c.acked);
  return (
    <div ref={list} className="mkt-detail mkt-detail--natural" data-slot={`${ID}.card`}>
      <MetaLine>{t.t('widget.local-changes.summary', { n: m.openChanges.length })}{'\u00A0·\u00A0'}{t.t('data.region.storeArea')}</MetaLine>
      <h3 className="mkt-section" tabIndex={-1} ref={heading}>{t.t('widget.local-changes.openList')}</h3>
      {m.openChanges.length === 0 ? <p className="mkt-detail-state__message" role="status">{t.t('widget.local-changes.allChecked')}</p> : <ul className="mkt-cards" data-slot={`${ID}.list`}>{m.openChanges.map((c) => card(c, false))}</ul>}
      {folded.length > 0 ? (
        <>
          <ActionButton variant="outline" aria-expanded={showFolded} onClick={() => setShowFolded(!showFolded)}>{t.t('widget.local-changes.folded', { n: m.foldedCount })}</ActionButton>
          {showFolded ? <ul className="mkt-cards" aria-label={t.t('widget.local-changes.folded', { n: m.foldedCount })}>{folded.map((c) => card(c, true))}</ul> : null}
        </>
      ) : null}
    </div>
  );
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  return view.status === 'ready' ? t.t('widget.local-changes.summary', { n: view.model.openChanges.length }) : t.t(view.messageKey);
}

export const localChangesModule: WidgetModule = { id: ID, Panel, Detail, useSummary };
