import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { Checkbox } from '@base-ui/react/checkbox';
import { useKitT } from '../kit-i18n';
import { ActionButton } from './controls';
import { Icon } from '../icons';

export interface TabItem<V extends string> { readonly value:V;readonly label:string }
/** DS 11.4 Tabs (in detail): each at least 48 high, selected = selection fill plus a 2px underline. */
export function DetailTabs<V extends string>({value,onValueChange,tabs,label,panels}:{readonly value:V;readonly onValueChange:(value:V)=>void;readonly tabs:readonly TabItem<V>[];readonly label:string;readonly panels?:Readonly<Partial<Record<V,ReactNode>>>}){
  return <Tabs.Root value={value} onValueChange={next=>onValueChange(next as V)} className="ui-detail-tabs"><Tabs.List aria-label={label} className="ui-detail-tabs__list">{tabs.map(tab=><Tabs.Tab key={tab.value} value={tab.value} className="ui-detail-tab">{tab.label}</Tabs.Tab>)}</Tabs.List>{tabs.map(tab=><Tabs.Panel key={tab.value} value={tab.value} className="ui-detail-tabs__panel">{panels?.[tab.value]}</Tabs.Panel>)}</Tabs.Root>;
}
export interface ChoiceItem<V extends string> { readonly value:V;readonly label:string;readonly disabled?:boolean }
function RadioChips<V extends string>({value,onChange,options,label,variant}:{readonly value:V;readonly onChange:(value:V)=>void;readonly options:readonly ChoiceItem<V>[];readonly label:string;readonly variant:'chips'|'segmented'}){
  const refs=useRef<(HTMLButtonElement|null)[]>([]);
  const move=(from:number,step:1|-1)=>{
    for(let i=1;i<=options.length;i+=1){const next=(from+step*i+options.length*i)%options.length;if(!options[next]!.disabled){onChange(options[next]!.value);refs.current[next]?.focus();return;}}
  };
  const onKeyDown=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
    if(event.key==='ArrowRight'||event.key==='ArrowDown'){event.preventDefault();move(index,1);}
    else if(event.key==='ArrowLeft'||event.key==='ArrowUp'){event.preventDefault();move(index,-1);}
  };
  const active=options.findIndex(o=>o.value===value);
  return <div role="radiogroup" aria-label={label} className={variant==='segmented'?'ui-segmented':'ui-chip-choice'}>{options.map((option,index)=><button key={option.value} ref={node=>{refs.current[index]=node;}} type="button" role="radio" aria-checked={option.value===value} disabled={option.disabled} tabIndex={index===(active<0?0:active)?0:-1} className="ui-choice-chip" onKeyDown={event=>onKeyDown(event,index)} onClick={()=>onChange(option.value)}>{option.label}</button>)}</div>;
}
/** DS 11.4 PeriodChips / ChipChoice: height 48 chips, wrap onto the next row, radio-group meaning. */
export function ChipChoice<V extends string>(props:{readonly value:V;readonly onChange:(value:V)=>void;readonly options:readonly ChoiceItem<V>[];readonly label:string}){return <RadioChips {...props} variant="chips"/>;}
export const PeriodChips=ChipChoice;
/** DS 11.4 SegmentedControl: two or three cells, height 48. */
export function SegmentedControl<V extends string>(props:{readonly value:V;readonly onChange:(value:V)=>void;readonly options:readonly ChoiceItem<V>[];readonly label:string}){return <RadioChips {...props} variant="segmented"/>;}
/** DS 11.4 TimeChips: three suggested times as chips. */
export function TimeChips({times,value,onChange,label}:{readonly times:readonly string[];readonly value:string|null;readonly onChange:(time:string)=>void;readonly label?:string}){
  const {t}=useKitT();
  return <ChipChoice value={value??''} onChange={onChange} label={label??t('ui.time.options')} options={times.map(time=>({value:time,label:time}))}/>;
}

