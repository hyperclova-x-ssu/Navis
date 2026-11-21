import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { createPortal } from 'react-dom';
import { Popover } from '@base-ui/react/popover';
import { motion, type MotionStyle } from 'motion/react';
import type { CoachStep } from '../../contracts';
import { useUi } from '../context';
import { consumeDismissSequence, dismissOnFocusOut, useOverlayClose, type CloseReason } from '../dismiss';
import { ActionButton, IconButton } from './controls';
import { Icon } from '../icons';
import { useKitT } from '../kit-i18n';
import { layoutTokens, motionTokens, transitionFor, type MotionKind } from '../motion';
import { drawerContentHeight } from '../drawer-layout';
import { toCanvasRect, type CanvasRect } from '../viewport';
import { cancelGridEdits } from '../grid-interactions';
import '../iteration7.css';

export interface DialogFrameProps { readonly open:boolean;readonly title:string;readonly description?:string;readonly children:ReactNode;readonly onClose:(reason:CloseReason,event?:Event)=>void;readonly returnFocusRef?:RefObject<HTMLElement|null>;readonly variant?:'detail'|'settings'|'briefing'|'fullscreen';readonly layoutId?:string;readonly footer?:ReactNode;readonly popupRef?:Ref<HTMLDivElement>;readonly popupStyle?:MotionStyle;/** v4: HelpButton(?) slot left of close (DS 11.4 DetailDialog). */readonly headerAction?:ReactNode;/** v4: localized close name. */readonly closeLabel?:string;readonly entryMotion?:MotionKind;readonly contentLang?:string;/** Optional POS close guard; existing dialogs retain their dismissal behavior. */readonly closeLocked?:boolean;readonly closeLockReason?:string;readonly initialFocusRef?:RefObject<HTMLElement|null>;readonly popupClassName?:string;readonly dialogRole?:'dialog'|'alertdialog';readonly posMotion?:boolean;readonly descriptionHidden?:boolean;/** Called before a different tab is selected inside the window. */readonly onContextChange?:()=>void }
export function DialogFrame({open,title,description,children,onClose,returnFocusRef,variant='detail',layoutId,footer,popupRef,popupStyle,headerAction,closeLabel,entryMotion,contentLang,closeLocked=false,closeLockReason,initialFocusRef,popupClassName='',dialogRole='dialog',posMotion=false,descriptionHidden=false,onContextChange}:DialogFrameProps){
  const {t}=useKitT();const {portalContainer,reducedMotion}=useUi();const closeRef=useRef<HTMLButtonElement>(null);
  const ownPopup=useRef<HTMLDivElement|null>(null);const lockId=useId();
  if((!open&&!posMotion)||!portalContainer)return null;
  const kind=entryMotion??(variant==='detail'||variant==='fullscreen'?'detailIn':'briefingIn');
  const defaultTransform=!reducedMotion&&!layoutId&&popupStyle?.transform===undefined;
  const defaultOpacity=popupStyle?.opacity===undefined;
  return <Dialog.Root open={open} modal onOpenChange={(next,details)=>{if(!next){if(closeLocked){details.cancel();consumeDismissSequence(details.event);return;}if(ownPopup.current)cancelGridEdits(ownPopup.current);consumeDismissSequence(details.event);onClose(details.reason==='escape-key'?'Esc':details.reason==='outside-press'?'outside':'button',details.event);}}}><Dialog.Portal container={portalContainer}><Dialog.Backdrop className={`ui-scrim ${posMotion?'ui-pos-scrim':''}`} data-testid="ui-dialog-backdrop"/><div className={`ui-modal-viewport ${variant==='fullscreen'?'ui-modal-viewport--fullscreen':''}`}><Dialog.Popup lang={contentLang} onClickCapture={event=>{const tab=event.target instanceof Element?event.target.closest('[role="tab"]'):null;if(tab&&tab.getAttribute('aria-selected')!=='true')onContextChange?.();}} role={dialogRole} inert={!open||undefined} aria-hidden={!open||undefined} ref={node=>{ownPopup.current=node;if(typeof popupRef==='function')popupRef(node);else if(popupRef)popupRef.current=node;}} initialFocus={initialFocusRef??closeRef} finalFocus={returnFocusRef??true} className={`ui-dialog ui-dialog--${variant} ${popupClassName}`} render={posMotion?<div style={popupStyle as CSSProperties}/>:<motion.div style={popupStyle} layoutId={reducedMotion?undefined:layoutId} initial={{...(defaultOpacity?{opacity:0}:{}),...(defaultTransform?{transform:`scale(${motionTokens.scaleOverlay})`}:{})}} animate={{...(defaultOpacity?{opacity:1}:{}),...(defaultTransform?{transform:'scale(1)'}:{})}} transition={transitionFor(kind,reducedMotion)}/>}><header className="ui-overlay-header"><div className="ui-overlay-heading"><Dialog.Title className="ui-dialog-title">{title}</Dialog.Title>{description?<Dialog.Description className={descriptionHidden?'ui-sr-only':'ui-dialog-description'}>{description}</Dialog.Description>:null}</div>{headerAction?<div className="ui-overlay-actions">{headerAction}</div>:null}<Dialog.Close disabled={closeLocked} render={<IconButton ref={closeRef} disabled={closeLocked} aria-describedby={closeLocked&&closeLockReason?lockId:undefined} label={closeLabel??t('common.close')} data-ui-close="true" icon="close" variant="ghost"/>}/>{closeLocked&&closeLockReason?<span id={lockId} className="ui-sr-only">{closeLockReason}</span>:null}</header><div className="ui-overlay-body">{children}</div><footer className={footer?'ui-overlay-note':'ui-overlay-note--empty'}>{footer}<div className="ui-overlay-notice-slot"/></footer></Dialog.Popup></div></Dialog.Portal></Dialog.Root>;
}
export type DetailDialogProps = Omit<DialogFrameProps,'variant'> & {readonly fullscreen?:boolean};
export function DetailDialog(props:DetailDialogProps){const {fullscreen,...rest}=props;return <DialogFrame {...rest} variant={fullscreen?'fullscreen':'detail'}/>;}
export function FullscreenToggle({fullscreen,onChange,accessibleLabel}:{readonly fullscreen:boolean;readonly onChange:(fullscreen:boolean)=>void;readonly accessibleLabel:string}){return <ActionButton variant="secondary" size="icon" className="detail-fullscreen-toggle" aria-label={accessibleLabel} aria-pressed={fullscreen} onClick={()=>onChange(!fullscreen)}><Icon name={fullscreen?"minimize":"maximize"}/></ActionButton>;}
export function BriefingCard(props:Omit<DialogFrameProps,'variant'|'title'|'description'> & {readonly title?:string;readonly description?:string;readonly fullscreen?:boolean}){const {t}=useKitT();const {fullscreen,...rest}=props;return <DialogFrame {...rest} title={props.title??t('ui.briefing.title')} description={props.description??t('ui.briefing.description')} variant={fullscreen?'fullscreen':'briefing'}/>;}
export interface FunctionDrawerProps { readonly open:boolean;readonly title:string;readonly children:ReactNode;readonly search?:ReactNode;readonly resultCount?:number;readonly showHint?:boolean;readonly onClose:(reason:CloseReason,event?:Event)=>void;readonly suppressReturnFocus?:boolean;readonly returnFocusRef?:RefObject<HTMLElement|null>;readonly initialFocusRef?:RefObject<HTMLElement|null> }
export function FunctionDrawer(props:FunctionDrawerProps){
  const {portalContainer}=useUi();
  // A new opening starts with its own measurement, never the previous query's.
  return props.open&&portalContainer?<OpenFunctionDrawer {...props}/>:null;
}
function OpenFunctionDrawer({open,title,children,search,resultCount,showHint=true,onClose,suppressReturnFocus=false,returnFocusRef,initialFocusRef}:FunctionDrawerProps){
  const {t}=useKitT();const {portalContainer,reducedMotion,layout,textScale}=useUi();const closeRef=useRef<HTMLButtonElement>(null),headerRef=useRef<HTMLElement>(null),queryRef=useRef<HTMLDivElement>(null),hintRef=useRef<HTMLParagraphElement>(null);
  const [listNode,setListNode]=useState<HTMLDivElement|null>(null);
  const [size,setSize]=useState<{height:number;count:number}|null>(null);
  useLayoutEffect(()=>{
    if(!listNode)return;
    const measure=()=>{
      const count=resultCount??listNode.querySelectorAll('.ui-function-row').length;
      // The committed portal node supplies logical sizes, independent of fit.
      const natural=listNode.offsetHeight;
      const queryHeight=queryRef.current?.offsetHeight??0;
      const headerHeight=headerRef.current?.offsetHeight??48,hintHeight=showHint?(hintRef.current?.offsetHeight||(textScale===125?70:56)):0;
      const height=drawerContentHeight({maxHeight:layout.drawer.height,bodyHeight:natural+(search?queryHeight+12:0),hintHeight,headerHeight});
      setSize(previous=>previous?.height===height&&previous.count===count?previous:{height,count});
    };
    measure();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);
    observer?.observe(listNode);for(const ref of [queryRef,headerRef,hintRef])if(ref.current)observer?.observe(ref.current);
    return()=>observer?.disconnect();
  },[listNode,children,search,resultCount,showHint,layout.drawer.height,textScale]);
  if(!open||!portalContainer)return null;
  return <Dialog.Root open modal={false} disablePointerDismissal onOpenChange={(next,details)=>{if(!next){consumeDismissSequence(details.event);onClose(details.reason==='escape-key'?'Esc':'button',details.event);}}}><Dialog.Portal container={portalContainer}><Dialog.Popup className="ui-drawer" style={{height:size?.height}} initialFocus={initialFocusRef??closeRef} finalFocus={suppressReturnFocus?false:returnFocusRef??true} render={<motion.div initial={{opacity:0,...(!reducedMotion?{transform:`translateX(${motionTokens.translateDrawer}px)`}:{})}} animate={{opacity:1,...(!reducedMotion?{transform:'translateX(0px)'}:{})}} transition={transitionFor('drawerIn',reducedMotion)}/>}><header ref={headerRef} className="ui-overlay-header"><Dialog.Title className="ui-dialog-title">{title}</Dialog.Title><Dialog.Close render={<IconButton ref={closeRef} label={t('common.close')} data-ui-close="true" icon="close" variant="ghost"/>}/></header>{search?<div ref={queryRef} className="ui-drawer__query"><div className="ui-drawer__search">{search}</div>{(resultCount??size?.count??0)>0?<p className="ui-drawer__count">{t('ui.drawer.count',{n:resultCount??size?.count??0})}</p>:null}</div>:null}<div className="ui-scroll-area ui-drawer__results" aria-label={t('ui.drawer.listName',{title})} tabIndex={0}><div ref={setListNode} className="ui-function-list">{children}</div></div>{showHint?<p ref={hintRef} className="ui-drawer__footer">{t('ui.drawer.footer1')}<br/>{t('ui.drawer.footer2')}</p>:null}</Dialog.Popup></Dialog.Portal></Dialog.Root>;
}
export interface AnchoredPopoverProps { readonly open:boolean;readonly anchorRef:RefObject<HTMLElement|null>;readonly onClose:(reason:CloseReason,event?:Event)=>void;readonly children:ReactNode;readonly id?:string;readonly focusOnOpen?:boolean;readonly side?:'top'|'right'|'bottom'|'left';readonly label?:string;readonly allowAnchorInteraction?:boolean }
export function AnchoredPopover({open,anchorRef,onClose,children,id,focusOnOpen=false,side='left',label,allowAnchorInteraction=false}:AnchoredPopoverProps){
  const {portalContainer,canvasElement}=useUi();
  const close=useOverlayClose(open,onClose);
  if(!portalContainer)return null;
  return <Popover.Root open={open} modal={false} onOpenChange={(next,details)=>{if(!next){if(allowAnchorInteraction&&details.event.target instanceof Node&&anchorRef.current?.contains(details.event.target)){details.cancel();details.allowPropagation();return;}consumeDismissSequence(details.event);close(details.reason==='escape-key'?'Esc':details.reason==='outside-press'?'outside':'button',details.event);}}}><Popover.Portal container={portalContainer}><Popover.Positioner positionMethod="absolute" collisionBoundary={canvasElement??undefined} anchor={anchorRef} side={side} sideOffset={layoutTokens.coachGap} collisionPadding={layoutTokens.margin} className="ui-popover-positioner"><Popover.Popup onBlurCapture={event=>dismissOnFocusOut(event.nativeEvent,event.currentTarget,anchorRef.current,close)} className="ui-popover" id={id} aria-hidden={!open||undefined} inert={!open||undefined} initialFocus={focusOnOpen} finalFocus={false} aria-label={label}><Popover.Arrow className="ui-popover-arrow"/>{children}</Popover.Popup></Popover.Positioner></Popover.Portal></Popover.Root>;
}
export function CoachMark({children,secondary,coachStep,closeLabel,noteLabel,scrollLabel,footer,...props}:Omit<AnchoredPopoverProps,'focusOnOpen'|'label'> & {readonly secondary?:string;readonly coachStep?:CoachStep;/** v4: localized names. Default: 안내 닫기 beside a footer (two or more tips); a one-step tip closes as the last step does, 확인 (D-326 Q14). */readonly closeLabel?:string;readonly noteLabel?:string;readonly scrollLabel?:string;/** v4: fixed row under the body column (CoachFooter). */readonly footer?:ReactNode}){
  const generated=useId();const id=props.id??generated;
  const {t}=useKitT();const {portalContainer,canvasElement,screenPreset,transform,textScale}=useUi();
  const close=useOverlayClose(props.open,props.onClose);
  const [popup,setPopup]=useState<HTMLDivElement|null>(null);
  const [geometry,setGeometry]=useState<{x:number;y:number;side:'top'|'bottom'|'left'|'right';tail:number;target:CanvasRect;scrollable:boolean}|null>(null);
  useLayoutEffect(()=>{
    if(!props.open||!popup||!screenPreset)return;
    const rect=(element:Element)=>{const r=element.getBoundingClientRect();return transform?toCanvasRect(r,transform):r;};
    const measure=()=>{
      const anchor=props.anchorRef.current;
      if(!anchor?.isConnected){setGeometry(null);return;}
      const target=rect(anchor),style=getComputedStyle(popup);
      const token=(name:string,fallback:number)=>parseFloat(style.getPropertyValue(name))||fallback;
      const gap=token('--coach-gap',layoutTokens.coachGap),margin=layoutTokens.margin,tailSize=token('--coach-tail',0),corner=margin;
      const width=popup.offsetWidth,height=popup.offsetHeight;
      if(!width||!height)return;
      const cornerInset=token('--space-2',0)+layoutTokens.targetDefault/2;
      const body=anchor.querySelector('.ui-panel-content');const bodyRect=body?rect(body):target;
      const point=coachStep==='resize-panel'?{x:target.right-cornerInset,y:target.bottom-cornerInset}:{x:bodyRect.x+bodyRect.width/2,y:bodyRect.y+bodyRect.height/2};
      const blocked=[...canvasElement?.querySelectorAll('.dashboard-rail,.ui-rail-item,.ui-edit-toolbar,.ui-panel-remove,.ui-panel-resize,.ui-page-bar,.ui-help-button,button[data-ui-close],button[aria-label="'+t('common.close')+'"]')??[]].filter(element=>!popup.contains(element)).map(element=>({rect:rect(element),railBackground:element.classList.contains('dashboard-rail'),help:element.classList.contains('ui-help-button')}));
      const overlaps=(box:{x:number;y:number;width:number;height:number},r:{x:number;y:number;width:number;height:number})=>box.x<r.x+r.width&&box.x+box.width>r.x&&box.y<r.y+r.height&&box.y+box.height>r.y;
      const preferred=coachStep==='choose-feature'?'left':props.side??'bottom';
      const sides=[preferred,...(['bottom','top','left','right'] as const).filter(side=>side!==preferred)];
      const candidates:{x:number;y:number;side:typeof sides[number];tail:number}[]=[];
      const extentOf=({x,y,side}:{x:number;y:number;side:typeof sides[number]})=>({x:x-(side==='right'?tailSize:0),y:y-(side==='bottom'?tailSize:0),width:width+(side==='left'||side==='right'?tailSize:0),height:height+(side==='top'||side==='bottom'?tailSize:0)});
      const text=popup.querySelector<HTMLElement>('.ui-coach-text');
      const scrollable=Boolean(text&&text.scrollHeight>text.clientHeight+1);
      let next:typeof geometry=null;
      for(const side of sides){
        const vertical=side==='bottom'||side==='top';
        let x=vertical?(coachStep==='resize-panel'?target.right-width:coachStep==='move-panel'?target.x:target.x+target.width/2-width/2):side==='left'?target.x-gap-width:target.right+gap;
        let y=vertical?(side==='bottom'?target.bottom+gap:target.y-gap-height):point.y-height/2;
        if(vertical){x=Math.max(margin,Math.min(x,screenPreset.baselineWidth-margin-width));x=Math.max(point.x-(width-corner),Math.min(x,point.x-corner));}
        else{y=Math.max(margin,Math.min(y,screenPreset.baselineHeight-margin-height));y=Math.max(point.y-(height-corner),Math.min(y,point.y-corner));}
        const tail=vertical?point.x-x:point.y-y;
        candidates.push({x,y,side,tail});
        const extent=extentOf({x,y,side});
        if(tail<corner||tail>(vertical?width:height)-corner||extent.x<margin||extent.y<margin||extent.x+extent.width>screenPreset.baselineWidth-margin||extent.y+extent.height>screenPreset.baselineHeight-margin)continue;
        if(overlaps(extent,target)||blocked.some(obstacle=>overlaps(obstacle.railBackground?{x,y,width,height}:extent,obstacle.rect)))continue;
        next={x,y,side,tail,target:{...target},scrollable};break;
      }
      if(!next){
        // Never strand the guidance queue because every preferred placement is
        // obstructed. Keep the target usable, then protect essential controls
        // before help buttons; equal scores retain the original side order.
        const overlapArea=(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number})=>Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
        const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(value,max));
        const ranked=candidates.map(candidate=>{
          const {side}=candidate,vertical=side==='bottom'||side==='top';
          const x=clamp(candidate.x,margin+(side==='right'?tailSize:0),screenPreset.baselineWidth-margin-width-(side==='left'?tailSize:0));
          const y=clamp(candidate.y,margin+(side==='bottom'?tailSize:0),screenPreset.baselineHeight-margin-height-(side==='top'?tailSize:0));
          const tail=clamp(vertical?point.x-x:point.y-y,corner,(vertical?width:height)-corner);
          const extent=extentOf({x,y,side});
          let essential=0,help=0;
          for(const obstacle of blocked){const area=overlapArea(obstacle.railBackground?{x,y,width,height}:extent,obstacle.rect);if(obstacle.help)help+=area;else essential+=area;}
          return {x,y,side,tail,targetOverlap:overlapArea(extent,target),essential,help};
        }).sort((a,b)=>a.targetOverlap-b.targetOverlap||a.essential-b.essential||a.help-b.help);
        const best=ranked[0]!;
        next={x:best.x,y:best.y,side:best.side,tail:best.tail,target:{...target},scrollable};
      }
      setGeometry(before=>JSON.stringify(before)===JSON.stringify(next)?before:next);
    };
    measure();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);observer?.observe(popup);if(props.anchorRef.current)observer?.observe(props.anchorRef.current);
    const mutations=new MutationObserver(measure);if(canvasElement)mutations.observe(canvasElement,{childList:true,subtree:true});
    window.addEventListener('resize',measure);window.visualViewport?.addEventListener('resize',measure);window.visualViewport?.addEventListener('scroll',measure);
    return()=>{observer?.disconnect();mutations.disconnect();window.removeEventListener('resize',measure);window.visualViewport?.removeEventListener('resize',measure);window.visualViewport?.removeEventListener('scroll',measure);};
  },[props.open,props.anchorRef,props.side,popup,screenPreset,transform,textScale,children,secondary,coachStep,canvasElement]);
  useEffect(()=>{
    const anchor=props.anchorRef.current;if(!props.open||!anchor)return;
    const ids=new Set((anchor.getAttribute('aria-describedby')??'').split(' ').filter(Boolean));ids.add(`${id}-text`);anchor.setAttribute('aria-describedby',[...ids].join(' '));
    return ()=>{const remaining=(anchor.getAttribute('aria-describedby')??'').split(' ').filter(value=>value&&value!==`${id}-text`);if(remaining.length)anchor.setAttribute('aria-describedby',remaining.join(' '));else anchor.removeAttribute('aria-describedby');};
  },[props.open,props.anchorRef,id]);
  const dismissButton = (event: MouseEvent<HTMLButtonElement>) => {
    consumeDismissSequence(event.nativeEvent);
    close('button', event.nativeEvent);
  };
  const content = <div className="ui-coach" data-coach-step={coachStep}>
    <div id={`${id}-text`} className="ui-coach-text" tabIndex={geometry?.scrollable ? 0 : undefined} role={geometry?.scrollable ? 'region' : undefined} aria-label={geometry?.scrollable ? (scrollLabel ?? t('ui.coach.scroll')) : undefined}>
      <p>{children}</p>{secondary ? <p className="ui-coach-secondary">{secondary}</p> : null}
    </div>
    {footer ? <IconButton label={closeLabel ?? t('ui.coach.close')} icon="close" variant="ghost" onClick={dismissButton} />
      : <ActionButton onClick={dismissButton}>{closeLabel ?? t('common.ok')}</ActionButton>}
  </div>;
  if(!portalContainer)return null;
  const side=geometry?.side??props.side??'bottom';
  const tailStyle={'--coach-tail-center':`${geometry?.tail??0}px`} as CSSProperties;
  return <Popover.Root open={props.open} modal={false} onOpenChange={(next,details)=>{if(!next){const target=details.event instanceof FocusEvent?details.event.relatedTarget:details.event.target;if(details.reason!=='escape-key'&&target instanceof Node&&props.anchorRef.current?.contains(target)){details.cancel();details.allowPropagation();return;}if(details.reason==='outside-press')details.allowPropagation();else consumeDismissSequence(details.event);close(details.reason==='escape-key'?'Esc':details.reason==='outside-press'?'outside':'button',details.event);}}}><Popover.Portal container={portalContainer}>
    {props.open&&geometry?<div className="ui-coach-target-highlight" data-coach-step={coachStep} aria-hidden="true" style={{left:geometry.target.x,top:geometry.target.y,width:geometry.target.width,height:geometry.target.height}}/>:null}
    <Popover.Positioner anchor={props.anchorRef} side={side} positionMethod="absolute" className="ui-popover-positioner ui-coach-positioner" data-coach-side={side} style={{left:geometry?.x??0,top:geometry?.y??0,transform:'none',visibility:geometry?'visible':'hidden'}}>
      <Popover.Popup onBlurCapture={event=>dismissOnFocusOut(event.nativeEvent,event.currentTarget,props.anchorRef.current,close)} ref={setPopup} id={id} className="ui-popover ui-popover--coach" role="note" aria-label={noteLabel??t('ui.coach.note')} data-has-footer={footer?'true':undefined} aria-hidden={!props.open||undefined} inert={!props.open||undefined} initialFocus={false} finalFocus={false} data-coach-side={side} style={tailStyle}>
        <svg className="ui-popover-arrow ui-coach-tail" data-side={side} viewBox="0 0 16 8" aria-hidden="true" focusable="false"><path className="ui-coach-tail-fill" d="M0 8 8 0 16 8Z"/><path className="ui-coach-tail-edge" d="M.5 8 8 .7 15.5 8"/></svg><span className="ui-coach-tail-join" aria-hidden="true"/>{content}{footer?<div className="ui-coach-footer-slot">{footer}</div>:null}
      </Popover.Popup>
    </Popover.Positioner>
  </Popover.Portal></Popover.Root>;
}

/** Optional bottom-row slot of a detail dialog: a module may put its own controls there instead of the default note. */
export interface DetailFooterSlot { readonly slot: HTMLElement | null; readonly claim: (on: boolean) => void }
export const DetailFooterContext = createContext<DetailFooterSlot | null>(null);
/** Renders children into the dialog's bottom row (replacing the note); inline when there is no such row. */
export function DetailFooterContent({ children }: { readonly children: ReactNode }) {
  const ctx = useContext(DetailFooterContext);
  const claim = ctx?.claim;
  useLayoutEffect(() => { claim?.(true); return () => claim?.(false); }, [claim]);
  if (!ctx) return <>{children}</>;
  return ctx.slot ? createPortal(children, ctx.slot) : null;
}
