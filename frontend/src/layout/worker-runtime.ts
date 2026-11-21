import type { LayoutIdentity, LayoutResult, LayoutWorkerRequest, LayoutWorkerResponse } from '../contracts';
import { getCatalog } from '../catalog';
import { screenPresets } from './presets';
import { layoutResult, resolve } from './index';
export type WorkerInbound={readonly type:'solve';readonly request:LayoutWorkerRequest}|{readonly type:'ready'}|{readonly type:'cancel'}|{readonly type:'clear'};
export type WorkerOutbound={readonly type:'ready'}|{readonly type:'result';readonly response:LayoutWorkerResponse;readonly slices:number;readonly searchMs:number};
export function sameIdentity(a:LayoutIdentity,b:LayoutIdentity):boolean {return a.runId===b.runId&&a.baseRevision===b.baseRevision&&a.gestureToken===b.gestureToken&&a.requestId===b.requestId&&a.presetId===b.presetId;}
export function createWorkerRuntime(post:(message:WorkerOutbound)=>void,scheduler:{now:()=>number;schedule:(callback:()=>void)=>unknown}){
  let generation=0,disposed=false;
  function receive(message:WorkerInbound):void {
    if(disposed)return;
    if(message.type==='ready'){post({type:'ready'});return;}
    generation++;
    if(message.type==='clear')return;
    if(message.type==='cancel')return;
    const request=message.request,current= generation;
    const preset=screenPresets[request.presetId];
    if(!preset)return;
    let slices=0;const started=scheduler.now();
    function finish(result:LayoutResult):void {
      if(disposed||current!==generation)return;
      post({type:'result',response:{runId:request.runId,baseRevision:request.baseRevision,gestureToken:request.gestureToken,requestId:request.requestId,presetId:request.presetId,result},slices,searchMs:scheduler.now()-started});
    }
    const iterator=resolve(request.beforePanels,request.intent,preset.grid,getCatalog(request.presetId));
    function slice():void {
      if(disposed||current!==generation)return;
      slices++;const deadline=scheduler.now()+4;
      try{
        do{const step=iterator.next();if(step.done){finish(step.value);return;}}while(scheduler.now()<deadline);
        scheduler.schedule(slice);
      }catch{finish(layoutResult(request.beforePanels,preset.grid,'INTERNAL_LAYOUT_ERROR'));}
    }
    scheduler.schedule(slice);
  }
  return {receive,dispose(){disposed=true;generation++;}};
}
