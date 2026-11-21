import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useUi } from '../context';
import { useKitT } from '../kit-i18n';
import { cancelGridEdits, registerGridLayer } from '../grid-interactions';
import { motionTokens, transitionFor } from '../motion';
import { IconButton } from './controls';

export interface DetailSidePanelProps {
  open:boolean;selectedRowId:string|null;title:string;onClose:()=>void;children:ReactNode;footer?:ReactNode;
  /** DS 12.2 slot order: the destructive action (ghost destructive) is always the LAST item of the body. The kit renders this slot after
   *  every section in `children`, so a widget cannot put a section after the danger zone. */
  danger?:ReactNode;
  initialFocusRef?:RefObject<HTMLElement|null>;returnFocusKey:string;onRestoreFocus:(key:string)=>void;
}
const minimumPanelHeight=320;
/** A region in the parent's existing trap. Row changes do not remount the panel. */
export function DetailSidePanel(props:DetailSidePanelProps){
  const {reducedMotion}=useUi(),{t}=useKitT(),root=useRef<HTMLElement>(null),heading=useRef<HTMLHeadingElement>(null),wasOpen=useRef(false),restored=useRef(false),returnKey=useRef(props.returnFocusKey),latest=useRef(props);latest.current=props;
  const close=()=>{if(root.current)cancelGridEdits(root.current);restored.current=true;latest.current.onRestoreFocus(latest.current.returnFocusKey);latest.current.onClose();};
  const closeRef=useRef(close);closeRef.current=close;
  useLayoutEffect(()=>{
    if(props.open)returnKey.current=props.returnFocusKey;
    if(root.current){root.current.inert=!props.open;if(props.open)root.current.removeAttribute('aria-hidden');else root.current.setAttribute('aria-hidden','true');}
    if(props.open&&!wasOpen.current){restored.current=false;(props.initialFocusRef?.current??heading.current)?.focus({preventScroll:true});}
    if(!props.open&&wasOpen.current&&!restored.current){
      // K-E 2: the panel also closes by itself (its row was filtered away while the user types in the search box). Focus goes back to the grid only when it was lost with the panel; a field elsewhere keeps it.
      const active=document.activeElement;
      if(!active||active===document.body||active===document.documentElement||root.current?.contains(active)||!active.isConnected)props.onRestoreFocus(returnKey.current);
    }
    wasOpen.current=props.open;
  },[props.open,props.initialFocusRef,props.returnFocusKey,props.onRestoreFocus]);
  useLayoutEffect(()=>{
    if(!props.open||!root.current)return;
    return registerGridLayer({root:root.current,priority:()=>latest.current.open?10:0,dismiss:()=>closeRef.current()});
  },[props.open]);
  // DS 12.2: never taller than the dialog body (so it cannot push the table or scroll the window body) and it scrolls only its own body.
  // The limit is inline so a widget stylesheet that turns the panel into an in-flow grid item cannot lift it. `data-layout` tells CSS whether
  // the panel overlays the right edge (the table beside it must then shrink to calc(100% - panel - 24px)) or already owns a grid column.
  useLayoutEffect(()=>{
    const node=root.current;if(!props.open||!node)return;
    const body=node.closest<HTMLElement>('.ui-overlay-body');
    const sync=()=>{
      const position=getComputedStyle(node).position;
      node.dataset.layout=position==='absolute'?'overlay':'flow';
      if(!body||body.clientHeight<=0){node.style.removeProperty('max-height');return;}
      let limit=body.clientHeight;
      // An in-flow panel that starts below other content may only use what is left under it, otherwise the window body scrolls.
      if(position==='relative'||position==='static'){
        const bodyRect=body.getBoundingClientRect(),scale=body.offsetHeight?bodyRect.height/body.offsetHeight:1;
        const offset=(node.getBoundingClientRect().top-bodyRect.top)/scale+body.scrollTop;
        if(offset>0)limit=Math.max(Math.min(limit,minimumPanelHeight),limit-offset);
      }
      node.style.maxHeight=`${Math.floor(limit)}px`;
    };
    sync();
    if(typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(sync);observer.observe(node);if(body)observer.observe(body);
    return()=>observer.disconnect();
  },[props.open]);
  return <AnimatePresence>{props.open?<motion.aside ref={root} key="side-panel" role="region" lang="ko" aria-label={props.title} className="ui-detail-side-panel" initial={{opacity:0,...(!reducedMotion?{transform:`translateX(${motionTokens.translateDrawer}px)`}:{})}} animate={{opacity:1,...(!reducedMotion?{transform:'translateX(0px)'}:{})}} exit={{opacity:0,...(!reducedMotion?{transform:`translateX(${motionTokens.translateDrawer}px)`}:{}),transition:transitionFor('sideOut',reducedMotion)}} transition={transitionFor('sideIn',reducedMotion)}>
    <header><h3 ref={heading} tabIndex={-1}>{props.title}</h3><IconButton label={t('ui.kit.close')} icon="close" variant="ghost" data-grid-cancel onClick={close}/></header>
    <div className="ui-detail-side-panel__body" key={props.selectedRowId}>{props.children}{props.danger?<div className="ui-detail-side-panel__danger" data-panel-slot="danger">{props.danger}</div>:null}</div>{props.footer?<footer>{props.footer}</footer>:null}
  </motion.aside>:null}</AnimatePresence>;
}
