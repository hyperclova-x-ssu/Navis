/**
 * Shared pieces of the mgmt-store widgets (T-050): translator, panel layout, state views,
 * command helper and the changed-value highlight (M-27).
 */
import type { ReactNode } from 'react';
import type { ContentShape, DetailRef, FeatureId, WidgetHost } from '../../../contracts';
import { useBundle, useI18n, type Translator } from '../../../i18n';
import { dataBundle, resolveDataText, type DataCommand, type DataCommandResult, type DataText } from '../../../data/widget-data';
import { useDataDispatch } from '../../../data/react';
import { managementBundle } from '../../../data/messages/management';
import { ActionButton, MetricFit, PanelBody, PanelState, useUi } from '../../../ui';
import { mgmtStoreBundle } from './messages';
import { FitProbe, type FitPart } from '../mgmt-money/fit';
import { ValueSlot } from '../mgmt-money/value-slot';
import './widget.css';

export type T = Translator<string>;

/** Common + mgmt-store + data bundles in the current language. */
export function useT(): T {
  return useBundle(mgmtStoreBundle, dataBundle, managementBundle) as unknown as T;
}

export const text = (t: T, value: DataText | null | undefined): string => resolveDataText((key, params) => t.t(key, params), value);

export type StoreWidgetId = 'manuals';

export function widgetName(t: T, id: FeatureId): string {
  return t.t(`widget.${id}.title`);
}

/** Weekday number (1 = Monday) to the short name key. */
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const weekdayShort = (t: T, weekday: number): string => t.t(`format.weekday.short.${WEEKDAY_KEYS[weekday - 1]}`);
export const weekdayLong = (t: T, weekday: number): string => t.t(`format.weekday.long.${WEEKDAY_KEYS[weekday - 1]}`);

/** Rows a list area can hold (SCR-30: A 3/5/7 by height, 125% text 2/4/5). */
export function useRowBudget(shape: ContentShape, height: number): number {
  const large = useUi().textScale === 125;
  if (shape === 'Q') return 0;
  if (shape === 'W') return 2;
  const table = large ? [2, 4, 5] : [3, 5, 7];
  return table[Math.min(Math.max(height - 2, 0), 2)] ?? 3;
}

