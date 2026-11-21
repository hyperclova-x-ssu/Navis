import { useContext, useEffect, useRef, type CSSProperties, type HTMLAttributes } from 'react';
import { UiContext } from '../context';
import { useKitT } from '../kit-i18n';
import { ActionButton } from './controls';
import { Icon } from '../icons';
import { pageTokens } from '../motion';

export interface PageDotProps { readonly isNew?:boolean;readonly index:number;readonly current:boolean;readonly onSelect:(index:number)=>void }
/** Hit 44x48; the mark is a 28x12 pill when selected, a 12 circle otherwise (shape plus colour). */
export function PageDot({index,current,onSelect,isNew=false}:PageDotProps){
  const t=useKitT();
  return <ActionButton variant="ghost" className="ui-page-dot" data-new={isNew?'true':undefined} aria-label={t.t('page.goTo',{n:index+1})} aria-current={current?'page':undefined} onClick={()=>onSelect(index)}><span className="ui-page-dot__mark" data-selected={String(current)} aria-hidden="true"/></ActionButton>;
}
export function PageArrow({direction,atEnd,onPress}:{readonly direction:'previous'|'next';readonly atEnd:boolean;readonly onPress:()=>void}){
  const {t}=useKitT();
  const name=direction==='previous'?t('page.previous'):t('page.next');
  // The slot stays; at the end the control is aria-disabled and explains why in its name.
  const label=atEnd?`${name}, ${direction==='previous'?t('page.first'):t('page.last')}`:name;
  return <ActionButton variant="ghost" size="icon" className="ui-page-arrow" aria-label={label} aria-disabled={atEnd||undefined} data-disabled={atEnd?'true':undefined} onClick={()=>{if(!atEnd)onPress();}}><Icon name={direction==='previous'?'chevron-left':'chevron-right'}/></ActionButton>;
}
export interface PageAddButtonProps { readonly total:number;readonly max?:number;readonly onAdd:()=>void;/** Called instead of onAdd at the page limit (the parent shows the page-limit Notice). */readonly onLimit?:()=>void }
export function PageAddButton({total,max=pageTokens.max,onAdd,onLimit}:PageAddButtonProps){
  const {t}=useKitT();const full=total>=max;
  const press=()=>{if(full)onLimit?.();else onAdd();};
  return <ActionButton variant="secondary" className="ui-page-add ui-page-add--text" aria-disabled={full||undefined} data-disabled={full?'true':undefined} onClick={press}><Icon name="plus"/>{t('ui.page.addWithText')}</ActionButton>;
}
export interface PageBarProps { /** 'canvas' positions the bar from the preset (DS 11.1: 16px under the grid, centred). */readonly placement?:'canvas';readonly total:number;readonly current:number;readonly onSelect:(index:number)=>void;readonly onAdd:()=>void;readonly onLimit?:()=>void;readonly hidden?:boolean;readonly max?:number }
/** SCR-24. One page: only the text add button. Hidden (not rendered) on the empty first screen. */
export function PageBar({total,current,onSelect,onAdd,onLimit,hidden=false,max,placement}:PageBarProps){
  const {t}=useKitT();const ui=useContext(UiContext);const previous=useRef(total);
  const grew=total>previous.current;
  useEffect(()=>{previous.current=total;},[total]);
  if(hidden)return null;
  const bar=ui?.layout.pageBar;
  const style:CSSProperties|undefined=placement==='canvas'&&bar?{position:'absolute',left:bar.centerX,top:bar.y,transform:'translateX(-50%)'}:undefined;
  return <nav className="ui-page-bar" style={style} aria-label={t('ui.page.barLabel')} data-count={total} data-grew={grew?'true':undefined}>
    {total>1?<PageArrow direction="previous" atEnd={current<=0} onPress={()=>onSelect(current-1)}/>:null}
    {total>1?Array.from({length:total},(_,index)=><PageDot key={index} index={index} current={index===current} onSelect={onSelect} isNew={grew&&index===total-1}/>):null}
    <PageAddButton total={total} max={max} onAdd={onAdd} onLimit={onLimit}/>
    {total>1?<PageArrow direction="next" atEnd={current>=total-1} onPress={()=>onSelect(current+1)}/>:null}
  </nav>;
}
/** SCR-25 edge band: shown only while dragging toward a direction that has a neighbour page. A status, not a button. */
export function EdgeZoneBand({side,targetPage,visible,...props}:{readonly side:'left'|'right';readonly targetPage:number;readonly visible:boolean}&Omit<HTMLAttributes<HTMLDivElement>,'children'>){
  const {t}=useKitT();
  return <div {...props} className={`ui-edge-zone ${props.className??''}`} data-side={side} data-visible={String(visible)} aria-hidden={visible?undefined:true}><span className="ui-edge-zone__chip" role={visible?'status':undefined}><Icon name={side==='left'?'chevron-left':'chevron-right'}/>{visible?t('ui.edge.chip',{n:targetPage}):null}</span></div>;
}
