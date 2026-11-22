import type { ApprovalBody, ApprovalForm, CancellationBody, CancellationForm, Settlement, SettlementPage } from '../../../../packages/naver/contracts/pn09/wire.ts';

const seoul = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' });
export const payTimestamp = (date: Date) => seoul.format(date).replace(/\D/g, '');
export const payDate = (date: Date) => payTimestamp(date).slice(0, 8);
export const pageSize = 1000;

function parseForm(raw: unknown, fields: string[]): URLSearchParams | null {
  if (typeof raw !== 'string' || /%(?![\da-fA-F]{2})/.test(raw)) return null;
  const form = new URLSearchParams(raw);
  const keys = [...form.keys()];
  return new Set(keys).size === keys.length && keys.every(key => fields.includes(key)) ? form : null;
}

function bounded(value: string | null, bytes: number): value is string {
  return value !== null && value.trim().length > 0 && Buffer.byteLength(value) <= bytes && !value.includes('\uFFFD');
}

const approvalKeys = ['paymentId'];
export function parseApproval(raw: unknown): ApprovalForm | null {
  const paymentId = parseForm(raw, approvalKeys)?.get('paymentId') ?? null;
  return bounded(paymentId, 50) ? { paymentId } : null;
}

const amountKeys = ['environmentDepositAmount', 'expectedRestAmount'] as const;
const cancelRequired = ['paymentId', 'cancelAmount', 'cancelReason', 'cancelRequester', 'taxScopeAmount', 'taxExScopeAmount'];
const cancelKeys = [...cancelRequired, 'merchantPayTransactionKey', 'doCompareRest', ...amountKeys];
// Shared error envelope: https://docs.pay.naver.com/docs/common/response-format
export function formError(operation: 'approve' | 'cancel', raw: unknown): 'RequireParameter' | 'InvalidParameter' {
  const form = parseForm(raw ?? '', operation === 'approve' ? approvalKeys : cancelKeys);
  const required = operation === 'approve' ? approvalKeys : cancelRequired;
  return form && required.some(key => !form.has(key)) ? 'RequireParameter' : 'InvalidParameter';
}
function won(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount <= 2147483647 ? amount : undefined;
}

export function parseCancellation(raw: unknown): CancellationForm | null {
  const form = parseForm(raw, cancelKeys);
  if (!form) return null;
  const paymentId = form.get('paymentId');
  const cancelAmount = won(form.get('cancelAmount'));
  const cancelReason = form.get('cancelReason');
  const cancelRequester = form.get('cancelRequester');
  const taxScopeAmount = won(form.get('taxScopeAmount'));
  const taxExScopeAmount = won(form.get('taxExScopeAmount'));
  const merchantPayTransactionKey = form.get('merchantPayTransactionKey');
  const compare = form.get('doCompareRest');
  if (!bounded(paymentId, 50) || !cancelAmount || !bounded(cancelReason, 256)
    || taxScopeAmount === undefined || taxExScopeAmount === undefined
    || (cancelRequester !== '1' && cancelRequester !== '2')
    || (merchantPayTransactionKey !== null && !bounded(merchantPayTransactionKey, 128))
    || (compare !== null && compare !== '0' && compare !== '1')) return null;
  const input: CancellationForm = { paymentId, cancelAmount, cancelReason, cancelRequester, taxScopeAmount, taxExScopeAmount };
  if (merchantPayTransactionKey !== null) input.merchantPayTransactionKey = merchantPayTransactionKey;
  for (const key of amountKeys) {
    if (!form.has(key)) continue;
    const amount = won(form.get(key));
    if (amount === undefined) return null;
    input[key] = amount;
  }
  if (compare !== null) input.doCompareRest = compare === '1' ? 1 : 0;
  if (input.doCompareRest === 1 && input.expectedRestAmount === undefined) return null;
  return input;
}

export interface ApprovalState {
  paymentId: string; payHistId: string; amount: number; merchantPayKey: string; productName: string; admissionAt: Date;
  merchantPayTransactionKey?: string;
  useDate: string;
}
export function approvalBody(state: ApprovalState): ApprovalBody {
  const { paymentId, payHistId, amount, merchantPayKey, productName, admissionAt } = state;
  const timestamp = payTimestamp(admissionAt);
  return {
    paymentId, detail: {
      paymentId, payHistId, merchantName: '안숭잘부 카페', merchantId: 'ansungjalbu-cafe',
      merchantPayKey, merchantUserKey: 'persona-shopper', admissionTypeCode: '01', admissionYmdt: timestamp,
      tradeConfirmYmdt: timestamp, admissionState: 'SUCCESS', totalPayAmount: amount, applyPayAmount: amount,
      primaryPayAmount: amount, npointPayAmount: 0, giftCardAmount: 0, discountPayAmount: 0, taxScopeAmount: amount,
      taxExScopeAmount: 0, environmentDepositAmount: 0, primaryPayMeans: 'CARD', cardCorpCode: 'C0',
      cardNo: '0000-****-****-****', cardAuthNo: '00000001', cardInstCount: 0, usedCardPoint: false,
      bankCorpCode: '', bankAccountNo: '', productName, settleExpected: false, settleExpectAmount: 0,
      payCommissionAmount: 0, userIdentifier: Buffer.alloc(32).toString('base64'),
      extraDeduction: false, useCfmYmdt: state.useDate,
      ...(state.merchantPayTransactionKey ? { merchantPayTransactionKey: state.merchantPayTransactionKey } : {}),
    },
  };
}

export function cancellationResult(form: CancellationForm, remaining: number) {
  if (remaining === 0) return 'AlreadyCanceled';
  if (form.cancelAmount > remaining) return 'OverRemainAmount';
  if (form.doCompareRest === 1 && form.expectedRestAmount !== remaining - form.cancelAmount) return 'RestAmountDiff';
  if (form.taxScopeAmount + form.taxExScopeAmount + (form.environmentDepositAmount ?? 0) !== form.cancelAmount) return 'TaxScopeAmountError';
  if (form.taxExScopeAmount || form.environmentDepositAmount) return 'TaxScopeAmtGreaterThanRemainError';
  return 'Success';
}
export function cancellationBody(form: CancellationForm, historyId: string, remaining: number, now: Date): CancellationBody {
  return {
    paymentId: form.paymentId, payHistId: historyId, primaryPayMeans: 'CARD',
    primaryPayCancelAmount: form.cancelAmount, primaryPayRestAmount: remaining, npointCancelAmount: 0, npointRestAmount: 0,
    giftCardCancelAmount: 0, giftCardRestAmount: 0, discountCancelAmount: 0, discountRestAmount: 0,
    taxScopeAmount: form.cancelAmount, taxExScopeAmount: 0, taxScopeRestAmount: remaining, taxExScopeRestAmount: 0,
    environmentDepositAmount: 0, environmentDepositRestAmount: 0, cancelYmdt: payTimestamp(now),
    totalRestAmount: remaining, applyRestAmount: remaining,
  };
}

export function settlementPage(list: Settlement[], currentPage: number, count = list.length): SettlementPage {
  return { list, currentPage, responseCount: list.length,
    ...(currentPage === 1 ? { totalCount: count, totalPageCount: Math.ceil(count / pageSize) } : {}) };
}
