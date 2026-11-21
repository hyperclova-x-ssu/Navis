/**
 * 마케팅 성과 (marketing-performance, T-060): four metrics and the best channel. The numbers come from the one coupon source
 * (src/data/marketing), so a coupon sent in another widget changes them in the same frame (F-55, AC-313/314). Coupon use is
 * recorded by POS at final settlement (API-246); widgets read that shared projection without keeping local counts.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FitProbe, PERFORMANCE_FIT, PERFORMANCE_STRIP_FIT } from './fit';
import type { DetailRef, FeatureId, QueryCondition, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import type { MarketingPerformanceModel, PerfRouteRow } from '../../../data/widget-data';
import { useWidgetView } from '../../../data/react';
import { MONTH_START } from '../../../data/widget-data';
import {
  ActionButton, DetailSidePanel, DetailTabs, FormulaRow, Icon, InlineEmpty, InsightCard, MetricFit, PanelAction, PanelState, RateBar, StatusBadge, Table, ChipChoice, UsageBar, formatPosMoney, type TabItem,
} from '../../../ui';
import { DeltaText, Flash, NoteLine, compactMoney, moneyDelta, ppDelta, text, useFit, useT } from './shared';
import './widget.css';

const FEATURE_ID = 'marketing-performance' as const;
const THIS_MONTH: QueryCondition = Object.freeze({ kind: 'default' });
/**
 * The previous calendar month of the business date: it ends the day before this month starts (`MONTH_START`) and starts on that month's
 * first day, so the button follows the demo date instead of a literal month (SEED-W1: the data condition resolves October for 11/17).
 */
export function previousMonthRange(monthStart: string): { readonly start: string; readonly end: string } {
  const [year, month] = monthStart.split('-').map(Number);
  const end = new Date(Date.UTC(year, month - 1, 0));
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return { start: iso(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))), end: iso(end) };
}
const LAST_MONTH: QueryCondition = Object.freeze({ kind: 'dateRange', ...previousMonthRange(MONTH_START) });
const ROUTE_REF: DetailRef = { featureId: FEATURE_ID, view: 'route', focus: 'action' };
/** The next step when nothing was used yet: send a coupon (the empty state's action in the panel and in the window). */
const SEND_COUPON_REF: DetailRef = { featureId: 'slot-coupon', view: 'send', focus: 'action' };

type T = ReturnType<typeof useT>;
type Block = { readonly label: string; readonly value: string; readonly delta: { readonly direction: 'up' | 'down'; readonly text: string } | null; readonly sub: string | null; readonly note: string | null } & (
  | { readonly id: 'rate' | 'revenue' | 'profit'; readonly raw: number }
  | { readonly id: 'return'; readonly raw: number | null }
);

const percent = (t: T, value: number | null): string => (value === null ? '—' : t.format.percent(value, 0));

/** The four metric blocks in the order of LOCALES 9.3 (rate, sales, profit, returning customers). */
export function metricBlocks(t: T, model: MarketingPerformanceModel): readonly Block[] {
  return [
    { id: 'rate', label: t.t('widget.marketing-performance.m.rate'), value: percent(t, model.rate), raw: model.rate ?? -1, delta: ppDelta(t, model.rateDelta), sub: t.t('widget.marketing-performance.usedIssued', { used: t.format.number(model.used), issued: t.format.number(model.issued) }), note: null },
    { id: 'revenue', label: t.t('widget.marketing-performance.m.revenue'), value: compactMoney(t, model.revenue.total), raw: model.revenue.total, delta: moneyDelta(t, model.revenueDelta), sub: null, note: null },
    { id: 'profit', label: t.t('widget.marketing-performance.m.profit'), value: compactMoney(t, model.profit), raw: model.profit, delta: null, sub: null, note: t.t('widget.marketing-performance.profitNote') },
    { id: 'return', label: t.t('widget.marketing-performance.m.return'), value: model.returnRate === null ? t.t('widget.marketing-performance.returnUnknown') : percent(t, model.returnRate), raw: model.returnRate, delta: ppDelta(t, model.returnRateDelta), sub: null, note: null },
  ];
}

