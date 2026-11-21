import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useBundle, useI18n, type Translator } from '../../../i18n';
import { dataBundles, resolveDataText } from '../../../data/widget-data';
import type { DataText } from '../../../data/widget-data';
import { Icon, StatusBadge, useUi } from '../../../ui';
import { mktPromoBundle } from './messages';
import { koreanLang, keepKoreanDots } from '../mkt-local/fit';

/** The widget's translator: common bundle + this folder's bundle + the data bundles (route names, scene captions, state texts). */
export function useT(): Translator<string> {
  const tr = useBundle(mktPromoBundle, ...dataBundles) as Translator<string>;
  return useMemo(() => tr.locale === 'ko' ? { ...tr, t: (key, params) => keepKoreanDots(tr.t(key, params)) } : tr, [tr]);
}

export const text = (t: Translator<string>, value: DataText | null | undefined): string => resolveDataText((key, params) => t.t(key, params), value);

const groupFmt = new Intl.NumberFormat('en-US');
/** "62.4만 원" with one decimal ("41.0만 원") where the compact format has a 만 unit; small amounts stay as the full format. */
export function compactMoney(t: Translator<string>, won: number): string {
  const abs = Math.abs(Math.round(won));
  const sign = won < 0 ? '-' : '';
  if (abs < 10000) return t.t('format.money.compact', { sign, full: groupFmt.format(abs), big: 'no', n: '0' });
  return t.t('format.money.compact', { sign, full: groupFmt.format(abs), big: 'yes', n: (Math.round(abs / 1000) / 10).toFixed(1) });
}

/** ▲/▼ as a 12px icon and the size of the change; null for no change (colour never judges good or bad). */
export function DeltaText({ direction, children, className = '' }: { readonly direction: 'up' | 'down'; readonly children: ReactNode; readonly className?: string }) {
  return <span className={`mp-delta ${className}`} data-direction={direction}><Icon name={direction === 'up' ? 'caret-up' : 'caret-down'} aria-hidden /><span>{children}</span></span>;
}

/** Percent-point delta such as `▲4%p`: icon + `4%p`. */
export function ppDelta(t: Translator<string>, delta: { readonly value: number } | null | undefined): { readonly direction: 'up' | 'down'; readonly text: string } | null {
  if (!delta || delta.value === 0) return null;
  return { direction: delta.value > 0 ? 'up' : 'down', text: t.format.percentPoint(Math.abs(delta.value)) };
}
export function moneyDelta(t: Translator<string>, delta: { readonly value: number } | null | undefined): { readonly direction: 'up' | 'down'; readonly text: string } | null {
  if (!delta || delta.value === 0) return null;
  return { direction: delta.value > 0 ? 'up' : 'down', text: compactMoney(t, Math.abs(delta.value)) };
}

const FLASH_MS = 800;
/**
 * M-27: a changed value gets a soft highlight for 800ms. Values are replaced in the same frame (no count-up);
 * the highlight is an opacity-only overlay (a still tint under reduced motion). The first render never flashes.
 */
export function Flash({ watch, children, className = '' }: { readonly watch: string | number; readonly children: ReactNode; readonly className?: string }) {
  const previous = useRef(watch);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (previous.current === watch) return undefined;
    previous.current = watch;
    setOn(true);
    const timer = window.setTimeout(() => setOn(false), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [watch]);
  return <span className={`mp-flash ${className}`} data-flash={on ? 'true' : undefined}>{children}</span>;
}

/** Text scale and preset the layout rules of D-65 depend on. */
export function useFit() {
  const ui = useUi();
  const { locale } = useI18n();
  return { textScale: ui.textScale, presetId: ui.screenPreset.id, locale, reduced: ui.reducedMotion, large: ui.textScale === 125 };
}

interface StateNote { readonly messageKey: string; readonly params?: Readonly<Record<string, string | number>> }
/**
 * 일부 자료 없음 note (DS 11.11a): StatusBadge '확인 필요' plus the sentence when the shape has room (`mode` 'full'); 'badge' keeps only the
 * badge and 'sr' only the screen-reader sentence, so a short panel never pushes its one button out.
 */
export function NoteLine({ notes, mode, slot }: { readonly notes: readonly StateNote[] | undefined; readonly mode: 'full' | 'badge' | 'sr'; readonly slot: string }) {
  const t = useT();
  if (!notes || notes.length === 0) return null;
  const sentence = notes.map((note) => t.t(note.messageKey, note.params)).join(' ');
  if (mode === 'sr') return <span className="ui-sr-only" lang={koreanLang(sentence)} data-slot={slot}>{sentence}</span>;
  if (mode === 'badge') return <p className="mp-note" data-slot={slot}><StatusBadge kind="needsReview" /><span className="ui-sr-only" lang={koreanLang(sentence)}>{sentence}</span></p>;
  return <p className="mp-note" data-slot={slot}><StatusBadge kind="needsReview" /> <span lang={koreanLang(sentence)}>{sentence}</span></p>;
}
