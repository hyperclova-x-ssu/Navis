import { formatPosMoney } from '../../../ui';

export function settlementIssue(reason: string, details?: Readonly<Record<string, unknown>>): string {
  if (reason === 'QUOTE_CHANGED') return '금액이 바뀌었어요. 다시 확인해 주세요';
  if (reason === 'DAY_CLOSED') return '마감한 날에는 결제할 수 없어요';
  if (reason === 'APPROVAL_REQUIRED') return '손님 승인을 먼저 기록해 주세요';
  if (reason === 'ALLOCATION_SUM_MISMATCH') return '결제 금액을 확인해 주세요';
  if (reason === 'DATA_UNAVAILABLE') return '결제 정보를 불러오지 못했어요';
  if (reason === 'MEMBER_REQUIRED') return '회원을 먼저 연결해 주세요';
  if (reason === 'AMOUNT_POSITIVE_REQUIRED') return '1원 이상 넣어 주세요';
  if (reason === 'CHARGE_BALANCE_EXCEEDED') return `충전금 잔액 ${formatPosMoney(Number(details?.available ?? 0))}까지 쓸 수 있어요`;
  if (reason === 'RECEIVABLE_LIMIT') return `남은 외상 금액 ${formatPosMoney(Number(details?.remaining ?? 0))}까지 수금할 수 있어요`;
  if (reason === 'TOPUP_ALREADY_USED') return '이미 사용한 충전금이라 전체 취소할 수 없어요';
  if (reason === 'RECEIVABLE_ALREADY_COLLECTED') return '이미 수금한 외상이 있어요 · 수금 취소·환불을 먼저 해 주세요';
  if (reason === 'REFUND_LIMIT') return '돌려드릴 수 있는 금액을 확인해 주세요';
  if (reason === 'QTY_LIMIT' || reason === 'INVALID_SELECTION') return '취소·환불할 품목과 수량을 확인해 주세요';
  if (reason === 'WHOLE_BILL_DISCOUNT') return '주문 전체에 할인이 들어가 있어 전체 취소만 할 수 있어요';
  if (reason === 'USE_REFUND') return '준비를 시작한 주문은 환불로 진행해 주세요';
  if (reason === 'USE_CANCEL') return '준비 전 주문은 결제 취소로 진행해 주세요';
  if (reason === 'INVALID_SETTLEMENT_KIND') return '이 거래는 카드·간편결제·현금으로 결제해 주세요';
  return '결제를 완료하지 못했어요';
}

