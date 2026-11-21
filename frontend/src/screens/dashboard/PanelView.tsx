import {useCallback,useLayoutEffect,useMemo,useRef,type KeyboardEvent} from 'react';
import {useDraggable} from '@dnd-kit/core';
import {AnimatePresence} from 'motion/react';
import type {CellSpan,DashboardLayerId,DetailRef,FeatureId,Panel,QueryCondition,RunStore} from '../../contracts';
import {getRegistration} from '../../catalog';
import {ContentRecovery,FeaturePanel,FlyInFrame,PanelMotionFrame,RemoveButton,ResizeHandle,panelLayoutId,panelShape} from '../../ui';
import {createWidgetHost,useWidgetModule,useWidgetSummary,useWidgetTapTarget} from '../../features/widgets/registry-context';
import {useWidgetView} from '../../data/react';
import type {ActiveGesture,DashboardController,FlightPlan} from './controller';
import {panelFocusKey,placementRect,type Rect} from './gestures';
import type {PresentationRunStore} from '../../state';
import {useRun} from './use-run';
import {useDashboardT} from './use-dashboard-t';

const DEFAULT_CONDITION:QueryCondition=Object.freeze({kind:'default'});
/** plan-2 panels hold one PanelAction: their title and body flow top to bottom (DS 11.9.2). */
const planTwo:ReadonlySet<FeatureId>=new Set<FeatureId>(['marketing-today','slot-coupon','expiry-coupon','promo-video','coupon-status','customer-groups','marketing-performance']);
export interface TapEntry {readonly owner:object;readonly target:DetailRef|null}
export interface PanelViewProps {
 readonly panel:Panel;readonly layer:DashboardLayerId;readonly run:RunStore;readonly controller:DashboardController;readonly active:ActiveGesture|null;readonly nodes:Map<FeatureId,HTMLElement>;
 readonly assembling?:boolean;readonly assemblyReady?:boolean;
 readonly flight?:FlightPlan;readonly lastFlight:boolean;readonly bounds:Rect|null;readonly onTools:(id:FeatureId)=>void;
 readonly onFlightSettled?:()=>void;
 readonly highlighted:boolean;readonly created:boolean;readonly waiting:boolean;
 /** What a short press opens, from the module (API-13 v4.1); read by the controller's openPanel. */
 readonly tapTargets:Map<FeatureId,TapEntry>;
}
export function PanelView({panel,layer,run,controller,active,nodes,flight,lastFlight,bounds,onTools,onFlightSettled,highlighted,created,waiting,tapTargets,assembling=false,assemblyReady=true}:PanelViewProps){
 const s=useRun(run),{name}=useDashboardT();
 const featureId=panel.featureId,condition=panel.condition??DEFAULT_CONDITION,label=name(featureId),groupId=getRegistration(featureId)?.groupId??'recommended';
 const module=useWidgetModule(featureId),summary=useWidgetSummary(featureId,condition),tapTarget=useWidgetTapTarget(featureId,condition);
 // An example state (empty or error, DS 11.5) flows top to bottom like plan-2 panels so its action keeps its margin at 1x1 and 125% (T-049 hand-over).
 const stateShown=useWidgetView(featureId,condition).status!=='ready';
 const owner=useRef({});
 useLayoutEffect(()=>{const entry={owner:owner.current,target:tapTarget};tapTargets.set(featureId,entry);return()=>{if(tapTargets.get(featureId)?.owner===entry.owner)tapTargets.delete(featureId);};},[tapTargets,featureId,tapTarget]);
 const host=useMemo(()=>createWidgetHost(run,{featureId,layer,focusKey:panelFocusKey(featureId)}),[run,featureId,layer]);
 const {setNodeRef,setActivatorNodeRef,listeners,attributes}=useDraggable({id:`panel-${featureId}`,data:{source:'panel',featureId}});
 const {setNodeRef:setResizeNode,listeners:resizeListeners}=useDraggable({id:`resize-${featureId}`,data:{source:'resize',featureId},disabled:s.edit.mode!=='edit'});
 // The same widget can be in an exiting page layer (M-19) and the arriving one: only the owner of the entry removes it.
 const own=useRef<HTMLElement|null>(null);
 const setNode=useCallback((node:HTMLElement|null)=>{setNodeRef(node);if(node){own.current=node;nodes.set(featureId,node);}else{if(nodes.get(featureId)===own.current)nodes.delete(featureId);own.current=null;}},[setNodeRef,nodes,featureId]);
 const editing=s.edit.mode==='edit',dragging=active?.source==='panel'&&active.featureId===featureId;
 const key=(event:KeyboardEvent<HTMLButtonElement>)=>{
  if(event.key==='Enter'&&event.shiftKey){event.preventDefault();run.actions.enterEditing();run.actions.selectPanel(featureId);onTools(featureId);return;}
  if(!editing)return;
  const direction=event.key==='ArrowLeft'?{column:-1,row:0}:event.key==='ArrowRight'?{column:1,row:0}:event.key==='ArrowUp'?{column:0,row:-1}:event.key==='ArrowDown'?{column:0,row:1}:null;
  if(direction){event.preventDefault();run.actions.selectPanel(featureId);if(event.ctrlKey||event.metaKey)controller.resize(featureId,{width:Math.max(1,Math.min(4,panel.width+direction.column)),height:Math.max(1,Math.min(4,panel.height+direction.row))});else controller.moveCell(featureId,direction);}
  else if(event.key==='Escape'){event.preventDefault();controller.cancel();}else if(event.key==='Enter'){event.preventDefault();run.actions.selectPanel(featureId);onTools(featureId);}
 };
 const Body=module?.Panel;
 const flying=Boolean(flight&&bounds&&(!assembling||assemblyReady));
 // PageLayer's initial=false must suppress the page entrance only. A fresh
 // local presence lets explicit placements fly and keeps restored panels still.
 const entranceKey=s.templateTour?`template:${s.templateTour.applyToken}:${Boolean(assemblyReady&&bounds)}`:'panel';
 const content=Body?<ContentRecovery resetKey={`${featureId}:${panel.width}x${panel.height}:${s.locale}`}><Body featureId={featureId} condition={condition} width={panel.width as CellSpan} height={panel.height as CellSpan} shape={panelShape(panel.width,panel.height)} presetId={s.screenPreset.id} editing={editing} host={host}/></ContentRecovery>:null;
 return <PanelMotionFrame panel={panel} layoutId={panelLayoutId(featureId)} style={{opacity:dragging||assembling&&!assemblyReady?0:1}} transitionKind={!s.gesturePreview&&s.notice?.featureId===featureId&&s.notice.messageKey==='resize'?'snap':'layout'} onSettled={()=>{if(!assembling&&!flight&&!run.getState().gesturePreview&&run.getState().layoutRevision===s.layoutRevision)(run as PresentationRunStore).actions.visualSettled({runId:s.runId,transitionToken:s.transitionToken});}}>
  <AnimatePresence key={entranceKey} initial={flying}>
  <FlyInFrame key="panel" fromRect={flying?flight?.sourceRect:undefined} toRect={flying&&bounds?placementRect(bounds,panel,s.screenPreset.grid):undefined} index={flight?.index??0} stagger={flight?.stagger} onSettled={()=>{if(flying&&flight&&lastFlight&&run.getState().runId===s.runId&&run.getState().layoutRevision===flight.revision&&!run.getState().gesturePreview){if(!assembling)(run as PresentationRunStore).actions.visualSettled({runId:s.runId,transitionToken:s.transitionToken});onFlightSettled?.();}}}>
   <FeaturePanel className={created?'dashboard-ai-created':undefined} ref={setNode} featureId={featureId} label={label} title={label} groupId={groupId} width={panel.width} height={panel.height} editing={editing} selected={s.edit.selectedFeatureId===featureId} highlighted={highlighted}
    interactive={tapTarget!==null} row={panel.row+1} column={panel.column+1} summary={summary} waiting={waiting} flow={planTwo.has(featureId)||stateShown}
    onHelp={()=>{if(run.getState().guidance.activeWidget===featureId)run.actions.dismissCoach();run.actions.openWidgetHelp(featureId,'panel',panelFocusKey(featureId));}}
    interactionProps={{...attributes,...listeners,ref:setActivatorNodeRef,id:panelFocusKey(featureId),'aria-keyshortcuts':'Shift+Enter ArrowLeft ArrowRight ArrowUp ArrowDown Control+ArrowLeft Control+ArrowRight Control+ArrowUp Control+ArrowDown Meta+ArrowLeft Meta+ArrowRight Meta+ArrowUp Meta+ArrowDown',onKeyDown:key,onContextMenu:e=>e.preventDefault(),onClick:e=>{if(e.detail===0)controller.tap({source:'panel',featureId},{x:0,y:0},{x:0,y:0,width:0,height:0});}}}
    controls={<><RemoveButton label={label} onClick={()=>controller.remove(featureId)}/><ResizeHandle {...resizeListeners} ref={setResizeNode} label={label} width={panel.width} height={panel.height} onClick={e=>{if(e.detail===0)onTools(featureId);}}/></>}>
    {content}
   </FeaturePanel>
  </FlyInFrame>
  </AnimatePresence>
 </PanelMotionFrame>;
}
