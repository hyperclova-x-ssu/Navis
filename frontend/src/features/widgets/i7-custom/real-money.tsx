import { useEffect, useRef, useState, type RefObject } from 'react';
import { TODAY } from '../../../data/db/time';
import type { SettlementAllocation } from '../../../data/iteration7/accounting/types';
import type { CustomOrderView } from '../../../data/iteration7/custom-orders';
import { PortError } from '../../../data/reality/00';
import { memberAccountPath } from '../../../data/reality/05/adapter';
import type { MemberAccountDto } from '../../../data/reality/05/dto';
import { customOrdersPath } from '../../../data/reality/08/adapter';
import type { CustomAccountEffect, CustomRealAllocation, CustomRealReversalQuote, CustomRealSettlementQuote, CustomTerminalRecord } from '../../../data/reality/08/commands';
import { ActionButton, DateField, TextField, TimeField } from '../../../ui';
import { SharedPosPaymentDialog, type MoneyPaymentQuote, type SettlementPaymentPhase } from '../../../screens/order/settlement/SharedPosPaymentDialog';
import { SharedPosReversalDialog, type MoneyReversalView } from '../../../screens/order/settlement/SharedPosReversalDialog';
import { commandError, money, orderNumber, requestKey } from './copy';
import type { CustomOrderPort, CustomUiResult } from './port-types';

export type CustomMoneyAction =
  | { readonly kind: 'payment'; readonly customOrderId: string }
  | { readonly kind: 'reversal'; readonly customOrderId: string; readonly cancelOrder: boolean };

type MoneyRow = Pick<CustomOrderView, 'customOrderId' | 'orderNo' | 'productLabel' | 'quoteAmount' | 'payment' | 'memberId'>;
type DialogProps = { readonly action: CustomMoneyAction; readonly row: MoneyRow; readonly port: CustomOrderPort;
  readonly returnFocusRef: RefObject<HTMLElement | null>; readonly close: () => void; readonly onDone: (result: CustomUiResult) => void };
const ready = { status: 'ready' } as const;
const pending = { status: 'pending' } as const;
const succeeded = { status: 'succeeded' } as const;
const orderPath = (id: string) => `${customOrdersPath}/${encodeURIComponent(id)}`;
const reasonOf = (error: unknown) => error instanceof PortError ? (error.reason ?? error.code) : 'SERVICE_UNAVAILABLE';
const resultText = (result: CustomUiResult) => result.outcomeUnknown ? '결과를 확인하지 못했어요. 같은 내용으로 다시 눌러 확인해 주세요' : commandError(result.reason);
const requiresSlip = (rows: readonly CustomRealAllocation[]) => rows.some(row => row.kind === 'method' && row.method !== 'cash');

export interface Slip { readonly approvalNo: string; readonly receiptNo: string; readonly date: string; readonly time: string }
export const emptySlip = (date: string): Slip => ({ approvalNo: '', receiptNo: '', date, time: '' });
/** The owner types the slip of the terminal they already own: a number and the time on it. Cash has none. */
export function terminalOf(slip: Slip): { readonly record?: CustomTerminalRecord; readonly valid: boolean } {
  const occurs = Date.parse(`${slip.date}T${slip.time}:00+09:00`);
  const valid = Boolean((slip.approvalNo.trim() || slip.receiptNo.trim()) && Number.isFinite(occurs));
  return valid ? { valid, record: { ...(slip.approvalNo.trim() ? { approvalNo: slip.approvalNo.trim() } : {}),
    ...(slip.receiptNo.trim() ? { receiptNo: slip.receiptNo.trim() } : {}), occurredAt: new Date(occurs).toISOString() } } : { valid };
}

export function SlipFields({ slip, onChange, today, disabled }: { readonly slip: Slip; readonly onChange: (slip: Slip) => void; readonly today: string; readonly disabled: boolean }) {
  return <>
    <TextField label="단말기 승인 번호" value={slip.approvalNo} onValueChange={approvalNo => onChange({ ...slip, approvalNo })} disabled={disabled} />
    <TextField label="단말기 영수증 번호" value={slip.receiptNo} onValueChange={receiptNo => onChange({ ...slip, receiptNo })} disabled={disabled} />
    <DateField label="단말기 거래일" value={slip.date} onValueChange={value => onChange({ ...slip, date: value ?? '' })} today={today} disabled={disabled} />
    <TimeField label="단말기 거래 시각" value={slip.time} onValueChange={value => onChange({ ...slip, time: value ?? '' })} step={1} disabled={disabled} />
  </>;
}


function AccountEffects({ effects }: { effects: readonly CustomAccountEffect[] }) {
  if (!effects.length) return null;
  return <ul aria-label="회원 계정 변화">{effects.map((effect, index) => {
    const won = money(Math.abs(effect.amount));
    return <li key={`${effect.account}:${effect.kind}:${index}`}>{effect.account === 'charge'
      ? `충전금 ${won} ${effect.kind === 'use' ? '쓰기' : '돌려주기'}`
      : `외상 ${won} ${effect.kind === 'sale' ? '생김' : '줄이기'}`}</li>;
  })}</ul>;
}

