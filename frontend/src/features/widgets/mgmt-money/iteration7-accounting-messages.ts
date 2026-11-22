export const customAccountingCopy = {
  title: '주문제작 수령 매출', product: '상품', sales: '매출', cost: '원가', unknownCost: '원가 미등록',
} as const;

const coverageDate = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', timeZone: 'UTC' });
export function depositCoverageNote(start: string, end: string): string {
  const date = (value: string) => {
    const parts = coverageDate.formatToParts(new Date(`${value}T00:00:00Z`));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
    const weekday = new Intl.DateTimeFormat('ko-KR', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
    return `${part('month')}/${part('day')}(${weekday})`;
  };
  return `실제 입금은 ${start === end ? date(start) : `${date(start)}~${date(end)}`} 자료만 있어요`;
}

export const accountingCopy = {
  title: '매출 · 실제 입금', sales: '오늘 매출', deposits: '실제 입금',
  salesMethods: '판매분 결제 수단', settlementSales: '정산 유형별 매출', depositMethods: '수단별 실제 입금',
  depositPurposes: '입금 종류별 내역', card: '카드', easy_pay: '간편결제', cash: '현금',
  cardSale: '카드 판매분', easyPaySale: '간편결제 판매분', cashSale: '현금 판매분',
  chargeUsed: '충전금 사용액', receivableCreated: '외상 발생액', membershipCount: '횟수권 이용분',
  subscriptionDaily: '구독권 기간분', membershipExpiry: '기한 만료 매출', customPickup: '주문제작 수령 매출',
  sale: '상품·메뉴 판매 입금', charge_topup: '충전금 충전액', receivable_collection: '외상 수금액',
  membership_sale: '회원권 판매액', custom_order: '주문제작 미리결제 · 수령 시 결제',
  gross: '주문 금액', discount: '할인', refund: '환불', returned: '취소·환불 반환액',
  grossReceived: '반환 전 실제 입금', pendingReceived: '분할 결제 수령액(실제 입금에 포함)',
  transactions: '결제 · 입금 내역', time: '시각', transaction: '거래번호', purpose: '주문 · 종류',
  amount: '실제 입금', recognized: '매출', method: '실제 결제 수단', settlement: '정산 유형',
  status: '상태', receipt: '입금', cancel: '취소', openReceipt: '영수증 보기', original: '원거래',
  charge: '충전금 사용', receivable: '외상', membership_count: '횟수권', membership_period: '구독권',
  all: '전체', accounts: '충전금·외상·회원권', mixed: '복합 결제', emptyTransactions: '아직 결제 · 입금 내역이 없어요',
  loading: '불러오는 중…', empty: '아직 매출 · 입금 내역이 없어요', error: '불러오지 못했어요',
  retry: '다시 시도하기', unavailable: '이 날짜의 실제 입금 자료가 없어요',
  expectedCash: '예상 현금 시재', actualCash: '현금 실제 입금',
  legacySales: '이전 날짜 매출',
} as const;
