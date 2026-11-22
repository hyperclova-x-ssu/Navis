import {useEffect, useEffectEvent, useRef, useState, type CSSProperties} from 'react';
import {getLiveClient} from '../../features/cctv/live';
import {createFaceAttempt, FACE_FRAME, FACE_TIMEOUT_MS, FRAME_SAMPLE_MS, hasFaceInFrame, type FaceBox} from './attempt';
import {isFacesignPaired} from './camera-session';
import './facesign.css';

interface FacesignCameraProps {
  amount: number;
  onApproved: () => void;
  onCancel: () => void;
}

const FALLBACK_SCAN_MS = 1450;
const formatAmount = new Intl.NumberFormat('ko-KR');
const frameStyle = {
  left: `${FACE_FRAME.x * 100}%`,
  top: `${FACE_FRAME.y * 100}%`,
  width: `${FACE_FRAME.width * 100}%`,
  height: `${FACE_FRAME.height * 100}%`,
} satisfies CSSProperties;

function drawPreview(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, frame: ImageBitmap) {
  const scale = Math.max(canvas.width / frame.width, canvas.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  context.drawImage(frame, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}

export function FacesignCamera({amount, onApproved, onCancel}: FacesignCameraProps) {
  const [mode] = useState(() => isFacesignPaired() ? 'camera' : 'animation');
  const [phase, setPhase] = useState<'scan' | 'timeout' | 'approved'>('scan');
  const [aligned, setAligned] = useState(false);
  const [hasPreview, setHasPreview] = useState(false);
  const preview = useRef<HTMLCanvasElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const cancelScan = useRef<(() => void) | null>(null);
  const approve = useEffectEvent(onApproved);

  useEffect(() => {
    if (phase === 'timeout') retryButton.current?.focus();
    if (phase !== 'scan') return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    let unsubscribe = () => {};
    let release = () => {};
    const canvas = preview.current;
    const context = canvas?.getContext('2d');

    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      unsubscribe();
      release();
      if (canvas) context?.clearRect(0, 0, canvas.width, canvas.height);
    }

    function finish(result: 'timeout' | 'approved') {
      if (stopped) return;
      stop();
      setPhase(result);
      if (result === 'approved') approve();
    }

    cancelScan.current = stop;
    if (mode === 'animation') {
      timer = setTimeout(() => finish('approved'), FALLBACK_SCAN_MS);
    } else {
      const startedAt = performance.now();
      const attempt = createFaceAttempt(startedAt);
      timer = setTimeout(() => finish('timeout'), FACE_TIMEOUT_MS);
      const client = getLiveClient();
      let detect: ((frame: HTMLCanvasElement) => readonly FaceBox[]) | undefined;
      let lastBitmap: ImageBitmap | null = null;
      let lastSample = -Infinity;
      let previewVisible = false;
      let faceAligned = false;

      function updateAlignment(present: boolean, now: number) {
        if (present !== faceAligned) {
          faceAligned = present;
          setAligned(present);
        }
        const result = attempt.observe(present, now);
        if (result === 'approved') finish('approved');
        if (result === 'timed-out') finish('timeout');
      }

      function paint() {
        raf = 0;
        if (!canvas || !context || stopped) return;
        const {connection, bitmap} = client.getSnapshot();
        const now = performance.now();
        if (attempt.advance(now) === 'timed-out') {
          finish('timeout');
          return;
        }
        if (connection !== 'live' || !bitmap || document.visibilityState !== 'visible') {
          if (previewVisible) {
            previewVisible = false;
            lastBitmap = null;
            context.clearRect(0, 0, canvas.width, canvas.height);
            setHasPreview(false);
          }
          updateAlignment(false, now);
          return;
        }
        if (bitmap.bitmap === lastBitmap) return;
        lastBitmap = bitmap.bitmap;
        drawPreview(canvas, context, bitmap.bitmap);
        if (!previewVisible) {
          previewVisible = true;
          setHasPreview(true);
        }
        if (detect && now - lastSample >= FRAME_SAMPLE_MS) {
          lastSample = now;
          updateAlignment(hasFaceInFrame(detect(canvas)), now);
        }
      }

      function schedulePaint() {
        if (!stopped && !raf) raf = requestAnimationFrame(paint);
      }

      unsubscribe = client.subscribe(schedulePaint);
      release = client.acquire({video: true});
      // The same-origin chunk holds the trained weights. The only frames used are the ones already displayed.
      void import('./face-detector').then(module => {
        if (!stopped) detect = module.createFaceDetector();
      }).catch(() => finish('timeout'));
      schedulePaint();
    }

    return () => {
      stop();
      cancelScan.current = null;
    };
  }, [mode, phase]);

  function cancel() {
    cancelScan.current?.();
    onCancel();
  }

  function retry() {
    setAligned(false);
    setHasPreview(false);
    setPhase('scan');
  }

  const title = phase === 'timeout' ? '얼굴을 확인하지 못했어요'
    : phase === 'approved' ? '결제를 확인하고 있어요'
      : '얼굴을 화면에 맞춰 주세요';

  return (
    <section className="kiosk-face" aria-label="페이스사인" lang="ko">
      <header className="kiosk-face__top">
        {phase === 'scan' ? (
          <button type="button" className="kiosk-face__back" onClick={cancel}>
            <span aria-hidden="true" /> 이전
          </button>
        ) : null}
        <span className="kiosk-face__method">페이스사인</span>
      </header>
      <p className="kiosk-face__total">결제 금액 <strong>{formatAmount.format(amount)}원</strong></p>
      <div className="kiosk-face__capture" data-aligned={aligned && phase === 'scan'} data-phase={phase}>
        {phase === 'scan' && mode === 'camera' ? (
          <canvas ref={preview} width={500} height={500} className="kiosk-face__video" aria-hidden="true" />
        ) : null}
        {phase === 'scan' ? (
          <div className="kiosk-face__frame" style={frameStyle} aria-hidden="true">
            <span className="kiosk-face__corner" /><span className="kiosk-face__corner" />
            <span className="kiosk-face__corner" /><span className="kiosk-face__corner" />
            {hasPreview ? null : <span className="kiosk-face__face"><i /></span>}
            {mode === 'animation' ? <span className="kiosk-face__scan" /> : null}
          </div>
        ) : (
          <span aria-hidden="true" className="kiosk-face__result">{phase === 'timeout' ? '!' : '✓'}</span>
        )}
      </div>
      <div className="kiosk-face__message" role="status" aria-atomic="true">
        <h1>{title}</h1>
        {phase === 'scan' ? <p>{aligned ? '그대로 잠시 기다려 주세요' : '한 분씩 정면을 봐 주세요'}</p> : null}
        {phase === 'timeout' ? <p>정면을 보고 다시 시도해 주세요</p> : null}
      </div>
      {phase === 'timeout' ? (
        <div className="kiosk-face__actions">
          <button type="button" className="kiosk-face__secondary" onClick={cancel}>다른 방법으로 결제</button>
          <button type="button" className="kiosk-face__primary" onClick={retry} ref={retryButton}>다시 시도</button>
        </div>
      ) : null}
    </section>
  );
}
