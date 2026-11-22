import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RunStore } from '../contracts';
import { selectTemplateTour, type PresentationRunStore } from '../state';
import { TourCard, TourLayer, toCanvasRect, useUi, type SpotlightRect } from '../ui';
import { useI18n } from '../i18n';
import { useDashboardT } from '../screens/dashboard/use-dashboard-t';
/** Logical canvas rectangles are measured after the template has settled. */
export function TemplateTour({run}:{run:RunStore}) {
 const state=useSyncExternalStore(run.subscribe,run.getState),tour=selectTemplateTour(state),{transform}=useUi(),{t}=useI18n();
 const {t:dashboardText}=useDashboardT();
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
   if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if((run as PresentationRunStore).actions.closeTemplateTour({kind:'keyboard',id:event.code||event.key}))run.actions.skipWidgetCoaches();}
   else if(event.key==='Enter'&&!event.repeat){event.preventDefault();event.stopImmediatePropagation();run.actions.nextTemplateTour();if(!selectTemplateTour(run.getState()))run.actions.skipWidgetCoaches();}
  };
  document.addEventListener('keydown',key,true);return()=>document.removeEventListener('keydown',key,true);
 },[run,Boolean(tour)]);
 if(!tour)return null;
 const last=tour.current===tour.total;
 return <TourLayer rect={rect}><TourCard title={t(`widget.${tour.targetFeatureId}.title`)} description={<>{t(tour.coachKey)}{last?<p>{dashboardText('dashboard.coach.chooseFromRecommendations')} {dashboardText('ui.drawer.footer2')}<br/>{dashboardText('dashboard.coach.move')}<br/>{dashboardText('dashboard.coach.resize')}</p>:null}</>} current={tour.current} total={tour.total} rect={rect} onNext={()=>{run.actions.nextTemplateTour();if(last)run.actions.skipWidgetCoaches();}} onClose={()=>{if(run.actions.closeTemplateTour())run.actions.skipWidgetCoaches();}} returnFocusRef={returnFocus}/></TourLayer>;
}
