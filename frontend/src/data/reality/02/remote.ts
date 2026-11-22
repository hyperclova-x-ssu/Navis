/**
 * REAL-PLAN F02 — the browser side of the POS service: bounded reads of the business day and the commands of a walk-in sale,
 * over the F00 transport (same-origin session, bearer, `no-store`, `Idempotency-Key`). No PosState knowledge lives here.
 *
 * Commands are the owner's explicit presses; an unknown outcome (network, timeout, 5xx after send) is resent with the SAME key until
 * the service returns the stored receipt, so a retry never records a second sale.
 */
import type { PosMethod } from '../../../contracts/pos';
import { createNaverPosRemote, type NaverPosRemote } from './naver';
import { PortError, type PortReads, type PortRequest, type PortTransport } from '../00/port';
import { createPortReads, toPortError } from '../00/transport';
import type {
  PosBillDto, PosBillReceiptDto, PosCommandReceiptDto, PosMemberChoice, PosMemberQuote, PosOrderDto, PosPaymentReceiptDto, PosQuoteDto, PosReceiptDto, PosReversalQuoteDto, PosTableDto,
} from './dto';
import type { PosServerRows } from './project';
import { billBody, orderLinesBody, paymentBody, POS_PATH, terminalBody, type CartLineInput, type TableRevision, type TerminalInput } from './requests';
import { abortClaim, claimFirstOrder, type FirstOrderReservation } from '../06/first-order';
import { redemptionPath, type CheckoutCoupon, type CouponQuote, type CouponQuoteLine } from '../14/dto';
import type { MemberPassDto } from '../05/dto';

