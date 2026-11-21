import navisSymbol from '../../assets/brand/navis-symbol.svg';
import {useCallback,useEffect,useId,useImperativeHandle,useLayoutEffect,useMemo,useRef,useState,type Ref} from 'react';
import {createPortal} from 'react-dom';
import {motion} from 'motion/react';
import {useDraggable} from '@dnd-kit/core';
import type {CommandResult,FeatureId,RunStore} from '../../contracts';
import {findPlacement} from '../../state';
import {isNavisLayoutNavigationConflict} from '../../features/assistant/domains/layout';
import {navisTranslator} from '../../features/assistant/messages';
import {motionTokens,timePolicy,transitionFor,useUi} from '../../ui';
import {agentStatusLabel,AiConversation,CandidateCard,createAssistantProvider,type AgentContinuation,type Candidate,type ConversationMessage} from '../../features/assistant';
import {AgentReplyControls} from '../../features/assistant/proposal-card';
import {useWidgetDataStore} from '../../data/react';
import {ActionButton} from '../../ui';
import type {AgentNavigationAction} from '../../../shared/navis-agent-schema.mjs';
import type {AgentHandoff,AskInput} from '../../features/assistant/types';
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
/** `buffer` holds the streamed text off screen until the provider resolves the whole reply (C-1); only the failure fallback reads it. */
interface PendingReply {controller:AbortController;text:string;messageId:string;started:boolean;buffer:string;delayTimer?:ReturnType<typeof setTimeout>}
const conversations=new WeakMap<RunStore,ConversationMemory>();
const aiInput={kind:'keyboard',id:'ai-conversation-active'} as const;
const candidateKey=(data:Pick<DragData,'featureId'|'condition'|'size'>)=>JSON.stringify([data.featureId,data.condition,data.size]);
export interface NavisHandle {readonly candidateResult:(data:DragData,result:CommandResult|null)=>void;readonly close:(restoreFocus?:boolean)=>void}
function CandidateChoice({candidate,controller,readRect}:{readonly candidate:Candidate;readonly controller:DashboardController;readonly readRect:(el:HTMLElement|null)=>Rect}){
 const data:DragData={source:'candidate',featureId:candidate.featureId,size:candidate.size,condition:candidate.condition};
 const id=useId();const {listeners,attributes,setNodeRef}=useDraggable({id:`candidate-${id}`,data});
 return <div ref={setNodeRef} data-candidate-id={candidate.featureId} {...listeners} {...attributes} role={undefined} tabIndex={undefined}><CandidateCard candidate={candidate} onSelect={()=>controller.tap(data,{x:0,y:0},readRect(null))}/></div>;
}
export interface DashboardNavisProps {readonly run:RunStore;readonly controller:DashboardController;readonly readRect:(el:HTMLElement|null)=>Rect;readonly dragging:boolean;readonly visible:boolean;readonly onShowPanel:(featureId:FeatureId)=>void;readonly onCreated:(featureId:FeatureId)=>void;readonly navigation?:NavisNavigation;readonly ref?:Ref<NavisHandle>}
/** Navis on both dashboard layers (SCR-34): launcher, conversation and candidate cards in the chosen language. */
export function DashboardNavis({run,controller,readRect,dragging,visible,onShowPanel,onCreated,navigation,ref}:DashboardNavisProps){
 const s=useRun(run),{reducedMotion,portalContainer}=useUi(),{t,name}=useDashboardT();
 const memory=useMemo(()=>{const previous=conversations.get(run);if(previous?.runId===s.runId)return previous;const next:ConversationMemory={runId:s.runId,draft:'',messages:[],lastRequest:'',nextMessageId:0,placed:new Set()};conversations.set(run,next);return next;},[run,s.runId]);
 // The run's data store: snapshot facts and simple-mode answers read the same values as the panels.
 const store=useWidgetDataStore();const assistant=useMemo(()=>createAssistantProvider({store,run}),[store,run]);
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(memory.draft),[messages,setMessages]=useState<ConversationMessage[]>(memory.messages),[phase,setPhase]=useState<'idle'|'interpreting'|'placing'>('idle'),[inputError,setInputError]=useState(false);
 const [dock]=useState(()=>{const node=document.createElement('div');node.className='dashboard-navis-dock';return node;});
 // Keep the moving dock inside a stationary wrapper outside modals. The dialog
 // can hide that wrapper from assistive tech without hiding the dock it adopts.
 const [standby]=useState(()=>{const node=document.createElement('div');node.className='dashboard-navis-standby';return node;});
 const installDock=useCallback(()=>{
  if(!portalContainer)return;
  const popup=Array.from(portalContainer.querySelectorAll<HTMLElement>('.ui-dialog[role="dialog"],.ui-dialog[role="alertdialog"]'))
   .reverse().find(node=>!node.hidden&&!node.inert&&!node.closest('[data-ending-style],.ui-overlay-exit'));
  const host=popup??standby;
  if(dock.parentElement!==host){
   const focused=dock.contains(document.activeElement)?document.activeElement as HTMLElement:null;
   host.append(dock);
   if(focused?.isConnected)focused.focus({preventScroll:true});
  }
  const chat=dock.querySelector<HTMLElement>('.dashboard-ai');
  dock.toggleAttribute('data-side-by-side',Boolean(popup&&chat&&popup.clientWidth>chat.offsetWidth*3));
  // K-E 17: in a detail window the launcher parks in the header row, left of the window's own controls, so it never covers a footer action or a row action in the bottom-right corner.
  // Offsets come from the layout boxes (offsetLeft/offsetTop), not from getBoundingClientRect, so the open animation's scale cannot skew them; dashboard.css turns them into `right` and `top`.
  const actions=popup?.querySelector('.detail-body-slot')?popup.querySelector<HTMLElement>('.ui-overlay-header .ui-overlay-actions'):null;
  if(popup&&actions){
   let left=0,top=0,node:HTMLElement|null=actions;
   while(node&&node!==popup){left+=node.offsetLeft;top+=node.offsetTop;node=node.offsetParent as HTMLElement|null;}
   const size=dock.querySelector<HTMLElement>('.dashboard-ai-launcher')?.offsetHeight??0;
   dock.dataset.headerDock='true';
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
 const cancelRequest=()=>{const request=pending.current;if(!request)return;pending.current=null;requestId.current++;clearTimeout(request.delayTimer);request.controller.abort();setPhase('idle');patch(request.messageId,{delivery:'stopped',delayed:false});if(!memory.draft)updateDraft(request.text);};
 const close=(restoreFocus=false)=>{const focusInside=pane.current?.contains(document.activeElement);handoffRef.current?.abort();cancelRequest();assistant.discardAgentTurn?.();if(openRef.current){openRef.current=false;run.actions.inputEnded(aiInput);}setOpen(false);if(restoreFocus&&focusInside)requestAnimationFrame(()=>button.current?.focus());};
 const openNavis=useCallback(()=>{run.actions.dismissCoach();openRef.current=true;run.actions.inputStarted(aiInput);setOpen(true);requestAnimationFrame(()=>pane.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus());},[run]);
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
 useImperativeHandle(ref,()=>({candidateResult:(data,result)=>resultRef.current(data,result),close:(restore)=>closeRef.current(restore)}),[]);
 const handoffRef=useRef<AbortController|null>(null);
 const navisResult=(outcome:NavigationResult)=>t(`common.navis.nav.${outcome}`);
 const openHandoff=async(destination:AgentHandoff)=>{
  if(!navigation)return;
  handoffRef.current?.abort();
  const controller=new AbortController();
  handoffRef.current=controller;
  const outcome=await navigation.handoff(destination,controller.signal);
  if(!controller.signal.aborted&&outcome!=='stale')append({id:`route-${++memory.nextMessageId}`,role:'assistant',text:navisResult(outcome)});
 };
 const submit=async(text=draft,retryMessageId?:string,continuation?:AgentContinuation)=>{
  if(!text.trim()){setInputError(true);return;}
  const placementOrder=hasPlacementIntent(text);
  const currentState=run.getState(),snapshot=store.getSnapshot();
  const reference=[...memory.messages].reverse().find(message=>message.reply?.panels.length===1)?.reply?.panels[0]?.featureId;
  const plan=navigation&&!placementOrder&&!continuation&&!isNavisLayoutNavigationConflict(text)?classifyNavigation(text,currentState,snapshot,reference):undefined;
  const form=navigation&&!continuation?routeMenuForm(text):undefined;
  if(retryMessageId){const old=memory.messages.find(message=>message.id===retryMessageId);if(!old||old.retryDismissed)return;patch(retryMessageId,{retryDismissed:true});}
  cancelRequest();
  const history=buildConversationHistory(memory.messages);
  const id=++requestId.current,runId=run.getState().runId,serial=++memory.nextMessageId,abort=new AbortController();
  const request:PendingReply={controller:abort,text,messageId:`assistant-${serial}`,started:false,buffer:''};
  pending.current=request;lastRequest.current=text;memory.lastRequest=text;updateDraft('');
  if(!retryMessageId&&!continuation)append({id:`user-${serial}`,role:'user',text});
  append({id:request.messageId,role:'assistant',text:'',requestText:text,delivery:'waiting'});setPhase('interpreting');
  const current=()=>pending.current===request&&id===requestId.current&&run.getState().runId===runId;
  request.delayTimer=setTimeout(()=>{if(current()&&!request.started)patch(request.messageId,{delayed:true});},10000);
  const {locale,activeBoard}=run.getState();
  try{
   if(plan?.unsupportedPeriod){
    pending.current=null;clearTimeout(request.delayTimer);setPhase('idle');
    patch(request.messageId,{text:t('common.navis.agent.unsupportedPeriod'),delivery:undefined,delayed:false});
    return;
   }
   if(form||plan?.local){
    const outcome=form?await navigation!.handoff(form,abort.signal):await navigation!.execute(plan!.command,plan!.args,abort.signal);
    if(!current())return;
    pending.current=null;clearTimeout(request.delayTimer);setPhase('idle');
    patch(request.messageId,{text:navisResult(outcome),delivery:undefined,delayed:false});
    return;
   }
   let arrived:AgentNavigationAction|undefined;
   const prepared=plan&&navigation?prepareNavigationRequest(plan,currentState,navigation):undefined;
   const route=prepared?{agentTurn:prepared.agentTurn,onNavigation:(frame:AgentNavigationAction)=>{arrived=frame;}}:{};
   const input={text,history,signal:abort.signal,continuation,locale,layer:activeBoard,...route,onStatus:frame=>{
    if(current()&&!request.started)patch(request.messageId,{waitingStatus:agentStatusLabel(frame,locale)});
   },onTextDelta:delta=>{
    if(!current())return;
    // Streamed words never reach the screen: they wait here until the reply (answer + cards) resolves and both are shown in one render.
    request.buffer+=delta;
    if(request.started||!request.buffer.trim())return;
    // The first real text ends the delay timer and changes the waiting line to "답을 정리하고 있어요".
    request.started=true;clearTimeout(request.delayTimer);
    patch(request.messageId,{delivery:'streaming',delayed:false});
   }} satisfies AskInput;
   let reply=await assistant.ask(input);
   if(!current())return;
   if(prepared&&arrived&&navigation){
    const destination=prepared.resolve(arrived);
    const latest=run.getState();
    const unchanged=latest.layer===currentState.layer&&latest.overlay===currentState.overlay&&latest.edit.mode===currentState.edit.mode&&
     latest.boards[activeBoard].currentPage===currentState.boards[activeBoard].currentPage&&store.getSnapshot().revision===snapshot.revision;
    const valid=unchanged&&destination&&arrived.snapshotRevision===snapshot.revision;
    if(valid&&arrived.command==='ui.close_chat'){
     pending.current=null;clearTimeout(request.delayTimer);setPhase('idle');
     patch(request.messageId,{text:t('dashboard.navis.close'),delivery:undefined,delayed:false});
     await navigation.execute(arrived.command,destination,abort.signal);
     return;
    }
    const outcome=valid?await navigation.execute(arrived.command,destination,abort.signal):'stale';
    if(!current())return;
    reply={...reply,answer:navisResult(outcome),panels:[]};
   }
   pending.current=null;clearTimeout(request.delayTimer);setPhase('idle');
   const stopped=reply.status==='stopped';
   patch(request.messageId,{text:reply.answer,reply,delivery:stopped?'stopped':undefined,delayed:false});
  }catch{
   if(!current()||abort.signal.aborted)return;
   pending.current=null;clearTimeout(request.delayTimer);setPhase('idle');
   const placementResults=placementOrder?[navisTranslator(locale).t('common.navis.noData')]:undefined;
   // The request failed after some text arrived: keep today's fallback and show that text now (a placement order never shows model text).
   patch(request.messageId,{text:placementOrder?'':request.buffer,placementResults,delivery:undefined,delayed:false});
  }
 };
 useEffect(()=>()=>{
  handoffRef.current?.abort();
  const request=pending.current;
  if(request){pending.current=null;requestId.current++;clearTimeout(request.delayTimer);request.controller.abort();memory.messages=memory.messages.map(message=>message.id===request.messageId?{...message,delivery:'stopped',delayed:false}:message);if(!memory.draft)memory.draft=request.text;}
  assistant.discardAgentTurn?.();
  if(openRef.current){openRef.current=false;run.actions.inputEnded(aiInput);}
 },[run,memory,assistant]);
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
 const contents=<>
  {visible?<button id={open?undefined:NAVIS_RETURN_FOCUS} ref={button} type="button" className="dashboard-ai-launcher" aria-label={open?t('dashboard.navis.close'):t('dashboard.navis.open')} aria-controls="dashboard-navis" aria-expanded={open} onClick={()=>open?close(true):openNavis()}><img src={navisSymbol} alt=""/></button>:null}
  {open&&visible?<motion.div id="dashboard-navis" ref={pane} className="dashboard-ai" data-drag-hidden={dragging} aria-hidden={dragging||undefined} inert={dragging||undefined} initial={{opacity:0,x:reducedMotion?0:motionTokens.translateDrawer}} animate={{opacity:1,x:0}} transition={transitionFor('drawerIn',reducedMotion)}>
   <div id={NAVIS_RETURN_FOCUS} className="dashboard-navis-focus" tabIndex={-1} onFocus={event=>{if(event.target===event.currentTarget)pane.current?.querySelector('textarea')?.focus({preventScroll:true});}}/>
   <AiConversation draft={draft} onDraftChange={updateDraft} messages={messages} phase={phase} inputError={inputError} onSubmit={()=>void submit()} onCancel={cancelRequest} onClose={()=>close(true)} onRetry={(text,messageId)=>void submit(text??lastRequest.current,messageId)} featureName={name} onShowPanel={viewOnBoard} renderCandidate={renderCandidate} placedOf={placedOf} onViewCandidateOnBoard={candidate=>viewOnBoard(candidate.featureId)}
    renderAgentReply={(reply,message)=>{
     const destination=reply.turn?.kind==='handoff'?reply.turn.destination:reply.turn?.kind==='refusal'?reply.turn.alternative:undefined;
     return <><AgentReplyControls reply={reply} onNotice={run.actions.showNotice} onContinue={answer=>{if(message.requestText)void submit(message.requestText,undefined,answer);}}/>
      {navigation&&destination?<ActionButton variant="outline" onClick={()=>void openHandoff(destination)}>{t('common.navis.nav.continue')}</ActionButton>:null}</>;
    }}/>
  </motion.div>:null}
 </>;
 return portalContainer?createPortal(contents,dock):contents;
}
export const highlightMs=timePolicy.existingHighlightMs;
