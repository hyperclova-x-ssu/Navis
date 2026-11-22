/** One fit transaction per marketing panel. Every measurement starts with the complete content. */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { runFit, type FitPart } from '../mgmt-money/fit';
import type { CellSpan, ContentShape } from '../../../contracts';

export type { FitPart };
export const keepKoreanDots = (value: string): string => value.replace(/[ \u00a0]·[ \u00a0]/g, '\u00a0·\u00a0');
/** D-333: the 4-high wide/tall cards (2×4 … 4×4) list the real rows beyond the small-size budget and re-show the columns the small sizes drop. */
export const isLargeCard = (shape: ContentShape, height: CellSpan | number): boolean => shape === 'L' && height >= 4;
export const koreanLang = (value: string): 'ko' | undefined => /\p{Script=Hangul}/u.test(value) ? 'ko' : undefined;

/** Observe the metric as well as its fixed-size frame: MetricFit and web fonts can settle after the parent effect. */
export function usePanelFit(ref: RefObject<HTMLElement | null>, fit: (content: HTMLElement) => void) {
  useLayoutEffect(() => {
    const content = ref.current?.closest<HTMLElement>('.ui-panel-content');
    if (!content) return undefined;
    let live = true;
    let first = 0;
    let second = 0;
    const run = () => { if (live) fit(content); };
    const settle = () => {
      run();
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      first = requestAnimationFrame(() => { second = requestAnimationFrame(run); });
    };
    settle();
    const panel = content.closest('.ui-feature-panel');
    const attrs = typeof MutationObserver === 'undefined' ? null : new MutationObserver(settle);
    attrs?.observe(panel ?? content, { attributes: true, attributeFilter: ['data-editing', 'data-selected', 'data-stage'], childList: true, characterData: true, subtree: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(settle);
    resize?.observe(content);
    for (const metric of content.querySelectorAll('.ui-metric-fit')) resize?.observe(metric);
    const fonts = document.fonts;
    void fonts?.ready.then(() => { if (live) settle(); });
    fonts?.addEventListener?.('loadingdone', settle);
    return () => {
      live = false;
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      attrs?.disconnect();
      resize?.disconnect();
      fonts?.removeEventListener?.('loadingdone', settle);
    };
  });
}

export function FitProbe({ order }: { readonly order: readonly FitPart[]; readonly deps?: readonly unknown[] }) {
  const ref = useRef<HTMLSpanElement>(null);
  usePanelFit(ref, content => { runFit(content, order); });
  return <span ref={ref} hidden data-fit-probe="" />;
}
