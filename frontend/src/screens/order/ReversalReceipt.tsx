import { useEffect, useRef, useState } from 'react';
import type { PosReversalInput, PosReversalQuote } from '../../contracts/pos';
import { dataBundles, resolveDataText } from '../../data/widget-data';
import { useBundle } from '../../i18n';
import { receiptBundle } from './messages';
import { posBundle } from '../../i18n/messages/pos';
import { usePosSession, usePosSnapshot } from '../../pos/react';
import { quoteReversal, selectPaymentRemaining, selectReceipt } from '../../pos/reversals';
import { ActionButton, CategoryChips, ChecklistRow, CorrectionConfirmation, NumberField, PosDialog, PosMoney, SegmentedControl, TextField, formatPosMoney, posClasses, posTimeTokens } from '../../ui';
import { MoneyReversalReceipt, type MoneyReversalReceiptProps } from './settlement/MoneyReversalReceipt';

type View = 'receipt' | 'cancel' | 'refund';
export interface ReversalReceiptEntry { readonly paymentId: string; readonly view: View }
type Scope = 'all' | 'items' | 'amount';
let sequence = 0;

type LegacyReceiptProps = { paymentId: string; initialView: View; onClose: () => void };
export function ReversalReceipt(props: LegacyReceiptProps | MoneyReversalReceiptProps) {
  if ('settlementId' in props) return <MoneyReversalReceipt {...props}/>;
  return <LegacyReversalReceipt {...props}/>;
}
function LegacyReversalReceipt({ paymentId, initialView, onClose }: LegacyReceiptProps) {
  const runtime = usePosSession(), read = usePosSnapshot(), { t, format } = useBundle(posBundle, receiptBundle, ...dataBundles);
  const receiptTime = (at: string) => `${format.date(at.slice(0, 10), 'long')} · ${format.time(at.slice(11, 16))}`;
  const [view, setView] = useState<View>(initialView), [scope, setScope] = useState<Scope>('all');
  const [selected, setSelected] = useState<readonly string[]>([]), [amount, setAmount] = useState(''), [method, setMethod] = useState<'card' | 'easy_pay' | 'cash'>('card');
  const [restock, setRestock] = useState(false), [phase, setPhase] = useState<'ready' | 'busy' | 'done' | 'error'>('ready');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [issuing, setIssuing] = useState(false), [kind, setKind] = useState<'income' | 'business'>('income'), [identifier, setIdentifier] = useState('');
  const locked = useRef(false), submittedQuote = useRef<PosReversalQuote | null>(null), timers = useRef<number[]>([]), focus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => () => { timers.current.forEach(window.clearTimeout); }, []);
  const schedule = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
  const meta = () => ({ runId: runtime.read().runId, idempotencyKey: `reversal-ui:${++sequence}` });
  const receipt = selectReceipt(read, { paymentId });
  const balance = selectPaymentRemaining(read.pos, paymentId);
  const operation = view === 'refund' ? 'refund' : 'cancel';
  const availableLines = quoteReversal(read, { paymentId, kind: operation, ...(restock ? { restockRetail: true } : {}) }).lines;
  const selectedLines = availableLines.filter(line => selected.includes(line.orderLineId) && line.qty > 0).map(line => ({ orderLineId: line.orderLineId, qty: line.qty }));
  const input: PosReversalInput = { paymentId, kind: operation, ...(scope === 'items' ? { lines: selectedLines } : {}), ...(scope === 'amount' ? { amount: Number(amount) } : {}), ...(restock ? { restockRetail: true } : {}) };
  const partialAmount = scope === 'amount' ? Number(amount) : undefined;
  const baseQuote = quoteReversal(read, input);
  const quote = balance && balance.methods.filter(m => m.amount > 0).length > 1 && baseQuote.issues.some(i => i.reason === 'METHOD_REQUIRED') && (partialAmount ?? baseQuote.amount) > 0
    ? quoteReversal(read, { ...input, methodAmounts: [{ method, amount: partialAmount ?? baseQuote.amount }] }) : baseQuote;
  const displayQuote = (phase === 'busy' || phase === 'done') && submittedQuote.current ? submittedQuote.current : quote;
  const issue = quote.issues[0];
  const reason = scope === 'items' && !selectedLines.length ? t('order.reversal.EMPTY_SELECTION') : issue ? t(issue.messageKey, { amount: formatPosMoney(quote.remaining) }) : undefined;
  const retail = receipt?.lines.some(line => read.data.catalog.items.some(item => item.menuId === line.menuId && item.kind === 'retail')) ?? false;
  const billDiscount = read.pos.bills.find(bill => bill.billId === receipt?.billId)?.discounts.some(discount => discount.scope === 'bill') ?? false;
  const correctionKind: 'cancel' | 'refund' = read.pos.orders.some(order => receipt?.orderNos.includes(order.orderNo) && order.preparation !== 'accepted') ? 'refund' : 'cancel';
  const confirm = () => {
    if (locked.current || !quote.canSubmit) return;
    locked.current = true; submittedQuote.current = quote; setPhase('busy'); setError('');
    const quoted = quote;
    schedule(() => {
      const latest = quoteReversal(runtime.read(), { ...input, ...(quote !== baseQuote ? { methodAmounts: quote.methods } : {}) });
      if (latest.quoteToken !== quoted.quoteToken) { locked.current = false; setError(t('receipt.changed')); setPhase('error'); return; }
      const result = runtime.execute({ type: 'payment.reverse', quoteToken: quoted.quoteToken, confirmed: true, meta: meta() });
      if (!result.ok) { locked.current = false; setError(result.reason === 'QUOTE_CHANGED' ? t('receipt.changed') : t(result.messageKey, { amount: formatPosMoney(quoted.remaining) })); setPhase('error'); return; }
      setPhase('done'); schedule(() => { locked.current = false; onClose(); }, posTimeTokens.payDoneMs);
    }, posTimeTokens.payApproveMs);
  };
  const runReceipt = (command: 'receipt.showAgain' | 'cashReceipt.issue' | 'cashReceipt.cancel') => {
    const result = command === 'receipt.showAgain' ? runtime.execute({ type: command, paymentId, meta: meta() })
      : command === 'cashReceipt.issue' ? runtime.execute({ type: command, paymentId, kind, identifier, meta: meta() })
      : receipt?.cashReceipt ? runtime.execute({ type: command, cashReceiptId: receipt.cashReceipt.cashReceiptId, meta: meta() }) : null;
    if (!result) return;
    if (!result.ok) { setError(t(result.messageKey)); return; }
    setIdentifier(''); setError(''); setIssuing(false); setNotice(command === 'receipt.showAgain' ? t('receipt.shown') : command === 'cashReceipt.issue' ? t('receipt.issued') : t('receipt.canceledIssue'));
  };
  if (!receipt) return <PosDialog open kind="receipt" title={t('receipt.receipt')} onClose={onClose} returnFocusRef={focus}><p role="alert">{t('pos.stateConflict')}</p></PosDialog>;
  if (view !== 'receipt') return <CorrectionConfirmation open operation={operation} amount={displayQuote.amount} methodLabel={displayQuote.methods.map(m => t(`pos.${m.method}`)).join(' · ')} phase={phase} error={error || t('receipt.failure')} reason={phase !== 'busy' && phase !== 'done' && !quote.canSubmit ? reason : undefined} onConfirm={confirm} onClose={onClose} returnFocusRef={focus} effects={<><p>{displayQuote.salesEffect === 'restore' ? t('receipt.restore') : t('receipt.keep')}</p>{displayQuote.couponEffect === 'restore' || displayQuote.membershipEffect === 'restore' ? <p>{t('receipt.benefits')}</p> : null}</>}>
    <fieldset disabled={phase === 'busy' || phase === 'done'}>
    <CategoryChips label={operation === 'cancel' ? t('receipt.cancel') : t('receipt.refund')} value={scope} options={[{ value: 'all', label: t('receipt.all') }, ...(!billDiscount ? [{ value: 'items' as const, label: t('receipt.items') }] : []), ...(operation === 'refund' ? [{ value: 'amount' as const, label: t('receipt.amount') }] : [])]} onChange={value => { setScope(value); setPhase('ready'); setError(''); }}/>
    {billDiscount ? <p>{t('order.reversal.WHOLE_BILL_DISCOUNT')}</p> : null}
    {scope === 'items' ? availableLines.filter(line => line.qty > 0).map(line => <ChecklistRow key={line.orderLineId} checked={selected.includes(line.orderLineId)} onCheckedChange={checked => setSelected(checked ? [...selected, line.orderLineId] : selected.filter(id => id !== line.orderLineId))}>{line.name} {line.qty} · <PosMoney amount={line.amount}/></ChecklistRow>) : null}
    {scope === 'amount' ? <NumberField label={t('receipt.amount')} min={0} value={amount === '' ? null : Number(amount)} onValueChange={value => setAmount(value === null ? '' : String(value))}/> : null}
    {balance && balance.methods.filter(m => m.amount > 0).length > 1 && scope !== 'all' ? <CategoryChips label={t('receipt.method')} value={method} options={balance.methods.filter(m => m.amount > 0).map(m => ({ value: m.method, label: t(`pos.${m.method}`) }))} onChange={setMethod}/> : null}
    {retail && operation === 'refund' ? <ChecklistRow checked={restock} onCheckedChange={setRestock}>{t('receipt.restock')}</ChecklistRow> : null}
    </fieldset>
  </CorrectionConfirmation>;
  return <PosDialog open kind="receipt" title={t('receipt.receipt')} onClose={onClose} returnFocusRef={focus} footer={<ActionButton variant="secondary" onClick={onClose}>{t('receipt.close')}</ActionButton>}>
    {notice ? <p role="status">{notice}</p> : null}
    {issuing ? <><SegmentedControl label={t('receipt.cashReceipt')} value={kind} options={[{value:'income',label:t('receipt.income')},{value:'business',label:t('receipt.business')}]} onChange={value => { setKind(value); setIdentifier(''); setError(''); }}/><TextField label={kind === 'income' ? t('receipt.phone') : t('receipt.businessNumber')} inputMode="numeric" value={identifier} onValueChange={setIdentifier} error={error || undefined}/><ActionButton onClick={() => runReceipt('cashReceipt.issue')}>{t('receipt.issueButton')}</ActionButton><ActionButton variant="secondary" onClick={() => { setIdentifier(''); setIssuing(false); setError(''); }}>{t('receipt.close')}</ActionButton></> : <>
      <h3 style={{ fontSize: 'var(--type-section)', lineHeight: 'var(--leading-section)' }}>{receipt.storeName}</h3>
      <dl className={posClasses.receipt}>
        <div className={posClasses.lineDetail}><dt>{t('receipt.at')}</dt><dd>{receiptTime(receipt.at)}</dd></div>
        <div className={posClasses.lineDetail}><dt>{t('receipt.orderNo')}</dt><dd>{receipt.orderNos.map(n => `#${n}`).join(' · ')}</dd></div>
        <div className={posClasses.lineDetail}><dt>{t('receipt.transaction')}</dt><dd>{receipt.transactionNo}</dd></div>
        {receipt.lines.map(line => <div key={line.orderLineId}>
          <dt className={posClasses.lineDetail}>{line.name} {line.qty}{line.options.length ? <p>{line.options.map(option => option.name).join(' · ')}</p> : null}{line.request ? <p>{t('pos.request', { text: line.request })}</p> : null}</dt>
          <dd><PosMoney amount={line.amount}/></dd>
        </div>)}
        <div className={posClasses.lineDetail}><dt>{t('pos.discount')}</dt><dd>{t('pos.discountComposition', { membership: format.money(receipt.discounts.find(d => d.source === 'membership')?.amount ?? 0, 'full'), coupon: format.money(receipt.discounts.find(d => d.source === 'coupon')?.amount ?? 0, 'full'), direct: format.money(receipt.discounts.find(d => d.source === 'direct')?.amount ?? 0, 'full') })}</dd></div>
        <div><dt>{t('receipt.amountPaid')}</dt><dd><PosMoney amount={receipt.amount} size="metric"/></dd></div>
        {receipt.splits.map(split => <div key={split.method}><dt>{t('receipt.paymentMethod')} · {t(`pos.${split.method}`)}</dt><dd><PosMoney amount={split.amount}/></dd></div>)}
        <div className={posClasses.lineDetail}><dt>{t('pos.paymentStatus')}</dt><dd>{t(`pos.${receipt.status}`)}</dd></div>
        <div className={posClasses.lineDetail}><dt>{t('receipt.approval')}</dt><dd>{receipt.approvalNo}</dd></div>
        {receipt.member ? <div className={posClasses.lineDetail}><dt>{t('receipt.member')}</dt><dd>{typeof receipt.member.name === 'string' ? receipt.member.name : resolveDataText(t, receipt.member.name)} · {receipt.member.phone}</dd></div> : null}
        {receipt.cashReceipt?.status === 'issued' ? <div className={posClasses.lineDetail}><dt>{t('receipt.cashReceipt')}</dt><dd>{receipt.cashReceipt.kind === 'income' ? t('receipt.income') : t('receipt.business')} · {receipt.cashReceipt.maskedIdentifier} · <PosMoney amount={receipt.cashReceipt.cashAmount}/></dd></div> : null}
        {receipt.corrections.map(correction => <div key={correction.correctionId} className="ui-pos-inline-error"><dt>{t(`receipt.${correction.kind}Status`)} · {receiptTime(correction.at)}</dt><dd><PosMoney amount={correction.amount} sign="minus"/></dd></div>)}
      </dl>
      <ActionButton variant="secondary" onClick={() => runReceipt('receipt.showAgain')}>{t('receipt.showAgain')}</ActionButton>
      {receipt.cashReceipt?.status === 'issued' ? <ActionButton variant="ghost" onClick={() => runReceipt('cashReceipt.cancel')}>{t('receipt.cancelIssue')}</ActionButton> : receipt.canIssueCashReceipt ? <ActionButton onClick={() => setIssuing(true)}>{t('receipt.issue')}</ActionButton> : null}
      {receipt.remaining > 0 ? <ActionButton variant="ghost" disabled={read.data.dayClosed} onClick={() => { setScope('all'); setView(correctionKind); }}>{correctionKind === 'cancel' ? t('receipt.cancel') : t('receipt.refund')}</ActionButton> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>}
  </PosDialog>;
}
