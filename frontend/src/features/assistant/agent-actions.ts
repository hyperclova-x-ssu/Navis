import type { FeatureId, NoticeRequest, RunState, RunStore } from '../../contracts';
import { accountHostFor } from '../../app/account-host';
import type { DataCommand, DataCommandResult } from '../../data/commands/types';
import { REAL_DOMAINS, REAL_UNDO_PREFIX, WIDGET_DOMAIN, type CommandReceipt } from '../../data/reality/00/port';
import { isDataWidgetId } from '../../data/conditions';
import type { DataSnapshot } from '../../data/db/types';
import type { WidgetDataStore } from '../../data/widget-data';
import { agentCommandPolicy, agentCommandRefs, validateAgentFrame, type AgentFrameData, type AgentKnownCommand, type AgentRecordKind } from '../../../shared/navis-agent-schema.mjs';
import { realCommandFor } from '../../../shared/navis-real-commands.mjs';
import { selectCommonNotice, type ChatReceiptIdentity } from '../../state';
import { menuCommandAdapter, type MenuCreationPreview, type MenuDraft } from './domains/menu';
import type { CommandAdapter, CommandContext, ConfirmationTier, DomainRegistry, LocalSlots, RecordTargets, RunActionOutcome, RunCommandAdapter, ScheduledNoticeReceipt } from './domains/registry';
import { assistantDomains } from './snapshot';

export { isMenuPrice } from './domains/menu';
export type { MenuCreationPreview, MenuDraft } from './domains/menu';
export type MenuDraftField = keyof MenuDraft;

type ActionProposalFrame = AgentFrameData['action_proposal'];
type ActionResultFrame = AgentFrameData['action_result'];
type Outcome = ActionResultFrame['outcome'];

export interface AgentActionReceipt {
  readonly frame: ActionResultFrame;
  readonly field?: string;
  readonly notice?: NoticeRequest;
  readonly requiresExtraConfirmation?: true;
  readonly retryable?: true;
  readonly uncertain?: true;
  /** F17: the command is bound to the real data port and its authoritative result has not arrived. `frame` is a placeholder and is never reported. */
  readonly pending?: true;
  /** F17: an unknown outcome of a real command. The owner can re-check; the same card key is resent, so no second record can be created. */
  readonly recheckable?: true;
  readonly undoToken?: string;
  readonly scheduledNotice?: ScheduledNoticeReceipt;
  /** The record a create command reported in its applied result. Local only: it never goes back on the wire. */
  readonly createdRecord?: CreatedRecord;
}

export interface CreatedRecord { readonly kind: AgentRecordKind; readonly id: string }

type ActionCommand = DataCommand['type'] | AgentKnownCommand;

export interface ProposalEdit<Command extends ActionCommand, Draft, Preview> {
  readonly draft: Draft;
  preview(draft: Draft): LocalAgentProposal<Command, Draft, Preview> | null;
  cancel(): void;
}
export type MenuProposalEdit = ProposalEdit<'menu.create', MenuDraft, MenuCreationPreview>;

export interface LocalAgentProposal<Command extends ActionCommand = ActionCommand, Draft = unknown, Preview = unknown> {
  readonly id: string;
  /** The `proposalId` of the wire frame this card came from, when that frame carried one. */
  readonly wireProposalId?: string;
  readonly command: Command;
  readonly tier: ConfirmationTier;
  readonly preview: Preview;
  readonly snapshotRevision: number;
  isCurrent(): boolean;
  getReceipt(): AgentActionReceipt | undefined;
  /**
   * Fixture commands answer synchronously. A command bound to the real port returns a `pending` receipt now and settles later:
   * `onSettled` (or `settled()`) receives the authoritative receipt. Pressing again while pending returns the same pending receipt.
   */
  confirm(currentStore: WidgetDataStore, acknowledgedProposalId?: string, onSettled?: (receipt: AgentActionReceipt) => void): AgentActionReceipt;
  /** The authoritative receipt once the real execution has settled (immediately for a fixture or consumed card). */
  settled(): Promise<AgentActionReceipt>;
  /** After an unknown outcome: ask again with the same card key. Anything else returns the current receipt unchanged. */
  recheck(currentStore: WidgetDataStore, onSettled?: (receipt: AgentActionReceipt) => void): AgentActionReceipt;
  cancel(): AgentActionReceipt;
  edit(): ProposalEdit<Command, Draft, Preview> | null;
  refresh(): LocalAgentProposal<Command, Draft, Preview> | null;
}

/** Existing menu card contract, implemented by the same executor as generic proposals. */
export type AgentActionProposal = LocalAgentProposal<'menu.create', MenuDraft, MenuCreationPreview>;

