import type { PreparedChange, SessionGate, SessionTransaction, SessionTransactionPort, PrepareResult } from '../../contracts';
import { handlers, type HandlerContext, type HandlerResult } from '../commands/handlers';
import type { SettingsCommand } from '../commands/management-types';
import { ONCE_COMMANDS, type DataCommand, type DataCommandResult, type ReversiblePickupCommand } from '../commands/types';
import { createSeedTables } from './seed';
import { deepFreeze } from './freeze';
import type { DataSnapshot, DataTables, SeedOverrides } from './types';
import { equalData, inverseChange } from './inverse';
import { REAL_UNDO_PREFIX, type RealPort } from '../reality/00/port';
import { posSettingsChange } from './settings';
import { isIsoDate } from './time';
import { selectClosing, paymentTotals } from '../derive/payments';
import type { ClosingScenario, CommandLedgerEntry } from './management-types';
import type { PosDataChanges, PosState, PosUiState } from '../../contracts/pos';
import type { PosPreferences } from '../../contracts/session';
import { createPosSeed } from '../../pos/seed';
import { applyCustomMoney, customTables, initializeCustomPos, selectCustomOrderRead, selectM2DayTotals, selectM2Drawer, projectPosTables } from '../pos/projection';
import { businessNow } from '../../pos/clock';
import { applyPosReservationWrite } from '../commands/management';
import { planCustomOrderCommand } from '../iteration7/custom-orders';
import { noticeRequiresKey } from '../iteration7/notices';
import { selectMoneyRead } from '../pos/projection';
import { selectAccountingDay } from '../iteration7/accounting';
import { appendStaffHistory } from '../iteration7/staff/commands';
// D-326 receipt undo dependencies.
import { isExpenseDayClosed } from '../commands/management-guards';
import { checkReversiblePickup } from '../commands/custom-order-guard';
import { synchronizeCustomMoney } from '../pos/projection';

export type DataSessionInput = (SettingsCommand & { readonly posPreferences?: PosPreferences; readonly commandRecord?: {readonly key:string;readonly fingerprint:string;readonly result:DataCommandResult} }) | { readonly type: 'pos.commit'; readonly expectedPosRevision: number; readonly nextPos: PosState; readonly dataChanges?: PosDataChanges; readonly undoPickupToken?: string };

