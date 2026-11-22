/** T-075 CCTV 손님분석 detail (SCR-346): the picture and numbers area for the mode (and the setup flow), above the unchanged "하루 기록" (D-371). */
import { useCallback, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type { WidgetDetailProps } from '../../../contracts';
import type { CctvMode, CctvView } from '../../cctv';
import { CctvPlayback, CctvSetup, CctvStage, setCctvMode, useCctvMode, useCctvView } from '../../cctv';
import { ActionButton } from '../../../ui';
import { changeText } from './cctv-panel';
import { ModeToggle, WidgetMenu, useCctvT, useSecondly, type CctvT } from './cctv-parts';
import type { ZoneEditorProps } from '../../cctv/zones';
import type { ZonesApi } from '../../cctv/zones/api';
import { linkedOccupancyText, type LinkedTableDisplay } from '../../cctv/zones/linked-ui';

export interface CctvLinksProps {
  readonly linkedTables?: readonly LinkedTableDisplay[];
  readonly linkPicker?: ZoneEditorProps['linkPicker'];
  readonly linkZones?: readonly { id: string; label: string }[];
  readonly linkError?: string | null;
  readonly linkBusy?: boolean;
  readonly linkConfirm?: { label: string; text: string; onPress(): void; onCancel(): void };
}
const orderLabels = { empty: '빈 테이블', reserved: '예약됨', occupied: '이용 중', payment_pending: '결제 대기', cleaning: '정리 중' } as const;
export function LinkedCctvRows({ links, zoneLabel }: { links: readonly LinkedTableDisplay[]; zoneLabel: (zoneId: string) => string }) {
  if (!links.length) return null;
  return <ul aria-label="연결된 테이블">{links.map(link => <li key={link.zoneId}><span>{zoneLabel(link.zoneId)} · 연결 테이블 {link.tableLabel ?? link.tableId} · {orderLabels[link.linkedOrderStatus]}</span> <span>{linkedOccupancyText(link)}</span>{link.needsClearingBadge ? <span>치울 테이블</span> : null}</li>)}</ul>;
}
export function CctvLinks({ linkedTables = [], linkPicker, linkZones = [], linkError, linkBusy, linkConfirm }: CctvLinksProps) {
  if (!linkPicker && linkedTables.length === 0) return null;
  const zoneLabel = (id: string) => linkZones.find(zone => zone.id === id)?.label ?? id;
  return <section lang="ko" aria-label="CCTV 테이블 연결">
    {linkPicker?.disabled ? <p>테이블별 주문이 있는 후불형에서 연결할 수 있어요</p> : null}
    {linkError ? <p role="alert">{linkError}</p> : null}
    {linkPicker && !linkPicker.disabled ? linkZones.filter(zone => linkPicker.enabledFor?.(zone.id) ?? true).map(zone => <label className="cc-zone-link" key={zone.id}>{zone.label} POS 테이블 연결 <select value={linkPicker.valueFor(zone.id) ?? ''} disabled={linkBusy} onChange={event => linkPicker.onChange(zone.id, event.currentTarget.value || null)}><option value="">연결 안 됨</option>{linkPicker.optionsFor(zone.id).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>) : null}
    {linkConfirm && <div className="mc-actions" role="group" aria-label={linkConfirm.label}>
      <p>{linkConfirm.text}</p><ActionButton disabled={linkBusy} onClick={linkConfirm.onPress}>{linkConfirm.label}</ActionButton>
      <ActionButton variant="secondary" onClick={linkConfirm.onCancel}>취소</ActionButton>
    </div>}
    <LinkedCctvRows links={linkPicker?.disabled ? [] : linkedTables} zoneLabel={zoneLabel}/>
  </section>;
}

const ID = 'customer-analysis' as const;
type Setup = 'connect' | 'zones' | null;
const NOT_LIVE = new Set(['none', 'waiting', 'phone-opened', 'lost', 'server-down']);

/** SCR-346 LiveStatusLine: a dot plus words (colour never alone). */
function StatusLine({ view }: { readonly view: CctvView }) {
  const t = useCctvT();
  const c = view.connection;
  const text = c === 'live' ? t('cctv.conn.liveStatus') : c === 'reconnecting' ? t('cctv.conn.reconnecting') : c === 'server-down' ? t('cctv.conn.serverDown') : c === 'lost' ? t('cctv.conn.lost') : c === 'none' ? t('cctv.conn.none') : t('cctv.conn.waiting');
  const tone = c === 'live' ? 'ok' : c === 'reconnecting' ? 'warn' : 'bad';
  return <p className="cc-line" data-testid="cctv-status-line" data-tone={tone}><span className="cc-dot" aria-hidden="true" />{text}</p>;
}

function LiveNumbers({ view }: { readonly view: CctvView }) {
  const t = useCctvT();
  const v = useSecondly(view);
  const on = v.inStore !== null;
  const used = v.tables.filter((x) => x.state === 'occupied').length;
  const clear = v.tables.filter((x) => x.state === 'clear').length;
  return (
    <section className="cctv-now cc-now" aria-label={t('cctv.nowNumbers.live')}>
      <h3>{t('cctv.nowNumbers.live')}</h3>
      <p className="cctv-now__main"><strong data-testid="now-instore">{on ? t('cctv.guests', { n: v.inStore! }) : '—'}</strong></p>
      <p className="cctv-now__row" data-testid="now-change">{changeText(t, v.change5m)}</p>
      {v.zonesCount > 0 ? <>
        <p className="cctv-now__row" data-testid="now-seats">{t('cctv.tables.inUse', { a: used, b: v.tables.length })}</p>
        <p className="cctv-now__row" data-testid="now-clear">{t('cctv.tables.toClear', { n: clear })}</p>
      </> : null}
    </section>
  );
}

function AvgAndSeats({ view }: { readonly view: CctvView }) {
  const t: CctvT = useCctvT();
  const v = useSecondly(view);
  const sec = v.avgDwell.kind === 'live-seconds' ? v.avgDwell.seconds : null;
  const avg = sec === null ? t('cctv.avg.none') : t('cctv.avg.minutes', { n: Math.max(1, Math.round(sec / 60)) });
  return (
    <div className="cctv-charts cc-charts">
      <section className="cctv-chart" aria-labelledby="cc-avg-title">
        <h3 id="cc-avg-title">{t('cctv.avg.live')}</h3>
        <p className="cc-avg" data-testid="live-avg">{avg}</p>
        <p className="cctv-caption">{t('cctv.avg.liveCaption')}</p>
      </section>
      <section className="cctv-chart" aria-labelledby="cc-seat-title">
        <h3 id="cc-seat-title">{t('cctv.seats.title')}</h3>
        <p className="cctv-caption">{t('cctv.occupied.caption')}</p>
        <ul className="cctv-bars cctv-bars--row">
          {v.tables.map((x) => {
            const s = x.occupiedSeconds ?? 0;
            const name = t(x.label.key as never, x.label.params as never);
            const time = t('cctv.avg.minutesSeconds', { m: Math.floor(s / 60), s: Math.floor(s % 60) });
            return <li key={x.id} data-testid="stay-seat" aria-label={t('cctv.seats.row', { name, time })}>
              <span className="cctv-bar__name" aria-hidden="true">{name}</span>
              <span className="cctv-bar__track"><span className="cctv-bar__fill" style={{ width: `${Math.min(100, Math.round((s / 300) * 100))}%` }} /></span>
              <span className="cctv-bar__value" aria-hidden="true">{time}</span>
            </li>;
          })}
        </ul>
      </section>
    </div>
  );
}

/** Live picture area: status line, picture + numbers, controls, legend, averages. */
function LiveArea({ onSetup }: { readonly onSetup: (s: Setup) => void }) {
  const t = useCctvT();
  const view = useCctvView({ video: true });
  const [frozen, setFrozen] = useState<CctvView | null>(null);
  const [boxes, setBoxes] = useState(true);
  const shown = frozen ?? view;
  return (
    <div className="cc-live cctv-playback" data-testid="cctv-live-area">
      <div className="cctv-stage-row">
        <div className="cctv-stage-col"><CctvStage view={shown} overlay={{ persons: boxes, cups: boxes, zones: boxes }} variant="detail" /></div>
        <div className="cctv-side"><StatusLine view={view} /><LiveNumbers view={view} /></div>
      </div>
      {view.zonesCount === 0 && view.connection === 'live' ? <p className="cc-line"><span>{t('cctv.zones.needed')}</span> <button type="button" className="cctv-btn" onClick={() => onSetup('zones')}>{t('cctv.zones.setup')}</button></p> : null}
      <div className="cctv-controls" role="group">
        <button type="button" className="cctv-btn" onClick={() => setFrozen(frozen ? null : view)}>{frozen ? t('cctv.player.resume') : t('cctv.player.pause')}</button>
        <button type="button" role="switch" aria-checked={boxes} className="cctv-switch" onClick={() => setBoxes((v) => !v)}><span className="cctv-switch__box" aria-hidden="true">{boxes ? '✓' : ''}</span>{t('cctv.player.boxes')}</button>
      </div>
      <ul className="cctv-legend">
        <li><i className="cctv-swatch cctv-swatch--person" />{t('cctv.legend.person')}</li>
        <li><i className="cctv-swatch cctv-swatch--occupied" />{t('cctv.legend.occupied')}</li>
        <li><i className="cctv-swatch cctv-swatch--empty" />{t('cctv.legend.empty')}</li>
        <li><i className="cctv-swatch cctv-swatch--clear" />{t('cctv.legend.clear')}</li>
      </ul>
      <AvgAndSeats view={view} />
    </div>
  );
}

/** The area above "하루 기록". `record` is the unchanged day-record body (same in both modes: AC-1344). */
export function CctvAnalysisDetail({ host, detailRef, record, zonesApi, linkedTables, linkPicker, linkZones, linkError }: WidgetDetailProps & { readonly record: ReactNode; /** The store's own zone api over the service (D-355: the same setup flow saves real zones). */ readonly zonesApi?: ZonesApi } & CctvLinksProps) {
  const t = useCctvT();
  const mode = useCctvMode();
  const status = useCctvView({ video: false });
  const [setup, setSetup] = useState<Setup>(detailRef.view === 'setup' ? 'connect' : detailRef.view === 'zones' ? 'zones' : null);
  const [said, setSaid] = useState('');
  const live = mode === 'live';
  const done = useCallback(() => setSetup(null), []); // CctvSetup's timers restart when this changes: it must stay the same function
  // Live and no current camera: the setup is the picture area (SCR-347). It stays until it is done.
  if (live && setup === null && NOT_LIVE.has(status.connection ?? '')) setSetup('connect');
  const change = (m: CctvMode) => { setCctvMode(m); setSetup(null); setSaid(t(m === 'live' ? 'cctv.mode.changedLive' : 'cctv.mode.changedMock')); };
  const menu = { reconnect: () => setSetup('connect'), resetZones: () => setSetup('zones'), canResetZones: status.connection === 'live' || status.connection === 'reconnecting' || zonesApi !== undefined };
  // The shell's detail header has an empty slot for this widget (T-079): the toggle and ⋯ go there; without it (dev host) they stay in the body.
  const [head, setHead] = useState<Element | null>(null);
  useLayoutEffect(() => { setHead(document.querySelector('[data-detail-header-slot="customer-analysis"]')); }, []); // eslint-disable-line react-hooks/set-state-in-effect
  const controls = <><ModeToggle mode={mode} onChange={change} />{live ? <WidgetMenu actions={menu} /> : null}</>;
  return (
    <div className="mc-detail cc-detail" data-widget={ID} data-mode={mode}>
      {head ? createPortal(controls, head) : <div className="cc-detail__head">{controls}</div>}
      <span className="cc-sr" role="status">{said}</span>
      {!live ? <CctvPlayback />
        : setup ? <CctvSetup key={setup} start={setup} host={host} onDone={done} linkPicker={linkPicker} zonesApi={zonesApi} />
        : <LiveArea onSetup={setSetup} />}
      <CctvLinks linkedTables={linkedTables} linkPicker={linkPicker} linkZones={linkZones} linkError={linkError}/>
      <div className="cc-record" data-testid="cctv-day-record">
        <div className="cc-record__head">
          <h2 className="cc-record__title">{t('cctv.dayRecord.title')}</h2>
          {live ? <span className="cc-record__note">{t('cctv.dayRecord.notCamera')}</span> : null}
        </div>
        {record}
      </div>
    </div>
  );
}
