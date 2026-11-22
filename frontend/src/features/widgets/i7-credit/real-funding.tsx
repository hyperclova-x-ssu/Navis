import { useEffect, useRef, useState } from 'react';
import type { WidgetHost } from '../../../contracts';
import type { PosMethodSplit } from '../../../contracts/pos';
import { readAppClock } from '../../../data/db/app-clock';
import { commandFailureText } from '../../../data/commands/failure-copy';
import type { SettlementAllocation } from '../../../data/iteration7/accounting/types';
import { PortError, type CommandReceipt, type RealPort } from '../../../data/reality/00';
import { terminalBody } from '../../../data/reality/02/requests';
import { memberAccountPath, memberFundingPath } from '../../../data/reality/05/adapter';
import { memberFundingReceipt, type MemberAccountDto, type MemberFundingDto } from '../../../data/reality/05/dto';
import { ActionButton, PosDialog, ResultPanel } from '../../../ui';
import { MoneyReversalReceipt } from '../../../screens/order/settlement/MoneyReversalReceipt';
import { SharedPosPaymentDialog, type MoneyPaymentQuote, type SettlementPaymentPhase } from '../../../screens/order/settlement/SharedPosPaymentDialog';
import { SharedPosReversalDialog, type MoneyReversalView } from '../../../screens/order/settlement/SharedPosReversalDialog';
import { emptySlip, SlipFields, terminalOf, type Slip } from '../i7-custom/real-money';
import { useMemberCommand } from '../mgmt-customers/members.commands';
import { useT } from '../mgmt-customers/shared';
import { useMemberProjection } from './use-member-projection';
import type { MemberReturnContext, MemberSettlementTarget, PassProduct } from './types';

type Payment = { readonly target: MemberSettlementTarget; readonly context: MemberReturnContext };
type Original = { readonly fundingId: string; readonly context: MemberReturnContext };
export type FundingAction = Payment | Original;
const titles = { charge_topup: '충전금 충전', receivable_collection: '외상 수금', membership_sale: '회원권 판매' } as const;
const ready = { status: 'ready' } as const;
const pending = { status: 'pending' } as const;
const succeeded = { status: 'succeeded' } as const;
const refundReferenceError = '단말기 번호는 영문자와 숫자로 시작하고, 영문자·숫자·하이픈·밑줄을 40자까지 쓸 수 있어요';

function refundSlipProblem(slip: Slip) {
  try {
    terminalBody({ ...slip, at: `${slip.date}T${slip.time}` });
  } catch (error) {
    if (error instanceof PortError && error.reason === 'TERMINAL_REFERENCE_INVALID') return refundReferenceError;
  }
  return '';
}

function allocateRefund(splits: readonly PosMethodSplit[], amount: number): MoneyReversalView['realMethodReturns'] {
  let remaining = amount;
  return splits.flatMap(split => {
    if (split.method !== 'cash' && split.method !== 'card' && split.method !== 'easy_pay') return [];
    const returned = Math.min(remaining, split.amount);
    remaining -= returned;
    return returned > 0 ? [{ method: split.method, amount: returned }] : [];
  });
}

function useResource<T>(real: RealPort, resource: string, path: string) {
  const [state, setState] = useState<{ row?: T; error?: string }>({});
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void real.reads.one<T>({ resource, path }, { signal: abort.signal }).then(
      row => { if (!abort.signal.aborted) setState({ row }); },
      error => { if (!abort.signal.aborted) setState({ error: error instanceof PortError && error.status === 404
        ? '원거래를 찾지 못했어요' : '거래 정보를 불러오지 못했어요' }); });
    return () => abort.abort();
  }, [real, resource, path, attempt]);
  return { ...state, retry: () => { setState({}); retry(n => n + 1); } };
}

type FundingProps = { readonly real: RealPort; readonly close: () => void; readonly host?: WidgetHost };
export function FundingDialog({ action, ...props }: FundingProps & { readonly action: FundingAction; readonly products: readonly PassProduct[] }) {
  return 'target' in action ? <FundingPayment action={action} {...props} /> : <FundingReceipt action={action} {...props} />;
}

