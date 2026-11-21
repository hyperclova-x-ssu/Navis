import {useCallback, useEffect, useRef, useState} from 'react';
import type {WidgetHost} from '../../../contracts';
import {useBundle, useI18n} from '../../../i18n';
import {ActionButton} from '../../../ui';
import {requestPairing, useLiveCctvView, useLiveConnection} from '../live';
import {cctvBundle} from '../messages';
import {setCctvMode} from '../live/mode';
import {createZonesApi, ZoneEditor, type ZonesApi, type ZoneEditorProps} from '../zones';
import {CctvStage, LiveCanvas} from './CctvStage';
import {ALLOW_HINT_MS, VERIFY_MS, svgDataUrl} from './qr';
import './setup.css';

export interface CctvSetupProps {
  /** `connect` = QR first (SCR-347); `zones` = open the editor on the saved areas (SCR-349). */
  readonly start: 'connect' | 'zones';
  readonly onDone: () => void;
  readonly host: WidgetHost;
  /** Test seam. */
  readonly zonesApi?: ZonesApi;
  readonly linkPicker?: ZoneEditorProps['linkPicker'];
}

type Step = 'qr' | 'verify' | 'zones';
type Pair =
  | {readonly kind: 'loading'}
  | {readonly kind: 'ready'; readonly code: string; readonly cameraUrl: string; readonly qrSvg: string; readonly expiresInSec: number; readonly expired: boolean}
  | {readonly kind: 'error'; readonly code: 'CAMERA_CONNECTED' | 'RATE_LIMITED' | 'UNREACHABLE' | 'NOT_CONFIGURED'};

const LIVEISH = new Set(['live', 'phone-opened', 'reconnecting']);

