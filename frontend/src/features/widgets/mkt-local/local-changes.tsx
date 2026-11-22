/** 동네 변화 알림 (`local-changes`, F-42): changes, their sources and the owner's acknowledgements. */
import { useEffect, useRef, useState } from 'react';
import { isLargeCard, koreanLang } from './fit';
import type { WidgetDetailProps, WidgetHost, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useWidgetView } from '../../../data/react';
import type { LocalChangeRow } from '../../../data/models/types';
import { ActionButton, DateField, InlineForm, PanelBody, StatusBadge, TextField, useUi } from '../../../ui';
import { calendarDay } from '../../../data/reality/13/adapter';
import type { PeriodDto } from '../../../data/reality/13/dto';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, dateTime, labelOrNull, rowCapacity, useT, type Translator } from './shared';
import { allowedSource, localKey, periodText, seoulStamp, useLocalCommand, useReadHost } from './local-changes.http';
import { dateRangeWithWeekdays } from '../date-range';

const ID = 'local-changes';

export function LocalReadNote({ notes, host }: { readonly notes?: readonly { readonly messageKey: string }[]; readonly host: WidgetHost }) {
  const t = useT();
  const note = notes?.find(entry => entry.messageKey === 'data.real.stale' || entry.messageKey === 'data.real.partial');
  if (!note) return null;
  return <div className="mkt-card" role="status">
    <MetaLine>{t.t(note.messageKey)}</MetaLine>
    <ActionButton variant="secondary" onClick={host.resetPreview}>{t.t('common.retry')}</ActionButton>
  </div>;
}

/** The change type is a text-only kind chip (DS 6.1: an icon only ever carries one state meaning, so ⚠ is not “공사”). */
const KindChip = ({ label }: { readonly label: string }) => <StatusBadge semantic="none" label={label} />;

function whenOf(t: Translator, c: LocalChangeRow): string {
  return c.endDate && c.endDate !== c.startDate ? dateRangeWithWeekdays(t, c.startDate, c.endDate) : t.format.date(c.startDate, 'short');
}
/** The descriptive “when” label if the data has one, then the formatted date (never a raw ISO date). */
function whenText(t: Translator, c: LocalChangeRow): string {
  const label = labelOrNull(t, c.whenKey);
  return label ? `${label}\u00A0·\u00A0${whenOf(t, c)}` : whenOf(t, c);
}

function Panel({ condition, width, height, shape, host: shellHost }: WidgetPanelProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return <PanelStateView id={ID} view={view} shape={shape} width={width} host={host} />;
  const m = view.model;
  /** D-333: the large card lists every open change with its distance, source and update time and the same-category badge (the lines the small sizes drop). */
  const large = isLargeCard(shape, height);
  const capacity = rowCapacity(shape, height, textScale);
  const rows = large ? m.openChanges : m.openChanges.slice(0, capacity);
  const compact = shape === 'W';
  const count = m.real?.unreadCount ?? m.count;
  const primary = (
    <PrimaryMetric id={ID} shape={shape} label={t.t(m.real ? 'widget.local-changes.openList' : 'widget.local-changes.thisWeek')} value={t.format.number(count)} unit={t.t('widget.local-changes.unit', { n: count })}
      secondary={m.foldedCount > 0 ? t.t('widget.local-changes.folded', { n: m.foldedCount }) : null} />
  );
  const list = rows.length === 0 ? null : (
    <FitList slot={`${ID}.list`} label={t.t('widget.local-changes.openList')} resetKey={`${t.locale}|${width}x${height}|${textScale}|${rows.length}`}
      items={rows.map((c, index) => (
        <li key={c.changeId} className="mkt-row" data-slot={`${ID}.list.row`} data-mkt-extra={large && index >= capacity ? '' : undefined}>
          <span className="mkt-row__text">
            <span className="mkt-row__title" lang={koreanLang(t.t(c.titleKey))}>{t.t(c.titleKey)}</span>
            <span className="mkt-row__sub">{compact ? `${t.t(c.kindKey)}\u00A0·\u00A0${whenText(t, c)}` : whenText(t, c)}</span>
            {large ? <span className="mkt-row__sub" data-mkt-extra="">{[!m.real && t.t('widget.local-changes.distance', { m: t.format.number(c.distanceM) }), c.sourceKey !== 'data.source.sample' && t.t('widget.local-changes.source', { source: t.t(c.sourceKey) }), t.t('widget.local-changes.updated', dateTime(t, m.real ? seoulStamp(c.updatedAt) : c.updatedAt))].filter(Boolean).join('\u00A0·\u00A0')}</span> : null}
          </span>
          {large && c.sameCategory ? <span data-mkt-extra=""><StatusBadge semantic="info" label={t.t('widget.local-changes.sameCategory')} /></span> : null}
          {compact ? null : <KindChip label={t.t(c.kindKey)} />}
        </li>
      ))} />
  );
  return <PanelBody width={width} height={height} primary={primary} list={list} />;
}