function MetricRows({ blocks, label }: { readonly blocks: readonly Block[]; readonly label: string }) {
  return (
    <ul className="mp-metric-rows" aria-label={label}>
      {blocks.map((block) => <li key={block.id} data-slot={`marketing-performance.metric.${block.id}`}><span>{block.label}</span><Flash watch={block.raw ?? block.value}><strong>{block.value}</strong>{block.delta ? <> <DeltaText direction={block.delta.direction}>{block.delta.text}</DeltaText></> : null}</Flash></li>)}
    </ul>
  );
}

function bestOf(t: T, model: MarketingPerformanceModel): { readonly route: string; readonly rate: string } | null {
  const best = model.best;
  if (!best) return null;
  return { route: t.t(best.nameKey), rate: percent(t, best.rate) };
}

function MetricBlock({ block, minStage, lines, verbose = false, splitMoneyUnit = false }: { readonly block: Block; readonly minStage: 0 | 1; readonly lines: { readonly sub: boolean; readonly note: boolean }; readonly verbose?: boolean; readonly splitMoneyUnit?: boolean }) {
  const t = useT();
  const moneyParts = splitMoneyUnit && (block.id === 'revenue' || block.id === 'profit') ? block.value.match(/^(-?[\d,.]+)(만 원)$/u) : null;
  const delta = block.delta;
  let verboseDelta: string | null = null;
  if (verbose && delta) {
    if (block.id === 'revenue') {
      verboseDelta = t.t(`widget.marketing-performance.revenueChange.${delta.direction}`, { amount: delta.text });
    } else if (t.locale === 'ko' && delta.text.endsWith('%p')) {
      verboseDelta = `지난달보다 ${delta.text.replace('%p', '%포인트')} ${delta.direction === 'up' ? '올랐어요' : '내렸어요'}`;
    }
  }
  return (
    <Flash watch={block.raw ?? block.value} className="mp-block">
      <div data-slot={`marketing-performance.metric.${block.id}`} className="mp-block__inner">
        <span className="mp-block__value" data-slot="marketing-performance.metric.value"><MetricFit value={moneyParts?.[1] ?? block.value} unit={moneyParts?.[2]} stacked={false} minStage={minStage} /></span>
        <span className="mp-block__label" data-slot="marketing-performance.metric.label">{block.label}</span>
        {delta ? <span className="mp-block__delta" data-slot="marketing-performance.metric.delta">{verboseDelta ?? <DeltaText direction={delta.direction}>{delta.text}</DeltaText>}</span> : null}
        {lines.note && block.note ? <span className="mp-block__note">{block.note}</span> : null}
        {lines.sub && block.sub ? <span className="mp-block__sub" data-slot="marketing-performance.metric.sub">{block.sub}</span> : null}
      </div>
    </Flash>
  );
}

function RouteRows({ t, routes }: { readonly t: T; readonly routes: readonly PerfRouteRow[] }) {
  return (
    <ul className="mp-routes" data-slot="marketing-performance.routes" aria-label={t.t('widget.marketing-performance.routeTable')}>
      {routes.map((route) => (
        <li key={route.route} data-row-id={route.route}>
          <span className="mp-routes__name">{t.t(route.nameKey)}</span>
          <Flash watch={route.issued * 1000 + route.used}><span className="mp-routes__num">{t.format.number(route.issued)}{'\u00A0·\u00A0'}{t.format.number(route.used)}{'\u00A0·\u00A0'}{percent(t, route.rate)}</span></Flash>
        </li>
      ))}
    </ul>
  );
}

