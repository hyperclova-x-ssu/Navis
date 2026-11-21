import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RunStore } from '../contracts';
import { selectTemplateTour, type PresentationRunStore } from '../state';
import { TourCard, TourLayer, toCanvasRect, useUi, type SpotlightRect } from '../ui';
import { useI18n } from '../i18n';
/** Logical canvas rectangles are measured after the template has settled. */
export function TemplateTour({run}:{run:RunStore}) {
 const state=useSyncExternalStore(run.subscribe,run.getState),tour=selectTemplateTour(state),{transform}=useUi(),{t}=useI18n();
 const [rect,setRect]=useState<SpotlightRect>({x:0,y:0,width:0,height:0});
 const target=tour?.targetFeatureId;
 const returnFocus=useRef<HTMLElement|null>(null);
 useLayoutEffect(()=>{
  if(!target)return;
  const node=document.querySelector<HTMLElement>(`[data-feature-id="${target}"]`);
  returnFocus.current=document.getElementById(`panel:${target}`);
  const measure=()=>{const box=node?.getBoundingClientRect();if(box&&transform)setRect(toCanvasRect(box,transform));};
  measure();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);if(node)observer?.observe(node);window.addEventListener('resize',measure);
  return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
 },[target,transform]);
 useLayoutEffect(()=>{
  if(!tour)return;
  const key=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();(run as PresentationRunStore).actions.closeTemplateTour({kind:'keyboard',id:event.code||event.key});}
   else if(event.key==='Enter'&&!event.repeat){event.preventDefault();event.stopImmediatePropagation();run.actions.nextTemplateTour();}
  };
  document.addEventListener('keydown',key,true);return()=>document.removeEventListener('keydown',key,true);
 },[run,Boolean(tour)]);
 if(!tour)return null;
 return <TourLayer rect={rect}><TourCard title={t(`widget.${tour.targetFeatureId}.title`)} description={t(tour.coachKey)} current={tour.current} total={tour.total} rect={rect} onNext={run.actions.nextTemplateTour} onClose={()=>run.actions.closeTemplateTour()} returnFocusRef={returnFocus}/></TourLayer>;
}
