import {memo,useCallback,useLayoutEffect,useMemo,useRef,useSyncExternalStore,type KeyboardEvent} from 'react';
import {useDraggable} from '@dnd-kit/core';
import {AnimatePresence} from 'motion/react';
import type {CellSpan,DashboardLayerId,DetailRef,FeatureId,GridSpec,Locale,Panel,QueryCondition,RunState,RunStore,ScreenPresetId} from '../../contracts';
import {getRegistration} from '../../catalog';
import {ContentRecovery,FeaturePanel,FlyInFrame,PanelMotionFrame,RemoveButton,ResizeHandle,panelLayoutId,panelShape} from '../../ui';
import {createWidgetHost,useWidgetModule,useWidgetSummary,useWidgetTapTarget} from '../../features/widgets/registry-context';
import {useWidgetView} from '../../data/react';
import type {ActiveGesture,DashboardController,FlightPlan} from './controller';
import {panelFocusKey,placementRect,type Rect} from './gestures';
import type {PresentationRunStore} from '../../state';
import {useDashboardT} from './use-dashboard-t';

const DEFAULT_CONDITION:QueryCondition=Object.freeze({kind:'default'});
/** plan-2 panels hold one PanelAction: their title and body flow top to bottom (DS 11.9.2). */
const planTwo:ReadonlySet<FeatureId>=new Set<FeatureId>(['marketing-today','slot-coupon','expiry-coupon','promo-video','coupon-status','customer-groups']);
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
/** The few store fields one panel shows. A drag preview, a notice for another widget or a different selection must not re-render this panel's widget body. */
interface PanelSlice {readonly editing:boolean;readonly snapNotice:boolean;readonly selected:boolean;readonly runId:string;readonly transitionToken:string;readonly layoutRevision:number;readonly locale:Locale;readonly presetId:ScreenPresetId;readonly grid:GridSpec;readonly tour:string|null}
const pickSlice=(featureId:FeatureId)=>(s:RunState):PanelSlice=>({editing:s.edit.mode==='edit',snapNotice:!s.gesturePreview&&s.notice?.featureId===featureId&&s.notice.messageKey==='resize',selected:s.edit.selectedFeatureId===featureId,runId:s.runId,transitionToken:s.transitionToken,layoutRevision:s.layoutRevision,locale:s.locale,presetId:s.screenPreset.id,grid:s.screenPreset.grid,tour:s.templateTour?`template:${s.templateTour.applyToken}`:null});
const sameSlice=(a:PanelSlice,b:PanelSlice)=>{for(const key of Object.keys(a) as (keyof PanelSlice)[])if(!Object.is(a[key],b[key]))return false;return true;};
/** useSyncExternalStore over a selection: the snapshot keeps its identity while the selected fields are equal. */
function useRunSlice<T>(run:RunStore,select:(s:RunState)=>T,equal:(a:T,b:T)=>boolean):T{
 const cache=useRef<{readonly state:RunState;readonly value:T}|null>(null);
 const snapshot=useCallback(()=>{const state=run.getState(),before=cache.current;if(before?.state===state)return before.value;const value=select(state);const kept=before&&equal(before.value,value)?before.value:value;cache.current={state,value:kept};return kept;},[run,select,equal]);
 return useSyncExternalStore(run.subscribe,snapshot,snapshot);
}
const samePanel=(a:Panel,b:Panel)=>a===b||a.featureId===b.featureId&&a.column===b.column&&a.row===b.row&&a.width===b.width&&a.height===b.height&&(a.condition===b.condition||JSON.stringify(a.condition)===JSON.stringify(b.condition));
const sameProps=(a:PanelShellProps,b:PanelShellProps)=>{for(const key of Object.keys(a) as (keyof PanelShellProps)[]){if(key==='panel'?!samePanel(a.panel,b.panel):!Object.is(a[key],b[key]))return false;}return true;};

