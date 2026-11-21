import {useLayoutEffect, useState} from 'react';
import type {RefObject} from 'react';
import {containRect} from '../../../data/cctv';
import type {OverlayRect} from './overlayLayout';

/** Real picture rectangle inside the box (object-fit: contain, letterbox excluded). `dep` re-measures when the video size becomes known. */
export function usePictureRect(box: RefObject<HTMLElement | null>, video: RefObject<HTMLVideoElement | null>, fallback: {width: number; height: number}, dep: unknown): OverlayRect {
  const [rect, setRect] = useState<OverlayRect>({x: 0, y: 0, width: 0, height: 0});
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => { const v = video.current; setRect(containRect(el.clientWidth, el.clientHeight, v?.videoWidth || fallback.width, v?.videoHeight || fallback.height)); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, video, fallback.width, fallback.height, dep]);
  return rect;
}
