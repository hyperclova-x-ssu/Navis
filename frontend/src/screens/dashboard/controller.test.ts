import {beginDashboard} from '../../app/test-session';
import {describe,expect,it,vi} from 'vitest';
import type {LayoutAdapter,LayoutWorkerRequest,LayoutWorkerResponse,Panel,RunStore} from '../../contracts';
import {createRunStore} from '../../state';
import {getRegistry} from '../../catalog';
import {preview,screenPresets} from '../../layout';
import {getPresetLayout,timePolicy} from '../../ui';
import {createDashboardController} from './controller';
import {panelRect} from './gestures';
function setup(id:'A'|'B'='A',panels:readonly Panel[]=[],guard?:()=>boolean){
 const preset=screenPresets[id],catalog=getRegistry(id),requests:{request:LayoutWorkerRequest;receive:(r:LayoutWorkerResponse)=>void}[]=[];
 const adapter:LayoutAdapter={ready:async()=>{},submit:(request,receive)=>{requests.push({request,receive});},cancel:()=>{},dispose:()=>{}};
 const run:RunStore=createRunStore({screenPreset:preset,catalog,time:timePolicy,clock:()=>0,theme:'light',layoutAdapter:adapter,previewGuard:guard});beginDashboard(run,'cafe');if(panels.length)run.actions.applyLayoutIntent({type:'restore',panels});
 const grid=getPresetLayout(preset).grid;const active=vi.fn(),drop=vi.fn(),flight=vi.fn();let timerId=0;const controller=createDashboardController(run,{getGridRect:()=>grid,select:()=>{},consumePointer:()=>{},onActive:active,onDrop:drop,onFlight:flight,requestFrame:fn=>{fn();return 1;},cancelFrame:()=>{},schedule:()=>++timerId,cancelTimer:()=>{}});
 const settle=()=>{const item=requests.at(-1)!;item.receive({...item.request,result:preview(item.request.beforePanels,item.request.intent,preset.grid,catalog)});};return {run,controller,grid,active,drop,flight,settle,requests};
}
for(const id of ['A','B'] as const)describe(id+' controller',()=>{
 it('adds 1x1 by tap to the first hole, preserves existing gaps and restores one exact undo snapshot',()=>{
  const old=[{featureId:'margin',column:2,row:1,width:1,height:1}] as const;const {run,controller}=setup(id,old);controller.tap({source:'feature',featureId:'ledger'},{x:0,y:0},{x:0,y:0,width:10,height:10});
  expect(run.getState().panels).toContainEqual(old[0]);expect(run.getState().panels.find(p=>p.featureId==='ledger')).toMatchObject({column:0,row:0,width:1,height:1});controller.undo(run.getState().undo!.token);expect(run.getState().panels).toEqual(old);
 });
 it('keeps an unmoved lift unchanged and resizes horizontal and vertical independently',()=>{
  const panel={featureId:'ledger',column:0,row:0,width:1,height:1} as const;const {run,controller,grid}=setup(id,[panel]);const revision=run.getState().layoutRevision;
  controller.start({source:'panel',featureId:'ledger'},1,{x:grid.x+20,y:grid.y+30},{...grid,width:281,height:224});controller.end({x:grid.x+20,y:grid.y+30});expect(run.getState().layoutRevision).toBe(revision);
  controller.resize('ledger',{width:2,height:1});expect(run.getState().panels[0]).toMatchObject({width:2,height:1});controller.resize('ledger',{width:2,height:3});expect(run.getState().panels[0]).toMatchObject({width:2,height:3});
 });
 it('holds commit while pending, commits one current collision result and undoes the whole displacement',()=>{
  const before=[{featureId:'ledger',column:0,row:0,width:1,height:1},{featureId:'margin',column:1,row:0,width:1,height:1}] as const;const {run,controller,settle,requests}=setup(id,before);controller.moveCell('ledger',{column:1,row:0});expect(run.getState().gesturePreview?.pendingCommit).toBe(true);expect(run.getState().panels).toEqual(before);expect(requests.length).toBeGreaterThan(0);settle();expect(run.getState().panels.find(p=>p.featureId==='ledger')?.column).toBe(1);const revision=run.getState().layoutRevision;settle();expect(run.getState().layoutRevision).toBe(revision);controller.undo(run.getState().undo!.token);expect(run.getState().panels).toEqual(before);
 });
 it('does not complete a coached action when beginPreview rejects, and cancels held commit on projection change',()=>{
  const before=[{featureId:'ledger',column:0,row:0,width:1,height:1},{featureId:'margin',column:1,row:0,width:1,height:1}] as const;const denied=setup(id,before,()=>false);const coach=vi.spyOn(denied.run.actions,'coachedAction');denied.controller.start({source:'resize',featureId:'ledger'},1,{x:50,y:200},{x:24,y:112,width:281,height:224});expect(coach).not.toHaveBeenCalled();
  const {run,controller,settle}=setup(id,before);controller.moveCell('ledger',{column:1,row:0});controller.cancelForViewportChange();settle();expect(run.getState().panels).toEqual(before);expect(run.getState().gesturePreview).toBeNull();
 });
});

