/** W20 · D-425. Anchor-normalized NAVER trends and owner-managed candidates. */
/* eslint-disable react-refresh/only-export-components -- The widget registry consumes the module descriptor. */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetView } from '../../../data/react';
import { PortError } from '../../../data/reality/00';
import { addExampleCandidate, cleanTrendKeyword, trendCandidateLimit, trendSource, validTrendKeyword, type TrendCandidate,
  type TrendRanking, type TrendRankRow } from '../../../data/reality/13/trend-ranking';
import { editExampleTrendCandidates, useTrendData, writeTrendCandidate } from '../../../data/reality/13/trend-hooks';
import { ActionButton, Badge, MiniChart, PanelBody, TextField, useUi } from '../../../ui';
import { chartPointY, getChartDomain } from '../../../ui/chart-domain';
import { isLargeCard, koreanLang } from './fit';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, rowCapacity, useT, type Translator } from './shared';
import { localKey, seoulStamp, useReadHost } from './local-changes.http';
import { LocalReadNote } from './local-changes';
import './local-trends.css';

const ID = 'local-trends';
const key = (name: string) => localKey(`trends.${name}`);

function percent(t: Translator, value: number) {
  return `${value >= 0.05 ? '+' : ''}${new Intl.NumberFormat(t.locale, {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  }).format(Math.abs(value) < 0.05 ? 0 : value)}%`;
}

const isRising = (row: TrendRankRow) => row.classification === 'new' || row.classification === 'annual' || row.classification === 'rising';
const recentChange = (t: Translator, row: TrendRankRow) => `${t.t(key('fourWeeks'))} ${percent(t, row.changePercent)}`;
const naverSearch = (keyword: string) => `https://search.naver.com/search.naver?${new URLSearchParams({ query: keyword })}`;

function rankingMessage(status?: TrendRanking['status']) {
  if (!status) return 'data.real.loading';
  if (status === 'disabled') return key('disabled');
  if (status === 'unavailable') return 'data.real.error';
  return localKey('noData');
}

function menuLabel(t: Translator, row: TrendRankRow) {
  if (row.menuName) return t.t(key('menuMatch'), { menu: row.menuName });
  return row.isMenu === false ? t.t(key('notMenu')) : undefined;
}

function TrendChart({ row }: { readonly row: TrendRankRow }) {
  const t = useT();
  const values = row.points.map(point => point.ratio);
  const latest = values.at(-1);
  return <div className="mkt-trend-chart__plot">
      <MiniChart kind="line" compact data={{ axisLabels: row.points.map(point => t.format.date(point.period, 'short')),
        series: [{ name: row.keyword, unit: '', values }] }} />
      {latest !== undefined && <span className="mkt-trend-chart__marker-track" aria-hidden="true" data-slot={`${ID}.chart.latest`}>
        <span className="mkt-trend-chart__marker" style={{ top: `${chartPointY(latest, getChartDomain(values))}%` }} />
      </span>}
  </div>;
}

function Panel({ condition, width, height, shape, host: shellHost }: WidgetPanelProps) {
  const t = useT();
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  const { ranking, candidates, retry } = useTrendData(view.status === 'ready');
  const host = useReadHost(shellHost);
  if (view.status !== 'ready') return <PanelStateView id={ID} view={view} shape={shape} width={width} host={host} />;
  if (ranking?.status !== 'ready' && ranking?.status !== 'empty') return <PanelStateView id={ID} shape={shape} width={width}
    view={{ status: ranking?.status === 'unavailable' ? 'error' : 'empty', variant: 'real-empty', messageKey: rankingMessage(ranking?.status) }}
    host={{ ...host, resetPreview: retry }} />;
  const first = ranking.items.find(isRising) ?? ranking.items[0];
  if (!first) return <PanelBody width={width} height={height} primary={<div className="mkt-primary" role="status">
    <p className="mkt-label">{t.t(key('noRising'))}</p>
    <MetaLine>{t.t(key('candidateCount'), { count: candidates.length })}</MetaLine>
  </div>} />;
  const large = isLargeCard(shape, height);
  const rowBudget = rowCapacity(shape, height, textScale);
  const visible = ranking.items.filter(row => row.id !== first.id).slice(0, large ? 10 : rowBudget);
  const label = `${first.keyword} · ${t.t(key('fourWeeks'))}`;
  const primary = <div className="mkt-trend-hero"><PrimaryMetric id={ID} shape={shape} label={label}
    value={percent(t, first.changePercent)} unit="" note={trendSource}
    secondary={first.sameWeekChangePercent == null ? null : `${t.t(key('lastYear'))} ${percent(t, first.sameWeekChangePercent)}`} /></div>;
  const list = visible.length === 0 ? null : <FitList slot={`${ID}.list`} label={t.t(key('ranking'))}
    resetKey={`${t.locale}|${width}x${height}|${textScale}|${visible.length}`} items={visible.map((row, index) => {
      const menu = menuLabel(t, row);
      return <li key={row.id} className="mkt-row mkt-trend-panel-row" data-slot={`${ID}.list.row`} data-mkt-extra={large && index >= rowBudget ? '' : undefined}>
        <span className="mkt-row__text"><span className="mkt-row__title" lang={koreanLang(row.keyword)}>{row.rank}. {row.keyword}</span>
          {menu && <span className="mkt-row__sub">{menu}</span>}</span>
        <span className="mkt-row__value">{recentChange(t, row)}</span>
      </li>;
    })} />;
  return <PanelBody width={width} height={height} primary={primary} list={list} />;
}

