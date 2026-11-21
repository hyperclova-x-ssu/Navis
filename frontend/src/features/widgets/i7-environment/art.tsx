import { useContext, useLayoutEffect, useRef } from 'react';
import { UiContext, useSystemPreferences } from '../../../ui/context';

/** R4 assets/i7 paths and view-box rotation centers, unchanged (DS 19.11). */
export function TurntableArt({ playing, detail = false }: { playing: boolean; detail?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const animationRef = useRef<Animation | null>(null);
  const ui = useContext(UiContext);
  const system = useSystemPreferences();
  const reducedMotion = Boolean(ui?.reducedMotion || system.reducedMotion);
  // A persistent WAAPI timeline keeps the current angle even when the detail is retained under [hidden].
  useLayoutEffect(() => {
    const disc = svgRef.current?.querySelector<SVGElement>('.tt-disc');
    if (!detail || reducedMotion || !disc?.animate) return;
    const animation = disc.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 1800, easing: 'linear', iterations: Infinity });
    animation.pause();
    animationRef.current = animation;
    return () => { animation.cancel(); animationRef.current = null; };
  }, [detail, reducedMotion]);
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg || !detail) return;
    const update = () => {
      const running = playing && !reducedMotion && document.visibilityState === 'visible' && !svg.closest('[hidden], [inert], [aria-hidden="true"]:not(svg)');
      const disc = svg.querySelector<SVGElement>('.tt-disc');
      if (disc) disc.dataset.spin = running ? 'running' : 'paused';
      if (running) animationRef.current?.play(); else animationRef.current?.pause();
    };
    update();
    document.addEventListener('visibilitychange', update);
    const observer = new MutationObserver(update);
    for (let node = svg.parentElement; node; node = node.parentElement) observer.observe(node, { attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden'] });
    return () => { document.removeEventListener('visibilitychange', update); observer.disconnect(); };
  }, [playing, detail, reducedMotion]);
  return <svg data-playing={playing || undefined} data-reduced-motion={reducedMotion || undefined} viewBox="0 0 240 200" width="240" height="200" aria-hidden="true" className="tt" ref={svgRef}>
  <rect x="4" y="4" width="232" height="192" rx="20" fill="var(--tt-plinth)" stroke="var(--tt-line)" strokeWidth="2"/>
  <circle cx="100" cy="100" r="88" fill="none" stroke="var(--tt-line)" strokeWidth="2"/>
  <g className="tt-disc">
    <circle cx="100" cy="100" r="84" fill="var(--tt-record)"/>
    <circle cx="100" cy="100" r="76" fill="none" stroke="var(--tt-groove)" strokeWidth="1"/>
    <circle cx="100" cy="100" r="67" fill="none" stroke="var(--tt-groove)" strokeWidth="1"/>
    <circle cx="100" cy="100" r="58" fill="none" stroke="var(--tt-groove)" strokeWidth="1"/>
    <circle cx="100" cy="100" r="44" fill="none" stroke="var(--tt-groove)" strokeWidth="1"/>
    <path d="M 46 62 A 66 66 0 0 1 82 37" fill="none" stroke="var(--tt-groove)" strokeWidth="3" strokeLinecap="round"/>
    <circle cx="100" cy="100" r="26" fill="var(--tt-label)"/>
    <rect x="98" y="78" width="4" height="12" rx="2" fill="var(--tt-ink)"/>
    <circle cx="100" cy="100" r="4" fill="var(--tt-ink)"/>
  </g>
  <circle cx="204" cy="40" r="14" fill="var(--tt-ink)" stroke="var(--tt-arm)" strokeWidth="2"/>
  <g className="tt-arm">
    <path d="M 204 40 L 204 140 L 197 154" fill="none" stroke="var(--tt-arm)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
    <rect x="189" y="150" width="14" height="18" rx="3" transform="rotate(25 196 159)" fill="var(--tt-arm)"/>
    <circle cx="204" cy="40" r="5" fill="var(--tt-arm)"/>
  </g>
  <circle cx="204" cy="176" r="7" fill="none" stroke="var(--tt-arm)" strokeWidth="2"/>
  <circle cx="26" cy="176" r="6" fill="var(--tt-arm)"/>
</svg>;
}

export function ThermometerIcon() { return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M14 14.6V4.5a2.5 2.5 0 0 0-5 0v10.1a4.5 4.5 0 1 0 5 0Z"/>
  <path d="M11.5 9.5v8"/>
  <circle cx="11.5" cy="18" r="1.6" fill="currentColor" stroke="none"/>
  <path d="M17.5 6h2.5M17.5 9.5h2.5M17.5 13h2.5"/>
</svg>; }

export function DropletIcon() { return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M12 3c-.3.4-6.5 7.3-6.5 11.5a6.5 6.5 0 0 0 13 0C18.5 10.3 12.3 3.4 12 3Z"/>
  <path d="M9 15a3 3 0 0 0 3 3"/>
</svg>; }