export function CustomMoneyDialog(props: DialogProps) {
  return props.action.kind === 'payment' ? <CustomPayment {...props} /> : <CustomReversal {...props} cancelOrder={props.action.cancelOrder} />;
}

function CustomPayment({ row, port, returnFocusRef, close, onDone }: DialogProps) {
  const real = port.real!, record = port.record!;
  const today = port.read().businessDate ?? TODAY;
  const id = row.customOrderId, memberId = row.memberId;
  // Keep the amount during the receipt view when the refreshed row becomes paid.
  const [amountDue] = useState(() => Math.max(0, (row.quoteAmount ?? 0) - (row.payment.amountSettled - row.payment.amountReturned)));
  const [account, setAccount] = useState<MemberAccountDto | null>(null);
  const [allocations, setAllocations] = useState<readonly SettlementAllocation[]>([]);
  const [phase, setPhase] = useState<SettlementPaymentPhase>(ready);
  const [review, setReview] = useState<CustomRealSettlementQuote>();
  const [problem, setProblem] = useState('');
  const [slip, setSlip] = useState(() => emptySlip(today));
  const [key] = useState(requestKey);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!memberId) return;
    const abort = new AbortController();
    void real.reads.one<MemberAccountDto>({ resource: 'pos.member-accounts', path: memberAccountPath(memberId) }, { signal: abort.signal }).then(
      value => { if (!abort.signal.aborted) setAccount(value); }, () => undefined);
    return () => abort.abort();
  }, [memberId, real]);
  const asQuote = (rows: readonly SettlementAllocation[]): MoneyPaymentQuote => {
    const remaining = amountDue - rows.reduce((sum, part) => sum + part.amount, 0);
    const short = rows.some(part => part.kind === 'charge' && part.amount > (account?.chargeBalance ?? 0));
    return { quoteId: '', quoteRevision: 0, amountDue, remaining, allocations: rows,
      canSubmit: amountDue > 0 && remaining === 0 && !short && rows.every(part => Number.isSafeInteger(part.amount) && part.amount > 0),
      issues: short ? [{ reason: 'CHARGE_BALANCE_EXCEEDED', details: { available: account?.chargeBalance ?? 0 } }] : [] };
  };
  const complete = async (q: CustomRealSettlementQuote) => {
    const terminal = requiresSlip(q.allocations) ? terminalOf(slip).record : undefined;
    const result = await record({ type: 'customOrder.recordPayment', customOrderId: id,
      quoteId: q.quoteId, allocations: q.allocations, ...(terminal ? { terminal } : {}), expectedRevision: q.quoteRevision, idempotencyKey: key });
    if (result.ok) {
      if (q.accountEffects.length) void real.load('members', { force: true });
      onDone(result);
      if (alive.current) { setReview(undefined); setPhase(succeeded); }
    } else if (alive.current) {
      if (result.reason === 'STALE_REVISION' || result.reason === 'QUOTE_CHANGED') setReview(undefined);
      setProblem(resultText(result));
      setPhase(ready);
    }
  };
  const run = (action: () => Promise<void>) => {
    if (busy.current) return false;
    busy.current = true; setProblem(''); setPhase(pending);
    void action().catch(error => { if (alive.current) { setProblem(commandError(reasonOf(error))); setPhase(ready); } })
      .finally(() => { busy.current = false; });
    return true;
  };
  const approve = (q: MoneyPaymentQuote) => run(async () => {
    const parts = q.allocations.flatMap<CustomRealAllocation>(part => {
      if (part.kind === 'method' && part.method) return [{ kind: 'method', method: part.method, amount: part.amount }];
      return part.kind === 'charge' || part.kind === 'receivable' ? [{ kind: part.kind, amount: part.amount }] : [];
    });
    const fresh = await real.transport.request<CustomRealSettlementQuote>({ method: 'POST', path: `${orderPath(id)}/settlement-quote`, body: { allocations: parts } });
    if (!alive.current) return;
    if (!fresh.canSubmit) { setProblem(commandError(fresh.issues[0]?.reason)); setPhase(ready); return; }
    if (requiresSlip(fresh.allocations) || fresh.accountEffects.length) { setReview(fresh); setPhase(ready); return; }
    await complete(fresh);
  });
  const title = '단말 결제 기록';
  const member = account && memberId ? { ...account, memberId: '', label: port.members?.find(person => person.memberId === memberId)?.label ?? '연결한 회원' } : null;
  const busyNow = phase.status === 'pending';
  const noncash = !!review && requiresSlip(review.allocations);
  return <SharedPosPaymentDialog mode="money" open target={{ purpose: 'custom_order', customOrderId: id }}
    summary={`${orderNumber(id, row.orderNo)} · ${row.productLabel}`} quote={asQuote(allocations)} member={member} phase={phase}
    returnFocusRef={returnFocusRef} onClose={close} onReset={() => { setProblem(''); setPhase(ready); }}
    onAllocationsChange={rows => { setAllocations(rows); setProblem(''); return asQuote(rows); }} onApprove={approve}
    tools={problem && <p role="alert">{problem}</p>}
    result={{ title: '단말 결제를 기록했어요' }}
    subview={review ? { title, onBack: () => { if (!busy.current) { setReview(undefined); setProblem(''); } }, content: <>
      <AccountEffects effects={review.accountEffects} />
      {noncash && <SlipFields slip={slip} onChange={setSlip} today={today} disabled={busyNow} />}
      {problem && <p role="alert">{problem}</p>}
      <ActionButton disabled={noncash && !terminalOf(slip).valid} loading={busyNow} onClick={() => { void run(() => complete(review)); }}>이 내용으로 기록하기</ActionButton>
    </> } : undefined} />;
}

