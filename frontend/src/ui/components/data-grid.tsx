import { Fragment, memo, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { useUi } from '../context';
import { useKitT } from '../kit-i18n';
import { flushSync } from 'react-dom';
import { Icon } from '../icons';
import { registerGridLayer } from '../grid-interactions';
import { ActionButton, SearchField } from './controls';
import { DateField } from './date-field';
import { useGridReorder } from './grid-reorder';
import { ACTIONS_COLUMN, planColumnDrops } from './data-grid-columns';

export type GridSort={columnId:string;direction:'asc'|'desc'}|null;
export type GridFocus={rowId:string;columnId:string}|null;
export type GridError={id:string;message:string};
export type GridWarning={id:string;message:string};
export type GridCommit={editToken:string;rowId:string;columnId:string;raw:string};
export type GridCommitResult={ok:true;notice?:string}|{ok:false;error:GridError};
export interface GridAction {id:string;label:string;disabled?:boolean;disabledReason?:string;onPress:()=>void}
export interface GridColumn<Row> {
  id:string;header:string;kind:'text'|'number'|'status'|'link'|'computed';
  value:(row:Row)=>unknown;render?:(row:Row)=>ReactNode; accessibleValue?:(row:Row)=>string;
  unit?:string;minWidth:number;sortable?:boolean;editable?:(row:Row)=>boolean;
  /** Use minWidth as the full track width, leaving extra space to flexible columns. */
  fixedWidth?:boolean;
  /**
   * DS 12.1 column drop order beside an overlay DetailSidePanel: 1 = hidden first, then 2, 3 ... until the rest fits the narrowed table.
   * A column without it is required and stays (so does the first column, whatever its value). The panel closing restores every column.
   * Example (메뉴 table): `{id:'photo',…,dropOrder:1}` … `{id:'saleStatus',…,dropOrder:7}`, and `rowActionsDropOrder={2}` on the grid for the 조작 column.
   */
  dropOrder?:number;
  required?:boolean;readOnlyReason?:string;
  /** 'date' opens the kit DateField (calendar popover, long date on the field); the raw value is the store-local `YYYY-MM-DD` and `onCommit` receives that string. */
  editor?:'text'|'number'|'select'|'date';
  /** Computed cells remain read-only; adapters can opt them into RowExpand. */
  expandOnActivate?:(row:Row)=>boolean;
  options?:readonly {value:string;label:string}[];
  help?:{id:string;label:string;content:ReactNode};
}
export interface DataGridProps<Row> {
  id:string;label:string;rows:readonly Row[];getRowId:(row:Row)=>string;getRowLabel:(row:Row)=>string;columns:readonly GridColumn<Row>[];
  query?:string;searchLabel?:string;searchPlaceholder?:string;onQueryChange?:(query:string)=>void;
  sort:GridSort;onSortChange:(sort:GridSort)=>void;filters?:Readonly<Record<string,string>>;onFilterChange?:(id:string,value:string)=>void;renderFilters?:()=>ReactNode;
  selectedRowId:string|null;onSelectionChange?:(id:string|null)=>void;expandedRowIds:ReadonlySet<string>;onExpandedChange?:(ids:ReadonlySet<string>)=>void;
  getExpandAction?:(row:Row)=>{label:string;disabled?:boolean;disabledReason?:string};renderExpanded?:(row:Row)=>ReactNode;
  getRowWarning?:(row:Row)=>GridWarning|null|undefined;
  getRowActions?:(row:Row)=>readonly GridAction[];renderRowActions?:(row:Row,actions:readonly GridAction[])=>ReactNode;
  /** Drop order of the trailing per-row actions column (the 조작 column); same meaning as `GridColumn.dropOrder`. Without it that column is required. */
  rowActionsDropOrder?:number;
  /** Optional visible/accessible heading for POS processing controls. */
  rowActionsLabel?:string;
  addAction?:GridAction;renderAddRow?:()=>ReactNode;onCommit?:(edit:GridCommit)=>GridCommitResult;
  focus:GridFocus;onFocusChange:(focus:GridFocus)=>void;error?:{rowId:string;columnId:string;error:GridError}|null;onErrorDismiss?:()=>void;
  obscuredCells?:ReadonlySet<string>;toolbar?:ReactNode;emptyContent:ReactNode;noResultsContent?:ReactNode;
  ref?:Ref<DataGridHandle>;
}
export interface DataGridHandle {focusCell:(rowId:string,columnId:string)=>boolean;focusRowAction:(rowId:string,actionId:string)=>boolean;focusFallback:()=>void;cancelEdit:()=>void}
type Position={rowId:string;columnId:string};
type Edit=GridCommit&{error?:GridError};
const same=(a:GridFocus,b:GridFocus)=>a?.rowId===b?.rowId&&a?.columnId===b?.columnId;
const key=(p:Position)=>JSON.stringify([p.rowId,p.columnId]);
const display=(v:unknown)=>v===null||v===undefined?'':String(v);
const NO_DROPS:readonly string[]=[];
const sameIds=(a:readonly string[],b:readonly string[])=>a.length===b.length&&a.every((id,i)=>id===b[i]);
/**
 * DS 12.1: the columns to hide right now. Only while an overlay DetailSidePanel is a direct sibling of the grid (the same relation the push rule in
 * mastermanage.css uses); a panel that owns a grid column (`data-layout="flow"`) or no panel at all hides nothing. Widths are the declared
 * `minWidth`s (the tracks are `minmax(minWidth, 1fr)`) plus the lengths behind the expand and actions CSS variables, read at 100% or 125% text.
 */
function measureColumnDrops<Row>(host:HTMLElement,area:HTMLElement,props:DataGridProps<Row>):readonly string[]{
  const panel=host.parentElement?.querySelector<HTMLElement>(':scope > .ui-detail-side-panel');
  if(!panel)return NO_DROPS;
  const layout=panel.dataset.layout??(getComputedStyle(panel).position==='absolute'?'overlay':'flow');
  const available=area.clientWidth;
  if(layout!=='overlay'||available<=0)return NO_DROPS;
  const length=(expression:string)=>{
    const probe=document.createElement('span');
    probe.setAttribute('data-grid-length-probe',expression);probe.style.cssText=`position:absolute;visibility:hidden;pointer-events:none;width:${expression}`;
    host.appendChild(probe);const width=probe.getBoundingClientRect().width;probe.remove();return width;
  };
  return planColumnDrops({columns:props.columns,available,fixedWidth:props.getExpandAction?length('var(--target-default)'):0,
    actions:props.getRowActions?{width:length('var(--table-action-width)'),dropOrder:props.rowActionsDropOrder}:null});
}
let editSequence=0;

/** API-211: adapters supply already searched, filtered and sorted rows and raw commit validation. */
export function DataGrid<Row>(props:DataGridProps<Row>){
  const {id,label,rows,getRowId,getRowLabel}=props;
  const allColumns=props.columns;
  const {reducedMotion}=useUi(),{t,locale}=useKitT();
  const textLang=(text:string)=>locale!=='ko'&&/\p{Script=Hangul}/u.test(text)?'ko':undefined;
  const root=useRef<HTMLDivElement>(null),scroller=useRef<HTMLDivElement>(null),title=useRef<HTMLHeadingElement>(null),add=useRef<HTMLButtonElement>(null);
  const input=useRef<HTMLElement|null>(null),nodes=useRef(new Map<string,HTMLElement>());
  const [edit,setEdit]=useState<Edit|null>(null),editing=useRef<Edit|null>(null);
  const [localError,setLocalError]=useState<{rowId:string;columnId:string;error:GridError}|null>(null);
  const [help,setHelp]=useState<string|null>(null),[announcement,setAnnouncement]=useState(''),[notice,setNotice]=useState('');
  // DS 12.1 column drop: `dropped` holds the hidden column ids (ACTIONS_COLUMN for 조작). Everything below renders and navigates `columns`, the shown ones.
  const [dropped,setDropped]=useState<readonly string[]>(NO_DROPS);
  const droppable=allColumns.some((c,i)=>i>0&&c.dropOrder!==undefined)||(props.getRowActions!==undefined&&props.rowActionsDropOrder!==undefined);
  const columns=useMemo(()=>dropped.length?allColumns.filter((c,i)=>i===0||!dropped.includes(c.id)):allColumns,[allColumns,dropped]);
  const actionsShown=props.getRowActions!==undefined&&!dropped.includes(ACTIONS_COLUMN);
  const helpRef=useRef(help);helpRef.current=help;
  const last=useRef<GridFocus>(null),previousIds=useRef(rows.map(getRowId)),current=useRef(props);current.current=props;
  const dismissedError=useRef<string|null>(null);
  const externalError=props.error?.error.id===dismissedError.current?null:props.error;
  const standalone=localError??externalError;
  const standaloneRef=useRef(standalone);standaloneRef.current=standalone;
  const hidden=(rowId:string,columnId:string)=>(props.obscuredCells?.has(`${rowId}:${columnId}`)||columnId.startsWith('$action:')&&props.obscuredCells?.has(`${rowId}:$actions`))??false;
  const rowActions=new Map(rows.map(row=>[getRowId(row),actionsShown?props.getRowActions?.(row)??[]:[]]));
  const navigation:Position[][]=[columns.flatMap(c=>[{rowId:'$header',columnId:c.id},...(c.help?[{rowId:'$header',columnId:`$help:${c.id}`}]:[])])];
  for(const row of rows){
    const rowId=getRowId(row),actions=rowActions.get(rowId)??[];
    navigation.push([...(props.getExpandAction?[{rowId,columnId:'$expand'}]:[]),...columns.map(c=>({rowId,columnId:c.id})),...actions.map(a=>({rowId,columnId:`$action:${a.id}`}))].filter(p=>!hidden(p.rowId,p.columnId)));
  }
  const targets=navigation.flat();
  const valid=(p:GridFocus):p is Position=>p!==null&&targets.some(n=>same(n,p));
  let firstEditable:Position|undefined,firstCell:Position|undefined;
  for(const row of rows){const rowId=getRowId(row);for(const c of columns){if(hidden(rowId,c.id))continue;firstCell??={rowId,columnId:c.id};if(c.kind!=='computed'&&c.editable?.(row))firstEditable??={rowId,columnId:c.id};}if(firstEditable)break;}
  const firstHeader=columns.find(c=>c.sortable);
  const entry=valid(props.focus)?props.focus:valid(last.current)?last.current:firstEditable??firstCell??(firstHeader?{rowId:'$header',columnId:firstHeader.id}:navigation[0]?.[0]);
  const tabIndex=(p:Position)=>!edit&&same(entry,p)?0:-1;
  const reorder=useGridReorder(scroller,rows.map(getRowId),reducedMotion,`${props.query??''}:${JSON.stringify(props.filters??{})}`);
  function focusTarget(p:Position):boolean{
    if(!valid(p))return false;
    const node=nodes.current.get(key(p));if(!node||node.closest('[inert]'))return false;
    last.current=p;node.focus({preventScroll:true});
    // Scroll the table itself, never the dashboard or the parent dialog.
    const area=scroller.current;if(area){const a=area.getBoundingClientRect(),r=node.getBoundingClientRect(),scale=area.offsetWidth?a.width/area.offsetWidth:1;const top=area.querySelector('thead')?.getBoundingClientRect().bottom??a.top;
      if(r.top<top)area.scrollTop-=(top-r.top)/scale;
      if(r.bottom>a.bottom)area.scrollTop+=(r.bottom-a.bottom)/scale;
      if(r.left<a.left)area.scrollLeft-=(a.left-r.left)/scale;
      if(r.right>a.right)area.scrollLeft+=(r.right-a.right)/scale;
    }
    return true;
  }
  /** DS 12.1 noResultsContent: [검색어 지우기] always clears the query and hands focus back to the search box. */
  function clearQuery(){current.current.onQueryChange?.('');queueMicrotask(()=>root.current?.querySelector<HTMLInputElement>('.ui-data-grid__toolbar input')?.focus({preventScroll:true}));}
  function focusFallback(){if(add.current&&!props.addAction?.disabled)add.current.focus();else title.current?.focus();}
  function dismissError(){dismissedError.current=standaloneRef.current?.error.id??null;setLocalError(null);current.current.onErrorDismiss?.();}
  function cancelEdit(){editing.current=null;setEdit(null);input.current=null;setLocalError(null);if(current.current.error){dismissedError.current=current.current.error.error.id;current.current.onErrorDismiss?.();}}
  function restoreEditor(){queueMicrotask(()=>input.current?.focus({preventScroll:true}));}
  function commit():boolean{
    const session=editing.current;if(!session)return true;
    const result=current.current.onCommit?.({editToken:session.editToken,rowId:session.rowId,columnId:session.columnId,raw:session.raw})??{ok:true};
    if(!result.ok){const invalid={...session,error:result.error};editing.current=invalid;setEdit(invalid);restoreEditor();return false;}
    // Clear the live session synchronously: the Enter-caused unmount/blur cannot commit twice.
    editing.current=null;setEdit(null);setLocalError(null);
    if(result.notice)setAnnouncement(result.notice);
    return true;
  }
  /** While a date cell is being edited, its calendar popover (a portal outside the grid) is part of the editor: pressing a day must not count as an outside press. */
  function inDateCalendar(target:HTMLElement){const session=editing.current;return !!session&&current.current.columns.find(c=>c.id===session.columnId)?.editor==='date'&&!!target.closest('.ui-popover');}
  function selectRaw(raw:string){
    updateRaw(raw);const session=editing.current!;
    if(!commit()){const invalid=editing.current;editing.current=null;setEdit(null);setLocalError({rowId:session.rowId,columnId:session.columnId,error:invalid!.error!});}else focusTarget(session);
  }
  function ready(){return commit();}
  function begin(row:Row,column:GridColumn<Row>){
    if(column.kind==='computed'||!column.editable?.(row)||!props.onCommit)return;
    const p={rowId:getRowId(row),columnId:column.id};
    if(hidden(p.rowId,p.columnId)||same(editing.current,p))return;
    if(!ready())return;
    dismissError();
    const next={...p,raw:display(column.value(row)),editToken:`${id}:edit:${++editSequence}`};
    editing.current=next;setEdit(next);last.current=p;props.onFocusChange(p);
  }
  function updateRaw(raw:string){const session=editing.current;if(!session)return;const next={...session,raw};editing.current=next;setEdit(next);}
  function runAction(action:GridAction){if(!ready())return;if(action.disabled){setNotice(action.disabledReason??'');return;}reorder.capture();action.onPress();}
  function expand(row:Row){if(!ready())return;const action=props.getExpandAction?.(row);if(action?.disabled){setNotice(action.disabledReason??'');return;}const rowId=getRowId(row);props.onExpandedChange?.(props.expandedRowIds.has(rowId)?new Set():new Set([rowId]));}
  function select(row:Row){if(!ready())return;if(props.onSelectionChange){const rowId=getRowId(row);props.onSelectionChange(props.selectedRowId===rowId?null:rowId);}else if(props.getExpandAction)expand(row);}
  // M-208 budget fallback: measured p95 >100ms. Sorting is immediate;
  // no pre/post layout flush. Row insertion still uses the bounded M-209 FLIP.
  function sort(column:GridColumn<Row>){if(!ready())return;reorder.cancel();const direction=props.sort?.columnId===column.id&&props.sort.direction==='asc'?'desc':'asc';props.onSortChange({columnId:column.id,direction});setAnnouncement(t(direction==='asc'?'ui.grid.sortAsc':'ui.grid.sortDesc',{column:column.header}));}
  function onNavigation(event:KeyboardEvent,p:Position){
    if((event.target as HTMLElement).closest('[data-grid-editor]'))return;
    let r=navigation.findIndex(line=>line.some(n=>same(n,p))),c=navigation[r]?.findIndex(n=>same(n,p))??0;
    const page=Math.max(1,Math.floor((scroller.current?.clientHeight??0)/(nodes.current.get(key(p))?.offsetHeight||56)));
    switch(event.key){
      case 'ArrowLeft':c=Math.max(0,c-1);break;case 'ArrowRight':c=Math.min(navigation[r].length-1,c+1);break;
      case 'ArrowUp':r=Math.max(0,r-1);break;case 'ArrowDown':r=Math.min(navigation.length-1,r+1);break;
      case 'PageUp':r=Math.max(0,r-page);break;case 'PageDown':r=Math.min(navigation.length-1,r+page);break;
      case 'Home':if(event.ctrlKey)r=0;c=0;break;case 'End':if(event.ctrlKey)r=navigation.length-1;c=navigation[r].length-1;break;
      default:return;
    }
    const delta=['ArrowUp','PageUp'].includes(event.key)?-1:1;
    while(!navigation[r]?.length&&r>0&&r<navigation.length-1)r+=delta;
    event.preventDefault();event.stopPropagation();const line=navigation[r];
    const vertical=['ArrowUp','ArrowDown','PageUp','PageDown'].includes(event.key);
    if(line.length)focusTarget((vertical?line.find(n=>n.columnId===p.columnId):undefined)??line[Math.min(c,line.length-1)]);
  }
  function targetProps(p:Position){return {
    tabIndex:tabIndex(p),'data-grid-target':key(p),
    ref:(node:HTMLElement|null)=>{if(node)nodes.current.set(key(p),node);else nodes.current.delete(key(p));},
    onFocus:()=>live.current.focus(p),
    onKeyDown:(e:KeyboardEvent<HTMLElement>)=>live.current.onNavigation(e,p),
  };}
  function targetFocus(p:Position){if(editing.current&&!same(editing.current,p)){restoreEditor();return;}last.current=p;if(!same(props.focus,p))props.onFocusChange(p);}
  function editorKey(event:KeyboardEvent,row:Row,column:GridColumn<Row>){
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();cancelEdit();focusTarget({rowId:getRowId(row),columnId:column.id});return;}
    if(event.key==='Enter'){event.preventDefault();if(commit())focusTarget({rowId:getRowId(row),columnId:column.id});return;}
    if(event.key==='Tab'){
      if(!commit()){event.preventDefault();return;}
      const editable=rows.flatMap(r=>columns.filter(c=>c.kind!=='computed'&&c.editable?.(r)&&!hidden(getRowId(r),c.id)).map(c=>({row:r,column:c})));
      const index=editable.findIndex(v=>getRowId(v.row)===getRowId(row)&&v.column.id===column.id),next=editable[index+(event.shiftKey?-1:1)];
      event.preventDefault();if(next){focusTarget({rowId:getRowId(next.row),columnId:next.column.id});begin(next.row,next.column);}else{
        const all=[...document.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')].filter(n=>n.tabIndex>=0&&!n.closest('[inert],[aria-hidden="true"]')&&!n.hasAttribute('disabled'));
        const outside=event.shiftKey?all.filter(n=>!scroller.current?.contains(n)&&!!(n.compareDocumentPosition(scroller.current!)&Node.DOCUMENT_POSITION_FOLLOWING)).at(-1):all.find(n=>!scroller.current?.contains(n)&&!!(scroller.current!.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING));
        if(outside)outside.focus();else (document.activeElement as HTMLElement|null)?.blur();
      }
    }
  }
  useImperativeHandle(props.ref,()=>({focusCell:(rowId,columnId)=>focusTarget({rowId,columnId}),focusRowAction:(rowId,actionId)=>focusTarget({rowId,columnId:`$action:${actionId}`}),focusFallback,cancelEdit}));
  const handlers=useRef({cancelEdit,commit,restoreEditor,dismissError,focusTarget});handlers.current={cancelEdit,commit,restoreEditor,dismissError,focusTarget};
  useLayoutEffect(()=>{
    if(!root.current)return;
    const remove=registerGridLayer({root:root.current,priority:()=>helpRef.current?40:editing.current?30:standaloneRef.current?20:0,dismiss:()=>{
      if(helpRef.current){setHelp(null);return;}
      const session=editing.current;if(session){handlers.current.cancelEdit();handlers.current.focusTarget(session);}else handlers.current.dismissError();
    },cancel:()=>handlers.current.cancelEdit()});
    const pointer=(event:PointerEvent)=>{
      if(helpRef.current&&!(event.target as HTMLElement).closest('.ui-grid-help')){setHelp(null);event.preventDefault();event.stopImmediatePropagation();return;}
      if(!editing.current)return;
      const target=event.target as HTMLElement;
      if(target.closest('[data-grid-editor]')&&root.current?.contains(target))return;
      if(inDateCalendar(target))return;
      if(target.closest('[data-ui-close],.ui-scrim,[data-grid-cancel]')){handlers.current.cancelEdit();return;}
      if(!handlers.current.commit()){event.preventDefault();event.stopImmediatePropagation();handlers.current.restoreEditor();}
    };
    const doc=root.current.ownerDocument;doc.addEventListener('pointerdown',pointer,true);
    return()=>{remove();doc.removeEventListener('pointerdown',pointer,true);};
  },[]);
  useLayoutEffect(()=>{
    if(edit&&input.current){input.current.focus({preventScroll:true});if(input.current instanceof HTMLInputElement)input.current.select();}
  },[edit?.editToken]);
  useLayoutEffect(()=>{
    const ids=rows.map(getRowId),old=previousIds.current,p=last.current??props.focus;
    // K-E 2: typing in the toolbar (search box, filter chips) can filter the remembered row away. Focus stays where the user is typing; the table never steals it.
    const active=root.current?.ownerDocument.activeElement??null,keep=!!active&&!!root.current?.querySelector(':scope > .ui-data-grid__toolbar')?.contains(active);
    if(props.selectedRowId&&!ids.includes(props.selectedRowId)){
      const neighbor=ids[Math.min(Math.max(0,old.indexOf(props.selectedRowId)),ids.length-1)];
      if(!keep){if(neighbor&&columns[0])focusTarget({rowId:neighbor,columnId:columns[0].id});else focusFallback();}
      props.onSelectionChange?.(null);
    }
    if(p&&p.rowId!=='$header'&&!ids.includes(p.rowId)){
      cancelEdit();
      if(keep){last.current=null;if(props.focus&&!ids.includes(props.focus.rowId))props.onFocusChange(null);}
      else{
        const index=Math.min(Math.max(0,old.indexOf(p.rowId)),ids.length-1);
        if(index>=0){if(!focusTarget({rowId:ids[index],columnId:p.columnId})){const fallback=navigation[index+1]?.[0];if(fallback)focusTarget(fallback);else focusFallback();}}else focusFallback();
      }
    }else if(p&&hidden(p.rowId,p.columnId)&&root.current?.contains(document.activeElement)){if(entry)focusTarget(entry);else focusFallback();}
    previousIds.current=ids;
  });
  // Re-plan after every render (a panel can appear in the same commit as a selection) ...
  useLayoutEffect(()=>{
    const next=droppable&&root.current&&scroller.current?measureColumnDrops(root.current,scroller.current,props):NO_DROPS;
    setDropped(prev=>sameIds(prev,next)?prev:next);
  });
  // ... and when the table area resizes (window, 125% text, the panel's push rule) or the panel leaves the DOM (restore at once).
  useLayoutEffect(()=>{
    const host=root.current,area=scroller.current;if(!droppable||!host||!area)return;
    const apply=()=>{const next=measureColumnDrops(host,area,current.current);flushSync(()=>setDropped(prev=>sameIds(prev,next)?prev:next));};
    const resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(apply);resize?.observe(area);
    const parent=host.parentElement,watch=parent&&typeof MutationObserver!=='undefined'?new MutationObserver(apply):null;if(parent)watch?.observe(parent,{childList:true});
    return()=>{resize?.disconnect();watch?.disconnect();};
  },[droppable]);
  const hasSearch=props.onQueryChange!==undefined;
  const cellError=(rowId:string,columnId:string)=>same(edit,{rowId,columnId})?edit?.error:same(standalone??null,{rowId,columnId})?standalone?.error:undefined;
  const columnsCount=columns.length+(props.getExpandAction?1:0)+(actionsShown?1:0);
  const tableStyle={'--data-grid-columns':[
    ...(props.getExpandAction?['var(--target-default)']:[]),
    ...columns.map(c=>c.fixedWidth?`${c.minWidth}px`:`minmax(${c.minWidth}px, 1fr)`),
    ...(actionsShown?['var(--table-action-width)']:[]),
  ].join(' '),'--data-grid-min-width':`calc(${columns.reduce((sum,c)=>sum+c.minWidth,0)}px + ${props.getExpandAction?'var(--target-default)':'0px'} + ${actionsShown?'var(--table-action-width)':'0px'})`} as CSSProperties;
  const newRow=props.renderAddRow?.();
  const warnings=new Map<string,GridWarning>();
  if(props.getRowWarning)for(const row of rows){const warning=props.getRowWarning(row);if(warning?.message)warnings.set(getRowId(row),warning);}
  const physicalRowCount=1+rows.length+warnings.size+(newRow?1:0)+(!rows.length?1:0)+(props.renderExpanded?rows.filter(row=>props.expandedRowIds.has(getRowId(row))).length:0);
  const controller:RowController<Row>={props,t,rowActions,hidden,tabIndex,targetProps,cellError,input,nodes,focus:targetFocus,onNavigation,expand,runAction,begin,select,editorKey,commit,updateRaw,focusTarget,selectRaw};
  const live=useRef(controller);live.current=controller;
  return <div className="ui-data-grid" lang="ko" ref={root} data-dropped-columns={dropped.length?dropped.join(' '):undefined} onPointerDown={e=>e.stopPropagation()} onClickCapture={e=>{if(editing.current&&!(e.target as HTMLElement).closest('[data-grid-editor]')&&!inDateCalendar(e.target as HTMLElement)&&!ready()){e.preventDefault();e.stopPropagation();}}}>
    <h3 id={`${id}-label`} ref={title} tabIndex={-1} lang={textLang(label)} className="ui-sr-only">{label}</h3>
    {columns.map(c=>{const reason=c.readOnlyReason??(c.kind==='computed'?t('ui.grid.computed'):undefined);return reason?<span key={c.id} id={`${id}-${c.id}-reason`} className="ui-sr-only">{reason}</span>:null;})}
    {(hasSearch||props.addAction||props.toolbar||props.renderFilters)?<div className="ui-data-grid__toolbar">
      {hasSearch?<SearchField label={props.searchLabel??t('ui.grid.search')} placeholder={props.searchPlaceholder??t('ui.grid.search')} hideLabel value={props.query??''} onValueChange={v=>{if(ready())props.onQueryChange?.(v);}}/>:null}
      {props.renderFilters?.()}{props.toolbar}
      {props.addAction?<ActionButton ref={add} data-grid-add="" variant="secondary" size="default" aria-disabled={props.addAction.disabled||undefined} onClick={()=>runAction(props.addAction!)}><Icon name="plus"/>{props.addAction.label}</ActionButton>:null}
    </div>:null}
    <div className="ui-data-grid__scroll" ref={scroller} onScroll={reorder.cancel}>
      <table role="grid" aria-labelledby={`${id}-label`} aria-rowcount={physicalRowCount} aria-colcount={columnsCount} className="ui-data-grid__table" data-has-expand={!!props.getExpandAction} style={tableStyle}>
        <thead role="rowgroup"><tr role="row">{props.getExpandAction?<th aria-hidden="true"/>:null}{columns.map(column=><th key={column.id} role="columnheader" data-kind={column.kind} aria-sort={column.sortable?(props.sort?.columnId===column.id?props.sort.direction==='asc'?'ascending':'descending':'none'):undefined} style={{minWidth:column.minWidth}}>
          <div className="ui-data-grid__header-content">
            {column.sortable ? (
              <button
                type="button"
                {...targetProps({ rowId: '$header', columnId: column.id })}
                className="ui-grid-press ui-data-grid__sort"
                style={column.kind === 'number' || column.kind === 'computed' ? undefined : { justifyContent: 'flex-start' }}
                onClick={() => sort(column)}
              >
                <SortLabel text={column.header} lang={textLang(column.header)} direction={props.sort?.columnId === column.id ? props.sort.direction : null} />
              </button>
            ) : <span {...targetProps({ rowId: '$header', columnId: column.id })} lang={textLang(column.header)}>{column.header}</span>}
          {column.help?<button type="button" {...targetProps({rowId:'$header',columnId:`$help:${column.id}`})} aria-label={column.help.label} aria-expanded={help===column.id} className="ui-grid-press ui-data-grid__icon" onClick={()=>{if(ready())setHelp(help===column.id?null:column.id);}}><Icon name="info"/></button>:null}</div>
          {help===column.id&&column.help?<div className="ui-grid-help" role="note" id={column.help.id}>{column.help.content}<ActionButton variant="ghost" onClick={()=>setHelp(null)}>{t('ui.kit.close')}</ActionButton></div>:null}
        </th>)}{actionsShown?<th role={props.rowActionsLabel?'columnheader':undefined} aria-hidden={!props.rowActionsLabel||undefined}>{props.rowActionsLabel?<span lang={textLang(props.rowActionsLabel)}>{props.rowActionsLabel}</span>:null}</th>:null}</tr></thead>
        <tbody role="rowgroup">{newRow?<tr className="ui-grid-new-row"><td colSpan={columnsCount}><GridNewRow>{newRow}</GridNewRow></td></tr>:null}
        {rows.map(row=>{const rowId=getRowId(row),actions=rowActions.get(rowId)??[],expanded=props.expandedRowIds.has(rowId),warning=warnings.get(rowId);return <GridRow key={rowId} gridId={id} row={row} rowId={rowId} rowLabel={getRowLabel(row)} columns={columns} controller={live} selected={props.selectedRowId===rowId} expanded={expanded} warningId={warning?.id} warningMessage={warning?.message}
          entry={!edit&&entry?.rowId===rowId?entry.columnId:null} edit={edit?.rowId===rowId?edit:null} error={standalone?.rowId===rowId?standalone:null} columnsCount={columnsCount} actionsShown={actionsShown} t={t}
          actionKey={JSON.stringify(actions.map(({id,label,disabled,disabledReason})=>[id,label,disabled,disabledReason]))} expandKey={JSON.stringify(props.getExpandAction?.(row))??''}
          obscuredKey={JSON.stringify([...(props.getExpandAction?['$expand']:[]),...columns.map(c=>c.id),'$actions',...actions.map(a=>`$action:${a.id}`)].filter(c=>hidden(rowId,c)))}
          renderExpanded={expanded?props.renderExpanded:undefined} renderRowActions={props.renderRowActions}/>;})}
        {!rows.length?<tr><td colSpan={columnsCount} className="ui-data-grid__empty">{props.query||Object.values(props.filters??{}).some(Boolean)?<NoResults content={props.noResultsContent} fallback={t('ui.grid.noResults')} clearLabel={hasSearch&&props.query?t('ui.grid.clear'):null} onClear={clearQuery}/>:props.emptyContent}</td></tr>:null}
        </tbody>
      </table>
    </div>
    <span className="ui-sr-only" role="status" aria-live="polite">{announcement}</span>{notice?<div role="status" className="ui-grid-notice">{notice}<ActionButton variant="ghost" onClick={()=>setNotice('')}>{t('ui.kit.close')}</ActionButton></div>:null}
  </div>;
}

interface RowController<Row> {
  props:DataGridProps<Row>;t:ReturnType<typeof useKitT>['t'];rowActions:Map<string,readonly GridAction[]>;
  hidden:(rowId:string,columnId:string)=>boolean;tabIndex:(p:Position)=>number;
  targetProps:(p:Position)=>{tabIndex:number;'data-grid-target':string;ref:(node:HTMLElement|null)=>void;onFocus:()=>void;onKeyDown:(e:KeyboardEvent<HTMLElement>)=>void};
  cellError:(rowId:string,columnId:string)=>GridError|undefined;input:RefObject<HTMLElement|null>;nodes:RefObject<Map<string,HTMLElement>>;
  focus:(p:Position)=>void;onNavigation:(event:KeyboardEvent,p:Position)=>void;expand:(row:Row)=>void;runAction:(a:GridAction)=>void;begin:(row:Row,c:GridColumn<Row>)=>void;select:(row:Row)=>void;
  editorKey:(event:KeyboardEvent,row:Row,c:GridColumn<Row>)=>void;commit:()=>boolean;updateRaw:(raw:string)=>void;selectRaw:(raw:string)=>void;focusTarget:(p:Position)=>boolean;
}
interface GridRowProps<Row> {
  gridId:string;row:Row;rowId:string;rowLabel:string;columns:readonly GridColumn<Row>[];controller:RefObject<RowController<Row>>;
  selected:boolean;expanded:boolean;entry:string|null;edit:Edit|null;error:DataGridProps<Row>['error'];
  actionKey:string;expandKey:string;obscuredKey:string;t:ReturnType<typeof useKitT>['t'];columnsCount:number;actionsShown:boolean;
  renderExpanded:DataGridProps<Row>['renderExpanded'];renderRowActions:DataGridProps<Row>['renderRowActions'];
  warningId?:string;warningMessage?:string;
}
// Sort changes only keyed order. No cell formatting, subtree reconciliation, or ref reattachment
// for an unchanged row. Event delegates read current callbacks rather than a captured adapter.
function GridRowView<Row>({row,rowId,rowLabel,columns,controller,selected,expanded,edit,columnsCount,actionsShown,warningId,warningMessage}:GridRowProps<Row>){
  const {props,t,hidden,tabIndex,targetProps,cellError,input,nodes}=controller.current;
  const {id}=props,actions=(controller.current.rowActions.get(rowId)??[]).map(action=>({...action,onPress:()=>controller.current.runAction(controller.current.rowActions.get(rowId)!.find(a=>a.id===action.id)!)})),expandAction=props.getExpandAction?.(row);
return <Fragment>
          <tr role="row" data-grid-row={rowId} aria-selected={selected||undefined} aria-describedby={warningMessage?warningId:undefined} data-editing={!!edit||undefined}>
            {expandAction?<td role="gridcell" inert={hidden(rowId,'$expand')||undefined} aria-hidden={hidden(rowId,'$expand')||undefined}><button type="button" {...targetProps({rowId,columnId:'$expand'})} className="ui-grid-press ui-data-grid__icon" aria-label={expandAction.label} aria-expanded={expanded} aria-disabled={expandAction.disabled||undefined} aria-describedby={expandAction.disabledReason?`${id}-${rowId}-expand-reason`:undefined} onClick={()=>controller.current.expand(row)}><Icon name={expanded?'chevron-down':'chevron-right'}/></button>{expandAction.disabledReason?<span className="ui-sr-only" id={`${id}-${rowId}-expand-reason`}>{expandAction.disabledReason}</span>:null}</td>:null}
            {columns.map((column,index)=>{
              const p={rowId,columnId:column.id},isEditing=same(edit,p),error=cellError(rowId,column.id),raw=display(column.value(row)),value=`${raw}${column.unit?` ${column.unit}`:''}`,editable=column.kind!=='computed'&&column.editable?.(row),obscured=hidden(rowId,column.id);
              const reason=column.readOnlyReason??(column.kind==='computed'?t('ui.grid.computed'):undefined),expandable=column.kind==='computed'&&!!column.expandOnActivate?.(row);
              const cellLabel=t('ui.grid.cell',{row:rowLabel,column:column.header,value:column.accessibleValue?.(row)??value});
              return <td key={column.id} role="gridcell" data-grid-row-id={rowId} data-grid-column-id={column.id} {...(!obscured?targetProps(p):{})} tabIndex={obscured?-1:tabIndex(p)} aria-hidden={obscured||undefined} inert={obscured||undefined} aria-label={cellLabel} aria-readonly={!editable} aria-describedby={[error?error.id:reason?`${id}-${column.id}-reason`:undefined,expandable&&expandAction?.disabledReason?`${id}-${rowId}-expand-reason`:undefined].filter(Boolean).join(' ')||undefined} aria-expanded={expandable?expanded:undefined} aria-disabled={expandable&&expandAction?.disabled||undefined} data-kind={column.kind} data-first={index===0||undefined} data-editable={editable||undefined} data-editing={isEditing||undefined} className="ui-data-grid__cell ui-grid-press" onKeyDown={event=>{
                controller.current.onNavigation(event,p);if(event.defaultPrevented||isEditing)return;
                if(event.key==='F2'||event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();if(editable)controller.current.begin(row,column);else if(expandable&&event.key!=='F2')controller.current.expand(row);else if(column.kind==='link'&&controller.current.commit())event.currentTarget.querySelector<HTMLElement>('a,button')?.click();else if(column.kind!=='computed')controller.current.select(row);}
              }} onClick={event=>{if(obscured||isEditing)return;event.stopPropagation();if(column.kind==='link')return;if(editable)controller.current.begin(row,column);else if(expandable)controller.current.expand(row);else if(column.kind!=='computed')controller.current.select(row);}}>
                {isEditing?<span className="ui-grid-editor" data-grid-editor data-editor={column.editor==='date'?'date':undefined} data-invalid={error?'true':undefined} onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}
                  onKeyDown={column.editor==='date'?e=>{if(e.currentTarget.contains(e.target as Node))controller.current.editorKey(e,row,column);}:undefined}>
                  {column.editor==='date'?<DateField label={t('ui.grid.edit',{row:rowLabel,column:column.header})} value={/^\d{4}-\d{2}-\d{2}$/.test(edit!.raw)?edit!.raw:null} onValueChange={iso=>controller.current.selectRaw(iso??'')} short defaultOpen buttonRef={n=>{input.current=n;}}/>
                  :column.editor==='select'?<select ref={n=>{input.current=n;}} name={`${id}-${column.id}`} aria-label={t('ui.grid.edit',{row:rowLabel,column:column.header})} value={edit!.raw} aria-invalid={!!error} aria-describedby={error?.id} onKeyDown={e=>controller.current.editorKey(e,row,column)} onBlur={()=>controller.current.commit()} onChange={event=>{
                    controller.current.selectRaw(event.currentTarget.value);
                  }}>{column.options?.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:<input ref={n=>{input.current=n;}} type="text" inputMode={column.editor==='number'||column.kind==='number'?'decimal':undefined} autoComplete="off" name={`${id}-${column.id}`} aria-label={t('ui.grid.edit',{row:rowLabel,column:column.header})} aria-invalid={!!error} aria-describedby={error?.id} value={edit!.raw} onChange={e=>controller.current.updateRaw(e.currentTarget.value)} onKeyDown={e=>controller.current.editorKey(e,row,column)} onBlur={()=>controller.current.commit()}/>}
                  {column.unit?<span>{column.unit}</span>:null}
                </span>:<span className="ui-data-grid__value" ref={node=>{node?.querySelectorAll<HTMLElement>('button,a,input,select,[tabindex]').forEach(n=>{n.tabIndex=-1;});}}>{column.render?.(row)??<>{raw}{column.unit?<small> {column.unit}</small>:null}</>}</span>}
                {error?<CellError error={error}/>:null}
              </td>;
            })}
            {actionsShown?<td role="gridcell" className="ui-data-grid__actions" data-grid-row-id={rowId} data-grid-column-id="$actions" inert={hidden(rowId,'$actions')||undefined} aria-hidden={hidden(rowId,'$actions')||undefined}>{props.renderRowActions?<span ref={node=>{node?.querySelectorAll<HTMLElement>('button,a,[tabindex]').forEach((n,i)=>{const a=actions[i];if(!a)return;n.tabIndex=tabIndex({rowId,columnId:`$action:${a.id}`});n.dataset.gridTarget=key({rowId,columnId:`$action:${a.id}`});nodes.current.set(n.dataset.gridTarget,n);});}} onKeyDown={e=>{const el=(e.target as HTMLElement).closest<HTMLElement>('[data-grid-target]');if(el?.dataset.gridTarget)controller.current.onNavigation(e,JSON.parse(el.dataset.gridTarget).reduce((a:Position,v:string,i:number)=>({...a,[i?'columnId':'rowId']:v}),{} as Position));}}>{props.renderRowActions(row,actions)}</span>:actions.map(action=><Fragment key={action.id}><button type="button" {...targetProps({rowId,columnId:`$action:${action.id}`})} className="ui-grid-press ui-data-grid__icon" aria-label={action.label} aria-disabled={action.disabled||undefined} aria-describedby={action.disabledReason?`${id}-${rowId}-${action.id}-reason`:undefined} onClick={()=>controller.current.runAction(controller.current.rowActions.get(rowId)!.find(a=>a.id===action.id)!)}><Icon name={action.id==='delete'?'trash':'chevron-right'}/></button>{action.disabledReason?<span id={`${id}-${rowId}-${action.id}-reason`} className="ui-sr-only">{action.disabledReason}</span>:null}</Fragment>)}</td>:null}
          </tr>
          {warningMessage?<tr role="row" className="ui-grid-warning-row"><td role="gridcell" colSpan={columnsCount}><p id={warningId} className="ui-grid-warning"><Icon name="warning"/>{warningMessage}</p></td></tr>:null}
          {expanded&&props.renderExpanded?<tr role="row" className="ui-grid-expanded-row"><td role="gridcell" colSpan={columnsCount}><div className="ui-grid-expanded">{props.renderExpanded(row)}</div></td></tr>:null}
        </Fragment>;
}
const GridRow=memo(GridRowView) as typeof GridRowView;

/** Zero-result search: the widget may supply its own sentence (`noResultsContent`), but the kit always adds the clear-search button. */
function NoResults({content,fallback,clearLabel,onClear}:{content?:ReactNode;fallback:string;clearLabel:string|null;onClear:()=>void}){
  const sentence=content??fallback;
  return <div className="ui-data-grid__noresults">{typeof sentence==='string'?<p>{sentence}</p>:sentence}{clearLabel?<ActionButton variant="secondary" onClick={onClear}>{clearLabel}</ActionButton>:null}</div>;
}
/** The sort arrow rides inside the label's last word, so a label that wraps at 125% text never leaves the arrow stranded on its own line. */
function SortLabel({text,lang,direction}:{text:string;lang?:string;direction:'asc'|'desc'|null}){
  const cut=text.lastIndexOf(' ')+1,head=text.slice(0,cut),tail=text.slice(cut);
  return <span className="ui-data-grid__sort-label" lang={lang}>{head}<span className="ui-data-grid__sort-tail">{tail}{direction?<Icon name={direction==='asc'?'caret-up':'caret-down'}/>:null}</span></span>;
}
export function CellError({error}:{error:GridError}){
  const ref=useRef<HTMLSpanElement>(null);
  useLayoutEffect(()=>{const node=ref.current,area=node?.closest('.ui-data-grid__scroll');if(!node||!area)return;const r=node.getBoundingClientRect(),a=area.getBoundingClientRect();node.dataset.above=String(r.bottom>a.bottom);},[error.id,error.message]);
  return <span ref={ref} role="alert" id={error.id} className="ui-cell-error"><Icon name="error"/>{error.message}</span>;
}
function GridNewRow({children}:{children:ReactNode}){
  const root=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{const node=root.current;const field=node?.querySelector<HTMLElement>('[required],[aria-required="true"]')??node?.querySelector<HTMLElement>('input,select,textarea');field?.focus();},[]);
  return <div ref={root}>{children}</div>;
}
