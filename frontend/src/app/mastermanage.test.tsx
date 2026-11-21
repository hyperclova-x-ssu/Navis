import '../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useState, useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangedValueSlot, WidgetModule } from '../contracts';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { createRunStore, selectDetailViewState, selectCommonNotice, type PresentationRunStore } from '../state';
import { createWidgetDataStore, selectClosing, TODAY } from '../data/widget-data';
import manifest from '../data/db/generated/manifest.json';
import { seedToday } from '../data/db/generated/today';
import { WidgetDataProvider } from '../data/react';
import { WidgetRegistryProvider } from '../features/widgets/registry-context';
import { I18nProvider } from '../i18n';
import { ActionButton, DataGrid, timePolicy, UiProvider, type GridFocus } from '../ui';
import { PosProvider } from '../pos/react';
import { ClosingOverlay } from './ClosingOverlay';
import { CommonNotice } from './CommonNotice';
import { createSessionActions, createSessionGate } from './session-actions';
import { visualElementStore } from 'motion-dom';
import { DashboardScreen } from '../screens/dashboard';
import { TemplateTour } from './template-tour';
import { changedVisibleSlots } from './value-highlights';
import { DetailOverlay } from '../screens/detail';

afterEach(()=>{cleanup();vi.useRealTimers();});
function setup(template:null|'A'=null,reduced=true){
 let now=0;
 const gate=createSessionGate(),run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>now,theme:'light',reducedMotion:reduced,sessionGate:gate});
 const store=createWidgetDataStore(undefined,{runId:run.getState().runId,sessionGate:gate});
 run.actions.setOnboardingAnswer({businessType:'cafe'});run.actions.setOnboardingAnswer({paymentStyle:'prepaid'});
 const actions=createSessionActions(run,store,gate);
 expect(actions.completeOnboarding(template).ok).toBe(true);
 const tick=(ms:number)=>act(()=>{now+=ms;run.actions.tick();});
 function Host({children}:{children?:React.ReactNode}){const s=useSyncExternalStore(run.subscribe,run.getState);return <I18nProvider locale={s.locale}><WidgetDataProvider store={store} preview={s.preview}><UiProvider screenPreset={s.screenPreset} reducedMotion={s.reducedMotion} textScale={s.textScale} theme={s.theme} transform={{scale:1,offsetX:0,offsetY:0,width:1920,height:1080,originX:0,originY:0}}>{children}<PosProvider value={actions.pos}><ClosingOverlay run={run} onOpenReceipt={()=>{}}/></PosProvider><CommonNotice run={run}/></UiProvider></WidgetDataProvider></I18nProvider>;}
 return {run,store,tick,Host};
}
describe('common closing surface',()=>{
 it('keeps the toast and its undo in the empty notice slot through a locale switch',async()=>{
  const errors=vi.spyOn(console,'error');
  try{
   const {run,store,Host}=setup();run.actions.openClosing('opener');render(<Host/>);
   fireEvent.click(await screen.findByRole('button',{name:'마감 정산하기'}));
   const undo=await screen.findByRole('button',{name:'되돌리기'}),notice=selectCommonNotice(run.getState());
   expect(undo.closest('.ui-overlay-notice-slot')).not.toBeNull();
   await waitFor(()=>expect(screen.getByText('오늘 마감했어요')).toBeVisible());
   const footer=document.querySelector('.ui-overlay-note')!;
   expect(footer).not.toHaveTextContent('가짜 데이터로 만든 화면이에요'); // D-323: no demo notice
   act(()=>run.actions.setLocale('en'));
   expect(selectCommonNotice(run.getState())).toBe(notice);
   expect(screen.getByRole('button',{name:'Undo'})).toBe(undo);
   expect(undo.closest('.ui-overlay-notice-slot')).not.toBeNull();
   expect(footer).not.toHaveTextContent('This screen uses sample data');
   fireEvent.click(undo);
   expect(selectClosing(store.getSnapshot(),{date:TODAY,scenario:'normal'}).status).toBe('reopened');
   expect(errors).not.toHaveBeenCalled();
  }finally{errors.mockRestore();}
 });
 it.each([100,125] as const)('keeps all cafe payment rows and one grid Tab entry at %s%%, with keyboard filtering and unchanged totals',async scale=>{
  const {run,Host}=setup();run.actions.setTextScale(scale);run.actions.openClosing('opener');render(<Host/>);
  const dialog=await screen.findByRole('dialog',{name:'오늘 마감 정산'}),grid=within(dialog).getByRole('grid');
  expect(within(grid).getAllByRole('row')).toHaveLength(manifest.counts.payments + 1);
  expect(within(grid).getAllByRole('gridcell',{name:/금액, .*원/}).length).toBeGreaterThan(0);
  expect(within(grid).getAllByRole('gridcell',{name:/결제 수단, 카드/}).length).toBeGreaterThan(0);
  expect(within(grid).getAllByRole('gridcell',{name:/상태, 결제/}).length).toBeGreaterThan(0);
  expect(within(dialog).getByRole('heading',{name:'오늘 마감 정산'})).toHaveFocus();
  expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  const radios=within(dialog).getAllByRole('radio');radios[0].focus();fireEvent.keyDown(radios[0],{key:'ArrowRight'});
  expect(radios[1]).toHaveFocus();expect(radios[1]).toHaveAttribute('aria-checked','true');
  expect(within(grid).getAllByRole('row')).toHaveLength(seedToday.pos.payments.filter(payment => payment.splits.some(split => split.method === 'card')).length + 1);
  expect(within(dialog).getAllByText('83.1만 원').length).toBeGreaterThan(0);
  expect(document.querySelector('[data-text-scale]')).toHaveAttribute('data-text-scale',String(scale));
 });
 it('closes once, keeps a late undo through another data edit and preserves that general undo',async()=>{
  const {run,store,Host,tick}=setup();run.actions.openClosing('opener');render(<Host/>);
  const button=await screen.findByRole('button',{name:'마감 정산하기'});
  fireEvent.click(button);fireEvent.click(button);
  expect(store.getSnapshot().tables.dayClosing).toHaveLength(manifest.counts.closings + 1);
  expect(selectClosing(store.getSnapshot(),{date:TODAY,scenario:'normal'})).toMatchObject({status:'closed',generation:1});
  expect(screen.getByText('오늘 마감됨 · 15:45')).toBeInTheDocument();
  const token=selectCommonNotice(run.getState())!.undo!.token;
  const edited=store.dispatch({type:'calendar.addEvent',title:'마감 뒤 메모',date:TODAY});expect(edited.ok).toBe(true);
  tick(6100);expect(selectCommonNotice(run.getState())).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'마감 되돌리기'}));
  expect(selectClosing(store.getSnapshot(),{date:TODAY,scenario:'normal'}).status).toBe('reopened');
  expect(selectCommonNotice(run.getState())?.messageKey).toBe('data.management.notice.reopened');
  expect(store.undo(token).ok).toBe(true);
  expect(edited.ok&&edited.undoToken&&store.undo(edited.undoToken).ok).toBe(true);
 });
 it('keeps empty closing separate and retries only the failed closing preview',async()=>{
  const {run,store,Host}=setup();run.actions.setPreviewFamily('empty');run.actions.openClosing('opener');render(<Host/>);
  expect(await screen.findByText('오늘 결제 내역이 없어요')).toBeInTheDocument();expect(screen.queryByText('0원')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'마감 정산하기'}));
  expect(selectClosing(store.getSnapshot(),{date:TODAY,scenario:'empty'}).status).toBe('closed');
  expect(selectClosing(store.getSnapshot(),{date:TODAY,scenario:'normal'}).status).toBe('open');
  act(()=>run.actions.setClosingPreview('error'));expect(screen.getByRole('button',{name:'마감 정산하기'})).toBeDisabled();
  expect(screen.getAllByText('결제 내역을 불러오지 못했어요')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'다시 시도하기'}));
  expect(run.getState().preview.family).toBe('empty');expect(run.getState().preview.closing).toBe('normal');
  expect(screen.getByRole('grid')).toBeInTheDocument();
 });
 it('pauses the common notice on focus and hidden page and keeps a different board layout undo',async()=>{
  const {run,Host,tick}=setup();run.actions.applyLayoutIntent({type:'add-tap',featureId:'menu'});const boardUndo=run.getState().undo;
  run.actions.openClosing('opener');render(<Host/>);fireEvent.click(await screen.findByRole('button',{name:'마감 정산하기'}));
  const undo=await screen.findByRole('button',{name:'되돌리기'});fireEvent.focus(undo);tick(9000);
  expect(selectCommonNotice(run.getState())).not.toBeNull();
  fireEvent.blur(undo);act(()=>run.actions.setPageHidden(true));tick(9000);expect(selectCommonNotice(run.getState())).not.toBeNull();
  act(()=>run.actions.setPageHidden(false));expect(run.getState().boards.management.undo?.token).toBe(boardUndo?.token);
 });
});
describe('template timing and tour input',()=>{
 it.each([[false,300],[true,80]] as const)('assembles with reduced=%s in %s ms then waits 400 ms, rejects stale completion and consumes Escape',async(reduced,duration)=>{
  vi.useFakeTimers();const {run,Host,tick}=setup('A',reduced);
  render(<Host><WidgetRegistryProvider modules={[]}><DashboardScreen run={run} manageTimers={false}/></WidgetRegistryProvider><TemplateTour run={run}/></Host>);
  act(()=>vi.advanceTimersByTime(duration-1));expect(run.getState().onboarding.step).toBe('applying');
  act(()=>vi.advanceTimersByTime(1));expect(run.getState().onboarding.step).toBe('applying');
  const last=document.querySelectorAll<HTMLElement>('.ui-fly-layer');
  act(()=>visualElementStore.get(last[last.length-1])!.getProps().onAnimationComplete?.({opacity:1}));
  expect(run.getState().onboarding.step).toBe('done');
  expect(selectCommonNotice(run.getState())?.messageKey).toBe('run.template.A.completed');
  tick(399);expect(run.getState().templateTour?.status).toBe('waiting');tick(1);expect(run.getState().templateTour?.status).toBe('active');
  const before=run.getState();expect(run.actions.switchLayer('marketing')).toBe(false);expect(run.getState()).toBe(before);
  fireEvent.keyDown(document,{key:'Enter',code:'Enter'});expect(run.getState().templateTour?.index).toBe(1);
  fireEvent.keyDown(document,{key:'Escape',code:'Escape'});expect(run.getState().templateTour?.status).toBe('completed');
  expect(run.getState().closingInput).toEqual({kind:'keyboard',id:'Escape'});
  expect((run as PresentationRunStore).actions.templateAssembled({runId:'stale',applyToken:'stale'})).toBe(false);
  for(const id of before.templateTour!.targets)expect(run.getState().guidance.widgetCoach[id]).toBe('dismissed');
 });
});
it('selects six visible changed values in editor/detail/dashboard priority and excludes first mounts',()=>{
 const slots:ChangedValueSlot[]=Array.from({length:9},(_,i)=>({slotId:String(i),featureId:'ledger',scope:i===8?'editor':i<4?'dashboard':'detail',semanticValue:0,visible:i!==7}));
 expect(changedVisibleSlots(slots,[...slots.map(s=>({...s,semanticValue:1})),{...slots[0],slotId:'new'}])).toEqual(['8','4','5','6','0','1']);
});
it('restores a detail controller, selected row, query, scroll and focused input through closing replacement',async()=>{
 const {run,Host}=setup();let mounts=0;
 const module:WidgetModule={id:'menu',Panel:()=>null,useSummary:()=>'',Detail:({host})=>{const [query,setQuery]=useState(()=>{mounts++;return '';});const [selected,setSelected]=useState(false);return <div data-grid-scroll><input id="menu-query" aria-label="메뉴 검색" value={query} onChange={e=>setQuery(e.target.value)}/><ActionButton onClick={()=>setSelected(true)}>메뉴 행 고르기</ActionButton>{selected?<p>고른 메뉴</p>:null}<ActionButton onClick={()=>host.openClosing('menu-query')}>정산 열기</ActionButton></div>;}};
 run.actions.applyLayoutIntent({type:'add-tap',featureId:'menu'});run.actions.openDetail('menu','opener');render(<Host><WidgetRegistryProvider modules={[module]}><DetailOverlay run={run}/></WidgetRegistryProvider></Host>);
 const input=await screen.findByRole('textbox',{name:'메뉴 검색'});fireEvent.change(input,{target:{value:'라테'}});fireEvent.click(screen.getByRole('button',{name:'메뉴 행 고르기'}));const scroller=input.closest<HTMLElement>('[data-grid-scroll]')!;scroller.scrollTop=125;fireEvent.scroll(scroller);act(()=>input.focus());expect(selectDetailViewState(run.getState())?.focusKey).toBe('menu-query');
 fireEvent.click(screen.getByRole('button',{name:'정산 열기'}));expect(await screen.findByRole('dialog',{name:'오늘 마감 정산'})).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'돌아가기'}));
 expect(await screen.findByRole('textbox',{name:'메뉴 검색'})).toHaveValue('라테');expect(mounts).toBe(1);expect(selectDetailViewState(run.getState())?.focusKey).toBe('menu-query');expect(screen.getByText('고른 메뉴')).toBeInTheDocument();expect(scroller.scrollTop).toBe(125);await waitFor(()=>expect(input).toHaveFocus());
});

