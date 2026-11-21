import {afterEach,expect,it,vi} from 'vitest';
import {createRunStore} from '../state';
import {getRegistry} from '../catalog';
import {screenPresets} from '../layout';
import {timePolicy} from '../ui';
import {createBrowserBootstrap} from './run';
function controlled(){let resolve!:()=>void,reject!:(error:Error)=>void,disposed=false;const ready=new Promise<void>((a,b)=>{resolve=a;reject=b;});const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>0,theme:'light',layoutAdapter:{ready:()=>ready,submit:()=>{},cancel:()=>{},dispose:()=>{disposed=true;}}});return {run,resolve,reject,disposed:()=>disposed};}
afterEach(()=>vi.restoreAllMocks());
it('waits for actual Worker readiness and disposes an abandoned startup without accepting its late reply',async()=>{
 const a=controlled(),bootstrap=createBrowserBootstrap(window,()=>a.run);const stop=bootstrap.subscribe(()=>{});
 expect(bootstrap.getStatus().phase).toBe('preparing');a.resolve();await Promise.resolve();await Promise.resolve();expect(bootstrap.getStatus().phase).toBe('ready');expect(bootstrap.getSnapshot()).toBe(a.run);stop();bootstrap.dispose();expect(a.disposed()).toBe(true);
 const b=controlled(),cancelled=createBrowserBootstrap(window,()=>b.run);const detach=cancelled.subscribe(()=>{});cancelled.dispose();const previous=cancelled.getStatus();b.resolve();await Promise.resolve();await Promise.resolve();expect(cancelled.getStatus()).toBe(previous);expect(b.disposed()).toBe(true);detach();
});
it('restarts a failed Worker with a new run and terminates the previous resource',async()=>{
 const a=controlled(),b=controlled(),runs=[a.run,b.run],bootstrap=createBrowserBootstrap(window,()=>runs.shift()!);const stop=bootstrap.subscribe(()=>{});a.reject(new Error('Worker failure'));await Promise.resolve();await Promise.resolve();expect(bootstrap.getStatus().phase).toBe('failed');bootstrap.restart();expect(a.disposed()).toBe(true);expect(bootstrap.getSnapshot()).toBe(b.run);b.resolve();await Promise.resolve();await Promise.resolve();expect(bootstrap.getStatus().phase).toBe('ready');stop();bootstrap.dispose();
});
it('releases the Worker on pagehide and starts a different execution after persisted return',async()=>{
 const a=controlled(),b=controlled(),runs=[a.run,b.run],bootstrap=createBrowserBootstrap(window,()=>runs.shift()!);const stop=bootstrap.subscribe(()=>{});a.resolve();await Promise.resolve();await Promise.resolve();window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));expect(a.disposed()).toBe(true);window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));expect(bootstrap.getSnapshot()).toBe(b.run);b.resolve();await Promise.resolve();await Promise.resolve();expect(bootstrap.getStatus().phase).toBe('ready');stop();bootstrap.dispose();
});
