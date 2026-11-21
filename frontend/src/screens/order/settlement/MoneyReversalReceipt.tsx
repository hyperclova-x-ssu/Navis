import { useRef, useState, type RefObject } from 'react';
import type { selectMoneyReceipt } from '../../../data/iteration7/accounting/selectors';
import type { MoneyReversalQuote } from '../../../data/iteration7/accounting/types';
import { dataBundles, resolveDataText } from '../../../data/widget-data';
import { ActionButton, CategoryChips, ChecklistRow, ErrorPanel, NumberField, PosDialog, PosMoney, SegmentedControl, TextField, posClasses } from '../../../ui';
import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
import { usePosSession, usePosSnapshot } from '../../../pos/react';
import { selectReceipt } from '../../../pos/reversals';
import { receiptBundle } from '../messages';
import { ReversalAccountEffects, SharedPosReversalDialog } from './SharedPosReversalDialog';
import { realMethodLabels, type SettlementPaymentPhase } from './SharedPosPaymentDialog';

export type MoneyReceipt = NonNullable<ReturnType<typeof selectMoneyReceipt>>;
export interface MoneyReversalReceiptEntry { readonly settlementId: string; readonly view: 'receipt' | 'cancel' | 'refund' }
export interface MoneyReceiptController {
  readonly receipt: MoneyReceipt | null; readonly phase: SettlementPaymentPhase;
  readonly quoteReversal: (input: MoneyReversalQuote['input']) => MoneyReversalQuote;
  readonly onConfirm: (quote: MoneyReversalQuote) => boolean; readonly onReset: () => void;
}
export interface MoneyReversalReceiptProps {
  readonly settlementId: string; readonly initialView: MoneyReversalReceiptEntry['view']; readonly money: MoneyReceiptController;
  readonly onClose: () => void; readonly returnFocusRef?: RefObject<HTMLElement | null>;
}
const allocationLabels = { charge: '충전금 사용', receivable: '외상 정산', membership_count: '회원권 이용분', membership_period: '구독권 이용' };
type ReversalScope = 'all' | 'items' | 'amount';

