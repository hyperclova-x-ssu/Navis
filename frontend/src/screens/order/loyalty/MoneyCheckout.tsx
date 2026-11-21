import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { SettlementAllocation, SettlementQuote } from '../../../data/iteration7/accounting/types';
import { usePosSession, usePosSnapshot } from '../../../pos/react';
import { quotePaymentBill } from '../../../pos/loyalty';
import { ActionButton, Icon, PosMoney, formatPosMoney, posTimeTokens } from '../../../ui';
import { SharedPosPaymentDialog } from '../settlement/SharedPosPaymentDialog';
import { SharedPosReversalDialog } from '../settlement/SharedPosReversalDialog';
import { useSaleSettlementState, type SettlementUiPort } from '../settlement/port';
import { DiscountTools, MemberSearch, SplitTools, usePayText, type PayCommand } from './Tools';
import type { CheckoutProps } from './Checkout';

type Tool = 'member' | 'discount' | 'split' | 'cancel';
let sequence = 0;

/** Existing bill tools and one shared controlled payment window; money lives in the coordinator. */
export function MoneyLoyaltyCheckout({ port, open, billId, summary, returnFocusRef, onClose, onComplete, startCancel }: CheckoutProps & { readonly port: SettlementUiPort }) {
  const runtime = usePosSession(), read = usePosSnapshot(), { t } = usePayText();
  const state = useSaleSettlementState(port, billId), bill = quotePaymentBill(read, billId);
  const part = bill.parts.find(row => row.status === 'unpaid');
  const key = JSON.stringify([billId, part?.partId, bill.memberId, bill.fingerprint]);
  const [selection, setSelection] = useState<{ key: string; rows: readonly SettlementAllocation[] }>({ key, rows: [] });
  const [tool, setTool] = useState<Tool | null>(startCancel ? 'cancel' : null), [error, setError] = useState<string | null>(null);
  const region = useRef<HTMLElement>(null), frozen = useRef<SettlementQuote | null>(null);
  const toolButtons = useRef<Partial<Record<Tool, HTMLButtonElement | null>>>({}), previousTool = useRef(tool);
  const rows = selection.key === key ? selection.rows : [];
  const live = tool === 'cancel' ? null : port.quoteSale({ billId, ...(part ? { partId: part.partId } : {}), allocations: rows });
  const busy = state.phase.status === 'pending', done = state.phase.status === 'succeeded';
  const quote = (busy || done) && frozen.current ? frozen.current : live;
  const locked = !!bill.parts.length;
  const member = bill.memberId ? port.member(bill.memberId) : null;
  const change = (allocations: readonly SettlementAllocation[]) => {
    setSelection({ key, rows: allocations });
    return port.quoteSale({ billId, ...(part ? { partId: part.partId } : {}), allocations });
  };
  const reset = () => { port.reset(); frozen.current = null; setError(null); };
  const execute: PayCommand = input => {
    const outcome = runtime.execute({ ...input, billId, meta: { runId: read.runId, idempotencyKey: 'money-checkout:tool:' + ++sequence } });
    setError(outcome.ok ? null : t(outcome.messageKey));
    return outcome;
  };
  const back = () => { setTool(null); setError(null); };
  useLayoutEffect(() => {
    if (tool) region.current?.querySelector<HTMLElement>('input,button')?.focus({ preventScroll: true });
    else if (previousTool.current) toolButtons.current[previousTool.current]?.focus({ preventScroll: true });
    previousTool.current = tool;
  }, [tool]);
  const finish = () => {
    if (!open || busy) return;
    if (tool === 'cancel' && done) { reset(); onClose(); return; }
    if (done && state.completion && !state.completion.settled) { reset(); setSelection({ key, rows: [] }); return; }
    if (!done && !bill.received && read.pos.bills.some(row => row.billId === billId && row.status === 'open')) {
      if (!execute({ type: 'bill.clearSplit' }).ok) return;
    }
    const orderNo = state.completion?.orderNo;
    reset();
    if (done && state.completion?.settled && orderNo !== undefined) onComplete(orderNo);
    onClose();
  };
  const finishEvent = useEffectEvent(finish);
  useEffect(() => {
    if (!open || !done) return;
    const timer = window.setTimeout(finishEvent, posTimeTokens.payDoneMs);
    return () => window.clearTimeout(timer);
  }, [open, done, state.phase.status === 'succeeded' ? state.phase.settlementId : undefined]);
  const openTool = (next: Tool) => { if (busy || done) return; setError(null); setTool(next); };
  if (tool === 'cancel') return <SharedPosReversalDialog mode="money" open={open} quote={port.quotePartialCancellation(billId)} phase={state.phase} returnFocusRef={returnFocusRef}
    onConfirm={port.cancelPartial} onRetry={reset} onClose={() => { if (busy) return; if (done) { reset(); onClose(); } else { reset(); if (startCancel) onClose(); else back(); } }}/>;
  if (!quote) return null;
  const toolTitle = tool === 'member' ? t('pay.memberSearch') : tool === 'discount' ? t('pos.discount') : t('pay.split');
  const tools = <div className="pay-tools__stack">
    {member && <ActionButton variant="ghost" disabled={busy || locked} onClick={() => execute({ type: 'bill.member', memberId: null })}>{t('pay.unlink')}</ActionButton>}
    {bill.discounts.filter(row => row.source !== 'membership').map(discount => <p key={discount.discountId}>{t('pay.' + discount.source)} <PosMoney amount={discount.amount} sign="minus"/></p>)}
    <div className="pay-tools__row pay-tools__toolbar">{(['member', 'discount', 'split'] as const).map(next => <ActionButton key={next} ref={button => { toolButtons.current[next] = button; }} variant="secondary" disabled={busy || done || locked && next !== 'split' || next === 'split' && (bill.received > 0 || bill.payable === 0)} onClick={() => openTool(next)}>{t(next === 'member' ? 'pay.memberSearch' : next === 'discount' ? 'pos.discount' : 'pay.split')}</ActionButton>)}</div>
    {locked && <p className="pay-tools__reason">{t('pay.splitLocked')}</p>}
    {!!bill.parts.length && <ul className="pay-tools__shares" aria-label={t('pay.split')}>{bill.parts.map((row, index) => <li key={row.partId} aria-current={row.partId === part?.partId ? 'step' : undefined} data-paid={row.status === 'paid'}><span>{t('pay.share', { n: index + 1, amount: formatPosMoney(row.amount) })}</span><span>{row.status === 'paid' ? <><Icon name="check"/>{t('pay.paid')}</> : row.partId === part?.partId ? t('pay.nextShare') : null}</span></li>)}</ul>}
    {bill.received > 0 && <div className="pay-tools__row"><p>{t('pay.partial', { amount: formatPosMoney(bill.remaining) })}</p><ActionButton variant="ghost" disabled={busy || done} onClick={() => openTool('cancel')}>{t('pay.cancelPartial')}</ActionButton></div>}
    {error && <p role="alert">{error}</p>}
  </div>;
  const subview = tool ? { title: toolTitle, onBack: back, content: <section ref={region} className="pay-tools__stack" aria-label={toolTitle}>
    {tool === 'member' ? <MemberSearch read={read} execute={execute} onApplied={back}/> : tool === 'discount' ? <DiscountTools read={read} quote={bill} execute={execute} onApplied={back} onFindMember={() => setTool('member')}/> : <SplitTools quote={bill} execute={execute} onApplied={back}/>}
    {error && <p role="alert">{error}</p>}
  </section> } : undefined;
  return <SharedPosPaymentDialog mode="money" open={open} target={quote.target} summary={summary} quote={quote} phase={state.phase} member={member} returnFocusRef={returnFocusRef}
    tools={tools} subview={subview} result={done && state.completion ? !state.completion.settled ? { title: t('pay.shareDone'), description: t('pay.partial', { amount: formatPosMoney(state.completion.remaining) }), action: t('pay.nextShare') } : state.completion.orderNo !== undefined ? { title: t('pos.done', { n: state.completion.orderNo }) } : undefined : undefined}
    onAllocationsChange={change} onApprove={current => { frozen.current = current; return port.approve(current); }} onReset={reset} onClose={finish}/>;
}
