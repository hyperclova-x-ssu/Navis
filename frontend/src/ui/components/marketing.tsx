import { koreanScreenText } from '../../i18n';
import { useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Checkbox } from '@base-ui/react/checkbox';
import { motion } from 'motion/react';
import { useKitT } from '../kit-i18n';
import { UiContext } from '../context';
import { usePanelChrome } from '../panel-chrome';
import { ActionButton } from './controls';
import { StatusBadge } from './badges';
import { Textarea, copyText } from './forms';
import { DetailFooterContent } from './overlays';
import { TimeField } from './time-field';
import { Icon } from '../icons';
import { motionTokens, pageTokens } from '../motion';

const useReduced=()=>useContext(UiContext)?.reducedMotion??false;
const stop={onPointerDown:(e:{stopPropagation():void})=>e.stopPropagation(),onPointerUp:(e:{stopPropagation():void})=>e.stopPropagation(),onKeyDown:(e:{stopPropagation():void})=>e.stopPropagation()};

/**
 * DS 11.9.1 PanelAction: the one button a plan-2 panel may hold. Secondary, 44 high, accessible name '{label}, {widget}'.
 * Presses and pointer events never reach the panel (no detail opening, no long press). While editing or waiting it is hidden
 * but keeps its slot so nothing reflows. A state action (retry, view coupons) is simply another label and handler.
 */
export function PanelAction({id,label,widgetName,onPress,hidden:hiddenProp,className=''}:{/** Set on the button, for focus return. */readonly id?:string;readonly label:string;readonly widgetName:string;readonly onPress:()=>void;/** editing or waiting: invisible, not focusable, slot kept */readonly hidden?:boolean;readonly className?:string}){
  const {t}=useKitT();const chrome=usePanelChrome();const hidden=hiddenProp??(chrome.editing||chrome.waiting);
  return <div className={`ui-panel-action-slot ${className}`} data-hidden={hidden?'true':undefined} aria-hidden={hidden||undefined} inert={hidden||undefined}>
    <ActionButton id={id} variant="secondary" className="ui-panel-action" aria-label={t('ui.panelAction.name',{label,widget:widgetName})} {...stop} onPointerCancel={e=>e.stopPropagation()} onClick={event=>{event.stopPropagation();onPress();}}><span className="ui-panel-action__label">{label}</span></ActionButton>
  </div>;
}

