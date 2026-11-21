import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

const field = 'changeId';
const kind = 'localChange';
const refused = reason => ({ outcome: 'refused', reason });

function lookupArgs({ intent, slots, searches }) {
  const querySlot = intent.querySlot ?? field;
  if (!slots.includes(querySlot) || !searches.some(search => search.kind === kind
    && search.querySlot === querySlot && !search.cursor)) return undefined;
  return { kind, querySlot };
}

export const localAdapters = Object.freeze([
  ['localChanges.acknowledge', false],
  ['localChanges.unacknowledge', true],
].map(([command, mustBeFolded]) => Object.freeze({
  command,
  lookups(input) {
    const args = lookupArgs(input);
    return args ? [{ name: 'search_records', args }] : [];
  },
  prepare({ input, reads }) {
    const { args } = input.intent;
    if (!validateAgentToolArgs('propose_action', { command, args }) || !lookupArgs(input)) return refused('invalid_target');
    const [read] = reads;
    if (read?.status === 'missing') return refused('invalid_target');
    if (read?.status !== 'ready') return refused('unavailable');

    const { match, choices } = resolveAgentTarget(read);
    if (!match) return choices.length ? { outcome: 'ambiguous', lookupIndex: 0, field } : refused('invalid_target');
    if (match.handle !== args.changeId.handle) return refused('invalid_target');
    if (typeof match.fields?.folded !== 'boolean') return refused('unavailable');
    if (match.fields.folded !== mustBeFolded) return refused('duplicate');
    return { outcome: 'ready', args };
  },
})));
