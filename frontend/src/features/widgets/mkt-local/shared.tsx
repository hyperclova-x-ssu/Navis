/** Shared pieces of the mkt-local widgets: translator, state views, panel row budget, small badges. No fixed colors or sizes (tokens in widget.css). */
import { useMemo, type ReactNode } from 'react';
import { FitProbe, koreanLang, keepKoreanDots, type FitPart } from './fit';
import { useBundle, type Translator } from '../../../i18n';
import { dataBundle } from '../../../data/messages';
import { TODAY } from '../../../data/widget-data';
import { resolveDataText } from '../../../data/text';
import type { DataText } from '../../../data/db/types';
import type { CellSpan, ContentShape, FeatureId, WidgetHost } from '../../../contracts';
import { ActionButton, Icon, MetricFit, PanelState, useUi, type IconName } from '../../../ui';
import { mktLocalBundle } from './messages';
import './widget.css';

export type { Translator };
export function useT(): Translator {
  const tr = useBundle(dataBundle, mktLocalBundle) as unknown as Translator;
  return useMemo(() => tr.locale === 'ko' ? { ...tr, t: (key, params) => keepKoreanDots(tr.t(key, params)) } : tr, [tr]);
}
export const text = (t: Translator, value: DataText | null | undefined): string => resolveDataText((key, params) => t.t(key, params), value);

/** `2026-11-17T15:45` → `오늘 15:45` (today) or `11/18(수) 09:12`: the kit formatter, the one place that writes a date and a time (DS 6.1). Param `{at}`. */
export function dateTime(t: Translator, iso: string): { readonly at: string } {
  return { at: t.format.dateTime(iso, { today: TODAY }) };
}

/** A data text that is only an ISO date (the generated snapshot uses the start date as its “when” label) says nothing a formatted date does not: skip it. */
export function labelOrNull(t: Translator, key: string): string | null {
  const label = t.t(key);
  return /^\d{4}-\d{2}-\d{2}/.test(label) ? null : label;
}

/** How many list rows fit under the key number (SCREENS 3.1 budget, fewer at 125% text). */
export function rowCapacity(shape: ContentShape, height: CellSpan, textScale: 100 | 125): number {
  const base = shape === 'W' ? 2 : shape === 'T' ? [0, 0, 2, 4, 6][height] : shape === 'S' ? 3 : 5;
  return Math.max(1, textScale === 125 ? base - 1 : base);
}

interface ViewLike { readonly status: 'ready' | 'empty' | 'error'; readonly variant: string; readonly messageKey?: string; readonly actionKey?: string }

/** DS 11.5 state: icon, one sentence, at most one action. Retry / connect → `host.resetPreview()`; browse → the widget's own browse tab. */
export function stateAction(t: Translator, id: FeatureId, view: ViewLike, host: WidgetHost): { readonly label: string; readonly widgetName: string; readonly onPress: () => void } | undefined {
  const widgetName = t.t(`widget.${id}.title`);
  if (view.status === 'error') return { label: t.t('common.retry'), widgetName, onPress: () => host.resetPreview() };
  if (view.status === 'empty' && view.actionKey) {
    const open = view.actionKey === 'data.action.browseOffers';
    return { label: t.t(view.actionKey), widgetName, onPress: () => (open ? host.openDetail({ featureId: id, view: 'browse' }) : host.resetPreview()) };
  }
  return undefined;
}

export function PanelStateView({ id, view, shape, width, host }: { readonly id: FeatureId; readonly view: ViewLike; readonly shape: ContentShape; readonly width: number; readonly host: WidgetHost }) {
  const t = useT();
  const tone = view.status === 'error' ? 'error' : view.variant.includes('disconnected') || view.variant.includes('unsupported') ? 'warning' : 'info';
  const message = t.locale === 'ko' && id === 'community' && view.variant === 'none' ? t.t('widget.community.state.none') : t.locale === 'ko' && id === 'ai-response' && view.variant === 'channel-disconnected' ? t.t('widget.ai-response.state.disconnected.short') : t.t(view.messageKey ?? '');
  const shortMessage = view.status === 'error'
    ? t.t('widget.local.state.error.short')
    : id === 'ai-response' && view.variant === 'channel-disconnected' ? t.t('widget.ai-response.state.disconnected.short') : undefined;
  return (
    <div className="mkt-state" data-slot={`${id}.state.message`}>
      <PanelState tone={tone} shape={shape} message={t.locale === 'ko' && view.status === 'error' && (shape === 'Q' || (shape === 'W' && width <= 2)) ? t.t('widget.local.state.error.short') : t.locale === 'ko' ? message.replace(/ · /g, '\u00a0·\u00a0') : message} shortMessage={shortMessage} action={stateAction(t, id, view, host)} />
    </div>
  );
}

