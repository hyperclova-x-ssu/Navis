import navisSymbol from '../../assets/brand/navis-symbol.svg';
import {useCallback,useEffect,useId,useImperativeHandle,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type Ref} from 'react';
import {createPortal} from 'react-dom';
import {motion} from 'motion/react';
import {useDraggable} from '@dnd-kit/core';
import type {CellSpan,CommandResult,DetailRef,FeatureId,Overlay,RunStore} from '../../contracts';
import {getRegistration,getRegistry} from '../../catalog';
import {findPlacement} from '../../state';
import {isNavisLayoutNavigationConflict} from '../../features/assistant/domains/layout';
import {navisStreamMessages as copy,navisTranslator} from '../../features/assistant/messages';
import {destinationOpenLabel,openedDetailText} from '../../features/assistant/destinations';
import {pressIsOutsideChat} from './navis-outside';
import {ChatGlyph} from '../../features/assistant/chat-glyphs';
import {NAVIS_INPUT_LIMIT, type ProposalSession} from '../../features/assistant/navis-conversation';
import {motionTokens,timePolicy,transitionFor,useUi} from '../../ui';
import {agentStatusLabel,AiConversation,CandidateCard,createAssistantProvider,type AgentContinuation,type Candidate,type ConversationMessage} from '../../features/assistant';
import {AgentReplyControls,TestSmsHandoffCard} from '../../features/assistant/proposal-card';
import {parseMenuCreateInput,storeFactSource} from '../../features/assistant/snapshot';
import {shouldBypassNavisNavigation} from '../../features/assistant/provider';
import {selectPromptSuggestions} from '../../features/assistant/prompt-suggestions';
import {matchWidget,norm} from '../../features/assistant/question';
import {useWidgetDataStore} from '../../data/react';
import {ActionButton} from '../../ui';
import {validateAgentDetailRef,type AgentNavigationAction} from '../../../shared/navis-agent-schema.mjs';
import type {AgentHandoff,AskInput,AssistantReply} from '../../features/assistant/types';
import {NAVIS_RETURN_FOCUS,classifyNavigation,prepareNavigationRequest,routeMenuForm,type NavigationResult,type NavisNavigation} from './navis-navigation';
import type {DashboardController,DragData} from './controller';
import type {Rect} from './gestures';
import {useRun} from './use-run';
import {useDashboardT} from './use-dashboard-t';

/** Keep only completed question/answer pairs from the visible conversation. */
export function buildConversationHistory(messages:readonly ConversationMessage[]): {role:'user'|'assistant';text:string}[] {
 const pairs:{role:'user'|'assistant';text:string}[][]=[];
 let question:string|undefined;
 const trim=(text:string,cap:number)=>{
  const value=text.trim();if(value.length<=cap)return value;
  const prefix=value.slice(0,cap);
  const endings=[...prefix.matchAll(/[.!?。！？](?=\s|$)/gu)];
  return (endings.length?prefix.slice(0,endings[endings.length-1].index!+1):prefix).trim();
 };
 for(const message of messages){
  if(message.role==='user'){question=message.text;continue;}
  if(message.reply?.protocol==='agent-v1'){question=undefined;continue;}
  if(!message.requestText||question!==message.requestText)continue;
  if(message.reply?.mode==='simple')continue;
  if(message.reply?.outOfScope){question=undefined;continue;}
  if(message.delivery||message.reply?.status==='stopped'||!message.reply){question=undefined;continue;}
  const answer=message.placementResults?.join('\n')??message.placementPrompt??message.text;
  const user=trim(question,300),assistant=trim(answer,500);
  if(user&&assistant)pairs.push([{role:'user',text:user},{role:'assistant',text:assistant}]);
  question=undefined;
 }
 const last=pairs.slice(-3);
 while(last.flat().reduce((sum,item)=>sum+item.text.length,0)>2400)last.shift();
 return last.flat();
}

