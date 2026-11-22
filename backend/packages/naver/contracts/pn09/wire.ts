// Online merchant approval and cancellation are the official form-based API.
// https://docs.pay.naver.com/docs/onetime-payment/payment/apply/
// https://docs.pay.naver.com/docs/onetime-payment/payment/cancel/
export const payPaths = {
  approve: '/naverpay-partner/naverpay/payments/v2.2/apply/payment',
  cancel: '/naverpay-partner/naverpay/payments/v1/cancel',
  settlement: '/naverpaysettle-payment/naverpaysettle/v1/settlements/by-case',
} as const;
export interface ApprovalForm { paymentId: string }
export interface CancellationForm {
  paymentId: string;
  merchantPayTransactionKey?: string;
  cancelAmount: number;
  cancelReason: string;
  cancelRequester: '1' | '2';
  taxScopeAmount: number;
  taxExScopeAmount: number;
  environmentDepositAmount?: number;
  doCompareRest?: 0 | 1;
  expectedRestAmount?: number;
}

export interface ApprovalDetail {
  paymentId: string; payHistId: string; merchantName: string; merchantId: string; merchantPayKey: string;
  merchantUserKey: string; admissionTypeCode: '01'; admissionYmdt: string; tradeConfirmYmdt: string;
  admissionState: 'SUCCESS'; totalPayAmount: number; applyPayAmount: number; primaryPayAmount: number;
  npointPayAmount: number; giftCardAmount: number; discountPayAmount: number; taxScopeAmount: number;
  taxExScopeAmount: number; environmentDepositAmount: number; primaryPayMeans: 'CARD';
  cardCorpCode: string; cardNo: string; cardAuthNo: string; cardInstCount: number; usedCardPoint: boolean;
  bankCorpCode: string; bankAccountNo: string; productName: string; settleExpected: false;
  settleExpectAmount: 0; payCommissionAmount: 0; merchantPayTransactionKey?: string; userIdentifier: string;
  extraDeduction: boolean; useCfmYmdt: string;
}
export interface ApprovalBody { paymentId: string; detail: ApprovalDetail }
export interface CancellationBody {
  paymentId: string; payHistId: string; primaryPayMeans: 'CARD';
  primaryPayCancelAmount: number; primaryPayRestAmount: number; npointCancelAmount: number; npointRestAmount: number;
  giftCardCancelAmount: number; giftCardRestAmount: number; discountCancelAmount: number; discountRestAmount: number;
  taxScopeAmount: number; taxExScopeAmount: number; taxScopeRestAmount: number; taxExScopeRestAmount: number;
  environmentDepositAmount: number; environmentDepositRestAmount: number; cancelYmdt: string;
  totalRestAmount: number; applyRestAmount: number;
}

// https://docs.pay.naver.com/docs/settlement/settlement-api/settle-by-case/
export interface Settlement {
  payDate: string; settleBasisDate: string; settleExpectDate: string; settleCompleteDate: string;
  paymentId: string; payHistId: string; settleType: '정산' | '정산 후 취소';
  merchantPayKey: string; productName: string; paySettleAmount: number; totalCommissionAmount: number;
  totalPayCommissionAmount: number; settleExpectAmount: number;
}
export interface SettlementPage {
  list: Settlement[]; responseCount: number; currentPage: number;
  totalCount?: number; totalPageCount?: number;
}
export type PayResponse<T> = { code: 'Success'; body: T; message?: string } | { code: string; body?: undefined; message?: string };

// Owner list/detail fields: https://help.admin.pay.naver.com/faq/content.help?faqId=13148
export const financialCenterPath = '/partner-assumed/v1/financial-center/recommendations';
export interface RecommendationSummary {
  title: string; officialNoticeUrl: string; startDate?: string; endDate?: string; status?: 'closed';
}
export interface Recommendation extends RecommendationSummary {
  overview: string; eligibility: string; applicationMethod: string; documents?: string[];
}