interface PanelContentProps {readonly Body:NonNullable<ReturnType<typeof useWidgetModule>>['Panel'];readonly featureId:FeatureId;readonly condition:QueryCondition;readonly width:number;readonly height:number;readonly presetId:ScreenPresetId;readonly editing:boolean;readonly locale:Locale;readonly host:ReturnType<typeof createWidgetHost>}
/** The widget body only re-renders when its own inputs change, not when its panel moves to another cell or another panel is dragged. */
const PanelContent=memo(function PanelContent({Body,featureId,condition,width,height,presetId,editing,locale,host}:PanelContentProps){
 return <ContentRecovery resetKey={`${featureId}:${width}x${height}:${locale}`}><Body featureId={featureId} condition={condition} width={width as CellSpan} height={height as CellSpan} shape={panelShape(width,height)} presetId={presetId} editing={editing} host={host}/></ContentRecovery>;
});

interface DragBindings {readonly setNodeRef:(node:HTMLElement|null)=>void;readonly setActivatorNodeRef:(node:HTMLElement|null)=>void;readonly listeners:ReturnType<typeof useDraggable>['listeners'];readonly attributes:ReturnType<typeof useDraggable>['attributes'];readonly setResizeNode:(node:HTMLElement|null)=>void;readonly resizeListeners:ReturnType<typeof useDraggable>['listeners']}
type PanelShellProps=Omit<PanelViewProps,'active'|'onTools'|'onFlightSettled'>&{readonly dragging:boolean;readonly drag:DragBindings;readonly onTools:(id:FeatureId)=>void;readonly onFlightSettled:()=>void};
/**
 * dnd-kit re-renders the component that calls useDraggable on every pointer move of the dragged panel (its transform
 * context). That component is only this thin binding layer; the panel shell below is memoized on stable props so a drag
 * move never re-renders the dragged widget (or any other).
 */