export function DetailState({ id, view, host, extra }: { readonly id: FeatureId; readonly view: ViewLike; readonly host: WidgetHost; readonly extra?: ReactNode }) {
  const t = useT();
  const action = stateAction(t, id, view, host);
  const error = view.status === 'error';
  const message = t.locale === 'ko' && id === 'community' && view.variant === 'none' ? t.t('widget.community.state.none') : t.locale === 'ko' && id === 'ai-response' && view.variant === 'channel-disconnected' ? t.t('widget.ai-response.state.disconnected.short') : t.t(view.messageKey ?? '');
  const icon: IconName = error ? 'error' : view.variant.includes('disconnected') ? 'warning' : 'info';
  return (
    <div className="mkt-detail-state" data-tone={error ? 'error' : 'info'} data-frame={id === 'local-changes' || id === 'local-trends' ? 'compact' : 'large'} data-slot={`${id}.state.message`}>
      {extra}
      <p className="mkt-detail-state__message" role={error ? 'alert' : 'status'}><Icon name={icon} aria-hidden />{message}</p>
      {action ? <ActionButton data-slot={`${id}.state.action`} onClick={action.onPress}>{action.label}</ActionButton> : null}
    </div>
  );
}

/** Drop order when the panel content does not fit (SCREENS 3.1): supporting line, then the label. */
const FIT_ORDER: readonly FitPart[] = [{ selector: '.mkt-panel-note' }, { selector: '.mkt-secondary' }, { selector: '.mkt-row__sub' }, { selector: '.mkt-row', last: true }];

/** Label, key number (MetricFit, never shrunk) and an optional supporting line. The line is the first thing to go at 125% text in Q. */
export function PrimaryMetric({ id, label, value, unit, longest, secondary, shape, note }: { readonly id: FeatureId; readonly label: string; readonly value: string; readonly unit: string; readonly longest?: string; readonly secondary?: string | null; readonly shape: ContentShape; /** DS 19.3: the 1×1 shows number + label only; this supporting phrase stays in the reading order for assistive technology. */ readonly note?: string }) {
  const { textScale } = useUi();
  const showSecondary = secondary && !(textScale === 125 && (shape === 'Q' || shape === 'W'));
  return (
    <div className="mkt-primary">
      <div data-slot={`${id}.metric.value`}><MetricFit value={value} unit={unit} longest={longest ?? value} stacked={shape === 'Q' && (textScale === 125 || Array.from(unit).length > 2) ? false : undefined} minStage={textScale === 125 && (shape === 'Q' || shape === 'W') ? 1 : 0} /></div>
      <p className="mkt-label" lang={koreanLang(label)} data-slot={`${id}.metric.label`}>{label}</p>
      {showSecondary ? <p className="mkt-secondary" lang={koreanLang(secondary)} data-slot={`${id}.metric.secondary`}>{secondary}</p> : null}
      {note && shape === 'Q' ? <p className="ui-sr-only" lang={koreanLang(note)} data-slot={`${id}.metric.note`}>{note}</p> : null}
      <FitProbe order={FIT_ORDER} deps={[textScale, shape, value, secondary]} />
    </div>
  );
}

export function MetaLine({ children }: { readonly children: ReactNode }) {
  return <p className="mkt-meta">{children}</p>;
}

/**
 * The panel's one FitProbe owns row visibility, after supporting text and before the label.
 * Keep every candidate mounted so resize, font and edit round trips can restore it.
 */
export function FitList({ items, label, slot }: { readonly items: readonly ReactNode[]; readonly resetKey: string; readonly label: string; readonly slot: string }) {
  return <ul className="mkt-rows" data-slot={slot} aria-label={label}>{items}</ul>;
}
