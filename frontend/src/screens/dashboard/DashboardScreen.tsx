import {useTemplateAssembly} from '../../app/template-assembly';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {AnimatePresence,LayoutGroup,motion,useIsPresent} from 'motion/react';
import {DndContext,DragOverlay,getClientRect,useDraggable,useDroppable,useSensor,useSensors} from '@dnd-kit/core';
import type {DashboardLayerId,FeatureId,GroupId,Panel,PageDirection,QueryCondition,RunStore,ViewportTransform,WidgetRegistration} from '../../contracts';
import {getLayerGroups,getRegistration,listFeatures,searchFeatures} from '../../catalog';
import {attachRunTimers,findPlacement,selectBoardPanels,selectCommonNotice,selectTemplateInteractionBlocked,type PresentationRunStore} from '../../state';
import {createTranslator,baseBundles,type MessageBundle} from '../../i18n';
import {TODAY} from '../../data/widget-data';
import {store as demoStore} from '../../data/db/generated/manifest.json';
import {useDataUndo} from '../../data/react';
import {createWidgetHost,useWidgetModule} from '../../features/widgets/registry-context';
import {ActionButton,Card,DashboardGrid,DropPreview,EdgeZoneBand,EditToolbar,FeaturePanel,FirstUseHint,FunctionDrawer,FunctionRailItem,FunctionRow,Icon,IdleChrome,InlineEmpty,NoticeHost,OverlayExitSurface,PageBar,PanelMotionFrame,PanelToolsPopover,RemoveButton,ResizeHandle,SearchField,SkipLink,layoutTokens,motionTokens,panelShape,timePolicy,toCanvasRect,transitionFor,useUi} from '../../ui';
import {createDashboardController,type ActiveGesture,type EdgeState,type FlightPlan,type SnapPlan} from './controller';
import {DashboardCoaches} from './coach';
import {clampDrawerTop,drawerGhostOffset,panelFocusKey,panelRect,placementRect,type Rect} from './gestures';
import {createInputGate,inputSequenceFromEvent} from './input';
import {DashboardNavis,type NavisHandle} from './navis';
import {createNavisNavigation} from './navis-navigation';
import {PanelView,type TapEntry} from './PanelView';
import {DashboardPointerSensor} from './sensors';
import {useRun} from './use-run';
import {useDashboardT} from './use-dashboard-t';
import './dashboard.css';

const DEFAULT_CONDITION:QueryCondition=Object.freeze({kind:'default'});
const rawRect=(el:HTMLElement|null):Rect=>{const r=el?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:{x:0,y:0,width:0,height:0};};
const projectionKey=(v:ViewportTransform)=>`${v.scale}:${v.offsetX}:${v.offsetY}`;
const isEmptyGrid=(target:Element)=>target.matches('.dashboard-grid-bounds,.ui-grid-cell,.ui-dashboard-grid,.dashboard-grid-drop,.dashboard-page-layer');
const isTextInput=(target:EventTarget|null)=>target instanceof HTMLElement&&(target.isContentEditable||target.matches('input,textarea,select,[role="slider"],[role="textbox"]'));
function coordinateReader(initial:ViewportTransform){let current=initial;return {get:()=>current,rect:(element:HTMLElement|null)=>toCanvasRect(rawRect(element),current),set:(next:ViewportTransform)=>{const changed=projectionKey(current)!==projectionKey(next);current=next;return changed;}};}
/** Search terms: the translated name and aliases plus the Korean ones (API-01 v4 searchFeatures). */
const koreanNames=createTranslator('ko',...(baseBundles as readonly MessageBundle<string>[]));
const terms=(t:(key:string)=>string,feature:WidgetRegistration)=>[t(feature.nameKey),koreanNames.t(feature.nameKey),...t(feature.aliasesKey).split('|'),...koreanNames.t(feature.aliasesKey).split('|')].filter(Boolean);
export interface DashboardScreenProps {readonly run:RunStore;readonly ready?:boolean;readonly manageTimers?:boolean;readonly posBusy?:boolean;readonly renderScreen?:(dashboard:ReactNode)=>ReactNode}

