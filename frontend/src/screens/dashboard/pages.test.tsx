import {ExampleStateChipForRun} from '../settings';
import {beginDashboard} from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import {useSyncExternalStore} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {FeatureId,Locale,Panel,RunStore,WidgetModule} from '../../contracts';
import {createRunStore,findPlacement} from '../../state';
import {getRegistry} from '../../catalog';
import {screenPresets} from '../../layout';
import {PanelAction,ScreenTransition,getPresetLayout,timePolicy} from '../../ui';
import {KitProviders} from '../../ui/test-utils';
import {DashboardScreen} from './DashboardScreen';
import {placementRect} from './gestures';
import {dashboardBundle,dashboardReviewStringCount} from './messages';

let activeRun:RunStore|null=null;
afterEach(()=>{cleanup();activeRun?.dispose();activeRun=null;vi.restoreAllMocks();vi.useRealTimers();});
/** Stub widget modules (other tasks' modules are not used as test evidence). */
const stub=(id:FeatureId,extra:Partial<WidgetModule>={}):WidgetModule=>({id,Panel:()=><p data-testid={`body-${id}`}>stub {id}</p>,Detail:()=><p>detail {id}</p>,useSummary:()=>`summary ${id}`,...extra});
function mount({layer='management',panels=[],pages=1,clock=()=>0,modules=[],business='cafe',locale='ko',crossfade=false}:{layer?:'management'|'marketing';panels?:readonly Panel[];pages?:number;clock?:()=>number;modules?:readonly WidgetModule[];business?:'cafe'|'retail'|null;locale?:Locale;/** Wrap the board like App.tsx does: a ScreenTransition keyed by screen and layer, so an exiting layer overlaps the arriving one. */crossfade?:boolean}={}){
 const preset=screenPresets.A,run=createRunStore({screenPreset:preset,catalog:getRegistry('A'),time:timePolicy,clock,theme:'light',reducedMotion:true});activeRun=run;
 beginDashboard(run,business);if(locale!=='ko')run.actions.setLocale(locale);if(layer==='marketing')run.actions.switchLayer('marketing');
 if(panels.length)run.actions.applyLayoutIntent({type:'restore',panels});for(let i=1;i<pages;i++)run.actions.addPage();if(pages>1)run.actions.goToPage(0);
 const grid=getPresetLayout(preset).grid;
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){let r={x:0,y:0,width:48,height:48};if(this.classList.contains('dashboard-grid-bounds'))r=grid;else{const article=this.closest<HTMLElement>('.ui-feature-panel'),p=run.getState().panels.find(p=>p.featureId===article?.dataset.featureId);if(p)r=placementRect(grid,p,preset.grid);else if(this.closest('.ui-function-row'))r={x:getPresetLayout(preset).drawer.x,y:200,width:getPresetLayout(preset).drawer.width,height:72};}return {...r,left:r.x,top:r.y,right:r.x+r.width,bottom:r.y+r.height,toJSON:()=>r};});
 vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('ui-popover--coach')?400:48;});
 vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('ui-popover--coach')?160:48;});
 function Host(){const s=useSyncExternalStore(run.subscribe,run.getState);return <KitProviders locale={s.locale} preset={preset} theme={s.theme} textScale={s.textScale} reducedMotion modules={modules}><DashboardScreen run={run} renderScreen={crossfade?board=><ScreenTransition screenKey={`${s.screen}:${s.layer}`}>{board}</ScreenTransition>:undefined}/><ExampleStateChipForRun run={run}/></KitProviders>;}
 render(<Host/>);return {run,grid,page:()=>run.getState().boards[run.getState().activeBoard].currentPage};
}
const pointer=(node:Element|Document,type:string,x:number,y:number,id=1)=>fireEvent(node,new PointerEvent(type,{pointerId:id,pointerType:'mouse',isPrimary:true,button:0,clientX:x,clientY:y,bubbles:true,cancelable:true}));
const key=(node:Element|Document,k:string,init:KeyboardEventInit={})=>{fireEvent.keyDown(node,{key:k,code:k,...init});fireEvent.keyUp(node,{key:k,code:k,...init});};
const ledger={featureId:'ledger',column:0,row:0,width:1,height:1} as const;