function Detail({ condition, host: shellHost, detailRef }: WidgetDetailProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const view = useWidgetView(ID, condition);
  const state = useTrendData(view.status === 'ready');
  const { ranking } = state;
  const [picked, setPicked] = useState(detailRef.itemId);
  const firstRow = useRef<HTMLLIElement>(null);
  const chartId = useId();
  const open = ranking?.items.find(row => row.id === picked || row.keyword === picked);
  const openId = open?.id;
  useLayoutEffect(() => { if (openId) firstRow.current?.scrollIntoView?.({ block: 'nearest' }); }, [openId]);

  if (view.status !== 'ready') return <DetailState id={ID} view={view} host={host} />;
  const owner = state.store.getSnapshot().tables.realLocal?.storeId ?? null;
  const seedKeyword = view.model.keywords.find(item => item.keywordId === detailRef.itemId);
  const searchKeyword = seedKeyword ? t.t(seedKeyword.keywordKey) : undefined;
  const fetched = ranking?.fetchedAt ? t.t(key('latestDate'), { date: seoulStamp(ranking.fetchedAt).slice(0, 10) }) : null;
  const source = fetched ? `${trendSource} · ${fetched}` : trendSource;

  return <div className="mkt-detail mkt-detail--natural" data-slot={`${ID}.card`}>
    <LocalReadNote notes={view.notes} host={host} />
    {!open && <MetaLine>{source}</MetaLine>}
    {ranking?.status === 'ready' ? <ul className="mkt-list" data-slot={`${ID}.list`} aria-label={t.t(key('ranking'))}>
      {ranking.items.map(row => {
        const expanded = open?.id === row.id;
        const id = `${chartId}-${row.rank}`;
        const menu = menuLabel(t, row);
        return <li key={row.id} ref={expanded ? firstRow : undefined} className="mkt-trend-keyword" data-slot={`${ID}.list.row`}>
          <button type="button" className="mkt-pick" aria-expanded={expanded} aria-controls={id} onClick={() => setPicked(expanded ? undefined : row.id)}>
            <span className="mkt-pick__top"><span className="mkt-pick__title" lang={koreanLang(row.keyword)}>{row.rank}. {row.keyword}</span>
              <span className="mkt-row__value">{recentChange(t, row)}</span></span>
            <span className="mkt-trend-keyword__details">
              <span className="mkt-pick__badges">{row.classification && <Badge>{t.t(key(row.classification))}</Badge>}
                {menu && <span className="mkt-pick__sub">{menu}</span>}</span>
              {row.sameWeekChangePercent != null && !expanded && <span className="mkt-pick__sub">{t.t(key('lastYear'))} {percent(t, row.sameWeekChangePercent)}</span>}
            </span>
          </button>
          <div id={id} hidden={!expanded}>{expanded && <section className="mkt-card mkt-trend-chart" data-slot={`${ID}.chart`}>
            <TrendChart row={row} />
            <dl className="mkt-trend-comparison">
              <div><dt>{t.t(key('fourWeeks'))}</dt><dd>{percent(t, row.changePercent)}</dd></div>
              <div><dt>{t.t(key('lastYear'))}</dt><dd>{row.sameWeekChangePercent == null ? '—' : percent(t, row.sameWeekChangePercent)}</dd></div>
            </dl>
            <MetaLine>{source}</MetaLine>
            <a className="mkt-touch-link" href={naverSearch(row.keyword)} target="_blank" rel="noopener noreferrer">{t.t(key('searchLink'))}</a>
            {row.isMenu && <div className="mkt-toolbar">
              {isRising(row) && <ActionButton variant="secondary" onClick={() => shellHost.openLinked({ featureId: 'slot-coupon', view: 'send', focus: 'action' })}>{t.t(key('coupon'))}</ActionButton>}
              <ActionButton variant="secondary" onClick={() => shellHost.openLinked({ featureId: 'promo-video', view: 'create', focus: 'action' })}>{t.t(key('promo'))}</ActionButton>
            </div>}
          </section>}</div>
        </li>;
      })}
    </ul> : <div role={ranking?.status === 'unavailable' ? 'alert' : 'status'}>
      <MetaLine>{t.t(rankingMessage(ranking?.status))}</MetaLine>
      {ranking?.status === 'unavailable' && <ActionButton variant="secondary" onClick={state.retry}>{t.t('common.retry')}</ActionButton>}
    </div>}
    <CandidateEditor key={`candidates:${owner ?? 'example'}`} state={state} initialKeyword={searchKeyword} />
    {ranking?.events != null && <MetaLine>{t.t(key('localEvents'), { count: ranking.events })}</MetaLine>}
  </div>;
}