export function MarketingPerformancePanel({ featureId, condition, width, height, shape, host }: WidgetPanelProps) {
  const t = useT();
  const view = useWidgetView(FEATURE_ID, condition);
  const fit = useFit();
  const name = t.t('widget.marketing-performance.title');
  if (view.status === 'error') {
    return <div className="mp-root" data-widget={featureId} data-shape={shape} data-state="error"><PanelState tone="error" shape={shape} message={t.locale === 'ko' && (shape === 'Q' || (shape === 'W' && width <= 2)) ? t.t('widget.marketing-performance.state.error.short') : t.t(view.messageKey)} shortMessage={t.t('widget.marketing-performance.state.error.short')} action={{ label: t.t('common.retry'), widgetName: name, onPress: () => host.resetPreview() }} /></div>;
  }
  if (view.status === 'empty') {
    return <div className="mp-root" data-widget={featureId} data-shape={shape} data-state="empty" data-slot="marketing-performance.empty"><PanelState tone="info" shape={shape} message={t.t(view.messageKey)} action={{ label: t.t('marketing.sendCoupon'), widgetName: name, onPress: () => host.openDetail(SEND_COUPON_REF) }} /></div>;
  }
  const { model } = view;
  const blocks = metricBlocks(t, model);
  const best = bestOf(t, model);
  const open = () => host.openDetail(ROUTE_REF);
  const shortAction = <PanelAction label={t.t('common.viewDetails')} widgetName={name} onPress={open} />;
  const longAction = <PanelAction label={t.t('marketing.detailsByChannel')} widgetName={name} onPress={open} />;
  const notes = view.notes ?? [];
  const noteMode = shape === 'Q' ? 'sr' : shape === 'W' ? 'badge' : height >= 2 && shape !== 'T' ? 'full' : 'badge';
  const noteLine = <NoteLine notes={notes} slot="marketing-performance.note" mode={noteMode} />;
  const period = t.format.dateRange(model.period.start, model.period.end);
  const base = { 'data-widget': featureId, 'data-shape': shape, 'data-state': 'ready', 'data-w': width, 'data-h': height } as const;

  if (shape === 'Q') {
    const [rate] = blocks;
    return (
      <div className="mp-root mp-q" {...base}><FitProbe order={PERFORMANCE_FIT} />
        <Flash watch={rate.raw ?? rate.value} className="mp-block">
          <span className="mp-key" data-slot="marketing-performance.metric.value"><MetricFit value={rate.value} stacked={false} minStage={fit.large ? 1 : 0} /></span>
          <p className="mp-block__label">{rate.label}</p>
          {rate.delta ? <p className="mp-desc ui-sr-only" data-slot="marketing-performance.metric.desc"><DeltaText direction={rate.delta.direction}>{rate.delta.text}</DeltaText></p> : null}
        </Flash>
        <div className="ui-sr-only">{noteLine}</div>{shortAction}
      </div>
    );
  }
  if (shape === 'W' && width === 4) {
    return (
      <div className="mp-root mp-strip" {...base}><FitProbe order={PERFORMANCE_STRIP_FIT} />
        <div className="mp-strip__blocks"><span className="mp-strip__deltas" hidden />{blocks.map((block) => <MetricBlock key={block.id} block={block} minStage={1} lines={{ sub: false, note: !fit.large }} splitMoneyUnit />)}</div>
        <div className="mp-strip__best" data-slot="marketing-performance.best">
          <div className="mp-strip__top ui-sr-only"><span className="mp-block__label">{period}</span>{noteLine}</div>
          {best ? <><span className="mp-best__value">{t.t('widget.marketing-performance.bestValue', { route: best.route, n: best.rate.replace('%', '') })}</span><span className="mp-best__label">{t.t('widget.marketing-performance.bestLabel')}</span></> : null}
          {longAction}
        </div>
      </div>
    );
  }
  if (shape === 'W') {
    const count = fit.large ? width - 1 : width === 2 ? 2 : 3;
    return (
      <div className="mp-root mp-wblocks" {...base} data-count={count} data-large={fit.large ? 'true' : undefined}>
        <div className="mp-wblocks__blocks">{blocks.slice(0, count).map((block) => <MetricBlock key={block.id} block={block} minStage={1} lines={{ sub: false, note: false }} />)}</div>
        {noteLine}{shortAction}<FitProbe order={PERFORMANCE_FIT} />
      </div>
    );
  }
  if (shape === 'T') {
    const [rate] = blocks;
    return (
      <div className="mp-root mp-trows" {...base}><FitProbe order={PERFORMANCE_FIT} />
        <Flash watch={rate.raw ?? rate.value} className="mp-block">
          <span className="mp-key" data-slot="marketing-performance.metric.value"><MetricFit value={rate.value} stacked={false} minStage={fit.large ? 1 : 0} /></span>
          <p className="mp-desc" data-slot="marketing-performance.metric.desc">{rate.label}{rate.delta ? <> <DeltaText direction={rate.delta.direction}>{rate.delta.text}</DeltaText></> : null}</p>
        </Flash>
        {shortAction}
        {noteLine}
        <MetricRows blocks={blocks.slice(1)} label={name} />
      </div>
    );
  }
  const withRoutes = width === 4 && height >= 2;
  return (
    <div className="mp-root mp-grid" {...base} data-cols={width === 4 ? 4 : 2}><FitProbe order={PERFORMANCE_FIT} />
      <div className="mp-grid__blocks">{blocks.map((block) => <MetricBlock key={block.id} block={block} minStage={width === 4 ? 1 : 0} lines={{ sub: shape !== 'S', note: true }} />)}</div>
      {withRoutes ? <RouteRows t={t} routes={model.routes} /> : null}
      {best && height >= 2 ? <p className="mp-best-line" data-slot="marketing-performance.best">{t.t('widget.marketing-performance.best', { route: best.route, n: best.rate.replace('%', '') })}</p> : null}
      {noteLine}{width >= 3 ? longAction : shortAction}
    </div>
  );
}

