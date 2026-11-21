import {beginDashboard} from './test-session';
import navisAsset from '../assets/brand/navis-logo.svg';
import '../ui/test-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { createRunStore } from '../state';
import { timePolicy } from '../ui';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { App } from './App';
import { BrowserApp } from './BrowserApp';
import { attachDocumentLifecycle, createBrowserRun } from './run';
const OriginalWorker=globalThis.Worker;
class ReadyWorker {onmessage:((e:{data:{type:string}})=>void)|null=null;postMessage(message:{type:string}){if(message.type==='ready')queueMicrotask(()=>this.onmessage?.({data:{type:'ready'}}));}terminate(){}}
beforeEach(()=>vi.stubGlobal('Worker',ReadyWorker));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.stubGlobal('Worker',OriginalWorker);});
const makeRun=()=>createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>0,theme:'light',reducedMotion:true});
describe('one real application composition',()=>{
 it('opens the order screen and returns to the same management state',async()=>{
  const run=makeRun();beginDashboard(run,'cafe');run.actions.startWithThree();run.actions.dismissCoach();run.actions.setTheme('dark');run.actions.setTextScale(125);
  run.actions.applyLayoutIntent({type:'add-tap',featureId:'tax'});
  const before=run.getState();expect(before.undo).not.toBeNull();const user=userEvent.setup();render(<App run={run}/>);
  expect(screen.getByRole('img',{name:'Navis'})).toHaveAttribute('src',navisAsset);
  const nav=screen.getByRole('navigation',{name:'화면'});
  expect(Array.from(nav.querySelectorAll('button')).map(button=>button.textContent)).toEqual(['주문/결제','관리','마케팅']);
  expect(screen.getByRole('button',{name:'관리'})).toHaveAttribute('aria-current','page');
  for(const label of ['주문/결제']){
   await user.click(screen.getByRole('button',{name:label}));
   expect(screen.getByRole('heading',{name:label,level:1})).toHaveFocus();
   await waitFor(()=>expect(screen.getByRole('tab',{name:'주문'})).toBeVisible());
   expect(screen.queryByRole('navigation',{name:'기능 열'})).not.toBeInTheDocument();
   expect(screen.getByRole('button',{name:label})).toHaveAttribute('aria-current','page');
   await user.click(screen.getByRole('button',{name:'관리'}));
   expect(await screen.findByRole('heading',{name:'안숭잘부 카페',level:1})).toHaveFocus();
   expect(run.getState()).toMatchObject({runId:before.runId,panels:before.panels,theme:'dark',textScale:125,undo:before.undo});
  }
 });
 it('switches on the first press while a coach is active',async()=>{
  let now=0;const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>now,theme:'light',reducedMotion:true});
  beginDashboard(run,'cafe');run.actions.visualSettled();now+=timePolicy.coachFirstMs;run.actions.tick();
  expect(run.getState().guidance.active).toBe('choose-feature');
  render(<App run={run}/>);await userEvent.setup().click(screen.getByRole('button',{name:'주문/결제'}));
  await waitFor(()=>expect(screen.getByRole('heading',{name:'주문/결제',level:1})).toBeVisible());expect(run.getState().guidance.active).toBeNull();
 });
 it('supports keyboard selection and preserves the existing editing and pointer blocks',async()=>{
  const run=makeRun();beginDashboard(run,'cafe');run.actions.dismissCoach();const user=userEvent.setup();render(<App run={run}/>);
  const reservations=screen.getByRole('button',{name:'주문/결제'});reservations.focus();await user.keyboard('{Enter}');
  await waitFor(()=>expect(screen.getByRole('heading',{name:'주문/결제',level:1})).toBeVisible());
  await user.click(screen.getByRole('button',{name:'관리'}));
  act(()=>run.actions.inputStarted({kind:'pointer',id:42}));
  fireEvent.click(screen.getByRole('button',{name:'주문/결제'}));
  expect(screen.getByRole('button',{name:'관리'})).toHaveAttribute('aria-current','page');
  act(()=>{run.actions.inputEnded({kind:'pointer',id:42});run.actions.enterEditing();});
  expect(screen.queryByRole('navigation',{name:'화면'})).not.toBeInTheDocument();
 });
 it('does not enter idle or show coaching or briefing while the order screen is active',async()=>{
  let now=0;const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>now,theme:'light',reducedMotion:true});
  beginDashboard(run,'cafe');run.actions.visualSettled();run.actions.dismissCoach();render(<App run={run}/>);
  await userEvent.setup().click(screen.getByRole('button',{name:'주문/결제'}));
  await waitFor(()=>expect(screen.getByRole('heading',{name:'주문/결제',level:1})).toBeVisible());
  act(()=>{now+=timePolicy.idleMs+timePolicy.briefingSafeMs+100;run.actions.tick();});
  expect(run.getState().idle.mode).toBe('active');expect(run.getState().briefing).not.toBe('visible');expect(run.getState().guidance.active).toBeNull();
  await waitFor(()=>expect(screen.getByRole('heading',{name:'주문/결제',level:1})).toBeVisible());
 });
 it('starts with one question and transitions into the real empty dashboard',async()=>{
  const run=makeRun();const user=userEvent.setup();render(<App run={run}/>);
  expect(screen.getByRole('heading',{name:'어떤 가게를 하세요?'})).toBeInTheDocument();
  expect(run.getState().guidance.dashboardReady).toBe(false);
  await user.click(screen.getByRole('button',{name:'카페'}));
  await user.click(screen.getByRole('radio',{name:/^선불형/}));
  await user.click(screen.getByRole('button',{name:/^빈 화면으로 시작하기/}));
  expect(await screen.findByRole('heading',{name:'안숭잘부 카페',level:1})).toBeInTheDocument();
  await waitFor(()=>expect(run.getState().guidance.dashboardReady).toBe(true));
  expect(run.getState().panels).toEqual([]);
  expect(screen.queryByRole('heading',{name:'어떤 가게를 하세요?'})).not.toBeInTheDocument();
 });
 it('opens settings and detail under the same controlled theme, text scale and run',async()=>{
  const run=makeRun();beginDashboard(run,'cafe');const user=userEvent.setup();render(<App run={run}/>);
  await user.click(screen.getByRole('button',{name:'설정'}));
  const settings=await screen.findByRole('dialog',{name:'설정'});
  await user.click(screen.getByRole('tab',{name:'다크'}));await user.click(screen.getByRole('switch',{name:/큰 글자/}));
  expect(settings.closest('[data-theme]')).toHaveAttribute('data-theme','dark');expect(document.documentElement).toHaveAttribute('data-text-scale','125');
  await user.click(screen.getByRole('button',{name:'닫기'}));
  act(()=>{run.actions.applyLayoutIntent({type:'add-tap',featureId:'margin'});});
  fireEvent.click(screen.getByRole('button',{name:/^마진, 1행 1열, 가로 1칸 세로 1칸, .*자세히 보기$/}),{detail:0});
  expect(await screen.findByRole('dialog',{name:'마진'})).toBeInTheDocument();
  expect(run.getState().panels).toEqual([{featureId:'margin',column:0,row:0,width:1,height:1,condition:{kind:'default'}}]);
 });
});
describe('document execution boundary',()=>{
 it('uses OS preferences initially without touching a storage API',()=>{
  const local=vi.spyOn(Storage.prototype,'setItem');const run=createBrowserRun({theme:'dark',reducedMotion:true});
  expect(run!.getState()).toMatchObject({screen:'business-question',theme:'dark',reducedMotion:true,textScale:100,panels:[]});expect(local).not.toHaveBeenCalled();
 });
 it('preserves the same run on ordinary pageshow and creates a new execution on bfcache return',()=>{
  const run=makeRun();const stop=attachDocumentLifecycle(run,window,()=>({theme:'dark',reducedMotion:true}));
  beginDashboard(run,'cafe');run.actions.startWithThree();run.actions.setTextScale(125);const id=run.getState().runId;
  window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:false}));expect(run.getState().runId).toBe(id);expect(run.getState().panels).toHaveLength(3);
  window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
  expect(run.getState().runId).not.toBe(id);expect(run.getState()).toMatchObject({screen:'business-question',businessType:null,panels:[],theme:'dark',textScale:100,reducedMotion:true,briefing:'pending'});stop();
 });
 it('replaces the mounted tree when an in-memory execution resets, leaving no modal or coach from the old run',async()=>{
  const run=makeRun();const user=userEvent.setup();beginDashboard(run,'cafe');render(<App run={run}/>);
  await user.click(screen.getByRole('button',{name:'설정'}));expect(await screen.findByRole('dialog',{name:'설정'})).toBeInTheDocument();
  act(()=>run.actions.resetRun({screenPreset:screenPresets.A,catalog:getRegistry('A'),theme:'light',reducedMotion:true}));expect(screen.getByRole('heading',{name:'어떤 가게를 하세요?'})).toBeInTheDocument();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 });
});