export interface PosRemoteOptions {
  readonly transport: PortTransport;
  readonly reads?: PortReads;
  /** Waits between resends of a command whose outcome is unknown. */
  readonly delaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CheckoutInput {
  /** One logical checkout attempt (a UUID the dialog makes once): it names every idempotency key below. */
  readonly attemptId: string;
  readonly type: 'dine_in' | 'takeout';
  readonly lines: readonly CartLineInput[];
  readonly method: PosMethod;
  readonly terminal?: TerminalInput;
  /** The amount the owner saw. A different server amount stops the checkout so the owner confirms it. */
  readonly expectedPayable: number;
  /** Set after a `quote-changed` answer: the same bill is paid at the new amount, no second bill is made. */
  readonly billId?: string;
  readonly discount?: number;
  readonly coupon?: CheckoutCoupon;
  readonly member?: { readonly memberId: string; readonly allocation: 'method' | 'charge' | 'receivable' };
  readonly pass?: {
    readonly membershipId: string;
    readonly kind: 'membership_count' | 'membership_period';
    readonly line: { readonly allocationId: string } | { readonly index: number };
    readonly expectedCoverage: number;
  };
}
export interface SubmitOrderInput {
  readonly lines: readonly CartLineInput[]; readonly key: string;
  readonly bill?: { readonly billId: string; readonly expectedRevision: number };
  readonly table?: TableRevision;
  /** R1-F06-2: the confirmed booking seated at this table and in its window; its first order is claimed first (B06 seam). Only for a new table bill. */
  readonly reservation?: FirstOrderReservation;
}
export type CheckoutResult =
  | { readonly status: 'paid'; readonly receipt: PosPaymentReceiptDto; readonly quote: PosQuoteDto }
  | { readonly status: 'quote-changed'; readonly billId: string; readonly quote: PosQuoteDto };

export interface ReversalInput {
  readonly kind: 'cancel' | 'refund';
  readonly lines?: readonly { readonly orderLineId: string; readonly qty: number }[];
  readonly amount?: number;
  readonly methodAmounts?: readonly { readonly method: PosMethod; readonly amount: number }[];
}

export interface PosLoad { readonly rows: PosServerRows; readonly asOf: string; readonly sourceRevision: number; readonly complete: boolean }

export interface PosRemote {
  readonly naver: NaverPosRemote;
  /** Orders, bills and receipts of one business day (receipts are re-read only when an order's remaining amount changed). */
  load(businessDate: string, options?: { readonly signal?: AbortSignal }): Promise<PosLoad>;
  checkout(input: CheckoutInput): Promise<CheckoutResult>;
  previewCoupon(code: string, lines: readonly CouponQuoteLine[], customerId?: string): Promise<CouponQuote>;
  submitOrder(input: SubmitOrderInput): Promise<PosBillReceiptDto>;
  registerTable(table: { layoutTableId: string; label: string; seats: number }, key: string): Promise<PosCommandReceiptDto>;
  cleanTable(table: TableRevision, key: string): Promise<PosCommandReceiptDto>;
  members(query: string, cursor?: string, signal?: AbortSignal): Promise<import('../00/port').ListPage<PosMemberChoice>>;
  memberBalance(memberId: string, signal?: AbortSignal): Promise<{ readonly chargeBalance: number; readonly receivableBalance: number }>;
  memberPasses(memberId: string, signal?: AbortSignal): Promise<readonly MemberPassDto[]>;
  /** Voids an open unpaid bill (an abandoned checkout). */
  voidBill(billId: string, key: string): Promise<PosCommandReceiptDto>;
  setPreparation(orderId: string, status: 'preparing' | 'completed', expectedRevision: number, key: string): Promise<PosCommandReceiptDto>;
  quoteReversal(paymentId: string, input: ReversalInput): Promise<PosReversalQuoteDto>;
  correct(settlementId: string, input: { readonly quoteToken: string; readonly terminal?: TerminalInput; readonly key: string }): Promise<PosCommandReceiptDto & { readonly paymentId?: string }>;
  receipt(paymentId: string): Promise<PosReceiptDto>;
  /** Forget cached receipts (store change, sign-out). */
  reset(): void;
}

const DEFAULT_DELAYS = [300, 1_000, 2_500];
const PAGE = 50, MAX_PAGES = 8, RECEIPT_PARALLEL = 6;
const sleepFor = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

function checkReceipt<T extends PosCommandReceiptDto>(value: unknown): T {
  const receipt = value as Partial<PosCommandReceiptDto> | null;
  if (!receipt || typeof receipt.receiptId !== 'string' || typeof receipt.resourceId !== 'string' || !Array.isArray(receipt.affectedSources)) {
    throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE', undefined, true);
  }
  return receipt as T;
}

export function createPosRemote(options: PosRemoteOptions): PosRemote {
  const { transport } = options;
  const reads = options.reads ?? createPortReads(transport);
  const delays = options.delaysMs ?? DEFAULT_DELAYS;
  const sleep = options.sleep ?? sleepFor;
  let scope = new AbortController();
  const receipts = new Map<string, { readonly revision: string; readonly receipt: PosReceiptDto }>();
  const pendingPayments = new Map<string, { request: PortRequest; key: string; quote: PosQuoteDto; billId: string; redemptionId?: string }>();

  async function send<T>(request: Omit<PortRequest, 'idempotencyKey'>, key: string): Promise<T> {
    const signal = request.signal ?? scope.signal;
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw new PortError(401, 'UNAUTHENTICATED', 'SESSION_ENDED');
      try {
        return await transport.request<T>({ ...request, signal, idempotencyKey: key });
      } catch (error) {
        const failed = toPortError(error, request.method);
        if (!failed.outcomeUnknown || attempt >= delays.length) throw failed;
        await sleep(delays[attempt]);
      }
    }
  }
  const read = <T>(path: string) => transport.request<T>({ method: 'GET', path: `${POS_PATH}${path}` });

