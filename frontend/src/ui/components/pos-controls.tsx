import { MetricFit } from './metric-fit';
import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { useBundle } from '../../i18n';
import { Icon } from '../icons';
import { useUi } from '../context';
import { posLayoutTokens } from '../pos-tokens';
import { posUiBundle } from '../pos-messages';
import { formatPosMoney, type PosMoneyFormat } from '../pos-money';
import { ActionButton, SearchField, type ActionButtonProps, type SearchFieldProps } from './controls';
import { ChipChoice, TextField, type ChoiceItem } from './forms';
import { StatusChip } from './management';
import { DetailDialog, type DetailDialogProps } from './overlays';

export interface CountBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly count:number; readonly tone?:'cart'|'neutral'|'missing';
}
/** The parent tab/card owns the accessible name; this badge never announces twice. */
export function CountBadge({count,tone='neutral',className='',...props}:CountBadgeProps) {
  return <span {...props} lang="ko" className={`ui-pos-count ${className}`} data-tone={tone}>
    {tone==='missing'?<Icon name="warning"/>:null}{count}
  </span>;
}

export function PosStatusChip(props:ComponentProps<typeof StatusChip>) {
  return <span className="ui-pos-status"><StatusChip {...props}/></span>;
}

export interface CategoryChipsProps<V extends string> {
  readonly value:V; readonly onChange:(value:V)=>void;
  readonly options:readonly ChoiceItem<V>[]; readonly label?:string;
}
export function CategoryChips<V extends string>({label,...props}:CategoryChipsProps<V>) {
  const {t} = useBundle(posUiBundle);
  return <div lang="ko" className="ui-pos-categories"><ChipChoice {...props} label={label??t('ui.pos.category')}/></div>;
}

export function PosSearchField(props:SearchFieldProps) {
  const {t} = useBundle(posUiBundle);
  return <div lang="ko" className="ui-pos-search"><SearchField {...props} hideLabel
    label={props.label??t('ui.pos.search')} placeholder={props.placeholder??t('ui.pos.searchHint')}
    clearLabel={t('ui.pos.clearSearch')}/></div>;
}

export interface PosQuantityStepperProps {
  readonly value:number; readonly name:string; readonly onChange:(quantity:number)=>void;
  /** A removed menu still permits removal, but cannot increase. */
  readonly removeOnly?:boolean; readonly disabledReason?:string;
  readonly onBlocked?:(reason:string)=>void;
  /** Cart roving navigation can remove both buttons from the page's Tab order. */
  readonly tabIndex?:number;
  /** Optional independent cart targets; tabIndex remains the fallback for both. */
  readonly decreaseTabIndex?:number; readonly increaseTabIndex?:number;
  readonly decreaseRef?:Ref<HTMLButtonElement>; readonly increaseRef?:Ref<HTMLButtonElement>;
}
export function PosQuantityStepper({value,name,onChange,removeOnly=false,disabledReason,onBlocked,tabIndex,decreaseTabIndex,increaseTabIndex,decreaseRef,increaseRef}:PosQuantityStepperProps) {
  const {t} = useBundle(posUiBundle); const id=useId();
  const atMax = value>=posLayoutTokens.common.quantityMax;
  const increaseReason = disabledReason??(atMax?t('ui.pos.quantityLimit'):undefined);
  const reason = disabledReason??(atMax?t('ui.pos.quantityLimit'):undefined);
  return <div lang="ko" className="ui-pos-quantity" role="group" aria-label={name}>
    <ActionButton ref={decreaseRef} variant="secondary" tabIndex={decreaseTabIndex??tabIndex} aria-label={t('ui.pos.decrease',{name})}
      aria-disabled={!!disabledReason} aria-describedby={disabledReason?id:undefined}
      onClick={() => disabledReason?onBlocked?.(disabledReason):onChange(removeOnly?0:value-1)}><Icon name="remove"/></ActionButton>
    <span className="ui-pos-quantity__value">{value}</span>
    <ActionButton ref={increaseRef} variant="secondary" tabIndex={increaseTabIndex??tabIndex} aria-label={t('ui.pos.increase',{name})}
      disabled={removeOnly||atMax} aria-disabled={!!increaseReason||removeOnly}
      aria-describedby={increaseReason?id:undefined}
      onClick={() => increaseReason?onBlocked?.(increaseReason):onChange(value+1)}><Icon name="plus"/></ActionButton>
    {reason?<span id={id} className="ui-sr-only">{reason}</span>:null}
  </div>;
}