export interface WidgetDataStore {
  getSnapshot(): DataSnapshot;
  subscribe(listener: () => void): () => void;
  /** Sync command. In a real (HTTP) domain: optimistic commands preview locally and settle in the background (`pending: true`); the rest return `ASYNC_REQUIRED` — use `execute`. */
  dispatch(command: DataCommand): DataCommandResult;
  /** The fixture handlers only (no real routing). The real port uses it for optimistic previews. */
  dispatchLocal(command: DataCommand): DataCommandResult;
  /** Authoritative command, always a Promise: resolves after the server receipt and the dependent re-read; fixture commands resolve with the local result. */
  execute(command: DataCommand): Promise<DataCommandResult>;
  undo(token: string): DataCommandResult;
  /** Replace whole tables from an HTTP load (REAL-PLAN F00). Skipped when nothing changed, so a background refresh does not stale a card's `baseRevision`. */
  hydrate(tables: Partial<DataTables>): void;
  /** The data port of this run, if the app composed one (REAL-PLAN F00). */
  readonly real: RealPort | undefined;
  bindReal(port: RealPort | undefined): void;
  readonly session: SessionTransactionPort<DataSessionInput>;
  bindCustomDispatch(dispatch: (command: import('../iteration7/custom-orders').CustomOrderCommand | ReversiblePickupCommand) => DataCommandResult,
    busy:()=>boolean, undoPickup?: (token: string, nextPos: PosState) => DataCommandResult): void;
  bindMoneyBusy(read:()=>boolean):void;
  bindMembershipDispatch(dispatch:(command:Extract<DataCommand,{type:'memberships.useOnce'|'memberships.cancelUse'}>)=>DataCommandResult):void;
  replay(command: {readonly type:string;readonly idempotencyKey?:string}): DataCommandResult | undefined;
  remember(command: {readonly type:string;readonly idempotencyKey?:string},result:DataCommandResult): void;
}
export interface DataStoreOptions {
  readonly runId?: string; readonly sessionGate?: SessionGate;
  /** Pass run.getState().pos at construction so both stores share the initial reference. */
  readonly pos?: PosState;
  /** Approval busy is UI-only and must still block the direct closeDay command. */
  readonly readPosUi?: () => PosUiState;
}
const NEW_ONCE = new Set(['menu.create', 'inventory.createItem', 'suppliers.createSupplier', 'suppliers.createPurchaseItem', 'suppliers.createOrder', 'suppliers.recordReceipt', 'members.create', 'booking.create', 'tax.createPayment', 'grants.apply', 'manuals.create', 'closing.closeDay', 'closing.undoDay']);
// D-326 uses the command ledger for fingerprinted replay.
for (const type of ['ledger.updateExpense', 'manuals.setPublished', 'coupon.update', 'coupon.endEarly', 'coupon.unpublish']) NEW_ONCE.add(type);
const error = (reason: string, field?: string): DataCommandResult => ({ ok: false, code: reason === 'KEY_REQUIRED' ? 'VALIDATION' : 'CONFLICT', reason, messageKey: `data.management.error.${reason}`, ...(field ? { field } : {}) });
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k, v]) => k !== 'baseRevision' && v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const fingerprint = (command: object) => JSON.stringify(canonical(command));
const settingsCommand = (c: DataCommand): c is SettingsCommand => c.type === 'onboarding.setAnswers' || c.type === 'shop.updateSettings';
const closingCommand = (c: DataCommand) => c.type === 'closing.closeDay' || c.type === 'closing.undoDay';
const preservedTables = new Set(['dayClosing', 'commandLedger', 'appliedKeys', 'payment', 'paymentLine', 'dailySales', 'menuDaily', 'staffScheduleChange']);
const businessTables = (t: DataTables) => Object.fromEntries(Object.entries(t).filter(([name]) => !preservedTables.has(name))) as Omit<DataTables, 'dayClosing' | 'commandLedger' | 'appliedKeys' | 'payment' | 'paymentLine' | 'dailySales' | 'menuDaily' | 'staffScheduleChange'>;
// D-326 adds only the context needed to check an affected day or recognition at receipt undo.
type PendingUndo = { token: string; before: DataTables; after: DataTables; ledgerKey?: string; legacyKey?: string;
  expenseDates?: readonly string[]; pickupRecognitionId?: string };
const isReversiblePickup = (command: DataCommand): command is ReversiblePickupCommand =>
  command.type === 'customOrder.receive' && 'reversiblePickup' in command && command.reversiblePickup === true;