  async function readReceipt(id: string, revision: string, signal?: AbortSignal): Promise<PosReceiptDto> {
    const hit = receipts.get(id);
    if (hit && hit.revision === revision) return hit.receipt;
    const receipt = await transport.request<PosReceiptDto>({ method: 'GET', path: `${POS_PATH}/payments/${encodeURIComponent(id)}/receipt`, signal });
    if (!signal?.aborted) receipts.set(id, { revision, receipt });
    return receipt;
  }

  const quoteBill = (billId: string, signal?: AbortSignal) => transport.request<PosQuoteDto>({ method: 'POST', path: `${POS_PATH}/settlement-quotes`, body: { billId }, signal });

  async function finishPayment(attemptId: string, billId: string, payment: NonNullable<ReturnType<typeof pendingPayments.get>>): Promise<CheckoutResult> {
    pendingPayments.set(attemptId, payment);
    try {
      const receipt = checkReceipt<PosPaymentReceiptDto>(await send(payment.request, payment.key));
      pendingPayments.delete(attemptId);
      // POS has recorded the payment. Reconciliation can also finish from the POS outbox if this request is interrupted.
      if (payment.redemptionId && !payment.request.signal?.aborted) {
        await transport.request({ method: 'POST', path: `${redemptionPath}/${encodeURIComponent(payment.redemptionId)}/reconcile`,
          body: {}, idempotencyKey: `coupon-reconcile:${attemptId}`, signal: payment.request.signal }).catch(() => {});
      }
      return { status: 'paid', receipt, quote: payment.quote };
    } catch (error) {
      const failed = toPortError(error, 'POST');
      if (!failed.outcomeUnknown) pendingPayments.delete(attemptId);
      if (failed.reason === 'QUOTE_CHANGED') return { status: 'quote-changed', billId, quote: await quoteBill(billId, payment.request.signal) };
      throw failed;
    }
  }

