/** T-075 CCTV 손님분석 panel (SCR-345): 실시간 / 목업 toggle, size-by-size display, live status table. Draws a `CctvView`; never knows where it came from. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WidgetPanelProps } from '../../../contracts';
import type { CctvMode, CctvView } from '../../cctv';
import { CctvStage, PanelVideo, setCctvMode, useCctvMode, useCctvView, useLiveConnection } from '../../cctv';
import { TODAY_AVG_DWELL_MIN } from '../../../data/cctv';
import type { CustomerAnalysisModel } from '../../../data/models/types';
import { Badge, MetricFit, PanelAction, panelShape, useUi } from '../../../ui';
import { DROP, ListBlock, Row, splitUnit, useFitDrop, useT } from './shared';
import { ModeToggle, WidgetMenu, livePanelStatus, showsNumbers, useCctvT, useSecondly, type CctvT, type PanelRun } from './cctv-parts';

const ID = 'customer-analysis' as const;
const BOXES = { persons: true, cups: false, zones: false } as const;

const inUse = (v: CctvView): number => v.tables.filter((x) => x.state === 'occupied').length;
const toClear = (v: CctvView): number => v.tables.filter((x) => x.state === 'clear').length;

export function changeText(t: CctvT, c: number | null): string {
  return c === null ? t('cctv.change.none') : c === 0 ? t('cctv.change.flat') : t(c > 0 ? 'cctv.change.up' : 'cctv.change.down', { n: Math.abs(c) });
}

/** The big number `N명` with its unit line (D-372). The unit line says nothing about estimating in the demo (D-321: the 예시 chip says it); live adds 실시간. */
function Guests({ view, unit, dropUnit }: { readonly view: CctvView; readonly unit: string; readonly dropUnit: boolean }) {
  const t = useCctvT();
  const n = view.inStore;
  const { value, unit: u } = n === null ? { value: '—', unit: '' } : splitUnit(t('cctv.guests', { n }), String(n));
  return (
    <div className="cc-guests">
      <div className="mc-value" data-slot={`${ID}.metric.value`}><MetricFit value={value} unit={u || undefined} longest="88" stacked={false} /></div>
      <p className="mc-sub" data-slot={`${ID}.metric.secondary`} data-drop={dropUnit ? DROP.sub : undefined}>{unit}</p>
    </div>
  );
}

function Delta({ view }: { readonly view: CctvView }) {
  const t = useCctvT();
  const c = view.change5m;
  return <p className="cc-delta" data-slot={`${ID}.delta`} data-drop={DROP.extra} data-dir={c === null || c === 0 ? 'flat' : c > 0 ? 'up' : 'down'}>{changeText(t, c)}</p>;
}

interface RowsProps { readonly view: CctvView; readonly model: CustomerAnalysisModel | null; readonly live: boolean }
/** SCR-345 right-hand rows in priority order (cut from the bottom by the drop order). */
function NumberRows({ view, model, live }: RowsProps) {
  const t = useT();
  const c = useCctvT();
  const peak = model?.peak ?? null;
  const avg = view.avgDwell.kind === 'mock-minutes'
    ? c('cctv.avg.minutes', { n: TODAY_AVG_DWELL_MIN })
    : view.avgDwell.seconds === null ? c('cctv.avg.none') : c('cctv.avg.minutes', { n: Math.max(1, Math.round(view.avgDwell.seconds / 60)) });
  const sample = live ? <Badge>{c('cctv.example')}</Badge> : undefined;
  return (
    <ListBlock id={ID} title={undefined}>
      {view.zonesCount > 0 ? <Row id={ID} rowId="in-use" name={c('cctv.tables.inUse', { a: inUse(view), b: view.tables.length })} drop={DROP.row} /> : null}
      {view.zonesCount > 0 ? <Row id={ID} rowId="to-clear" name={c('cctv.tables.toClear', { n: toClear(view) })} drop={DROP.row} /> : null}
      <Row id={ID} rowId="avg" name={live ? c('cctv.avg.live') : c('cctv.avg.mock')} value={avg} drop={DROP.row} />
      {peak ? <Row id={ID} rowId={`h${peak.hour}-visits`} name={<>{t.t('widget.customer-analysis.hourVisits', { hour: peak.hour })}{sample ? ' ' : ''}{sample}</>} value={peak.visits === null ? t.t('widget.customer-analysis.notCounted') : t.t('widget.customer-analysis.visitCount', { n: peak.visits })} drop={DROP.row + 1} /> : null}
      {peak ? <Row id={ID} rowId={`h${peak.hour}-staff`} name={<>{t.t('widget.customer-analysis.hourStaff', { hour: peak.hour })}{sample ? ' ' : ''}{sample}</>} value={peak.staff === null ? t.t('widget.customer-analysis.noStaff') : t.t('widget.customer-analysis.staffCount', { n: peak.staff })} drop={DROP.row + 2} /> : null}
      {model ? <Row id={ID} rowId="today" name={t.t('widget.customer-analysis.todayVisits')} value={t.t('widget.customer-analysis.visitCount', { n: model.totalVisits })} drop={DROP.row + 3} /> : null}
    </ListBlock>
  );
}

