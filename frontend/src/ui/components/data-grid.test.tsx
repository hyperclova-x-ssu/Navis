import '../test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { createRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiProvider } from '../UiProvider';
import { screenPresets } from '../../layout/presets';
import { DataGrid, type DataGridHandle, type DataGridProps, type GridColumn, type GridCommit, type GridCommitResult, type GridFocus, type GridSort } from './data-grid';
import { DetailSidePanel } from './detail-side-panel';
import { DetailDialog } from './overlays';
import { I18nProvider } from '../../i18n';

afterEach(cleanup);
type Row = { id:string; name:string; amount:number };
const initial:Row[] = [{id:'a',name:'우유',amount:4},{id:'b',name:'원두',amount:2}];
const columns:GridColumn<Row>[] = [
  {id:'name',header:'이름',kind:'text',minWidth:200,value:r=>r.name,editable:()=>true},
  {id:'amount',header:'수량',kind:'number',minWidth:160,value:r=>r.amount,unit:'L',editable:()=>true,sortable:true,help:{id:'amount-help',label:'수량 설명 보기',content:'수량을 고쳐요'}},
  {id:'computed',header:'계산',kind:'computed',minWidth:180,value:r=>r.amount*2},
];
const handle=createRef<DataGridHandle>();
function Host({commit=()=>({ok:true}),obscured=new Set<string>(),count=2,dialog=false,readOnly=false}:{commit?:(e:GridCommit)=>GridCommitResult;obscured?:Set<string>;count?:number;dialog?:boolean;readOnly?:boolean}) {
  const [rows,setRows]=useState(()=>count===2?initial:Array.from({length:count},(_,i)=>({id:`r${i}`,name:`회원 ${i}`,amount:i})));
  const [focus,setFocus]=useState<GridFocus>(null),[sort,setSort]=useState<GridSort>(null),[selected,setSelected]=useState<string|null>(null),[expanded,setExpanded]=useState<ReadonlySet<string>>(new Set());
  const [open,setOpen]=useState(true);
  const body=<><DataGrid ref={handle} id="test" label="품목" rows={rows} columns={readOnly?columns.map(c=>c.id==='name'?{...c,editable:undefined}:c):columns} getRowId={r=>r.id} getRowLabel={r=>r.name} sort={sort} onSortChange={setSort} focus={focus} onFocusChange={setFocus} selectedRowId={selected} onSelectionChange={setSelected} expandedRowIds={expanded} onExpandedChange={setExpanded} getExpandAction={r=>({label:`${r.name} 펼치기`})} renderExpanded={r=><p>{r.name} 기록</p>} getRowActions={r=>[{id:'delete',label:`${r.name} 지우기`,onPress:()=>setRows(v=>v.filter(x=>x.id!==r.id))}]} onCommit={commit} obscuredCells={obscured} emptyContent="비어 있어요"/><DetailSidePanel open={selected!==null} selectedRowId={selected} title="선택 품목" onClose={()=>setSelected(null)} returnFocusKey={`${selected}:name`} onRestoreFocus={()=>selected&&handle.current?.focusCell(selected,'name')}>내용</DetailSidePanel><button onClick={()=>setRows(v=>v.filter(x=>x.id!=='a'))}>외부 삭제</button><button>표 다음</button></>;
  return <UiProvider screenPreset={screenPresets.A} reducedMotion>{dialog?<DetailDialog open={open} title="품목 상세" onClose={()=>setOpen(false)}>{body}</DetailDialog>:body}</UiProvider>;
}
describe('API-211 DataGrid',()=>{
  it('lets fixed-width columns leave the remaining space to flexible columns', () => {
    const mixedWidths: GridColumn<Row>[] = [columns[0], { ...columns[1], fixedWidth: true }, columns[2]];
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion>
      <DataGrid id="mixed-widths" label="너비 표" rows={initial} columns={mixedWidths} getRowId={row => row.id} getRowLabel={row => row.name} sort={null} onSortChange={() => {}} focus={null} onFocusChange={() => {}} selectedRowId={null} expandedRowIds={new Set()} emptyContent="비어 있어요" />
    </UiProvider>);
    const table = screen.getByRole('grid');
    expect(table.style.getPropertyValue('--data-grid-columns')).toBe('minmax(200px, 1fr) 160px minmax(180px, 1fr)');
    expect(table.style.getPropertyValue('--data-grid-min-width')).toBe('calc(540px + 0px + 0px)');
  });
  it('keeps the sort indicator beside the label for left-aligned columns', () => {
    const styles = readFileSync('src/ui/mastermanage.css', 'utf8');
    const sortableColumns = [{ ...columns[0], sortable: true }, columns[1]];
    function HeaderHost() {
      const [sort, setSort] = useState<GridSort>({ columnId: 'name', direction: 'desc' });
      return <UiProvider screenPreset={screenPresets.A} reducedMotion>
        <style>{styles}</style>
        <DataGrid id="sort-header" label="정렬 표" rows={initial} columns={sortableColumns} getRowId={row => row.id} getRowLabel={row => row.name} sort={sort} onSortChange={setSort} focus={null} onFocusChange={() => {}} selectedRowId={null} expandedRowIds={new Set()} emptyContent="비어 있어요" />
      </UiProvider>;
    }
    render(<HeaderHost />);
    const name = screen.getByRole('button', { name: '이름' });
    // K-A A4: the arrow rides inside the label's last word, so a wrapped label never strands it
    expect(name.querySelector('.ui-data-grid__sort-label .ui-data-grid__sort-tail > svg')).toHaveAttribute('aria-hidden', 'true');
    expect(getComputedStyle(name).justifyContent).toBe('flex-start');

    const amount = screen.getByRole('button', { name: '수량' });
    fireEvent.click(amount);
    expect(amount.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    expect(getComputedStyle(amount).justifyContent).toBe('flex-end');
  });
  it.each(['en','zh-Hans','zh-Hant','ko'] as const)('marks Korean title and sortable/non-sortable header text for locale %s',locale=>{
    const cols:GridColumn<Row>[]=[{...columns[0],header:'메모'},{...columns[1],header:'금액',help:undefined},{...columns[2],header:'Amount'}];
    const tree=(label:string)=><I18nProvider locale={locale}><UiProvider screenPreset={screenPresets.A} reducedMotion><DataGrid id="language" label={label} rows={initial} columns={cols} getRowId={r=>r.id} getRowLabel={r=>r.name} sort={null} onSortChange={()=>{}} focus={null} onFocusChange={()=>{}} selectedRowId={null} expandedRowIds={new Set()} emptyContent="비어 있어요"/></UiProvider></I18nProvider>;
    const view=render(tree('매출 내역'));
    const expected=locale==='ko'?null:'ko';
    expect(screen.getByRole('heading',{name:'매출 내역'}).getAttribute('lang')).toBe(expected);
    expect(screen.getByText('메모',{selector:'th span'}).getAttribute('lang')).toBe(expected);
    expect(screen.getByRole('button',{name:'금액'}).querySelector('span')?.getAttribute('lang')).toBe(expected);
    expect(screen.getByText('Amount',{selector:'th span'})).not.toHaveAttribute('lang');
    view.rerender(tree('Sales'));
    expect(screen.getByRole('heading',{name:'Sales'})).not.toHaveAttribute('lang');
  });
  it.each([false,true])('keeps shared readonly descriptions outside 126 rows and sorts without geometry or focus work (reduced=%s)',reduced=>{
    const data=Array.from({length:126},(_,i)=>({id:`m${i}`,name:`회원 ${i}`,amount:i}));
    function MeasureHost(){const [sort,setSort]=useState<GridSort>(null);return <UiProvider screenPreset={screenPresets.A} reducedMotion={reduced}><DataGrid id="measure" label="측정 표" rows={sort?[...data].reverse():data} columns={columns} getRowId={r=>r.id} getRowLabel={r=>r.name} sort={sort} onSortChange={setSort} focus={null} onFocusChange={()=>{}} selectedRowId={null} expandedRowIds={new Set()} emptyContent="비어 있어요"/></UiProvider>;}
    render(<MeasureHost/>);
    const cells=document.querySelectorAll('[data-grid-column-id="computed"]');
    const reason=cells[0].getAttribute('aria-describedby')!;
    expect([...cells].every(c=>c.getAttribute('aria-describedby')===reason)).toBe(true);
    expect(document.getElementById(reason)).toHaveTextContent('계산된 값이라 고칠 수 없어요');
    expect(document.querySelector('[data-grid-row]')?.contains(document.getElementById(reason))).toBe(false);
    const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect'),offset=vi.spyOn(HTMLElement.prototype,'offsetTop','get'),focus=vi.spyOn(HTMLElement.prototype,'focus');
    fireEvent.click(screen.getByRole('button',{name:'수량'}));
    expect(rect).not.toHaveBeenCalled();expect(offset).not.toHaveBeenCalled();expect(focus).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[data-grid-row]')).toHaveLength(126);
  });
  it('expands only adapter-enabled computed cells on click or Enter, preserves readonly and disabled/invalid guards',()=>{
    const commit=vi.fn(()=>({ok:false as const,error:{id:'blocked-expand',message:'수량을 확인해 주세요'}}));
    const expand=vi.fn();
    const expandable:GridColumn<Row>[]=[...columns.slice(0,2),{...columns[2],expandOnActivate:r=>r.id==='a'}];
    function ExpandHost(){const [expanded,setExpanded]=useState<ReadonlySet<string>>(new Set());return <UiProvider screenPreset={screenPresets.A} reducedMotion><DataGrid id="computed-expand" label="펼침 표" rows={initial} columns={expandable} getRowId={r=>r.id} getRowLabel={r=>r.name} sort={null} onSortChange={()=>{}} focus={null} onFocusChange={()=>{}} selectedRowId={null} expandedRowIds={expanded} onExpandedChange={ids=>{expand(ids);setExpanded(ids);}} getExpandAction={r=>({label:`${r.name} 기록`})} renderExpanded={r=><p>{r.name} 변동 기록</p>} onCommit={commit} emptyContent="비어 있어요"/></UiProvider>;}
    render(<ExpandHost/>);const cell=screen.getByRole('gridcell',{name:'우유, 계산, 8'});
    fireEvent.click(cell);expect(screen.getByText('우유 변동 기록')).toBeInTheDocument();expect(cell).toHaveAttribute('aria-readonly','true');expect(cell).toHaveAttribute('aria-expanded','true');
    fireEvent.keyDown(cell,{key:'Enter'});expect(screen.queryByText('우유 변동 기록')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('gridcell',{name:'원두, 계산, 4'}));expect(expand).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('gridcell',{name:'우유, 수량, 4 L'}));fireEvent.keyDown(screen.getByRole('textbox',{name:'우유, 수량'}),{key:'Enter'});
    fireEvent.click(cell);expect(expand).toHaveBeenCalledTimes(2);expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
  it('renders an adapter warning below its row while collapsed and ties it to the row',()=>{
    const warning:DataGridProps<Row>['getRowWarning']=r=>r.id==='a'?{id:'stock-warning',message:'오늘 사용량이 재고보다 3.9 L 많아요. 기록을 확인해 주세요'}:null;
    const props:DataGridProps<Row>={id:'warnings',label:'경고 표',rows:initial,columns,getRowId:r=>r.id,getRowLabel:r=>r.name,sort:null,onSortChange:()=>{},focus:null,onFocusChange:()=>{},selectedRowId:null,expandedRowIds:new Set(),getRowWarning:warning,getExpandAction:r=>({label:`${r.name} 기록`}),renderExpanded:r=><p>{r.name} 기록</p>,emptyContent:'비어 있어요'};
    const view=render(<UiProvider screenPreset={screenPresets.A} reducedMotion><DataGrid {...props}/></UiProvider>);
    const row=document.querySelector('[data-grid-row="a"]')!;expect(row).toHaveAttribute('aria-describedby','stock-warning');expect(row).toHaveAccessibleDescription(/오늘 사용량/);expect(row.nextElementSibling).toHaveTextContent('오늘 사용량');expect(screen.queryByText('우유 기록')).not.toBeInTheDocument();expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount','4');
    view.rerender(<UiProvider screenPreset={screenPresets.A} reducedMotion><DataGrid {...props} getRowWarning={()=>null}/></UiProvider>);expect(document.getElementById('stock-warning')).toBeNull();expect(row).not.toHaveAttribute('aria-describedby');
  });
  it('keeps computed expansion disabled with an accessible reason and excludes obscured computed cells',()=>{
    const expanded=vi.fn(),cols:GridColumn<Row>[]=[{...columns[2],expandOnActivate:()=>true}];
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion><DataGrid id="disabled-computed" label="막힌 펼침" rows={initial} getRowId={r=>r.id} getRowLabel={r=>r.name} columns={cols} sort={null} onSortChange={()=>{}} focus={null} onFocusChange={()=>{}} selectedRowId={null} expandedRowIds={new Set()} onExpandedChange={expanded} getExpandAction={r=>({label:`${r.name} 기록`,disabled:true,disabledReason:'기록을 확인할 수 없어요'})} obscuredCells={new Set(['b:computed'])} emptyContent="비어 있어요"/></UiProvider>);
    const cell=screen.getByRole('gridcell',{name:'우유, 계산, 8'});expect(cell).toHaveAttribute('aria-disabled','true');expect(cell).toHaveAccessibleDescription(/기록을 확인할 수 없어요/);
    fireEvent.keyDown(cell,{key:'Enter'});expect(expanded).not.toHaveBeenCalled();expect(screen.getByText('기록을 확인할 수 없어요',{selector:'.ui-grid-notice'})).toHaveAttribute('role','status');
    const hidden=document.querySelector('[data-grid-row-id="b"][data-grid-column-id="computed"]')!;expect(hidden).toHaveAttribute('inert');fireEvent.click(hidden);expect(expanded).not.toHaveBeenCalled();
  });
  it('reorders 126 stable rows without rerendering their contents or remounting cells',()=>{
    const paint=vi.fn((r:Row)=><span>{r.name}</span>),data=Array.from({length:126},(_,i)=>({id:`p${i}`,name:`회원 ${i}`,amount:i}));
    const sortColumns:GridColumn<Row>[]=[{...columns[0],sortable:true,render:paint}];
    function SortHost(){const [sort,setSort]=useState<GridSort>(null),[focus,setFocus]=useState<GridFocus>({rowId:'p0',columnId:'name'});return <UiProvider screenPreset={screenPresets.A} reducedMotion><DataGrid id="perf" label="정렬 표" rows={sort?.direction==='asc'?[...data].reverse():data} columns={sortColumns} getRowId={r=>r.id} getRowLabel={r=>r.name} sort={sort} onSortChange={setSort} focus={focus} onFocusChange={setFocus} selectedRowId={null} expandedRowIds={new Set()} emptyContent="비어 있어요"/></UiProvider>;}
    render(<SortHost/>);
    const cell=document.querySelector('[data-grid-row="p0"] td');paint.mockClear();
    fireEvent.click(screen.getByRole('button',{name:'이름'}));
    expect(document.querySelector('[data-grid-row]')).toHaveAttribute('data-grid-row','p125');
    expect(document.querySelector('[data-grid-row="p0"] td')).toBe(cell);
    expect(paint).not.toHaveBeenCalled();
    expect(screen.getByRole('grid').querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });
  it.each([false,true])('uses current action callbacks on memoized rows after their adapter changes (custom=%s)',custom=>{
    const press=vi.fn();
    const renderRowActions=(_row:Row,actions:readonly import('./data-grid').GridAction[])=>actions.map(a=><button key={a.id} onClick={a.onPress}>{a.label}</button>);
    function CallbackHost(){const [version,setVersion]=useState(0);return <UiProvider screenPreset={screenPresets.A} reducedMotion><button onClick={()=>setVersion(v=>v+1)}>다음 자료</button><DataGrid id="callbacks" label="콜백 표" rows={initial} columns={columns} getRowId={r=>r.id} getRowLabel={r=>r.name} sort={null} onSortChange={()=>{}} focus={null} onFocusChange={()=>{}} selectedRowId={null} expandedRowIds={new Set()} getRowActions={()=>[{id:'delete',label:'행 지우기',onPress:()=>press(version)}]} renderRowActions={custom?renderRowActions:undefined} emptyContent="비어 있어요"/></UiProvider>;}
    render(<CallbackHost/>);fireEvent.click(screen.getByRole('button',{name:'다음 자료'}));fireEvent.click(screen.getAllByRole('button',{name:'행 지우기'})[0]);expect(press).toHaveBeenCalledWith(1);
  });
  it('keeps 126 rows in the DOM and exactly one navigation Tab stop',()=>{
    render(<Host count={126}/>);
    const grid=screen.getByRole('grid');
    expect(grid.querySelectorAll('[data-grid-row]')).toHaveLength(126);
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(screen.getByRole('gridcell',{name:'회원 0, 수량, 0 L'})).toBeInTheDocument();
  });
  it('scrolls an offscreen focus target below the actual sticky header, including its border offset',()=>{
    render(<Host count={126}/>);const area=document.querySelector<HTMLElement>('.ui-data-grid__scroll')!,header=area.querySelector('thead')!,cell=area.querySelector<HTMLElement>('[data-grid-row-id="r125"][data-grid-column-id="name"]')!;
    const rect=(top:number,height:number)=>({x:0,y:top,top,left:0,right:800,bottom:top+height,width:800,height,toJSON:()=>({})});
    vi.spyOn(area,'getBoundingClientRect').mockReturnValue(rect(100,400));vi.spyOn(area,'offsetWidth','get').mockReturnValue(800);
    vi.spyOn(header,'getBoundingClientRect').mockReturnValue(rect(101,48));vi.spyOn(cell,'getBoundingClientRect').mockReturnValue(rect(125,56));
    area.scrollTop=100;act(()=>{handle.current?.focusCell('r125','name');});expect(area.scrollTop).toBe(76);expect(cell).toHaveFocus();
  });
  it('moves through headers, help, expansion and named actions with arrows',async()=>{
    const user=userEvent.setup();render(<Host/>);
    await user.tab();expect(screen.getByRole('gridcell',{name:'우유, 이름, 우유'})).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowRight}');expect(screen.getByRole('button',{name:'수량'})).toHaveFocus();
    await user.keyboard('{ArrowRight}');expect(screen.getByRole('button',{name:'수량 설명 보기'})).toHaveFocus();
    await user.keyboard('{Home}{ArrowDown}{Home}');expect(screen.getByRole('button',{name:'우유 펼치기'})).toHaveFocus();
    await user.keyboard('{End}');expect(screen.getByRole('button',{name:'우유 지우기'})).toHaveFocus();
  });
  it('commits raw once for Enter then blur, and gives a fresh token to the next edit',()=>{
    const commit=vi.fn((_edit:GridCommit)=>({ok:true as const}));render(<Host commit={commit}/>);
    const cell=screen.getByRole('gridcell',{name:'우유, 수량, 4 L'});
    fireEvent.click(cell);const input=screen.getByRole('textbox',{name:'우유, 수량'});
    fireEvent.change(input,{target:{value:'4.250'}});fireEvent.keyDown(input,{key:'Enter'});fireEvent.blur(input);
    expect(commit).toHaveBeenCalledTimes(1);expect(commit.mock.calls[0]?.[0]).toMatchObject({rowId:'a',columnId:'amount',raw:'4.250'});
    fireEvent.click(cell);fireEvent.keyDown(screen.getByRole('textbox',{name:'우유, 수량'}),{key:'Enter'});
    expect(commit).toHaveBeenCalledTimes(2);expect(commit.mock.calls[0]?.[0].editToken).not.toBe(commit.mock.calls[1]?.[0].editToken);
  });
  it('blocks invalid blur, sorting, selection and expansion; Esc cancels draft and error together',async()=>{
    const commit=vi.fn(()=>({ok:false as const,error:{id:'invalid',message:'0 이상의 숫자를 넣어 주세요'}}));render(<Host commit={commit}/>);
    fireEvent.click(screen.getByRole('gridcell',{name:'우유, 수량, 4 L'}));const input=screen.getByRole('textbox',{name:'우유, 수량'});
    fireEvent.change(input,{target:{value:'많이'}});fireEvent.blur(input);
    expect(input).toHaveValue('많이');expect(input).toHaveAttribute('aria-describedby','invalid');
    fireEvent.click(screen.getByRole('button',{name:'수량'}));fireEvent.click(screen.getByRole('gridcell',{name:'원두, 이름, 원두'}));fireEvent.click(screen.getByRole('button',{name:'원두 펼치기'}));
    expect(screen.queryByRole('region',{name:'선택 품목'})).not.toBeInTheDocument();expect(screen.queryByText('원두 기록')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader',{name:/수량/})).toHaveAttribute('aria-sort','none');
    await vi.waitFor(()=>expect(input).toHaveFocus());fireEvent.keyDown(input,{key:'Escape'});
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
  it('Tab saves and edits the next cell, while input arrows keep their cursor behavior',async()=>{
    const user=userEvent.setup(),commit=vi.fn(()=>({ok:true as const}));render(<Host commit={commit}/>);
    await user.click(screen.getByRole('gridcell',{name:'우유, 이름, 우유'}));await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('textbox',{name:'우유, 이름'})).toHaveFocus();
    await user.tab();expect(screen.getByRole('textbox',{name:'우유, 수량'})).toHaveFocus();expect(commit).toHaveBeenCalledTimes(1);
  });
  it('excludes obscured cells and restores same-column focus to a neighbor after deletion',()=>{
    render(<Host obscured={new Set(['a:amount'])}/>);
    expect(handle.current?.focusCell('a','amount')).toBe(false);
    expect(document.querySelector('[aria-label="우유, 수량, 4 L"]')).toHaveAttribute('inert');
    act(()=>{handle.current?.focusCell('a','name');});fireEvent.click(screen.getByRole('button',{name:'외부 삭제'}));
    expect(screen.getByRole('gridcell',{name:'원두, 이름, 원두'})).toHaveFocus();
    expect(screen.queryByRole('gridcell',{name:'우유, 수량, 4 L'})).not.toBeInTheDocument();
  });
  it('consumes one Esc layer before SidePanel and parent dialog, without a second trap',()=>{
    render(<Host dialog/>);
    fireEvent.click(screen.getByRole('gridcell',{name:'우유, 계산, 8'}));
    // Computed cells never select a row.
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('gridcell',{name:'우유, 이름, 우유'}),{key:'Enter'});
    fireEvent.keyDown(screen.getByRole('textbox',{name:'우유, 이름'}),{key:'Escape'});
    expect(screen.getByRole('dialog',{name:'품목 상세'})).toBeInTheDocument();
  });
  it('closes help, editor, side panel and parent in that order, restoring row focus immediately',async()=>{
    const user=userEvent.setup();render(<Host dialog readOnly/>);
    await user.click(screen.getByRole('gridcell',{name:'우유, 이름, 우유'}));
    const side=screen.getByRole('region',{name:'선택 품목'});expect(side).not.toHaveAttribute('aria-modal');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(screen.getByRole('gridcell',{name:'우유, 수량, 4 L'}));
    await user.keyboard('{Escape}');expect(screen.queryByRole('textbox')).not.toBeInTheDocument();expect(side).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'수량 설명 보기'}));expect(screen.getByRole('note')).toBeInTheDocument();
    await user.keyboard('{Escape}');expect(screen.queryByRole('note')).not.toBeInTheDocument();expect(side).toBeInTheDocument();
    await user.keyboard('{Escape}');expect(screen.getByRole('gridcell',{name:'우유, 이름, 우유'})).toHaveFocus();
    expect(screen.getByRole('dialog',{name:'품목 상세'})).toBeInTheDocument();
    await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('cancels an invalid draft before parent close and never commits on the closing blur',async()=>{
    const user=userEvent.setup(),commit=vi.fn((_edit:GridCommit)=>({ok:false as const,error:{id:'invalid-close',message:'잘못된 값이에요'}}));render(<Host dialog commit={commit}/>);
    await user.click(screen.getByRole('gridcell',{name:'우유, 수량, 4 L'}));await user.type(screen.getByRole('textbox',{name:'우유, 수량'}),'많이');
    await user.keyboard('{Enter}');expect(commit).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button',{name:'닫기'}));expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(commit).toHaveBeenCalledTimes(1);
  });
  it('falls back to a sortable header when empty, and keeps obscured actions out of the Tab entry',()=>{
    render(<Host count={0}/>);expect(screen.getByRole('button',{name:'수량'})).toHaveAttribute('tabindex','0');
  });
  it('closes a selected row that disappears even when focus has moved to a header',async()=>{
    const user=userEvent.setup();render(<Host readOnly/>);await user.click(screen.getByRole('gridcell',{name:'우유, 이름, 우유'}));
    expect(screen.getByRole('region',{name:'선택 품목'})).toBeInTheDocument();
    act(()=>{handle.current?.focusCell('$header','amount');});await user.click(screen.getByRole('button',{name:'외부 삭제'}));
    await vi.waitFor(()=>expect(screen.queryByRole('region',{name:'선택 품목'})).not.toBeInTheDocument());
  });
});