/** SCR-347~350: QR → connection check → table areas. Moves on by itself when the phone connects (AC-1329). */
export function CctvSetup({start, onDone, host, zonesApi, linkPicker}: CctvSetupProps) {
  const {t} = useBundle(cctvBundle);
  const {locale} = useI18n();
  const {connection, serverDown, retry} = useLiveConnection();
  const view = useLiveCctvView({video: true});
  const api = zonesApi ?? createZonesApi();
  const [step, setStep] = useState<Step>(start === 'zones' ? 'zones' : 'qr');
  const [pair, setPair] = useState<Pair>({kind: 'loading'});
  const [copied, setCopied] = useState(false);
  const [hint, setHint] = useState(false);
  const [replace] = useState(() => start === 'connect' && LIVEISH.has(connection)); // "camera again": a new phone replaces the live one
  const [sawLeave, setSawLeave] = useState(!replace);
  const guideRef = useRef<HTMLParagraphElement>(null);
  const apiRef = useRef(api);
  useEffect(() => { apiRef.current = api; });

  const fetchQr = useCallback(() => {
    void requestPairing({replace, lang: locale}).then(r => {
      if (!r.ok) { setPair({kind: 'error', code: r.code}); return; }
      setPair({kind: 'ready', code: r.code, cameraUrl: r.cameraUrl, qrSvg: r.qrSvg, expiresInSec: r.expiresInSec, expired: false});
    });
  }, [locale, replace]);
  const makeQr = useCallback(() => { setPair({kind: 'loading'}); setCopied(false); fetchQr(); }, [fetchQr]);

  // One QR when the QR step opens; a new one is made only by the button (or after the server was back).
  const needQr = step === 'qr';
  useEffect(() => { if (needQr && pair.kind === 'loading') fetchQr(); }, [needQr]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (needQr && connection !== 'server-down' && pair.kind === 'error' && (pair.code === 'UNREACHABLE' || pair.code === 'NOT_CONFIGURED')) fetchQr(); }, [connection]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (step === 'qr') guideRef.current?.focus(); }, [step]);

  // QR expiry (10 min from the server's expiresInSec; the server clock is not epoch).
  const code = pair.kind === 'ready' ? pair.code : null;
  const expiresIn = pair.kind === 'ready' ? pair.expiresInSec : 600;
  useEffect(() => {
    if (!code) return;
    const id = window.setTimeout(() => setPair(p => (p.kind === 'ready' && p.code === code ? {...p, expired: true} : p)), expiresIn * 1000);
    return () => window.clearTimeout(id);
  }, [code, expiresIn]);

  // 15 s with the phone open and no video → ask to allow the camera.
  useEffect(() => {
    if (connection !== 'phone-opened') return;
    const id = window.setTimeout(() => setHint(true), ALLOW_HINT_MS);
    return () => { window.clearTimeout(id); setHint(false); };
  }, [connection]);

  // Replace mode: only a connection that left `live` after the new QR counts as the new phone.
  // A state machine driven by an external connection signal: the effect is the right place to step it.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { if (connection !== 'live') setSawLeave(true); }, [connection]);

  // Connected → check mark; then zones missing → editor, saved zones → done.
  useEffect(() => {
    if (step === 'qr' && connection === 'live' && pair.kind === 'ready' && sawLeave) setStep('verify');
    if (step === 'verify' && connection !== 'live') setStep('qr');
  }, [step, connection, pair.kind, sawLeave]);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (step !== 'verify') return;
    let alive = true;
    const id = window.setTimeout(() => {
      apiRef.current.get().then(z => z.zones.length > 0, () => false).then(has => { if (alive) { if (has) onDone(); else setStep('zones'); } });
    }, VERIFY_MS);
    return () => { alive = false; window.clearTimeout(id); };
  }, [step, onDone]);

  const copy = () => {
    if (pair.kind !== 'ready') return;
    void navigator.clipboard?.writeText(pair.cameraUrl).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }, () => undefined);
  };

  const bar = <ol className="cs-steps" aria-label={t('cctv.setup.steps')}>
    <li className="cs-step" aria-current={step === 'zones' ? undefined : 'step'} data-done={step !== 'qr' || undefined}>{t('cctv.setup.stepCamera')}</li>
    <li className="cs-step" aria-current={step === 'zones' ? 'step' : undefined}>{t('cctv.setup.stepZones')}</li>
  </ol>;

  if (step === 'zones') {
    const aspect = view.frame && view.frame.kind === 'bitmap' ? view.frame.w / view.frame.h : null;
    return <div className="cs-setup" data-testid="cctv-setup" data-step="zones">
      {bar}
      <ZoneEditor
        api={api}
        linkPicker={linkPicker}
        background={<LiveCanvas view={view} label={t('cctv.a11y.video')} />}
        frameAspect={aspect}
        disconnected={connection === 'lost' || connection === 'reconnecting'}
        onSaved={() => { host.notify({kind: 'success', messageKey: 'cctv.zones.saved'}); onDone(); }}
        onClose={onDone}
      />
    </div>;
  }

  if (step === 'verify') {
    return <div className="cs-setup" data-testid="cctv-setup" data-step="verify">
      {bar}
      <div className="cs-verify">
        <CctvStage view={view} overlay={{persons: true, cups: false, zones: false}} variant="detail" />
        <p className="cs-ok" role="status">{t('cctv.setup.connected')}</p>
      </div>
    </div>;
  }

  // qr step
  const down = connection === 'server-down';
  const downReason = serverDown === 'not-configured' ? 'cctv.conn.serverNotConfigured' : serverDown === 'bad-origin' ? 'cctv.conn.serverBadOrigin' : 'cctv.conn.serverUnreachable';
  const lost = connection === 'lost';
  const title = down ? t('cctv.conn.serverDown') : lost ? t('cctv.conn.lost') : t('cctv.qr.guide');
  const waiting = connection === 'phone-opened' ? t('cctv.conn.phoneOpened') : t('cctv.conn.waiting');
  return <div className="cs-setup" data-testid="cctv-setup" data-step="qr" data-connection={connection}>
    {bar}
    <div className="cs-card">
      {down ? null : pair.kind === 'ready' && !pair.expired ? (
        <div className="cs-qr"><img src={svgDataUrl(pair.qrSvg)} alt={t('cctv.setup.qrAlt')} width={280} height={280} /></div>
      ) : pair.kind === 'ready' ? (
        <div className="cs-qr cs-qr--expired" role="status">{t('cctv.qr.expired')}</div>
      ) : pair.kind === 'loading' ? (
        <div className="cs-qr cs-qr--skeleton" aria-label={t('cctv.setup.makingQr')} />
      ) : null}
      <div className="cs-side">
        <p className="cs-guide" tabIndex={-1} ref={guideRef}>{title}</p>
        {down ? <>
          <p className="cs-line">{t(downReason as never)}</p>
          <div><ActionButton variant="secondary" onClick={retry}>{t('cctv.conn.retry')}</ActionButton><ActionButton variant="secondary" onClick={() => { setCctvMode('mock'); onDone(); }}>{t('cctv.conn.viewExample')}</ActionButton></div>
        </> : <>
          {lost ? <><p className="cs-line">{t('cctv.conn.lostReason')}</p><ActionButton variant="secondary" onClick={() => { setCctvMode('mock'); onDone(); }}>{t('cctv.conn.viewExample')}</ActionButton></> : null}
          {pair.kind === 'ready' && pair.expired ? <div><ActionButton onClick={makeQr}>{t('cctv.qr.renew')}</ActionButton></div> : null}
          {pair.kind === 'error' ? <>
            <p className="cs-line" role="alert">{pair.code === 'CAMERA_CONNECTED' ? t('cctv.setup.cameraBusy') : pair.code === 'RATE_LIMITED' ? t('cctv.setup.rateLimited') : t('cctv.conn.serverDown')}</p>
            <div><ActionButton variant="secondary" onClick={makeQr}>{t('cctv.qr.renew')}</ActionButton></div>
          </> : <p className="cs-line" aria-live="polite">{waiting}</p>}
          {hint ? <p className="cs-line" role="status">{t('cctv.conn.allowCheck')}</p> : null}
          {pair.kind === 'ready' && !pair.expired ? <>
            <p className="cs-line">{t('cctv.qr.code')} <span className="cs-code" data-testid="cctv-pair-code">{pair.code}</span></p>
            <div className="cs-small">
              <ActionButton variant="secondary" onClick={copy}>{copied ? t('cctv.qr.copied') : t('cctv.qr.copyLink')}</ActionButton>
              <span>{t('cctv.qr.noSave')}</span>
            </div>
          </> : <div className="cs-small"><span>{t('cctv.qr.noSave')}</span></div>}
        </>}
      </div>
    </div>
  </div>;
}
