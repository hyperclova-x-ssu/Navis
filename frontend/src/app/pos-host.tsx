import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { RunState, RunStore } from '../contracts';
import { useRunSlice } from './run-slice';
import type { PosRuntime } from '../pos/runtime';
import { ActionButton, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, ChipChoice, posTimeTokens, useUi } from '../ui';
import { selectOrderSummary } from '../pos/status';
import { usePosStatusSession, usePosSnapshot } from '../pos/react';
import { AnimatePresence } from 'motion/react';
import { MissingOrderAlert } from '../screens/order/status/Alert';
import { selectCommonNotice } from '../state';
import '../screens/order/status/status.css';
import { ReversalReceipt, type ReversalReceiptEntry } from '../screens/order/ReversalReceipt';
import type { FeatureId } from '../contracts';
import { CustomOrderProvider, type CustomOrderPort, type CustomReturnContext } from '../features/widgets/i7-custom';
import type { CctvLinksProps } from '../features/widgets/mgmt-customers/cctv-detail';
import { SessionActionsContext, useSessionActions, type CustomCoordinator } from './session-actions';
import { useAccountingViews, useMoneyRead, useWidgetDataStore, useWidgetView, WidgetDataProvider } from '../data/react';
import { dataBundles, resolveDataText, selectMembers } from '../data/widget-data';
import { cctvOccupancyObservations, cctvPosLinks, selectLinkedTableStates, tableLinksEnabled } from '../data/iteration7/table-links';
import { createLinkPickers } from '../features/cctv/zones/linked-ui';
import { useRealCctvLinks } from '../features/cctv/zones/real-links';
import { cctvBundle, useCctvView } from '../features/cctv';
import { getLiveClient } from '../features/cctv/live';
import { useBundle } from '../i18n';
import { posBundle } from '../i18n/messages/pos';
import type { MoneyRead, MoneyReversalQuote, SettlementQuote, SettlementTarget } from '../data/iteration7/accounting/types';
import { selectMemberAccounts } from '../data/iteration7/accounts';
import { MemberMoneyProvider, memberMoneyBinding, type CreditPort, type OriginalMoneyTransaction, type MemberReturnContext } from '../features/widgets/i7-credit';
import { AccountingPresentationProvider } from '../features/widgets/mgmt-money/ledger';
import { SettlementUiProvider, type SettlementUiPort, type SaleSettlementState } from '../screens/order/settlement/port';
import type { MoneyReversalReceiptEntry } from '../screens/order/settlement/MoneyReversalReceipt';
import { getPaymentBillId, quotePaymentBill } from '../pos/loyalty';
import { SharedPosPaymentDialog, SharedPosReversalDialog } from '../screens/order/settlement';
import type { SettlementPaymentPhase } from '../screens/order/settlement/SharedPosPaymentDialog';
import { bindPosBridge } from '../data/reality/02/adapter';
import { createPosBridge, type PosBridge } from '../data/reality/02/bridge';
import { createPosRemote } from '../data/reality/02/remote';
import { PosBridgeProvider, usePosBridge } from '../pos/remote-context';

export interface M2WidgetBindings {
  readonly customPort: CustomOrderPort;
  readonly resetPreview: (id: FeatureId) => void;
  readonly cctv: CctvLinksProps;
  readonly tableLinkPicker: ReturnType<typeof createLinkPickers>['table'];
  readonly busy: boolean;
}
const M2WidgetContext = createContext<M2WidgetBindings | null>(null);
export const M2WidgetProvider = M2WidgetContext.Provider;
export const useM2WidgetBindings = () => useContext(M2WidgetContext);

export type RootReceiptEntry = ReversalReceiptEntry | MoneyReversalReceiptEntry;
/** Existing order/closing callers still emit payment entries; the host resolves their settlement. */
export type OpenReversalReceipt = (entry: ReversalReceiptEntry) => void;
export interface PosReceiptHostProps {
  readonly entry: RootReceiptEntry | null;
  readonly onClose: () => void;
  readonly returnFocusRef?: import('react').RefObject<HTMLElement | null>;
  readonly scheduler?: ApprovalScheduler;
}
export function PosReceiptHost({ entry, onClose, returnFocusRef, scheduler = browserApprovalScheduler }: PosReceiptHostProps) {
  const session = useContext(SessionActionsContext);
  if (session) return <CoordinatedReceiptHost entry={entry} onClose={onClose} returnFocusRef={returnFocusRef} scheduler={scheduler} money={session.money}/>;
  return entry && 'paymentId' in entry ? <ReversalReceipt key={`${entry.paymentId}:${entry.view}`} paymentId={entry.paymentId} initialView={entry.view} onClose={onClose}/> : null;
}
function CoordinatedReceiptHost({ entry, onClose, returnFocusRef, scheduler = browserApprovalScheduler, money }: PosReceiptHostProps & { readonly money: MoneyCoordinator }) {
  const store = useWidgetDataStore();
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useSyncExternalStore(money.subscribe, money.approval, money.approval);
  const bridge = usePosBridge();
  if (!entry) return null;
  // REAL-PLAN F02: over HTTP the receipt and its corrections come from the service (by payment), not from the local money coordinator.
  if (bridge) {
    const paymentId = 'paymentId' in entry ? entry.paymentId : entry.settlementId.replace(/^legacy:/, '');
    return <ReversalReceipt key={`${paymentId}:${entry.view}`} paymentId={paymentId} initialView={entry.view} onClose={onClose}
      fromMemberLedger={'settlementId' in entry && !entry.settlementId.startsWith('legacy:')} returnFocusRef={returnFocusRef}/>;
  }
  const settlementId = 'settlementId' in entry ? entry.settlementId : money.receipt({ paymentId: entry.paymentId })?.settlementId;
  return settlementId !== undefined ? <MoneyReceiptRoute key={`${settlementId}:${entry.view}`} settlementId={settlementId} view={entry.view} money={money} onClose={onClose} returnFocusRef={returnFocusRef} scheduler={scheduler}/>
    : 'paymentId' in entry ? <ReversalReceipt key={`${entry.paymentId}:${entry.view}`} paymentId={entry.paymentId} initialView={entry.view} onClose={onClose}/> : null;
}