interface PanelCtx extends WidgetPanelProps { readonly model: CustomerAnalysisModel | null; /** Soft note of the day record (e.g. no roster), already translated. */ readonly note: string | null; readonly mode: CctvMode; readonly onMode: (m: CctvMode) => void }

/** Shared frame: head (toggle · ⋯) for every size but 1×1 — on the shell's title row (CSS), except T which has no room — body, and the 1×1 toggle at the bottom (PanelAction's place). */
function Frame({ ctx, menu, children, status, action }: { readonly ctx: PanelCtx; readonly menu: boolean | { readonly reconnect: () => void; readonly resetZones: () => void; readonly canResetZones: boolean }; readonly children: ReactNode; readonly status?: { readonly text: string; readonly unavailable?: boolean } | null; readonly action?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFitDrop(ref);
  const shape = panelShape(ctx.width, ctx.height);
  const q = shape === 'Q';
  const t = useCctvT();
  const [said, setSaid] = useState('');
  const change = (m: CctvMode) => { ctx.onMode(m); setSaid(t(m === 'live' ? 'cctv.mode.changedLive' : 'cctv.mode.changedMock')); };
  const toggle = <ModeToggle mode={ctx.mode} onChange={change} hidden={ctx.editing} className={q ? 'cc-toggle--q' : ''} />;
  const head = <div className={`cc-head${shape === 'T' ? '' : ' cc-head--title'}`}>{toggle}{typeof menu === 'object' && shape !== 'T' ? <WidgetMenu actions={menu} hidden={ctx.editing} /> : null}</div>;
  return (
    <div ref={ref} className={`mc-root cc-root cc-root--${shape}`} data-slot={`${ID}.card`} data-widget={ID} data-mode={ctx.mode}>
      {q ? null : head}
      <div className="cc-body">{children}</div>
      {status ? <p className="cc-status" data-slot={`${ID}.state.message`} data-drop={q && !status.unavailable ? DROP.sub : undefined} role="status">
        {q && status.unavailable && <span data-slot={`${ID}.metric.value`} aria-hidden="true">—</span>}{status.text}
      </p> : null}
      {action}
      {q ? toggle : null}
      <span className="cc-sr" role="status">{said}</span>
    </div>
  );
}

/** Size layouts of a numbers view (Q · T · W). */
function Numbers({ ctx, view, unit, live }: { readonly ctx: PanelCtx; readonly view: CctvView; readonly unit: string; readonly live: boolean }) {
  const shape = panelShape(ctx.width, ctx.height);
  const showNums = showsNumbers(view);
  if (!showNums) return null;
  if (shape === 'Q') return <Guests view={view} unit={unit} dropUnit />;
  return (
    <div className={`cc-numbers cc-numbers--${shape}`}>
      <div className="cc-numbers__main"><Guests view={view} unit={unit} dropUnit /><Delta view={view} /></div>
      <NumberRows view={view} model={ctx.model} live={live} />
      {ctx.note ? <p className="mc-sub mc-flag" data-drop={DROP.extra}><span aria-hidden="true">△ </span>{ctx.note}</p> : null}
    </div>
  );
}

/** S · L: the picture is the body, the numbers sit in one band under it. */
function Band({ view, unit }: { readonly view: CctvView; readonly unit: string }) {
  const t = useCctvT();
  const nums = showsNumbers(view);
  return (
    <div className="cc-band" data-slot={`${ID}.band`}>
      {nums ? <>
        <Guests view={view} unit={unit} dropUnit={false} />
        <div className="cc-band__chips">
          {view.zonesCount > 0 ? <span className="cc-chip">{t('cctv.tables.inUse', { a: inUse(view), b: view.tables.length })}</span> : <span className="cc-chip">{t('cctv.zones.needed')}</span>}
          {view.zonesCount > 0 ? <span className="cc-chip">{t('cctv.tables.toClear', { n: toClear(view) })}</span> : null}
        </div>
        <Delta view={view} />
      </> : null}
    </div>
  );
}

function PanelButton({ ctx, labelKey, run }: { readonly ctx: PanelCtx; readonly labelKey: string; readonly run: () => void }) {
  const t = useCctvT();
  const name = useT().t('widget.customer-analysis.title');
  return <PanelAction label={t(labelKey as never)} widgetName={name} onPress={run} hidden={ctx.editing} />;
}

/** 목업: fixed scene numbers (1×1·T·W) or the looping café video with its own numbers (S·L). */
function MockPanel({ ctx }: { readonly ctx: PanelCtx }) {
  const t = useCctvT();
  const { reducedMotion } = useUi();
  const shape = panelShape(ctx.width, ctx.height);
  const big = shape === 'S' || shape === 'L';
  const fixed = useCctvView({ video: false });
  const [played, setPlayed] = useState<CctvView | null>(null);
  const view = big && played ? played : fixed;
  const shown = useSecondly(view);
  const unit = t('cctv.unit.mock');
  return (
    <Frame ctx={ctx} menu={false}>
      {big ? <div className="cc-video"><PanelVideo overlay={BOXES} paused={ctx.editing} reducedMotion={reducedMotion} onView={setPlayed} /></div> : null}
      {big ? <Band view={shown} unit={unit} /> : <Numbers ctx={ctx} view={shown} unit={unit} live={false} />}
    </Frame>
  );
}

/** 실시간: server counts; status text and one PanelAction for anything but a current connection. */
function LivePanel({ ctx, autoOpen, onAutoDone }: { readonly ctx: PanelCtx; readonly autoOpen: boolean; readonly onAutoDone: () => void }) {
  const t = useCctvT();
  const shape = panelShape(ctx.width, ctx.height);
  const big = shape === 'S' || shape === 'L';
  const view = useCctvView({ video: big && !ctx.editing });
  const nums = useSecondly(view);
  const { retry } = useLiveConnection();
  const status = livePanelStatus(view);
  const unit = view.connection === 'reconnecting' ? t('cctv.conn.reconnecting') : t('cctv.unit.live');
  const open = (v: 'setup' | 'zones') => ctx.host.openDetail({ featureId: ID, view: v });
  const run = (r: PanelRun) => (r === 'retry' ? retry() : open(r));

  // Switched to live on a W / S / L panel with no camera: the setup opens by itself (AC-1328: small panels only by the button).
  const connection = useRef(view.connection);
  useEffect(() => { connection.current = view.connection; });
  useEffect(() => {
    if (!autoOpen) return undefined;
    const id = window.setTimeout(() => {
      if (['none', 'waiting', 'phone-opened', 'lost'].includes(connection.current ?? '')) open('setup');
      onAutoDone();
    }, 800);
    return () => window.clearTimeout(id);
  }, [autoOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const menu = { reconnect: () => open('setup'), resetZones: () => open('zones'), canResetZones: view.connection === 'live' || view.connection === 'reconnecting' };
  const hideAll = status !== null && !status.keepNumbers;
  const unavailable = view.connection === 'server-down';
  const message = status && t(status.textKey as never);
  const body = big
    ? <>
      {unavailable ? <div className="cc-video mc-camera-unavailable" role="status" data-slot={`${ID}.state.message`}>{message}</div>
        : hideAll ? <div className="cc-video cc-video--off" /> : <div className="cc-video"><CctvStage view={view} overlay={BOXES} variant="panel" /></div>}
      <Band view={hideAll ? { ...nums, inStore: null } : nums} unit={unit} />
    </>
    : <Numbers ctx={ctx} view={hideAll ? { ...nums, inStore: null } : nums} unit={unit} live />;
  return (
    <Frame ctx={ctx} menu={menu}
      status={message && !(big && unavailable) ? { text: message, unavailable } : null}
      action={status?.action ? <PanelButton ctx={ctx} labelKey={status.action.labelKey} run={() => run(status.action!.run)} /> : null}>
      {body}
    </Frame>
  );
}

/** The panel body for the current mode. The toggle changes the mode; going live with no camera opens the setup (W · S · L). */
export function CctvAnalysisPanel(props: WidgetPanelProps & { readonly model: CustomerAnalysisModel | null; readonly note: string | null }) {
  const mode = useCctvMode();
  const [auto, setAuto] = useState(false);
  const shape = panelShape(props.width, props.height);
  const onMode = (m: CctvMode) => {
    setCctvMode(m);
    setAuto(m === 'live' && shape !== 'Q' && shape !== 'T');
  };
  const ctx: PanelCtx = { ...props, mode, onMode };
  return mode === 'live' ? <LivePanel ctx={ctx} autoOpen={auto} onAutoDone={() => setAuto(false)} /> : <MockPanel ctx={ctx} />;
}