interface FieldShell { readonly label:string;readonly error?:string;readonly hint?:string;readonly unit?:string;readonly id?:string;readonly className?:string }
function Field({label,error,hint,unit,className='',children,fieldId}:FieldShell&{readonly children:ReactNode;readonly fieldId:string}){
  const {t}=useKitT();
  return <div className={`ui-field ${className}`} data-invalid={error?'true':undefined}><label id={`${fieldId}-label`} htmlFor={fieldId} className="ui-field__label">{label}</label><div className="ui-field__control">{children}{unit?<span className="ui-field__unit">{unit}</span>:null}</div>{hint&&!error?<p id={`${fieldId}-hint`} className="ui-field__hint">{hint}</p>:null}{error?<p id={`${fieldId}-error`} className="ui-field__error" role="alert"><Icon name="error"/><span className="ui-sr-only">{t('ui.field.error',{message:''})}</span>{error}</p>:null}</div>;
}
const describe=(id:string,error?:string,hint?:string)=>error?`${id}-error`:hint?`${id}-hint`:undefined;
/** Shared field shell and aria-describedby id for the kit pickers (DateField, TimeField): same label above, hint and error sentence below. */
export {Field as FieldFrame,describe as describeField};
export type {FieldShell as FieldFrameProps};
/** DS 11.4 TextField: height 56, label above (never a placeholder), error as a sentence with an icon under the field. */
export function TextField({label,value,onValueChange,error,hint,unit,id,className,type='text',inputMode,placeholder,disabled,required,inputRef,name}:FieldShell&{readonly value:string;readonly onValueChange:(value:string)=>void;readonly type?:'text'|'search'|'tel'|'email';readonly inputMode?:'text'|'numeric'|'decimal';readonly placeholder?:string;readonly disabled?:boolean;readonly required?:boolean;readonly inputRef?:Ref<HTMLInputElement>;readonly name?:string}){
  const generated=useId();const fieldId=id??generated;const d=describe(fieldId,error,hint);
  return <Field label={label} error={error} hint={hint} unit={unit} id={fieldId} className={className} fieldId={fieldId}><input ref={inputRef} id={fieldId} name={name} className="ui-text-input" type={type} inputMode={inputMode} value={value} placeholder={placeholder} disabled={disabled} required={required} aria-invalid={error?true:undefined} aria-describedby={d} onChange={event=>onValueChange(event.currentTarget.value)}/></Field>;
}
/** DS 11.4 NumberField: TextField with a unit on the right. The value is a number, or null while empty or not a number. */
export function NumberField({label,value,onValueChange,min,max,step,error,hint,unit,id,className,disabled,inputRef,name}:FieldShell&{readonly value:number|null;readonly onValueChange:(value:number|null)=>void;readonly min?:number;readonly max?:number;readonly step?:number;readonly disabled?:boolean;readonly inputRef?:Ref<HTMLInputElement>;readonly name?:string}){
  const generated=useId();const fieldId=id??generated;const d=describe(fieldId,error,hint);
  return <Field label={label} error={error} hint={hint} unit={unit} id={fieldId} className={className} fieldId={fieldId}><input ref={inputRef} id={fieldId} name={name} className="ui-text-input ui-number-input" type="number" inputMode="numeric" min={min} max={max} step={step} value={value??''} disabled={disabled} aria-invalid={error?true:undefined} aria-describedby={d} onChange={event=>{const raw=event.currentTarget.value;const next=raw===''?null:Number(raw);onValueChange(next!==null&&Number.isFinite(next)?next:null);}}/></Field>;
}
/** DS 11.4 Textarea: min height 120. */
export function Textarea({label,value,onValueChange,error,hint,id,className,disabled,rows=4,inputRef,name}:FieldShell&{readonly value:string;readonly onValueChange:(value:string)=>void;readonly disabled?:boolean;readonly rows?:number;readonly inputRef?:Ref<HTMLTextAreaElement>;readonly name?:string}){
  const generated=useId();const fieldId=id??generated;const d=describe(fieldId,error,hint);
  return <Field label={label} error={error} hint={hint} id={fieldId} className={className} fieldId={fieldId}><textarea ref={inputRef} id={fieldId} name={name} className="ui-text-input ui-textarea" rows={rows} value={value} disabled={disabled} aria-invalid={error?true:undefined} aria-describedby={d} onChange={event=>onValueChange(event.currentTarget.value)}/></Field>;
}
/** DS 11.4 DateStepper: two 48 buttons and the date text. Left/Right arrows step while the date text has focus. */
export function DateStepper({text,onPrevious,onNext,previousDisabled=false,nextDisabled=false,label}:{readonly text:string;readonly onPrevious:()=>void;readonly onNext:()=>void;readonly previousDisabled?:boolean;readonly nextDisabled?:boolean;readonly label?:string}){
  const {t}=useKitT();
  return <div role="group" aria-label={label??t('ui.date.label')} className="ui-date-stepper">
    <ActionButton variant="outline" size="icon" aria-label={t('ui.date.previous')} disabled={previousDisabled} onClick={onPrevious}><Icon name="chevron-left"/></ActionButton>
    <span className="ui-date-stepper__text" tabIndex={0} role="status" aria-live="polite" onKeyDown={event=>{if(event.key==='ArrowLeft'&&!previousDisabled){event.preventDefault();onPrevious();}else if(event.key==='ArrowRight'&&!nextDisabled){event.preventDefault();onNext();}}}>{text}</span>
    <ActionButton variant="outline" size="icon" aria-label={t('ui.date.next')} disabled={nextDisabled} onClick={onNext}><Icon name="chevron-right"/></ActionButton>
  </div>;
}
/** DS 11.4 QuantityStepper: [-] value [+] unit, and the remaining line below. Out of range disables that button and says why. */
export function QuantityStepper({value,onChange,min=0,max=Number.POSITIVE_INFINITY,step=1,unit,label,remaining,minReason,maxReason}:{readonly value:number;readonly onChange:(value:number)=>void;readonly min?:number;readonly max?:number;readonly step?:number;readonly unit?:string;readonly label:string;/** e.g. '잔량 4 L' (already formatted). */readonly remaining?:string;readonly minReason?:string;readonly maxReason?:string}){
  const {t}=useKitT();const id=useId();const atMin=value<=min,atMax=value>=max;
  const reasonId=`${id}-reason`;const reason=atMax?maxReason:atMin?minReason:undefined;
  return <div role="group" aria-label={label} className="ui-quantity"><div className="ui-quantity__row">
    <ActionButton variant="outline" size="icon" aria-label={t('ui.quantity.decrease')} disabled={atMin} aria-describedby={atMin&&minReason?reasonId:undefined} onClick={()=>onChange(Math.max(min,value-step))}><Icon name="remove"/></ActionButton>
    <input className="ui-text-input ui-quantity__value" type="number" inputMode="numeric" aria-label={label} min={min} max={Number.isFinite(max)?max:undefined} step={step} value={value} onChange={event=>{const next=Number(event.currentTarget.value);if(Number.isFinite(next))onChange(Math.min(max,Math.max(min,next)));}}/>
    <ActionButton variant="outline" size="icon" aria-label={t('ui.quantity.increase')} disabled={atMax} aria-describedby={atMax&&maxReason?reasonId:undefined} onClick={()=>onChange(Math.min(max,value+step))}><Icon name="plus"/></ActionButton>
    {unit?<span className="ui-quantity__unit">{unit}</span>:null}</div>
    {remaining?<p className="ui-quantity__remaining">{remaining}</p>:null}{reason?<p id={reasonId} className="ui-quantity__reason">{reason}</p>:null}</div>;
}
/** DS 11.4 ChecklistRow: min 64, 24 box with a 48 hit, the sentence in body type. */
export function ChecklistRow({checked,onCheckedChange,children,disabled=false}:{readonly checked:boolean;readonly onCheckedChange:(checked:boolean)=>void;readonly children:ReactNode;readonly disabled?:boolean}){
  const id=useId();
  return <div className="ui-checklist-row" data-checked={String(checked)}><Checkbox.Root id={id} checked={checked} disabled={disabled} onCheckedChange={next=>onCheckedChange(next)} className="ui-checklist-row__box" aria-labelledby={`${id}-label`}><Checkbox.Indicator className="ui-checklist-row__tick"><Icon name="check"/></Checkbox.Indicator></Checkbox.Root><span id={`${id}-label`} className="ui-checklist-row__text">{children}</span></div>;
}
export function ChecklistProgress({done,total}:{readonly done:number;readonly total:number}){const {t}=useKitT();return <span className="ui-checklist-progress">{t('ui.checklist.progress',{done,total})}</span>;}
/** DS 11.4 InlineForm: opens inside the detail, focus goes to the first field, closing returns to the button that opened it. */
export function InlineForm({title,children,onSave,onClose,saveLabel,closeLabel,saveDisabled=false,saving=false,returnFocusRef}:{readonly title:string;readonly children:ReactNode;readonly onSave:()=>void;readonly onClose:()=>void;readonly saveLabel?:string;readonly closeLabel?:string;readonly saveDisabled?:boolean;readonly saving?:boolean;readonly returnFocusRef?:RefObject<HTMLElement|null>}){
  const {t}=useKitT();const formRef=useRef<HTMLFormElement>(null);const opener=useRef<Element|null>(null);const id=useId();
  useEffect(()=>{
    opener.current=document.activeElement;
    formRef.current?.querySelector<HTMLElement>('input:not([type=hidden]),textarea,select,button:not([data-inline-form-action])')?.focus();
    return ()=>{const target=returnFocusRef?.current??opener.current;if(target instanceof HTMLElement&&target.isConnected)target.focus();};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  return <form ref={formRef} className="ui-inline-form" aria-labelledby={`${id}-title`} onSubmit={event=>{event.preventDefault();if(!saveDisabled&&!saving)onSave();}} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose();}}}>
    <h3 id={`${id}-title`} className="ui-inline-form__title">{title}</h3><div className="ui-inline-form__body">{children}</div>
    <div className="ui-inline-form__actions"><ActionButton type="submit" data-inline-form-action disabled={saveDisabled} loading={saving}>{saveLabel??t('common.saveAction')}</ActionButton><ActionButton variant="secondary" data-inline-form-action onClick={onClose}>{closeLabel??t('common.close')}</ActionButton></div></form>;
}
/** Local clipboard write (the only allowed system call, D-63 5). Resolves false when unavailable or refused. */
export async function copyText(text:string):Promise<boolean>{
  try{if(typeof navigator==='undefined'||!navigator.clipboard?.writeText)return false;await navigator.clipboard.writeText(text);return true;}catch{return false;}
}
/** DS 11.4 DraftCard: read-only draft face with the word 초안; copy writes the real clipboard. On failure the text is selected and an alert asks for a manual copy. */
export function DraftCard({text,onCopied,onSave,copyLabel,saveLabel,label}:{readonly text:string;/** Called with the result; the parent shows the 복사했어요 Notice on true. */readonly onCopied?:(ok:boolean)=>void;readonly onSave?:()=>void;readonly copyLabel?:string;readonly saveLabel?:string;readonly label?:string}){
  const {t}=useKitT();const body=useRef<HTMLParagraphElement>(null);const [failed,setFailed]=useState(false);
  const copy=async()=>{
    const ok=await copyText(text);setFailed(!ok);
    if(!ok&&body.current){const range=document.createRange();range.selectNodeContents(body.current);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);}
    onCopied?.(ok);
  };
  return <div className="ui-draft-card"><span className="ui-draft-card__label">{label??t('common.draft')}</span><p ref={body} className="ui-draft-card__text">{text}</p>{failed?<p className="ui-draft-card__error" role="alert"><Icon name="error"/>{t('common.copyFailed')}</p>:null}
    <div className="ui-draft-card__actions"><ActionButton variant="secondary" onClick={copy}><Icon name="copy"/>{copyLabel??t('ui.copy.action')}</ActionButton>{onSave?<ActionButton variant="secondary" onClick={onSave}>{saveLabel??t('common.saveAction')}</ActionButton>:null}</div></div>;
}
/** DS 11.4 ChannelTransfer: store and online counts, a direction swap, an amount stepper and [옮기기]. The total never changes. */
export function ChannelTransfer({store,online,unit,onTransfer,format=(n:number)=>String(n)}:{readonly store:number;readonly online:number;readonly unit?:string;readonly onTransfer:(move:{readonly from:'store'|'online';readonly amount:number})=>void;readonly format?:(n:number)=>string}){
  const {t}=useKitT();const [from,setFrom]=useState<'store'|'online'>('store');const [amount,setAmount]=useState(1);
  const source=from==='store'?store:online;const over=amount>source;const total=store+online;
  return <div className="ui-channel-transfer"><div className="ui-channel-transfer__cards">
    <div className="ui-channel-card" data-from={String(from==='store')}><span>{t('ui.channel.store')}</span><strong>{format(store)}{unit?` ${unit}`:''}</strong></div>
    <ActionButton variant="outline" size="icon" aria-label={t('ui.channel.swap')} onClick={()=>setFrom(from==='store'?'online':'store')}><Icon name="move"/></ActionButton>
    <div className="ui-channel-card" data-from={String(from==='online')}><span>{t('ui.channel.online')}</span><strong>{format(online)}{unit?` ${unit}`:''}</strong></div></div>
    <QuantityStepper value={amount} onChange={setAmount} min={1} max={Math.max(1,source)} label={`${from==='store'?t('ui.channel.store'):t('ui.channel.online')} → ${from==='store'?t('ui.channel.online'):t('ui.channel.store')}`} unit={unit} maxReason={over?t('ui.channel.overStock'):undefined}/>
    {over?<p className="ui-quantity__reason" role="alert">{t('ui.channel.overStock')}</p>:null}
    <div className="ui-channel-transfer__foot"><span>{t('ui.channel.total',{n:total})}</span><span>{t('ui.channel.totalSame')}</span></div>
    <ActionButton disabled={over||source<=0||amount<1} onClick={()=>onTransfer({from,amount})}>{t('common.moveAction')}</ActionButton></div>;
}
/** DS 11.4 MasterDetail frame: list 40% (at least 520) and detail 60%, gap 24. */
export function MasterDetail({list,detail,listLabel,detailLabel}:{readonly list:ReactNode;readonly detail:ReactNode;readonly listLabel?:string;readonly detailLabel?:string}){
  const {t}=useKitT();
  return <div className="ui-master-detail"><section className="ui-master-detail__list" aria-label={listLabel??t('ui.masterDetail.list')}>{list}</section><section className="ui-master-detail__detail" aria-label={detailLabel??t('ui.masterDetail.detail')}>{detail}</section></div>;
}
