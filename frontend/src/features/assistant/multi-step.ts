import {
  agentCommandPolicy, isAgentNavigationCommand, validateAgentFrame, validateAgentMultiPlan, validateAgentRequest,
  type AgentActionProposal, type AgentDone, type AgentFrameData, type AgentIntent, type AgentMultiPlan, type AgentMultiSequence,
  type AgentMultiState, type AgentMultiStep, type AgentMultiStepResult, type AgentRequest,
} from '../../../shared/navis-agent-schema.mjs';

type LocalOutcome = Parameters<AgentMultiSequence['recordLocal']>[1];
type PreparationOutcome = Parameters<AgentMultiSequence['recordPreparation']>[1];
type NavigationOutcome = Parameters<AgentMultiSequence['recordNavigation']>[1];
type Card = Parameters<AgentMultiSequence['bindCard']>[1];
type CardReceipt = Parameters<AgentMultiSequence['recordCard']>[1];
type TurnTerminal = AgentDone | AgentFrameData['error'];

export type MultiStepProjection =
  | { readonly kind: 'request'; readonly request: AgentRequest }
  | { readonly kind: LocalOutcome; readonly field?: string };

export type MultiStepAttempt = Readonly<{ stepId: string }>;
type Projected<P> = P extends { readonly kind: 'request' }
  ? { readonly projection: P; readonly attempt: MultiStepAttempt }
  : { readonly projection: P; readonly attempt?: undefined };

type Binding = Pick<AgentRequest, 'runId' | 'snapshotRevision' | 'layer' | 'page'>;
type ActiveStep = {
  readonly attempt: MultiStepAttempt;
  readonly request: Binding;
  readonly intent: Exclude<AgentIntent, { kind: 'menu.create' } | { kind: 'conversation' }>;
  tier?: Card['tier'];
  card?: Pick<Card, 'id' | 'tier'> & { acknowledged: boolean };
};

const successfulOutcomes = new Set(['applied', 'read', 'navigated']);

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const fields = Object.entries(left);
  return fields.length === Object.keys(right).length
    && fields.every(([field, value]) => Object.hasOwn(right, field) && sameValue(value, (right as Record<string, unknown>)[field]));
}

function sameBinding(frame: Partial<Binding>, request: Binding): boolean {
  return frame.runId === request.runId && frame.snapshotRevision === request.snapshotRevision
    && frame.layer === request.layer && frame.page === request.page;
}

function projectedIntent(request: AgentRequest): ActiveStep['intent'] | undefined {
  const { intent, slots } = request;
  if (intent.kind === 'conversation') return undefined;
  if (intent.kind !== 'menu.create') return intent;
  // The legacy menu-create request projects only the names of its browser-local slots.
  return { kind: 'command', command: 'menu.create', args: {
    category: intent.category,
    ...Object.fromEntries(['name', 'price', 'memo'].filter(slot => slots.includes(slot)).map(slot => [slot, { slot }])),
  } };
}

