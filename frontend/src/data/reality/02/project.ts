/**
 * REAL-PLAN F02 — server POS rows → the browser's `PosState`.
 *
 * Widgets, the receipt, order status, the day totals, the ledger and the Navis facts all read `PosState`, so the real records are
 * projected into the same row shapes (never a second model). Everything here is pure; `bridge.ts` publishes the result through the
 * session commit. Keep server preparation times and correction lines when present, with compatibility for older rows.
 */
import type {
  PosBill, PosBillAllocation, PosCancellation, PosCart, PosMethod, PosOrder, PosOrderLine, PosPayment, PosRefund, PosState,
} from '../../../contracts/pos';
import { CONNECT_SOURCE } from '../../../connect-kiosk/channel';
import { canonicalPosMoney } from '../../../pos/domain/money';
import type { MoneyState } from '../../iteration7/accounting/types';
import { kstLocal } from './clock';
import type { PosBillDto, PosCorrectionDto, PosOrderDto, PosReceiptDto, PosSaleLineDto, PosTableDto } from './dto';
import { projectMemberSales } from './member-sales';

export interface PosServerRows {
  readonly orders: readonly PosOrderDto[];
  readonly bills: readonly PosBillDto[];
  readonly tables?: readonly PosTableDto[];
  /** Keyed by payment ID, or the settlement ID when no tender was received. */
  readonly receipts: ReadonlyMap<string, PosReceiptDto>;
}

const emptyCart = (cart: PosCart): PosCart => ({ cartId: cart.cartId, revision: cart.revision + 1, type: cart.type, memo: '', lines: [], lock: null });

function allocationsOf(lines: readonly PosSaleLineDto[], receipt: PosReceiptDto, corrections: readonly PosCorrectionDto[]) {
  // The receipt reports what is still returnable per line; the difference to the sale is what the cancel corrections took back.
  const remaining = new Map(receipt.reversalLines.map(line => [line.orderLineId, line.quantity]));
  const cancels = corrections.filter(correction => correction.kind === 'cancel');
  const last = cancels.at(-1);
  return new Map(cancels.map(correction => [correction.correctionId, correction.lines ? correction.lines.map(row => {
    const line = lines.find(candidate => candidate.allocationId === row.allocationId);
    const cost = !line || line.baseCost === null || line.optionCost === null ? null : (line.baseCost + line.optionCost) * row.qty;
    return { lineId: row.orderLineId, allocationId: row.allocationId, qty: row.qty, gross: row.gross, discount: row.discount, cost };
  }) : correction === last
    ? lines.flatMap(line => {
      const qty = line.qty - (remaining.get(line.orderLineId) ?? 0);
      if (qty <= 0) return [];
      const share = (value: number) => Math.round(value * qty / line.qty);
      const cost = line.baseCost === null || line.optionCost === null ? null : (line.baseCost + line.optionCost) * qty;
      return [{ lineId: line.orderLineId, allocationId: line.allocationId, qty, gross: share(line.gross), discount: share(line.discount), cost }];
    }) : []] as const));
}

const lineOf = (line: PosSaleLineDto, canceledQty: number): PosOrderLine => ({
  orderLineId: line.orderLineId, menuId: line.menuId, nameAtOrder: line.name, qty: line.qty, unitPriceAtOrder: line.basePrice + line.optionPrice,
  optionsAtOrder: line.options.map(option => ({ optionId: option.optionId, name: option.name, extraPrice: option.extraPrice, extraRecipe: [] })),
  request: '', canceledQty,
});

/**
 * The money rows this projection derived earlier (settlements, payments and recognitions it named `legacy:*`, and the corrections of the
 * previous projected sales) are dropped before deriving again, so a re-read never counts a sale twice. Everything else in the money
 * source (member accounts, passes, custom orders) is another domain's and stays.
 */
function withoutProjectedSales(money: MoneyState, previous: PosState): MoneyState {
  const correctionIds = new Set([...previous.cancellations.map(row => row.cancellationId), ...previous.refunds.map(row => row.refundId)]);
  const derived = new Set(money.settlements.filter(row => row.settlementId.startsWith('legacy:')).map(row => row.settlementId));
  return {
    ...money,
    settlements: money.settlements.filter(row => !derived.has(row.settlementId)),
    payments: money.payments.filter(row => !derived.has(row.settlementId)),
    recognitions: money.recognitions.filter(row => !row.recognitionId.startsWith('legacy:')),
    corrections: money.corrections.filter(row => !correctionIds.has(row.correctionId) && !derived.has(row.settlementId)),
  };
}