function FeatureChoice({feature,label,placed,controller,readRect}:{readonly feature:WidgetRegistration;readonly label:string;readonly placed:boolean;readonly controller:ReturnType<typeof createDashboardController>;readonly readRect:(el:HTMLElement|null)=>Rect}){const {listeners,attributes,setNodeRef}=useDraggable({id:`feature-${feature.id}`,data:{source:'feature',featureId:feature.id}});return <FunctionRow {...attributes} {...listeners} ref={setNodeRef} label={label} icon={feature.id} groupId={feature.groupId} placed={placed} onClick={e=>{if(e.detail===0)controller.tap({source:'feature',featureId:feature.id},{x:0,y:0},readRect(e.currentTarget));}}/>;}
/** SCR-25 drag-free page send in the kit position tool's page slot: an end without a neighbour stays focusable with its reason. */
function PageSend({current,total,onSend}:{readonly current:number;readonly total:number;readonly onSend:(direction:PageDirection)=>void}){
 const {t}=useDashboardT();
 const send=(direction:PageDirection)=>{const target=current+direction,atEnd=target<0||target>=total,label=t(direction<0?'page.moveToPrevious':'page.moveToNext');return <ActionButton key={direction} variant="outline" aria-disabled={atEnd||undefined} data-disabled={atEnd?'true':undefined} aria-label={atEnd?`${label}, ${t(direction<0?'page.first':'page.last')}`:label} onClick={()=>{if(!atEnd)onSend(direction);}}>{label}</ActionButton>;};
 return <div className="ui-cell-move-control dashboard-page-send" role="group" aria-label={t('dashboard.tools.page')}>{send(-1)}{send(1)}</div>;
}
function DropTarget({children}:{readonly children:ReactNode}){const {setNodeRef}=useDroppable({id:'dashboard-grid'});return <div ref={setNodeRef} className="dashboard-grid-drop">{children}</div>;}
/** M-19: only the page layer (dotted grid and panels) slides; an exiting page is inert and hidden from assistive tech. */
function PageLayer({children,direction}:{readonly children:ReactNode;readonly direction:number}){
 const present=useIsPresent(),{reducedMotion}=useUi(),dx=reducedMotion?0:motionTokens.translatePage;
 return <motion.div className="dashboard-page-layer" custom={direction} variants={{enter:(d:number)=>({opacity:0,x:dx*d}),center:{opacity:1,x:0},exit:(d:number)=>({opacity:0,x:-dx*d})}} initial="enter" animate="center" exit="exit" transition={transitionFor('page',reducedMotion)} aria-hidden={!present||undefined} inert={!present||undefined} data-exiting={!present?'true':undefined}>{children}</motion.div>;
}
/** The lifted copy under the pointer: the same widget body as the panel, never interactive. */
function GhostPanel({run,layer,featureId,width,height,condition,label}:{readonly run:RunStore;readonly layer:DashboardLayerId;readonly featureId:FeatureId;readonly width:number;readonly height:number;readonly condition?:QueryCondition;readonly label:string}){
 const module=useWidgetModule(featureId),host=useMemo(()=>createWidgetHost(run,{featureId,layer}),[run,featureId,layer]),Body=module?.Panel,preset=run.getState().screenPreset.id;
 const groupId=getRegistration(featureId)?.groupId??'recommended';
 return <FeaturePanel featureId={featureId} label={label} title={label} groupId={groupId} width={width} height={height} editing controls={<><RemoveButton label={label}/><ResizeHandle label={label} width={width} height={height}/></>}>{Body?<Body featureId={featureId} condition={condition??DEFAULT_CONDITION} width={width as 1} height={height as 1} shape={panelShape(width,height)} presetId={preset} editing host={host}/>:null}</FeaturePanel>;
}