function FundingPayment({ action, real, products, close, host }: FundingProps & { action: Payment; products: readonly PassProduct[] }) {
  const { target, context } = action;
  const account = useResource<MemberAccountDto>(real, 'pos.member-accounts', memberAccountPath(target.memberId));
  const command = useMemberCommand();
  const projection = useMemberProjection();
  const { t } = useT();
  const [allocations, setAllocations] = useState<readonly SettlementAllocation[]>([]);
  const [terminalSplits, setTerminalSplits] = useState<readonly PosMethodSplit[]>();
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState('');
  const today = readAppClock().calendarDate;
  const [slip, setSlip] = useState(() => emptySlip(today));
  const locked = useRef(false);
  const product = target.purpose === 'membership_sale' ? products.find(row => row.productId === target.productId) : undefined;
  const amount = target.purpose === 'membership_sale' ? product?.price ?? 0 : target.amount;
  const collectionAvailable = target.purpose !== 'receivable_collection' || amount <= (account.row?.receivableBalance ?? 0);
  const asQuote = (rows: readonly SettlementAllocation[]): MoneyPaymentQuote => {
    const remaining = amount - rows.reduce((sum, row) => sum + row.amount, 0);
    return { quoteId: '', quoteRevision: account.row?.revision ?? 0, amountDue: amount,
      allocations: rows, remaining, canSubmit: !!account.row && amount > 0 && collectionAvailable && remaining === 0
        && rows.every(row => row.kind === 'method' && row.method && Number.isSafeInteger(row.amount) && row.amount > 0),
      issues: account.row && !collectionAvailable ? [{ reason: 'RECEIVABLE_LIMIT', details: { remaining: account.row.receivableBalance } }] : [],
      ...(target.purpose === 'receivable_collection' ? { collectionSources: [{ amount, txnId: target.receivableTxnId ?? '' }] } : {}) };
  };
  function record(splits: readonly PosMethodSplit[]) {
    if (!account.row || locked.current) return false;
    locked.current = true; setProblem('');
    const terminal = splits.some(row => row.method !== 'cash') ? terminalOf(slip).record : undefined;
    command.run({ type: 'memberAccounts.recordFunding', target, splits, terminal, expectedRevision: account.row.revision }, result => {
      locked.current = false;
      if (!result.ok) {
        if (result.reason === 'STALE_REVISION' || result.reason === 'QUOTE_CHANGED') { setProblem('거래가 바뀌었어요. 금액을 다시 확인해 주세요'); setTerminalSplits(undefined); account.retry(); }
        else setProblem(result.outcomeUnknown ? '거래 결과를 확인하지 못했어요. 같은 내용으로 다시 확인해 주세요' : commandFailureText(t, result));
        return;
      }
      const receipt = result.value as (CommandReceipt & { readonly membershipId?: string }) | undefined;
      if (target.purpose === 'membership_sale' && receipt?.membershipId) projection.waitFor({ kind: 'sale', id: receipt.membershipId });
      else host?.notify({ kind: 'success', messageKey: 'data.management.notice.saved' });
      setTerminalSplits(undefined); setSaved(true);
    });
    return true;
  }
  const phase: SettlementPaymentPhase = saved && !projection.status ? succeeded : command.pending ? pending : ready;
  const tools = <>
    {account.error ? <><p role="alert">{account.error}</p><ActionButton variant="secondary" onClick={account.retry}>다시 시도하기</ActionButton></>
      : !account.row ? <p role="status">거래 정보를 불러오고 있어요</p> : null}
    {problem && <p role="alert">{problem}</p>}
  </>;
  return <SharedPosPaymentDialog mode="money" open target={target} summary={product?.label ?? titles[target.purpose]}
    quote={asQuote(allocations)} phase={phase} returnFocusRef={context.returnFocusRef} onClose={close} onReset={() => setProblem('')}
    member={target.purpose === 'receivable_collection' && account.row ? { ...account.row, memberId: '', label: '' } : null}
    onAllocationsChange={rows => { setAllocations(rows); setProblem(''); return asQuote(rows); }}
    onApprove={quote => {
      const splits = quote.allocations.map(row => ({ method: row.method!, amount: row.amount }));
      if (splits.some(row => row.method !== 'cash')) { setTerminalSplits(splits); return false; }
      return record(splits);
    }}
    tools={tools}
    subview={saved && projection.status ? { title: titles[target.purpose], onBack: close, content: <>
      <p role="status">{projection.status === 'retry' ? '결제를 기록했어요. 회원권을 아직 불러오지 못했어요' : '결제를 기록했어요. 회원권을 불러오고 있어요'}</p>
      {projection.status === 'retry' && <ActionButton variant="secondary" onClick={projection.retry}>다시 시도하기</ActionButton>}
      <ActionButton onClick={close}>닫기</ActionButton>
    </> } : terminalSplits ? { title: '단말 결제 기록', onBack: () => { if (!locked.current) { setTerminalSplits(undefined); setProblem(''); } },
      content: <>
        <SlipFields slip={slip} onChange={setSlip} today={today} disabled={command.pending} />
        {problem && <p role="alert">{problem}</p>}
        <ActionButton disabled={!terminalOf(slip).valid} loading={command.pending} onClick={() => record(terminalSplits)}>받은 금액 기록하기</ActionButton>
      </> } : undefined} />;
}

