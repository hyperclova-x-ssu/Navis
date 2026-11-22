/**
 * KIOSK-UI — the Npay 커넥트 mini kiosk as a page of its own (a presentation prop, D-351): the portrait 800 x 1280 frame scaled to fit
 * the window, the customer flow, its timers (60 s idle, ~1.5 s approval for every payment tile, 10 s 끝내기) and the hand-over of a
 * paid order to the Navis window. No real payment, camera feed, card number or phone number is handled here.
 */
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Locale } from '../contracts';
import './kiosk.css';
import { CONNECT_CHANNEL, createBrowserTransport, type ConnectTransport } from './channel';
import { cartTotal, initialKioskState, kioskReducer } from './flow';
import { KIOSK_TIMINGS, buildOrderMessage, type KioskTimings } from './order';
import { FacesignCamera } from './facesign';
import {
  AttractScreen, BuzzerScreen, CartScreen, DetailScreen, MenuScreen, MethodScreen, PayScreen, ProcessingScreen, ReviewScreen, ScanScreen, SentScreen, SuccessScreen,
  type Send,
} from './screens';

/** Scale the 800 x 1280 frame to the room it has (letterbox: the page behind it is the only margin). */
function useFit(stage: RefObject<HTMLDivElement | null>): number {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const measure = () => { const r = node.getBoundingClientRect(); if (r.width > 0 && r.height > 0) setScale(Math.min(r.width / 800, r.height / 1280)); };
    measure();
    if (typeof ResizeObserver !== 'function') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [stage]);
  return scale;
}

/** The scaled portrait frame on its dark stage; every kiosk page (flow, presenter setup) lives inside it. */
export function KioskStage({ children, screen, onActivity }: { readonly children: ReactNode; readonly screen?: string; readonly onActivity?: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const scale = useFit(stage);
  return <div ref={stage} className="ck-stage" data-screen={screen} onPointerDownCapture={onActivity} onKeyDownCapture={onActivity}>
    <div className="ck-frame" style={{ transform: `scale(${scale})` }} lang="ko">{children}</div>
  </div>;
}

export interface KioskProps {
  readonly categoryLocale?: Locale;
  readonly transport?: ConnectTransport;
  readonly timings?: Partial<KioskTimings>;
  readonly newId?: () => string;
  readonly now?: () => Date;
}

export function Kiosk({ transport, timings, newId, now, categoryLocale = 'ko' }: KioskProps) {
  const t = { ...KIOSK_TIMINGS, ...timings };
  const [state, dispatch] = useReducer(kioskReducer, initialKioskState);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; });
  const [bus] = useState<ConnectTransport>(() => transport ?? createBrowserTransport(CONNECT_CHANNEL));
  const [activity, setActivity] = useState(0);
  const [added, setAdded] = useState<string | null>(null);
  const fast = useRef(false);
  const send: Send = useCallback(action => {
    if (action.type === 'paymentRequested') fast.current = true;
    if (action.type === 'choosePayment') fast.current = false;
    if (action.type === 'openItem') { setAdded(action.itemId); window.setTimeout(() => setAdded(null), 380); }
    dispatch(action);
  }, []);

  // 60 s without a touch returns to the attract screen (not while a payment is being approved).
  useEffect(() => {
    if (state.screen === 'attract' || state.screen === 'processing') return;
    const timer = window.setTimeout(() => dispatch({ type: 'home' }), t.idleMs);
    return () => window.clearTimeout(timer);
  }, [state, activity, t.idleMs]);

  // The QR camera screen "sees" the code and the payment is requested; no camera is opened for it.
  useEffect(() => {
    if (state.screen !== 'scan') return;
    const timer = window.setTimeout(() => send({ type: 'paymentRequested', label: '네이버페이' }), t.scanMs);
    return () => window.clearTimeout(timer);
  }, [state.screen, t.scanMs, send]);

  // Every payment method approves by itself; the paid order is handed to Navis at the moment the kiosk shows 'success'.
  useEffect(() => {
    if (state.screen !== 'processing') return;
    const timer = window.setTimeout(() => {
      const id = newId ? newId() : globalThis.crypto.randomUUID();
      const message = buildOrderMessage(stateRef.current, id, (now ? now() : new Date()).toISOString());
      if (message) bus.post(message);
      dispatch({ type: 'approved', orderId: id });
    }, fast.current ? t.cameraApproveMs : t.approveMs);
    return () => window.clearTimeout(timer);
  }, [state.screen, t.approveMs, t.cameraApproveMs, bus, newId, now]);

  const screen = (() => {
    switch (state.screen) {
      case 'attract': return <AttractScreen send={send}/>;
      case 'method': return <MethodScreen send={send}/>;
      case 'menu': return <MenuScreen state={state} send={send} added={added} categoryLocale={categoryLocale}/>;
      case 'detail': return <DetailScreen state={state} send={send}/>;
      case 'cart': return <CartScreen state={state} send={send}/>;
      case 'buzzer': return <BuzzerScreen state={state} send={send}/>;
      case 'pay': return <PayScreen state={state} send={send}/>;
      case 'scan': return <ScanScreen state={state} send={send}/>;
      case 'face': return <div className="ck-screen"><FacesignCamera amount={cartTotal(state.cart)} onApproved={() => send({ type: 'paymentRequested', label: '페이스사인' })} onCancel={() => send({ type: 'back' })}/></div>;
      case 'processing': return <ProcessingScreen state={state}/>;
      case 'success': return <SuccessScreen state={state} send={send} seconds={t.endSeconds}/>;
      case 'review': return <ReviewScreen state={state} send={send}/>;
      case 'reviewSent': case 'laterSent': return <SentScreen state={state} send={send} seconds={t.endSeconds}/>;
    }
  })();

  return <KioskStage screen={state.screen} onActivity={() => setActivity(n => n + 1)}>
    <div key={state.screen} className="ck-screen-host">{screen}</div>
  </KioskStage>;
}
