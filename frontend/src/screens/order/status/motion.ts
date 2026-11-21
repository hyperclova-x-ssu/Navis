import { useLayoutEffect, useRef, type RefObject } from 'react';
import { managementTokens, motionTokens } from '../../../ui';

/** M-244. Domain publication stays synchronous; only an inert visual copy fades out. */
export function useStatusMotion(root: RefObject<HTMLDivElement | null>, ids: readonly string[], reduced: boolean) {
  const pending = useRef<{ positions: Map<string, number>; scale: number; leaving: boolean } | null>(null);
  const previous = useRef<{ positions: Map<string, number>; scale: number; leaving: boolean } | null>(null);
  const active = useRef<Animation[]>([]), ghosts = useRef<HTMLElement[]>([]);
  const clear = () => { active.current.forEach(animation => animation.cancel()); active.current = []; ghosts.current.forEach(node => node.remove()); ghosts.current = []; };
  const capture = (leavingId?: string) => {
    const host = root.current, area = host?.querySelector<HTMLElement>('.ui-data-grid__scroll');
    if (reduced || !host || !area) { clear(); return; }
    const bounds = host.getBoundingClientRect(), clip = area.getBoundingClientRect(), scale = host.offsetWidth ? bounds.width / host.offsetWidth : 1;
    if (!scale || !clip.height) return;
    const rows = [...host.querySelectorAll<HTMLElement>('.order-status__grid [data-grid-row]')];
    const visible = rows.map(node => ({ node, rect: node.getBoundingClientRect() })).filter(({ rect }) => rect.bottom > clip.top && rect.top < clip.bottom);
    if (visible.length > managementTokens.sortVisibleMax) { clear(); return; }
    const leaving = visible.find(({ node }) => node.dataset.gridRow === leavingId);
    const widths = leaving ? [...leaving.node.children].map(cell => (cell as HTMLElement).offsetWidth) : [];
    pending.current = { positions: new Map(visible.map(({ node, rect }) => [node.dataset.gridRow!, rect.top])), scale, leaving: !!leaving };
    // Reads above include the displayed positions of interrupted animations.
    clear();
    if (!leaving) return;
    const surface = document.createElement('div'), table = document.createElement('table'), body = document.createElement('tbody');
    surface.className = 'order-status__leaving ui-pos-order-grid'; surface.inert = true; surface.setAttribute('aria-hidden', 'true');
    Object.assign(surface.style, { left: `${(clip.left - bounds.left) / scale}px`, top: `${(clip.top - bounds.top) / scale}px`, width: `${clip.width / scale}px`, height: `${clip.height / scale}px` });
    const copy = leaving.node.cloneNode(true) as HTMLElement;
    copy.removeAttribute('id'); copy.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    [...copy.children].forEach((cell, index) => (cell as HTMLElement).style.width = `${widths[index]}px`);
    table.className = 'ui-data-grid__table';
    Object.assign(table.style, { position: 'absolute', tableLayout: 'fixed', left: `${(leaving.rect.left - clip.left) / scale}px`, top: `${(leaving.rect.top - clip.top) / scale}px`, width: `${leaving.rect.width / scale}px` });
    body.append(copy); table.append(body); surface.append(table); host.append(surface); ghosts.current.push(surface);
    const animation = surface.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: motionTokens.duration.rowOut, easing: `cubic-bezier(${motionTokens.ease.out.join(',')})`, fill: 'forwards' });
    if (animation) { active.current.push(animation); animation.finished?.then(() => surface.remove(), () => surface.remove()); } else surface.remove();
  };
  const order = ids.join('\0');
  useLayoutEffect(() => {
    const frame = pending.current ?? previous.current; pending.current = null;
    if (reduced || !root.current) { clear(); return; }
    const nodes = [...root.current.querySelectorAll<HTMLElement>('.order-status__grid [data-grid-row]')];
    for (const node of nodes) node.getAnimations?.().forEach(animation => animation.cancel());
    const bounds = root.current.getBoundingClientRect(), scale = root.current.offsetWidth ? bounds.width / root.current.offsetWidth : 1;
    const rows = nodes.map(node => ({ node, rect: node.getBoundingClientRect() }));
    previous.current = scale ? { positions: new Map(rows.map(({ node, rect }) => [node.dataset.gridRow!, rect.top])), scale, leaving: false } : null;
    if (!frame) return;
    for (const { node, rect } of rows) {
      const before = frame.positions.get(node.dataset.gridRow!);
      if (!node.animate) continue;
      if (before === undefined) { active.current.push(node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionTokens.duration.rowIn })); continue; }
      if (before === rect.top) continue;
      active.current.push(node.animate([{ transform: `translateY(${(before - rect.top) / frame.scale}px)` }, { transform: 'translateY(0px)' }], {
        duration: motionTokens.duration.sort, delay: frame.leaving ? motionTokens.duration.rowOut : 0, fill: 'backwards', easing: `cubic-bezier(${motionTokens.ease.inOut.join(',')})`,
      }));
    }
  }, [order, reduced]);
  useLayoutEffect(() => clear, []);
  return capture;
}
