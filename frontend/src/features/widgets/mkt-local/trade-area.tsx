/** 상권분석 (`trade-area`, F-43): foot traffic by hour; tapping an hour shows that slot; “이 지역 트렌드 보기” opens local-trends. */
import { useState } from 'react';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetView } from '../../../data/react';
import { ActionButton, PanelBody, useUi } from '../../../ui';
import { calendarDay } from '../../../data/reality/13/adapter';
import { tradeHours } from '../../../data/reality/13/dto';
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

function Panel({ condition, width, height, shape, host: shellHost }: WidgetPanelProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return <PanelStateView id={ID} view={view} shape={shape} width={width} host={host} />;
  const m = view.model;
  const { hours, ranked, peak, salesOnly } = tradeHours(m);
  if (!peak) return <PanelStateView id={ID} view={noData} shape={shape} width={width} host={host} />;
  const peakValue = t.format.number(peak.value);
  const metric = salesOnly ? 'hourlySales' : 'movement';
  const label = m.real ? `${t.format.hourRange(peak.hour, peak.end)} · ${t.t(localKey(metric))}` : t.t('widget.trade-area.peakFootfall', { hour: peak.hour });
  const average = m.real ? t.t(localKey(metric)) : t.t('widget.trade-area.hourlyAverage');
  const referenceDate = m.real?.population.items.find(row => row.startHour === peak.hour)?.referenceDate;
  const source = salesOnly ? 'POS' : referenceDate ? t.t(localKey('seoulDate'), { date: t.format.date(referenceDate, 'short') }) : t.t(m.sourceKey);
  const formatValue = (value: number) => salesOnly ? t.format.count(value, 'pcs') : m.real ? movementCount(t, value) : t.format.count(value, 'person');
  /** D-333: the large card names the area and period beside 「시간대별 일평균」 and lists every hour of the data, not only the busiest ones (the detail's lines, re-shown). */
  const large = isLargeCard(shape, height);
  const primary = (
    <PrimaryMetric id={ID} shape={shape} label={label} value={peakValue} unit={t.t(salesOnly ? localKey('salesUnit') : 'widget.trade-area.unit', { n: peak.value })}
      longest={peakValue} secondary={m.real ? (shape === 'Q' ? null : source) : large ? [t.t(m.regionKey), t.t(m.periodKey), average].join('\u00A0·\u00A0') : average}
      note={m.real ? source : `${t.t('widget.trade-area.nearShop')}\u00A0·\u00A0${average}`} />
  );
  const busiest = ranked.slice(0, shape === 'W' ? 2 : rowCapacity(shape, height, textScale)).sort((a, b) => a.hour - b.hour);
  const rows = large ? [...hours].sort((a, b) => a.hour - b.hour) : busiest;
  const list = (
    <FitList slot={`${ID}.list`} label={average} resetKey={`${t.locale}|${width}x${height}|${textScale}|${rows.length}`}
      items={rows.map((h) => (
        <li key={h.hour} className="mkt-row" data-slot={`${ID}.list.row`} data-mkt-extra={large && !busiest.includes(h) ? '' : undefined}>
          <span className="mkt-row__title">{t.format.hourRange(h.hour, h.end)}</span>
          <span className="mkt-row__value">{formatValue(h.value)}</span>
        </li>
      ))} />
  );
  const max = Math.max(peak.value, 1);
  const chart = shape === 'S' || shape === 'L' ? (
    <div className="mkt-bars" role="img" aria-label={m.real ? `${label} · ${formatValue(peak.value)}` : `${t.t('widget.trade-area.chartLabel')}: ${t.t('widget.trade-area.summary', { hour: peak.hour, people: peakValue })}`}>
      {hours.map((h) => <span key={h.hour} className="mkt-bars__bar" data-peak={h.hour === peak.hour} style={{ height: `${Math.round((h.value / max) * 100)}%` }} />)}
    </div>
  ) : null;
  return <PanelBody width={width} height={height} primary={primary} list={list} chart={chart ?? undefined} />;
}

