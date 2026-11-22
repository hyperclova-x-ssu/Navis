/**
 * REAL-PLAN F02 — publishes the service's POS records into the run (the session commit the POS runtime already uses) and runs the
 * owner's commands against the service. One bridge per run. Nothing here executes without a call from a button press: reads happen
 * on start and after a command, writes only through `checkout`, `abandon`, `setPreparation` and `correct`.
 */
import type { PosCommandValue, PosMethod, PosPlan, PosReadSnapshot, PosResult, PosTableView } from '../../../contracts/pos';
import { PortError } from '../00/port';
import { toPortError } from '../00/transport';
import type { PosBillDto, PosBillLinkDto, PosCommandReceiptDto, PosQuoteDto, PosReceiptDto, PosReversalQuoteDto, PosTableDto } from './dto';
import { projectPosState } from './project';
import type { CheckoutInput, PosRemote, ReversalInput, SubmitOrderInput } from './remote';
import type { TerminalInput } from './requests';
import { BOOKING_SOURCES, FIRST_ORDER_DOMAINS, type FirstOrderReservation } from '../06/first-order';

/** Dependent domains that read what a sale or correction moved. The service moves stock through its relay, a moment after the receipt. */
export const POS_DEPENDENT_DOMAINS = ['stock', 'members'] as const;
/** R1-F06-2: a first order of a claimed reservation also moves the booking list (the visit completes) and the calendar that reads it. */
export type DependentDomain = (typeof POS_DEPENDENT_DOMAINS)[number] | (typeof FIRST_ORDER_DOMAINS)[number] | 'coupons' | 'groups';
const FOLLOW_UP_MS = [2_000, 6_000] as const;

export type SyncState = { readonly status: 'idle' | 'loading' | 'ready' | 'error'; readonly asOf?: string; readonly sourceRevision?: number; readonly complete: boolean; readonly error?: PortError };