describe('page bar (SCR-24, AC-181~185)',()=>{
 it('is hidden on the first empty screen, shows a text add button for one page, then dots and arrows',async()=>{
  const {run}=mount();await act(async()=>{});
  expect(screen.queryByRole('navigation',{name:'페이지'})).toBeNull();
  act(()=>{run.actions.applyLayoutIntent({type:'add-tap',featureId:'ledger'});});
  const bar=screen.getByRole('navigation',{name:'페이지'});expect(within(bar).getByRole('button',{name:'페이지 추가하기'})).toBeVisible();expect(within(bar).queryByRole('button',{name:/페이지로 이동/})).toBeNull();
  fireEvent.click(within(bar).getByRole('button',{name:'페이지 추가하기'}));
  expect(run.getState().boards.management.pages).toHaveLength(2);expect(run.getState().boards.management.currentPage).toBe(1);
  expect(within(bar).getByRole('button',{name:'2페이지로 이동'})).toHaveAttribute('aria-current','page');
  expect(within(bar).getByRole('button',{name:'다음 페이지, 마지막 페이지예요'})).toHaveAttribute('aria-disabled','true');
  fireEvent.click(within(bar).getByRole('button',{name:'1페이지로 이동'}));expect(run.getState().boards.management.currentPage).toBe(0);
  // The new empty page shows only the dotted grid: no hint or starter (D-63 ⑤).
  fireEvent.click(within(bar).getByRole('button',{name:'다음 페이지'}));expect(screen.queryByRole('button',{name:/3개로 시작하기/})).toBeNull();
  expect(await screen.findByText('2/2 페이지')).toBeInTheDocument();
 });
 it('refuses a sixth page with the page-limit notice',async()=>{
  const {run}=mount({panels:[ledger],pages:5});await act(async()=>{});
  const add=screen.getByRole('button',{name:'페이지 추가하기'});expect(add).toHaveAttribute('aria-disabled','true');fireEvent.click(add);
  expect(run.getState().boards.management.pages).toHaveLength(5);expect(await screen.findByText('페이지는 최대 5장까지예요')).toBeInTheDocument();
 });
 it('turns pages with ←/→ outside editing but not from a text field or an open drawer (AC-182~184)',async()=>{
  const {run,page}=mount({panels:[ledger],pages:3});await act(async()=>{});
  key(document.body,'ArrowRight');expect(page()).toBe(1);key(document.body,'ArrowRight');expect(page()).toBe(2);key(document.body,'ArrowRight');expect(page()).toBe(2);key(document.body,'ArrowLeft');expect(page()).toBe(1);
  await userEvent.setup().click(screen.getByRole('button',{name:'기능 검색하기'}));const search=await screen.findByRole('searchbox');key(search,'ArrowLeft');expect(page()).toBe(1);
  act(()=>{run.actions.closeOverlay('button');});
  // Editing: ←/→ move the selected panel, PageUp/PageDown turn the view, Shift+PageDown sends the panel.
  act(()=>{run.actions.goToPage(0);run.actions.enterEditing();run.actions.selectPanel('ledger');});
  const panel=screen.getByRole('button',{name:/^손익, 1행 1열/});key(panel,'ArrowRight');expect(page()).toBe(0);expect(run.getState().panels[0].column).toBe(1);
  key(panel,'PageDown');expect(page()).toBe(1);key(document.body,'PageUp');expect(page()).toBe(0);
  // Turning away from the selected panel's page deselects it (store rule); select again before sending.
  act(()=>{run.actions.selectPanel('ledger');});key(screen.getByRole('button',{name:/^손익, 1행 2열/}),'PageDown',{shiftKey:true});
  expect(findPlacement(run.getState(),'ledger')).toMatchObject({pageIndex:1});expect(page()).toBe(1);expect(await screen.findByText(/손익을 2페이지로 옮겼어요/)).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button',{name:'되돌리기'}));expect(findPlacement(run.getState(),'ledger')).toMatchObject({pageIndex:0});expect(page()).toBe(0);
 });
 it('sends the selected panel from the position tool and disables the side without a neighbour (SCR-25)',async()=>{
  const {run,page}=mount({panels:[ledger],pages:2});await act(async()=>{});act(()=>run.actions.enterEditing());
  await userEvent.setup().click(screen.getByRole('button',{name:/손익 크기 바꾸기/}));
  expect(screen.getByRole('button',{name:'이전 페이지로 보내기, 첫 페이지예요'})).toHaveAttribute('aria-disabled','true');
  fireEvent.click(screen.getByRole('button',{name:'다음 페이지로 보내기'}));expect(page()).toBe(1);expect(run.getState().boards.management.pages[1].panels.map(p=>p.featureId)).toEqual(['ledger']);
 });
});

