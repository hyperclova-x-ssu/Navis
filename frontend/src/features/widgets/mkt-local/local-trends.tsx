/** 로컬 트렌드 (`local-trends`, F-44): keyword change list; a keyword opens its metric definition, comparison period, source and date. */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { koreanLang } from './fit';
import { useWidgetView } from '../../../data/react';
import type { KeywordRow } from '../../../data/models/types';
import { PanelBody, useUi } from '../../../ui';
import { DetailState, FitList, MetaLine, PanelStateView, PrimaryMetric, dateTime, rowCapacity, useT, type Translator } from './shared';

const ID = 'local-trends';

/** ▲/▼ plus words, never colour alone. */
function changeText(t: Translator, k: KeywordRow): string {
  if (k.changePercent === null) return t.t('widget.local-trends.noComparison');
  const pct = t.format.number(Math.abs(k.changePercent));
  if (k.changePercent > 0) return `▲ ${t.t('widget.local-trends.rose', { pct })}`;
  if (k.changePercent < 0) return `▼ ${t.t('widget.local-trends.fell', { pct })}`;
  return `– ${t.t('widget.local-trends.rose', { pct: 0 })}`;
}

function Panel({ condition, width, height, shape, host }: WidgetPanelProps) {
  const t = useT();
  const { textScale } = useUi();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return <PanelStateView id={ID} view={view} shape={shape} width={width} host={host} />;
  const m = view.model;
  const rows = m.notable.slice(0, shape === 'W' ? 2 : rowCapacity(shape, height, textScale));
  const primary = (
    <PrimaryMetric id={ID} shape={shape} label={t.t('widget.local-trends.notableKeywords')} value={t.format.number(m.notableCount)} unit={t.t('widget.local-trends.unit', { n: m.notableCount })} note={t.t('widget.local-trends.periodNote')} />
  );
  const list = rows.length === 0 ? null : (
    <FitList slot={`${ID}.list`} label={t.t('widget.local-trends.mentionsUp')} resetKey={`${t.locale}|${width}x${height}|${textScale}|${rows.length}`}
      items={rows.map((k) => (
        <li key={k.keywordId} className="mkt-row" data-slot={`${ID}.list.row`}>
          <span className="mkt-row__text">
            <span className="mkt-row__title" lang={koreanLang(t.t(k.keywordKey))}>{t.t(k.keywordKey)}</span>
            <span className="mkt-row__sub">{shape === 'S' || shape === 'L' ? `${t.t('widget.local-trends.category', { category: t.t(k.categoryKey) })}` : t.t('widget.local-trends.mentionsUp')}</span>
          </span>
          <span className="mkt-row__value">{changeText(t, k)}</span>
        </li>
      ))} />
  );
  return <PanelBody width={width} height={height} primary={primary} list={list} />;
}

function Detail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useT();
  const view = useWidgetView(ID, condition);
  // A chat hand-off opens the keyword it names; otherwise the first keyword is open.
  const [picked, setPicked] = useState<string | null | undefined>(detailRef.itemId);
  const openRow = useRef<HTMLLIElement>(null);
  const evidencePrefix = useId();

  useLayoutEffect(() => {
    if (picked) openRow.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [picked]);

  if (view.status !== 'ready') return <DetailState id={ID} view={view} host={host} />;
  const m = view.model;
  const selected = picked === null ? undefined : m.keywords.find((k) => k.keywordId === picked) ?? m.keywords[0];
  const updated = dateTime(t, m.updatedAt);
  return (
    <div className="mkt-detail mkt-detail--natural" data-slot={`${ID}.card`}>
      <MetaLine>{t.t('widget.local-trends.region', { region: t.t(m.regionKey) })}{'\u00A0·\u00A0'}{t.format.dateRange(m.period.start, m.period.end)}</MetaLine>
      <MetaLine>{t.t('widget.local-trends.source', { source: t.t(m.sourceKey) })}{'\u00A0·\u00A0'}{t.t('widget.local-trends.updated', updated)}</MetaLine>
      <p className="mkt-meta">{t.t('widget.local-trends.pick')}</p>
      <ul className="mkt-list" data-slot={`${ID}.list`} aria-label={t.t('widget.local-trends.notableKeywords')}>
        {m.keywords.map((k) => {
          const expanded = selected?.keywordId === k.keywordId;
          const evidenceId = `${evidencePrefix}-${k.keywordId}`;
          return (
            <li key={k.keywordId} ref={expanded ? openRow : undefined} className="mkt-trend-keyword" data-slot={`${ID}.list.row`}>
              <button type="button" className="mkt-pick" aria-expanded={expanded} aria-controls={evidenceId} onClick={() => setPicked(expanded ? null : k.keywordId)}>
                <span className="mkt-pick__top"><span className="mkt-pick__title">{t.t(k.keywordKey)}</span><span className="mkt-row__value">{changeText(t, k)}</span></span>
                <span className="mkt-pick__sub">{t.t('widget.local-trends.mentions', { n: k.mentions })}{k.notable ? `\u00A0·\u00A0${t.t('widget.local-trends.mentionsUp')}` : ''}</span>
              </button>
              <div id={evidenceId} hidden={!expanded} aria-live="polite">
                {expanded && (
                  <div className="mkt-card">
                    <h4 className="mkt-card__title">{t.t(k.keywordKey)}</h4>
                    <p className="mkt-card__line">{t.t('widget.local-trends.mentions', { n: k.mentions })}{k.previous !== null ? `${t.locale === 'ko' ? '' : ' '}(${t.t('widget.local-trends.previous', { n: k.previous })})` : ''}</p>
                    <p className="mkt-card__line">{changeText(t, k)}</p>
                    <p className="mkt-card__line">{t.t('widget.local-trends.category', { category: t.t(k.categoryKey) })}</p>
                    <p className="mkt-card__line">{t.t('widget.local-trends.definition')}</p>
                    <p className="mkt-card__meta">{t.t('widget.local-trends.comparePeriod', { current: t.format.dateRange(m.period.start, m.period.end), previous: t.format.dateRange(m.previousPeriod.start, m.previousPeriod.end) })}</p>
                    <p className="mkt-card__meta">{t.t('widget.local-trends.source', { source: t.t(m.sourceKey) })}{'\u00A0·\u00A0'}{t.t('widget.local-trends.updated', updated)}</p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function useSummary({ condition }: { readonly condition: WidgetPanelProps['condition'] }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  return view.status === 'ready' ? t.t('widget.local-trends.summary', { n: view.model.notableCount }) : t.t(view.messageKey);
}

export const localTrendsModule: WidgetModule = { id: ID, Panel, Detail, useSummary };
