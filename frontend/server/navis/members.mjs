import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

const commands = [
  'members.create', 'members.update', 'members.setGrade', 'members.addNote',
  'members.updateNote', 'members.deleteNote', 'members.delete',
];
const refused = reason => ({ outcome: 'refused', reason });
const search = (kind, querySlot) => ({ name: 'search_records', args: { kind, querySlot } });
const hasResult = read => read?.status === 'ready' || read?.status === 'missing';

export const memberLookup = (querySlot = 'memberQuery') => search('member', querySlot);

function checkedTarget(read, ref, field, lookupIndex) {
  if (!hasResult(read)) return refused('unavailable');
  const { match, choices } = resolveAgentTarget(read);
  if (!match && choices.length) return { outcome: 'ambiguous', lookupIndex, field };
  return match && match.handle === ref?.handle ? { match } : refused('invalid_target');
}

/** Booking and member commands use the same scoped, exact-match identity check. */
export function checkedMemberTarget(read, ref, lookupIndex) {
  return checkedTarget(read, ref, 'memberId', lookupIndex);
}

function lookups({ intent: { command, args, querySlot }, slots }) {
  const member = memberLookup(querySlot ?? 'memberQuery');
  const targets = [member];
  if (args?.noteId) targets.push(search('note', 'noteQuery'));
  if (command === 'members.update' && args?.phone?.slot) targets.push(memberLookup(args.phone.slot));
  return targets.every(target => slots.includes(target.args.querySlot)) ? targets : [];
}

function prepare({ input: { intent: { command, args } }, reads }) {
  if (!validateAgentToolArgs('propose_action', { command, args })) return refused('invalid_target');
  const [memberRead, otherRead] = reads;
  const ready = { outcome: 'ready', args };
  if (command === 'members.create') {
    if (!hasResult(memberRead)) return refused('unavailable');
    return memberRead.matches.length || memberRead.nextCursor ? refused('duplicate') : ready;
  }
  const member = checkedMemberTarget(memberRead, args.memberId, 0);
  if (!member.match) return member;
  if (command === 'members.update' && args.phone) {
    if (!hasResult(otherRead)) return refused('unavailable');
    if (otherRead.nextCursor || otherRead.matches.some(match => match.handle !== member.match.handle)) return refused('duplicate');
  }
  if (args.noteId) {
    const note = checkedTarget(otherRead, args.noteId, 'noteId', 1);
    if (!note.match) return note;
    if (note.match.fields?.ownerHandle !== member.match.handle) return refused('invalid_target');
  }
  if (command === 'members.delete') {
    const blocked = member.match.fields?.deleteBlocked;
    if (blocked === undefined) return refused('unavailable');
    if (blocked) return refused('invalid_target');
  }
  return ready;
}

export function createMemberAdapters({ allowMemberDelete = true } = {}) {
  return Object.freeze(commands.map(command => Object.freeze({
    command,
    ...(command === 'members.delete' && allowMemberDelete !== true
      ? { prepare: () => refused('widget_only') }
      : { lookups, prepare }),
  })));
}

export const memberAdapters = createMemberAdapters();