  return {
    naver: createNaverPosRemote(transport, send, () => scope.signal),
    previewCoupon(code, lines, customerId) {
      return transport.request({ method: 'POST', path: `${redemptionPath}/quote`, body: { code, lines, customerId }, signal: scope.signal });
    },
    async load(businessDate, { signal } = {}) {
      const options = { maxPages: MAX_PAGES, signal };
      const [orders, bills, tables] = await Promise.all([
        reads.all<PosOrderDto>({ resource: 'pos.orders', path: `${POS_PATH}/orders`, query: { businessDate, limit: PAGE } }, options),
        reads.all<PosBillDto>({ resource: 'pos.bills', path: `${POS_PATH}/bills`, query: { businessDate, limit: PAGE } }, options),
        reads.all<PosTableDto>({ resource: 'pos.tables', path: `${POS_PATH}/tables`, query: { limit: PAGE } }, options),
      ]);
      const found = new Map<string, PosReceiptDto>();
      const ids = new Map<string, string>();
      const receiptRevision = (row: PosBillDto | PosOrderDto, remaining: number) =>
        JSON.stringify([remaining, row.source, row.naverPayPaymentId, row.smartstoreProductOrderId]);
      for (const bill of bills.items) {
        const id = bill.paymentId ?? bill.settlementId;
        if (id) ids.set(id, receiptRevision(bill, bill.remaining ?? bill.quote.payable));
      }
      for (const order of orders.items) {
        const id = order.paymentId ?? order.settlementId;
        if (id && !ids.has(id)) ids.set(id, receiptRevision(order, order.remaining));
      }
      const queue = [...ids];
      const worker = async () => {
        for (let row = queue.shift(); row; row = queue.shift()) found.set(row[0], await readReceipt(row[0], row[1], signal));
      };
      await Promise.all(Array.from({ length: Math.min(RECEIPT_PARALLEL, queue.length) }, worker));
      return { rows: { orders: orders.items, bills: bills.items, tables: tables.items, receipts: found }, asOf: orders.asOf,
        sourceRevision: Math.max(orders.sourceRevision, bills.sourceRevision, tables.sourceRevision), complete: orders.complete && bills.complete && tables.complete };
    },

    async checkout(input) {
      const { signal } = scope;
      const pending = pendingPayments.get(input.attemptId);
      if (pending) return finishPayment(input.attemptId, pending.billId, pending);
      let billId = input.billId, quote: PosQuoteDto | undefined;
      if (!billId) {
        const receipt = checkReceipt<PosBillReceiptDto>(await send({ method: 'POST', path: `${POS_PATH}/bills`, body: billBody(input.type, input.lines, { discount: input.coupon?.discount ?? input.discount }), signal }, `bill:${input.attemptId}`));
        billId = receipt.resourceId; quote = receipt.quote;
      } else {
        quote = await quoteBill(billId, signal);
      }
      if (quote.payable !== input.expectedPayable) return { status: 'quote-changed', billId, quote };
      const path = `${POS_PATH}/bills/${encodeURIComponent(billId)}`;
      let redemptionId: string | undefined;
      if (input.coupon) {
        if (quote.discount !== input.coupon.discount) throw new PortError(409, 'CONFLICT', 'BILL_DISCOUNT_MISMATCH');
        const { code, customerId } = input.coupon;
        const claim = checkReceipt<PosCommandReceiptDto & { redemption: { state: string; holdUntil?: string } }>(
          await send({ method: 'POST', path: redemptionPath, body: { code, billId, customerId }, signal }, `coupon-claim:${input.attemptId}`));
        if (claim.redemption?.state !== 'held' || (claim.redemption.holdUntil && Date.parse(claim.redemption.holdUntil) <= Date.now())) {
          throw new PortError(409, 'CONFLICT', 'COUPON_HOLD_EXPIRED');
        }
        redemptionId = claim.resourceId;
      }
      if (input.member) {
        const { memberId, allocation } = input.member;
        const pass = input.pass;
        const target = pass?.line;
        const line = target && ('allocationId' in target
          ? quote.lines.find(line => line.allocationId === target.allocationId)
          : quote.lines[target.index]);
        if (pass && !line) throw new PortError(409, 'CONFLICT', 'MEMBERSHIP_UNAVAILABLE');
        const coverage = pass && line ? Math.floor(line.amount / line.qty) : 0;
        if (pass && coverage !== pass.expectedCoverage) return { status: 'quote-changed', billId, quote };
        const amount = quote.payable - coverage;
        const tender = allocation === 'method' ? { kind: allocation, method: input.method, amount } : { kind: allocation, amount };
        const allocations = [
          ...(pass && line ? [{ kind: pass.kind, membershipId: pass.membershipId, allocationId: line.allocationId, quantity: 1 }] : []),
          ...(amount > 0 ? [tender] : []),
        ];
        const terminal = amount > 0 && allocation === 'method' && input.method !== 'cash' ? paymentBody(input.method, amount, quote.quoteRevision, input.terminal).terminal : undefined;
        const body = { memberId, allocations };
        const memberQuote = await transport.request<PosMemberQuote>({ method: 'POST', path: `${path}/member-quote`, body, signal });
        const request = { method: 'POST' as const, path: `${path}/member-payments`, body: { ...body, quoteRevision: memberQuote.quoteRevision, accountRevision: memberQuote.accountRevision, ...(terminal ? { terminal } : {}) }, signal };
        return finishPayment(input.attemptId, billId, { request, key: `member-payment:${input.attemptId}:${memberQuote.quoteRevision}`, quote, billId, redemptionId });
      }
      const request = { method: 'POST' as const, path: `${path}/payments`, body: paymentBody(input.method, quote.payable, quote.quoteRevision, input.terminal), signal };
      return finishPayment(input.attemptId, billId, { request, key: `payment:${input.attemptId}:${quote.quoteRevision}`, quote, billId, redemptionId });
    },

    async submitOrder({ lines, key, bill, table, reservation }) {
      let skipped: string | undefined;
      if (reservation && !bill && table) {
        const claim = await claimFirstOrder(send, reservation, key, sleep);
        if (claim.status === 'bound') {
          // The claim's command key is the bill's idempotency key: POS checks the binding (booking, owner, table, window) before it records anything.
          try {
            return checkReceipt<PosBillReceiptDto>(await send({ method: 'POST', path: `${POS_PATH}/bills`, body: billBody('dine_in', lines, { table, postpaid: true, reservationId: reservation.reservationId }) }, claim.commandKey));
          } catch (error) {
            const failed = toPortError(error, 'POST');
            if (!failed.outcomeUnknown) await abortClaim(send, claim.claimId);
            throw failed;
          }
        }
        skipped = claim.reason;
      }
      const path = bill ? `${POS_PATH}/bills/${encodeURIComponent(bill.billId)}/orders` : `${POS_PATH}/bills`;
      const body = bill ? { expectedRevision: bill.expectedRevision, lines: orderLinesBody(lines) } : billBody('dine_in', lines, { table, postpaid: true });
      const receipt = checkReceipt<PosBillReceiptDto>(await send({ method: 'POST', path, body }, key));
      return skipped ? { ...receipt, reservationSkipped: skipped } : receipt;
    },
    async registerTable(body, key) { return checkReceipt(await send({ method: 'POST', path: `${POS_PATH}/tables`, body }, key)); },
    async cleanTable({ tableId, expectedRevision }, key) {
      return checkReceipt(await send({ method: 'PATCH', path: `${POS_PATH}/tables/${encodeURIComponent(tableId)}`, body: { state: 'empty', expectedRevision } }, key));
    },
    members(query, cursor, signal) {
      return reads.page<PosMemberChoice>({ resource: 'pos.member-picker', path: '/customers', query: { limit: 20, ...(query ? { query } : {}) } }, { cursor, signal });
    },
    memberBalance(memberId, signal) {
      return reads.one({ resource: 'pos.member-account', path: `${POS_PATH}/member-accounts/${encodeURIComponent(memberId)}` }, { signal });
    },
    async memberPasses(memberId, signal) {
      const page = await reads.all<MemberPassDto>({ resource: 'pos.member-passes', path: '/memberships',
        query: { memberId, status: 'active', limit: PAGE } }, { maxPages: MAX_PAGES, signal });
      return page.items;
    },

    async voidBill(billId, key) {
      return checkReceipt(await send({ method: 'POST', path: `${POS_PATH}/bills/${encodeURIComponent(billId)}/void`, body: { expectedRevision: 1, confirmed: true } }, key));
    },
    async setPreparation(orderId, status, expectedRevision, key) {
      return checkReceipt(await send({ method: 'POST', path: `${POS_PATH}/orders/${encodeURIComponent(orderId)}/preparation`, body: { status, expectedRevision } }, key));
    },
    quoteReversal(paymentId, input) {
      return transport.request<PosReversalQuoteDto>({
        method: 'POST', path: `${POS_PATH}/payments/${encodeURIComponent(paymentId)}/reversal-quote`,
        body: { kind: input.kind, ...(input.lines ? { lines: input.lines } : {}), ...(input.amount !== undefined ? { amount: input.amount } : {}), ...(input.methodAmounts ? { methodAmounts: input.methodAmounts } : {}) },
      });
    },
    async correct(settlementId, input) {
      const body = { quoteToken: input.quoteToken, confirmed: true, ...(input.terminal ? { terminal: terminalBody(input.terminal) } : {}) };
      return checkReceipt(await send({ method: 'POST', path: `${POS_PATH}/settlements/${encodeURIComponent(settlementId)}/corrections`, body }, input.key));
    },
    receipt(paymentId) { return read<PosReceiptDto>(`/payments/${encodeURIComponent(paymentId)}/receipt`); },
    reset() { scope.abort(); scope = new AbortController(); receipts.clear(); pendingPayments.clear(); },
  };
}
