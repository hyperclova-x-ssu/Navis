import {toMinutes} from './time';
import type {DoneOrderRow, MenuItem, OpenOrderRow, OrderInputs, OrderItem, OrderRecord, OrderRuntime, OrderSummary} from './types';

export const MISSING_MIN = 20;

export function usualMin(record: OrderRecord, catalog: readonly MenuItem[]): number {
  const active = record.lines.filter(line => line.qty > 0);
  if (!active.length) return 0;
  const longest = Math.max(...active.map(l => catalog.find(item => item.menuId === l.menuId)?.prepMin ?? 3));
  const qty = active.reduce((s, l) => s + l.qty, 0);
  return Math.min(9, longest + (qty - 1));
}
/** Korean fixture text (tests and Korean-only dev hosts). Screens translate `orderItems` instead. */
export const menuText = (record: OrderRecord): string =>
  record.lines.map(l => (l.qty > 1 ? `${l.menu} ${l.qty}` : l.menu)).join(', ');
export const orderItems = (record: OrderRecord, catalog: readonly MenuItem[]): readonly OrderItem[] => record.lines.map(l => ({
  menuId: l.menuId, name: l.menu, menuKey: catalog.find(item => item.menuId === l.menuId)?.key ?? '', qty: l.qty,
}));

function compute(orders: readonly OrderRuntime[], input: OrderInputs): OrderSummary {
  const now = toMinutes(input.businessNow);
  const records = new Map(input.records.map(record => [record.id, record]));
  const open: OpenOrderRow[] = [];
  const done: DoneOrderRow[] = [];
  let orderGross = 0, waitSum = 0, recent10 = 0, prev10 = 0, todayCount = 0, canceledCount = 0;
  for (const run of orders) {
    const r = records.get(run.id);
    if (!r) continue;
    if (run.status === 'canceled') { canceledCount++; continue; }
    todayCount++;
    orderGross += r.amount;
    const at = toMinutes(r.orderedAt);
    if (at > now - 10 && at <= now) recent10++;
    else if (at > now - 20 && at <= now - 10) prev10++;
    if (run.status !== 'done') {
      const elapsedMin = Math.max(0, now - at), usual = usualMin(r, input.catalog);
      const isMissing = elapsedMin >= MISSING_MIN;
      open.push({id: r.id, no: r.no, orderedAt: r.orderedAt, menuText: menuText(r), items: orderItems(r, input.catalog), elapsedMin, usualMin: usual,
        isMissing, isSlow: !isMissing && elapsedMin > 2 * usual});
    } else {
      if (!run.doneAt) continue;
      const waitMin = Math.max(0, toMinutes(run.doneAt) - at);
      waitSum += waitMin;
      done.push({id: r.id, no: r.no, orderedAt: r.orderedAt, menuText: menuText(r), items: orderItems(r, input.catalog), doneAt: run.doneAt, waitMin,
        completedInRun: run.completedInRun});
    }
  }
  open.sort((a, b) => toMinutes(a.orderedAt) - toMinutes(b.orderedAt) || a.no - b.no);
  done.sort((a, b) => toMinutes(b.doneAt) - toMinutes(a.doneAt) || b.no - a.no);
  const missing = open.filter(o => o.isMissing);
  return {
    todayCount, orderGross, doneCount: done.length, openCount: open.length, canceledCount,
    slowCount: open.filter(o => o.isSlow).length, missingCount: missing.length, missingIds: missing.map(o => o.id),
    avgWaitMin: done.length ? Math.round((waitSum / done.length) * 10) / 10 : null,
    recent10, prev10, rush: recent10 >= 5 && recent10 - prev10 >= 3 && open.length >= 4,
    openList: open, doneList: done,
  };
}

const cache = new WeakMap<readonly OrderRuntime[], WeakMap<readonly OrderRecord[], WeakMap<readonly MenuItem[], Map<string, OrderSummary>>>>();
/** Every immutable input, including businessNow, participates in memoization. */
export function selectOrderSummary(slice: {readonly orders: readonly OrderRuntime[]}, input: OrderInputs): OrderSummary {
  let byRecords = cache.get(slice.orders);
  if (!byRecords) { byRecords = new WeakMap(); cache.set(slice.orders, byRecords); }
  let byCatalog = byRecords.get(input.records);
  if (!byCatalog) { byCatalog = new WeakMap(); byRecords.set(input.records, byCatalog); }
  let byTime = byCatalog.get(input.catalog);
  if (!byTime) { byTime = new Map(); byCatalog.set(input.catalog, byTime); }
  const hit = byTime.get(input.businessNow);
  if (hit) return hit;
  const next = compute(slice.orders, input);
  byTime.set(input.businessNow, next);
  return next;
}
