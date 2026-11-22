import '../test-setup';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UiProvider } from '../UiProvider';
import { screenPresets } from '../../layout/presets';
import { moveTable, resizeTableCount, setTableSeats } from '../../layout/table-layout';
import { sixTableLayout as createTableLayout } from '../../layout/table-layout-fixture';
import { TableGridEditor, TableSettingsPanel } from './table-grid-editor';
afterEach(cleanup);
function Host({count=6}:{count?:number}){
  const [layout,setLayout]=useState(()=>resizeTableCount(createTableLayout(),count)!),[selected,setSelected]=useState<string|null>(null);
  return <UiProvider screenPreset={screenPresets.A} reducedMotion><TableGridEditor layout={layout} selectedTableId={selected} onSelect={setSelected} onMove={(id,c,r)=>setLayout(v=>moveTable(v,id,c,r)??v)} onSeatsChange={(id,n)=>setLayout(v=>setTableSeats(v,id,n)??v)}/><TableSettingsPanel layout={layout} selectedTableId={selected} onSelect={setSelected} onCountChange={n=>setLayout(v=>resizeTableCount(v,n)??v)} onSeatsChange={(id,n)=>setLayout(v=>setTableSeats(v,id,n)??v)}/><p aria-live="polite">테이블 {layout.tables.length}개 · {layout.tables.reduce((sum,table)=>sum+table.seats,0)}석</p></UiProvider>;
}
it('commits direct table counts once on Enter then blur, rejects invalid ranges and keeps the previous count',()=>{
  const changed=vi.fn();render(<UiProvider screenPreset={screenPresets.A} reducedMotion><TableSettingsPanel layout={createTableLayout()} onCountChange={changed} onSeatsChange={()=>{}}/></UiProvider>);
  const input=screen.getByRole('spinbutton',{name:'테이블 수'});
  for(const raw of ['0','21','1.5','']){fireEvent.change(input,{target:{value:raw}});fireEvent.keyDown(input,{key:'Enter'});expect(input).toHaveValue(6);expect(input).toHaveAccessibleDescription('테이블은 1개부터 20개까지 놓을 수 있어요');}
  expect(changed).not.toHaveBeenCalled();fireEvent.change(input,{target:{value:'8'}});fireEvent.keyDown(input,{key:'Enter'});fireEvent.blur(input);expect(changed).toHaveBeenCalledExactlyOnceWith(8);
});
it('shows mixed seats empty, steps from the minimum, accepts direct seats and updates the total immediately',()=>{
  render(<Host/>);const seats=screen.getByRole('spinbutton',{name:'모든 테이블 같게'});expect(seats).toHaveValue(null);
  fireEvent.click(screen.getByRole('button',{name:'모든 테이블 같게 늘리기'}));expect(seats).toHaveValue(3);expect(screen.getByText('테이블 6개 · 18석')).toBeInTheDocument();
  fireEvent.change(seats,{target:{value:'4'}});fireEvent.blur(seats);expect(screen.getByText('테이블 6개 · 24석')).toBeInTheDocument();
  fireEvent.change(seats,{target:{value:'13'}});fireEvent.keyDown(seats,{key:'Enter'});expect(seats).toHaveValue(4);expect(seats).toHaveAccessibleDescription('좌석은 1석부터 12석까지 정할 수 있어요');
  fireEvent.click(screen.getByRole('button',{name:'T3 줄이기'}));expect(seats).toHaveValue(null);expect(screen.getByText('테이블 6개 · 23석')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'모든 테이블 같게 줄이기'}));expect(seats).toHaveValue(2);expect(screen.getByText('테이블 6개 · 12석')).toBeInTheDocument();
});
it('accepts both table-count boundaries and rejects per-table seats without changing the layout',()=>{
  render(<Host/>);const count=screen.getByRole('spinbutton',{name:'테이블 수'});
  fireEvent.change(count,{target:{value:'20'}});fireEvent.blur(count);expect(screen.getByText('테이블 20개 · 46석')).toBeInTheDocument();
  fireEvent.change(count,{target:{value:'1'}});fireEvent.keyDown(count,{key:'Enter'});expect(screen.getByText('테이블 1개 · 2석')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'테이블 수 줄이기'}));expect(screen.getByText('테이블은 1개부터 20개까지 놓을 수 있어요')).toBeInTheDocument();
  const seats=screen.getByRole('spinbutton',{name:'모든 테이블 같게'});fireEvent.change(seats,{target:{value:'0'}});fireEvent.blur(seats);expect(screen.getByText('테이블 1개 · 2석')).toBeInTheDocument();
});
it('selecting a tile focuses and scrolls its matching list row; Enter uses the same destination',()=>{
  const scroll=vi.fn(),original=HTMLElement.prototype.scrollIntoView;HTMLElement.prototype.scrollIntoView=scroll;
  try{render(<Host count={20}/>);const tile=screen.getByRole('button',{name:'T20, 2석, 가로 3번째 세로 2번째 칸'});fireEvent.click(tile);const row=document.getElementById('table-settings-T20')!;expect(row).toHaveFocus();expect(row).toHaveAttribute('data-selected','true');expect(scroll.mock.instances).toContain(row);fireEvent.keyDown(tile,{key:'Enter'});expect(row).toHaveFocus();}finally{HTMLElement.prototype.scrollIntoView=original;}
});
it('announces valid keyboard moves with one-based coordinates and rejected moves without changing coordinates',()=>{
  render(<Host/>);const tile=screen.getByRole('button',{name:'T1, 2석, 가로 2번째 세로 2번째 칸'});fireEvent.keyDown(tile,{key:'ArrowRight'});expect(screen.getByText('T1, 가로 3번째 세로 2번째 칸')).toHaveAttribute('role','status');
  fireEvent.keyDown(tile,{key:'ArrowUp'});fireEvent.keyDown(tile,{key:'ArrowUp'});expect(screen.getByText('여기에는 놓을 수 없어요')).toHaveAttribute('role','status');expect(tile).toHaveAccessibleName('T1, 2석, 가로 3번째 세로 1번째 칸');
});
it('scopes tile/list pairing with the additive getListRowId callback and preserves custom list focus',()=>{
  const layout=createTableLayout(),getListRowId=(id:string)=>`settings-draft-${id}`,enter=vi.fn((id:string)=>document.querySelector<HTMLButtonElement>(`#settings-draft-${id} button`)?.focus());
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><TableGridEditor layout={layout} selectedTableId={null} onSelect={()=>{}} onMove={()=>{}} onSeatsChange={()=>{}} getListRowId={getListRowId} onEnterList={enter}/><TableSettingsPanel layout={layout} getListRowId={getListRowId} onCountChange={()=>{}} onSeatsChange={()=>{}}/></UiProvider>);
  fireEvent.keyDown(screen.getByRole('button',{name:'T1, 2석, 가로 2번째 세로 2번째 칸'}),{key:'Enter'});expect(enter).toHaveBeenCalledExactlyOnceWith('T1');expect(screen.getByRole('button',{name:'T1 줄이기'})).toHaveFocus();
});
it('announces a pointer move and keeps the following synthetic click from moving focus into the list',()=>{
  render(<Host/>);const tile=screen.getByRole('button',{name:'T1, 2석, 가로 2번째 세로 2번째 칸'}),grid=document.querySelector<HTMLElement>('.ui-table-grid')!;
  vi.spyOn(grid,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:936,bottom:624,width:936,height:624,toJSON:()=>({})});
  const pointer=(type:string,x:number,y:number)=>fireEvent(tile,Object.assign(new Event(type,{bubbles:true}),{pointerId:7,button:0,clientX:x,clientY:y}));
  pointer('pointerdown',156,156);pointer('pointermove',260,260);pointer('pointerup',260,260);
  expect(screen.getByText('T1, 가로 3번째 세로 3번째 칸')).toHaveAttribute('role','status');expect(tile).toHaveAccessibleName('T1, 2석, 가로 3번째 세로 3번째 칸');
  fireEvent.click(tile);expect(document.getElementById('table-settings-T1')).not.toHaveFocus();
});
