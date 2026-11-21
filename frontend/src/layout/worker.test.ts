import { describe, expect, it } from 'vitest';
import { LayoutCache, layoutCacheKey } from './cache';
import { createWorkerRuntime } from './worker-runtime';
import type { LayoutWorkerRequest } from '../contracts';
const request:LayoutWorkerRequest={runId:'run',baseRevision:0,gestureToken:'g',requestId:1,presetId:'B',beforePanels:[{featureId:'ledger',column:1,row:1,width:1,height:1}],intent:{type:'add-drop',featureId:'margin',column:1,row:1}};
describe('bounded coordinate cache',()=>{
  it('normalizes array order but includes every original coordinate, size and intent',()=>{
    const p={featureId:'calendar' as const,column:4,row:3,width:2,height:1};
    const before=[...request.beforePanels,p];
    expect(layoutCacheKey({...request,beforePanels:before})).toBe(layoutCacheKey({...request,beforePanels:[...before].reverse()}));
    expect(layoutCacheKey({...request,beforePanels:before})).not.toBe(layoutCacheKey({...request,beforePanels:[...request.beforePanels,{...p,row:4}]}));
    expect(layoutCacheKey({...request,intent:{type:'add-drop',featureId:'margin',column:2,row:1}})).not.toBe(layoutCacheKey(request));
  });
  it('evicts the least recently used entry and clears the run cache',()=>{
    const cache=new LayoutCache<number>(2);cache.set('a',1);cache.set('b',2);expect(cache.get('a')).toBe(1);cache.set('c',3);
    expect(cache.get('b')).toBeUndefined();expect(cache.size).toBe(2);cache.clear();expect(cache.size).toBe(0);
  });
});
describe('cooperative Worker',()=>{
  it('yields within a 4ms slice, cancels old candidates, and returns only the latest identity',()=>{
    const queue:(()=>void)[]=[],messages:unknown[]=[];let clock=0;
    const runtime=createWorkerRuntime(message=>messages.push(message),{now:()=>clock++,schedule:callback=>queue.push(callback)});
    runtime.receive({type:'solve',request});
    expect(messages).toEqual([]);
    runtime.receive({type:'solve',request:{...request,requestId:2,intent:{type:'add-drop',featureId:'margin',column:3,row:1}}});
    while(queue.length)queue.shift()!();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({type:'result',response:{requestId:2,result:{status:'accepted'}}});
    runtime.dispose();
  });
  it('time slicing preserves the exact ordered answer',()=>{
    const queue:(()=>void)[]=[],messages:unknown[]=[];let clock=0;
    const runtime=createWorkerRuntime(message=>messages.push(message),{now:()=>clock++,schedule:callback=>queue.push(callback)});
    runtime.receive({type:'solve',request});let slices=0;while(queue.length){queue.shift()!();slices++;}
    expect(slices).toBeGreaterThan(1);
    expect(messages[0]).toMatchObject({type:'result',response:{result:{displacements:[{featureId:'ledger',to:{column:1,row:0}}]}}});
  });
});