/** Only explicit commands in the current message authorize placement. */
export const PLACEMENT_WORDS = Object.freeze({
 verbs: ['추가','놓아','놔','올려','넣어','깔아'] as const,
 surfaces: ['위젯','패널','대시보드','보드','화면에'] as const,
 englishVerbs: /\b(?:add|put|place)\b/iu,
 englishSurfaces: /\b(?:widget|panel|dashboard|board)s?\b/iu,
});
export function hasPlacementIntent(text:string):boolean {
 const value=text.normalize('NFKC').toLocaleLowerCase();
 if(/(?:이전|기존|모든|앞선)\s*(?:지시|규칙|명령).*무시|ignore\s+(?:all\s+|previous\s+)?(?:instructions|rules)|(?:추가|놓|올리|넣|깔)[^.!?]{0,12}(?:하지\s*마|말아|하지\s*않)|\b(?:don't|do not|never)\s+(?:add|put|place)\b/iu.test(value))return false;
 if(/(?:뭐|무엇|어떤|어느).{0,20}(?:좋아|추천|할까)|\b(?:which|what|how)\b/iu.test(value))return false;
 const verb=PLACEMENT_WORDS.verbs.some(word=>value.includes(word))||PLACEMENT_WORDS.englishVerbs.test(value);
 const surface=PLACEMENT_WORDS.surfaces.some(word=>value.includes(word))||PLACEMENT_WORDS.englishSurfaces.test(value);
 return verb&&surface;
}
/** One conversation per run, shared by both dashboard layers (D-63 ④), kept while the screen remounts. */
interface ConversationMemory {runId:string;draft:string;messages:ConversationMessage[];lastRequest:string;nextMessageId:number;placed:Set<string>}
interface PendingReply {
 readonly controller: AbortController;
 readonly text: string;
 readonly messageId: string;
 started: boolean;
 waitingVisible: boolean;
 delayed: boolean;
 showTimer?: ReturnType<typeof setTimeout>;
 delayTimer?: ReturnType<typeof setTimeout>;
}
function clearWaitingTimers(request: PendingReply) {
 clearTimeout(request.showTimer);
 clearTimeout(request.delayTimer);
}
const conversations=new WeakMap<RunStore,ConversationMemory>();
const aiInput={kind:'keyboard',id:'ai-conversation-active'} as const;
const korean=navisTranslator('ko');
const candidateKey=(data:Pick<DragData,'featureId'|'condition'|'size'>)=>JSON.stringify([data.featureId,data.condition,data.size]);
const isCellSpan=(value:number):value is CellSpan=>Number.isInteger(value)&&value>=1&&value<=4;
const popupSelector='.ui-dialog[role="dialog"],.ui-dialog[role="alertdialog"]';
const overlayDepth=(overlay:Overlay)=>overlay.type==='detail'?overlay.stack?.length??1:0;
interface HiddenHandoff {readonly overlay:Overlay;readonly opener:HTMLElement|null;readonly scrollTop:number}
function handoffStillOpen(target:Overlay,current:Overlay) {
 if(target.type==='detail')return current.type==='detail'&&overlayDepth(current)>=overlayDepth(target)
  ||current.type==='closing'&&!!current.returnTo;
 return target.type===current.type;
}
export interface NavisHandle {readonly candidateResult:(data:DragData,result:CommandResult|null)=>void;readonly close:(restoreFocus?:boolean)=>void}
function CandidateChoice({candidate,controller,readRect}:{readonly candidate:Candidate;readonly controller:DashboardController;readonly readRect:(el:HTMLElement|null)=>Rect}){
 const data:DragData={source:'candidate',featureId:candidate.featureId,size:candidate.size,condition:candidate.condition};
 const id=useId();const {listeners,attributes,setNodeRef}=useDraggable({id:`candidate-${id}`,data});
 return <div ref={setNodeRef} data-candidate-id={candidate.featureId} {...listeners} {...attributes} role={undefined} tabIndex={undefined}><CandidateCard candidate={candidate} onSelect={()=>controller.tap(data,{x:0,y:0},readRect(null))}/></div>;
}
/** The words of an owner's pick on a clarification, exactly as its button showed them (price as money, a named choice by its label). */
function continuationLabel(reply: AssistantReply, answer: AgentContinuation): string | undefined {
 if('price' in answer)return korean.format.money(answer.price,'full');
 if('choiceId' in answer&&(reply.turn?.kind==='clarification'||reply.turn?.kind==='ambiguity')){
  const choice=reply.turn.choices.find(item=>item.id===answer.choiceId);
  return choice?.label||choice?.detail||undefined;
 }
 return undefined;
}
function retirePendingCard(memory: ConversationMemory) {
 return [...memory.messages].reverse().some(message=>message.reply?.proposalSession?.retireForClose());
}
function reproposalText(original: string, session?: ProposalSession) {
 const menu = session?.getSnapshot().menu?.preview.after;
 if (!menu) return original;
 const text = `메뉴에 ${menu.name} ${menu.category === 'dessert' ? '디저트' : '음료'} ${menu.price}원 추가해줘${menu.memo ? ` 메모 ${menu.memo}` : ''}`;
 const parsed = parseMenuCreateInput(text);
 return parsed?.name === menu.name && parsed.category === menu.category && parsed.price === menu.price
  && (parsed.memo ?? null) === menu.memo ? text : original;
}
export interface DashboardNavisProps {readonly run:RunStore;readonly controller:DashboardController;readonly readRect:(el:HTMLElement|null)=>Rect;readonly dragging:boolean;readonly visible:boolean;readonly onShowPanel:(featureId:FeatureId)=>void;readonly onCreated:(featureId:FeatureId)=>void;readonly navigation?:NavisNavigation;readonly ref?:Ref<NavisHandle>}
/** Navis on both dashboard layers (SCR-34): launcher, conversation and candidate cards in the chosen language. */
export function DashboardNavis({run,controller,readRect,dragging,visible,onShowPanel,onCreated,navigation,ref}:DashboardNavisProps){
 const s=useRun(run),{reducedMotion,portalContainer}=useUi(),{t,name,translator}=useDashboardT();
 const memory=useMemo(()=>{const previous=conversations.get(run);if(previous?.runId===s.runId)return previous;const next:ConversationMemory={runId:s.runId,draft:'',messages:[],lastRequest:'',nextMessageId:0,placed:new Set()};conversations.set(run,next);return next;},[run,s.runId]);
 // The run's data store: snapshot facts and simple-mode answers read the same values as the panels.
 const store=useWidgetDataStore();const assistant=useMemo(()=>createAssistantProvider({store,run}),[store,run]);
 const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
 const prompts=useMemo(()=>selectPromptSuggestions(snapshot),[snapshot]);
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(memory.draft),[messages,setMessages]=useState<ConversationMessage[]>(memory.messages),[phase,setPhase]=useState<'idle'|'interpreting'|'placing'>('idle'),[inputError,setInputError]=useState(false);
 const [hiddenHandoff,setHiddenHandoff]=useState<HiddenHandoff>();
 // SCR-23: the launcher is hidden while a modal (settings, closing, POS dialogs) is open; only a detail window keeps it, in its header row.
 const [modal,setModal]=useState(false);
 const [dock]=useState(()=>{const node=document.createElement('div');node.className='dashboard-navis-dock';return node;});
 // Keep the moving dock inside a stationary wrapper outside modals. The dialog
 // can hide that wrapper from assistive tech without hiding the dock it adopts.
 const [standby]=useState(()=>{const node=document.createElement('div');node.className='dashboard-navis-standby';return node;});
 const installDock=useCallback(()=>{
  if(!portalContainer)return;
  const popup=Array.from(portalContainer.querySelectorAll<HTMLElement>(popupSelector))
   .reverse().find(node=>!node.hidden&&!node.inert&&!node.closest('[data-ending-style],.ui-overlay-exit'));
  // A detail window adopts the dock (launcher in its header row). Any other dialog adopts it only while the conversation is open, so the
  // pane stays reachable above the inert page; with the conversation closed the dock stays outside, the launcher is hidden, and the
  // dialog keeps its full width (SCR-23, UXS-5, UXP-7).
  const actions=popup?.querySelector('.detail-body-slot')?popup.querySelector<HTMLElement>('.ui-overlay-header .ui-overlay-actions'):null;
  setModal(Boolean(popup&&!actions));
  const host=popup&&(actions||openRef.current)?popup:standby;
  if(dock.parentElement!==host){
   const focused=dock.contains(document.activeElement)?document.activeElement as HTMLElement:null;
   host.append(dock);
   if(focused?.isConnected)focused.focus({preventScroll:true});
  }
  const chat=dock.querySelector<HTMLElement>('.dashboard-ai');
  dock.toggleAttribute('data-side-by-side',Boolean(host===popup&&chat&&popup.clientWidth>chat.offsetWidth*3));
  // K-E 17: in a detail window the launcher parks in the header row, left of the window's own controls, so it never covers a footer action or a row action in the bottom-right corner.
  // Offsets come from the layout boxes (offsetLeft/offsetTop), not from getBoundingClientRect, so the open animation's scale cannot skew them; dashboard.css turns them into `right` and `top`.
  if(popup&&actions){
   // UXS-6: the header launcher is 48 px like the window's own controls, so set the attribute first and measure after the new size applies.
   dock.dataset.headerDock='true';
   let left=0,top=0,node:HTMLElement|null=actions;
   while(node&&node!==popup){left+=node.offsetLeft;top+=node.offsetTop;node=node.offsetParent as HTMLElement|null;}
   const size=dock.querySelector<HTMLElement>('.dashboard-ai-launcher')?.offsetHeight??0;
   dock.style.setProperty('--navis-header-right',`${popup.offsetWidth-left}px`);
   dock.style.setProperty('--navis-header-top',`${top+actions.offsetHeight/2-size/2}px`);
  }else{
   delete dock.dataset.headerDock;dock.style.removeProperty('--navis-header-right');dock.style.removeProperty('--navis-header-top');
  }
 },[dock,portalContainer,standby]);
 useLayoutEffect(()=>{
  if(!portalContainer)return;
  portalContainer.append(standby);
  installDock();
  const observer=new MutationObserver(installDock);
  observer.observe(portalContainer,{childList:true,subtree:true});
  return()=>{observer.disconnect();dock.remove();standby.remove();};
 },[dock,installDock,portalContainer,standby]);
 const button=useRef<HTMLButtonElement>(null),pane=useRef<HTMLDivElement>(null),openRef=useRef(false),requestId=useRef(0),lastRequest=useRef(memory.lastRequest),pending=useRef<PendingReply|null>(null);
 const updateDraft=(value:string)=>{memory.draft=value;setDraft(value);setInputError(false);};
 const append=(message:ConversationMessage)=>{memory.messages=[...memory.messages,message];setMessages(memory.messages);};
 const patch=(id:string,change:Partial<ConversationMessage>)=>{memory.messages=memory.messages.map(message=>message.id===id?{...message,...change}:message);setMessages(memory.messages);};
 const abortRequest=(showStop:boolean)=>{
  const request=pending.current;
  if(!request)return;
  pending.current=null;requestId.current++;clearWaitingTimers(request);request.controller.abort();setPhase('idle');
  if(showStop)patch(request.messageId,{delivery:'stopped',delayed:false});
  else{memory.messages=memory.messages.filter(message=>message.id!==request.messageId);setMessages(memory.messages);}
  if(!memory.draft)updateDraft(request.text);
 };
 const cancelRequest=()=>abortRequest(true);
 const close=(restoreFocus=false,cardRetired=false)=>{
  const focusInside=pane.current?.contains(document.activeElement);
  handoffRef.current?.abort();abortRequest(false);setHiddenHandoff(undefined);
  if(!cardRetired)retirePendingCard(memory);assistant.discardAgentTurn?.();
  if(openRef.current){openRef.current=false;run.actions.inputEnded(aiInput);}
  setOpen(false);
  if(restoreFocus&&focusInside)requestAnimationFrame(()=>{if(!openRef.current)button.current?.focus({preventScroll:true});});
 };
 const openNavis=useCallback(()=>{run.actions.dismissCoach();openRef.current=true;run.actions.inputStarted(aiInput);setOpen(true);
  // F17: warm the facts of widgets that were never opened (real-port domains), so the first question already reads the store's records.
  void assistant.preloadFacts?.();
  requestAnimationFrame(()=>pane.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus());},[run,assistant]);
 const focusCard=(featureId:FeatureId)=>requestAnimationFrame(()=>pane.current?.querySelector<HTMLButtonElement>(`[data-candidate-id="${featureId}"] .ai-candidate button`)?.focus());
 const candidateResult=(data:DragData,result:CommandResult|null)=>{
  if(!result){focusCard(data.featureId);return;}
  if(result.status==='accepted'){memory.placed.add(candidateKey(data));append({id:`placed-${++memory.nextMessageId}`,role:'assistant',text:t('dashboard.navis.placed',{name:name(data.featureId)})});onCreated(data.featureId);close(true);return;}
  if(result.status==='pending')return;
  if(result.code==='DUPLICATE'){
   const reason=result.existingPage!==undefined?t('page.alreadyOn',{n:result.existingPage+1}):t('navis.item.duplicate');
   append({id:`candidate-${++memory.nextMessageId}`,role:'assistant',text:'',result:{status:'unchanged',items:[{spec:{featureId:data.featureId,width:1,height:1,condition:data.condition??{kind:'default'}},status:'duplicate',reason}]}});
  }else append({id:`candidate-${++memory.nextMessageId}`,role:'assistant',text:result.code==='NO_CAPACITY'?t('navis.item.noCapacity'):t('dashboard.drop.blocked')});
  focusCard(data.featureId);
 };
 const resultRef=useRef(candidateResult);resultRef.current=candidateResult;const closeRef=useRef(close);closeRef.current=close;
 // D-369: a press or click anywhere outside the chat closes it. The chat is the pane and the launcher (both live in the dock); the notice toast
 // is left alone. While the chat is hidden for a widget it opened (C-04) nothing closes it. History and draft stay (the conversation memory is kept),
 // and focus stays where the press put it, so the close does not restore focus to the launcher.
 useEffect(()=>{
  if(!open||hiddenHandoff)return;
  const outside=(target:EventTarget|null)=>pressIsOutsideChat(dock,target);
  const pressed=(event:PointerEvent)=>{if(outside(event.target))closeRef.current(false);};
  // A mouse, touch or pen click is handled by its press (a text selection that ends outside is not an outside press); a keyboard or scripted click has detail 0.
  const clicked=(event:MouseEvent)=>{if(event.detail===0&&outside(event.target))closeRef.current(false);};
  document.addEventListener('pointerdown',pressed,true);
  document.addEventListener('click',clicked,true);
  return()=>{document.removeEventListener('pointerdown',pressed,true);document.removeEventListener('click',clicked,true);};
 },[open,hiddenHandoff,dock]);
 useImperativeHandle(ref,()=>({candidateResult:(data,result)=>resultRef.current(data,result),close:(restore)=>closeRef.current(restore)}),[]);
 const handoffRef=useRef<AbortController|null>(null);
 const restoreHandoff=useRef<HiddenHandoff|undefined>(undefined);
 useLayoutEffect(()=>{
  if(!hiddenHandoff||s.exitPendingToken||handoffStillOpen(hiddenHandoff.overlay,s.overlay))return;
  restoreHandoff.current=hiddenHandoff;
  // Reveal before restoring the saved scroll position and focus.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  setHiddenHandoff(undefined);
 },[hiddenHandoff,s.exitPendingToken,s.overlay]);
 useLayoutEffect(()=>{
  const prior=restoreHandoff.current;
  if(hiddenHandoff||!prior)return;
  restoreHandoff.current=undefined;
  const transcript=pane.current?.querySelector<HTMLElement>('.ai-conversation__body');
  if(transcript)transcript.scrollTop=prior.scrollTop;
  const opener=prior.opener;
  if(opener&&pane.current?.contains(opener))opener.focus({preventScroll:true});
  if(!opener||document.activeElement!==opener)pane.current?.querySelector('textarea')?.focus({preventScroll:true});
 },[hiddenHandoff]);
 const navisResult=(outcome:NavigationResult,command?:string,args?:Readonly<Record<string,unknown>>)=>{
  // B28: after a detail opens, name the widget (and row) that is showing and whether it is off the board.
  if(command==='ui.openDetail'&&(outcome==='opened'||outcome==='already')&&validateAgentDetailRef(args))return openedDetailText(run.getState(),args as DetailRef,store.getSnapshot(),korean);
  const featureId=command==='ui.show_panel'&&typeof args?.featureId==='string'?getRegistration(args.featureId)?.id:undefined;
  const placement=outcome==='opened'&&featureId?findPlacement(run.getState(),featureId):undefined;
  return placement?korean.t('navis.panelLocation',{name:name(placement.panel.featureId),page:placement.pageIndex+1,
   row:placement.panel.row+1,column:placement.panel.column+1}):t(`common.navis.nav.${outcome}`);
 };
 const hideForHandoff=(outcome:NavigationResult,opener:HTMLElement|null,scrollTop:number)=>{
  if(outcome!=='opened'&&outcome!=='already'||!openRef.current)return false;
  const overlay=run.getState().overlay;
  if(overlay.type!=='detail'&&overlay.type!=='closing'&&overlay.type!=='settings')return false;
  setHiddenHandoff({overlay,opener,scrollTop});
  if(outcome==='already')requestAnimationFrame(()=>{
   if(!openRef.current||run.getState().overlay!==overlay)return;
   const dialog=dock.parentElement?.matches(popupSelector)?dock.parentElement:null;
   dialog?.focus({preventScroll:true});
  });
  return true;
 };
 const activateHandoff=async(action:(signal:AbortSignal)=>Promise<NavigationResult>|NavigationResult,opener:HTMLElement)=>{
  handoffRef.current?.abort();
  const controller=new AbortController();
  handoffRef.current=controller;
  const scrollTop=pane.current?.querySelector('.ai-conversation__body')?.scrollTop??0;
  const outcome=await action(controller.signal);
  if(!controller.signal.aborted&&outcome!=='stale'&&!hideForHandoff(outcome,opener,scrollTop)){
   append({id:`route-${++memory.nextMessageId}`,role:'assistant',text:navisResult(outcome)});
  }
 };
 const openHandoff=(destination:AgentHandoff,opener:HTMLElement)=>{
  if(navigation)void activateHandoff(signal=>navigation.handoff(destination,signal),opener);
 };
 const openDetail=(destination:DetailRef,opener:HTMLElement)=>{
  if(navigation)void activateHandoff(signal=>navigation.execute('ui.openDetail',{...destination},signal),opener);
 };
 const asPlacedCandidate=(state:ReturnType<RunStore['getState']>,panel:NonNullable<ReturnType<typeof findPlacement>>['panel']):Candidate|undefined=>{
  if(!isCellSpan(panel.width)||!isCellSpan(panel.height))return;
  const condition=panel.condition??{kind:'default'};
  return {featureId:panel.featureId,condition,size:{width:panel.width,height:panel.height},
   preview:storeFactSource(store).view(panel.featureId,condition),reason:korean.t('navis.card.placed',{name:name(panel.featureId)}),
   placement:getRegistration(panel.featureId)?.layer===state.activeBoard?'current-layer':'other-layer'};
 };
 const submit=async(text=draft,retryMessageId?:string,continuation?:AgentContinuation,reproposing=false,pickedLabel?:string)=>{
  if(text.length>NAVIS_INPUT_LIMIT)return;
  if(!text.trim()){setInputError(true);return;}
  const placementOrder=hasPlacementIntent(text);
  const currentState=run.getState(),snapshot=store.getSnapshot();
  const reference=[...memory.messages].reverse().find(message=>message.reply?.panels.length===1)?.reply?.panels[0]?.featureId;
  const routeable=navigation&&!continuation&&!shouldBypassNavisNavigation(text);
  const classified=routeable?classifyNavigation(text,currentState,snapshot,reference):undefined;
  const plan=classified&&(classified.command==='ui.show_panel'||classified.command==='ui.open_drawer'
   ||!placementOrder&&!isNavisLayoutNavigationConflict(text))?classified:undefined;
  const form=routeable?routeMenuForm(text):undefined;
  const routeOpener=pane.current?.contains(document.activeElement)?document.activeElement as HTMLElement:null;
  const routeScrollTop=pane.current?.querySelector('.ai-conversation__body')?.scrollTop??0;
  if(retryMessageId){const old=memory.messages.find(message=>message.id===retryMessageId);if(!old||old.retryDismissed)return;patch(retryMessageId,{retryDismissed:true});}
  handoffRef.current?.abort();
  cancelRequest();
  const history=buildConversationHistory(memory.messages);
  const id=++requestId.current,runId=run.getState().runId,serial=++memory.nextMessageId,abort=new AbortController();
  const request:PendingReply={controller:abort,text,messageId:`assistant-${serial}`,started:false,waitingVisible:false,delayed:false};
  pending.current=request;lastRequest.current=text;memory.lastRequest=text;if(!reproposing)updateDraft('');
  if(!retryMessageId&&!continuation)append({id:`user-${serial}`,role:'user',text});
  // C-14 / M-16: the value the owner picked on a question's buttons stays in the transcript as the owner's own bubble.
  else if(!retryMessageId&&pickedLabel)append({id:`user-${serial}`,role:'user',text:pickedLabel});
  append({id:request.messageId,role:'assistant',text:'',requestText:text,delivery:'waiting'});setPhase('interpreting');
  const current=()=>pending.current===request&&id===requestId.current&&run.getState().runId===runId;
  request.showTimer=setTimeout(()=>{
   if(!current())return;
   request.waitingVisible=true;
   patch(request.messageId,{waitingVisible:true});
  },300);
  request.delayTimer=setTimeout(()=>{
   if(!current()||request.started)return;
   request.delayed=true;
   patch(request.messageId,{delayed:true});
  },10000);
  const {locale,activeBoard}=run.getState();
  try{
   if(plan?.unsupportedPeriod){
    pending.current=null;clearWaitingTimers(request);setPhase('idle');
    patch(request.messageId,{text:t('common.navis.agent.unsupportedPeriod'),delivery:undefined,delayed:false});
    return;
   }
   if(form||plan?.local){
    const outcome=form?await navigation!.handoff(form,abort.signal):await navigation!.execute(plan!.command,plan!.args,abort.signal);
    if(!current())return;
    pending.current=null;clearWaitingTimers(request);setPhase('idle');
    patch(request.messageId,{text:navisResult(outcome,plan?.command,plan?.args),delivery:undefined,delayed:false});
    if(form||plan?.command==='ui.openDetail')hideForHandoff(outcome,routeOpener,routeScrollTop);
    return;
   }
   let arrived:AgentNavigationAction|undefined;
   const prepared=plan&&navigation?prepareNavigationRequest(plan,currentState,navigation):undefined;
   const route=prepared?{agentTurn:prepared.agentTurn,onNavigation:(frame:AgentNavigationAction)=>{arrived=frame;}}:{};
   // B23: a later step of an ordered plan arrives as its own message once the owner's card for the step before has a receipt.
   const onFollowUp=(followUp:AssistantReply)=>{
    if(run.getState().runId!==runId||memory.runId!==runId)return;
    append({id:`assistant-${++memory.nextMessageId}`,role:'assistant',text:followUp.answer,requestText:text,reply:followUp});
   };
   const input={text,history,signal:abort.signal,continuation,locale,layer:activeBoard,...route,onFollowUp,onStatus:frame=>{
    if(current())patch(request.messageId,{waitingStatus:agentStatusLabel(frame)});
   },onFirstText:()=>{
    if(!current()||request.started)return;
    request.started=true;
    request.delayed=false;
    clearTimeout(request.delayTimer);
    patch(request.messageId,{delayed:false});
   }} satisfies AskInput;
   let reply=await assistant.ask(input);
   if(!current())return;
   if(reply.turn?.kind==='refusal'&&reply.turn.reason==='widget_only'&&!reply.answer.trim()){
    reply={...reply,answer:navisTranslator(reply.locale??locale).t('common.navis.agent.widgetOnly')};
   }
   if(prepared&&arrived&&navigation){
    const destination=prepared.resolve(arrived);
    const latest=run.getState();
    const unchanged=latest.layer===currentState.layer&&latest.overlay===currentState.overlay&&latest.edit.mode===currentState.edit.mode&&
     latest.boards[activeBoard].currentPage===currentState.boards[activeBoard].currentPage&&store.getSnapshot().revision===snapshot.revision;
    const valid=unchanged&&destination&&arrived.snapshotRevision===snapshot.revision;
    if(valid&&arrived.command==='ui.close_chat'){
     pending.current=null;clearWaitingTimers(request);setPhase('idle');
     patch(request.messageId,{text:t('dashboard.navis.closedReply'),delivery:undefined,delayed:false});
     await navigation.execute(arrived.command,destination,abort.signal);
     return;
    }
    const outcome=valid?await navigation.execute(arrived.command,destination,abort.signal):'stale';
    if(!current())return;
    reply={...reply,answer:navisResult(outcome,arrived.command,destination),panels:[]};
    if(arrived.command==='ui.openDetail')hideForHandoff(outcome,routeOpener,routeScrollTop);
   }
   if(placementOrder&&!reply.proposalSession&&!reply.panels.length&&!reply.turn){
    const state=run.getState(),wording=norm(text);
    const registered=getRegistry(state.screenPreset.id).find(widget=>wording.includes(norm(name(widget.id))));
    const feature=registered?.id??matchWidget(text),existing=feature&&findPlacement(state,feature);
    const candidate=existing&&asPlacedCandidate(state,existing.panel);
    if(candidate)reply={...reply,panels:[candidate]};
   }
   pending.current=null;clearWaitingTimers(request);setPhase('idle');
   const stopped=reply.status==='stopped';
   patch(request.messageId,{text:reply.answer,reply,delivery:stopped?'stopped':undefined,delayed:false});
  }catch{
   if(!current()||abort.signal.aborted)return;
   pending.current=null;clearWaitingTimers(request);setPhase('idle');
   const reply: AssistantReply={answer:copy.requestFailed,panels:[],turn:{kind:'refusal',reason:'request_failed'}};
   patch(request.messageId,{text:reply.answer,reply,delivery:undefined,delayed:false});
  }
 };
 useEffect(()=>()=>{
  handoffRef.current?.abort();
  const request=pending.current;
  if(request){pending.current=null;requestId.current++;clearWaitingTimers(request);request.controller.abort();memory.messages=memory.messages.filter(message=>message.id!==request.messageId);if(!memory.draft)memory.draft=request.text;}
  retirePendingCard(memory);
  assistant.discardAgentTurn?.();
  if(openRef.current){openRef.current=false;run.actions.inputEnded(aiInput);}
 },[run,memory,assistant]);
 const layer=useRef(s.layer);
 useLayoutEffect(()=>{
  const changedLayer=layer.current!==s.layer;
  layer.current=s.layer;
  if(!openRef.current)return;
  if(s.edit.mode==='edit')closeRef.current(true);
  else if(changedLayer&&retirePendingCard(memory))closeRef.current(true,true);
 },[s.layer,s.edit.mode,memory]);
 useEffect(()=>{if(openRef.current&&!s.pageHidden&&!s.activeInputs.some(input=>input.kind===aiInput.kind&&input.id===aiInput.id))run.actions.inputStarted(aiInput);},[s.pageHidden,s.activeInputs,run]);
 const placedOf=(candidate:Candidate)=>{const placed=findPlacement(s,candidate.featureId);if(!placed||placed.layer!==s.activeBoard)return null;return {pageIndex:placed.pageIndex,onViewedPage:placed.pageIndex===s.boards[s.activeBoard].currentPage};};
 const viewOnBoard=(featureId:FeatureId)=>{close(true);onShowPanel(featureId);};
 const renderCandidate=(candidate:Candidate)=>{
  // Other-layer cards are read-only (no drag, no tap); placed ones show where and offer 'Show on dashboard'.
  if(candidate.placement==='other-layer'||s.layer==='orders-payment'||s.edit.mode==='edit'||s.overlay.type!=='none'&&s.overlay.type!=='drawer')return <CandidateCard candidate={candidate}/>;
  const placed=placedOf(candidate);
  if(placed)return <div data-candidate-id={candidate.featureId}><CandidateCard candidate={candidate} placed={placed} onViewOnBoard={()=>viewOnBoard(candidate.featureId)}/>{memory.placed.has(candidateKey(candidate))?<span className="dashboard-candidate-added">{t('navis.card.added')}</span>:null}</div>;
  return <CandidateChoice candidate={candidate} controller={controller} readRect={readRect}/>;
 };
 const surfaceVisible=!dragging&&!hiddenHandoff;
 const contents=<>
  {visible&&!hiddenHandoff&&s.edit.mode!=='edit'&&!(modal&&!open)?<button id={open?undefined:NAVIS_RETURN_FOCUS} ref={button} type="button" className="dashboard-ai-launcher" data-layer={s.layer} aria-label={t(open?'dashboard.navis.close':'dashboard.navis.open')} aria-controls="dashboard-navis" aria-expanded={open} onClick={()=>open?close(true):openNavis()}><img src={navisSymbol} alt=""/></button>:null}
  {open&&visible?<motion.div id="dashboard-navis" ref={pane} className="dashboard-ai" data-drag-hidden={dragging} data-handoff-hidden={!!hiddenHandoff} aria-hidden={!surfaceVisible||undefined} inert={!surfaceVisible||undefined} initial={{opacity:0,x:reducedMotion?0:motionTokens.translateDrawer}} animate={{opacity:1,x:0}} transition={transitionFor('drawerIn',reducedMotion)}>
   <div id={NAVIS_RETURN_FOCUS} className="dashboard-navis-focus" tabIndex={-1} onFocus={event=>{if(event.target===event.currentTarget)pane.current?.querySelector('textarea')?.focus({preventScroll:true});}}/>
   <AiConversation draft={draft} onDraftChange={updateDraft} messages={messages} phase={phase} inputError={inputError} onSubmit={()=>void submit()} onCancel={cancelRequest} onClose={()=>close(true)} onRetry={(text,messageId)=>void submit(text??lastRequest.current,messageId)} featureName={name} onShowPanel={viewOnBoard} renderCandidate={renderCandidate} placedOf={placedOf} onViewCandidateOnBoard={candidate=>viewOnBoard(candidate.featureId)}
    prompts={prompts} surfaceVisible={surfaceVisible} onOpenEvidence={navigation?openDetail:undefined} receiptContext={{ run, store }}
    renderAgentReply={(reply,message)=>{
     const destination=reply.turn?.kind==='handoff'?reply.turn.destination:reply.turn?.kind==='refusal'?reply.turn.alternative:undefined;
     const label=destination&&navigation?destinationOpenLabel(destination,translator):undefined;
     if(destination?.step==='test-sms'&&label)return <TestSmsHandoffCard openLabel={label} onOpen={opener=>openHandoff(destination,opener)}/>;
     const onContinue=(answer:AgentContinuation)=>{if(message.requestText)void submit(message.requestText,undefined,answer,false,continuationLabel(reply,answer));};
     return <>
      <AgentReplyControls reply={reply} run={run} receiptVisible={surfaceVisible} onNotice={run.actions.showNotice} onContinue={onContinue}
       onOpenDetail={navigation?openDetail:undefined}
       onRepropose={message.requestText&&!message.retryDismissed?()=>void submit(reproposalText(message.requestText!,reply.proposalSession),message.id,undefined,true):undefined}/>
      {destination&&label?<ActionButton variant="outline" onClick={event=>openHandoff(destination,event.currentTarget)}>{label}<ChatGlyph name="open"/></ActionButton>:null}
     </>;
    }}/>
  </motion.div>:null}
 </>;
 return portalContainer?createPortal(contents,dock):contents;
}
export const highlightMs=timePolicy.existingHighlightMs;
