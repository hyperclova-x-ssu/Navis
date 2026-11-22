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
import type { PosBridge } from '../../../data/reality/02/bridge';
import type { projectCheckoutQuote } from '../../../data/reality/02/checkout-view';
import { useHttpCheckout } from './useHttpCheckout';

type Tool = 'member' | 'discount' | 'split' | 'cancel';
type CheckoutQuote = SettlementQuote | ReturnType<typeof projectCheckoutQuote>;
let sequence = 0;

/** Existing bill tools and one shared controlled payment window; money lives in the coordinator. */
export function MoneyLoyaltyCheckout(props: CheckoutProps & { readonly port: SettlementUiPort | null; readonly bridge: PosBridge | null }) {
  const { port, bridge, open, billId, summary, returnFocusRef, onClose, onComplete, startCancel } = props;
  const runtime = usePosSession(), read = usePosSnapshot(), { t } = usePayText();
  const http = useHttpCheckout(bridge, props);
  const state = useSaleSettlementState(port, billId), bill = quotePaymentBill(read, billId);
  const part = bill.parts.find(row => row.status === 'unpaid');
  const key = JSON.stringify([billId, part?.partId, bill.memberId, bill.fingerprint]);
  const [selection, setSelection] = useState<{ key: string; rows: readonly SettlementAllocation[] }>({ key, rows: [] });
  const [tool, setTool] = useState<Tool | null>(startCancel ? 'cancel' : null), [error, setError] = useState<string | null>(null);
  const region = useRef<HTMLElement>(null), frozen = useRef<SettlementQuote | null>(null);
  const toolButtons = useRef<Partial<Record<Tool, HTMLButtonElement | null>>>({}), previousTool = useRef(tool);
  const rows = selection.key === key ? selection.rows : [];
  const live = tool === 'cancel' ? null : http?.quote ?? port?.quoteSale({ billId, ...(part ? { partId: part.partId } : {}), allocations: rows });
  const phase = http?.phase ?? state.phase;
  const busy = phase.status === 'pending', done = phase.status === 'succeeded';
  const quote = (busy || done) && frozen.current ? frozen.current : live;
  const locked = !!bill.parts.length;
  const member = http ? http.member : bill.memberId ? port?.member(bill.memberId) : null;
  const change = (allocations: readonly SettlementAllocation[]) => {
    if (http) return http.change(allocations);
    setSelection({ key, rows: allocations });
    return port!.quoteSale({ billId, ...(part ? { partId: part.partId } : {}), allocations });
  };
  const reset = () => { if (http) http.reset(); else port?.reset(); frozen.current = null; setError(null); };
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
    if (http) {
      if (http.closeBlocked) return;
      if (done && http.orderNo !== undefined) onComplete(http.orderNo);
      onClose();
      return;
    }
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
  }, [open, done, phase.status === 'succeeded' ? phase.settlementId : undefined]);
  const openTool = (next: Tool) => { if (busy || done) return; setError(null); setTool(next); };
  if (tool === 'cancel') return !http && port ? <SharedPosReversalDialog mode="money" open={open} quote={port.quotePartialCancellation(billId)} phase={phase} returnFocusRef={returnFocusRef}
    onConfirm={port.cancelPartial} onRetry={reset} onClose={() => { if (busy) return; if (done) { reset(); onClose(); } else { reset(); if (startCancel) onClose(); else back(); } }}/> : null;
  if (!quote) return null;
  const toolTitle = tool === 'member' ? t('pay.memberSearch') : tool === 'discount' ? t('pos.discount') : t('pay.split');
  const tools = <div className="pay-tools__stack">
    {member && <ActionButton variant="ghost" disabled={busy || locked} onClick={() => { if (http) http.unlink(); else execute({ type: 'bill.member', memberId: null }); }}>{t('pay.unlink')}</ActionButton>}
    {http?.coupon && <p>{http.coupon.couponName} <PosMoney amount={http.coupon.discount} sign="minus"/></p>}
    {bill.discounts.filter(row => row.source !== 'membership').map(discount => <p key={discount.discountId}>{t('pay.' + discount.source)} <PosMoney amount={discount.amount} sign="minus"/></p>)}
    <div className="pay-tools__row pay-tools__toolbar">{(['member', 'discount', 'split'] as const).filter(next => !http || next === 'member' || next === 'discount' && !!http.discountTool).map(next => <ActionButton key={next} ref={button => { toolButtons.current[next] = button; }} variant="secondary" disabled={busy || done || locked && next !== 'split' || next === 'split' && (bill.received > 0 || bill.payable === 0)} onClick={() => openTool(next)}>{t(next === 'member' ? 'pay.memberSearch' : next === 'discount' ? 'pos.discount' : 'pay.split')}</ActionButton>)}</div>
    {locked && <p className="pay-tools__reason">{t('pay.splitLocked')}</p>}
    {!!bill.parts.length && <ul className="pay-tools__shares" aria-label={t('pay.split')}>{bill.parts.map((row, index) => <li key={row.partId} aria-current={row.partId === part?.partId ? 'step' : undefined} data-paid={row.status === 'paid'}><span>{t('pay.share', { n: index + 1, amount: formatPosMoney(row.amount) })}</span><span>{row.status === 'paid' ? <><Icon name="check"/>{t('pay.paid')}</> : row.partId === part?.partId ? t('pay.nextShare') : null}</span></li>)}</ul>}
    {!http && bill.received > 0 && <div className="pay-tools__row"><p>{t('pay.partial', { amount: formatPosMoney(bill.remaining) })}</p><ActionButton variant="ghost" disabled={busy || done} onClick={() => openTool('cancel')}>{t('pay.cancelPartial')}</ActionButton></div>}
    {error && <p role="alert">{error}</p>}
  </div>;
  const subview = tool ? { title: toolTitle, onBack: back, content: <section ref={region} className="pay-tools__stack" aria-label={toolTitle}>
    {tool === 'member' ? <MemberSearch read={read} execute={execute} onApplied={back} source={http?.memberSource}/> :
      tool === 'discount' ? <DiscountTools read={read} quote={bill} execute={execute} onApplied={back} onFindMember={() => setTool('member')} remoteCoupon={http?.discountTool}/> :
      !http && <SplitTools quote={bill} execute={execute} onApplied={back}/>}
    {error && <p role="alert">{error}</p>}
  </section> } : undefined;
  return <SharedPosPaymentDialog<CheckoutQuote> mode="money" open={open} target={quote.target} summary={summary} quote={quote} phase={phase} member={member} returnFocusRef={returnFocusRef}
    tools={tools} subview={subview} review={http?.review} result={http?.result ?? (done && state.completion ? !state.completion.settled ? { title: t('pay.shareDone'), description: t('pay.partial', { amount: formatPosMoney(state.completion.remaining) }), action: t('pay.nextShare') } : state.completion.orderNo !== undefined ? { title: t('pos.done', { n: state.completion.orderNo }) } : undefined : undefined)}
    onAllocationsChange={change} onApprove={current => {
      if (http) return http.approve(current);
      if (!port || !('sourceFingerprint' in current)) return false;
      frozen.current = current;
      return port.approve(current);
    }} onReset={reset} onClose={finish}/>;
}
