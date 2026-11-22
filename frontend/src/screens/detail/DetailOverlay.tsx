import {selectDetailViewState,type PresentationRunStore} from '../../state';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { animate, motion, useMotionValue } from 'motion/react';
import type { DetailRef, FeatureId, InputSequence, RunStore, ViewportTransform } from '../../contracts';
import { getRegistration } from '../../catalog';
import { useBundle } from '../../i18n';
import { cctvBundle, useCctvMode } from '../../features/cctv';
import { createWidgetHost, useWidgetModule } from '../../features/widgets/registry-context';
import { useWidgetViewStatus } from '../../data/react';
import { DetailFooterContext, ActionButton, ContentRecovery, DetailDialog, HelpButton, Icon, InlineError, OverlayExitSurface, WidgetCoach, getPresetLayout, groupStyle, motionTokens, panelLayoutId, toCanvasRect, transitionFor, useUi, type CloseReason, type FrameRect } from '../../ui';
import { detailBundle } from './messages';
import { FullscreenToggle } from '../../ui/components/overlays';
import { registerGridLayer } from '../../ui/grid-interactions';
import { observeTextDetailHeight } from '../../ui/text-detail-layout';
import { compactFrameHeight, detailFrameStyle, textDetailFrame, type MeasuredFrameHeight } from './compact-layout';
import './detail-v4.css';

export type DetailFrameClass = 'large' | 'compact';
export function detailFrameClass(featureId:FeatureId):DetailFrameClass{
  return getRegistration(featureId)?.detail.frame === 'compact' ? 'compact' : 'large';
}
/** Linked/back openings grow from the centre of the target frame (M-06 variant), not from a panel. */
function centeredFrame(target: FrameRect): FrameRect {
  const scale = motionTokens.scaleOverlay;
  const width = target.width * scale, height = target.height * scale;
  return { x: target.x + (target.width - width) / 2, y: target.y + (target.height - height) / 2, width, height };
}
const defaultCondition = { kind: 'default' } as const;

