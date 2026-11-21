import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';
import { checkedMemberTarget, memberLookup } from './members.mjs';

const commands = [
  'booking.create', 'booking.update', 'booking.confirm', 'booking.cancel', 'booking.markCompleted', 'booking.markNoShow',
];
const editableStatuses = ['needs-check', 'confirmed', 'proposed'];
const refused = reason => ({ outcome: 'refused', reason });

function targetFields({ command, args = {}, querySlot }, slots) {
  const targets = [];
  if (command !== 'booking.create') {
    targets.push({ kind: 'reservation', field: 'reservationId', querySlot: querySlot ?? 'reservationId', ref: args.reservationId });
  }
  const booking = command === 'booking.update' ? args.patch : args;
  if (booking?.memberId) {
    const member = memberLookup(slots.includes('memberQuery') ? 'memberQuery' : 'memberId');
    targets.push({ ...member.args, field: 'memberId', ref: booking.memberId });
  }
  if (booking?.tableChoice?.tableId) {
    targets.push({ kind: 'table', field: 'tableChoice', querySlot: 'tableId', ref: booking.tableChoice.tableId });
  }
  return targets;
}

function canChangeVisit(command, fields) {
  if (fields?.kind !== 'visit') return false;
  switch (command) {
    case 'booking.confirm': return fields.status === 'needs-check';
    case 'booking.markCompleted':
    case 'booking.markNoShow': return fields.status === 'confirmed' && fields.visitStarted === true;
    case 'booking.update':
    case 'booking.cancel': return editableStatuses.includes(fields.status);
    default: return false;
  }
}

function prepare({ input: { intent, slots }, reads }) {
  const { command, args } = intent;
  if (!validateAgentToolArgs('propose_action', { command, args })) return refused('invalid_target');
  for (const [lookupIndex, target] of targetFields(intent, slots).entries()) {
    const search = reads[lookupIndex];
    if (target.kind === 'member') {
      const result = checkedMemberTarget(search, target.ref, lookupIndex);
      if (!result.match) return result;
      continue;
    }
    if (!['ready', 'missing'].includes(search?.status)) return refused('unavailable');
    const { match, choices } = resolveAgentTarget(search);
    if (!match) {
      return choices.length ? { outcome: 'ambiguous', lookupIndex, field: target.field } : refused('invalid_target');
    }
    if (match.handle !== target.ref?.handle || target.kind === 'reservation' && !canChangeVisit(command, match.fields)) {
      return refused('invalid_target');
    }
  }
  // The browser resolves private slot values and simulates the canonical booking command on this revision.
  // The resulting allocation warning and before/after are part of the local confirmation card.
  return { outcome: 'ready', args, ...(command === 'booking.cancel' ? { tier: 'extra-confirm' } : {}) };
}

export const bookingAdapters = Object.freeze(commands.map(command => Object.freeze({
  command,
  lookups({ intent, slots }) {
    const targets = targetFields(intent, slots);
    return targets.every(target => slots.includes(target.querySlot))
      ? targets.map(({ kind, querySlot }) => ({ name: 'search_records', args: { kind, querySlot } })) : [];
  },
  prepare,
})));
