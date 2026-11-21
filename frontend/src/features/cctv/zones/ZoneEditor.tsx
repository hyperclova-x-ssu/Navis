/**
 * T-073 SCR-349 table zone editor (F-59, AC-1335~1341, MOTION 11 M-34~M-36).
 * Zones sit over the camera frame (passed in as `background`); pointer = tap (adopt / select), long press 0.5 s (delete),
 * drag (draw around, or eraser). Undo, Done (PUT, closes only after success), Close (draft kept in page memory).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ActionButton, IconButton, useUi } from '../../../ui';
import { useBundle } from '../../../i18n';
import { cctvBundle } from '../messages';
import { createZonesApi, ZonesApiError, type ZonesApi } from './api';
import { DEFAULT_ASPECT, ERASER_RADIUS, zoneTokens, type DraftZone, type Point, type ZoneId, type ZoneSet } from './types';
import { applyOp, draftFromSaved, editorReducer, initialEditorState, keepDraft, newZoneId, putBody, renumber, takeKeptDraft, type EditorAction, type EditorContext, type EditorState } from './editor-state';
import { cellAt, displayRings, isDrawTooSmall, ringsToPath, zoneBounds, zoneCenter } from './mask';
import './zones.css';

export interface ZoneEditorProps {
  onSaved(z: ZoneSet): void;
  onClose(): void;
  /** Camera frame under the zones (live bitmap, still photo). */
  readonly background?: ReactNode;
  /** Current camera frame width / height; sent as frameAspect on save. */
  readonly frameAspect?: number | null;
  /** Saved zones when the caller already has them; otherwise the editor GETs them. */
  readonly initial?: ZoneSet;
  readonly api?: ZonesApi;
  /** Camera link lost while editing (SCREENS 9.6): frame frozen, editing continues. */
  readonly disconnected?: boolean;
  /** Test seam for zone ids. */
  readonly newId?: () => ZoneId;
  /** Controlled links for saved zones, supplied by the session owner. */
  readonly linkPicker?: { valueFor: (zoneId: string) => string | null; optionsFor: (zoneId: string) => readonly { value: string; label: string }[]; onChange: (zoneId: string, tableId: string | null) => void; disabled?: boolean; enabledFor?: (zoneId: string) => boolean };
}

type Phase = { kind: 'loading' } | { kind: 'load-failed' } | { kind: 'ready' };
type Suggest = 'idle' | 'finding' | 'none';
type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; conflict: boolean };
type Tool = 'draw' | 'erase';
interface Gesture { id: number; at: number; startPx: [number, number]; mode: 'press' | 'draw' | 'erase'; path: Point[]; hitId: ZoneId | null; timer: number | null; fired: boolean }
interface Notice { key: number; text: string; undo: boolean }

const ringCache = new WeakMap<Uint8Array, string>();
function zonePath(cells: Uint8Array, w: number, h: number): string {
  let d = ringCache.get(cells);
  if (d === undefined) { d = ringsToPath(displayRings(cells), w, h); ringCache.set(cells, d); }
  return d;
}

type Act = EditorAction | { type: 'reset'; state: EditorState } | { type: 'rebase'; revision: number };
function reduce(s: EditorState | null, { a, ctx }: { a: Act; ctx: EditorContext }): EditorState | null {
  if (a.type === 'reset') return a.state;
  if (!s) return s;
  if (a.type === 'rebase') return { ...s, draft: { ...s.draft, baseRevision: a.revision } };
  return editorReducer(s, a, ctx);
}

