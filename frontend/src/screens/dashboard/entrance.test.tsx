import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import {useSyncExternalStore} from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {visualElementStore} from 'motion-dom';
import type {RunStore} from '../../contracts';
import {getRegistry} from '../../catalog';
import {createRunStore,selectCommonNotice} from '../../state';
import {screenPresets} from '../../layout';
import {getPresetLayout,timePolicy} from '../../ui';
import {KitProviders} from '../../ui/test-utils';
import {createWidgetDataStore} from '../../data/widget-data';
import {createSessionActions,sessionGateFor} from '../../app/session-actions';
import {DashboardScreen} from './DashboardScreen';

let activeRun:RunStore;
afterEach(()=>{cleanup();activeRun?.dispose();vi.restoreAllMocks();vi.useRealTimers();});
function mount({template=false,reduced=false,ready=true,placed=false}={}){
 vi.useFakeTimers();
 const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>Date.now(),theme:'light',reducedMotion:reduced});activeRun=run;
 run.actions.setOnboardingAnswer({businessType:'cafe'});run.actions.setOnboardingAnswer({paymentStyle:'prepaid'});
 const data=createWidgetDataStore(undefined,{runId:run.getState().runId,sessionGate:sessionGateFor(run)});
 expect(createSessionActions(run,data).completeOnboarding(template?'A':null).ok).toBe(true);
 if(placed)run.actions.applyLayoutIntent({type:'add-tap',featureId:'ledger'});
 const grid=getPresetLayout(screenPresets.A).grid;
 vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){
  const r=this.classList.contains('dashboard-grid-bounds')?grid:{x:1800,y:240,width:48,height:48};
  return {...r,left:r.x,top:r.y,right:r.x+r.width,bottom:r.y+r.height,toJSON:()=>r};
 });
 function Host({ready}:{ready:boolean}){const s=useSyncExternalStore(run.subscribe,run.getState);return <KitProviders reducedMotion={s.reducedMotion}><DashboardScreen run={run} ready={ready} manageTimers={false}/></KitProviders>;}
 const view=render(<Host ready={ready}/>);
 return {run,ready:()=>view.rerender(<Host ready/>)};
}
function frames(){return Array.from(document.querySelectorAll<HTMLElement>('.dashboard-page-layer:not([data-exiting]) .ui-fly-layer'));}
function visual(node:HTMLElement){const value=visualElementStore.get(node);expect(value).toBeDefined();return value!;}
function finish(node:HTMLElement){act(()=>visual(node).getProps().onAnimationComplete?.({opacity:1}));}