function MoneyReceiptRoute({ settlementId, view, money, onClose, returnFocusRef, scheduler }: MoneyReversalReceiptEntry & Omit<PosReceiptHostProps, 'entry'> & { readonly money: MoneyCoordinator; readonly scheduler: ApprovalScheduler }) {
  const store = useWidgetDataStore();
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const read = money.read();
  const [phase, setPhase] = useState<SettlementPaymentPhase>(readyPhase);
  const pending = useRef(false), job = useRef<unknown>(undefined), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; scheduler.cancel(job.current); }; }, [scheduler]);
  return <ReversalReceipt settlementId={settlementId} initialView={view} onClose={() => { if (!pending.current) onClose(); }} returnFocusRef={returnFocusRef} money={{
    receipt: money.receipt({ settlementId }), phase, quoteReversal: money.quoteReversal,
    onReset: () => { if (!pending.current) setPhase(readyPhase); },
    onConfirm: quote => {
      if (pending.current || phase.status === 'succeeded' || money.approval()?.status === 'pending' || !quote.canSubmit) return false;
      pending.current = true; setPhase({ status: 'pending' });
      const key = crypto.randomUUID(), runId = read.runId;
      job.current = scheduler.schedule(() => {
        if (!alive.current || money.read().runId !== runId) return;
        const result = money.reverse({ quote, idempotencyKey: `receipt:${key}` });
        pending.current = false;
        setPhase(result.ok ? { status: 'succeeded' } : { status: 'failed', reason: result.reason ?? result.code });
      }, posTimeTokens.payApproveMs);
      return true;
    },
  }}/>;
}

export interface ApprovalScheduler {
  schedule(callback: () => void, delay: number): unknown;
  cancel(handle: unknown): void;
}
export const browserApprovalScheduler: ApprovalScheduler = {
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  cancel: handle => window.clearTimeout(handle as number),
};

/** Presentation time is separate from the fixed business clock. One timer per attempt. */
export function attachApprovalScheduler(runtime: PosRuntime, scheduler: ApprovalScheduler) {
  let disposed = false;
  let pending: { key: string; handle?: unknown; fired: boolean } | undefined;
  const sync = () => {
    if (disposed) return;
    const read = runtime.read(), attempt = read.posUi.approval;
    const key = attempt?.status === 'pending' ? `${read.runId}:${attempt.attemptId}` : undefined;
    if (pending?.key === key) return;
    if (pending) scheduler.cancel(pending.handle);
    pending = undefined;
    if (!key || !attempt || attempt.runId !== read.runId) return;
    const job = { key, fired: false, handle: undefined as unknown };
    pending = job;
    job.handle = scheduler.schedule(() => {
      if (disposed || job.fired || pending !== job) return;
      job.fired = true;
      const latest = runtime.read(), current = latest.posUi.approval;
      if (latest.runId !== attempt.runId || current?.attemptId !== attempt.attemptId || current.status !== 'pending' || current.quoteFingerprint !== attempt.quoteFingerprint) return;
      runtime.finishApproval({ runId: attempt.runId, attemptId: attempt.attemptId,
        expectedQuoteFingerprint: attempt.quoteFingerprint, outcome: attempt.scenario === 'payment-failure' ? 'failed' : 'approved' });
    }, posTimeTokens.payApproveMs);
  };
  const unsubscribe = runtime.subscribe(sync);
  sync();
  return () => { disposed = true; unsubscribe(); if (pending) scheduler.cancel(pending.handle); pending = undefined; };
}

export function PosApprovalHost({ runtime, scheduler = browserApprovalScheduler }: { runtime: PosRuntime; scheduler?: ApprovalScheduler }) {
  useEffect(() => attachApprovalScheduler(runtime, scheduler), [runtime, scheduler]);
  return null;
}

