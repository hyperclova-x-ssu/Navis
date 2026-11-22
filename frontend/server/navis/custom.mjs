import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { checkedMemberTarget } from './members.mjs';
import { resolveAgentTarget } from './registry.mjs';

const commands = [
  'customOrder.create', 'customOrder.update', 'customOrder.quote', 'customOrder.recordDecision',
  'customOrder.setStage', 'customOrder.receive', 'customOrder.cancel', 'pickup.reschedule', 'pickup.cancel',
  'customTemplate.generate', 'customTemplate.save', 'customTemplate.delete',
];
const extraConfirmation = new Set(['customOrder.cancel', 'pickup.cancel', 'customTemplate.delete']);
const decisionStages = new Set(['approval_pending', 'revision_requested', 'quote_pending', 'payment_pending', 'in_production']);
const receiptChanges = ['answers', 'productLabel', 'options', 'quantity', 'memberId', 'guest', 'desiredPickupAt'];
const refused = reason => ({ outcome: 'refused', reason });

function targets({ args }) {
  const fields = [
    ['customOrder', 'customOrderId'], ['customTemplate', 'templateId'],
    ['reservation', 'reservationId'], ['member', 'memberId'],
  ];
  return fields.filter(([, field]) => args?.[field]).map(([kind, field]) => ({
    kind, field, handle: args[field].handle,
  }));
}

function lookups({ intent, slots, searches }) {
  const bindings = targets(intent).map(({ kind, handle }) => {
    const candidates = searches.filter(search => search.kind === kind && !search.cursor && slots.includes(search.querySlot)
      && (kind === 'member' || !intent.querySlot || search.querySlot === intent.querySlot));
    const matching = candidates.filter(search => search.matches.some(match => match.handle === handle));
    return matching.length === 1 ? matching[0] : candidates.length === 1 ? candidates[0] : undefined;
  });
  return bindings.every(Boolean)
    ? bindings.map(({ kind, querySlot }) => ({ name: 'search_records', args: { kind, querySlot } }))
    : [];
}

function checkedTarget(read, target, lookupIndex) {
  if (target.kind === 'member') return checkedMemberTarget(read, { handle: target.handle }, lookupIndex);
  if (!['ready', 'missing'].includes(read?.status)) return refused('unavailable');
  const { match, choices } = resolveAgentTarget(read);
  if (!match && choices.length) return { outcome: 'ambiguous', lookupIndex, field: target.field };
  return match && match.handle === target.handle ? { match } : refused('invalid_target');
}

function paymentGate(fields) {
  return fields.paymentReversalRequired === true ? refused('widget_only')
    : fields.paymentReversalRequired === false ? undefined : refused('unavailable');
}

function eligibility(command, args, kind, fields) {
  if (kind === 'reservation') {
    if (fields?.kind !== 'pickup' || fields.status !== 'confirmed') return refused('invalid_target');
    return command === 'pickup.cancel' ? paymentGate(fields) : undefined;
  }
  if (kind !== 'customOrder') return undefined;
  const stage = fields?.stage;
  if (!stage) return refused('unavailable');
  if (stage === 'canceled' || stage === 'received_by_customer') return refused('invalid_target');

  switch (command) {
    case 'customOrder.receive':
      if (stage !== 'production_complete' || fields.approvalCurrent !== true) return refused('invalid_target');
      if (fields.paymentTiming === undefined || fields.paymentComplete === undefined) return refused('unavailable');
      return fields.paymentTiming === 'advance' && fields.paymentComplete === true ? undefined : refused('widget_only');
    case 'customOrder.cancel':
    case 'customOrder.quote':
      return paymentGate(fields);
    case 'customOrder.update':
      // Reversal and approval impact depend on which resolved values actually change.
      // The card preflight checks that comparison using the widget's canonical planner.
      return receiptChanges.some(field => Object.hasOwn(args, field)) && fields.paymentReversalRequired === undefined
        ? refused('unavailable') : undefined;
    case 'customOrder.recordDecision':
      if (!decisionStages.has(stage) || fields.quoteRevision === 0) return refused('invalid_target');
      return paymentGate(fields) ?? (fields.quoteRevision === undefined || !fields.proposedPickupAt ? refused('unavailable') : undefined);
    case 'customOrder.setStage':
      if (stage === 'received' && args.nextStage === 'quote_pending') return undefined;
      if (fields.approvalCurrent !== true) return refused('invalid_target');
      if (stage === 'in_production' && args.nextStage === 'production_complete') return undefined;
      if (stage !== 'payment_pending' || args.nextStage !== 'in_production') return refused('invalid_target');
      if (fields.paymentTiming !== 'advance') return refused('invalid_target');
      return fields.paymentComplete === true ? undefined
        : refused(fields.paymentComplete === false ? 'widget_only' : 'unavailable');
  }
}

function prepare({ input: { intent }, reads }) {
  const { command, args } = intent;
  if (!validateAgentToolArgs('propose_action', { command, args })) return refused('invalid_target');
  for (const [index, target] of targets(intent).entries()) {
    const result = checkedTarget(reads[index], target, index);
    if (!result.match) return result;
    const issue = eligibility(command, args, target.kind, result.match.fields);
    if (issue) return issue;
  }

  return { outcome: 'ready', args, ...(extraConfirmation.has(command) ? { tier: 'extra-confirm' } : {}) };
}

export const customAdapters = Object.freeze(commands.map(command => Object.freeze({ command, lookups, prepare })));
