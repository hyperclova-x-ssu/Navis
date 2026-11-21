/**
 * T-063 panel fit guard (DS 11.3.3, SCREENS 3.1 drop order): after layout, while the panel content is taller or wider than its box,
 * the next part of `order` is hidden (`data-fit-hidden`, CSS: display none). A part is a selector; `last` hides one match at a time
 * from the end (list rows), the others hide every match. Text is never shrunk, clipped or ellipsized; the number, unit, title and
 * action are never in `order`. Without layout (tests) nothing is hidden. Shared by the T-063 widget folders.
 */
import { useLayoutEffect, useRef } from 'react';

/** A line never starts with the separator: the dot stays with the item before it (no-break space before it). */
export const keepDots = (text: string): string => text.replace(/ · /g, '\u00A0· ');

export interface FitPart { readonly selector: string; readonly last?: boolean }

/** Edit mode: the remove and resize buttons float over the content; text must not touch them (key numbers keep 8px). */
export function editClashCount(content: HTMLElement): number { return editClashElements(content).length; }

/** The elements whose text lines touch an edit-mode button (one entry per touching line). */
export function editClashElements(content: HTMLElement): Element[] {
  const panel = content.closest<HTMLElement>('.ui-feature-panel');
  if (!panel || panel.getAttribute('data-editing') !== 'true') return [];
  const buttons = Array.from(panel.querySelectorAll<HTMLElement>('.ui-panel-remove, .ui-panel-resize')).map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0);
  if (buttons.length === 0) return [];
  const found: Element[] = [];
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || !node.textContent?.trim() || el.closest('[data-fit-hidden], [hidden], .ui-sr-only, [inert], [data-hidden="true"]')) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const badge = el.closest('.ui-status-badge, .ui-status-chip');
    const gap = el.closest('.ui-metric-fit, .mm-text-value') || badge ? 8 : 1;
    for (const line of badge ? [badge.getBoundingClientRect()] : Array.from(range.getClientRects())) {
      if (line.width === 0) continue;
      for (const b of buttons) {
        if (line.left < b.right + gap && line.right > b.left - gap && line.top < b.bottom + gap && line.bottom > b.top - gap) found.push(el);
      }
    }
  }
  return found;
}

/**
 * How much is still wrong with a panel's content (0 = fits): vertical and horizontal overflow of the box and of its root, a slot that spills onto the slot
 * below it in the same column, and edit-button clashes. A slot that only outgrows its own grid cell with free room below is not counted.
 */
export function fitScore(content: HTMLElement, slack = 1): number {
  const slots = Array.from(content.querySelectorAll<HTMLElement>('.ui-panel-body > div'));
  let spill = 0;
  const boxes = slots.map((slot) => ({ slot, rect: slot.getBoundingClientRect() })).filter(({ rect }) => rect.height > 0);
  for (const a of boxes) {
    // Rectangles include the dashboard and fly-in transforms; scrollHeight does not.
    const scaleY = a.slot.clientHeight > 0 ? a.rect.height / a.slot.clientHeight : 1;
    const bottom = a.rect.top + a.slot.scrollHeight * scaleY;
    for (const b of boxes) {
      if (a === b || b.rect.top <= a.rect.top || b.rect.left >= a.rect.right - 1 || b.rect.right <= a.rect.left + 1) continue;
      spill += Math.max(0, bottom - b.rect.top - 1);
    }
  }
  let roots = 0;
  for (const child of Array.from(content.children)) if (child instanceof HTMLElement && child.clientHeight > 0) roots += Math.max(0, child.scrollHeight - child.clientHeight - slack);
  return Math.max(0, content.scrollHeight - content.clientHeight - slack) + Math.max(0, content.scrollWidth - content.clientWidth - 1) + roots + spill + 1000 * editClashCount(content);
}

