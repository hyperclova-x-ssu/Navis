import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CustomMethodAllocation, CustomSettlementQuote } from '../../../data/iteration7/custom-orders';
import type { SettlementAllocation, SettlementQuote, SettlementTarget as MoneyTarget } from '../../../data/iteration7/accounting/types';
import { ActionButton, ErrorPanel, NumberField, PosDialog, PosMoney, ResultPanel, Spinner, posClasses } from '../../../ui';
import { settlementIssue } from './copy';
import './settlement.css';

export type RealMethod = CustomMethodAllocation['method'];
export type RealAllocation = CustomMethodAllocation;
/** Kept narrow for the M2 custom host; M3 targets come from API-276. */
export type SettlementTarget = CustomSettlementQuote['target'];
export type SettlementPaymentQuote = Pick<CustomSettlementQuote, 'quoteId' | 'quoteRevision' | 'amountDue' | 'allocations' | 'remaining' | 'canSubmit' | 'issues'>;
export interface MoneyPaymentQuote {
  readonly quoteId: string; readonly quoteRevision: number; readonly amountDue: number;
  readonly allocations: readonly SettlementAllocation[]; readonly remaining: number; readonly canSubmit: boolean;
  readonly issues: readonly { readonly reason?: string; readonly details?: Readonly<Record<string, unknown>> }[];
  readonly discounts?: SettlementQuote['discounts']; readonly recognitionEffects?: SettlementQuote['recognitionEffects'];
  readonly membershipEffects?: SettlementQuote['membershipEffects']; readonly collectionSources?: SettlementQuote['collectionSources'];
}
export type SettlementPaymentPhase = { readonly status: 'ready' } | { readonly status: 'pending' }
  | { readonly status: 'succeeded'; readonly settlementId?: string } | { readonly status: 'failed'; readonly reason: string; readonly details?: Readonly<Record<string, unknown>> };
export interface SettlementMember {
  readonly memberId: string; readonly label: string; readonly chargeBalance: number; readonly receivableBalance: number;
  readonly accountBalancesAvailable?: boolean;
}
interface CommonProps {
  readonly open: boolean; readonly summary: string; readonly phase: SettlementPaymentPhase;
  readonly returnFocusRef: RefObject<HTMLElement | null>; readonly onReset: () => void; readonly onClose: () => void;
}
interface PaymentReview<Q> {
  readonly label: string;
  readonly fields: ReactNode;
  readonly pendingLabel: string;
  readonly failure?: { readonly title: string; readonly description?: string; readonly retryLabel: string; readonly canChangeMethod: boolean };
  readonly onRetry: (quote: Q) => void;
}
export interface SharedPosPaymentDialogProps extends CommonProps {
  readonly mode?: 'real'; readonly target: SettlementTarget; readonly quote: SettlementPaymentQuote;
  readonly onAllocationsChange: (allocations: readonly RealAllocation[]) => SettlementPaymentQuote;
  readonly onApprove: (quote: SettlementPaymentQuote) => boolean;
}
export interface MoneyPaymentDialogProps<Q extends MoneyPaymentQuote = MoneyPaymentQuote> extends CommonProps {
  readonly mode: 'money'; readonly target: MoneyTarget; readonly quote: Q; readonly member?: SettlementMember | null;
  readonly onAllocationsChange: (allocations: readonly SettlementAllocation[]) => Q;
  /** The root coordinator owns approval, zero-money commits and scheduling. */
  readonly onApprove: (quote: Q) => boolean;
  readonly tools?: ReactNode;
  readonly subview?: { readonly title: string; readonly content: ReactNode; readonly onBack: () => void };
  readonly result?: { readonly title: string; readonly description?: string; readonly action?: string };
  readonly review?: PaymentReview<Q>;
}
export const realMethods: readonly RealMethod[] = ['card', 'easy_pay', 'cash'];
export const realMethodLabels: Record<RealMethod, string> = { card: '카드', easy_pay: '간편결제', cash: '현금' };
export const realAllocations = (rows: readonly SettlementAllocation[]): readonly RealAllocation[] => rows.flatMap(row => row.kind === 'method' && row.method ? [{ kind: 'method' as const, method: row.method, amount: row.amount }] : []);
const titleFor = (purpose: MoneyTarget['purpose']) => ({ sale: '결제', custom_order: '주문제작 결제', charge_topup: '충전금 충전', receivable_collection: '외상 수금', membership_sale: '회원권 판매' })[purpose];
const doneFor = (purpose: MoneyTarget['purpose']) => ({ sale: '결제를 완료했어요', custom_order: '결제를 완료했어요', charge_topup: '충전했어요', receivable_collection: '외상을 수금했어요', membership_sale: '회원권을 판매했어요' })[purpose];