/** A settlement receipt exists even when no real payment or approval number exists. */
export function MoneyReversalReceipt({ settlementId, initialView, money, onClose, returnFocusRef }: MoneyReversalReceiptProps) {
  const runtime = usePosSession(), read = usePosSnapshot();
  const { t, format } = useBundle(posBundle, receiptBundle, ...dataBundles);
  const receiptTime = (at: string) => `${format.date(at.slice(0, 10), 'long')} · ${format.time(at.slice(11, 16))}`;
  const [view, setView] = useState(initialView), [amount, setAmount] = useState<number | null>(null);
  const [scope, setScope] = useState<ReversalScope>('all');
  const [selected, setSelected] = useState<Readonly<Record<string, number | null>>>({});
  const [issuing, setIssuing] = useState(false), [cashKind, setCashKind] = useState<'income' | 'business'>('income');
  const [identifier, setIdentifier] = useState(''), [receiptError, setReceiptError] = useState(''), [notice, setNotice] = useState('');
  const identifierInput = useRef<HTMLInputElement>(null);
  const localFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const focus = returnFocusRef ?? localFocus, receipt = money.receipt;
  if (!receipt || receipt.settlementId !== settlementId) return <PosDialog open kind="receipt" title="영수증" returnFocusRef={focus} onClose={onClose}><ErrorPanel title="결제 정보를 불러오지 못했어요" actions={<ActionButton onClick={onClose}>닫기</ActionButton>}/></PosDialog>;
  const lines = receipt.reversalLines.filter(line => line.quantity > 0);
  // K-E 10: the on-screen number is the order's own number (B-029), never the internal settlement id. A charge or collection that belongs to no order has none, so the row is left out.
  const orderNo = receipt.billId ?? (settlementId.startsWith('seed:') ? settlementId.slice('seed:'.length) : null);
  const cancelable = lines.some(line => !line.prepared), refundable = lines.some(line => line.prepared);
  const mixedPreparation = cancelable && refundable;
  if (view !== 'receipt') {
    const kind = view;
    const itemScope = receipt.purpose === 'sale' && lines.length > 0 && !receipt.wholeBillDiscount;
    const amountScope = kind === 'refund' && !mixedPreparation && receipt.purpose !== 'charge_topup' && receipt.purpose !== 'membership_sale';
    const effectiveScope = mixedPreparation && itemScope ? 'items' : scope;
    const quote = money.quoteReversal({ settlementId, kind,
      ...(effectiveScope === 'items' ? { lines: lines.filter(line => selected[line.allocationId] !== undefined).map(line => ({ allocationId: line.allocationId, quantity: selected[line.allocationId] ?? 0 })) } : {}),
      ...(effectiveScope === 'amount' ? { amount: amount ?? 0 } : {}),
    });
    const busy = money.phase.status === 'pending';
    const lineName = (line: typeof lines[number]) => typeof line.name === 'string' ? line.name : line.name ? resolveDataText(t, line.name) : line.menuId;
    const selection = <fieldset className="shared-settlement__selection" disabled={busy}>
      <legend className="ui-sr-only">취소·환불 범위</legend>
      <CategoryChips label={kind === 'refund' ? '환불 범위' : '취소 범위'} value={effectiveScope} options={[
        ...(!mixedPreparation || !itemScope ? [{ value: 'all' as const, label: '전체' }] : []),
        ...(itemScope ? [{ value: 'items' as const, label: '품목 고르기' }] : []),
        ...(amountScope ? [{ value: 'amount' as const, label: '금액 넣기' }] : []),
      ]} onChange={value => { setScope(value); money.onReset(); }}/>
      {receipt.wholeBillDiscount && <p>주문 전체에 할인이 들어가 있어 전체 취소만 할 수 있어요</p>}
      {effectiveScope === 'items' && lines.map(line => <div key={line.allocationId} className="shared-settlement__mixed">
        <ChecklistRow checked={selected[line.allocationId] !== undefined} disabled={line.prepared !== (kind === 'refund')} onCheckedChange={checked => setSelected(current => {
          const next = { ...current };
          if (checked) next[line.allocationId] = line.quantity;
          else delete next[line.allocationId];
          return next;
        })}>{lineName(line)} {line.quantity}</ChecklistRow>
        {selected[line.allocationId] !== undefined && <NumberField label={`${lineName(line)} 취소·환불 수량`} name={`reversal-quantity-${line.allocationId}`} min={1} max={line.quantity} step={1} value={selected[line.allocationId] ?? null} onValueChange={value => setSelected(current => ({ ...current, [line.allocationId]: value }))} />}
      </div>)}
    </fieldset>;
    return <SharedPosReversalDialog mode="money" open quote={quote} phase={money.phase} returnFocusRef={focus} onConfirm={money.onConfirm} onClose={onClose} onRetry={money.onReset}
      selection={selection} onAmountChange={effectiveScope === 'amount' && amountScope ? setAmount : undefined}/>;
  }
  const reversible = receipt.remainingRefundable > 0 || receipt.membershipEffects.some(use => !use.canceledAt);
  const paymentReceipt = receipt.paymentId ? selectReceipt(read, { paymentId: receipt.paymentId }) : null;
  const cashReceipt = paymentReceipt?.cashReceipt;
  const runReceipt = (command: 'receipt.showAgain' | 'cashReceipt.issue' | 'cashReceipt.cancel') => {
    const meta = { runId: read.runId, idempotencyKey: `money-receipt:${crypto.randomUUID()}` };
    const paymentId = receipt.paymentId;
    const result = command === 'receipt.showAgain' && paymentId ? runtime.execute({ type: command, paymentId, meta })
      : command === 'cashReceipt.issue' && paymentId ? runtime.execute({ type: command, paymentId, kind: cashKind, identifier, meta })
      : command === 'cashReceipt.cancel' && cashReceipt ? runtime.execute({ type: command, cashReceiptId: cashReceipt.cashReceiptId, meta }) : null;
    if (result && !result.ok) { setNotice(''); setReceiptError(t(result.messageKey)); if (command === 'cashReceipt.issue') identifierInput.current?.focus(); return; }
    if (!result && command !== 'receipt.showAgain') return;
    setIdentifier(''); setReceiptError(''); setIssuing(false);
    setNotice(t(command === 'receipt.showAgain' ? 'receipt.shown' : command === 'cashReceipt.issue' ? 'receipt.issued' : 'receipt.canceledIssue'));
  };
  const correctionKinds: readonly ('cancel' | 'refund')[] = receipt.purpose === 'sale'
    ? [...(cancelable || !lines.length ? ['cancel' as const] : []), ...(refundable ? ['refund' as const] : [])]
    : [receipt.purpose === 'membership_sale' || receipt.currentPrepared ? 'refund' : 'cancel'];
  const openReversal = (kind: 'cancel' | 'refund') => { money.onReset(); setAmount(null); setScope('all'); setSelected({}); setView(kind); };
  return <PosDialog open kind="receipt" title="영수증" returnFocusRef={focus} onClose={onClose} footer={<ActionButton variant="secondary" onClick={onClose}>닫기</ActionButton>}>
    <div lang="ko" className="shared-settlement">
      {notice && <p role="status">{notice}</p>}
      {issuing ? <>
        <SegmentedControl label={t('receipt.cashReceipt')} value={cashKind} options={[{ value: 'income', label: t('receipt.income') }, { value: 'business', label: t('receipt.business') }]} onChange={value => { setCashKind(value); setIdentifier(''); setReceiptError(''); }}/>
        <TextField label={t(cashKind === 'income' ? 'receipt.phone' : 'receipt.businessNumber')} name="cash-receipt-identifier" inputRef={identifierInput} inputMode="numeric" value={identifier} onValueChange={value => { setIdentifier(value); setReceiptError(''); }} error={receiptError || undefined}/>
        <ActionButton onClick={() => runReceipt('cashReceipt.issue')}>{t('receipt.issueButton')}</ActionButton>
        <ActionButton variant="secondary" onClick={() => { setIssuing(false); setIdentifier(''); setReceiptError(''); }}>{t('receipt.close')}</ActionButton>
      </> : <>
      <dl className={posClasses.receipt}>
        {orderNo && <div><dt>정산 거래번호</dt><dd>{orderNo}</dd></div>}
        <div><dt>거래 일시</dt><dd>{receiptTime(receipt.at)}</dd></div>
        <div><dt>정산 금액</dt><dd><PosMoney amount={receipt.amount}/></dd></div>
        <div><dt>실제 입금</dt><dd><PosMoney amount={receipt.payment?.amount ?? 0}/></dd></div>
        {receipt.payment?.splits.map(row => <div key={row.method}><dt>{realMethodLabels[row.method]}</dt><dd><PosMoney amount={row.amount}/></dd></div>)}
        {receipt.allocations.filter(row => row.kind !== 'method').map((row, index) => <div key={row.allocationId ?? index}><dt>{row.kind === 'method' ? '' : allocationLabels[row.kind]}</dt><dd><PosMoney amount={row.amount}/></dd></div>)}
        {receipt.membershipEffects.map(use => <div key={use.useId}><dt>회원권 할인</dt><dd><PosMoney amount={use.membershipDiscount}/></dd></div>)}
      </dl>
      {cashReceipt && <p>{cashReceipt.status === 'issued' ? `${t('receipt.cashReceipt')} ${t(cashReceipt.kind === 'income' ? 'receipt.income' : 'receipt.business')} · ${cashReceipt.maskedIdentifier}` : t('receipt.canceledIssue')}</p>}
      {!!receipt.corrections.length && <section aria-label="취소·환불 내역">{receipt.corrections.map(correction => <div key={correction.correctionId}><p>{correction.kind === 'refund' ? '환불' : '결제 취소'} · {receiptTime(correction.at)} · <PosMoney amount={correction.amount} sign="minus"/></p>{correction.realMethodReturns.map(row => <p key={row.method}>{realMethodLabels[row.method]} <PosMoney amount={row.amount} sign="minus"/></p>)}<ReversalAccountEffects quote={correction}/></div>)}</section>}
      <ActionButton variant="secondary" onClick={() => runReceipt('receipt.showAgain')}>{t('receipt.showAgain')}</ActionButton>
      {cashReceipt?.status === 'issued' ? <ActionButton variant="ghost" onClick={() => runReceipt('cashReceipt.cancel')}>{t('receipt.cancelIssue')}</ActionButton> : paymentReceipt?.canIssueCashReceipt ? <ActionButton onClick={() => { setNotice(''); setIssuing(true); }}>{t('receipt.issue')}</ActionButton> : null}
      {receiptError && <p role="alert">{receiptError}</p>}
      {reversible && correctionKinds.map(kind => <ActionButton key={kind} variant="ghost" onClick={() => openReversal(kind)}>{t(kind === 'refund' ? 'receipt.refund' : 'receipt.cancel')}</ActionButton>)}
      </>}
    </div>
  </PosDialog>;
}