function Detail({ condition, host: shellHost, detailRef }: WidgetDetailProps) {
  const t = useT();
  const host = useReadHost(shellHost);
  const view = useWidgetView(ID, condition);
  // A chat hand-off names the hour to show; any other entry starts on the peak.
  const [picked, setPicked] = useState<number | null>(detailRef.hour ?? null);
  if (view.status !== 'ready') return <DetailState id={ID} view={view} host={host} />;
  const m = view.model;
  const { hours, peak, salesOnly } = tradeHours(m);
  const trade = m.real;
  const trends = <ActionButton variant="secondary" onClick={() => host.openLinked({ featureId: 'local-trends' })}>{t.t('widget.trade-area.viewTrends')}</ActionButton>;
  if (!peak) return <DetailState id={ID} view={noData} host={host} extra={trends} />;
  const measured = new Set(hours.map(row => row.hour));
  const salesHours = salesOnly ? [] : trade?.sales.items.filter(row => !measured.has(row.hour)) ?? [];
  const chartHours = [...hours, ...salesHours.map(row => ({ hour: row.hour, end: row.hour + 1, value: null }))]
    .sort((a, b) => a.hour - b.hour);
  const hour = picked ?? peak.hour;
  const slot = chartHours.find(h => h.hour === hour) ?? (!trade ? peak : undefined);
  const max = Math.max(peak.value, 1);
  const updated = dateTime(t, m.updatedAt);
  const range = slot ? t.format.hourRange(slot.hour, slot.end) : t.format.hourRange(hour, hour + 1);
  const band = trade?.population.items.find(row => row.startHour <= hour && hour < row.endHour);
  const sale = trade?.sales.items.find(row => row.hour === hour);
  const original = band && allowedSource(band.sourceUrl);
  return (
    <div className="mkt-detail" data-slot={`${ID}.card`}>
      <LocalReadNote notes={view.notes} host={host} />
      <MetaLine>{trade ? `${periodText(t, trade.period)} · ${t.format.weekday(calendarDay, 'long')}` : [t.t(m.regionKey), t.t(m.periodKey), t.t('widget.trade-area.hourlyAverage')].join('\u00A0·\u00A0')}</MetaLine>
      <MetaLine>{m.sourceKey !== 'data.source.sample' ? <>{t.t('widget.trade-area.source', { source: salesOnly ? 'POS' : t.t(m.sourceKey) })}{'\u00A0·\u00A0'}</> : null}{t.t('widget.trade-area.updated', trade ? dateTime(t, seoulStamp(m.updatedAt)) : updated)}</MetaLine>
      <div className="mkt-hours" role="group" aria-label={t.t(trade ? localKey(salesOnly ? 'hourlySales' : 'movement') : 'widget.trade-area.chartLabel')}>
        {chartHours.map(h => {
          const value = h.value === null ? t.t(localKey('noData')) : salesOnly ? t.format.count(h.value, 'pcs') : trade ? movementCount(t, h.value) : t.format.count(h.value, 'person');
          const peakNote = !trade && h.hour === peak.hour ? t.t('widget.trade-area.peakNote') : '';
          return <button key={h.hour} type="button" className="mkt-hour" aria-pressed={h.hour === hour} data-peak={h.hour === peak.hour}
            aria-label={[t.format.hourRange(h.hour, h.end), value, peakNote].filter(Boolean).join(', ')} onClick={() => setPicked(h.hour)}>
              <span className="mkt-hour__num" aria-hidden="true">{h.value === null ? '—' : t.format.number(h.value)}</span>
              <span className="mkt-hour__track" aria-hidden="true">{h.value !== null && <span className="mkt-hour__bar" style={{ height: `${Math.max(2, Math.round((h.value / max) * 100))}%` }} />}</span>
              <span className="mkt-hour__label" aria-hidden="true">{t.t('widget.trade-area.hourTick', { hour: h.hour })}</span>
            </button>;
        })}
      </div>
      <div className="mkt-card" aria-live="polite" data-slot={`${ID}.metric.value`}>
        <h4 className="mkt-card__title">{range}</h4>
        {trade ? <>
          <p className="mkt-card__line"><strong>{t.t(localKey('movement'))}</strong>{' · '}{band ? movementCount(t, band.estimate) : t.t(localKey('noData'))}</p>
          {band ? <>
            <p className="mkt-card__meta">{band.region} · {quarterText(t, band.quarter)} · {t.t(localKey('seoulDate'), { date: t.format.date(band.referenceDate, 'short') })} · {t.t('widget.trade-area.updated', dateTime(t, seoulStamp(band.refreshedAt)))}</p>
            {original && <a className="mkt-touch-link" href={original} target="_blank" rel="noopener noreferrer">{t.t(localKey('original'))}</a>}
          </> : null}
          <p className="mkt-card__line"><strong>{t.t(localKey('hourlySales'))}</strong>{' · '}{sale ? `${t.t(localKey('quantity'))} ${t.format.count(sale.quantity, 'pcs')}` : t.t(trade.sales.status === 'unavailable' ? 'data.real.error' : localKey('noData'))}</p>
          <p className="mkt-card__meta">POS · {periodText(t, trade.period)}</p>
          {sale && <div>
            <ActionButton variant="secondary" onClick={() => host.openLinked({ featureId: 'ledger',
              condition: { kind: 'dateRange', start: trade.period.from, end: trade.period.to }, ...(sale.settlementIds.length === 1 ? { itemId: sale.settlementIds[0] } : {}) })}>{t.t(localKey('ledger'))}</ActionButton>
          </div>}
        </> : slot?.value != null && <>
          <p className="mkt-card__line">{t.t('widget.trade-area.slotDetail', { hours: range, people: t.format.count(slot.value, 'person') })}</p>
          <p className="mkt-card__line">
            {slot.hour === peak.hour ? t.t('widget.trade-area.peakSentence') : t.t('widget.trade-area.ofPeak', { pct: Math.round((slot.value / max) * 100) })}
          </p>
          <p className="mkt-card__meta">{t.t('widget.trade-area.estimate')}</p>
        </>}
      </div>
      <div>{trends}</div>
    </div>
  );
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return t.t(view.messageKey);
  const { real, peak } = view.model;
  if (real) {
    if (peak) return `${t.t('data.real.local.movement')} · ${movementCount(t, peak.people)}`;
    if (real.sales.items.length) return t.t('data.real.local.hourlySales');
    return t.t('data.real.local.noData');
  }
  return t.t('widget.trade-area.summary', { hour: peak.hour, people: t.format.number(peak.people) });
}

export const tradeAreaModule: WidgetModule = {
  id: ID,
  Panel,
  Detail,
  useSummary,
};