/**
 * Replace the sale and table-session rows of `base` with the service's records of the business day. The cart, drawer,
 * reservation prompts and the money opening balances stay as they are. `money` is a new object so the session commit treats the
 * result as a plain publication and does not plan legacy corrections for the projected rows.
 */
export function projectPosState(base: PosState, rows: PosServerRows, options: { readonly clearCart?: boolean } = {}): PosState {
  const layouts = new Map((rows.tables ?? []).flatMap(table => table.layoutTableId && table.state !== 'archived' ? [[table.tableId, table.layoutTableId] as const] : []));
  const billById = new Map(rows.bills.filter(bill => bill.status !== 'open' || bill.orderIds?.length).map(bill => [bill.billId, bill]));
  const receiptByBill = new Map([...rows.receipts].map(([id, receipt]) => [receipt.billId, { id, receipt }]));
  const ordered = [...rows.orders].sort((a, b) => a.orderedAt.localeCompare(b.orderedAt) || a.orderNo - b.orderNo);
  const orders: PosOrder[] = [], bills: PosBill[] = [], billAllocations: PosBillAllocation[] = [], payments: PosPayment[] = [];
  const cancellations: PosCancellation[] = [], refunds: PosRefund[] = [];
  const canceledQty = new Map<string, number>();
  let seq = base.seq;

  for (const order of ordered) {
    const id = order.paymentId ?? order.settlementId;
    if (id && !rows.receipts.has(id)) throw new Error(`MISSING_RECEIPT:${id}`);
    // A retained paid-order page may include a row beyond the bill page's bound.
    if (id && !billById.has(order.billId)) billById.set(order.billId, {
      billId: order.billId, businessDate: order.businessDate, status: 'paid', revision: order.revision,
      type: order.tableId ? 'dine_in' : 'takeout', createdAt: order.orderedAt, recognizedAt: order.orderedAt, tableId: order.tableId, orderIds: [order.orderId],
      quote: { quoteRevision: 0, lines: order.lines, payable: order.amount, gross: order.lines.reduce((n, line) => n + line.gross, 0), discount: order.lines.reduce((n, line) => n + line.discount, 0) },
    });
  }

  for (const bill of billById.values()) {
    const record = receiptByBill.get(bill.billId);
    const receipt = record?.receipt;
    const at = receipt ? kstLocal(receipt.at) : undefined;
    const lines = bill.quote.lines;
    const discountId = `${bill.billId}:discount:1`, discountTotal = lines.reduce((sum, line) => sum + line.discount, 0);
    const first = ordered.find(order => bill.orderIds?.includes(order.orderId) ?? order.billId === bill.billId);
    for (const line of lines) billAllocations.push({ allocationId: line.allocationId, billId: bill.billId, orderLineId: line.orderLineId, qty: line.qty });
    bills.push({
      billId: bill.billId, originOrderNo: first?.orderNo ?? receipt?.orderNos[0] ?? 0,
      tableId: bill.tableId ? layouts.get(bill.tableId) ?? bill.tableId : null, status: bill.status, settledAt: at, recognizedAt: at,
      ...(receipt?.memberId ? { memberId: receipt.memberId } : {}),
      discounts: discountTotal > 0 ? [{ discountId, billId: bill.billId, source: 'direct', scope: 'bill', amount: discountTotal }] : [],
      settlementLines: receipt ? lines.map(line => ({
        allocationId: line.allocationId, menuId: line.menuId, qty: line.qty, basePriceAtSale: line.basePrice, optionPriceAtSale: line.optionPrice,
        unitCostAtSale: line.baseCost, optionCostAtSale: line.optionCost, recognizedQty: line.qty,
        discountAllocations: line.discount > 0 ? [{ discountId, amount: line.discount }] : [],
      })) : [],
    });
    if (!record || !receipt || !at) continue;
    const allocated = allocationsOf(lines, receipt, receipt.corrections);
    for (const fragments of allocated.values()) for (const row of fragments) canceledQty.set(row.lineId, (canceledQty.get(row.lineId) ?? 0) + row.qty);
    const counted = (receipt.splits[0]?.method ?? 'cash') as PosMethod;
    payments.push({
      paymentId: record.id, billId: bill.billId, at, seq: payments.length + 1, transactionNo: receipt.transactionNo ?? '',
      // The number the owner copied from the terminal slip is the approval number; cash has only the service's own number.
      approvalNo: receipt.terminal?.approvalNo ?? receipt.terminal?.receiptNo ?? receipt.approvalNo ?? '',
      amount: receipt.amount, splits: receipt.splits.map(split => ({ method: split.method, amount: split.amount })), countedMethod: counted,
      status: receipt.status === 'canceled' ? 'canceled' : 'paid', recognizedAt: at,
    });
    for (const correction of receipt.corrections) {
      seq = Math.max(seq, correction.seq);
      const common = { paymentId: record.id, billId: bill.billId, at: kstLocal(correction.at), seq: correction.seq, amount: correction.amount,
        methodAmounts: correction.methods.map(split => ({ method: split.method, amount: split.amount })), reason: '' };
      if (correction.kind === 'cancel') cancellations.push({ ...common, cancellationId: correction.correctionId, allocations: allocated.get(correction.correctionId) ?? [], restockRetail: correction.restockRetail });
      else refunds.push({ ...common, refundId: correction.correctionId, lineAmounts: [] });
    }
  }
  for (const order of ordered) {
    const orderedAt = kstLocal(order.orderedAt);
    const fullyCanceled = order.status === 'void' || order.lines.every(line => (canceledQty.get(line.orderLineId) ?? 0) >= line.qty);
    orders.push({
      orderId: order.orderId, orderNo: order.orderNo, orderedAt, seq: order.orderNo, type: billById.get(order.billId)?.type ?? (order.tableId ? 'dine_in' : 'takeout'),
      originBillId: order.billId, lines: order.lines.map(line => lineOf(line, canceledQty.get(line.orderLineId) ?? 0)),
      memo: order.source === 'connect' ? CONNECT_SOURCE : '',
      preparation: fullyCanceled ? 'canceled' : order.preparation,
      preparedAt: order.preparingAt ? kstLocal(order.preparingAt) : order.preparingAt === undefined && order.preparation !== 'accepted' ? orderedAt : null,
      completedAt: order.completedAt ? kstLocal(order.completedAt) : order.completedAt === undefined && order.preparation === 'completed' ? orderedAt : null,
      completedInRun: false,
    });
  }
  seq = Math.max(seq, payments.length);
  const projected: PosState = {
    ...base, revision: base.revision + 1, seq,
    orders, bills, billAllocations, payments, refunds, cancellations, receipts: payments.map(payment => ({ paymentId: payment.paymentId, billId: payment.billId })),
    ...(rows.tables ? { tableSessions: rows.tables.flatMap(table => {
      const id = layouts.get(table.tableId);
      if (!id || (table.state !== 'occupied' && table.state !== 'cleaning')) return [];
      return [{ tableId: id, billId: table.billId ?? table.lastBillId ?? undefined, cleaning: table.state === 'cleaning' }];
    }) } : {}),
    cashReceipts: [], money: base.money ? withoutProjectedSales(base.money, base) : base.money,
    ...(options.clearCart ? { cart: emptyCart(base.cart) } : {}),
  };
  // The day totals, ledger and margin read `pos.money`: the projected sales are written into it (a new object, never the base's).
  if (!projected.money) return projected;
  const memberSales = [...rows.receipts.values()].filter(receipt => receipt.containsMemberValue);
  const memberBillIds = new Set(memberSales.map(receipt => receipt.billId));
  const legacy = { ...projected, payments: payments.filter(payment => !memberBillIds.has(payment.billId)),
    cancellations: cancellations.filter(row => !memberBillIds.has(row.billId)), refunds: refunds.filter(row => !memberBillIds.has(row.billId)) };
  return { ...projected, money: projectMemberSales(projected, canonicalPosMoney(legacy) ?? projected.money, memberSales) };
}
