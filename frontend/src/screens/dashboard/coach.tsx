import {useMemo,useRef,type RefObject} from 'react';
import type {CoachStep,FeatureId,RunStore} from '../../contracts';
import {CoachFooter,CoachMark,WidgetCoach,type CloseReason} from '../../ui';
import {useRun} from './use-run';
import {useDashboardT} from './use-dashboard-t';

const isEmptyGrid=(target:Element)=>target.matches('.dashboard-grid-bounds,.ui-grid-cell,.ui-dashboard-grid,.dashboard-grid-drop,.dashboard-page-layer');
/**
 * Counts one coach sequence (SCR-41): F-03 steps and widget explanations share the queue, so '{current}/{total}'
 * runs over both. A sequence ends when nothing is visible or queued.
 */
function useSequence(visibleKey:string|null,remaining:number){
 const seq=useRef<{shown:number;key:string|null}>({shown:0,key:null});
 if(visibleKey&&visibleKey!==seq.current.key)seq.current={shown:seq.current.shown+1,key:visibleKey};
 if(!visibleKey&&!remaining)seq.current={shown:0,key:null};
 return {current:seq.current.shown,total:seq.current.shown+remaining};
}
export interface DashboardCoachesProps {readonly run:RunStore;readonly nodes:Map<FeatureId,HTMLElement>;readonly recommendNode:HTMLElement|null;readonly onFinishEditing:()=>void}
/** F-03 coach marks and the widget coach (first explanation or the (?) help), one visible at a time (SCR-27). */
export function DashboardCoaches({run,nodes,recommendNode,onFinishEditing}:DashboardCoachesProps){
 const s=useRun(run),{t,name}=useDashboardT(),g=s.guidance;
 const help=s.widgetHelp?.origin==='panel'?s.widgetHelp.featureId:null;
 const widget=help??g.activeWidget;
 const remaining=g.queue.length+g.widgetQueue.length;
 const {current,total}=useSequence(g.active??(g.activeWidget?`w:${g.activeWidget}`:null),remaining);
 // A step that cannot show yet (resize needs edit mode after the move tip) is not "next": the walk must not end on a button that leads nowhere.
 const reachable=(step:CoachStep)=>step==='choose-feature'||s.panels.length>0&&(step==='resize-panel'?s.edit.mode==='edit'&&g.coach['move-panel']==='dismissed':s.edit.mode==='view');
 const more=g.queue.filter(reachable).length+g.widgetQueue.length;
 // One footer for every tip of a sequence of two or more: counter, skip-all, and the primary "next" (the last tip: "OK").
 // A single tip has no footer and uses the kit's confirmation button (D-326 Q14).
 // Next is the same call as the close X; a tip still advances by itself when its action is done.
 const queue=total>=2?{current,total,onSkipAll:run.actions.skipWidgetCoaches,onNext:()=>{run.actions.dismissCoach();},nextLabel:t('dashboard.coach.next'),last:more===0}:undefined;
 const stepAnchor:RefObject<HTMLElement|null>=useMemo(()=>({get current(){return g.targetFeatureId?nodes.get(g.targetFeatureId)??null:recommendNode;}}),[g.targetFeatureId,nodes,recommendNode]);
 const widgetAnchor:RefObject<HTMLElement|null>=useMemo(()=>({get current(){return widget?nodes.get(widget)??null:null;}}),[widget,nodes]);
 const closeStep=(reason:CloseReason,event?:Event)=>{
  // A coach may appear as soon as a cancelled contact ends. Its outside-press dismissal consumes the click,
  // so explicit edit-exit actions (Done, empty grid) still finish editing.
  const target=event?.target;
  if(reason==='outside'&&target instanceof Element&&(target.closest('.ui-edit-toolbar button')||isEmptyGrid(target)))onFinishEditing();
  run.actions.dismissCoach();
 };
 const stepText=g.active==='choose-feature'?t('dashboard.coach.choose'):g.active==='resize-panel'?t('dashboard.coach.resize'):t('dashboard.coach.move');
 return <>
  <CoachMark coachStep={g.active??undefined} side={g.active==='choose-feature'?'left':'bottom'} open={Boolean(g.active)&&!help} anchorRef={stepAnchor} onClose={closeStep} closeLabel={g.active&&queue?t('dashboard.coach.close'):undefined} noteLabel={t('dashboard.coach.note')} scrollLabel={t('dashboard.coach.scroll')} secondary={g.active==='choose-feature'?t('ui.drawer.footer2'):undefined} footer={g.active&&queue?<CoachFooter {...queue}/>:undefined}>{stepText}</CoachMark>
  <WidgetCoach open={Boolean(widget)&&Boolean(nodes.get(widget!))} anchorRef={widgetAnchor} side="bottom" title={widget?name(widget):''} queue={help?undefined:queue}
   onClose={(reason,event)=>{if(help)run.actions.closeWidgetHelp();else closeStep(reason,event);}}>{widget?t(`widget.${widget}.coach`):''}</WidgetCoach>
 </>;
}