it('blocks source navigation after an invalid grid commit, then Escape cancels one layer before opening closing',async()=>{
 const {run,Host}=setup();
 const module:WidgetModule={id:'menu',Panel:()=>null,useSummary:()=>'',Detail:({host})=>{
  const [focus,setFocus]=useState<GridFocus>(null);
  return <><DataGrid id="navigation-grid" label="메뉴 표" rows={[{id:'menu-row',price:1}]} getRowId={r=>r.id} getRowLabel={()=>'메뉴'} columns={[{id:'price',header:'단가',kind:'number',value:r=>r.price,minWidth:100,editable:()=>true}]} sort={null} onSortChange={()=>undefined} selectedRowId={null} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} onCommit={()=>({ok:false,error:{id:'invalid-price',message:'0 이상의 숫자를 넣어 주세요'}})} emptyContent={null}/><ActionButton onClick={()=>host.openClosing('navigation-grid')}>정산 열기</ActionButton></>;
 }};
 run.actions.applyLayoutIntent({type:'add-tap',featureId:'menu'});run.actions.openDetail('menu','opener');
 render(<Host><WidgetRegistryProvider modules={[module]}><DetailOverlay run={run}/></WidgetRegistryProvider></Host>);
 const cell=await screen.findByRole('gridcell',{name:/메뉴, 단가/});fireEvent.keyDown(cell,{key:'Enter'});
 const editor=screen.getByRole('textbox');fireEvent.change(editor,{target:{value:'-1'}});fireEvent.keyDown(editor,{key:'Enter'});
 expect(editor).toHaveAttribute('aria-invalid','true');fireEvent.click(screen.getByRole('button',{name:'정산 열기'}));
 expect(run.getState().overlay.type).toBe('detail');expect(editor).toHaveFocus();
 fireEvent.keyDown(editor,{key:'Escape',code:'Escape'});expect(run.getState().overlay.type).toBe('detail');expect(screen.queryByRole('textbox')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'정산 열기'}));expect(await screen.findByRole('dialog',{name:'오늘 마감 정산'})).toBeInTheDocument();
});
