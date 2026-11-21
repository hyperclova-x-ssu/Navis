import { useEffect, useId, useRef, useState } from 'react';
import type { DetailRef } from '../../../contracts';
import { ActionButton, NumberField } from '../../../ui';
import { accountIssue, creditCopy, money, transactionLabel } from './copy';
import type { AccountMember, AccountTransaction, CreditPort, MemberReturnContext, OriginalMoneyTransaction } from './types';

/** An original exists when the transaction points at a settlement, an earlier transaction or a source record. */
export const hasOriginal = (transaction: OriginalMoneyTransaction) => !!(transaction.settlementId || transaction.originalTxnId || transaction.sourceRef);

export function AccountActions({ member, port, detailRef, initialPurpose, initialAmount = null, focusAmount }: {
  readonly member: AccountMember; readonly port: CreditPort; readonly detailRef: DetailRef;
  readonly initialPurpose?: string; readonly initialAmount?: number | null; readonly focusAmount?: boolean;
}) {
  const [amount, setAmount] = useState<number | null>(initialAmount), [error, setError] = useState('');
  const topup = useRef<HTMLButtonElement>(null), collection = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusAmount) input.current?.focus({ preventScroll: true });
  }, [focusAmount]);
  const reason = useId();
  const noDebt = member.receivableBalance <= 0;
  const open = (purpose: 'charge_topup' | 'receivable_collection') => {
    const issue = amount === null || !Number.isSafeInteger(amount) || amount <= 0 ? creditCopy.positive
      : purpose === 'receivable_collection' && amount > member.receivableBalance ? `남은 외상 금액 ${money(member.receivableBalance)}까지 수금할 수 있어요` : '';
    setError(issue);
    if (issue) { input.current?.focus(); return; }
    port.openSettlement({ purpose, memberId: member.memberId, amount: amount! }, { detailRef, selectedId: member.memberId, returnFocusRef: purpose === 'charge_topup' ? topup : collection });
  };
  return <div className="credit-stack" data-intent={initialPurpose}>
    <NumberField label="금액" name="account-amount" value={amount} onValueChange={value => { setAmount(value); setError(''); }} min={1} step={1} unit="원" error={error} inputRef={input} />
    <div className="credit-actions"><ActionButton ref={topup} onClick={() => open('charge_topup')}>충전하기</ActionButton><ActionButton ref={collection} variant="secondary" disabled={noDebt} aria-describedby={noDebt ? reason : undefined} onClick={() => open('receivable_collection')}>외상 수금하기</ActionButton></div>
    {noDebt && <p id={reason} className="credit-secondary">{creditCopy.noCollection}</p>}
  </div>;
}

export function OriginalTransactionButton({ transaction, port, detailRef, memberId }: { readonly transaction: AccountTransaction; readonly port: CreditPort; readonly detailRef: DetailRef; readonly memberId: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const context: MemberReturnContext = { detailRef, selectedId: memberId, returnFocusRef: button };
  const issue = accountIssue(transaction.reason);
  // A line without an original (an opening balance) says so instead of showing a dead button.
  return <>{hasOriginal(transaction)
    ? <ActionButton ref={button} variant="ghost" aria-label={`${transactionLabel(transaction)} ${money(transaction.amount)} 원거래 보기`} onClick={() => port.openOriginalTransaction(transaction, context)}>원거래 보기</ActionButton>
    : <p className="credit-secondary">원거래가 없어요</p>}{issue && <p role="status">{issue}</p>}</>;
}
