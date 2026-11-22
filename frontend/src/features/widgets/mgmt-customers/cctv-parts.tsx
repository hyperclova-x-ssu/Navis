/** T-075 small parts of the CCTV 손님분석 widget: mode toggle, ⋯ widget menu, panel status rules, once-a-second numbers. Text comes from `cctvBundle`. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ActionButton, SegmentedControl } from '../../../ui';
import type { CctvMode, CctvView } from '../../cctv';
import { useBundle } from '../../../i18n';
import { cctvBundle } from '../../cctv';

export const useCctvT = () => useBundle(cctvBundle).t;
export type CctvT = ReturnType<typeof useCctvT>;

/** Numbers change their text once a second (SCREENS 9.11); frames and statuses are never throttled. */
export function useSecondly<T>(value: T): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  useEffect(() => { latest.current = value; });
  useEffect(() => {
    const id = window.setInterval(() => setShown(latest.current), 1000);
    return () => window.clearInterval(id);
  }, []);
  return shown;
}

interface ModeToggleProps { readonly mode: CctvMode; readonly onChange: (m: CctvMode) => void; readonly hidden?: boolean; readonly className?: string }
/** SCR-345 ModeToggle: 실시간 | 목업. Hidden in place while editing (the slot stays). */
export function ModeToggle({ mode, onChange, hidden = false, className = '' }: ModeToggleProps) {
  const t = useCctvT();
  const name = (m: CctvMode) => t(m === 'live' ? 'cctv.mode.live' : 'cctv.mode.mock');
  const label = `${t('cctv.mode.toggleLabel')}, ${t('cctv.mode.selected', { mode: name(mode) })}`;
  return (
    <div className={`cc-toggle ${className}`} data-hidden={hidden ? 'true' : undefined} aria-hidden={hidden || undefined} inert={hidden || undefined} data-slot="customer-analysis.mode-toggle"
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <SegmentedControl<CctvMode> value={mode} onChange={onChange} label={label} options={[{ value: 'live', label: name('live') }, { value: 'mock', label: name('mock') }]} />
    </div>
  );
}

/** The widget header also hosts the example switch when the data comes from the service. */
export function DetailModeToggle({ mode, onChange }: Pick<ModeToggleProps, 'mode' | 'onChange'>) {
  const [header, setHeader] = useState<Element | null>(null);
  useLayoutEffect(() => {
    setHeader(document.querySelector('[data-detail-header-slot="customer-analysis"]'));
  }, []); // eslint-disable-line react-hooks/set-state-in-effect
  const toggle = <ModeToggle mode={mode} onChange={onChange} />;
  return header ? createPortal(toggle, header) : <div className="cc-detail__head">{toggle}</div>;
}

export interface MenuActions { readonly reconnect: () => void; readonly resetZones: () => void; readonly canResetZones: boolean }
/** The ⋯ button of this widget only (SCREENS 9.11): 카메라 다시 연결 · 테이블 다시 설정. The list is a portal, so a panel never clips it. */
export function WidgetMenu({ actions, hidden = false }: { readonly actions: MenuActions; readonly hidden?: boolean }) {
  const t = useCctvT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) }); // eslint-disable-line react-hooks/set-state-in-effect
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e: PointerEvent) => { const n = e.target as Node; if (!list.current?.contains(n) && !btn.current?.contains(n)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  const pick = (run: () => void) => { setOpen(false); run(); };
  return (
    <div className="cc-menu" data-hidden={hidden ? 'true' : undefined} aria-hidden={hidden || undefined} inert={hidden || undefined} data-slot="customer-analysis.menu"
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <ActionButton ref={btn} variant="outline" size="icon" aria-label={t('cctv.menu.label')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}><span aria-hidden="true">⋯</span></ActionButton>
      {open ? createPortal(
        <div ref={list} className="cc-menu__list" role="menu" aria-label={t('cctv.menu.label')} style={{ top: pos.top, right: pos.right }}>
          <button type="button" role="menuitem" className="cc-menu__item" onClick={() => pick(actions.reconnect)}>{t('cctv.menu.reconnect')}</button>
          <button type="button" role="menuitem" className="cc-menu__item" disabled={!actions.canResetZones} onClick={() => pick(actions.resetZones)}>{t('cctv.menu.resetZones')}</button>
          {actions.canResetZones ? null : <p className="cc-menu__hint" role="note">{t('cctv.menu.needCamera')}</p>}
        </div>, document.body) : null}
    </div>
  );
}

export type PanelRun = 'setup' | 'zones' | 'retry';
export interface PanelStatus { readonly textKey: string; readonly action: { readonly labelKey: string; readonly run: PanelRun } | null; /** Numbers stay visible next to the status (no zones yet). */ readonly keepNumbers: boolean }

/** SCR-345 status table for a live panel; null = numbers are shown as they are. */
export function livePanelStatus(view: CctvView): PanelStatus | null {
  switch (view.connection) {
    case 'none': return { textKey: 'cctv.conn.none', action: { labelKey: 'cctv.conn.connect', run: 'setup' }, keepNumbers: false };
    case 'waiting':
    case 'phone-opened': return { textKey: 'cctv.conn.waiting', action: { labelKey: 'cctv.conn.openSetup', run: 'setup' }, keepNumbers: false };
    case 'lost': return { textKey: 'cctv.conn.lost', action: { labelKey: 'cctv.conn.reconnect', run: 'setup' }, keepNumbers: false };
    case 'server-down': return { textKey: 'cctv.conn.serverDown', action: { labelKey: 'cctv.conn.retry', run: 'retry' }, keepNumbers: false };
    default:
      return view.zonesCount === 0 ? { textKey: 'cctv.zones.needed', action: { labelKey: 'cctv.zones.setup', run: 'zones' }, keepNumbers: true } : null;
  }
}

/** Numbers only when the connection is current (reconnecting keeps them, lost / down / none hide them: AC-1330). */
export const showsNumbers = (view: CctvView): boolean => view.mode === 'mock' || ((view.connection === 'live' || view.connection === 'reconnecting') && view.inStore !== null);
