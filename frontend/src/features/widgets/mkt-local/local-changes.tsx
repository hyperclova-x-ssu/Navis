/** 동네 변화 알림 (`local-changes`, F-42): changes, their sources and the owner's acknowledgements. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { isLargeCard, koreanLang } from './fit';
import type { WidgetDetailProps, WidgetHost, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useRealPort, useWidgetDataStore, useWidgetView } from '../../../data/react';
import type { LocalChangeRow, LocalChangesModel } from '../../../data/models/types';
import { ActionButton, DateField, InlineForm, PanelBody, StatusBadge, TextField, useUi } from '../../../ui';
import { calendarDay, readLocalNews } from '../../../data/reality/13/adapter';
import { literal, type NewsReferences, type PeriodDto } from '../../../data/reality/13/dto';
import { exampleChange, exampleCoverage } from './example-local';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, dateTime, labelOrNull, rowCapacity, useT, type Translator } from './shared';
import { allowedSource, localKey, periodText, seoulStamp, useLocalCommand, useLocalData, useReadHost } from './local-changes.http';
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

/**
 * PAR-3 (D-384): the example mode shows the real screen. The fixture rows are given the same parts the service's change records carry
 * (kind, area, official source and link, the coverage line); the real model passes through, only its kind chip is made the same in the
 * panel and in the card.
 */
function useUnifiedModel(model: LocalChangesModel | undefined): LocalChangesModel | undefined {
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(() => {
    if (!model) return model;
    const dtos = model.real?.changes ?? snapshot.tables.localChange.filter(row => model.changes.some(c => c.changeId === row.changeId)).map(exampleChange);
    const byId = new Map(dtos.map(dto => [dto.id, dto]));
    const decorate = (c: LocalChangeRow): LocalChangeRow => {
      const dto = byId.get(c.changeId);
      return dto ? { ...c, kindKey: dto.changeType === 'closure' ? 'data.localChangeKind.closing' : localKey(dto.kind),
        whenKey: dto.changeType === 'closure' ? '' : localKey(dto.dateKind), sourceKey: literal(dto.authority), distanceM: 0 } : c;
    };
    const changes = model.changes.map(decorate);
    return { ...model, changes, openChanges: changes.filter(c => !c.acked), radiusM: 0,
      real: model.real ?? { changes: dtos, coverage: exampleCoverage(), unreadCount: model.openChanges.length, period: { from: model.week.start, to: model.week.end } } };
  }, [model, snapshot]);
}

