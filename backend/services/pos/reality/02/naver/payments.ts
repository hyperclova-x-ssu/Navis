import { NaverError, type OwnerContext } from '../../../../account/naver/wire.ts';
import { PosError } from '../../../wire.ts';
import { ProviderUnavailable } from './orders.ts';

// Read-only external payment and order status shown next to POS order status. Navis never approves,
// cancels or charges an Npay payment here; top-up, receivable and membership stay on the store terminal
// or cash with a transaction reference (I17).
export type SettlementRow = {
  paymentId: string; payHistId: string; settleType: string; payDate: string; settleBasisDate: string;
  settleExpectDate: string; settleCompleteDate: string; paySettleAmount: number; totalCommissionAmount: number;
  totalPayCommissionAmount: number; settleExpectAmount: number;
};
export type SettlementRead = {
  responseCount: number; currentPage: number; totalCount?: number; totalPageCount?: number; list: SettlementRow[];
};
export type PaymentReadPort = {
  settlements(ctx: OwnerContext, lookup: 'payment-id' | 'pay-hist-id', id: string, pageNumber?: number): Promise<SettlementRead>;
  commerceOrders(ctx: OwnerContext, productOrderIds: readonly string[]): Promise<Array<{ productOrderId: string; productOrderStatus: string }>>;
};

// Npay settlement search keys are bounded to 50 bytes by the settlement API.
export const npayKeyPattern = /^[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,49}$/;
const seoulDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });
const settleDate = /^\d{8}$/;

function pageInput(raw: unknown) {
  const query = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (Object.keys(query).some(key => key !== 'page')) throw new PosError(400, 'INVALID_REQUEST');
  if (query.page === undefined) return undefined;
  if (typeof query.page !== 'string' || !/^[1-9]\d{0,9}$/.test(query.page) || Number(query.page) > 2_147_483_647) {
    throw new PosError(400, 'INVALID_REQUEST');
  }
  return Number(query.page);
}

// https://docs.pay.naver.com/docs/settlement/settlement-api/settle-by-case/
// Each row is one payment history line: `정산` for the approved payment and `정산 후 취소` for a cancellation of
// that same original payment. Deposits come only from this settlement lookup with a completed settlement date,
// never from an approval response (I17).
export async function readSettlements(naver: PaymentReadPort, scope: OwnerContext, by: 'paymentId' | 'payHistId',
  id: string, rawQuery: unknown, at: Date) {
  if (!npayKeyPattern.test(id)) throw new PosError(400, 'INVALID_REQUEST');
  const page = pageInput(rawQuery);
  let result: SettlementRead;
  try {
    result = await naver.settlements(scope, by === 'paymentId' ? 'payment-id' : 'pay-hist-id', id, page);
  } catch (error) {
    if (error instanceof NaverError && error.status === 400) throw new PosError(400, 'INVALID_REQUEST');
    throw new ProviderUnavailable('NPAY_SETTLEMENT_UNAVAILABLE');
  }
  const today = seoulDate.format(at).replaceAll('-', '');
  const items = result.list.map(row => {
    if ((by === 'paymentId' ? row.paymentId : row.payHistId) !== id) throw new ProviderUnavailable('NPAY_SETTLEMENT_UNAVAILABLE');
    const settled = settleDate.test(row.settleCompleteDate) && row.settleCompleteDate <= today;
    return {
      paymentId: row.paymentId, payHistId: row.payHistId, settleType: row.settleType,
      kind: row.settleType === '정산' ? 'approval' as const : row.settleType === '정산 후 취소' ? 'cancellation' as const : 'other' as const,
      payDate: row.payDate, settleBasisDate: row.settleBasisDate, settleExpectDate: row.settleExpectDate,
      settleCompleteDate: row.settleCompleteDate, paySettleAmount: row.paySettleAmount,
      totalCommissionAmount: row.totalCommissionAmount, totalPayCommissionAmount: row.totalPayCommissionAmount,
      settleExpectAmount: row.settleExpectAmount, status: settled ? 'settled' as const : 'scheduled' as const,
    };
  });
  const sum = (pick: (row: typeof items[number]) => number) => items.reduce((total, row) => total + pick(row), 0);
  return {
    lookup: { by, id },
    // Pagination counters exactly as the official field table returns them (totals on the first page).
    page: {
      responseCount: result.responseCount, currentPage: result.currentPage,
      ...(result.totalCount !== undefined && { totalCount: result.totalCount }),
      ...(result.totalPageCount !== undefined && { totalPageCount: result.totalPageCount }),
    },
    items,
    totals: {
      complete: result.currentPage === 1 && (result.totalPageCount ?? 1) <= 1,
      paySettleAmount: sum(row => row.paySettleAmount), totalCommissionAmount: sum(row => row.totalCommissionAmount),
      settleExpectAmount: sum(row => row.settleExpectAmount),
      settledAmount: sum(row => row.status === 'settled' ? row.settleExpectAmount : 0),
    },
    asOf: at.toISOString(),
  };
}

function productOrderIds(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'productOrderIds')) {
    throw new PosError(400, 'INVALID_REQUEST');
  }
  const ids = (raw as { productOrderIds?: unknown }).productOrderIds;
  // The seller order detail query accepts up to 300 product order IDs.
  if (!Array.isArray(ids) || !ids.length || ids.length > 300 || ids.some(id => typeof id !== 'string' || !/^\d{1,32}$/.test(id))
    || new Set(ids).size !== ids.length) throw new PosError(400, 'INVALID_REQUEST');
  return ids as string[];
}

// https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-pay-order-seller
// Only the product order ID and its status are projected. An ID that is not returned can be missing or
// belong to another seller, so it is reported as unavailable without further detail.
export async function readSmartStoreStatuses(naver: PaymentReadPort, scope: OwnerContext, raw: unknown, at: Date) {
  const ids = productOrderIds(raw);
  let rows: Awaited<ReturnType<PaymentReadPort['commerceOrders']>>;
  try {
    rows = await naver.commerceOrders(scope, ids);
  } catch (error) {
    if (error instanceof NaverError && error.status === 400) throw new PosError(400, 'INVALID_REQUEST');
    throw new ProviderUnavailable('SMARTSTORE_UNAVAILABLE');
  }
  const found = new Map(rows.map(row => [row.productOrderId, row.productOrderStatus]));
  if (rows.some(row => !/^[A-Z_]{1,40}$/.test(row.productOrderStatus)) || found.size !== rows.length) {
    throw new ProviderUnavailable('SMARTSTORE_UNAVAILABLE');
  }
  return {
    items: ids.filter(id => found.has(id)).map(productOrderId => ({ productOrderId, productOrderStatus: found.get(productOrderId)! })),
    unavailable: ids.filter(id => !found.has(id)),
    asOf: at.toISOString(),
  };
}
