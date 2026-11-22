import type { PortRequest, PortTransport } from '../00/port';
import type { PosCommandReceiptDto, PosProviderLinks } from './dto';

export interface NaverOrder extends PosProviderLinks {
  readonly source?: 'naver';
  orderNumber: string;
  status: 'received' | 'preparing' | 'picked-up';
  preparationMinutes: number | null;
  revision: number;
  preparingAt: string | null;
  pickedUpAt: string | null;
  actions: { prepare: boolean; pickup: boolean };
}

export interface NaverOrderPage {
  items: NaverOrder[];
  nextCursor: string | null;
  status: 'ready' | 'partial';
}

/** Order status rows keep provider IDs separate and leave unreported POS cells empty. */
export interface NaverOrderStatusRow {
  readonly id: string;
  readonly naver: NaverOrder;
}

export function projectNaverOrderStatus(order: NaverOrder): NaverOrderStatusRow {
  return { id: `naver:${order.orderNumber}`, naver: order };
}

export type NaverTransition = { kind: 'prepare'; preparationMinutes: number } | { kind: 'pickup' };

export interface NpaySettlement {
  page: { responseCount: number; currentPage: number; totalCount?: number; totalPageCount?: number };
  items: {
    paymentId: string; payHistId: string; settleType: string; kind: 'approval' | 'cancellation' | 'other';
    payDate: string; settleBasisDate: string;
    settleExpectDate: string; settleCompleteDate: string; paySettleAmount: number; totalCommissionAmount: number;
    totalPayCommissionAmount: number; settleExpectAmount: number; status: 'scheduled' | 'settled';
  }[];
}

interface SmartStoreStatuses {
  items: { productOrderId: string; productOrderStatus: string }[];
  unavailable: string[];
}

export function createNaverPosRemote(
  transport: PortTransport,
  send: <T>(request: Omit<PortRequest, 'idempotencyKey'>, key: string) => Promise<T>,
  signal: () => AbortSignal,
) {
  const path = '/pos/naver';
  const orderPath = (id: string) => `${path}/orders/${encodeURIComponent(id)}`;
  const readSignal = (abort: AbortSignal) => AbortSignal.any([abort, signal()]);
  return {
    orders: (cursor?: string, abort?: AbortSignal) => transport.request<NaverOrderPage>({
      method: 'GET', path: `${path}/orders`, query: { cursor }, signal: abort ?? signal(),
    }),
    order: (id: string, abort?: AbortSignal) => transport.request<NaverOrder>({
      method: 'GET', path: orderPath(id), signal: abort ?? signal(),
    }),
    transition: (id: string, action: NaverTransition, expectedRevision: number, key: string) =>
      send<PosCommandReceiptDto>({
        method: 'POST', path: `${orderPath(id)}/${action.kind}`, expectedRevision,
        body: action.kind === 'prepare' ? { preparationMinutes: action.preparationMinutes } : {},
      }, key),
    settlement: (by: 'payments' | 'pay-histories', id: string, page: number, abort: AbortSignal) =>
      transport.request<NpaySettlement>({
        method: 'GET', path: `${path}/npay/${by}/${encodeURIComponent(id)}`, query: { page }, signal: readSignal(abort),
      }),
    smartStore: (productOrderIds: string[], abort: AbortSignal) => transport.request<SmartStoreStatuses>({
      method: 'POST', path: `${path}/smartstore/order-statuses`, body: { productOrderIds }, signal: readSignal(abort),
    }),
  };
}

export type NaverPosRemote = ReturnType<typeof createNaverPosRemote>;
