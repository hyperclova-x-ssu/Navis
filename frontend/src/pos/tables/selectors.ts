import type { PosBillQuote, PosCart, PosReadSnapshot, PosReservationRead, PosTableMap } from '../../contracts/pos';
import { businessNow } from '../clock';
import { quoteCart } from '../domain/cart';
import { canonical, freezePos, money } from '../domain/common';
import { tablesEnabled } from './preferences';

export const isUnpaidBill = (bill: { readonly status: string }) => bill.status === 'open' || bill.status === 'partial';
const minutes = (at: string) => { const time = at.slice(-5); return Number(time.slice(0, 2)) * 60 + Number(time.slice(3)); };
export function reservationInWindow(reservation: PosReservationRead, now = businessNow()): boolean {
  const delta = minutes(now) - minutes(reservation.time);
  return reservation.status === 'confirmed' && !reservation.allocationWarning && reservation.date === now.slice(0, 10) && delta >= -30 && delta < 120;
}

const billQuotes = new WeakMap<PosReadSnapshot, Map<string, PosBillQuote>>();
/** Payment uses current catalog prices/costs; order records retain their historical snapshots. */
export function quoteBill(read: PosReadSnapshot, billId: string): PosBillQuote {
  let cache = billQuotes.get(read); if (!cache) { cache = new Map(); billQuotes.set(read, cache); }
  const hit = cache.get(billId); if (hit) return hit;
  const bill = read.pos.bills.find(b => b.billId === billId);
  const allocations = read.pos.billAllocations.filter(a => a.billId === billId && a.qty > 0);
  const orders = read.pos.orders.filter(o => o.preparation !== 'canceled' && o.lines.some(l => allocations.some(a => a.orderLineId === l.orderLineId)));
  const orderLines = orders.flatMap(o => o.lines);
  const cart: PosCart = { cartId: `bill:${billId}`, revision: read.posRevision, type: 'dine_in', memo: '', lock: null,
    lines: allocations.flatMap(a => {
      const line = orderLines.find(l => l.orderLineId === a.orderLineId);
      if (!line) return [];
      const options = line.optionsAtOrder.map(o => ({ ...o, groupId: '', extraCost: null }));
      return [{ lineId: a.allocationId, menuId: line.menuId, selectedOptionIds: options.map(o => o.optionId), qty: a.qty, request: line.request,
        snapshot: { name: line.nameAtOrder, basePrice: line.unitPriceAtOrder - options.reduce((n, o) => n + o.extraPrice, 0), baseCost: null, options } }];
    }) };
  const quote = quoteCart({ ...read, pos: { ...read.pos, cart } }, cart.cartId);
  const discount = bill?.discounts.reduce((n, d) => n + d.amount, 0) ?? 0;
  const received = read.pos.payments.filter(p => p.billId === billId && p.status === 'paid').reduce((n, p) => n + p.amount, 0);
  const payable = quote.gross - discount, remaining = payable - received;
  const issues = [...quote.issues];
  if (!bill) issues.unshift({ reason: 'NOT_FOUND', messageKey: 'run.session.conflict' });
  else if (!isUnpaidBill(bill)) issues.unshift({ reason: 'STATE_CONFLICT', messageKey: 'run.session.conflict' });
  if (cart.lines.length !== allocations.length) issues.push({ reason: 'QTY_ALLOCATION_INVALID', messageKey: 'run.session.conflict' });
  if (![discount, payable, received, remaining].every(money)) issues.push({ reason: 'INVALID_AMOUNT', messageKey: 'run.session.conflict' });
  const result = freezePos({ billId, revision: read.posRevision, orderIds: orders.map(o => o.orderId), lines: quote.lines, totalQty: quote.totalQty,
    gross: quote.gross, discount, payable, received, remaining, canSubmit: issues.length === 0, issues,
    fingerprint: canonical({ bill, allocations, quote: quote.fingerprint, costs: quote.lines.map(l => [l.baseCost, l.optionCost]), received }) });
  cache.set(billId, result); return result;
}
const unpaid = new WeakMap<PosReadSnapshot, readonly PosBillQuote[]>();
export function selectUnpaidBills(read: PosReadSnapshot): readonly PosBillQuote[] {
  const hit = unpaid.get(read); if (hit) return hit;
  const result = freezePos(read.pos.bills.filter(isUnpaidBill).map(b => quoteBill(read, b.billId)));
  unpaid.set(read, result); return result;
}
const maps = new WeakMap<PosReadSnapshot, Map<string, PosTableMap>>();
export function selectTableMap(read: PosReadSnapshot, now = businessNow()): PosTableMap {
  let cache = maps.get(read); if (!cache) { cache = new Map(); maps.set(read, cache); }
  const hit = cache.get(now); if (hit) return hit;
  const enabled = tablesEnabled(read.settings), unpaidBills = selectUnpaidBills(read);
  const tables = enabled ? (read.settings.tableLayout?.tables ?? []).map(table => {
    const bills = read.pos.bills.filter(b => b.tableId === table.tableId && isUnpaidBill(b));
    const quotes = bills.map(b => quoteBill(read, b.billId));
    const orders = read.pos.orders.filter(o => quotes.some(q => q.orderIds.includes(o.orderId)));
    const reservations = (read.data.reservations ?? []).filter(r => r.tableId === table.tableId && r.status === 'confirmed' && !r.allocationWarning && r.date === now.slice(0, 10)).sort((a, b) => a.time.localeCompare(b.time));
    const active = reservations.find(r => reservationInWindow(r, now));
    const reservation = active ?? reservations.find(r => minutes(r.time) > minutes(now)) ?? null;
    const cleaning = read.pos.tableSessions.some(s => s.tableId === table.tableId && s.cleaning);
    const state = bills.some(b => b.status === 'partial' || b.requestedAt) ? 'payment_pending' as const : bills.length ? 'occupied' as const
      : cleaning ? 'cleaning' as const : active ? 'reserved' as const : 'empty' as const;
    const first = orders.map(o => o.orderedAt).sort()[0];
    return { tableId: table.tableId, number: table.number, seats: table.seats, state, billIds: bills.map(b => b.billId),
      total: quotes.reduce((n, q) => n + q.remaining, 0), elapsed: first ? Math.max(0, minutes(now) - minutes(first)) : 0, orderCount: orders.length, reservation };
  }) : [];
  const result = freezePos({ enabled, layout: read.settings.tableLayout, tables, unpaidBills });
  cache.set(now, result); return result;
}