describe('candidate gestures',()=>{
 const condition={kind:'dateRange',start:'2026-10-20',end:'2026-10-26'} as const;
 const data={source:'candidate',featureId:'ledger',size:{width:2,height:1},condition} as const;
 it('taps a recommended size, retains its condition, and undoes it',()=>{const {run,controller}=setup();controller.tap(data,{x:0,y:0},{x:0,y:0,width:20,height:20});expect(run.getState().panels[0]).toMatchObject({width:2,height:1,condition});controller.undo(run.getState().undo!.token);expect(run.getState().panels).toEqual([]);});
 it('previews a candidate drop at the same size and condition and restores on cancel',()=>{const {run,controller,grid}=setup();expect(controller.start(data,7,{x:grid.x+20,y:grid.y+20},{x:grid.x+20,y:grid.y+20,width:100,height:60})).toBe(true);controller.move({x:grid.x+120,y:grid.y+80});expect(run.getState().gesturePreview?.intent).toMatchObject({type:'add-ai',width:2,height:1,condition});controller.cancel();expect(run.getState().panels).toEqual([]);expect(run.getState().edit.mode).toBe('view');});
 it('displaces on candidate drop and undoes the exact snapshot',()=>{const old=[{featureId:'margin',column:0,row:0,width:1,height:1}] as const;const {run,controller,grid,settle}=setup('A',old);const span=panelRect(grid,{width:2,height:1},run.getState().screenPreset.grid);const point={x:grid.x+span.width/2,y:grid.y+span.height/2};controller.start(data,7,point,{...point,width:100,height:60});controller.end(point);if(run.getState().gesturePreview?.pendingCommit)settle();expect(run.getState().panels.find(p=>p.featureId==='ledger')).toMatchObject({width:2,height:1,condition});controller.undo(run.getState().undo!.token);expect(run.getState().panels).toEqual(old);});
});
it('rejects an outside candidate drop without changing layout or undo',()=>{const before=[{featureId:'margin',column:1,row:1,width:1,height:1}] as const;const {run,controller,grid}=setup('A',before);const previous=run.getState(),data={source:'candidate',featureId:'ledger',size:{width:2,height:1},condition:{kind:'default'}} as const;controller.start(data,1,{x:grid.x+50,y:grid.y+50},{x:grid.x+50,y:grid.y+50,width:80,height:60});const result=controller.end({x:grid.x-50,y:grid.y-50});expect(result?.code).toBe('OUTSIDE_GRID');expect(run.getState().panels).toEqual(before);expect(run.getState().undo).toEqual(previous.undo);});

