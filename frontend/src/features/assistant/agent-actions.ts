import type { NoticeRequest, RunState, RunStore } from '../../contracts';
import type { DataCommand } from '../../data/commands/types';
import type { DataSnapshot } from '../../data/db/types';
import type { WidgetDataStore } from '../../data/widget-data';
import { agentCommandPolicy, agentCommandRefs, validateAgentFrame, type AgentFrameData, type AgentKnownCommand } from '../../../shared/navis-agent-schema.mjs';
import { selectCommonNotice } from '../../state';
import { menuCommandAdapter, type MenuCreationPreview, type MenuDraft } from './domains/menu';
import type { CommandAdapter, CommandContext, ConfirmationTier, DomainRegistry, LocalSlots, RecordTargets, RunCommandAdapter } from './domains/registry';
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
  readonly undoToken?: string;
}

type ActionCommand = DataCommand['type'] | AgentKnownCommand;

export interface ProposalEdit<Command extends ActionCommand, Draft, Preview> {
  readonly draft: Draft;
  preview(draft: Draft): LocalAgentProposal<Command, Draft, Preview> | null;
  cancel(): void;
}
export type MenuProposalEdit = ProposalEdit<'menu.create', MenuDraft, MenuCreationPreview>;

export interface LocalAgentProposal<Command extends ActionCommand = ActionCommand, Draft = unknown, Preview = unknown> {
  readonly id: string;
  readonly command: Command;
  readonly tier: ConfirmationTier;
  readonly preview: Preview;
  readonly snapshotRevision: number;
  isCurrent(): boolean;
  getReceipt(): AgentActionReceipt | undefined;
  confirm(currentStore: WidgetDataStore, acknowledgedProposalId?: string): AgentActionReceipt;
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
type Applied = { readonly kind: 'applied'; readonly revision?: number; readonly notice?: NoticeRequest; readonly undoToken?: string };
type Executable<Preview> = Rejected | {
  readonly kind: 'ready';
  readonly preview: Preview;
  readonly tier?: ConfirmationTier;
  readonly execute: () => ExecutionRejection | Applied;
};

const runUndo = new WeakMap<RunStore, {
  token: string; runId: string; store: WidgetDataStore; reverse: (run: RunStore) => boolean; reversing: boolean;
}>();

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

export function createAgentActions(store: WidgetDataStore, domains: DomainRegistry = assistantDomains, run?: RunStore) {
  let pendingId: string | undefined;

  function makeProposal<Command extends ActionCommand, Draft, Preview>(
    command: Command, draft: Draft, snapshot: DataSnapshot, isCurrent: () => boolean, minimumTier: ConfirmationTier,
    prepare: (draft: Draft, context: CommandContext, refreshing: boolean) => Executable<Preview>, refreshing = false,
  ): Prepared<LocalAgentProposal<Command, Draft, Preview>> {
    if (!isCurrent() || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
    const id = crypto.randomUUID();
    const result = prepare(draft, { snapshot, proposalId: id, idempotencyKey: `navis:${snapshot.runId}:${id}` }, refreshing);
    if (result.kind !== 'ready') return result;
    const { preview } = result;
    const tier = minimumTier === 'extra-confirm' || result.tier === 'extra-confirm' ? 'extra-confirm' : 'normal';
    pendingId = id;
    const isPendingProposal = () => pendingId === id && isCurrent() && store.getSnapshot().runId === snapshot.runId;
    let receipt: AgentActionReceipt | undefined;
    let locked = false;
    let replaced = false;
    let acknowledged = false;
    const report = (outcome: Outcome, details?: Omit<ActionResultFrame, 'proposalId' | 'outcome'>): AgentActionReceipt =>
      ({ frame: { proposalId: id, outcome, ...details } });
    const consume = (outcome: Outcome, details?: Omit<ActionResultFrame, 'proposalId' | 'outcome'>) =>
      (receipt = report(outcome, details));
    const busy = () => report('busy');
    const conflict = () => consume('conflict');
    const reprepare = (next: Draft) => {
      const updated = makeProposal(command, next, store.getSnapshot(), isCurrent, minimumTier, prepare, true);
      return updated.kind === 'proposal' ? updated.proposal : null;
    };

    return { kind: 'proposal', proposal: {
      id, command, tier, snapshotRevision: snapshot.revision, preview,
      isCurrent: isPendingProposal,
      getReceipt: () => receipt,
      confirm(currentStore, acknowledgedProposalId) {
        if (currentStore !== store) return report('conflict');
        if (receipt) return receipt;
        if (locked) return busy();
        if (!isPendingProposal() || store.getSnapshot().revision !== snapshot.revision) return conflict();
        if (tier === 'extra-confirm' && (!acknowledged || acknowledgedProposalId !== id)) {
          acknowledged = true;
          return { ...report('invalid'), requiresExtraConfirmation: true };
        }
        locked = true;
        try {
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
          };
        } finally {
          locked = false;
        }
      },
      cancel() {
        if (receipt) return receipt;
        return locked ? busy() : consume('cancelled');
      },
      edit() {
        if (locked || replaced || !isPendingProposal() || receipt && receipt.frame.outcome !== 'invalid') return null;
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
    return makeProposal(adapter.command, checked.draft, snapshot, isCurrent, checked.tier, (draft, context): Executable<Preview> => {
      const result = adapter.preflight(draft, context);
      if (result.kind !== 'ready') return result;
      const { command } = result;
      if (command.type !== adapter.command || agentCommandPolicy(command.type, command)?.policy !== 'propose') return { kind: 'invalid' };
      const dispatchCommand: DataCommand = { ...structuredClone(command), baseRevision: context.snapshot.revision };
      Object.freeze(dispatchCommand);
      return { ...result, execute() {
        const applied = store.dispatch(dispatchCommand);
        if (!applied.ok) {
          if (applied.reason === 'TRANSACTION_BUSY') return { kind: 'busy' };
          if (applied.code === 'CONFLICT' || applied.code === 'NOT_FOUND') return { kind: 'conflict' };
          return { kind: 'invalid', messageKey: applied.messageKey, field: applied.field };
        }
        if (applied.duplicate) return { kind: 'unchanged', revision: applied.revision, messageKey: applied.noticeKey };
        const token = adapter.undoToken(applied);
        const notice: NoticeRequest | undefined = applied.noticeKey ? {
          kind: 'success', featureId: adapter.featureId, messageKey: applied.noticeKey,
          ...(applied.params ? { params: applied.params } : {}),
          ...(token ? { undo: { target: 'data', token } } : {}),
        } : undefined;
        return { kind: 'applied', revision: applied.revision, notice, undoToken: token };
      } };
    });
  }

  function prepareRun(frame: ActionProposalFrame, adapter: RunCommandAdapter, slots: LocalSlots, snapshot: DataSnapshot,
    isCurrent: () => boolean, targets: RecordTargets, capturedRun: RunState | undefined) {
    if (!run || !capturedRun || capturedRun.runId !== snapshot.runId) return { kind: 'invalid' } as const;
    const currentRun = () => run.getState().runId === capturedRun.runId && isCurrent();
    const checked = validateDraft(frame, adapter, slots, snapshot, targets);
    if (checked.kind !== 'ready') return checked;
    return makeProposal(adapter.command, checked.draft, snapshot, currentRun, checked.tier, (draft, context, refreshing): Executable<unknown> => {
      const result = adapter.preflight(draft, { ...context, run: refreshing ? run.getState() : capturedRun });
      if (result.kind !== 'ready') return result;
      return { ...result, execute() {
        const outcome = result.execute(run, store);
        if (outcome.kind !== 'applied') return outcome;
        const { undo, notice } = outcome;
        if (!undo) return { kind: 'applied', notice, revision: store.getSnapshot().revision };
        const token = context.proposalId, revision = store.getSnapshot().revision;
        runUndo.set(run, { store, runId: capturedRun.runId, token, reverse: undo, reversing: false });
        return { kind: 'applied', revision, undoToken: token,
          notice: { kind: 'success', messageKey: 'common.navis.agent.changeApplied', ...notice, undo: { target: 'run', token } } };
      } };
    });
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
