import type {CommandResult,FeatureId,LayoutResponse,PageDirection,Panel,QueryCondition,RunStore} from '../../contracts';
import {findPlacement} from '../../state';
import {gestureTokens,layoutTokens,motionTokens} from '../../ui/motion';
import {cellTarget,edgeAt,insideRect,panelFocusKey,panelRect,placementRect,resizeAxis,type EdgeSide,type Point,type Rect} from './gestures';
export interface DragData {readonly source:'feature'|'panel'|'resize'|'candidate';readonly featureId:FeatureId;readonly size?:{readonly width:number;readonly height:number};readonly condition?:QueryCondition}
export interface ActiveGesture extends DragData {readonly pointerId:number;readonly token:string;readonly origin:Point;readonly sourceRect:Rect;readonly initialPanel:Panel;readonly grab:Point}
/** index orders the flights; stagger (ms) is the start interval (M-04 40ms, M-28 24ms). */
export interface FlightPlan {readonly featureId:FeatureId;readonly sourceRect:Rect;readonly index:number;readonly revision:number;readonly stagger:number}
export interface SnapPlan {readonly token:string;readonly featureId:FeatureId;readonly from:Rect;readonly to:Rect;readonly valid:boolean}
/** The band the pointer dwells in and the 1-based page it leads to (SCR-25, EdgeZoneBand). */
export interface EdgeState {readonly side:EdgeSide;readonly targetPage:number}
export interface DashboardEnvironment {
 readonly getGridRect:()=>Rect|null;readonly select:(id:FeatureId|null)=>void;readonly consumePointer:(id:number)=>void;readonly onActive:(gesture:ActiveGesture|null)=>void;readonly onDrop?:(plan:SnapPlan)=>void;readonly onFlight:(plans:readonly FlightPlan[])=>void;readonly requestFrame:(fn:()=>void)=>number;readonly cancelFrame:(id:number)=>void;readonly onTools?:(id:FeatureId)=>void;readonly onCandidateResult?:(data:DragData,result:CommandResult|null)=>void;
 /** API-04 v4: the dwell clock is the controller's; tests inject fake timers. */
 readonly schedule:(fn:()=>void,ms:number)=>number;readonly cancelTimer:(id:number)=>void;
 readonly onEdge?:(edge:EdgeState|null)=>void;
 /** The widget is already on another page of this layer (AC-190): the screen shows that page and highlights it. */
 readonly onDuplicate?:(featureId:FeatureId,pageIndex:number)=>void;
 /** A short press on a panel outside editing (the screen knows the module's tap target). */
 readonly openPanel?:(featureId:FeatureId)=>void;
}
export interface DashboardController {readonly start:(data:DragData,pointerId:number,point:Point,sourceRect:Rect)=>boolean;readonly move:(point:Point)=>void;readonly end:(point:Point)=>CommandResult|null;readonly cancel:()=>void;readonly cancelForViewportChange:()=>void;readonly tap:(data:DragData,point:Point,sourceRect:Rect)=>void;readonly startThree:(sourceRect:Rect)=>void;readonly startPreset:(sourceRect:Rect)=>void;readonly resize:(featureId:FeatureId,size:{width:number;height:number})=>void;readonly moveCell:(featureId:FeatureId,delta:{column:number;row:number})=>void;readonly movePanelToPage:(featureId:FeatureId,direction:PageDirection)=>CommandResult;readonly remove:(featureId:FeatureId)=>void;readonly undo:(token:string)=>void;readonly dispose:()=>void}
const validSpan=(value:number|undefined)=>value!==undefined&&Number.isInteger(value)&&value>=1&&value<=4;
export function createDashboardController(run:RunStore,env:DashboardEnvironment):DashboardController {
 let active:ActiveGesture|null=null,last:Point|null=null,frame:number|null=null,moved=false,size={width:1,height:1},held:{gesture:ActiveGesture;point:Point}|null=null;
 // Edge dwell: armed once the pointer has been outside every band during this gesture (MOTION 9.3-2 "entered").
 let edge:{side:EdgeSide;timer:number|null}|null=null,armed=false;
 const spec=()=>run.getState().screenPreset.grid;
 const select=(id:FeatureId|null)=>{if(id)run.actions.selectPanel(id);env.select(id);};
 const neighbour=(side:EdgeSide)=>{const s=run.getState(),board=s.boards[s.activeBoard],next=board.currentPage+(side==='right'?1:-1);return next>=0&&next<board.pages.length?next:null;};
 function clearEdge(){if(!edge)return;if(edge.timer!==null)env.cancelTimer(edge.timer);edge=null;env.onEdge?.(null);}
 function flip(side:EdgeSide){
  if(!active||!edge||edge.side!==side)return;
  edge.timer=null;
  const result=run.actions.flipPageDuringGesture(active.token,side==='right'?1:-1);
  if(!result.ok){clearEdge();return;}
  const next=neighbour(side);
  // Keep dwelling (no restart while the pointer stays); without a further neighbour the band disappears.
  if(next===null){env.onEdge?.(null);return;}
  edge.timer=env.schedule(()=>flip(side),gestureTokens.edgeRepeatMs);
  env.onEdge?.({side,targetPage:next+1});
 }
 function trackEdge(point:Point){
  if(!active||active.source==='resize'||(active.source==='panel'&&!moved))return;
  const grid=env.getGridRect();const side=grid?edgeAt(point,grid):null;
  if(!side){armed=true;clearEdge();return;}
  if(!armed||edge?.side===side)return;
  clearEdge();
  const next=neighbour(side);if(next===null)return;
  edge={side,timer:env.schedule(()=>flip(side),gestureTokens.edgeDwellMs)};
  env.onEdge?.({side,targetPage:next+1});
 }
 function flush(){if(frame!==null){env.cancelFrame(frame);frame=null;}if(!active||!last||active.source==='panel'&&!moved)return;const grid=env.getGridRect();if(!grid)return;
  if(active.source==='resize'){const cell=panelRect(grid,{width:1,height:1},spec());size={width:resizeAxis(last.x-active.origin.x,size.width,active.initialPanel.width,cell.width+layoutTokens.gridGap),height:resizeAxis(last.y-active.origin.y,size.height,active.initialPanel.height,cell.height+layoutTokens.gridGap)};run.actions.updatePreview(active.token,{width:size.width,height:size.height});return;}
  const targetSize=panelRect(grid,active.initialPanel,spec());const grab=active.source==='panel'?active.grab:active.source==='candidate'?{x:targetSize.width/2,y:targetSize.height/2}:undefined;const hit=cellTarget(last,grid,spec(),active.initialPanel,grab);
  // API-03 v4: position only; the store picks move / add-drop / sized placement for this source and page.
  run.actions.updatePreview(active.token,{column:hit.column,row:hit.row,inside:hit.inside});
 }
 function snap(gesture:ActiveGesture,point:Point,valid:boolean){if(gesture.source==='resize'||gesture.source==='panel'&&!moved)return;const grid=env.getGridRect();if(!grid)return;const panel=run.getState().panels.find(p=>p.featureId===gesture.featureId);const initial=panelRect(grid,gesture.initialPanel,spec());
  // A cancelled drag whose panel stayed on another page has no visible destination here: no snap back.
  if(!panel&&gesture.source==='panel')return;
  env.onDrop?.({token:gesture.token,featureId:gesture.featureId,valid,from:{x:gesture.source==='feature'||gesture.source==='candidate'?point.x-initial.width/2:gesture.sourceRect.x+point.x-gesture.origin.x,y:gesture.source==='feature'||gesture.source==='candidate'?point.y-initial.height/2:gesture.sourceRect.y+point.y-gesture.origin.y,width:initial.width,height:initial.height},to:panel?placementRect(grid,panel,spec()):gesture.sourceRect});}
 function clear(){clearEdge();active=null;last=null;armed=false;if(frame!==null)env.cancelFrame(frame);frame=null;env.onActive(null);}
 const duplicateFollow=(featureId:FeatureId,result:LayoutResponse)=>{if(result.code==='DUPLICATE'&&result.existingPage!==undefined)env.onDuplicate?.(featureId,result.existingPage);};
 let unsubscribe:(()=>void)|null=null;const watch=()=>{unsubscribe??=run.subscribe((state,previous)=>{if(held&&previous.gesturePreview?.token===held.gesture.token&&!state.gesturePreview){const pending=held;held=null;if(state.layoutRevision>previous.layoutRevision||previous.gesturePreview?.status==='rejected')snap(pending.gesture,pending.point,state.layoutRevision>previous.layoutRevision);if(pending.gesture.source==='candidate')env.onCandidateResult?.(pending.gesture,{...(previous.gesturePreview!.result??{status:'rejected',valid:false,code:'CANCELLED',panels:state.panels,displacements:[],usedCells:0,remainingCells:0}),revision:state.layoutRevision});}});};
 function command(featureId:FeatureId,intent:Parameters<RunStore['actions']['beginPreview']>[0]['intent'],source:'resize'|'keyboard'){const token=run.actions.beginPreview({source,pointerId:-1,intent});if(!token)return;run.actions.coachedAction(source==='resize'?'resize-panel':'move-panel');run.actions.commitPreview(token);void featureId;}
 const controller:DashboardController={
  start(data,pointerId,point,sourceRect){watch();if(active)return false;const s=run.getState();if(!run.catalog.some(f=>f.id===data.featureId))return false;
   const panel=s.panels.find(p=>p.featureId===data.featureId);
   if(data.source==='feature'||data.source==='candidate'){
    // API-03 v4: a widget anywhere on this layer is a duplicate; the tap path reports its page instead of dragging.
    const placed=findPlacement(s,data.featureId);
    if(placed&&placed.layer===s.activeBoard){env.consumePointer(pointerId);controller.tap(data,point,sourceRect);return false;}
   }else if(!panel)return false;
   const initialPanel:Panel=panel??{featureId:data.featureId,column:0,row:0,width:validSpan(data.size?.width)&&validSpan(data.size?.height)?data.size!.width:1,height:validSpan(data.size?.width)&&validSpan(data.size?.height)?data.size!.height:1,condition:data.condition};const grid=env.getGridRect();if(!grid)return false;const hit=cellTarget(point,grid,spec(),initialPanel);
   const intent=data.source==='candidate'?{type:'add-ai' as const,featureId:data.featureId,column:hit.column,row:hit.row,width:initialPanel.width as 1|2|3|4,height:initialPanel.height as 1|2|3|4,condition:data.condition??{kind:'default' as const}}:data.source==='feature'?{type:'add-drop' as const,featureId:data.featureId,column:hit.column,row:hit.row}:data.source==='resize'?{type:'resize' as const,featureId:data.featureId,width:panel!.width,height:panel!.height}:{type:'move' as const,featureId:data.featureId,column:panel!.column,row:panel!.row};
   const token=run.actions.beginPreview({source:data.source==='feature'?'drawer':data.source,pointerId,intent});if(!token)return false;held=null;run.actions.coachedAction(data.source==='resize'?'resize-panel':'move-panel');env.consumePointer(pointerId);if(data.source!=='candidate')select(data.featureId);moved=false;armed=false;last=point;size={width:initialPanel.width,height:initialPanel.height};active={...data,pointerId,token,origin:point,sourceRect,initialPanel,grab:{x:point.x-sourceRect.x,y:point.y-sourceRect.y}};env.onActive(active);return true;
  },
  move(point){if(!active)return;last=point;if(Math.hypot(point.x-active.origin.x,point.y-active.origin.y)>gestureTokens.slop)moved=true;trackEdge(point);if(frame===null)frame=env.requestFrame(()=>{frame=null;flush();});},
  end(point){if(!active)return null;last=point;if(Math.hypot(point.x-active.origin.x,point.y-active.origin.y)>gestureTokens.slop)moved=true;flush();clearEdge();const gesture=active,grid=env.getGridRect();
   // A drop over the feature rail (the right band continues there) is outside the grid: back to the source page.
   const inside=Boolean(grid&&insideRect(point,grid));const result=run.actions.commitPreview(gesture.token,inside);if(result.status==='pending')held={gesture,point};else {snap(gesture,point,result.status==='accepted'||result.status==='unchanged');if(gesture.source==='candidate')env.onCandidateResult?.(gesture,result);}clear();return result;},
  cancel(){const gesture=active,point=last;held=null;clearEdge();run.actions.cancelPreview();if(gesture&&point)snap(gesture,point,false);clear();if(gesture?.source==='candidate')env.onCandidateResult?.(gesture,null);},
  cancelForViewportChange(){const gesture=active;held=null;clearEdge();run.actions.cancelPreviewForViewportChange();clear();if(gesture?.source==='candidate')env.onCandidateResult?.(gesture,null);},
  tap(data,_point,sourceRect){
   if(data.source==='candidate'){const result=run.actions.applyLayoutIntent({type:'add-candidate-tap',featureId:data.featureId,width:data.size?.width??1,height:data.size?.height??1,condition:data.condition??{kind:'default'}});duplicateFollow(data.featureId,result);env.onCandidateResult?.(data,result);return;}
   if(data.source==='feature'){const result=run.actions.applyLayoutIntent({type:'add-tap',featureId:data.featureId});if(run.getState().overlay.type==='drawer')run.actions.closeOverlay('drag-start');if(result.status==='accepted')env.onFlight([{featureId:data.featureId,sourceRect,index:0,revision:result.revision,stagger:motionTokens.staggerStart}]);duplicateFollow(data.featureId,result);return;}
   if(data.source==='resize'||run.getState().edit.mode==='edit'){select(data.featureId);if(data.source==='resize')env.onTools?.(data.featureId);return;}
   if(env.openPanel)env.openPanel(data.featureId);else run.actions.openDetail(data.featureId,panelFocusKey(data.featureId));
  },
  startThree(sourceRect){const result=run.actions.startWithThree();if(result.status==='accepted')env.onFlight(result.panels.map((p,index)=>({featureId:p.featureId,sourceRect,index,revision:result.revision,stagger:motionTokens.staggerStart})));},
  // M-28: from the button frame, top to bottom then left to right, 24ms apart.
  startPreset(sourceRect){const result=run.actions.startWithPreset();if(result.status==='accepted')env.onFlight([...result.panels].sort((a,b)=>a.row-b.row||a.column-b.column).map((p,index)=>({featureId:p.featureId,sourceRect,index,revision:result.revision,stagger:motionTokens.staggerRecommend})));},
  resize(featureId,next){command(featureId,{type:'resize',featureId,...next},'resize');},
  moveCell(featureId,delta){const p=run.getState().panels.find(p=>p.featureId===featureId);if(p)command(featureId,{type:'move',featureId,column:p.column+delta.column,row:p.row+delta.row},'keyboard');},
  movePanelToPage(featureId,direction){return run.actions.movePanelToPage(featureId,direction);},
  remove(featureId){
   const panels=run.getState().panels;
   // Finish first so the last removal's Undo remains the visible notice.
   if(panels.length===1&&panels[0].featureId===featureId&&run.getState().boards[run.getState().activeBoard].pages.every((page,i)=>i===run.getState().boards[run.getState().activeBoard].currentPage||!page.panels.length))run.actions.finishEditing();
   run.actions.applyLayoutIntent({type:'remove',featureId});
   if(!run.getState().panels.length)select(null);
  },undo(token){run.actions.undo(token);},dispose(){unsubscribe?.();controller.cancel();},
 };return controller;
}
