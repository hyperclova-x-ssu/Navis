import { useEffect, useLayoutEffect, useEffectEvent, useId, useRef, type CSSProperties, type Ref } from 'react';
import { Toaster, toast } from 'sonner';
import { createPortal } from 'react-dom';
import type { Notice, UndoPauseReason } from '../../contracts';
import { koreanScreenText, type Translator } from '../../i18n';
import { useUi } from '../context';
import { formatNotice, objectParticle } from '../copy';
import { useKitT } from '../kit-i18n';
import { Icon } from '../icons';
import { ActionButton } from './controls';
import { layoutTokens } from '../motion';

interface AvoidRect {readonly x:number;readonly y:number;readonly width:number;readonly height:number}
export interface NoticeHostProps { readonly notice:Notice|null;/** Optional translator for widget `data.*` notice keys (with their params). Kit keys always use the kit translator. */readonly translator?:Translator;readonly featureLabel?:string;readonly aiResult?:{readonly added:number;readonly other:number;readonly onView:()=>void};readonly onUndo?:(token:string)=>void;/** Called instead of onUndo when notice.undo.target is 'data'. */readonly onDataUndo?:(token:string)=>void;readonly onPause?:(reason:UndoPauseReason)=>void;readonly onResume?:(reason:UndoPauseReason)=>void;/** Protected controls in logical canvas coordinates. */readonly avoidRects?:readonly AvoidRect[] }
function PlacedNoticeFrame({ref,...props}:NoticeHostProps & {readonly notice:Notice;readonly ref:Ref<HTMLDivElement>}){
  const frame=useRef<HTMLDivElement|null>(null);const {layout,screenPreset}=useUi();
  useLayoutEffect(()=>{
    const node=frame.current,list=node?.closest<HTMLElement>('[data-sonner-toaster]');if(!node||!list)return;
    const place=()=>{
      if(node.hasAttribute('inert'))return;
      // offset sizes exclude canvas fit and the existing toast enter transform.
      const width=node.offsetWidth,height=node.offsetHeight,{grid}=layout,margin=layoutTokens.margin;
      const center=grid.x+(grid.width-width)/2,bottom=grid.y+grid.height-margin-height;
      const candidates=[{x:center,y:bottom},{x:grid.x+margin,y:bottom},{x:grid.x+grid.width-margin-width,y:bottom}];
      // A detail window's bottom row (its [이전]·[다음] / note) must stay pressable: lift the toast above that row while the window is open.
      const parent=list.offsetParent as HTMLElement|null;const row=document.querySelector<HTMLElement>('.ui-overlay-note');
      let lifted:number|null=null;
      if(parent&&row&&row.getClientRects().length>0){
        const pr=parent.getBoundingClientRect(),rr=row.getBoundingClientRect(),scale=parent.offsetWidth>0?pr.width/parent.offsetWidth:1;
        const rowTop=(rr.top-pr.top)/(scale||1);
        if(bottom+height>rowTop-margin/2)lifted=rowTop-margin/2-height;
      }
      const measured=(selector:string):AvoidRect[]=>Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(element=>element.getClientRects().length>0||element.getBoundingClientRect().width>0).map(element=>{
        const bounds=element.getBoundingClientRect(),origin=parent?.getBoundingClientRect();
        const scale=parent&&origin&&parent.offsetWidth>0?origin.width/parent.offsetWidth:1;
        return {x:(bounds.x-(origin?.x??0))/(scale||1),y:(bounds.y-(origin?.y??0))/(scale||1),width:bounds.width/(scale||1),height:bounds.height/(scale||1)};
      });
      const header=measured('.app-layer-navigation,.dashboard-header>div:first-child:not(.ui-edit-toolbar),.dashboard-header-actions,.ui-edit-toolbar>*');
      const obstacles=[...(props.avoidRects??[]),...header,...measured('.ui-page-bar,.dashboard-empty-start')];
      const overlaps=(candidate:{x:number;y:number})=>obstacles.some(rect=>candidate.x<rect.x+rect.width&&candidate.x+width>rect.x&&candidate.y<rect.y+rect.height&&candidate.y+height>rect.y);
      // Try actual header gaps around the title, tabs and actions; if none can fit,
      // search the grid below the header instead of covering a control.
      const safe=candidates.find(candidate=>!overlaps(candidate));
      const headerX=[center,margin,...header.map(rect=>rect.x+rect.width+margin/2),...header.map(rect=>rect.x-width-margin/2)];
      const headerSafe=headerX.map(x=>({x,y:margin})).find(candidate=>candidate.x>=margin&&candidate.x+width<=screenPreset.baselineWidth-margin&&!overlaps(candidate));
      const gridY=[grid.y,grid.y+(grid.height-height)/2,...obstacles.map(rect=>rect.y-height-margin/2),...obstacles.map(rect=>rect.y+rect.height+margin/2)];
      const gridSafe=gridY.flatMap(y=>[center,grid.x+margin,grid.x+grid.width-margin-width].map(x=>({x,y}))).find(candidate=>candidate.y>=grid.y&&candidate.y+height<=grid.y+grid.height&&!overlaps(candidate));
      const position=lifted!==null?{x:center,y:lifted}:safe??headerSafe??gridSafe??{x:center,y:Math.max(grid.y,...header.map(rect=>rect.y+rect.height+margin/2))};
      // Keep Sonner's list and toast identity/motion; only move its anchor.
      Object.assign(list.style,{left:`${position.x}px`,right:'auto',top:'auto',bottom:`${screenPreset.baselineHeight-position.y-height}px`,transform:'none'});
    };
    place();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(place);observer?.observe(node);for(const element of document.querySelectorAll('.dashboard-header,.app-layer-navigation,.ui-page-bar'))observer?.observe(element);window.addEventListener('resize',place);
    const watch=typeof MutationObserver==='undefined'?null:new MutationObserver(place);watch?.observe(document.body,{childList:true,subtree:true});
    return()=>{window.removeEventListener('resize',place);observer?.disconnect();watch?.disconnect();};
  },[props.avoidRects,props.notice,layout,screenPreset]);
  return <NoticeFrame {...props} ref={node=>{frame.current=node;if(typeof ref==='function')return ref(node);if(ref)ref.current=node;}}/>;
}
/** LOCALES writes some sentences with the Undo word at the end ('… · 되돌리기'); the Undo button itself follows, so the word is not read twice. */
function withoutUndoSuffix(text:string,undo:string,button:boolean):string{const suffix=new RegExp(`[\\s\\u00a0]+·[\\s\\u00a0]+${undo}$`);return button?text.replace(suffix,''):text;}
export function NoticeFrame({notice,translator,featureLabel,aiResult,onUndo,onDataUndo,onPause,onResume,ref}:NoticeHostProps & {readonly notice:Notice;readonly ref?:Ref<HTMLDivElement>}){
  const kt=useKitT();const isData=notice.undo?.target==='data';const undoHandler=isData?onDataUndo??onUndo:onUndo;const undoToken=isData?notice.undo?.token??notice.undoToken:notice.undoToken;const pointer=useRef<number|null>(null);const focused=useRef(false);
  const undoButton=Boolean(undoHandler&&undoToken);
  const layoutChange=kt.locale==='ko'&&(notice.messageKey==='move'||notice.messageKey==='resize')&&Boolean(notice.panel);
  const coordinate=layoutChange?formatNotice(notice,featureLabel,kt).replace(/\.$/,''):'';
  const visibleLayout=layoutChange?`${featureLabel??kt.t('ui.notice.panelFallback')}${notice.messageKey==='move'?objectParticle(featureLabel??kt.t('ui.notice.panelFallback'))+' 옮겼어요':' 크기를 바꿨어요'}`:null;
  const message=visibleLayout??(aiResult?`${aiResult.added===1&&featureLabel?kt.t('ui.notice.aiOne',{label:featureLabel}):kt.t('ui.notice.aiMany',{n:aiResult.added})}${aiResult.other?kt.t('ui.notice.aiOther',{n:aiResult.other}):``}`:withoutUndoSuffix(translator&&translator.has(notice.messageKey)?translator.t(notice.messageKey,notice.params):formatNotice(notice,featureLabel,kt),kt.t('common.undo'),undoButton));
  const resume=useEffectEvent((reason:UndoPauseReason)=>onResume?.(reason));
  useEffect(()=>{
    const release=(event:PointerEvent)=>{if(pointer.current!==null&&(event.pointerId===pointer.current||event.type==='pointercancel')){pointer.current=null;resume('toast-touch');}};
    document.addEventListener('pointerup',release,true);document.addEventListener('pointercancel',release,true);
    return ()=>{document.removeEventListener('pointerup',release,true);document.removeEventListener('pointercancel',release,true);if(pointer.current!==null)resume('toast-touch');if(focused.current)resume('toast-focus');};
  },[]);
  return <div ref={ref} className="ui-notice" data-kind={notice.kind} role={layoutChange?undefined:notice.kind==='error'?'alert':'status'} aria-live={layoutChange?'off':notice.kind==='error'?'assertive':'polite'} aria-atomic="true" onFocusCapture={()=>{focused.current=true;onPause?.('toast-focus');}} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget)){focused.current=false;onResume?.('toast-focus');}}} onPointerDownCapture={event=>{if(pointer.current===null){pointer.current=event.pointerId;onPause?.('toast-touch');}}}><Icon name={notice.kind==='error'?'error':'check'}/><span className="ui-notice__message" aria-hidden={layoutChange||undefined}>{kt.locale==='ko'?koreanScreenText(message):message}</span>{layoutChange?<span className="ui-sr-only" role="status" aria-live="polite">{coordinate}</span>:null}{aiResult?.other?<ActionButton variant="outline" onClick={aiResult.onView}>{kt.t('ui.notice.aiView')}</ActionButton>:null}{undoButton&&undoHandler&&undoToken?<ActionButton variant="outline" onClick={()=>undoHandler(undoToken)}>{kt.t('common.undo')}</ActionButton>:null}</div>;
}
/** Controlled by RunState. Sonner never competes with the state-owned expiry timer. */
export function NoticeHost({notice,translator,featureLabel,aiResult,onUndo,onDataUndo,onPause,onResume,avoidRects}:NoticeHostProps){
  const kt=useKitT();const {theme,portalContainer}=useUi();const id=useId();const toaster=useRef<HTMLElement|null>(null);
  useLayoutEffect(()=>{toaster.current?.setAttribute('aria-live','off');});
  const frames=useRef(new Map<string,HTMLDivElement>());
  // Undo expiry changes on pause/resume; its token identifies the same lifetime.
  // Other notices keep their state-owned deadline for their entire lifetime.
  const toastId=notice?`${id}:${notice.id}`:null;
  const currentToast=useRef<string|null>(toastId);
  useEffect(()=>{
    if(notice&&toastId)toast.custom(()=> <PlacedNoticeFrame translator={translator} onDataUndo={onDataUndo} ref={node=>{if(node){frames.current.set(toastId,node);if(currentToast.current!==toastId){node.setAttribute('inert','');node.setAttribute('aria-hidden','true');}}else frames.current.delete(toastId);}} notice={notice} featureLabel={featureLabel} aiResult={aiResult} onUndo={onUndo} onPause={onPause} onResume={onResume} avoidRects={avoidRects}/>,{id:toastId,toasterId:id,duration:Infinity,dismissible:false,unstyled:true});
  },[notice,translator,featureLabel,aiResult,onUndo,onDataUndo,onPause,onResume,id,toastId,avoidRects]);
  useEffect(()=>{
    currentToast.current=toastId;
    if(!toastId)return;
    const nodes=frames.current;
    return ()=>{
      currentToast.current=null;
      // Sonner owns the asynchronous exit. Retire its snapshot immediately so
      // an old Undo cannot receive input or remain in the accessibility tree.
      const frame=nodes.get(toastId);if(frame){frame.setAttribute('inert','');frame.setAttribute('aria-hidden','true');}
      toast.dismiss(toastId);
    };
  },[toastId]);
  if(!portalContainer)return null;
  return createPortal(<Toaster ref={toaster} id={id} className="ui-sonner" theme={theme} position="bottom-center" visibleToasts={1} duration={Infinity} hotkey={[]} swipeDirections={[]} expand offset="var(--layout-margin)" containerAriaLabel={kt.t('ui.notice.region')} customAriaLabel={kt.t('ui.notice.region')} style={{'--width':'var(--toast-max-width)'} as CSSProperties} toastOptions={{unstyled:true,duration:Infinity}}/>,portalContainer);
}
