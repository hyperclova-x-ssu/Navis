/** 상권분석 (`trade-area`, F-43): foot traffic by hour; tapping an hour shows that slot; “이 지역 트렌드 보기” opens local-trends. */
import { useMemo, useState, useSyncExternalStore } from 'react';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetDataStore, useWidgetView } from '../../../data/react';
import type { TradeAreaModel } from '../../../data/models/types';
import { ActionButton, PanelBody, useUi } from '../../../ui';
import { calendarDay } from '../../../data/reality/13/adapter';
import { literal, tradeHours } from '../../../data/reality/13/dto';
import { EXAMPLE_REGION, EXAMPLE_STOREFRONT_ADDRESS, exampleTrade } from './example-local';
import { isLargeCard } from './fit';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, dateTime, rowCapacity, useT, type Translator } from './shared';
import { allowedSource, localKey, periodText, seoulStamp, useReadHost } from './local-changes.http';
import { LocalReadNote } from './local-changes';

const ID = 'trade-area';

const noData = { status: 'empty' as const, variant: 'real-empty', messageKey: localKey('noData') };

/** The service's quarter code (`2026-Q4`) as the owner reads it; anything else stays as it came (T-27). */
function quarterText(t: Translator, quarter: string): string {
  const match = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!match) return quarter;
  return t.locale === 'ko' ? `${match[1]}년 ${match[2]}분기` : t.locale === 'en' ? `Q${match[2]} ${match[1]}` : `${match[1]}年第${match[2]}季`;
}

function movementCount(t: Translator, value: number): string {
  const unit = t.t('widget.trade-area.unit', { n: value });
  return `${t.format.number(value)}${t.locale === 'en' ? ' ' : ''}${unit}`;
}

/**
 * PAR-3 (D-384): the example mode shows the real screen. Its model gets the same official-source and POS-sales parts the service sends,
 * derived from the fixture tables; the real model passes through untouched.
 */
function useUnifiedModel(model: TradeAreaModel | undefined): TradeAreaModel | undefined {
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(() => {
    if (!model || model.real) return model;
    const real = exampleTrade(snapshot, model.updatedAt);
    return { ...model, real, regionKey: literal(EXAMPLE_REGION), sourceKey: 'data.real.local.seoul', periodKey: literal(real.population.quarter) };
  }, [model, snapshot]);
}

function Panel({ condition, width, height, shape, host: shellHost }: WidgetPanelProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  const m = useUnifiedModel(view.status === 'ready' ? view.model : undefined);
  if (view.status !== 'ready' || !m) return <PanelStateView id={ID} view={view as never} shape={shape} width={width} host={host} />;
  const { hours, ranked, peak, salesOnly } = tradeHours(m);
  if (!peak) return <PanelStateView id={ID} view={noData} shape={shape} width={width} host={host} />;
  const peakValue = t.format.number(peak.value);
  const metric = salesOnly ? 'hourlySales' : 'movement';
  const label = `${t.format.hourRange(peak.hour, peak.end)} · ${t.t(localKey(metric))}`;
  const listLabel = t.t('widget.trade-area.busiest');
  const referenceDate = m.real?.population.items.find(row => row.startHour === peak.hour)?.referenceDate;
  const sourceName = salesOnly ? 'POS' : t.t(m.sourceKey);
  const source = !salesOnly && referenceDate ? t.t(localKey('seoulDate'), { date: t.format.date(referenceDate, 'short') }) : sourceName;
  const formatValue = (value: number) => salesOnly ? t.format.count(value, 'pcs') : movementCount(t, value);
  const large = isLargeCard(shape, height);
  const metricContent = (
    <PrimaryMetric id={ID} shape={shape} label={label} value={peakValue} unit={t.t(salesOnly ? localKey('salesUnit') : 'widget.trade-area.unit', { n: peak.value })}
      longest={peakValue} secondary={height > 1 ? source : undefined} note={height > 1 ? source : undefined} />
  );
  const primary = height === 1 ? <div className="mkt-trade-compact">
    {metricContent}
    <p className="mkt-meta" data-slot={`${ID}.metric.source`} title={source}>{sourceName}</p>
  </div> : metricContent;
  const busiest = ranked.slice(0, shape === 'W' ? 2 : rowCapacity(shape, height, textScale)).sort((a, b) => a.hour - b.hour);
  const rows = large ? hours.filter(h => h.hour !== peak.hour).sort((a, b) => a.hour - b.hour) : busiest;
  const list = (
    <FitList slot={`${ID}.list`} label={listLabel} resetKey={`${t.locale}|${width}x${height}|${textScale}|${rows.length}`}
      items={rows.map((h) => (
        <li key={h.hour} className="mkt-row" data-slot={`${ID}.list.row`} data-mkt-extra={large && !busiest.includes(h) ? '' : undefined}>
          <span className="mkt-row__title">{t.format.hourRange(h.hour, h.end)}</span>
          <span className="mkt-row__value">{formatValue(h.value)}</span>
        </li>
      ))} />
  );
  const max = Math.max(peak.value, 1);
  const chart = shape === 'S' || shape === 'L' ? (
    <div className="mkt-bars mkt-trade-bars" role="img" aria-label={hours.map(h => `${t.format.hourRange(h.hour, h.end)} ${formatValue(h.value)}`).join(' · ')}>
      {hours.map(h => <span className="mkt-trade-bars__column" key={h.hour} aria-hidden="true">
        <span className="mkt-trade-bars__track">
          <span className="mkt-bars__bar" data-peak={h.hour === peak.hour} style={{ height: `${Math.round(h.value / max * 100)}%` }} />
        </span>
        <span className="mkt-trade-bars__tick">{t.t('widget.trade-area.hourTick', { hour: h.hour })}</span>
      </span>)}
    </div>
  ) : null;
  return <PanelBody width={width} height={height} primary={primary} list={list && <div><MetaLine>{listLabel}</MetaLine>{list}</div>} chart={chart ?? undefined} />;
}