export interface DiscountSliderProps { readonly value:number;readonly onChange:(value:number)=>void;/** The loss limit (e.g. 65). The thumb cannot pass it. */readonly max:number;readonly recommended?:number;/** Already-formatted 'you keep per item' money for the accessible value text. */readonly profitText:string;readonly label?:string;readonly disabled?:boolean }
const clampInt=(v:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,Math.round(v)));
/** DS 11.9.4 DiscountSlider: integer percent, never above the limit, recommended marker, hatched loss zone, keys and [-][+]. */
export function DiscountSlider({value,onChange,max,recommended,profitText,label,disabled=false}:DiscountSliderProps){
  const {t}=useKitT();const track=useRef<HTMLDivElement>(null);const dragging=useRef(false);const id=useId();
  const set=(next:number)=>{const v=clampInt(next,0,max);if(v!==value)onChange(v);};
  const fromPointer=(event:ReactPointerEvent)=>{const rect=track.current?.getBoundingClientRect();if(!rect||rect.width<=0)return;set((event.clientX-rect.left)/rect.width*100);};
  const onKey=(event:KeyboardEvent)=>{
    const step=event.key==='ArrowLeft'||event.key==='ArrowDown'?-1:event.key==='ArrowRight'||event.key==='ArrowUp'?1:event.key==='PageDown'?-10:event.key==='PageUp'?10:0;
    if(step){event.preventDefault();set(value+step);}else if(event.key==='Home'){event.preventDefault();set(0);}else if(event.key==='End'){event.preventDefault();set(max);}
  };
  const name=label??t('marketing.discountRate');
  return <div className="ui-discount" data-disabled={disabled?'true':undefined}>
    <div className="ui-discount__row">
      <ActionButton variant="outline" size="icon" aria-label={t('ui.discount.decrease')} disabled={disabled||value<=0} onClick={()=>set(value-1)}><Icon name="remove"/></ActionButton>
      <div className="ui-discount__track-area">
        <div ref={track} className="ui-discount__track" onPointerDown={event=>{if(disabled)return;dragging.current=true;event.currentTarget.setPointerCapture?.(event.pointerId);fromPointer(event);}} onPointerMove={event=>{if(dragging.current)fromPointer(event);}} onPointerUp={()=>{dragging.current=false;}} onPointerCancel={()=>{dragging.current=false;}}>
          <span className="ui-discount__fill" style={{width:`${value}%`}}/>
          <span className="ui-discount__loss" style={{left:`${max}%`}} aria-hidden="true"/>
          {recommended!==undefined?<span className="ui-discount__marker" style={{left:`${recommended}%`}} aria-hidden="true"/>:null}
          <div role="slider" tabIndex={disabled?-1:0} aria-label={name} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={t('ui.discount.name',{p:value,profit:profitText,max})} aria-disabled={disabled||undefined} aria-describedby={`${id}-limit`} className="ui-discount__thumb" style={{left:`${value}%`}} onKeyDown={onKey}/>
        </div>
        <div className="ui-discount__captions"><span className="ui-discount__recommended">{recommended!==undefined?t('ui.discount.recommended',{p:recommended}):null}</span><span id={`${id}-limit`} className="ui-discount__limit" style={{left:`${max}%`}}>{t('ui.discount.limitText')}</span></div>
      </div>
      <ActionButton variant="outline" size="icon" aria-label={t('ui.discount.increase')} disabled={disabled||value>=max} onClick={()=>set(value+1)}><Icon name="plus"/></ActionButton>
      <label className="ui-discount__value"><input className="ui-text-input" type="number" inputMode="numeric" min={0} max={max} value={value} disabled={disabled} aria-label={name} onChange={event=>{const n=Number(event.currentTarget.value);if(Number.isFinite(n))set(n);}}/><span>%</span></label>
    </div>
  </div>;
}
/** Sentences under the slider, replaced in the same frame as the value (no count-up). */
export function DiscountSummary({price,profit,total,lossCost,fixedSet=false}:{readonly price:string;readonly profit:string;readonly total:string;readonly lossCost?:string;readonly fixedSet?:boolean}){
  const {t,locale}=useKitT();
  const summary=t('ui.discount.summary',{price,profit,total});
  return <div className="ui-discount-summary"><p>{locale==='ko'?koreanScreenText(summary):summary}</p>{lossCost?<p className="ui-discount-summary__loss">{t('ui.discount.loss',{amount:lossCost})}</p>:null}{fixedSet?<p className="ui-discount-summary__fixed">{t('ui.discount.setFixed')}</p>:null}</div>;
}

export interface BenefitOption { readonly value:string;readonly name:string;/** 'you keep ...' line */readonly detail:string;readonly recommended?:boolean;/** '200원 더 남아요' */readonly diff?:string }
/** DS 11.9.4 BenefitCard group: radio cards at least 72 high with a recommended badge; the whole card is the hit area. */
export function BenefitCards({value,onChange,options,label}:{readonly value:string;readonly onChange:(value:string)=>void;readonly options:readonly BenefitOption[];readonly label?:string}){
  const {t}=useKitT();const refs=useRef<(HTMLButtonElement|null)[]>([]);const active=Math.max(0,options.findIndex(o=>o.value===value));
  const go=(from:number,step:1|-1)=>{const next=(from+step+options.length)%options.length;onChange(options[next]!.value);refs.current[next]?.focus();};
  return <div role="radiogroup" aria-label={label??t('ui.benefit.group')} className="ui-benefit-cards">{options.map((option,index)=>
    <button key={option.value} ref={node=>{refs.current[index]=node;}} type="button" role="radio" aria-checked={option.value===value} tabIndex={index===active?0:-1} className="ui-benefit-card" onClick={()=>onChange(option.value)}
      onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowRight'){event.preventDefault();go(index,1);}else if(event.key==='ArrowUp'||event.key==='ArrowLeft'){event.preventDefault();go(index,-1);}}}>
      <span className="ui-benefit-card__head"><span className="ui-benefit-card__name">{option.name}</span>{option.recommended?<StatusBadge kind="recommended"/>:null}</span>
      <span className="ui-benefit-card__detail">{option.detail}</span>{option.diff?<span className="ui-benefit-card__diff">{option.diff}</span>:null}
    </button>)}</div>;
}
export const BenefitCard=BenefitCards;