type TrendState = ReturnType<typeof useTrendData>;

function CandidateEditor({ state, initialKeyword }: { readonly state: TrendState; readonly initialKeyword?: string }) {
  const t = useT();
  const [open, setOpen] = useState(Boolean(initialKeyword));
  const [keyword, setKeyword] = useState(initialKeyword ?? '');
  const [remove, setRemove] = useState<TrendCandidate>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const busy = useRef(false);
  const { candidates, http, port, sourceRevision, store } = state;
  const available = !http || sourceRevision !== undefined;
  const full = candidates.length >= trendCandidateLimit;

  async function apply(target?: TrendCandidate, suggestion?: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      if (http) {
        if (!port || sourceRevision === undefined) return;
        await writeTrendCandidate(port.transport, target ? { id: target.id, expectedRevision: sourceRevision } : { keyword: cleanTrendKeyword(suggestion ?? keyword) });
        await port.retry('local');
      } else {
        const current = store.getSnapshot().tables.exampleLocalTrends?.candidates ?? candidates;
        editExampleTrendCandidates(store, target ? current.filter(item => item.id !== target.id) : [...current, addExampleCandidate(current, suggestion ?? keyword)]);
      }
      if (!target && !suggestion) setKeyword('');
      setRemove(undefined);
    } catch (error) {
      const reason = error instanceof PortError ? error.reason : error instanceof Error ? error.message : undefined;
      setFailure(reason === 'TREND_CANDIDATE_EXISTS' ? key('exists') : reason === 'TREND_CANDIDATE_LIMIT' ? key('limit') : 'data.real.error');
      if (http) void port?.retry('local');
      setRemove(undefined);
    } finally { busy.current = false; setPending(false); }
  }

  const recommendations = state.ranking?.recommendations;
  return <>
  {recommendations && recommendations.items.length > 0 && <section className="mkt-card mkt-trend-recommendations" data-slot={`${ID}.recommendations`}>
    <div className="mkt-toolbar"><h3 className="mkt-section">{t.t(key('recommended'))}</h3><Badge>{t.t(key('dictionary'), { version: recommendations.version })}</Badge></div>
    <ul className="mkt-list">{recommendations.items.map(item => <li key={item.id} className="mkt-row">
      <span className="mkt-row__text">{item.keyword}</span>
      <ActionButton variant="secondary" disabled={!available || pending || full} onClick={() => void apply(undefined, item.keyword)}>{t.t(key('addSuggested'))}</ActionButton>
    </li>)}</ul>
  </section>}
  {failure && <p role="alert">{t.t(failure, { max: trendCandidateLimit })}</p>}
  <details className="mkt-card mkt-trend-candidates" open={open}>
    <summary onClick={event => { event.preventDefault(); setOpen(value => !value); }}>{t.t(key('manage'))}</summary>
    {open && <div className="mkt-detail">
      <TextField label={t.t(key('candidate'))} name="candidate" value={keyword} onValueChange={setKeyword} disabled={!available || pending} />
      <div><ActionButton onClick={() => void apply()} loading={pending && !remove} disabled={!available || full || !validTrendKeyword(keyword) || pending}>
        {t.t(key('add'))}
      </ActionButton></div>
      {full && <MetaLine>{t.t(key('limit'), { max: trendCandidateLimit })}</MetaLine>}
      <ul className="mkt-list">{candidates.map(item => <li key={item.id} className="mkt-row">
        <span className="mkt-row__text">{item.keyword} {item.suggested && <Badge>{t.t(key('suggested'))}</Badge>}</span>
        {remove?.id === item.id ? <div className="mkt-toolbar">
          <span>{t.t(key('removePrompt'), { keyword: item.keyword })}</span>
          <ActionButton variant="secondary" disabled={pending} onClick={() => setRemove(undefined)}>{t.t('common.cancel')}</ActionButton>
          <ActionButton variant="destructive" loading={pending} onClick={() => void apply(item)}>{t.t(key('confirm'))}</ActionButton>
        </div> : <ActionButton variant="ghost" disabled={pending} onClick={() => setRemove(item)}>{t.t(key('remove'), { keyword: item.keyword })}</ActionButton>}
      </li>)}</ul>
    </div>}
  </details></>;
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  const { ranking } = useTrendData(view.status === 'ready');
  if (view.status !== 'ready') return t.t(view.messageKey);
  const top = ranking?.items.find(isRising) ?? ranking?.items[0];
  if (top) return `${top.keyword} ${recentChange(t, top)}`;
  return ranking?.status === 'ready' || ranking?.status === 'empty' ? t.t(key('noRising')) : t.t(rankingMessage(ranking?.status));
}

export const localTrendsModule: WidgetModule = { id: ID, Panel, Detail, useSummary };