describe('first-page explicit entrances (T-208b)',()=>{
 it.each([false,true])('settles template guidance in the landing task without a later visual publish (reduced=%s)',reduced=>{
  const {run}=mount({template:true,reduced});
  finish(frames().at(-1)!);
  expect(run.getState().guidance.visualPending).toBe(false);
  const changes:unknown[]=[];
  const off=run.subscribe((next,before)=>{if(next.guidance!==before.guidance)changes.push(next.guidance);});
  act(()=>vi.advanceTimersByTime(399));off();
  expect(changes).toEqual([]);
  expect(run.getState().templateTour?.status).toBe('waiting');
 });
 it.each([[false,280],[true,80]] as const)('waits for the last three-start flight instead of the normal deadline (reduced=%s)',(reduced,duration)=>{
  const {run}=mount({reduced});fireEvent.click(screen.getByRole('button',{name:/3개로 시작하기/}));
  const nodes=frames();
  finish(nodes[0]);finish(nodes[1]);
  act(()=>vi.advanceTimersByTime(duration*2-1));
  expect(run.getState().guidance.visualPending).toBe(true);
  expect(run.getState().guidance.active).not.toBe('resize-panel');
  finish(nodes[2]);
  expect(run.getState().guidance.visualPending).toBe(false);
  expect(run.getState().starter).toBe('completed');
 });
 it('does not let a panel layout completion settle an active flight',()=>{
  const {run}=mount();fireEvent.click(screen.getByRole('button',{name:/3개로 시작하기/}));
  const layout=frames()[0].closest<HTMLElement>('.ui-layout-layer')!;
  act(()=>visual(layout).getProps().onLayoutAnimationComplete?.());
  expect(run.getState().guidance.visualPending).toBe(true);
  finish(frames().at(-1)!);expect(run.getState().guidance.visualPending).toBe(false);
 });
 it.each([[false,560],[true,160]] as const)('retains a late safety deadline when flight completion is lost (reduced=%s)',(reduced,deadline)=>{
  const {run}=mount({reduced});fireEvent.click(screen.getByRole('button',{name:/3개로 시작하기/}));
  act(()=>vi.advanceTimersByTime(deadline-1));expect(run.getState().guidance.visualPending).toBe(true);
  act(()=>vi.advanceTimersByTime(1));expect(run.getState().guidance.visualPending).toBe(false);
 });
 it.each([
  ['template',false,6,20,200],['three',false,3,40,200],['recommended',false,7,24,200],
  ['template',true,6,0,80],['three',true,3,0,80],['recommended',true,7,0,80],
 ] as const)('%s reduced=%s starts the actual fly layers instead of inheriting the first page suppression',(path,reduced,count,stagger,duration)=>{
  const {run}=mount({template:path==='template',reduced});
  if(path==='recommended'){act(()=>{run.actions.switchLayer('marketing');});fireEvent.click(screen.getByRole('button',{name:'추천 배치로 시작하기'}));}
  if(path==='three')fireEvent.click(screen.getByRole('button',{name:/3개로 시작하기/}));
  const nodes=frames();expect(nodes).toHaveLength(count);
  nodes.forEach((node,index)=>{
   expect(visual(node).blockInitialAnimation).toBe(false);
   expect(node).toHaveStyle({opacity:reduced?'0':'0.88'});
   const props=visual(node).getProps();expect(props.transition).toMatchObject({duration:duration/1000,delay:index*stagger/1000});
   if(reduced)expect(node.style.transform).toBe('');
   else expect(node.style.transform).not.toBe('translate3d(0px, 0px, 0px) scale(1, 1)');
  });
 });
 it.each([false,true])('does not animate existing panels on load, layer return, page return or undo (reduced=%s)',reduced=>{
  const {run}=mount({placed:true,reduced});
  const placed=()=>{expect(frames()).toHaveLength(1);expect(frames()[0]).toHaveStyle({opacity:'1'});expect(visual(frames()[0]).blockInitialAnimation).toBe(true);};
  placed();act(()=>{run.actions.switchLayer('marketing');});act(()=>{run.actions.switchLayer('management');});placed();
  act(()=>{run.actions.addPage();});act(()=>{run.actions.goToPage(0);});placed();
  act(()=>{run.actions.applyLayoutIntent({type:'remove',featureId:'ledger'});});
  act(()=>{run.actions.undo(run.getState().undo!.token);});placed();
 });
 it('does not replay a completed three-start when returning to its layer or page',()=>{
  const {run}=mount();fireEvent.click(screen.getByRole('button',{name:/3개로 시작하기/}));finish(frames().at(-1)!);
  act(()=>{run.actions.switchLayer('marketing');});act(()=>{run.actions.switchLayer('management');});
  expect(frames().every(node=>node.style.opacity==='1'&&visual(node).blockInitialAnimation)).toBe(true);
  act(()=>{run.actions.addPage();});act(()=>{run.actions.goToPage(0);});
  expect(frames().every(node=>node.style.opacity==='1'&&visual(node).blockInitialAnimation)).toBe(true);
 });
 it('discards interrupted flight plans before a layer return',()=>{
  const {run}=mount();fireEvent.click(screen.getByRole('button',{name:/3개로 시작하기/}));
  act(()=>{run.actions.switchLayer('marketing');});act(()=>{run.actions.switchLayer('management');});
  expect(frames()).toHaveLength(3);
  expect(frames().every(node=>node.style.opacity==='1'&&visual(node).blockInitialAnimation)).toBe(true);
 });
 it('rejects an old last-flight callback after a new run begins',()=>{
  const {run}=mount({template:true}),last=frames().at(-1)!;
  const complete=visual(last).getProps().onAnimationComplete!;
  act(()=>{run.actions.resetRun({screenPreset:screenPresets.A,catalog:getRegistry('A'),theme:'light',reducedMotion:false});});
  const before=run.getState();act(()=>complete({opacity:1}));
  expect(run.getState()).toBe(before);expect(selectCommonNotice(run.getState())).toBeNull();
 });
 it.each([[false,300],[true,80]] as const)('posts completion only on the final flight completion, after readiness (reduced=%s)',(reduced,duration)=>{
  const {run,ready}=mount({template:true,reduced,ready:false});
  act(()=>vi.advanceTimersByTime(1000));expect(run.getState().onboarding.step).toBe('applying');
  ready();const nodes=frames();expect(nodes).toHaveLength(6);
  // jsdom cannot run the compositor. Drive its real completion callback, keeping
  // the production Motion props and presence context intact above this boundary.
  act(()=>vi.advanceTimersByTime(duration-1));finish(nodes[0]);
  expect(selectCommonNotice(run.getState())).toBeNull();expect(run.getState().onboarding.step).toBe('applying');
  act(()=>vi.advanceTimersByTime(1));
  expect(run.getState().onboarding.step).toBe('applying'); // A wall-clock deadline alone is insufficient.
  finish(nodes[5]);expect(run.getState().onboarding.step).toBe('done');
  expect(frames()[0]).toBe(nodes[0]); // Landing must not remount the widget body.
  expect(selectCommonNotice(run.getState())?.messageKey).toBe('run.template.A.completed');
  const notice=selectCommonNotice(run.getState());finish(nodes[5]);expect(selectCommonNotice(run.getState())).toBe(notice);
 });
});
