import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

const commands = ['notice.saveDraft', 'notice.importClosure', 'notice.deleteDraft', 'notice.send'];
const refused = reason => ({ outcome: 'refused', reason });

function targets(input) {
  const { intent: { command, args, querySlot }, slots, searches } = input;
  const fields = [
    ['noticeId', 'noticeDraft', ['noticeQuery']],
    [command === 'notice.saveDraft' ? 'closureEventId' : 'eventId', 'event', ['eventQuery', 'closureQuery']],
  ];
  return fields.filter(([field]) => args?.[field]).map(([field, kind, aliases]) => {
    const candidates = [querySlot, field, ...aliases];
    const slot = candidates.find(candidate => slots.includes(candidate)
      && searches.some(search => search.kind === kind && search.querySlot === candidate && !search.cursor));
    return { field, kind, slot };
  });
}

function prepare({ input, reads }) {
  const { command, args } = input.intent;
  if (!validateAgentToolArgs('propose_action', { command, args })) return refused('invalid_target');

  const resolved = new Map();
  let index = 0;
  for (const { field, slot } of targets(input)) {
    if (!slot) return refused('invalid_target');
    const read = reads[index];
    if (!['ready', 'missing'].includes(read?.status)) return refused('unavailable');
    const { match, choices } = resolveAgentTarget(read);
    if (!match) return choices.length ? { outcome: 'ambiguous', lookupIndex: index, field } : refused('invalid_target');
    if (match.handle !== args[field].handle) return refused('invalid_target');
    resolved.set(field, match.fields);
    index++;
  }

  const closure = resolved.get(command === 'notice.saveDraft' ? 'closureEventId' : 'eventId');
  if ((args.eventId || args.closureEventId) && (closure?.source !== 'direct' || closure.closure !== true)) {
    return refused('invalid_target');
  }
  if (command === 'notice.send') {
    const draft = resolved.get('noticeId');
    if (!Number.isSafeInteger(draft?.revision) || draft.revision < 1) return refused('unavailable');
    if (draft.alreadySent === true) return refused('duplicate');
    // The browser validates the exact scheduled time in its private slot.
    const allowed = draft.sendAllowed === true || !!args.sendAt && draft.scheduleAllowed === true;
    if (!allowed || draft.alreadySent !== false || !['none', 'current'].includes(draft.closureLink)) {
      return refused('invalid_target');
    }
  }
  return { outcome: 'ready', args };
}

export const noticeAdapters = Object.freeze(commands.map(command => Object.freeze({
  command,
  lookups(input) {
    return targets(input).flatMap(({ kind, slot }) => slot ? [{ name: 'search_records', args: { kind, querySlot: slot } }] : []);
  },
  prepare,
})));
