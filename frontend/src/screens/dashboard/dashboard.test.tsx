import {beginDashboard} from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import {useSyncExternalStore} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {LayoutAdapter,LayoutWorkerRequest,LayoutWorkerResponse,Panel,RunStore} from '../../contracts';
import {createRunStore} from '../../state';
import {getRegistry} from '../../catalog';
import {KitProviders} from '../../ui/test-utils';
import {preview,screenPresets} from '../../layout';
import {getPresetLayout,layoutTokens,timePolicy} from '../../ui';
import {replyResponse} from '../../features/assistant/stream-fixture';
import {DashboardScreen} from './DashboardScreen';
import {placementRect} from './gestures';
let activeRun:RunStore|null=null;
afterEach(()=>{cleanup();activeRun?.dispose();activeRun=null;vi.restoreAllMocks();vi.useRealTimers();});
function mount(id:'A'|'B'='A',panels:readonly Panel[]=[],ready=true,layoutAdapter?:LayoutAdapter,clock=()=>0){const preset=screenPresets[id],run=createRunStore({screenPreset:preset,catalog:getRegistry(id),time:timePolicy,clock,theme:'light',reducedMotion:true,layoutAdapter});activeRun=run;beginDashboard(run,'cafe');if(panels.length)run.actions.applyLayoutIntent({type:'restore',panels});
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){let r={x:0,y:0,width:48,height:48};if(this.classList.contains('dashboard-grid-bounds'))r=getPresetLayout(preset).grid;else{const article=this.closest<HTMLElement>('.ui-feature-panel'),p=run.getState().panels.find(p=>p.featureId===article?.dataset.featureId);if(p)r=placementRect(getPresetLayout(preset).grid,p,preset.grid);else if(this.closest('.ui-function-row'))r={x:getPresetLayout(preset).drawer.x,y:200,width:getPresetLayout(preset).drawer.width,height:72};}return {...r,left:r.x,top:r.y,right:r.x+r.width,bottom:r.y+r.height,toJSON:()=>r};});
 function Host(){const s=useSyncExternalStore(run.subscribe,run.getState);return <KitProviders locale={s.locale} preview={s.preview} preset={preset} theme={s.theme} textScale={s.textScale} reducedMotion><DashboardScreen run={run} ready={ready}/></KitProviders>;}
 render(<Host/>);return {run};}