/** Uses the same timing and run/attempt guards as ordinary POS approval. */
export function attachCustomApprovalScheduler(custom: CustomCoordinator, scheduler: ApprovalScheduler) {
  let disposed = false, pending: { key: string; handle?: unknown; fired: boolean } | undefined;
  const sync = () => {
    if (disposed) return;
    const attempt = custom.approval(), key = attempt?.status === 'pending' ? `${attempt.runId}:${attempt.attemptId}` : undefined;
    if (pending?.key === key) return;
    if (pending) scheduler.cancel(pending.handle);
    pending = undefined;
    if (!attempt || !key) return;
    const job = { key, fired: false, handle: undefined as unknown }; pending = job;
    job.handle = scheduler.schedule(() => {
      if (disposed || job.fired || pending !== job) return;
      job.fired = true;
      const current = custom.approval();
      if (current?.status !== 'pending' || current.runId !== attempt.runId || current.attemptId !== attempt.attemptId || current.generation !== attempt.generation || current.quote.quoteId !== attempt.quote.quoteId) return;
      custom.finishApproval({ runId: attempt.runId, attemptId: attempt.attemptId, outcome: 'approved' });
    }, posTimeTokens.payApproveMs);
  };
  const unsubscribe = custom.subscribe(sync); sync();
  return () => { disposed = true; unsubscribe(); if (pending) scheduler.cancel(pending.handle); pending = undefined; };
}

type PaymentEntry = { readonly key: string; readonly quote: SettlementQuote; readonly context: CustomReturnContext };
type ReversalEntry = { readonly key: string; readonly quote: MoneyReversalQuote; readonly context: CustomReturnContext; readonly cancelOrder: boolean; readonly phase: SettlementPaymentPhase };
const readyPhase: SettlementPaymentPhase = { status: 'ready' };
function retainedReturnContext<T extends CustomReturnContext>(context: T): T {
  return { ...context, returnFocusRef: { get current() {
    const trigger = context.returnFocusRef.current;
    if (trigger?.isConnected && !trigger.matches(':disabled,[aria-disabled="true"]')) return trigger;
    return document.getElementById(`custom-${context.selectedId}`)
      ?? Array.from(document.querySelectorAll<HTMLElement>('[data-row-id]')).find(row => row.dataset.rowId === context.selectedId)?.querySelector<HTMLElement>('button')
      ?? Array.from(document.querySelectorAll<HTMLElement>('[data-grid-row-id][tabindex]')).find(cell => cell.dataset.gridRowId === context.selectedId && !cell.closest('[inert],[aria-hidden="true"]'))
      ?? null;
  } } };
}

type MoneyCoordinator = ReturnType<typeof useSessionActions>['money'];
export function moneyApprovalPhase(approval: ReturnType<MoneyCoordinator['approval']>): SettlementPaymentPhase {
  if (!approval) return readyPhase;
  if (approval.status === 'pending') return { status: 'pending' };
  if (approval.status === 'succeeded') return { status: 'succeeded', settlementId: approval.result?.ok ? approval.result.value?.settlementId : undefined };
  return { status: 'failed', reason: approval.result && !approval.result.ok ? approval.result.reason ?? approval.result.code : 'APPROVAL_FAILED' };
}

/** One presentation timer for the canonical attempt, including account-only settlements. */
export function attachMoneyApprovalScheduler(money: MoneyCoordinator, scheduler: ApprovalScheduler) {
  let disposed = false, pending: { key: string; handle?: unknown; fired: boolean } | undefined;
  const sync = () => {
    const attempt = money.approval(), key = attempt?.status === 'pending' ? `${attempt.runId}:${attempt.attemptId}` : undefined;
    if (disposed || pending?.key === key) return;
    if (pending) scheduler.cancel(pending.handle);
    pending = undefined;
    if (!attempt || !key) return;
    const job = { key, fired: false, handle: undefined as unknown }; pending = job;
    job.handle = scheduler.schedule(() => {
      if (disposed || job.fired || pending !== job) return;
      job.fired = true;
      const current = money.approval();
      if (current?.status !== 'pending' || current.runId !== attempt.runId || current.attemptId !== attempt.attemptId || current.quote.quoteId !== attempt.quote.quoteId) return;
      money.finishApproval({ runId: attempt.runId, attemptId: attempt.attemptId, outcome: money.read().scenario === 'payment-failure' ? 'failed' : 'approved' });
    }, posTimeTokens.payApproveMs);
  };
  const unsubscribe = money.subscribe(sync); sync();
  return () => { disposed = true; unsubscribe(); if (pending) scheduler.cancel(pending.handle); };
}

/** Resolve immutable original references, including account reversals and zero-money uses. */
export function originalMoneySettlement(read: MoneyRead, transaction: OriginalMoneyTransaction): string | undefined {
  if (transaction.settlementId) return transaction.settlementId;
  let txn = read.state.accountTxns.find(row => row.txnId === transaction.originalTxnId || row.txnId === transaction.txnId);
  const visited = new Set<string>();
  while (txn && !visited.has(txn.txnId)) {
    visited.add(txn.txnId);
    if (txn.settlementId) return txn.settlementId;
    txn = read.state.accountTxns.find(row => row.txnId === txn?.originalTxnId);
  }
  const use = read.state.uses.find(row => row.useId === transaction.useId);
  const source = use?.sourceRef ?? transaction.sourceRef;
  const settlement = read.state.settlements.find(row => transaction.useId && row.allocations.some(allocation => allocation.useId === transaction.useId))
    ?? read.state.settlements.find(row => source && row.sourceRef.kind === source.kind && row.sourceRef.id === source.id);
  if (settlement) return settlement.settlementId;
  if (transaction.useId || transaction.sourceRef) return undefined;
  return transaction.membershipId ? read.state.memberships.find(row => row.membershipId === transaction.membershipId)?.saleSettlementId : undefined;
}