function viewport(width:number,height:number){
 vi.spyOn(window,'innerWidth','get').mockReturnValue(width);
 vi.spyOn(window,'innerHeight','get').mockReturnValue(height);
}
describe('first positive layout viewport selects the execution',()=>{
 it.each([[1920,1080,'A'],[2399,1200,'A'],[2400,1199,'A'],[2400,1200,'B'],[2399,1440,'A'],[2560,1199,'A'],[2560,1440,'B'],[960,540,'A']])('%i×%i selects %s with matching catalog',(width,height,id)=>{
  viewport(width,height);const run=createBrowserRun({theme:'light',reducedMotion:true});
  expect(run?.getState().screenPreset.id).toBe(id);
  expect(run?.catalog.every(feature=>feature.presetId===id)).toBe(true);
 });
 it('does not choose a fallback before the first positive viewport',()=>{
  viewport(0,1080);expect(createBrowserRun({theme:'light',reducedMotion:true})).toBeNull();
 });
 it('bfcache selects again from the new layout viewport while ordinary pageshow preserves the run',()=>{
  viewport(1920,1080);const run=createBrowserRun({theme:'light',reducedMotion:true})!;
  const stop=attachDocumentLifecycle(run,window,()=>({theme:'dark',reducedMotion:true}));
  beginDashboard(run,'cafe');run.actions.startWithThree();const before=run.getState();
  viewport(2560,1440);window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:false}));
  expect(run.getState().runId).toBe(before.runId);expect(run.getState().screenPreset.id).toBe('A');
  window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
  expect(run.getState()).toMatchObject({screenPreset:screenPresets.B,screen:'business-question',panels:[],theme:'dark',textScale:100});
  expect(run.catalog.every(feature=>feature.presetId==='B')).toBe(true);stop();
 });
 it('waits through a zero viewport on persisted return and creates only one new execution',()=>{
  const run=makeRun();const stop=attachDocumentLifecycle(run,window);const id=run.getState().runId;
  viewport(0,0);window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
  expect(run.getState().runId).toBe(id);expect(run.getState().pageHidden).toBe(true);
  viewport(2560,1440);window.dispatchEvent(new Event('resize'));
  expect(run.getState().runId).not.toBe(id);expect(run.getState().screenPreset.id).toBe('B');
  const next=run.getState().runId;window.dispatchEvent(new Event('resize'));expect(run.getState().runId).toBe(next);stop();
 });
});

