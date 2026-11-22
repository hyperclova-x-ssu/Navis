import { createStore } from 'zustand/vanilla';
import type { BlockedReason, CellSpan, CoachStep, CommandResult, DashboardBoard, DashboardLayerId, DashboardPage, DetailRef, DetailReturnState, FeatureId, GesturePreview, GuidanceProgress, InputSequence, LayerId, LayoutIntent, LayoutResult, LayoutResponse, LayoutWorkerResponse, Notice, OnboardingState, Panel, PreparedChange, PrepareResult, PreviewFamily, PreviewPosition, PreviewTarget, QueryCondition, ResolvedCatalog, RunActions, RunContext, RunOptions, RunResetOptions, RunSessionInput, RunState as BaseRunState, RunStore, SessionTransaction, SessionTransactionPort, ShopSettings, TableLayout, TimerScheduler, Theme, Locale, UndoEntry, UndoPauseReason, WidgetCoachStatus } from '../contracts';
import { locales } from '../contracts';
import type { NoticeRequest } from '../contracts';
import { getBusinessPreset, getManagementTemplates, getMarketingPreset, getRegistration } from '../catalog';
import { evaluate, fastPreview, layoutResult, nearestEmptyRect, samePanels } from '../layout';
import { layoutCacheKey } from '../layout/cache';
import { createLayoutWorkerClient } from '../layout/worker-client';
import { sameIdentity } from '../layout/worker-runtime';
import { createTableLayout, tableLayoutEnabled, validateTableLayout } from '../layout/table-layout';
import { createPosSeed, createPosUi } from '../pos/seed';
import { pauseOrderUndo, resumeOrderUndo } from '../pos/status';
import { normalizePosSettings, selectPosPreferences, validatePosSettingsChange } from '../pos/tables/preferences';
import { createLinkedOccupancyState, observeLinkedOccupancy, reconcileLinkedOccupancy } from '../data/iteration7/table-links';
import type { PosReadSnapshot } from '../contracts/pos';
import { initializeCustomPos } from '../data/pos/projection';
import { NORMAL_VARIANT, previewVariants } from '../data/preview/variants';
import { withoutRemovedWidgets } from './removed-widgets';
import { PAGE_LIMIT, type NavisLayoutPlan } from './navis-layout';
import { createBriefingDayGate, type BriefingDayOptions } from './briefing-day';
export { PAGE_LIMIT } from './navis-layout';
export { briefingBusinessDay, browserBriefingStorage, BRIEFING_LEAD_MINUTES, type BriefingDayOptions, type BriefingDayStorage } from './briefing-day';
export { runMessages } from './messages';

/** Shell presentation is independent of the board mirrors and their layout undo. */
export interface ChatReceiptIdentity { readonly proposalId: string }
interface ReceiptLayoutUndo { readonly layer: DashboardLayerId; readonly token: string }
export type ChatReceiptNoticeRequest = NoticeRequest & { readonly chatReceipt: ChatReceiptIdentity; readonly layoutUndo?: ReceiptLayoutUndo };
type ExpiringNotice = Notice & { readonly absoluteExpiry?: true };
export interface CommonNotice extends ExpiringNotice {
  readonly remainingMs: number;
  readonly chatReceipt?: ChatReceiptIdentity;
  readonly layoutUndo?: ReceiptLayoutUndo;
}
type RunState = BaseRunState & { readonly commonNotice: CommonNotice | null; readonly inlineChatReceipt?: ChatReceiptIdentity; readonly detailReturn: DetailReturnState | null; readonly detailState: DetailReturnState | null; readonly closingParent: Extract<BaseRunState['overlay'],{type:'detail'}> | null; readonly demoRestart?: boolean };
export const selectDemoRestart = (state: BaseRunState): boolean => (state as RunState).demoRestart === true;
export const selectCommonNotice = (state: BaseRunState): CommonNotice | null => 'commonNotice' in state ? (state as RunState).commonNotice : null;
export function selectChatReceiptNotice(state: BaseRunState): CommonNotice | null {
  const notice = selectCommonNotice(state);
  return notice?.chatReceipt && notice.undo && notice.remainingMs > 0 && notice.chatReceipt === (state as RunState).inlineChatReceipt ? notice : null;
}
export function selectCommonNoticePresentation(state: BaseRunState): CommonNotice | null {
  return selectChatReceiptNotice(state) ? null : selectCommonNotice(state);
}
export function setChatReceiptVisible(run: RunStore, receipt: ChatReceiptIdentity, visible: boolean) {
  (run.actions as Partial<RunPresentationActions>).setChatReceiptVisible?.(receipt, visible);
}
export const selectDetailReturn = (state: BaseRunState): DetailReturnState | null => 'detailReturn' in state ? (state as RunState).detailReturn : null;
export const selectDetailViewState = (state: BaseRunState): DetailReturnState | null => 'detailState' in state ? (state as RunState).detailState : null;
/** REAL-PLAN F00: the durable part of a run, read from the account service when a session starts. */
export interface AccountRestore {
  readonly theme:Theme;
  readonly textScale:100|125;
  readonly locale:Locale;
  readonly onboardingDone:boolean;
  readonly resumeDemoRestart?:boolean;
  readonly settings:ShopSettings;
  readonly boards:Readonly<Record<DashboardLayerId,{readonly pages:readonly DashboardPage[];readonly currentPage:number;readonly revision:number}>>;
}
export interface RunPresentationActions extends RunActions {
  readonly commitNavisLayout: (plan: NavisLayoutPlan, options?: { readonly deferNotice?: boolean }) => CommandResult;
  readonly removePage: (page: DashboardPage, expectedLayoutRevision: number) => boolean;
  /** Replace theme, language, settings, onboarding state and both boards with the stored account state. Returns false when it is invalid for this run (the run is left untouched). */
  readonly restoreAccount:(restore:AccountRestore)=>boolean;
  readonly restartOnboarding:()=>boolean;
  readonly chooseDemoLayout:(templateId:OnboardingState['selectedTemplateId'])=>boolean;
  readonly finishDemoRestart:(transitionToken:string)=>boolean;
  readonly setChatReceiptVisible: (receipt: ChatReceiptIdentity, visible: boolean) => void;
  /** Update the current onboarding table draft without advancing its step. */
  readonly updateOnboardingTableDraft:(layout:TableLayout,identity:{readonly runId:string;readonly transitionToken:string})=>boolean;
  readonly rememberDetailState:(state:DetailReturnState)=>boolean;
  readonly openLinkedDetail:(ref:DetailRef,source?:DetailReturnState)=>boolean;
  readonly closeTemplateTour:(input?:InputSequence)=>boolean;
  readonly visualSettled:(completion?:{readonly runId:string;readonly transitionToken:string})=>void;
}
export interface PresentationRunStore extends RunStore {readonly actions:RunPresentationActions}
export const TEMPLATE_TOUR_START_MS = 400;

const steps: readonly CoachStep[] = ['choose-feature','resize-panel','move-panel'];
const dashboardLayers: readonly DashboardLayerId[] = ['management','marketing'];
const layerIds: readonly LayerId[] = ['orders-payment','management','marketing'];
const businesses = ['cafe','restaurant','pub','beauty','retail','academy','fitness','other'] as const;
const families: readonly PreviewFamily[] = ['normal','empty','error','special'];
const isDashboardLayer=(layer:LayerId):layer is DashboardLayerId=>layer==='management'||layer==='marketing';
const sameInput=(a:InputSequence|null|undefined,b:InputSequence):boolean=>a?.kind===b.kind&&a.id===b.id;
const snapshot=(panels:readonly Panel[]):readonly Panel[]=>Object.freeze(panels.map(p=>Object.freeze({...p})));
const snapshotPages=(pages:readonly DashboardPage[]):readonly (readonly Panel[])[]=>Object.freeze(pages.map(page=>snapshot(page.panels)));
const isAdd=(intent:LayoutIntent):boolean=>intent.type==='add-tap'||intent.type==='add-drop'||intent.type==='add-ai'||intent.type==='add-candidate-tap';
function immutable<T>(value:T):T {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    Object.freeze(value);for(const child of Object.values(value))immutable(child);
  }return value;
}
const copyDetailRef=(ref:DetailRef):DetailRef=>immutable({
  featureId:ref.featureId,
  ...(ref.view===undefined?{}:{view:ref.view}),
  ...(ref.itemId===undefined?{}:{itemId:ref.itemId}),
  ...(ref.focus===undefined?{}:{focus:ref.focus}),
  ...(ref.date===undefined?{}:{date:ref.date}),
  ...(ref.condition===undefined?{}:{condition:{...ref.condition}}),
  ...(ref.time===undefined?{}:{time:ref.time}),
  ...(ref.hour===undefined?{}:{hour:ref.hour}),
  ...(ref.filter===undefined?{}:{filter:typeof ref.filter==='string'?ref.filter:{...ref.filter}}),
  ...(ref.prefill===undefined?{}:{prefill:structuredClone(ref.prefill)}),
});
function emptyGuidance():GuidanceProgress{
  return {firstHintSeen:false,coach:{'choose-feature':'unseen','resize-panel':'unseen','move-panel':'unseen'},active:null,targetFeatureId:null,queue:[],panelMilestones:{first:false,second:false},nextCoachAt:Infinity,dashboardReady:false,visualPending:false,widgetCoach:{},widgetQueue:[],activeWidget:null};
}
const pageId=(layer:DashboardLayerId,index:number)=>`${layer}-${index+1}`;
function pageIdAllocator(board:DashboardBoard):()=>string{
  const occupied=new Set(board.pages.map(page=>page.pageId));
  if(board.undo?.removedPageId)occupied.add(board.undo.removedPageId);
  let index=board.pages.length;
  return ()=>{
    let id=pageId(board.layerId,index++);
    while(occupied.has(id))id=pageId(board.layerId,index++);
    return id;
  };
}
function newBoard(layerId:DashboardLayerId):DashboardBoard{
  return {layerId,pages:[{pageId:pageId(layerId,0),panels:[]}],currentPage:0,revision:0,guidance:emptyGuidance(),starter:'ready',undo:null,notice:null};
}
/** The single write helper for mirrors: panels, guidance, starter, undo and notice always equal boards[activeBoard] (viewed page). */
function mirror(s:RunState):RunState{
  const board=s.boards[s.activeBoard],panels=board.pages[board.currentPage].panels;
  if(s.panels===panels&&s.guidance===board.guidance&&s.starter===board.starter&&s.undo===board.undo&&s.notice===board.notice)return s;
  return {...s,panels,guidance:board.guidance,starter:board.starter,undo:board.undo,notice:board.notice};
}
type BoardPatch=Partial<Pick<DashboardBoard,'pages'|'currentPage'|'revision'|'guidance'|'starter'|'undo'|'notice'>>&{readonly panels?:readonly Panel[]};
/** Writes the source board (and through mirror() the read-only mirrors). panels replaces the board's (new) current page. */
function writeBoard(s:RunState,layer:DashboardLayerId,patch:BoardPatch):RunState{
  const board=s.boards[layer];
  const currentPage=patch.currentPage??board.currentPage;
  let pages=patch.pages??board.pages;
  if(patch.panels&&patch.panels!==pages[currentPage].panels)pages=pages.map((page,index)=>index===currentPage?{...page,panels:patch.panels!}:page);
  const next:DashboardBoard={layerId:board.layerId,pages,currentPage,revision:patch.revision??board.revision,guidance:patch.guidance??board.guidance,starter:patch.starter??board.starter,undo:patch.undo===undefined?board.undo:patch.undo,notice:patch.notice===undefined?board.notice:patch.notice};
  // No-op writes keep the same objects so unchanged ticks never notify subscribers.
  if((Object.keys(next) as (keyof DashboardBoard)[]).every(key=>Object.is(next[key],board[key])))return mirror(s);
  return mirror({...s,boards:{...s.boards,[layer]:next}});
}
const writeActive=(s:RunState,patch:BoardPatch):RunState=>writeBoard(s,s.activeBoard,patch);
function initial(options:RunOptions,now:number,id:string,theme=options.theme):RunState{
  const boards={management:newBoard('management'),marketing:newBoard('marketing')};
  return mirror({runId:id,screenPreset:options.screenPreset,screen:'business-question',businessType:null,panels:[],layoutRevision:0,edit:{mode:'view',gesture:null,gestureToken:null,selectedFeatureId:null},gesturePreview:null,overlay:{type:'none'},exitPendingToken:null,exitingOverlay:null,closingInput:null,guidance:boards.management.guidance,starter:'ready',briefing:'pending',briefingSafeSince:null,idle:{mode:'active',lastInputAt:now,blockedReasons:[],wakeInputToken:null},activeInputs:[],pageHidden:false,theme,textScale:100,reducedMotion:options.reducedMotion??false,undo:null,notice:null,layer:'management',activeBoard:'management',boards,locale:'ko',preview:{family:'normal',overrides:{}},widgetHelp:null,runRevision:0,transactionId:null,transitionToken:`${id}:initial`,onboarding:{step:'business',draft:{businessType:null,paymentStyle:null,tableLayout:null},selectedTemplateId:null,applyToken:null},templateTour:null,shopSettings:{businessType:null,paymentStyle:null,tableLayout:null,revision:0,cctvPosLinks:[]},pos:initializeCustomPos(createPosSeed()),posRevision:0,posUi:createPosUi(),detailDialogFullscreen:false,linkedOccupancy:createLinkedOccupancyState(),linkedActiveZoneIds:[],commonNotice:null,detailReturn:null,detailState:null,closingParent:null});
}
const boardHas=(board:DashboardBoard,featureId:FeatureId)=>board.pages.some(page=>page.panels.some(p=>p.featureId===featureId));
const boardEmpty=(board:DashboardBoard)=>board.pages.every(page=>!page.panels.length);
const boardPanelCount=(board:DashboardBoard)=>board.pages.reduce((n,page)=>n+page.panels.length,0);
const dashboardVisible=(s:RunState)=>s.layer===s.activeBoard;
const onViewedPage=(s:RunState,featureId:FeatureId)=>s.panels.some(p=>p.featureId===featureId);

export interface BoardPanelEntry { readonly pageIndex:number; readonly panel:Panel }
export interface PanelPlacement { readonly layer:DashboardLayerId; readonly pageIndex:number; readonly panel:Panel }
const boardPanelsMemo=new WeakMap<DashboardBoard,readonly BoardPanelEntry[]>();
/** Every page of one layer (default: the active board). Same board object, same array. */
export function selectBoardPanels(state:BaseRunState,layer:DashboardLayerId=state.activeBoard):readonly BoardPanelEntry[]{
  const board=state.boards[layer];let entries=boardPanelsMemo.get(board);
  if(!entries){entries=Object.freeze(board.pages.flatMap((page,pageIndex)=>page.panels.map(panel=>Object.freeze({pageIndex,panel}))));boardPanelsMemo.set(board,entries);}
  return entries;
}
/** Where a widget is placed in this run (active board first), or null. */
export function findPlacement(state:BaseRunState,featureId:FeatureId):PanelPlacement|null{
  for(const layer of [state.activeBoard,...dashboardLayers.filter(l=>l!==state.activeBoard)]){
    const entry=selectBoardPanels(state,layer).find(e=>e.panel.featureId===featureId);
    if(entry)return {layer,pageIndex:entry.pageIndex,panel:entry.panel};
  }
  return null;
}