describe('layer-wide placement (AC-190·191)',()=>{
 it('a drawer tap of a widget on another page goes to that page and rings it',async()=>{
  const {run,page}=mount({panels:[ledger],pages:2});await act(async()=>{});act(()=>{run.actions.goToPage(1);});
  const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'재무'}));
  const row=await screen.findByRole('button',{name:'손익, 이미 있어요'});await user.click(row);
  expect(page()).toBe(0);expect(run.getState().boards.management.pages[1].panels).toEqual([]);
  await waitFor(()=>expect(document.querySelector('[data-feature-id="ledger"]')).toHaveAttribute('data-highlighted','true'));
  expect(await screen.findByText('1페이지에 이미 있어요')).toBeInTheDocument();
 });
 it('a drawer tap adds to the first hole of the page in view',async()=>{
  const {run}=mount({panels:[ledger],pages:2});await act(async()=>{});act(()=>{run.actions.goToPage(1);});
  const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'재무'}));await user.click(await screen.findByRole('button',{name:'마진'}));
  expect(run.getState().boards.management.pages[1].panels).toEqual([expect.objectContaining({featureId:'margin',column:0,row:0})]);
 });
});

describe('edge drag across pages (item ①: the gesture survives the panel leaving with its page)',()=>{
 it('flips after the dwell while the source panel node is removed, and drops on the new page',async()=>{
  const {run,grid,page}=mount({panels:[ledger],pages:2});await act(async()=>{});act(()=>run.actions.enterEditing());
  const button=screen.getByRole('button',{name:/^손익, 1행 1열/}),r=button.getBoundingClientRect();
  pointer(button,'pointerdown',r.x+40,r.y+40);pointer(document,'pointermove',r.x+80,r.y+60);await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});
  expect(run.getState().gesturePreview?.source).toBe('panel');
  pointer(document,'pointermove',grid.x+grid.width-16,grid.y+300);
  expect(document.querySelector('.ui-edge-zone[data-side="right"]')).toHaveAttribute('data-visible','true');expect(document.querySelector('.ui-edge-zone[data-side="left"]')).toHaveAttribute('data-visible','false');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,timePolicy.coachGapMs+400));});
  expect(page()).toBe(1);expect(run.getState().gesturePreview).toMatchObject({sourcePage:0,targetPage:1});
  await waitFor(()=>expect(document.querySelector('.dashboard-page-layer:not([data-exiting]) [data-feature-id="ledger"]')).toBeNull());
  const drop={x:grid.x+grid.width/2,y:grid.y+grid.height/2};pointer(document,'pointermove',drop.x,drop.y);await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});pointer(document,'pointerup',drop.x,drop.y);
  expect(run.getState().gesturePreview).toBeNull();expect(findPlacement(run.getState(),'ledger')).toMatchObject({pageIndex:1});expect(run.getState().boards.management.pages[0].panels).toEqual([]);
  expect(await screen.findByText(/손익을 2페이지로 옮겼어요/)).toBeInTheDocument();
 });
});

