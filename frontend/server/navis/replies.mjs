import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

const commands = [
  'reply.draft', 'inquiry.saveDraft', 'inquiry.send', 'inquiry.post',
  'community.accept', 'community.decline', 'community.sendInterest',
];
const refused = reason => ({ outcome: 'refused', reason });

function lookup({ intent, slots, searches }, kind, field) {
  const candidates = intent.querySlot === undefined
    ? [field, kind === 'thread' ? 'threadQuery' : 'offerQuery']
    : [intent.querySlot];
  const querySlot = candidates.find(slot => slots.includes(slot)
    && searches.some(search => search.kind === kind && search.querySlot === slot && !search.cursor));
  return querySlot ? { name: 'search_records', args: { kind, querySlot } } : undefined;
}

function checkThread(command, row) {
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1) return 'unavailable';
  if (row.status === 'done') return 'duplicate';
  if (!['waiting', 'draft_ready'].includes(row.status) || row.connected !== true) return 'invalid_target';
  if (row.type !== 'message' && !(row.type === 'review' && row.isPublic === true)) return 'invalid_target';
  if (command === 'reply.draft' || command === 'inquiry.saveDraft') {
    return row.canDraft === true ? undefined : 'invalid_target';
  }
  const type = command === 'inquiry.post' ? 'review' : 'message';
  return row.type === type && row.hasDraft === true && row.canSend === true ? undefined : 'invalid_target';
}

function checkOffer(command, row) {
  if (!row || typeof row.eligible !== 'boolean') return 'unavailable';
  const interest = command === 'community.sendInterest';
  if (row.visibility !== (interest ? 'public' : 'direct')) return 'invalid_target';
  if (row.status === 'accepted' || row.status === 'declined' || interest && row.interestSent === true) return 'duplicate';
  return row.status === 'pending' && row.eligible && (!interest || row.interestSent === false)
    ? undefined : 'invalid_target';
}

export const replyAdapters = Object.freeze(commands.map(command => {
  const isOffer = command.startsWith('community.');
  const field = isOffer ? 'offerId' : 'threadId';
  const kind = isOffer ? 'offer' : 'thread';
  return Object.freeze({
    command,
    lookups(input) {
      const targetLookup = lookup(input, kind, field);
      return targetLookup ? [targetLookup] : [];
    },
    prepare({ input, reads }) {
      const { args } = input.intent;
      if (!validateAgentToolArgs('propose_action', { command, args })) return refused('invalid_target');
      if (!lookup(input, kind, field)) return refused('invalid_target');
      const read = reads[0];
      if (read?.status !== 'ready' && read?.status !== 'missing') return refused('unavailable');
      const { match, choices } = resolveAgentTarget(read);
      if (!match) return choices.length ? { outcome: 'ambiguous', lookupIndex: 0, field } : refused('invalid_target');
      if (match.handle !== args[field].handle) return refused('invalid_target');
      const reason = (isOffer ? checkOffer : checkThread)(command, match.fields);
      return reason ? refused(reason) : { outcome: 'ready', args };
    },
  });
}));