function blockers(s:RunState):BlockedReason[]{
  const reasons:BlockedReason[]=[];
  if(coachingBlocks(s))reasons.push('coaching');
  if(s.overlay.type!=='none')reasons.push(s.overlay.type==='closing'?'detail':s.overlay.type);
  if(s.edit.mode==='edit')reasons.push('edit');
  if(s.activeInputs.length||s.edit.gesture)reasons.push('pointer-active');
  if(s.gesturePreview?.status==='pending')reasons.push('layout-pending');
  if(s.notice||s.commonNotice)reasons.push('notice-visible');
  if(s.exitPendingToken)reasons.push('overlay-exit');
  if(s.pageHidden)reasons.push('page-hidden');
  return reasons;
}
/** Visible coach, help, or a queued item that could be shown now (target on the viewed page). */
function coachingBlocks(s:RunState):boolean{
  if(templateBlocked(s))return true;
  const g=s.guidance;
  if(g.active||g.activeWidget||s.widgetHelp)return true;
  return dashboardVisible(s)&&(g.queue.some(step=>hasTarget(s,step))||g.widgetQueue.some(id=>onViewedPage(s,id)));
}
function templateBlocked(s:BaseRunState):boolean{return s.onboarding.step==='applying'||!!s.templateTour&&s.templateTour.status!=='completed';}
export const selectTemplateInteractionBlocked=templateBlocked;
export function selectTemplateTour(state:BaseRunState):{readonly current:number;readonly total:number;readonly targetFeatureId:FeatureId;readonly coachKey:string}|null{
  const tour=state.templateTour;if(tour?.status!=='active')return null;
  const targetFeatureId=tour.targets[tour.index],registration=getRegistration(targetFeatureId);
  return {current:tour.index+1,total:tour.targets.length,targetFeatureId,coachKey:registration!.coachKey};
}
function coachSafe(s:RunState):boolean{return !templateBlocked(s)&&s.screen==='dashboard'&&dashboardVisible(s)&&s.guidance.dashboardReady&&!s.guidance.visualPending&&s.overlay.type==='none'&&!s.widgetHelp&&!s.exitPendingToken&&!s.gesturePreview&&!s.edit.gesture&&!s.activeInputs.length&&!s.pageHidden;}
function target(s:RunState,step:CoachStep):Panel['featureId']|null{return step==='choose-feature'?null:s.panels[0]?.featureId??null;}
function hasTarget(s:RunState,step:CoachStep):boolean{return step==='choose-feature'||s.panels.length>0&&(step==='resize-panel'?s.edit.mode==='edit'&&s.guidance.coach['move-panel']==='dismissed':s.edit.mode==='view');}
function queueStep(g:GuidanceProgress,step:CoachStep):GuidanceProgress{
  return g.coach[step]==='unseen'?{...g,coach:{...g.coach,[step]:'queued'},queue:[...g.queue,step]}:g;
}
function queueWidget(g:GuidanceProgress,featureId:FeatureId):GuidanceProgress{
  return g.widgetCoach[featureId]===undefined?{...g,widgetCoach:{...g.widgetCoach,[featureId]:'queued'},widgetQueue:[...g.widgetQueue,featureId]}:g;
}
/** A visible widget explanation goes back to the front of its queue without a record. */
function requeueWidget(g:GuidanceProgress):GuidanceProgress{
  const id=g.activeWidget;if(!id)return g;
  return {...g,activeWidget:null,widgetCoach:{...g.widgetCoach,[id]:'queued'},widgetQueue:[id,...g.widgetQueue.filter(x=>x!==id)]};
}
/** A visible F-03 step whose target is page-bound goes back to the front of its queue without a record. */
function requeueStep(g:GuidanceProgress):GuidanceProgress{
  const step=g.active;if(!step||step==='choose-feature')return g;
  return {...g,active:null,targetFeatureId:null,coach:{...g.coach,[step]:'queued'},queue:[step,...g.queue.filter(x=>x!==step)]};
}
/** Explanations whose widget left the board are dropped back to 'not seen'. */
function pruneWidgets(board:DashboardBoard,t:number,gapMs:number):GuidanceProgress{
  const g=board.guidance;
  const drop=new Set([...(g.activeWidget&&!boardHas(board,g.activeWidget)?[g.activeWidget]:[]),...g.widgetQueue.filter(id=>!boardHas(board,id))]);
  if(!drop.size)return g;
  const widgetCoach:Partial<Record<FeatureId,WidgetCoachStatus>>={...g.widgetCoach};for(const id of drop)delete widgetCoach[id];
  const droppedVisible=g.activeWidget!==null&&drop.has(g.activeWidget);
  return {...g,widgetCoach,widgetQueue:g.widgetQueue.filter(id=>!drop.has(id)),activeWidget:droppedVisible?null:g.activeWidget,nextCoachAt:droppedVisible?Math.max(g.nextCoachAt,t+gapMs):g.nextCoachAt};
}

/** One isolated, memory-only run. clock must report monotonic milliseconds. */
function validateContext(context:RunContext):RunContext {
  if(context.catalog.some(feature=>feature.presetId!==context.screenPreset.id))throw new TypeError('Catalog preset must match the screen preset');
  return immutable(context);
}
/** Board catalogs: every registry entry carries its layer, and a board accepts only its own layer's widgets (API-02 v4). */
function layerCatalogs(catalog:ResolvedCatalog):{readonly boards:Readonly<Record<DashboardLayerId,ResolvedCatalog>>}{
  const member=(feature:ResolvedCatalog[number],layer:DashboardLayerId)=>getRegistration(feature.id)?.layer===layer;
  return {boards:Object.freeze({management:Object.freeze(catalog.filter(f=>member(f,'management'))),marketing:Object.freeze(catalog.filter(f=>member(f,'marketing')))})};
}
/** Keep semantic defaults in the core; the data boundary normalizes them for each widget. */
const defaultCondition=():QueryCondition=>({kind:'default'});
const asSpan=(value:number):CellSpan=>(Number.isInteger(value)&&value>=1&&value<=4?value:1) as CellSpan;