describe('one physical fit host',()=>{
 it('shows the preparation status in the default language of a new run (ko) from the kit bundle while no run exists',async()=>{
  viewport(0,0);render(<BrowserApp/>);
  const status=await screen.findByRole('status');
  expect(status).toHaveTextContent('화면을 준비하고 있어요');expect(status).toHaveAttribute('lang','ko');
 });
 it('waits for the first positive viewport before mounting a question',async()=>{
  viewport(0,0);render(<BrowserApp/>);expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  viewport(2560,1440);act(()=>window.dispatchEvent(new Event('resize')));
  expect(await screen.findByRole('heading',{name:'어떤 가게를 하세요?'})).toBeInTheDocument();
  expect(document.querySelector('.ui-root')).toHaveAttribute('data-screen-preset','B');
 });
 it('keeps the mounted settings portal, run and screen when fitting an A run into a B window',async()=>{
  viewport(1920,1080);const run=makeRun();beginDashboard(run,'cafe');run.actions.openSettings();render(<App run={run}/>);
  const dialog=await screen.findByRole('dialog',{name:'설정'});const host=document.querySelector('.app-canvas')!;const canvas=document.querySelector('.ui-root');const before=run.getState();
  expect(host).toHaveStyle({transform:'translate(0px, 0px) scale(1)'});expect(host.contains(dialog)).toBe(true);
  viewport(2560,1440);act(()=>window.dispatchEvent(new Event('resize')));
  expect(host).toHaveStyle({transform:'translate(0px, 0px) scale(1.3333333333333333)'});
  expect(document.querySelector('.ui-root')).toBe(canvas);expect(screen.getByRole('dialog',{name:'설정'})).toBe(dialog);
  expect(run.getState()).toBe(before);expect(canvas).toHaveAttribute('data-screen-preset','A');
 });
});

it('cancels an in-flight candidate on projection change while preserving committed panels and undo',async()=>{
 viewport(1920,1080);const run=makeRun();beginDashboard(run,'cafe');run.actions.startWithThree();render(<App run={run}/>);
 await screen.findByRole('heading',{name:'안숭잘부 카페',level:1});let token:string|null=null;
 act(()=>{token=run.actions.beginPreview({source:'resize',pointerId:71,intent:{type:'resize',featureId:'margin',width:2,height:2}});});
 expect(token).not.toBeNull();const before=run.getState();
 viewport(1280,800);act(()=>window.dispatchEvent(new Event('resize')));
 expect(run.getState().gesturePreview).toBeNull();expect(run.getState().panels).toBe(before.panels);expect(run.getState().undo).toBe(before.undo);expect(run.getState().closingInput).toEqual({kind:'pointer',id:71});
 act(()=>{expect(run.actions.consumeInput({kind:'pointer',id:71},'up')).toBe(true);expect(run.actions.consumeInput({kind:'pointer',id:71},'click')).toBe(true);});
 expect(run.getState().closingInput).toBeNull();
});
