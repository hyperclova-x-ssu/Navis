import type { RunStore } from '../contracts';
import type { PosApprovalCompletion, PosApprovalPending, PosApprovalInput, PosCartCommand, PosSessionCommand, PosTableCommand, PosCommandValue, PosDataRead, PosFinishApproval, PosPlan, PosPlanningResult, PosReadSnapshot, PosResult, PosSession, PosSuccess, PosUiState } from '../contracts/pos';
import { businessNow } from './clock';
import { planPosCommand, planPosUndo } from './domain';
import { canonical, commandKey, posFailure, checkMeta, makePlan, unchanged } from './domain/common';
import { applyOrderStatusCommand, initialOrderAlert, evaluateOrderAlert, dismissOrderAlert, seenOrderAlert, selectOrderSummary, isOrderUndoLive, pauseOrderUndo, resumeOrderUndo, type OrderAlertContext, type OrderUndoPauseReason, type OrderFilter } from './status';
import type { PosStatusCommand } from '../contracts/pos';
import { canonicalPosMoney } from './domain/money';
import { cartCommandPayload } from './domain/cart';
import { planTableCommand, planTableUndo, tableCommandPayload, selectPosPreferences, tablesEnabled, transferredDiscountsMatch } from './tables';
import { preserveOrderSequence } from './tables/commands';
import { planLoyaltyCommand, loyaltyCommandPayload, planPaymentBegin, planPaymentFinish } from './loyalty';
import type { PosLoyaltyCommand } from '../contracts/pos';
import type { PosReversalCommand, PosDrawerCommand } from '../contracts/pos';
import { planReversalCommand, reversalCommandPayload } from './reversals';
import { planDrawerCommand, planDrawerUndo, drawerCommandPayload } from './closing';
import { preserveTransferOrderProgress } from './tables/transfer';

const isTableCommand = (command: PosSessionCommand): command is PosTableCommand => ['bill.moveTable', 'bill.mergeTables', 'bill.separateTable', 'bill.submitOrder', 'bill.requestPayment', 'table.clean', 'table.saveLayout', 'reservation.respond', 'pos.setPreferences', 'order.cancelUnpaid'].includes(command.type);
const isStatusCommand = (command: PosSessionCommand): command is PosStatusCommand => ['order.start', 'order.complete', 'order.reopen', 'order.undo', 'orderAlert.seen', 'orderAlert.dismiss'].includes(command.type);
const isLoyaltyCommand = (command: PosSessionCommand): command is PosLoyaltyCommand => ['bill.member', 'bill.setDiscount', 'bill.removeDiscount', 'bill.split', 'bill.clearSplit', 'bill.cancelPartial', 'bill.confirmZero'].includes(command.type);
const isReversalCommand = (command: PosSessionCommand): command is PosReversalCommand => ['payment.reverse', 'receipt.showAgain', 'cashReceipt.issue', 'cashReceipt.cancel'].includes(command.type);
const isDrawerCommand = (command: PosSessionCommand): command is PosDrawerCommand => ['drawer.set', 'drawer.addMovement', 'drawer.removeMovement'].includes(command.type);
const statusPayload = (command: PosStatusCommand) => { const { meta: _meta, ...payload } = command; return payload; };
const editPayload = (command: PosCartCommand | PosTableCommand | PosStatusCommand | PosLoyaltyCommand | PosReversalCommand | PosDrawerCommand) => isDrawerCommand(command) ? drawerCommandPayload(command) : isReversalCommand(command) ? reversalCommandPayload(command) : isLoyaltyCommand(command) ? loyaltyCommandPayload(command) : isStatusCommand(command) ? statusPayload(command) : isTableCommand(command) ? tableCommandPayload(command) : cartCommandPayload(command);

