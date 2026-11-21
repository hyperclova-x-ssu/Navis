import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {RefObject} from 'react';
import type {CctvView} from '../../../data/cctv';
import {useBundle} from '../../../i18n';
import {useUi} from '../../../ui';
import {cctvBundle} from '../messages';
import {drawBoxes} from '../playback/drawBoxes';
import {PanelVideo} from '../playback/PanelVideo';
import type {OverlayOptions, OverlayRect} from '../playback/overlayLayout';
import '../playback/playback.css';
import './setup.css';

export interface CctvStageProps {
  readonly view: CctvView;
  readonly overlay: OverlayOptions;
  readonly variant: 'panel' | 'detail';
}

/** Size of an element, kept up to date (the overlay is drawn in the live picture's pixels). */
function useBoxSize(ref: RefObject<HTMLElement | null>): OverlayRect {
  const [r, setR] = useState<OverlayRect>({x: 0, y: 0, width: 0, height: 0});
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = () => setR({x: 0, y: 0, width: el.clientWidth, height: el.clientHeight});
    m();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return r;
}

/** The newest live frame on a canvas (no overlay). Also the still picture under the zone editor. */
export function LiveCanvas({view, label}: {readonly view: CctvView; readonly label?: string}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const f = view.frame && view.frame.kind === 'bitmap' ? view.frame : null;
  useEffect(() => {
    const c = ref.current;
    if (!c || !f) return;
    try {
      if (c.width !== f.w) c.width = f.w;
      if (c.height !== f.h) c.height = f.h;
      c.getContext('2d')?.drawImage(f.bitmap, 0, 0, f.w, f.h);
    } catch { /* the client already closed this bitmap: the next frame replaces it */ }
  }, [f]);
  return <canvas ref={ref} className="cs-canvas" width={f?.w ?? 16} height={f?.h ?? 9} role="img" aria-label={label} style={{aspectRatio: `${f?.w ?? 16} / ${f?.h ?? 9}`}} />;
}

function LiveStage({view, overlay, variant}: CctvStageProps) {
  const {t} = useBundle(cctvBundle);
  const box = useRef<HTMLDivElement>(null);
  const rect = useBoxSize(box);
  const s = view.stats;
  const hidden = view.connection === 'lost' || view.connection === 'server-down' || view.connection === 'none' || view.connection === 'waiting' || view.connection === 'phone-opened';
  const shown = !hidden && view.frame !== null;
  return <div className={`cctv-playback cs-stage cs-stage--${variant}`} data-testid="cctv-live-stage" data-connection={view.connection ?? undefined}>
    <div className="cs-picture" ref={box}>
      {shown ? <LiveCanvas view={view} label={t('cctv.a11y.video')} /> : <div className="cs-empty" style={{aspectRatio: '16 / 9'}} />}
      {shown ? drawBoxes(view, rect, overlay, t) : null}
      {view.connection === 'reconnecting' ? <span className="cs-chip" role="status">{t('cctv.conn.reconnecting')}</span> : null}
    </div>
    {shown && s && variant === 'detail' ? <p className="cs-stats" data-testid="cctv-stats">{t('cctv.conn.stats', {sec: (((s.e2eMs ?? s.latencyMs)) / 1000).toFixed(1), fps: Math.round(s.fps)})}</p> : null}
  </div>;
}

/** API-19.4: mock `<video>` + boxes, or the live bitmap + boxes. Draws a `CctvView`; boxes come from `drawBoxes` (T-071). */
export function CctvStage(props: CctvStageProps) {
  const {reducedMotion} = useUi();
  if (props.view.mode === 'mock') {
    return <div className={`cs-stage cs-stage--${props.variant}`} data-testid="cctv-mock-stage"><PanelVideo overlay={props.overlay} reducedMotion={reducedMotion} /></div>;
  }
  return <LiveStage {...props} />;
}
