/** Shared helpers of the mgmt-customers widgets: translator, overflow drop order, panel state, small bars. */
import { useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import type { FeatureId, WidgetHost, WidgetPanelProps } from '../../../contracts';
import { useBundle, type Translator } from '../../../i18n';
import { dataBundles } from '../../../data/widget-data';
import type { WidgetView } from '../../../data/models/types';
import { ActionButton, Icon, MetricFit, PanelBody, PanelState, panelShape, useUi } from '../../../ui';
import { customersBundle } from './messages';
import { editClashElements, fitScore, keepDots } from '../mgmt-money/fit';
import { ValueSlot } from './workspace';
import { textFitsBox } from './text-fit';
import './widgets.css';

/** Widget translator: this bundle + `data.*` (fake names, states, notices) + the common bundle. */
export function useT(): Translator {
  const tr = useBundle(customersBundle, ...dataBundles) as unknown as Translator;
  // data-bundle sentences carry ' · ' separators: keep each dot with the item before it
  return useMemo(() => ({ ...tr, t: (key: string, params?: Record<string, string | number>) => keepDots((tr.t as (k: string, p?: Record<string, string | number>) => string)(key, params)) }) as unknown as Translator, [tr]);
}

/**
 * Drop order (DS 11.3.3): never shrink text. Elements marked `data-drop="n"` are hidden, highest n first, until the root no longer
 * overflows. Equal n: key-block supporting lines go first, then later elements. Runs after every render, resize and font load.
 */
export function useFitDrop(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const run = () => {
      root.querySelectorAll<HTMLElement>('.ui-grade-bar li').forEach(el=>{el.dataset.drop='5.5';});
      const narrow = !!root.querySelector('.ui-panel-body[data-shape="Q"], .ui-panel-body[data-shape="W"]');
      const items = Array.from(root.querySelectorAll<HTMLElement>('[data-drop]')).filter(el => !(narrow && el.matches('.mc-kpi > .mc-label')));
      const summaries=Array.from(root.querySelectorAll<HTMLElement>('[data-more-template]'));
      const syncSummary=()=>{for(const el of summaries){const rows=Array.from(el.parentElement!.querySelectorAll<HTMLElement>('[data-fit-row]'));const n=rows.filter(row=>row.hidden).length;el.hidden=n===0||!rows.some(row=>!row.hidden);el.textContent=(el.dataset.moreTemplate??'').replace('__COUNT__',String(n));}};
      for (const item of items) item.hidden = false;
      // A narrow bar must keep its value/hour intact. Staff captions are optional as a group;
      // never wrap "people" into fragments that paint over the list below the chart.
      const staff = Array.from(root.querySelectorAll<HTMLElement>('.mc-bar__sub'));
      if (staff.some(el => el.clientWidth > 0 && !textFitsBox(el))) {
        staff.forEach(el => { el.hidden = true; });
      }
      const cells = Array.from(root.querySelectorAll<HTMLElement>('.ui-panel-body > div'));
      const ranked = items.map((el, index) => ({ el, index, rank: Number(el.dataset.drop), keySub: el.matches('.mc-kpi > .mc-sub') }))
        .sort((a, b) => b.rank - a.rank || Number(b.keySub) - Number(a.keySub) || b.index - a.index);
      const over = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
      const dropped: HTMLElement[] = [];
      const frame = root.closest<HTMLElement>('.ui-panel-content') ?? root;
      const fits = () => {syncSummary();return !over(root) && fitScore(frame) === 0;};
      for (let guard = 0; guard < items.length; guard += 1) {
        syncSummary();
        const clashing = editClashElements(root.closest<HTMLElement>('.ui-panel-content') ?? root);
        const rootOver = over(root) || clashing.length > 0;
        const overCells = cells.filter((cell) => cell.offsetParent !== null && over(cell));
        if (!rootOver && overCells.length === 0) break;
        // The primary block determines the height left for every other row. Follow the
        // global drop order even when only the chart/list cell currently overflows.
        const next = ranked.find(({ el }) => !el.hidden);
        if (!next) break;
        const group = next.el.dataset.fitGroup;
        const targets = group ? items.filter(el => el.dataset.fitGroup === group) : [next.el];
        for (const el of targets) { el.hidden = true; if (!dropped.includes(el)) dropped.push(el); }
      }
      // give back what was not needed (the most important dropped parts first): one part may have been dropped for a problem a later drop solved
      if (dropped.length > 0 && fits()) {
        for (let i = dropped.length - 1; i >= 0; i -= 1) {
          const el = dropped[i]!; const group = el.dataset.fitGroup;
          const targets = group ? items.filter(item => item.dataset.fitGroup === group) : [el];
          targets.forEach(item => { item.hidden = false; });
          if (!fits()) targets.forEach(item => { item.hidden = true; });
        }
      }
      syncSummary();
    };
    run();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(run);
    observer?.observe(root);
    let live = true;
    const fonts = document.fonts;
    const onFonts = () => { if (live) run(); };
    void fonts?.ready.then(onFonts);
    fonts?.addEventListener?.('loadingdone', onFonts);
    return () => { live = false; observer?.disconnect(); fonts?.removeEventListener?.('loadingdone', onFonts); };
  });
}

