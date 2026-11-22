import { parseBill, type ReadPosCatalog } from '../../catalog.ts';
import { assertReservationBinding, operatingBillCommand } from '../../claims.ts';
import { appendOutbox, applyCommand, openDay } from '../../ledger.ts';
import { correctPayment, parseReversal, quoteReversal, receipt, type createReversalTokens } from '../../reversals.ts';
import { assertNoPendingApproval, insertBill, quoteOpenBill, readBill, recognizeSale, setPreparation } from '../../sales.ts';
import { commandReceipt, integer, methods, object, PosError, uuid, type PosTx } from '../../wire.ts';
import { billDetail, listBills, listInput, listOrders, orderDetail, page } from './reads.ts';
import { readCouponSales } from './coupon-sales.ts';
import { acceptOrder, appendOrder, mergeBills, moveBill, splitBill } from './postpaid.ts';
import { undoTransfer } from './transfer-undo.ts';
import { changeTable, confirm, createTable, endTableSession, listTables, openTableSession,
  parseTableRef, readTable, tableStates } from './tables.ts';
import { connectSource, parseTerminal, requireTerminal } from './terminal.ts';

export type PosOwnerRoute = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, mode: 'read' | 'command',
  handler: (tx: PosTx, params: { storeId: string; id?: string }, body: unknown, key: string, query: unknown) => Promise<unknown>,
) => void;

function createBill(tx: PosTx, key: string, body: unknown, readCatalog?: ReadPosCatalog) {
  const { table, postpaid, reservationId: reservation, ...draft } = object(body, ['type', 'lines', 'discount', 'table', 'postpaid', 'reservationId']);
  const reservationId = reservation === undefined ? undefined : uuid(reservation);
  const bill = parseBill(draft);
  const reference = parseTableRef(table);
  if (postpaid !== undefined && postpaid !== true) throw new PosError(400, 'INVALID_REQUEST');
  const deferred = !!reference || postpaid === true;
  if (deferred && bill.type !== 'dine_in') throw new PosError(400, 'ORDER_TYPE_INVALID');
  if (reservationId && !deferred) throw new PosError(400, 'RESERVATION_REQUIRES_POSTPAID');
  return applyCommand(tx, operatingBillCommand, key, { bill, table: reference, postpaid, ...(reservationId && { reservationId }) }, async () => {
    const claim = await assertReservationBinding(tx, key, reservationId, reference?.tableId ?? null);
    const { billId, quote, day } = await insertBill(tx, bill, readCatalog, deferred);
    if (reference) await openTableSession(tx, reference, billId);
    const orderId = deferred ? await acceptOrder(tx, billId, day, quote.lines) : undefined;
    const sources = ['pos.bills', ...(orderId ? ['pos.orders'] : []), ...(reference ? ['pos.tables'] : [])];
    const reservationLink = claim && orderId ? { billId, orderId, tableId: reference?.tableId ?? null } : undefined;
    if (claim && reservationLink) {
      await appendOutbox(tx, 'pos.reservation_order_linked.v1', claim.reservationId, { ...claim, ...reservationLink });
      sources.push('voice-booking', 'reservations', 'calendar', 'briefing');
    }
    return { ...commandReceipt(billId, 1, sources), quote, ...(orderId && { orderId, orderIds: [orderId] }),
      ...(reservationLink && { reservationId, reservationLink }) };
  });
}

function recordPayment(tx: PosTx, key: string, billId: string, body: unknown, readCatalog?: ReadPosCatalog) {
  const input = object(body, ['method', 'amount', 'quoteRevision', 'terminal']);
  const method = methods.find((candidate) => candidate === input.method);
  if (!method) throw new PosError(400, 'INVALID_PAYMENT_METHOD');
  const terminal = parseTerminal(input.terminal);
  requireTerminal(method === 'cash' ? 'cash_record' : 'terminal_record', terminal);
  const amount = integer(input.amount, 1, Number.MAX_SAFE_INTEGER, 'INVALID_AMOUNT');
  const quoteRevision = integer(input.quoteRevision, 0);
  return applyCommand(tx, 'payment.record', key, { billId, method, amount, quoteRevision, terminal }, async () => {
    const businessDate = await openDay(tx);
    const quote = await quoteOpenBill(tx, billId, businessDate, readCatalog);
    if (quoteRevision !== quote.quoteRevision) throw new PosError(409, 'QUOTE_CHANGED', { quote });
    if (amount !== quote.payable) throw new PosError(400, 'ALLOCATION_SUM_MISMATCH', { payable: quote.payable });
    await assertNoPendingApproval(tx, billId);
    const { value: { orderIds, paymentId, settlementId } } = await recognizeSale(tx,
      { billId, businessDate, splits: [{ method, amount }] }, quote, { terminal, source: connectSource(key, quoteRevision, terminal) });
    const sources = ['pos.bills', 'pos.orders', 'pos.receipts', 'pos.sales'];
    if (await endTableSession(tx, billId, 'cleaning')) sources.push('pos.tables');
    return { ...commandReceipt(paymentId, 1, sources, paymentId), billId, orderId: orderIds[0], orderIds, paymentId, settlementId };
  });
}

