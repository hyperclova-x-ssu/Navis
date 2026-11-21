import { completeOrder, reopenOrder, startOrder, undoOrderComplete } from '../../orders';
import type { OrderCommandOutcome, OrdersSlice } from '../../orders';
import type { PosState } from '../../contracts/pos';
import { orderRuntime } from './inputs';
import type { OrderStatusClock, OrderStatusCommand, OrderStatusOutcome, OrderStatusSlice } from './types';

export const createOrderStatusSlice = (pos: PosState): OrderStatusSlice => ({ pos, orderUndo: null });

/** Pure state patch. T-248 wraps it in the existing meta/idempotency and atomic publication boundary. */
export function applyOrderStatusCommand(slice: OrderStatusSlice, command: OrderStatusCommand, clock: OrderStatusClock): OrderStatusOutcome {
  const input: OrdersSlice = { orders: slice.pos.orders.map(orderRuntime), orderRevision: slice.pos.revision, orderUndo: slice.orderUndo };
  let outcome: OrderCommandOutcome;
  switch (command.type) {
    case 'order.start': outcome = startOrder(input, command.orderId, clock.now, clock.businessNow, clock.token); break;
    case 'order.complete': outcome = completeOrder(input, command.orderId, clock.now, clock.businessNow, clock.token); break;
    case 'order.reopen': outcome = reopenOrder(input, command.orderId); break;
    case 'order.undo': outcome = undoOrderComplete(input, command.token, clock.now); break;
  }
  if (outcome.result.status === 'unchanged') return { slice, result: outcome.result };
  const next = new Map(outcome.slice.orders.map(order => [order.id, order]));
  const orders = slice.pos.orders.map((order, index) => {
    const runtime = next.get(order.orderId)!;
    if (runtime === input.orders[index]) return order;
    return { ...order, preparation: runtime.status === 'done' ? 'completed' as const : runtime.status === 'open' ? 'accepted' as const : runtime.status,
      preparedAt: runtime.preparedAt ?? null, completedAt: runtime.doneAt, completedInRun: runtime.completedInRun };
  });
  return { slice: { pos: { ...slice.pos, revision: slice.pos.revision + 1, seq: slice.pos.seq + 1, orders }, orderUndo: outcome.slice.orderUndo }, result: outcome.result };
}
