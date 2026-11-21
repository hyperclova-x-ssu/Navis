/**
 * VideoPlayer (D-80, DS 11.12.1, SCR-57, M-47): the finished mp4 (API-25, Range) in a 9:16 frame with ▶/⏸ 48, a seek bar
 * (track 4, hit 48, follows the pointer 1:1), “0:07 / 0:15” and mute 48. No autoplay; it stops at the end and ▶ becomes
 * 다시 보기. Plays with sound, also under reduced motion (the video is content).
 */
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Icon, useUi } from '../../../ui';
import { clockText } from './promo-format';
import { useT } from './shared';

/** Speaker glyphs for the mute button (the kit has no volume icon). */
function SpeakerIcon({ muted }: { readonly muted: boolean }) {
  return (
    <svg className="pv-speaker" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
      {muted ? <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" /> : <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />}
    </svg>
  );
}

export function PromoPlayer({ src, name }: { readonly src: string; readonly name: string }) {
  const t = useT();
  const ui = useUi();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const preset = ui.screenPreset.id === 'B' ? 'B' : 'A';

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    let frame = 0;
    const loop = () => { setTime(video.currentTime); frame = requestAnimationFrame(loop); };
    if (playing) frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) { video.pause(); return; }
    if (ended) { video.currentTime = 0; setEnded(false); }
    const played = video.play?.();
    if (played && typeof played.catch === 'function') played.catch(() => setPlaying(false));
  };
  const seekTo = (fraction: number) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    video.currentTime = Math.max(0, Math.min(duration, fraction * duration));
    setTime(video.currentTime);
    setEnded(false);
  };
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width > 0) seekTo((event.clientX - box.left) / box.width);
  };
  const progress = duration > 0 ? Math.min(1, time / duration) : 0;
  const playName = playing ? t.t('promo.player.pause') : ended ? t.t('promo.player.replay') : t.t('promo.player.play');
  return (
    <div className="pv-player" role="group" aria-label={name} data-preset={preset} data-slot="promo-video.player">
      <div className="pv-player__frame">
        <video
          ref={videoRef} className="pv-player__video" src={src} preload="metadata" playsInline muted={muted}
          onPlay={() => { setPlaying(true); setEnded(false); }} onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setEnded(true); }}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)} onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onClick={toggle}
        />
      </div>
      <div className="pv-player__controls">
        <button type="button" className="pv-player__button" aria-label={playName} onClick={toggle} data-slot="promo-video.play">
          <Icon name={playing ? 'pause' : ended ? 'replay' : 'play'} aria-hidden />
        </button>
        <div
          className="pv-player__seek" role="slider" tabIndex={0} aria-label={t.t('promo.player.seek')} aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}
          aria-valuetext={t.t('promo.player.time', { now: clockText(time), total: clockText(duration) })}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); fromPointer(e); }}
          onPointerMove={(e) => { if (e.buttons & 1) fromPointer(e); }}
          onKeyDown={(e) => {
            if (!duration) return;
            const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            seekTo((time + step) / duration);
          }}
        >
          <span className="pv-player__track"><span className="pv-player__fill" style={{ transform: `scaleX(${progress})` }} /></span>
          <span className="pv-player__thumb" style={{ left: `${progress * 100}%` }} />
        </div>
        <span className="pv-player__time pv-tabular" aria-hidden="true">{t.t('promo.player.time', { now: clockText(time), total: clockText(duration) })}</span>
        <button type="button" className="pv-player__button" aria-label={muted ? t.t('promo.player.unmute') : t.t('promo.player.mute')} aria-pressed={muted} onClick={() => setMuted(!muted)}>
          <SpeakerIcon muted={muted} />
        </button>
      </div>
    </div>
  );
}