const CreditPortContext = createContext<CreditPort | null>(null);
/** Registry panels query their own period but use the same route port and source. */
export function useRunCreditBinding(condition: import('../contracts').QueryCondition) {
  const read = useMoneyRead(), port = useContext(CreditPortContext), view = useWidgetView('credit-receivable', condition);
  const fallback: CreditPort = useMemo(() => ({ openSettlement: () => {}, openOriginalTransaction: () => {}, openAccounts: () => {}, openMembershipUse: () => {} }), []);
  const binding = memberMoneyBinding(read, port ?? fallback, condition);
  return view.status === 'ready' ? binding : { ...binding, view: { status: view.status === 'error' ? 'error' as const : 'empty' as const } };
}

/**
 * The run fields the root host reads. A drag's drop-cell changes, a notice or a selection do not touch them, so the host (and every provider value it
 * builds: widget data context, M2 widgets, custom orders, credit, settlement, accounting) stays still while a widget is dragged (PERF-DRAG-REAL).
 */
const pickM2Slice = (s: RunState) => ({ runId: s.runId, layer: s.layer, shopSettings: s.shopSettings, overlay: s.overlay, linkedOccupancy: s.linkedOccupancy,
  exitPendingToken: s.exitPendingToken, preview: s.preview, activeInputs: s.activeInputs,
  // `session.pos.read()` below is built from these (the other fields of the read, runRevision and the data snapshot, do not change what this host renders).
  pos: s.pos, posUi: s.posUi, posRevision: s.posRevision });

