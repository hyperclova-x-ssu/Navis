import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { RunStore } from '../contracts';
import { selectCommonNotice, runMessages } from '../state';
import { useWidgetDataStore } from '../data/react';
import { dataBundles } from '../data/widget-data';
import { useBundle } from '../i18n';
import { posBundle } from '../i18n/messages/pos';
import { PosContext } from '../pos/react';
import { orderStatusRuntime } from '../pos/runtime';
import { closingBundle } from './closing-messages';
import { shellBundle } from '../screens/settings/messages';
import { applyAgentRunUndo } from '../features/assistant/agent-actions';
import {motion} from 'motion/react';
import { NoticeFrame, motionTokens,transitionFor,useUi,posClasses,timePolicy } from '../ui';
export function CommonNotice({run}:{run:RunStore}){
 const state=useSyncExternalStore(run.subscribe,run.getState),notice=selectCommonNotice(state),store=useWidgetDataStore(),translator=useBundle(posBundle,runMessages,closingBundle,shellBundle,...dataBundles),{portalContainer,reducedMotion}=useUi(),contextPos=useContext(PosContext),pos=contextPos?orderStatusRuntime(contextPos):null;
 const hover=useRef(false),focused=useRef(false);
 const syncPause=()=>{const paused=hover.current||focused.current;if(paused)run.actions.pauseUndo('toast-focus');else run.actions.resumeUndo('toast-focus');pos?.pauseStatusUndo('focus',paused);};
 const [container,setContainer]=useState<HTMLElement|null>(null);
 useLayoutEffect(()=>{
  const find=()=>setContainer(Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] .ui-overlay-notice-slot,[role="alertdialog"] .ui-overlay-notice-slot')).reverse().find(slot=>!slot.closest('[inert],[aria-hidden="true"],[data-exiting="true"]'))??portalContainer);
  find();const observer=new MutationObserver(find);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['inert','aria-hidden','data-exiting']});return()=>observer.disconnect();
 },[portalContainer,state.overlay.type]);
 useLayoutEffect(()=>{if(notice&&(hover.current||focused.current)){run.actions.pauseUndo('toast-focus');pos?.pauseStatusUndo('focus',true);}},[notice?.id,run,pos]);
 // The shared state preserves six-second undo notices; M1 payment completion has no undo.
 useEffect(()=>{
  if(notice?.messageKey!=='pos.done'||!Number.isFinite(notice.expiresAt))return;
  const id=notice.id,timer=window.setTimeout(()=>{if(selectCommonNotice(run.getState())?.id===id)run.actions.clearNotice();},Math.max(0,notice.remainingMs-(timePolicy.undoMs-timePolicy.noticeMs)));
  return()=>window.clearTimeout(timer);
 },[notice?.id,notice?.expiresAt,run]);
 if(!notice||!container)return null;
 const undo=(token:string)=>{const result=store.undo(token);if(result.ok)run.actions.showNotice({kind:'complete',messageKey:result.noticeKey??'data.notice.undone'});else run.actions.showNotice({kind:'error',messageKey:result.messageKey});};
 const posUndo=notice.undo?.target==='pos';
 const runUndo=notice.undo?.target==='run';
 const localizedNotice=state.locale==='ko'&&notice.messageKey==='data.management.notice.closed'?{...notice,messageKey:'closing.notice.closed'}:notice;
 const visibleNotice=posUndo||runUndo?{...localizedNotice,undoToken:notice.undo!.token}:localizedNotice;
 const undoOther=(token:string)=>{
  if(runUndo){
   const ok=applyAgentRunUndo(run,store,token);
   run.actions.showNotice({kind:ok?'complete':'error',messageKey:ok?'data.notice.undone':'UNDO_UNAVAILABLE'});
   return;
  }
  if(!posUndo){run.actions.undo(token);return;}
  const result=pos?.undo(token);run.actions.showNotice({kind:result?.ok?'complete':'error',messageKey:result?.ok?'pos.undone':'pos.undoFailed'});
 };
 return createPortal(<div style={{pointerEvents:'auto'}} className={`app-common-notice${state.layer==='orders-payment'?` ${posClasses.notice}${state.posUi.tab==='order'?` ${posClasses.orderNotice}`:''}`:''}`} data-pos={state.layer==='orders-payment'||undefined} data-pos-order={state.layer==='orders-payment'&&state.posUi.tab==='order'||undefined} data-modal={container!==portalContainer||undefined} onPointerEnter={()=>{hover.current=true;syncPause();}} onPointerLeave={()=>{hover.current=false;syncPause();}}><motion.div key={notice.id} initial={{opacity:0,y:reducedMotion?0:motionTokens.translateToast}} animate={{opacity:1,y:0}} transition={transitionFor('short',reducedMotion)}><NoticeFrame notice={visibleNotice} translator={translator} onDataUndo={undo} onUndo={undoOther} onPause={reason=>{if(reason==='toast-focus'){focused.current=true;syncPause();}else {run.actions.pauseUndo(reason);pos?.pauseStatusUndo('touch',true);}}} onResume={reason=>{if(reason==='toast-focus'){focused.current=false;syncPause();}else {run.actions.resumeUndo(reason);pos?.pauseStatusUndo('touch',false);}}}/></motion.div></div>,container);
}
