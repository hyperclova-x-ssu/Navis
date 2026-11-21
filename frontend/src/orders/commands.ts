import {ORDER_UNDO_MS} from './time';
import type {OrderCommandResult, OrderRecord, OrderRuntime, OrdersSlice, OrderUndo, OrderUndoPauseReason} from './types';

export interface OrderCommandOutcome { readonly slice: OrdersSlice; readonly result: OrderCommandResult }
const unchanged = (slice: OrdersSlice, code: Extract<OrderCommandResult, {status: 'unchanged'}>['code']): OrderCommandOutcome =>
  ({slice, result: {status: 'unchanged', code}});

export function initialOrdersSlice(records: readonly OrderRecord[]): OrdersSlice {
  return {orders: records.map(r => ({id: r.id, status: r.initialStatus, doneAt: r.initialDoneAt, completedInRun: false})), orderRevision: 0, orderUndo: null};
}
function apply(slice: OrdersSlice, before: OrderRuntime, after: OrderRuntime, now: number, token: string): OrderCommandOutcome {
  const orderUndo: OrderUndo = {token, orderId: before.id, before, after, expiresAt: now + ORDER_UNDO_MS, remainingMs: ORDER_UNDO_MS, pausedReasons: []};
  return {slice: {orders: slice.orders.map(o => o.id === before.id ? after : o), orderRevision: slice.orderRevision + 1, orderUndo}, result: {status: 'applied'}};
}
export function startOrder(slice: OrdersSlice, orderId: string, now: number, businessNow: string, token = `order-undo-${slice.orderRevision + 1}`): OrderCommandOutcome {
  const run = slice.orders.find(o => o.id === orderId);
  if (!run) return unchanged(slice, 'UNKNOWN_ORDER');
  if (run.status !== 'accepted' && run.status !== 'open') return unchanged(slice, 'NOT_OPEN');
  return apply(slice, run, {...run, status: 'preparing', preparedAt: businessNow}, now, token);
}
/** Business timestamps and monotonic undo deadlines are separate injected clocks. */
export function completeOrder(slice: OrdersSlice, orderId: string, now: number, businessNow: string, token = `order-undo-${slice.orderRevision + 1}`): OrderCommandOutcome {
  const run = slice.orders.find(o => o.id === orderId);
  if (!run) return unchanged(slice, 'UNKNOWN_ORDER');
  if (run.status === 'done' || run.status === 'canceled') return unchanged(slice, 'NOT_OPEN');
  return apply(slice, run, {...run, status: 'done', doneAt: businessNow, completedInRun: true, completedFrom: run.status}, now, token);
}
export function isOrderUndoLive(undo: OrderUndo, now: number): boolean {
  return undo.pausedReasons.length > 0 ? undo.remainingMs > 0 : now < undo.expiresAt;
}
export function pauseOrderUndo(undo: OrderUndo | null, reason: OrderUndoPauseReason, now: number): OrderUndo | null {
  if (!undo || undo.pausedReasons.includes(reason)) return undo;
  if (!isOrderUndoLive(undo, now)) return null;
  return {...undo, remainingMs: undo.pausedReasons.length ? undo.remainingMs : Math.max(0, undo.expiresAt - now), pausedReasons: [...undo.pausedReasons, reason]};
}
export function resumeOrderUndo(undo: OrderUndo | null, reason: OrderUndoPauseReason, now: number): OrderUndo | null {
  if (!undo || !undo.pausedReasons.includes(reason)) return undo;
  const pausedReasons = undo.pausedReasons.filter(value => value !== reason);
  return {...undo, pausedReasons, expiresAt: pausedReasons.length ? undo.expiresAt : now + undo.remainingMs};
}
function sameWriteSet(a: OrderRuntime, b: OrderRuntime): boolean {
  return a.id === b.id && a.status === b.status && a.doneAt === b.doneAt && a.preparedAt === b.preparedAt && a.completedInRun === b.completedInRun && a.completedFrom === b.completedFrom;
}
/** 6초 되돌리기 바. token 1회 소비, 만료·교체된 token은 unchanged. */
export function undoOrderComplete(slice: OrdersSlice, token: string, now: number): OrderCommandOutcome {
  const undo = slice.orderUndo;
  if (!undo || undo.token !== token || !isOrderUndoLive(undo, now)) return unchanged(slice, 'UNDO_UNAVAILABLE');
  const run = slice.orders.find(o => o.id === undo.orderId);
  if (!run || !sameWriteSet(run, undo.after)) return unchanged(slice, 'UNDO_UNAVAILABLE');
  return {
    slice: {orders: slice.orders.map(o => (o.id === run.id ? undo.before : o)),
      orderRevision: slice.orderRevision + 1, orderUndo: null},
    result: {status: 'applied'},
  };
}
/** '완료된 주문'의 진행 중으로 되돌리기. completedInRun인 주문만. */
export function reopenOrder(slice: OrdersSlice, orderId: string): OrderCommandOutcome {
  const run = slice.orders.find(o => o.id === orderId);
  if (!run) return unchanged(slice, 'UNKNOWN_ORDER');
  if (run.status !== 'done' || !run.completedInRun) return unchanged(slice, 'NOT_REOPENABLE');
  return {
    slice: {
      orders: slice.orders.map(o => (o.id === orderId ? {...o, status: o.completedFrom ?? (o.preparedAt ? 'preparing' : 'accepted'), doneAt: null, completedInRun: false, completedFrom: undefined} : o)),
      orderRevision: slice.orderRevision + 1,
      orderUndo: slice.orderUndo?.orderId === orderId ? null : slice.orderUndo,
    },
    result: {status: 'applied'},
  };
}
