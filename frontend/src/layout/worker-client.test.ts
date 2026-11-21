import { describe,expect,it } from 'vitest';
import { createLayoutWorkerClient } from './worker-client';
import type { WorkerPort } from './worker-client';
import type { LayoutWorkerRequest,LayoutWorkerResponse } from '../contracts';
import { preview,screenPresets } from './index';
import { getCatalog } from '../catalog';
import type { WorkerInbound,WorkerOutbound } from './worker-runtime';
function port(){
  const sent:WorkerInbound[]=[];let terminated=0;
  const worker:WorkerPort={postMessage:message=>sent.push(message),terminate:()=>{terminated++;},onmessage:null,onerror:null,onmessageerror:null};
  const emit=(message:WorkerOutbound)=>worker.onmessage?.({data:message} as MessageEvent<WorkerOutbound>);
  return {worker,sent,emit,terminated:()=>terminated};
}
const request:LayoutWorkerRequest={runId:'r',baseRevision:0,gestureToken:'g',requestId:1,presetId:'B',beforePanels:[{featureId:'ledger',column:1,row:1,width:1,height:1}],intent:{type:'add-drop',featureId:'margin',column:1,row:1}};
const result=preview(request.beforePanels,request.intent,screenPresets.B.grid,getCatalog('B'));
describe('native Worker client boundary',()=>{
  it('validates every identity field, then reuses a single search for the next 999 identical candidates',async()=>{
    const p=port(),client=createLayoutWorkerClient(()=>p.worker);p.emit({type:'ready'});await client.ready();
    const responses:LayoutWorkerResponse[]=[];client.submit(request,r=>responses.push(r));
    for(const [field,value] of [['runId','old'],['baseRevision',-1],['gestureToken','old'],['requestId',0],['presetId','A']] as const){
      p.emit({type:'result',response:{...request,[field]:value,result},slices:1,searchMs:1});expect(responses).toEqual([]);
    }
    p.emit({type:'result',response:{...request,result},slices:2,searchMs:1});
    for(let i=2;i<=1000;i++)client.submit({...request,requestId:i},r=>responses.push(r));
    expect(responses).toHaveLength(1000);expect(responses.at(-1)?.requestId).toBe(1000);
    expect(client.stats()).toMatchObject({searches:1,cacheHits:999,cacheSize:1,maxSlices:2});
    expect(p.sent.filter(m=>m.type==='solve')).toHaveLength(1);
    client.submit({...request,baseRevision:1,requestId:1001},r=>responses.push(r));
    expect(client.stats()).toMatchObject({searches:2,cacheHits:999,cacheSize:0});
    client.dispose();expect(p.terminated()).toBe(1);expect(client.stats().cacheSize).toBe(0);
  });
  it('cancels stale responses, bounds the cache at 256 and clears it at a new run',()=>{
    const p=port(),client=createLayoutWorkerClient(()=>p.worker),responses:LayoutWorkerResponse[]=[];
    client.submit(request,r=>responses.push(r));client.cancel();p.emit({type:'result',response:{...request,result},slices:1,searchMs:1});expect(responses).toEqual([]);
    for(let i=0;i<270;i++){
      const next={...request,requestId:i+2,beforePanels:[{...request.beforePanels[0],row:Math.floor(i/8),column:i%8}]};
      client.submit(next,r=>responses.push(r));p.emit({type:'result',response:{...next,result},slices:1,searchMs:1});
    }
    expect(client.stats().cacheSize).toBe(256);
    client.submit({...request,runId:'next'},r=>responses.push(r));expect(client.stats().cacheSize).toBe(0);client.dispose();
  });
  it('reports startup and communication failures as internal errors and permits disposal before ready',async()=>{
    const startup=createLayoutWorkerClient(()=>{throw new Error('cannot start');});await expect(startup.ready()).rejects.toThrow('INTERNAL_LAYOUT_ERROR');
    const p=port(),client=createLayoutWorkerClient(()=>p.worker);p.emit({type:'ready'});await client.ready();
    const responses:LayoutWorkerResponse[]=[];client.submit(request,r=>responses.push(r));p.worker.onmessageerror?.({} as MessageEvent);
    expect(responses[0].result).toMatchObject({code:'INTERNAL_LAYOUT_ERROR',panels:request.beforePanels});expect(p.terminated()).toBe(1);
    client.dispose();startup.dispose();
  });
});
