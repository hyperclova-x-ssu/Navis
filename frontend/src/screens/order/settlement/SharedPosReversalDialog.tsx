import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { CustomReversalQuote } from '../../../data/iteration7/custom-orders';
import { ActionButton, ErrorPanel, NumberField, PosDialog, PosMoney, ResultPanel, Spinner, formatPosMoney } from '../../../ui';
import type { SettlementPaymentPhase } from './SharedPosPaymentDialog';
import { realMethodLabels } from './SharedPosPaymentDialog';
import { settlementIssue } from './copy';

export interface MoneyReversalView {
  readonly quoteId: string; readonly quoteRevision: number; readonly kind: 'cancel' | 'refund';
  readonly amount: number; readonly remainingRefundable: number; readonly canSubmit: boolean;
  readonly realMethodReturns: CustomReversalQuote['realMethodReturns'];
  readonly recognitionEffects: readonly { readonly recognitionId: string; readonly amount: number }[];
  readonly accountEffects: readonly { readonly account: 'charge' | 'receivable'; readonly amount: number }[];
  readonly membershipEffects: readonly { readonly useId: string; readonly canceledAt: string | null }[];
  readonly issues: readonly { readonly reason?: string; readonly details?: Readonly<Record<string, unknown>> }[];
}
interface CommonProps {
  readonly open: boolean; readonly phase: SettlementPaymentPhase; readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly cancelOrder?: boolean; readonly onClose: () => void; readonly onAmountChange?: (amount: number | null) => void; readonly onRetry?: () => void;
  readonly selection?: ReactNode;
}
export interface SharedPosReversalDialogProps extends CommonProps {
  readonly mode?: 'real'; readonly quote: CustomReversalQuote; readonly onConfirm: (quote: CustomReversalQuote) => boolean;
}
export interface MoneyReversalDialogProps<Q extends MoneyReversalView = MoneyReversalView> extends CommonProps {
  readonly mode: 'money'; readonly quote: Q; readonly onConfirm: (quote: Q) => boolean;
}
type ReversalView = Omit<MoneyReversalView, 'kind' | 'accountEffects' | 'membershipEffects'> & {
  readonly kind: 'cancel' | 'cancellation' | 'refund'; readonly accountEffects?: MoneyReversalView['accountEffects']; readonly membershipEffects?: MoneyReversalView['membershipEffects'];
};

/** The common host supplies the original-source quote and commits its atomic correction. */
export function SharedPosReversalDialog<Q extends MoneyReversalView = MoneyReversalView>(props: SharedPosReversalDialogProps | MoneyReversalDialogProps<Q>) {
  if (props.mode === 'money') return <ReversalPresentation {...props}/>;
  return <ReversalPresentation {...props}/>;
}
function ReversalPresentation<Q extends ReversalView>({ open, quote, phase, returnFocusRef, cancelOrder = false, onConfirm, onClose, onAmountChange, onRetry, selection }: CommonProps & { readonly quote: Q; readonly onConfirm: (quote: Q) => boolean }) {
  const confirm = useRef<HTMLButtonElement>(null), submitting = useRef(false), submitted = useRef<Q | null>(null);
  const busy = phase.status === 'pending', done = phase.status === 'succeeded';
  useLayoutEffect(() => { if (!open || phase.status === 'failed' || phase.status === 'ready') submitting.current = false; }, [open, phase.status]);
  const display = (busy || done) && submitted.current ? submitted.current : quote;
  const refund = display.kind === 'refund';
  return <PosDialog open={open} kind="confirm" title={refund ? '환불' : '결제 취소'} description="원래 결제 수단으로 돌려드려요" returnFocusRef={returnFocusRef} initialFocusRef={confirm} busy={busy} onClose={() => { if (!busy) onClose(); }}>
    <div className="shared-settlement" lang="ko">
      {done ? <ResultPanel title={refund ? '환불했어요' : '취소했어요'}><ActionButton onClick={onClose}>닫기</ActionButton></ResultPanel>
        : phase.status === 'failed' ? <ErrorPanel title={settlementIssue(phase.reason, phase.details)} actions={onRetry ? <ActionButton onClick={() => { submitting.current = false; onRetry(); }}>다시 시도</ActionButton> : <ActionButton onClick={onClose}>닫기</ActionButton>} />
        : <>
          {selection}
          <PosMoney amount={display.amount} size="display" />
          <dl>{display.realMethodReturns.map(row => <div key={row.method}><dt>{realMethodLabels[row.method]}</dt><dd><PosMoney amount={row.amount}/></dd></div>)}</dl>
          {onAmountChange && refund ? <NumberField label="환불 금액" min={1} max={quote.remainingRefundable} value={quote.amount} disabled={busy} onValueChange={onAmountChange} unit="원"/> : null}
          <ReversalAccountEffects quote={display}/>
          {display.recognitionEffects.map(effect => <p key={effect.recognitionId}>매출 반영 <PosMoney amount={effect.amount}/></p>)}
          {cancelOrder && <p>연결된 주문제작과 픽업 예약도 함께 취소해요</p>}
          {!!quote.issues.length && <p role="alert">{quote.issues.map(issue => settlementIssue(issue.reason ?? '', issue.details)).join(' · ')}</p>}
          <ActionButton ref={confirm} size="primary" disabled={busy || !quote.canSubmit} aria-busy={busy || undefined} onClick={() => { if (submitting.current || busy || !quote.canSubmit) return; submitting.current = true; submitted.current = quote; if (!onConfirm(quote)) submitting.current = false; }}>{busy ? <><Spinner/>처리 중이에요</> : refund ? '환불 확정하기' : '취소 확정하기'}</ActionButton>
        </>}
    </div>
  </PosDialog>;
}
export function ReversalAccountEffects({ quote }: { readonly quote: Pick<ReversalView, 'accountEffects' | 'membershipEffects'> }) {
  return <>
    {quote.accountEffects?.map((effect, index) => <p key={index}>{effect.account === 'charge'
      ? `충전금 잔액 ${formatPosMoney(Math.abs(effect.amount))}${effect.amount >= 0 ? '이 돌아가요' : '이 줄어들어요'}`
      : `미수금 ${formatPosMoney(Math.abs(effect.amount))}${effect.amount >= 0 ? '이 돌아가요' : '이 줄어들어요'}`}</p>)}
    {quote.membershipEffects?.filter(effect => effect.canceledAt !== null).map(effect => <p key={effect.useId}>회원권 1회가 돌아가요</p>)}
  </>;
}
