/** 상권분석 (`trade-area`, F-43): foot traffic by hour; tapping an hour shows that slot; “이 지역 트렌드 보기” opens local-trends. */
import { useState } from 'react';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetView } from '../../../data/react';
import type { TradeAreaModel } from '../../../data/models/types';
import { ActionButton, PanelBody, useUi } from '../../../ui';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, dateTime, rowCapacity, useT } from './shared';

const ID = 'trade-area';

/** Top `count` hours by people, shown in clock order (plan-1: 12시 260명 · 14시 320명). */
const topHours = (m: TradeAreaModel, count: number) => [...m.hours].sort((a, b) => b.people - a.people || a.hour - b.hour).slice(0, count).sort((a, b) => a.hour - b.hour);

function Panel({ condition, width, height, shape, host }: WidgetPanelProps) {
  const t = useT();
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return <PanelStateView id={ID} view={view} shape={shape} width={width} host={host} />;
  const m = view.model;
  const peakPeople = t.format.number(m.peak.people);
  const primary = (
    <PrimaryMetric id={ID} shape={shape} label={t.t('widget.trade-area.peakFootfall', { hour: m.peak.hour })} value={peakPeople} unit={t.t('widget.trade-area.unit', { n: m.peak.people })}
      longest={t.format.number(Math.max(...m.hours.map((h) => h.people)))} secondary={t.t('widget.trade-area.hourlyAverage')}
      note={`${t.t('widget.trade-area.nearShop')}\u00A0·\u00A0${t.t('widget.trade-area.hourlyAverage')}`} />
  );
  const rows = topHours(m, shape === 'W' ? 2 : rowCapacity(shape, height, textScale));
  const list = (
    <FitList slot={`${ID}.list`} label={t.t('widget.trade-area.hourlyAverage')} resetKey={`${t.locale}|${width}x${height}|${textScale}|${rows.length}`}
      items={rows.map((h) => (
        <li key={h.hour} className="mkt-row" data-slot={`${ID}.list.row`}>
          <span className="mkt-row__title">{t.format.hourRange(h.hour, h.hour + 1)}</span>
          <span className="mkt-row__value">{t.format.count(h.people, 'person')}</span>
        </li>
      ))} />
  );
  const max = Math.max(...m.hours.map((h) => h.people), 1);
  const chart = shape === 'S' || shape === 'L' ? (
    <div className="mkt-bars" role="img" aria-label={`${t.t('widget.trade-area.chartLabel')}: ${t.t('widget.trade-area.summary', { hour: m.peak.hour, people: peakPeople })}`}>
      {m.hours.map((h) => <span key={h.hour} className="mkt-bars__bar" data-peak={h.hour === m.peak.hour} style={{ height: `${Math.round((h.people / max) * 100)}%` }} />)}
    </div>
  ) : null;
  return <PanelBody width={width} height={height} primary={primary} list={list} chart={chart ?? undefined} />;
}

function Detail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useT();
  const view = useWidgetView(ID, condition);
  // A chat hand-off names the hour to show; any other entry starts on the peak.
  const [picked, setPicked] = useState<number | null>(detailRef.hour ?? null);
  if (view.status !== 'ready') return <DetailState id={ID} view={view} host={host} />;
  const m = view.model;
  const hour = picked ?? m.peak.hour;
  const slot = m.hours.find((h) => h.hour === hour) ?? m.peak;
  const max = Math.max(...m.hours.map((h) => h.people), 1);
  const updated = dateTime(t, m.updatedAt);
  const hours = t.format.hourRange(slot.hour, slot.hour + 1);
  return (
    <div className="mkt-detail" data-slot={`${ID}.card`}>
      <MetaLine>{[t.t(m.regionKey), t.t(m.periodKey), t.t('widget.trade-area.hourlyAverage')].join('\u00A0·\u00A0')}</MetaLine>
      <MetaLine>{t.t('widget.trade-area.source', { source: t.t(m.sourceKey) })}{'\u00A0·\u00A0'}{t.t('widget.trade-area.updated', updated)}</MetaLine>
      <div className="mkt-hours" role="group" aria-label={t.t('widget.trade-area.chartLabel')}>
        {m.hours.map((h) => (
          <button key={h.hour} type="button" className="mkt-hour" aria-pressed={h.hour === hour} data-peak={h.hour === m.peak.hour} aria-label={`${t.format.hourRange(h.hour, h.hour + 1)}, ${t.format.count(h.people, 'person')}${h.hour === m.peak.hour ? `, ${t.t('widget.trade-area.peakNote')}` : ''}`} onClick={() => setPicked(h.hour)}>
            <span className="mkt-hour__num" aria-hidden="true">{t.format.number(h.people)}</span>
            <span className="mkt-hour__track" aria-hidden="true"><span className="mkt-hour__bar" style={{ height: `${Math.max(2, Math.round((h.people / max) * 100))}%` }} /></span>
            <span className="mkt-hour__label" aria-hidden="true">{t.t('widget.trade-area.hourTick', { hour: h.hour })}</span>
          </button>
        ))}
      </div>
      <div className="mkt-card" aria-live="polite" data-slot={`${ID}.metric.value`}>
        <h4 className="mkt-card__title">{hours}</h4>
        <p className="mkt-card__line">{t.t('widget.trade-area.slotDetail', { hours, people: t.format.count(slot.people, 'person') })}</p>
        <p className="mkt-card__line">
          {slot.hour === m.peak.hour
            ? t.t('widget.trade-area.peakSentence')
            : t.t('widget.trade-area.ofPeak', { pct: Math.round((slot.people / m.peak.people) * 100) })}
        </p>
        <p className="mkt-card__meta">{t.t('widget.trade-area.estimate')}</p>
      </div>
      <div>
        <ActionButton variant="secondary" onClick={() => host.openLinked({ featureId: 'local-trends' })}>{t.t('widget.trade-area.viewTrends')}</ActionButton>
      </div>
    </div>
  );
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  return view.status === 'ready' ? t.t('widget.trade-area.summary', { hour: view.model.peak.hour, people: t.format.number(view.model.peak.people) }) : t.t(view.messageKey);
}

export const tradeAreaModule: WidgetModule = { id: ID, Panel, Detail, useSummary };