export interface DetailOverlayProps {
  readonly run: RunStore;
  /** Defaults to the panel hit target's id; the dashboard can supply its own registry. */
  readonly resolveReturnFocus?: (key: string) => HTMLElement | null;
  /** Development-only fault for the root verification scenario; retry restores the real content. */
  readonly simulateContentError?: boolean;
}
const resolveById = (key: string) => document.getElementById(key);
const ignoreKitExit = () => undefined;
const identity = 'translate3d(0px, 0px, 0px) scale(1, 1)';
function frameTransform(frame: FrameRect, base: FrameRect): string {
  if (base.width <= 0 || base.height <= 0) return identity;
  return `translate3d(${frame.x - base.x}px, ${frame.y - base.y}px, 0px) scale(${frame.width / base.width}, ${frame.height / base.height})`;
}
function interpolateFrame(from: FrameRect, to: FrameRect, progress: number): FrameRect {
  return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress, width: from.width + (to.width - from.width) * progress, height: from.height + (to.height - from.height) * progress };
}
function panelFrame(target: HTMLElement | null, fallback: FrameRect, viewport: ViewportTransform | null): FrameRect {
  const element = target?.closest<HTMLElement>('[data-feature-id]') ?? target;
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return fallback;
  return viewport ? toCanvasRect(rect, viewport) : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
function inputFor(event?: Event): InputSequence | undefined {
  if (event instanceof KeyboardEvent && event.type === 'keydown') return { kind: 'keyboard', id: event.code || event.key };
  if (event instanceof PointerEvent && event.type === 'pointerdown') return { kind: 'pointer', id: event.pointerId };
  return undefined;
}

/** Owns only the close sequence; the application continues to own general/wake input. */
function useClosingInput(run: RunStore) {
  useEffect(() => {
    let released = false;
    const end = (event: Event) => {
      const input = run.getState().closingInput;
      if (!input) return;
      if (input.kind === 'pointer' && event instanceof PointerEvent && event.pointerId === input.id) {
        released = true;
        run.actions.consumeInput(input, event.type === 'pointercancel' ? 'cancel' : 'up');
      } else if (input.kind === 'keyboard' && event instanceof KeyboardEvent && (event.code || event.key) === input.id) {
        run.actions.inputEnded(input); run.actions.consumeInput(input, 'cancel');
      }
    };
    const click = () => { const input = run.getState().closingInput; if (input?.kind === 'pointer') run.actions.consumeInput(input, 'click'); released = false; };
    const start = (event: Event) => {
      const input = run.getState().closingInput;
      if (!input) return;
      if (released || input.kind === 'keyboard' && event instanceof PointerEvent || input.kind === 'pointer' && event instanceof KeyboardEvent) run.actions.consumeInput(input, 'cancel');
      released = false;
    };
    const cancel = () => { const input = run.getState().closingInput; if (input) run.actions.consumeInput(input, 'cancel'); released = false; };
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
    document.addEventListener('keyup', end, true);
    document.addEventListener('click', click, true);
    document.addEventListener('pointerdown', start, true);
    document.addEventListener('keydown', start, true);
    window.addEventListener('blur', cancel);
    return () => {
      document.removeEventListener('pointerup', end, true);
      document.removeEventListener('pointercancel', end, true);
      document.removeEventListener('keyup', end, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('pointerdown', start, true);
      document.removeEventListener('keydown', start, true);
      window.removeEventListener('blur', cancel);
    };
  }, [run]);
}

/** Mount once under UiProvider. Logical modal lifetime and visual exit lifetime are separate. */
export function DetailOverlay({ run, resolveReturnFocus = resolveById, simulateContentError = false }: DetailOverlayProps) {
  const state = useSyncExternalStore(run.subscribe, run.getState);
  const { reducedMotion, textScale, portalContainer, transform: viewportTransform } = useUi();
  const preset = state.screenPreset;
  const layout = useMemo(() => getPresetLayout(preset), [preset]);
  const viewport = useRef(viewportTransform);
  // Fit changes only reproject the canvas. Keep the running logical frame and deadline.
  useLayoutEffect(() => { viewport.current = viewportTransform; }, [viewportTransform]);
  const active = state.overlay.type === 'detail';
  const retained=useRef<Extract<typeof state.overlay,{type:'detail'}>|null>(null);
  const [bodyHost]=useState(()=>document.createElement('div'));
  const bodies=useRef(new Map<string,React.ReactNode>());
  const [outerScroll] = useState(() => new WeakMap<HTMLElement, { top: number; left: number }>());
  const currentDescriptor = state.overlay.type === 'detail' ? state.overlay : state.overlay.type === 'none' && state.exitingOverlay?.type === 'detail' ? state.exitingOverlay : null;
  if(currentDescriptor)retained.current=currentDescriptor;
  const descriptor=currentDescriptor??(state.overlay.type==='closing'?retained.current:null);
  const featureId = descriptor?.featureId;
  const returnFocusKey = descriptor?.returnFocusKey;
  const stack = descriptor?.type === 'detail' ? descriptor.stack : undefined;
  const depth = stack?.length ?? 1;
  const stackTop = stack?.at(-1);
  const detailRef = useMemo<DetailRef | null>(() => stackTop ?? (featureId ? { featureId } : null), [stackTop, featureId]);
  const translator = useBundle(detailBundle);
  const cctvT = useBundle(cctvBundle).t;
  const cctvMode = useCctvMode();
  const { t } = translator;
  const text = (key: string) => (translator as { has(key: string): boolean; t(key: string): string }).has(key) ? (translator as { t(key: string): string }).t(key) : '';
  const module = useWidgetModule(featureId ?? ('' as FeatureId));
  const ModuleDetail = module?.Detail ?? null;
  const condition = (featureId ? state.panels.find(panel => panel.featureId === featureId)?.condition : undefined) ?? defaultCondition;
  // SCR-31: the frame follows the widget, with or without its module (a missing module shows the error state in the same frame).
  const frameClass: DetailFrameClass = featureId ? detailFrameClass(featureId) : 'large';
  const fullscreen = state.detailDialogFullscreen;
  // K-E 11: a widget that has nothing to list (empty) or failed to load shows its short state in the compact window (spec minimum 560 / 640 at 125%),
  // not in the 952-high large frame that would stay mostly empty. A ready widget keeps its registered frame.
  const viewStatus = useWidgetViewStatus(featureId ?? null, condition);
  const stateCompact = viewStatus !== null && viewStatus !== 'ready';
  const compact = frameClass === 'compact' || stateCompact;
  // U-D: the kit animates the dialog's width/height only for the fullscreen toggle (iteration7.css). A link or back swaps
  // compact <-> large and must jump to the new frame: the FLIP animates it, and the compact height is measured from the real size.
  // So the transition is allowed only while a fullscreen change is running.
  const [seenFullscreen, setSeenFullscreen] = useState(fullscreen);
  const [resizing, setResizing] = useState(false);
  if (seenFullscreen !== fullscreen) { setSeenFullscreen(fullscreen); setResizing(true); }
  useEffect(() => {
    if (!resizing) return;
    const timer = setTimeout(() => setResizing(false), motionTokens.duration.fly + 100);
    return () => clearTimeout(timer);
  }, [resizing]);
  const host = useMemo(() => {
    if(!featureId||!returnFocusKey)return null;
    const base=createWidgetHost(run,{featureId,layer:state.activeBoard,focusKey:returnFocusKey});
    const allowed=()=>{const invalid=bodyHost.querySelector<HTMLElement>('[aria-invalid="true"]');if(invalid){invalid.focus();return false;}return true;};
    return {...base,openLinked:(ref:DetailRef)=>{if(allowed())base.openLinked(ref);},openDetail:(ref:DetailRef)=>{if(allowed())base.openDetail(ref);},openClosing:(key:string)=>allowed()&&base.openClosing(key)};
  },[run,featureId,returnFocusKey,state.activeBoard,bodyHost]);
  const helpRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const lastDepth = useRef<number | null>(null);
  const lastFullscreen = useRef<boolean | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const announcementTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(announcementTimer.current), []);
  const helpOpen = active && state.widgetHelp?.origin === 'detail' && state.widgetHelp.featureId === featureId;
  // K-B: the open help is the first Esc step (DS 12.2: help -> cell edit -> CellError -> side panel -> window), whatever holds focus
  // inside the window. It joins the same document-level layer stack as the grid and the side panel, above both, so one Esc closes
  // only the help and focus goes back to the (?) button that opened it.
  useLayoutEffect(() => {
    const button = helpRef.current;
    if (!helpOpen || !button) return;
    return registerGridLayer({ root: button, priority: () => 50, dismiss: () => { run.actions.closeWidgetHelp(); button.focus({ preventScroll: true }); } });
  }, [helpOpen, run]);
  // K-B: an open inline form (or any widget-local inline layer that marks itself `data-esc-layer` and owns a `data-esc-close` button) is one Esc
  // step as well, even while focus is outside it (for example on the (?) button after the help closed) or while a side panel sits below it.
  // The layer presses the layer's own close button, so its close path (and its focus return to the opener) stays the widget's / the form's.
  useLayoutEffect(() => {
    if (!active) return;
    const closeSelector = 'button[data-inline-form-action]:not([type="submit"]), [data-esc-close]';
    // Forms inside a side panel are the panel's own sections (e.g. 주문제작 견적·승인): their close only resets values, so Esc there stays the panel's step.
    const openLayers = () => Array.from(bodyHost.querySelectorAll<HTMLElement>('form.ui-inline-form, [data-esc-layer]')).filter(el => !el.closest('[inert], .ui-detail-side-panel') && el.querySelector(closeSelector));
    return registerGridLayer({ root: bodyHost, priority: () => openLayers().length ? 15 : 0, dismiss: () => { openLayers().at(-1)?.querySelector<HTMLElement>(closeSelector)?.click(); } });
  }, [active, bodyHost]);
  const compactTokens = useMemo(() => featureId==='briefing' ? {...layout.textDetail,minHeight:state.screenPreset.id==='B'?800:720,largeTextMinHeight:state.screenPreset.id==='B'?800:720} : layout.textDetail, [featureId, layout.textDetail, state.screenPreset.id]);
  // U-D: the compact height is plain React state keyed by widget/preset/text size. A motion value wrote `height` straight into the DOM
  // and Motion never cleared it, so the next (large) widget in the same dialog kept the previous compact height.
  const bodyKey = detailRef ? `${detailRef.featureId}:${detailRef.view ?? ''}:${detailRef.itemId ?? ''}:${detailRef.focus ?? ''}` : '';
  const frameKey = `${bodyKey}|${preset.id}|${textScale}|${stateCompact ? 'state' : 'frame'}`;
  const [measuredHeight, setMeasuredHeight] = useState<MeasuredFrameHeight | null>(null);
  const latestHeight = useRef<MeasuredFrameHeight | null>(null);
  const compactHeight = compactFrameHeight(measuredHeight, frameKey, compactTokens, textScale);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [recoveredFault, setRecoveredFault] = useState<string | null>(null);
  const faultKey = `${state.runId}:${featureId}`;
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  const claim = useCallback((on: boolean) => setClaims(n => Math.max(0, n + (on ? 1 : -1))), []);
  const footerCtx = useMemo(() => ({ slot: footerSlot, claim }), [footerSlot, claim]);
  const memory = useRef<{ key: string; frame: FrameRect; opacity: number } | null>(null);
  const transform = useMotionValue(identity);
  const opacity = useMotionValue(0);
  useClosingInput(run);
  useLayoutEffect(()=>{
    if(!active||!detailRef)return;
    const view = bodyHost.querySelector<HTMLElement>(':scope > div:not([hidden])');
    const viewport = bodyHost.closest<HTMLElement>('.ui-overlay-body');
    if (!view || !viewport) return;
    const scroller = () => view.querySelector<HTMLElement>('.ui-data-grid__scroll,[data-grid-scroll]') ?? viewport;
    let live = true, initialFocusPending = true;
    const wanted = () => {
      const saved = selectDetailViewState(run.getState());
      if (saved?.ref.featureId !== detailRef.featureId) return;
      return Array.from(view.querySelectorAll<HTMLElement>('[data-focus-key],[id]')).find(el => el.dataset.focusKey === saved.focusKey || el.id === saved.focusKey);
    };
    const restore = () => {
      const current = run.getState(), saved = selectDetailViewState(current);
      if (!live || current.overlay.type !== 'detail' || saved?.ref.featureId !== detailRef.featureId) return;
      const scroll = scroller();
      const outer = outerScroll.get(view);
      if (outer && scroll !== viewport) { viewport.scrollTop = outer.top; viewport.scrollLeft = outer.left; }
      scroll.scrollTop = saved.scrollTop;
      scroll.scrollLeft = saved.scrollLeft;
      wanted()?.focus({ preventScroll: true });
    };
    if (depth > 1 && !selectDetailViewState(run.getState())) { viewport.scrollTop = 0; viewport.scrollLeft = 0; }
    // The kit's default initial focus is Close. A returning controller owns that one
    // initial focus decision; the first user input releases this guard immediately.
    const initialFocus=(event:FocusEvent)=>{if(initialFocusPending&&event.target instanceof HTMLElement&&event.target.matches('[data-ui-close]')&&wanted()){initialFocusPending=false;restore();}};
    const release=()=>{initialFocusPending=false;};
    surface?.addEventListener('focusin',initialFocus,true);surface?.addEventListener('pointerdown',release,true);surface?.addEventListener('keydown',release,true);
    queueMicrotask(restore);const restoreFrame=requestAnimationFrame(restore);
    const remember = () => {
      const scroll = scroller();
      outerScroll.set(view, { top: viewport.scrollTop, left: viewport.scrollLeft });
      const el = document.activeElement as HTMLElement | null, prior = selectDetailViewState(run.getState());
      (run as PresentationRunStore).actions.rememberDetailState({
        ref: detailRef, tab: prior?.tab ?? detailRef.view ?? '',
        query: view.querySelector<HTMLInputElement>('input[type=search]')?.value ?? prior?.query ?? '',
        sort: prior?.sort ?? null, filters: prior?.filters ?? {}, expandedRowIds: prior?.expandedRowIds ?? [],
        selectedRowId: prior?.selectedRowId ?? null, scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft,
        focusKey: el?.dataset.focusKey || el?.id || prior?.focusKey || '',
      });
    };
    const rememberScroll = (event: Event) => {
      if (event.target === viewport || (event.target instanceof Node && view.contains(event.target))) remember();
    };
    viewport.addEventListener('scroll', rememberScroll, true);
    view.addEventListener('focusin', remember);
    view.addEventListener('change', remember);
    return () => {
      live = false;
      cancelAnimationFrame(restoreFrame);
      surface?.removeEventListener('focusin', initialFocus, true);
      surface?.removeEventListener('pointerdown', release, true);
      surface?.removeEventListener('keydown', release, true);
      viewport.removeEventListener('scroll', rememberScroll, true);
      view.removeEventListener('focusin', remember);
      view.removeEventListener('change', remember);
    };
  },[active,detailRef,depth,bodyHost,outerScroll,run,surface]);

  useLayoutEffect(() => {
    if (!active || !compact || fullscreen || !surface) return;
    return observeTextDetailHeight(surface, naturalHeight => {
      const { height } = textDetailFrame(preset, compactTokens, textScale, naturalHeight);
      if (latestHeight.current?.key === frameKey && latestHeight.current.height === height) return;
      const next = { key: frameKey, height };
      latestHeight.current = next;
      setMeasuredHeight(next);
    });
  }, [active, compact, fullscreen, surface, preset, compactTokens, textScale, frameKey]);

  useLayoutEffect(() => {
    if (!featureId || !returnFocusKey) { memory.current = null; lastDepth.current = null; lastFullscreen.current = null; transform.set(identity); opacity.set(0); return; }
    if (!surface) return;
    const depthChanged = lastDepth.current !== null && lastDepth.current !== depth;
    lastDepth.current = depth;
    const origin = resolveReturnFocus(returnFocusKey);
    returnFocusRef.current = origin;
    const openFrame = () => {
      if (fullscreen) return { x: 0, y: 0, width: preset.baselineWidth, height: preset.baselineHeight };
      if (!compact) return layout.detail;
      return textDetailFrame(preset, compactTokens, textScale, compactFrameHeight(latestHeight.current, frameKey, compactTokens, textScale));
    };
    const expanded = openFrame();
    const key = panelLayoutId(featureId);
    // Resizing an already open dialog changes its frame, not the body transform.
    if (active && !depthChanged && memory.current?.key === key && lastFullscreen.current !== null && lastFullscreen.current !== fullscreen) {
      lastFullscreen.current = fullscreen;
      memory.current = { key, frame: expanded, opacity: 1 };
      transform.set(identity); opacity.set(1);
      return;
    }
    lastFullscreen.current = fullscreen;
    const centered = active && depthChanged && !reducedMotion;
    const prior = memory.current?.key === key ? memory.current : null;
    // A settled compact body may have resized since its opening flight completed.
    const previousFrame = !active && compact && !fullscreen && prior?.opacity === 1 ? expanded : prior?.frame;
    const from = centered ? centeredFrame(expanded) : previousFrame ?? panelFrame(origin, expanded, viewport.current);
    const fromOpacity = centered ? 0 : prior?.opacity ?? (active ? 0 : 1);
    const toOpacity = active ? 1 : 0;
    memory.current = { key, frame: from, opacity: fromOpacity };
    transform.set(reducedMotion ? identity : frameTransform(from, expanded));
    opacity.set(fromOpacity);
    const exitToken = state.exitPendingToken;
    const playback = animate(0, 1, {
      duration: motionTokens.duration[reducedMotion ? 'reduced' : active ? 'detailIn' : 'detailOut'] / 1000,
      ease: motionTokens.ease.out,
      onUpdate: progress => {
        // A close target may be remeasured after resize without restarting its clock.
        const base = active ? openFrame() : expanded;
        const to = active ? base : panelFrame(origin, base, viewport.current);
        const frame = interpolateFrame(from, to, progress);
        const alpha = fromOpacity + (toOpacity - fromOpacity) * progress;
        memory.current = { key, frame, opacity: alpha };
        transform.set(reducedMotion ? identity : frameTransform(frame, base));
        opacity.set(alpha);
      },
      onComplete: () => { if (!active && exitToken) run.actions.finishOverlayExit(exitToken); },
    });
    return () => playback.stop();
  }, [active, featureId, depth, returnFocusKey, fullscreen, reducedMotion, resolveReturnFocus, transform, opacity, surface, state.exitPendingToken, run, preset, layout, compact, compactTokens, frameKey, textScale, recoveredFault]);

  useEffect(() => {
    // A linked open or a back replaces the body the opener lived in; keep focus inside the dialog.
    if (!active) return;
    if (depth > 1) backRef.current?.focus({ preventScroll: true });
  }, [active, depth, featureId]);

  const close = (reason: CloseReason, event?: Event) => {
    // Esc closes an open detail help first, then the detail itself.
    if (reason === 'Esc' && run.getState().widgetHelp?.origin === 'detail') { run.actions.closeWidgetHelp(); return; }
    run.actions.closeOverlay(reason, inputFor(event));
    // Base UI also restores focus; this makes logical close immediate, before its next frame.
    returnFocusRef.current?.focus({ preventScroll: true });
  };
  const body = ModuleDetail && featureId && detailRef && host
    ? <ContentRecovery key={`${featureId}:${detailRef.view ?? ''}:${detailRef.itemId ?? ''}`} onRetry={() => setRecoveredFault(faultKey)}><CheckedModuleBody Detail={ModuleDetail} featureId={featureId} condition={condition} detailRef={detailRef} host={host} fail={simulateContentError && recoveredFault !== faultKey} /></ContentRecovery>
    : <InlineError onRetry={() => { if (featureId && returnFocusKey) run.actions.openDetail(featureId, returnFocusKey); }} />;
  if(descriptor&&bodyKey){bodies.current.set(bodyKey,body);if(active){const allowed=new Set((stack??[detailRef!]).map(ref=>`${ref.featureId}:${ref.view??''}:${ref.itemId??''}:${ref.focus??''}`));for(const key of bodies.current.keys())if(!allowed.has(key))bodies.current.delete(key);}}
  if(!descriptor){bodies.current.clear();retained.current=null;}
  const preserved=<DetailFooterContext.Provider value={footerCtx}>{createPortal(<>{[...bodies.current].map(([key,content])=><div key={key} hidden={!active||key!==bodyKey} inert={!active||key!==bodyKey||undefined}><DetailFooterContext.Provider value={active&&key===bodyKey?footerCtx:{slot:null,claim:()=>undefined}}>{content}</DetailFooterContext.Provider></div>)}</>,bodyHost)}</DetailFooterContext.Provider>;
  const bodySlot=<div ref={node=>{if(node&&!node.contains(bodyHost))node.append(bodyHost);}} className="detail-body-slot"/>;
  const widgetName = featureId ? text(`widget.${featureId}.title`) : '';
  const coachText = featureId ? text(`widget.${featureId}.coach`) : '';
  const title = widgetName || t('detail.error');
  const showCctvPrivacy = featureId === 'customer-analysis' && cctvMode === 'live' && claims === 0;
  const footer = <>{showCctvPrivacy ? <span>{cctvT('cctv.footer.live')}</span> : null}<div ref={setFooterSlot} className="detail-footer-slot" /></>;
  const groupId = featureId ? getRegistration(featureId)?.groupId : undefined;
  const style = { ...(groupId ? groupStyle(groupId) : {}), transform, opacity, transformOrigin: 'top left', ...detailFrameStyle(compact, fullscreen, compactTokens, textScale, compactHeight) };
  // T-079: the CCTV detail's mode toggle and ⋯ are drawn by the widget into this empty slot (first control in the header, SCREENS 9.3); other widgets get no slot.
  const slot = featureId === 'customer-analysis' ? <span className="detail-header-slot" data-detail-header-slot="customer-analysis" /> : null;
  const headerAction = featureId ? <>
    {slot}
    {depth > 1 ? <ActionButton ref={backRef} variant="ghost" className="detail-back" data-testid="detail-back" onClick={() => { run.actions.detailBack(); }}><Icon name="chevron-left" />{t('common.back')}</ActionButton> : null}
    <FullscreenToggle fullscreen={fullscreen} accessibleLabel={t(fullscreen ? 'detail.restoreName' : 'detail.fullscreenName')} onChange={next => { run.actions.setDetailDialogFullscreen(next); clearTimeout(announcementTimer.current); setAnnouncement(''); const message = t(next ? 'detail.fullscreen' : 'detail.restore'); announcementTimer.current = setTimeout(() => setAnnouncement(message), reducedMotion ? 0 : motionTokens.duration.fly); }} />
    {coachText ? <HelpButton ref={helpRef} name={widgetName} onPress={() => { if (helpOpen) run.actions.closeWidgetHelp(); else run.actions.openWidgetHelp(featureId, 'detail', `detail-help:${featureId}`); }} /> : null}
    <span className="ui-sr-only" aria-live="polite">{announcement}</span>
  </> : null;
  const coach = featureId && coachText ? <WidgetCoach open={helpOpen} anchorRef={helpRef} onClose={() => { run.actions.closeWidgetHelp(); }} title={widgetName}>{coachText}</WidgetCoach> : null;
  if(!descriptor)return <>{preserved}</>;
  if (active) return <>{preserved}<DetailFooterContext.Provider value={footerCtx}><DetailDialog open onContextChange={run.actions.clearNotice} title={title} fullscreen={fullscreen} returnFocusRef={returnFocusRef} popupRef={setSurface} popupStyle={style} popupClassName={resizing ? 'detail-frame-resize' : undefined} onClose={close} footer={footer} headerAction={headerAction} closeLabel={t('common.close')}>{bodySlot}{coach}</DetailDialog></DetailFooterContext.Provider></>;
  if (!state.exitPendingToken) return <>{preserved}</>;
  return <>{preserved}<DetailFooterContext.Provider value={footerCtx}>{createPortal(<motion.div className="ui-scrim ui-overlay-exit" data-testid="detail-exit-backdrop" aria-hidden="true" inert style={{ pointerEvents: 'none' }} initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={transitionFor('short', reducedMotion)} />, portalContainer ?? document.body)}<OverlayExitSurface token={state.exitPendingToken} kind={fullscreen ? 'fullscreen' : 'detail'} surfaceRef={setSurface} style={style} onComplete={ignoreKitExit}>
    <header className="ui-overlay-header"><div className="ui-overlay-heading"><h2 className="ui-dialog-title">{title}</h2></div><span className="detail-exit-close" aria-hidden="true"><Icon name="close" /></span></header>
    <div className="ui-overlay-body">{bodySlot}</div><footer className="ui-overlay-note">{footer}</footer>
  </OverlayExitSurface></DetailFooterContext.Provider></>;
}

function CheckedModuleBody({ Detail, featureId, condition, detailRef, host, fail }: { readonly Detail: NonNullable<import('../../contracts').WidgetModule['Detail']>; readonly featureId: FeatureId; readonly condition: import('../../contracts').QueryCondition; readonly detailRef: DetailRef; readonly host: import('../../contracts').WidgetHost; readonly fail: boolean }) {
  if (import.meta.env.DEV && fail) throw new Error('Detail verification body failure');
  return <div className="detail-module-body"><Detail featureId={featureId} condition={condition} detailRef={detailRef} host={host} /></div>;
}

