import {createSessionGate,registerSessionGate} from './session-actions';
import type { RunStore, Theme } from '../contracts';
import { getRegistry } from '../catalog';
import { selectScreenPreset } from '../layout';
import { browserBriefingStorage, createRunStore } from '../state';
import { timePolicy } from '../ui';
import type {PresentationRunStore} from '../state';
import {createLayoutWorkerClient} from '../layout/worker-client';
import {createVerificationLayoutAdapter,rejectFirstPreview} from '../state/dev/verification';
import {readVerification} from './verification-policy';
import {createAccountHost,type AccountHost,type AccountHostFactory} from './account-host';
import {browserServerArrival} from '../data/reality/12/arrival';
interface BrowserPreferences { readonly theme:Theme; readonly reducedMotion:boolean }
export function readBrowserPreferences():BrowserPreferences {
    return {theme:'light',reducedMotion:typeof matchMedia!=='undefined'&&matchMedia('(prefers-reduced-motion: reduce)').matches};
}
function browserContext(win:Window){
    const screenPreset=selectScreenPreset({width:win.innerWidth,height:win.innerHeight});
    return screenPreset?{screenPreset,catalog:getRegistry(screenPreset.id)}:null;
}
const configuredBriefingPreviewHosts: string = import.meta.env.VITE_NAVIS_PREVIEW_HOSTS ?? '';
const briefingPreviewHosts = new Set([
    '127.0.0.1', 'localhost', '[::1]', 'moa',
    ...configuredBriefingPreviewHosts.split(',').map(host => host.trim().toLowerCase()).filter(Boolean),
]);

/** No implicit preset: a document waits for its first positive layout viewport. */
export function createBrowserRun(preferences=readBrowserPreferences(),win:Window=window):RunStore|null {
    const context=browserContext(win);
    if(!context)return null;const scenario=readVerification(win.location.search);const layoutAdapter=scenario==='layout-pending'||scenario==='layout-worker-error'?createVerificationLayoutAdapter(createLayoutWorkerClient(),{delayMs:scenario==='layout-pending'?800:0,failOnce:scenario==='layout-worker-error'}):undefined;
    const sessionGate=createSessionGate();
    // The D-327 verification override bypasses the daily record in dev and on approved preview hosts.
    const { hostname, search } = win.location;
    const repeatBriefing = (import.meta.env.DEV || briefingPreviewHosts.has(hostname)) && new URLSearchParams(search).get('briefing') === 'always';
    const briefingStorage = repeatBriefing ? null : browserBriefingStorage(win);
    const run=createRunStore({...context,sessionGate,briefingStorage,briefingServer:repeatBriefing?undefined:browserServerArrival(),time:timePolicy,clock:()=>win.performance.now(),...preferences,layoutAdapter,previewGuard:scenario==='preview-start-rejected'?rejectFirstPreview():undefined});
    registerSessionGate(run,sessionGate);return run;
}
/** `signin`: the account service needs an owner session (REAL-PLAN F00); `account` is present only when the account domain runs over HTTP. */
export interface BootstrapStatus {readonly phase:'waiting'|'preparing'|'ready'|'failed'|'account-unavailable'|'signin';readonly run:RunStore|null;readonly account?:AccountHost|null}
export function createBrowserBootstrap(win:Window,factory:()=>RunStore|null=()=>createBrowserRun(readBrowserPreferences(),win),accountFactory:AccountHostFactory=createAccountHost){
 let run=factory(),account:AccountHost|null=null,detachAccount:(()=>void)|undefined,status:BootstrapStatus={phase:run?'preparing':'waiting',run},generation=0,started=false,disposed=false,restoring=false,suspended=false;
 const control={restart:()=>restart(),retry:()=>{started=false;prepare();}};
 const bindAccount=()=>{detachAccount?.();detachAccount=undefined;account?.dispose();account=run?accountFactory(run as PresentationRunStore,control):null;};
 bindAccount();
 const listeners=new Set<()=>void>();
 const publish=(phase:BootstrapStatus['phase'])=>{if(status.phase===phase&&status.run===run&&status.account===account)return;status={phase,run,account};listeners.forEach(listener=>listener());};
 const prepare=()=>{if(!run||started||disposed)return;started=true;const current=++generation,pending=run;publish('preparing');void pending.prepareLayout().then(async ready=>{
   if(disposed||current!==generation||pending!==run)return;
   if(!ready||!account){publish(ready?'ready':'failed');return;}
   // The stored account state (settings, boards, preferences) is in the run before the first screen.
   const host=account;
   try{await host.load();}catch(error){if(disposed||current!==generation||pending!==run)return;publish((error as {reason?:string}|null)?.reason==='SESSION_REQUIRED'?'signin':'account-unavailable');return;}
   if(disposed||current!==generation||pending!==run)return;
   detachAccount?.();detachAccount=host.attach();publish('ready');
  },()=>{if(!disposed&&current===generation)publish('failed');});};
 const restore=()=>{if(!restoring||!browserContext(win))return;restoring=false;restart();};
 const hide=()=>{if(disposed)return;suspended=true;generation++;void account?.attach;run?.actions.setPageHidden(true);run?.dispose();};
 const show=(event:PageTransitionEvent)=>{if(event.persisted||suspended){restoring=true;restore();}else{run?.actions.setPageHidden(false);measure();}};
 const measure=()=>{if(restoring){restore();return;}if(disposed||run)return;run=factory();bindAccount();if(run){publish('preparing');prepare();}};
 const restart=()=>{generation++;detachAccount?.();detachAccount=undefined;run?.dispose();started=false;suspended=false;run=factory();bindAccount();publish(run?'preparing':'waiting');prepare();};
 const detach=()=>{win.removeEventListener('resize',measure);win.removeEventListener('pageshow',show);win.removeEventListener('pagehide',hide);};
 return {
  getSnapshot:()=>run,getStatus:()=>status,
  restart,retry:control.retry,
  subscribe(listener:()=>void){listeners.add(listener);if(listeners.size===1){win.addEventListener('resize',measure);win.addEventListener('pageshow',show);win.addEventListener('pagehide',hide);measure();prepare();}return()=>{listeners.delete(listener);if(!listeners.size)detach();};},
  dispose(){if(disposed)return;disposed=true;generation++;detach();listeners.clear();detachAccount?.();account?.dispose();run?.dispose();},
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