/** Masks a name for display: the first character stays, the rest become circles ('김○○'). */
export function maskName(name:string):string{if(/[○*]/u.test(name))return name;const chars=Array.from(name.trim());return chars.length<=1?name:`${chars[0]}${'○'.repeat(Math.min(chars.length-1,3))}`;}
export interface Recipient { readonly id:string;readonly name:string;/** day, time and visit count line */readonly meta?:string;readonly consent:boolean }
/** DS 11.9.4 RecipientList: check rows (min 64, hit 48), masked names, no-consent rows disabled with a sentence and an icon. */
export function RecipientList({recipients,selected=[],onChange,onEmptyChange,label,consentLabels}:{readonly recipients:readonly Recipient[];readonly selected?:readonly string[];readonly onChange?:(ids:readonly string[])=>void;readonly onEmptyChange?:(empty:boolean)=>void;readonly label?:string;readonly consentLabels?:{readonly yes:string;readonly no:string}}){
  const {t,locale}=useKitT();
  const valid=new Set(recipients.filter(r=>r.consent).map(r=>r.id));
  const chosen=selected.filter(id=>valid.has(id));
  useEffect(()=>{onEmptyChange?.(chosen.length===0);},[chosen.length,onEmptyChange]);
  const toggle=(id:string,on:boolean)=>onChange?.(on?[...new Set([...chosen,id])]:chosen.filter(x=>x!==id));
  return <div className="ui-recipient-list">
    {recipients.length===0?<p className="ui-recipient-list__empty">{t('marketing.noRecipients')}</p>:null}
    <ul aria-label={label??t('ui.recipient.listLabel')}>{recipients.map(r=>{const id=`rcp-${r.id}`;return <li key={r.id} className="ui-recipient-row" data-row-id={r.id} data-consent={String(r.consent)}>
      {onChange && <Checkbox.Root checked={r.consent&&chosen.includes(r.id)} disabled={!r.consent} aria-labelledby={`${id}-name`} aria-describedby={r.consent?undefined:`${id}-reason`} onCheckedChange={on=>toggle(r.id,on)} className="ui-checklist-row__box"><Checkbox.Indicator className="ui-checklist-row__tick"><Icon name="check"/></Checkbox.Indicator></Checkbox.Root>}
      <span className="ui-recipient-row__text"><span id={`${id}-name`} className="ui-recipient-row__name">{maskName(r.name)}</span>{r.meta?<span className="ui-recipient-row__meta">{locale==='ko'?koreanScreenText(r.meta):r.meta}</span>:null}{!r.consent&&!consentLabels&&<span id={`${id}-reason`} className="ui-recipient-row__reason"><Icon name="no-entry"/>{t('marketing.noConsent')}</span>}</span>
      {r.consent?<StatusBadge semantic="done" label={consentLabels?.yes??t('ui.recipient.sendable')}/>:consentLabels?<span id={`${id}-reason`}><StatusBadge semantic="warning" label={consentLabels.no}/></span>:null}</li>;})}</ul></div>;
}

/** DS 11.9.4 SmsPreview: '(광고)' first line and the opt-out last line cannot be removed or edited; only the body is a Textarea. */
export function SmsPreview({body,onBodyChange,recipientCount,error}:{readonly body:string;readonly onBodyChange:(body:string)=>void;readonly recipientCount:number;readonly error?:string}){
  const {t,locale}=useKitT();
  return <div className="ui-sms-preview" role="group" aria-label={t('marketing.messagePreview')}>
    <p className="ui-sms-preview__fixed ui-sms-preview__ad" data-fixed="ad"><strong>{t('marketing.adMark')}</strong><span className="ui-sr-only"> {t('ui.sms.fixedPart')}</span></p>
    <Textarea label={t('ui.sms.bodyLabel')} value={body} onValueChange={onBodyChange} rows={3} error={error} className="ui-sms-preview__body"/>
    <p className="ui-sms-preview__fixed ui-sms-preview__optout" data-fixed="optout"><strong>{t('marketing.optOut')}</strong><span className="ui-sr-only"> {t('ui.sms.fixedPart')}. {t('ui.sms.autoFooter')}</span></p>
    <p className="ui-sms-preview__line">{locale==='ko'?koreanScreenText(t('ui.sms.line',{n:recipientCount})):t('ui.sms.line',{n:recipientCount})}</p></div>;
}