/** One root host: shared money and financial consumers remain mounted across layer changes. */
export function M2RunHost({ run, children, scheduler = browserApprovalScheduler }: { readonly run: RunStore; readonly children?: ReactNode; readonly scheduler?: ApprovalScheduler }) {
  const session = useSessionActions(), custom = session.custom, money = session.money, data = useWidgetDataStore();
  const state = useRunSlice(run, pickM2Slice), snapshot = useSyncExternalStore(data.subscribe, data.getSnapshot);
  const approval = useSyncExternalStore(money.subscribe, money.approval, money.approval);
  const realLinks = useRealCctvLinks(state.shopSettings, state.overlay);
  const view = useCctvView({ video: false, enabled: !realLinks.real }), { t } = useBundle(cctvBundle, posBundle, ...dataBundles);
  const [payment, setPayment] = useState<PaymentEntry | null>(null), [paymentFailure, setPaymentFailure] = useState<string | null>(null);
  const [reversal, setReversal] = useState<ReversalEntry | null>(null), [linkError, setLinkError] = useState<string | undefined>();
  const [receipt, setReceipt] = useState<(MoneyReversalReceiptEntry & { context: CustomReturnContext }) | null>(null);
  const [saleOverride, setSaleOverride] = useState<SaleSettlementState | null>(null);
  const [useRequest, setUseRequest] = useState<{ memberId: string; membershipId: string; context: MemberReturnContext; billId?: string; error?: string; active?: boolean } | null>(null);
  const pendingReversal = useRef(false), reversalJob = useRef<unknown>(undefined), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; scheduler.cancel(reversalJob.current); }; }, [scheduler]);
  useEffect(() => attachMoneyApprovalScheduler(money, scheduler), [money, scheduler]);
  // The existing reader owns reliability. Always ingest, including an empty source list.
  useLayoutEffect(() => {
    if (realLinks.real) return;
    const current = run.getState(), activeZoneIds = view.tables.map(zone => zone.id), elapsedNow = current.linkedOccupancy.elapsedNow;
    if (view.mode === 'mock' || getLiveClient().getSnapshot().zones !== null) session.pruneCctvPosLinks(activeZoneIds);
    run.actions.reconcileLinkedOccupancy({ activeZoneIds, elapsedNow }, current.runId);
    for (const observation of cctvOccupancyObservations(view, new Date().toISOString(), elapsedNow)) run.actions.observeLinkedOccupancy(observation, current.runId);
  }, [realLinks.real, run, session, view]);
  const read = session.pos.read();
  const joined = useMemo(() => selectLinkedTableStates(read, { occupancy: state.linkedOccupancy, elapsedNow: state.linkedOccupancy.elapsedNow }), [read, state.linkedOccupancy]);
  const zones = useMemo(() => view.tables.map(zone => ({ id: zone.id, label: t(zone.label.key, zone.label.params) })), [view.tables, t]);
  const tables = useMemo(() => (state.shopSettings.tableLayout?.tables ?? []).map(table => ({ id: table.tableId, label: `T${table.number}` })), [state.shopSettings.tableLayout]);
  const pickers = useMemo(() => createLinkPickers({ enabled: tableLinksEnabled(state.shopSettings), zones, tables, links: cctvPosLinks(state.shopSettings), onSet: (zoneId, tableId) => {
    const current = run.getState();
    const result = session.setCctvPosLink({ zoneId, tableId, baseRevision: current.shopSettings.revision, idempotencyKey: `table-link:${crypto.randomUUID()}` }, zones.map(zone => zone.id));
    setLinkError(result.ok ? undefined : t(result.messageKey));
  } }), [run, session, state.shopSettings, zones, tables, t]);

  const accounts = selectMemberAccounts(money.read());
  const member = (memberId: string) => {
    const row = accounts.members.find(row => row.memberId === memberId);
    return row ? { memberId, label: row.name, chargeBalance: row.chargeBalance, receivableBalance: row.receivableBalance } : null;
  };
  const canOpen = () => !pendingReversal.current && money.approval()?.status !== 'pending';
  const openPayment = (target: SettlementTarget, context: CustomReturnContext) => {
    if (!canOpen()) return;
    money.dismissApproval(); setPaymentFailure(null); setSaleOverride(null); setReceipt(null); setReversal(null);
    setPayment({ key: crypto.randomUUID(), quote: money.quoteSettlement({ target, allocations: [] }), context: retainedReturnContext(context) });
  };
  const customPort: CustomOrderPort = { read: custom.read, subscribe: custom.subscribe, dispatch: custom.dispatch,
    members: selectMembers(snapshot, {}).rows.map(row => ({ memberId: row.memberId, label: typeof row.name === 'string' ? row.name : resolveDataText(t, row.name) })),
    openSettlement: openPayment,
    openReversal: (target, context) => {
      if (!canOpen()) return;
      const order = custom.read().tables.customOrder.find(row => row.customOrderId === target.customOrderId);
      const original = money.read().state.settlements.find(row => row.purpose === 'custom_order' && row.sourceRef.id === target.customOrderId);
      if (!original) return;
      money.dismissApproval(); setPayment(null); setReceipt(null);
      setReversal({ key: crypto.randomUUID(), quote: money.quoteReversal({ settlementId: original.settlementId, kind: order?.stage === 'received_by_customer' ? 'refund' : 'cancel' }), context: retainedReturnContext(context), cancelOrder: target.cancelOrder, phase: readyPhase });
    },
  };
  const phase = paymentFailure ? { status: 'failed' as const, reason: paymentFailure } : moneyApprovalPhase(approval);
  const closePayment = () => { if (!money.dismissApproval()) return; setPayment(null); setPaymentFailure(null); };
  useEffect(() => {
    if (phase.status !== 'succeeded' || !payment) return;
    const key = payment.key;
    const handle = scheduler.schedule(() => { money.dismissApproval(); setPayment(current => current?.key === key ? null : current); }, posTimeTokens.payDoneMs);
    return () => scheduler.cancel(handle);
  }, [money, scheduler, payment?.key, phase.status]);
  useEffect(() => {
    if (reversal?.phase.status !== 'succeeded') return;
    const key = reversal.key;
    const handle = scheduler.schedule(() => setReversal(current => current?.key === key ? null : current), posTimeTokens.payDoneMs);
    return () => scheduler.cancel(handle);
  }, [reversal?.key, reversal?.phase.status, scheduler]);
  const confirmReversal = (quote: MoneyReversalQuote): boolean => {
    if (!reversal || !canOpen() || !quote.canSubmit) return false;
    pendingReversal.current = true;
    const entry = reversal, runId = state.runId;
    setReversal({ ...entry, phase: { status: 'pending' } });
    reversalJob.current = scheduler.schedule(() => {
      if (!mounted.current || run.getState().runId !== runId) return;
      const result = money.reverse({ quote, idempotencyKey: `money-reversal:${entry.key}`, cancelOrder: entry.cancelOrder });
      pendingReversal.current = false;
      setReversal(current => current?.key === entry.key ? { ...current, phase: result.ok ? { status: 'succeeded' } : { status: 'failed', reason: result.reason ?? result.code } } : current);
    }, posTimeTokens.payApproveMs);
    return true;
  };
  const creditPort: CreditPort = {
    openSettlement: openPayment,
    openAccounts: memberId => { if (canOpen()) run.actions.openLinkedDetail({ featureId: 'credit-receivable', itemId: memberId }); },
    openOriginalTransaction: (transaction, context) => {
      if (!canOpen()) return;
      const settlementId = data.real?.mode('pos') === 'http' && transaction.settlementId
        ? transaction.settlementId : originalMoneySettlement(money.read(), transaction);
      // A missing original stays an unavailable receipt, never another member's last receipt.
      setReceipt({ settlementId: settlementId ?? '', view: 'receipt', context: retainedReturnContext(context) });
    },
    openMembershipUse: (memberId, membershipId, context) => {
      if (!canOpen()) return;
      if (data.real?.mode('pos') === 'http') {
        run.actions.showNotice({ kind: 'error', messageKey: 'pos.notice', params: { message: 'POS 결제에서 회원권을 적용할 수 없어요' } });
        return;
      }
      setUseRequest({ memberId, membershipId, context: retainedReturnContext(context) });
      run.actions.closeOverlay();
    },
  };
  // The detail's exit and pointer release finish before the requested layer can open.
  useEffect(() => {
    if (!useRequest || useRequest.active) return;
    if (state.overlay.type !== 'none') { setUseRequest(null); return; }
    if (state.exitPendingToken || state.activeInputs.some(input => input.kind === 'pointer')) return;
    if (state.layer !== 'orders-payment' && !run.actions.switchLayer('orders-payment')) return;
    session.pos.setTab('order');
    setUseRequest(current => current ? { ...current, active: true } : null);
  }, [useRequest, state.overlay.type, state.exitPendingToken, state.activeInputs, state.layer, run, session.pos]);
  const binding = memberMoneyBinding(useMoneyRead(), creditPort);
  const completion = approval?.result?.ok ? approval.result.value : undefined;
  const saleState = useMemo<SaleSettlementState>(() => saleOverride ?? {
    billId: approval?.quote.target.purpose === 'sale' ? approval.quote.target.billId : undefined,
    phase: moneyApprovalPhase(approval),
    ...(completion ? { completion: { settled: completion.settled ?? false, remaining: completion.remaining ?? 0, orderNo: completion.orderNo } } : {}),
  }, [saleOverride, approval, completion]);
  const salePort: SettlementUiPort = {
    subscribe: money.subscribe, read: () => saleState, quoteSale: money.quoteSale, member,
    approve: quote => {
      if (!canOpen()) return false;
      setSaleOverride(null);
      const result = money.beginApproval({ quote, idempotencyKey: `sale:${crypto.randomUUID()}` });
      if (!result.ok) setSaleOverride({ billId: quote.target.purpose === 'sale' ? quote.target.billId : undefined, phase: { status: 'failed', reason: result.reason ?? result.code } });
      return result.ok;
    },
    reset: () => { if (money.dismissApproval()) setSaleOverride(null); },
    quotePartialCancellation: money.quotePartialCancellation,
    cancelPartial: quote => {
      if (!canOpen() || !quote.canSubmit) return false;
      pendingReversal.current = true;
      const billId = money.read().state.settlements.find(row => quote.settlementIds.includes(row.settlementId))?.billId ?? undefined;
      const key = crypto.randomUUID(), runId = state.runId;
      setSaleOverride({ billId, phase: { status: 'pending' } });
      reversalJob.current = scheduler.schedule(() => {
        if (!mounted.current || run.getState().runId !== runId) return;
        const result = money.cancelPartial({ quote, idempotencyKey: `partial:${key}` });
        pendingReversal.current = false;
        setSaleOverride({ billId, phase: result.ok ? { status: 'succeeded' } : { status: 'failed', reason: result.reason ?? result.code } });
      }, posTimeTokens.payApproveMs);
      return true;
    },
  };
  const accounting = useAccountingViews();
  const presentation = { ...accounting, onRetry: () => {
    const overlay = run.getState().overlay;
    if (overlay.type === 'closing') { run.actions.resetClosingPreview(); return; }
    const id = overlay.type === 'detail' ? overlay.stack?.at(-1)?.featureId ?? overlay.featureId : 'ledger';
    run.actions.resetWidgetPreview(id);
  }, onOpenReceipt: (row: import('../features/widgets/mgmt-money/ledger').AccountingTransaction) => {
    if (!canOpen()) return;
    setReceipt({ settlementId: row.settlementId, view: 'receipt', context: { selectedId: row.id, returnFocusRef: { current: document.activeElement instanceof HTMLElement ? document.activeElement : null } } });
  } };
  const hostBinding: M2WidgetBindings = { customPort, tableLinkPicker: realLinks.real ? realLinks.tablePicker : pickers.table, resetPreview: run.actions.resetWidgetPreview, busy: approval?.status === 'pending' || pendingReversal.current,
    cctv: realLinks.real ? realLinks.cctv : { linkPicker: pickers.zone, linkZones: zones, linkedTables: joined.tables, linkError } };
  const viewContext = useMemo(() => ({ linkedTableTasks: realLinks.real ? [] : joined.seatedWithoutOrderTasks.map(task => ({ ...task, params: { ...task.params, table: tables.find(table => table.id === task.tableId)?.label ?? task.params.table } })) }), [realLinks.real, joined.seatedWithoutOrderTasks, tables]);
  const paymentTarget = payment?.quote.target;
  const fundingMemberId = paymentTarget?.purpose === 'custom_order' ? custom.read().tables.customOrder.find(row => row.customOrderId === paymentTarget.customOrderId)?.memberId
    : payment && 'memberId' in payment.quote.target ? payment.quote.target.memberId : undefined;
  const paymentSummary = paymentTarget?.purpose === 'custom_order' ? custom.read().tables.customOrder.find(order => order.customOrderId === paymentTarget.customOrderId)?.productLabel ?? '' : fundingMemberId ? member(fundingMemberId)?.label ?? '' : '';
  return <WidgetDataProvider store={data} preview={state.preview} viewContext={viewContext}><PosRealHost><M2WidgetProvider value={hostBinding}><CustomOrderProvider port={customPort}><CreditPortContext.Provider value={creditPort}><MemberMoneyProvider binding={binding}><SettlementUiProvider value={salePort}><AccountingPresentationProvider value={presentation}>
    {children}
    {useRequest && state.layer === 'orders-payment' && <MembershipUseHandoff request={useRequest} session={session} onChange={setUseRequest} onReturn={() => {
      const context = useRequest.context;
      run.actions.switchLayer('management'); run.actions.openDetailRef(context.detailRef, 'dashboard'); setUseRequest(null);
      scheduler.schedule(() => context.returnFocusRef.current?.focus(), 0);
    }}/>}
    {payment ? <SharedPosPaymentDialog mode="money" key={payment.key} open target={payment.quote.target} summary={paymentSummary} quote={payment.quote} member={fundingMemberId ? member(fundingMemberId) : null} phase={phase} returnFocusRef={payment.context.returnFocusRef} onAllocationsChange={allocations => {
      const quote = money.quoteSettlement({ target: payment.quote.target, allocations }); setPayment(current => current?.key === payment.key ? { ...current, quote } : current); return quote;
    }} onApprove={quote => {
      const result = money.beginApproval({ quote, idempotencyKey: `funding:${crypto.randomUUID()}` });
      if (!result.ok) setPaymentFailure(result.reason ?? result.code); return result.ok;
    }} onReset={() => { money.dismissApproval(); setPaymentFailure(null); setPayment(current => current ? { ...current, quote: money.quoteSettlement({ target: current.quote.target, allocations: current.quote.allocations }) } : current); }} onClose={closePayment}/> : null}
    {reversal ? <SharedPosReversalDialog mode="money" key={reversal.key} open quote={reversal.quote} phase={reversal.phase} returnFocusRef={reversal.context.returnFocusRef} cancelOrder={reversal.cancelOrder} onConfirm={confirmReversal} onClose={() => { if (!pendingReversal.current) setReversal(null); }} onRetry={() => setReversal(current => current ? { ...current, key: crypto.randomUUID(), quote: money.quoteReversal(current.quote.input), phase: readyPhase } : null)} onAmountChange={amount => setReversal(current => current ? { ...current, quote: money.quoteReversal({ ...current.quote.input, amount: amount ?? 0 }) } : null)}/> : null}
    <PosReceiptHost entry={receipt} onClose={() => setReceipt(null)} returnFocusRef={receipt?.context.returnFocusRef} scheduler={scheduler}/>
  </AccountingPresentationProvider></SettlementUiProvider></MemberMoneyProvider></CreditPortContext.Provider></CustomOrderProvider></M2WidgetProvider></PosRealHost></WidgetDataProvider>;
}

