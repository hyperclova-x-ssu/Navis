import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { createPortal } from 'react-dom';
import { useUi } from '../context';
import { useKitT } from '../kit-i18n';
import { layoutTokens, managementTokens, motionTokens } from '../motion';
import { consumeDismissSequence } from '../dismiss';
import { ActionButton } from './controls';
import { projectSpotlight } from './spotlight-geometry';

function useViewportRaster(){
  const read=()=>({width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio||1});
  const [viewport,setViewport]=useState(read);
  useLayoutEffect(()=>{
    const update=()=>setViewport(read()),resolution=window.matchMedia?.(`(resolution: ${viewport.dpr}dppx)`);
    window.addEventListener('resize',update);window.visualViewport?.addEventListener('resize',update);resolution?.addEventListener('change',update);
    return()=>{window.removeEventListener('resize',update);window.visualViewport?.removeEventListener('resize',update);resolution?.removeEventListener('change',update);};
  },[viewport.dpr]);
  return viewport;
}
export interface SpotlightRect {x:number;y:number;width:number;height:number}
export interface SpotlightMeasurement {mode:'move'|'instant';maxFrameMs:number;missedFrames:number;frames:readonly number[]}
export interface SpotlightProps {rect:SpotlightRect;/** M-202b can be selected by the host after device measurements. */instant?:boolean;onMeasured?:(measurement:SpotlightMeasurement)=>void}
export function Spotlight({rect,instant=false,onMeasured}:SpotlightProps){
  const {theme,screenPreset,reducedMotion,transform}=useUi(),viewport=useViewportRaster(),maskId=useId().replaceAll(':',''),hole=useRef<SVGGElement>(null),rings=useRef<SVGGElement>(null),previous=useRef<SpotlightRect|null>(null),animations=useRef<Animation[]>([]),[fallback,setFallback]=useState(false),measure=useRef(onMeasured);measure.current=onMeasured;
  const fit=transform??{scale:1,offsetX:0,offsetY:0},target=projectSpotlight(rect,fit,viewport.dpr),r=target.radius,w=target.lineWidth;
  const canvas=(p:SpotlightRect)=>({x:(p.x-fit.offsetX)/fit.scale,y:(p.y-fit.offsetY)/fit.scale,width:p.width/fit.scale,height:p.height/fit.scale}),aperture=canvas(target);
  const lastScale=useRef(`${transform?.scale}:${viewport.dpr}:${viewport.width}:${viewport.height}`);
  useLayoutEffect(()=>{
    const old=previous.current;previous.current=target;
    const nodes=[hole.current,rings.current].filter((n):n is SVGGElement=>!!n),active=animations.current;
    // Retarget from the actual displayed frame before cancelling an interrupted move.
    let from=old;
    if(old&&active.some(a=>a.playState==='running')&&rings.current&&typeof DOMMatrixReadOnly!=='undefined'){
      // The new rect attributes have already committed. Read only the active transform,
      // then apply it to the previous dimensions to recover the frame before that commit.
      const matrix=new DOMMatrixReadOnly(getComputedStyle(rings.current).transform);
      from={x:matrix.e,y:matrix.f,width:old.width*matrix.a,height:old.height*matrix.d};
    }
    active.forEach(a=>a.cancel());animations.current=[];
    const rasterKey=`${transform?.scale}:${viewport.dpr}:${viewport.width}:${viewport.height}`,resize=lastScale.current!==rasterKey;lastScale.current=rasterKey;
    if(!old||!from||instant||fallback||reducedMotion||resize||!nodes.every(n=>typeof n.animate==='function')){measure.current?.({mode:'instant',maxFrameMs:0,missedFrames:0,frames:[]});return;}
    const sx=from.width/target.width,sy=from.height/target.height;
    for(const node of nodes){
      const a=node===hole.current?canvas(from):from,b=node===hole.current?aperture:target;
      const start=`translate(${a.x}px,${a.y}px) scale(${sx},${sy})`,end=`translate(${b.x}px,${b.y}px)`;
      animations.current.push(node.animate([{transform:start},{transform:end}],{duration:motionTokens.duration.spotlight,easing:`cubic-bezier(${motionTokens.ease.inOut.join(',')})`}));
    }
    let frame=0,prev=0,started=0;const frames:number[]=[];
    const tick=(now:number)=>{if(!started)started=now;if(prev)frames.push(now-prev);prev=now;if(now-started<motionTokens.duration.spotlight){frame=requestAnimationFrame(tick);return;}const maxFrameMs=Math.max(0,...frames),missedFrames=frames.reduce((sum,ms)=>sum+Math.max(0,Math.round(ms/(1000/60))-1),0);measure.current?.({mode:'move',maxFrameMs,missedFrames,frames});if(maxFrameMs>33||missedFrames>2){animations.current.forEach(a=>a.cancel());setFallback(true);}};
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[target.x,target.y,target.width,target.height,instant,fallback,reducedMotion,transform?.scale,viewport.dpr,viewport.width,viewport.height]);
  useLayoutEffect(()=>{const finish=()=>{animations.current.forEach(a=>a.cancel());};window.addEventListener('resize',finish);return()=>{finish();window.removeEventListener('resize',finish);};},[]);
  return <>
    <svg data-spotlight="" data-motion-mode={instant||fallback||reducedMotion?'instant':'move'} aria-hidden="true" className="ui-spotlight" width={screenPreset.baselineWidth} height={screenPreset.baselineHeight} viewBox={`0 0 ${screenPreset.baselineWidth} ${screenPreset.baselineHeight}`} onPointerDown={e=>{e.preventDefault();e.stopPropagation();}} onClick={e=>{e.preventDefault();e.stopPropagation();}}>
      <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={screenPreset.baselineWidth} height={screenPreset.baselineHeight}><rect width="100%" height="100%" fill="white"/><g ref={hole} style={{transform:`translate(${aperture.x}px,${aperture.y}px)`,transformOrigin:'0 0'}}><rect width={aperture.width} height={aperture.height} rx={r/fit.scale} fill="black"/></g></mask></defs>
      <rect width="100%" height="100%" fill="var(--scrim)" mask={`url(#${maskId})`}/>
    </svg>
    {createPortal(<svg data-spotlight-rings="" data-theme={theme} data-reduced-motion={String(reducedMotion)} aria-hidden="true" className="ui-spotlight-rings" width={viewport.width} height={viewport.height} viewBox={`0 0 ${viewport.width} ${viewport.height}`}>
      <g ref={rings} style={{transform:`translate(${target.x}px,${target.y}px)`,transformOrigin:'0 0'}}>
        <rect data-spotlight-inner="" x={w/2} y={w/2} width={target.width-w} height={target.height-w} rx={r-w/2} fill="none" stroke="var(--spotlight-ring-inner)" strokeWidth={w}/>
        <rect data-spotlight-outer="" x={-w/2} y={-w/2} width={target.width+w} height={target.height+w} rx={r+w/2} fill="none" stroke="var(--spotlight-ring-outer)" strokeWidth={w}/>
      </g>
    </svg>,document.body)}
  </>;

}
const overlaps=(a:SpotlightRect,b:SpotlightRect)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
export function placeTourCard(target:SpotlightRect,size:{width:number;height:number},canvas:{width:number;height:number},avoid:readonly SpotlightRect[]=[]){
  const gap=layoutTokens.coachGap,margin=layoutTokens.margin;
  const candidates=[{x:target.x+(target.width-size.width)/2,y:target.y+target.height+gap,side:'bottom'},{x:target.x+(target.width-size.width)/2,y:target.y-gap-size.height,side:'top'},{x:target.x+target.width+gap,y:target.y+(target.height-size.height)/2,side:'right'},{x:target.x-gap-size.width,y:target.y+(target.height-size.height)/2,side:'left'}] as const;
  for(const candidate of candidates){const box={...candidate,x:Math.max(margin,Math.min(candidate.x,canvas.width-margin-size.width)),y:Math.max(margin,Math.min(candidate.y,canvas.height-margin-size.height)),...size};if(!overlaps(box,target)&&!avoid.some(a=>overlaps(box,a)))return {x:box.x,y:box.y,side:candidate.side};}
  return {x:Math.max(margin,Math.min(target.x+(target.width-size.width)/2,canvas.width-margin-size.width)),y:Math.max(margin,Math.min(target.y+target.height-margin-size.height,canvas.height-margin-size.height)),side:'inside' as const};
}
export interface TourCardProps {title:string;description:ReactNode;current:number;total:number;onNext:()=>void;onClose:()=>void;rect?:SpotlightRect;avoidRects?:readonly SpotlightRect[];returnFocusRef?:RefObject<HTMLElement|null>}
/** Base UI owns the sole tour modal/trap. Its inert surface includes the lit panel. */
export function TourCard({title,description,current,total,onNext,onClose,rect,avoidRects=[],returnFocusRef}:TourCardProps){
  const {portalContainer,screenPreset,reducedMotion}=useUi(),{t}=useKitT(),next=useRef<HTMLButtonElement>(null),card=useRef<HTMLDivElement>(null),[size,setSize]=useState<{width:number;height:number}>({width:managementTokens.tourWidth,height:managementTokens.tourMaxHeight});
  useLayoutEffect(()=>{if(!card.current)return;const node=card.current,read=()=>setSize({width:node.offsetWidth,height:node.offsetHeight});read();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(read);observer?.observe(node);return()=>observer?.disconnect();},[current]);
  if(!portalContainer)return null;
  const position=rect?placeTourCard({...rect,x:rect.x-managementTokens.spotlightPadding,y:rect.y-managementTokens.spotlightPadding,width:rect.width+2*managementTokens.spotlightPadding,height:rect.height+2*managementTokens.spotlightPadding},size,{width:screenPreset.baselineWidth,height:screenPreset.baselineHeight},avoidRects):{x:layoutTokens.margin,y:layoutTokens.margin,side:'inside'};
  const vertical=position.side==='top'||position.side==='bottom';
  const tail=rect?Math.max(layoutTokens.margin,Math.min((vertical?rect.x+rect.width/2-position.x:rect.y+rect.height/2-position.y),(vertical?size.width:size.height)-layoutTokens.margin)):layoutTokens.margin;
  return <Dialog.Root open modal disablePointerDismissal onOpenChange={(open,details)=>{if(!open){consumeDismissSequence(details.event);onClose();}}}><Dialog.Portal container={portalContainer}><Dialog.Popup ref={card} initialFocus={next} finalFocus={returnFocusRef??true} className="ui-tour-card" lang="ko" data-side={position.side} data-reduced={reducedMotion} style={{left:position.x,top:position.y,'--tour-tail-offset':`${tail}px`} as CSSProperties} aria-label={t('ui.tour.name',{name:title,total,current})}>
    {position.side!=='inside'?<svg aria-hidden="true" className="ui-tour-card__tail" width="16" height="8" viewBox="0 0 16 8"><path d="M0 8 8 0 16 8" fill="var(--popover)" stroke="var(--input)"/></svg>:null}
    {current===1?<p className="ui-tour-card__intro">{t('ui.tour.intro')}</p>:null}<Dialog.Title>{title}</Dialog.Title><div className="ui-tour-card__description" key={current}>{description}</div><footer><span>{t('ui.tour.progress',{current,total})}</span><ActionButton variant="secondary" onClick={onClose}>{t('ui.coach.close')}</ActionButton><ActionButton ref={next} onClick={onNext}>{t(current===total?'ui.kit.confirm':'ui.kit.next')}</ActionButton></footer>
  </Dialog.Popup></Dialog.Portal></Dialog.Root>;
}
/** Public rects and modal layering stay in canvas coordinates; only the two rings escape its scale. */
export function TourLayer({rect,children,...props}:SpotlightProps & {children:ReactNode}){const {portalContainer}=useUi();return portalContainer?createPortal(<div className="ui-tour-layer"><Spotlight rect={rect} {...props}/>{children}</div>,portalContainer):null;}