describe('panels through the widget registry (API-13)',()=>{
 it('renders the module body, its key sentence in the accessible name and the (?) help without spending the first explanation',async()=>{
  const {run}=mount({panels:[ledger],modules:[stub('ledger')]});await act(async()=>{});
  expect(screen.getByTestId('body-ledger')).toBeInTheDocument();
  const panel=screen.getByRole('button',{name:'손익, 1행 1열, 가로 1칸 세로 1칸, summary ledger, 자세히 보기'});expect(panel).toHaveAttribute('id','panel:ledger');
  const before=run.getState().guidance.widgetCoach.ledger;
  fireEvent.click(screen.getByRole('button',{name:'손익 설명 보기'}));expect(run.getState().widgetHelp).toMatchObject({featureId:'ledger',origin:'panel',returnFocusKey:'panel:ledger'});
  expect(await screen.findByRole('note',{name:'손익'})).toHaveTextContent(/오늘 매출과 지출, 순이익/);
  fireEvent.click(screen.getByRole('button',{name:'확인'}));expect(run.getState().widgetHelp).toBeNull();expect(run.getState().guidance.widgetCoach.ledger).toBe(before);
 });
 it('falls back to the legacy content when no module is registered',async()=>{
  mount({panels:[ledger]});await act(async()=>{});expect(screen.getByRole('button',{name:'손익, 1행 1열, 가로 1칸 세로 1칸, 손익, 자세히 보기'})).toBeInTheDocument();expect(screen.queryByTestId('body-ledger')).toBeNull();
 });
 it('does not offer a detail hit target for a panel with no detail, while retaining editing controls',async()=>{
  const today=stub('marketing-today',{Detail:null,useTapTarget:()=>null});
  const {run}=mount({layer:'marketing',panels:[{featureId:'marketing-today',column:0,row:0,width:2,height:1}],modules:[today]});await act(async()=>{});
  expect(screen.queryByRole('button',{name:/^오늘 할 홍보, 1행 1열/})).toBeNull();
  act(()=>run.actions.enterEditing());
  expect(screen.getByRole('button',{name:/^오늘 할 홍보, 1행 1열/})).toBeInTheDocument();
 });
 it('opens the module tap target with openDetailRef and the own detail with openDetail',async()=>{
  const today=stub('marketing-today',{Detail:null,useTapTarget:()=>({featureId:'slot-coupon',focus:'action'})});
  const {run}=mount({layer:'marketing',panels:[{featureId:'marketing-today',column:0,row:0,width:4,height:1},{featureId:'coupon-status',column:0,row:1,width:2,height:1}],modules:[today,stub('coupon-status')]});await act(async()=>{});
  const open=vi.spyOn(run.actions,'openDetailRef'),own=vi.spyOn(run.actions,'openDetail');
  fireEvent.click(screen.getByRole('button',{name:/^오늘 할 홍보, 1행 1열/}),{detail:0});expect(open).toHaveBeenCalledWith({featureId:'slot-coupon',focus:'action'},'panel:marketing-today');
  act(()=>{run.actions.closeOverlay('button');run.actions.finishOverlayExit(run.getState().exitPendingToken!);});
  fireEvent.click(screen.getByRole('button',{name:/^진행 중인 쿠폰, 2행 1열/}),{detail:0});expect(own).toHaveBeenCalledWith('coupon-status','panel:coupon-status');
 });
});