export interface BridgeDeps {
  readonly remote: PosRemote;
  readonly read: () => PosReadSnapshot;
  readonly commit: (plan: PosPlan, expected: PosReadSnapshot) => PosResult<PosCommandValue>;
  /** Re-read dependent domains (stock). Called right after a receipt and again after the relay delay. */
  readonly reload?: (domains: readonly DependentDomain[]) => void;
  readonly schedule?: (callback: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

export type CheckoutOutcome =
  | { readonly status: 'paid'; readonly orderNo: number | undefined; readonly paymentId: string; readonly billId: string }
  | { readonly status: 'quote-changed'; readonly billId: string; readonly payable: number; readonly quote?: PosQuoteDto }
  | { readonly status: 'failed'; readonly reason: string; readonly field?: string; readonly outcomeUnknown: boolean };
export type CommandOutcome = { readonly ok: true; readonly receipt: PosCommandReceiptDto & PosBillLinkDto } | { readonly ok: false; readonly reason: string; readonly outcomeUnknown: boolean };
type CartVersion = Pick<PosReadSnapshot['pos']['cart'], 'cartId' | 'revision'>;

export interface CheckoutRequest {
  readonly attemptId: string;
  readonly method: PosMethod;
  readonly terminal?: TerminalInput;
  /** The amount shown to the owner (the local quote). */
  readonly expectedPayable: number;
  readonly billId?: string;
  readonly member?: CheckoutInput['member'];
  readonly pass?: CheckoutInput['pass'];
  readonly coupon?: CheckoutInput['coupon'];
}

export interface PosBridge {
  readonly remote: PosRemote;
  state(): SyncState;
  subscribe(listener: () => void): () => void;
  /** Read the business day and publish it. Concurrent calls share one request. */
  sync(options?: { readonly force?: boolean }): Promise<SyncState>;
  checkout(request: CheckoutRequest): Promise<CheckoutOutcome>;
  bill(billId: string): PosBillDto | undefined;
  submitOrder(input: { readonly key: string; readonly table?: PosTableView; readonly billId?: string; readonly reservation?: FirstOrderReservation }): Promise<CommandOutcome>;
  cleanTable(layoutTableId: string): Promise<CommandOutcome>;
  abandon(billId: string): Promise<void>;
  setPreparation(orderId: string, status: 'preparing' | 'completed'): Promise<CommandOutcome>;
  quoteReversal(paymentId: string, input: ReversalInput): Promise<{ readonly ok: true; readonly quote: PosReversalQuoteDto } | { readonly ok: false; readonly reason: string }>;
  correct(input: { readonly settlementId: string; readonly quoteToken: string; readonly terminal?: TerminalInput; readonly key: string }): Promise<CommandOutcome>;
  receipt(paymentId: string): Promise<PosReceiptDto>;
  loadedReceipt(id: string): PosReceiptDto | undefined;
  /** The service settlement a payment belongs to (the id a correction is posted against). */
  settlementOf(paymentId: string): string | undefined;
  /** The store name on the service's receipts (the account's store), for the receipt heading. */
  storeName(): string | null;
  /** Sign-out, lost access or a store change: forget cached receipts and show no sales until the next read (the service's rows stop being shown). */
  clearRows(): void;
  dispose(): void;
}

const reasonOf = (error: unknown) => {
  const failed = toPortError(error, 'POST');
  return { reason: failed.reason ?? (failed.outcomeUnknown ? 'OUTCOME_UNKNOWN' : failed.code), field: failed.field, outcomeUnknown: failed.outcomeUnknown };
};

export function createPosBridge(deps: BridgeDeps): PosBridge {
  const { remote, read, commit } = deps;
  const schedule = deps.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = deps.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  const timers = new Set<unknown>();
  let state: SyncState = { status: 'idle', complete: true };
  let inflight: Promise<SyncState> | undefined, signature = '';
  let scope = new AbortController();
  /** The service's revision of each order, needed as `expectedRevision` when the owner moves it through preparation. */
  const revisions = new Map<string, number>();
  const settlements = new Map<string, string>();
  const loadedReceipts = new Map<string, PosReceiptDto>();
  const bills = new Map<string, PosBillDto>(), tables = new Map<string, PosTableDto>();
  const pendingOrders = new Map<string, { input: SubmitOrderInput; cartId: string; revision: number }>();
  let storeName: string | null = null;
  const publish = (next: SyncState) => { state = next; for (const listener of [...listeners]) listener(); };

  async function publishRows(clearCart: CartVersion | undefined, signal: AbortSignal): Promise<SyncState> {
    const date = read().pos.businessDate;
    const loaded = await remote.load(date, { signal });
    if (signal.aborted) return state;
    revisions.clear();
    settlements.clear();
    storeName = [...loaded.rows.receipts.values()].find(row => row.storeName)?.storeName ?? storeName;
    for (const order of loaded.rows.orders) revisions.set(order.orderId, order.revision);
    loadedReceipts.clear();
    for (const [id, receipt] of loaded.rows.receipts) {
      settlements.set(id, receipt.settlementId);
      loadedReceipts.set(id, receipt);
      if (receipt.memberId) loadedReceipts.set(receipt.settlementId, receipt);
    }
    bills.clear(); tables.clear();
    for (const bill of loaded.rows.bills) bills.set(bill.billId, bill);
    for (const table of loaded.rows.tables ?? []) if (table.layoutTableId && table.state !== 'archived') tables.set(table.layoutTableId, table);
    const sig = JSON.stringify([loaded.sourceRevision, loaded.rows.orders, loaded.rows.bills, loaded.rows.tables]);
    if (sig !== signature || clearCart) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const expected = read();
        const matches = clearCart?.cartId === expected.pos.cart.cartId && clearCart.revision === expected.pos.cart.revision;
        const nextPos = projectPosState(expected.pos, loaded.rows, { clearCart: matches });
        const plan: PosPlan = { nextPos, nextUi: expected.posUi, result: { ok: true, status: 'applied', posRevision: nextPos.revision, dataRevision: expected.dataRevision + 1, value: null } };
        const result = commit(plan, expected);
        if (result.ok) { signature = sig; break; }
        // The owner acted between the read and the commit (or a transaction is open): read the run again.
        if (result.reason !== 'STALE_REVISION' && result.reason !== 'TRANSACTION_BUSY') throw new PortError(500, 'UNKNOWN', result.reason);
        if (signal.aborted) return state;
        if (attempt === 3) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
        await Promise.resolve();
      }
    }
    return { status: 'ready', asOf: loaded.asOf, sourceRevision: loaded.sourceRevision, complete: loaded.complete };
  }

