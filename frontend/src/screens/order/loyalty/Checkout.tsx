import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { PosCommandValue, PosFailure, PosMethod, PosMethodSplit, PosResult } from '../../../contracts/pos';
import { quotePaymentBill, normalizeMethodSplits } from '../../../pos/loyalty';
import { commandKey } from '../../../pos/domain/common';
import { usePosSession, usePosSnapshot } from '../../../pos/react';
import { ActionButton, ErrorPanel, Icon, NumberField, PosDialog, PosMoney, ResultPanel, Spinner, formatPosMoney, posClasses, posTimeTokens } from '../../../ui';
import { DiscountTools, MemberSearch, SplitTools, usePayText, payName, type PayCommand } from './Tools';
import './loyalty.css';
import { useSettlementUi } from '../settlement/port';
import { MoneyLoyaltyCheckout } from './MoneyCheckout';
import { usePosBridge } from '../../../pos/remote-context';

const methods = ['card','easy_pay','cash'] as const;
let sequence = 0;
export interface CheckoutProps {
  readonly open:boolean; readonly billId:string; readonly summary:string; readonly returnFocusRef:RefObject<HTMLElement|null>;
  readonly onClose:()=>void; readonly onComplete:(orderNo:number)=>void;
  readonly startCancel?:boolean;
  readonly onRegisterMember?: () => void;
}
type View = 'payment'|'member'|'discount'|'split'|'mixed'|'cancel';
export function LoyaltyCheckout({open,billId,summary,returnFocusRef,onClose,onComplete,onRegisterMember,startCancel=false}:CheckoutProps) {
  const settlement = useSettlementUi(), bridge = usePosBridge();
  if (bridge || settlement) return <MoneyLoyaltyCheckout open={open} billId={billId} summary={summary} returnFocusRef={returnFocusRef} onClose={onClose} onComplete={onComplete} onRegisterMember={onRegisterMember} startCancel={startCancel} port={settlement} bridge={bridge}/>;
  return <LegacyLoyaltyCheckout open={open} billId={billId} summary={summary} returnFocusRef={returnFocusRef} onClose={onClose} onComplete={onComplete} startCancel={startCancel}/>;
}
function LegacyLoyaltyCheckout({open,billId,summary,returnFocusRef,onClose,onComplete,startCancel=false}:CheckoutProps) {
  const runtime=usePosSession(),read=usePosSnapshot(),{t}=usePayText();
  const [view,setView]=useState<View>(startCancel?'cancel':'payment');
  const [confirmed,setConfirmed]=useState(()=>quotePaymentBill(read,billId));
  const [localError,setLocalError]=useState<PosFailure|null>(null),[zeroResult,setZeroResult]=useState<PosResult<PosCommandValue>|null>(null);
  const [selected,setSelected]=useState<PosMethod>('card'),[mixed,setMixed]=useState<Partial<Record<PosMethod,number|null>>>({});
  const [lastSplits,setLastSplits]=useState<readonly PosMethodSplit[]>([]),[paused,setPaused]=useState(false);
  const firstMethod=useRef<HTMLButtonElement|null>(null),region=useRef<HTMLElement|null>(null),lastTool=useRef<View>('member');
  const attempt=read.posUi.approval,busy=attempt?.status==='pending';
  // Successful approval results live in the command ledger; the attempt carries
  // failures directly. Match this attempt so earlier paid shares cannot complete it.
  const result=zeroResult??attempt?.result??(attempt?.status==='succeeded'
    ? read.pos.commandLedger.find(record=>record.key===commandKey(attempt.meta,'approval.begin'))?.result
    : undefined);
  const done=zeroResult?.ok||attempt?.status==='succeeded';
  const completion=done&&result?.ok&&result.value&&'orderIds' in result.value?result.value:null;
  const settled=completion?.settled??false;
  const orderNo=read.pos.orders.find(order=>completion?.orderIds.includes(order.orderId))?.orderNo;
  const live=quotePaymentBill(read,billId),quote=done?confirmed:live;
  const part=quote.parts.find(p=>p.status==='unpaid'),amount=part?.amount??quote.remaining;
  const locked=!!quote.parts.length;
  const member=read.data.loyalty?.members.find(m=>m.memberId===quote.memberId);
  const error=localError??(attempt?.status==='failed'&&result&&!result.ok?result:null);
  const refresh=()=>{setConfirmed(quotePaymentBill(runtime.read(),billId));setLocalError(null);setZeroResult(null);setMixed({});};
  const back=()=>{setView('payment');refresh();requestAnimationFrame(()=>document.querySelector<HTMLElement>(`[data-pay-tool="${lastTool.current}"]`)?.focus({preventScroll:true}));};
  const execute:PayCommand=input=>{
    const current=runtime.read();
    const outcome=runtime.execute({...input,billId,meta:{runId:current.runId,idempotencyKey:`bill-payment:tool:${++sequence}`}});
    if(!outcome.ok)setLocalError(outcome);else{setLocalError(null);setConfirmed(quotePaymentBill(runtime.read(),billId));}
    return outcome;
  };
  const finish=()=>{
    if(!open||runtime.read().posUi.approval?.status==='pending')return;
    if(done&&!settled){runtime.dismissApproval();refresh();setView('payment');return;}
    if(!done){
      const current=quotePaymentBill(runtime.read(),billId);
      if(!current.received&&runtime.read().pos.bills.some(b=>b.billId===billId&&b.status==='open')){const outcome=execute({type:'bill.clearSplit'});if(!outcome.ok)return;}
    }
    if(!runtime.dismissApproval())return;
    if(settled&&orderNo!==undefined)onComplete(orderNo);
    onClose();
  };
  const autoFinish=useEffectEvent(finish);
  useEffect(()=>{
    if(!open||!done||paused)return;
    const timer=window.setTimeout(autoFinish,posTimeTokens.payDoneMs);
    return()=>window.clearTimeout(timer);
  },[open,done,paused,attempt?.attemptId]);
  // Only the current subview gets focus. Subviews share the same trapped dialog.
  useLayoutEffect(()=>{if(view!=='payment')region.current?.querySelector<HTMLElement>('input,button')?.focus({preventScroll:true});},[view]);
  const begin=(splits:readonly PosMethodSplit[])=>{
    if(runtime.read().posUi.approval?.status==='pending')return;
    if(!splits.length){runtime.dismissApproval();refresh();return;}
    const current=runtime.read(),latest=quotePaymentBill(current,billId);
    if(latest.canSubmit&&latest.fingerprint!==confirmed.fingerprint){setLocalError({ok:false,code:'CONFLICT',reason:'QUOTE_CHANGED',messageKey:'pos.quoteChanged'});return;}
    setLastSplits(splits);setSelected(splits[0].method);setPaused(false);setLocalError(null);setView('payment');
    const nextPart=latest.parts.find(p=>p.status==='unpaid');
    const outcome=runtime.beginApproval({billId,...(nextPart?{partId:nextPart.partId}:{}),quoteRevision:confirmed.revision,splits,meta:{runId:current.runId,idempotencyKey:`bill-payment:approve:${++sequence}`}});
    if(!outcome.ok)setLocalError(outcome);
  };
  const zero=()=>{const outcome=execute({type:'bill.confirmZero'});if(outcome.ok){setZeroResult(outcome);setPaused(false);}};
  const chooseAgain=()=>{runtime.dismissApproval();refresh();setView('payment');};
  const openTool=(next:View)=>{if(busy||done)return;lastTool.current=next;setLocalError(null);setView(next);};
  const mixedTotal=methods.reduce((sum,method)=>sum+(mixed[method]??0),0),remaining=amount-mixedTotal;
  const mixedSplits=methods.flatMap(method=>(mixed[method]??0)>0?[{method,amount:mixed[method]!}]:[]);
  const mixedValid=normalizeMethodSplits(mixedSplits,amount).ok;
  const failureText=()=>{
    const key=error?.reason;
    if(key==='QUOTE_CHANGED')return[t('pos.quoteChanged'),t('pos.quoteChangedHelp')];
    if(key==='INVALID_OPTION')return[t('pay.optionChanged'),t('pay.optionChangedHelp')];
    if(['SOLD_OUT','ITEM_REMOVED','REQUIRED_OPTION'].includes(key??''))return[t('pos.removed'),t('pos.removedHelp')];
    if(key==='DAY_CLOSED')return[t('pos.closed'),t('pos.closedHelp')];
    if(key==='DATA_UNAVAILABLE')return[t('pos.dataError'),t('pos.dataErrorHelp')];
    return[t('pos.failure'),t('pos.failureHelp')];
  };
  const inlineError=error?t(error.reason==='DISCOUNT_EXCEEDS_GROSS'?'pay.exceeds':error.reason==='INVALID_AMOUNT'?'pay.amountInvalid':error.reason==='BILL_LOCKED'?'pay.splitLocked':error.reason==='QTY_ALLOCATION_INVALID'?'pay.quantityInvalid':'pos.commandError'):null;
  const title=view==='member'?t('pay.memberSearch'):view==='discount'?t('pos.discount'):view==='split'?t('pay.split'):view==='mixed'?t('pay.mixed'):t('pos.payment');
  if(view==='cancel')return <PartialCancellation open={open} billId={billId} returnFocusRef={returnFocusRef} onClose={()=>{if(startCancel)onClose();else back();}} onCanceled={onClose}/>;
  return <PosDialog open={open} kind="pay" title={title} description={`${t('pos.payable')} ${formatPosMoney(amount)}`} returnFocusRef={returnFocusRef} initialFocusRef={firstMethod} busy={busy} onClose={reason=>{if(reason==='Esc'&&view!=='payment'){back();return;}finish();}} headerAction={view!=='payment'?<ActionButton variant="ghost" onClick={back}><Icon name="chevron-left"/>{t('pay.back')}</ActionButton>:undefined}>
    <div lang="ko" className="order-payment">
      <div className="order-payment__amount"><p>{t('pos.payable')}</p><PosMoney amount={amount} size="display" aria-live="polite" aria-atomic="true"/><p className="order-payment__summary">{summary}</p></div>
      {view!=='payment'?<section key={view} ref={region} role="region" aria-label={title} className="pay-tools__subview">
        {view==='member'?<MemberSearch read={read} execute={execute} onApplied={back}/>:view==='discount'?<DiscountTools read={read} quote={quote} execute={execute} onApplied={back} onFindMember={()=>openTool('member')}/>:view==='split'?<SplitTools quote={quote} execute={execute} onApplied={back}/>:<div className="pay-tools__stack">
          {methods.map(method=><div key={method} className="pay-tools__row"><NumberField label={t(`pos.${method}`)} value={mixed[method]??null} onValueChange={value=>setMixed({...mixed,[method]:value})} min={0} unit={t('pay.won')}/><ActionButton variant="ghost" aria-label={t('pay.methodRemaining',{method:t(`pos.${method}`)})} onClick={()=>setMixed({...mixed,[method]:Math.max(0,amount-methods.filter(m=>m!==method).reduce((sum,m)=>sum+(mixed[m]??0),0))})}>{t('pay.fillRemaining')}</ActionButton></div>)}
          <p role="status">{remaining===0&&mixedValid?<><Icon name="check"/>{t('pay.amountMatches')}</>:t(remaining<0?'pay.mixedOver':'pay.mixedShort',{amount:formatPosMoney(Math.abs(remaining))})}</p>
          <ActionButton size="primary" disabled={!mixedValid} onClick={()=>begin(mixedSplits)}>{t('pos.checkout')}</ActionButton>
        </div>}{inlineError?<p className="pay-tools__error" role="alert">{inlineError}</p>:null}
      </section>:done?<ResultPanel title={settled?t(zeroResult?'pay.zeroDone':'pos.done',{n:orderNo??''}):t('pay.shareDone')} description={settled?lastSplits.map(s=>`${t(`pos.${s.method}`)} ${formatPosMoney(s.amount)}`).join(' + '):t('pay.partial',{amount:formatPosMoney(live.remaining)})} onInteract={()=>setPaused(true)}>
        <ActionButton variant="secondary" onClick={finish}>{settled?t('common.close'):t('pay.nextShare')}</ActionButton>
      </ResultPanel>:error&&view==='payment'?<ErrorPanel title={failureText()[0]} description={failureText()[1]} actions={error.reason==='QUOTE_CHANGED'?<ActionButton onClick={chooseAgain}>{t('pos.chooseAgain')}</ActionButton>:['SOLD_OUT','ITEM_REMOVED','DAY_CLOSED','DATA_UNAVAILABLE','INVALID_OPTION','REQUIRED_OPTION'].includes(error.reason)?<ActionButton onClick={finish}>{t('pos.backToCart')}</ActionButton>:<><ActionButton onClick={()=>begin(lastSplits)}>{t('pos.retry')}</ActionButton><ActionButton variant="secondary" onClick={chooseAgain}>{t('pos.otherMethod')}</ActionButton></>}/>:<>
        {member?<div className="pay-tools__member" role="status"><Icon name="members"/><span>{t('pay.memberLinked',{name:payName(t,member.name)})}</span><ActionButton variant="ghost" disabled={busy||locked} onClick={()=>execute({type:'bill.member',memberId:null})}>{t('pay.unlink')}</ActionButton></div>:null}
        <div className="pay-tools__discounts">{quote.discounts.map(d=><div key={d.discountId} className={posClasses.summaryRow}><span>{t(`pay.${d.source}`)}</span><PosMoney amount={d.amount} sign="minus"/><ActionButton variant="ghost" disabled={busy||locked} aria-label={t('pay.removeDiscount',{name:t(`pay.${d.source}`)})} onClick={()=>execute({type:'bill.removeDiscount',discountId:d.discountId})}><Icon name="remove"/></ActionButton></div>)}</div>
        <div className="pay-tools__row pay-tools__toolbar">{(['member','discount','split','mixed'] as const).map(v=><ActionButton key={v} data-pay-tool={v} variant="secondary" disabled={busy||(locked&&(v==='member'||v==='discount'))||(quote.received>0&&v==='split')||(quote.payable===0&&(v==='split'||v==='mixed'))} aria-describedby={locked&&(v==='member'||v==='discount')?'pay-lock-reason':undefined} onClick={()=>openTool(v)}>{t(v==='member'?'pay.memberSearch':v==='discount'?'pos.discount':v==='split'?'pay.split':'pay.mixed')}</ActionButton>)}</div>
        {locked?<p id="pay-lock-reason" className="pay-tools__reason">{t('pay.splitLocked')}</p>:null}
        {quote.parts.length?<ul aria-label={t('pay.split')} className="pay-tools__shares">{quote.parts.map((p,i)=><li key={p.partId} aria-current={p===part?'step':undefined} data-paid={p.status==='paid'}><span>{t('pay.share',{n:i+1,amount:formatPosMoney(p.amount)})}</span><span>{p.status==='paid'?<><Icon name="check"/>{t('pay.paid')} · {read.pos.payments.find(payment=>payment.partId===p.partId)?.splits.map(s=>`${t(`pos.${s.method}`)} ${formatPosMoney(s.amount)}`).join(' + ')}</>:p===part?t('pay.nextShare'):null}</span></li>)}</ul>:null}
        {quote.received>0?<div className="pay-tools__row"><strong role="status">{t('pay.partial',{amount:formatPosMoney(quote.remaining)})}</strong><ActionButton variant="ghost" disabled={busy} onClick={()=>openTool('cancel')}>{t('pay.cancelPartial')}</ActionButton></div>:null}
        {quote.payable===0?<ActionButton size="primary" className="ui-pos-action" onClick={zero}>{t('pay.zero')}</ActionButton>:<div className={posClasses.methods} role="group" aria-label={t('pos.payment')}>{methods.map((method,index)=><ActionButton key={method} ref={node=>{if(method==='card')firstMethod.current=node;if(busy&&selected===method)node?.setAttribute('aria-busy','true');else node?.removeAttribute('aria-busy');}} className={posClasses.method} disabled={busy&&selected!==method} onKeyDown={event=>{if(busy||!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const buttons=event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button');buttons?.[(index+(event.key==='ArrowRight'?1:-1)+methods.length)%methods.length]?.focus();}} onClick={()=>begin([{method,amount}])}>{busy&&selected===method?<><Spinner/><span>{t('pos.approving')}</span></>:<><Icon name={method==='cash'?'money':method==='card'?'receipt':'send'}/><span>{t(`pos.${method}`)}</span></>}</ActionButton>)}</div>}
      </>}
    </div>
  </PosDialog>;
}

/** The domain command is synchronous; this owns only the specified presentation delay. */
function PartialCancellation({open,billId,returnFocusRef,onClose,onCanceled}:Pick<CheckoutProps,'open'|'billId'|'returnFocusRef'|'onClose'> & {onCanceled:()=>void}) {
  const runtime=usePosSession(),read=usePosSnapshot(),{t}=usePayText(),[phase,setPhase]=useState<'ready'|'busy'|'done'|'error'>('ready');
  const close=useRef<HTMLButtonElement|null>(null),timer=useRef<number|undefined>(undefined),pressing=useRef(false);
  const payments=useRef(read.pos.payments.filter(p=>p.billId===billId&&p.status==='paid')).current;
  const amount=payments.reduce((sum,p)=>sum+p.amount,0),methodsText=payments.flatMap(p=>p.splits).map(s=>`${t(`pos.${s.method}`)} ${formatPosMoney(s.amount)}`).join(' + ');
  useEffect(()=>()=>window.clearTimeout(timer.current),[]);
  const confirm=()=>{
    if(pressing.current||phase==='busy'||phase==='done')return;
    pressing.current=true;setPhase('busy');const runId=runtime.read().runId;
    timer.current=window.setTimeout(()=>{
      if(runtime.read().runId!==runId)return;
      const outcome=runtime.execute({type:'bill.cancelPartial',billId,confirmed:true,meta:{runId,idempotencyKey:`bill-payment:cancel:${++sequence}`}});
      pressing.current=false;setPhase(outcome.ok?'done':'error');
      if(outcome.ok)timer.current=window.setTimeout(onCanceled,posTimeTokens.payDoneMs);
    },posTimeTokens.payApproveMs);
  };
  return <PosDialog open={open} kind="confirm" title={t('pay.cancelTitle')} description={`${t('pay.cancelAmount',{amount:formatPosMoney(amount)})} · ${methodsText}`} returnFocusRef={returnFocusRef} initialFocusRef={close} busy={phase==='busy'} busyReason={t('pay.canceling')} onClose={()=>{if(phase==='busy')return;window.clearTimeout(timer.current);if(phase==='done')onCanceled();else onClose();}} footer={<div className="pay-tools__row"><ActionButton ref={close} variant="secondary" size="primary" disabled={phase==='busy'} onClick={()=>{window.clearTimeout(timer.current);if(phase==='done')onCanceled();else onClose();}}>{t('common.close')}</ActionButton><ActionButton variant="destructive" size="primary" disabled={phase==='busy'||phase==='done'} onClick={confirm}>{phase==='busy'?<><Spinner/>{t('pay.canceling')}</>:phase==='done'?t('pay.canceled',{amount:formatPosMoney(amount)}):t(phase==='error'?'pos.retry':'pay.cancelAction',{amount:formatPosMoney(amount)})}</ActionButton></div>}>
    <div lang="ko" className="pay-tools__stack"><p>{t('pay.cancelAmount',{amount:formatPosMoney(amount)})} · {methodsText}</p><p>{t('pay.cancelShares',{n:payments.length})}</p><p>{t('pay.unlockCart')}</p>{phase==='error'?<p role="alert">{t('pay.cancelError')}</p>:phase==='done'?<ResultPanel title={t('pay.canceled',{amount:formatPosMoney(amount)})} onInteract={()=>window.clearTimeout(timer.current)}/>:null}</div>
  </PosDialog>;
}
