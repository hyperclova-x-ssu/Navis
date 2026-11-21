import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ChangedValueSlot } from '../../../contracts';
import { useVisibleValueSlot } from '../../../ui/visible-slots';

/** Registers meaning only; the app chooses the six highlights and their lifetime. */
export function ValueSlot({ slotId, featureId, scope, semanticValue, children, as: Element = 'span' }: Omit<ChangedValueSlot, 'visible'> & { children: ReactNode; as?: 'span' | 'div' }) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  useVisibleValueSlot({ slotId, featureId, scope, semanticValue, visible });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const ancestors: HTMLElement[] = [];
    for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) ancestors.push(parent);
    const update = () => {
      const rect = node.getBoundingClientRect();
      if (!node.isConnected || rect.width <= 0 || rect.height <= 0) { setVisible(false); return; }
      let shown = true;
      let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
      for (const parent of ancestors) {
        const style = getComputedStyle(parent);
        if (parent.hidden || parent.hasAttribute('data-fit-hidden') || style.display === 'none' || style.visibility === 'hidden' || parent.getAttribute('aria-hidden') === 'true') shown = false;
        if (parent !== node && /auto|scroll|hidden|clip/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) {
          const clip = parent.getBoundingClientRect();
          left = Math.max(left, clip.left); right = Math.min(right, clip.right);
          top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
        }
      }
      setVisible(shown && right > Math.max(0, left) && bottom > Math.max(0, top) && left < window.innerWidth && top < window.innerHeight);
    };
    update();
    const mutations = new MutationObserver(update);
    for (const parent of ancestors) mutations.observe(parent, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-fit-hidden', 'data-editing', 'data-text-scale'] });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resize?.observe(node);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => { mutations.disconnect(); resize?.disconnect(); window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); };
  }, [slotId, semanticValue]);
  return <Element ref={node => { ref.current = node; }} className="ui-visible-value" data-slot-id={slotId}>{children}</Element>;
}