export function useMarketingPerformanceSummary({ condition }: { readonly featureId: FeatureId; readonly condition: QueryCondition }): string {
  const t = useT();
  const view = useWidgetView(FEATURE_ID, condition);
  if (view.status !== 'ready') return t.t(view.messageKey);
  return metricBlocks(t, view.model).map(block => `${block.label} ${block.value}${block.delta ? ` ${block.delta.direction === 'up' ? '▲' : '▼'}${block.delta.text}` : ''}`).join(t.locale === 'ko' ? '\u00a0·\u00a0' : ' · ');
}

/* ───────────── detail ───────────── */

type DetailTab = 'route' | 'coupon' | 'video';

/**
 * The lines are the route's own per-code records (`PerfRouteRow.lines`): the same period source the route row and the metric add up,
 * ended coupons included, so the lines sum to the row (GD-3). It no longer reads the running-coupon rows, which skip ended coupons.
 */
function CouponLines({ t, route, lastMonth }: { readonly t: T; readonly route: PerfRouteRow; readonly lastMonth: boolean }) {
  const lines = route.lines.map((line) => {
    const name = text(t, line.name);
    return { id: line.codeId, label: line.status === 'active' ? name : t.t(`widget.marketing-performance.routeLines.${line.status}`, { name }), line };
  });
  return (
    <div className="mp-routelines" data-slot="marketing-performance.route-lines" aria-live="polite">
      {lines.length === 0 ? <p className="mp-hint">{t.t(lastMonth ? 'widget.marketing-performance.routeLines.lastMonth' : 'widget.marketing-performance.routeLines.none')}</p> : (
        <>
          <ul>{lines.map(({ id, label, line }) => (
            <li key={id} data-code-id={id}>
              <span className="mp-routelines__name">{label}</span>
              <span className="mp-routelines__use"><UsageBar used={line.used} total={line.issued} /><span className="mp-routelines__count">{t.t('widget.marketing-performance.routeLines.usage', { used: t.format.number(line.used), total: t.format.number(line.issued) })}</span></span>
            </li>
          ))}</ul>
          <p className="mp-hint" data-slot="marketing-performance.route-lines.sum">{t.t('widget.marketing-performance.routeLines.sum', { issued: t.format.number(route.issued), used: t.format.number(route.used) })}</p>
        </>
      )}
    </div>
  );
}

