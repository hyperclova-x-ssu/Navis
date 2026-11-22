import { useEffect, useRef, useState } from 'react';
import type { SettlementAllocation } from '../../../data/iteration7/accounting/types';
import { projectCheckoutQuote } from '../../../data/reality/02/checkout-view';
import type { CheckoutOutcome } from '../../../data/reality/02/bridge';
import type { PosMemberChoice } from '../../../data/reality/02/dto';
import { terminalBody } from '../../../data/reality/02/requests';
import { PortError } from '../../../data/reality/00/port';
import type { CheckoutCoupon, CouponQuote } from '../../../data/reality/14/dto';
import { useOptionalWidgetDataStore } from '../../../data/react';
import { getPaymentBillId, quotePaymentBill } from '../../../pos/loyalty';
import type { PosBridge } from '../../../data/reality/02/bridge';
import { usePosSnapshot } from '../../../pos/react';
import { POS_NOW_TIME } from '../../../pos/clock';
import { ActionButton, Spinner, TextField, formatPosMoney } from '../../../ui';
import { usePayText } from './Tools';
import type { CheckoutProps } from './Checkout';
import type { MoneyPaymentDialogProps, MoneyPaymentQuote, SettlementPaymentPhase } from '../settlement/SharedPosPaymentDialog';