/**
 * DS 11.9.4a SendTimePicker: now / schedule radios and a time. Any time of day is allowed (no night restriction, owner decision 2026-11-20).
 * The time is the kit TimeField (DS 11.4: a 48 high button that opens a list of times every 30 minutes, Enter picks); an off-grid value is still listed.
 * `time` is `HH:MM`, or '' while nothing is chosen.
 */
export function SendTimePicker({mode,onModeChange,time,onTimeChange}:{readonly mode:'now'|'schedule';readonly onModeChange:(mode:'now'|'schedule')=>void;readonly time:string;readonly onTimeChange:(time:string)=>void}){
  const {t}=useKitT();
  return <fieldset className="ui-send-time"><legend>{t('ui.send.time')}</legend>
    <div role="radiogroup" aria-label={t('ui.send.time')} className="ui-segmented">
      {(['now','schedule'] as const).map(m=><button key={m} type="button" role="radio" aria-checked={mode===m} tabIndex={mode===m?0:-1} className="ui-choice-chip" onClick={()=>onModeChange(m)}>{m==='now'?t('ui.send.now'):t('ui.send.schedule')}</button>)}
    </div>
    {mode==='schedule'?<div className="ui-send-time__input"><TimeField label={t('ui.send.timeInput')} value={time||null} onValueChange={next=>onTimeChange(next??'')}/></div>:null}
  </fieldset>;
}

