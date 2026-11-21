import {beginDashboard} from './test-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunStore } from '../state';
import { getRegistry, getLayerCatalog } from '../catalog';
import { screenPresets } from '../layout';
import { timePolicy } from '../ui';
import { createViewportSource } from './viewport';
import { createBrowserBootstrap } from './run';
const makeRun=(id:'A'|'B'='A')=>createRunStore({screenPreset:screenPresets[id],catalog:getRegistry(id),time:timePolicy,clock:()=>0,theme:'light',reducedMotion:true});
function dimensions(width:number,height:number){vi.spyOn(window,'innerWidth','get').mockReturnValue(width);vi.spyOn(window,'innerHeight','get').mockReturnValue(height);}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('browser viewport subscription',()=>{
 it('waits for the first positive viewport exactly once',()=>{
  dimensions(0,0);const source=createBrowserBootstrap(window);const notify=vi.fn();const stop=source.subscribe(notify);
  expect(source.getSnapshot()).toBeNull();dimensions(2560,1440);window.dispatchEvent(new Event('resize'));
  const run=source.getSnapshot()!;expect(run.getState().screenPreset.id).toBe('B');expect(notify).toHaveBeenCalledTimes(1);
  dimensions(1920,1080);window.dispatchEvent(new Event('resize'));expect(source.getSnapshot()).toBe(run);stop();
 });
 it('updates only the projection, allows enlargement and keeps the last positive projection',()=>{
  dimensions(1920,1080);const run=makeRun();beginDashboard(run,'cafe');run.actions.startWithThree();
  const before=run.getState();const source=createViewportSource(run,window);const stop=source.subscribe(vi.fn());
  expect(source.getSnapshot()).toMatchObject({scale:1,offsetX:0,offsetY:0});
  dimensions(3000,1800);window.dispatchEvent(new Event('resize'));expect(source.getSnapshot()).toMatchObject({scale:1.5625,offsetX:0,offsetY:56.25});
  dimensions(960,600);window.dispatchEvent(new Event('resize'));expect(source.getSnapshot()).toMatchObject({scale:.5,offsetX:0,offsetY:30});
  const valid=source.getSnapshot();dimensions(0,0);window.dispatchEvent(new Event('resize'));expect(source.getSnapshot()).toBe(valid);
  expect(run.getState()).toBe(before);stop();
 });
 it('fits a B run below A without losing the B grid or dense committed state',()=>{
  dimensions(2560,1440);const run=makeRun('B');beginDashboard(run,'cafe');
  run.actions.applyLayoutIntent({type:'restore',panels:getLayerCatalog('B','management').map((f,i)=>({featureId:f.id,column:i%8,row:Math.floor(i/8),width:1,height:1}))});
  const state=run.getState();expect(state.panels).toHaveLength(17);const source=createViewportSource(run,window);const stop=source.subscribe(vi.fn());
  dimensions(1280,720);window.dispatchEvent(new Event('resize'));expect(source.getSnapshot().scale).toBe(.5);expect(run.getState()).toBe(state);
  dimensions(2560,1440);window.dispatchEvent(new Event('resize'));expect(source.getSnapshot().scale).toBe(1);expect(run.getState()).toBe(state);stop();
 });
 it('uses the keyboard available area and its origin only while a drawer is open, then restores layout fit',()=>{
  dimensions(1920,1080);const visual=Object.assign(new EventTarget(),{width:1600,height:600,offsetLeft:20,offsetTop:40});
  vi.stubGlobal('visualViewport',visual);
  const run=makeRun();beginDashboard(run,'cafe');const source=createViewportSource(run,window);const stop=source.subscribe(vi.fn());
  expect(source.getSnapshot().scale).toBe(1);run.actions.openDrawer('recommended','');
  expect(source.getSnapshot()).toMatchObject({scale:600/1080,offsetX:20+(1600-1920*600/1080)/2,offsetY:40});
  visual.offsetTop=80;visual.dispatchEvent(new Event('scroll'));expect(source.getSnapshot().offsetY).toBe(80);
  run.actions.closeOverlay();run.actions.finishOverlayExit(run.getState().exitPendingToken!);expect(source.getSnapshot()).toMatchObject({scale:1,offsetX:0,offsetY:0});
  const notify=vi.fn();const stopOther=source.subscribe(notify);stop();stopOther();visual.dispatchEvent(new Event('resize'));expect(notify).not.toHaveBeenCalled();
 });
});
