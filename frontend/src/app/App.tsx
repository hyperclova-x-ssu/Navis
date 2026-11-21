import navisLogo from '../assets/brand/navis-logo.svg';
import '../assets/brand/brand.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LayerId, RunStore } from '../contracts';
import { I18nProvider, useI18n } from '../i18n';
import { createWidgetDataStore } from '../data/widget-data';
import { WidgetDataProvider } from '../data/react';
import { WidgetRegistryProvider } from '../features/widgets/registry-context';
import { widgetModules } from '../features/widgets/registry';
import { ActionButton, Icon, UiProvider, ScreenTransition, useSystemPreferences } from '../ui';
import { OnboardingScreen } from '../screens/onboarding';
import { DashboardScreen } from '../screens/dashboard';
import { NAVIS_RETURN_FOCUS, applyNavisDetailSelection } from '../screens/dashboard/navis-navigation';
import { OrderScreen } from '../screens/order';
import { PosProvider, usePosSnapshot } from '../pos/react';
import { PosApprovalHost, PosAlertHost, PosReceiptHost, M2RunHost, useM2WidgetBindings, type RootReceiptEntry } from './pos-host';
import { useShellT } from '../screens/settings/use-shell-t';
import { DetailOverlay } from '../screens/detail';
import { SettingsOverlay } from '../screens/settings';
import { BriefingOverlay } from '../screens/briefing';
import { AppRecovery } from './AppRecovery';
import { attachDocumentLifecycle } from './run';
import { createViewportSource } from './viewport';
import { getRegistry } from '../catalog';
import { selectScreenPreset } from '../layout';
import { readBrowserPreferences } from './run';
import {VerificationControls,VerificationFault,type AppVerification} from './verification';
import {createSessionActions,sessionGateFor,SessionActionsProvider} from './session-actions';
import {ClosingOverlay} from './ClosingOverlay';
import {layoutEditCopy} from './layout-edit-messages';
import {CommonNotice} from './CommonNotice';
import {TemplateTour} from './template-tour';
import {ValueHighlights} from './value-highlights';
import {attachRunTimers,selectTemplateInteractionBlocked} from '../state';
import {useWidgetDataStore} from '../data/react';
import {resolveClosingVariant,selectClosing,TODAY} from '../data/widget-data';
import {ExampleStateChipForRun} from '../screens/settings';
import {ClosingButton,ClosedDayState} from '../ui';
import './app.css';
export interface AppProps { readonly run:RunStore;readonly verification?:AppVerification;readonly onRestart?:()=>void;readonly manageLifecycle?:boolean }
interface ExecutionProps extends AppProps {readonly fail:boolean;readonly clearFailure:()=>void;readonly setFailure:()=>void}
type Layer = LayerId;
const layerItems: readonly Layer[] = ['orders-payment','management','marketing'];
const layerLabelKeys = {'orders-payment':'app.layer.orders',management:'app.layer.management',marketing:'app.layer.marketing'} as const;
function RunView({run,verification,fail,clearFailure,setFailure}:ExecutionProps){
    const state=useSyncExternalStore(run.subscribe,run.getState);
    const [receiptEntry,setReceiptEntry]=useState<RootReceiptEntry|null>(null);
    const [settled,setSettled]=useState<{runId:string;transitionToken:string}|null>(null);
    const data=useWidgetDataStore(),snapshot=useSyncExternalStore(data.subscribe,data.getSnapshot);
    const variant=resolveClosingVariant(state.preview),closing=selectClosing(snapshot,{date:TODAY,scenario:variant==='no-payments'?'empty':'normal'});
    const blocked=selectTemplateInteractionBlocked(state);
    const m2=useM2WidgetBindings();
    const pos=usePosSnapshot(),posBusy=pos.posUi.approval?.status==='pending'||!!m2?.busy;
    useEffect(()=>attachRunTimers(run,{schedule:(fn,delay)=>window.setTimeout(fn,delay),cancel:id=>window.clearTimeout(id as number)}),[run]);
    const layer:Layer=state.layer;
    const focusAfterSwitch=useRef(false);
    const {t}=useShellT();
    const {locale:uiLocale}=useI18n(),layoutCopy=layoutEditCopy[uiLocale]??layoutEditCopy.ko;
    const editReasonId=useId(),editFromButton=useRef(false);
    const detailSeed=state.overlay.type==='detail'?state.overlay.stack?.at(-1):undefined;
    useEffect(()=>{
        if(!detailSeed?.condition&&detailSeed?.view!=='history')return;
        const apply=()=>{
            const details=Array.from(document.querySelectorAll<HTMLElement>('.ui-dialog[role="dialog"]'))
                .reverse().find(node=>!node.closest('[hidden],[inert],.ui-overlay-exit')&&
                    node.querySelector(`[data-widget="${detailSeed.featureId}"]`));
            return !!details&&applyNavisDetailSelection(details,detailSeed);
        };
        if(apply())return;
        const observer=new MutationObserver(()=>{if(apply())observer.disconnect();});
        const host=document.querySelector<HTMLElement>('[data-ui-portal-host]');
        if(host)observer.observe(host,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','inert']});
        return()=>observer.disconnect();
    },[detailSeed]);
    const dashboardRef=useRef<HTMLElement|null>(null),settingsRef=useRef<HTMLElement|null>(null);
    useLayoutEffect(()=>{
        if(state.overlay.type==='settings'&&document.activeElement?.closest('#dashboard-navis'))settingsRef.current=document.getElementById(NAVIS_RETURN_FOCUS);
        else if(state.overlay.type!=='settings'||!settingsRef.current?.isConnected)settingsRef.current=document.querySelector<HTMLElement>('[data-focus-key="settings"]');
    },[state.screen,state.overlay.type,state.edit.mode,layer]);
    useLayoutEffect(()=>{dashboardRef.current=state.screen==='dashboard'?document.getElementById('dashboard'):null;},[state.screen]);
    useLayoutEffect(()=>{if(!focusAfterSwitch.current)return;const heading=document.querySelector<HTMLElement>(layer==='management'||layer==='marketing'?'.dashboard-header h1':'.order-header h1');if(heading){heading.tabIndex=-1;heading.focus();focusAfterSwitch.current=false;}},[layer]);
    // 배치 편집 (U-B): the same edit mode a long press on a panel opens. Keyboard focus follows into the toolbar and back to the button after 완료.
    useLayoutEffect(()=>{
        if(!editFromButton.current)return;
        if(state.edit.mode==='edit')document.querySelector<HTMLElement>('.ui-edit-toolbar button')?.focus();
        else{editFromButton.current=false;document.querySelector<HTMLElement>('[data-focus-key="layout-edit"]')?.focus();}
    },[state.edit.mode]);
    const isPos=layer==='orders-payment';
    const hasPanels=state.panels.length>0;
    const switchLayer=(next:Layer)=>{
        if(next===layer||posBusy)return;
        focusAfterSwitch.current=true;
        if(!run.actions.switchLayer(next))focusAfterSwitch.current=false;
    };
    const showNavigation=state.screen==='dashboard'&&state.edit.mode!=='edit'&&state.idle.mode!=='idle';
    const transition=(body:React.ReactNode)=><ScreenTransition screenKey={`${state.screen}:${layer}`} onSettled={()=>{
        const current=run.getState();
        if(current.runId===state.runId&&current.transitionToken===state.transitionToken)setSettled({runId:state.runId,transitionToken:state.transitionToken});
    }}>{body}</ScreenTransition>;
    return <>
        {showNavigation?<div className="app-layer-navigation"><img className="navis-logo" src={navisLogo} alt="Navis" /><nav aria-label={t('shell.screens')}>{layerItems.map(item=><ActionButton key={item} variant="ghost" data-layer={item} aria-current={layer===item?'page':undefined} disabled={blocked||posBusy} onClick={()=>switchLayer(item)}>{t(layerLabelKeys[item])}</ActionButton>)}</nav></div>:null}
        {state.screen==='dashboard'&&state.edit.mode!=='edit'&&state.idle.mode!=='idle'?<div className="app-closing-header"><ExampleStateChipForRun run={run}/><span className="app-closing-badge">{closing.status==='closed'?<ClosedDayState closed variant="header"/>:null}</span>{isPos?null:<span className="app-layout-edit"><ActionButton id="app-layout-edit" data-focus-key="layout-edit" variant="secondary" className="app-layout-edit-button" aria-label={layoutCopy.open} aria-describedby={hasPanels?undefined:editReasonId} disabled={blocked||posBusy||!hasPanels} onClick={()=>{editFromButton.current=true;run.actions.enterEditing();}}><Icon name="move"/>{layoutCopy.button}</ActionButton>{hasPanels?null:<span id={editReasonId} className="app-layout-edit__reason">{layoutCopy.empty}</span>}</span>}<ClosingButton id="app-closing" data-focus-key="closing" closed={closing.status==='closed'} disabled={blocked||posBusy} onClick={()=>run.actions.openClosing('app-closing')}/></div>:null}
        <DashboardScreen run={run} manageTimers={false} posBusy={posBusy} ready={settled?.runId===state.runId&&settled.transitionToken===state.transitionToken} renderScreen={board=>transition(state.screen==='business-question'?<OnboardingScreen run={run}/>:isPos?<OrderScreen run={run} onOpenReceipt={setReceiptEntry} linkedTables={m2?.cctv.linkedTables}/>:board)}/>
        <SettingsOverlay run={run} tableLinkPicker={m2?.tableLinkPicker} tableLinkError={m2?.cctv.linkError} returnFocusRef={verification?.scenario==='error-settings'?undefined:settingsRef} verification={{failContent:fail&&verification?.scenario==='error-settings',onRetry:clearFailure}}/><DetailOverlay run={run} simulateContentError={fail&&verification?.scenario==='error-detail'}/><BriefingOverlay run={run} returnFocusRef={dashboardRef} verification={{failContent:fail&&verification?.scenario==='error-briefing',onRetry:clearFailure}}/>
        <ClosingOverlay run={run} onOpenReceipt={setReceiptEntry}/><PosReceiptHost entry={receiptEntry} onClose={()=>setReceiptEntry(null)}/><TemplateTour run={run}/><CommonNotice run={run}/><PosAlertHost run={run}/>
        {verification?<VerificationControls scenario={verification.scenario} state={state} onFailure={setFailure}/>:null}
    </>;
}
function RunCanvas(props:ExecutionProps){
    const {run,verification,fail}=props;
    const state=useSyncExternalStore(run.subscribe,run.getState);
    const [viewport]=useState(()=>createViewportSource(run,window));
    const transform=useSyncExternalStore(viewport.subscribe,viewport.getSnapshot);
    const preset=state.screenPreset;
    if(import.meta.env.DEV&&fail&&verification?.scenario==='error-canvas')throw new Error('Development canvas failure');
    return <div className="app-canvas" style={{width:preset.baselineWidth,height:preset.baselineHeight,transform:`translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`}}>
        <VerificationFault active={fail&&verification?.scenario==='error-provider'}><UiProvider screenPreset={preset} transform={transform} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}><M2RunHost run={run}><RunView {...props}/></M2RunHost></UiProvider></VerificationFault>
    </div>;
}
export function App({run,verification,onRestart,manageLifecycle=true}:AppProps){
    const runId=useSyncExternalStore(run.subscribe,()=>run.getState().runId);
    const locale=useSyncExternalStore(run.subscribe,()=>run.getState().locale);
    const preview=useSyncExternalStore(run.subscribe,()=>run.getState().preview);
    const system=useSystemPreferences();
    // One fake DB per run: a new run (restart, reset, reload) starts from the seed again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const dataStore=useMemo(()=>createWidgetDataStore(run.getState().onboarding.step==='done'?{shopSettings:{...run.getState().shopSettings,layoutActivated:false}}:undefined,{runId,sessionGate:sessionGateFor(run),pos:run.getState().pos,readPosUi:()=>run.getState().posUi}),[runId,run]);
    const sessionActions=useMemo(()=>createSessionActions(run,dataStore,sessionGateFor(run)),[run,dataStore]);
    useEffect(()=>()=>sessionActions.pos.dispose(),[sessionActions]);
    const [failure,setFailure]=useState(()=>({runId,active:verification?.initialFailure??false}));
    const fail=failure.runId===runId&&failure.active;
    const restart=()=>{setFailure({runId,active:false});if(onRestart){onRestart();return;}const preset=selectScreenPreset({width:window.innerWidth,height:window.innerHeight});if(preset)run.actions.resetRun({screenPreset:preset,catalog:getRegistry(preset.id),...readBrowserPreferences()});};
    useEffect(()=>manageLifecycle?attachDocumentLifecycle(run,window,readBrowserPreferences,onRestart):undefined,[run,onRestart,manageLifecycle]);
    useEffect(()=>{if(run.getState().reducedMotion!==system.reducedMotion)run.actions.setReducedMotion(system.reducedMotion);},[run,system.reducedMotion]);
    // The document language follows the chosen language (ko, en, zh-Hans, zh-Hant): fonts and line breaking read it (DS 11.3).
    useLayoutEffect(()=>{document.documentElement.lang=locale;},[locale]);
    return <I18nProvider locale={locale}><WidgetDataProvider store={dataStore} preview={preview}><WidgetRegistryProvider modules={widgetModules}><SessionActionsProvider value={sessionActions}><PosProvider value={sessionActions.pos}><PosApprovalHost runtime={sessionActions.pos}/><ValueHighlights key={runId} run={run}>
        <AppRecovery key={runId} onRestart={restart}><RunCanvas key={runId} run={run} verification={import.meta.env.DEV?verification:undefined} fail={import.meta.env.DEV&&fail} clearFailure={()=>setFailure({runId,active:false})} setFailure={()=>setFailure({runId,active:true})}/></AppRecovery>
    </ValueHighlights></PosProvider></SessionActionsProvider></WidgetRegistryProvider></WidgetDataProvider></I18nProvider>;
}
