import type { PosOrder, PosState } from '../../contracts/pos';
import type { OrderCommandResult, OrderItem, OrderSummary, OrderUndo } from '../../orders';

export type OrderFilter = 'open' | 'done' | 'canceled' | 'all';
export type OrderPaymentStatus = 'unpaid' | 'partial' | 'paid' | 'partially_canceled' | 'partially_refunded' | 'refunded' | 'canceled';
export interface OrderStatusRow extends PosOrder {
  readonly id: string; readonly no: number; readonly menuText: string; readonly items: readonly OrderItem[];
  /** Historical order price (unitPriceAtOrder already includes options), never net revenue. */
  readonly amount: number;
  readonly paymentStatus: OrderPaymentStatus; readonly billIds: readonly string[]; readonly tableIds: readonly string[];
  readonly elapsedMin: number; readonly usualMin: number; readonly waitMin: number | null;
  readonly isSlow: boolean; readonly isMissing: boolean; readonly canReopen: boolean;
}
export interface PosOrderSummary extends Omit<OrderSummary, 'openList' | 'doneList'> {
  /** Recognized order gross and net revenue both come from the existing POS ledger selector. */
  readonly netRevenue: number;
  readonly counts: Readonly<Record<OrderFilter, number>>;
  readonly rows: readonly OrderStatusRow[]; readonly openList: readonly OrderStatusRow[];
  readonly doneList: readonly OrderStatusRow[]; readonly canceledList: readonly OrderStatusRow[];
}
export interface OrderSummaryOptions { readonly filter?: OrderFilter; readonly businessNow?: string }
/** T-248 stores the transient undo alongside posUi; no second POS store is introduced. */
export interface OrderStatusSlice { readonly pos: PosState; readonly orderUndo: OrderUndo | null }
export type OrderStatusCommand =
  | { readonly type: 'order.start' | 'order.complete' | 'order.reopen'; readonly orderId: string }
  | { readonly type: 'order.undo'; readonly token: string };
export interface OrderStatusClock { readonly businessNow: string; readonly now: number; readonly token?: string }
export interface OrderStatusOutcome { readonly slice: OrderStatusSlice; readonly result: OrderCommandResult }