/** T-052: edge dwell, position-only previews and page moves (ARCHITECTURE 11.4-6~9, API-04 v4). */
describe('pages and edge dwell',()=>{
 function pages(count:number,panels:readonly Panel[]=[]){
  const preset=screenPresets.A,catalog=getRegistry('A'),requests:{request:LayoutWorkerRequest;receive:(r:LayoutWorkerResponse)=>void}[]=[];
  const adapter:LayoutAdapter={ready:async()=>{},submit:(request,receive)=>{requests.push({request,receive});},cancel:()=>{},dispose:()=>{}};
  const run:RunStore=createRunStore({screenPreset:preset,catalog,time:timePolicy,clock:()=>0,theme:'light',layoutAdapter:adapter});beginDashboard(run,'cafe');
  if(panels.length)run.actions.applyLayoutIntent({type:'restore',panels});
  for(let i=1;i<count;i++)run.actions.addPage();run.actions.goToPage(0);
  // A fake clock for the controller's dwell timers.
  let now=0,next=0;const timers=new Map<number,{fn:()=>void;at:number;ms:number}>();
  const schedule=vi.fn((fn:()=>void,ms:number)=>{const id=++next;timers.set(id,{fn,at:now+ms,ms});return id;}),cancelTimer=vi.fn((id:number)=>{timers.delete(id);});
  const advance=(ms:number)=>{const end=now+ms;for(;;){const due=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].fn();}now=end;};
  const grid=getPresetLayout(preset).grid,edges:unknown[]=[],duplicates:[string,number][]=[];
  const controller=createDashboardController(run,{getGridRect:()=>grid,select:()=>{},consumePointer:()=>{},onActive:()=>{},onFlight:()=>{},requestFrame:fn=>{fn();return 1;},cancelFrame:()=>{},schedule,cancelTimer,onEdge:edge=>edges.push(edge),onDuplicate:(id,page)=>duplicates.push([id,page])});
  const settle=()=>{const item=requests.at(-1)!;item.receive({...item.request,result:preview(item.request.beforePanels,item.request.intent,preset.grid,catalog)});};
  return {run,controller,grid,schedule,cancelTimer,advance,timers,edges,duplicates,settle,page:()=>run.getState().boards.management.currentPage};
 }
 const ledger={featureId:'ledger',column:0,row:0,width:1,height:1} as const;
 const grabLedger=(c:ReturnType<typeof pages>['controller'],grid:{x:number;y:number})=>{const from={x:grid.x+40,y:grid.y+40};expect(c.start({source:'panel',featureId:'ledger'},1,from,{x:grid.x,y:grid.y,width:281,height:208})).toBe(true);c.move({x:from.x+300,y:from.y+60});};
 it('flips after 500ms in the band, then every 700ms with a still pointer, and sends only positions',()=>{
  const {run,controller,grid,schedule,advance,page,edges}=pages(3,[ledger]);const update=vi.spyOn(run.actions,'updatePreview');
  grabLedger(controller,grid);expect(update.mock.calls.every(call=>call.length===2&&!('type' in (call[1] as object)))).toBe(true);
  controller.move({x:grid.x+grid.width-20,y:grid.y+300});expect(schedule).toHaveBeenLastCalledWith(expect.any(Function),500);expect(edges.at(-1)).toEqual({side:'right',targetPage:2});
  advance(499);expect(page()).toBe(0);advance(1);expect(page()).toBe(1);expect(run.getState().gesturePreview).toMatchObject({sourcePage:0,targetPage:1});
  expect(schedule).toHaveBeenLastCalledWith(expect.any(Function),700);expect(edges.at(-1)).toEqual({side:'right',targetPage:3});
  advance(699);expect(page()).toBe(1);advance(1);expect(page()).toBe(2);
  // No neighbour after the last page: no new page, no band, no further timer.
  const calls=schedule.mock.calls.length;advance(5000);expect(run.getState().boards.management.pages).toHaveLength(3);expect(schedule.mock.calls.length).toBe(calls);expect(edges.at(-1)).toBeNull();
 });
 it('drops on the flipped page as one move-page change and undoes both pages and the viewed page',()=>{
  const {run,controller,grid,advance,page}=pages(2,[ledger,{featureId:'margin',column:1,row:0,width:1,height:1}]);const revision=run.getState().layoutRevision,boardRevision=run.getState().boards.management.revision;
  grabLedger(controller,grid);controller.move({x:grid.x+grid.width-20,y:grid.y+300});advance(500);expect(page()).toBe(1);
  const drop={x:grid.x+grid.width/2,y:grid.y+grid.height/2};controller.move(drop);const result=controller.end(drop);
  expect(result?.status).toBe('accepted');const board=run.getState().boards.management;
  expect(board.pages[0].panels.map(p=>p.featureId)).toEqual(['margin']);expect(board.pages[1].panels.map(p=>p.featureId)).toEqual(['ledger']);expect(board.currentPage).toBe(1);
  expect(run.getState().layoutRevision).toBe(revision+1);expect(board.revision).toBe(boardRevision+1);expect(board.undo?.kind).toBe('move-page');expect(run.getState().notice).toMatchObject({messageKey:'move-page',params:{n:2}});
  controller.undo(board.undo!.token);const restored=run.getState().boards.management;expect(restored.pages[0].panels).toEqual([ledger,{featureId:'margin',column:1,row:0,width:1,height:1}]);expect(restored.pages[1].panels).toEqual([]);expect(restored.currentPage).toBe(0);
 });
 it('returns to the source page with no undo when the flipped page has no room',()=>{
  const full=[{featureId:'margin',column:0,row:0,width:4,height:4},{featureId:'calendar',column:4,row:0,width:2,height:4}] as const;
  const {run,controller,grid,advance,page}=pages(2,[ledger]);run.actions.goToPage(1);run.actions.applyLayoutIntent({type:'restore',panels:full});run.actions.goToPage(0);const undo=run.getState().boards.management.undo;
  grabLedger(controller,grid);controller.move({x:grid.x+grid.width-20,y:grid.y+300});advance(500);expect(page()).toBe(1);
  const drop={x:grid.x+300,y:grid.y+300};controller.move(drop);expect(run.getState().gesturePreview?.status).toBe('rejected');const result=controller.end(drop);
  expect(result?.status).toBe('rejected');expect(page()).toBe(0);expect(run.getState().boards.management.pages[0].panels).toEqual([ledger]);expect(run.getState().boards.management.undo).toEqual(undo);expect(run.getState().notice?.messageKey).toBe('no-room-next-page');
 });
 it('treats a drop over the feature rail as OUTSIDE_GRID and returns to the source page',()=>{
  const {run,controller,grid,advance,page}=pages(2,[ledger]);const undo=run.getState().boards.management.undo;
  grabLedger(controller,grid);controller.move({x:grid.x+grid.width+40,y:grid.y+300});advance(500);expect(page()).toBe(1);
  const result=controller.end({x:grid.x+grid.width+40,y:grid.y+300});
  expect(result?.code).toBe('OUTSIDE_GRID');expect(page()).toBe(0);expect(run.getState().boards.management.pages[0].panels).toEqual([ledger]);expect(run.getState().boards.management.pages[1].panels).toEqual([]);expect(run.getState().boards.management.undo).toEqual(undo);expect(run.getState().notice?.messageKey).toBe('OUTSIDE_GRID');
 });
 it.each(['leave','end','cancel','viewport','dispose'] as const)('clears the dwell timer on %s',(how)=>{
  const {controller,grid,advance,page,cancelTimer,timers}=pages(2,[ledger]);grabLedger(controller,grid);controller.move({x:grid.x+grid.width-20,y:grid.y+300});expect(timers.size).toBe(1);
  if(how==='leave')controller.move({x:grid.x+600,y:grid.y+300});else if(how==='end')controller.end({x:grid.x+600,y:grid.y+300});else if(how==='cancel')controller.cancel();else if(how==='viewport')controller.cancelForViewportChange();else controller.dispose();
  expect(cancelTimer).toHaveBeenCalled();expect(timers.size).toBe(0);advance(2000);expect(page()).toBe(0);
 });
 it('has no band toward a side without a neighbour page and needs the pointer to enter the band',()=>{
  const {controller,grid,schedule,edges}=pages(2,[ledger]);grabLedger(controller,grid);
  controller.move({x:grid.x+10,y:grid.y+300});expect(schedule).not.toHaveBeenCalled();expect(edges.filter(Boolean)).toEqual([]);
  // A drawer drag that starts inside the right band waits until the pointer has left it once.
  const second=pages(2);expect(second.controller.start({source:'feature',featureId:'ledger'},2,{x:second.grid.x+second.grid.width-10,y:second.grid.y+200},{x:1500,y:300,width:300,height:72})).toBe(true);
  second.controller.move({x:second.grid.x+second.grid.width-12,y:second.grid.y+200});expect(second.schedule).not.toHaveBeenCalled();
  second.controller.move({x:second.grid.x+900,y:second.grid.y+200});second.controller.move({x:second.grid.x+second.grid.width-12,y:second.grid.y+200});expect(second.schedule).toHaveBeenCalledWith(expect.any(Function),500);
  second.advance(500);expect(second.page()).toBe(1);const drop={x:second.grid.x+100,y:second.grid.y+100};second.controller.move(drop);expect(second.controller.end(drop)?.status).toBe('accepted');expect(second.run.getState().boards.management.pages[1].panels.map(p=>p.featureId)).toEqual(['ledger']);
 });
 it('refuses to start a drawer drag for a widget on another page and reports that page',()=>{
  const {run,controller,grid,duplicates}=pages(2,[ledger]);run.actions.goToPage(1);
  expect(controller.start({source:'feature',featureId:'ledger'},1,{x:grid.x+600,y:grid.y+200},{x:1500,y:300,width:300,height:72})).toBe(false);
  expect(duplicates).toEqual([['ledger',0]]);expect(run.getState().notice).toMatchObject({messageKey:'duplicate-other-page',params:{n:1}});expect(run.getState().boards.management.pages[1].panels).toEqual([]);
 });
 it('sends the selected panel to the next page without dragging (11.4-9) and refuses at the last page',()=>{
  const {run,controller}=pages(2,[ledger]);run.actions.enterEditing();run.actions.selectPanel('ledger');
  expect(controller.movePanelToPage('ledger',1).status).toBe('accepted');expect(run.getState().boards.management.pages[1].panels).toEqual([expect.objectContaining(ledger)]);expect(run.getState().boards.management.currentPage).toBe(1);
  expect(controller.movePanelToPage('ledger',1).code).toBe('NO_NEIGHBOR_PAGE');
 });
 it('starts the marketing recommended layout with M-28 flights 24ms apart, top to bottom and left to right',()=>{
  const {run,controller}=pages(1);const flights=vi.fn();const c=createDashboardController(run,{getGridRect:()=>getPresetLayout(screenPresets.A).grid,select:()=>{},consumePointer:()=>{},onActive:()=>{},onFlight:flights,requestFrame:fn=>{fn();return 1;},cancelFrame:()=>{},schedule:()=>0,cancelTimer:()=>{}});void controller;
  run.actions.switchLayer('marketing');c.startPreset({x:700,y:500,width:400,height:56});
  const plans=flights.mock.calls[0][0] as readonly {featureId:string;index:number;stagger:number}[];expect(plans).toHaveLength(8);expect(plans.map(p=>p.stagger)).toEqual(Array(8).fill(24));expect(plans.map(p=>p.index)).toEqual([0,1,2,3,4,5,6,7]);
  expect(plans.map(p=>p.featureId)).toEqual(['marketing-today','ai-response','expiry-coupon','promo-video','slot-coupon','coupon-status','customer-groups','marketing-performance']);
 });
});