function FundingReceipt({ action, real, close }: FundingProps & { action: Original }) {
  const { fundingId, context } = action;
  const resource = useResource<MemberFundingDto>(real, 'pos.member-funding', memberFundingPath(fundingId));
  const command = useMemberCommand();
  const { t } = useT();
  const today = readAppClock().calendarDate;
  const [slip, setSlip] = useState(() => emptySlip(today));
  const [view, setView] = useState<'receipt' | 'refund'>('receipt');
  const [amount, setAmount] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState('');
  const original = resource.row;
  if (saved) return <PosDialog open kind="confirm" title="환불" returnFocusRef={context.returnFocusRef} onClose={close}>
    <div className="shared-settlement" lang="ko"><ResultPanel title="환불을 기록했어요"><ActionButton onClick={close}>닫기</ActionButton></ResultPanel></div>
  </PosDialog>;
  if (view === 'refund' && original) {
    const returns = allocateRefund(original.remainingMethods, amount ?? 0);
    const noncash = returns.some(row => row.method !== 'cash');
    const slipProblem = noncash ? refundSlipProblem(slip) : '';
    const terminal = noncash ? terminalOf(slip).record : undefined;
    const inRange = amount !== null && Number.isSafeInteger(amount) && amount > 0 && amount <= original.remainingRefundable;
    const quote: MoneyReversalView = { quoteId: '', quoteRevision: original.revision, kind: 'refund', amount: amount ?? 0,
      remainingRefundable: original.remainingRefundable, canSubmit: inRange && (!noncash || (!!terminal && !slipProblem)),
      realMethodReturns: returns, recognitionEffects: [], accountEffects: [], membershipEffects: [], issues: [] };
    return <SharedPosReversalDialog mode="money" open quote={quote} phase={command.pending ? pending : ready}
      returnFocusRef={context.returnFocusRef} onClose={close} onAmountChange={next => { setAmount(next); setProblem(''); }}
      selection={<>
        {noncash && <SlipFields slip={slip} onChange={next => { setSlip(next); setProblem(''); }} today={today} disabled={command.pending} />}
        {(slipProblem || problem) && <p role="alert">{slipProblem || problem}</p>}
      </>}
      onConfirm={() => {
        if (!quote.canSubmit || command.pending) return false;
        command.run({ type: 'memberAccounts.recordRefund', fundingId, amount: amount!, terminal, expectedRevision: original.revision, confirmed: true }, result => {
          if (result.ok) { setSaved(true); return; }
          if (result.reason === 'STALE_REVISION' || result.reason === 'QUOTE_CHANGED') {
            setProblem(commandFailureText(t, result, { reason: '거래가 바뀌었어요', next: '금액을 다시 확인해 주세요' }));
            setView('receipt'); resource.retry();
          } else {
            const alreadyUsed = result.reason === 'CHARGE_BALANCE_EXCEEDED';
            const limit = result.reason === 'REFUND_LIMIT';
            const reason = alreadyUsed ? '이미 사용한 충전금이 있어요' : limit ? '현재 잔액에서 환불할 수 있는 금액을 넘었어요'
              : result.reason === 'TERMINAL_REFERENCE_INVALID' ? refundReferenceError : undefined;
            setProblem(commandFailureText(t, result, { reason, next: alreadyUsed || limit ? '환불 금액을 줄여 주세요' : reason ? '' : undefined }));
          }
        });
        return true;
      }} />;
  }
  if (!original) return <PosDialog open kind="receipt" title="영수증" returnFocusRef={context.returnFocusRef} onClose={close}>
    {resource.error ? <><p role="alert">{resource.error}</p><ActionButton variant="secondary" onClick={resource.retry}>다시 시도하기</ActionButton></>
      : <p role="status">거래 정보를 불러오고 있어요</p>}
  </PosDialog>;
  const note = original.purpose === 'membership_sale' ? '회원권 환불을 기록할 수 없어요' : problem || undefined;
  return <MoneyReversalReceipt settlementId={original.settlementId} initialView="receipt" returnFocusRef={context.returnFocusRef} onClose={close}
    money={{ receipt: memberFundingReceipt(original) }} recorded={{ ...original.terminal, note }}
    onRecordedRefund={original.purpose === 'membership_sale' ? undefined : () => {
      setAmount(original.remainingRefundable); setProblem(''); setView('refund');
    }} />;
}
