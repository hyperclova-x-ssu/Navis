/**
 * mgmt-money shared pieces (T-047): translator, number splitting, row budgets by size, the panel layout, the
 * small chart, state views and the command runner. Nothing here knows a value: every number comes from a model.
 */
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useBundle } from '../../../i18n';
import type { Formatters, Locale, MessageParams } from '../../../i18n';
import { dataBundle, type DataCommand, type DataCommandResult } from '../../../data/widget-data';
import { useDataDispatch } from '../../../data/react';
import { managementBundle } from '../../../data/messages/management';
import type { ContentShape, FeatureId, WidgetHost, WidgetPanelProps } from '../../../contracts';
import { ActionButton, Icon, MetricFit, PanelBody, PanelState, StatusBadge, useUi } from '../../../ui';
import { mgmtMoneyBundle } from './messages';
import { FitProbe, keepDots, type FitPart } from './fit';
import { ValueSlot } from './value-slot';

/** SCR-212: secondary text, rows/chart, essential secondary text, then label. Value and unit stay. */
export const MONEY_FIT: readonly FitPart[] = [{ selector: '.mm-note' }, { selector: '.mm-row__badge' }, { selector: '.mm-sub:not(.mm-sub--essential)' }, { selector: '.mm-row__sub' }, { selector: '.mm-rows-title' }, { selector: '.mm-row', last: true }, { selector: '.mm-chart' }, { selector: '.mm-sub--essential' }, { selector: '.mm-label' }];

/** Korean fallback keeps Korean word boundaries on every screen language (SCR R-13). */
export const copyLang = (text: string): 'ko' | undefined => /[가-힣]/u.test(text) ? 'ko' : undefined;

/** Callable translator (`t(key, params)`) that also carries `format` and `locale`. */
export interface T { (key: string, params?: MessageParams): string; readonly format: Formatters; readonly locale: Locale }

/** Translator with this bundle, the common bundle and the fake-data bundle (`data.*`). */
export function useMoneyT(): T {
  const translator = useBundle(mgmtMoneyBundle, dataBundle, managementBundle);
  return useMemo(() => Object.assign((key: string, params?: MessageParams) => keepDots(translator.t(key as never, params)), { format: translator.format, locale: translator.locale }), [translator]);
}

/** Splits a compact formatted number into value and unit for MetricFit ('128.4만 원' → '128.4' + '만 원'; '₩1,284,000' stays whole). */
export function splitFormatted(text: string): { readonly value: string; readonly unit: string } {
  const match = /^(\D?[\d.,]+)\s*(.*)$/u.exec(text);
  return match ? { value: match[1] ?? text, unit: match[2] ?? '' } : { value: text, unit: '' };
}
export const splitMoney = (t: T, won: number) => splitFormatted(t.format.money(won, 'compact'));

