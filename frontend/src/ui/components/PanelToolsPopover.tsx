import { useLayoutEffect,useState,type ReactNode,type RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';
import { useUi } from '../context';
import { useKitT } from '../kit-i18n';
import { consumeDismissSequence,dismissOnFocusOut,useOverlayClose,type CloseReason } from '../dismiss';
import { panelToolPosition } from '../panel-layout';
import { toCanvasRect } from '../viewport';
import { CellMoveControl,ResizeAxisControl,type ResizeAxisControlProps } from './controls';
export interface PanelToolsPopoverProps extends ResizeAxisControlProps {readonly open:boolean;readonly label:string;readonly anchorRef:RefObject<HTMLElement|null>;readonly onClose:(reason:CloseReason,event?:Event)=>void;readonly onMove?:(delta:{column:number;row:number})=>void;/** SCR-25: extra controls (e.g. send to previous / next page) shown after the move buttons. */readonly pageSlot?:ReactNode}
export function PanelToolsPopover({open,label,anchorRef,onClose,onMove,pageSlot,...size}:PanelToolsPopoverProps){
 const {t}=useKitT();const {portalContainer,screenPreset,transform,textScale}=useUi();const [popup,setPopup]=useState<HTMLDivElement|null>(null),[position,setPosition]=useState<{x:number;y:number}|null>(null);
 const close=useOverlayClose(open,onClose);
 useLayoutEffect(()=>{
  if(!open||!popup||!anchorRef.current)return;
  const measure=()=>{
   const anchor=anchorRef.current;if(!anchor)return;
   const r=anchor.getBoundingClientRect(),rect=transform?toCanvasRect(r,transform):r;
   const blocked=Array.from(document.querySelectorAll<HTMLElement>('.dashboard-header,.app-layer-navigation,.ui-page-bar')).filter(node=>node.getClientRects().length>0).map(node=>{const bounds=node.getBoundingClientRect();return transform?toCanvasRect(bounds,transform):bounds;});
   const next=panelToolPosition(rect,{width:popup.offsetWidth,height:popup.offsetHeight},{width:screenPreset.baselineWidth,height:screenPreset.baselineHeight},blocked);
   setPosition(before=>before?.x===next.x&&before.y===next.y?before:next);
  };
  measure();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);observer?.observe(popup);observer?.observe(anchorRef.current);for(const node of document.querySelectorAll('.dashboard-header,.app-layer-navigation,.ui-page-bar'))observer?.observe(node);return()=>observer?.disconnect();
 },[open,popup,anchorRef,screenPreset,transform,textScale]);
 if(!portalContainer)return null;
 return <Popover.Root open={open} modal={false} onOpenChange={(next,details)=>{if(!next){consumeDismissSequence(details.event);close(details.reason==='escape-key'?'Esc':details.reason==='outside-press'?'outside':'button',details.event);}}}><Popover.Portal container={portalContainer}><Popover.Positioner positionMethod="absolute" anchor={anchorRef} side="bottom" className="ui-panel-tool-positioner" style={{left:position?.x??0,top:position?.y??0,transform:'none',visibility:position?'visible':'hidden'}}><Popover.Popup onBlurCapture={event=>dismissOnFocusOut(event.nativeEvent,event.currentTarget,anchorRef.current,close)} ref={setPopup} className="ui-popover ui-popover--panel-tools" aria-label={t('ui.tools.name',{label})} initialFocus finalFocus={anchorRef}><h2 className="ui-panel-tools-title">{label}</h2><div className="ui-panel-tools-body" role="region" aria-label={t('ui.tools.region')} tabIndex={0}><ResizeAxisControl {...size}/>{onMove?<CellMoveControl onMove={onMove}/>:null}{pageSlot}</div></Popover.Popup></Popover.Positioner></Popover.Portal></Popover.Root>;
}