function Panel({ condition, width, height, shape, host: shellHost }: WidgetPanelProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  const m = useUnifiedModel(view.status === 'ready' ? view.model : undefined);
  if (view.status !== 'ready' || !m) return <PanelStateView id={ID} view={view as never} shape={shape} width={width} host={host} />;
  /** D-333: the large card lists every open change with its distance, source and update time and the same-category badge (the lines the small sizes drop). */
  const large = isLargeCard(shape, height);
  const capacity = rowCapacity(shape, height, textScale);
  const rows = large ? [...m.openChanges, ...m.changes.filter(change => change.acked)] : m.openChanges.slice(0, capacity);
  const compact = shape === 'W';
  // The original panel number: this week's changes, which does not drop when one is folded away (the folded count says how many).
  const count = m.real!.unreadCount;
  const primary = (
    <PrimaryMetric id={ID} shape={shape} label={t.t('widget.local-changes.unreadLabel')} value={t.format.number(count)} unit={t.t('widget.local-changes.unit', { n: count })}
      secondary={m.foldedCount > 0 ? t.t('widget.local-changes.folded', { n: m.foldedCount }) : null} />
  );
  const list = rows.length === 0 ? null : (
    <FitList slot={`${ID}.list`} label={t.t('widget.local-changes.openList')} resetKey={`${t.locale}|${width}x${height}|${textScale}|${rows.length}`}
      items={rows.map((c, index) => (
        <li key={c.changeId} className="mkt-row" data-slot={`${ID}.list.row`} data-mkt-extra={large && index >= capacity ? '' : undefined}>
          <span className="mkt-row__text">
            <span className="mkt-row__title" lang={koreanLang(t.t(c.titleKey))}>{t.t(c.titleKey)}</span>
            <span className="mkt-row__sub">{compact ? `${t.t(c.kindKey)}\u00A0·\u00A0${whenText(t, c)}` : whenText(t, c)}</span>
            {large ? <span className="mkt-row__sub" data-mkt-extra="">{[t.t(c.sourceKey) === '사장님 기록' ? '' : t.t('widget.local-changes.source', { source: t.t(c.sourceKey) }), t.t(t.t(c.sourceKey) === '사장님 기록' ? 'widget.local-changes.recorded' : 'widget.local-changes.updated', dateTime(t, seoulStamp(c.updatedAt)))].filter(Boolean).join('\u00A0·\u00A0')}</span> : null}
          </span>
          {large && c.sameCategory ? <span data-mkt-extra=""><StatusBadge semantic="info" label={t.t('widget.local-changes.sameCategory')} /></span> : null}
          {compact ? null : c.acked ? <StatusBadge kind="checked" /> : <KindChip label={t.t(c.kindKey)} />}
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
  return <InlineForm footerActions title={t.t(localKey('addChange'))} saveLabel={t.t(localKey('saveChange'))} saving={pending} saveDisabled={!valid} onClose={close} onSave={async () => {
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

function NewsReferencesCard({ example, period, region }: { readonly example: boolean; readonly period: PeriodDto; readonly region: string }) {
  const t = useT();
  const port = useRealPort();
  const [state, setState] = useState<NewsReferences | 'unavailable'>();
  const { from, to } = period;
  useEffect(() => {
    if (example || !port) return;
    const controller = new AbortController();
    void readLocalNews(port.reads, { from, to }, controller.signal).then(news => {
      if (!controller.signal.aborted) setState(news ?? 'unavailable');
    }, () => { if (!controller.signal.aborted) setState('unavailable'); });
    return () => controller.abort();
  }, [example, port, from, to]);
  const title = t.t(localKey('newsReferences'));
  const rows = !state || state === 'unavailable' ? [] : state.items.flatMap(item => {
    const url = allowedSource(item.url);
    return url ? [{ ...item, url }] : [];
  });
  if (example || !state || state === 'unavailable' || state.status === 'unavailable') return null;
  return <section className="mkt-card" aria-label={title} aria-live="polite">
    <h3 className="mkt-section">{title}</h3>
    <MetaLine>{region} · {periodText(t, period)}</MetaLine>
    {rows.length ? <ul className="mkt-list">{rows.map((item, index) => <li key={`${index}:${item.url}`} className="mkt-row">
      <span className="mkt-row__text"><span className="mkt-row__title">{item.title}</span>
        <span className="mkt-row__sub">{t.format.date(seoulStamp(item.publishedAt).slice(0, 10), 'short')}</span></span>
      <a className="mkt-touch-link" href={item.url} target="_blank" rel="noopener noreferrer">{t.t(localKey('original'))}<span className="ui-sr-only"> {item.title}</span></a>
    </li>)}</ul> : <p className="mkt-meta" role="status">{t.t(localKey('links.empty'))}</p>}
  </section>;
}

function Detail({ condition, host: shellHost, detailRef }: WidgetDetailProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const view = useWidgetView(ID, condition);
  const m = useUnifiedModel(view.status === 'ready' ? view.model : undefined);
  const data = useLocalData();
  const dispatch = useDataDispatch();
  const { send, pending, error } = useLocalCommand(host);
  const [creating, setCreating] = useState(false);
  const [pendingId, setPendingId] = useState<string>();
  // A chat hand-off opens the folded list, or the folded row it names, already expanded.
  const [expanded, setExpanded] = useState<boolean>();
  const showFolded = expanded ?? (detailRef.view === 'folded' || (!!m && m.changes.some((c) => c.acked && c.changeId === detailRef.itemId)));
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const wanted = detailRef.itemId;
  useEffect(() => { if (wanted) list.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [wanted, showFolded, view.status]);
  if (view.status !== 'ready' || !m) return <DetailState id={ID} view={view as never} host={host} />;
  const real = m.real!;
  const acknowledge = (changeId: string, folded: boolean) => {
    const command = { type: folded ? 'localChanges.unacknowledge' : 'localChanges.acknowledge', changeId } as const;
    // The service answers after its receipt; the example data answers at once, with the same notice and the same focus.
    if (view.status === 'ready' && view.model.real) {
      setPendingId(changeId);
      void send(command).then(ok => { if (ok) heading.current?.focus(); }).finally(() => setPendingId(undefined));
      return;
    }
    const result = dispatch(command);
    if (result.ok) host.notify({ kind: 'success', messageKey: result.noticeKey ?? (folded ? 'data.notice.changeReopened' : 'data.notice.changeAcked'), ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
    heading.current?.focus();
  };
  const card = (c: LocalChangeRow, folded: boolean) => {
    const source = real.changes.find(row => row.id === c.changeId);
    const manual = source?.authority === '사장님 기록';
    const updated = dateTime(t, seoulStamp(c.updatedAt));
    const href = source && allowedSource(source.sourceUrl);
    return (
      <li key={c.changeId} className="mkt-card" data-slot={`${ID}.list.row`} aria-current={c.changeId === wanted ? 'true' : undefined}>
        <div className="mkt-card__badges">
          <KindChip label={t.t(c.kindKey)} />
          {c.sameCategory ? <StatusBadge semantic="info" label={t.t('widget.local-changes.sameCategory')} /> : null}
          {folded ? <StatusBadge kind="checked" /> : null}
        </div>
        <h4 className="mkt-card__title">{t.t(c.titleKey)}</h4>
        <p className="mkt-card__line">{whenText(t, c)}{source && <> · {source.region}</>}</p>
        {t.locale !== 'ko' && c.inDemandForecast ? <p className="mkt-card__line">{t.t('widget.local-changes.reflected')}</p> : null}
        <p className="mkt-card__meta">{!manual && <>{t.t('widget.local-changes.source', { source: t.t(c.sourceKey) })}{'\u00A0·\u00A0'}</>}{t.t(manual ? 'widget.local-changes.recorded' : 'widget.local-changes.updated', updated)}</p>
        {href && <p><a className="mkt-touch-link" href={href} target="_blank" rel="noopener noreferrer">{t.t(localKey('original'))}</a></p>}
        <ActionButton variant="secondary" loading={pending && pendingId === c.changeId} disabled={creating || pending} onClick={() => acknowledge(c.changeId, folded)}>{t.t(folded ? localKey('openAgain') : 'widget.local-changes.markReviewed')}<span className="ui-sr-only"> {t.t(c.titleKey)}</span></ActionButton>
      </li>
    );
  };
  const folded = m.changes.filter((c) => c.acked);
  const official = real.changes.some(row => row.authority !== '사장님 기록');
  return (
    <div ref={list} className="mkt-detail mkt-detail--natural" data-slot={`${ID}.card`}>
      <LocalReadNote notes={view.notes} host={host} />
      <MetaLine><strong data-slot="local-changes.detail.unread">{t.t('widget.local-changes.summary', { n: real.unreadCount })}</strong>{' · '}{periodText(t, real.period)}</MetaLine>
      <MetaLine>{real.coverage ? official
        ? t.t('widget.local-changes.officialCoverage', { region: real.coverage.region, date: t.format.date(real.coverage.referenceDate, 'short') })
        : t.t('widget.local-changes.noOfficial', { region: real.coverage.region }) : t.t(localKey('noCoverage'))}</MetaLine>
      {real.coverage?.fetchedAt && <MetaLine>{t.t('widget.local-changes.source', { source: '서울 열린데이터광장' })}{' · '}
        {t.t('widget.local-changes.updated', dateTime(t, seoulStamp(real.coverage.fetchedAt)))}</MetaLine>}
      {!creating && <div><ActionButton variant="secondary" onClick={() => setCreating(true)} disabled={pending}>{t.t(localKey('addChange'))}</ActionButton></div>}
      {creating && <CreateChange host={host} region={real.coverage?.region ?? ''} period={real.period} close={() => setCreating(false)} />}
      <h3 className="mkt-section" tabIndex={-1} ref={heading}>{t.t('widget.local-changes.openList')}</h3>
      {error && <p role="alert">{t.t(error)}</p>}
      {m.openChanges.length === 0 ? <p className="mkt-detail-state__message" role="status">{t.t(m.changes.length === 0 ? localKey('noData') : 'widget.local-changes.allChecked')}</p> : <ul className="mkt-cards" data-slot={`${ID}.list`}>{m.openChanges.map((c) => card(c, false))}</ul>}
      {folded.length > 0 ? (
        <>
          <ActionButton variant="outline" aria-expanded={showFolded} onClick={() => setExpanded(!showFolded)}>{t.t('widget.local-changes.folded', { n: m.foldedCount })}</ActionButton>
          {showFolded ? <ul className="mkt-cards" aria-label={t.t('widget.local-changes.folded', { n: m.foldedCount })}>{folded.map((c) => card(c, true))}</ul> : null}
        </>
      ) : null}
      {real.coverage && <NewsReferencesCard key={`${data?.storeId ?? 'example'}:${real.period.from}:${real.period.to}:${real.coverage.region}`}
        example={!view.model.real} period={real.period} region={real.coverage.region} />}
    </div>
  );
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  const m = useUnifiedModel(view.status === 'ready' ? view.model : undefined);
  return view.status === 'ready' && m ? t.t('widget.local-changes.summary', { n: m.real!.unreadCount }) : t.t((view as { messageKey: string }).messageKey);
}

export const localChangesModule: WidgetModule = {
  id: ID,
  Panel,
  Detail,
  useSummary,
};
