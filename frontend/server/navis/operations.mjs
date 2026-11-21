import { isDeepStrictEqual } from 'node:util';
import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

const commands = [
  'environment.setPlaying', 'environment.skipTrack', 'environment.selectPlaylist',
  'environment.selectTrack', 'environment.setVolume', 'cctv.markPeakForReview',
  'ui.setCctvMode', 'ui.acknowledgeBriefing',
];
const refused = reason => ({ outcome: 'refused', reason });
const ready = args => ({ outcome: 'ready', args });

function projectedFact(reading, key) {
  const values = reading?.facts?.filter(fact => fact.key === key) ?? [];
  return values.length === 1 ? values[0].value : undefined;
}

function reviewPreflight(input) {
  const { args } = input.intent;
  const reading = input.readings?.find(entry => entry.tool === 'get_cctv_review' && isDeepStrictEqual(entry.args, args));
  if (!reading?.facts) return refused('unavailable');
  const date = projectedFact(reading, 'cctv.review.date');
  const hour = projectedFact(reading, 'cctv.review.hour');
  const status = projectedFact(reading, 'cctv.review.status');
  if (date !== input.businessDate || !Number.isInteger(hour) || hour < 0 || hour > 23) return refused('invalid_target');
  if (status === 'marked') return refused('duplicate');
  return status === 'open' ? ready(args) : refused('invalid_target');
}

function targets({ intent: { args = {}, querySlot }, searches, slots }) {
  return [['trackId', 'track'], ['playlistId', 'playlist']].flatMap(([field, kind]) => {
    if (!args[field]) return [];
    const slot = [querySlot, `${kind}Query`, field].find(candidate => slots.includes(candidate)
      && searches.some(search => search.kind === kind && search.querySlot === candidate && !search.cursor));
    return [{ field, kind, slot }];
  });
}

function prepare({ input, reads = [] }) {
  const { command, args } = input.intent;
  if (!validateAgentToolArgs('propose_action', { command, args })) return refused('invalid_target');
  if (input.layer === 'pos') return refused('out_of_scope');
  if (command === 'cctv.markPeakForReview') return reviewPreflight(input);
  if (command === 'ui.acknowledgeBriefing') return ready(args);

  const display = input.readings?.find(reading => reading.tool === 'get_ui_state' && reading.args.section === 'display');
  if (command === 'ui.setCctvMode') {
    if (!['mock', 'live'].includes(projectedFact(display, 'cctv.mode'))) return refused('unavailable');
    if (args.mode === 'live' && projectedFact(display, 'cctv.mode.liveAvailable') !== 1) return refused('unavailable');
    return ready(args);
  }

  if (projectedFact(display, 'music.device.status') !== 'connected') return refused('unavailable');
  if (['environment.setPlaying', 'environment.skipTrack'].includes(command)
    && projectedFact(display, 'music.track.ready') !== 1) return refused('unavailable');

  for (const [lookupIndex, { field, kind, slot }] of targets(input).entries()) {
    if (!slot) return refused('invalid_target');
    const read = reads[lookupIndex];
    if (!['ready', 'missing'].includes(read?.status)) return refused('unavailable');
    const { match, choices } = resolveAgentTarget(read);
    if (!match) return choices.length ? { outcome: 'ambiguous', lookupIndex, field } : refused('invalid_target');
    if (match.handle !== args[field].handle) return refused('invalid_target');
    if (kind === 'playlist' && match.fields?.hasTracks !== true) return refused('unavailable');
  }
  return ready(args);
}

export const operationAdapters = Object.freeze(commands.map(command => Object.freeze({
  command,
  lookups(input) {
    const requested = targets(input);
    return requested.every(target => target.slot)
      ? requested.map(({ kind, slot }) => ({ name: 'search_records', args: { kind, querySlot: slot } })) : [];
  },
  prepare,
})));
