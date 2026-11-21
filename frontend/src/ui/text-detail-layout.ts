const bodySelector = '.detail-module-body:not([hidden] *)';
const headerSelector = '.ui-overlay-header';
const footerSelector = '.ui-overlay-note';
const pixels = (value: string) => Number.parseFloat(value) || 0;

/** Include content clipped by a widget's own scroll area in the natural height of the dialog. */
function hiddenScrollHeight(root: HTMLElement): number {
  let hidden = 0;
  for (const child of root.children) {
    if (!(child instanceof HTMLElement) || child.hidden) continue;
    const overflow = getComputedStyle(child).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && child.scrollHeight > child.clientHeight) {
      hidden += child.scrollHeight - child.clientHeight;
    } else {
      hidden += hiddenScrollHeight(child);
    }
  }
  return hidden;
}

/** Measure in canvas CSS pixels so the viewport transform and the opening animation don't affect the frame. */
export function naturalTextDetailHeight(surface: HTMLElement): number {
  const read = (selector: string) => {
    const node = surface.querySelector<HTMLElement>(selector);
    return node ? pixels(getComputedStyle(node).height) || node.scrollHeight : 0;
  };
  const style = getComputedStyle(surface);
  const header = surface.querySelector<HTMLElement>(headerSelector);
  const headerMinimum = header ? pixels(getComputedStyle(header).minHeight) : 0;
  const headerHeight = Math.max(headerMinimum, read('.ui-dialog-title'), read('.ui-button--icon'), read('.detail-exit-close'));
  const chrome = pixels(style.paddingTop) + pixels(style.paddingBottom) + pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
  const footerHeight = read(footerSelector);
  const gap = pixels(style.rowGap || style.gap);
  const body = surface.querySelector<HTMLElement>(bodySelector);
  return chrome + headerHeight + gap + read(bodySelector) + (body ? hiddenScrollHeight(body) : 0) + (footerHeight > 0 ? gap + footerHeight : 0);
}

/** Follow layout and content changes, including overflow changes inside a fixed-height scrolling body. */
export function observeTextDetailHeight(surface: HTMLElement, onHeight: (height: number) => void): () => void {
  let frame: number | undefined;
  const watched = new Set<Element>();
  const measure = () => {
    const next = new Set(surface.querySelectorAll(`${headerSelector}, ${bodySelector}, ${footerSelector}`));
    for (const node of watched) {
      if (next.has(node)) continue;
      sizes?.unobserve(node);
      watched.delete(node);
    }
    for (const node of next) {
      if (watched.has(node)) continue;
      sizes?.observe(node);
      watched.add(node);
    }
    onHeight(naturalTextDetailHeight(surface));
  };
  const schedule = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      measure();
    });
  };
  const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  const contents = new MutationObserver(schedule);
  contents.observe(surface, { subtree: true, childList: true, characterData: true, attributeFilter: ['hidden', 'open'] });
  measure();
  return () => {
    sizes?.disconnect();
    contents.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
