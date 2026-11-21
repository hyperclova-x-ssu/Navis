import type { LayoutAdapter, LayoutResult, LayoutWorkerRequest, LayoutWorkerResponse } from '../contracts';
import { LayoutCache, layoutCacheKey } from './cache';
import { layoutResult } from './index';
import { screenPresets } from './presets';
import { sameIdentity } from './worker-runtime';
import type { WorkerInbound, WorkerOutbound } from './worker-runtime';
export interface WorkerPort {
  postMessage(message:WorkerInbound):void;
  terminate():void;
  onmessage:((event:MessageEvent<WorkerOutbound>)=>void)|null;
  onerror:((event:ErrorEvent)=>void)|null;
  onmessageerror:((event:MessageEvent)=>void)|null;
}
export interface WorkerClient extends LayoutAdapter { readonly stats:()=>{searches:number;cacheHits:number;cacheSize:number;maxSlices:number} }
/** Initialize before dashboard entry. Startup errors reject ready(), never NO_CAPACITY. */
export function createLayoutWorkerClient(factory:()=>WorkerPort=()=>new Worker(new URL('./layout.worker.ts',import.meta.url),{type:'module'})):WorkerClient {
  let port:WorkerPort|null=null,disposed=false,failed=false,runId:string|null=null,baseRevision:number|null=null;
  let pending:{request:LayoutWorkerRequest;receive:(response:LayoutWorkerResponse)=>void}|null=null;
  const cache=new LayoutCache<LayoutResult>();let searches=0,cacheHits=0,maxSlices=0;
  let resolveReady:()=>void=()=>{},rejectReady:(error:Error)=>void=()=>{};
  const readiness=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  // The owner may await readiness later; a startup failure still has a handler now.
  void readiness.catch(()=>{});
  function failure():void {
    if(disposed)return;failed=true;cache.clear();rejectReady(new Error('INTERNAL_LAYOUT_ERROR'));
    const active=pending;pending=null;
    if(active)active.receive({...active.request,result:layoutResult(active.request.beforePanels,screenPresets[active.request.presetId].grid,'INTERNAL_LAYOUT_ERROR')});
    port?.terminate();port=null;
  }
  try{
    port=factory();
    port.onmessage=event=>{
      if(disposed||failed)return;
      if(event.data.type==='ready'){resolveReady();return;}
      const {response,slices}=event.data;const active=pending;
      if(!active||!sameIdentity(response,active.request))return;
      pending=null;maxSlices=Math.max(maxSlices,slices);
      cache.set(layoutCacheKey(active.request),response.result);active.receive(response);
    };
    port.onerror=failure;port.onmessageerror=failure;port.postMessage({type:'ready'});
  }catch{failure();}
  return {
    ready:()=>failed?Promise.reject(new Error('INTERNAL_LAYOUT_ERROR')):readiness,
    submit(request,receive){
      if(disposed)return;
      if(runId!==request.runId||baseRevision!==request.baseRevision){cache.clear();runId=request.runId;baseRevision=request.baseRevision;port?.postMessage({type:'clear'});}
      pending=null;port?.postMessage({type:'cancel'});
      const hit=cache.get(layoutCacheKey(request));
      if(hit){cacheHits++;receive({...request,result:hit});return;}
      if(failed){receive({...request,result:layoutResult(request.beforePanels,screenPresets[request.presetId].grid,'INTERNAL_LAYOUT_ERROR')});return;}
      searches++;pending={request,receive};
      try{port!.postMessage({type:'solve',request});}catch{failure();}
    },
    cancel(){pending=null;port?.postMessage({type:'cancel'});},
    dispose(){if(disposed)return;disposed=true;pending=null;cache.clear();port?.terminate();port=null;rejectReady(new Error('CANCELLED'));},
    stats:()=>({searches,cacheHits,cacheSize:cache.size,maxSlices}),
  };
}
