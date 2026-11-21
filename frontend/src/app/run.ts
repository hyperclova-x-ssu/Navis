import {createSessionGate,registerSessionGate} from './session-actions';
import type { RunStore, Theme } from '../contracts';
import { getRegistry } from '../catalog';
import { selectScreenPreset } from '../layout';
import { browserBriefingStorage, createRunStore } from '../state';
import { timePolicy } from '../ui';
import {createLayoutWorkerClient} from '../layout/worker-client';
import {createVerificationLayoutAdapter,rejectFirstPreview} from '../state/dev/verification';
import {readVerification} from './verification-policy';
interface BrowserPreferences { readonly theme:Theme; readonly reducedMotion:boolean }
export function readBrowserPreferences():BrowserPreferences {
    return {theme:'light',reducedMotion:typeof matchMedia!=='undefined'&&matchMedia('(prefers-reduced-motion: reduce)').matches};
}
function browserContext(win:Window){
    const screenPreset=selectScreenPreset({width:win.innerWidth,height:win.innerHeight});
    return screenPreset?{screenPreset,catalog:getRegistry(screenPreset.id)}:null;
}
/** No implicit preset: a document waits for its first positive layout viewport. */
export function createBrowserRun(preferences=readBrowserPreferences(),win:Window=window):RunStore|null {
    const context=browserContext(win);
    if(!context)return null;const scenario=readVerification(win.location.search);const layoutAdapter=scenario==='layout-pending'||scenario==='layout-worker-error'?createVerificationLayoutAdapter(createLayoutWorkerClient(),{delayMs:scenario==='layout-pending'?800:0,failOnce:scenario==='layout-worker-error'}):undefined;
    const sessionGate=createSessionGate();
    // D-327: the arrival briefing opens by itself once per business day; the day is remembered in this browser.
    // Dev only: ?briefing=always skips that memory so verification scripts can see the card on every load.
    const briefingStorage=import.meta.env.DEV&&new URLSearchParams(win.location.search).get('briefing')==='always'?null:browserBriefingStorage(win);
    const run=createRunStore({...context,sessionGate,briefingStorage,time:timePolicy,clock:()=>win.performance.now(),...preferences,layoutAdapter,previewGuard:scenario==='preview-start-rejected'?rejectFirstPreview():undefined});
    registerSessionGate(run,sessionGate);return run;
}
export interface BootstrapStatus {readonly phase:'waiting'|'preparing'|'ready'|'failed';readonly run:RunStore|null}
export function createBrowserBootstrap(win:Window,factory:()=>RunStore|null=()=>createBrowserRun(readBrowserPreferences(),win)){
 let run=factory(),status:BootstrapStatus={phase:run?'preparing':'waiting',run},generation=0,started=false,disposed=false,restoring=false,suspended=false;
 const listeners=new Set<()=>void>();
 const publish=(phase:BootstrapStatus['phase'])=>{if(status.phase===phase&&status.run===run)return;status={phase,run};listeners.forEach(listener=>listener());};
 const prepare=()=>{if(!run||started||disposed)return;started=true;const current=++generation,pending=run;publish('preparing');void pending.prepareLayout().then(ready=>{if(disposed||current!==generation||pending!==run)return;publish(ready?'ready':'failed');},()=>{if(!disposed&&current===generation)publish('failed');});};
 const restore=()=>{if(!restoring||!browserContext(win))return;restoring=false;restart();};
 const hide=()=>{if(disposed)return;suspended=true;generation++;run?.actions.setPageHidden(true);run?.dispose();};
 const show=(event:PageTransitionEvent)=>{if(event.persisted||suspended){restoring=true;restore();}else{run?.actions.setPageHidden(false);measure();}};
 const measure=()=>{if(restoring){restore();return;}if(disposed||run)return;run=factory();if(run){publish('preparing');prepare();}};
 const restart=()=>{generation++;run?.dispose();started=false;suspended=false;run=factory();publish(run?'preparing':'waiting');prepare();};
 const detach=()=>{win.removeEventListener('resize',measure);win.removeEventListener('pageshow',show);win.removeEventListener('pagehide',hide);};
 return {
  getSnapshot:()=>run,getStatus:()=>status,
  restart,
  subscribe(listener:()=>void){listeners.add(listener);if(listeners.size===1){win.addEventListener('resize',measure);win.addEventListener('pageshow',show);win.addEventListener('pagehide',hide);measure();prepare();}return()=>{listeners.delete(listener);if(!listeners.size)detach();};},
  dispose(){if(disposed)return;disposed=true;generation++;detach();listeners.clear();run?.dispose();},
 };
}
/** A persisted restoration is a new execution; an ordinary resize never is. */
export function attachDocumentLifecycle(run:RunStore,win:Window,preferences=readBrowserPreferences,onRestore?:()=>void):()=>void {
    let awaitingRestoration=false;
    const restore=()=>{
        if(!awaitingRestoration)return;
        const context=browserContext(win);
        if(!context)return;
        awaitingRestoration=false;
        if(onRestore)onRestore();else run.actions.resetRun({...context,...preferences()});
    };
    const hide=()=>run.actions.setPageHidden(true);
    const show=(event:PageTransitionEvent)=>{
        if(event.persisted){awaitingRestoration=true;hide();restore();}
        else if(!awaitingRestoration)run.actions.setPageHidden(false);
    };
    win.addEventListener('pagehide',hide);win.addEventListener('pageshow',show);win.addEventListener('resize',restore);
    return ()=>{win.removeEventListener('pagehide',hide);win.removeEventListener('pageshow',show);win.removeEventListener('resize',restore);};
}
