/**
 * The common panel body of the four coupon widgets (DS 11.9.1~11.9.2, SCR-37): title is drawn by the dashboard frame;
 * here K (MetricFit, stage >= 1 at 125 %) -> one-line description -> PanelAction.
 * W: K and description left, action right. T/S/L: rows below.
 *
 * Fit rule (DS 11.9.2 덜어내기 순서): when the content still overflows its frame (long English title, 125 %, narrow column)
 * the description steps down to its shorter sentence, then disappears, then rows are dropped from the bottom. K, unit, the title
 * and the button name always stay. Measured after layout; jsdom (no layout) never drops anything.
 */
import { useRef, type ReactNode } from 'react';
import { koreanLang, usePanelFit } from '../mkt-local/fit';
import { fitCouponPanel } from './fit';
import type { ContentShape } from '../../../contracts';
import { useRealRetry } from '../../../data/react';
import { ActionButton, MetricFit, PanelAction, PanelBody } from '../../../ui';
import { keepDots, Live, useMkt, usePanelMode } from './shared';
import { useRealCoupons } from './panel.actions';

export function CouponSourceNote({ id }: { readonly id: 'slot-coupon' | 'expiry-coupon' | 'coupon-status' }) {
  const data = useRealCoupons(), retry = useRealRetry('coupons'), { t } = useMkt();
  if (!data?.missing.includes(id)) return null;
  return <div className="mkt-actions"><p role="status">{t('data.real.partial')}</p>
    <ActionButton variant="secondary" onClick={retry}>{t('common.retry')}</ActionButton>
  </div>;
}

export interface PanelKpi { readonly value: string; readonly unit: string; /** longest value the widget can show (stable stage) */ readonly longest?: string }
export interface PanelActionSpec { readonly label: string; readonly widgetName: string; readonly onPress: () => void }

export function MktPanel({ id, shape, width, height, editing, label, labelFirst = false, kpi, descs, aside, rows, action, primaryRow }: {
  readonly id: string; readonly shape: ContentShape; readonly width: number; readonly height: number; readonly editing: boolean;
  readonly label: string; readonly labelFirst?: boolean; readonly kpi: PanelKpi;
  readonly primaryRow?: string;
  /** one-line description candidates, most informative first (the next one is used when the first does not fit) */ readonly descs?: readonly string[];
  /** not Q: extra line next to / under the description (e.g. the ‘확인 필요’ note) */ readonly aside?: ReactNode;
  /** T / S / L only: one node per row */ readonly rows?: readonly ReactNode[]; readonly action: PanelActionSpec | null;
}) {
  const mode = usePanelMode(shape, editing);
  const { locale } = useMkt();
  const list = [...new Set((descs ?? []).map((desc) => {
    if (locale !== 'ko' || desc === label || !desc.startsWith(label)) return desc;
    return desc.slice(label.length).replace(/^[\s\u00a0]*·[\s\u00a0]*/u, '');
  }).filter((d) => d !== ''))];
  const root = useRef<HTMLDivElement>(null);
  usePanelFit(root, fitCouponPanel);
  const button=action?<PanelAction label={action.label} widgetName={action.widgetName} hidden={editing || undefined} onPress={action.onPress}/>:undefined;
  const description=list.length&&(!mode.isQ||list[0]!==label)?<div className="mkt-desc" data-slot={`${id}.metric.desc`}>{list.map((desc,index)=><span key={desc} data-mkt-desc-candidate="" hidden={index!==0} lang={koreanLang(desc)}>{keepDots(desc)}</span>)}</div>:null;
  const metricLabel = <p className="mkt-label" data-slot={`${id}.metric.label`} lang={koreanLang(label)}>{label}</p>;
  const primary = <>
    {labelFirst ? metricLabel : null}
    <div className="mkt-number-row">
      <Live value={kpi.value}>
        <span data-slot={`${id}.metric.value`} className="mkt-kpi"><MetricFit value={kpi.value} unit={kpi.unit} longest={kpi.longest ?? kpi.value} stacked={false} minStage={mode.isQ ? mode.minStage : 0} /></span>
      </Live>
      {mode.isQ?button:null}
    </div>
    {labelFirst ? null : metricLabel}
    {primaryRow && <p className="mkt-primary-row" lang={koreanLang(primaryRow)}>{keepDots(primaryRow)}</p>}
    {mode.isQ?<div className="ui-sr-only">{description}</div>:!mode.isW?description:null}
  </>;
  return <div ref={root} className="mkt-panel" data-widget={id} data-shape={shape} data-width={width} data-height={height}>
    <PanelBody width={width} height={height} primary={primary}
      secondary={mode.isQ?undefined:mode.isW?<>{description}{aside}</>:aside}
      list={!mode.isQ && !mode.isW && rows?.length ? <ul className="mkt-rows" data-slot={`${id}.rows`}>{rows}</ul> : undefined}
      action={mode.isQ?undefined:button}/>
  </div>;
}