function CustomReversal({ row, port, close, onDone, returnFocusRef, cancelOrder }: DialogProps & { cancelOrder: boolean }) {
  const real = port.real!, record = port.record!;
  const id = row.customOrderId, kind = cancelOrder ? 'cancellation' : 'refund';
  const today = port.read().businessDate ?? TODAY;
  const [selection, setSelection] = useState<{ amount?: number | null; attempt: number }>({ attempt: 0 });
  const [loaded, setLoaded] = useState<{ selection: typeof selection; quote?: CustomRealReversalQuote; error?: string }>();
  const [slip, setSlip] = useState(() => emptySlip(today));
  const [phase, setPhase] = useState<SettlementPaymentPhase>(ready);
  const [problem, setProblem] = useState('');
  const [key] = useState(requestKey);
  const busy = useRef(false);
  useEffect(() => {
    if (selection.amount === null) return;
    const abort = new AbortController();
    void real.transport.request<CustomRealReversalQuote>({ method: 'POST', path: `${orderPath(id)}/reversal-quote`,
      body: { kind, ...(selection.amount !== undefined ? { amount: selection.amount } : {}) }, signal: abort.signal }).then(
      quote => { if (!abort.signal.aborted) setLoaded({ selection, quote }); },
      error => { if (!abort.signal.aborted) setLoaded({ selection, error: commandError(reasonOf(error)) }); });
    return () => abort.abort();
  }, [real, id, kind, selection]);
  const fresh = loaded?.selection === selection ? loaded : undefined;
  const q = fresh?.quote;
  const last = loaded?.quote;
  const noncash = q?.realMethodReturns.some(part => part.method !== 'cash') ?? false;
  const quote: MoneyReversalView = {
    quoteId: q?.quoteId ?? '', quoteRevision: q?.quoteRevision ?? 0, kind: cancelOrder ? 'cancel' : 'refund',
    amount: selection.amount ?? last?.amount ?? 0, remainingRefundable: (q ?? last)?.remainingRefundable ?? 0,
    canSubmit: !!q?.canSubmit && (!noncash || terminalOf(slip).valid), realMethodReturns: q?.realMethodReturns ?? [],
    recognitionEffects: q?.recognitionEffects ?? [], accountEffects: q?.accountEffects ?? [], membershipEffects: [], issues: [],
  };
  const retry = () => setSelection(current => ({ ...current, attempt: current.attempt + 1 }));
  const approve = () => {
    if (!q?.canSubmit || !quote.canSubmit || busy.current) return false;
    busy.current = true; setPhase(pending); setProblem('');
    const terminal = noncash ? terminalOf(slip).record : undefined;
    void record({ type: 'customOrder.recordCorrection', customOrderId: id, quoteId: q.quoteId, kind,
      ...(!cancelOrder ? { amount: q.amount } : {}), ...(terminal ? { terminal } : {}), expectedRevision: q.quoteRevision, confirmed: true, idempotencyKey: key })
      .then(result => {
        if (result.ok) {
          if (q.accountEffects?.length) void real.load('members', { force: true });
          onDone(result); setPhase(succeeded);
        } else {
          setProblem(resultText(result)); setPhase(ready);
          if (result.reason === 'STALE_REVISION' || result.reason === 'QUOTE_CHANGED') retry();
        }
      }, error => { setProblem(commandError(reasonOf(error))); setPhase(ready); })
      .finally(() => { busy.current = false; });
    return true;
  };
  const issue = q && !q.canSubmit ? commandError(q.issues[0]?.reason) : problem;
  return <SharedPosReversalDialog mode="money" open quote={quote} phase={phase} returnFocusRef={returnFocusRef} cancelOrder={cancelOrder} onClose={close}
    onConfirm={approve} onAmountChange={!cancelOrder ? amount => setSelection(current => ({ ...current, amount })) : undefined}
    selection={<>
      {fresh?.error ? <><p role="alert">{fresh.error}</p><ActionButton variant="secondary" onClick={retry}>다시 시도하기</ActionButton></>
        : !fresh && selection.amount !== null ? <p role="status">거래 정보를 불러오고 있어요</p> : null}
      {issue && <p role="alert">{issue}</p>}
      {noncash && <SlipFields slip={slip} onChange={setSlip} today={today} disabled={phase.status === 'pending'} />}
    </>} />;
}