export interface PosRuntimeOptions {
  readonly run: RunStore;
  /** Must return a stable immutable reference for the current data revision. */
  readonly readData: () => PosDataRead;
  readonly subscribeData?: (listener: () => void) => () => void;
  /** T-242: prepare both, isCurrent both, publish both silently, flush each once. */
  readonly commit: (plan: PosPlan, expected: PosReadSnapshot) => PosResult<PosCommandValue>;
  readonly onDispose?:()=>void;
  readonly moneyCommand?: (command:PosSessionCommand)=>PosResult<PosCommandValue>|undefined;
  readonly isBusy?: () => boolean;
  readonly businessNow?: () => string;
}
export interface PosRuntime extends PosSession {
  readonly beginApproval: (input: PosApprovalInput) => PosResult<PosApprovalPending | PosApprovalCompletion>;
  /** Called only by the app's injected approval scheduler, after time.pay-approve. */
  readonly finishApproval: (input: PosFinishApproval) => PosResult<PosCommandValue>;
  readonly dismissApproval: () => boolean;
  readonly setTab: (tab: PosUiState['tab']) => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}
export interface PosStatusRuntime extends PosRuntime {
  readonly openPos: (input: { readonly tab: 'status'; readonly orderId?: string; readonly forceVisible?: boolean }) => boolean;
  readonly selectStatus: (filter: OrderFilter, orderId: string | null) => boolean;
  readonly evaluateAlert: (context: OrderAlertContext) => void;
  readonly pauseStatusUndo: (reason: OrderUndoPauseReason, paused: boolean) => void;
}
/** Existing composer-only consumers can retain the narrower runtime port. */
export function orderStatusRuntime(runtime: PosRuntime): PosStatusRuntime {
  if (!('openPos' in runtime) || !('selectStatus' in runtime) || !('evaluateAlert' in runtime) || !('pauseStatusUndo' in runtime)) throw new Error('Order status runtime is required');
  return runtime as PosStatusRuntime;
}
export function createPosRuntime(options: PosRuntimeOptions): PosStatusRuntime {
  const { run } = options;
  let disposed = false, applying = false, lastRun: ReturnType<RunStore['getState']> | undefined;
  let lastData: PosDataRead | undefined, snapshot: PosReadSnapshot;
  // No-op results cannot enter the business ledger without creating a revision/notification.
  // Retain only these inert results in this run's runtime; applied keys live in PosState.
  const unchangedKeys = new Map<string, { fingerprint: string; result: PosSuccess<PosCommandValue>; scenario: PosReadSnapshot['scenario']; generation: number }>();
  const read = (): PosReadSnapshot => {
    const state = run.getState(), data = options.readData();
    if (lastRun && state.runId !== lastRun.runId) unchangedKeys.clear();
    if (state !== lastRun || data !== lastData) {
      const scenario = state.preview.pos ?? (state.preview.family === 'empty' || state.preview.family === 'error' ? state.preview.family : 'normal');
      snapshot = Object.freeze({ runId: state.runId, runRevision: state.runRevision, pos: state.pos, posRevision: state.posRevision,
        posUi: state.posUi, dataRevision: data.revision, settings: state.shopSettings, scenario, data });
      lastRun = state; lastData = data;
    }
    return snapshot;
  };
  function apply(planned: PosPlanningResult, expected: PosReadSnapshot): PosResult<PosCommandValue> {
    if (!planned.ok) return planned;
    let { plan } = planned;
    if (plan.nextPos === expected.pos) {
      if (plan.nextUi !== expected.posUi && !run.actions.setPosUi(plan.nextUi, expected.runId)) return posFailure('TRANSACTION_BUSY', 'CONFLICT');
      return plan.result;
    }
    // Old approval planners used array length for IDs; M3 removes eight real receipts,
    // so keep their new IDs unique against the retained immutable transaction IDs.
    const minted=plan.nextPos.payments.slice(expected.pos.payments.length),ids=new Map<string,string>();
    let number=Math.max(0,...expected.pos.payments.map(p=>Number(/^P-(\d+)$/.exec(p.paymentId)?.[1]??0)));
    for(const p of minted)if(expected.pos.payments.some(o=>o.paymentId===p.paymentId))ids.set(p.paymentId,`P-${String(++number).padStart(3,'0')}`);
    if(ids.size){const value=plan.result.value&&'paymentId'in plan.result.value?{...plan.result.value,paymentId:ids.get(plan.result.value.paymentId!)??plan.result.value.paymentId!}:plan.result.value,result={...plan.result,value};
      plan={...plan,result,nextPos:{...plan.nextPos,payments:plan.nextPos.payments.map((p,i)=>i<expected.pos.payments.length?p:{...p,paymentId:ids.get(p.paymentId)??p.paymentId,...(ids.has(p.paymentId)?{transactionNo:`거래-${expected.pos.businessDate.replaceAll('-','')}-${ids.get(p.paymentId)!.slice(2).padStart(4,'0')}`,approvalNo:`예시-${ids.get(p.paymentId)!.slice(2).padStart(6,'0')}`}:{})}),receipts:plan.nextPos.receipts.map((r,i)=>i<expected.pos.receipts.length?r:{...r,paymentId:ids.get(r.paymentId)??r.paymentId}),commandLedger:plan.nextPos.commandLedger.map(r=>r.result===plan.result?{...r,result}:r)}};
    }
    const money=options.moneyCommand?plan.nextPos.money:canonicalPosMoney(plan.nextPos);
    return options.commit(money&&money!==plan.nextPos.money?{...plan,nextPos:{...plan.nextPos,money}}:plan, expected);
  }
  function plan(read: PosReadSnapshot, command: PosSessionCommand): PosPlanningResult {
    const now = (options.businessNow ?? businessNow)();
    if (isDrawerCommand(command)) return planDrawerCommand(read, command, now);
    if (isReversalCommand(command)) return planReversalCommand(read, command, now);
    if (isStatusCommand(command)) {
      const checked = checkMeta(read, command.meta, command.type, statusPayload(command)); if (checked) return checked;
      if (read.scenario === 'error' || read.scenario === 'empty') return posFailure('DATA_UNAVAILABLE');
      if (read.posUi.approval?.status === 'pending') return posFailure('APPROVAL_BUSY', 'CONFLICT');
      if ('ids' in command) {
        const alert = read.posUi.orderAlert ?? initialOrderAlert;
        const next = command.type === 'orderAlert.dismiss' ? dismissOrderAlert(alert) : seenOrderAlert(alert, command.ids);
        const result = unchanged(read, null);
        return result.ok ? { ok: true, plan: { ...result.plan, nextUi: next === alert ? read.posUi : { ...read.posUi, orderAlert: next } } } : result;
      }
      const token = `pos:status:${commandKey(command.meta, command.type)}`;
      const outcome = applyOrderStatusCommand({ pos: read.pos, orderUndo: read.posUi.orderUndo ?? null }, command, { now: Date.now(), businessNow: now, token });
      if (outcome.result.status === 'unchanged') return posFailure(outcome.result.code, 'CONFLICT');
      const nextPos = command.type === 'order.undo' ? { ...outcome.slice.pos, commandLedger: outcome.slice.pos.commandLedger.map(record => record.key === command.token.slice('pos:status:'.length) ? { ...record, undone: true } : record) } : outcome.slice.pos;
      const nextRead = { ...read, pos: nextPos };
      const summary = selectOrderSummary(nextRead);
      const alert = read.posUi.orderAlert ?? initialOrderAlert;
      const nextUi = { ...read.posUi, orderUndo: outcome.slice.orderUndo,
        orderAlert: summary.missingCount ? alert : dismissOrderAlert(alert) };
      return makePlan(read, nextPos, nextUi, null, command.meta, command.type, statusPayload(command), command.type === 'order.start' || command.type === 'order.complete' ? token : undefined);
    }
    if (isLoyaltyCommand(command)) return planLoyaltyCommand(read, command, now);
    if (isTableCommand(command)) {
      const checked = checkMeta(read, command.meta, command.type, tableCommandPayload(command)); if (checked) return checked;
      if (command.type === 'bill.submitOrder') {
        const target = command.billId ?? read.pos.cart.targetBillId;
        const table = command.tableId ?? read.pos.cart.tableId;
        if (read.pos.bills.some(b => b.splitPlan && (b.billId === target || table && b.tableId === table && ['open', 'partial'].includes(b.status)))) return posFailure('BILL_LOCKED', 'CONFLICT');
      }
      if (command.type === 'order.cancelUnpaid') {
        const lines = read.pos.orders.find(o => o.orderId === command.orderId)?.lines ?? [];
        if (read.pos.billAllocations.some(a => lines.some(l => l.orderLineId === a.orderLineId) && read.pos.bills.some(b => b.billId === a.billId && (b.splitPlan || b.discounts.some(d => d.fixedAllocations)) && ['open', 'partial'].includes(b.status)))) return posFailure('BILL_LOCKED', 'CONFLICT');
      }
      return planTableCommand(read, command, now);
    }
    if (command.type === 'approval.begin') {
      if ('billId' in command && !transferredDiscountsMatch(read, command.billId)) return posFailure('QUOTE_CHANGED', 'CONFLICT');
      return planPaymentBegin(read, command, now);
    }
    if (command.type === 'approval.finish') {
      const attempt = read.posUi.approval;
      // API-242: an unavailable view is a validation failure for the current pending callback.
      // Replaced callbacks and callbacks across a closing generation still use the planner's stale guard.
      const currentPending = attempt?.status === 'pending' && attempt.billId && attempt.approvalInput
        && command.runId === read.runId && attempt.runId === command.runId && attempt.attemptId === command.attemptId
        && attempt.quoteFingerprint === command.expectedQuoteFingerprint && attempt.closingGeneration === read.data.closingGeneration;
      if (currentPending) {
        if (read.data.dayClosed) return posFailure('DAY_CLOSED', 'CONFLICT');
        if (read.scenario === 'error' || read.scenario === 'empty') return posFailure('DATA_UNAVAILABLE');
      }
      return planPaymentFinish(read, command, now);
    }
    // Takeout is paid immediately even in a postpaid shop, through the existing single-payment plan.
    const immediate = read.settings.paymentStyle === 'postpaid' && read.pos.cart.type === 'takeout'
      ? { ...read, settings: { ...read.settings, paymentStyle: 'prepaid' as const } } : read;
    const planned = planPosCommand(immediate, command, now);
    return preserveOrderSequence(read, planned);
  }
  function execute(command: PosSessionCommand): PosResult<PosCommandValue> {
    if (disposed) return posFailure('STALE_RUN', 'CONFLICT');
    const moneyResult=options.moneyCommand?.(command);if(moneyResult)return moneyResult;
    if (applying || options.isBusy?.()) return posFailure('TRANSACTION_BUSY', 'CONFLICT');
    applying = true;
    try {
      const expected = read();
      const cartCommand = command.type !== 'approval.begin' && command.type !== 'approval.finish' ? command : null;
      const key = cartCommand ? commandKey(cartCommand.meta, cartCommand.type) : null;
      const previous = key ? unchangedKeys.get(key) : undefined;
      if (previous && cartCommand) {
        if (cartCommand.meta.runId !== expected.runId) return posFailure('STALE_RUN', 'CONFLICT');
        if (previous.scenario !== expected.scenario || previous.generation !== expected.data.closingGeneration) return posFailure('STALE_REVISION', 'CONFLICT');
        if (previous.fingerprint !== canonical(editPayload(cartCommand))) return posFailure('IDEMPOTENCY_MISMATCH', 'CONFLICT');
        return { ...previous.result, duplicate: true };
      }
      const result = apply(plan(expected, command), expected);
      if (result.ok && result.status === 'unchanged' && key && cartCommand) unchangedKeys.set(key, {
        fingerprint: canonical(editPayload(cartCommand)), result, scenario: expected.scenario, generation: expected.data.closingGeneration,
      });
      if (!result.ok && command.type === 'approval.finish') {
        const state = run.getState(), attempt = state.posUi.approval;
        if (attempt?.status === 'pending' && state.runId === command.runId && attempt.attemptId === command.attemptId && attempt.quoteFingerprint === command.expectedQuoteFingerprint) {
          run.actions.setPosUi({ ...state.posUi, approval: { ...attempt, status: 'failed', result } }, command.runId);
        }
      }
      return result;
    } finally { applying = false; }
  }
  return {
    execute, read,
    beginApproval: input => execute({ ...input, type: 'approval.begin' }) as PosResult<PosApprovalPending | PosApprovalCompletion>,
    finishApproval: input => execute({ ...input, type: 'approval.finish' }),
    undo(token) {
      if (disposed) return posFailure('STALE_RUN', 'CONFLICT');
      if (applying || options.isBusy?.()) return posFailure('TRANSACTION_BUSY', 'CONFLICT');
      applying = true;
      try { const expected = read(); if(token.startsWith('pos:status:') && (!expected.posUi.orderUndo || expected.posUi.orderUndo.token !== token || !isOrderUndoLive(expected.posUi.orderUndo, Date.now()))) return posFailure('UNDO_UNAVAILABLE', 'CONFLICT'); return apply(token.startsWith('pos:status:') ? plan(expected, { type: 'order.undo', token, meta: { runId: expected.runId, idempotencyKey: `undo:${token}` } }) : token.startsWith('pos:drawer:') ? planDrawerUndo(expected, token) : token.startsWith('pos:tables:') ? planTableUndo(preserveTransferOrderProgress(expected, token), token) : planPosUndo(expected, token), expected); } finally { applying = false; }
    },
    dismissApproval() {
      if (disposed || applying || options.isBusy?.()) return false;
      const state = run.getState();
      if (state.posUi.approval?.status === 'pending') return false;
      if (!state.posUi.approval) return true;
      return run.actions.setPosUi({ ...state.posUi, approval: null }, state.runId);
    },
    setTab(tab) {
      if (disposed || applying || options.isBusy?.() || !['order', 'status', 'tables'].includes(tab)) return false;
      const state = run.getState();
      const preferences = selectPosPreferences(state.shopSettings);
      if (tab === 'tables' && (!tablesEnabled(state.shopSettings) || !preferences.showTables) || tab === 'status' && !preferences.showStatus && !state.posUi.forceStatusVisible) return false;
      if (state.posUi.approval?.status === 'pending') return false;
      if (state.posUi.tab === tab) return true;
      return run.actions.setPosUi({ ...state.posUi, tab }, state.runId);
    },
    openPos(input) {
      if (disposed || applying || options.isBusy?.()) return false;
      const state = run.getState();
      if (state.posUi.approval?.status === 'pending' || !input.forceVisible && !selectPosPreferences(state.shopSettings).showStatus) return false;
      if (input.orderId && !state.pos.orders.some(order => order.orderId === input.orderId)) return false;
      if (state.overlay.type !== 'none') { const exit = run.actions.closeOverlay('button'); if (exit) run.actions.finishOverlayExit(exit); }
      if (state.layer !== 'orders-payment' && !run.actions.switchLayer('orders-payment')) return false;
      const current = run.getState();
      const alert = dismissOrderAlert(seenOrderAlert(current.posUi.orderAlert ?? initialOrderAlert, selectOrderSummary(read()).missingIds));
      return run.actions.setPosUi({ ...current.posUi, tab: 'status', statusFilter: 'open', selectedOrderId: input.orderId ?? null,
        forceStatusVisible: !!input.forceVisible || current.posUi.forceStatusVisible, orderAlert: alert,
        ...(input.orderId ? { orderHighlight: { orderId: input.orderId, token: `${current.runId}:${current.posRevision}:${Date.now()}` } } : {}) }, current.runId);
    },
    selectStatus(filter, orderId) {
      if (disposed || applying || options.isBusy?.()) return false;
      const state = run.getState();
      if (state.posUi.statusFilter === filter && state.posUi.selectedOrderId === orderId) return true;
      return run.actions.setPosUi({ ...state.posUi, statusFilter: filter, selectedOrderId: orderId }, state.runId);
    },
    evaluateAlert(context) {
      if (disposed || applying || options.isBusy?.()) return;
      const state = run.getState(), current = state.posUi.orderAlert ?? initialOrderAlert;
      const summary = selectOrderSummary(read());
      const alert = context.orderDetailOpen ? dismissOrderAlert(seenOrderAlert(current, summary.missingIds)) : evaluateOrderAlert(current, summary, context);
      if (alert !== current) run.actions.setPosUi({ ...state.posUi, orderAlert: context.orderDetailOpen ? dismissOrderAlert(alert) : alert }, state.runId);
    },
    pauseStatusUndo(reason, paused) {
      if (disposed || applying || options.isBusy?.()) return;
      const state = run.getState(), undo = state.posUi.orderUndo ?? null;
      const next = paused ? pauseOrderUndo(undo, reason, Date.now()) : resumeOrderUndo(undo, reason, Date.now());
      if (next !== undo) run.actions.setPosUi({ ...state.posUi, orderUndo: next }, state.runId);
    },
    subscribe: listener => {
      const offRun = run.subscribe(listener), offData = options.subscribeData?.(listener);
      return () => { offRun(); offData?.(); };
    },
    dispose() { disposed = true; options.onDispose?.(); lastRun = undefined; lastData = undefined; unchangedKeys.clear(); },
  };
}