/** Drop ranks (higher goes first): supporting line, second line, rows, list title, label, chart (DS 11.3.3). */
export const DROP = { sub: 9, extra: 8, row: 6, listTitle: 5, label: 4, chart: 3 } as const;

export interface PanelFrameProps { readonly id: FeatureId; readonly children: ReactNode }
/** Root of every panel body: full height, overflow handled by the drop order. */
export function PanelFrame({ id, children }: PanelFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  useFitDrop(ref);
  return <div ref={ref} className="mc-root" data-slot={`${id}.card`} data-widget={id}>{children}</div>;
}

/** Splits a rendered "86건" / "86 visits" into the number text and its unit. */
export function splitUnit(rendered: string, numberText: string): { value: string; unit: string } {
  const at = rendered.indexOf(numberText);
  if (at < 0) return { value: numberText, unit: '' };
  return { value: numberText, unit: `${rendered.slice(0, at)}${rendered.slice(at + numberText.length)}`.trim() };
}

export interface KpiProps {
  readonly id: FeatureId;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly longest?: string;
  readonly sub?: ReactNode;
  /** New iteration-5 copy uses Korean line breaking even on en/zh screens (R-13). */
  readonly subLang?: 'ko';
  /** Second line of the supporting text, dropped first (DS 11.3.3). */
  readonly extra?: ReactNode;
  readonly labelDrop?: number;
  /** Drop rank of the supporting line (default DROP.sub: first to go). A warning that must outlast the label passes a lower rank. */
  readonly subDrop?: number;
}
/** Label (L) + key value with unit (K, MetricFit) + supporting line (S). */
export function Kpi({ id, label, value, unit, longest, sub, subLang, extra, labelDrop = DROP.label, subDrop = DROP.sub }: KpiProps) {
  const large = useUi().textScale === 125;
  return (
    <div className="mc-kpi">
      <div className="mc-value" data-slot={`${id}.metric.value`}><ValueSlot featureId={id} scope="dashboard" slotId={`${id}.dashboard.metric`} value={value}><MetricFit value={value} unit={unit} longest={longest ?? value} stacked={large ? false : undefined} /></ValueSlot></div>
      <p className="mc-label" data-slot={`${id}.metric.label`} data-drop={labelDrop}>{label}</p>
      {sub ? <p className="mc-sub" lang={subLang} data-slot={`${id}.metric.secondary`} data-drop={subDrop}><ValueSlot featureId={id} scope="dashboard" slotId={`${id}.dashboard.secondary`} value={typeof sub==='string'?sub:null}>{sub}</ValueSlot></p> : null}
      {extra ? <p className="mc-sub" data-drop={DROP.extra}>{extra}</p> : null}
    </div>
  );
}