function CreateChange({ host, region, period, close }: { readonly host: WidgetHost; readonly region: string; readonly period: PeriodDto; readonly close: () => void }) {
  const t = useT();
  const { pending, error, send } = useLocalCommand(host);
  const [title, setTitle] = useState('');
  const [area, setArea] = useState(region);
  const [referenceDate, setDate] = useState(calendarDay);
  const [url, setUrl] = useState('');
  const sourceUrl = allowedSource(url.trim());
  const invalidUrl = Boolean(url.trim()) && (!sourceUrl || sourceUrl.length > 2048);
  const valid = title.trim() && title.trim().length <= 160 && area.trim() && area.trim().length <= 100
    && referenceDate >= period.from && referenceDate <= period.to && !invalidUrl;
  return <InlineForm title={t.t(localKey('addChange'))} saving={pending} saveDisabled={!valid} onClose={close} onSave={async () => {
    if (await send({ type: 'localChanges.create', title: title.trim(), region: area.trim(), referenceDate, sourceUrl })) close();
  }}>
    <TextField label={t.t(localKey('title'))} name="title" value={title} onValueChange={setTitle} disabled={pending} required />
    <TextField label={t.t(localKey('region'))} name="region" value={area} onValueChange={setArea} disabled={pending} required />
    <DateField label={t.t(localKey('recorded-date'))} name="referenceDate" value={referenceDate} min={period.from} max={period.to}
      onValueChange={value => setDate(value ?? '')} disabled={pending} required />
    <TextField label={t.t(localKey('sourceUrl'))} name="sourceUrl" value={url} onValueChange={setUrl} disabled={pending}
      error={invalidUrl ? t.t(localKey('sourceInvalid')) : undefined} />
    {error && <p role="alert">{t.t(error)}</p>}
  </InlineForm>;
}

