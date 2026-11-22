/** 로컬 트렌드 (`local-trends`, F-44): keyword change list; a keyword opens its metric definition, comparison period, source and date. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { isLargeCard, koreanLang } from './fit';
import { useRealPort, useWidgetDataStore, useWidgetView } from '../../../data/react';
import { readLocalTrends } from '../../../data/reality/13/adapter';
import type { LinkSeries, RealLocal, SearchLinksDto } from '../../../data/reality/13/dto';
import type { KeywordRow } from '../../../data/models/types';
import { ActionButton, DetailTabs, PanelBody, TextField, useUi } from '../../../ui';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, dateTime, rowCapacity, useT, type Translator } from './shared';
import { allowedSource, localKey, periodText, seoulStamp, useLocalData, useReadHost } from './local-changes.http';
import { LocalReadNote } from './local-changes';
import { dateRangeWithWeekdays } from '../date-range';

const ID = 'local-trends';

/** ▲/▼ plus words, never colour alone. */
function changeText(t: Translator, k: KeywordRow): string {
  if (k.changePercent === null) return t.t('widget.local-trends.noComparison');
  const pct = t.format.number(Math.abs(k.changePercent));
  if (k.changePercent > 0) return `▲ ${t.t('widget.local-trends.rose', { pct })}`;
  if (k.changePercent < 0) return `▼ ${t.t('widget.local-trends.fell', { pct })}`;
  return `– ${t.t('widget.local-trends.rose', { pct: 0 })}`;
}

function Panel({ condition, width, height, shape, host: shellHost }: WidgetPanelProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return <PanelStateView id={ID} view={view} shape={shape} width={width} host={host} />;
  const m = view.model;
  const search = m.real?.search;
  const latest = search?.items.at(-1);
  if (m.real && !latest && !m.keywords.length) return <PanelStateView id={ID} view={{ status: 'empty', variant: 'real-empty', messageKey: localKey('noData') }} shape={shape} width={width} host={host} />;
  const label = m.real ? t.t(localKey(latest ? 'searchInterest' : 'menuSales')) : t.t('widget.local-trends.notableKeywords');
  const value = m.real ? latest?.ratio ?? m.keywords.reduce((total, row) => total + row.mentions, 0) : m.notableCount;
  /** D-333: the large card names the area and period, lists the other keywords the data holds after the notable ones, and gives each its mentions and the count before. */
  const large = isLargeCard(shape, height);
  const notable = (m.real ? m.keywords : m.notable).slice(0, shape === 'W' ? 2 : rowCapacity(shape, height, textScale));
  const rows = large ? [...notable, ...m.keywords.filter((k) => !notable.some((n) => n.keywordId === k.keywordId))] : notable;
  const primary = (
    <PrimaryMetric id={ID} shape={shape} label={label} value={t.format.number(value)} unit={m.real ? '' : t.t('widget.local-trends.unit', { n: value })} note={m.real ? undefined : t.t('widget.local-trends.periodNote')}
      secondary={m.real ? (latest ? search?.query.keywordGroups[0]?.groupName : periodText(t, m.real.period))
        : large ? `${t.t('widget.local-trends.region', { region: t.t(m.regionKey) })}\u00A0·\u00A0${dateRangeWithWeekdays(t, m.period.start, m.period.end)}` : null} />
  );
  const list = rows.length === 0 ? null : (
    <FitList slot={`${ID}.list`} label={t.t(m.real ? localKey('menuSales') : 'widget.local-trends.mentionsUp')} resetKey={`${t.locale}|${width}x${height}|${textScale}|${rows.length}`}
      items={rows.map((k) => (
        <li key={k.keywordId} className="mkt-row" data-slot={`${ID}.list.row`} data-mkt-extra={large && !notable.includes(k) ? '' : undefined}>
          <span className="mkt-row__text">
            <span className="mkt-row__title" lang={koreanLang(t.t(k.keywordKey))}>{t.t(k.keywordKey)}</span>
            <span className="mkt-row__sub">{m.real ? t.t(localKey('quantity')) : shape === 'S' || shape === 'L' ? t.t('widget.local-trends.category', { category: t.t(k.categoryKey) }) : t.t('widget.local-trends.mentionsUp')}</span>
            {large && !m.real ? <span className="mkt-row__sub" data-mkt-extra="">{t.t('widget.local-trends.mentions', { n: k.mentions })}{k.previous !== null ? `${t.locale === 'ko' ? '' : ' '}(${t.t('widget.local-trends.previous', { n: k.previous })})` : ''}</span> : null}
          </span>
          <span className="mkt-row__value">{m.real ? t.format.number(k.mentions) : changeText(t, k)}</span>
        </li>
      ))} />
  );
  return <PanelBody width={width} height={height} primary={primary} list={list} />;
}