const pointer=(node:Element|Document,type:string,x:number,y:number,id=1)=>fireEvent(node,new PointerEvent(type,{pointerId:id,pointerType:'touch',isPrimary:id===1,button:0,clientX:x,clientY:y,bubbles:true,cancelable:true}));
it.each([
 ['Escape','done'],['pointercancel','done'],['outside','done'],['viewport','done'],['Escape','Escape'],['Escape','empty area'],
] as const)('after %s cancels a pending touch move, %s ends editing despite the queued coach and late answer',async(cancel,exit)=>{
 const requests:{request:LayoutWorkerRequest;receive:(response:LayoutWorkerResponse)=>void}[]=[];
 const adapter:LayoutAdapter={ready:async()=>{},submit:(request,receive)=>{requests.push({request,receive});},cancel:()=>{},dispose:()=>{}};
 vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('ui-popover--coach')?360:48;});
 vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('ui-popover--coach')?160:48;});
 let now=0;const {run}=mount('A',[],true,adapter,()=>now);await act(async()=>{});
 act(()=>{run.actions.startWithThree();run.actions.visualSettled();now=timePolicy.coachFirstMs;run.actions.tick();run.actions.dismissCoach();run.actions.enterEditing();});
 const before=run.getState().panels,revision=run.getState().layoutRevision;
 const panel=screen.getByRole('button',{name:/^캘린더, 1행 3열, 가로 1칸 세로 1칸/}),from=panel.getBoundingClientRect(),grid=getPresetLayout(screenPresets.A).grid;
 pointer(panel,'pointerdown',from.x+80,from.y+80);pointer(document,'pointermove',grid.x+80,grid.y+80);
 await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});
 expect(run.getState().gesturePreview?.status).toBe('pending');
 act(()=>{now+=timePolicy.coachGapMs;});
 if(cancel==='Escape'){fireEvent.keyDown(document,{key:'Escape',code:'Escape'});fireEvent.keyUp(document,{key:'Escape',code:'Escape'});pointer(document,'pointerup',grid.x+80,grid.y+80);}
 else if(cancel==='pointercancel')pointer(document,'pointercancel',grid.x+80,grid.y+80);
 else if(cancel==='outside')pointer(document,'pointerup',grid.x-80,grid.y-80);
 else{fireEvent(window,new Event('resize'));pointer(document,'pointerup',grid.x+80,grid.y+80);}
 expect(run.getState().gesturePreview).toBeNull();expect(run.getState().panels).toEqual(before);
 expect(run.getState().edit).toMatchObject({mode:'edit',gesture:null,gestureToken:null});
 expect(run.getState().activeInputs).toEqual([]);
 expect(run.getState().guidance.active).toBeNull();
 act(()=>{for(const {request,receive} of requests)receive({...request,result:preview(request.beforePanels,request.intent,screenPresets.A.grid,getRegistry('A'))});});
 if(exit==='done')await userEvent.setup().click(screen.getByRole('button',{name:'완료'}));
 else if(exit==='Escape'){fireEvent.keyDown(panel,{key:'Escape',code:'Escape'});fireEvent.keyUp(panel,{key:'Escape',code:'Escape'});}
 else await userEvent.setup().click(screen.getByTestId('dashboard-grid-bounds'));
 act(()=>{for(const {request,receive} of requests)receive({...request,result:preview(request.beforePanels,request.intent,screenPresets.A.grid,getRegistry('A'))});});
 expect(run.getState().edit.mode).toBe('view');await waitFor(()=>expect(screen.getByRole('button',{name:'설정'})).toBeVisible());
 expect(run.getState().panels).toEqual(before);expect(run.getState().layoutRevision).toBe(revision);expect(run.getState().edit.gesture).toBeNull();expect(run.getState().activeInputs).toEqual([]);
});
for(const id of ['A','B'] as const)describe(id+' actual dashboard composition',()=>{
 it('keeps h1/settings focus key and adds three 1x1 starters with one Undo',async()=>{const {run}=mount(id);expect(screen.getByRole('heading',{level:1})).toHaveTextContent('안숭잘부 카페');expect(screen.getByRole('button',{name:'설정'})).toHaveAttribute('data-focus-key','settings');await userEvent.setup().click(screen.getByRole('button',{name:/3개로 시작하기/}));expect(run.getState().panels.map(p=>[p.column,p.row,p.width,p.height])).toEqual([[0,0,1,1],[1,0,1,1],[2,0,1,1]]);await userEvent.setup().click(await screen.findByRole('button',{name:'되돌리기'}));expect(run.getState().panels).toHaveLength(0);});
 it('keeps one Undo after removing the last panel and restores its cell and size',async()=>{
  const last={featureId:'calendar',column:2,row:1,width:2,height:2} as const;
  const {run}=mount(id,[{featureId:'ledger',column:0,row:0,width:1,height:1},{featureId:'margin',column:1,row:0,width:1,height:1},last]),user=userEvent.setup();
  await act(async()=>{});
  act(()=>run.actions.enterEditing());
  for(const label of ['손익','마진','캘린더'])await user.click(screen.getByRole('button',{name:`${label} 빼기`}));
  expect(run.getState().panels).toHaveLength(0);
  expect(run.getState().edit.mode).toBe('view');
  await waitFor(()=>expect(screen.getByRole('button',{name:/3개로 시작하기/})).toBeVisible());
  const undo=await screen.findByRole('button',{name:'되돌리기'});
  expect(screen.getAllByRole('button',{name:'되돌리기'})).toHaveLength(1);
  // Sonner mounts the notice asynchronously; presence alone does not imply visibility.
  await waitFor(()=>expect(undo).toBeVisible());
  await user.click(undo);
  expect(run.getState().panels).toEqual([last]);
  // The restored panel fades in even with reduced motion.
  await waitFor(()=>expect(screen.getByRole('button',{name:/^캘린더, 2행 3열, 가로 2칸 세로 2칸/})).toBeVisible());
  expect(screen.queryByRole('button',{name:'되돌리기'})).toBeNull();
 });
 it('searches the 17 management widgets and tap adds at the first hole while preserving another cell',async()=>{const old={featureId:'calendar',column:3,row:2,width:1,height:1} as const,{run}=mount(id,[old]),user=userEvent.setup();await user.click(screen.getByRole('button',{name:'기능 검색하기'}));expect(screen.getByRole('dialog')).toHaveTextContent('17개 기능');await user.type(screen.getByRole('searchbox'),'손익');await user.click(screen.getByRole('button',{name:'손익'}));expect(run.getState().panels).toContainEqual(old);expect(run.getState().panels.find(p=>p.featureId==='ledger')).toMatchObject({column:0,row:0,width:1,height:1});});
 it('selects on edit tap without changing the snapshot/revision and keeps h1',()=>{const p={featureId:'ledger',column:2,row:1,width:1,height:1} as const,{run}=mount(id,[p]);act(()=>run.actions.enterEditing());const button=screen.getByRole('button',{name:/^손익, \d행 \d열, 가로 1칸 세로 1칸/}),r=button.getBoundingClientRect(),revision=run.getState().layoutRevision;pointer(button,'pointerdown',r.x+30,r.y+30);pointer(document,'pointerup',r.x+30,r.y+30);expect(run.getState().panels).toEqual([p]);expect(run.getState().layoutRevision).toBe(revision);expect(run.getState().edit.selectedFeatureId).toBe('ledger');expect(screen.getByRole('heading',{level:1})).toBeInTheDocument();});
 it('keeps the immediate corner resize reachable while its Undo is visible',async()=>{
  const {run}=mount(id,[{featureId:'margin',column:0,row:screenPresets[id].grid.rows-4,width:1,height:1}]);
  await act(async()=>{}); // Settle the jsdom host's unavailable Worker startup.
  const panel=()=>placementRect(getPresetLayout(screenPresets[id]).grid,run.getState().panels[0],screenPresets[id].grid);
  vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('ui-notice')?680:48;});
  vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('ui-notice')?70:48;});
  vi.spyOn(HTMLElement.prototype,'offsetLeft','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('ui-panel-resize')?panel().width-56:8;});
  vi.spyOn(HTMLElement.prototype,'offsetTop','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('ui-panel-resize')?panel().height-56:8;});
  act(()=>{run.actions.enterEditing();run.actions.selectPanel('margin');run.actions.applyLayoutIntent({type:'resize',featureId:'margin',width:4,height:4});});
  const undo=await screen.findByRole('button',{name:'되돌리기'});
  expect(undo.closest('[data-sonner-toaster]')).toHaveStyle({left:'48px',bottom:`${screenPresets[id].baselineHeight-(getPresetLayout(screenPresets[id]).grid.y+getPresetLayout(screenPresets[id]).grid.height)+layoutTokens.margin}px`});
  const handle=screen.getByRole('button',{name:/마진 크기 바꾸기/});
  const r=panel(),from={x:r.x+r.width-32,y:r.y+r.height-32};
  pointer(handle,'pointerdown',from.x,from.y);pointer(document,'pointermove',from.x-3*(id==='A'?892/3:303),from.y-3*(id==='A'?240:264));pointer(document,'pointerup',from.x-3*(id==='A'?892/3:303),from.y-3*(id==='A'?240:264));
  expect(run.getState().panels[0]).toMatchObject({width:1,height:1});
 });
 it('uses keyboard axes and one coordinate notice with a resize alternative',async()=>{const p={featureId:'ledger',column:0,row:0,width:1,height:1} as const,{run}=mount(id,[p]);act(()=>run.actions.enterEditing());const button=screen.getByRole('button',{name:/^손익, \d행 \d열, 가로 1칸 세로 1칸/});fireEvent.keyDown(button,{key:'ArrowRight'});fireEvent.keyUp(button,{key:'ArrowRight'});expect(run.getState().panels[0].column).toBe(1);fireEvent.keyDown(button,{key:'ArrowDown',ctrlKey:true});fireEvent.keyUp(button,{key:'ArrowDown',ctrlKey:true});expect(run.getState().panels[0]).toMatchObject({width:1,height:2});expect(await screen.findByText(/1행.*2열/)).toBeInTheDocument();await userEvent.setup().click(screen.getByRole('button',{name:/손익 크기 바꾸기/}));expect(screen.getByRole('group',{name:'가로 칸 수'})).toBeInTheDocument();});
 it('prevents native touch scrolling only after a drawer contact becomes drag, even on the detached row',async()=>{const {run}=mount(id),user=userEvent.setup();await user.click(screen.getByRole('button',{name:'재무'}));const row=screen.getByRole('button',{name:'손익'}),r=row.getBoundingClientRect();pointer(row,'pointerdown',r.x+120,r.y+20);const listMove=new Event('touchmove',{cancelable:true,bubbles:true});row.dispatchEvent(listMove);expect(listMove.defaultPrevented).toBe(false);pointer(document,'pointermove',r.x+108,r.y+26);expect(run.getState().gesturePreview).not.toBeNull();expect(row.isConnected).toBe(false);const dragMove=new Event('touchmove',{cancelable:true,bubbles:true});row.dispatchEvent(dragMove);expect(dragMove.defaultPrevented).toBe(true);pointer(document,'pointercancel',r.x+108,r.y+26);});
 it('disables resize choices beyond the right and bottom boundaries with an explanation',async()=>{const {run}=mount(id,[{featureId:'ledger',column:screenPresets[id].grid.columns-1,row:screenPresets[id].grid.rows-1,width:1,height:1}]);act(()=>run.actions.enterEditing());await userEvent.setup().click(screen.getByRole('button',{name:/손익 크기 바꾸기/}));expect(screen.getByRole('button',{name:'가로 2칸'})).toBeDisabled();expect(screen.getByRole('button',{name:'세로 2칸'})).toBeDisabled();expect(screen.getByRole('button',{name:'가로 2칸'})).toHaveAccessibleDescription(expect.stringContaining('격자'));});
 it('preserves a panel node after flight and an unrelated revision',async()=>{const {run}=mount(id);await userEvent.setup().click(screen.getByRole('button',{name:/3개로 시작하기/}));const panel=screen.getByRole('button',{name:/^손익, \d행/});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,100));});act(()=>run.actions.applyLayoutIntent({type:'add-tap',featureId:'tax'}));expect(screen.getByRole('button',{name:/^손익, \d행/})).toBe(panel);});
});
it('starts no dashboard lifecycle while the question owns the run',()=>{const preset=screenPresets.A,run=createRunStore({screenPreset:preset,catalog:getRegistry('A'),time:timePolicy,clock:()=>0,theme:'light'});activeRun=run;render(<KitProviders preset={preset}><DashboardScreen run={run}/></KitProviders>);expect(screen.queryByRole('main')).toBeNull();expect(run.getState().guidance.dashboardReady).toBe(false);});