/**
 * REAL-PLAN F02: when the POS domain runs over HTTP, one bridge per run publishes the service's records into the run and carries the
 * owner's checkout, correction and preparation commands. Fixture builds get no bridge and every POS screen keeps its local behavior.
 */
function PosRealHost({ children }: { readonly children: ReactNode }) {
  const data = useWidgetDataStore(), session = useSessionActions(), real = data.real;
  const bridge = useMemo<PosBridge | null>(() => {
    if (!real || real.mode('pos') !== 'http') return null;
    return createPosBridge({
      remote: createPosRemote({ transport: real.transport, reads: real.reads }),
      read: session.pos.read, commit: session.commit,
      reload: domains => { for (const domain of domains) if (real.mode(domain) === 'http') void real.load(domain, { force: true }); },
    });
  }, [real, session]);
  useEffect(() => {
    if (!bridge || !real) return;
    bindPosBridge(bridge);
    // The port loads the domain once idle (first start, retry, store change) and the adapter drives `bridge.sync()`.
    const kick = () => {
      if (real.state('pos').status === 'idle') void real.load('pos');
      if (real.mode('menu') === 'http' && real.state('menu').status === 'idle') void real.load('menu');
      // Cart validation needs the current store's ingredient units for the menu's real recipe.
      if (real.mode('stock') === 'http' && real.state('stock').status === 'idle') void real.load('stock');
      // R1-F06-2: the table map shows the booking that is due at a table; over HTTP its rows come from the booking domain.
      if (real.mode('booking') === 'http' && real.state('booking').status === 'idle') void real.load('booking');
    };
    kick();
    const off = real.subscribe(kick);
    return () => { off(); bindPosBridge(undefined); bridge.dispose(); };
  }, [real, bridge]);
  return <PosBridgeProvider value={bridge}>{children}</PosBridgeProvider>;
}