export function PanelView({active,onTools,onFlightSettled,...props}:PanelViewProps){
 const featureId=props.panel.featureId,editing=useRunSlice(props.run,selectEditing,Object.is);
 const {setNodeRef,setActivatorNodeRef,listeners,attributes}=useDraggable({id:`panel-${featureId}`,data:{source:'panel',featureId}});
 const {setNodeRef:setResizeNode,listeners:resizeListeners}=useDraggable({id:`resize-${featureId}`,data:{source:'resize',featureId},disabled:!editing});
 const latest=useRef({onTools,onFlightSettled});
 useLayoutEffect(()=>{latest.current={onTools,onFlightSettled};});
 const tools=useCallback((id:FeatureId)=>latest.current.onTools(id),[]),settled=useCallback(()=>latest.current.onFlightSettled?.(),[]);
 const drag=useMemo<DragBindings>(()=>({setNodeRef,setActivatorNodeRef,listeners,attributes,setResizeNode,resizeListeners}),[setNodeRef,setActivatorNodeRef,listeners,attributes,setResizeNode,resizeListeners]);
 return <PanelShell {...props} dragging={active?.source==='panel'&&active.featureId===featureId} drag={drag} onTools={tools} onFlightSettled={settled}/>;
}
const selectEditing=(s:RunState)=>s.edit.mode==='edit';
const PanelShell=memo(function PanelShell({panel,layer,run,controller,nodes,flight,lastFlight,bounds,onTools,onFlightSettled,highlighted,created,waiting,tapTargets,dragging,drag,assembling=false,assemblyReady=true}:PanelShellProps){
 const {name}=useDashboardT();
 const featureId=panel.featureId,pick=useMemo(()=>pickSlice(featureId),[featureId]),s=useRunSlice(run,pick,sameSlice);
 const condition=panel.condition??DEFAULT_CONDITION,label=name(featureId),groupId=getRegistration(featureId)?.groupId??'recommended';
 const module=useWidgetModule(featureId),summary=useWidgetSummary(featureId,condition),tapTarget=useWidgetTapTarget(featureId,condition);
 // An example state (empty or error, DS 11.5) flows top to bottom like plan-2 panels so its action keeps its margin at 1x1 and 125% (T-049 hand-over).
 const stateShown=useWidgetView(featureId,condition).status!=='ready';
 const owner=useRef({});
 useLayoutEffect(()=>{const entry={owner:owner.current,target:tapTarget};tapTargets.set(featureId,entry);return()=>{if(tapTargets.get(featureId)?.owner===entry.owner)tapTargets.delete(featureId);};},[tapTargets,featureId,tapTarget]);
 const host=useMemo(()=>createWidgetHost(run,{featureId,layer,focusKey:panelFocusKey(featureId)}),[run,featureId,layer]);
 // The same widget can be in an exiting page layer (M-19) and the arriving one: only the owner of the entry removes it.
 const own=useRef<HTMLElement|null>(null);
 const {setNodeRef,setActivatorNodeRef,listeners,attributes,setResizeNode,resizeListeners}=drag;
 const setNode=useCallback((node:HTMLElement|null)=>{setNodeRef(node);if(node){own.current=node;nodes.set(featureId,node);}else{if(nodes.get(featureId)===own.current)nodes.delete(featureId);own.current=null;}},[setNodeRef,nodes,featureId]);
 const editing=s.editing;
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
 const entranceKey=s.tour?`${s.tour}:${Boolean(assemblyReady&&bounds)}`:'panel';
 const content=Body?<PanelContent Body={Body} featureId={featureId} condition={condition} width={panel.width} height={panel.height} presetId={s.presetId} editing={editing} locale={s.locale} host={host}/>:null;
 return <PanelMotionFrame panel={panel} layoutId={panelLayoutId(featureId)} style={{opacity:dragging||assembling&&!assemblyReady?0:1}} transitionKind={s.snapNotice?'snap':'layout'} onSettled={()=>{if(!assembling&&!flight&&!run.getState().gesturePreview&&run.getState().layoutRevision===s.layoutRevision)(run as PresentationRunStore).actions.visualSettled({runId:s.runId,transitionToken:s.transitionToken});}}>
  <AnimatePresence key={entranceKey} initial={flying}>
  <FlyInFrame key="panel" fromRect={flying?flight?.sourceRect:undefined} toRect={flying&&bounds?placementRect(bounds,panel,s.grid):undefined} index={flight?.index??0} stagger={flight?.stagger} onSettled={()=>{if(flying&&flight&&lastFlight&&run.getState().runId===s.runId&&run.getState().layoutRevision===flight.revision&&!run.getState().gesturePreview){if(!assembling)(run as PresentationRunStore).actions.visualSettled({runId:s.runId,transitionToken:s.transitionToken});onFlightSettled?.();}}}>
   <FeaturePanel className={created?'dashboard-ai-created':undefined} ref={setNode} featureId={featureId} label={label} title={label} groupId={groupId} width={panel.width} height={panel.height} editing={editing} selected={s.selected} highlighted={highlighted}
    describeViewInteraction={false} interactive={tapTarget!==null} row={panel.row+1} column={panel.column+1} summary={summary} waiting={waiting} flow={planTwo.has(featureId)||stateShown}
    onHelp={()=>{if(run.getState().guidance.activeWidget===featureId)run.actions.dismissCoach();run.actions.openWidgetHelp(featureId,'panel',panelFocusKey(featureId));}}
    interactionProps={{...attributes,...listeners,ref:setActivatorNodeRef,id:panelFocusKey(featureId),'aria-keyshortcuts':'Shift+Enter ArrowLeft ArrowRight ArrowUp ArrowDown Control+ArrowLeft Control+ArrowRight Control+ArrowUp Control+ArrowDown Meta+ArrowLeft Meta+ArrowRight Meta+ArrowUp Meta+ArrowDown',onKeyDown:key,onContextMenu:e=>e.preventDefault(),onClick:e=>{if(e.detail===0)controller.tap({source:'panel',featureId},{x:0,y:0},{x:0,y:0,width:0,height:0});}}}
    controls={<><RemoveButton label={label} onClick={()=>controller.remove(featureId)}/><ResizeHandle {...resizeListeners} ref={setResizeNode} label={label} width={panel.width} height={panel.height} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown" onKeyDown={event=>{if(event.key.startsWith('Arrow')){event.preventDefault();const width=panel.width+(event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0),height=panel.height+(event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0);controller.resize(featureId,{width:Math.max(1,Math.min(4,width)),height:Math.max(1,Math.min(4,height))});}}} onClick={()=>onTools(featureId)}/></>}>
    {content}
   </FeaturePanel>
  </FlyInFrame>
  </AnimatePresence>
 </PanelMotionFrame>;
},sameProps);