function voidBill(tx: PosTx, key: string, billId: string, body: unknown) {
  const input = object(body, ['expectedRevision', 'confirmed']);
  confirm(input.confirmed);
  const expectedRevision = integer(input.expectedRevision, 1);
  return applyCommand(tx, 'bill.void', key, { billId, expectedRevision }, async () => {
    const bill = await readBill(tx, billId);
    if (bill.status !== 'open' || expectedRevision !== bill.revision) {
      throw new PosError(409, 'STALE_REVISION', { revision: bill.revision + Number(bill.status !== 'open') });
    }
    if (await openDay(tx) !== bill.day) throw new PosError(409, 'DAY_CLOSED');
    await assertNoPendingApproval(tx, billId);
    await tx.db.query("UPDATE pos.bill SET status = 'void' WHERE store_id = $1 AND bill_id = $2", [tx.storeId, billId]);
    const sources = bill.draft.postpaid ? ['pos.bills', 'pos.orders'] : ['pos.bills'];
    if (await endTableSession(tx, billId, 'empty')) sources.push('pos.tables');
    return commandReceipt(billId, bill.revision + 1, sources);
  });
}

// Bind to the POS service's authenticated gateway-owner registrar. Commands must
// share the existing scoped transaction and per-store write lock.
export function registerPosRealityRoutes(owner: PosOwnerRoute, tokens: ReturnType<typeof createReversalTokens>,
  { readCatalog }: { readCatalog?: ReadPosCatalog } = {}) {
  owner('GET', '/tables', 'read', async (tx, _params, _body, _key, query) => {
    const options = listInput(query, tableStates);
    return page(tx, await listTables(tx, options), options.limit, (row) => row.tableId);
  });
  owner('GET', '/tables/:id', 'read', (tx, { id }) => readTable(tx, uuid(id)));
  owner('POST', '/tables', 'command', (tx, _params, body, key) => createTable(tx, key, body));
  owner('PATCH', '/tables/:id', 'command', (tx, { id }, body, key) => changeTable(tx, key, uuid(id), body));
  owner('DELETE', '/tables/:id', 'command', (tx, { id }, body, key) => changeTable(tx, key, uuid(id), body, true));

  owner('GET', '/bills', 'read', (tx, _params, _body, _key, query) => listBills(tx, query));
  owner('GET', '/coupon-sales', 'read', (tx, _params, _body, _key, query) => readCouponSales(tx, query));
  owner('GET', '/bills/:id', 'read', (tx, { id }) => billDetail(tx, uuid(id)));
  owner('POST', '/bills', 'command', (tx, _params, body, key) => createBill(tx, key, body, readCatalog));
  owner('POST', '/bills/:id/orders', 'command', (tx, { id }, body, key) => appendOrder(tx, key, uuid(id), body, readCatalog));
  owner('POST', '/bills/:id/move', 'command', (tx, { id }, body, key) => moveBill(tx, key, uuid(id), body));
  owner('POST', '/bills/:id/merge', 'command', (tx, { id }, body, key) => mergeBills(tx, key, uuid(id), body));
  owner('POST', '/bills/:id/split', 'command', (tx, { id }, body, key) => splitBill(tx, key, uuid(id), body));
  owner('POST', '/receipts/:id/undo', 'command', (tx, { id }, body, key) => undoTransfer(tx, key, uuid(id), body));
  owner('POST', '/bills/:id/void', 'command', (tx, { id }, body, key) => voidBill(tx, key, uuid(id), body));
  owner('POST', '/settlement-quotes', 'read', async (tx, _params, body) => {
    const billId = uuid(object(body, ['billId']).billId);
    return { billId, ...await quoteOpenBill(tx, billId, await openDay(tx), readCatalog) };
  });
  owner('POST', '/bills/:id/payments', 'command', (tx, { id }, body, key) => recordPayment(tx, key, uuid(id), body, readCatalog));

  owner('GET', '/orders', 'read', (tx, _params, _body, _key, query) => listOrders(tx, query));
  owner('GET', '/orders/:id', 'read', (tx, { id }) => orderDetail(tx, uuid(id)));
  owner('POST', '/orders/:id/preparation', 'command', (tx, { id }, body, key) => {
    const { status, expectedRevision } = object(body, ['status', 'expectedRevision']);
    if (status !== 'preparing' && status !== 'completed') throw new PosError(400, 'INVALID_STATUS');
    return setPreparation(tx, key, uuid(id), status, integer(expectedRevision, 1));
  });
  owner('GET', '/payments/:id/receipt', 'read', (tx, { id }) => receipt(tx, uuid(id)));
  owner('POST', '/payments/:id/reversal-quote', 'read', (tx, { id }, body) => quoteReversal(tx, tokens, uuid(id), parseReversal(body)));
  owner('POST', '/settlements/:id/corrections', 'command', (tx, { id }, body, key) => {
    const { quoteToken, confirmed, terminal } = object(body, ['quoteToken', 'confirmed', 'terminal']);
    confirm(confirmed);
    if (typeof quoteToken !== 'string' || !quoteToken || quoteToken.length > 8192) throw new PosError(400, 'INVALID_REQUEST');
    return correctPayment(tx, tokens, key, quoteToken, { settlementId: uuid(id), terminal: parseTerminal(terminal) });
  });
}