export interface PosActionButtonProps extends Omit<ActionButtonProps,'onClick'|'loading'> {
  /** Dispatch synchronously; approval/busy and errors remain controlled by the app. */
  readonly onAction:()=>void; readonly reason?:string;
  readonly busy?:boolean; readonly busyLabel?:string; readonly onBlocked?:(reason:string)=>void;
}
export function PosActionButton({children,onAction,reason,busy=false,busyLabel,onBlocked,disabled=false,className='',...props}:PosActionButtonProps) {
  const {t}=useBundle(posUiBundle); const id=useId(); const locked=useRef(false);
  const activate=() => {
    if (busy||disabled||locked.current) return;
    if (reason) { onBlocked?.(reason); return; }
    locked.current=true;
    try {
      onAction();
    } finally { queueMicrotask(() => { locked.current=false; }); }
  };
  return <div lang="ko" className="ui-pos-action-block">
    <p id={id} className="ui-pos-action-reason">{reason?<><Icon name="info"/>{reason}</>:null}</p>
    <ActionButton {...props} className={`ui-pos-action ${className}`} aria-disabled={!!reason||busy||disabled}
      aria-busy={busy||undefined} aria-describedby={[props['aria-describedby'],reason?id:undefined].filter(Boolean).join(' ')||undefined}
      onClick={activate}>{busy?<><Spinner/>{busyLabel??t('ui.pos.approving')}</>:children}</ActionButton>
  </div>;
}

export interface PosDialogProps extends Omit<DetailDialogProps,'fullscreen'|'posMotion'|'popupClassName'|'dialogRole'|'closeLocked'|'closeLockReason'|'descriptionHidden'> {
  readonly kind?:'option'|'pay'|'confirm'|'receipt'; readonly busy?:boolean; readonly busyReason?:string;
}
/** Reuses Base UI's existing dialog trap, dismissal, return target and notice slot. */
export function PosDialog({kind='option',busy=false,busyReason,popupRef,...props}:PosDialogProps) {
  const {t}=useBundle(posUiBundle); const {reducedMotion}=useUi();
  return <DetailDialog {...props} posMotion descriptionHidden contentLang="ko" closeLabel={props.closeLabel??t('ui.pos.close')}
    closeLocked={busy} closeLockReason={busyReason??t('ui.pos.approvalLock')}
    dialogRole={kind==='confirm'?'alertdialog':'dialog'}
    popupClassName={`ui-pos-dialog ui-pos-dialog--${kind}`}
    popupRef={node => {
      if (node&&props.returnFocusRef?.current&&!reducedMotion) {
        const source=props.returnFocusRef.current.getBoundingClientRect();
        const target=node.getBoundingClientRect();
        const scale=target.width&&node.offsetWidth?target.width/node.offsetWidth:1;
        node.style.transformOrigin=`${(source.x+source.width/2-target.x)/scale}px ${(source.y+source.height/2-target.y)/scale}px`;
      }
      if (typeof popupRef==='function') return popupRef(node);
      if (popupRef) popupRef.current=node;
    }}/>;
}

/** Decorative, always accompanied by the caller's visible waiting sentence. */
export function Spinner() {
  return <svg className="ui-pos-spinner" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d="M16 2a14 14 0 1 1-14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
  </svg>;
}

export interface ResultPanelProps {
  readonly title:string; readonly description?:ReactNode; readonly children?:ReactNode;
  /** App scheduler pauses payDone on either callback; the kit owns no business timer. */
  readonly onInteract?:()=>void;
}
export function ResultPanel({title,description,children,onInteract}:ResultPanelProps) {
  const heading=useRef<HTMLHeadingElement>(null); const placingFocus=useRef(false);
  useLayoutEffect(() => { placingFocus.current=true; heading.current?.focus({preventScroll:true}); placingFocus.current=false; },[]);
  return <div lang="ko" className="ui-pos-result" onFocusCapture={() => { if (!placingFocus.current) onInteract?.(); }} onPointerDownCapture={onInteract} onKeyDownCapture={onInteract}>
    <span className="ui-pos-result__circle" aria-hidden="true"><span className="ui-pos-result__check"><Icon name="check"/></span></span>
    <h2 ref={heading} tabIndex={-1}>{title}</h2>
    {description?<p className="ui-pos-result__description">{description}</p>:null}{children}
  </div>;
}