type Prepared<Proposal> = { readonly kind: 'proposal'; readonly proposal: Proposal }
  | { readonly kind: 'invalid' | 'unchanged' | 'busy' | 'conflict'; readonly field?: string; readonly messageKey?: string };

type Rejected = Exclude<Prepared<never>, { kind: 'proposal' }>;
type ExecutionRejection = Rejected & { readonly revision?: number };
type Applied = { readonly kind: 'applied'; readonly revision?: number; readonly notice?: NoticeRequest; readonly undoToken?: string; readonly scheduledNotice?: ScheduledNoticeReceipt; readonly createdRecord?: CreatedRecord };
type Executable<Preview> = Rejected | {
  readonly kind: 'ready';
  readonly preview: Preview;
  readonly tier?: ConfirmationTier;
  readonly commandFingerprint?: string;
  readonly revalidateRecord?: boolean;
  readonly execute: () => ExecutionRejection | Applied;
  /** Present for data commands: true when the real port owns this command (it then runs through `executeAsync`, never `execute`). */
  readonly routed?: () => boolean;
  readonly executeAsync?: () => Promise<ExecutionRejection | Applied | { readonly kind: 'unknown' }>;
};

type AccountFlush = () => Promise<'saved' | 'unchanged' | 'conflict' | 'error'>;
type AccountHostLookup = (run: RunStore) => { flush: AccountFlush } | undefined;
const durablePreferences = new Set(['settings.set_theme', 'settings.set_text_scale', 'settings.set_locale']);
const isDurableAccountCard = (command: string) => command.startsWith('layout.') || durablePreferences.has(command);
const pendingAccountWrites = new WeakSet<RunStore>();

const runUndo = new WeakMap<RunStore, {
  token: string; runId: string; store: WidgetDataStore; reverse: (run: RunStore) => boolean; reversing: boolean;
  flush?: AccountFlush;
}>();
/** Commands whose real result names the record they created. The identifier is read from that exact successful value only. */
const createdRecordFields: Readonly<Record<string, readonly [AgentRecordKind, string]>> = {
  'menu.create': ['menu', 'menuId'],
  'calendar.addEvent': ['event', 'eventId'],
  'calendar.addTodo': ['event', 'eventId'],
  'staff.create': ['staff', 'staffId'],
  'suppliers.createSupplier': ['supplier', 'supplierId'],
  'members.create': ['member', 'memberId'],
};

function createdRecordOf(command: string, value: unknown): CreatedRecord | undefined {
  const field = createdRecordFields[command];
  if (!field || !value || typeof value !== 'object') return undefined;
  const fields = value as Record<string, unknown>;
  // A real receipt (`CommandReceipt`) names the created resource by `resourceId`; a fixture value carries the typed id field.
  const id = typeof fields.receiptId === 'string' ? fields.resourceId : fields[field[1]];
  return typeof id === 'string' && id ? Object.freeze({ kind: field[0], id }) : undefined;
}

/** The visible board a run card was prepared for. Leaving that layer or page retires the card. */
function runScope(state: RunState) {
  return { layer: state.layer, board: state.activeBoard, page: state.boards[state.activeBoard].currentPage };
}

const undoneChatReceipts = new WeakSet<ChatReceiptIdentity>();
const failedChatReceiptUndos = new WeakSet<ChatReceiptIdentity>();
/** F17: undo of a real receipt is a server round trip. One in flight per visible receipt; both the receipt row and the toast route here. */
const realReceiptUndos = new WeakMap<ChatReceiptIdentity, Promise<void>>();
const receiptUndoListeners = new Set<() => void>();
let receiptUndoVersion = 0;
const bumpReceiptUndo = () => { receiptUndoVersion += 1; for (const listener of [...receiptUndoListeners]) listener(); };
/** For `useSyncExternalStore`: re-render the receipt when a real undo starts or settles. */
export function subscribeAgentReceiptUndo(listener: () => void): () => void {
  receiptUndoListeners.add(listener);
  return () => { receiptUndoListeners.delete(listener); };
}
export const agentReceiptUndoVersion = () => receiptUndoVersion;
/** Resolves when the real undo of this receipt has settled (immediately when none is running). */
export function agentReceiptUndoSettled(identity: ChatReceiptIdentity): Promise<void> {
  return realReceiptUndos.get(identity) ?? Promise.resolve();
}

export function agentReceiptUndoFailed(identity: ChatReceiptIdentity): boolean {
  return failedChatReceiptUndos.has(identity);
}

