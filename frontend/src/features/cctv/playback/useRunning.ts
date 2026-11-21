import {useEffect, useState} from 'react';
import type {RefObject} from 'react';

/** False while the element is off screen or the page is hidden: playback pauses then (nobody sees it). */
export function useRunning(ref: RefObject<Element | null>): boolean {
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const on = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible && pageVisible;
}