export function createWidgetDataStore(seed?: SeedOverrides, options: DataStoreOptions = {}): WidgetDataStore {
  const runId = options.runId ?? 'run';
  const initialPos = options.pos ?? initializeCustomPos(createPosSeed());
  let snapshot: DataSnapshot = deepFreeze({ revision: 0, seq: 0, runId, pos: initialPos, tables: projectPosTables(createSeedTables(seed), initialPos) });
  const seedIds = new Set<string>();
  function collectIds(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(collectIds); return; }
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (/Id$/.test(key) && typeof child === 'string') seedIds.add(child); else collectIds(child); }
  }
  collectIds(snapshot.tables);
  let pendingUndo: PendingUndo | null = null;
  let tokenSeq = 0, notifying = false;
  let membershipDispatch:((command:Extract<DataCommand,{type:'memberships.useOnce'|'memberships.cancelUse'}>)=>DataCommandResult)|undefined;
  let customBusy:()=>boolean = ()=>false,moneyBusy:()=>boolean=()=>false;
  let customDispatch: Parameters<WidgetDataStore['bindCustomDispatch']>[0] | undefined;
  let undoPickupWithCoordinator: Parameters<WidgetDataStore['bindCustomDispatch']>[2];
  // No-op acknowledgements leave the published snapshot and revision unchanged.
  const noOpLedger = new Map<string, CommandLedgerEntry>();
  const closingTokens = new Map<string, { date: string; scenario: ClosingScenario; closingId: string }>();
  const listeners = new Set<() => void>();
  const prepared = new Map<string, { tx: SessionTransaction; before: DataSnapshot; after: DataSnapshot; pickupUndo?: PendingUndo | null }>();
  let pendingFlush: string | null = null;
  const busy = () => customBusy() || notifying || pendingFlush !== null || !!options.sessionGate && options.sessionGate.phase !== 'idle';
  const project = (tables: DataTables, pos = snapshot.pos!) => projectPosTables(tables, pos, snapshot.pos);
  const unpaid = () => {
    const bills = snapshot.pos!.bills.filter(b => b.status === 'open' || b.status === 'partial');
    const attempt = options.readPosUi?.().approval;
    const pending = attempt?.status === 'pending'||moneyBusy();
    const count = bills.length + (pending && !bills.some(b => b.billId === attempt?.billId) ? 1 : 0);
    return count ? { ...error('UNPAID_BILLS'), details: { count, billIds: bills.map(b => b.billId), received: snapshot.pos!.payments.filter(p => bills.some(b => b.billId === p.billId) && p.status === 'paid').reduce((n, p) => n + p.amount, 0), route: 'orders-payment' } } as DataCommandResult : null;
  };
  const emit = () => {
    notifying = true;
    try { for (const listener of [...listeners]) { try { listener(); } catch { /* A committed publication still reaches every subscriber. */ } } }
    finally { notifying = false; }
  };
  function dispatchLocal(command: DataCommand): DataCommandResult {
    if (busy()) return customBusy()&&command?.type==='closing.closeDay'&&(!options.sessionGate||options.sessionGate.phase==='idle')?error('UNPAID_BILLS'):error('TRANSACTION_BUSY');
    if (!command || typeof command !== 'object' || typeof command.type !== 'string') return { ok: false, code: 'VALIDATION', field: 'type', messageKey: 'data.error.unknownCommand' };
    if(snapshot.pos?.money && (command.type==='memberships.useOnce'||command.type==='memberships.cancelUse'))return membershipDispatch?membershipDispatch(command):{ok:false,code:'CONFLICT',reason:'POS_CONTEXT_REQUIRED',messageKey:'data.money.error.POS_CONTEXT_REQUIRED',details:{route:'orders-payment'}};
    if (command.type === 'customOrder.receive' && customDispatch) return customDispatch(command);
    if (settingsCommand(command)) return error('COORDINATOR_REQUIRED');
    const isClosing = closingCommand(command);
    const isCustom = /^(customTemplate|customOrder|pickup)\./.test(command.type);
    const isNotice = command.type.startsWith('notice.');
    const handler = (handlers as unknown as Readonly<Record<string, ((ctx: HandlerContext, c: DataCommand) => HandlerResult) | undefined>>)[command.type];
    if (!handler && !isClosing && !isCustom) return { ok: false, code: 'VALIDATION', field: 'type', messageKey: 'data.error.unknownCommand' };
    const key = 'idempotencyKey' in command ? command.idempotencyKey : undefined;
    const isNew = (isNotice && ('idempotencyKey' in command || noticeRequiresKey(command as import('../iteration7/notices').NoticeCommand))) || isCustom && ('idempotencyKey' in command || command.type === 'customTemplate.save' && !command.templateId) || NEW_ONCE.has(command.type) || ['staff.create', 'staff.delete', 'staff.deleteSchedule', 'staff.moveHandoff'].includes(command.type) || command.type === 'staff.saveSchedule' && (!command.scheduleId || 'idempotencyKey' in command);
    if ((isNew || ONCE_COMMANDS.has(command.type)) && (typeof key !== 'string' || !key.trim())) return isNew ? error('KEY_REQUIRED', 'idempotencyKey') : { ok: false, code: 'VALIDATION', field: 'idempotencyKey', messageKey: 'data.error.idempotencyKeyRequired' };
    if (isClosing && (command.type === 'closing.closeDay' || command.type === 'closing.undoDay')) {
      if (!isIsoDate(command.date)) return { ok: false, code: 'VALIDATION', field: 'date', messageKey: 'data.error.dateInvalid' };
      if (!['normal', 'empty'].includes(command.scenario)) return { ok: false, code: 'PREVIEW_FAILURE', reason: 'PAYMENTS_UNAVAILABLE', messageKey: 'data.management.error.PAYMENTS_UNAVAILABLE' };
    }
    const scope = isClosing && 'scenario' in command ? `:${command.scenario}` : '';
    const ledgerKey = key && isNew ? `${runId}:${command.type}${scope}:${key}` : undefined;
    const applied = ledgerKey ? (snapshot.tables.commandLedger[ledgerKey] ?? noOpLedger.get(ledgerKey)) : key ? snapshot.tables.appliedKeys[key] : undefined;
    if (applied && ledgerKey && 'fingerprint' in applied) {
      if (applied.fingerprint !== fingerprint(command)) return error('IDEMPOTENCY_MISMATCH');
      if (isClosing && 'scenario' in command && 'date' in command) {
        const current = selectClosing(snapshot, { date: command.date, scenario: command.scenario });
        if (applied.closingId !== current.closingId) return error('STALE_CLOSING');
      }
      if (applied.status === 'undone') return error('COMMAND_UNDONE');
      return { ...(applied.result as Extract<DataCommandResult, { ok: true }>), duplicate: true };
    }
    if (applied) return { ...(applied.result as Extract<DataCommandResult, { ok: true }>), duplicate: true };
    if (command.baseRevision !== undefined && command.baseRevision !== snapshot.revision) return error('STALE_REVISION');
    if (command.type === 'closing.closeDay' || command.type === 'closing.undoDay') return close(command, ledgerKey!);
    if (isCustom && snapshot.tables.dayClosing.some(c=>c.businessDate===snapshot.pos!.businessDate && c.scenario==='normal' && c.status==='closed')) return error('DAY_CLOSED');
    let seq = snapshot.seq;
    const reversiblePickup = isReversiblePickup(command);
    const customRead = isCustom ? selectCustomOrderRead(snapshot) : undefined;
    if (reversiblePickup) {
      const blocked = checkReversiblePickup(customRead!, command.customOrderId);
      if (blocked) return blocked;
    }
    const customPlan = customRead ? planCustomOrderCommand(customRead, command as import('../iteration7/custom-orders').CustomOrderCommand) : undefined;
    if (customPlan && !customPlan.ok) return customPlan;
    const outcome = customPlan
      ? { ...customPlan, undoable: customPlan.undoable || reversiblePickup, tables: customTables(snapshot.tables, customPlan) }
      : handler!({ snapshot, tables: snapshot.tables, nextId: (prefix) => { let id: string; do { id = `${prefix}-${++seq}`; } while (seedIds.has(id)); return id; } }, command);
    if (!outcome.ok) return outcome;
    if (equalData(outcome.tables, snapshot.tables)) { const result:DataCommandResult={ ok: true, revision: snapshot.revision, ...(outcome.noticeKey ? { noticeKey: outcome.noticeKey } : {}), ...(outcome.value !== undefined ? { value: outcome.value } : {}) }; if(ledgerKey) noOpLedger.set(ledgerKey,{fingerprint:fingerprint(command),result,status:'applied'}); return result; }
    const revision = snapshot.revision + 1;
    const undoToken = outcome.undoable ? `data-undo:${runId}:${++tokenSeq}` : undefined;
    const result: DataCommandResult = deepFreeze({ ok: true, revision, ...(undoToken ? { undoToken } : {}), ...(outcome.noticeKey ? { noticeKey: outcome.noticeKey } : {}), ...(outcome.params ? { params: outcome.params } : {}), ...(outcome.value !== undefined ? { value: outcome.value } : {}) });
    const nextPos = customPlan ? applyCustomMoney(snapshot.pos!, customPlan.moneyEffects) : snapshot.pos!;
    let tables = project(outcome.tables,nextPos);
    if (ledgerKey) tables = { ...tables, commandLedger: { ...tables.commandLedger, [ledgerKey]: { fingerprint: fingerprint(command), result, status: 'applied' } } };
    else if (key) tables = { ...tables, appliedKeys: { ...tables.appliedKeys, [key]: { command: command.type, result } } };
    pendingUndo = undoToken ? { token: undoToken, before: snapshot.tables, after: tables, ledgerKey, legacyKey: ledgerKey ? undefined : key,
      ...(command.type === 'ledger.updateExpense' ? { expenseDates: [snapshot.tables.expense.find(row => row.expenseId === command.expenseId)!.businessDate,
        tables.expense.find(row => row.expenseId === command.expenseId)!.businessDate] } : {}),
      ...(reversiblePickup && customPlan ? { pickupRecognitionId: customPlan.value.recognitionId } : {}),
    } : pendingUndo;
    // Async video progress is not a new user edit and must not consume the general undo slot.
    if (!undoToken && !['video.attachJob', 'video.progress', 'video.settle', 'promo.syncCatalog'].includes(command.type)) pendingUndo = null;
    snapshot = deepFreeze({ ...snapshot, revision, seq, tables, pos:nextPos }); emit(); return result;
  }
  let real: RealPort | undefined;
  function dispatch(command: DataCommand): DataCommandResult {
    const route = command && typeof command === 'object' ? real?.route(command) : null;
    if (route === 'async') return { ok: false, code: 'CONFLICT', reason: 'ASYNC_REQUIRED', messageKey: 'data.real.error.ASYNC_REQUIRED' };
    if (route === 'optimistic') {
      const { preview } = real!.begin(command);
      return preview && preview.ok ? { ...preview, pending: true } : preview!;
    }
    return dispatchLocal(command);
  }
  function hydrate(patch: Partial<DataTables>) {
    const keys = Object.keys(patch) as (keyof DataTables)[];
    if (keys.every(key => equalData(patch[key], snapshot.tables[key]))) return;
    pendingUndo = null;
    snapshot = deepFreeze({ ...snapshot, revision: snapshot.revision + 1, tables: project({ ...snapshot.tables, ...patch }) });
    emit();
  }
  function execute(command: DataCommand): Promise<DataCommandResult> {
    return real ? real.execute(command) : Promise.resolve(dispatchLocal(command));
  }
  function close(command: Extract<DataCommand, { type: 'closing.closeDay' | 'closing.undoDay' }>, ledgerKey: string): DataCommandResult {
    if (command.type === 'closing.closeDay') { const blocked = unpaid(); if (blocked) return blocked; }
    const current = selectClosing(snapshot, command);
    if (command.type === 'closing.closeDay' && (!Number.isSafeInteger(command.expectedGeneration) || command.expectedGeneration < 0)) return { ok: false, code: 'VALIDATION', field: 'expectedGeneration', messageKey: 'data.management.error.GENERATION_INVALID' };
    if (command.type === 'closing.closeDay' && command.expectedGeneration !== current.generation || command.type === 'closing.undoDay' && command.closingId !== current.closingId) return error('STALE_CLOSING');
    if (command.type === 'closing.closeDay' && current.status === 'closed' || command.type === 'closing.undoDay' && current.status === 'reopened') {
      const result: DataCommandResult = deepFreeze({ ok: true, revision: snapshot.revision, value: snapshot.tables.dayClosing.find((c) => c.closingId === current.closingId) });
      noOpLedger.set(ledgerKey, { fingerprint: fingerprint(command), result, status: 'applied', closingId: current.closingId ?? undefined });
      return result;
    }
    const closingId = command.type === 'closing.closeDay' ? `${runId}:${command.date}:${command.scenario}:${current.generation + 1}` : command.closingId;
    const closing = command.type === 'closing.closeDay' ? { closingId, businessDate: command.date, scenario: command.scenario, generation: current.generation + 1, status: 'closed' as const, closedAt: businessNow(), salesSnapshot: paymentTotals(snapshot, command), ...(snapshot.pos?.money?{accountingSnapshot:selectAccountingDay({...selectMoneyRead(snapshot),...(command.scenario==='empty'?{state:{...snapshot.pos.money,settlements:[],payments:[],recognitions:[],accountTxns:[],memberships:[],uses:[],corrections:[]}}:{})},{date:command.date})}:{}), drawerSnapshot: selectM2Drawer(snapshot.pos!, command.scenario), posTotalsSnapshot: selectM2DayTotals(snapshot.pos!,command.scenario), paymentRevision: snapshot.revision } : { ...snapshot.tables.dayClosing.find((c) => c.closingId === closingId)!, status: 'reopened' as const, reopenedAt: businessNow() };
    if (!closing.salesSnapshot) return error('STALE_CLOSING');
    const undoToken = command.type === 'closing.closeDay' ? `closing-undo:${runId}:${++tokenSeq}` : undefined;
    if (undoToken) closingTokens.set(undoToken, { date: command.date, scenario: command.scenario, closingId });
    const result: DataCommandResult = deepFreeze({ ok: true, revision: snapshot.revision + 1, value: closing, noticeKey: command.type === 'closing.closeDay' ? 'data.management.notice.closed' : 'data.management.notice.reopened', ...(undoToken ? { undoToken } : {}) });
    snapshot = deepFreeze({ ...snapshot, revision: snapshot.revision + 1, tables: { ...snapshot.tables, dayClosing: command.type === 'closing.closeDay' ? [...snapshot.tables.dayClosing, closing] : snapshot.tables.dayClosing.map((c) => c.closingId === closingId ? closing : c), commandLedger: { ...snapshot.tables.commandLedger, [ledgerKey]: { fingerprint: fingerprint(command), result, status: 'applied', closingId } } } });
    emit(); return result;
  }
  function restoredTables(receipt: PendingUndo): DataTables | undefined {
    const inverse = inverseChange(businessTables(receipt.before), businessTables(receipt.after), businessTables(snapshot.tables));
    if (!inverse.ok) return;
    const commandLedger = { ...snapshot.tables.commandLedger };
    if (receipt.ledgerKey) commandLedger[receipt.ledgerKey] = { ...commandLedger[receipt.ledgerKey], status: 'undone' };
    const appliedKeys = { ...snapshot.tables.appliedKeys };
    if (receipt.legacyKey) delete appliedKeys[receipt.legacyKey];
    return { ...snapshot.tables, ...inverse.value as ReturnType<typeof businessTables>, commandLedger, appliedKeys };
  }
  // D-326 removes solely this receipt's recognition, leaving deposits, payments and account movements in place.
  function undoPickupRecognition(receipt: PendingUndo): PosState | undefined {
    const pos = snapshot.pos!;
    const rows = pos.money?.recognitions ?? pos.customRecognitions ?? [];
    const recognition = rows.find(row => row.recognitionId === receipt.pickupRecognitionId);
    if (!recognition || isExpenseDayClosed(snapshot.tables, recognition.businessDate)
      || rows.some(row => row.originalRecognitionId === recognition.recognitionId)) return;
    const recognitions = rows.filter(row => row !== recognition);
    return pos.money ? synchronizeCustomMoney({ ...pos, revision: pos.revision + 1, money: { ...pos.money, recognitions } })
      : { ...pos, revision: pos.revision + 1, customRecognitions: (pos.customRecognitions ?? []).filter(row => row !== recognition) };
  }
  function undo(token: string): DataCommandResult {
    if (real && token.startsWith(REAL_UNDO_PREFIX)) { void real.undo(token); return { ok: true, revision: snapshot.revision, pending: true }; }
    if (busy()) return error('TRANSACTION_BUSY');
    const closing = closingTokens.get(token);
    if (closing) return dispatchLocal({ type: 'closing.undoDay', ...closing, idempotencyKey: token });
    if (!pendingUndo || pendingUndo.token !== token) return { ok: false, code: 'CONFLICT', reason: 'UNDO_UNAVAILABLE', messageKey: 'data.error.undoUnavailable' };
    if (pendingUndo.expenseDates?.some(date => isExpenseDayClosed(snapshot.tables, date))) return error('UNDO_UNAVAILABLE');
    const nextPos = pendingUndo.pickupRecognitionId ? undoPickupRecognition(pendingUndo) : snapshot.pos!;
    if (!nextPos) return error('UNDO_UNAVAILABLE');
    if (pendingUndo.pickupRecognitionId && undoPickupWithCoordinator) return undoPickupWithCoordinator(token, nextPos);
    const restored = restoredTables(pendingUndo);
    if (!restored) return error('UNDO_UNAVAILABLE');
    let seq = snapshot.seq;
    const staffScheduleChange = appendStaffHistory(snapshot.tables, restored, prefix => `${prefix}-${++seq}`);
    snapshot = deepFreeze({ ...snapshot, seq, revision: snapshot.revision + 1, pos: nextPos, tables: project({ ...restored, staffScheduleChange }, nextPos) });
    pendingUndo = null; emit(); return { ok: true, revision: snapshot.revision, noticeKey: 'data.notice.undone' };
  }
  const session: SessionTransactionPort<DataSessionInput> = {
    prepare(tx, input): PrepareResult {
      if (notifying || pendingFlush || options.sessionGate && (options.sessionGate.phase !== 'preparing' || options.sessionGate.transactionId !== tx.transactionId)) return { ok: false, code: 'CONFLICT', reason: 'TRANSACTION_BUSY', messageKey: 'data.management.error.TRANSACTION_BUSY' };
      if (tx.runId !== runId || tx.expectedDataRevision !== snapshot.revision || !tx.transactionId || !tx.transitionToken || 'baseRevision' in input && input.baseRevision !== undefined && input.baseRevision !== snapshot.revision) return { ok: false, code: 'CONFLICT', reason: 'STALE_REVISION', messageKey: 'data.management.error.STALE_REVISION' };
      if (input.type === 'pos.commit') {
        if (input.expectedPosRevision !== snapshot.pos!.revision) return { ok: false, code: 'CONFLICT', reason: 'STALE_REVISION', messageKey: 'data.management.error.STALE_REVISION' };
        if (input.nextPos.revision !== input.expectedPosRevision + 1 || input.nextPos.businessDate !== snapshot.pos!.businessDate || input.nextPos.seq < snapshot.pos!.seq) return { ok: false, code: 'VALIDATION', reason: 'INVALID_POS_PLAN', messageKey: 'run.session.validation' };
        let tables = snapshot.tables;
        // D-326 pickup and its sales recognition publish together in both stores.
        let pickupUndo: PendingUndo | null | undefined;
        if (input.undoPickupToken) {
          if (pendingUndo?.token !== input.undoPickupToken || !pendingUndo.pickupRecognitionId) {
            return { ok: false, code: 'CONFLICT', reason: 'UNDO_UNAVAILABLE', messageKey: 'data.error.undoUnavailable' };
          }
          const restored = restoredTables(pendingUndo);
          if (!restored) return { ok: false, code: 'CONFLICT', reason: 'UNDO_UNAVAILABLE', messageKey: 'data.error.undoUnavailable' };
          tables = restored;
          pickupUndo = null;
        }
        if (input.dataChanges?.settings) {
          const changed = posSettingsChange(tables, input.dataChanges.settings, snapshot.pos!, options.readPosUi?.().approval?.status === 'pending');
          if (!changed.ok) return { ok: false, code: changed.code === 'VALIDATION' ? 'VALIDATION' : 'CONFLICT', reason: changed.reason ?? changed.code, messageKey: changed.messageKey };
          tables = changed.tables;
        }
        if (input.dataChanges?.custom) {
          if (!input.dataChanges.custom.ok) return {ok:false,code:'CONFLICT',reason:'INVALID_POS_PLAN',messageKey:'run.session.validation'};
          tables = customTables(tables,input.dataChanges.custom);
        }
        if (input.dataChanges?.customLedger) { const entry=input.dataChanges.customLedger; tables={...tables,commandLedger:{...tables.commandLedger,[entry.key]:{fingerprint:entry.fingerprint,result:entry.result,status:'applied'}}}; }
        if (input.dataChanges?.reservation) {
          const changed = applyPosReservationWrite(tables, input.dataChanges.reservation);
          if (!changed.ok) return { ok: false, code: changed.code === 'VALIDATION' ? 'VALIDATION' : 'CONFLICT', reason: changed.reason ?? changed.code, messageKey: changed.messageKey };
          tables = changed.tables;
        }
        const ticket = `data-ticket:${runId}:${++tokenSeq}`;
        const after = deepFreeze({ ...snapshot, pos: input.nextPos, transactionId: tx.transactionId, revision: snapshot.revision + 1, tables: project(tables, input.nextPos) });
        if (input.dataChanges?.pickupUndo) {
          const { token, recognitionId } = input.dataChanges.pickupUndo;
          pickupUndo = { token, pickupRecognitionId: recognitionId, before: snapshot.tables, after: after.tables, ledgerKey: input.dataChanges.customLedger?.key };
        }
        prepared.set(ticket, { tx: { ...tx }, before: snapshot, after, pickupUndo });
        return { ok: true, change: Object.freeze({ store: 'data', transactionId: tx.transactionId, ticket }) };
      }
      if (!settingsCommand(input)) return { ok: false, code: 'VALIDATION', reason: 'SETTINGS_REQUIRED', messageKey: 'data.management.error.SETTINGS_REQUIRED' };
      if (input.paymentStyle !== snapshot.tables.shopSettings.paymentStyle || input.businessType !== snapshot.tables.shopSettings.businessType) {
        const blocked = unpaid(); if (blocked && !blocked.ok) return { ...blocked, code: 'CONFLICT', reason: 'UNPAID_BILLS' };
      }
      const outcome = posSettingsChange(snapshot.tables, { ...snapshot.tables.shopSettings, businessType: input.businessType, paymentStyle: input.paymentStyle,
        tableLayout: input.tableLayout === undefined ? snapshot.tables.shopSettings.tableLayout : input.tableLayout,
        posPreferences: input.posPreferences ?? snapshot.tables.shopSettings.posPreferences, cctvPosLinks: input.cctvPosLinks ?? snapshot.tables.shopSettings.cctvPosLinks, revision: snapshot.tables.shopSettings.revision + 1 }, snapshot.pos!, options.readPosUi?.().approval?.status === 'pending');
      if (!outcome.ok) return { ok: false, code: outcome.code === 'VALIDATION' ? 'VALIDATION' : 'CONFLICT', reason: outcome.reason ?? outcome.code, messageKey: outcome.messageKey };
      const settingsTables = input.commandRecord ? {...outcome.tables,commandLedger:{...outcome.tables.commandLedger,[input.commandRecord.key]:{fingerprint:input.commandRecord.fingerprint,result:input.commandRecord.result,status:'applied' as const}}} : outcome.tables;
      const ticket = `data-ticket:${runId}:${++tokenSeq}`;
      prepared.set(ticket, { tx: { ...tx }, before: snapshot, after: deepFreeze({ ...snapshot, transactionId: tx.transactionId, revision: snapshot.revision + (equalData(settingsTables, snapshot.tables) ? 0 : 1), tables: project(settingsTables) }) });
      return { ok: true, change: Object.freeze({ store: 'data', transactionId: tx.transactionId, ticket }) };
    },
    isCurrent(change: PreparedChange) {
      const value = prepared.get(change.ticket);
      return !!value && change.store === 'data' && change.transactionId === value.tx.transactionId && value.before === snapshot && value.tx.runId === runId && (!options.sessionGate || options.sessionGate.phase === 'preparing' && options.sessionGate.transactionId === change.transactionId);
    },
    publish(change) {
      const value = prepared.get(change.ticket);
      if (!value || change.store !== 'data' || change.transactionId !== value.tx.transactionId || value.before !== snapshot) return;
      if (value.pickupUndo !== undefined) pendingUndo = value.pickupUndo;
      snapshot = value.after; pendingFlush = change.transactionId; prepared.delete(change.ticket);
    },
    flush(transactionId) { if (pendingFlush !== transactionId) return; pendingFlush = null; emit(); },
    abort(change) { prepared.delete(change.ticket); },
  };
  return { getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, dispatch, dispatchLocal, execute, hydrate, undo, session,
    get real() { return real; }, bindReal(port) { real = port; }, bindCustomDispatch(dispatch,busy,undoPickup) { customDispatch=dispatch;customBusy=busy;undoPickupWithCoordinator=undoPickup; },
    bindMoneyBusy(read){moneyBusy=read;},
    bindMembershipDispatch(dispatch){membershipDispatch=dispatch;},
    replay(command) { const key=command.idempotencyKey ? `${runId}:${command.type}:${command.idempotencyKey}` : ''; const record=snapshot.tables.commandLedger[key] ?? noOpLedger.get(key); if(!record)return; if(record.fingerprint!==fingerprint(command))return error('IDEMPOTENCY_MISMATCH'); if(record.status==='undone')return error('COMMAND_UNDONE'); return {...record.result as Extract<DataCommandResult,{ok:true}>,duplicate:true}; },
    remember(command,result) { if(command.idempotencyKey)noOpLedger.set(`${runId}:${command.type}:${command.idempotencyKey}`,{fingerprint:fingerprint(command),result,status:'applied'}); } };
}