function Detail({ condition, host: shellHost, detailRef }: WidgetDetailProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const view = useWidgetView(ID, condition);
  const m = useUnifiedModel(view.status === 'ready' ? view.model : undefined);
  // A chat hand-off names the hour to show; any other entry starts on the peak.
  const [picked, setPicked] = useState<number | null>(detailRef.hour ?? null);
  if (view.status !== 'ready' || !m) return <DetailState id={ID} view={view as never} host={host} />;
  const { hours, peak, salesOnly } = tradeHours(m);
  const trade = m.real!;
  const resolvedAddress = !view.model.real ? EXAMPLE_STOREFRONT_ADDRESS : trade.location?.items[0]?.address;
  const locationLine = resolvedAddress ? <MetaLine>{t.t(localKey('mapsAddress'))} · {resolvedAddress}</MetaLine> : null;
  const trends = <ActionButton variant="secondary" onClick={() => host.openLinked({ featureId: 'local-trends' })}>{t.t('widget.trade-area.viewTrends')}</ActionButton>;
  if (!peak) return <DetailState id={ID} view={noData} host={host} extra={<>{locationLine}{trends}</>} />;
  const measured = new Set(hours.map(row => row.hour));
  const salesHours = salesOnly ? [] : trade.sales.items.filter(row => !measured.has(row.hour));
  const chartHours = [...hours, ...salesHours.map(row => ({ hour: row.hour, end: row.hour + 1, value: null }))]
    .sort((a, b) => a.hour - b.hour);
  const hour = picked ?? peak.hour;
  const slot = chartHours.find(h => h.hour === hour);
  const max = Math.max(peak.value, 1);
  const range = slot ? t.format.hourRange(slot.hour, slot.end) : t.format.hourRange(hour, hour + 1);
  const band = trade.population.items.find(row => row.startHour <= hour && hour < row.endHour);
  const sale = trade.sales.items.find(row => row.hour === hour);
  const original = band && allowedSource(band.sourceUrl);
  return (
    <div className="mkt-detail" data-slot={`${ID}.card`}>
      <LocalReadNote notes={view.notes} host={host} />
      <MetaLine>{`${periodText(t, trade.period)} · ${t.format.weekday(calendarDay, 'long')}`}</MetaLine>
      <MetaLine>{t.t('widget.trade-area.source', { source: salesOnly ? 'POS' : t.t(m.sourceKey) })}{'\u00A0·\u00A0'}
        {band ? t.t('widget.trade-area.updated', dateTime(t, seoulStamp(band.refreshedAt))) : t.t('widget.trade-area.updated', dateTime(t, seoulStamp(m.updatedAt)))}
        {!salesOnly && view.model.real && ' · 서울특별시·KT, 서울시 통신데이터'}</MetaLine>
      {locationLine}
      <div className="mkt-hours" role="group" aria-label={t.t(localKey(salesOnly ? 'hourlySales' : 'movement'))}>
        {chartHours.map(h => {
          const value = h.value === null ? t.t(localKey('noData')) : salesOnly ? t.format.count(h.value, 'pcs') : movementCount(t, h.value);
          return <button key={h.hour} type="button" className="mkt-hour" aria-pressed={h.hour === hour} data-peak={h.hour === hour}
            aria-label={[t.format.hourRange(h.hour, h.end), value, h.hour === peak.hour && !salesOnly ? t.t('widget.trade-area.peakSentence') : ''].filter(Boolean).join(', ')} onClick={() => setPicked(h.hour)}>
              <span className="mkt-hour__num" aria-hidden="true">{h.value === null ? '—' : t.format.number(h.value)}</span>
              <span className="mkt-hour__track" aria-hidden="true">{h.value !== null && <span className="mkt-hour__bar" style={{ height: `${Math.max(2, Math.round((h.value / max) * 100))}%` }} />}</span>
              <span className="mkt-hour__label" aria-hidden="true">{t.t('widget.trade-area.hourTick', { hour: h.hour })}</span>
            </button>;
        })}
      </div>
      <div className="mkt-card" aria-live="polite" data-slot={`${ID}.metric.value`}>
        <h4 className="mkt-card__title">{range}</h4>
        <p className="mkt-card__line"><strong>{t.t(localKey('movement'))}</strong>{' · '}{band ? <strong className="mkt-decision-metric">{movementCount(t, band.estimate)}</strong> : t.t(localKey('noData'))}</p>
        {band && !salesOnly ? <p className="mkt-card__line">{hour === peak.hour ? '가장 많은 시간대예요' : `가장 많은 시간의 ${Math.round((band.estimate / max) * 100)}%예요`}</p> : null}
        {band ? <>
          <p className="mkt-card__meta">{band.region} · {quarterText(t, band.quarter)} · 자료 기준일 {t.format.date(band.referenceDate, 'short')}</p>
          {original && <a className="mkt-touch-link" href={original} target="_blank" rel="noopener noreferrer">{t.t(localKey('original'))}</a>}
        </> : null}
        <p className="mkt-card__line"><strong>{t.t(localKey('hourlySales'))}</strong>{' · '}{sale ? <>{t.t(localKey('quantity'))} {salesOnly ? <strong className="mkt-decision-metric">{t.format.count(sale.quantity, 'pcs')}</strong> : t.format.count(sale.quantity, 'pcs')}</> : trade.sales.status === 'unavailable' ? t.t('data.real.error') : '이 시간대에 기록된 판매가 없어요'}</p>
        <p className="mkt-card__meta">POS · {periodText(t, trade.period)}</p>
        {sale && <div>
          <ActionButton variant="secondary" onClick={() => host.openLinked({ featureId: 'ledger',
            condition: { kind: 'dateRange', start: trade.period.from, end: trade.period.to }, ...(sale.settlementIds.length === 1 ? { itemId: sale.settlementIds[0] } : {}) })}>{t.t(localKey('ledger'))}</ActionButton>
        </div>}
      </div>
      <div>{trends}</div>
    </div>
  );
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  const m = useUnifiedModel(view.status === 'ready' ? view.model : undefined);
  if (view.status !== 'ready' || !m) return t.t((view as { messageKey: string }).messageKey);
  const { real, peak } = m;
  if (peak && real?.population.items.length) return `${t.t('data.real.local.movement')} · ${movementCount(t, peak.people)}`;
  if (real?.sales.items.length) return t.t('data.real.local.hourlySales');
  return t.t('data.real.local.noData');
}

export const tradeAreaModule: WidgetModule = {
  id: ID,
  Panel,
  Detail,
  useSummary,
};