function MembershipUseHandoff({ request, session, onChange, onReturn }: {
  readonly request: { memberId: string; membershipId: string; context: MemberReturnContext; billId?: string; error?: string; active?: boolean };
  readonly session: ReturnType<typeof useSessionActions>;
  readonly onChange: (next: typeof request) => void; readonly onReturn: () => void;
}) {
  const read = usePosSnapshot(), { t } = useBundle(posBundle);
  const needsBill = read.settings.paymentStyle === 'postpaid' && read.pos.cart.type !== 'takeout';
  const bills = read.pos.bills.filter(row => row.status === 'open');
  const billId = needsBill ? request.billId ?? bills[0]?.billId : getPaymentBillId(read);
  const quote = billId ? quotePaymentBill(read, billId) : null;
  const applied = quote?.discounts.some(row => row.membershipId === request.membershipId);
  const apply = () => {
    if (!billId) return;
    const meta = () => ({ runId: read.runId, idempotencyKey: `member-use:${crypto.randomUUID()}` });
    const linked = session.pos.execute({ type: 'bill.member', billId, memberId: request.memberId, meta: meta() });
    const result = linked.ok ? session.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'membership', membershipId: request.membershipId }, meta: meta() }) : linked;
    onChange({ ...request, billId, error: result.ok ? undefined : t(result.messageKey as keyof typeof posBundle.ko) });
  };
  return <Card className="app-common-notice ui-pos-notice" role="region" aria-label="회원권 사용 연결" lang="ko" data-pos-alert-blocker>
    <CardHeader><CardTitle>회원권 사용</CardTitle><CardDescription>이용할 메뉴와 수량을 고른 뒤 회원권을 적용해 주세요</CardDescription></CardHeader>
    {(needsBill || request.error) && <CardContent>{needsBill && <ChipChoice label="계산서 고르기" value={billId ?? ''} options={bills.map(row => ({ value: row.billId, label: row.tableId ?? `주문 #${row.originOrderNo}` }))} onChange={value => onChange({ ...request, billId: value, error: undefined })}/>}{request.error && <p role="alert">{request.error}</p>}</CardContent>}
    <CardFooter className="pay-tools__row">
    <ActionButton disabled={!quote?.lines.length || applied} onClick={apply}>{applied ? '회원권을 적용했어요' : '선택한 회원권 적용하기'}</ActionButton>
    <ActionButton variant="ghost" onClick={onReturn}>회원목록으로 돌아가기</ActionButton>
    </CardFooter>
  </Card>;
}

