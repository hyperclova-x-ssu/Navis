import '../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import {useSyncExternalStore} from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {getRegistry} from '../catalog';
import {screenPresets} from '../layout';
import {createRunStore} from '../state';
import {createWidgetDataStore,selectPayments,TODAY} from '../data/widget-data';
import {seedCatalog} from '../data/db/generated/catalog';
import {quoteCart} from '../pos/domain';
import {seedToday} from '../data/db/generated/today';
import {quoteReversal} from '../pos/reversals';
import {KitProviders} from '../ui/test-utils';
import {timePolicy,type DataGridProps} from '../ui';
import {createSessionActions,sessionGateFor} from './session-actions';
import {PosProvider} from '../pos/react';
import {ClosingOverlay} from './ClosingOverlay';

type Row=ReturnType<typeof selectPayments>['rows'][number];
// Observe the adapter boundary while keeping the real grid, sorting and data store.
const observed=vi.hoisted(()=>({current:null as DataGridProps<Row>|null}));
vi.mock('../ui',async importOriginal=>{
 const actual=await importOriginal<typeof import('../ui')>();
 return {...actual,DataGrid:(props:DataGridProps<Row>)=>{observed.current=props;return <actual.DataGrid {...props}/>;}};
});
afterEach(()=>{cleanup();observed.current=null;});
function mount(){
 const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>0,theme:'light',reducedMotion:true});
 run.actions.setOnboardingAnswer({businessType:'cafe'});run.actions.setOnboardingAnswer({paymentStyle:'prepaid'});
 const store=createWidgetDataStore(undefined,{runId:run.getState().runId,sessionGate:sessionGateFor(run)});
 const actions=createSessionActions(run,store);
 expect(actions.completeOnboarding(null).ok).toBe(true);
 run.actions.openClosing('opener');
 function Host(){const s=useSyncExternalStore(run.subscribe,run.getState);return <KitProviders locale={s.locale} store={store} preview={s.preview} reducedMotion><PosProvider value={actions.pos}><ClosingOverlay run={run} onOpenReceipt={()=>{}}/></PosProvider></KitProviders>;}
 render(<Host/>);return {run,store,pos:actions.pos};
}
const grid=()=>observed.current!;
const cardCount=seedToday.rollup.methodCounts.card;
describe('closing grid identity across sorts',()=>{
 it('shows each menu and quantity for a multi-item payment, including after a menu rename',()=>{
  const {store}=mount();
  const payment=seedToday.pos.payments.find(row=>row.transactionNo==='거래-20261117-0150')!;
  const cell=()=>document.querySelector(`[data-grid-row-id="${payment.paymentId}"][data-grid-column-id="content"]`)!;
  expect(cell()).toHaveTextContent('오트 말차 라떼 1, 연유 돌체라떼 1, 아메리카노 1');
  expect(cell()).toHaveAccessibleName('15:38, 내용, 오트 말차 라떼 1, 연유 돌체라떼 1, 아메리카노 1');
  act(()=>{expect(store.dispatch({type:'menu.update',menuId:'m-dolce-latte',patch:{name:'고소한 라테'}}).ok).toBe(true);});
  expect(cell()).toHaveTextContent('오트 말차 라떼 1, 고소한 라테 1, 아메리카노 1');
 });
 it('shows refund items and marks Korean content for line breaking on an English screen',()=>{
  const {run,store,pos}=mount();
  const latte=seedCatalog.menu.find(menu=>menu.menuId==='m-cafe-latte')!;
  const optionIds=latte.groups.filter(group=>group.required).map(group=>group.options[0].optionId);
  const meta=(idempotencyKey:string)=>({runId:run.getState().runId,idempotencyKey});
  act(()=>{
   expect(pos.execute({type:'cart.add',menuId:latte.menuId,optionIds,qty:2,meta:meta('latte') })).toMatchObject({ok:true});
   const cart=quoteCart(pos.read());
   expect(pos.beginApproval({cartId:cart.cartId,quoteRevision:cart.revision,splits:[{method:'card',amount:latte.price*2}],meta:meta('pay')})).toMatchObject({ok:true});
   const attempt=run.getState().posUi.approval!;
   expect(pos.finishApproval({runId:attempt.runId,attemptId:attempt.attemptId,expectedQuoteFingerprint:attempt.quoteFingerprint,outcome:'approved'})).toMatchObject({ok:true});
   pos.dismissApproval();
   const orderId=pos.read().pos.orders.at(-1)!.orderId;
   expect(pos.execute({type:'order.start',orderId,meta:meta('prepare')})).toMatchObject({ok:true});
   const paymentId=pos.read().pos.payments.at(-1)!.paymentId;
   const quote=quoteReversal(pos.read(),{paymentId,kind:'refund'});
   expect(quote.canSubmit,JSON.stringify(quote.issues)).toBe(true);
   expect(pos.execute({type:'payment.reverse',quoteToken:quote.quoteToken,confirmed:true,meta:meta('refund')})).toMatchObject({ok:true});
  });
  const refund=pos.read().pos.refunds.at(-1)!;
  const cell=()=>document.querySelector(`[data-grid-row-id="${refund.refundId}"][data-grid-column-id="content"]`)!;
  expect(cell()).toHaveTextContent('카페라떼 2');
  act(()=>{expect(store.dispatch({type:'menu.update',menuId:'m-cafe-latte',patch:{name:'고소한 라테'}}).ok).toBe(true);run.actions.setLocale('en');});
  expect(cell()).toHaveTextContent('고소한 라테 2');
  expect(cell().querySelector('[lang="ko"]')).toHaveTextContent('고소한 라테 2');
 });
 it('reuses column definitions until the translator changes',()=>{
  const {run}=mount(),columns=grid().columns;
  fireEvent.click(screen.getByRole('columnheader',{name:/금액/}).querySelector('button')!);
  expect(grid().sort).toEqual({columnId:'amount',direction:'asc'});
  expect(grid().columns).toBe(columns);
  act(()=>run.actions.setLocale('en'));
  expect(grid().columns).not.toBe(columns);
  expect(grid().columns.find(c=>c.id==='amount')!.header).toBe('금액'); // Korean-only copy still falls back.
 });
 it('sorts a copy, preserves every row object and matches selector ordering for all sortable columns',()=>{
  const {store}=mount(),initial=grid().rows,initialIds=initial.map(r=>r.paymentId),byId=new Map(initial.map(r=>[r.paymentId,r]));
  expect(initial).toHaveLength(seedToday.rollup.paymentCount);
  for(const [columnId,field] of [['amount','amount'],['method','method'],['status','status'],['time','time']] as const){
   for(const direction of ['asc','desc'] as const){
    act(()=>grid().onSortChange({columnId,direction}));
    expect(grid().rows.map(r=>r.paymentId)).toEqual(selectPayments(store.getSnapshot(),{date:TODAY,scenario:'normal',sort:{field,direction}}).rows.map(r=>r.paymentId));
    for(const row of grid().rows)expect(row).toBe(byId.get(row.paymentId));
    expect(initial.map(r=>r.paymentId)).toEqual(initialIds);
   }
  }
 });
 it('keeps filtered row identity across sorts and refreshes rows for a different scenario or snapshot',()=>{
  const {run,store}=mount();
  fireEvent.click(screen.getByRole('radio',{name:'카드'}));
  const filtered=grid().rows,byId=new Map(filtered.map(r=>[r.paymentId,r]));
  expect(filtered).toHaveLength(cardCount);
  act(()=>grid().onSortChange({columnId:'amount',direction:'asc'}));
  for(const row of grid().rows)expect(row).toBe(byId.get(row.paymentId));
  act(()=>run.actions.setClosingPreview('no-payments'));expect(grid().rows).toHaveLength(0);
  act(()=>run.actions.setClosingPreview('normal'));expect(grid().rows).toHaveLength(cardCount);
  const before=grid().rows;
  act(()=>{expect(store.dispatch({type:'calendar.addEvent',title:'정렬 뒤 메모',date:TODAY}).ok).toBe(true);});
  expect(grid().rows).not.toBe(before);expect(grid().rows).toHaveLength(cardCount);
 });
});
