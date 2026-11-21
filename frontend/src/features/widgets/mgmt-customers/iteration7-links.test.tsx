import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { encodeRle } from '../../cctv/zones/mask';
import { CELLS } from '../../cctv/zones/types';
import { keepDraft } from '../../cctv/zones/editor-state';
vi.mock('../../cctv/live', async orig => { const real=await orig<typeof import('../../cctv/live')>(); return {...real,useLiveConnection:()=>({connection:'live'}),useLiveCctvView:()=>({mode:'live',connection:'live',frame:null,persons:[],cups:[],inStore:null,occupants:null,change5m:null,tables:[],avgDwell:{kind:'live-seconds',seconds:null},stale:false,zonesCount:1})}; });
import { CctvSetup } from '../../cctv/setup/CctvSetup';
afterEach(()=>{cleanup();keepDraft(null);});
it('forwards the controlled POS picker through the live camera setup',async()=>{
 const cells=new Uint8Array(CELLS);cells.fill(1,0,40);const zone={id:'z1',number:1,source:'drawn' as const,mask:encodeRle(cells)};
 const api={get:vi.fn(async()=>({revision:1,savedAt:'x',frameAspect:1.78,zones:[zone]})),put:vi.fn(),suggest:vi.fn()} as never;
 const onChange=vi.fn();
 renderWithKit(<CctvSetup start="zones" onDone={()=>{}} host={{notify:vi.fn()} as never} zonesApi={api} linkPicker={{valueFor:()=>null,optionsFor:()=>[{value:'T1',label:'T1'}],onChange}}/>);
 fireEvent.click(await screen.findByText('테이블 목록'));
 fireEvent.change(screen.getByRole('combobox',{name:'테이블 1 POS 테이블 연결'}),{target:{value:'T1'}});
 expect(onChange).toHaveBeenCalledExactlyOnceWith('z1','T1');
});
it('shows linked order status on CCTV and removes the clearing warning after cups clear', async () => {
 const { LinkedCctvRows } = await import('./cctv-detail');
 const row={zoneId:'z1',tableId:'T1',occupancyState:'cups_left' as const,occupancyObservedAt:'2026-10-26T15:45',linkedOrderStatus:'empty' as const,needsClearingBadge:true};
 const {rerender}=renderWithKit(<LinkedCctvRows links={[row]} zoneLabel={()=> 't1'}/>);
 expect(screen.getByText(/t1 · 연결 테이블 T1 · 빈 테이블/)).toBeInTheDocument();
 expect(screen.getByText('치울 테이블')).toBeInTheDocument();
 rerender(<LinkedCctvRows links={[{...row,occupancyState:'empty',needsClearingBadge:false}]} zoneLabel={()=> 't1'}/>);
 expect(screen.queryByText('치울 테이블')).not.toBeInTheDocument();
});
it('hides associations and explains why links are unavailable when table mode is off',async()=>{
 const { CctvLinks } = await import('./cctv-detail');
 renderWithKit(<CctvLinks linkedTables={[{zoneId:'z1',tableId:'T1',occupancyState:'occupied',occupancyObservedAt:null,linkedOrderStatus:'empty',needsClearingBadge:false}]} linkZones={[{id:'z1',label:'t1'}]} linkPicker={{disabled:true,valueFor:()=> 'T1',optionsFor:()=>[],onChange:()=>{}}}/>);
 expect(screen.getByText('테이블별 주문이 있는 후불형에서 연결할 수 있어요')).toBeInTheDocument();
 expect(screen.queryByText(/연결 테이블 T1/)).not.toBeInTheDocument();
 expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});
it('projects the mocked nine-to-eleven-minute interval and removes tasks on order or departure',async()=>{
 const {createPosSeed,createPosUi,createPosSeedCatalog}=await import('../../../pos/seed');
 const {createTableLayout}=await import('../../../layout/table-layout');
 const {createLinkedOccupancyState,observeLinkedOccupancy,selectLinkedTableStates}=await import('../../../data/iteration7/table-links');
 const seed=createPosSeed(),pos={...seed,orders:[],bills:[],payments:[],billAllocations:[],tableSessions:[]};
 const read={runId:'links-ui',runRevision:0,pos,posRevision:0,posUi:createPosUi(),dataRevision:0,scenario:'normal' as const,settings:{businessType:'cafe' as const,paymentStyle:'postpaid' as const,tableLayout:createTableLayout(),revision:0,cctvPosLinks:[{zoneId:'z1',tableId:'T1'}]},data:{revision:0,catalog:createPosSeedCatalog(),dayClosed:false,closingGeneration:0}};
 let occupancy=observeLinkedOccupancy(read,createLinkedOccupancyState(),{zoneId:'z1',state:'occupied',observedAt:'2026-10-26T15:45',elapsedNow:0});
 expect(selectLinkedTableStates(read,{occupancy,elapsedNow:540000}).seatedWithoutOrderTasks).toHaveLength(0);
 expect(selectLinkedTableStates(read,{occupancy,elapsedNow:660000}).seatedWithoutOrderTasks).toHaveLength(1);
 const ordering={...read,pos:{...pos,bills:[{billId:'open',originOrderNo:1,tableId:'T1',status:'open' as const,discounts:[],settlementLines:[]}]}};
 expect(selectLinkedTableStates(ordering,{occupancy,elapsedNow:660000}).seatedWithoutOrderTasks).toHaveLength(0);
 occupancy=observeLinkedOccupancy(read,occupancy,{zoneId:'z1',state:'empty',observedAt:'2026-10-26T15:46',elapsedNow:660000});
 expect(selectLinkedTableStates(read,{occupancy,elapsedNow:660000}).seatedWithoutOrderTasks).toHaveLength(0);
});
it('shows a coordinator link error without changing the controlled selection',async()=>{
 const { CctvLinks } = await import('./cctv-detail');
 renderWithKit(<CctvLinks linkError="이미 연결된 테이블이에요" linkZones={[{id:'z1',label:'t1'}]} linkPicker={{valueFor:()=>null,optionsFor:()=>[{value:'T1',label:'T1'}],onChange:()=>{}}}/>);
 expect(screen.getByRole('alert')).toHaveTextContent('이미 연결된 테이블이에요');
 expect(screen.getByRole('combobox',{name:'t1 POS 테이블 연결'})).toHaveValue('');
});
