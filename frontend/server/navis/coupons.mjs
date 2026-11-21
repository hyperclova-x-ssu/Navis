import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

const coupon = { kind: 'coupon', field: 'couponId', alias: 'couponQuery' };
const code = { kind: 'couponCode', field: 'codeId', alias: 'codeQuery' };
const targets = {
  'coupon.sendSlot': { kind: 'slot', field: 'slotId', alias: 'slotQuery' },
  'coupon.notifyEnding': coupon,
  'coupon.markPosted': code,
  'coupon.createExpiry': { kind: 'stock', field: 'itemId', alias: 'itemQuery' },
  'coupon.update': coupon,
  'coupon.endEarly': coupon,
  'coupon.unpublish': code,
  'coupon.pause': coupon,
  'coupon.resume': coupon,
  'coupon.extend': coupon,
};
const refuse = reason => ({ outcome: 'refused', reason });

function lookup(input, { kind, field, alias }) {
  if (!input.intent.args?.[field]) return [];
  const querySlot = [input.intent.querySlot, field, alias].find(slot => input.slots.includes(slot)
    && input.searches.some(search => search.kind === kind && search.querySlot === slot && !search.cursor));
  return querySlot ? [{ name: 'search_records', args: { kind, querySlot } }] : [];
}

function targetIssue(command, fields) {
  if (command === 'coupon.createExpiry') {
    if (fields?.expiryHandled === true) return 'duplicate';
    if (fields?.expiryHandled !== false || typeof fields.expiryEligible !== 'boolean') return 'unavailable';
    return fields.expiryEligible ? undefined : 'invalid_target';
  }
  if (command === 'coupon.unpublish') {
    if (fields?.route === undefined || typeof fields.activated !== 'boolean' || typeof fields.unpublished !== 'boolean') return 'unavailable';
    if (fields.unpublished) return 'duplicate';
    return fields.route === 'place_news' && fields.activated ? undefined : 'invalid_target';
  }
  if (command === 'coupon.sendSlot') {
    if (fields?.handled === true) return 'duplicate';
    if (fields?.handled !== false || !Number.isSafeInteger(fields.recipientCount)) return 'unavailable';
    return fields.recipientCount > 0 ? undefined : 'invalid_target';
  }
  if (command === 'coupon.markPosted') {
    if (fields?.route === undefined) return 'unavailable';
    if (fields.route !== 'place_news') return 'invalid_target';
    if (fields.activated === true || fields.unpublished === true) return 'duplicate';
    if (fields.activated !== false || typeof fields.eligible !== 'boolean') return 'unavailable';
    return fields.eligible ? undefined : 'invalid_target';
  }
  if (!['active', 'paused', 'ended'].includes(fields?.status)) return 'unavailable';
  if (fields.status === 'ended') return 'invalid_target';
  if (command === 'coupon.pause') return fields.status === 'active' ? undefined : 'duplicate';
  if (command === 'coupon.resume') return fields.status === 'paused' ? undefined : 'duplicate';
  if (command === 'coupon.notifyEnding') {
    if (fields.status !== 'active' || fields.endingSoon === false) return 'invalid_target';
    if (fields.endingSoon !== true || !Number.isSafeInteger(fields.reminderRecipients)) return 'unavailable';
    return fields.reminderRecipients > 0 ? undefined : 'invalid_target';
  }
  return undefined;
}

function prepare({ input, reads }, target) {
  const { command, args } = input.intent;
  if (!validateAgentToolArgs('propose_action', { command, args })) return refuse('invalid_target');
  if (!lookup(input, target).length) return refuse('invalid_target');
  const [read] = reads;
  if (!['ready', 'missing'].includes(read?.status)) return refuse('unavailable');
  const { match, choices } = resolveAgentTarget(read);
  if (!match) return choices.length ? { outcome: 'ambiguous', lookupIndex: 0, field: target.field } : refuse('invalid_target');
  if (match.handle !== args[target.field].handle) return refuse('invalid_target');
  const issue = targetIssue(command, match.fields);
  return issue ? refuse(issue) : { outcome: 'ready', args };
}

// These adapters accept only scoped operational evidence. Recipient selection,
// content preview, and execution remain at the existing local action boundary.
export const couponAdapters = Object.freeze(Object.entries(targets).map(([command, target]) => Object.freeze({
  command,
  lookups: input => lookup(input, target),
  prepare: context => prepare(context, target),
})));
