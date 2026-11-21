import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { PanelFrame } from './shared';
import { FitMiniTable } from './workspace';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('shrinks rows and whole columns, then restores both when space returns',()=>{
 const callbacks:(()=>void)[]=[];vi.stubGlobal('ResizeObserver',class { constructor(callback:()=>void){callbacks.push(callback);}observe(){}disconnect(){} });
 const view=renderWithKit(<PanelFrame id="menu"><FitMiniTable rows={[{id:'one'},{id:'two'},{id:'three'}]} columns={[{id:'name',label:'이름',render:r=>r.id},{id:'price',label:'판매가',render:()=>4500},{id:'cost',label:'원가',render:()=>700}]} getRowId={r=>r.id} label="메뉴" dropColumns={['cost']}/></PanelFrame>);
 const root=view.container.querySelector<HTMLElement>('.mc-root')!;let height=80,width=200;
 Object.defineProperties(root,{clientHeight:{get:()=>height},clientWidth:{get:()=>width},scrollHeight:{get:()=>Array.from(root.querySelectorAll<HTMLElement>('tbody tr')).filter(row=>!row.hidden).length*48},scrollWidth:{get:()=>Array.from(root.querySelectorAll<HTMLElement>('thead th')).filter(cell=>!cell.hidden).length*100}});
 callbacks.forEach(fn=>fn());expect(root.querySelectorAll('tbody tr[hidden]').length).toBeGreaterThan(0);expect(root.querySelectorAll('tr > :nth-child(3)[hidden]')).toHaveLength(4);
 height=400;width=400;callbacks.forEach(fn=>fn());expect(root.querySelectorAll('tbody tr[hidden],tr > :nth-child(3)[hidden]')).toHaveLength(0);expect(root.querySelector('[data-more-template]')).not.toBeVisible();
});
it('covered headers leave the roving sequence and rejoin after the panel moves',async()=>{
 const {useState}=await import('react');const {act,screen}=await import('@testing-library/react');const {default:userEvent}=await import('@testing-library/user-event');const {DataGrid}=await import('../../../ui');
 const {useSideGrid}=await import('./workspace');const callbacks:(()=>void)[]=[];vi.stubGlobal('ResizeObserver',class {constructor(callback:()=>void){callbacks.push(callback);}observe(){}disconnect(){}});
 function Fixture(){const {root,obscured}=useSideGrid(true),[focus,setFocus]=useState<import('../../../ui').GridFocus>(null);return <div ref={root} data-testid="frame"><DataGrid id="coverage-grid" label="메뉴" rows={[{id:'one'}]} columns={['이름','판매가','원가'].map((header,i)=>({id:String(i),header,kind:'text' as const,value:()=>header,minWidth:100,sortable:true}))} getRowId={r=>r.id} getRowLabel={()=>'메뉴'} sort={null} onSortChange={()=>{}} selectedRowId={null} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} obscuredCells={obscured} emptyContent=""/><aside className="ui-detail-side-panel"/></div>;}
 const v=renderWithKit(<Fixture/>),root=v.getByTestId('frame');let right=600;const rect=(left:number,width:number)=>({x:left,y:0,left,right:left+width,top:0,bottom:300,width,height:300,toJSON(){return {};}});
 root.getBoundingClientRect=()=>rect(0,right);root.querySelector<HTMLElement>('aside')!.getBoundingClientRect=()=>rect(right-200,200);
 root.querySelectorAll<HTMLElement>('th').forEach((el,i)=>{el.getBoundingClientRect=()=>rect(100+i*125,100);});root.querySelectorAll<HTMLElement>('[data-grid-row-id]').forEach((el,i)=>{el.getBoundingClientRect=()=>rect(100+i*125,100);});
 const price=screen.getByRole('button',{name:'판매가'}),cost=screen.getByRole('button',{name:'원가'});act(()=>callbacks.forEach(fn=>fn()));expect(cost.inert).toBe(true);price.focus();await userEvent.keyboard('{ArrowRight}');expect(price).toHaveFocus();right=800;act(()=>callbacks.forEach(fn=>fn()));expect(cost.inert).toBe(false);await userEvent.keyboard('{ArrowRight}');expect(cost).toHaveFocus();
});