describe('PanelAction panels (plan-2 ③, API-13 v4.1)',()=>{
 it('opens the own detail with focus:action through the host and never the panel tap or a drag',async()=>{
  const withAction=stub('slot-coupon',{Panel:({host})=><PanelAction label="쿠폰 보내기" widgetName="빈 시간 단골 쿠폰" onPress={()=>host.openDetail({featureId:'slot-coupon',focus:'action'})}/>});
  const {run}=mount({layer:'marketing',panels:[{featureId:'slot-coupon',column:0,row:0,width:2,height:1}],modules:[withAction]});await act(async()=>{});
  const ref=vi.spyOn(run.actions,'openDetailRef'),own=vi.spyOn(run.actions,'openDetail'),begin=vi.spyOn(run.actions,'beginPreview');
  const action=screen.getByRole('button',{name:'쿠폰 보내기, 빈 시간 단골 쿠폰'}),r=action.getBoundingClientRect();
  pointer(action,'pointerdown',r.x+10,r.y+10);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,600));});pointer(action,'pointerup',r.x+10,r.y+10);fireEvent.click(action);
  expect(ref).toHaveBeenCalledWith({featureId:'slot-coupon',focus:'action'},'panel:slot-coupon');expect(own).not.toHaveBeenCalled();expect(begin).not.toHaveBeenCalled();
  act(()=>{run.actions.closeOverlay('button');run.actions.finishOverlayExit(run.getState().exitPendingToken!);run.actions.enterEditing();});
  // Editing hides the action but keeps its slot (DS 11.9.1).
  expect(document.querySelector('.ui-panel-action-slot')).toHaveAttribute('data-hidden','true');
 });
});

describe('coaching (AC-197·200, SCR-27·41)',()=>{
 it('shows F-03 first, then one widget explanation at a time with a progress footer and skip-all',async()=>{
  let now=0;const {run}=mount({clock:()=>now});await act(async()=>{});
  act(()=>{run.actions.startWithThree();run.actions.visualSettled();now+=timePolicy.coachFirstMs;run.actions.tick();});
  // F-03 #1 (choose) is still first in the queue, then resize and move, then the three explanations.
  await act(async()=>{});
  expect(run.getState().guidance.active).toBe('choose-feature');// The rail anchor has no jsdom geometry, so the choose tip is laid out hidden here.
  const choose=document.querySelector<HTMLElement>('.ui-popover--coach[aria-label="안내"]');expect(choose).toHaveTextContent('필요한 기능을 여기서 눌러 추가해요');
  expect(screen.getByText('1/6')).toBeInTheDocument();
  fireEvent.click(choose!.querySelector<HTMLElement>('button[aria-label="안내 닫기"]')!);act(()=>{now+=timePolicy.coachGapMs;run.actions.tick();});
  expect(run.getState().guidance.active).toBe('move-panel');expect(await screen.findByText('2/6')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'안내 닫기'}));act(()=>{run.actions.enterEditing();now+=timePolicy.coachGapMs;run.actions.tick();});
  fireEvent.click(screen.getByRole('button',{name:'안내 닫기'}));act(()=>run.actions.finishEditing());act(()=>{now+=timePolicy.coachGapMs;run.actions.tick();});
  expect(run.getState().guidance.activeWidget).toBe('ledger');const note=await screen.findByRole('note',{name:'손익'});expect(note).toHaveTextContent(/오늘 매출과 지출, 순이익/);expect(screen.getByText('4/6')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'남은 안내 모두 건너뛰기'}));
  expect(run.getState().guidance).toMatchObject({activeWidget:null,widgetQueue:[]});expect(run.getState().guidance.widgetCoach).toMatchObject({ledger:'dismissed',margin:'dismissed',calendar:'dismissed'});
  act(()=>{now+=5000;run.actions.tick();});expect(screen.queryByRole('note')).toBeNull();
 });
});