export function createRunStore(options:RunOptions&BriefingDayOptions):PresentationRunStore{
  const briefingDay=createBriefingDayGate(options);
  let context=validateContext({screenPreset:options.screenPreset,catalog:options.catalog});
  let catalogs=layerCatalogs(context.catalog);
  let adapter=options.layoutAdapter??createLayoutWorkerClient();let disposed=false;
  const initialOptions=(reset?:RunResetOptions):RunOptions=>({...options,...context,...reset});
  let lastNow=options.clock();let runStartedAt=lastNow;let serial=0;let editStartRevision:number|null=null;
  let readyAt:Record<DashboardLayerId,number|null>={management:null,marketing:null};
  /** Paused data-undo notices (their timer has no UndoEntry): notice id -> remaining time and reasons. */
  const noticePauses=new Map<string,{remainingMs:number;reasons:UndoPauseReason[]}>();
  const commonPauses=new Map<DashboardLayerId,{at:number;undoToken:string|undefined;undoRemaining:number;noticeId:string|undefined;noticeRemaining:number}>();
  const layoutTime=(layer:DashboardLayerId,t:number)=>commonPauses.get(layer)?.at??t;
  const now=()=>{lastNow=Math.max(lastNow,options.clock());return lastNow;};
  const unique=()=>`${options.createId?.()??globalThis.crypto.randomUUID()}-${++serial}`;
  const consumedGestures=new Set<string>();
  const vanilla=createStore<RunState>(()=>immutable(initial(initialOptions(),lastNow,unique())));
  const listeners=new Set<(state:RunState,previous:RunState)=>void>();
  const notify=(previous:RunState)=>{
    const state=vanilla.getState();
    for(const listener of [...listeners]){try{listener(state,previous);}catch{/* Published snapshots survive an individual subscriber failure. */}}
  };
  // Eligibility reads POS/settings only; no data, camera frames or business timestamps enter it.
  const occupancyRead=(s:RunState)=>({pos:s.pos,settings:s.shopSettings} as PosReadSnapshot);
  const reconcileOccupancy=(s:RunState,t=now()):RunState=>{
    const previous=s.linkedOccupancy;
    if(!previous.observations.length&&!previous.seatedWithoutOrder.length)return s;
    const next=reconcileLinkedOccupancy(occupancyRead(s),previous,Math.max(previous.elapsedNow,t-runStartedAt),s.linkedActiveZoneIds);
    return next===previous?s:{...s,linkedOccupancy:next};
  };
  const store={getState:vanilla.getState,setState(next:RunState,replace:true=true){const previous=vanilla.getState();vanilla.setState(immutable(reconcileOccupancy(next)),replace);notify(previous);},subscribe(listener:(state:RunState,previous:RunState)=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};}};
  const prepared=new Map<string,{change:PreparedChange;tx:SessionTransaction;previous:RunState;next:RunState}>();
  let published:{transactionId:string;previous:RunState}|null=null,flushing=false;
  const busy=()=>disposed||flushing||published!==null||!!options.sessionGate&&options.sessionGate.phase!=='idle';
  const grid=()=>context.screenPreset.grid;
  const boardCatalog=(layer:DashboardLayerId)=>catalogs.boards[layer];
  const knownFeature=(id:string)=>context.catalog.some(f=>f.id===id)||getRegistration(id)!==undefined;
  /** In the run's explicit catalog but not on this board's (unknown ids stay UNKNOWN_FEATURE). */
  const otherLayer=(layer:DashboardLayerId,id:FeatureId)=>!boardCatalog(layer).some(f=>f.id===id)&&context.catalog.some(f=>f.id===id);
  const currentLayout=(s=store.getState())=>evaluate(s.panels,grid(),boardCatalog(s.activeBoard));
  function reconcile(s:RunState,previous:RunState,t:number):RunState{
    if(s.templateTour?.status==='waiting'&&s.onboarding.step==='done'&&!s.pageHidden&&t>=s.templateTour.readyAt)s={...s,templateTour:{...s.templateTour,status:'active'}};
    if(s.commonNotice&&t>=s.commonNotice.expiresAt){noticePauses.delete(s.commonNotice.id);s={...s,commonNotice:null};}
    if(previous.commonNotice&&previous.commonNotice.id!==s.commonNotice?.id){
      noticePauses.delete(previous.commonNotice.id);
      const backing=previous.commonNotice.layoutUndo;
      if(backing){
        const board=s.boards[backing.layer];
        if(board.undo?.token===backing.token){
          s=writeBoard(s,backing.layer,{undo:null,notice:board.notice?.undoToken===backing.token?null:board.notice});
        }
      }
    }
    if(s.commonNotice){
      for(const layer of dashboardLayers){
        const board=s.boards[layer],saved=commonPauses.get(layer);
        if(!saved||saved.undoToken!==board.undo?.token||saved.noticeId!==board.notice?.id)commonPauses.set(layer,{at:t,undoToken:board.undo?.token,undoRemaining:board.undo?(board.undo.pausedReasons.length?board.undo.remainingMs:Math.max(0,board.undo.expiresAt-t)):0,noticeId:board.notice?.id,noticeRemaining:board.notice?Math.max(0,board.notice.expiresAt-t):0});
      }
    }else if(commonPauses.size){
      const releasedAt=Math.min(t,previous.commonNotice?.expiresAt??t);
      for(const layer of dashboardLayers){
        const saved=commonPauses.get(layer),board=s.boards[layer];if(!saved)continue;
        const undo=board.undo&&board.undo.token===saved.undoToken?{...board.undo,remainingMs:saved.undoRemaining,expiresAt:releasedAt+saved.undoRemaining}:board.undo;
        const notice=board.notice&&board.notice.id===saved.noticeId?{...board.notice,expiresAt:releasedAt+saved.noticeRemaining}:board.notice;
        s=writeBoard(s,layer,{undo,notice});
      }
      commonPauses.clear();
    }
    for(const layer of dashboardLayers){
      const board=s.boards[layer];
      let undo=board.undo;let notice=board.notice;
      if(undo&&!s.commonNotice&&!undo.pausedReasons.length&&t>=undo.expiresAt)undo=null;
      if(notice?.undoToken){
        if(undo?.token===notice.undoToken){const expiresAt=undo.pausedReasons.length?Infinity:undo.expiresAt;if(notice.expiresAt!==expiresAt)notice={...notice,expiresAt};}
        else notice=null;
      }else if(notice&&!s.commonNotice&&t>=notice.expiresAt)notice=null;
      if(board.notice&&notice?.id!==board.notice.id)noticePauses.delete(board.notice.id);
      const guidance=pruneWidgets(board,t,options.time.coachGapMs);
      if(undo!==board.undo||notice!==board.notice||guidance!==board.guidance)s=writeBoard(s,layer,{undo,notice,guidance});
    }
    let guidance=s.guidance;
    if(guidance.active&&(!hasTarget(s,guidance.active)||s.overlay.type!=='none'||s.pageHidden)){
      const active=guidance.active;
      guidance={...guidance,active:null,targetFeatureId:null,coach:{...guidance.coach,[active]:'queued'},queue:[active,...guidance.queue.filter(x=>x!==active)]};
    }
    if(guidance.activeWidget&&(!onViewedPage(s,guidance.activeWidget)||s.overlay.type!=='none'||s.pageHidden||!dashboardVisible(s)||s.idle.mode==='idle'))guidance=requeueWidget(guidance);
    if(guidance!==s.guidance)s=writeActive(s,{guidance});
    if(!guidance.active&&!guidance.activeWidget&&coachSafe(s)&&t>=guidance.nextCoachAt){
      const step=guidance.queue.find(candidate=>hasTarget(s,candidate));
      if(step)guidance={...guidance,active:step,targetFeatureId:target(s,step),coach:{...guidance.coach,[step]:'visible'},queue:guidance.queue.filter(candidate=>candidate!==step)};
      else {const id=guidance.widgetQueue.find(x=>onViewedPage(s,x));if(id)guidance={...guidance,activeWidget:id,widgetCoach:{...guidance.widgetCoach,[id]:'visible'},widgetQueue:guidance.widgetQueue.filter(x=>x!==id)};}
    }else if(guidance.active&&guidance.active!=='choose-feature'&&guidance.targetFeatureId!==target(s,guidance.active))guidance={...guidance,targetFeatureId:target(s,guidance.active)};
    if(guidance!==s.guidance)s=writeActive(s,{guidance});
    let reasons=blockers(s);
    const safe=s.screen==='dashboard'&&s.layer!=='orders-payment'&&!reasons.length&&!guidance.visualPending;
    let idle=s.idle;
    // Start the idle interval when the final blocker clears, rather than changing
    // a timestamp on every tick while the UI is blocked.
    if(safe&&(previous.idle.blockedReasons.length||previous.guidance.visualPending&&!guidance.visualPending)&&idle.lastInputAt!==t)idle={...idle,lastInputAt:t};
    let briefingSafeSince=s.briefingSafeSince;
    // The arrival briefing follows the management board's F-03 steps and shows only over management.
    const coachingComplete=s.layer==='management'&&s.activeBoard==='management'&&steps.every(step=>s.boards.management.guidance.coach[step]==='dismissed'||step==='resize-panel'&&s.edit.mode==='view'&&s.boards.management.guidance.coach[step]==='queued');
    // D-327: automatic only on the first visit of a business day. Once it has shown (or this run was told it already
    // showed today) the card stays closed for new runs of that day; its widget detail and the chat still open it by hand.
    if(safe&&coachingComplete&&s.briefing==='pending'&&!briefingDay.settled(s.runId)){
      briefingSafeSince??=t;
      if(t-briefingSafeSince>=options.time.briefingSafeMs){
        briefingSafeSince=null;
        if(briefingDay.claim(s.runId)){s={...s,briefing:'visible',overlay:{type:'briefing'}};reasons=blockers(s);idle={...idle,mode:'active',lastInputAt:t};}
      }
    }else briefingSafeSince=null;
    if(safe&&s.overlay.type==='none'&&idle.mode==='active'&&t-idle.lastInputAt>=options.time.idleMs)idle={...idle,mode:'idle'};
    if(reasons.length!==idle.blockedReasons.length||reasons.some((reason,i)=>reason!==idle.blockedReasons[i]))idle={...idle,blockedReasons:reasons};
    return {...s,idle,briefingSafeSince};
  }
  function update(fn:(s:RunState,t:number)=>RunState,tick=false):void{
    if(busy())return;
    const previous=store.getState();const t=now();let proposed=fn(previous,t);
    const detailKey=(state:RunState)=>state.overlay.type==='detail'?state.overlay.featureId:state.overlay.type;
    const changedContext=previous.screen==='dashboard'&&(
      previous.layer!==proposed.layer||previous.boards[previous.activeBoard].currentPage!==proposed.boards[previous.activeBoard].currentPage||
      previous.edit.mode==='view'&&proposed.edit.mode==='edit'||
      detailKey(previous)!==detailKey(proposed)&&!(previous.overlay.type==='closing'&&proposed.overlay.type==='none')&&!(previous.overlay.type==='settings'&&proposed.overlay.type==='none'&&previous.commonNotice?.messageKey==='settings.businessChanged')
    );
    if(changedContext){
      const oldNotice=previous.boards[previous.activeBoard].notice;
      if(oldNotice&&!(oldNotice.messageKey==='duplicate-other-page'&&(previous.boards[previous.activeBoard].currentPage!==proposed.boards[previous.activeBoard].currentPage||previous.overlay.type==='drawer'&&proposed.overlay.type==='none'))&&proposed.boards[previous.activeBoard].notice?.id===oldNotice.id)proposed=writeBoard(proposed,previous.activeBoard,{notice:null});
      if(previous.commonNotice&&!previous.commonNotice.chatReceipt&&proposed.commonNotice?.id===previous.commonNotice.id)proposed={...proposed,commonNotice:null};
    }
    let next=mirror(reconcileOccupancy(reconcile(proposed,previous,t),t));
    const unchanged=()=> (Object.keys(next) as (keyof RunState)[]).every(key=>Object.is(next[key],previous[key]));
    // A timer arriving before every transition must not publish a countdown-only snapshot.
    if(tick&&unchanged())return;
    if(next.commonNotice){const remainingMs=noticePauses.get(next.commonNotice.id)?.remainingMs??Math.max(0,next.commonNotice.expiresAt-t);if(remainingMs!==next.commonNotice.remainingMs)next={...next,commonNotice:{...next.commonNotice,remainingMs}};}
    if(unchanged())return;
    prepared.clear();store.setState(immutable({...next,runRevision:previous.runRevision+1}),true);
  }
  const response=(layout:LayoutResponse,s=store.getState()):CommandResult=>({...layout,revision:s.layoutRevision,...('existingFeatureId' in layout&&layout.existingFeatureId?{highlightFeatureId:layout.existingFeatureId}:{})});
  const rejected=(code:NonNullable<LayoutResult['code']>):CommandResult=>response({...currentLayout(),status:'rejected',valid:false,code});
  interface NoticeContext { readonly existingPage?:number; readonly pageMove?:boolean }
  function errorNotice(code:NonNullable<LayoutResult['code']>,featureId?:Panel['featureId'],extra:NoticeContext={}):void{
    if(code==='CANCELLED'||code==='STALE_REVISION')return;
    update((s,t)=>{
      const layerId=s.activeBoard;
      const base={id:unique(),featureId,layerId};
      let notice:Notice;
      if(code==='DUPLICATE'&&extra.existingPage!==undefined)notice={...base,kind:'duplicate',messageKey:'duplicate-other-page',params:{n:extra.existingPage+1},expiresAt:t+options.time.noticeMs};
      else if(code==='DUPLICATE')notice={...base,kind:'duplicate',messageKey:code,expiresAt:t+options.time.existingHighlightMs};
      else if(code==='OTHER_LAYER')notice={...base,kind:'error',messageKey:'other-layer',params:{layer:(featureId&&getRegistration(featureId)?.layer)??''},expiresAt:t+options.time.noticeMs};
      else if(code==='NO_CAPACITY'&&extra.pageMove)notice={...base,kind:'error',messageKey:'no-room-next-page',expiresAt:t+options.time.noticeMs};
      else if(code==='NO_CAPACITY')notice={...base,kind:'error',messageKey:code,params:{maxPages:s.boards[layerId].pages.length>=PAGE_LIMIT?1:0},expiresAt:t+options.time.noticeMs};
      else if(code==='PAGE_LIMIT')notice={...base,kind:'error',messageKey:'page-limit',expiresAt:t+options.time.noticeMs};
      else notice={...base,kind:'error',messageKey:code,expiresAt:t+options.time.noticeMs};
      return writeActive(s,{notice});
    });
  }
  function paused(undo:UndoEntry|null,reason:UndoPauseReason,t:number,pause:boolean):UndoEntry|null{
    if(!undo)return null;
    if(pause){
      if(undo.pausedReasons.includes(reason))return undo;
      if(!undo.pausedReasons.length&&t>=undo.expiresAt)return null;
      return {...undo,remainingMs:undo.pausedReasons.length?undo.remainingMs:Math.max(0,undo.expiresAt-t),pausedReasons:[...undo.pausedReasons,reason]};
    }
    if(!undo.pausedReasons.includes(reason))return undo;
    const pausedReasons=undo.pausedReasons.filter(x=>x!==reason);
    return {...undo,pausedReasons,expiresAt:pausedReasons.length?undo.expiresAt:t+undo.remainingMs};
  }
  /** Local notices follow the pause rules for layout undo. Server receipt deadlines keep counting down. */
  function pausedNotice<T extends ExpiringNotice>(notice:T|null,reason:UndoPauseReason,t:number,pause:boolean):T|null{
    if(!notice||notice.absoluteExpiry)return notice;
    const entry=noticePauses.get(notice.id);
    if(pause){
      if(entry?.reasons.includes(reason))return notice;
      if(!entry&&t>=notice.expiresAt)return notice;
      noticePauses.set(notice.id,entry?{...entry,reasons:[...entry.reasons,reason]}:{remainingMs:Math.max(0,notice.expiresAt-t),reasons:[reason]});
      return notice.expiresAt===Infinity?notice:{...notice,expiresAt:Infinity};
    }
    if(!entry?.reasons.includes(reason))return notice;
    const reasons=entry.reasons.filter(x=>x!==reason);
    if(reasons.length){noticePauses.set(notice.id,{...entry,reasons});return notice;}
    noticePauses.delete(notice.id);return {...notice,expiresAt:t+entry.remainingMs};
  }
  function shellNotice(s:RunState,notice:ExpiringNotice,t:number):CommonNotice{
    const next=s.pageHidden?pausedNotice(notice,'page-hidden',t,true)!:notice;
    return {...next,remainingMs:noticePauses.get(next.id)?.remainingMs??Math.max(0,next.expiresAt-t)};
  }
  function withDefaultConditions(layout:LayoutResult,intent:LayoutIntent):LayoutResult {
    if(!['add-tap','add-drop','starter'].includes(intent.type))return layout;
    const ids=intent.type==='starter'?intent.featureIds:'featureId' in intent?[intent.featureId]:[];
    return {...layout,panels:layout.panels.map(p=>p.condition||!ids.includes(p.featureId)?p:{...p,condition:defaultCondition()})};
  }
  /** Layer-wide pre-checks before the page engine (API-02 v4): membership, then duplicates on other pages. */
  function precheck(s:RunState,intent:LayoutIntent):CommandResult|null{
    const ids=intent.type==='starter'?intent.featureIds:intent.type==='restore'?intent.panels.map(p=>p.featureId):isAdd(intent)?['featureId' in intent?intent.featureId:null]:[];
    const board=s.boards[s.activeBoard];
    for(const id of ids){
      if(!id)continue;
      if(otherLayer(s.activeBoard,id)){errorNotice('OTHER_LAYER',id);return rejected('OTHER_LAYER');}
      const found=selectBoardPanels(s).find(e=>e.panel.featureId===id);
      if(found&&found.pageIndex!==board.currentPage){
        errorNotice('DUPLICATE',id,{existingPage:found.pageIndex});
        return response({...currentLayout(s),status:'unchanged',code:'DUPLICATE',existingFeatureId:id,existingPage:found.pageIndex});
      }
    }
    return null;
  }
  function commitResolved(intent:LayoutIntent,layout:LayoutResult,baseRevision:number,fromStarter=false,pageIndex?:number):CommandResult{
    const before=store.getState();
    if(disposed||baseRevision!==before.layoutRevision)return rejected('STALE_REVISION');
    if(before.idle.wakeInputToken||before.closingInput)return rejected('CANCELLED');
    if(layout.status!=='accepted'){
      if(layout.code)errorNotice(layout.code,layout.existingFeatureId);
      return response(layout);
    }
    if(!evaluate(layout.panels,grid(),boardCatalog(before.activeBoard)).valid)return rejected('INTERNAL_LAYOUT_ERROR');
    layout=withDefaultConditions(layout,intent);
    adapter.cancel();
    update((s,t)=>{
      const board=s.boards[s.activeBoard],page=pageIndex??board.currentPage,previousPanels=board.pages[page].panels;
      const revision=s.layoutRevision+1,boardRevision=board.revision+1;
      const count=boardPanelCount(board)-previousPanels.length+layout.panels.length;
      let guidance=board.guidance;
      if(isAdd(intent)||intent.type==='starter'){
        if(!guidance.panelMilestones.first&&count>=1){guidance=queueStep(queueStep(guidance,'move-panel'),'resize-panel');guidance={...guidance,panelMilestones:{...guidance.panelMilestones,first:true}};}
        if(!guidance.panelMilestones.second&&count>=2){guidance={...guidance,panelMilestones:{...guidance.panelMilestones,second:true}};}
        // F-21: one explanation per newly placed widget, in placement order, only on success.
        for(const p of layout.panels)if(!previousPanels.some(old=>old.featureId===p.featureId))guidance=queueWidget(guidance,p.featureId);
      }
      const kind=isAdd(intent)?'add':intent.type==='starter'?'starter-add':intent.type==='restore'?null:intent.type;
      const beforePages=snapshotPages(board.pages);
      const undo:UndoEntry|null=kind?{token:unique(),kind:kind as UndoEntry['kind'],beforePanels:beforePages[page],appliedRevision:boardRevision,remainingMs:options.time.undoMs,expiresAt:t+options.time.undoMs,pausedReasons:s.pageHidden?['page-hidden']:[],consumed:false,layerId:board.layerId,pageIndex:page,beforePages}:null;
      const featureId='featureId' in intent?intent.featureId:undefined;
      const notice:Notice|null=undo?{id:unique(),kind:'success',messageKey:undo.kind,featureId,panel:layout.panels.find(p=>p.featureId===featureId),displacedCount:layout.displacements.length,undoToken:undo.token,expiresAt:undo.expiresAt,layerId:board.layerId}:null;
      const pages=board.pages.map((p,i)=>i===page?{...p,panels:layout.panels}:p);
      const empty=pages.every(p=>!p.panels.length);
      const next:RunState={...s,layoutRevision:revision,gesturePreview:null,edit:{...s.edit,gesture:null,gestureToken:null,selectedFeatureId:s.edit.selectedFeatureId&&layout.panels.some(p=>p.featureId===s.edit.selectedFeatureId)?s.edit.selectedFeatureId:null}};
      return writeBoard(next,board.layerId,{pages,currentPage:page,revision:boardRevision,guidance:{...guidance,visualPending:true},starter:empty?board.layerId==='management'&&s.onboarding.applyToken?'completed':'ready':fromStarter?'running':board.starter==='running'?'completed':board.starter,undo,notice});
    });
    return response(layout);
  }
  /** Atomic page move (ARCHITECTURE 11.4-8·9): one update removes from the source page and writes the target page. */
  function commitPageMove(p:GesturePreview,layout:LayoutResult):CommandResult{
    const before=store.getState();
    if(disposed||p.baseRevision!==before.layoutRevision)return rejected('STALE_REVISION');
    if(before.idle.wakeInputToken||before.closingInput)return rejected('CANCELLED');
    const catalog=boardCatalog(p.layerId);
    const source=before.boards[p.layerId].pages[p.sourcePage].panels.filter(panel=>panel.featureId!==p.featureId);
    if(!evaluate(layout.panels,grid(),catalog).valid||!evaluate(source,grid(),catalog).valid)return rejected('INTERNAL_LAYOUT_ERROR');
    adapter.cancel();
    update((s,t)=>{
      const board=s.boards[p.layerId],boardRevision=board.revision+1;
      const beforePages=snapshotPages(board.pages);
      const pages=board.pages.map((page,i)=>i===p.sourcePage?{...page,panels:source}:i===p.targetPage?{...page,panels:layout.panels}:page);
      const undo:UndoEntry={token:unique(),kind:'move-page',beforePanels:beforePages[p.sourcePage],appliedRevision:boardRevision,remainingMs:options.time.undoMs,expiresAt:t+options.time.undoMs,pausedReasons:s.pageHidden?['page-hidden']:[],consumed:false,layerId:p.layerId,pageIndex:p.sourcePage,beforePages};
      const notice:Notice={id:unique(),kind:'success',messageKey:'move-page',featureId:p.featureId,params:{n:p.targetPage+1},panel:layout.panels.find(x=>x.featureId===p.featureId),displacedCount:layout.displacements.length,undoToken:undo.token,expiresAt:undo.expiresAt,layerId:p.layerId};
      const guidance=board.guidance.activeWidget===p.featureId?requeueWidget(board.guidance):board.guidance;
      const next:RunState={...s,layoutRevision:s.layoutRevision+1,gesturePreview:null,edit:{...s.edit,gesture:null,gestureToken:null}};
      return writeBoard(next,p.layerId,{pages,currentPage:p.targetPage,revision:boardRevision,undo,notice,guidance:{...guidance,visualPending:true}});
    });
    return response(layout);
  }
  function pendingResult(p:GesturePreview):LayoutResponse {
    return p.result??{status:'pending',panels:p.beforePanels,displacements:[],usedCells:p.beforePanels.reduce((n,p)=>n+p.width*p.height,0),remainingCells:grid().columns*grid().rows-p.beforePanels.reduce((n,p)=>n+p.width*p.height,0)};
  }
  function receive(response:LayoutWorkerResponse):void {
    const s=store.getState(),p=s.gesturePreview;
    if(disposed||!p||!sameIdentity(p,response)||p.baseRevision!==s.layoutRevision||p.runId!==s.runId||response.presetId!==context.screenPreset.id)return;
    let result=withDefaultConditions(response.result,p.intent);
    if(!evaluate(result.panels,grid(),boardCatalog(p.layerId)).valid||result.status==='rejected'&&!samePanels(result.panels,p.beforePanels))result=layoutResult(p.beforePanels,grid(),'INTERNAL_LAYOUT_ERROR');
    update(s=>({...s,gesturePreview:{...p,status:result.status,candidatePanels:result.panels,displacements:result.displacements,reason:result.code,result}}));
    if(p.pendingCommit)actions.commitPreview(p.token);
  }
  /** Computes a candidate; `also` applies further changes in the same state update (page flips, keyboard sends). */
  function submitCandidate(p:GesturePreview,inside=true,also:(s:RunState)=>RunState=s=>s):LayoutResponse {
    adapter.cancel();
    const computed=inside?fastPreview(p.beforePanels,p.intent,grid(),boardCatalog(p.layerId)):layoutResult(p.beforePanels,grid(),'OUTSIDE_GRID');
    const fast=computed?withDefaultConditions(computed,p.intent):null;
    const candidate:GesturePreview={...p,status:fast?.status??'pending',candidatePanels:fast?.panels??p.beforePanels,displacements:fast?.displacements??[],reason:fast?.code,result:fast,pendingCommit:false};
    update(s=>also({...s,gesturePreview:candidate}));
    if(!fast){
      try{adapter.submit({runId:p.runId,baseRevision:p.baseRevision,gestureToken:p.token,requestId:p.requestId,presetId:p.presetId,beforePanels:p.beforePanels,intent:p.intent},receive);}
      catch{receive({...p,result:layoutResult(p.beforePanels,grid(),'INTERNAL_LAYOUT_ERROR')});}
    }
    return pendingResult(store.getState().gesturePreview??candidate);
  }
  /** The panel being dragged, as it is on the gesture's source page. */
  const sourcePanel=(s:RunState,p:GesturePreview)=>s.boards[p.layerId].pages[p.sourcePage]?.panels.find(x=>x.featureId===p.featureId);
  /** API-03 v4: the store, not the controller, turns a position into an intent for this source and page. */
  function intentAt(s:RunState,p:GesturePreview,position:PreviewPosition):LayoutIntent|null{
    const {column,row}=position,featureId=p.featureId;
    if(p.source==='drawer')return {type:'add-drop',featureId,column,row};
    if(p.source==='candidate'){
      const base=p.intent;
      if(base.type!=='add-ai'&&base.type!=='add-candidate-tap')return null;
      return {type:'add-ai',featureId,column,row,width:asSpan(base.width),height:asSpan(base.height),condition:base.condition};
    }
    if(p.source==='panel'||p.source==='keyboard'){
      if(p.targetPage===p.sourcePage)return {type:'move',featureId,column,row};
      const origin=sourcePanel(s,p);if(!origin)return null;
      return {type:'add-ai',featureId,column,row,width:asSpan(origin.width),height:asSpan(origin.height),condition:origin.condition??defaultCondition()};
    }
    return null;
  }
  function fallbackPosition(s:RunState,p:GesturePreview):PreviewPosition{
    if(p.position)return p.position;
    if('column' in p.intent&&'row' in p.intent)return {column:p.intent.column,row:p.intent.row,inside:true};
    const origin=sourcePanel(s,p);return {column:origin?.column??0,row:origin?.row??0,inside:true};
  }
  function commitIntent(intent:LayoutIntent,baseRevision:number,fromStarter=false):CommandResult{
    const before=store.getState();
    if(baseRevision!==before.layoutRevision)return rejected('STALE_REVISION');
    if(disposed||before.idle.wakeInputToken||before.closingInput)return rejected('CANCELLED');
    const refused=precheck(before,intent);if(refused)return refused;
    actions.cancelPreview();
    const fast=fastPreview(before.panels,intent,grid(),boardCatalog(before.activeBoard));
    if(fast)return commitResolved(intent,fast,baseRevision,fromStarter);
    const token=actions.beginPreview({source:'keyboard',pointerId:-1,intent});
    return token?actions.commitPreview(token):rejected('CANCELLED');
  }
  function dismiss(s:RunState,t:number,step?:CoachStep):RunState{
    const g=s.guidance,active=g.active;
    if(active){
      if(step&&step!==active)return s;
      return writeActive(s,{guidance:{...g,active:null,targetFeatureId:null,coach:{...g.coach,[active]:'dismissed'},nextCoachAt:t+options.time.coachGapMs}});
    }
    if(g.activeWidget&&!step)return writeActive(s,{guidance:{...g,activeWidget:null,widgetCoach:{...g.widgetCoach,[g.activeWidget]:'dismissed'},nextCoachAt:t+options.time.coachGapMs}});
    return s;
  }
  /** Coaches wait at least one gap after their target page or layer becomes visible again. */
  function delayCoach(s:RunState,layer:DashboardLayerId,t:number):RunState{
    const g=s.boards[layer].guidance;
    return Number.isFinite(g.nextCoachAt)&&g.nextCoachAt<t+options.time.coachGapMs?writeBoard(s,layer,{guidance:{...g,nextCoachAt:t+options.time.coachGapMs}}):s;
  }
  /** Viewed-page change outside a gesture: page-bound coaches return to their queues without a record. */
  function changePage(s:RunState,index:number,t:number):RunState{
    const board=s.boards[s.activeBoard];
    let next=writeActive(s,{currentPage:index,guidance:requeueStep(requeueWidget(board.guidance))});
    next=delayCoach(next,next.activeBoard,t);
    const selected=next.edit.selectedFeatureId;
    return selected&&!onViewedPage(next,selected)?{...next,edit:{...next.edit,selectedFeatureId:null}}:next;
  }
  const closePanelHelp=(s:RunState):RunState=>s.widgetHelp?.origin==='panel'?{...s,widgetHelp:null}:s;
  const canOpen=()=>!store.getState().closingInput&&!store.getState().idle.wakeInputToken&&!store.getState().gesturePreview&&!store.getState().edit.gesture;
  function updatePreview(token:string,target:PreviewTarget|LayoutIntent,insideGrid?:boolean):LayoutResponse{
    const s=store.getState(),p=s.gesturePreview;
    if(!p||p.token!==token||p.pendingCommit||p.baseRevision!==s.layoutRevision)return {...currentLayout(),status:'rejected',valid:false,code:'STALE_REVISION'};
    let intent:LayoutIntent|null,inside=insideGrid??true,position=p.position;
    if('type' in target)intent=target;
    else if('width' in target)intent=p.source==='resize'?{type:'resize',featureId:p.featureId,width:target.width,height:target.height}:null;
    else{position={column:target.column,row:target.row,inside:target.inside};inside=target.inside;intent=intentAt(s,p,position);}
    if(!intent)return pendingResult(p);
    if(inside&&p.reason!=='OUTSIDE_GRID'&&layoutCacheKey({presetId:p.presetId,beforePanels:p.beforePanels,intent})===layoutCacheKey(p)){
      // Same intent: keep the candidate, only remember the last position for edge flips and the drop.
      if(position&&(position.column!==p.position?.column||position.row!==p.position?.row||position.inside!==p.position?.inside))update(s=>s.gesturePreview===p?{...s,gesturePreview:{...p,position}}:s);
      return pendingResult(store.getState().gesturePreview??p);
    }
    return submitCandidate({...p,intent,position,requestId:p.requestId+1},inside);
  }
  const conflict=(reason:string,validation=false):PrepareResult=>({ok:false,code:validation?'VALIDATION':'CONFLICT',reason,messageKey:validation?'run.session.validation':'run.session.conflict'});
  const validBusiness=(value:unknown)=>value===null||businesses.includes(value as typeof businesses[number]);
  function prepareState(s:RunState,tx:SessionTransaction,input:RunSessionInput):RunState|PrepareResult{
    if(input.type==='pos.commit'){
      if(s.posRevision!==input.expectedPosRevision)return conflict('STALE_REVISION');
      if(input.nextPos.revision!==s.posRevision+1||input.nextPos.businessDate!==s.pos.businessDate||input.nextPos.seq<s.pos.seq)return conflict('INVALID_POS_PLAN',true);
      if(input.nextSettings){
        if(input.nextSettings.revision!==s.shopSettings.revision+1)return conflict('STALE_REVISION');
        if(!validBusiness(input.nextSettings.businessType)||!['prepaid','postpaid'].includes(input.nextSettings.paymentStyle??'')||input.nextSettings.tableLayout!==null&&!validateTableLayout(input.nextSettings.tableLayout))return conflict('INVALID_SETTINGS',true);
        const blocked=validatePosSettingsChange(s.pos,s.shopSettings,input.nextSettings,s.posUi.approval?.status==='pending');if(blocked)return conflict(blocked.reason);
      }
      return {...s,pos:immutable(input.nextPos),posRevision:input.nextPos.revision,posUi:immutable(input.nextUi),...(input.nextSettings?{shopSettings:immutable(input.nextSettings),businessType:input.nextSettings.businessType}:{}),runRevision:s.runRevision+1,transactionId:tx.transactionId};
    }
    if(input.type==='update-settings'){
      const settings=normalizePosSettings({...input.settings,posPreferences:input.settings.posPreferences??s.shopSettings.posPreferences});
      if(templateBlocked(s))return conflict('TRANSACTION_BUSY');
      if(s.onboarding.step!=='done'||!settings||!validBusiness(settings.businessType)||!['prepaid','postpaid'].includes(settings.paymentStyle??'')||settings.tableLayout!==null&&!validateTableLayout(settings.tableLayout))return conflict('INVALID_SETTINGS',true);
      if(settings.revision!==s.shopSettings.revision+1)return conflict('STALE_REVISION');
      const blocked=validatePosSettingsChange(s.pos,s.shopSettings,settings,s.posUi.approval?.status==='pending');if(blocked)return conflict(blocked.reason);
      return {...s,businessType:settings.businessType,shopSettings:immutable({...settings}),runRevision:s.runRevision+1,transactionId:tx.transactionId};
    }
    if(s.onboarding.step!=='start')return conflict('INVALID_STEP');
    const draft=s.onboarding.draft;
    if(!validBusiness(draft.businessType)||!['prepaid','postpaid'].includes(draft.paymentStyle??'')||draft.tableLayout!==null&&!validateTableLayout(draft.tableLayout))return conflict('INVALID_SETTINGS',true);
    if(!boardEmpty(s.boards.management))return conflict('NOT_EMPTY');
    const template=input.templateId===null?null:getManagementTemplates({businessType:draft.businessType,paymentStyle:draft.paymentStyle!,presetId:s.screenPreset.id}).find(template=>template.id===input.templateId);
    if(input.templateId!==null&&!template)return conflict('INVALID_TEMPLATE');
    const layout=template?evaluate(template.panels,grid(),boardCatalog('management')):null;
    if(layout&&!layout.valid)return conflict('INVALID_TEMPLATE');
    const applyToken=template?unique():null;
    let next:RunState={...s,screen:'dashboard',businessType:draft.businessType,shopSettings:normalizePosSettings({...draft,revision:s.shopSettings.revision+1,cctvPosLinks:s.shopSettings.cctvPosLinks??[]}),runRevision:s.runRevision+1,transactionId:tx.transactionId,transitionToken:unique(),onboarding:{...s.onboarding,step:template?'applying':'done',selectedTemplateId:template?.id??null,applyToken},templateTour:template?{status:'waiting',runId:s.runId,applyToken:applyToken!,targets:template.tourOrder,index:0,readyAt:Infinity}:null};
    let guidance=queueStep(s.boards.management.guidance,'choose-feature');
    if(template){
      guidance={...guidance,firstHintSeen:true,visualPending:true,panelMilestones:{first:true,second:true}};
      guidance=queueStep(queueStep(guidance,'move-panel'),'resize-panel');
      const board=s.boards.management;
      next=writeBoard({...next,layer:'management',activeBoard:'management',layoutRevision:s.layoutRevision+1},'management',{pages:board.pages.map((page,index)=>index===0?{...page,panels:template.panels.map(p=>({...p,condition:p.condition??defaultCondition()}))}:page),currentPage:0,revision:board.revision+1,starter:'completed',undo:null,notice:null,guidance});
    }else next=writeBoard(next,'management',{guidance});
    return immutable({...next,idle:{...next.idle,blockedReasons:blockers(next)}});
  }
  const session:SessionTransactionPort<RunSessionInput>={
    prepare(tx,input){
      const s=store.getState(),gate=options.sessionGate;
      if(disposed||flushing||published||gate&&(gate.phase!=='preparing'||gate.transactionId!==tx.transactionId))return conflict('TRANSACTION_BUSY');
      if(s.runId!==tx.runId)return conflict('STALE_RUN');
      if(s.runRevision!==tx.expectedRunRevision)return conflict('STALE_REVISION');
      if(s.transitionToken!==tx.transitionToken)return conflict('STALE_TRANSITION');
      const next=prepareState(s,tx,input);
      if('ok' in next)return next;
      const change:PreparedChange=Object.freeze({store:'run',transactionId:tx.transactionId,ticket:unique()});
      prepared.set(change.ticket,{change,tx:{...tx},previous:s,next:immutable(reconcileOccupancy(next))});
      return {ok:true,change};
    },
    isCurrent(change){const entry=prepared.get(change.ticket);return !disposed&&!published&&!!entry&&entry.change===change&&entry.previous===store.getState()&&entry.tx.runId===store.getState().runId&&entry.tx.transitionToken===store.getState().transitionToken;},
    publish(change){
      const entry=prepared.get(change.ticket);
      if(!entry||entry.change!==change||entry.previous!==store.getState()||published||disposed)return;
      published={transactionId:entry.tx.transactionId,previous:entry.previous};
      prepared.clear();vanilla.setState(entry.next,true);
    },
    flush(transactionId){
      if(!published||published.transactionId!==transactionId)return;
      const previous=published.previous;published=null;flushing=true;
      try{notify(previous);}finally{flushing=false;}
    },
    abort(change){if(prepared.get(change.ticket)?.change===change)prepared.delete(change.ticket);},
  };
  function standaloneComplete(templateId:OnboardingState['selectedTemplateId']):boolean{
    if(options.sessionGate||busy())return false;
    const s=store.getState();
    const result=session.prepare({transactionId:unique(),runId:s.runId,expectedDataRevision:0,expectedRunRevision:s.runRevision,transitionToken:s.transitionToken},{type:'complete-onboarding',templateId});
    if(!result.ok)return false;
    session.publish(result.change);session.flush(result.change.transactionId);return true;
  }
  function finishTour(input?:InputSequence):boolean{
    const s=store.getState(),tour=s.templateTour;if(tour?.status!=='active')return false;
    update((s,t)=>{
      const g=s.boards.management.guidance,widgetCoach={...g.widgetCoach};
      for(const id of tour.targets)widgetCoach[id]='dismissed';
      return writeBoard({...s,templateTour:{...tour,status:'completed'},closingInput:input??null},'management',{guidance:{...g,widgetCoach,widgetQueue:g.widgetQueue.filter(id=>!tour.targets.includes(id)),activeWidget:null,dashboardReady:true,visualPending:false,nextCoachAt:t+options.time.coachFirstMs}});
    });return true;
  }
  const defaultReturn=(ref:DetailRef,focusKey:string):DetailReturnState=>({ref,tab:ref.view??'',query:'',sort:null,filters:{},expandedRowIds:[],selectedRowId:null,scrollTop:0,scrollLeft:0,focusKey});
  const startDemoRestart=(s:RunState,t:number):RunState=>mirror({
    ...s, demoRestart:true, screen:'business-question', activeBoard:'management', layer:'management',
    overlay:{type:'none'}, exitingOverlay:null, exitPendingToken:null, templateTour:null,
    transitionToken:unique(), runRevision:s.runRevision+1,
    idle:{...s.idle,mode:'active',lastInputAt:t},
    onboarding:{step:'business',draft:{businessType:null,paymentStyle:s.shopSettings.paymentStyle??'prepaid',tableLayout:null},selectedTemplateId:null,applyToken:null},
  });
  const actionImpl:RunPresentationActions={
    observeLinkedOccupancy(input,expectedRunId){
      update((s,t)=>{
        if(expectedRunId&&expectedRunId!==s.runId||!s.linkedActiveZoneIds.includes(input.zoneId))return s;
        const previous=s.linkedOccupancy.observations.find(o=>o.zoneId===input.zoneId);
        if(previous?.state===input.state&&previous.observedAt===input.observedAt&&input.elapsedNow<=s.linkedOccupancy.elapsedNow)return s;
        const next=observeLinkedOccupancy(occupancyRead(s),s.linkedOccupancy,{...input,elapsedNow:Math.max(input.elapsedNow,t-runStartedAt)});
        return next===s.linkedOccupancy?s:{...s,linkedOccupancy:next};
      });
    },
    reconcileLinkedOccupancy(input,expectedRunId){
      update((s,t)=>{
        if(expectedRunId&&expectedRunId!==s.runId)return s;
        const ids=s.linkedActiveZoneIds.length===input.activeZoneIds.length&&s.linkedActiveZoneIds.every((id,i)=>id===input.activeZoneIds[i])?s.linkedActiveZoneIds:[...input.activeZoneIds];
        const next=reconcileLinkedOccupancy(occupancyRead(s),s.linkedOccupancy,Math.max(input.elapsedNow,t-runStartedAt),ids);
        return next===s.linkedOccupancy&&ids===s.linkedActiveZoneIds?s:{...s,linkedActiveZoneIds:ids,linkedOccupancy:next};
      });
    },
    setPosPreview(scenario){
      if(scenario!==null&&!['normal','empty','error','payment-failure'].includes(scenario))return;
      update(s=>{
        const {pos,...preview}=s.preview;
        if(pos===scenario||scenario===null&&pos===undefined)return s;
        return {...s,preview:scenario===null?preview:{...preview,pos:scenario}};
      });
    },
    setPosUi(posUi,expectedRunId){
      const s=store.getState();
      if(s.runId!==expectedRunId||!['order','status','tables'].includes(posUi.tab))return false;
      if(s.posUi===posUi)return true;
      prepared.clear();store.setState(immutable({...s,posUi}),true);return true;
    },
    setOnboardingAnswer(answer){
      const s=store.getState(),onboarding=s.onboarding;
      if(onboarding.step==='business'&&Object.keys(answer).length===1&&'businessType' in answer&&validBusiness(answer.businessType)){
        update(s=>({...s,transitionToken:unique(),onboarding:{...s.onboarding,step:s.demoRestart?'start':'payment',draft:{...s.onboarding.draft,businessType:answer.businessType!}}}));return true;
      }
      if(onboarding.step!=='payment'||Object.keys(answer).length!==1||!['prepaid','postpaid'].includes(answer.paymentStyle??''))return false;
      const draft={...onboarding.draft,paymentStyle:answer.paymentStyle!},enabled=tableLayoutEnabled(draft.businessType,draft.paymentStyle);
      update(s=>({...s,transitionToken:unique(),onboarding:{...s.onboarding,step:enabled?'tables':'start',draft:{...draft,tableLayout:enabled?draft.tableLayout??createTableLayout():draft.tableLayout}}}));return true;
    },
    onboardingBack(){
      const s=store.getState(),o=s.onboarding;
      const step=o.step==='payment'?'business':o.step==='tables'?'payment':o.step==='start'?s.demoRestart?'business':tableLayoutEnabled(o.draft.businessType,o.draft.paymentStyle)?'tables':'payment':null;
      if(!step)return false;
      update(s=>({...s,transitionToken:unique(),onboarding:{...s.onboarding,step,draft:step==='tables'&&s.onboarding.draft.tableLayout===null?{...s.onboarding.draft,tableLayout:createTableLayout()}:s.onboarding.draft}}));return true;
    },
    updateOnboardingTableDraft(layout,identity){
      const s=store.getState();
      if(!identity||identity.runId!==s.runId||identity.transitionToken!==s.transitionToken||s.onboarding.step!=='tables'||!tableLayoutEnabled(s.onboarding.draft.businessType,s.onboarding.draft.paymentStyle)||!validateTableLayout(layout))return false;
      update(s=>({...s,onboarding:{...s.onboarding,draft:{...s.onboarding.draft,tableLayout:immutable({...layout,tables:layout.tables.map(t=>({...t}))})}}}));return true;
    },
    saveOnboardingTables(layout){
      const s=store.getState();if(s.onboarding.step!=='tables'||!tableLayoutEnabled(s.onboarding.draft.businessType,s.onboarding.draft.paymentStyle)||!validateTableLayout(layout))return false;
      update(s=>({...s,transitionToken:unique(),onboarding:{...s.onboarding,step:'start',draft:{...s.onboarding.draft,tableLayout:immutable({...layout,tables:layout.tables.map(t=>({...t}))})}}}));return true;
    },
    skipOnboardingTables(){
      if(store.getState().onboarding.step!=='tables')return false;
      update(s=>({...s,transitionToken:unique(),onboarding:{...s.onboarding,step:'start',draft:{...s.onboarding.draft,tableLayout:null}}}));return true;
    },
    selectStartTemplate(templateId){
      const s=store.getState();if(s.onboarding.step!=='start'||!['A','B','C'].includes(templateId))return false;
      if(s.onboarding.selectedTemplateId!==templateId)update(s=>({...s,onboarding:{...s.onboarding,selectedTemplateId:templateId}}));return true;
    },
    restartOnboarding(){
      const s=store.getState();
      if(disposed||s.screen!=='dashboard'||s.onboarding.step!=='done'||s.overlay.type!=='settings')return false;
      update(startDemoRestart);
      return true;
    },
    chooseDemoLayout(templateId){
      const s=store.getState(),{draft,step}=s.onboarding;
      if(disposed||!s.demoRestart||step!=='start')return false;
      const template=getManagementTemplates({businessType:draft.businessType,paymentStyle:draft.paymentStyle??'prepaid',presetId:s.screenPreset.id})
        .find(item=>item.id===templateId);
      if(templateId!==null&&!template)return false;
      const panels=template?.panels.map(panel=>({...panel,condition:panel.condition??defaultCondition()}))??[];
      if(!evaluate(panels,grid(),boardCatalog('management')).valid)return false;
      update(s=>{
        const board=s.boards.management;
        return writeBoard({...s,transitionToken:unique(),layoutRevision:s.layoutRevision+1,runRevision:s.runRevision+1,
          onboarding:{...s.onboarding,step:'applying',selectedTemplateId:templateId}},'management',{
          pages:[{pageId:pageId('management',0),panels}],currentPage:0,revision:board.revision+1,
          guidance:{...emptyGuidance(),firstHintSeen:!!template,panelMilestones:{first:!!template,second:!!template}},
          starter:template?'completed':'ready',undo:null,notice:null,
        });
      });
      return true;
    },
    finishDemoRestart(transitionToken){
      const s=store.getState();
      if(disposed||!s.demoRestart||s.onboarding.step!=='applying'||s.transitionToken!==transitionToken)return false;
      update((s,t)=>({...s,demoRestart:false,screen:'dashboard',transitionToken:unique(),runRevision:s.runRevision+1,
        onboarding:{...s.onboarding,step:'done'},idle:{...s.idle,lastInputAt:t}}));
      return true;
    },
    applyManagementTemplate(templateId,baseLayoutRevision=store.getState().layoutRevision){
      if(baseLayoutRevision!==store.getState().layoutRevision)return rejected('STALE_REVISION');
      return standaloneComplete(templateId)?response(currentLayout()):rejected('CANCELLED');
    },
    startEmpty(){return standaloneComplete(null);},
    templateAssembled({runId,applyToken}){
      const s=store.getState();if(s.runId!==runId||s.onboarding.step!=='applying'||s.onboarding.applyToken!==applyToken||s.templateTour?.applyToken!==applyToken)return false;
      update((s,t)=>({...s,onboarding:{...s.onboarding,step:'done'},templateTour:{...s.templateTour!,readyAt:t+TEMPLATE_TOUR_START_MS},commonNotice:shellNotice(s,{id:unique(),kind:'complete',messageKey:`run.template.${s.onboarding.selectedTemplateId}.completed`,expiresAt:t+options.time.completeMs},t)}));return true;
    },
    nextTemplateTour(){const tour=store.getState().templateTour;if(tour?.status!=='active')return false;if(tour.index===tour.targets.length-1)return finishTour();update(s=>({...s,templateTour:{...tour,index:tour.index+1}}));return true;},
    closeTemplateTour:finishTour,
    openClosing(returnFocusKey,options){
      const s=store.getState();
      if(s.screen!=='dashboard'||s.onboarding.step!=='done'||s.idle.mode==='idle'||s.idle.wakeInputToken||s.closingInput||s.exitPendingToken||s.overlay.type!=='none'&&s.overlay.type!=='detail')return false;
      const parent=s.overlay.type==='detail'?s.overlay:null;
      const ref=parent?.stack?.at(-1)??(parent?{featureId:parent.featureId}:null);
      const returnTo=ref?s.detailState??defaultReturn(ref,parent!.returnFocusKey):null;
      actions.cancelPreview();
      update(s=>({...s,widgetHelp:null,closingParent:parent,edit:{mode:'view',gesture:null,gestureToken:null,selectedFeatureId:null},overlay:{type:'closing',returnFocusKey,...(options?.tab?{tab:options.tab}:{}),...(options?.readOnly?{readOnly:true}:{}),...(returnTo?{returnTo}:{})},exitPendingToken:null,exitingOverlay:null}));return true;
    },
    rememberDetailState(detailState){
      const s=store.getState();if(s.overlay.type!=='detail'||detailState.ref.featureId!==s.overlay.featureId||!Number.isFinite(detailState.scrollTop)||!Number.isFinite(detailState.scrollLeft)||detailState.scrollTop<0||detailState.scrollLeft<0)return false;
      update(s=>({...s,detailState:immutable({...detailState,ref:{...detailState.ref},filters:{...detailState.filters},expandedRowIds:[...detailState.expandedRowIds],sort:detailState.sort?{...detailState.sort}:null})}));return true;
    },
    setClosingPreview(variant){
      if(variant!==null&&!['normal','no-payments','error'].includes(variant))return;
      update(s=>{if(s.preview.closing===(variant??undefined))return s;const preview={...s.preview};if(variant===null)delete preview.closing;else preview.closing=variant;return {...s,preview};});
    },
    resetClosingPreview(){actions.setClosingPreview('normal');},
    chooseBusiness(type){
      actions.setOnboardingAnswer({businessType:type});
    },
    skipBusiness(){actions.chooseBusiness(null);},
    applyLayoutIntent(intent,revision=store.getState().layoutRevision){return commitIntent(intent,revision);},
    commitAssistantBatch(panels,baseRevision,runId){
      const s=store.getState();if(disposed||s.runId!==runId||s.layoutRevision!==baseRevision)return rejected('STALE_REVISION');
      if(s.idle.wakeInputToken||s.closingInput)return rejected('CANCELLED');
      const board=s.boards[s.activeBoard];
      for(const panel of panels){
        if(otherLayer(s.activeBoard,panel.featureId)){errorNotice('OTHER_LAYER',panel.featureId);return rejected('OTHER_LAYER');}
        const found=selectBoardPanels(s).find(e=>e.panel.featureId===panel.featureId);
        // Another page already holds it: write nothing (the assistant should have listed it as duplicate).
        if(found&&found.pageIndex!==board.currentPage)return response({...currentLayout(s),status:'rejected',valid:false,code:'DUPLICATE',existingFeatureId:panel.featureId,existingPage:found.pageIndex});
      }
      const layout=evaluate(panels,grid(),boardCatalog(s.activeBoard));
      if(!layout.valid)return rejected('INTERNAL_LAYOUT_ERROR');
      return commitResolved({type:'add-tap',featureId:panels.find(p=>!s.panels.some(old=>old.featureId===p.featureId))?.featureId??panels[0].featureId},layout,baseRevision);
    },
    commitNavisLayout(plan, { deferNotice = false } = {}) {
      const s = store.getState(), board = s.boards[plan.layer];
      if (disposed || s.runId !== plan.runId || s.layoutRevision !== plan.layoutRevision || s.activeBoard !== plan.originLayer
        || s.boards[s.activeBoard].currentPage !== plan.originPage || board.pages !== plan.previousPages || board.currentPage !== plan.previousPage) {
        return rejected('STALE_REVISION');
      }
      if (s.layer === 'orders-payment' || s.screen !== 'dashboard' || s.edit.mode !== 'view' || !canOpen()
        || s.exitPendingToken || (s.overlay.type !== 'none' && s.overlay.type !== 'drawer')) return rejected('CANCELLED');
      if (plan.pages.length < board.pages.length || plan.pages.length > PAGE_LIMIT || !plan.pages[plan.page]) return rejected('INTERNAL_LAYOUT_ERROR');
      const catalog = boardCatalog(plan.layer);
      const checks = plan.pages.map(panels => evaluate(panels, grid(), catalog));
      const ids = plan.pages.flatMap(panels => panels.map(panel => panel.featureId));
      if (checks.some(result => !result.valid) || new Set(ids).size !== ids.length) return rejected('INTERNAL_LAYOUT_ERROR');
      const changed = plan.pages.some((panels, index) => !samePanels(panels, board.pages[index]?.panels ?? []));
      if (changed !== Boolean(plan.undoKind)) return rejected('INTERNAL_LAYOUT_ERROR');
      if (!changed && plan.pages.length === board.pages.length) return response({ ...checks[plan.page], status: 'unchanged' });
      const oldIds = new Set(board.pages.flatMap(page => page.panels.map(panel => panel.featureId)));
      const nextPageId = pageIdAllocator(board);
      const pages = plan.pages.map((panels, index) => board.pages[index]?.panels === panels ? board.pages[index]
        : { pageId: board.pages[index]?.pageId ?? nextPageId(), panels: checks[index].panels });
      const undoKind = plan.undoKind;
      update((current, t) => {
        const pageChanged = plan.page !== board.currentPage;
        let guidance = pageChanged ? requeueStep(requeueWidget(board.guidance)) : board.guidance;
        if (!undoKind) return writeBoard(current, plan.layer, { pages, currentPage: plan.page, guidance });
        if (!guidance.panelMilestones.first && ids.length >= 1) {
          guidance = queueStep(queueStep(guidance, 'move-panel'), 'resize-panel');
          guidance = { ...guidance, panelMilestones: { ...guidance.panelMilestones, first: true } };
        }
        if (!guidance.panelMilestones.second && ids.length >= 2) {
          guidance = { ...guidance, panelMilestones: { ...guidance.panelMilestones, second: true } };
        }
        for (const id of ids) if (!oldIds.has(id)) guidance = queueWidget(guidance, id);
        const revision = board.revision + 1;
        const beforePages = snapshotPages(pages.map((page, index) => board.pages[index] ?? { ...page, panels: [] }));
        const undo: UndoEntry = {
          token: unique(), kind: undoKind, layerId: plan.layer, pageIndex: board.currentPage,
          beforePages, beforePanels: beforePages[board.currentPage], appliedRevision: revision,
          remainingMs: options.time.undoMs, expiresAt: t + options.time.undoMs,
          pausedReasons: current.pageHidden ? ['page-hidden'] : [], consumed: false,
        };
        const notice: Notice | null = !deferNotice && plan.layer === current.activeBoard ? {
          id: unique(), kind: 'success', messageKey: undoKind, layerId: plan.layer, featureId: plan.featureId,
          panel: pages.flatMap(page => page.panels).find(panel => panel.featureId === plan.featureId),
          displacedCount: plan.displaced.length, undoToken: undo.token, expiresAt: undo.expiresAt,
          ...(undoKind === 'move-page' ? { params: { n: plan.page + 1 } } : {}),
        } : null;
        const editorSelection = current.edit.selectedFeatureId;
        const edit = plan.layer === current.activeBoard && editorSelection && !pages[plan.page].panels.some(panel => panel.featureId === editorSelection)
          ? { ...current.edit, selectedFeatureId: null } : current.edit;
        const starter = !ids.length && !(plan.layer === 'management' && current.onboarding.applyToken) ? 'ready' : 'completed';
        return writeBoard({ ...current, edit, layoutRevision: current.layoutRevision + 1 }, plan.layer, {
          pages, currentPage: plan.page, revision, undo, notice, starter, guidance: { ...guidance, visualPending: true },
        });
      });
      return response(checks[plan.page]);
    },
    startWithThree(revision=store.getState().layoutRevision){
      const s=store.getState();
      // v4.1: the marketing board starts with startWithPreset, never with three.
      if(s.activeBoard==='marketing'||s.onboarding.applyToken!==null||s.starter==='running'||!boardEmpty(s.boards[s.activeBoard]))return response({...currentLayout(s),status:'unchanged'});
      if(revision!==s.layoutRevision)return rejected('STALE_REVISION');
      update(s=>writeActive(s,{starter:'running'}));
      const result=commitIntent({type:'starter',featureIds:getBusinessPreset(s.businessType,s.activeBoard).starterIds},revision,true);
      if(result.status!=='accepted')update(s=>writeActive(s,{starter:'ready'}));
      return result;
    },
    /** v4.1 (API-03, ARCHITECTURE 11.13.3): marketing board, every page empty; coordinates are validated, never searched. */
    startWithPreset(revision=store.getState().layoutRevision){
      const s=store.getState();
      if(disposed||s.activeBoard!=='marketing'||s.starter==='running'||!boardEmpty(s.boards.marketing))return response({...currentLayout(s),status:'unchanged'});
      if(revision!==s.layoutRevision)return rejected('STALE_REVISION');
      if(s.idle.wakeInputToken||s.closingInput)return rejected('CANCELLED');
      const panels:Panel[]=getMarketingPreset(s.businessType).map(c=>({featureId:c.featureId,column:c.column,row:c.row,width:c.width,height:c.height}));
      const layout=evaluate(panels,grid(),boardCatalog('marketing'));
      if(!layout.valid)return rejected('INTERNAL_LAYOUT_ERROR');
      actions.cancelPreview();
      update(s=>writeActive(s,{starter:'running'}));
      const result=commitResolved({type:'starter',featureIds:panels.map(p=>p.featureId)},layout,revision,true);
      if(result.status!=='accepted')update(s=>writeActive(s,{starter:'ready'}));
      return result;
    },
    beginPreview(request){
      let s=store.getState();
      if(s.gesturePreview?.pendingCommit){actions.cancelPreview();s=store.getState();}
      if(disposed||options.previewGuard&&!options.previewGuard(request)||s.gesturePreview||s.idle.wakeInputToken||s.closingInput||s.overlay.type!=='none'&&s.overlay.type!=='drawer'||request.token&&consumedGestures.has(request.token))return null;
      const featureId='featureId' in request.intent?request.intent.featureId:null;
      if(!featureId||!boardCatalog(s.activeBoard).some(f=>f.id===featureId))return null;
      const board=s.boards[s.activeBoard];
      // A widget already on another page of this layer cannot start a new placement (the screen uses findPlacement).
      if(isAdd(request.intent)&&selectBoardPanels(s).some(e=>e.panel.featureId===featureId&&e.pageIndex!==board.currentPage))return null;
      const token=request.token??unique();
      const p:GesturePreview={token,gestureToken:token,runId:s.runId,presetId:context.screenPreset.id,requestId:1,source:request.source,inputIntent:request.inputIntent??'drag',featureId,baseRevision:s.layoutRevision,beforePanels:snapshot(s.panels),intent:request.intent,status:'pending',candidatePanels:s.panels,displacements:[],pointerId:request.pointerId,pendingCommit:false,result:null,layerId:s.activeBoard,sourcePage:board.currentPage,targetPage:board.currentPage,position:null};
      if(s.edit.mode==='view'&&request.source!=='candidate')editStartRevision=s.layoutRevision;
      update(s=>({...s,widgetHelp:null,overlay:s.overlay.type==='drawer'?{type:'none'}:s.overlay,exitPendingToken:s.overlay.type==='drawer'?unique():s.exitPendingToken,exitingOverlay:s.overlay.type==='drawer'?s.overlay:s.exitingOverlay,edit:{...s.edit,mode:request.source==='candidate'?s.edit.mode:'edit',selectedFeatureId:featureId,gesture:request.source==='resize'?'resize':'drag',gestureToken:token}}));
      submitCandidate(p);return token;
    },
    updatePreview,
    flipPageDuringGesture(token,direction){
      const s=store.getState(),p=s.gesturePreview;
      if(disposed||!p||p.token!==token||p.pendingCommit||p.source==='resize'||p.baseRevision!==s.layoutRevision||(direction!==1&&direction!==-1))return {ok:false,code:'CANCELLED'};
      const board=s.boards[p.layerId],next=p.targetPage+direction;
      if(next<0||next>=board.pages.length)return {ok:false,code:'NO_NEIGHBOR_PAGE'};
      const position=fallbackPosition(s,p);
      const moved:GesturePreview={...p,targetPage:next,beforePanels:snapshot(board.pages[next].panels),requestId:p.requestId+1,position};
      const intent=intentAt(s,moved,position)??p.intent;
      const preview=submitCandidate({...moved,intent},position.inside,s=>writeBoard(s,p.layerId,{currentPage:next}));
      return {ok:true,pageIndex:next,preview};
    },
    commitPreview(token,insideGrid){
      const s=store.getState(),p=s.gesturePreview;
      if(!p||p.token!==token||consumedGestures.has(token))return rejected('CANCELLED');
      const inside=insideGrid??p.position?.inside??true;
      if(!inside){actions.cancelPreview(token);errorNotice('OUTSIDE_GRID',p.featureId);return rejected('OUTSIDE_GRID');}
      if(p.baseRevision!==s.layoutRevision){actions.cancelPreview(token);return rejected('STALE_REVISION');}
      if(p.status==='pending'){
        if(!p.pendingCommit)update(s=>({...s,gesturePreview:{...p,pendingCommit:true},edit:{...s.edit,gesture:null}}));
        return response(pendingResult(p));
      }
      consumedGestures.add(token);adapter.cancel();
      const result=p.result!;
      const pageMove=p.targetPage!==p.sourcePage&&(p.source==='panel'||p.source==='keyboard');
      // Consume the token before applying the exact preview result, with one state update.
      if(result.status==='accepted')return pageMove?commitPageMove(p,result):commitResolved(p.intent,result,p.baseRevision,false,p.targetPage);
      // Failures and no-ops return to the starting page with the original layout.
      update(s=>{const next={...s,gesturePreview:null,edit:{...s.edit,gesture:null,gestureToken:null}};return next.boards[p.layerId].currentPage===p.sourcePage?next:writeBoard(next,p.layerId,{currentPage:p.sourcePage});});
      if(pageMove&&result.code==='NO_CAPACITY'){
        const current=store.getState();if(disposed||p.baseRevision!==current.layoutRevision)return rejected('STALE_REVISION');
        if(current.idle.wakeInputToken||current.closingInput)return rejected('CANCELLED');
        errorNotice('NO_CAPACITY',p.featureId,{pageMove:true});return response(result);
      }
      return commitResolved(p.intent,result,p.baseRevision);
    },
    cancelPreview(token){
      const p=store.getState().gesturePreview;if(!p||token&&p.token!==token)return;
      consumedGestures.add(p.token);adapter.cancel();
      update(s=>{const next={...s,gesturePreview:null,edit:{...s.edit,gesture:null,gestureToken:null}};return next.boards[p.layerId].currentPage===p.sourcePage?next:writeBoard(next,p.layerId,{currentPage:p.sourcePage});});
    },
    cancelPreviewForViewportChange(){
      const s=store.getState();if(s.onboarding.step==='applying'&&s.onboarding.applyToken){actions.templateAssembled({runId:s.runId,applyToken:s.onboarding.applyToken});return;}
      const p=store.getState().gesturePreview;if(!p)return;
      actions.cancelPreview(p.token);
      if(p.pointerId>=0)update(s=>({...s,closingInput:{kind:'pointer',id:p.pointerId}}));
    },
    movePanelToPage(featureId,direction){
      const s=store.getState();
      if(disposed||s.idle.wakeInputToken||s.closingInput||s.gesturePreview||s.edit.gesture||(direction!==1&&direction!==-1))return rejected('CANCELLED');
      const origin=s.panels.find(p=>p.featureId===featureId);
      if(!origin)return response({...currentLayout(s),status:'unchanged'});
      const board=s.boards[s.activeBoard],targetPage=board.currentPage+direction;
      if(targetPage<0||targetPage>=board.pages.length)return rejected('NO_NEIGHBOR_PAGE');
      const targetPanels=board.pages[targetPage].panels;
      // ① nearest completely empty rectangle of the same size, ② else the same cell with push-aside, ③ else no room.
      const spot=nearestEmptyRect(targetPanels,grid(),origin.width,origin.height,origin.column,origin.row)??{column:origin.column,row:origin.row};
      const intent:LayoutIntent={type:'add-ai',featureId,column:spot.column,row:spot.row,width:asSpan(origin.width),height:asSpan(origin.height),condition:origin.condition??defaultCondition()};
      const token=unique();
      const p:GesturePreview={token,gestureToken:token,runId:s.runId,presetId:context.screenPreset.id,requestId:1,source:'keyboard',inputIntent:'list',featureId,baseRevision:s.layoutRevision,beforePanels:snapshot(targetPanels),intent,status:'pending',candidatePanels:targetPanels,displacements:[],pointerId:-1,pendingCommit:false,result:null,layerId:s.activeBoard,sourcePage:board.currentPage,targetPage,position:{column:spot.column,row:spot.row,inside:true}};
      const fast=fastPreview(p.beforePanels,intent,grid(),boardCatalog(s.activeBoard));
      if(fast){
        if(fast.status==='accepted')return commitPageMove(p,fast);
        if(fast.code)errorNotice(fast.code,featureId,{pageMove:true});
        return response({...currentLayout(s),status:fast.status,valid:fast.valid,...(fast.code?{code:fast.code}:{})});
      }
      // A collision resolves through the Worker like any keyboard command; the view follows only after the move commits.
      submitCandidate(p,true,s=>({...s,widgetHelp:null,edit:{...s.edit,selectedFeatureId:featureId,gesture:'drag',gestureToken:token}}));
      return actions.commitPreview(token);
    },
    undo(token){
      if(disposed)return rejected('CANCELLED');
      actions.tick();const s=store.getState();
      const layer=dashboardLayers.find(l=>s.boards[l].undo?.token===token);
      const board=layer?s.boards[layer]:null,undo=board?.undo??null;
      if(!layer||!board||s.idle.wakeInputToken||s.closingInput||!undo||undo.token!==token||undo.consumed||undo.appliedRevision!==board.revision||!undo.pausedReasons.length&&layoutTime(layer,now())>=undo.expiresAt)return rejected('UNDO_UNAVAILABLE');
      if(undo.removedPageId&&board.pages.length>=PAGE_LIMIT)return rejected('UNDO_UNAVAILABLE');
      adapter.cancel();
      // Consume before restore so a second call can never apply the same snapshot.
      update(s=>writeBoard({...s,gesturePreview:null,edit:{...s.edit,gesture:null,gestureToken:null}},layer,{undo:null}));
      const restored=undo.beforePages.map(panels=>evaluate(panels,grid(),boardCatalog(layer)));
      const invalid=restored.find(r=>!r.valid);if(invalid)return rejected(invalid.code!);
      update((s,t)=>{
        const current=s.boards[layer];
        const restoredOrder=undo.removedPageId
          ? [...current.pages.slice(0,undo.pageIndex),{pageId:undo.removedPageId,panels:undo.beforePanels},...current.pages.slice(undo.pageIndex)]
          : current.pages;
        const pages=restoredOrder.map((page,i)=>i<restored.length?{...page,panels:restored[i].panels}:page);
        const empty=pages.every(p=>!p.panels.length);
        const edit=undo.removedPageId&&layer===s.activeBoard?{...s.edit,selectedFeatureId:null}:s.edit;
        return writeBoard({...s,edit,layoutRevision:s.layoutRevision+1},layer,{pages,currentPage:Math.min(undo.pageIndex,pages.length-1),revision:current.revision+1,starter:empty&&!(layer==='management'&&s.onboarding.applyToken)?'ready':'completed',guidance:layer===s.activeBoard?{...current.guidance,visualPending:true}:current.guidance,notice:{id:unique(),kind:'complete',messageKey:'undo-complete',expiresAt:t+options.time.completeMs,layerId:layer}});
      });
      return response(restored[undo.pageIndex]??currentLayout());
    },
    pauseUndo(reason){update((s,t)=>s.commonNotice?{...s,commonNotice:pausedNotice(s.commonNotice,reason,t,true)}:writeActive(s,{undo:paused(s.undo,reason,t,true),notice:pausedNotice(s.notice,reason,t,true)}));},
    resumeUndo(reason){update((s,t)=>{
      let next=s.commonNotice?{...s,commonNotice:pausedNotice(s.commonNotice,reason,t,false)}:s;
      for(const layer of dashboardLayers){const board=next.boards[layer];next=writeBoard(next,layer,{undo:paused(board.undo,reason,layoutTime(layer,t),false),notice:pausedNotice(board.notice,reason,layoutTime(layer,t),false)});}
      return next;
    });},
    setDetailDialogFullscreen(detailDialogFullscreen){update(s=>s.detailDialogFullscreen===detailDialogFullscreen?s:{...s,detailDialogFullscreen});},
    setTheme(theme){update(s=>({...s,theme}));},
    setTextScale(textScale){update(s=>({...s,textScale}));},
    setReducedMotion(reducedMotion){update(s=>({...s,reducedMotion}));},
    enterEditing(){if(canOpen()){const s=store.getState();if(s.edit.mode==='view')editStartRevision=s.layoutRevision;update(s=>({...s,widgetHelp:null,edit:{...s.edit,mode:'edit'}}));}},
    selectPanel(featureId){const s=store.getState();if(s.edit.mode!=='edit'||!s.panels.some(p=>p.featureId===featureId))return false;update(s=>({...s,edit:{...s.edit,selectedFeatureId:featureId}}));return true;},
    finishEditing(){
      if(store.getState().gesturePreview||store.getState().edit.gesture)return false;
      update((s,t)=>{
        if(s.edit.mode==='view')return s;
        const changed=editStartRevision!==null&&s.layoutRevision!==editStartRevision;
        const canUndoPageRemoval=s.undo?.kind==='remove-page'&&s.notice?.undoToken===s.undo.token;
        editStartRevision=null;
        const next={...s,edit:{mode:'view' as const,gesture:null,gestureToken:null,selectedFeatureId:null}};
        return changed&&!canUndoPageRemoval?writeActive(next,{notice:{id:unique(),kind:'complete',messageKey:'edit-complete',expiresAt:t+options.time.completeMs,layerId:s.activeBoard}}):next;
      });return true;
    },
    openDrawer(group,query=''){
      if(!canOpen())return false;
      update((s,t)=>({...closePanelHelp(dismiss(s,t,'choose-feature')),overlay:{type:'drawer',group,query},exitPendingToken:null,exitingOverlay:null}));return true;
    },
    openSettings(){if(!canOpen())return false;update(s=>({...closePanelHelp(s),overlay:{type:'settings'},exitPendingToken:null,exitingOverlay:null}));return true;},
    openDetail(featureId,returnFocusKey){
      if(store.getState().edit.mode==='edit'||!canOpen()||!boardCatalog(store.getState().activeBoard).some(feature=>feature.id===featureId)||!store.getState().panels.some(p=>p.featureId===featureId))return false;
      update(s=>({...closePanelHelp(s),overlay:{type:'detail',featureId,returnFocusKey},exitPendingToken:null,exitingOverlay:null,detailReturn:null,detailState:null,closingParent:null}));return true;
    },
    /** v4.1 (API-03): the root detail of any registry widget (unplaced or on another layer included); ref.focus is kept. */
    openDetailRef(ref,returnFocusKey){
      const s=store.getState();
      if(disposed||s.screen!=='dashboard'||s.edit.mode==='edit'||s.overlay.type!=='none'||s.exitPendingToken||!canOpen()||!knownFeature(ref.featureId))return false;
      const root=copyDetailRef(ref);
      const withState=Object.keys(root).length>1;
      update(s=>({...closePanelHelp(s),overlay:{type:'detail',featureId:root.featureId,returnFocusKey,...(withState?{stack:[root]}:{})},exitPendingToken:null,exitingOverlay:null,detailReturn:null,detailState:null,closingParent:null}));return true;
    },
    closeOverlay(reason='button',input){
      const s=store.getState();if(s.overlay.type==='none')return null;
      const token=unique();
      if(s.overlay.type==='closing'&&s.overlay.returnTo&&s.closingParent){
        update(s=>({...s,overlay:s.closingParent!,detailState:s.overlay.type==='closing'?s.overlay.returnTo??null:null,closingParent:null,closingInput:input??null,exitPendingToken:null,exitingOverlay:null}));return token;
      }
      update(s=>({...s,widgetHelp:s.overlay.type==='detail'&&s.widgetHelp?.origin==='detail'?null:s.widgetHelp,overlay:{type:'none'},exitingOverlay:s.overlay,exitPendingToken:token,closingInput:reason==='drag-start'?null:input??null,briefing:s.overlay.type==='briefing'?'dismissed':s.briefing,detailReturn:null,detailState:null,closingParent:null}));return token;
    },
    finishOverlayExit(token){update(s=>s.exitPendingToken===token?{...s,exitPendingToken:null,exitingOverlay:null}:s);},
    visualSettled(completion){
      const current=store.getState();if(current.screen!=='dashboard'||completion&&(completion.runId!==current.runId||completion.transitionToken!==current.transitionToken))return;
      update((s,t)=>{
        const g=s.guidance,first=!g.dashboardReady;
        if(first)readyAt={...readyAt,[s.activeBoard]:t};
        return writeActive(s,{starter:s.starter==='running'?'completed':s.starter,guidance:{...g,dashboardReady:true,visualPending:false,nextCoachAt:first?t+options.time.coachFirstMs:g.nextCoachAt}});
      });
    },
    /** v4.1: CoachFooter 'skip all remaining'. Visible and queued F-03 steps and widget explanations become 'dismissed'; the help (?) still works. */
    skipWidgetCoaches(){
      update((s,t)=>{
        const g=s.guidance;
        if(!g.active&&!g.activeWidget&&!g.queue.length&&!g.widgetQueue.length)return s;
        const coach={...g.coach},widgetCoach={...g.widgetCoach};
        for(const step of [...(g.active?[g.active]:[]),...g.queue])coach[step]='dismissed';
        for(const id of [...(g.activeWidget?[g.activeWidget]:[]),...g.widgetQueue])widgetCoach[id]='dismissed';
        return writeActive(s,{guidance:{...g,coach,widgetCoach,active:null,targetFeatureId:null,queue:[],activeWidget:null,widgetQueue:[],nextCoachAt:t+options.time.coachGapMs}});
      });
    },
    dismissCoach(){const g=store.getState().guidance;update((s,t)=>dismiss(s,t));return g.active!==null||g.activeWidget!==null;},
    coachedAction(step){const s=store.getState();const matches=s.guidance.active===step&&!!s.gesturePreview&&(step==='resize-panel'?s.gesturePreview.source==='resize':s.gesturePreview.source==='panel'||s.gesturePreview.source==='keyboard');if(matches)update((s,t)=>dismiss(s,t,step));return matches;},
    markFirstHintSeen(){
      const s=store.getState(),ready=readyAt[s.activeBoard];
      if(s.guidance.firstHintSeen||!boardEmpty(s.boards[s.activeBoard])||ready===null||now()-ready<options.time.hintDelayMs||s.activeInputs.length)return false;
      update(s=>writeActive(s,{guidance:{...s.guidance,firstHintSeen:true}}));return true;
    },
    inputStarted(input){
      let s=store.getState();
      if(s.idle.wakeInputToken&&!s.idle.wakeInputToken.released)return true;
      if(s.activeInputs.some(x=>sameInput(x,input)))return sameInput(s.closingInput,input);
      if(input.kind==='pointer'&&s.activeInputs.some(x=>x.kind==='pointer'&&!sameInput(x,input)))return true;
      if(s.gesturePreview?.pendingCommit){actions.cancelPreview();s=store.getState();}
      const wake=s.idle.mode==='idle';
      update((s,t)=>{
        const firstHintSeen=s.guidance.firstHintSeen||s.screen==='dashboard'&&s.guidance.dashboardReady;
        const next:RunState={...s,closingInput:null,activeInputs:[...s.activeInputs.filter(x=>!sameInput(x,input)),input],idle:{...s.idle,mode:'active',lastInputAt:t,wakeInputToken:wake?{token:unique(),input,released:false}:null}};
        return firstHintSeen===s.guidance.firstHintSeen?next:writeActive(next,{guidance:{...s.guidance,firstHintSeen}});
      });return wake;
    },
    inputEnded(input){
      const s=store.getState();const consume=sameInput(s.idle.wakeInputToken?.input,input)||sameInput(s.closingInput,input);
      update((s,t)=>({...s,activeInputs:s.activeInputs.filter(x=>!sameInput(x,input)),idle:{...s.idle,lastInputAt:t,wakeInputToken:sameInput(s.idle.wakeInputToken?.input,input)?{...s.idle.wakeInputToken!,released:true}:s.idle.wakeInputToken}}));return consume;
    },
    consumeInput(input,phase){
      const s=store.getState();const consume=sameInput(s.idle.wakeInputToken?.input,input)||sameInput(s.closingInput,input);
      if(!consume)return false;
      if(phase==='click'||phase==='cancel')update((s,t)=>({...s,closingInput:sameInput(s.closingInput,input)?null:s.closingInput,activeInputs:s.activeInputs.filter(x=>!sameInput(x,input)),idle:{...s.idle,lastInputAt:t,wakeInputToken:sameInput(s.idle.wakeInputToken?.input,input)?null:s.idle.wakeInputToken}}));
      else if(phase==='up')actions.inputEnded(input);
      return true;
    },
    setPageHidden(pageHidden){
      if(pageHidden)actions.cancelPreview();
      update((s,t)=>{
        let next:RunState={...s,pageHidden,...(pageHidden?{activeInputs:[],closingInput:null,idle:{...s.idle,wakeInputToken:null,lastInputAt:t}}:{})};
        next={...next,commonNotice:pausedNotice(next.commonNotice,'page-hidden',t,pageHidden),...(next.posUi.orderUndo?{posUi:{...next.posUi,orderUndo:pageHidden?pauseOrderUndo(next.posUi.orderUndo,'page-hidden',Date.now()):resumeOrderUndo(next.posUi.orderUndo,'page-hidden',Date.now())}}:{})};
        for(const layer of dashboardLayers){const board=next.boards[layer],at=layoutTime(layer,t);const undo=paused(board.undo,'page-hidden',at,pageHidden),notice=pausedNotice(board.notice,'page-hidden',at,pageHidden);if(undo!==board.undo||notice!==board.notice)next=writeBoard(next,layer,{undo,notice});}
        return next;
      });
    },
    clearNotice(){update(s=>s.commonNotice?{...s,commonNotice:null}:s.notice?writeActive(s,{notice:null}):s);},
    tick(){update(s=>s,true);},
    resetRun(next){
      if(disposed)return;
      const nextContext=validateContext({screenPreset:next.screenPreset,catalog:next.catalog});
      if(options.layoutAdapter)adapter.cancel();else{adapter.dispose();adapter=createLayoutWorkerClient();}
      consumedGestures.clear();noticePauses.clear();commonPauses.clear();prepared.clear();readyAt={management:null,marketing:null};
      context=nextContext;catalogs=layerCatalogs(context.catalog);
      const t=now();runStartedAt=t;store.setState(immutable(initial(initialOptions(next),t,unique())),true);
    },
    switchLayer(layer){
      const s=store.getState();
      if(disposed||!layerIds.includes(layer)||layer===s.layer)return false;
      // SCR-21: not while editing, dragging, previewing, pressing, in a modal, during an exit or while idle.
      if(s.screen!=='dashboard'||s.edit.mode==='edit'||s.edit.gesture||s.gesturePreview||s.activeInputs.some(input=>input.kind==='pointer')||s.overlay.type!=='none'&&s.overlay.type!=='drawer'||s.exitPendingToken||s.idle.mode==='idle'||s.idle.wakeInputToken||s.closingInput)return false;
      update((s,t)=>{
        // The drawer closes at once (its surface may leave with the layer); a visible F-03 coach is recorded as
        // dismissed and a visible explanation returns to its queue for when this layer is shown again.
        let next:RunState={...s,overlay:{type:'none'},widgetHelp:null,...(s.layer==='orders-payment'?{posUi:{...s.posUi,forceStatusVisible:false}}:{})};
        if(next.guidance.active)next=dismiss(next,t,next.guidance.active);
        if(next.guidance.activeWidget)next=writeActive(next,{guidance:requeueWidget(next.guidance)});
        next={...next,layer,idle:{...next.idle,mode:'active',lastInputAt:t},...(layer==='orders-payment'?{posUi:{...next.posUi,tab:selectPosPreferences(next.shopSettings).startTab}}:{})};
        if(isDashboardLayer(layer)){
          next=mirror({...next,activeBoard:layer});
          if(layer==='marketing')next=writeBoard(next,'marketing',{guidance:queueStep(next.boards.marketing.guidance,'choose-feature')});
          next=delayCoach(next,layer,t);
        }
        return next;
      });
      return true;
    },
    goToPage(index){
      const s=store.getState(),board=s.boards[s.activeBoard];
      if(disposed||!Number.isInteger(index)||index<0||index>=board.pages.length)return false;
      if(s.gesturePreview||s.edit.gesture||s.overlay.type==='detail'||s.overlay.type==='closing'||s.overlay.type==='settings'||s.overlay.type==='briefing'||s.idle.wakeInputToken||s.closingInput)return false;
      if(index!==board.currentPage)update((s,t)=>changePage(s,index,t));
      return true;
    },
    addPage(){
      const s=store.getState(),board=s.boards[s.activeBoard];
      if(board.pages.length>=PAGE_LIMIT){errorNotice('PAGE_LIMIT');return {ok:false,code:'PAGE_LIMIT'};}
      const index=board.pages.length;
      const nextPageId=pageIdAllocator(board);
      update((s,t)=>changePage(writeActive(s,{pages:[...board.pages,{pageId:nextPageId(),panels:[]}]}),index,t));
      return {ok:true,index};
    },
    removePage(page,expectedLayoutRevision){
      const s=store.getState(),board=s.boards[s.activeBoard],index=board.currentPage;
      if(disposed||s.screen!=='dashboard'||s.layer!==s.activeBoard||s.edit.mode!=='edit'||index===0
        ||board.pages[index]!==page||s.layoutRevision!==expectedLayoutRevision||!canOpen()
        ||(s.overlay.type!=='none'&&s.overlay.type!=='drawer'))return false;
      const pages=board.pages.filter((_,i)=>i!==index),revision=board.revision+1;
      const beforePages=snapshotPages(board.pages);
      adapter.cancel();
      update((current,t)=>{
        const undo:UndoEntry={token:unique(),kind:'remove-page',removedPageId:page.pageId,layerId:board.layerId,
          pageIndex:index,beforePages,beforePanels:beforePages[index],appliedRevision:revision,
          remainingMs:options.time.undoMs,expiresAt:t+options.time.undoMs,
          pausedReasons:current.pageHidden?['page-hidden']:[],consumed:false};
        const notice:Notice={id:unique(),kind:'success',messageKey:'ui.page.removed',undoToken:undo.token,
          expiresAt:undo.expiresAt,layerId:board.layerId};
        const moved=changePage(current,index-1,t);
        const starter=pages.every(p=>!p.panels.length)&&!(board.layerId==='management'&&current.onboarding.applyToken)?'ready':board.starter;
        return writeActive({...moved,layoutRevision:current.layoutRevision+1},{pages,revision,starter,undo,notice,
          guidance:{...moved.guidance,visualPending:true}});
      });
      return true;
    },
    openWidgetHelp(featureId,origin,returnFocusKey){
      const s=store.getState();
      if(disposed||s.edit.mode==='edit'||s.edit.gesture||s.gesturePreview||s.idle.wakeInputToken||s.closingInput||!knownFeature(featureId))return false;
      if(origin==='detail'?s.overlay.type!=='detail':origin!=='panel'||!onViewedPage(s,featureId))return false;
      // A visible coach is recorded as dismissed; the help itself never changes "seen once" records.
      update((s,t)=>({...dismiss(s,t),widgetHelp:{featureId,origin,returnFocusKey}}));
      return true;
    },
    closeWidgetHelp(){
      if(!store.getState().widgetHelp)return false;
      update((s,t)=>delayCoach({...s,widgetHelp:null},s.activeBoard,t));return true;
    },
    openLinkedDetail(ref,source){
      const s=store.getState(),overlay=s.overlay;
      if(disposed||overlay.type!=='detail'||!knownFeature(ref.featureId))return false;
      if(source&&source.ref.featureId!==overlay.featureId)return false;
      const first:DetailRef=overlay.stack?.[0]??{featureId:overlay.featureId};
      const linked=copyDetailRef(ref);
      const returnTo=immutable(source??s.detailReturn??s.detailState??defaultReturn(first,overlay.returnFocusKey));
      update(s=>({...s,widgetHelp:s.widgetHelp?.origin==='detail'?null:s.widgetHelp,detailReturn:returnTo,detailState:null,overlay:{type:'detail',featureId:linked.featureId,returnFocusKey:overlay.returnFocusKey,stack:[first,linked]}}));
      return true;
    },
    detailBack(){
      const overlay=store.getState().overlay;
      if(disposed||overlay.type!=='detail'||(overlay.stack?.length??0)<2)return false;
      const first=overlay.stack![0];
      update(s=>({...s,widgetHelp:s.widgetHelp?.origin==='detail'?null:s.widgetHelp,detailState:s.detailReturn,detailReturn:null,overlay:{type:'detail',featureId:first.featureId,returnFocusKey:overlay.returnFocusKey,stack:[first]}}));
      return true;
    },
    restoreAccount(stored){
      // D-365: a board saved with a widget that left the product (마케팅 성과) drops it and closes the gap, instead of failing the restore.
      const restore=withoutRemovedWidgets(stored,grid());
      if(disposed||!locales.includes(restore.locale)||!dashboardLayers.every(layer=>{
        const board=restore.boards[layer];
        return !!board&&board.pages.length>=1&&board.pages.length<=PAGE_LIMIT&&Number.isInteger(board.currentPage)&&board.currentPage>=0&&board.currentPage<board.pages.length
          &&board.pages.every(page=>{const layout=evaluate(page.panels,grid(),boardCatalog(layer));return layout.valid;});
      }))return false;
      update((s,t)=>{
        const done=restore.onboardingDone;
        let next:RunState={...s,theme:restore.theme,textScale:restore.textScale,locale:restore.locale,businessType:restore.settings.businessType,shopSettings:immutable({...s.shopSettings,...restore.settings}),
          ...(done&&s.onboarding.step!=='done'?{demoRestart:false,screen:'dashboard' as const,transitionToken:unique(),templateTour:null,onboarding:{...s.onboarding,step:'done' as const,selectedTemplateId:null,applyToken:null,draft:{...s.onboarding.draft,businessType:restore.settings.businessType,paymentStyle:restore.settings.paymentStyle,tableLayout:restore.settings.tableLayout}}}:{})};
        if(!done&&(s.demoRestart||restore.resumeDemoRestart))next=startDemoRestart(next,t);
        for(const layer of dashboardLayers){
          const incoming=restore.boards[layer],board=next.boards[layer];
          // A returning owner is not coached again: every first-run step counts as seen.
          const guidance:GuidanceProgress=done?{...board.guidance,firstHintSeen:true,dashboardReady:true,visualPending:false,active:null,targetFeatureId:null,queue:[],panelMilestones:{first:true,second:true},coach:{'choose-feature':'dismissed','resize-panel':'dismissed','move-panel':'dismissed'}}:board.guidance;
          next=writeBoard(next,layer,{pages:incoming.pages,currentPage:incoming.currentPage,revision:incoming.revision,guidance,starter:incoming.pages.some(page=>page.panels.length)?'completed':board.starter,undo:null,notice:null});
        }
        return {...next,layoutRevision:s.layoutRevision+1,runRevision:s.runRevision+1};
      });
      return true;
    },
    setLocale(locale){
      if(!locales.includes(locale))return false;
      update(s=>s.locale===locale?s:{...s,locale});return true;
    },
    setPreviewFamily(family){
      if(!families.includes(family))return;
      // Choosing a family clears every per-widget choice (SCR-29).
      update(s=>s.preview.family===family&&!Object.keys(s.preview.overrides).length?s:{...s,preview:{family,overrides:{}}});
    },
    setPreviewSelection(next,expected){
      const state=store.getState();
      if(state.preview!==expected||state.posUi.approval?.status==='pending'||!families.includes(next.family)||
        next.closing!==undefined&&!['normal','no-payments','error'].includes(next.closing)||
        next.pos!==undefined&&!['normal','empty','error','payment-failure'].includes(next.pos)||
        Object.entries(next.overrides).some(([id,variant])=>!knownFeature(id)||
          variant!==NORMAL_VARIANT&&!previewVariants(id as FeatureId).some(option=>option.id===variant)))return false;
      const preview={...next,overrides:{...next.overrides}};
      update(s=>({...s,preview}));
      return store.getState().preview===preview;
    },
    setPreviewVariant(featureId,variant){
      if(!knownFeature(featureId))return;
      update(s=>{
        const overrides:Partial<Record<FeatureId,string>>={...s.preview.overrides};
        if(variant===null){if(!(featureId in overrides))return s;delete overrides[featureId];}
        else{if(overrides[featureId]===variant)return s;overrides[featureId]=variant;}
        return {...s,preview:{...s.preview,overrides}};
      });
    },
    resetWidgetPreview(featureId){
      if(!knownFeature(featureId))return;
      update(s=>{
        const overrides:Partial<Record<FeatureId,string>>={...s.preview.overrides};
        if(s.preview.family==='normal'){if(!(featureId in overrides))return s;delete overrides[featureId];}
        else{if(overrides[featureId]==='normal')return s;overrides[featureId]='normal';}
        return {...s,preview:{...s.preview,overrides}};
      });
    },
    setChatReceiptVisible(receipt, visible) {
      update(s => {
        if (visible && s.commonNotice?.chatReceipt === receipt && s.inlineChatReceipt !== receipt) return { ...s, inlineChatReceipt: receipt };
        if (!visible && s.inlineChatReceipt === receipt) return { ...s, inlineChatReceipt: undefined };
        return s;
      });
    },
    showNotice(request: NoticeRequest | ChatReceiptNoticeRequest){
      update((s,t)=>{
        const receipt=s.commonNotice;
        if(request.kind==='error'&&request.messageKey==='UNDO_UNAVAILABLE'&&(receipt?.undo?.target==='run'||receipt?.chatReceipt)){
          // CommonNotice reports a refused reversal here. Keep the original receipt deadline for retry.
          return {...s,commonNotice:{...receipt,kind:'error',messageKey:'data.error.undoUnavailable'}};
        }
        const undo=request.undo;
        const layoutUndo=undo?.target==='layout'&&s.undo?.token===undo.token;
        // A server receipt's undo deadline (REAL-PLAN) caps the toast: it never outlives what the server will still accept.
        const duration=request.messageKey==='settings.businessChanged'?options.time.noticeMs:request.undoUntil===undefined?options.time.undoMs:Math.max(0,Math.min(options.time.undoMs,request.undoUntil-Date.now()));
        const expiresAt=t+duration;
        let notice:ExpiringNotice={id:unique(),kind:request.kind,messageKey:request.messageKey,expiresAt,layerId:s.activeBoard,...(request.featureId?{featureId:request.featureId}:{}),...(request.params?{params:request.params}:{}),...(undo?{undo:{target:undo.target,token:undo.token}}:{}),...(layoutUndo?{undoToken:undo.token}:{}),...(request.undoUntil!==undefined?{absoluteExpiry:true}:{})};
        if(undo?.target==='data'&&s.pageHidden)notice=pausedNotice(notice,'page-hidden',t,true)!;
        const posUi=s.posUi.orderUndo&&undo?.token!==s.posUi.orderUndo.token?{...s.posUi,orderUndo:null}:s.posUi;
        const chatReceipt = 'chatReceipt' in request && (undo?.target === 'data' || undo?.target === 'run') ? request.chatReceipt : undefined;
        const backing = chatReceipt && 'layoutUndo' in request && undo?.target === 'run' ? request.layoutUndo : undefined;
        const layoutReceipt = backing && s.boards[backing.layer].undo?.token === backing.token ? {layoutUndo:backing} : {};
        return undo?.target==='layout'?writeActive({...s,posUi},{notice}):{...s,posUi,commonNotice:{...shellNotice(s,notice,t),...(chatReceipt && {chatReceipt}),...layoutReceipt},inlineChatReceipt:undefined};
      });
    },
    supersedeWidgetSuccessNotice(featureId){
      update(s=>{
        const receipt=s.commonNotice;
        if(receipt?.kind!=='success'||receipt.featureId!==featureId||receipt.chatReceipt)return s;
        const commonNotice=receipt.undo
          ? {...receipt,kind:'complete' as const,messageKey:'data.real.receipt.previousChange',params:undefined}
          : null;
        return {...s,commonNotice};
      });
    },
    acknowledgeBriefing(){update(s=>s.briefing==='pending'?{...s,briefing:'dismissed',briefingSafeSince:null}:s);},
  };
  const commandActions=new Set<keyof RunPresentationActions>(['applyLayoutIntent','commitAssistantBatch','commitNavisLayout','startWithThree','startWithPreset','applyManagementTemplate','commitPreview','movePanelToPage','undo','updatePreview']);
  const booleanActions=new Set<keyof RunPresentationActions>(['setPosUi','setOnboardingAnswer','onboardingBack','updateOnboardingTableDraft','saveOnboardingTables','skipOnboardingTables','selectStartTemplate','startEmpty','templateAssembled','restoreAccount','nextTemplateTour','closeTemplateTour','openClosing','selectPanel','finishEditing','openDrawer','openSettings','openDetail','openDetailRef','dismissCoach','coachedAction','markFirstHintSeen','inputStarted','inputEnded','consumeInput','switchLayer','goToPage','openWidgetHelp','closeWidgetHelp','openLinkedDetail','detailBack','setLocale','rememberDetailState']);
  for(const action of ['restartOnboarding','chooseDemoLayout','finishDemoRestart','removePage'] as const)booleanActions.add(action);
  const tourBlockedActions=new Set<keyof RunPresentationActions>(['applyLayoutIntent','commitAssistantBatch','commitNavisLayout','startWithThree','startWithPreset','beginPreview','updatePreview','commitPreview','movePanelToPage','undo','enterEditing','selectPanel','finishEditing','openDrawer','openSettings','openDetail','openDetailRef','openClosing','dismissCoach','coachedAction','skipWidgetCoaches','markFirstHintSeen','switchLayer','goToPage','addPage','removePage','flipPageDuringGesture','openWidgetHelp','openLinkedDetail','acknowledgeBriefing','rememberDetailState']);
  const guardedActions=new Map<keyof RunPresentationActions,(...args:unknown[])=>unknown>();
  // One entrance guard also covers synchronous re-entry through any public action.
  const actions:RunPresentationActions=new Proxy(actionImpl,{get(target,key: keyof RunPresentationActions){
    const action=target[key];
    if(typeof action!=='function')return action;
    const existing=guardedActions.get(key);if(existing)return existing;
    const guarded=(...args:unknown[])=>{
      if(busy()||templateBlocked(store.getState())&&tourBlockedActions.has(key)){
        if(commandActions.has(key))return rejected('CANCELLED');
        if(booleanActions.has(key))return false;
        if(key==='beginPreview'||key==='closeOverlay')return null;
        if(key==='addPage'||key==='flipPageDuringGesture')return {ok:false,code:'CANCELLED'};
        return undefined;
      }
      return Reflect.apply(action,target,args);
    };
    guardedActions.set(key,guarded);return guarded;
  }});
  function nextDeadline():number|null{
    if(disposed)return null;
    const s=store.getState();const deadlines:number[]=[];
    for(const eligible of s.linkedOccupancy.seatedWithoutOrder){
      if(s.linkedOccupancy.elapsedNow-eligible.since<=600_000)deadlines.push(runStartedAt+eligible.since+600_001);
    }
    if(s.commonNotice)deadlines.push(s.commonNotice.expiresAt);
    if(s.templateTour?.status==='waiting'&&s.onboarding.step==='done'&&!s.pageHidden)deadlines.push(s.templateTour.readyAt);
    for(const layer of dashboardLayers){
      const board=s.boards[layer];
      if(!s.commonNotice&&board.undo&&!board.undo.pausedReasons.length)deadlines.push(board.undo.expiresAt);
      if(!s.commonNotice&&board.notice&&!board.notice.undoToken)deadlines.push(board.notice.expiresAt);
    }
    const g=s.guidance;
    if(!g.active&&!g.activeWidget&&coachSafe(s)&&(g.queue.some(step=>hasTarget(s,step))||g.widgetQueue.some(id=>onViewedPage(s,id))))deadlines.push(g.nextCoachAt);
    if(s.briefingSafeSince!==null)deadlines.push(s.briefingSafeSince+options.time.briefingSafeMs);
    if(s.screen==='dashboard'&&s.layer!=='orders-payment'&&!s.idle.blockedReasons.length&&!s.guidance.visualPending&&s.idle.mode==='active')deadlines.push(s.idle.lastInputAt+options.time.idleMs);
    const finite=deadlines.filter(Number.isFinite);
    // Remaining delay in the injected clock's units, suitable for a single scheduler.
    return finite.length?Math.max(0,Math.ceil(Math.min(...finite)-now())):null;
  }
  return {get catalog(){return context.catalog;},getState:store.getState,subscribe:store.subscribe,actions,session,nextDeadline,async prepareLayout(){const preparing=adapter,runId=store.getState().runId;const current=()=>!disposed&&adapter===preparing&&store.getState().runId===runId;try{await preparing.ready();return current();}catch{if(current())errorNotice('INTERNAL_LAYOUT_ERROR');return false;}},dispose(){if(disposed||busy())return;disposed=true;prepared.clear();listeners.clear();adapter.dispose();}};
}
/** T-007 supplies browser scheduling; domain tests can advance the clock and tick directly. */
export function attachRunTimers(run:RunStore,scheduler:TimerScheduler):()=>void{
  let handle:unknown;let scheduled=false;let disposed=false;
  function schedule(){
    if(scheduled){scheduler.cancel(handle);scheduled=false;}
    if(disposed)return;
    const delay=run.nextDeadline();
    if(delay!==null){scheduled=true;handle=scheduler.schedule(()=>{scheduled=false;if(!disposed){run.actions.tick();schedule();}},delay);}
  }
  const unsubscribe=run.subscribe(schedule);schedule();
  return ()=>{disposed=true;unsubscribe();if(scheduled)scheduler.cancel(handle);scheduled=false;};
}
