import {useEffect, useRef, useState} from 'react';
import {SAMPLE_START_TIME, VIDEO_URL, mockCctvView, pickFrame} from '../../../data/cctv';
import type {CctvView, DetectionFrame} from '../../../data/cctv';
import {drawBoxes} from './drawBoxes';
import {PANEL_OVERLAY} from './overlayLayout';
import type {OverlayOptions} from './overlayLayout';
import {useDetections} from './useDetections';
import {usePictureRect} from './usePictureRect';
import {useRunning} from './useRunning';

type VideoEl = HTMLVideoElement & {requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (n: number) => void};
const SIZE = {width: 960, height: 540} as const;

export interface PanelVideoProps {
  /** Default = persons only (board panel). */
  readonly overlay?: OverlayOptions;
  /** Editing / dragging / resizing / detail open: the video holds its frame (M-23). */
  readonly paused?: boolean;
  /** Reduced motion: hold the sample's reference frame. */
  readonly reducedMotion?: boolean;
  /** Called when the video cannot be used, so the panel can fall back to numbers only. */
  readonly onFail?: () => void;
  /** Called with the view that is on screen (so the panel's number band can use it). */
  readonly onView?: (view: CctvView) => void;
}

/** API-13 v4.1/v4.2: silent looping video + thin boxes (persons only by default). Numbers live in the panel's number band. */
export function PanelVideo({paused = false, reducedMotion = false, onFail, onView, overlay = PANEL_OVERLAY}: PanelVideoProps) {
  const {load} = useDetections();
  const file = load.status === 'ready' ? load.file! : null;
  const ref = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoEl>(null);
  const [ready, setReady] = useState(false);
  const [frame, setFrame] = useState<DetectionFrame | null>(null);
  const running = useRunning(ref);
  const frames = file?.frames;
  const rect = usePictureRect(ref, videoRef, file ?? SIZE, ready);

  const pick = () => {
    const v = videoRef.current;
    if (!v || !frames || !ready) return;
    const f = pickFrame(frames, v.currentTime);
    setFrame(prev => (prev === f ? prev : f)); // same frame: no redraw
  };

  const shouldPlay = ready && !reducedMotion && !paused && running;
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !ready) return;
    if (!shouldPlay) { v.pause(); return; }
    void v.play().catch(() => undefined);
    let id = 0;
    const rvfc = typeof v.requestVideoFrameCallback === 'function';
    const tick = () => { pick(); id = rvfc ? v.requestVideoFrameCallback!(tick) : requestAnimationFrame(tick); };
    tick();
    return () => { if (rvfc) v.cancelVideoFrameCallback?.(id); else cancelAnimationFrame(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldPlay, frames, ready]);
  // Held frame (reduced motion / paused) once the file arrives.
  useEffect(() => { if (ready && !shouldPlay) pick(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, frames, shouldPlay]);

  const view = file && frame ? mockCctvView(file, frame.t) : null;
  useEffect(() => { if (view) onView?.(view); }, [view?.inStore, view?.occupants]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMeta = () => {
    const v = videoRef.current!;
    if (reducedMotion && v.duration > SAMPLE_START_TIME) v.currentTime = SAMPLE_START_TIME;
    setReady(true);
  };

  return <div ref={ref} className="panel-video" aria-hidden="true" data-testid="panel-video">
    <video ref={videoRef} src={VIDEO_URL} className="panel-video__media" preload="metadata" muted loop playsInline
      onLoadedMetadata={onMeta} onSeeked={pick} onError={() => onFail?.()}/>
    {view ? drawBoxes(view, rect, overlay) : null}
  </div>;
}