describe('coach tips share one look and walk with 다음 (U-A2)',()=>{
 const startTour=async()=>{
  let now=0;const {run}=mount({clock:()=>now});await act(async()=>{});
  act(()=>{run.actions.startWithThree();run.actions.visualSettled();now+=timePolicy.coachFirstMs;run.actions.tick();});await act(async()=>{});
  const advance=()=>{act(()=>{now+=timePolicy.coachGapMs;run.actions.tick();});};
  return {run,advance};
 };
 it('walks the whole reachable tour with 다음 and ends on 확인 with no skip link, without doing any action',async()=>{
  const {run,advance}=await startTour();
  const tip=()=>document.querySelector<HTMLElement>('.ui-popover--coach')!;
  expect(run.getState().guidance.active).toBe('choose-feature');expect(within(tip()).getByText('1/6')).toBeInTheDocument();
  // Every multi-step tip: counter, skip-all link and the primary 다음; one close X with the same name.
  expect(within(tip()).getByRole('button',{name:'남은 안내 모두 건너뛰기'})).toBeInTheDocument();expect(within(tip()).getAllByRole('button',{name:'안내 닫기'})).toHaveLength(1);
  fireEvent.click(within(tip()).getByRole('button',{name:'다음'}));advance();
  expect(run.getState().guidance.active).toBe('move-panel');expect(within(tip()).getByText('2/6')).toBeInTheDocument();
  expect(tip()).toHaveTextContent("길게 누르거나 위의 '배치 편집'을 눌러 옮길 수 있어요");
  fireEvent.click(within(tip()).getByRole('button',{name:'다음'}));advance();
  // The resize tip needs edit mode, so the walk goes on with the widget explanations.
  for(const [id,count] of [['ledger','3/6'],['margin','4/6']] as const){
   expect(run.getState().guidance.activeWidget).toBe(id);expect(within(tip()).getByText(count)).toBeInTheDocument();
   fireEvent.click(within(tip()).getByRole('button',{name:'다음'}));advance();
  }
  expect(run.getState().guidance.activeWidget).toBe('calendar');expect(within(tip()).getByText('5/6')).toBeInTheDocument();
  expect(within(tip()).queryByRole('button',{name:'다음'})).toBeNull();expect(within(tip()).queryByRole('button',{name:'남은 안내 모두 건너뛰기'})).toBeNull();
  fireEvent.click(within(tip()).getByRole('button',{name:'확인'}));advance();
  expect(run.getState().guidance).toMatchObject({active:null,activeWidget:null,widgetQueue:[]});expect(screen.queryByRole('note')).toBeNull();
 });
 it('gives step tips and widget tips the same card, type and footer', async()=>{
  const {run,advance}=await startTour();
  const read=()=>{const el=document.querySelector<HTMLElement>('.ui-popover--coach')!;return {card:el.className,text:el.querySelector('.ui-coach-text')?.tagName,close:el.querySelectorAll('button[aria-label="안내 닫기"]').length,footer:el.querySelectorAll('.ui-coach-footer').length,primary:el.querySelectorAll('.ui-coach-footer .ui-button--default').length};};
  const step=read();fireEvent.click(screen.getByRole('button',{name:'다음'}));advance();fireEvent.click(screen.getByRole('button',{name:'다음'}));advance();
  expect(run.getState().guidance.activeWidget).toBe('ledger');
  expect(read()).toEqual(step);
 });
});

describe('marketing layer (SCR-26·41·42, AC-175·308~312·319)',()=>{
 it('has five groups and a recommended drawer with today’s promotions first',async()=>{
  mount({layer:'marketing'});await act(async()=>{});
  const rail=screen.getByRole('navigation',{name:'기능 열'});expect(within(rail).getAllByRole('button').map(b=>b.textContent)).toEqual(['검색','추천','소식','돈','손님','동네']);
  const user=userEvent.setup();await user.click(within(rail).getByRole('button',{name:'기능 검색하기'}));expect(await screen.findByRole('dialog',{name:'기능 찾기'})).toHaveTextContent('12개 기능');
  await user.click(within(rail).getByRole('button',{name:'추천'}));const drawer=await screen.findByRole('dialog',{name:'추천'});
  expect(within(drawer).getAllByRole('button').filter(b=>b.classList.contains('ui-function-row')).map(b=>b.getAttribute('aria-label'))).toEqual(['오늘 할 홍보','메시지·리뷰 응대','빈 시간 단골 쿠폰','AI 홍보 영상']);
 });
 it('starts with the recommended layout, one Undo, and seven explanations in placement order',async()=>{
  let now=0;const {run}=mount({layer:'marketing',clock:()=>now});await act(async()=>{});
  expect(screen.queryByRole('button',{name:/3개로 시작하기/})).toBeNull();expect(screen.getByText('패널 7개를 한 번에 추가해 드려요')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'추천 배치로 시작하기'}));
  expect(run.getState().panels).toHaveLength(7);expect(await screen.findByText('패널 7개로 시작했어요')).toBeInTheDocument();expect(screen.getByText('패널 7개를 추가했어요')).toBeInTheDocument();
  expect(run.getState().guidance.widgetQueue).toEqual(['marketing-today','ai-response','expiry-coupon','promo-video','slot-coupon','coupon-status','customer-groups']);
  fireEvent.click(await screen.findByRole('button',{name:'되돌리기'}));expect(run.getState().panels).toHaveLength(0);expect(screen.getByRole('button',{name:'추천 배치로 시작하기'})).toBeVisible();
 });
});