it.each(['mouse','touch'] as const)('keeps the candidate sensor alive through %s drag cancellation',async(pointerType)=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(replyResponse({answer:'추천해요',panels:[{featureId:'ledger',size:{width:2,height:1},reason:'확인'}]}));
 const {run}=mount('A');await userEvent.setup().click(screen.getByRole('button',{name:'Navis 열기'}));fireEvent.change(screen.getByRole('textbox'),{target:{value:'매출 보여줘'}});fireEvent.click(screen.getByRole('button',{name:'요청 보내기'}));const card=await screen.findByRole('group',{name:'손익'});const start={x:1600,y:400};
 const send=(node:Element|Document,type:string,x:number,y:number)=>fireEvent(node,new PointerEvent(type,{pointerId:1,pointerType,isPrimary:true,button:0,clientX:x,clientY:y,bubbles:true,cancelable:true}));
 send(card,'pointerdown',start.x,start.y);send(document,'pointermove',start.x-30,start.y);await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});expect(run.getState().gesturePreview?.source).toBe('candidate');expect(screen.getByRole('region',{name:'Navis',hidden:true}).parentElement).toHaveAttribute('inert');send(document,'pointercancel',start.x-30,start.y);expect(run.getState().panels).toEqual([]);expect(run.getState().gesturePreview).toBeNull();expect(screen.getByRole('region',{name:'Navis'})).toBeInTheDocument();
});
it.each(['mouse','touch'] as const)('drops a %s candidate with the displayed size and can undo it',async(pointerType)=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(replyResponse({answer:'추천해요',panels:[{featureId:'ledger',size:{width:2,height:1},reason:'확인'}]}));const {run}=mount('A');await userEvent.setup().click(screen.getByRole('button',{name:'Navis 열기'}));fireEvent.change(screen.getByRole('textbox'),{target:{value:'매출'}});fireEvent.click(screen.getByRole('button',{name:'요청 보내기'}));const card=await screen.findByRole('group',{name:'손익'});expect(screen.getByText('추천해요')).toBeInTheDocument();expect(screen.queryByText('간단히 답했어요')).toBeNull();expect(run.getState().panels).toEqual([]);const grid=getPresetLayout(screenPresets.A).grid;const target=placementRect(grid,{column:0,row:0,width:2,height:1},screenPresets.A.grid);const x=target.x+target.width/2,y=target.y+target.height/2;
 const send=(node:Element|Document,type:string,px:number,py:number)=>fireEvent(node,new PointerEvent(type,{pointerId:1,pointerType,isPrimary:true,button:0,clientX:px,clientY:py,bubbles:true,cancelable:true}));send(card,'pointerdown',1600,400);send(document,'pointermove',1570,400);send(document,'pointermove',x,y);send(document,'pointerup',x,y);expect(run.getState().panels.find(p=>p.featureId==='ledger')).toMatchObject({column:0,row:0,width:2,height:1});expect(screen.queryByRole('region',{name:'Navis'})).toBeNull();const undo=await screen.findByRole('button',{name:'되돌리기'});fireEvent.click(undo);expect(run.getState().panels).toEqual([]);
});
it('Escape cancels a candidate drag and restores the conversation and draft',async()=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(replyResponse({answer:'추천해요',panels:[{featureId:'ledger',size:{width:2,height:1},reason:'확인'}]}));const {run}=mount('A');await userEvent.setup().click(screen.getByRole('button',{name:'Navis 열기'}));fireEvent.change(screen.getByRole('textbox'),{target:{value:'매출'}});fireEvent.click(screen.getByRole('button',{name:'요청 보내기'}));const card=await screen.findByRole('group',{name:'손익'});fireEvent.change(screen.getByRole('textbox'),{target:{value:'남긴 초안'}});pointer(card,'pointerdown',1600,400);pointer(document,'pointermove',1570,400);expect(run.getState().gesturePreview?.source).toBe('candidate');fireEvent.keyDown(card,{key:'Escape',code:'Escape'});fireEvent.keyUp(card,{key:'Escape',code:'Escape'});pointer(document,'pointerup',100,100);expect(run.getState().gesturePreview).toBeNull();expect(screen.getByRole('region',{name:'Navis'})).toBeInTheDocument();expect(screen.getByRole('textbox')).toHaveValue('남긴 초안');expect(run.getState().panels).toEqual([]);
});
it.each([
 ['en','management',[['Recommended','Picks'],['상품','상품'],['재고','재고'],['재무','재무'],['회원','회원'],['매장','매장'],['일정','일정'],['기타','기타']]],
 ['en','marketing',[['Recommended','Picks'],['News','News'],['Money','Money'],['Customers','Guests'],['Neighborhood','Local']]],
 ['ko','marketing',[['추천','추천'],['소식','소식'],['돈','돈'],['손님','손님'],['동네','동네']]],
 ['zh-Hant','management',[['推薦','推薦'],['상품','상품'],['재고','재고'],['재무','재무'],['회원','회원'],['매장','매장'],['일정','일정'],['기타','기타']]],
] as const)('rail in %s on %s: short visible names from LOCALES 2, full accessible names (T-055)',(locale,layer,rows)=>{
 const {run}=mount('A');act(()=>{run.actions.setLocale(locale);if(layer==='marketing')run.actions.switchLayer('marketing');});
 // The first rail item is search; the rest are the layer's five groups in order.
 const groups=Array.from(document.querySelectorAll<HTMLButtonElement>('.dashboard-rail .ui-rail-item')).slice(1);
 expect(groups.map(button=>[button.getAttribute('aria-label')??button.textContent,button.querySelector('.ui-rail-item__label')!.textContent])).toEqual(rows.map(([name,visible])=>[name,visible]));
 for(const [name] of rows)expect(screen.getByRole('button',{name})).toBeInTheDocument();
});
it('lays an example-state panel out top to bottom (flow) so its action keeps its margin; normal panels keep the plan-1 frame (T-049 hand-over)',()=>{
 const {run}=mount('A',[{featureId:'ledger',column:0,row:0,width:1,height:1},{featureId:'calendar',column:1,row:0,width:1,height:1}]);
 const panel=(id:string)=>document.querySelector(`.dashboard-page-layer [data-feature-id="${id}"]`)!;
 expect(panel('ledger')).not.toHaveAttribute('data-flow');
 act(()=>run.actions.setPreviewFamily('empty'));
 expect(panel('ledger')).toHaveAttribute('data-flow','true');
 act(()=>{run.actions.setPreviewFamily('normal');run.actions.setPreviewVariant('ledger','error');});
 expect(panel('ledger')).toHaveAttribute('data-flow','true');expect(panel('calendar')).not.toHaveAttribute('data-flow');
});

it('uses the demo store name as the dashboard heading in both dashboard layers', () => {
 const {run}=mount('A');
 expect(screen.getByRole('heading',{level:1,name:'안숭잘부 카페'})).toBeInTheDocument();
 act(()=>run.actions.switchLayer('marketing'));
 expect(screen.getByRole('heading',{level:1,name:'안숭잘부 카페'})).toBeInTheDocument();
});