/** Sends a data command and, on success, passes the result notice to the host. Reasons for failure stay with the caller. */
export function useRunCommand(host: WidgetHost): (command: DataCommand, options?: { readonly quiet?: boolean }) => DataCommandResult {
  const dispatch = useDataDispatch();
  return (command, options) => {
    const result = dispatch(command);
    if (result.ok && result.noticeKey && !options?.quiet) {
      host.notify({ kind: 'success', messageKey: result.noticeKey, ...(result.params ? { params: result.params } : {}), ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
    }
    return result;
  };
}

export interface PanelParts {
  readonly id: StoreWidgetId;
  readonly shape: ContentShape;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly value: string;
  readonly semanticValue?: number;
  readonly subSemanticValue?: number;
  readonly unit?: string;
  /** Longest value this widget can show here (fixes the MetricFit step). */
  readonly longest?: string;
  /** Caption under the key value (one line). */
  readonly sub?: string;
  /** The key value is words, not a number. */
  readonly textValue?: boolean;
  readonly chart?: ReactNode;
  readonly list?: ReactNode;
  readonly workspace?: ReactNode;
}

/** SCR-212: secondary text first, then list/chart, label last. Value and unit stay. */
export const STORE_FIT: readonly FitPart[] = [{ selector: '.mgmt-sub' }, { selector: '.mgmt-row__sub' }, { selector: '.mgmt-list__title' }, { selector: '.mgmt-row:not([data-row-id^="check-"])', last: true }, { selector: '.mgmt-row', last: true }, { selector: '.ui-panel-chart' }, { selector: '.mgmt-label' }];

/** Label, key value (MetricFit, text never shrinks below the kit steps), caption and the shape's other slots. */
export function PanelLayout({ id, width, height, label, value, semanticValue, subSemanticValue, unit, longest, sub, textValue, chart, list, workspace }: PanelParts) {
  const primary = (
    <div className="mgmt-primary" lang="ko" data-slot={`${id}.card`} data-text-value={textValue ? 'true' : undefined}>
      <div className="mgmt-value" data-slot={`${id}.metric.value`}><ValueSlot as="div" slotId={`${id}.dashboard.count`} featureId={id} scope="dashboard" semanticValue={semanticValue ?? value}><MetricFit value={value} unit={unit} longest={longest ?? value} stacked={false} /></ValueSlot></div>
      <p className="mgmt-label" data-slot={`${id}.metric.label`}>{label}</p>
      {sub ? <p className="mgmt-sub" data-slot={`${id}.metric.secondary`}><ValueSlot slotId={`${id}.dashboard.secondary`} featureId={id} scope="dashboard" semanticValue={subSemanticValue ?? sub}>{sub}</ValueSlot></p> : null}
    </div>
  );
  return <><PanelBody width={width} height={height} primary={primary} chart={chart} list={list} workspace={workspace} /><FitProbe order={height === 1 ? STORE_FIT.filter(part => part.selector !== '.mgmt-label') : STORE_FIT} slack={0} deps={[width, height, value, sub, label]} /></>;
}

export interface RowData { readonly id: string; readonly name: ReactNode; readonly value?: ReactNode; readonly sub?: ReactNode }

/** List rows ("name … value"), one line each; the value does not wrap. */
export function RowList({ slot, title, rows, label }: { readonly slot: StoreWidgetId; readonly title?: string; readonly rows: readonly RowData[]; readonly label?: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="mgmt-list" lang="ko" data-slot={`${slot}.list`}>
      {title ? <p className="mgmt-list__title" data-slot={`${slot}.list.title`}>{title}</p> : null}
      <ul className="mgmt-rows" aria-label={label ?? title}>
        {rows.map((row) => (
          <li key={row.id} className="mgmt-row" data-slot={`${slot}.list.row`} data-row-id={row.id}>
            <span className="mgmt-row__name">{row.name}{row.sub ? <span className="mgmt-row__sub">{row.sub}</span> : null}</span>
            {row.value !== undefined ? <span className="mgmt-row__value">{row.value}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface NotReady { readonly status: 'empty' | 'error'; readonly messageKey: string; readonly actionKey?: string }

/** Empty and error states of a panel: icon, sentence and at most one action (DS 11.5). */
export function StatePanel({ id, shape, view, host, open }: { readonly id: StoreWidgetId; readonly shape: ContentShape; readonly view: NotReady; readonly host: WidgetHost; readonly open?: DetailRef }) {
  const t = useT();
  const name = widgetName(t, id);
  const action = actionFor(view, host, open);
  return (
    <div className="mgmt-state" lang={/[가-힣]/u.test(t.t(view.messageKey)) ? 'ko' : undefined} data-slot={`${id}.state.message`}>
      <PanelState
        tone={view.status === 'error' ? 'error' : 'info'}
        shape={shape}
        message={t.t(view.messageKey)}
        action={action ? { label: t.t(action.labelKey), widgetName: name, onPress: action.run } : undefined}
      />
    </div>
  );
}

function actionFor(view: NotReady, host: WidgetHost, open?: DetailRef): { labelKey: string; run: () => void } | null {
  if (view.status === 'error') return { labelKey: 'common.retry', run: () => host.resetPreview() };
  if (view.actionKey === 'data.action.retry') return { labelKey: view.actionKey, run: () => host.resetPreview() };
  if (view.actionKey && open) return { labelKey: view.actionKey, run: () => { host.resetPreview(); host.openDetail(open); } };
  return null;
}

/** Empty or error state inside a detail: the sentence and the action as a normal button. */
export function DetailState({ view, host, onAction }: { readonly view: NotReady; readonly host: WidgetHost; readonly onAction?: () => void }) {
  const t = useT();
  const retry = view.status === 'error' || view.actionKey === 'data.action.retry';
  const labelKey = view.status === 'error' ? 'common.retry' : view.actionKey;
  const run = retry ? () => host.resetPreview() : onAction;
  // A load failure looks the same as in the other widgets' windows (매장 환경): the kit state with its warning icon, sentence and retry button.
  if (view.status === 'error') {
    return (
      <div className="mgmt-detail-state" lang={/[가-힣]/u.test(t.t(view.messageKey)) ? 'ko' : undefined}>
        <PanelState tone="error" message={t.t(view.messageKey)} />
        {run ? <ActionButton variant="secondary" onClick={run}>{t.t(labelKey ?? 'common.retry')}</ActionButton> : null}
      </div>
    );
  }
  return (
    <div className="mgmt-detail-state" lang={/[가-힣]/u.test(t.t(view.messageKey)) ? 'ko' : undefined} role="status">
      <p className="mgmt-detail-state__message">{t.t(view.messageKey)}</p>
      {labelKey && run ? <ActionButton variant="secondary" onClick={run}>{t.t(labelKey)}</ActionButton> : null}
    </div>
  );
}

/** Polite status line that screen readers read once when the text changes. */
export function Status({ children }: { readonly children?: ReactNode }) {
  return <p className="mgmt-status" role="status" aria-live="polite">{children}</p>;
}

export function useLocaleFormat() {
  return useI18n().format;
}

/** Splits "8개" / "8 items" into the number and its unit so MetricFit can print the unit in caption size. */
export function splitCount(format: ReturnType<typeof useI18n>['format'], n: number, unit: Parameters<ReturnType<typeof useI18n>['format']['count']>[1]): { value: string; unit: string } {
  const full = format.count(n, unit);
  const num = format.number(n);
  const rest = full.replace(num, '').trim();
  return { value: num, unit: rest };
}