describe('language and example state (F-22, SCR-29)',()=>{
 it('keeps the store name in Korean and translates surrounding dashboard controls',async()=>{
  mount({panels:[ledger],locale:'en'});await act(async()=>{});
  expect(screen.getByRole('heading',{level:1,name:'안숭잘부 카페'})).toHaveAttribute('lang','ko');expect(screen.getByRole('button',{name:'Settings'})).toBeInTheDocument();
  expect(screen.getByRole('navigation',{name:'Features'})).toBeInTheDocument();expect(screen.getByRole('button',{name:/^손익, row 1 column 1, 1 wide 1 tall/})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Open Navis'})).toBeInTheDocument();expect(document.body.textContent).not.toMatch(/dashboard\.|ui\.|navis\./);
 });
 it.each([
  ['ko','Navis 열기','Navis 닫기'],
  ['en','Open Navis','Close Navis'],
  ['zh-Hans','打开 Navis','关闭 Navis'],
  ['zh-Hant','開啟 Navis','關閉 Navis'],
 ] as const)('names the launcher in %s and the fixed chat controls in Korean (D-329 OQ-6)',async(locale,open,close)=>{
  mount({locale});await act(async()=>{});
  fireEvent.click(screen.getByRole('button',{name:open}));
  expect(screen.getByRole('button',{name:close})).toHaveAttribute('aria-expanded','true');
  expect(screen.getByRole('textbox',{name:'질문하거나 요청해 주세요'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'요청 보내기'})).toBeInTheDocument();
 });
 it('shows the example-state chip in the header when the family is not normal',async()=>{
  const {run}=mount({panels:[ledger]});await act(async()=>{});expect(screen.queryByRole('button',{name:/예시 상태/})).toBeNull();
  act(()=>run.actions.setPreviewFamily('empty'));expect(screen.getByRole('button',{name:/예시 상태: 비어 있음/})).toBeInTheDocument();
 });
 it('keeps every dashboard key in four languages',()=>{
  for(const locale of ['en','zh-Hans','zh-Hant'] as const)expect(Object.keys(dashboardBundle[locale]).sort()).toEqual(Object.keys(dashboardBundle.ko).sort());
  expect(Object.values(dashboardBundle.ko).every(Boolean)).toBe(true);expect(dashboardReviewStringCount).toBeGreaterThan(0);
 });
});

describe('edit mode after a layer round trip (owner report: layout edit broke after Navis opened another screen)',()=>{
 /** The cross-fade keeps the exiting layer's board mounted next to the arriving one; its late unmount must not clear the arriving grid. */
 it('keeps dragging a panel after switching to marketing and back through the screen transition',async()=>{
  const {run,grid}=mount({panels:[ledger],crossfade:true});await act(async()=>{});
  for(const layer of ['marketing','management'] as const){act(()=>{run.actions.switchLayer(layer);});await waitFor(()=>expect(document.querySelectorAll('.dashboard-screen')).toHaveLength(1));}
  expect(run.getState().activeBoard).toBe('management');
  act(()=>run.actions.enterEditing());
  const button=await screen.findByRole('button',{name:/^손익, 1행 1열/}),r=button.getBoundingClientRect();
  pointer(button,'pointerdown',r.x+40,r.y+40);pointer(document,'pointermove',r.x+80,r.y+60);await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});
  expect(run.getState().gesturePreview?.source).toBe('panel');
  const drop={x:grid.x+grid.width/2,y:grid.y+grid.height/2};pointer(document,'pointermove',drop.x,drop.y);await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});pointer(document,'pointerup',drop.x,drop.y);
  expect(run.getState().gesturePreview).toBeNull();
  const moved=run.getState().panels.find(p=>p.featureId==='ledger');expect(moved).toBeDefined();expect(moved!.column>0||moved!.row>0).toBe(true);
 });
 it('still resizes a panel by its handle after the round trip',async()=>{
  const {run,grid}=mount({panels:[ledger],crossfade:true});await act(async()=>{});
  for(const layer of ['marketing','management'] as const){act(()=>{run.actions.switchLayer(layer);});await waitFor(()=>expect(document.querySelectorAll('.dashboard-screen')).toHaveLength(1));}
  act(()=>run.actions.enterEditing());
  const handle=await screen.findByRole('button',{name:/손익 크기 바꾸기/}),h=handle.getBoundingClientRect();
  pointer(handle,'pointerdown',h.x+8,h.y+8);pointer(document,'pointermove',h.x+60,h.y+8);pointer(document,'pointermove',h.x+grid.width/3,h.y+8);await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});
  expect(run.getState().gesturePreview?.source).toBe('resize');pointer(document,'pointerup',h.x+grid.width/3,h.y+8);
  expect(run.getState().panels.find(p=>p.featureId==='ledger')!.width).toBeGreaterThan(1);
 });
});