export function agentReceiptStatus(run: RunStore | undefined, receipt: AgentActionReceipt, identity: ChatReceiptIdentity) {
  if (undoneChatReceipts.has(identity)) return 'undone';
  if (realReceiptUndos.has(identity)) return 'undoing';
  const notice = run && selectCommonNotice(run.getState());
  if (!run || !receipt.undoToken || notice?.chatReceipt === identity && notice.undo?.token === receipt.undoToken && notice.remainingMs > 0) {
    return 'applied';
  }
  return 'expired';
}

/** Both receipt surfaces use the current shared receipt to authorize the reversal. */
export function applyAgentReceiptUndo(run: RunStore, store: WidgetDataStore, identity: ChatReceiptIdentity, token: string): boolean {
  // A second press while the real undo is on its way is the same press.
  if (realReceiptUndos.has(identity)) return true;
  run.actions.tick();
  const state = run.getState(), notice = selectCommonNotice(state);
  if (state.runId !== store.getSnapshot().runId || notice?.chatReceipt !== identity
    || notice.undo?.token !== token || notice.remainingMs <= 0 || undoneChatReceipts.has(identity)) return false;
  const port = store.real;
  if (notice.undo.target === 'data' && port && token.startsWith(REAL_UNDO_PREFIX)) {
    return startReceiptUndo(run, store, identity, () => port.undo(token));
  }
  const account = notice.undo.target === 'run' ? runUndo.get(run) : undefined;
  const flush = account?.flush;
  if (flush && account.token === token) {
    if (pendingAccountWrites.has(run)) return false;
    pendingAccountWrites.add(run);
    return startReceiptUndo(run, store, identity, async () => {
      try {
        if (!applyAgentRunUndo(run, store, token)) return undoFailure();
        const status = await flush();
        return status === 'saved' || status === 'unchanged' ? { ok: true, revision: store.getSnapshot().revision }
          : undoFailure(status === 'conflict' ? 'data.real.error.STALE_REVISION' : 'data.real.error.SERVICE_UNAVAILABLE');
      } finally {
        pendingAccountWrites.delete(run);
      }
    });
  }
  const data = notice.undo.target === 'data' ? store.undo(token) : undefined;
  const ok = notice.undo.target === 'run' ? applyAgentRunUndo(run, store, token) : data?.ok === true;
  if (ok) {
    undoneChatReceipts.add(identity);
    failedChatReceiptUndos.delete(identity);
  } else {
    failedChatReceiptUndos.add(identity);
    if (data && !data.ok && data.reason === 'TRANSACTION_BUSY') return false;
  }
  if (selectCommonNotice(run.getState())?.chatReceipt === identity) {
    run.actions.showNotice({ kind: ok ? 'complete' : 'error', messageKey: ok ? 'data.notice.undone' : 'UNDO_UNAVAILABLE' });
  }
  return ok;
}

/** Undo of a real receipt: pending until the server answers, then undone or refused with its reason (the receipt stays as it was). */
const undoFailure = (messageKey = 'UNDO_UNAVAILABLE'): DataCommandResult =>
  ({ ok: false, code: 'CONFLICT', reason: 'UNDO_UNAVAILABLE', messageKey });

function startReceiptUndo(run: RunStore, store: WidgetDataStore, identity: ChatReceiptIdentity, execute: () => Promise<DataCommandResult>): boolean {
  failedChatReceiptUndos.delete(identity);
  const runId = store.getSnapshot().runId;
  const finish = (result: DataCommandResult) => {
    realReceiptUndos.delete(identity);
    if (result.ok) {
      undoneChatReceipts.add(identity);
      failedChatReceiptUndos.delete(identity);
    } else failedChatReceiptUndos.add(identity);
    bumpReceiptUndo();
    const visible = selectCommonNotice(run.getState());
    // Tell the owner unless another message already took the toast, or the run was replaced.
    if (run.getState().runId === runId && (!visible || visible.chatReceipt === identity)) {
      run.actions.showNotice(result.ok ? { kind: 'complete', messageKey: result.noticeKey ?? 'data.notice.undone' }
        : { kind: 'error', messageKey: result.messageKey });
    }
  };
  const settled = Promise.resolve().then(execute).then(finish, () => finish(undoFailure()));
  realReceiptUndos.set(identity, settled);
  bumpReceiptUndo();
  return true;
}

/** The rendered receipt routes its token here. A retired, expired or foreign receipt has no authority. */
export function applyAgentRunUndo(run: RunStore, store: WidgetDataStore, token: string): boolean {
  const entry = runUndo.get(run);
  if (!entry || entry.reversing || entry.store !== store || entry.token !== token) return false;
  entry.reversing = true;
  try {
    run.actions.tick();
    const state = run.getState(), notice = selectCommonNotice(state);
    if (runUndo.get(run) !== entry || entry.runId !== store.getSnapshot().runId || entry.runId !== state.runId
      || notice?.undo?.target !== 'run' || notice.undo.token !== token || notice.remainingMs <= 0) return false;
    if (!entry.reverse(run)) return false;
    if (runUndo.get(run) === entry) runUndo.delete(run);
    return true;
  } finally {
    entry.reversing = false;
  }
}