/** DS 11.9.4 ConfirmStep: question title (focused on open), three summary lines, [보내기] disabled at once on press, no undo after sending. */
export function ConfirmStep({count,summary,onSend,onCancel,cancelLabel,phase='ask',sendDisabled=false,footerActions=false}:{readonly count:number;readonly summary:readonly {readonly label:string;readonly value:string}[];readonly onSend:()=>void;readonly onCancel:()=>void;readonly cancelLabel?:string;readonly phase?:'ask'|'sending'|'sent';readonly sendDisabled?:boolean;readonly footerActions?:boolean}){
  const {t}=useKitT();const title=useRef<HTMLHeadingElement>(null);const [locked,setLocked]=useState(false);
  useEffect(()=>{title.current?.focus();},[]);
  const busy=locked||phase!=='ask';
  const actions = <>
    {phase==='sending'?<p className="ui-confirm-step__status" role="status">{t('ui.confirm.sending')}</p>:null}
    {phase==='sent'?<p className="ui-confirm-step__status" role="status"><Icon name="check"/>{t('common.sentSample')}</p>:null}
    {phase!=='sent'?<div className="ui-confirm-step__actions"><ActionButton disabled={busy||sendDisabled} onClick={()=>{if(busy)return;setLocked(true);onSend();}}>{t('ui.confirm.send')}</ActionButton><ActionButton variant="secondary" disabled={phase==='sending'} onClick={onCancel}>{cancelLabel??t('ui.confirm.notNow')}</ActionButton></div>:null}
  </>;
  return <section className="ui-confirm-step" aria-labelledby="ui-confirm-title">
    <h3 id="ui-confirm-title" ref={title} tabIndex={-1} className="ui-confirm-step__title">{t('ui.confirm.title',{n:count})}</h3>
    <dl className="ui-confirm-step__summary">{summary.map(row=><div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
    {footerActions ? <DetailFooterContent><div className="detail-footer-actions">{actions}</div></DetailFooterContent> : actions}</section>;
}

/** DS 11.9.4a CopyThenPosted: post text card, real clipboard copy, then 'I posted it'. Nothing counts as posted before the second press. */
export function CopyThenPosted({text,onCopied,onPosted,posted=false}:{readonly text:string;readonly onCopied?:(ok:boolean)=>void;readonly onPosted:()=>void;readonly posted?:boolean}){
  const {t}=useKitT();const body=useRef<HTMLParagraphElement>(null);const [state,setState]=useState<'idle'|'copied'|'failed'>('idle');const [done,setDone]=useState(false);
  const copy=async()=>{
    const ok=await copyText(text);setState(ok?'copied':'failed');
    if(!ok&&body.current){const range=document.createRange();range.selectNodeContents(body.current);const sel=window.getSelection();sel?.removeAllRanges();sel?.addRange(range);}
    onCopied?.(ok);
  };
  const isPosted=posted||done;
  return <div className="ui-copy-posted"><p ref={body} className="ui-copy-posted__text">{text}</p>
    <p className="ui-copy-posted__hint">{state==='copied'?<><Icon name="check"/>{t('common.copied')} </>:null}{t('ui.copy.then')}</p>
    {state==='failed'?<p className="ui-draft-card__error" role="alert"><Icon name="error"/>{t('common.copyFailed')}</p>:null}
    <div className="ui-copy-posted__actions"><ActionButton variant="secondary" disabled={isPosted} onClick={copy}><Icon name="copy"/>{t('ui.copy.action')}</ActionButton>
      <ActionButton disabled={isPosted} onClick={()=>{if(isPosted)return;setDone(true);onPosted();}}>{isPosted?<Icon name="check"/>:null}{t('marketing.posted')}</ActionButton></div></div>;
}

/** DS 11.9.4 UsageBar: 8 high, 96 long, direct label '4/20'. The number is the information. */
export function UsageBar({used,total}:{readonly used:number;readonly total:number}){
  const {t}=useKitT();const share=total>0?Math.min(1,used/total):0;
  return <span className="ui-usage-bar" role="img" aria-label={t('ui.usage.name',{used,total})}><span className="ui-usage-bar__track"><span className="ui-usage-bar__fill" style={{width:`${share*100}%`}}/></span><span className="ui-usage-bar__label" aria-hidden="true">{used}/{total}</span></span>;
}
/** DS 11.9.4 RateBar: a 0 to scaleMax percent bar for the channel table, ticks every quarter, the number written beside it. */
export function RateBar({value,label,scaleMax=40,text}:{readonly value:number;readonly label:string;readonly scaleMax?:number;readonly text?:string}){
  const {t}=useKitT();const share=Math.min(1,Math.max(0,value/scaleMax));const shown=text??`${value}%`;
  return <span className="ui-rate-bar" role="img" aria-label={t('ui.rate.name',{label,value:shown})}><span className="ui-rate-bar__track"><span className="ui-rate-bar__fill" style={{width:`${share*100}%`}}/></span><span className="ui-rate-bar__label" aria-hidden="true">{shown}</span></span>;
}
/** DS 11.9.4 FormulaRow: collapsed by default, 48 high; the identity lines appear when opened. */
export function FormulaRow({children,label,defaultOpen=false}:{readonly children:ReactNode;readonly label?:string;readonly defaultOpen?:boolean}){
  const {t}=useKitT();const [open,setOpen]=useState(defaultOpen);const id=useId();
  return <div className="ui-formula-row"><button type="button" className="ui-formula-row__toggle" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(!open)}><Icon name={open?'chevron-down':'chevron-right'}/>{label??t('ui.formula.show')}</button>{open?<div id={id} className="ui-formula-row__body">{children}</div>:null}</div>;
}
/** DS 11.9.4 InsightCard: a fixed one-line sentence on the selection face with a small 'sample' caption. No button. */
export function InsightCard({children}:{readonly children:ReactNode}){const {t}=useKitT();return <div className="ui-insight-card"><p>{children}</p><span className="ui-insight-card__tag">{t('ui.insight.example')}</span></div>;}

/** DS 11.9.4 StepProgress: static step rows (check plus name), the current one bold, no spinner, dots or percent. */
export function StepProgress({steps,current,onCancel,title}:{readonly steps:readonly string[];/** index of the running step; steps.length means finished */readonly current:number;readonly onCancel?:()=>void;readonly title?:string}){
  const {t}=useKitT();const name=steps[current];
  return <section className="ui-step-progress" aria-label={title}>
    {title?<h3 className="ui-step-progress__title">{title}</h3>:null}
    <ol>{steps.map((step,index)=><li key={step} data-state={index<current?'done':index===current?'current':'todo'} aria-current={index===current?'step':undefined}><span className="ui-step-progress__mark" aria-hidden="true">{index<current?<Icon name="check"/>:null}</span><span className="ui-step-progress__name">{step}<span className="ui-sr-only">{index<current?`, ${t('common.state.normal')}`:''}</span></span></li>)}</ol>
    <p className="ui-sr-only" role="status">{name?t('ui.step.current',{name}):''}</p>
    {onCancel?<ActionButton variant="secondary" onClick={onCancel}>{t('ui.step.cancel')}</ActionButton>:null}</section>;
}

export interface VideoScene { readonly id:string;/** seconds */readonly start:number;readonly end:number;readonly caption:string;readonly name?:string;readonly content?:ReactNode }
/** DS 11.9.4 VideoPreview: 9:16 frame (A 315x560, B 428x760), opaque caption band, text alternative 'scene n/total, range, caption'. */
export function VideoPreview({scene,index,total,preset='A',playing=false,rangeText}:{readonly scene:VideoScene;readonly index:number;readonly total:number;readonly preset?:'A'|'B';readonly playing?:boolean;readonly rangeText:string}){
  const {t}=useKitT();const reduced=useReduced();const size=pageTokens.videoFrame[preset];
  const fade=reduced?0:motionTokens.duration.scene/1000;
  return <div className="ui-video-preview" role="img" aria-label={t('ui.video.alt',{n:index+1,total,range:rangeText,caption:scene.caption})} style={{width:size.width,height:size.height}}>
    <motion.div key={scene.id} className="ui-video-preview__scene" aria-hidden="true" initial={{opacity:reduced?1:0}} animate={{opacity:1}} transition={{duration:fade,ease:'linear'}}>
      <motion.div className="ui-video-preview__art" animate={{scale:playing&&!reduced?1.04:1}} transition={{duration:playing&&!reduced?Math.max(0.001,scene.end-scene.start):0,ease:'linear'}}>{scene.content}</motion.div>
    </motion.div>
    <p className="ui-video-preview__caption" aria-hidden="true">{scene.caption}</p>
    <span className="ui-video-preview__silent" aria-hidden="true"><Icon name="ban"/> {t('ui.video.silent')}</span>
  </div>;
}
export interface PlayControlsProps { readonly playing:boolean;readonly finished:boolean;readonly onPlayPause:()=>void;readonly onPrevious:()=>void;readonly onNext:()=>void;readonly scenes:readonly {readonly id:string;readonly rangeText:string}[];readonly current:number;readonly onSelectScene:(index:number)=>void;/** 0..1 across the whole video */readonly progress:number }
/** DS 11.9.4 PlayControls. Under reduced motion there is no play button, only next scene. */
export function PlayControls({playing,finished,onPlayPause,onPrevious,onNext,scenes,current,onSelectScene,progress}:PlayControlsProps){
  const {t,locale}=useKitT();const reduced=useReduced();
  return <div className="ui-play-controls"><div className="ui-play-controls__buttons">
    <ActionButton variant="outline" size="icon" aria-label={t('ui.video.previous')} disabled={current<=0} onClick={onPrevious}><Icon name="previous-scene"/></ActionButton>
    {reduced?null:<ActionButton size="icon" aria-label={finished?t('ui.video.replay'):playing?t('ui.video.pause'):t('ui.video.play')} onClick={onPlayPause}><Icon name={finished?'replay':playing?'pause':'play'}/></ActionButton>}
    <ActionButton variant={reduced?'default':'outline'} size={reduced?'default':'icon'} aria-label={t('ui.video.next')} disabled={current>=scenes.length-1} onClick={onNext}>{reduced?t('ui.video.next'):null}<Icon name="next-scene"/></ActionButton></div>
    <div className="ui-play-controls__chips" role="group" aria-label={t('ui.video.scenes')}>{scenes.map((scene,index)=>{const label=t('ui.video.sceneChip',{n:index+1,range:scene.rangeText});return <ActionButton key={scene.id} variant="outline" aria-label={label} aria-pressed={index===current} aria-current={index===current?'step':undefined} onClick={()=>onSelectScene(index)}>{locale==='ko'?koreanScreenText(label):label}</ActionButton>;})}</div>
    <div className="ui-play-controls__progress" role="progressbar" aria-label={t('ui.video.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress*100)}><span style={{transform:`scaleX(${Math.min(1,Math.max(0,progress))})`}}/></div></div>;
}
/** DS 11.9.4 SceneList: rows of at least 64 with range, name and the whole caption; the current scene is selected. */
export function SceneList({scenes,current,onSelect}:{readonly scenes:readonly {readonly id:string;readonly rangeText:string;readonly name?:string;readonly caption:string}[];readonly current:number;readonly onSelect:(index:number)=>void}){
  return <ul className="ui-scene-list">{scenes.map((scene,index)=><li key={scene.id}><button type="button" className="ui-scene-row" aria-current={index===current?'step':undefined} data-current={String(index===current)} onClick={()=>onSelect(index)}><span className="ui-scene-row__range">{scene.rangeText}</span><span className="ui-scene-row__name">{scene.name}</span><span className="ui-scene-row__caption">{scene.caption}</span></button></li>)}</ul>;
}
const SCENE_TICK_MS=100;
/** DS 11.9.4a VideoPlayer = VideoPreview + PlayControls. No autoplay, stops at the end, scene stepping only under reduced motion. */
export function VideoPlayer({scenes,preset='A',onPlayedChange,currentIndex,onSceneChange}:{readonly scenes:readonly VideoScene[];readonly preset?:'A'|'B';onPlayedChange?:(playing:boolean)=>void;/** Controlled scene index: keeps an external scene list in sync. Stepping, playing and chips report through onSceneChange. */readonly currentIndex?:number;readonly onSceneChange?:(index:number)=>void}){
  const {t}=useKitT();const reduced=useReduced();
  const startIndex=currentIndex!==undefined&&scenes[currentIndex]?currentIndex:0;
  const [index,setIndex]=useState(startIndex);const [time,setTime]=useState(scenes[startIndex]?.start??0);const [playing,setPlaying]=useState(false);
  const reported=useRef(startIndex);
  useEffect(()=>{const next=currentIndex;if(next===undefined||!scenes[next])return;reported.current=next;if(next!==index){setIndex(next);setTime(scenes[next]!.start);}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[currentIndex]);
  const sceneChange=useRef(onSceneChange);sceneChange.current=onSceneChange;
  // Report only when the scene itself changed (not when the parent merely re-rendered with a new callback).
  useEffect(()=>{if(reported.current!==index){reported.current=index;sceneChange.current?.(index);}},[index]);
  const total=scenes[scenes.length-1]?.end??0;const finished=!playing&&time>=total&&total>0;
  useEffect(()=>{onPlayedChange?.(playing);},[playing,onPlayedChange]);
  useEffect(()=>{
    if(!playing||reduced)return;
    const timer=window.setInterval(()=>{
      setTime(previous=>{
        const next=previous+SCENE_TICK_MS/1000;
        if(next>=total){setPlaying(false);setIndex(scenes.length-1);return total;}
        const found=scenes.findIndex(scene=>next>=scene.start&&next<scene.end);if(found>=0)setIndex(found);
        return next;
      });
    },SCENE_TICK_MS);
    return ()=>window.clearInterval(timer);
  },[playing,reduced,scenes,total]);
  const range=(scene:VideoScene)=>t('ui.video.range',{start:scene.start,end:scene.end});
  const jump=(to:number)=>{const bound=Math.min(scenes.length-1,Math.max(0,to));setIndex(bound);setTime(scenes[bound]!.start);};
  const scene=scenes[index];if(!scene)return null;
  return <div className="ui-video-player"><VideoPreview scene={scene} index={index} total={scenes.length} preset={preset} playing={playing} rangeText={range(scene)}/>
    <PlayControls playing={playing} finished={finished} progress={total>0?(time/total):0} scenes={scenes.map(s=>({id:s.id,rangeText:range(s)}))} current={index}
      onPlayPause={()=>{if(finished){jump(0);setPlaying(true);}else setPlaying(!playing);}} onPrevious={()=>{setPlaying(false);jump(index-1);}} onNext={()=>{setPlaying(false);jump(index+1);}} onSelectScene={i=>{jump(i);}}/></div>;
}
