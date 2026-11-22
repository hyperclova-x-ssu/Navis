import {useEffect, useRef, useState} from 'react';
import {getLiveClient, requestPairing, useLiveConnection, type PairResult} from '../../features/cctv/live';
import {svgDataUrl} from '../../features/cctv/setup/qr';
import {isFacesignPaired, setFacesignPaired} from './camera-session';
import './facesign.css';

type PairState =
  | {kind: 'loading'}
  | {kind: 'code'; pair: PairResult; replace: boolean}
  | {kind: 'connected' | 'expired' | 'busy' | 'unavailable' | 'limited'};

const errorMessage = {
  unavailable: '카메라 서버에 연결하지 못했어요',
  expired: 'QR 코드가 만료됐어요',
  busy: '이미 카메라가 연결돼 있어요',
  limited: '잠시 뒤에 QR 코드를 다시 만들어 주세요',
};

interface FacesignSetupProps {
  onClose: () => void;
}

export function FacesignSetup({onClose}: FacesignSetupProps) {
  const {connection} = useLiveConnection();
  const [pair, setPair] = useState<PairState>(() => isFacesignPaired() ? {kind: 'connected'} : {kind: 'loading'});
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  async function createQr(replace: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPair({kind: 'loading'});
    const result = await requestPairing({replace, lang: 'ko'});
    inFlight.current = false;
    if (!mounted.current) return;
    if (result.ok) {
      setPair({kind: 'code', pair: result, replace});
    } else {
      const kind = result.code === 'CAMERA_CONNECTED' ? 'busy'
        : result.code === 'RATE_LIMITED' ? 'limited' : 'unavailable';
      setPair({kind});
    }
  }

  useEffect(() => {
    mounted.current = true;
    titleRef.current?.focus();
    const timer = isFacesignPaired() ? undefined : setTimeout(() => void createQr(false), 0);
    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (pair.kind !== 'code') return;
    const client = getLiveClient();
    let cameraOpened = client.getSnapshot().camera === 'connected';
    const unsubscribe = client.subscribe(() => {
      const {camera, connection, frame} = client.getSnapshot();
      if (camera === 'connected') cameraOpened = true;
      if (camera === 'live' && connection === 'live' && frame && (!pair.replace || cameraOpened)) {
        setFacesignPaired(true);
        setPair({kind: 'connected'});
      }
    });
    const expiry = setTimeout(() => setPair({kind: 'expired'}), pair.pair.expiresInSec * 1000);
    return () => {
      unsubscribe();
      clearTimeout(expiry);
    };
  }, [pair]);

  const live = pair.kind === 'connected' && connection === 'live';
  const title = live ? '카메라가 연결됐어요'
    : pair.kind === 'connected' ? '카메라 연결을 확인해 주세요'
      : '휴대폰 카메라 연결';

  return (
    <section className="kiosk-face kiosk-face--setup" aria-label="페이스사인 카메라 설정" lang="ko">
      <header className="kiosk-face__top">
        <button type="button" className="kiosk-face__back" onClick={onClose}>
          <span aria-hidden="true" /> 이전
        </button>
        <span className="kiosk-face__method">페이스사인 설정</span>
      </header>
      <div className="kiosk-face__setup-content">
        <h1 ref={titleRef} tabIndex={-1}>{title}</h1>
        {pair.kind === 'loading' ? <p role="status">QR 코드를 만들고 있어요</p> : null}
        {pair.kind === 'code' ? (
          <>
            <img src={svgDataUrl(pair.pair.qrSvg)} alt="휴대폰 카메라 연결 QR 코드" width={320} height={320} />
            <p>휴대폰으로 QR을 스캔하고<br />카메라를 허용해 주세요</p>
            <a href={pair.pair.cameraUrl} target="_blank" rel="noreferrer">카메라 페이지 열기</a>
          </>
        ) : null}
        {pair.kind === 'connected' ? (
          <button type="button" className="kiosk-face__primary" onClick={onClose}>돌아가기</button>
        ) : null}
        {pair.kind in errorMessage ? <p role="status">{errorMessage[pair.kind as keyof typeof errorMessage]}</p> : null}
        {pair.kind === 'busy' || (pair.kind === 'connected' && !live) ? (
          <button type="button" className="kiosk-face__secondary" onClick={() => void createQr(true)}>카메라 다시 연결</button>
        ) : null}
        {pair.kind === 'expired' || pair.kind === 'unavailable' || pair.kind === 'limited' ? (
          <button type="button" className="kiosk-face__secondary" onClick={() => void createQr(false)}>새 QR 만들기</button>
        ) : null}
      </div>
    </section>
  );
}