export interface ErrorPanelProps {
  readonly title:string; readonly description?:ReactNode; readonly actions?:ReactNode;
}
export function ErrorPanel({title,description,actions}:ErrorPanelProps) {
  const heading=useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { heading.current?.focus({preventScroll:true}); },[]);
  return <div lang="ko" className="ui-pos-error" role="alert" aria-atomic="true">
    <Icon name="no-entry"/><h2 ref={heading} tabIndex={-1}>{title}</h2>
    {description?<p>{description}</p>:null}{actions?<div className="ui-pos-error__actions">{actions}</div>:null}
  </div>;
}

export interface PosMoneyProps extends HTMLAttributes<HTMLSpanElement> {
  readonly amount:number; readonly moneyStyle?:PosMoneyFormat['style']; readonly sign?:PosMoneyFormat['sign'];
  readonly size?:'body'|'control'|'metric'|'display';
}
export function PosMoney({amount,moneyStyle,sign,size='body',className='',...props}:PosMoneyProps) {
  const formatted=formatPosMoney(amount,{style:moneyStyle,sign});
  const parts=(size==='display'||size==='metric')?formatted.match(/^(.+?)(만 원|원)$/u):null;
  return <span {...props} lang="ko" className={`ui-pos-money ui-pos-money--${size} ${className}`}>{parts?<MetricFit value={parts[1]} unit={parts[2]} presentation="payment"/>:formatted}</span>;
}

export interface CorrectionConfirmationProps extends Omit<PosDialogProps,'kind'|'title'|'busy'|'footer'> {
  readonly operation:'cancel'|'refund'; readonly amount:number; readonly methodLabel?:string;
  readonly phase:'ready'|'busy'|'done'|'error'; readonly error?:string; readonly reason?:string;
  readonly onConfirm:()=>void; readonly onInteract?:()=>void;
  /** Quote-provided consequences; e.g. whether sales, inventory or coupon use returns. */
  readonly effects?:ReactNode;
}
/** Quote-driven confirmation only: no reversal, refund or inventory calculation lives here. */
export function CorrectionConfirmation({operation,amount,methodLabel,phase,error,reason,onConfirm,onInteract,effects,children,...props}:CorrectionConfirmationProps) {
  const {t}=useBundle(posUiBundle); const id=useId(); const pressing=useRef(false);
  const busy=phase==='busy',done=phase==='done'; const verb=operation==='cancel'?'cancel':'refund';
  const formatted=formatPosMoney(amount);
  const amountLine=`${t(`ui.pos.${verb}Amount`,{amount:formatted})}${methodLabel?` · ${methodLabel}`:''}`;
  const blocked=reason??(amount===0?t('ui.pos.chooseItems'):undefined);
  const label=done?t(`ui.pos.${verb}Done`,{amount:formatted}):busy?t(`ui.pos.${verb}Busy`):phase==='error'?t('ui.pos.retry'):t(`ui.pos.${verb}Action`,{amount:formatted});
  return <PosDialog {...props} kind="confirm" title={t(`ui.pos.${verb}Title`)}
    description={amountLine}
    busy={busy} footer={<div lang="ko" className="ui-pos-confirm-actions">
      <ActionButton variant="secondary" size="primary" disabled={busy} onClick={() => props.onClose('button')}>{t('ui.pos.close')}</ActionButton>
      <ActionButton variant="destructive" size="primary" className="ui-pos-confirm-action" disabled={busy||done||!!blocked}
        aria-busy={busy||undefined} aria-describedby={blocked?id:undefined}
        onFocus={onInteract} onPointerDown={onInteract}
        onClick={() => { if (pressing.current) return; pressing.current=true; try { onConfirm(); } finally { queueMicrotask(() => { pressing.current=false; }); } }}>
        {busy?<Spinner/>:done?<Icon name="check"/>:null}{label}
      </ActionButton>
    </div>}>
    {children}
    <p className="ui-pos-confirm-amount">{amountLine}</p>
    {effects}
    {blocked?<p id={id} className="ui-pos-inline-reason">{blocked}</p>:null}
    {phase==='error'?<p className="ui-pos-inline-error" role="alert"><Icon name="no-entry"/>{error??t('ui.pos.cancelError')}</p>:null}
    {done?<p className="ui-sr-only" role="status">{label}</p>:null}
  </PosDialog>;
}