  function sync(options: { readonly force?: boolean } = {}, clearCart?: CartVersion): Promise<SyncState> {
    const { signal } = scope;
    if (inflight) return options.force ? inflight.then(() => signal.aborted ? state : sync(options, clearCart)) : inflight;
    publish({ ...state, status: state.status === 'ready' ? 'ready' : 'loading', error: undefined });
    const run = publishRows(clearCart, signal).then(next => { if (!signal.aborted) publish(next); return next; }, error => {
      if (signal.aborted) return state;
      const failed = toPortError(error, 'GET');
      if (clearCart) signature = '';
      publish({ status: 'error', asOf: state.asOf, complete: false, error: failed });
      return state;
    }).finally(() => { if (inflight === run) inflight = undefined; });
    inflight = run;
    return run;
  }

  function refreshDependents(sources: readonly string[], couponSale = false) {
    const base: readonly DependentDomain[] = sources.some(source => ['members', 'memberships', 'pos.member-accounts'].includes(source)) ? POS_DEPENDENT_DOMAINS : ['stock'];
    const orderDomains: readonly DependentDomain[] = sources.some(source => (BOOKING_SOURCES as readonly string[]).includes(source)) ? [...base, ...FIRST_ORDER_DOMAINS] : base;
    const domains: readonly DependentDomain[] = couponSale || sources.includes('pos.sales') ? [...orderDomains, 'coupons', 'groups'] : orderDomains;
    deps.reload?.(domains);
    for (const ms of FOLLOW_UP_MS) {
      const handle = schedule(() => { timers.delete(handle); deps.reload?.(domains); }, ms);
      timers.add(handle);
    }
  }
  function clearRows() {
    scope.abort(); scope = new AbortController(); inflight = undefined;
    for (const handle of timers) cancel(handle);
    timers.clear();
    signature = ''; revisions.clear(); settlements.clear(); loadedReceipts.clear(); bills.clear(); tables.clear(); pendingOrders.clear(); storeName = null; remote.reset();
    const expected = read();
    if (expected.pos.orders.length || expected.pos.bills.length || expected.pos.tableSessions.length || expected.pos.cart.lines.length) {
      const nextPos = projectPosState(expected.pos, { orders: [], bills: [], tables: [], receipts: new Map() }, { clearCart: true });
      commit({ nextPos, nextUi: expected.posUi, result: { ok: true, status: 'applied', posRevision: nextPos.revision, dataRevision: expected.dataRevision + 1, value: null } }, expected);
    }
    publish({ status: 'idle', complete: true });
  }
  const afterReceipt = async (clearCart: CartVersion | undefined, sources: readonly string[], signal: AbortSignal, couponSale = false) => {
    if (signal.aborted) return;
    await sync({ force: true }, clearCart);
    if (!signal.aborted) refreshDependents(sources, couponSale);
  };
  const linesOf = (cart: PosReadSnapshot['pos']['cart']) => cart.lines.map(line => ({ menuId: line.menuId, qty: line.qty, optionIds: line.selectedOptionIds }));