function DashboardContent({run,ready=true,manageTimers=true,posBusy=false,renderScreen}:DashboardScreenProps){
 const s=useRun(run),{portalContainer,reducedMotion,transform,layout,textScale,screenPreset}=useUi();
 const templateSettled=useTemplateAssembly(run);
 const {t,name,translator}=useDashboardT(),dataUndo=useDataUndo();
 if(!transform)throw new Error('Dashboard requires a positive canvas transform');
 const boardVisible=s.screen==='dashboard'&&s.layer!=='orders-payment';
 const layer=s.activeBoard,board=s.boards[layer],pageIndex=board.currentPage,pageCount=board.pages.length,boardEmpty=board.pages.every(page=>!page.panels.length);
 const [coordinates]=useState(()=>coordinateReader(transform)),readRect=coordinates.rect;
 const [gridNode,setGridNode]=useState<HTMLDivElement|null>(null);const searchRef=useRef<HTMLInputElement>(null),startRef=useRef<HTMLButtonElement>(null),[recommendNode,setRecommendNode]=useState<HTMLButtonElement|null>(null);
 const [snap,setSnap]=useState<(SnapPlan&{projectionKey:string})|null>(null),[active,setActive]=useState<ActiveGesture|null>(null),[flights,setFlights]=useState<readonly FlightPlan[]>([]),[bounds,setBounds]=useState<Rect|null>(null),[searchMode,setSearchMode]=useState(false),[hint,setHint]=useState(false),[tools,setTools]=useState<FeatureId|null>(null),[pendingLong,setPendingLong]=useState<{token:string;requestId:number}|null>(null),[edge,setEdge]=useState<EdgeState|null>(null);
 const [highlights,setHighlights]=useState<readonly FeatureId[]>([]),[created,setCreated]=useState<readonly FeatureId[]>([]),[announcement,setAnnouncement]=useState('');
 const navis=useRef<NavisHandle>(null),posBusyRef=useRef(posBusy);
 posBusyRef.current=posBusy;
 const nodes=useMemo(()=>new Map<FeatureId,HTMLElement>(),[]),tapTargets=useMemo(()=>new Map<FeatureId,TapEntry>(),[]);
 const highlight=useCallback((ids:readonly FeatureId[])=>{setHighlights(ids);window.setTimeout(()=>setHighlights(current=>current===ids?[]:current),timePolicy.existingHighlightMs);},[]);
 const navigation=useMemo(()=>createNavisNavigation(run,{
  highlight:id=>highlight([id]),closeChat:()=>navis.current?.close(true),setDrawerSearch:setSearchMode,posBusy:()=>posBusyRef.current,
 }),[run,highlight]);
 useEffect(()=>navigation.attach(),[navigation]);
 /** AC-190 / SCR-34: show the page that holds the widget and ring it (M-13). */
 const showPanel=useCallback((featureId:FeatureId)=>{const placed=findPlacement(run.getState(),featureId);if(!placed||placed.layer!==run.getState().activeBoard)return;if(placed.pageIndex!==run.getState().boards[placed.layer].currentPage)run.actions.goToPage(placed.pageIndex);highlight([featureId]);},[run,highlight]);
 /** API-13 v4.1: a short press opens the module's tap target; the own detail expands from the panel, another widget's opens from the centre. */
 const openPanel=useCallback((featureId:FeatureId)=>{
  if(run.getState().guidance.activeWidget===featureId)run.actions.dismissCoach();
  const entry=tapTargets.get(featureId),target=entry?entry.target:{featureId};if(!target)return;
  const key=panelFocusKey(featureId);
  if(target.featureId===featureId&&target.view===undefined&&target.itemId===undefined&&target.focus===undefined)run.actions.openDetail(featureId,key);else run.actions.openDetailRef(target,key);
 },[run,tapTargets]);
 const [noticeAvoidRects,setNoticeAvoidRects]=useState<readonly Rect[]>([]);
 useLayoutEffect(()=>{
  const measure=()=>{
   const ids=new Set([s.notice?.featureId,s.edit.mode==='edit'?s.edit.selectedFeatureId:null]);
   const rects=s.panels.filter(panel=>ids.has(panel.featureId)).flatMap(panel=>{
    const node=nodes.get(panel.featureId);if(!node||s.edit.mode!=='edit')return [];
    const destination=placementRect(layout.grid,panel,s.screenPreset.grid);
    // Layout offsets describe the committed panel, before Motion's projection or the shell's fit transform.
    return Array.from(node.querySelectorAll<HTMLElement>('.ui-panel-resize,.ui-panel-remove'),control=>({x:destination.x+control.offsetLeft,y:destination.y+control.offsetTop,width:control.offsetWidth,height:control.offsetHeight}));
   });
   setNoticeAvoidRects(before=>JSON.stringify(before)===JSON.stringify(rects)?before:rects);
  };
  measure();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);
  for(const node of nodes.values())observer?.observe(node);
  return()=>observer?.disconnect();
 },[s.notice?.featureId,s.edit.mode,s.edit.selectedFeatureId,s.panels,s.screenPreset,layout,textScale,nodes]);
 const runtime=useMemo(()=>{const gate=createInputGate(run,()=>{setHint(false);setSnap(null);},()=>controller.cancel());const controller=createDashboardController(run,{getGridRect:()=>gridNode?readRect(gridNode):null,select:id=>{if(id)run.actions.selectPanel(id);},consumePointer:gate.consumePointer,onActive:gesture=>{setActive(gesture);if(gesture)setTools(null);},onCandidateResult:(data,result)=>navis.current?.candidateResult(data,result),onFlight:setFlights,onTools:id=>{run.actions.selectPanel(id);setTools(id);},onDrop:plan=>setSnap({...plan,projectionKey:projectionKey(coordinates.get())}),requestFrame:fn=>window.requestAnimationFrame(fn),cancelFrame:id=>window.cancelAnimationFrame(id),schedule:(fn,ms)=>window.setTimeout(fn,ms),cancelTimer:id=>window.clearTimeout(id),onEdge:setEdge,onDuplicate:featureId=>showPanel(featureId),openPanel});const captured=new WeakMap<HTMLElement,ReturnType<typeof getClientRect>>();return {controller,gate,captured,capture:(node:HTMLElement,rect:DOMRect)=>captured.set(node,toCanvasRect(rect,coordinates.get()))};},[run,gridNode,readRect,coordinates,showPanel,openPanel]);
 const sensors=useSensors(useSensor(DashboardPointerSensor,{run,controller:runtime.controller,gate:runtime.gate,capture:runtime.capture,getTransform:coordinates.get}));
 useLayoutEffect(()=>{if(coordinates.set(transform))runtime.controller.cancelForViewportChange();},[coordinates,transform,runtime]);
 useEffect(()=>boardVisible?runtime.gate.attach(document,window):undefined,[runtime,boardVisible]);
 useEffect(()=>()=>runtime.controller.dispose(),[runtime]);
 useEffect(()=>manageTimers?attachRunTimers(run,{schedule:(fn,delay)=>window.setTimeout(fn,delay),cancel:handle=>window.clearTimeout(handle as number)}):undefined,[run,manageTimers]);
 useEffect(()=>{if(boardVisible)void run.prepareLayout();},[run,s.runId,boardVisible]);
 useEffect(()=>{if(boardVisible&&ready&&run.getState().onboarding.step!=='applying')(run as PresentationRunStore).actions.visualSettled({runId:s.runId,transitionToken:s.transitionToken});},[run,ready,layer,boardVisible]);
 useLayoutEffect(()=>{const node=gridNode;if(!node)return;const measure=()=>{const r=readRect(node);setBounds(before=>before&&JSON.stringify(before)===JSON.stringify(r)?before:r);};measure();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);observer?.observe(node);window.addEventListener('resize',measure);return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};},[gridNode,readRect,transform]);
 // M-11 first drag hint: once per board (AC-177 counterpart for the hint).
 useEffect(()=>{if(!boardVisible||!ready)return;const timer=window.setTimeout(()=>{if(run.actions.markFirstHintSeen()&&!reducedMotion)setHint(true);},timePolicy.hintDelayMs);return()=>window.clearTimeout(timer);},[run,ready,reducedMotion,layer,boardVisible]);
 useEffect(()=>{if(!hint)return;const timer=window.setTimeout(()=>setHint(false),motionTokens.duration.hint);return()=>window.clearTimeout(timer);},[hint]);
 const applying=s.onboarding.step==='applying';
 // Flight plans belong to the current visit, never to a restored board/page.
 useLayoutEffect(()=>setFlights([]),[layer,pageIndex]);
 const [templateFlights,setTemplateFlights]=useState<readonly FlightPlan[]>([]);
 useLayoutEffect(()=>{if(!applying||!ready)return;setTemplateFlights(s.panels.map((panel,index)=>{const item=document.querySelector<HTMLElement>(`[data-template-group="${getRegistration(panel.featureId)?.groupId}"]`);return {featureId:panel.featureId,index,revision:s.layoutRevision,stagger:motionTokens.staggerTemplate,sourceRect:readRect(item?.querySelector<HTMLElement>('.ui-icon')??item)};}));},[applying,ready,s.panels,s.layoutRevision,readRect]);
 const preview=s.gesturePreview,currentFlights=applying?templateFlights:flights.filter(f=>f.revision===s.layoutRevision),duration=reducedMotion?motionTokens.duration.reduced:currentFlights.length?motionTokens.duration.fly+(currentFlights.length-1)*(currentFlights[0]?.stagger??motionTokens.staggerStart):motionTokens.duration.layout;
 // FlyInFrame owns settlement. Allow twice the complete flight span before the
 // safety timer recovers a missing callback, including stagger/reduced motion.
 const settleDeadline=currentFlights.length?duration*2:duration;
 useEffect(()=>{if(!boardVisible||applying||!s.guidance.visualPending||preview)return;const revision=s.layoutRevision,timer=window.setTimeout(()=>{if(run.getState().layoutRevision===revision&&!run.getState().gesturePreview)(run as PresentationRunStore).actions.visualSettled({runId:s.runId,transitionToken:s.transitionToken});},settleDeadline);return()=>window.clearTimeout(timer);},[run,s.guidance.visualPending,s.layoutRevision,preview,settleDeadline,applying,boardVisible,s.runId,s.transitionToken]);
 useEffect(()=>{if(preview?.status!=='pending')return;const timer=window.setTimeout(()=>{const p=run.getState().gesturePreview;if(p?.token===preview.token&&p.requestId===preview.requestId)setPendingLong({token:preview.token,requestId:preview.requestId});},layoutTokens.prepareThresholdMs);return()=>window.clearTimeout(timer);},[run,preview]);
 // A page move (button, key or drop) rings the arrived panel for 800ms (SCR-25, M-13).
 useEffect(()=>{const notice=s.notice;if(notice?.messageKey==='move-page'&&notice.featureId)highlight([notice.featureId]);},[s.notice,highlight]);
 // Polite announcements: page position, layer with page, and the recommended-layout completion (SCR-24/35/41).
 const previousView=useRef({layer,pageIndex,pageCount,revision:s.layoutRevision});
 useEffect(()=>{
  const before=previousView.current,status=t('page.status',{current:pageIndex+1,total:pageCount});
  if(before.layer!==layer)setAnnouncement(t('dashboard.announce.layer',{layer:t(`app.layer.${layer}`),status}));
  else if(before.pageIndex!==pageIndex||before.pageCount!==pageCount)setAnnouncement(status);
  previousView.current={layer,pageIndex,pageCount,revision:s.layoutRevision};
 },[layer,pageIndex,pageCount,s.layoutRevision,t]);
 // A focused panel that leaves with its page hands focus to the grid instead of the document body.
 useLayoutEffect(()=>{const focused=document.activeElement;if(gridNode&&focused instanceof HTMLElement&&(focused.closest('[data-exiting="true"]')||!focused.isConnected))gridNode.focus({preventScroll:true});},[pageIndex,layer,gridNode]);

 const longPending=Boolean(preview?.status==='pending'&&pendingLong?.token===preview.token&&pendingLong.requestId===preview.requestId);
 const shown=(preview?.status==='accepted'?preview.candidatePanels.map(p=>preview.source==='resize'&&p.featureId===preview.featureId?preview.beforePanels.find(old=>old.featureId===p.featureId)!:p):s.panels).filter(p=>s.panels.some(old=>old.featureId===p.featureId));
 const drawer=s.overlay.type==='drawer'?s.overlay:null,exitingDrawer=s.exitingOverlay?.type==='drawer'?s.exitingOverlay:null,isIdle=s.idle.mode==='idle';
 const placedIds=useMemo(()=>new Set(selectBoardPanels(s,layer).map(entry=>entry.panel.featureId)),[s,layer]);
 const queryFeatures=(d:NonNullable<typeof drawer>)=>searchMode?searchFeatures(listFeatures({presetId:s.screenPreset.id,layer,query:''}),d.query,f=>terms(t,f)):listFeatures({presetId:s.screenPreset.id,layer,group:d.group,businessType:s.businessType});
 const drawerFeatures=drawer?queryFeatures(drawer):[],exitFeatures=exitingDrawer?queryFeatures(exitingDrawer):[];
 const selected=s.panels.find(p=>p.featureId===tools),toolAnchor:RefObject<HTMLElement|null>=useMemo(()=>({get current(){return tools?nodes.get(tools)??null:null;}}),[tools,nodes]);
 const unavailable=selected?Object.fromEntries((['width','height'] as const).map(axis=>[axis,Object.fromEntries([1,2,3,4].flatMap(value=>{const width=axis==='width'?value:selected.width,height=axis==='height'?value:selected.height;const reason=selected.column+width>s.screenPreset.grid.columns||selected.row+height>s.screenPreset.grid.rows?t('dashboard.resize.outside'):s.panels.reduce((sum,p)=>sum+p.width*p.height,0)-selected.width*selected.height+width*height>s.screenPreset.grid.columns*s.screenPreset.grid.rows?t(pageCount>=5?'ui.notice.noCapacity':'ui.notice.noCapacityMore'):null;return reason?[[value,reason]]:[];}))])):undefined;
 const target=useMemo(()=>{
  if(!preview)return null;const intent=preview.intent,before=preview.beforePanels.find(p=>p.featureId===preview.featureId);let panel:Panel|null=null;
  if(intent.type==='resize'&&before)panel={...before,width:intent.width,height:intent.height};
  else if(intent.type==='add-ai')panel={featureId:intent.featureId,column:intent.column,row:intent.row,width:intent.width,height:intent.height,condition:intent.condition};
  else if(intent.type==='move'&&before)panel={...before,column:intent.column,row:intent.row};
  else if(intent.type==='add-drop')panel={featureId:intent.featureId,column:intent.column,row:intent.row,width:1,height:1};
  else if(before)panel=before;
  if(!panel)return null;const grid=s.screenPreset.grid;
  return {...panel,column:Math.max(0,Math.min(grid.columns-panel.width,panel.column)),row:Math.max(0,Math.min(grid.rows-panel.height,panel.row))};
 },[preview,s.screenPreset.grid]);
 const crossPage=Boolean(preview&&preview.targetPage!==preview.sourcePage);
 const dropReason=preview?.reason==='OUTSIDE_GRID'?t('ui.notice.outsideGrid'):preview?.reason==='INTERNAL_LAYOUT_ERROR'?t('dashboard.drop.error'):crossPage&&preview?.reason==='NO_CAPACITY'?t('page.noRoomNext'):t(pageCount>=5?'ui.notice.noCapacity':'ui.notice.noCapacityMore');
 const currentSnap=snap?.projectionKey===projectionKey(transform)?snap:null,ghostSize=active&&bounds?panelRect(bounds,active.initialPanel,s.screenPreset.grid):null;
 const closeDrawer=(reason:'button'|'Esc'|'outside',event?:Event)=>run.actions.closeOverlay(reason,event?inputSequenceFromEvent(event,run):undefined);
 // Category flyout: its top follows the clicked rail button (the search item for the find drawer), clamped inside the canvas.
 const railRef=useRef<HTMLElement>(null),drawerGroup=drawer?.group,drawerOpen=Boolean(drawer);
 useLayoutEffect(()=>{
  const host=portalContainer,rail=railRef.current;if(!drawerOpen||!host||!rail)return;
  const place=()=>{
   const button=searchMode?rail.querySelector<HTMLElement>('nav>.ui-rail-item:first-child'):rail.querySelector<HTMLElement>(`[data-template-group="${drawerGroup}"]`),flyout=host.querySelector<HTMLElement>('.ui-drawer:not(.ui-overlay-exit)');
   if(!button||!flyout)return;
   const anchor=readRect(button),top=clampDrawerTop({anchorTop:anchor.y,height:flyout.offsetHeight,min:layout.drawer.y,canvasHeight:screenPreset.baselineHeight,margin:layoutTokens.margin});
   host.style.setProperty('--drawer-y',`${top}px`);
   host.style.setProperty('--drawer-arrow-y',`${Math.max(layoutTokens.margin,Math.min(Math.max(layoutTokens.margin,flyout.offsetHeight-layoutTokens.margin),anchor.y+anchor.height/2-top))}px`);
  };
  place();
  // The flyout mounts and sizes itself after this commit; re-place on both before the next paint.
  const observed=new Set<Element>(),resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(place),watch=()=>{for(const node of host.querySelectorAll('.ui-drawer:not(.ui-overlay-exit)'))if(!observed.has(node)){observed.add(node);resize?.observe(node);}};
  const mutation=new MutationObserver(()=>{watch();place();});mutation.observe(host,{childList:true,subtree:true});watch();
  return()=>{mutation.disconnect();resize?.disconnect();};
 },[drawerOpen,drawerGroup,searchMode,portalContainer,readRect,layout.drawer.y,screenPreset.baselineHeight,textScale,transform]);
 const finishEditing=useCallback(()=>{setTools(null);run.actions.finishEditing();},[run]);
 const openGroup=(group:GroupId)=>{setSearchMode(false);if(drawer&&!searchMode&&drawer.group===group)run.actions.closeOverlay('button');else run.actions.openDrawer(group);};
 const sendToPage=useCallback((featureId:FeatureId,direction:PageDirection)=>{const result=runtime.controller.movePanelToPage(featureId,direction);if(result.status==='accepted'){setTools(null);requestAnimationFrame(()=>document.getElementById(panelFocusKey(featureId))?.focus({preventScroll:true}));}},[runtime]);
 // SCR-24/25 keys: ←/→ turn pages outside editing; in editing PageUp/PageDown turn and Shift+PageUp/PageDown send the selected panel.
 useEffect(()=>{
  const key=(event:KeyboardEvent)=>{
   if(event.defaultPrevented||event.isComposing||event.repeat||event.altKey||event.ctrlKey||event.metaKey)return;
   const state=run.getState();if(state.screen!=='dashboard'||state.layer!==state.activeBoard||state.idle.mode==='idle'||state.gesturePreview||state.edit.gesture)return;
   if(state.overlay.type!=='none'&&state.overlay.type!=='drawer')return;
   if(isTextInput(event.target)||(event.target instanceof Element&&event.target.closest('#dashboard-navis,.ui-drawer,.ui-popover')))return;
   const current=state.boards[state.activeBoard].currentPage;
   const page=event.key==='ArrowLeft'||event.key==='PageUp'?-1:event.key==='ArrowRight'||event.key==='PageDown'?1:0;if(!page)return;
   const editing=state.edit.mode==='edit',arrow=event.key.startsWith('Arrow');
   if(arrow&&(editing||event.shiftKey||state.overlay.type==='drawer'))return;
   if(!arrow&&!editing)return;
   event.preventDefault();
   if(!arrow&&event.shiftKey){const id=state.edit.selectedFeatureId;if(id)sendToPage(id,page as PageDirection);return;}
   run.actions.goToPage(current+page);
  };
  document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
 },[run,sendToPage]);
 // A panel action button that opened a detail gets focus back when that detail closes (AC-286).
 const actionReturn=useRef<HTMLElement|null>(null);
 useEffect(()=>{const press=(event:Event)=>{const button=event.target instanceof Element?event.target.closest<HTMLElement>('.dashboard-page-layer .ui-panel-action'):null;if(button)actionReturn.current=button;};document.addEventListener('click',press,true);return()=>document.removeEventListener('click',press,true);},[]);
 const overlayType=s.overlay.type;const lastOverlay=useRef(overlayType);
 useEffect(()=>{const was=lastOverlay.current;lastOverlay.current=overlayType;if(was==='detail'&&overlayType!=='detail'){const button=actionReturn.current;actionReturn.current=null;if(button?.isConnected)requestAnimationFrame(()=>requestAnimationFrame(()=>button.focus({preventScroll:true})));}else if(overlayType!=='detail'&&was!=='detail')actionReturn.current=null;},[overlayType]);
 // API-03 v4.2: layout notices undo through the board, data notices through the data store (useDataUndo).
 const layoutUndo=useCallback((token:string)=>{runtime.controller.undo(token);},[runtime]);
 const dataUndoNotice=useCallback((token:string)=>{const result=dataUndo(token);run.actions.showNotice(result.ok?{kind:'complete',messageKey:'common.undone'}:{kind:'error',messageKey:result.messageKey});},[dataUndo,run]);
 const startPreset=()=>{const before=run.getState().layoutRevision;runtime.controller.startPreset(readRect(startRef.current));if(run.getState().layoutRevision!==before)setAnnouncement(t('dashboard.announce.preset'));};
 const direction=previousView.current.layer===layer?pageDirection(previousView.current.pageIndex,pageIndex):0;
 const storeName=demoStore?.name?.trim();
 const title=storeName||(translator.locale==='ko'?t('dashboard.title'):t(`app.layer.${layer}`));
 const activeLabel=active?name(active.featureId):'';
 const ghostContent=active&&active.source!=='resize'?<GhostPanel run={run} layer={layer} featureId={active.featureId} width={active.initialPanel.width} height={active.initialPanel.height} condition={active.initialPanel.condition} label={activeLabel}/>:null;
 const dragHidden=active?.source==='candidate'||preview?.source==='candidate';
 const boardBody=boardVisible?(<main className="dashboard-screen" data-idle={String(isIdle)} data-layer={layer}><SkipLink/>
   <div className="dashboard-main"><IdleChrome idle={isIdle}><header className="dashboard-header">{s.edit.mode==='edit'?<><h1 className="ui-sr-only" lang={storeName?'ko':undefined}>{title}</h1><EditToolbar onDone={finishEditing}/></>:<><div><h1 lang={storeName?'ko':undefined}>{title}</h1><p>{translator.format.date(TODAY,'long')}</p></div><div className="dashboard-header-actions"><ActionButton data-focus-key="settings" variant="outline" onClick={run.actions.openSettings}>{t('common.settings')}</ActionButton></div></>}</header></IdleChrome>
    <div ref={setGridNode} className="dashboard-grid-bounds" data-testid="dashboard-grid-bounds" id="dashboard" tabIndex={-1} onPointerDownCapture={event=>{if(run.getState().overlay.type==='drawer'){run.actions.closeOverlay('outside',{kind:'pointer',id:event.pointerId});runtime.gate.consumePointer(event.pointerId);event.preventDefault();event.stopPropagation();}}} onClick={event=>{if(event.target instanceof Element&&isEmptyGrid(event.target)){run.actions.dismissCoach();finishEditing();}}}>
     <DropTarget>
      <AnimatePresence key={layer} initial={false} custom={direction}>
       <PageLayer key={board.pages[pageIndex].pageId} direction={direction}><LayoutGroup id={board.pages[pageIndex].pageId}>
        <DashboardGrid editing={s.edit.mode==='edit'} empty={!s.panels.length}>{shown.map(panel=><PanelView key={panel.featureId} panel={panel} layer={layer} run={run} controller={runtime.controller} active={active} nodes={nodes} assembling={applying} assemblyReady={!applying||ready&&templateFlights.length===s.panels.length} flight={currentFlights.find(f=>f.featureId===panel.featureId)} lastFlight={currentFlights.at(-1)?.featureId===panel.featureId} onFlightSettled={applying?templateSettled:()=>setFlights([])} bounds={bounds} highlighted={highlights.includes(panel.featureId)||s.notice?.kind==='duplicate'&&s.notice.featureId===panel.featureId} created={created.includes(panel.featureId)} waiting={isIdle} tapTargets={tapTargets} onTools={id=>{run.actions.selectPanel(id);setTools(id);}}/>)}{preview&&target?<DropPreview panel={target} status={preview.status} reason={dropReason} displacedCount={preview.displacements.length} pendingLong={longPending}/>:null}</DashboardGrid>
       </LayoutGroup></PageLayer>
      </AnimatePresence>
      {preview&&target&&(target.width===1||target.height===1)?<Card className="dashboard-placement-caption" data-status={preview.status} aria-hidden="true">{preview.status==='rejected'?<Icon name="error"/>:null}<span>{preview.status==='pending'?(longPending?t('ui.drop.checking'):t('ui.panel.size',{w:target.width,h:target.height})):preview.status==='rejected'?dropReason:[t('ui.drop.here'),t('ui.panel.size',{w:target.width,h:target.height}),...(preview.displacements.length?[t('ui.drop.displaced',{n:preview.displacements.length})]:[])].join(s.locale==='ko'?'\u00a0·\u00a0':' · ')}</span></Card>:null}
     </DropTarget>
     {boardEmpty&&!preview?<div className="dashboard-empty"><IdleChrome idle={isIdle}><p>{t('dashboard.empty.hint')}</p>{layer==='marketing'?<><ActionButton ref={startRef} size="primary" onClick={startPreset}>{t('marketing.startPreset')}</ActionButton><p className="dashboard-empty-note">{t('marketing.startPresetHint')}</p></>:<ActionButton ref={startRef} size="primary" onClick={()=>runtime.controller.startThree(readRect(startRef.current))}>{s.businessType?t('dashboard.starter.business',{business:s.businessType}):t('dashboard.starter.general')}</ActionButton>}</IdleChrome></div>:null}
    </div>
   </div>
   <IdleChrome idle={isIdle}><aside ref={railRef} className="dashboard-rail ui-glass-card"><nav aria-label={t('dashboard.rail.label')}><FunctionRailItem label={t('common.search')} aria-label={t('app.features.searchAction')} icon="search" selected={Boolean(drawer&&searchMode)} expanded={Boolean(drawer&&searchMode)} onClick={()=>{if(drawer&&searchMode)run.actions.closeOverlay('button');else{setSearchMode(true);run.actions.openDrawer('recommended','');}}}/>{getLayerGroups(layer).map(group=><FunctionRailItem key={group} data-template-group={group} ref={group==='recommended'?setRecommendNode:undefined} groupId={group} label={t(`group.${group}`)} shortLabel={t(`group.rail.${group}`)} icon={group} selected={Boolean(drawer&&!searchMode&&drawer.group===group)} expanded={Boolean(drawer&&!searchMode&&drawer.group===group)} iconSlot={group==='recommended'?<FirstUseHint play={hint}><Icon name="recommended"/></FirstUseHint>:undefined} onClick={()=>openGroup(group)}/>)}</nav></aside></IdleChrome>
   <PageBar placement="canvas" total={pageCount} current={pageIndex} hidden={isIdle||pageCount===1&&boardEmpty} onSelect={index=>run.actions.goToPage(index)} onAdd={()=>run.actions.addPage()} onLimit={()=>run.actions.addPage()}/>
   <EdgeZoneBand side="left" targetPage={edge?.side==='left'?edge.targetPage:Math.max(1,pageIndex)} visible={edge?.side==='left'}/>
   <EdgeZoneBand side="right" targetPage={edge?.side==='right'?edge.targetPage:pageIndex+2} visible={edge?.side==='right'}/>
   <p className="ui-sr-only" role="status" aria-live="polite">{announcement}</p>
  </main>):null;
 return <DndContext sensors={sensors} autoScroll={false} measuring={{draggable:{measure:node=>runtime.captured.get(node)??toCanvasRect(node.getBoundingClientRect(),coordinates.get())}}} accessibility={{restoreFocus:false,announcements:{onDragStart:()=>undefined,onDragMove:()=>undefined,onDragOver:()=>undefined,onDragEnd:()=>undefined,onDragCancel:()=>undefined},screenReaderInstructions:{draggable:t('ui.panel.openHelp')}}}>
  {renderScreen?renderScreen(boardBody):boardBody}
  {s.screen==='dashboard'?<DashboardNavis ref={navis} run={run} controller={runtime.controller} readRect={readRect} dragging={dragHidden} visible={!selectTemplateInteractionBlocked(s)&&!isIdle} navigation={navigation} onShowPanel={showPanel} onCreated={id=>{setCreated([id]);window.setTimeout(()=>setCreated([]),timePolicy.existingHighlightMs);}}/>:null}
  <FunctionDrawer showHint={drawerFeatures.some(feature=>!placedIds.has(feature.id))} open={Boolean(drawer)} title={searchMode?t('app.features.find'):drawer?t(`group.${drawer.group}`):''} resultCount={drawerFeatures.length} suppressReturnFocus={Boolean(active)} initialFocusRef={searchMode?searchRef:undefined} onClose={closeDrawer} search={drawer&&searchMode?<SearchField hideLabel value={drawer.query} inputRef={searchRef} onValueChange={value=>run.actions.openDrawer(drawer.group,value)}/>:undefined}>
   {drawerFeatures.length?drawerFeatures.map((f,index)=><div key={f.id}>{searchMode&&drawer?.query===''&&(index===0||drawerFeatures[index-1].groupId!==f.groupId)?<h2 className="dashboard-result-group">{t(`group.${f.groupId}`)}</h2>:null}<FeatureChoice feature={f} label={t(f.nameKey)} placed={placedIds.has(f.id)} controller={runtime.controller} readRect={readRect}/></div>):drawer?<div className="dashboard-search-empty"><InlineEmpty title={t('app.features.noResult')} action={<ActionButton variant="outline" onClick={()=>run.actions.openDrawer(drawer.group,'')}>{t('common.clearSearch')}</ActionButton>}/></div>:null}
  </FunctionDrawer>
  {exitingDrawer&&s.exitPendingToken?<OverlayExitSurface token={s.exitPendingToken} kind="drawer" onComplete={run.actions.finishOverlayExit}><header className="ui-overlay-header"><h2 className="ui-dialog-title">{searchMode?t('app.features.find'):t(`group.${exitingDrawer.group}`)}</h2></header><div className="ui-function-list">{exitFeatures.map(f=><FunctionRow key={f.id} label={t(f.nameKey)} icon={f.id} groupId={f.groupId} placed={placedIds.has(f.id)}/>)}</div><p className="ui-drawer__footer">{t('ui.drawer.footer1')}<br/>{t('ui.drawer.footer2')}</p></OverlayExitSurface>:null}
  <PanelToolsPopover unavailable={unavailable} open={Boolean(selected&&s.edit.mode==='edit'&&!active)} anchorRef={toolAnchor} label={selected?name(selected.featureId):''} width={selected?.width??1} height={selected?.height??1} onChange={size=>{if(selected)runtime.controller.resize(selected.featureId,size);}} onMove={delta=>{if(selected)runtime.controller.moveCell(selected.featureId,delta);}} onClose={()=>setTools(null)} pageSlot={pageCount>1?<PageSend current={pageIndex} total={pageCount} onSend={direction=>{if(selected)sendToPage(selected.featureId,direction);}}/>:null}/>
  <DashboardCoaches run={run} nodes={nodes} recommendNode={recommendNode} onFinishEditing={finishEditing}/>
  <NoticeHost notice={selectCommonNotice(s)?null:s.notice} translator={translator} featureLabel={s.notice?.featureId?name(s.notice.featureId):undefined} onUndo={layoutUndo} onDataUndo={dataUndoNotice} onPause={run.actions.pauseUndo} onResume={run.actions.resumeUndo} avoidRects={noticeAvoidRects}/>
  {portalContainer?createPortal(<DragOverlay modifiers={[({transform})=>{const offset=(active?.source==='feature'||active?.source==='candidate')&&ghostSize?drawerGhostOffset(active.origin,active.sourceRect,ghostSize):{x:0,y:0};return {...transform,x:transform.x+offset.x,y:transform.y+offset.y};}]} dropAnimation={null} transition="none" className="dashboard-drag-overlay" style={{width:ghostSize?.width,height:ghostSize?.height,pointerEvents:'none',zIndex:'var(--layer-drag)'}}>{ghostContent?<div className="dashboard-drag-ghost" aria-hidden="true" inert><PanelMotionFrame dragging lifted>{ghostContent}</PanelMotionFrame></div>:null}</DragOverlay>,portalContainer):null}
  {currentSnap&&portalContainer?createPortal(<motion.div key={currentSnap.token} className="dashboard-snap-ghost" aria-hidden="true" inert style={{left:0,top:0,width:currentSnap.to.width,height:currentSnap.to.height,transformOrigin:'top left'}} initial={{transform:reducedMotion?`translate3d(${currentSnap.to.x}px,${currentSnap.to.y}px,0) scale(1,1)`:`translate3d(${currentSnap.from.x}px,${currentSnap.from.y}px,0) scale(${currentSnap.from.width/currentSnap.to.width},${currentSnap.from.height/currentSnap.to.height})`,opacity:motionTokens.opacityDrag}} animate={{transform:`translate3d(${currentSnap.to.x}px,${currentSnap.to.y}px,0) scale(1,1)`,opacity:0}} transition={transitionFor('snap',reducedMotion)} onAnimationComplete={()=>setSnap(before=>before?.token===currentSnap.token?null:before)}>{(()=>{const p=s.panels.find(p=>p.featureId===currentSnap.featureId)??{width:1,height:1};return <GhostPanel run={run} layer={layer} featureId={currentSnap.featureId} width={p.width} height={p.height} condition={'condition' in p?p.condition:undefined} label={name(currentSnap.featureId)}/>;})()}</motion.div>,portalContainer):null}
 </DndContext>;
}
/** M-19 direction: a later page arrives from the right. */
function pageDirection(previous:number,next:number):number{return next>previous?1:next<previous?-1:0;}
export function DashboardScreen(props:DashboardScreenProps){const state=useRun(props.run);return state.screen==='dashboard'||props.renderScreen?<DashboardContent {...props}/>:null;}