describe('drag render cost (owner: widget edit drag felt heavy)',()=>{
 it('does not re-render any widget body while a panel is dragged (pointer moves within the layout)',async()=>{
  const renders:Record<string,number>={};
  const counting=(id:FeatureId):WidgetModule=>({id,Panel:()=>{renders[id]=(renders[id]??0)+1;return <p>body {id}</p>;},Detail:()=><p>detail {id}</p>,useSummary:()=>`summary ${id}`});
  const margin:Panel={featureId:'margin',column:5,row:3,width:1,height:1};
  const {run,grid}=mount({panels:[ledger,margin],modules:[counting('ledger'),counting('margin')]});await act(async()=>{});act(()=>run.actions.enterEditing());
  const button=screen.getByRole('button',{name:/^손익, 1행 1열/}),r=button.getBoundingClientRect();
  pointer(button,'pointerdown',r.x+40,r.y+40);pointer(document,'pointermove',r.x+80,r.y+60);await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});
  expect(run.getState().gesturePreview?.source).toBe('panel');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
  const before={...renders};
  // Thirty pointer moves inside the grid, none of them reaching the other panel's cell.
  for(let i=1;i<=30;i++){pointer(document,'pointermove',r.x+80+i*6,r.y+60+i*3);await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});}
  expect(renders).toEqual(before);
  pointer(document,'pointerup',r.x+260,r.y+150);
  expect(run.getState().gesturePreview).toBeNull();void grid;
 });
});

describe('Navis on the marketing layer (SCR-34, AC-179)',()=>{
 it('shows a management widget as a read-only card in marketing and sends locale and layer',async()=>{
  const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({answer:'확인했어요',panels:[{featureId:'ledger',size:{width:1,height:1},reason:'매출'}]})});vi.stubGlobal('fetch',fetcher);
  mount({layer:'marketing'});await act(async()=>{});
  fireEvent.click(screen.getByRole('button',{name:'Navis 열기'}));fireEvent.change(screen.getByRole('textbox'),{target:{value:'매출 알려줘'}});fireEvent.click(screen.getByRole('button',{name:'요청 보내기'}));
  const card=await screen.findByRole('group',{name:/손익.*관리에 있어요/});expect(within(card).queryByRole('button')).toBeNull();expect(card.closest('[data-candidate-id]')).toBeNull();
  const body=JSON.parse(fetcher.mock.calls[0][1].body);expect(body).toMatchObject({locale:'ko',layer:'marketing'});
  vi.unstubAllGlobals();
 });
});