  return {
    remote,
    state: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sync: options => sync(options),

    async checkout(request) {
      const { signal } = scope, { cart } = read().pos;
      try {
        const result = await remote.checkout({
          attemptId: request.attemptId, type: cart.type,
          lines: linesOf(cart), method: request.method, terminal: request.terminal, expectedPayable: request.expectedPayable, billId: request.billId, member: request.member,
          coupon: request.coupon, pass: request.pass,
        });
        if (result.status === 'quote-changed') return { status: 'quote-changed', billId: result.billId, payable: result.quote.payable,
          ...(request.pass && { quote: result.quote }) };
        // The sale is recorded. Publish it (and empty the cart only if the owner did not change it meanwhile).
        const clearCart = bills.get(result.receipt.billId)?.orderIds?.length ? undefined : cart;
        await afterReceipt(clearCart, result.receipt.affectedSources, signal, !!request.coupon || !!request.member);
        const orderNo = read().pos.orders.find(order => order.orderId === result.receipt.orderId)?.orderNo;
        return { status: 'paid', orderNo, paymentId: result.receipt.paymentId ?? result.receipt.settlementId, billId: result.receipt.billId };
      } catch (error) {
        return { status: 'failed', ...reasonOf(error) };
      }
    },

    bill: id => bills.get(id),

    async submitOrder({ key, table, billId, reservation }) {
      const { cart } = read().pos, { signal } = scope;
      try {
        let pending = pendingOrders.get(key);
        if (!pending) {
          let target = table ? tables.get(table.tableId) : undefined;
          if (table && !target) {
            const receipt = await remote.registerTable({ layoutTableId: table.tableId, label: `T${table.number}`, seats: table.seats }, `table:${key}`);
            if (signal.aborted) throw new PortError(401, 'UNAUTHENTICATED', 'SESSION_ENDED');
            await sync({ force: true });
            target = tables.get(table.tableId);
            if (!target || target.tableId !== receipt.resourceId) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
          }
          const activeId = table ? target?.billId : billId;
          const existing = activeId ? bills.get(activeId) : undefined;
          if (activeId && existing?.status !== 'open') throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
          const input: SubmitOrderInput = { key, lines: linesOf(cart), ...(existing ? { bill: { billId: existing.billId, expectedRevision: existing.revision } }
            : target ? { table: { tableId: target.tableId, expectedRevision: target.revision }, ...(reservation ? { reservation } : {}) } : {}) };
          pending = { input, cartId: cart.cartId, revision: cart.revision };
          pendingOrders.set(key, pending);
        }
        if (signal.aborted) throw new PortError(401, 'UNAUTHENTICATED', 'SESSION_ENDED');
        const receipt = await remote.submitOrder(pending.input);
        pendingOrders.delete(key);
        if (!signal.aborted) await sync({ force: true }, pending);
        // R1-F06-2: the booking's visit completes from the link event a moment later; read the booking list and the calendar again now and after the relay delay.
        if (receipt.reservationLink && !signal.aborted) refreshDependents(receipt.affectedSources);
        return { ok: true, receipt };
      } catch (error) {
        const failure = reasonOf(error);
        if (!failure.outcomeUnknown) pendingOrders.delete(key);
        if (!signal.aborted) await sync({ force: true });
        return { ok: false, ...failure };
      }
    },

    async cleanTable(layoutTableId) {
      const table = tables.get(layoutTableId);
      if (table?.state !== 'cleaning') return { ok: false, reason: 'STALE_REVISION', outcomeUnknown: false };
      try {
        const receipt = await remote.cleanTable({ tableId: table.tableId, expectedRevision: table.revision }, `clean:${table.tableId}:${table.revision}`);
        await sync({ force: true });
        return { ok: true, receipt };
      } catch (error) { await sync({ force: true }); return { ok: false, ...reasonOf(error) }; }
    },

    async abandon(billId) {
      try { await remote.voidBill(billId, `void:${billId}`); } catch { /* an open unpaid draft is harmless; the day's close lists it */ }
    },

    async setPreparation(orderId, status) {
      const expected = revisions.get(orderId);
      if (expected === undefined) return { ok: false, reason: 'NOT_FOUND', outcomeUnknown: false };
      try {
        const receipt = await remote.setPreparation(orderId, status, expected, `prep:${orderId}:${status}:${expected}`);
        await sync({ force: true });
        return { ok: true, receipt };
      } catch (error) { await sync({ force: true }); return { ok: false, ...reasonOf(error) }; }
    },

    async quoteReversal(paymentId, input) {
      try { return { ok: true, quote: await remote.quoteReversal(paymentId, input) }; } catch (error) { return { ok: false, reason: reasonOf(error).reason }; }
    },

    async correct({ settlementId, quoteToken, terminal, key }) {
      const { signal } = scope;
      try {
        const receipt = await remote.correct(settlementId, { quoteToken, terminal, key });
        await afterReceipt(undefined, receipt.affectedSources, signal, true);
        return { ok: true, receipt };
      } catch (error) { return { ok: false, ...reasonOf(error) }; }
    },

    receipt: paymentId => remote.receipt(paymentId),
    loadedReceipt: id => loadedReceipts.get(id),
    settlementOf: paymentId => settlements.get(paymentId),
    storeName: () => storeName,
    clearRows,
    /** Stops pending follow-up reads and forgets cached receipts. Subscribers stay: the host may reconnect the same bridge (StrictMode). */
    dispose() { scope.abort(); scope = new AbortController(); inflight = undefined; for (const handle of timers) cancel(handle); timers.clear(); remote.reset(); },
  };
}
