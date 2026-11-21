/** Pure order timing/processing types. POS adapts API-245 at src/pos/status. */
/** `key` is the data bundle message key of the menu name (data.menu.*); `name` is the Korean fixture name. */
export interface MenuItem { readonly menuId: string; readonly name: string; readonly key: string; readonly unitPrice: number; readonly prepMin: number }
/** One order line for display: the menu's message key and quantity (screens translate the name). */
export interface OrderItem { readonly menuId: string; readonly name: string; readonly menuKey: string; readonly qty: number }
export interface OrderLine { readonly menuId: string; readonly menu: string; readonly qty: number; readonly unitPrice: number }
export type OpenOrderStatus = 'open' | 'accepted' | 'preparing';
export type OrderStatus = OpenOrderStatus | 'done' | 'canceled';
export interface OrderRecord {
  readonly id: string; readonly no: number; readonly orderedAt: string;
  readonly lines: readonly OrderLine[]; readonly amount: number;
  readonly initialStatus: OrderStatus; readonly initialDoneAt: string | null;
}
export interface OrderRuntime {
  readonly id: string; readonly status: OrderStatus;
  readonly doneAt: string | null; readonly completedInRun: boolean;
  readonly preparedAt?: string | null; readonly completedFrom?: OpenOrderStatus;
}
export interface OrderInputs {
  readonly records: readonly OrderRecord[]; readonly catalog: readonly MenuItem[]; readonly businessNow: string;
}
export type OrderUndoPauseReason = 'focus' | 'touch' | 'page-hidden';
export interface OrderUndo {
  readonly token: string; readonly orderId: string; readonly expiresAt: number;
  readonly remainingMs: number; readonly pausedReasons: readonly OrderUndoPauseReason[];
  readonly before: OrderRuntime; readonly after: OrderRuntime;
}
export interface OrderAlert { readonly visible: boolean; readonly notifiedIds: readonly string[] }
/** RunState에서 주문 부분만 뽑은 조각. 순수 함수는 이 조각만 읽고 쓴다. */
export interface OrdersSlice {
  readonly orders: readonly OrderRuntime[]; readonly orderRevision: number; readonly orderUndo: OrderUndo | null;
}
export type OrderCommandResult =
  | { readonly status: 'applied' }
  | { readonly status: 'unchanged'; readonly code: 'UNKNOWN_ORDER' | 'NOT_OPEN' | 'NOT_REOPENABLE' | 'UNDO_UNAVAILABLE' };
export interface OpenOrderRow {
  readonly id: string; readonly no: number; readonly orderedAt: string; readonly menuText: string; readonly items: readonly OrderItem[];
  readonly elapsedMin: number; readonly usualMin: number; readonly isSlow: boolean; readonly isMissing: boolean;
}
export interface DoneOrderRow {
  readonly id: string; readonly no: number; readonly orderedAt: string; readonly menuText: string; readonly items: readonly OrderItem[];
  readonly doneAt: string; readonly waitMin: number; readonly completedInRun: boolean;
}
export interface OrderSummary {
  /** Active order amounts, independent of settlement/recognition. POS replaces orderGross with the ledger gross. */
  readonly todayCount: number; readonly orderGross: number; readonly doneCount: number; readonly openCount: number; readonly canceledCount: number;
  readonly slowCount: number; readonly missingCount: number; readonly missingIds: readonly string[];
  /** 완료 주문이 없으면 null (패널: '아직 없어요'). */
  readonly avgWaitMin: number | null; readonly recent10: number; readonly prev10: number; readonly rush: boolean;
  readonly openList: readonly OpenOrderRow[]; readonly doneList: readonly DoneOrderRow[];
}