export interface CashDrawerInputProps {
  readonly value:number|null; readonly onValueChange:(amount:number|null)=>void;
  readonly closed?:boolean; readonly error?:string;
}
/** Commands enforce domain validation; invalid drafts never change the accepted money. */
export function CashDrawerInput({value,onValueChange,closed=false,error}:CashDrawerInputProps) {
  const {t}=useBundle(posUiBundle);
  const [draft,setDraft]=useState({accepted:value,raw:value===null?'':String(value),invalid:false});
  // A new external amount replaces the editing draft during the same render.
  // Invalid drafts never call the money command or overwrite its accepted value.
  if (draft.accepted!==value) setDraft({accepted:value,raw:value===null?'':String(value),invalid:false});
  const change=(raw:string) => {
    const next=raw===''?null:Number(raw);
    const valid=raw===''||(/^\d+$/.test(raw)&&next!==null&&Number.isSafeInteger(next)&&next>=0);
    setDraft({accepted:valid?next:value,raw,invalid:!valid});
    if (valid) onValueChange(next);
  };
  return <div lang="ko" className="ui-pos-cash-input"><TextField name="actual-cash" label={t('ui.pos.actualCash')}
    value={closed?(value===null?'':String(value)):draft.raw} onValueChange={change} inputMode="numeric" disabled={closed}
    error={closed?undefined:error??(draft.invalid?t('ui.pos.cashInvalid'):undefined)}
    hint={closed?t('ui.pos.cashClosed'):t('ui.pos.actualCashHint')} unit={t('ui.pos.won')}/></div>;
}

export interface CashDrawerRow {
  readonly id:string; readonly label:string; readonly amount:number;
  readonly sign?:PosMoneyFormat['sign']; readonly note?:string;
  readonly action?:{readonly label:string; readonly onPress:()=>void};
}
export interface CashDrawerCalcProps {
  readonly rows:readonly CashDrawerRow[]; readonly expected:number; readonly actual:number|null;
  readonly difference:number|null; readonly onActualChange:(amount:number|null)=>void;
  readonly closed?:boolean; readonly error?:string;
  readonly memo?:string; readonly onMemoChange?:(memo:string)=>void;
}
/** Displays the cash selector's rows, expected amount and difference without recalculating totals. */
export function CashDrawerCalc({rows,expected,actual,difference,onActualChange,closed=false,error,memo,onMemoChange}:CashDrawerCalcProps) {
  const {t}=useBundle(posUiBundle);
  return <section lang="ko" className="ui-pos-cash-calc" aria-label={t('ui.pos.cashDrawer')}>
    {rows.map(row=><div key={row.id} className="ui-pos-cash-row"><div>{row.label}{row.note?<p className="ui-pos-line-detail">{row.note}</p>:null}</div>
      <div><PosMoney amount={row.amount} sign={row.sign} size="control"/>{row.action?<ActionButton variant="ghost" disabled={closed} onClick={row.action.onPress}>{row.action.label}</ActionButton>:null}</div></div>)}
    <div className="ui-pos-cash-row ui-pos-cash-total"><strong>{t('ui.pos.expectedCash')}</strong><PosMoney amount={expected} size="metric"/></div>
    <CashDrawerInput value={actual} onValueChange={onActualChange} closed={closed} error={error}/>
    <DiffLine difference={difference}/>
    {memo!==undefined&&onMemoChange?<TextField name="cash-memo" label={t('ui.pos.cashMemo')} value={memo} onValueChange={onMemoChange} disabled={closed}/>:null}
  </section>;
}

export function DiffLine({difference}:{readonly difference:number|null}) {
  const {t}=useBundle(posUiBundle);
  const tone=difference===null?'empty':difference<0?'short':difference>0?'over':'match';
  const message=difference===null?'':difference===0?t('ui.pos.cashMatch'):t(difference<0?'ui.pos.cashShort':'ui.pos.cashOver',{amount:formatPosMoney(Math.abs(difference))});
  return <p lang="ko" className="ui-pos-diff" data-tone={tone} role="status" aria-atomic="true">
    {difference!==null?<Icon name={tone==='short'?'warning':tone==='over'?'info':'check'}/>:null}{message}
  </p>;
}