/** Row: name on the left (up to two lines), value on the right (no wrap). */
export function Row({ id, rowId, name, value, note, drop = DROP.row }: { readonly id: FeatureId; readonly rowId: string; readonly name: ReactNode; readonly value?: ReactNode; readonly note?: ReactNode; readonly drop?: number }) {
  return (
    <li className="mc-row" data-slot={`${id}.list.row`} data-row-id={rowId} data-fit-row data-drop={drop}>
      <span className="mc-row__name">{name}{note ? <span className="mc-row__note">{note}</span> : null}</span>
      {value !== undefined ? <span className="mc-row__value">{value}</span> : null}
    </li>
  );
}

/** List with a caption title; rows are numbered for the drop order (later rows go first). */
export function ListBlock({ id, title, children }: { readonly id: FeatureId; readonly title?: string; readonly children: ReactNode }) {
  const t=useT();
  return (
    <div className="mc-list" data-slot={`${id}.list`}>
      {title ? <p className="mc-list__title" data-slot={`${id}.list.title`} data-drop={DROP.listTitle}>{title}</p> : null}
      <ul>{children}</ul>
      <p className="mc-caption" data-more-template={t.t('common.moreItems',{n:'__COUNT__'})} hidden/>
    </div>
  );
}

/** Bar columns with direct number labels (never colour alone). `marker` draws a shape above the bar; with `onSelect` each bar is a button. */
export interface BarItem { readonly key: string; readonly value: number | null; readonly label: string; readonly display: string; readonly sub?: string; readonly marker?: 'below' | 'review' | 'gap' | null; readonly tone?: 'a' | 'b' | 'peak'; readonly name?: string }
function Marker({ kind }: { readonly kind: 'below' | 'review' | 'gap' }) {
  return (
    <svg className="mc-bar__marker" data-marker={kind} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      {kind === 'below' ? <path d="M1 2h10L6 10z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /> : kind === 'review' ? <path d="M6 1l1.5 3.4 3.5.4-2.6 2.4.8 3.5L6 8.9 2.8 10.7l.8-3.5L1 4.8l3.5-.4z" fill="currentColor" /> : <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}
export function Bars({ items, max, label, height = 'auto', onSelect, selectedKey }: { readonly items: readonly BarItem[]; readonly max: number; readonly label: string; readonly height?: 'auto' | 'tall'; readonly onSelect?: (key: string) => void; readonly selectedKey?: string | null }) {
  const top = Math.max(1, max);
  const inner = (item: BarItem) => (
    <>
      <span className="mc-bar__display">{item.display}</span>
      <span className="mc-bar__track">
        {item.marker ? <Marker kind={item.marker} /> : null}
        {item.value === null ? <span className="mc-bar__fill mc-bar__fill--gap" aria-hidden="true" /> : <span className="mc-bar__fill" style={{ height: `${Math.max(item.value > 0 ? 4 : 0, (item.value / top) * 100)}%` }} />}
      </span>
      <span className="mc-bar__label">{item.label}</span>
      {item.sub !== undefined ? <span className="mc-bar__sub" data-drop={DROP.extra} data-fit-group="bar-sub">{item.sub}</span> : null}
    </>
  );
  return (
    <div className="mc-bars" role={onSelect ? 'group' : 'img'} aria-label={label} data-height={height}>
      {items.map((item) => onSelect
        ? <button type="button" className="mc-bar" key={item.key} data-bar-id={item.key} data-tone={item.tone ?? 'a'} data-gap={item.value === null ? 'true' : undefined} aria-pressed={selectedKey === item.key} aria-label={item.name ?? item.label} onClick={() => onSelect(item.key)}>{inner(item)}</button>
        : <div className="mc-bar" key={item.key} data-bar-id={item.key} data-tone={item.tone ?? 'a'} data-gap={item.value === null ? 'true' : undefined}>{inner(item)}</div>)}
    </div>
  );
}

/** Empty / error state of a panel (DS 11.5): icon + message (max 2 lines) + at most one action. */
export function StatePanel({ id, view, t, props }: { readonly id: FeatureId; readonly view: Exclude<WidgetView<unknown>, { status: 'ready' }>; readonly t: Translator; readonly props: Pick<WidgetPanelProps, 'width' | 'height' | 'host'> }) {
  const { host } = props;
  const shape = panelShape(props.width, props.height);
  const error = view.status === 'error';
  const actionKey = view.status === 'empty' ? view.actionKey : 'data.action.retry';
  return (
    <PanelFrame id={id}>
      <div className="mc-state" data-slot={`${id}.state.message`}>
        <PanelState tone={error ? 'error' : 'info'} shape={shape} message={t.t(view.messageKey)} action={actionKey ? { label: t.t(actionKey), widgetName: t.t(`widget.${id}.title`), onPress: () => { host.resetPreview(); if (!error && (id === 'menu' || id === 'members')) host.openDetail({ featureId: id, view: 'register', focus: 'action' }); } } : undefined} />
      </div>
    </PanelFrame>
  );
}

/** Wrapper that picks the slots by the cell shape: the panel decides the number of rows from the shape. */
export function Body({ props, primary, chart, list, secondary }: { readonly props: Pick<WidgetPanelProps, 'width' | 'height'>; readonly primary: ReactNode; readonly chart?: ReactNode; readonly list?: ReactNode; readonly secondary?: ReactNode }) {
  return <PanelBody width={props.width} height={props.height} primary={primary} chart={chart ? <div className="mc-chart-slot" data-drop={DROP.chart}>{chart}</div> : undefined} list={list} secondary={secondary} />;
}

/** Notifies the shell about a data command result (success with an undo token, or an error). */
export function reportResult(host: WidgetHost, result: { ok: boolean; noticeKey?: string; params?: Readonly<Record<string, string | number>>; undoToken?: string; messageKey?: string }): boolean {
  if (result.ok) {
    if (result.noticeKey) host.notify({ kind: 'success', messageKey: result.noticeKey, ...(result.params ? { params: result.params } : {}), ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
    return true;
  }
  if (result.messageKey) host.notify({ kind: 'error', messageKey: result.messageKey });
  return false;
}

/** Hours as "10, 11시"-like list text with the common hour-range format. */
export const hourList = (t: Translator, hours: readonly number[]): string => hours.map((h) => t.format.time(`${String(h).padStart(2, '0')}:00`)).join(', ');

/** Empty / error state inside a detail: message plus the one retry / connect action. */
export function DetailState({ id, view, t, host }: { readonly id: FeatureId; readonly view: Exclude<WidgetView<unknown>, { status: 'ready' }>; readonly t: Translator; readonly host: WidgetHost }) {
  const error = view.status === 'error';
  const actionKey = view.status === 'empty' ? view.actionKey : 'data.action.retry';
  return (
    <div className="mc-detail-state" data-slot={`${id}.state.message`} data-tone={error ? 'error' : 'info'}>
      <p role={error ? 'alert' : 'status'}>{t.t(view.messageKey)}</p>
      {actionKey ? <ActionButton variant="secondary" data-slot={`${id}.state.action`} onClick={() => { host.resetPreview(); if (!error && (id === 'menu' || id === 'members')) host.openDetail({ featureId: id, view: 'register', focus: 'action' }); }}>{t.t(actionKey)}</ActionButton> : null}
    </div>
  );
}

/** Soft note lines (`view.notes`) such as ‘일부 시간 미집계’, with the warning icon so colour is not the only cue. */
export function Notes({ notes, t }: { readonly notes?: readonly { readonly messageKey: string; readonly params?: Readonly<Record<string, string | number>> }[]; readonly t: Translator }) {
  if (!notes?.length) return null;
  return <ul className="mc-notes">{notes.map((n) => <li key={n.messageKey}><Icon name="warning" aria-hidden /><span>{t.t(n.messageKey, n.params)}</span></li>)}</ul>;
}