function Detail({ condition, host: shellHost, detailRef }: WidgetDetailProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const view = useWidgetView(ID, condition);
  const dispatch = useDataDispatch();
  const { send, pending, error } = useLocalCommand(host);
  const [creating, setCreating] = useState(false);
  // A chat hand-off opens the folded list, or the folded row it names, already expanded.
  const [expanded, setExpanded] = useState<boolean>();
  const showFolded = expanded ?? (detailRef.view === 'folded'
    || (view.status === 'ready' && view.model.changes.some((c) => c.acked && c.changeId === detailRef.itemId)));
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const wanted = detailRef.itemId;
  useEffect(() => { if (wanted) list.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [wanted, showFolded, view.status]);
  if (view.status !== 'ready') return <DetailState id={ID} view={view} host={host} />;
  const m = view.model;
  const acknowledge = (changeId: string, folded: boolean) => {
    if (m.real) {
      void send({ type: folded ? 'localChanges.unacknowledge' : 'localChanges.acknowledge', changeId })
        .then(ok => { if (ok) heading.current?.focus(); });
      return;
    }
    const result = dispatch({ type: 'localChanges.acknowledge', changeId });
    if (result.ok) host.notify({ kind: 'success', messageKey: result.noticeKey ?? 'data.notice.changeAcked', ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
    heading.current?.focus();
  };
  const card = (c: LocalChangeRow, folded: boolean) => {
    const source = m.real?.changes.find(row => row.id === c.changeId);
    const updated = dateTime(t, source ? seoulStamp(c.updatedAt) : c.updatedAt);
    const href = source && allowedSource(source.sourceUrl);
    return (
      <li key={c.changeId} className="mkt-card" data-slot={`${ID}.list.row`} aria-current={c.changeId === wanted ? 'true' : undefined}>
        <div className="mkt-card__badges">
          <KindChip label={t.t(source ? localKey(source.kind) : c.kindKey)} />
          {c.sameCategory ? <StatusBadge semantic="info" label={t.t('widget.local-changes.sameCategory')} /> : null}
          {folded ? <StatusBadge kind="checked" /> : null}
        </div>
        <h4 className="mkt-card__title">{t.t(c.titleKey)}</h4>
        <p className="mkt-card__line">{whenText(t, c)}{source && <> · {source.region}</>}</p>
        {!source && <p className="mkt-card__line">{t.t('widget.local-changes.distance', { m: t.format.number(c.distanceM) })}</p>}

        {t.locale !== 'ko' && c.inDemandForecast ? <p className="mkt-card__line">{t.t('widget.local-changes.reflected')}</p> : null}
        <p className="mkt-card__meta">{c.sourceKey !== 'data.source.sample' ? <>{t.t('widget.local-changes.source', { source: t.t(c.sourceKey) })}{'\u00A0·\u00A0'}</> : null}{t.t('widget.local-changes.updated', updated)}</p>
        {href && <p><a className="mkt-touch-link" href={href} target="_blank" rel="noopener noreferrer">{t.t(localKey('original'))}</a></p>}
        {(!folded || m.real) && <ActionButton variant="secondary" loading={pending} disabled={creating || pending} onClick={() => acknowledge(c.changeId, folded)}>{t.t(folded ? localKey('openAgain') : 'common.gotIt')}<span className="ui-sr-only"> {t.t(c.titleKey)}</span></ActionButton>}
      </li>
    );
  };
  const folded = m.changes.filter((c) => c.acked);
  return (
    <div ref={list} className="mkt-detail mkt-detail--natural" data-slot={`${ID}.card`}>
      <LocalReadNote notes={view.notes} host={host} />
      <MetaLine>{t.t('widget.local-changes.summary', { n: m.real?.unreadCount ?? m.openChanges.length })}{'\u00A0·\u00A0'}{m.real ? periodText(t, m.real.period) : t.t('data.region.storeArea')}</MetaLine>
      {m.real && <>
        <MetaLine>{m.real.coverage ? t.t(localKey('coverage'), { region: m.real.coverage.region, date: t.format.date(m.real.coverage.referenceDate, 'short') }) : t.t(localKey('noCoverage'))}</MetaLine>
        {!!m.real.coverage?.kinds.length && <MetaLine>{m.real.coverage.kinds.map(kind => t.t(localKey(kind))).join(' · ')}</MetaLine>}
        <div><ActionButton variant="secondary" onClick={() => setCreating(true)} disabled={creating || pending}>{t.t(localKey('addChange'))}</ActionButton></div>
        {creating && <CreateChange host={host} region={m.real.coverage?.region ?? ''} period={m.real.period} close={() => setCreating(false)} />}
      </>}
      <h3 className="mkt-section" tabIndex={-1} ref={heading}>{t.t('widget.local-changes.openList')}</h3>
      {error && <p role="alert">{t.t(error)}</p>}
      {m.openChanges.length === 0 ? <p className="mkt-detail-state__message" role="status">{t.t(m.real && m.changes.length === 0 ? localKey('noData') : 'widget.local-changes.allChecked')}</p> : <ul className="mkt-cards" data-slot={`${ID}.list`}>{m.openChanges.map((c) => card(c, false))}</ul>}
      {folded.length > 0 ? (
        <>
          <ActionButton variant="outline" aria-expanded={showFolded} onClick={() => setExpanded(!showFolded)}>{t.t('widget.local-changes.folded', { n: m.foldedCount })}</ActionButton>
          {showFolded ? <ul className="mkt-cards" aria-label={t.t('widget.local-changes.folded', { n: m.foldedCount })}>{folded.map((c) => card(c, true))}</ul> : null}
        </>
      ) : null}
    </div>
  );
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  return view.status === 'ready' ? t.t('widget.local-changes.summary', { n: view.model.real?.unreadCount ?? view.model.openChanges.length }) : t.t(view.messageKey);
}

export const localChangesModule: WidgetModule = {
  id: ID,
  Panel,
  Detail,
  useSummary,
};