export function ZoneEditor({ onSaved, onClose, background, frameAspect, initial, api: apiProp, disconnected = false, newId = newZoneId, linkPicker }: ZoneEditorProps) {
  const { t } = useBundle(cctvBundle);
  const { reducedMotion } = useUi();
  const api = useMemo(() => apiProp ?? createZonesApi(), [apiProp]);
  const aspect = frameAspect ?? DEFAULT_ASPECT;
  const W = 1000; const H = W / aspect;
  const ctx = useMemo<EditorContext>(() => ({ aspect, newId }), [aspect, newId]);

  const [kept] = useState(takeKeptDraft);
  const [state, send] = useReducer(reduce, kept);
  const dispatch = useCallback((a: Act) => send({ a, ctx }), [ctx]);
  const [phase, setPhase] = useState<Phase>(kept ? { kind: 'ready' } : { kind: 'loading' });
  const [suggest, setSuggest] = useState<Suggest>('idle');
  const [guideOpen, setGuideOpen] = useState(() => !!kept && kept.draft.baseRevision === 0 && kept.draft.zones.every(z => !z.adopted) && kept.undo.length === 0);
  const [tool, setTool] = useState<Tool>('draw');
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [preview, setPreview] = useState<readonly DraftZone[] | null>(null);
  const [drawPath, setDrawPath] = useState<Point[] | null>(null);
  const [pressing, setPressing] = useState<{ id: ZoneId; held: boolean } | null>(null);
  const [eraserAt, setEraserAt] = useState<Point | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [announce, setAnnounce] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const loadSeq = useRef(0);

  const say = useCallback((text: string) => setAnnounce(text), []);
  const showNotice = useCallback((text: string, undo = false) => setNotice({ key: Date.now(), text, undo }), []);
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Opening (DATA_MODEL 12.3): saved zones open adopted; with none saved, ask for suggestions once.
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    let set: ZoneSet;
    try { set = await (initial ? Promise.resolve(initial) : api.get()); } catch { if (seq === loadSeq.current) setPhase({ kind: 'load-failed' }); return; }
    if (seq !== loadSeq.current) return;
    dispatch({ type: 'reset', state: initialEditorState(draftFromSaved(set)) });
    setPhase({ kind: 'ready' });
    if (set.zones.length > 0) return;
    setGuideOpen(true);
    setSuggest('finding');
    try {
      const res = await api.suggest();
      if (seq !== loadSeq.current) return;
      dispatch({ type: 'suggestions', zones: res.zones });
      setSuggest(res.zones.length ? 'idle' : 'none');
    } catch {
      if (seq === loadSeq.current) setSuggest('none');
    }
  }, [api, initial, dispatch]);
  useEffect(() => {
    if (kept) return;
    void Promise.resolve().then(load); // starts after commit; load only sets state after awaits
    const seq = loadSeq;
    return () => { seq.current++; };
    // Opening runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zones = preview ?? state?.draft.zones ?? [];
  const adoptedCount = zones.filter(z => z.adopted).length;
  const suggestedCount = zones.length - adoptedCount;
  const nameOf = (z: DraftZone) => t('cctv.table.n', { n: z.number });

  /* ---------- actions ---------- */
  const runOp = useCallback((op: Parameters<typeof applyOp>[1]) => dispatch({ type: 'op', op }), [dispatch]);
  const adopt = (z: DraftZone) => {
    runOp({ kind: 'adopt', id: z.id });
  };
  const remove = (z: DraftZone) => {
    const label = z.adopted ? z.number : null;
    runOp({ kind: 'remove', id: z.id });
    if (label !== null) showNotice(t('cctv.zones.deleted', { n: label }), true);
    say(label !== null ? t('cctv.zones.deleted', { n: label }) : t('cctv.zones.suggested'));
  };
  const undo = useCallback(() => {
    if (!state?.undo.length) return;
    dispatch({ type: 'undo' });
    setNotice(null);
    say(t('common.undone'));
  }, [state, say, t, dispatch]);

  // Announce adopt / draw results once the numbers are known.
  const lastZones = useRef<readonly DraftZone[] | null>(null);
  useEffect(() => {
    const prev = lastZones.current; const next = state?.draft.zones ?? null;
    lastZones.current = next;
    if (!prev || !next || prev === next) return;
    const before = new Map(prev.map(z => [z.id, z]));
    for (const z of next) {
      const old = before.get(z.id);
      if (z.adopted && (!old || !old.adopted)) { say(t('cctv.zoneEditor.added', { name: t('cctv.table.n', { n: z.number }) })); return; }
    }
  }, [state, say, t]);

  /* ---------- pointer ---------- */
  const toPoint = (e: { clientX: number; clientY: number }): Point => {
    const r = stageRef.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))), Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1)))];
  };
  const hitTest = (p: Point): DraftZone | null => {
    const i = cellAt(p[0], p[1]);
    if (i < 0) return null;
    return zones.find(z => z.adopted && z.cells[i]) ?? zones.find(z => !z.adopted && z.cells[i]) ?? null;
  };
  const clearGesture = () => {
    const g = gesture.current;
    if (g?.timer) window.clearTimeout(g.timer);
    gesture.current = null;
    setPressing(null); setDrawPath(null);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (phase.kind !== 'ready' || !state || save.kind === 'saving' || gesture.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stageRef.current?.setPointerCapture?.(e.pointerId);
    const p = toPoint(e);
    if (tool === 'erase') {
      gesture.current = { id: e.pointerId, at: performance.now(), startPx: [e.clientX, e.clientY], mode: 'erase', path: [p], hitId: null, timer: null, fired: false };
      setEraserAt(p);
      setPreview(renumber(applyOp(state.draft.zones, { kind: 'erase', path: [p], radius: ERASER_RADIUS }, ctx)));
      return;
    }
    const hit = hitTest(p);
    const g: Gesture = { id: e.pointerId, at: performance.now(), startPx: [e.clientX, e.clientY], mode: 'press', path: [p], hitId: hit?.id ?? null, timer: null, fired: false };
    gesture.current = g;
    if (hit) {
      setPressing({ id: hit.id, held: true });
      g.timer = window.setTimeout(() => {
        g.fired = true; g.timer = null;
        const z = state.draft.zones.find(x => x.id === hit.id);
        setPressing(null);
        if (z) { remove(z); navigator.vibrate?.(10); }
      }, reducedMotion ? zoneTokens.reducedLongPressMs : zoneTokens.longPressMs);
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = tool === 'erase' || gesture.current ? toPoint(e) : null;
    if (tool === 'erase' && p) setEraserAt(p);
    const g = gesture.current;
    if (!g || g.id !== e.pointerId || !p || !state) return;
    if (g.mode === 'press') {
      if (g.fired) return;
      if (Math.hypot(e.clientX - g.startPx[0], e.clientY - g.startPx[1]) <= zoneTokens.drawThresholdPx) return;
      if (g.timer) { window.clearTimeout(g.timer); g.timer = null; }
      setPressing(null);
      g.mode = 'draw';
    }
    const last = g.path[g.path.length - 1];
    if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.002) return;
    g.path.push(p);
    if (g.mode === 'draw') setDrawPath([...g.path]);
    else setPreview(prev => renumber(applyOp(prev ?? state.draft.zones, { kind: 'erase', path: [last, p], radius: ERASER_RADIUS }, ctx)));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId || !state) return;
    if (g.timer) window.clearTimeout(g.timer);
    gesture.current = null;
    setPressing(null);
    if (g.mode === 'erase') {
      setPreview(null);
      const next = editorReducer(state, { type: 'op', op: { kind: 'erase', path: g.path, radius: ERASER_RADIUS } }, ctx);
      if (next !== state) { dispatch({ type: 'op', op: { kind: 'erase', path: g.path, radius: ERASER_RADIUS } }); say(t('cctv.zoneEditor.erased')); }
      return;
    }
    if (g.mode === 'draw') {
      setDrawPath(null);
      const op = { kind: 'draw', path: g.path } as const;
      if (isDrawTooSmall(g.path, aspect) || editorReducer(state, { type: 'op', op }, ctx) === state) { showNotice(t('cctv.zones.tooSmall')); say(t('cctv.zones.tooSmall')); return; }
      runOp(op);
      return;
    }
    if (g.fired) return;
    if (g.hitId && performance.now() - g.at > zoneTokens.tapMaxMs) return; // long press let go early: cancelled
    const z = g.hitId ? state.draft.zones.find(x => x.id === g.hitId) : undefined;
    if (!z) { dispatch({ type: 'select', id: null }); return; }
    if (!z.adopted) adopt(z);
    else dispatch({ type: 'select', id: z.id });
  };
  const onPointerCancel = () => { clearGesture(); setPreview(null); };
  useEffect(() => () => { if (gesture.current?.timer) window.clearTimeout(gesture.current.timer); }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state?.selectedId) {
      const z = state.draft.zones.find(x => x.id === state.selectedId);
      if (z) { e.preventDefault(); remove(z); }
    }
  };

  /* ---------- save / close ---------- */
  const done = async () => {
    if (!state || adoptedCount === 0 || save.kind === 'saving') return;
    setSave({ kind: 'saving' });
    try {
      const set = await api.put(putBody(state.draft, frameAspect ?? state.draft.frameAspect ?? null));
      keepDraft(null);
      setSave({ kind: 'idle' });
      navigator.vibrate?.(10);
      onSaved(set);
    } catch (err) {
      const conflict = err instanceof ZonesApiError && err.code === 'REVISION_CONFLICT';
      if (conflict && err.current) dispatch({ type: 'rebase', revision: err.current.revision });
      setSave({ kind: 'failed', conflict });
      say(t(conflict ? 'cctv.zoneEditor.conflict' : 'cctv.zones.saveFailed'));
    }
  };
  const close = () => { clearGesture(); keepDraft(state); onClose(); };

  /* ---------- render ---------- */
  const selected = state?.selectedId ? zones.find(z => z.id === state.selectedId) : undefined;
  const selBounds = selected ? zoneBounds(selected.cells) : null;
  const press = pressing ? zones.find(z => z.id === pressing.id) : undefined;
  const pressCenter = press ? zoneCenter(press.cells) : null;
  const undoDisabled = !state?.undo.length;
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

  return (
    <div className="cz-editor" data-reduced={reducedMotion ? 'true' : 'false'} onKeyDown={onKeyDown}>
      {guideOpen && (
        <section className="cz-guide" aria-labelledby="cz-guide-title">
          <p className="cz-guide__title" id="cz-guide-title">{t('cctv.zones.helpTitle')}</p>
          <p className="cz-guide__row"><GuideIcon kind="tap" />{t('cctv.zones.help1')}</p>
          <p className="cz-guide__row"><GuideIcon kind="draw" />{t('cctv.zones.help2')}</p>
          <p className="cz-guide__row"><GuideIcon kind="erase" />{t('cctv.zones.help3')}</p>
          <div className="cz-guide__actions"><ActionButton variant="secondary" onClick={() => setGuideOpen(false)}>{t('common.ok')}</ActionButton></div>
        </section>
      )}

      <div
        ref={stageRef}
        className="cz-stage"
        style={{ aspectRatio: String(aspect) }}
        data-tool={tool}
        role="application"
        aria-label={t('cctv.zoneEditor.stage')}
        aria-roledescription={t('cctv.zoneEditor.stage')}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => { if (!gesture.current) setEraserAt(null); }}
        onContextMenu={e => e.preventDefault()}
        data-testid="zone-stage"
      >
        <div className="cz-stage__bg">{background}</div>
        <svg className="cz-layer cz-layer--suggest" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {zones.map(z => {
            const d = zonePath(z.cells, W, H);
            return (
              <g key={z.id} className="cz-zone" data-zone={z.id} data-adopted={String(z.adopted)} data-selected={String(z.id === state?.selectedId)} data-pressed={String(reducedMotion && pressing?.id === z.id)}>
                <path className="cz-zone__fill" d={d} fillRule="evenodd" />
                <path className="cz-zone__halo" d={d} />
                <path className="cz-zone__line" d={d} />
              </g>
            );
          })}
          {drawPath && drawPath.length > 1 && (
            <>
              <polyline className="cz-path cz-path--halo" points={drawPath.map(([x, y]) => `${x * W},${y * H}`).join(' ')} />
              <polyline className="cz-path" points={drawPath.map(([x, y]) => `${x * W},${y * H}`).join(' ')} />
            </>
          )}
        </svg>
        {zones.map(z => {
          const b = zoneBounds(z.cells);
          if (!b) return null;
          return <span key={z.id} className="cz-chip" style={{ left: pct(b.x0), top: pct(b.y0) }} aria-hidden="true">{z.adopted ? nameOf(z) : t('cctv.zones.suggested')}</span>;
        })}
        {selected && selBounds && tool === 'draw' && (
          <span className="cz-delete" style={{ left: pct(selBounds.x1), top: pct(selBounds.y0) }} onPointerDown={e => e.stopPropagation()}>
            <IconButton icon="remove" variant="secondary" label={t('cctv.zoneEditor.deleteZone', { name: nameOf(selected) })} onClick={() => remove(selected)} />
          </span>
        )}
        {press && pressCenter && !reducedMotion && (
          <svg className="cz-ring" viewBox="0 0 56 56" style={{ left: pct(pressCenter.cx), top: pct(pressCenter.cy) }} data-suggest={String(!press.adopted)} aria-hidden="true" data-testid="long-press-ring">
            <circle className="cz-ring__halo" cx="28" cy="28" r="24" />
            <circle className="cz-ring__fill" cx="28" cy="28" r="24" />
          </svg>
        )}
        {press && pressCenter && reducedMotion && (
          <span className="cz-hold-caption" style={{ left: pct(pressCenter.cx), top: pct(pressCenter.cy) }}>{t('cctv.zoneEditor.keepPressing')}</span>
        )}
        {tool === 'erase' && eraserAt && <span className="cz-eraser" style={{ left: pct(eraserAt[0]), top: pct(eraserAt[1]) }} aria-hidden="true" />}
        {(phase.kind === 'loading' || suggest === 'finding') && (
          <span className="cz-status-chip" role="status"><span className="cz-spinner" aria-hidden="true" />{t('cctv.zones.finding')}</span>
        )}
        {disconnected && <span className="cz-status-chip cz-status-chip--top" role="status">{t('cctv.conn.lost')}</span>}
      </div>

      {phase.kind === 'load-failed' && (
        <div className="cz-error" role="alert">
          <span>{t('cctv.conn.serverDown')}</span>
          <ActionButton variant="secondary" onClick={() => { setPhase({ kind: 'loading' }); void load(); }}>{t('cctv.conn.retry')}</ActionButton>
        </div>
      )}
      {suggest === 'none' && <p className="cz-summary">{t('cctv.zones.noneFound')}</p>}

      <div className="cz-toolbar" role="toolbar" aria-label={t('cctv.setup.stepZones')}>
        <ActionButton variant="outline" aria-pressed={tool === 'draw'} onClick={() => setTool('draw')}><GuideIcon kind="draw" />{t('cctv.zones.toolDraw')}</ActionButton>
        <ActionButton variant="outline" aria-pressed={tool === 'erase'} onClick={() => { setTool(tool === 'erase' ? 'draw' : 'erase'); dispatch({ type: 'select', id: null }); }}><GuideIcon kind="erase" />{t('cctv.zones.toolErase')}</ActionButton>
        <ActionButton variant="outline" disabled={undoDisabled} aria-describedby={undoDisabled ? 'cz-undo-reason' : undefined} title={undoDisabled ? t('cctv.zones.nothingToUndo') : undefined} onClick={undo}><UndoIcon />{t('cctv.zones.toolUndo')}</ActionButton>
        <span id="cz-undo-reason" className="ui-sr-only">{t('cctv.zones.nothingToUndo')}</span>
        {!guideOpen && <ActionButton variant="ghost" onClick={() => setGuideOpen(true)}>{t('cctv.zones.howTo')}</ActionButton>}
        <span className="cz-toolbar__spacer" />
        <ActionButton variant="ghost" onClick={close}>{t('common.close')}</ActionButton>
        <ActionButton size="primary" loading={save.kind === 'saving'} disabled={adoptedCount === 0 || save.kind === 'saving' || phase.kind !== 'ready'} aria-describedby={adoptedCount === 0 ? 'cz-done-reason' : undefined} onClick={() => void done()}>
          {save.kind === 'saving' ? t('cctv.zoneEditor.saving') : t('cctv.zones.toolDone')}
        </ActionButton>
      </div>

      <p className="cz-summary" id="cz-done-reason">
        {adoptedCount === 0 ? t('cctv.zones.atLeastOne') : suggestedCount > 0 ? t('cctv.zoneEditor.summary', { a: adoptedCount, b: suggestedCount }) : t('cctv.zoneEditor.summaryTables', { a: adoptedCount })}
      </p>

      {save.kind === 'failed' && (
        <div className="cz-error" role="alert">
          <span>{t(save.conflict ? 'cctv.zoneEditor.conflict' : 'cctv.zones.saveFailed')}</span>
          <ActionButton variant="secondary" onClick={() => void done()}>{t('cctv.conn.retry')}</ActionButton>
        </div>
      )}
      {notice && (
        <div className="cz-notice" key={notice.key}>
          <span>{notice.text.split(' · ')[0]}</span>
          {notice.undo && <ActionButton variant="link" onClick={undo}>{t('cctv.zones.toolUndo')}</ActionButton>}
        </div>
      )}

      <details className="cz-list">
        <summary>{t('cctv.zoneEditor.list')}</summary>
        {linkPicker?.disabled ? <p>테이블별 주문이 있는 후불형에서 연결할 수 있어요</p> : null}
        <ul>
          {[...zones].sort((a, b) => Number(b.adopted) - Number(a.adopted) || a.number - b.number).map(z => (
            <li key={z.id}>
              <span>{z.adopted ? t('cctv.zoneEditor.adopted', { name: nameOf(z) }) : t('cctv.zones.suggestedHint')}</span>
              {z.adopted && linkPicker && (linkPicker.enabledFor?.(z.id) ?? true) ? <label>POS 테이블 연결 <select aria-label={`${nameOf(z)} POS 테이블 연결`} value={linkPicker.valueFor(z.id) ?? ''} disabled={linkPicker.disabled} onChange={event => linkPicker.onChange(z.id, event.currentTarget.value || null)}><option value="">연결 안 됨</option>{linkPicker.optionsFor(z.id).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null}
              {!z.adopted && <ActionButton variant="secondary" onClick={() => adopt(z)}>{t('cctv.zoneEditor.adopt')}</ActionButton>}
              <ActionButton variant="outline" aria-label={z.adopted ? t('cctv.zoneEditor.deleteZone', { name: nameOf(z) }) : undefined} onClick={() => remove(z)}>{t('cctv.zoneEditor.delete')}</ActionButton>
            </li>
          ))}
        </ul>
      </details>

      <p className="ui-sr-only" aria-live="polite" data-testid="zone-announce">{announce}</p>
    </div>
  );
}

function GuideIcon({ kind }: { readonly kind: 'tap' | 'draw' | 'erase' }) {
  return (
    <svg className="cz-icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {kind === 'tap' && <><rect x="3" y="5" width="14" height="10" rx="2" strokeDasharray="3 2.5" /><circle cx="10" cy="10" r="1.6" fill="currentColor" /></>}
      {kind === 'draw' && <path d="M4 12c0-4 3-7 7-7 3 0 5 2 5 4.5S13.5 15 10 15c-2 0-3.5-.6-4.5-1.5M5.5 13.5 4 16" />}
      {kind === 'erase' && <><path d="M8 16h8M3.5 11.5 10 5l5 5-5.5 6H7.5z" /><path d="m7 8 5 5" /></>}
    </svg>
  );
}
function UndoIcon() {
  return <svg className="cz-icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 5 3.5 8.5 7 12" /><path d="M4 8.5h7.5a4.5 4.5 0 0 1 0 9H9" /></svg>;
}
