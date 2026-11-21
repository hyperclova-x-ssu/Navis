import {selectCommonNotice} from '../../state';
import {CommonNotice} from '../../app/CommonNotice';
import {beginDashboard} from '../../app/test-session';
import navisAsset from '../../assets/brand/navis-symbol.svg';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, expect, it} from 'vitest';
import type {WidgetDetailProps, WidgetModule, WidgetPanelProps} from '../../contracts';
import {createRunStore} from '../../state';
import {getRegistry} from '../../catalog';
import {screenPresets} from '../../layout';
import {timePolicy} from '../../ui';
import {KitProviders} from '../../ui/test-utils';
import {createWidgetDataStore, TODAY, widgetFacts} from '../../data/widget-data';
import {useDataDispatch, useWidgetView} from '../../data/react';
import {addDays} from '../../data/db/time';
import {DashboardScreen} from './DashboardScreen';
import {DetailOverlay} from '../detail';

afterEach(cleanup);
/** A stub ledger module: panel and detail both read the run's data store (API-13), never a copy. */
function SalesValue({condition}:Pick<WidgetPanelProps,'condition'>){const view=useWidgetView('ledger',condition);const fact=widgetFacts(view)[0];return <p data-testid="sales">{fact?String(fact.value):'none'}</p>;}
const ledgerStub:WidgetModule={id:'ledger',Panel:(props:WidgetPanelProps)=><SalesValue condition={props.condition}/>,Detail:(props:WidgetDetailProps)=><SalesValue condition={props.condition}/>,useSummary:()=>'stub summary'};
it('uses the same data store facts in the board panel and its detail',async()=>{
 const preset=screenPresets.A,run=createRunStore({screenPreset:preset,catalog:getRegistry('A'),time:timePolicy,clock:()=>0,theme:'light',reducedMotion:true});
 beginDashboard(run,'cafe');run.actions.dismissCoach();
 const condition={kind:'dateRange',start:addDays(TODAY, -6),end:TODAY} as const;
 run.actions.applyLayoutIntent({type:'restore',panels:[{featureId:'ledger',column:0,row:0,width:2,height:1,condition}]});
 const store=createWidgetDataStore();
 render(<KitProviders preset={preset} reducedMotion store={store} modules={[ledgerStub]}><DashboardScreen run={run}/><DetailOverlay run={run}/></KitProviders>);
 const board=await screen.findByTestId('sales');const value=board.textContent;expect(value).not.toBe('none');
 expect(screen.getByRole('button',{name:/^손익, 1행 1열, 가로 2칸 세로 1칸, stub summary, 자세히 보기$/})).toBeInTheDocument();
 act(()=>run.actions.openDetail('ledger','panel:ledger'));
 const dialog=await screen.findByRole('dialog',{name:'손익'});await waitFor(()=>expect(within(dialog).getByTestId('sales')).toHaveTextContent(value!));
 act(()=>run.dispose());
});
it('reflects a data command in the panel at once and offers the data undo on the board notice',async()=>{
 const preset=screenPresets.A,run=createRunStore({screenPreset:preset,catalog:getRegistry('A'),time:timePolicy,clock:()=>0,theme:'light',reducedMotion:true});
 beginDashboard(run,'cafe');run.actions.dismissCoach();run.actions.applyLayoutIntent({type:'restore',panels:[{featureId:'ledger',column:0,row:0,width:1,height:1}]});
 const store=createWidgetDataStore();
 const results:ReturnType<ReturnType<typeof useDataDispatch>>[]=[];
 function Probe(){
  const dispatch=useDataDispatch();
  return <button onClick={()=>results.push(dispatch({type:'calendar.addEvent',title:'납품 확인',date:TODAY}))}>테스트 일정 추가</button>;
 }
 render(<KitProviders preset={preset} reducedMotion store={store} modules={[ledgerStub]}><Probe/><DashboardScreen run={run}/><CommonNotice run={run}/></KitProviders>);
 await act(async()=>{}); // Settle the jsdom host's unavailable Worker startup (its error notice).
 fireEvent.click(screen.getByRole('button',{name:'테스트 일정 추가'}));
 const first=results[0];const undoToken=first.ok?first.undoToken:undefined;expect(undoToken).toBeTruthy();
 act(()=>run.actions.showNotice({kind:'success',messageKey:'common.saveAction',undo:{target:'data',token:undoToken!}}));
 fireEvent.click(await screen.findByRole('button',{name:'되돌리기'}));
 // The board notice routed the Undo to the data store (API-03 v4.2), not to the layout undo.
 expect(selectCommonNotice(run.getState())?.messageKey).toBe('data.notice.undone');expect(store.undo(undoToken!).ok).toBe(false);expect(run.getState().panels).toHaveLength(1);
 act(()=>run.dispose());
});

it('holds idle and briefing safety while the conversation is open and restarts on close',async()=>{
 let now=0;const preset=screenPresets.A,run=createRunStore({screenPreset:preset,catalog:getRegistry('A'),time:timePolicy,clock:()=>now,theme:'light',reducedMotion:true});beginDashboard(run,'cafe');run.actions.dismissCoach();
 render(<KitProviders preset={preset} theme="light" textScale={100} reducedMotion><DashboardScreen run={run}/></KitProviders>);
 const launcher=screen.getByRole('button',{name:'Navis 열기'});expect(launcher.querySelector('img')).toHaveAttribute('src',navisAsset);fireEvent.click(launcher);expect(screen.getByRole('button',{name:'Navis 닫기'})).toHaveAttribute('aria-expanded','true');act(()=>{now+=60000;run.actions.tick();});expect(run.getState().idle.mode).toBe('active');expect(run.getState().briefing).toBe('pending');expect(run.getState().briefingSafeSince).toBeNull();
 fireEvent.click(within(screen.getByRole('region',{name:'Navis'})).getByRole('button',{name:'닫기'}));expect(run.getState().activeInputs).toEqual([]);expect(run.getState().idle.lastInputAt).toBe(now);act(()=>run.dispose());
});