/** A real command whose request may or may not have landed: the port marks the failure `outcomeUnknown` (BAD_RESPONSE is an unreadable reply after sending). */
export function isUnknownOutcome(result: Extract<DataCommandResult, { readonly ok: false }>): boolean {
  return result.outcomeUnknown === true || result.reason === 'OUTCOME_UNKNOWN' || result.reason === 'BAD_RESPONSE';
}
const isNoOpReceipt = (value: unknown): boolean => !!value && typeof value === 'object' && 'receiptId' in value && (value as { readonly changed?: unknown }).changed === false;
const noBinding = () => ({ kind: 'invalid' as const, messageKey: 'data.real.error.SOURCE_UNAVAILABLE' });

/** What a card needs to turn a command result into its receipt: the command, its feature and which token reverses it. */
interface OutcomeSpec {
  readonly command: string;
  readonly featureId?: FeatureId;
  undoToken(result: Extract<DataCommandResult, { readonly ok: true }>): string | undefined;
}

/** `real`: the result came from the data port, where a stale revision is the conflict and an unknown outcome is not a failure. */
function settledOutcome(applied: DataCommandResult, real: boolean, spec: OutcomeSpec): ExecutionRejection | Applied | { readonly kind: 'unknown' } {
  if (!applied.ok) {
    if (real && isUnknownOutcome(applied)) return { kind: 'unknown' };
    if (applied.reason === 'TRANSACTION_BUSY') return { kind: 'busy' };
    if (real ? applied.reason === 'STALE_REVISION' || applied.reason === 'BRIEFING_DAY_CHANGED' || applied.code === 'NOT_FOUND' : applied.code === 'CONFLICT' || applied.code === 'NOT_FOUND') return { kind: 'conflict' };
    return { kind: 'invalid', messageKey: applied.messageKey, field: applied.field };
  }
  if (applied.duplicate || real && isNoOpReceipt(applied.value)) return { kind: 'unchanged', revision: applied.revision, messageKey: applied.noticeKey };
  const token = spec.undoToken(applied);
  const deadline = real && token ? Date.parse((applied.value as CommandReceipt | undefined)?.undoUntil ?? '') : NaN;
  // A real receipt with an undo window always leaves a visible receipt, even when the binding named no success message.
  const noticeKey = applied.noticeKey ?? (real && token ? 'common.navis.agent.changeApplied' : undefined);
  const notice: NoticeRequest | undefined = noticeKey ? {
    kind: 'success', ...(spec.featureId ? { featureId: spec.featureId } : {}), messageKey: noticeKey,
    ...(applied.params ? { params: applied.params } : {}),
    ...(token ? { undo: { target: 'data', token } } : {}),
    ...(Number.isFinite(deadline) ? { undoUntil: deadline } : {}),
  } : undefined;
  const createdRecord = createdRecordOf(spec.command, applied.value);
  return { kind: 'applied', revision: applied.revision, notice, undoToken: token, ...(createdRecord ? { createdRecord } : {}) };
}