export function runFit(content: HTMLElement, order: readonly FitPart[], slack = 1): number {
  // Every pass starts from the full layout, including after a metric's font stage settles.
  for (const el of Array.from(content.querySelectorAll<HTMLElement>('[data-fit-hidden]'))) el.removeAttribute('data-fit-hidden');
  // the 48px help button (edit mode: the remove button) ends at y 56; when the content box starts above that (100 % text, one-line title) the first line must start below it
  const help = content.closest('.ui-feature-panel')?.querySelector('.ui-help-button, .ui-panel-remove');
  if (help && content.clientHeight > 0) content.toggleAttribute('data-help-pad', false);
  if (help && content.clientHeight > 0 && content.getBoundingClientRect().top < help.getBoundingClientRect().bottom) content.setAttribute('data-help-pad', '');
  if (content.clientHeight === 0) return 0;
  const score = () => fitScore(content, slack);
  const initial = score();
  if (initial === 0) return 0;
  // 1. hide parts in the drop order until it fits
  const dropped: HTMLElement[] = [];
  let current = initial;
  for (const part of order) {
    if (current === 0) break;
    const matches = Array.from(content.querySelectorAll<HTMLElement>(part.selector)).filter((el) => !el.hasAttribute('data-fit-hidden') && !el.closest('[data-fit-hidden]'));
    for (const el of part.last ? matches.reverse() : matches) {
      if (current === 0) break;
      el.setAttribute('data-fit-hidden', '');
      dropped.push(el);
      current = score();
    }
  }
  // 2. dropping cannot fix it (a wide key number, a text the drop order does not cover): show everything again rather than removing parts for nothing
  if (current >= initial) { for (const el of dropped) el.removeAttribute('data-fit-hidden'); return 0; }
  // 3. give back what was not needed: the most important dropped parts first, while the result stays as good
  for (let i = dropped.length - 1; i >= 0; i -= 1) {
    const el = dropped[i]!;
    el.removeAttribute('data-fit-hidden');
    if (score() > current) el.setAttribute('data-fit-hidden', '');
  }
  const hidden = content.querySelectorAll('[data-fit-hidden]').length;
  return hidden;
}

/** Render `<FitProbe order={...} />` inside the panel body; it fits the surrounding `.ui-panel-content`. */
export function FitProbe({ order, deps = [], slack = 1 }: { readonly order: readonly FitPart[]; readonly deps?: readonly unknown[]; readonly slack?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const key = order.map((p) => `${p.selector}${p.last ? '!' : ''}`).join('|');
  useLayoutEffect(() => {
    const content = ref.current?.closest<HTMLElement>('.ui-panel-content');
    if (!content) return undefined;
    const run = () => { runFit(content, order, slack); };
    run();
    const panel = content.closest<HTMLElement>('.ui-feature-panel');
    const attrs = typeof MutationObserver === 'undefined' || !panel ? null : new MutationObserver(run);
    if (panel) attrs?.observe(panel, { attributes: true, attributeFilter: ['data-editing', 'data-selected', 'data-width', 'data-height', 'data-shape'] });
    // MetricFit commits its stage after the parent's layout effect / ResizeObserver callback.
    // The fixed-height content box does not resize when that number becomes shorter, so observe
    // the committed stage too. Fit's own data-fit-hidden writes are deliberately excluded.
    attrs?.observe(content, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-stage'] });
    const root = content.closest('.ui-root');
    if (root) attrs?.observe(root, { attributes: true, attributeFilter: ['data-text-scale', 'data-screen-preset'] });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(run);
    observer?.observe(content);
    let live = true;
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    const onFonts = () => { if (live) run(); };
    void fonts?.ready.then(onFonts);
    fonts?.addEventListener?.('loadingdone', onFonts);
    return () => { live = false; attrs?.disconnect(); observer?.disconnect(); fonts?.removeEventListener?.('loadingdone', onFonts); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, slack, ...deps]);
  return <span ref={ref} hidden data-fit-probe="" />;
}
