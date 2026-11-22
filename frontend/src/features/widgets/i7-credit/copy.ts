import type { AccountTransaction, OriginalMoneyTransaction } from './types';

export const creditCopy = {
  title: '충전금·외상 관리', empty: '아직 충전금·외상 거래가 없어요',
  loading: '충전금·외상 내역을 불러오고 있어요',
  error: '충전금·외상 내역을 불러오지 못했어요', shortError: '불러오지 못했어요',
  search: '이름이나 연락처 끝자리로 찾아보세요',
  positive: '1원 이상 넣어 주세요', memberRequired: '회원을 먼저 연결해 주세요',
  alreadyUsed: '이미 사용한 충전금이라 전체 취소할 수 없어요',
  alreadyCollected: '이미 수금한 외상이 있어요 · 수금 취소·환불을 먼저 해 주세요',
  /** Empty state next action (H1): the member list is where a member is picked to charge. */
  emptyNext: '회원목록에서 회원을 골라 충전해 보세요', openMembers: '회원목록 보기',
  /** Zero rows are worded by what emptied them: a search, a kind chip, or the tab itself (A10). */
  noSearch: '검색 결과가 없어요', clearSearch: '검색어 지우기', clearKind: '거르기 풀기',
  noChargeRows: '아직 충전금 거래가 없어요', noReceivableRows: '아직 외상 거래가 없어요',
  noCollection: '남은 외상이 없어서 수금할 수 없어요',
} as const;
const formatter = new Intl.NumberFormat('ko-KR');
export const number = (amount: number) => formatter.format(amount);
export const money = (amount: number) => `${number(amount)}원`;
/** `+5,000원` / `−5,000원` (U+2212, DS 6.1) / `0원`. */
export const signedMoney = (amount: number) => `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${money(Math.abs(amount))}`;
/** A kind chip's zero-row sentence, e.g. `취소·환불 거래가 없어요`. */
export const noKindRows = (kind: string) => `${kind} 거래가 없어요`;
export function maskedName(name: string) {
  // The cafe sample members arrive already masked (`가○손님0012`); masking again would turn them into `가○○○○○○2`.
  if (name.includes('○')) return name.trim();
  const letters = [...name.trim()];
  return letters.length <= 1 ? letters[0] ?? '—' : `${letters[0]}${'○'.repeat(Math.max(1, letters.length - 2))}${letters.length > 2 ? letters.at(-1) : ''}`;
}
export function maskedPhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 6 ? `${digits.startsWith('02') ? digits.slice(0, 2) : digits.slice(0, 3)}-****-${digits.slice(-4)}` : '—';
}
export const transactionLabel = (transaction: AccountTransaction) => {
  if (transaction.kind === 'reversal') return transaction.account === 'charge' ? '충전 취소·환불' : '취소·환불';
  return { opening: '이전 잔액', topup: '충전', use: '충전금 사용', sale: '외상 발생', collection: '외상 수금', adjustment: '조정' }[transaction.kind];
};
export const accountIssue = (reason?: string | null) => reason === 'TOPUP_ALREADY_USED' ? creditCopy.alreadyUsed
  : reason === 'RECEIVABLE_ALREADY_COLLECTED' ? creditCopy.alreadyCollected : '';
export const hasOriginal = (transaction: OriginalMoneyTransaction) => !!(transaction.settlementId || transaction.originalTxnId || transaction.sourceRef);