// Nonmodal POS surfaces still need exclusive access to their controls (API-245).
const alertBlockers = '[role="dialog"],[role="alertdialog"],.ui-popover,.ui-detail-side-panel,[data-pos-alert-blocker]';
function hasAlertBlocker(root: ParentNode): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>(alertBlockers)).some(surface =>
    !surface.closest('[inert],[aria-hidden="true"],[data-exiting="true"],[hidden]'));
}

/** Shell-owned: works even when no management widget or POS screen is mounted. */
export function PosAlertHost({ run }: { readonly run: RunStore }) {
  const state = useSyncExternalStore(run.subscribe, run.getState), runtime = usePosStatusSession(), read = usePosSnapshot();
  const { portalContainer, canvasElement } = useUi();
  const root = canvasElement ?? document.body;
  const [surfaceOpen, setSurfaceOpen] = useState(false);
  // Run/store updates can mount a prompt in this commit. Read it before paint;
  // the observer also catches windows controlled by another component's local state.
  useLayoutEffect(() => { setSurfaceOpen(hasAlertBlocker(root)); });
  useEffect(() => {
    const sync = () => setSurfaceOpen(hasAlertBlocker(root));
    sync(); const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-hidden', 'data-exiting', 'inert', 'hidden', 'data-pos-alert-blocker'] });
    return () => observer.disconnect();
  }, [root]);
  const inPos = state.screen === 'dashboard' && state.layer === 'orders-payment';
  const dashboard = state.screen === 'dashboard' && state.layer === 'management';
  const status = inPos && read.posUi.tab === 'status';
  const coach = !!state.guidance.active || !!state.guidance.activeWidget || !!state.templateTour && state.templateTour.status !== 'completed';
  const blocked = surfaceOpen || state.overlay.type !== 'none' || !!state.exitPendingToken || state.pageHidden || state.idle.mode === 'idle' || state.edit.mode === 'edit';
  useEffect(() => { runtime.evaluateAlert({ onDashboard: dashboard, onPos: inPos, orderDetailOpen: status, coachVisible: coach, overlayOpen: blocked || hasAlertBlocker(root) }); }, [runtime, read, dashboard, inPos, status, coach, blocked, root]);
  const summary = selectOrderSummary(read), missing = summary.openList.find(row => row.isMissing);
  if (!portalContainer) return null;
  const visible = read.posUi.orderAlert?.visible && missing && (dashboard || inPos) && !status && !coach && !blocked && read.scenario !== 'error';
  const dismiss = () => runtime.execute({ type: 'orderAlert.dismiss', ids: summary.missingIds, meta: { runId: read.runId, idempotencyKey: `dismiss:${summary.missingIds.join(',')}` } });
  return createPortal(<AnimatePresence>{visible && missing ? <MissingOrderAlert key={read.runId} row={missing} count={summary.missingCount} location={inPos ? read.posUi.tab === 'order' ? 'order' : 'tables' : 'management'} hasNotice={!!selectCommonNotice(state)} onOpen={() => runtime.openPos({ tab: 'status', orderId: missing.id, forceVisible: true })} onDismiss={dismiss}/> : null}</AnimatePresence>, portalContainer);
}
