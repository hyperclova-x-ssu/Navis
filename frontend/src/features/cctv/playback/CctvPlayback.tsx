import {useCallback, useEffect, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {DETECTIONS_URL, SAMPLE_START_TIME, VIDEO_URL, formatClock, pickFrame} from '../../../data/cctv';
import type {DetectionFrame} from '../../../data/cctv';
import {useBundle} from '../../../i18n';
import {useUi} from '../../../ui';
import {cctvBundle} from '../messages';
import {NowNumbers} from './NowNumbers';
import {StayCharts} from './StayCharts';
import {drawBoxes} from './drawBoxes';
import {FULL_OVERLAY} from './overlayLayout';
import {usePictureRect} from './usePictureRect';
import {useDetections} from './useDetections';
import {useRunning} from './useRunning';
import {viewFor} from './snapshotView';
import './playback.css';

export interface CctvPlaybackProps {
  /** Dev-only overrides to reproduce failures with a wrong path. */
  readonly detectionsUrl?: string;
  readonly videoUrl?: string;
}

type VideoEl = HTMLVideoElement & {requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (n: number) => void};

/** Mock playback (F-57, SCR-345/346): the analyzed store video and its per-frame overlays and numbers. */
export function CctvPlayback({detectionsUrl, videoUrl = VIDEO_URL}: CctvPlaybackProps) {
  const {t} = useBundle(cctvBundle);
  const {reducedMotion} = useUi();
  const {load, retry, attempt} = useDetections(detectionsUrl);
  const file = load.status === 'ready' ? load.file! : null;
  const jsonFailed = load.status === 'error';
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoEl>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(false); // numbers/boxes follow the video only after it is ready; before that the fixed scene shows
  const userPaused = useRef(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [showBoxes, setShowBoxes] = useState(true);
  const [loop, setLoop] = useState(true);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(SAMPLE_START_TIME);
  const [duration, setDuration] = useState(0);
  const [frame, setFrame] = useState<DetectionFrame | null>(null);
  const running = useRunning(rootRef);
  const rect = usePictureRect(stageRef, videoRef, file ?? {width: 960, height: 540}, ready);
  const frames = file?.frames;

  const sync = useCallback(() => {
    const v = videoRef.current;
    if (!v || !readyRef.current) return;
    const at = v.currentTime;
    setTime(Math.round(at * 10) / 10);
    if (!frames) return;
    const f = pickFrame(frames, at);
    setFrame(prev => (prev === f ? prev : f)); // same frame: no redraw
  }, [frames]);
  useEffect(() => { sync(); }, [sync]);

  // Loading skeleton only if the video is not ready after 300ms (M-15).
  useEffect(() => {
    if (ready || videoFailed) return;
    const id = window.setTimeout(() => setSlow(true), 300);
    return () => window.clearTimeout(id);
  }, [ready, videoFailed, attempt]);

  // Not visible (off screen / hidden page) → pause; visible again → play, unless reduced motion or the user paused.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !ready) return;
    if (!running) v.pause();
    else if (!reducedMotion && !userPaused.current) void v.play().catch(() => setPlaying(false));
  }, [running, ready, reducedMotion]);

  // Frame sync while playing: requestVideoFrameCallback if present, otherwise rAF.
  useEffect(() => {
    const v = videoRef.current;
    if (!playing || !v) return;
    let id = 0;
    const rvfc = typeof v.requestVideoFrameCallback === 'function';
    const tick = () => { sync(); id = rvfc ? v.requestVideoFrameCallback!(tick) : requestAnimationFrame(tick); };
    tick();
    return () => { if (rvfc) v.cancelVideoFrameCallback?.(id); else cancelAnimationFrame(id); };
  }, [playing, sync]);
  useEffect(() => () => { videoRef.current?.pause(); }, []); // closing stops playback

  const onMeta = () => {
    const v = videoRef.current!;
    if (Number.isFinite(v.duration)) setDuration(v.duration);
    v.currentTime = v.duration > SAMPLE_START_TIME ? SAMPLE_START_TIME : 0;
    readyRef.current = true;
    setReady(true);
    if (!reducedMotion) void v.play().catch(() => setPlaying(false)); // reduced motion: fixed scene, no autoplay
    sync();
  };
  const toggle = () => {
    const v = videoRef.current;
    if (!v || videoFailed) return;
    if (ended) { v.currentTime = 0; setEnded(false); userPaused.current = false; void v.play().catch(() => setPlaying(false)); sync(); }
    else if (v.paused) { userPaused.current = false; void v.play().catch(() => setPlaying(false)); } else { userPaused.current = true; v.pause(); }
  };
  const seek = (to: number) => {
    const v = videoRef.current;
    if (!v || videoFailed || !ready) return;
    v.currentTime = Math.min(Math.max(0, to), duration);
    setEnded(false);
    sync();
  };
  const clockText = (sec: number) => t('cctv.player.time', {m: String(Math.floor(sec / 60)).padStart(2, '0'), s: String(Math.floor(sec % 60)).padStart(2, '0')});
  const onKey = (e: KeyboardEvent) => {
    if (videoFailed) return;
    if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); toggle(); }
    // K-E 13: ←/→ seek 5 s while the video itself has focus (the slider has its own handler and has already handled the key).
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.defaultPrevented && (e.target as HTMLElement).closest('.cctv-stage')) {
      e.preventDefault();
      seek((videoRef.current?.currentTime ?? shownTime) + (e.key === 'ArrowRight' ? 5 : -5));
    }
  };
  const reload = () => { readyRef.current = false; userPaused.current = false; setVideoFailed(false); setEnded(false); setReady(false); setSlow(false); setFrame(null); retry(); };

  const overlayOn = !!(file && frame && ready && !videoFailed);
  const view = viewFor(overlayOn ? file : null, frame?.t ?? SAMPLE_START_TIME, videoUrl === VIDEO_URL && (detectionsUrl ?? DETECTIONS_URL) === DETECTIONS_URL);
  const overlay = {...FULL_OVERLAY, persons: showBoxes, cups: showBoxes};
  const label = ended ? t('cctv.player.replay') : playing ? t('cctv.player.pauseMock') : t('cctv.player.play');
  const shownTime = ready && !videoFailed ? time : 0;

  return <div ref={rootRef} className="cctv-playback" onKeyDown={onKey}>
    <div className="cctv-stage-row">
      <div className="cctv-stage-col">
        {videoFailed ? <div className="cctv-fallback" role="alert">
          <span className="cctv-fallback__icon" aria-hidden="true">⚠</span>
          <p className="cctv-fallback__title">{t('cctv.video.failed')}</p>
          <p>{t('cctv.video.numbersKept')}</p>
          <button type="button" className="cctv-btn" onClick={reload}>{t('cctv.video.reload')}</button>
        </div> : <div ref={stageRef} className="cctv-stage" tabIndex={0} role="group" aria-label={t('cctv.a11y.video')}>
          <video key={attempt} ref={videoRef} src={videoUrl} className="cctv-video" preload="metadata" muted playsInline loop={loop}
            onLoadedMetadata={onMeta} onError={() => { readyRef.current = false; setReady(false); setVideoFailed(true); setPlaying(false); }}
            onEnded={() => { setEnded(true); setPlaying(false); }}
            onPlay={() => { setPlaying(true); setEnded(false); }} onPause={() => { setPlaying(false); sync(); }} onSeeked={sync}/>
          {slow && !ready ? <div className="cctv-skeleton" role="status" aria-busy="true">{t('cctv.video.loading')}</div> : null}
          {jsonFailed ? <div className="cctv-box-error" role="status"><span>{t('cctv.video.boxesFailed')}</span>
            <button type="button" className="cctv-btn cctv-btn--small" onClick={retry}>{t('cctv.video.reload')}</button></div> : null}
          {overlayOn ? drawBoxes(view, rect, overlay, t) : null}
        </div>}
      </div>
      <div className="cctv-side">
        <NowNumbers view={view} time={shownTime} duration={duration}/>
      </div>
    </div>
    <div className="cctv-controls" role="group">
      <button type="button" className="cctv-btn" onClick={toggle} disabled={videoFailed}>{playing ? '⏸' : '▶'} <span>{label}</span></button>
      <button type="button" className="cctv-btn" onClick={() => seek(0)} disabled={videoFailed}>↺ <span>{t('cctv.player.restart')}</span></button>
      <input type="range" className="cctv-slider" aria-label={t('cctv.player.position')} min={0} max={Math.floor(duration)} step={1} value={Math.min(Math.floor(shownTime), Math.floor(duration))} disabled={videoFailed}
        aria-valuetext={t('cctv.player.positionValue', {now: clockText(shownTime), total: clockText(duration)})}
        onChange={e => seek(Number(e.target.value))}
        onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); seek((videoRef.current?.currentTime ?? shownTime) + (e.key === 'ArrowRight' ? 5 : -5)); } }}/>
      <span className="cctv-clock">{formatClock(shownTime)} / {formatClock(duration)}</span>
      <button type="button" role="switch" aria-checked={loop} className="cctv-switch" onClick={() => setLoop(v => !v)} disabled={videoFailed}>
        <span className="cctv-switch__box" aria-hidden="true">{loop ? '✓' : ''}</span>{t('cctv.player.loop')}</button>
      <button type="button" role="switch" aria-checked={showBoxes} className="cctv-switch" onClick={() => setShowBoxes(v => !v)} disabled={videoFailed || jsonFailed}>
        <span className="cctv-switch__box" aria-hidden="true">{showBoxes ? '✓' : ''}</span>{t('cctv.player.boxes')}</button>
      {videoFailed ? <span className="cctv-why">{t('cctv.player.disabledWhy')}</span> : null}
    </div>
    <ul className="cctv-legend">
      <li><i className="cctv-swatch cctv-swatch--person"/>{t('cctv.legend.person')}</li>
      <li><i className="cctv-swatch cctv-swatch--occupied"/>{t('cctv.legend.occupied')}</li>
      <li><i className="cctv-swatch cctv-swatch--empty"/>{t('cctv.legend.empty')}</li>
      <li><i className="cctv-swatch cctv-swatch--clear"/>{t('cctv.legend.clear')}</li>
    </ul>
    <StayCharts view={view}/>
    <p className="cctv-fake">{t('cctv.footer.mock')}</p>
  </div>;
}
