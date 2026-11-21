import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

const preflights = {
  'video.make': { action: 'make', key: 'promo.video.busy' },
  'video.retry': { action: 'make', key: 'promo.video.busy' },
  'coupon.sendReachOut': { action: 'reach-out', key: 'groups.reachOut.eligibleCount' },
};
const videoStatuses = { 'video.markPosted': 'done', 'video.retry': 'failed' };
const preflightTool = 'get_promotion_preflight';
const refused = reason => ({ outcome: 'refused', reason });

function videoLookup({ intent, slots, searches }) {
  const querySlot = [intent.querySlot, 'videoId', 'videoQuery'].find(slot => slots.includes(slot)
    && searches.some(search => search.kind === 'promoVideo' && search.querySlot === slot && !search.cursor));
  return querySlot ? { name: 'search_records', args: { kind: 'promoVideo', querySlot } } : undefined;
}

function lookups(input) {
  if (input.layer === 'pos') return [];
  const { command } = input.intent;
  const lookup = videoStatuses[command] && videoLookup(input);
  if (videoStatuses[command] && !lookup) return [];
  const check = preflights[command];
  return [...(lookup ? [lookup] : []), ...(check ? [{ name: preflightTool, args: { action: check.action } }] : [])];
}

function videoIssue(input, read, status) {
  if (!videoLookup(input)) return refused('invalid_target');
  if (!['ready', 'missing'].includes(read?.status)) return refused('unavailable');
  const { match, choices } = resolveAgentTarget(read);
  if (!match) return choices.length ? { outcome: 'ambiguous', lookupIndex: 0, field: 'videoId' } : refused('invalid_target');
  if (match.handle !== input.intent.args.videoId.handle) return refused('invalid_target');
  if (status === 'done' && match.fields?.status === 'posted') return refused('duplicate');
  if (!match.fields?.status) return refused('unavailable');
  return match.fields.status === status ? undefined : refused('invalid_target');
}

function preflightIssue(input, read, check) {
  if (read?.status !== 'ready') return refused('unavailable');
  const facts = input.readings?.find(entry => entry.tool === preflightTool && entry.args.action === check.action)?.facts;
  const values = facts?.filter(fact => fact.key === check.key).map(fact => fact.value);
  if (values?.length !== 1 || !Number.isSafeInteger(values[0]) || values[0] < 0) return refused('unavailable');
  const [value] = values;
  if (check.action === 'make') return value === 0 ? undefined : refused('unavailable');
  return value > 0 ? undefined : refused('invalid_target');
}

function prepare({ input, reads }) {
  const { command, args } = input.intent;
  if (!validateAgentToolArgs('propose_action', { command, args })) return refused('invalid_target');
  if (input.layer === 'pos') return refused('out_of_scope');
  const status = videoStatuses[command], check = preflights[command];
  const issue = (status && videoIssue(input, reads[0], status))
    ?? (check && preflightIssue(input, reads[status ? 1 : 0], check));
  return issue ?? { outcome: 'ready', args };
}

// Proposal-only adapters. The browser owns local input validation and runs
// the same widget data command at the revision-checked card boundary.
export const promotionAdapters = Object.freeze([
  'promo.draft.set', 'video.make', 'video.retry', 'video.markPosted', 'coupon.sendReachOut',
].map(command => Object.freeze({ command, lookups, prepare })));
