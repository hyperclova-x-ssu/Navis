import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { StoreTable, TableLayout } from '../../contracts';
import { useUi } from '../context';
import { useKitT } from '../kit-i18n';
import { managementTokens, motionTokens, timePolicy, transitionFor } from '../motion';
import { ActionButton } from './controls';
import { Icon } from '../icons';

export interface TableGridEditorProps {
  layout:TableLayout;selectedTableId:string|null;onSelect:(tableId:string)=>void;
  onMove:(tableId:string,column:number,row:number)=>void;onSeatsChange:(tableId:string,seats:number)=>void;
  onEnterList?:(tableId:string)=>void;onInvalidMove?:()=>void;
  /** Pair with TableSettingsPanel when several editors can be mounted together. */
  getListRowId?:(tableId:string)=>string;
}
const defaultListRowId=(tableId:string)=>`table-settings-${tableId}`;
type Drag={table:StoreTable;pointerId:number;startX:number;startY:number;x:number;y:number;column:number;row:number;active:boolean;valid:boolean};
type Settle={table:StoreTable;x:number;y:number;endX:number;endY:number};
export function TableGridEditor(props:TableGridEditorProps){
  const {t}=useKitT(),{transform,reducedMotion}=useUi(),root=useRef<HTMLDivElement>(null),[drag,setDrag]=useState<Drag|null>(null),state=useRef<Drag|null>(null),[settle,setSettle]=useState<Settle|null>(null),[notice,setNotice]=useState(''),suppressClick=useRef(false);
  const update=(next:Drag|null)=>{state.current=next;setDrag(next);};
  const scale=transform?.scale??1;
  function abortDrag(){const d=state.current;if(d?.active&&!reducedMotion)setSettle({table:d.table,x:d.x,y:d.y,endX:0,endY:0});update(null);}
  const valid=(table:StoreTable,column:number,row:number)=>column>=0&&column<managementTokens.tableColumns&&row>=0&&row<managementTokens.tableRows&&!props.layout.tables.some(v=>v.tableId!==table.tableId&&v.column===column&&v.row===row);
  const reject=()=>{setNotice(t('ui.tablegrid.invalid'));props.onInvalidMove?.();};
  function move(table:StoreTable,column:number,row:number){props.onMove(table.tableId,column,row);setNotice(t('ui.tablegrid.moved',{n:table.number,x:column+1,y:row+1}));}
  function enterList(tableId:string){
    props.onEnterList?.(tableId);
    const row=root.current?.ownerDocument.getElementById((props.getListRowId??defaultListRowId)(tableId));
    if(row){if(!row.contains(row.ownerDocument.activeElement))row.focus({preventScroll:true});row.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'instant'});}
  }
  function keyboard(event:KeyboardEvent,table:StoreTable){
    const moves:Record<string,readonly [number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if(moves[event.key]){event.preventDefault();event.stopPropagation();const [x,y]=moves[event.key],column=table.column+x,row=table.row+y;if(valid(table,column,row))move(table,column,row);else reject();}
    else if(event.key==='+'||event.key==='='||event.key==='-'){event.preventDefault();event.stopPropagation();const seats=table.seats+(event.key==='-'?-1:1);if(seats>=1&&seats<=12)props.onSeatsChange(table.tableId,seats);else setNotice(t('ui.tablegrid.seatLimit'));}
    else if(event.key==='Enter'){event.preventDefault();props.onSelect(table.tableId);enterList(table.tableId);}
  }
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),timePolicy.noticeMs);return()=>clearTimeout(timer);},[notice]);
  useEffect(()=>{const cancel=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'&&state.current){event.preventDefault();event.stopImmediatePropagation();abortDrag();}};document.addEventListener('keydown',cancel,true);return()=>document.removeEventListener('keydown',cancel,true);},[reducedMotion]);
  return <div className="ui-table-editor" lang="ko"><div ref={root} className="ui-table-grid" role="group" aria-label={t('ui.tablegrid.name')}>
    {Array.from({length:managementTokens.tableColumns*managementTokens.tableRows},(_,i)=><span key={i} data-table-cell="" aria-hidden="true" style={{gridColumn:i%managementTokens.tableColumns+1,gridRow:Math.floor(i/managementTokens.tableColumns)+1}}/>)}
    <AnimatePresence initial={false}>{props.layout.tables.map(table=><TableTile key={table.tableId} table={table} selected={props.selectedTableId===table.tableId} dragging={!!(drag?.active&&drag.table.tableId===table.tableId||settle?.table.tableId===table.tableId)} onKeyDown={e=>keyboard(e,table)} onClick={()=>{if(suppressClick.current){suppressClick.current=false;return;}props.onSelect(table.tableId);enterList(table.tableId);}} onPointerDown={event=>{
      if(event.button!==0)return;suppressClick.current=false;setSettle(null);event.currentTarget.setPointerCapture?.(event.pointerId);update({table,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,x:0,y:0,column:table.column,row:table.row,active:false,valid:true});
    }} onPointerMove={event=>{
      const d=state.current;if(!d||d.pointerId!==event.pointerId)return;const x=(event.clientX-d.startX)/scale,y=(event.clientY-d.startY)/scale,active=d.active||Math.hypot(x,y)>managementTokens.tableDragSlop;
      const box=root.current?.getBoundingClientRect();if(!box)return;const column=Math.floor((event.clientX-box.left)/(box.width/managementTokens.tableColumns)),row=Math.floor((event.clientY-box.top)/(box.height/managementTokens.tableRows));update({...d,x,y,column,row,active,valid:valid(d.table,column,row)});
    }} onPointerUp={event=>{
      const d=state.current;if(!d||d.pointerId!==event.pointerId)return;event.currentTarget.releasePointerCapture?.(event.pointerId);
      if(d.active){event.preventDefault();suppressClick.current=true;const cell=(root.current?.offsetWidth??0)/managementTokens.tableColumns;if(!reducedMotion)setSettle({table:d.table,x:d.x,y:d.y,endX:d.valid?(d.column-d.table.column)*cell:0,endY:d.valid?(d.row-d.table.row)*cell:0});if(d.valid)move(d.table,d.column,d.row);else reject();}
      update(null);
    }} onPointerCancel={abortDrag}/>)}</AnimatePresence>
    {drag?.active?<><div aria-hidden="true" className="ui-table-drop" data-valid={drag.valid} style={{gridColumn:Math.max(0,Math.min(8,drag.column))+1,gridRow:Math.max(0,Math.min(5,drag.row))+1}}>{!drag.valid?<Icon name="ban"/>:null}</div><div className="ui-table-drag" aria-hidden="true" style={{gridColumn:drag.table.column+1,gridRow:drag.table.row+1,transform:`translate(${drag.x}px,${drag.y}px)`,opacity:motionTokens.opacityDrag}}><strong>T{drag.table.number}</strong><span>{t('ui.tablegrid.seats',{n:drag.table.seats})}</span></div></>:null}
    {settle?<motion.div className="ui-table-drag" aria-hidden="true" style={{gridColumn:settle.table.column+1,gridRow:settle.table.row+1}} initial={{transform:`translate(${settle.x}px,${settle.y}px)`}} animate={{transform:`translate(${settle.endX}px,${settle.endY}px)`}} transition={transitionFor('snap',reducedMotion)} onAnimationComplete={()=>setSettle(null)}><strong>T{settle.table.number}</strong><span>{t('ui.tablegrid.seats',{n:settle.table.seats})}</span></motion.div>:null}
  </div><p role="status" aria-live="polite" className="ui-table-grid__notice">{notice}</p></div>;
}
export function TableTile({table,selected,dragging,...props}:Omit<Parameters<typeof ActionButton>[0],'children'> & {table:StoreTable;selected:boolean;dragging?:boolean}){const {t}=useKitT(),{reducedMotion}=useUi();return <motion.div className="ui-table-tile-motion" style={{gridColumn:table.column+1,gridRow:table.row+1} as CSSProperties} initial={{opacity:reducedMotion?1:0}} animate={{opacity:1}} exit={{opacity:0,transition:{duration:reducedMotion?0:motionTokens.duration.rowOut/1000}}} transition={{duration:reducedMotion?0:motionTokens.duration.rowIn/1000}}><ActionButton {...props} variant="outline" className="ui-table-tile" aria-label={t('ui.tablegrid.tile',{n:table.number,seats:table.seats,x:table.column+1,y:table.row+1})} aria-pressed={selected} data-dragging={dragging||undefined}><strong>T{table.number}</strong><span>{t('ui.tablegrid.seats',{n:table.seats})}</span></ActionButton></motion.div>;}
export interface TableSettingsPanelProps {
  layout:TableLayout;onCountChange:(count:number)=>void;onSeatsChange:(tableId:string|null,seats:number)=>void;
  selectedTableId?:string|null;onSelect?:(id:string)=>void;
  getListRowId?:(tableId:string)=>string;
  /** Controlled options and selection supplied by the feature owning the links. */
  linkPicker?:{valueFor:(tableId:string)=>string|null;optionsFor:(tableId:string)=>readonly {value:string;label:string}[];onChange:(tableId:string,value:string|null)=>void;disabled?:boolean};
}
export function TableSettingsPanel({layout,onCountChange,onSeatsChange,selectedTableId,onSelect,getListRowId=defaultListRowId,linkPicker}:TableSettingsPanelProps){
  const {t}=useKitT(),minimum=Math.min(...layout.tables.map(v=>v.seats)),sameSeats=layout.tables.every(v=>v.seats===layout.tables[0]?.seats);
  return <section className="ui-table-settings" lang="ko">
    <TableQuantity label={t('ui.tablegrid.count')} value={layout.tables.length} min={1} max={20} onChange={onCountChange} limit={t('ui.tablegrid.countLimit')} unit={t('ui.tablegrid.countUnit')}/>
    <h3>{t('ui.tablegrid.perTable')}</h3>
    <TableQuantity label={t('ui.tablegrid.same')} value={sameSeats?minimum:null} stepFrom={minimum} min={1} max={12} onChange={n=>onSeatsChange(null,n)} limit={t('ui.tablegrid.seatLimit')} unit={t('ui.tablegrid.seatUnit')}/>
    <div className="ui-table-settings__list">{layout.tables.map(table=><div key={table.tableId} id={getListRowId(table.tableId)} role="group" tabIndex={-1} aria-label={`T${table.number}`} data-selected={table.tableId===selectedTableId} onFocus={event=>{if(event.target!==event.currentTarget)onSelect?.(table.tableId);}}>
      <TableQuantity label={`T${table.number}`} value={table.seats} min={1} max={12} onChange={n=>onSeatsChange(table.tableId,n)} limit={t('ui.tablegrid.seatLimit')} direct={false}/>
      {linkPicker?<label>CCTV 구역 연결 <select aria-label={`T${table.number} CCTV 구역 연결`} value={linkPicker.valueFor(table.tableId)??''} disabled={linkPicker.disabled} onChange={event=>linkPicker.onChange(table.tableId,event.currentTarget.value||null)}><option value="">연결 안 됨</option>{linkPicker.optionsFor(table.tableId).map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>:null}
    </div>)}</div>
  </section>;
}
function TableQuantity({label,value,stepFrom=value??1,min,max,onChange,limit,unit,direct=true}:{unit?:string;label:string;value:number|null;stepFrom?:number;min:number;max:number;onChange:(n:number)=>void;limit:string;direct?:boolean}){
  const {t}=useKitT(),id=useId(),[draft,setDraft]=useState<string|null>(null),dirty=useRef(false),[error,setError]=useState(false);
  useEffect(()=>{if(!error)return;const timer=setTimeout(()=>setError(false),timePolicy.noticeMs);return()=>clearTimeout(timer);},[error]);
  function commit(){
    if(!dirty.current)return;
    // Clear synchronously so the blur following Enter cannot publish a second time.
    dirty.current=false;const raw=draft??'',n=Number(raw);setDraft(null);
    if(!/^\d+$/.test(raw.trim())||!Number.isInteger(n)||n<min||n>max){setError(true);return;}
    setError(false);if(n!==value)onChange(n);
  }
  function step(delta:number){
    dirty.current=false;setDraft(null);const next=stepFrom+delta;
    if(next<min||next>max){setError(true);return;}
    setError(false);onChange(next);
  }
  const describedBy=error?`${id}-error`:undefined;
  return <div>
    <div className="ui-table-stepper">
      {direct?<label htmlFor={id}>{label}</label>:<span>{label}</span>}
      <ActionButton variant="outline" size="icon" aria-label={t('ui.tablegrid.decrease',{name:label})} aria-disabled={stepFrom<=min} aria-describedby={describedBy} onClick={()=>step(-1)}><Icon name="remove"/></ActionButton>
      {direct?<input id={id} name={id} autoComplete="off" type="number" inputMode="numeric" min={min} max={max} step={1} value={draft??value??''} aria-invalid={error||undefined} aria-describedby={describedBy}
        onChange={event=>{dirty.current=true;setDraft(event.currentTarget.value);setError(false);}} onBlur={commit}
        onKeyDown={event=>{
          if(event.key==='Enter'){event.preventDefault();commit();}
          else if(event.key==='Escape'&&dirty.current){event.preventDefault();event.stopPropagation();dirty.current=false;setDraft(null);setError(false);}
        }}/>:<span className="ui-table-stepper__value">{t('ui.tablegrid.seats',{n:value??''})}</span>}
      {direct&&unit?<span>{unit}</span>:null}
      <ActionButton variant="outline" size="icon" aria-label={t('ui.tablegrid.increase',{name:label})} aria-disabled={stepFrom>=max} aria-describedby={describedBy} onClick={()=>step(1)}><Icon name="plus"/></ActionButton>
    </div>
    {error?<p id={`${id}-error`} className="ui-table-stepper__error" role="status"><Icon name="warning"/>{limit}</p>:null}
  </div>;
}
