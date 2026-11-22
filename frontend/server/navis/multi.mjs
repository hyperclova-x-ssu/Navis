import { isDeepStrictEqual } from 'node:util';
import {
  agentCommandPolicy, isAgentNavigationCommand, normalizeAgentReadSelection, validateAgentDetailRef,
  validateAgentFrame, validateAgentMultiPlan, validateAgentNavigationArgs, validateAgentRequest,
} from '../../shared/navis-agent-schema.mjs';

const success = new Set(['applied', 'read', 'navigated']);
const navigationFailures = new Map([
  ['invalid', 'invalid'], ['unavailable', 'unavailable'], ['noHistory', 'unavailable'],
]);
const bindingOf = ({ runId, snapshotRevision, layer, page }) => ({ runId, snapshotRevision, layer, page });
const createdKinds = new Map([
  ['menu.create', 'menu'], ['inventory.createItem', 'stock'], ['members.create', 'member'],
  ['suppliers.createPurchaseItem', 'purchaseItem'], ['suppliers.createSupplier', 'supplier'],
  ['suppliers.createOrder', 'purchaseOrder'], ['calendar.addEvent', 'event'],
  ['calendar.addTodo', 'event'], ['staff.create', 'staff'],
]);

function canonicalRead(intent) {
  return intent.reads ? { ...intent, reads: intent.reads.map(normalizeAgentReadSelection) } : intent;
}

function scopedAmbiguity({ recordKind, querySlot, queryBinding, nextCursor, choices }, searches) {
  return searches.some(search => search.kind === recordKind && search.querySlot === querySlot
    && (!search.queryBinding || queryBinding === search.queryBinding)
    && (!nextCursor || nextCursor === search.nextCursor)
    && choices.every(({ handle }) => search.matches.some(match => match.handle === handle)));
}

function observedDestination(destination, runId, command, args) {
  if (destination?.runId !== runId) return undefined;
  const { layer, page, detail } = destination;
  if (!validateAgentNavigationArgs('ui.switch_layer', { layer })
    || page !== undefined && !validateAgentNavigationArgs('ui.go_to_page', { page })
    || detail !== undefined && !validateAgentDetailRef(detail)) return undefined;
  if (command === 'ui.switch_layer' && layer !== args.layer
    || command === 'ui.go_to_page' && page !== args.page
    || command === 'ui.openDetail' && detail?.featureId !== args.featureId) return undefined;
  return globalThis.structuredClone({ runId, layer, ...(page !== undefined && { page }), ...(detail && { detail }) });
}

/**
 * One sequence per authorized store/session/run. The host supplies projected
 * single-turn requests and reports outcomes from the existing card executor.
 * This adapter has no transport or mutation port.
 */