/** M2 and M3 use one presentation; the M2 host retains its real-method contract. */
/** K-E 10: the collection line says how much of the member's 외상 is collected now ('외상 10,000원 중 5,000원'), never the internal transaction id. */
function collectionLine(sources: readonly { readonly amount: number }[], member?: SettlementMember | null): ReactNode {
  const collected = sources.reduce((sum, source) => sum + source.amount, 0);
  return member && member.receivableBalance > collected
    ? <>외상 <PosMoney amount={member.receivableBalance} /> 중 <PosMoney amount={collected} /></>
    : <>외상 <PosMoney amount={collected} /></>;
}
export function SharedPosPaymentDialog<Q extends MoneyPaymentQuote = MoneyPaymentQuote>(props: SharedPosPaymentDialogProps | MoneyPaymentDialogProps<Q>) {
  if (props.mode === 'money') return <PaymentPresentation {...props}/>;
  return <PaymentPresentation {...props} mode="real" onAllocationsChange={rows => props.onAllocationsChange(realAllocations(rows))}/>;
}

function PaymentPresentation<Q extends MoneyPaymentQuote>(props: CommonProps & {
  readonly mode: 'real' | 'money'; readonly target: MoneyTarget; readonly quote: Q; readonly member?: SettlementMember | null;
  readonly onAllocationsChange: (allocations: readonly SettlementAllocation[]) => Q; readonly onApprove: (quote: Q) => boolean; readonly tools?: ReactNode;
  readonly subview?: MoneyPaymentDialogProps['subview']; readonly result?: MoneyPaymentDialogProps['result']; readonly review?: PaymentReview<Q>;
}) {
  const { quote, phase } = props;
  const [mixed, setMixed] = useState(false);
  const first = useRef<HTMLButtonElement>(null), submitted = useRef(false);
  const busy = phase.status === 'pending', done = phase.status === 'succeeded', blocked = busy || done;
  useLayoutEffect(() => { if (!props.open || phase.status === 'failed' || phase.status === 'ready') submitted.current = false; }, [props.open, phase.status]);
  const issues = quote.issues.filter(issue => issue.reason !== 'ALLOCATION_SUM_MISMATCH' || quote.allocations.length > 0);
  const change = (rows: readonly SettlementAllocation[]) => { submitted.current = false; return props.onAllocationsChange(rows); };
  const approve = (current: Q = quote) => {
    if (submitted.current || blocked || !current.canSubmit) return;
    submitted.current = true;
    if (!props.onApprove(current)) submitted.current = false;
  };
  const reset = () => { submitted.current = false; props.onReset(); };
  const accountRows = quote.allocations.filter(row => row.kind !== 'method');
  const realDue = quote.amountDue - accountRows.reduce((sum, row) => sum + row.amount, 0);
  const zero = quote.amountDue === 0;
  const title = props.mode === 'money' ? titleFor(props.target.purpose) : '결제';
  return <PosDialog open={props.open} kind="pay" title={props.subview?.title ?? title} description={props.summary} returnFocusRef={props.returnFocusRef} initialFocusRef={first}
    busy={busy} headerAction={props.subview ? <ActionButton variant="ghost" onClick={props.subview.onBack}>결제로 돌아가기</ActionButton> : undefined}
    onClose={reason => { if (!busy) { if (reason === 'Esc' && props.subview) props.subview.onBack(); else props.onClose(); } }}>
    <div className="order-payment shared-settlement" data-purpose={props.target.purpose} lang="ko">
      <div className="order-payment__amount"><PosMoney amount={quote.amountDue} size="display" /><p>결제할 금액</p><p className="order-payment__summary">{props.summary}</p></div>
      {props.subview ? props.subview.content : done ? <ResultPanel title={props.result?.title ?? doneFor(props.target.purpose)} description={props.result?.description ?? (props.target.purpose === 'custom_order' ? '주문 진행 상태와 결제 상태를 따로 기록했어요' : undefined)}><ActionButton onClick={props.onClose}>{props.result?.action ?? '닫기'}</ActionButton></ResultPanel>
        : phase.status === 'failed' ? <ErrorPanel title={props.review?.failure?.title ?? settlementIssue(phase.reason, phase.details)} description={props.review?.failure?.description}
          actions={<><ActionButton onClick={() => { if (props.review) props.review.onRetry(quote); else { reset(); approve(); } }}>{props.review?.failure?.retryLabel ?? '다시 시도'}</ActionButton>
            {props.review?.failure?.canChangeMethod !== false && <ActionButton variant="secondary" onClick={() => { reset(); change(props.review ? [] : accountRows); setMixed(false); }}>다른 결제 수단</ActionButton>}</>} />
        : <>
          {props.mode === 'money' && <>
            {props.member && <p className="pay-tools__member">{!props.review && `${props.member.memberId} `}{props.member.label}{props.member.accountBalancesAvailable !== false && <> · 충전금 잔액 <PosMoney amount={props.member.chargeBalance}/></>}</p>}
            {props.tools}
            <SettlementAllocationFields target={props.target} quote={quote} member={props.member} disabled={blocked} wholeTender={!!props.review} onChange={change}/>
            <MembershipSettlementEffects quote={quote}/>
            {!!quote.collectionSources?.length && <section aria-label="수금할 외상 내역"><p lang="ko">{collectionLine(quote.collectionSources, props.member)}</p></section>}
          </>}
          {!zero && <>
            <div className={posClasses.methods} role="group" aria-label="실제 결제 수단">{realMethods.map((method, index) => <ActionButton key={method} ref={index === 0 ? first : undefined} className={posClasses.method} disabled={blocked || (props.review ? quote.amountDue : realDue) <= 0} aria-busy={!props.review && busy && !mixed && quote.allocations.some(row => row.kind === 'method' && row.method === method) || undefined}
              onKeyDown={event => { if (blocked || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button'); buttons?.[(index + (event.key === 'ArrowRight' ? 1 : -1) + realMethods.length) % realMethods.length]?.focus(); }}
              aria-pressed={props.review ? quote.allocations.some(row => row.kind === 'method' && row.method === method) : undefined}
              onClick={() => { if (submitted.current || blocked) return; setMixed(false); const next = change([...(props.review ? [] : accountRows), { kind: 'method', method, amount: props.review ? quote.amountDue : realDue }]); if (!props.review) approve(next); }}>{!props.review && busy && !mixed && quote.allocations.some(row => row.kind === 'method' && row.method === method) ? <><Spinner />승인 중이에요</> : realMethodLabels[method]}</ActionButton>)}</div>
            {!props.review && <ActionButton variant="secondary" aria-expanded={mixed} disabled={blocked || realDue <= 0} onClick={() => { setMixed(!mixed); change(accountRows); }}>여러 수단으로 내기</ActionButton>}
          </>}
          {mixed && realDue > 0 ? <section className="shared-settlement__mixed" aria-label="여러 수단으로 내기">{realMethods.map(method => <div key={method} className="pay-tools__row"><NumberField label={realMethodLabels[method]} min={0} unit="원" disabled={blocked} value={quote.allocations.find(row => row.kind === 'method' && row.method === method)?.amount ?? null} onValueChange={amount => change([...quote.allocations.filter(row => row.kind !== 'method' || row.method !== method), ...(amount !== null && amount > 0 ? [{ kind: 'method' as const, method, amount }] : [])])} /><ActionButton variant="ghost" disabled={blocked} aria-label={`${realMethodLabels[method]} 남은 금액 넣기`} onClick={() => {
            const amount = Math.max(0, realDue - quote.allocations.filter(row => row.kind === 'method' && row.method !== method).reduce((sum, row) => sum + row.amount, 0));
            change([...quote.allocations.filter(row => row.kind !== 'method' || row.method !== method), ...(amount > 0 ? [{ kind: 'method' as const, method, amount }] : [])]);
          }}>남은 금액 넣기</ActionButton></div>)}</section> : null}
          {props.mode === 'money' || mixed ? <p role="status">남은 금액 <PosMoney amount={quote.remaining}/></p> : null}
          {!!issues.length && <p role="alert">{issues.map(issue => settlementIssue(issue.reason ?? '', issue.details)).join(' · ')}</p>}
          {props.review ? quote.allocations.length > 0 && <div className="pay-tools__stack">{props.review.fields}
            <ActionButton size="primary" disabled={blocked || !quote.canSubmit} aria-busy={busy || undefined} onClick={() => approve()}>{busy ? <><Spinner />{props.review.pendingLabel}</> : props.review.label}</ActionButton>
          </div> : (mixed || realDue === 0 || zero) && <ActionButton ref={realDue === 0 ? first : undefined} size="primary" disabled={blocked || !quote.canSubmit} aria-busy={busy || undefined} onClick={() => approve()}>{busy ? <><Spinner />승인 중이에요</> : zero && props.target.purpose === 'sale' ? '0원으로 주문하기' : '결제하기'}</ActionButton>}
        </>}
    </div>
  </PosDialog>;
}

/** Account sources stay outside the three method buttons, including for each split share. */
export function SettlementAllocationFields({ target, quote, member, disabled, wholeTender = false, onChange }: {
  readonly target: MoneyTarget; readonly quote: MoneyPaymentQuote; readonly member?: SettlementMember | null; readonly disabled: boolean; readonly wholeTender?: boolean;
  readonly onChange: (allocations: readonly SettlementAllocation[]) => unknown;
}) {
  if (target.purpose !== 'sale' && target.purpose !== 'custom_order') return null;
  const replace = (kind: 'charge' | 'receivable', amount: number | null) => onChange([
    ...quote.allocations.filter(row => row.kind !== kind && row.kind !== 'method'),
    ...(amount !== null && amount > 0 ? [{ kind, amount }] : []),
  ]);
  const available = (kind: 'charge' | 'receivable') => Math.max(0, quote.amountDue - quote.allocations.filter(row => row.kind !== 'method' && row.kind !== kind).reduce((sum, row) => sum + row.amount, 0));
  // UXP-11: a walk-in has nothing to settle against, so the two disabled number fields and their buttons are not drawn at all;
  // one muted line says how to unlock them. They appear (full group) once a member is linked.
  if (!member) return <p className="shared-settlement__note">충전금·외상 정산은 회원을 먼저 연결해 주세요</p>;
  if (wholeTender) return <section role="group" aria-label="정산 유형" className="shared-settlement__mixed">
    <h3>정산 유형</h3>
    <div className="pay-tools__row">
      <ActionButton variant="secondary" disabled={disabled || member.accountBalancesAvailable === false || member.chargeBalance < quote.amountDue} aria-pressed={quote.allocations[0]?.kind === 'charge'} onClick={() => onChange([{ kind: 'charge', amount: quote.amountDue }])}>충전 잔액</ActionButton>
      <ActionButton variant="secondary" disabled={disabled} aria-pressed={quote.allocations[0]?.kind === 'receivable'} onClick={() => onChange([{ kind: 'receivable', amount: quote.amountDue }])}>외상</ActionButton>
    </div>
    {member.accountBalancesAvailable !== false && <p>현재 외상 <PosMoney amount={member.receivableBalance}/></p>}
  </section>;
  return <section role="group" aria-label="정산 유형" className="shared-settlement__mixed">
    <h3>정산 유형</h3>
    <div className="pay-tools__row"><NumberField label="충전금 사용" min={0} unit="원" disabled={disabled || !member} value={quote.allocations.find(row => row.kind === 'charge')?.amount ?? null} onValueChange={amount => replace('charge', amount)}/><ActionButton variant="secondary" disabled={disabled || !member} onClick={() => replace('charge', Math.min(member?.chargeBalance ?? 0, available('charge')))}>전액 넣기</ActionButton></div>
    <div className="pay-tools__row"><NumberField label="외상 정산" min={0} unit="원" disabled={disabled || !member} value={quote.allocations.find(row => row.kind === 'receivable')?.amount ?? null} onValueChange={amount => replace('receivable', amount)}/><ActionButton variant="secondary" disabled={disabled || !member} onClick={() => replace('receivable', available('receivable'))}>나머지 외상</ActionButton></div>
  </section>;
}

export function MembershipSettlementEffects({ quote }: { readonly quote: MoneyPaymentQuote }) {
  if (!quote.membershipEffects?.length) return null;
  return <section aria-label="회원권 정산" className="shared-settlement__mixed">
    {quote.membershipEffects.map(use => <div key={use.useId}><p>회원권 이용분 <PosMoney amount={use.recognizedAmount}/></p><p>회원권 할인 <PosMoney amount={use.membershipDiscount}/></p></div>)}
  </section>;
}