/** One runner per chat session and run. The host owns transport, navigation, card presses and undo authority. */
export function startMultiStepPlan(plan: AgentMultiPlan) {
  if (!validateAgentMultiPlan(plan)) throw new TypeError('Invalid Navis multi-step plan');
  const { runId, steps } = structuredClone(plan);
  const results: AgentMultiStepResult[] = [];
  const wireIds = new Set<string>();
  const cardIds = new Set<string>();
  let cursor = 0;
  let phase: AgentMultiState['phase'] = 'ready';
  let active: ActiveStep | undefined;
  let revisionFloor = 0;
  let projecting = false;
  let latestUndo: AgentMultiState['latestUndo'];

  function getState(): AgentMultiState {
    const progress = { results, ...(latestUndo && { latestUndo }) };
    return structuredClone(phase === 'complete' ? { ...progress, phase } : { ...progress, phase, step: steps[cursor] });
  }

  function advance(outcome: Exclude<AgentMultiStepResult['outcome'], 'blocked'>, details?: { proposalId: string; revision?: number }) {
    results.push({ stepId: steps[cursor].id, outcome, ...details });
    active = undefined;
    for (cursor += 1; cursor < steps.length; cursor += 1) {
      const { id, dependsOn } = steps[cursor];
      const blockedBy = dependsOn?.filter(parent => !results.some(result => result.stepId === parent && successfulOutcomes.has(result.outcome)));
      if (!blockedBy?.length) break;
      results.push({ stepId: id, outcome: 'blocked', blockedBy });
    }
    phase = cursor === steps.length ? 'complete' : 'ready';
  }

  function waitForInput() {
    active = undefined;
    phase = 'awaiting_input';
    return true;
  }

  function projectNext<P extends MultiStepProjection>(project: (step: AgentMultiStep) => P, options?: { readonly resumeStepId: string }): Projected<P> | undefined;
  function projectNext(project: (step: AgentMultiStep) => MultiStepProjection, options?: { readonly resumeStepId: string }) {
    const step = steps[cursor];
    const canProject = options ? phase === 'awaiting_input' && options.resumeStepId === step?.id : phase === 'ready';
    if (!canProject || projecting) return undefined;
    let projection: MultiStepProjection;
    projecting = true;
    try {
      projection = project(structuredClone(step));
    } finally {
      projecting = false;
    }
    if (step !== steps[cursor]) return undefined;
    if (projection.kind !== 'request') {
      if (projection.kind === 'clarify') waitForInput();
      else advance(projection.kind);
      return { projection };
    }

    const { request } = projection;
    if (!validateAgentRequest(request) || request.runId !== runId || request.snapshotRevision < revisionFloor) return undefined;
    const intent = projectedIntent(request);
    const selected = step.intent;
    if (!intent || (selected.kind === 'read' ? !sameValue(selected, intent) : intent.kind !== 'command' || intent.command !== selected.command)) return undefined;

    const attempt = Object.freeze({ stepId: step.id });
    const { snapshotRevision, layer, page } = request;
    revisionFloor = snapshotRevision;
    active = { attempt, request: { runId, snapshotRevision, layer, page }, intent: structuredClone(intent) };
    phase = 'preparing';
    return { projection, attempt };
  }

  function recordTurn(attempt: MultiStepAttempt, terminal: TurnTerminal, proposal?: AgentActionProposal) {
    if (!active || active.attempt !== attempt || phase !== 'preparing') return false;
    const { intent, request } = active;
    const command = intent.kind === 'command' ? intent.command : undefined;
    if (validateAgentFrame('error', terminal) && proposal === undefined) {
      advance(terminal.code === 'CANCELLED' ? 'cancelled' : 'error');
      return true;
    }
    if (!validateAgentFrame('done', terminal) || proposal !== undefined && terminal.outcome !== 'proposal') return false;

    switch (terminal.outcome) {
      case 'proposal': {
        if (!validateAgentFrame('action_proposal', proposal) || !proposal.proposalId || !proposal.tier
          || proposal.command !== command || wireIds.has(proposal.proposalId) || !sameBinding(proposal, request)
          || intent.kind !== 'command' || !sameValue(proposal.args, intent.args ?? {})) return false;
        const policy = agentCommandPolicy(proposal.command, proposal.args);
        if (policy.policy !== 'propose' || policy.confirmation === 'extra-confirm' && proposal.tier !== 'extra-confirm') return false;
        wireIds.add(proposal.proposalId);
        active.tier = proposal.tier;
        phase = 'awaiting_card';
        return true;
      }
      case 'clarify':
        if ('command' in terminal.clarification ? terminal.clarification.command !== command : command !== 'menu.create') return false;
        return waitForInput();
      case 'ambiguous':
        return waitForInput();
      case 'navigate':
        if (terminal.navigation.command !== command || !sameBinding(terminal.navigation, request)) return false;
        phase = 'awaiting_navigation';
        return true;
      case 'reply':
        if (command) {
          if (!isAgentNavigationCommand(command)) return false;
          phase = 'awaiting_navigation';
        } else advance('read');
        return true;
      case 'handoff':
        if (terminal.handoff.command !== command || terminal.handoff.runId !== runId
          || terminal.handoff.snapshotRevision !== request.snapshotRevision) return false;
        advance('handoff');
        return true;
      case 'refused':
        advance('refused');
        return true;
      default:
        return false;
    }
  }

  /** A step that ended locally, with no server terminal: a refusal, a handoff, or a question the owner must answer first. */
  function recordLocal(attempt: MultiStepAttempt, outcome: LocalOutcome) {
    if (!active || active.attempt !== attempt || phase !== 'preparing') return false;
    if (outcome === 'clarify') return waitForInput();
    advance(outcome);
    return true;
  }

  function bindCard(attempt: MultiStepAttempt, card: Card) {
    if (!active || active.attempt !== attempt || phase !== 'awaiting_card' || active.card
      || active.intent.kind !== 'command' || card.command !== active.intent.command
      || !validateAgentFrame('action_result', { proposalId: card.id, outcome: 'cancelled' })
      || cardIds.has(card.id) || card.snapshotRevision !== active.request.snapshotRevision
      || (card.tier !== 'normal' && card.tier !== 'extra-confirm') || active.tier === 'extra-confirm' && card.tier !== 'extra-confirm') return false;
    cardIds.add(card.id);
    active.card = { id: card.id, tier: card.tier, acknowledged: false };
    return true;
  }

  function recordPreparation(attempt: MultiStepAttempt, outcome: PreparationOutcome) {
    if (!active || active.attempt !== attempt || phase !== 'awaiting_card' || active.card) return false;
    if (outcome === 'clarify' || outcome === 'conflict') return waitForInput();
    if (outcome === 'busy') return true;
    if (outcome !== 'unchanged' && outcome !== 'invalid' && outcome !== 'unavailable') return false;
    advance(outcome);
    return true;
  }

  function recordCard(attempt: MultiStepAttempt, receipt: CardReceipt, undoEligible = false) {
    if (!active || active.attempt !== attempt || phase !== 'awaiting_card' || !active.card) return false;
    const card = active?.card;
    const { frame, requiresExtraConfirmation } = receipt;
    if (!validateAgentFrame('action_result', frame)
      || frame.proposalId !== card.id || frame.revision !== undefined && frame.revision < revisionFloor
      || requiresExtraConfirmation !== undefined && typeof requiresExtraConfirmation !== 'boolean'
      || undoEligible && frame.outcome !== 'applied') return false;
    if (requiresExtraConfirmation) {
      if (card.tier !== 'extra-confirm' || frame.outcome !== 'invalid') return false;
      card.acknowledged = true;
      return true;
    }
    if (frame.outcome === 'applied' && card.tier === 'extra-confirm' && !card.acknowledged) return false;
    if (frame.outcome === 'busy') return true;
    const { proposalId, revision } = frame;
    if (revision !== undefined) revisionFloor = revision;
    if (frame.outcome === 'conflict') return waitForInput();
    if (undoEligible) latestUndo = { stepId: attempt.stepId, proposalId };
    advance(frame.outcome, { proposalId, ...(revision !== undefined && { revision }) });
    return true;
  }

  function recordNavigation(attempt: MultiStepAttempt, outcome: NavigationOutcome) {
    if (!active || active.attempt !== attempt || phase !== 'awaiting_navigation') return false;
    switch (outcome) {
      case 'busy': return true;
      case 'stale': return waitForInput();
      case 'opened':
      case 'already': advance('navigated'); return true;
      case 'invalid': advance('invalid'); return true;
      case 'unavailable':
      case 'noHistory': advance('unavailable'); return true;
      default: return false;
    }
  }

  function cancelStep(stepId: string) {
    if (steps[cursor]?.id !== stepId || active?.card) return false;
    advance('cancelled');
    return true;
  }

  return Object.freeze({
    getState, projectNext, recordTurn, recordLocal, bindCard, recordPreparation, recordCard, recordNavigation, cancelStep,
    stop() {
      if (phase === 'complete' || active?.card) return false;
      while (cursor < steps.length) advance('cancelled');
      return true;
    },
    clearUndo(proposalId: string) {
      if (!latestUndo || latestUndo.proposalId !== proposalId) return false;
      latestUndo = undefined;
      return true;
    },
  });
}

export type MultiStepRunner = ReturnType<typeof startMultiStepPlan>;