export function createAgentMultiSequence(plan) {
  if (!validateAgentMultiPlan(plan)) throw new TypeError('Invalid Navis multi-step plan');
  const { planId, runId, steps } = globalThis.structuredClone(plan);
  const results = new Map();
  const wireIds = new Set();
  const cardIds = new Set();
  let latestUndo;
  let revisionFloor = 0;
  let cursor = 0;
  let active;
  let pending;
  let conflictDetails;
  let phase = 'ready';

  function advance(outcome, details) {
    results.set(steps[cursor].id, { stepId: steps[cursor].id, outcome, ...details });
    active = undefined;
    pending = undefined;
    conflictDetails = undefined;
    for (cursor += 1; cursor < steps.length; cursor += 1) {
      const { id, dependsOn } = steps[cursor];
      const blockedBy = dependsOn?.filter(parent => !success.has(results.get(parent).outcome));
      if (!blockedBy?.length) break;
      results.set(id, { stepId: id, outcome: 'blocked', blockedBy });
    }
    phase = cursor === steps.length ? 'complete' : 'ready';
  }

  function waitForInput(terminal, details) {
    phase = 'awaiting_input';
    pending = terminal && globalThis.structuredClone(terminal);
    conflictDetails = details;
    active = undefined;
    return true;
  }

  function begin(stepId, input) {
    const step = steps[cursor];
    if (step?.id !== stepId || !['ready', 'awaiting_input'].includes(phase)
      || !validateAgentRequest(input) || input.runId !== runId || input.snapshotRevision < revisionFloor) return undefined;
    const { intent } = step;
    let turnIntent = input.intent;
    if (turnIntent.kind === 'menu.create') {
      // The original menu path derives wire args from its browser-local slots.
      turnIntent = { kind: 'command', command: 'menu.create', args: {
        category: turnIntent.category,
        ...Object.fromEntries(['name', 'price', 'memo'].filter(slot => input.slots.includes(slot)).map(slot => [slot, { slot }])),
      } };
    }
    const matchesIntent = intent.kind === 'read' ? isDeepStrictEqual(canonicalRead(intent), canonicalRead(turnIntent))
      : turnIntent.kind === 'command' && turnIntent.command === intent.command;
    if (!matchesIntent) return undefined;

    revisionFloor = input.snapshotRevision;
    const attempt = Object.freeze({ planId, stepId });
    active = { attempt, binding: bindingOf(input), ...globalThis.structuredClone({ intent: turnIntent, searches: input.searches }) };
    pending = undefined;
    conflictDetails = undefined;
    phase = 'preparing';
    return attempt;
  }

  function recordTurn(attempt, terminal, proposal) {
    if (!active || active.attempt !== attempt || phase !== 'preparing') return false;
    const { intent, binding } = active;
    const command = intent.kind === 'command' ? intent.command : undefined;
    if (terminal?.outcome === 'proposal') {
      if (!validateAgentFrame('done', terminal) || !command || intent.clarify || isAgentNavigationCommand(command)
        || !validateAgentFrame('action_proposal', proposal)
        || !proposal.proposalId || !proposal.tier || wireIds.has(proposal.proposalId) || proposal.command !== command
        || !isDeepStrictEqual(bindingOf(proposal), binding) || !isDeepStrictEqual(proposal.args, intent.args ?? {})
        || agentCommandPolicy(command, proposal.args)?.policy !== 'propose') return false;
      wireIds.add(proposal.proposalId);
      active.tier = proposal.tier;
      active.wireProposalId = proposal.proposalId;
      phase = 'awaiting_card';
      return true;
    }
    if (proposal !== undefined) return false;
    if (validateAgentFrame('error', terminal)) {
      advance(terminal.code === 'CANCELLED' ? 'cancelled' : 'error');
      return true;
    }
    if (!validateAgentFrame('done', terminal)) return false;
    switch (terminal.outcome) {
      case 'clarify':
        if ((terminal.clarification.command ?? 'menu.create') !== command
          || intent.clarify && terminal.clarification.field !== intent.clarify) return false;
        return waitForInput(terminal);
      case 'ambiguous':
        if (!scopedAmbiguity(terminal.clarification, active.searches)) return false;
        return waitForInput(terminal);
      case 'navigate':
        if (terminal.navigation.command !== command || !isDeepStrictEqual(bindingOf(terminal.navigation), binding)
          || !Object.entries(intent.args ?? {}).every(([field, value]) => isDeepStrictEqual(terminal.navigation.args[field], value))) return false;
        active.navigationArgs = globalThis.structuredClone(terminal.navigation.args);
        phase = 'awaiting_navigation';
        return true;
      case 'reply': {
        if (command) {
          if (!isAgentNavigationCommand(command)) return false;
          phase = 'awaiting_navigation';
          return true;
        }
        const { readStatuses } = terminal;
        if (intent.reads && readStatuses?.length !== intent.reads.length) return false;
        const ready = !readStatuses || readStatuses.length > 0 && readStatuses.every(status => status === 'ready');
        advance(ready ? 'read' : 'unavailable', readStatuses && { readStatuses: [...readStatuses] });
        return true;
      }
      case 'handoff':
        if (terminal.handoff.command !== command || terminal.handoff.runId !== runId
          || terminal.handoff.snapshotRevision !== binding.snapshotRevision) return false;
        advance('handoff');
        return true;
      case 'refused':
        advance('refused');
        return true;
      default:
        return false;
    }
  }

  function bindCard(attempt, card) {
    if (!active || active.attempt !== attempt || phase !== 'awaiting_card' || active.card
      || active.wireProposalId !== card?.wireProposalId
      || !validateAgentFrame('action_result', { proposalId: card?.id, outcome: 'cancelled' })
      || cardIds.has(card.id) || card.command !== active.intent.command || card.snapshotRevision !== active.binding.snapshotRevision
      || !['normal', 'extra-confirm'].includes(card.tier) || active.tier === 'extra-confirm' && card.tier !== active.tier) return false;
    cardIds.add(card.id);
    active.card = { id: card.id, tier: card.tier, acknowledged: false };
    return true;
  }

  function recordPreparation(attempt, outcome) {
    if (!active || active.attempt !== attempt || phase !== 'awaiting_card' || active.card) return false;
    if (outcome === 'clarify') return waitForInput();
    if (outcome === 'conflict') return waitForInput({ outcome: 'conflict' });
    if (outcome === 'busy') return true;
    if (!['unchanged', 'invalid', 'unavailable'].includes(outcome)) return false;
    advance(outcome);
    return true;
  }

  function recordCard(attempt, receipt, hasUndo = false) {
    const card = active?.card;
    const { frame, requiresExtraConfirmation, createdRecord } = receipt ?? {};
    if (!card || active.attempt !== attempt || phase !== 'awaiting_card'
      || !validateAgentFrame('action_result', frame) || frame.proposalId !== card.id
      || frame.revision !== undefined && frame.revision < revisionFloor
      || frame.outcome === 'applied' && frame.revision === undefined
      || requiresExtraConfirmation !== undefined && typeof requiresExtraConfirmation !== 'boolean'
      || typeof hasUndo !== 'boolean' || hasUndo && frame.outcome !== 'applied') return false;
    if (requiresExtraConfirmation) {
      if (card.tier !== 'extra-confirm' || frame.outcome !== 'invalid' || frame.revision !== undefined) return false;
      card.acknowledged = true;
      return true;
    }
    if (frame.outcome === 'applied' && card.tier === 'extra-confirm' && !card.acknowledged) return false;
    if (frame.outcome === 'busy') return true;
    const { proposalId, revision } = frame;
    const details = { proposalId, ...(revision === undefined ? {} : { revision }) };
    if (frame.outcome === 'applied') {
      latestUndo = hasUndo ? { stepId: steps[cursor].id, proposalId } : undefined;
      if (createdRecord && createdRecord.kind === createdKinds.get(active.intent.command)
        && typeof createdRecord.id === 'string' && createdRecord.id && revision > active.binding.snapshotRevision) {
        details.createdRecord = { kind: createdRecord.kind, id: createdRecord.id };
      }
    }
    if (revision !== undefined) revisionFloor = revision;
    if (frame.outcome === 'conflict') return waitForInput({ outcome: 'conflict' }, details);
    advance(frame.outcome, details);
    return true;
  }

  function recordNavigation(attempt, outcome, destination) {
    if (!active || active.attempt !== attempt || phase !== 'awaiting_navigation') return false;
    if (outcome === 'busy') return true;
    if (outcome === 'stale') return waitForInput({ outcome: 'conflict' });
    if (outcome === 'opened' || outcome === 'already') {
      const observed = observedDestination(destination, runId, active.intent.command, active.navigationArgs ?? active.intent.args ?? {});
      if (!observed) return false;
      advance('navigated', { destination: observed });
    } else if (navigationFailures.has(outcome)) advance(navigationFailures.get(outcome));
    else return false;
    return true;
  }

  return Object.freeze({
    getState: () => globalThis.structuredClone({
      phase, results: [...results.values()], ...(phase === 'complete' ? {} : { step: steps[cursor] }),
      ...(pending && { pending }),
      ...(latestUndo ? { latestUndo } : {}),
    }),
    begin, recordTurn, bindCard, recordPreparation, recordCard, recordNavigation,
    recordLocal(stepId, outcome) {
      if (steps[cursor]?.id !== stepId || !['ready', 'awaiting_input'].includes(phase)) return false;
      if (outcome === 'clarify') return waitForInput();
      if (!['refused', 'handoff', 'invalid', 'unavailable'].includes(outcome)) return false;
      advance(outcome);
      return true;
    },
    cancelStep(stepId) {
      if (steps[cursor]?.id !== stepId || phase === 'complete' || active?.card) return false;
      advance('cancelled');
      return true;
    },
    finishConflict(stepId) {
      if (steps[cursor]?.id !== stepId || pending?.outcome !== 'conflict') return false;
      advance('conflict', conflictDetails);
      return true;
    },
    clearUndo(proposalId) {
      if (!latestUndo || latestUndo.proposalId !== proposalId) return false;
      latestUndo = undefined;
      return true;
    },
  });
}