type Phase =
  | { readonly status: 'ready' }
  | { readonly status: 'pending' }
  | { readonly status: 'done'; readonly orderNo: number | undefined }
  | { readonly status: 'changed'; readonly payable: number }
  | { readonly status: 'failed'; readonly reason: string; readonly outcomeUnknown: boolean };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function useHttpCheckout(bridge: PosBridge | null, { open, billId, onRegisterMember }: CheckoutProps) {
  const read = usePosSnapshot(), { t } = usePayText();
  const existingBill = billId !== getPaymentBillId(read);
  const quote = quotePaymentBill(read, billId), amount = bridge?.bill(billId)?.quote.payable ?? (quote.remaining || quote.payable);
  const data = useOptionalWidgetDataStore();
  const couponAvailable = !!bridge && !existingBill && !quote.discount && data?.real?.mode('coupons') === 'http';
  const [phase, setPhase] = useState<Phase>({ status: 'ready' });
  const [rows, setRows] = useState<readonly SettlementAllocation[]>([]);
  const [member, setMember] = useState<PosMemberChoice>();
  const [balance, setBalance] = useState<{ memberId: string; charge: number; receivable: number }>();
  const [approvalNo, setApprovalNo] = useState(''), [receiptNo, setReceiptNo] = useState(''), [at, setAt] = useState(POS_NOW_TIME);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [couponCode, setCouponCode] = useState('');
  const [couponPreview, setCouponPreview] = useState<(CheckoutCoupon & CouponQuote & { fingerprint: string })>();
  const [couponChecking, setCouponChecking] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  const couponCheckingRef = useRef(false);
  const attempt = useRef<string>(undefined), created = useRef(existingBill ? billId : undefined), pressing = useRef(false);
  const alive = useRef(true);
  const [frozenPayable, setFrozenPayable] = useState<number>();
  const [repriced, setRepriced] = useState<number>();
  const couponFingerprint = JSON.stringify([quote.lines.map(line => [line.menuId, line.gross, line.qty, line.options.map(option => option.optionId)]), member?.customerId, couponCode.trim()]);
  const coupon = couponAvailable && couponPreview?.fingerprint === couponFingerprint ? couponPreview : undefined;
  const payable = frozenPayable ?? repriced ?? (amount - (coupon?.discount ?? 0));
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const memberId = member?.memberId;
  useEffect(() => {
    if (!bridge || !memberId || !open) return;
    const request = new AbortController();
    void bridge.remote.memberBalance(memberId, request.signal).then(({ chargeBalance, receivableBalance }) => {
      if (!request.signal.aborted) setBalance({ memberId, charge: chargeBalance, receivable: receivableBalance });
    }).catch(() => {});
    return () => request.abort();
  }, [bridge, memberId, open]);

  const reasonText = (reason: string) => {
    if (reason === 'CHARGE_BALANCE_EXCEEDED') return '충전 잔액이 부족해요';
    if (reason === 'MEMBER_NOT_FOUND') return '회원을 다시 선택해 주세요';
    if (reason === 'COUPON_MEMBER_REQUIRED') return '쿠폰을 받은 회원을 선택해 주세요';
    if (reason === 'COUPON_HOURS') return '지금은 이 쿠폰을 쓸 수 있는 시간이 아니에요';
    if (reason === 'COUPON_PAUSED') return '일시 중지된 쿠폰이에요';
    if (reason === 'COUPON_ENDED') return '사용 기간이 끝난 쿠폰이에요';
    if (reason === 'COUPON_EXHAUSTED' || reason === 'COUPON_HOLD_EXPIRED') return '쿠폰 사용 가능 여부를 다시 확인해 주세요';
    if (reason === 'COUPON_MENU_REQUIRED' || reason === 'COUPON_SHOT_REQUIRED') return '쿠폰에 맞는 메뉴와 옵션을 담아 주세요';
    if (reason === 'BILL_DISCOUNT_MISMATCH') return '할인 금액이 바뀌었어요. 쿠폰을 다시 확인해 주세요';
    if (reason.startsWith('COUPON_')) return '쿠폰 코드를 확인해 주세요';
    const key = `pay.real.error.${reason}` as const;
    return t(([
      'pay.real.error.DAY_CLOSED', 'pay.real.error.TERMINAL_REFERENCE_EXISTS', 'pay.real.error.TERMINAL_TIME_INVALID', 'pay.real.error.CATALOG_UNAVAILABLE',
      'pay.real.error.CATALOG_RECIPE_UNAVAILABLE', 'pay.real.error.OUTCOME_UNKNOWN', 'pay.real.error.SESSION_ENDED',
    ] as readonly string[]).includes(key) ? key as 'pay.real.error.DAY_CLOSED' : 'pay.real.error.GENERIC');
  };

  const checkCoupon = async () => {
    const code = couponCode.trim();
    if (!bridge || !code || couponCheckingRef.current) return;
    setCouponError(null);
    couponCheckingRef.current = true;
    setCouponChecking(true);
    try {
      const lines = quote.lines.map(({ lineId, menuId, gross, basePrice, options }) => ({
        lineId, menuId, gross, basePrice, options: options.map(({ optionId, extraPrice }) => ({ optionId, extraPrice })),
      }));
      const customerId = member?.customerId;
      const preview = await bridge.remote.previewCoupon(code, lines, customerId);
      if (!Number.isSafeInteger(preview.discount) || preview.discount <= 0 || preview.discount >= amount) {
        throw new PortError(409, 'CONFLICT', 'COUPON_INVALID_BENEFIT');
      }
      if (alive.current) setCouponPreview({ ...preview, code, customerId, fingerprint: couponFingerprint });
    } catch (error) {
      if (alive.current) setCouponError(reasonText(error instanceof PortError ? error.reason ?? error.code : 'UNKNOWN'));
    } finally {
      couponCheckingRef.current = false;
      if (alive.current) setCouponChecking(false);
    }
  };

  const currentBalance = balance?.memberId === memberId ? balance : undefined;
  const makeQuote = (selection: readonly SettlementAllocation[]) => projectCheckoutQuote({
    billId, revision: bridge?.bill(billId)?.quote.quoteRevision ?? quote.revision, amountDue: payable, selection,
    canRecord: !couponChecking && (!couponAvailable || !couponCode.trim() || !!coupon),
    chargeBalance: currentBalance?.charge,
  });
  const current = makeQuote(rows);
  const change = (selection: readonly SettlementAllocation[]) => {
    setFieldError(null);
    setRows(selection);
    return makeQuote(selection);
  };
  const reset = () => {
    if (coupon && !existingBill) {
      setCouponPreview(undefined);
      attempt.current = undefined;
      created.current = undefined;
      setRepriced(undefined);
    }
    setFrozenPayable(undefined);
    setPhase({ status: 'ready' });
  };
  const record = async (quoted: MoneyPaymentQuote) => {
    if (!bridge || pressing.current || phase.status === 'done' || couponCheckingRef.current || !quoted.canSubmit) return;
    const tender = quoted.allocations[0];
    if (tender.kind !== 'method' && tender.kind !== 'charge' && tender.kind !== 'receivable') return;
    const allocation = tender.kind, method = tender.method ?? 'cash';
    let terminal: { approvalNo?: string; receiptNo?: string; at: string } | undefined;
    if (allocation === 'method' && method !== 'cash') {
      if (!TIME.test(at)) { setFieldError(t('pay.real.timeInvalid')); return; }
      terminal = { approvalNo, receiptNo, at: `${read.pos.businessDate}T${at}` };
      try { terminalBody(terminal); } catch (error) {
        const reason = error instanceof PortError ? error.reason : undefined;
        setFieldError(t(reason === 'TERMINAL_REFERENCE_REQUIRED' ? 'pay.real.referenceRequired' : reason === 'TERMINAL_TIME_INVALID' ? 'pay.real.timeInvalid' : 'pay.real.referenceInvalid'));
        return;
      }
    }
    setFieldError(null);
    pressing.current = true;
    setFrozenPayable(quoted.amountDue);
    setPhase({ status: 'pending' });
    attempt.current ??= crypto.randomUUID();
    const outcome: CheckoutOutcome = await bridge.checkout({ attemptId: attempt.current, method, terminal, expectedPayable: quoted.amountDue, billId: created.current,
      ...(member ? { member: { memberId: member.memberId, allocation } } : {}),
      ...(coupon ? { coupon: { code: coupon.code, customerId: coupon.customerId, discount: coupon.discount } } : {}) });
    pressing.current = false;
    if (!alive.current) return;
    if (outcome.status === 'paid') {
      setPhase({ status: 'done', orderNo: outcome.orderNo });
    } else if (outcome.status === 'quote-changed') {
      created.current = outcome.billId;
      setFrozenPayable(undefined);
      setRepriced(outcome.payable);
      setPhase({ status: 'changed', payable: outcome.payable });
    } else {
      setPhase({ status: 'failed', reason: outcome.reason, outcomeUnknown: outcome.outcomeUnknown });
    }
  };
  const busy = phase.status === 'pending';
  const selected = current.allocations[0], method = selected?.method ?? 'cash';
  const methodLabel = t(`pos.${method}`);
  const allocationLabel = selected?.kind === 'charge' ? '충전 잔액' : selected?.kind === 'receivable' ? '외상' : methodLabel;
  const paymentPhase: SettlementPaymentPhase = phase.status === 'done' ? { status: 'succeeded' }
    : phase.status === 'failed' || phase.status === 'changed' ? { status: 'failed', reason: phase.status === 'failed' ? phase.reason : 'QUOTE_CHANGED' }
    : phase;
  const review: NonNullable<MoneyPaymentDialogProps['review']> = {
    label: selected?.kind !== 'method' ? `${allocationLabel} ${formatPosMoney(payable)} 기록하기` :
      method === 'cash' ? t('pay.real.cashConfirm', { amount: formatPosMoney(payable) }) : t('pay.real.terminalConfirm', { method: methodLabel, amount: formatPosMoney(payable) }),
    pendingLabel: t('pay.real.recording'),
    onRetry: quoted => { void record(quoted); },
    failure: phase.status === 'changed' ? { title: t('pay.real.quoteChanged'), description: t('pay.real.quoteChangedHelp', { amount: formatPosMoney(phase.payable) }),
      retryLabel: t('pay.real.recordNew', { amount: formatPosMoney(phase.payable) }), canChangeMethod: false } :
      phase.status === 'failed' ? { title: t('pay.real.failed'), description: reasonText(phase.reason),
        retryLabel: t('pay.real.retry'), canChangeMethod: !phase.outcomeUnknown } : undefined,
    fields: <>
      {selected?.kind === 'charge' ? <p>회원의 충전 잔액에서 차감해요</p> :
        selected?.kind === 'receivable' ? <p>받을 금액을 회원 외상에 기록해요</p> :
        method === 'cash' ? <p>{t('pay.real.cashHelp')}</p> : <>
          <p>{t('pay.real.terminalHelp')}</p>
          <TextField name="terminal-approval-no" label={t('pay.real.approvalNo')} value={approvalNo} onValueChange={setApprovalNo} disabled={busy}/>
          <TextField name="terminal-receipt-no" label={t('pay.real.receiptNo')} value={receiptNo} onValueChange={setReceiptNo} disabled={busy}/>
          <TextField name="terminal-at" label={t('pay.real.terminalAt')} value={at} onValueChange={setAt} inputMode="numeric" disabled={busy}/>
        </>}
      {fieldError && <p role="alert">{fieldError}</p>}
    </>,
  };
  const discountTool = couponAvailable ? <section className="pay-tools__stack">
    <TextField name="pos-coupon-code" label="쿠폰 코드" value={couponCode} disabled={couponChecking}
      onValueChange={value => { setCouponCode(value); setCouponPreview(undefined); setCouponError(null); }}/>
    <ActionButton variant="secondary" disabled={couponChecking || !couponCode.trim()} onClick={() => { void checkCoupon(); }}>
      {couponChecking && <Spinner/>}쿠폰 확인
    </ActionButton>
    {coupon && <p role="status">{coupon.couponName} · {formatPosMoney(coupon.discount)} 할인</p>}
    {couponError && <p role="alert">{couponError}</p>}
  </section> : null;
  return bridge ? {
    quote: current, phase: paymentPhase, review, reset, change,
    closeBlocked: pressing.current || phase.status === 'failed' && phase.outcomeUnknown,
    approve: (quoted: MoneyPaymentQuote) => { void record(quoted); return false; },
    result: phase.status === 'done' ? { title: t('pos.done', { n: phase.orderNo ?? '' }), description: `${allocationLabel} ${formatPosMoney(payable)}` } : undefined,
    orderNo: phase.status === 'done' ? phase.orderNo : undefined,
    member: member && { memberId: member.memberId, label: `${member.name} · ${member.phoneMasked}`,
      chargeBalance: currentBalance?.charge ?? 0, receivableBalance: currentBalance?.receivable ?? 0, accountBalancesAvailable: !!currentBalance },
    unlink: () => { setMember(undefined); setBalance(undefined); change([]); },
    memberSource: { remote: bridge.remote, onSelect: (value: PosMemberChoice) => {
      setBalance(undefined); setMember(value); change([]);
    }, onRegister: onRegisterMember },
    discountTool,
    coupon,
  } : null;
}