/** ISO date arithmetic in UTC (no device time zone, no Date.now). */
export function addIsoDays(iso: string, days: number): string {
  const [y = 0, m = 1, d = 1] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/* ---------- row budgets (SCREENS 3.1) ---------- */
export interface SizeCtx { readonly shape: ContentShape; readonly width: number; readonly height: number; readonly scale: 100 | 125; readonly preset: 'A' | 'B' }
export function useSizeCtx(props: Pick<WidgetPanelProps, 'shape' | 'width' | 'height'>): SizeCtx {
  const ui = useUi();
  return { shape: props.shape, width: props.width, height: props.height, scale: ui.textScale, preset: ui.screenPreset.id };
}
const T_ROWS = { A: { 100: [3, 5, 7], 125: [2, 4, 5] }, B: { 100: [3, 6, 8], 125: [3, 5, 6] } } as const;
/** D-333: the 4-high card lists more rows (only margin has a row budget); the fit guard still hides whatever does not fit. */
const L_ROWS = { A: { 100: [3, 5, 15], 125: [2, 4, 10] }, B: { 100: [4, 6, 16], 125: [3, 5, 11] } } as const;
/** Largest number of list rows the size can show (the widget may use fewer). */
export function rowBudget(ctx: SizeCtx): number {
  const index = Math.min(2, Math.max(0, ctx.height - 2));
  switch (ctx.shape) {
    case 'Q': return 0;
    case 'W': return ctx.scale === 125 ? 1 : 2;
    case 'T': return T_ROWS[ctx.preset][ctx.scale][index] ?? 2;
    case 'S': return 2;
    default: return L_ROWS[ctx.preset][ctx.scale][index] ?? 3;
  }
}

/* ---------- small chart ---------- */
export interface ChartData {
  readonly values: readonly number[];
  readonly labels: readonly string[];
  readonly kind: 'bar' | 'line';
  readonly format: (n: number) => string;
  readonly ariaLabel: string;
  /** Prefer every axis label when each fits one line; otherwise show first/last only. */
  readonly allLabels?: boolean;
  /** Direct value label on every bar/point (detail only); panels label the last one. */
  readonly valueLabels?: boolean;
  readonly dates?: readonly string[];
  readonly series?: readonly { readonly id: string; readonly label: string; readonly values: readonly number[] }[];
}
export function fitAxisLabels(axis: HTMLElement, preferAll: boolean): void {
  const labels = Array.from(axis.children) as HTMLElement[];
  // Measure the full set again after growing, a scale change or font loading.
  axis.setAttribute('data-all-labels', String(preferAll));
  for (const label of labels) label.hidden = false;
  const allFit = preferAll && (axis.clientWidth === 0 || labels.every(label => label.scrollWidth <= label.clientWidth));
  axis.setAttribute('data-all-labels', String(allFit));
  labels.forEach((label, i) => {
    const visible = allFit || i === 0 || i === labels.length - 1;
    label.hidden = !visible;
    label.setAttribute('data-visible', String(visible));
  });
}

export function MiniSeries({ data, className = '' }: { readonly data: ChartData; readonly className?: string }) {
  const axisRef = useRef<HTMLElement>(null);
  const labelKey = JSON.stringify(data.labels);
  useLayoutEffect(() => {
    const axis = axisRef.current;
    if (!axis) return;
    const fit = () => fitAxisLabels(axis, Boolean(data.allLabels));
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(axis);
    let live = true;
    const onFonts = () => { if (live) fit(); };
    void document.fonts?.ready.then(onFonts);
    document.fonts?.addEventListener?.('loadingdone', onFonts);
    return () => { live = false; observer?.disconnect(); document.fonts?.removeEventListener?.('loadingdone', onFonts); };
  }, [labelKey, data.allLabels]);
  const { values, labels, kind } = data;
  const all = data.series?.flatMap(series => [...series.values]) ?? values;
  const hi = Math.max(...(all.length ? all : [0])), lo = Math.min(...(all.length ? all : [0]));
  const span = hi - lo || Math.abs(hi) || 1;
  const bottom = kind === 'line' ? lo - span * 0.25 : Math.min(0, lo);
  const top = kind === 'line' ? hi + span * 0.25 : Math.max(0, hi);
  const pos = (v: number) => ((v - bottom) / (top - bottom || 1)) * 100;
  const last = values.length - 1;
  const summary = `${data.ariaLabel}: ${values.map((v, i) => `${labels[i] ?? data.dates?.[i] ?? i + 1} ${data.series ? data.series.map(series => `${series.label} ${data.format(series.values[i] ?? 0)}`).join(' · ') : data.format(v)}`).join(', ')}`;
  return (
    <figure className={`mm-chart ${className}`} data-kind={kind}>
      <div className="mm-chart__plot" role="img" aria-label={summary}>
        {data.series ? <div className="mm-chart__groups" aria-hidden="true">
          {data.valueLabels ? <span className="mm-chart__baseline" style={{ bottom: `${pos(0)}%` }} /> : null}
          {values.map((_, i) => <div key={data.dates?.[i] ?? i} className="mm-chart__group" data-date={data.dates?.[i]}>
            {data.series!.map((series, seriesIndex) => {
              const value = series.values[i] ?? 0;
              return <span key={series.id} className="mm-chart__paired-bar" data-series={series.id} data-series-index={seriesIndex} data-value={value} style={{ height: `${Math.abs(pos(value) - pos(0))}%`, bottom: `${Math.min(pos(value), pos(0))}%` }}>
                <span className="mm-chart__paired-fill" />
                {data.valueLabels ? <span className="mm-chart__bar-value" data-negative={value < 0 || undefined}>{data.format(value)}</span> : null}
              </span>;
            })}
          </div>)}
        </div> : kind === 'bar' ? (
          <div className="mm-chart__bars" aria-hidden="true">
            {values.map((v, i) => <div key={i} className="mm-chart__col"><span className="mm-chart__value" data-visible={String(i === last || Boolean(data.valueLabels))}>{data.format(v)}</span><span className="mm-chart__bar" data-last={String(i === last)} style={{ height: `${Math.max(2, pos(v))}%` }} /></div>)}
          </div>
        ) : (
          <div className="mm-chart__line" aria-hidden="true">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none">
              <polyline vectorEffect="non-scaling-stroke" fill="none" points={values.map((v, i) => `${values.length === 1 ? 50 : (i / (values.length - 1)) * 100},${100 - pos(v)}`).join(' ')} />
            </svg>
            {values.map((v, i) => <span key={i} className="mm-chart__dot" data-last={String(i === last)} style={{ left: `${values.length === 1 ? 50 : (i / (values.length - 1)) * 100}%`, bottom: `${pos(v)}%` }}>{i === last || data.valueLabels ? <span className="mm-chart__dot-label">{data.format(v)}</span> : null}</span>)}
          </div>
        )}
      </div>
      {data.series && data.series.length > 1 ? <div className="mm-chart__legend">{data.series.map((series, index) => <span key={series.id} data-series-index={index}>{series.label}</span>)}</div> : null}
      <figcaption ref={axisRef} className="mm-chart__axis" aria-hidden="true">
        {labels.map((label, i) => <span key={i} data-visible={String(Boolean(data.allLabels) || i === 0 || i === last)}>{label}</span>)}
      </figcaption>
    </figure>
  );
}

/* ---------- panel layout ---------- */
export interface RowData { readonly id: string; readonly name: string; readonly value?: string; readonly sub?: string; /** D-333: a third caption line that only large cards fill (it is hidden with the other sub text when it does not fit). */ readonly detail?: string; readonly badge?: ReactNode; readonly semanticValue?: string | number | boolean | null }
export interface PanelSpec {
  readonly slot: FeatureId;
  readonly label: string;
  readonly value: string;
  readonly semanticValue?: string | number | boolean | null;
  readonly unit?: string;
  readonly unitPlacement?: 'before' | 'after';
  /** The value is a sentence (e.g. 원가 확인 필요), not a number: no MetricFit. */
  readonly textValue?: boolean;
  /** DS 12.14.3: a value-replacing sentence uses the kit state layout, with no label/K/unit. */
  readonly state?: { readonly message: string; readonly tone: 'info' | 'warning'; readonly chip?: ReactNode };
  readonly sub?: string;
  readonly subSemanticValue?: string | number | boolean | null;
  readonly subEssential?: boolean;
  readonly fitOrder?: readonly FitPart[];
  readonly rows: readonly RowData[];
  readonly rowsTitle?: string;
  readonly chart?: ChartData;
  /** Right column of W shows the chart (else the rows). */
  readonly chartInW?: boolean;
  readonly status?: ReactNode;
  readonly permanent?: ReactNode;
  /** SCR-212 height budgets apply to this list (DS 12.14.4). */
  readonly limitRows?: boolean;
  /** Count units (건, items): the unit sits beside the number when it fits. */
  readonly inlineUnit?: boolean;
  /** Long row names: at 125% show 1 row in 1x2 (tightT) or 3 in x3 (tightL). */
  readonly tightT?: number;
  readonly tightL?: boolean;
}

export function Rows({ rows, title, slot, dropped, rowLimit }: { readonly rows: readonly RowData[]; readonly title?: string; readonly slot: FeatureId; /** rows the model has but the size does not show (the sweep checks the free space) */ readonly dropped?: number; /** DS 12.14.4 height maximum, distinct from a fit-hidden row. */ readonly rowLimit?: number }) {
  if (rows.length === 0) return null;
  return (
    <div className="mm-rows-block">
      {title ? <p className="mm-rows-title" lang={copyLang(title)} data-slot={`${slot}.list.title`}>{title}</p> : null}
      <ul className="mm-rows" data-slot={`${slot}.list`} data-fit-dropped={dropped ? dropped : undefined} data-row-limit={rowLimit}>
        {rows.map((row) => (
          <li key={row.id} className="mm-row" data-slot={`${slot}.list.row`} data-row-id={row.id}>
            <span className="mm-row__text"><span className="mm-row__name" lang={copyLang(row.name)}>{row.name}</span>{row.sub ? <span className="mm-row__sub" lang={copyLang(row.sub)}><ValueSlot slotId={`${slot}.dashboard.row.${row.id}.sub`} featureId={slot} scope="dashboard" semanticValue={row.semanticValue === undefined ? row.sub : row.semanticValue}>{row.sub}</ValueSlot></span> : null}{row.detail ? <span className="mm-row__sub mm-row__detail" lang={copyLang(row.detail)}>{row.detail}</span> : null}</span>
            {row.badge ? <span className="mm-row__badge">{row.badge}</span> : null}
            {row.value ? <span className="mm-row__value" lang={copyLang(row.value)}><ValueSlot slotId={`${slot}.dashboard.row.${row.id}.value`} featureId={slot} scope="dashboard" semanticValue={row.semanticValue === undefined ? row.value : row.semanticValue}>{row.value}</ValueSlot></span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MoneyPanel({ spec, ctx, rowsInQ = false }: { readonly spec: PanelSpec; readonly ctx: SizeCtx; readonly rowsInQ?: boolean }) {
  const { shape } = ctx;
  // Offer the height's maximum, then drop only rows that cannot fit at their natural height.
  const budget = spec.limitRows ? rowBudget(ctx) : spec.rows.length;
  const rows = spec.rows.slice(0, budget);
  const metric = spec.textValue
    ? <span className="mm-text-value" lang={copyLang(spec.value)} data-slot={`${spec.slot}.metric.value`}>{spec.value}</span>
    : <span className="mm-value" lang={copyLang(spec.value + (spec.unit ?? ''))} data-slot={`${spec.slot}.metric.value`}><MetricFit value={spec.value} unit={spec.unit} unitPlacement={spec.unitPlacement} stacked={spec.inlineUnit || ctx.scale === 125 ? false : undefined} /></span>;
  const primary = (
    <div className="mm-primary" data-slot={`${spec.slot}.metric`} data-state={spec.state ? 'true' : undefined}>
      {spec.state ? <div className="mm-state" data-slot={`${spec.slot}.state`} lang={copyLang(spec.state.message)}><PanelState tone={spec.state.tone} shape={shape} message={spec.state.message}>{spec.state.chip ? <span className="mm-state-chip">{spec.state.chip}</span> : null}</PanelState></div> : <>
      <ValueSlot as="div" slotId={`${spec.slot}.dashboard.metric`} featureId={spec.slot} scope="dashboard" semanticValue={spec.semanticValue === undefined ? spec.value : spec.semanticValue}>{metric}</ValueSlot>
      <span className="mm-label" lang={copyLang(spec.label)} data-slot={`${spec.slot}.metric.label`}>{spec.label}</span>
      {spec.sub ? <span className={`mm-sub${spec.subEssential ? ' mm-sub--essential' : ''}`} lang={copyLang(spec.sub)} data-slot={`${spec.slot}.metric.secondary`}><ValueSlot slotId={`${spec.slot}.dashboard.secondary`} featureId={spec.slot} scope="dashboard" semanticValue={spec.subSemanticValue ?? spec.sub}>{spec.sub}</ValueSlot></span> : null}
      </>}
      {spec.permanent}
      {shape === 'S' || shape === 'L' ? spec.status : null}
      <FitProbe order={(shape === 'Q' || shape === 'W') ? (spec.fitOrder ?? MONEY_FIT).filter(part => part.selector !== '.mm-label') : spec.fitOrder ?? MONEY_FIT} deps={[ctx.scale, ctx.preset, ctx.width, ctx.height, spec.value, spec.sub, spec.rows.length]} />
    </div>
  );
  if (shape === 'Q') return <PanelBody width={ctx.width} height={ctx.height} primary={primary} />;
  const chartAllowed = Boolean(spec.chart) && (shape === 'S' || shape === 'L' || (shape === 'W' && spec.chartInW));
  const rowsAllowed = rows.length > 0 && !(shape === 'W' && spec.chartInW && chartAllowed);
  const shownRows = rows;
  return (
    <PanelBody
      width={ctx.width}
      height={ctx.height}
      primary={primary}
      chart={chartAllowed && spec.chart ? <MiniSeries data={{ ...spec.chart, allLabels: shape !== 'W' }} /> : undefined}
      list={rowsAllowed || rowsInQ ? <Rows rows={shownRows} title={shape === 'W' ? undefined : spec.rowsTitle} slot={spec.slot} dropped={spec.rows.length - shownRows.length} rowLimit={spec.limitRows ? budget : undefined} /> : undefined}
      secondary={shape === 'S' || shape === 'L' ? undefined : spec.status}
    />
  );
}

/* ---------- state views ---------- */
export function ViewState({ view, ctx, host, featureId, t }: {
  readonly view: { readonly status: 'empty' | 'error'; readonly messageKey: string; readonly actionKey?: string };
  readonly ctx: SizeCtx; readonly host: WidgetHost; readonly featureId: FeatureId; readonly t: T;
}) {
  const failed = view.status === 'error';
  const actionKey = failed ? 'data.action.retry' : view.actionKey;
  return (
    <div className="mm-state" lang={copyLang(t(view.messageKey))} data-slot={`${featureId}.state`}>
      <PanelState
        tone={failed ? 'error' : 'info'}
        shape={ctx.shape}
        message={t(view.messageKey)}
        action={actionKey ? { label: t(actionKey), widgetName: t(`widget.${featureId}.title`), onPress: () => host.resetPreview() } : undefined}
      />
    </div>
  );
}

/** Notes of a partial/special ready view (e.g. 일부 소식을 불러오지 못했어요) as a warning line. */
export function NoteLine({ notes, t }: { readonly notes?: readonly { readonly messageKey: string; readonly params?: Readonly<Record<string, string | number>> }[]; readonly t: T }) {
  if (!notes || notes.length === 0) return null;
  const message = notes.map((n) => t(n.messageKey, n.params)).join('\u00A0· ');
  return <span className="mm-note" lang={copyLang(message)} role="status"><StatusBadge kind="needsReview" label={message} /></span>;
}

/* ---------- commands ---------- */
/** Dispatches a data command and reports the result through the host (success with undo token, or an error notice). */
/** `answeredInline`: refusal reasons the caller shows next to the form itself (no extra error toast). */
export function useRunCommand(host: WidgetHost): (command: DataCommand, notice?: { messageKey: string; params?: Readonly<Record<string, string | number>> }, answeredInline?: readonly string[]) => DataCommandResult {
  const dispatch = useDataDispatch();
  return (command, notice, answeredInline) => {
    const result = dispatch(command);
    if (result.ok) {
      if (notice || result.noticeKey) host.notify({ kind: 'success', messageKey: notice?.messageKey ?? result.noticeKey!, ...((notice?.params ?? result.params) ? { params: notice?.params ?? result.params } : {}), ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
    } else if (!(result.reason && answeredInline?.includes(result.reason))) {
      host.notify({ kind: 'error', messageKey: result.messageKey });
    }
    return result;
  };
}

export function Kpi({ slot, label, value, unit, tone, semanticValue, details }: {
  readonly slot: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly tone?: 'warning';
  readonly semanticValue?: string | number | boolean | null;
  readonly details?: ReactNode;
}) {
  return (
    <div className={details ? 'mm-kpi mm-kpi--with-details' : 'mm-kpi'} data-slot={slot} data-tone={tone}>
      <span className="mm-kpi__value"><ValueSlot slotId={`${slot}.detail.value`} featureId={slot.split('.')[0] as FeatureId} scope="detail" semanticValue={semanticValue === undefined ? value : semanticValue}><MetricFit value={value} unit={unit} presentation="hero"/></ValueSlot></span>
      <span className="mm-kpi__label" lang={copyLang(label)}>{label}</span>
      {details}
    </div>
  );
}

/** Period labels shared by ledger and margin detail chips. */
export const PERIOD_KEYS = { today: 'format.period.today', last7: 'format.period.last7', last30: 'format.period.last30', month: 'format.period.thisMonth' } as const;

/** Detail-sized empty/error view: sentence plus the one retry action (resets only this widget's sample state). */
export function DetailViewState({ view, host, t, nextAction }: { readonly view: { readonly status: 'empty' | 'error'; readonly messageKey: string; readonly actionKey?: string }; readonly host: WidgetHost; readonly t: T; /** The widget's own next step for an empty view that has no data action (H1: a state sentence always comes with what to do next). */ readonly nextAction?: { readonly label: string; readonly onPress: () => void } }) {
  const failed = view.status === 'error';
  const actionKey = failed ? 'data.action.retry' : view.actionKey;
  return (
    <div className="mm-detail-state" lang={copyLang(t(view.messageKey))} data-tone={failed ? 'error' : 'info'}>
      <p className="mm-detail-state__text" role={failed ? 'alert' : 'status'}><Icon name={failed ? 'error' : 'info'} />{t(view.messageKey)}</p>
      {actionKey ? <ActionButton variant="outline" onClick={() => host.resetPreview()}>{t(actionKey)}</ActionButton> : nextAction ? <ActionButton variant="outline" onClick={nextAction.onPress}>{nextAction.label}</ActionButton> : null}
    </div>
  );
}