function Detail({ condition, host: shellHost, detailRef }: WidgetDetailProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const view = useWidgetView(ID, condition);
  const data = useLocalData();
  const [links, setLinks] = useState<LinkState | null>(null);
  // A chat hand-off opens the keyword it names; otherwise the first keyword is open.
  const [picked, setPicked] = useState<string | null | undefined>(detailRef.itemId);
  const openRow = useRef<HTMLLIElement>(null);
  const evidencePrefix = useId();

  useLayoutEffect(() => {
    if (picked) openRow.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [picked, view.status]);

  if (view.status !== 'ready') return <DetailState id={ID} view={view} host={host} />;
  const m = view.model;
  const selected = picked === null ? undefined : m.keywords.find((k) => k.keywordId === picked) ?? m.keywords[0];
  const updated = dateTime(t, m.real ? seoulStamp(m.updatedAt) : m.updatedAt);
  const label = t.t(m.real ? localKey('menuSales') : 'widget.local-trends.notableKeywords');
  return (
    <div className="mkt-detail mkt-detail--natural" data-slot={`${ID}.card`}>
      <LocalReadNote notes={view.notes} host={host} />
      <MetaLine>{m.real ? 'POS' : t.t('widget.local-trends.region', { region: t.t(m.regionKey) })}{'\u00A0·\u00A0'}{dateRangeWithWeekdays(t, m.period.start, m.period.end)}</MetaLine>
      <MetaLine>{!m.real && m.sourceKey !== 'data.source.sample' ? <>{t.t('widget.local-trends.source', { source: t.t(m.sourceKey) })}{'\u00A0·\u00A0'}</> : null}{t.t('widget.local-trends.updated', updated)}</MetaLine>
      <p className="mkt-meta">{t.t('widget.local-trends.pick')}</p>
      {m.real && !m.keywords.length && <p className="mkt-meta" role="status">{t.t(m.real.sales.status === 'unavailable' ? 'data.real.error' : localKey('noData'))}</p>}
      <ul className="mkt-list" data-slot={`${ID}.list`} aria-label={label}>
        {m.keywords.map((k) => {
          const expanded = selected?.keywordId === k.keywordId;
          const evidenceId = `${evidencePrefix}-${k.keywordId}`;
          return (
            <li key={k.keywordId} ref={expanded ? openRow : undefined} className="mkt-trend-keyword" data-slot={`${ID}.list.row`}>
              <button type="button" className="mkt-pick" aria-expanded={expanded} aria-controls={evidenceId} onClick={() => setPicked(expanded ? null : k.keywordId)}>
                <span className="mkt-pick__top"><span className="mkt-pick__title">{t.t(k.keywordKey)}</span><span className="mkt-row__value">{m.real ? t.format.number(k.mentions) : changeText(t, k)}</span></span>
                <span className="mkt-pick__sub">{m.real ? t.t(localKey('quantity')) : t.t('widget.local-trends.mentions', { n: k.mentions })}{k.notable ? `\u00A0·\u00A0${t.t('widget.local-trends.mentionsUp')}` : ''}</span>
              </button>
              <div id={evidenceId} hidden={!expanded} aria-live="polite">
                {expanded && (
                  <div className="mkt-card">
                    <h4 className="mkt-card__title">{t.t(k.keywordKey)}</h4>
                    {m.real ? <>
                      {/* The same card as the sample keyword: a total line, one line per day (menu sales), the basis and the link to the menu. */}
                      <p className="mkt-card__line">{t.t(localKey('quantity'))}{' '}{t.format.number(k.mentions)}</p>
                      {m.real.sales.items.filter(row => row.menuId === k.keywordId).map(row => <p key={row.businessDate} className="mkt-card__line">
                        {t.format.date(row.businessDate, 'short')}{' · '}{t.format.number(row.quantity)}
                      </p>)}
                      <p className="mkt-card__meta">POS{' · '}{dateRangeWithWeekdays(t, m.period.start, m.period.end)}{' · '}{t.t('widget.local-trends.updated', updated)}</p>
                      <ActionButton variant="link" onClick={() => host.openLinked({ featureId: 'menu', itemId: k.keywordId })}>{t.t(localKey('menu'))}</ActionButton>
                    </> : <>
                    <p className="mkt-card__line">{t.t('widget.local-trends.mentions', { n: k.mentions })}{k.previous !== null ? `${t.locale === 'ko' ? '' : ' '}(${t.t('widget.local-trends.previous', { n: k.previous })})` : ''}</p>
                    <p className="mkt-card__line">{changeText(t, k)}</p>
                    <p className="mkt-card__line">{t.t('widget.local-trends.category', { category: t.t(k.categoryKey) })}</p>
                    <p className="mkt-card__line">{t.t('widget.local-trends.definition')}</p>
                    <p className="mkt-card__meta">{t.t('widget.local-trends.comparePeriodDays', { current: dateRangeWithWeekdays(t, m.period.start, m.period.end), previous: dateRangeWithWeekdays(t, m.previousPeriod.start, m.previousPeriod.end) })}</p>
                    <p className="mkt-card__meta">{m.sourceKey !== 'data.source.sample' ? <>{t.t('widget.local-trends.source', { source: t.t(m.sourceKey) })}{'\u00A0·\u00A0'}</> : null}{t.t('widget.local-trends.updated', updated)}</p>
                    </>}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {data && <SearchInterest key={data.storeId} data={data} onLinks={setLinks} />}
      {links?.links && links.storeId === data?.storeId && <SearchLinks key={links.keyword} state={links} links={links.links} />}
    </div>
  );
}

/** The latest keyword's PN10 result links. Display only: held by this widget, never written to the snapshot, history or Navis facts. */
interface LinkState { readonly storeId: string; readonly keyword: string; readonly links: SearchLinksDto | null; readonly retry: () => void }

function SearchInterest({ data, onLinks }: { readonly data: RealLocal; readonly onLinks: (state: LinkState | null) => void }) {
  const t = useT();
  const port = useRealPort();
  const store = useWidgetDataStore();
  const search = data.trends.search;
  const applied = search?.query.keywordGroups[0]?.groupName;
  const [keyword, setKeyword] = useState(applied ?? '');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function lookUp(value = keyword) {
    const input = value.trim();
    if (!port || !input || input.length > 80 || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setFailed(false);
    setPending(true);
    try {
      const result = await readLocalTrends(port.reads, data.trends.period, input, controller.signal);
      const current = store.getSnapshot().tables.realLocal;
      if (!controller.signal.aborted && current?.storeId === data.storeId) {
        // A filtered read owns the search series. Keep the sales read from any concurrent post-commit refresh.
        store.hydrate({ realLocal: { ...current, trends: { ...current.trends, search: result.search } } });
        onLinks({ storeId: data.storeId, keyword: input, links: result.links ?? null, retry: () => void lookUp(input) });
      }
    } catch {
      if (!controller.signal.aborted) { setFailed(true); onLinks(null); }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return <section className="mkt-card">
    <h3 className="mkt-section">{t.t(localKey('searchInterest'))}</h3>
    <form className="mkt-detail" onSubmit={event => { event.preventDefault(); void lookUp(); }}>
      <TextField label={t.t(localKey('keyword'))} name="keyword" value={keyword} onValueChange={setKeyword} disabled={pending} required />
      <div><ActionButton type="submit" loading={pending} disabled={!keyword.trim() || keyword.trim().length > 80}>{t.t(localKey('lookUp'))}</ActionButton></div>
    </form>
    {failed && <p role="alert">{t.t('data.real.error')}</p>}
    {search && <div aria-live="polite">
      <MetaLine>{applied} · {t.t(localKey('searchSource'), { period: periodText(t, { from: search.query.startDate, to: search.query.endDate }) })}</MetaLine>
      {search.items.length ? <ul className="mkt-list">{search.items.map(point => <li key={point.period} className="mkt-row">
        <span className="mkt-row__title">{t.format.date(point.period, 'short')}</span><span className="mkt-row__value">{t.format.number(point.ratio)}</span>
      </li>)}</ul> : <p>{t.t(search.status === 'unavailable' ? 'data.real.error' : localKey('noData'))}</p>}
    </div>}
  </section>;
}

/** `검색 결과 링크 · 네이버 검색` (PN10 · AC-1610): titles as plain text and the original link, apart from the interest index and sales. */
function SearchLinks({ state, links }: { readonly state: LinkState; readonly links: SearchLinksDto }) {
  const t = useT();
  const [channel, setChannel] = useState<'blog' | 'cafearticle'>('blog');
  const column = (series: LinkSeries) => {
    if (series.status === 'unavailable') return <div role="alert"><p className="mkt-meta">{t.t(localKey('links.failed'))}</p>
      <ActionButton variant="secondary" onClick={state.retry}>{t.t('common.retry')}</ActionButton></div>;
    const rows = series.items.slice(0, 10).flatMap(item => { const url = allowedSource(item.url); return url ? [{ ...item, url }] : []; });
    if (!rows.length) return <p role="status" className="mkt-meta">{t.t(localKey('links.empty'))}</p>;
    return <ul className="mkt-list">{rows.map((item, index) => <li key={`${index}:${item.url}`} className="mkt-row">
      <span className="mkt-row__text">{item.title}</span>
      <a className="mkt-touch-link" href={item.url} target="_blank" rel="noopener noreferrer">{t.t(localKey('original'))}<span className="ui-sr-only"> {item.title}</span></a>
    </li>)}</ul>;
  };
  const tabs = [{ value: 'blog' as const, label: t.t(localKey('links.blog')) }, { value: 'cafearticle' as const, label: t.t(localKey('links.cafearticle')) }];
  return <section className="mkt-card" data-slot={`${ID}.links`} aria-label={t.t(localKey('links.title'))}>
    <h3 className="mkt-section">{t.t(localKey('links.title'))}</h3>
    <MetaLine>{state.keyword} · {t.t(localKey('links.note'))}</MetaLine>
    <DetailTabs tabs={tabs} value={channel} onValueChange={setChannel} label={t.t(localKey('links.title'))} />
    {column(links[channel])}
  </section>;
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  if (view.status === 'ready' && view.model.real) return t.t(view.model.real.search?.items.length ? 'data.real.local.searchInterest' : 'data.real.local.menuSales');
  return view.status === 'ready' ? t.t('widget.local-trends.summary', { n: view.model.notableCount }) : t.t(view.messageKey);
}

export const localTrendsModule: WidgetModule = {
  id: ID,
  Panel,
  Detail,
  useSummary,
};