export function createAgentActions(store: WidgetDataStore, domains: DomainRegistry = assistantDomains, run?: RunStore,
  findAccountHost: AccountHostLookup = accountHostFor) {
  let pendingId: string | undefined;

  function makeProposal<Command extends ActionCommand, Draft, Preview>(
    command: Command, draft: Draft, snapshot: DataSnapshot, isCurrent: () => boolean, minimumTier: ConfirmationTier,
    prepare: (draft: Draft, context: CommandContext, refreshing: boolean) => Executable<Preview>, refreshing = false,
    wireProposalId?: string,
  ): Prepared<LocalAgentProposal<Command, Draft, Preview>> {
    if (!isCurrent() || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
    const id = crypto.randomUUID();
    const context = { snapshot, proposalId: id, idempotencyKey: `navis:${snapshot.runId}:${id}` };
    const result = prepare(draft, context, refreshing);
    if (result.kind !== 'ready') return result;
    const { preview } = result;
    const fingerprint = JSON.stringify(preview);
    const tier = minimumTier === 'extra-confirm' || result.tier === 'extra-confirm' ? 'extra-confirm' : 'normal';
    pendingId = id;
    const isPendingProposal = () => pendingId === id && isCurrent() && store.getSnapshot().runId === snapshot.runId;
    let receipt: AgentActionReceipt | undefined;
    let locked = false;
    let replaced = false;
    let acknowledged = false;
    /** F17: the real-port execution of this card, while it is in flight, and the executable an unknown outcome can be re-checked with. */
    let inFlight: Promise<AgentActionReceipt> | undefined;
    let retry: Extract<Executable<Preview>, { kind: 'ready' }> | undefined;
    const report = (outcome: Outcome, details?: Omit<ActionResultFrame, 'proposalId' | 'outcome'>): AgentActionReceipt =>
      ({ frame: { proposalId: id, outcome, ...details } });
    const consume = (outcome: Outcome, details?: Omit<ActionResultFrame, 'proposalId' | 'outcome'>) =>
      (receipt = report(outcome, details));
    const busy = (): AgentActionReceipt => ({ ...report('busy'), retryable: true });
    const conflict = () => consume('conflict');
    /** A change made after the preview can already satisfy it. That is a same-value answer with no revision, not a card to press again. */
    const stale = () => {
      try {
        const latest = prepare(draft, { ...context, snapshot: store.getSnapshot() }, true);
        if (latest.kind === 'unchanged') return consume('unchanged');
      } catch {
        // An unreadable current state is a stale card.
      }
      return conflict();
    };
    const pendingReceipt = (): AgentActionReceipt => ({ frame: { proposalId: id, outcome: 'busy' }, pending: true });
    /** The final receipt of a real execution. `keep: false` leaves the card pressable (nothing was decided). */
    const settleReal = (applied: Awaited<ReturnType<NonNullable<Extract<Executable<Preview>, { kind: 'ready' }>['executeAsync']>>>): { final: AgentActionReceipt; keep: boolean } => {
      if (applied.kind === 'unknown') return { final: { ...report('invalid'), uncertain: true, recheckable: true }, keep: true };
      if (applied.kind === 'busy') return { final: busy(), keep: false };
      if (applied.kind === 'conflict') return { final: applied.messageKey ? report('conflict', { messageKey: applied.messageKey }) : stale(), keep: true };
      if (applied.kind !== 'applied') {
        return { keep: true, final: {
          ...report(applied.kind, {
            ...(applied.messageKey ? { messageKey: applied.messageKey } : {}),
            ...(applied.revision !== undefined ? { revision: applied.revision } : {}),
          }),
          ...(applied.field ? { field: applied.field } : {}),
        } };
      }
      return { keep: true, final: {
        ...report('applied', {
          ...(applied.revision !== undefined ? { revision: applied.revision } : {}),
          ...(applied.notice ? { messageKey: applied.notice.messageKey } : {}),
        }),
        ...(applied.notice ? { notice: applied.notice } : {}),
        ...(applied.undoToken ? { undoToken: applied.undoToken } : {}),
        ...(applied.scheduledNotice ? { scheduledNotice: applied.scheduledNotice } : {}),
        ...(applied.createdRecord ? { createdRecord: applied.createdRecord } : {}),
      } };
    };
    const begin = (executable: Extract<Executable<Preview>, { kind: 'ready' }>, onSettled?: (receipt: AgentActionReceipt) => void): AgentActionReceipt => {
      const waiting = pendingReceipt();
      receipt = waiting;
      locked = true;
      retry = executable;
      // Whatever goes wrong while deciding the result, the card ends unconfirmed-and-recheckable, never locked and never silent.
      const decided = (outcome: Awaited<ReturnType<NonNullable<typeof executable.executeAsync>>>) => {
        try { return settleReal(outcome); } catch { return settleReal({ kind: 'unknown' }); }
      };
      inFlight = executable.executeAsync!().then(decided, () => decided({ kind: 'unknown' })).then(({ final, keep }) => {
        receipt = keep ? final : undefined;
        locked = false;
        inFlight = undefined;
        try { onSettled?.(final); } catch (error) { setTimeout(() => { throw error; }); }
        return final;
      });
      return waiting;
    };
    const reprepare = (next: Draft) => {
      const updated = makeProposal(command, next, store.getSnapshot(), isCurrent, minimumTier, prepare, true, wireProposalId);
      return updated.kind === 'proposal' ? updated.proposal : null;
    };

    return { kind: 'proposal', proposal: {
      id, command, tier, snapshotRevision: snapshot.revision, preview, ...(wireProposalId ? { wireProposalId } : {}),
      isCurrent: isPendingProposal,
      getReceipt: () => receipt,
      settled: () => inFlight ?? Promise.resolve(receipt ?? report('conflict')),
      recheck(currentStore, onSettled) {
        if (currentStore !== store) return report('conflict');
        if (receipt?.pending) return receipt;
        if (!receipt?.uncertain || !receipt.recheckable || !retry) return receipt ?? report('conflict');
        return begin(retry, onSettled);
      },
      confirm(currentStore, acknowledgedProposalId, onSettled) {
        if (currentStore !== store) return report('conflict');
        if (receipt) return receipt;
        if (locked) return busy();
        if (!isPendingProposal()) return conflict();
        const currentSnapshot = store.getSnapshot();
        if (!result.revalidateRecord && currentSnapshot.revision !== snapshot.revision) return stale();
        if (tier === 'extra-confirm' && (!acknowledged || acknowledgedProposalId !== id)) {
          acknowledged = true;
          return { ...report('invalid'), requiresExtraConfirmation: true };
        }
        locked = true;
        let handedOff = false;
        try {
          const latest = prepare(draft, result.revalidateRecord ? { ...context, snapshot: currentSnapshot } : context, true);
          if (latest.kind === 'busy') return busy();
          if (latest.kind !== 'ready' || JSON.stringify(latest.preview) !== fingerprint
            || latest.commandFingerprint !== result.commandFingerprint || latest.tier !== result.tier
            || store.getSnapshot() !== (result.revalidateRecord ? currentSnapshot : snapshot) || !isPendingProposal()) return conflict();
          if (result.executeAsync && result.routed?.()) {
            // The real port owns this command: wait for the authoritative receipt (the card stays locked, pending).
            handedOff = true;
            return begin(result, onSettled);
          }
          const applied = result.execute();
          if (applied.kind !== 'applied') {
            if (applied.kind === 'busy') return busy();
            if (applied.kind === 'conflict') return conflict();
            return (receipt = {
              ...report(applied.kind, {
                ...(applied.messageKey ? { messageKey: applied.messageKey } : {}),
                ...(applied.revision !== undefined ? { revision: applied.revision } : {}),
              }),
              ...(applied.field ? { field: applied.field } : {}),
            });
          }
          const final = consume('applied', {
            ...(applied.revision !== undefined ? { revision: applied.revision } : {}),
            ...(applied.notice ? { messageKey: applied.notice.messageKey } : {}),
          });
          return {
            ...final,
            ...(applied.notice ? { notice: applied.notice } : {}),
            ...(applied.undoToken ? { undoToken: applied.undoToken } : {}),
            ...(applied.scheduledNotice ? { scheduledNotice: applied.scheduledNotice } : {}),
            ...(applied.createdRecord ? { createdRecord: applied.createdRecord } : {}),
          };
        } catch {
          return (receipt = { ...report('invalid'), uncertain: true });
        } finally {
          if (!handedOff) locked = false;
        }
      },
      cancel() {
        if (receipt) return receipt;
        return locked ? busy() : consume('cancelled');
      },
      edit() {
        if (locked || replaced || !isPendingProposal() || receipt && (receipt.frame.outcome !== 'invalid' || receipt.uncertain)) return null;
        consume('cancelled');
        replaced = true;
        let closed = false;
        return {
          draft,
          preview(next) {
            if (closed || !isPendingProposal()) return null;
            const updated = reprepare(next);
            if (updated) closed = true;
            return updated;
          },
          cancel() { closed = true; },
        };
      },
      refresh() {
        if (replaced || receipt?.frame.outcome !== 'conflict' || !isPendingProposal()) return null;
        const next = reprepare(draft);
        if (next) replaced = true;
        return next;
      },
    } };
  }

  function validateDraft<Draft>(
    frame: ActionProposalFrame, adapter: Pick<RunCommandAdapter<Draft>, 'slots' | 'resolve'>, slots: LocalSlots,
    snapshot: DataSnapshot, targets: RecordTargets, authorizeDraft: (draft: Draft) => boolean = () => true,
  ): Rejected | { kind: 'ready'; draft: Draft; tier: ConfirmationTier } {
    if (!validateAgentFrame('action_proposal', frame)) return { kind: 'invalid' } as const;
    if (frame.snapshotRevision !== snapshot.revision || (frame.runId !== undefined && frame.runId !== snapshot.runId)
      || store.getSnapshot() !== snapshot) return { kind: 'conflict' } as const;
    const policy = agentCommandPolicy(frame.command, frame.args);
    if (policy?.policy !== 'propose') return { kind: 'invalid' } as const;
    const invalidRef = agentCommandRefs(frame.command, frame.args).some(ref => {
      if ('slot' in ref) return !Object.hasOwn(slots, ref.slot) || !(adapter.slots[ref.slot]?.(slots[ref.slot]) ?? false);
      const target = targets.get(ref.handle);
      return !target || !ref.kinds?.some(kind => kind === '*' || kind === target.kind);
    });
    if (invalidRef) return { kind: 'invalid' } as const;
    const draft = adapter.resolve(frame.args, slots, snapshot, targets);
    if (draft === undefined || !authorizeDraft(draft)) return { kind: 'invalid' } as const;
    const tier = 'tier' in frame && frame.tier === 'extra-confirm' ? 'extra-confirm' : policy.confirmation;
    return { kind: 'ready', draft, tier } as const;
  }

  function prepare<Command extends DataCommand, Draft, Preview>(
    frame: ActionProposalFrame, adapter: CommandAdapter<Command, Draft, Preview>, slots: LocalSlots,
    snapshot: DataSnapshot, isCurrent: () => boolean, targets: RecordTargets, authorizeDraft?: (draft: Draft) => boolean,
  ) {
    if (frame.command !== adapter.command) return { kind: 'invalid' } as const;
    const checked = validateDraft(frame, adapter, slots, snapshot, targets, authorizeDraft);
    if (checked.kind !== 'ready') return checked;
    const wireProposalId = 'proposalId' in frame && typeof frame.proposalId === 'string' ? frame.proposalId : undefined;
    return makeProposal(adapter.command, checked.draft, snapshot, isCurrent, checked.tier, (draft, context): Executable<Preview> => {
      const active = domains.command(adapter.command) as CommandAdapter<Command, Draft, Preview> | undefined;
      const result = (active ?? adapter).preflight(draft, context);
      if (result.kind !== 'ready') return result;
      const { command } = result;
      if (command.type !== adapter.command || agentCommandPolicy(command.type, command)?.policy !== 'propose') return { kind: 'invalid' };
      const dispatchCommand: DataCommand = { ...structuredClone(command), baseRevision: context.snapshot.revision };
      Object.freeze(dispatchCommand);
      const routed = () => store.real?.route(dispatchCommand) != null;
      const operating = isDataWidgetId(adapter.featureId) && store.real?.mode(WIDGET_DOMAIN[adapter.featureId]) === 'http';
      if (operating && !routed()) return noBinding();
      const outcome = (applied: DataCommandResult, real: boolean) => settledOutcome(applied, real, adapter);
      return { ...result, commandFingerprint: JSON.stringify(dispatchCommand),
        execute: () => operating ? noBinding() : outcome(store.dispatch(dispatchCommand), false) as ExecutionRejection | Applied,
        routed,
        executeAsync: async () => outcome(await store.execute(dispatchCommand), true),
      };
    }, false, wireProposalId);
  }

  function prepareRun(frame: ActionProposalFrame, adapter: RunCommandAdapter, slots: LocalSlots, snapshot: DataSnapshot,
    isCurrent: () => boolean, targets: RecordTargets, capturedRun: RunState | undefined) {
    if (!run || !capturedRun || capturedRun.runId !== snapshot.runId) return { kind: 'invalid' } as const;
    const scope = runScope(capturedRun);
    const currentRun = () => {
      const state = run.getState(), now = runScope(state);
      return state.runId === capturedRun.runId && now.layer === scope.layer && now.board === scope.board && now.page === scope.page && isCurrent();
    };
    const checked = validateDraft(frame, adapter, slots, snapshot, targets);
    if (checked.kind !== 'ready') return checked;
    const metadata = realCommandFor(adapter.command, frame.args);
    const mappedDomain = REAL_DOMAINS.find(domain => domain === metadata?.domain);
    const policyFeature = agentCommandPolicy(frame.command, frame.args).featureId;
    return makeProposal(adapter.command, checked.draft, snapshot, currentRun, checked.tier, (draft, context, refreshing): Executable<unknown> => {
      const account = isDurableAccountCard(adapter.command) ? findAccountHost(run) : undefined;
      if (account && pendingAccountWrites.has(run)) return { kind: 'busy' };
      const result = adapter.preflight(draft, { ...context, run: refreshing ? run.getState() : capturedRun, deferLayoutNotice: !!account });
      if (result.kind !== 'ready') return result;
      // HTTP builds: a card whose adapter names the widget's own data command waits for the service's receipt, like any data-command card.
      const realCommand = result.realCommand && Object.freeze(structuredClone(result.realCommand));
      const realAction = result.realAction;
      const feature = result.featureId ?? policyFeature;
      const featureDomain = feature && isDataWidgetId(feature) ? WIDGET_DOMAIN[feature] : undefined;
      const operating = [mappedDomain, featureDomain].some(domain => domain && store.real?.mode(domain) === 'http');
      if (realCommand && (!metadata || metadata.workflow === true || metadata.command !== realCommand.type || realAction)) return { kind: 'invalid' };
      if (realAction && (!metadata?.workflow || mappedDomain !== realAction.domain || realAction.bindings[0].type !== metadata.command)) return { kind: 'invalid' };
      const hasCommand = !!realCommand && store.real?.route(realCommand) != null;
      const hasWorkflow = () => !!realAction && store.real?.mode(realAction.domain) === 'http'
        && realAction.bindings.every(command => store.real?.route(command) != null);
      if (operating && !hasCommand && !hasWorkflow()) return noBinding();
      const settle = (applied: DataCommandResult) => settledOutcome(applied, true,
        { command: adapter.command, featureId: result.featureId, undoToken: value => value.undoToken });
      const finishRun = (outcome: RunActionOutcome, flush?: AccountFlush): ExecutionRejection | Applied => {
        if (outcome.kind !== 'applied') return outcome;
        const { undo, notice, scheduledNotice } = outcome;
        const revision = store.getSnapshot().revision;
        if (!undo) return { kind: 'applied', notice, scheduledNotice, revision };
        const token = context.proposalId;
        runUndo.set(run, { store, runId: capturedRun.runId, token, reverse: undo, reversing: false, flush });
        return { kind: 'applied', revision, undoToken: token,
          notice: { kind: 'success', messageKey: 'common.navis.agent.changeApplied', ...notice, undo: { target: 'run', token } } };
      };
      const asReal = realCommand ? {
        commandFingerprint: JSON.stringify(realCommand),
        routed: () => store.real?.route(realCommand) != null,
        executeAsync: async () => {
          const applied = await store.execute(realCommand);
          if (!applied.ok && applied.reason === 'BRIEFING_DAY_CHANGED' && realCommand.type === 'briefing.acknowledge') {
            await store.real?.retry('briefing');
          }
          if (applied.ok && run.getState().runId === capturedRun.runId) result.afterCommit?.(run);
          return settle(applied.ok && result.noticeKey ? { ...applied, noticeKey: result.noticeKey } : applied);
        },
      } : realAction ? {
        commandFingerprint: realAction.fingerprint,
        // Optional workflows bind the authoritative record revision and recheck it before the first write.
        revalidateRecord: metadata?.workflow === 'optional',
        routed: hasWorkflow,
        executeAsync: async () => settle(await realAction.execute(store)),
      } : account ? {
        commandFingerprint: 'account',
        routed: () => !!findAccountHost(run),
        executeAsync: async () => {
          if (pendingAccountWrites.has(run)) return { kind: 'busy' as const };
          pendingAccountWrites.add(run);
          try {
            const outcome = result.execute(run, store);
            if (outcome.kind !== 'applied') return outcome;
            const status = await account.flush();
            if (status === 'conflict') return { kind: 'conflict' as const, messageKey: 'data.real.error.STALE_REVISION' };
            if (status === 'error') return { kind: 'invalid' as const, messageKey: 'data.real.error.SERVICE_UNAVAILABLE' };
            if (status === 'unchanged') return { kind: 'unchanged' as const };
            if (run.getState().runId !== capturedRun.runId) return { kind: 'conflict' as const };
            return finishRun(outcome, () => account.flush());
          } catch {
            return { kind: 'invalid' as const, messageKey: 'data.real.error.SERVICE_UNAVAILABLE' };
          } finally {
            pendingAccountWrites.delete(run);
          }
        },
      } : {};
      return { ...result, ...asReal, execute() {
        return operating || account ? noBinding() : finishRun(result.execute(run, store));
      } };
    }, false, 'proposalId' in frame && typeof frame.proposalId === 'string' ? frame.proposalId : undefined);
  }

  return {
    prepare(frame: ActionProposalFrame, slots: LocalSlots, snapshot: DataSnapshot, isCurrent = () => true, targets: RecordTargets = new Map(),
      capturedRun = run?.getState()) {
      const adapter = domains.command(frame.command);
      if (adapter) return prepare(frame, adapter, slots, snapshot, isCurrent, targets);
      const runAdapter = domains.runCommand(frame.command);
      return runAdapter ? prepareRun(frame, runAdapter, slots, snapshot, isCurrent, targets, capturedRun) : { kind: 'invalid' } as const;
    },
    propose(frame: ActionProposalFrame, draft: MenuDraft, snapshot: DataSnapshot, isCurrent = () => true): AgentActionProposal | null {
      if (domains.command('menu.create') !== menuCommandAdapter) return null;
      const { name, price, memo } = draft;
      const slots = { name, price, ...(memo?.trim() ? { memo } : {}) };
      const prepared = prepare(frame, menuCommandAdapter, slots, snapshot, isCurrent, new Map(), resolved => resolved.category === draft.category);
      return prepared.kind === 'proposal' ? prepared.proposal : null;
    },
  };
}
