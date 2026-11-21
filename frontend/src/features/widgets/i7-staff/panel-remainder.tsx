import { useLayoutEffect, useRef } from 'react';

/** Keep the existing fit guard's hidden rows represented by the SCR-271/276/279 remainder. */
export function PanelRemainder({ total, rowSelector, unit }: { total: number; rowSelector: string; unit: '명' | '건' }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const label = ref.current;
    const list = label?.parentElement;
    if (!label || !list) return;
    const update = () => {
      const visible = Array.from(list.querySelectorAll(rowSelector)).filter(row => !row.closest('[data-fit-hidden], [hidden]')).length;
      const remaining = Math.max(0, total - visible);
      const text = remaining ? `외 ${remaining}${unit}` : '';
      // FitProbe observes text mutations. Equal writes would trigger another fit of the same hidden rows.
      if (label.hidden !== (remaining === 0)) label.hidden = remaining === 0;
      if (label.textContent !== text) label.textContent = text;
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(list, { subtree: true, attributes: true, attributeFilter: ['data-fit-hidden'] });
    return () => observer.disconnect();
  }, [total, rowSelector, unit]);
  return <p ref={ref} className="i7-panel-remainder" hidden />;
}