export function MarketingPerformanceDetail({ detailRef, host }: WidgetDetailProps) {
  const t = useT();
  // N18 handoff: a Navis entry names the tab (`view`) and the period (`condition`) the owner asked for; the owner can still change both.
  const [period, setPeriod] = useState<'this' | 'last'>(detailRef.condition?.kind === 'dateRange' && detailRef.condition.start === (LAST_MONTH as { start: string }).start ? 'last' : 'this');
  const [tab, setTab] = useState<DetailTab>(detailRef.view === 'coupon' || detailRef.view === 'video' ? detailRef.view : 'route');
  const [selected, setSelected] = useState<PerfRouteRow['route'] | null>(null);
  const view = useWidgetView(FEATURE_ID, period === 'this' ? THIS_MONTH : LAST_MONTH);
  const focusRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (detailRef.focus === 'action') focusRef.current?.focus(); }, [detailRef.focus]);
  /** DS 12.2: closing the side panel returns focus to the route row that opened it. */
  const restoreRow = useCallback((routeId: string) => { tableRef.current?.querySelector<HTMLElement>(`[data-row-id="${routeId}"] .mp-rowbtn`)?.focus(); }, []);
  const chips = (
    <ChipChoice label={t.t('widget.marketing-performance.period')} value={period} onChange={setPeriod} options={[{ value: 'this', label: t.t('widget.marketing-performance.period.this') }, { value: 'last', label: t.t('widget.marketing-performance.period.last') }]} />
  );
  if (view.status === 'error') return <div className="mp-detail" data-widget={FEATURE_ID} data-state="error">{chips}<PanelState tone="error" message={t.t(view.messageKey)} action={{ label: t.t('common.retry'), widgetName: t.t('widget.marketing-performance.title'), onPress: () => host.resetPreview() }} /></div>;
  if (view.status === 'empty') {
    return (
      <div className="mp-detail" data-widget={FEATURE_ID} data-state="empty">{chips}
        <InlineEmpty title={t.t(view.messageKey)} description={t.t('widget.marketing-performance.empty.next')} action={<ActionButton onClick={() => host.openLinked(SEND_COUPON_REF)}>{t.t('marketing.sendCoupon')}</ActionButton>} />
      </div>
    );
  }
  const { model } = view;
  // DS 6.1: the window writes money in exact won, so the sales change is written the same way (no mix of 624,000원 and 8.1만 원 on one line).
  const blocks = metricBlocks(t, model).map((block) => {
    if (block.id !== 'revenue' && block.id !== 'profit') return block;
    const exact = { ...block, value: formatPosMoney(block.raw) };
    return block.id === 'revenue' && block.delta && model.revenueDelta ? { ...exact, delta: { direction: block.delta.direction, text: formatPosMoney(Math.abs(model.revenueDelta.value)) } } : exact;
  });
  const tabs: TabItem<DetailTab>[] = [{ value: 'route', label: t.t('widget.marketing-performance.tab.route') }, { value: 'coupon', label: t.t('widget.marketing-performance.tab.coupon') }, { value: 'video', label: t.t('widget.marketing-performance.tab.video') }];
  const selectedRoute = model.routes.find((route) => route.route === selected) ?? null;
  const total = <tr className="mp-total" data-row-id="total"><th scope="row">{t.t('widget.marketing-performance.total')}</th><td data-numeric="true"><Flash watch={model.issued}>{t.format.number(model.issued)}</Flash></td><td data-numeric="true">{t.format.number(model.used)}</td><td data-numeric="true"><Flash watch={model.rate ?? -1}>{percent(t, model.rate)}</Flash></td></tr>;
  const head = (first: string) => <thead><tr><th scope="col">{first}</th><th scope="col" data-numeric="true">{t.t('widget.marketing-performance.th.issued')}</th><th scope="col" data-numeric="true">{t.t('widget.marketing-performance.th.used')}</th><th scope="col" data-numeric="true">{t.t('widget.marketing-performance.th.rate')}</th></tr></thead>;
  /** Column widths follow the content (A11): the name takes what is left, numbers and the rate bar keep a fixed width and sit on the right. */
  const cols = <colgroup><col /><col className="mp-col--num" /><col className="mp-col--num" /><col className="mp-col--rate" /></colgroup>;
  const rateCell = (rate: number | null, label: string): ReactNode => (rate === null ? '—' : <RateBar value={rate} label={label} text={percent(t, rate)} />);
  const toggleRoute = (route: PerfRouteRow['route']) => setSelected((current) => (current === route ? null : route));
  const routeTable = (
    <div className="mp-tablewrap" data-panel={selectedRoute ? 'open' : undefined}>
      <div className="mp-tablewrap__main" ref={tableRef}>
        <Table aria-label={t.t('widget.marketing-performance.routeTable')} data-slot="marketing-performance.table">
          {cols}
          {head(t.t('widget.marketing-performance.th.route'))}
          <tbody>
            {model.routes.map((route) => {
              const isSelected = selected === route.route;
              return (
                <tr key={route.route} data-row-id={route.route} aria-selected={isSelected} data-selected={isSelected ? 'true' : undefined} className="mp-row--link" onClick={() => toggleRoute(route.route)}>
                  <th scope="row"><button type="button" className="mp-rowbtn" aria-expanded={isSelected}><span>{t.t(route.nameKey)}</span><Icon name="chevron-right" aria-hidden /></button></th>
                  <td data-numeric="true"><Flash watch={route.issued}>{t.format.number(route.issued)}</Flash></td><td data-numeric="true">{t.format.number(route.used)}</td><td data-numeric="true">{rateCell(route.rate, t.t(route.nameKey))}</td>
                </tr>
              );
            })}
            {model.missingRoutes.map((route) => (
              <tr key={route} data-row-id={route} data-missing="true"><th scope="row">{t.t(`data.marketing.route.${route === 'place_news' ? 'placeNews' : route}`)}</th><td colSpan={3}><StatusBadge kind="needsReview" label={t.t('widget.marketing-performance.missing')} /></td></tr>
            ))}
            {total}
          </tbody>
        </Table>
      </div>
      <DetailSidePanel
        open={!!selectedRoute}
        selectedRowId={selectedRoute?.route ?? null}
        title={selectedRoute ? t.t('widget.marketing-performance.routeLines', { route: t.t(selectedRoute.nameKey) }) : ''}
        onClose={() => setSelected(null)}
        returnFocusKey={selectedRoute?.route ?? ''}
        onRestoreFocus={restoreRow}
      >
        {selectedRoute ? <CouponLines t={t} route={selectedRoute} lastMonth={period === 'last'} /> : null}
      </DetailSidePanel>
    </div>
  );
  const couponTable = (
    <div className="mp-tablewrap"><div className="mp-tablewrap__main">
      <Table aria-label={t.t('widget.marketing-performance.tab.coupon')} data-slot="marketing-performance.coupon-table">
        {cols}
        {head(t.t('widget.marketing-performance.th.coupon'))}
        <tbody>
          {model.byCoupon.map((row) => (
            <tr key={row.couponId} data-row-id={row.couponId} data-selected={detailRef.itemId === row.couponId ? 'true' : undefined} aria-selected={detailRef.itemId === row.couponId ? true : undefined}>
              <th scope="row">{text(t, row.name)}</th><td data-numeric="true"><Flash watch={row.issued}>{t.format.number(row.issued)}</Flash></td><td data-numeric="true">{t.format.number(row.used)}</td><td data-numeric="true">{rateCell(row.rate, text(t, row.name))}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div></div>
  );
  const clipRoute = model.routes.find((route) => route.route === 'clip');
  const videoTable = (
    <div className="mp-tablewrap"><div className="mp-tablewrap__main">
      <Table aria-label={t.t('widget.marketing-performance.tab.video')} data-slot="marketing-performance.video-table">
        {cols}
        {head(t.t('widget.marketing-performance.th.video'))}
        <tbody>
          {clipRoute ? <tr key="clip-line" data-row-id="clip"><th scope="row">{t.t(clipRoute.nameKey)}</th><td data-numeric="true">{t.format.number(clipRoute.issued)}</td><td data-numeric="true">{t.format.number(clipRoute.used)}</td><td data-numeric="true">{rateCell(clipRoute.rate, t.t(clipRoute.nameKey))}</td></tr> : null}
          {model.byVideo.map((row) => (
            <tr key={row.videoId} data-row-id={row.videoId}><th scope="row">{t.t('widget.marketing-performance.video.row', { route: t.t(`data.marketing.postTo.${row.postedRoute ?? 'clip'}`) })}</th><td data-numeric="true"><Flash watch={row.issued}>{t.format.number(row.issued)}</Flash></td><td data-numeric="true">{t.format.number(row.used)}</td><td data-numeric="true">{rateCell(row.rate, row.videoId)}</td></tr>
          ))}
        </tbody>
      </Table>
      {model.byVideo.length === 0 && !clipRoute ? <p className="mp-hint">{t.t('widget.marketing-performance.video.zero')}</p> : null}
    </div></div>
  );
  const insight = model.insight ? t.t('widget.marketing-performance.insight', {
    best: t.t(model.routes.find((route) => route.route === model.insight!.bestRoute)?.nameKey ?? 'data.marketing.route.placeNews'),
    other: t.t(model.routes.find((route) => route.route === model.insight!.compareRoute)?.nameKey ?? 'data.marketing.route.sms'),
  }) : null;
  const money = (won: number) => formatPosMoney(won);
  const notes = view.notes ?? [];
  return (
    <div className="mp-detail mp-perf" data-widget={FEATURE_ID} data-state="ready" data-period={period}>
      <div ref={focusRef} tabIndex={-1} className="mp-perf__top">
        {chips}
        <span className="mp-perf__range" data-slot="marketing-performance.range">{t.format.dateRange(model.period.start, model.period.end)}</span>
        {period === 'last' ? <span className="mp-hint">{t.t('widget.marketing-performance.lastMonthNote')}</span> : null}
        {notes.map((note) => <span key={note.messageKey}><StatusBadge kind="needsReview" /> {t.t(note.messageKey, note.params)}</span>)}
      </div>
      <div className="mp-perf__kpis" data-slot="marketing-performance.kpis">{blocks.map((block) => <MetricBlock key={block.id} block={block} minStage={0} lines={{ sub: true, note: true }} verbose />)}</div>
      <DetailTabs value={tab} onValueChange={setTab} tabs={tabs} label={t.t('widget.marketing-performance.tabs')} panels={{ route: routeTable, coupon: couponTable, video: videoTable }} />
      {model.recentIssued > 0 ? <p className="mp-hint" role="status" data-slot="marketing-performance.recent">{t.t('widget.marketing-performance.recent', { n: model.recentIssued })}</p> : null}
      <FormulaRow>
        <p data-slot="marketing-performance.formula.rate">{t.t('widget.marketing-performance.formula.rate', { rate: percent(t, model.rate), used: model.used, issued: model.issued })}</p>
        <p data-slot="marketing-performance.formula.revenue">{t.t('widget.marketing-performance.formula.revenue', { total: money(model.revenue.total), a: money(model.revenue.coupon), b: money(model.revenue.attributed) })}</p>
        <p data-slot="marketing-performance.formula.profit">{t.t('widget.marketing-performance.formula.profit', { profit: money(model.profit), total: money(model.revenue.total), cost: money(model.cost), discount: money(model.discount) })}</p>
      </FormulaRow>
      <p className="mp-hint" data-slot="marketing-performance.basis">{t.t(model.basisKey)}</p>
      {insight ? <InsightCard>{insight}</InsightCard> : null}
    </div>
  );
}

export const marketingPerformanceModule: WidgetModule = {
  id: FEATURE_ID,
  Panel: MarketingPerformancePanel,
  Detail: MarketingPerformanceDetail,
  useSummary: useMarketingPerformanceSummary,
};
