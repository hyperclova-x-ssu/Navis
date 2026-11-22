import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

const targets = {
  'manuals.update': ['manual', 'manualId'],
  'manuals.setPublished': ['manual', 'manualId'],
  'manuals.delete': ['manual', 'manualId'],
  'manuals.toggleStep': ['manual', 'manualId'],
  'manuals.saveDraft': ['manualDraft', 'draftId'],
  'manuals.discardDraft': ['manualDraft', 'draftId'],
  'grants.apply': ['grantNotice', 'noticeId'],
  'grants.markReviewed': ['grantNotice', 'noticeId'],
  'grants.updateApplication': ['grantApplication', 'applicationId'],
  'grants.deleteApplication': ['grantApplication', 'applicationId'],
};

const refused = reason => ({ outcome: 'refused', reason });
const hasSearchResult = read => read?.status === 'ready' || read?.status === 'missing';

function lookups({ intent: { command, args, querySlot = 'name' }, slots }) {
  if (command === 'manuals.createDraftFromMemo') return [];
  const kind = command === 'manuals.create' ? 'manual' : targets[command][0];
  const slot = command === 'manuals.create' ? args?.title?.slot : querySlot;
  return slots.includes(slot) ? [{ name: 'search_records', args: { kind, querySlot: slot } }] : [];
}

function prepare({ input: { intent: { command, args } }, reads }) {
  if (!validateAgentToolArgs('propose_action', { command, args })) return refused('invalid_target');
  const ready = { outcome: 'ready', args };
  if (command === 'manuals.createDraftFromMemo') return ready;
  const [read] = reads;
  if (!hasSearchResult(read)) return refused('unavailable');
  if (command === 'manuals.create') {
    if (read.nextCursor) return refused('unavailable');
    return read.matches.some(match => match.match === 'exact') ? refused('duplicate') : ready;
  }

  const [, field] = targets[command];
  const { match, choices } = resolveAgentTarget(read);
  if (!match && choices.length) return { outcome: 'ambiguous', lookupIndex: 0, field };
  if (!match || match.handle !== args[field].handle) return refused('invalid_target');
  const fields = match.fields ?? {};

  if (command === 'manuals.setPublished') {
    if (fields.section === undefined || fields.published === undefined) return refused('unavailable');
    if (fields.section !== 'handover') return refused('invalid_target');
    if (!fields.published) return refused('duplicate');
  }
  if (command === 'manuals.toggleStep') {
    if (fields.checklist === undefined) return refused('unavailable');
    if (!fields.checklist) return refused('invalid_target');
    if (args.checked === undefined) return { outcome: 'clarify', field: 'checked' };
    // The local step slot stays opaque here. The browser preflight and the
    // shared data command check the actual step number and desired state.
  }
  if (command === 'grants.apply') {
    if (fields.applied) return refused('duplicate');
    if (fields.applied === undefined || fields.canApply === undefined) return refused('unavailable');
    if (!fields.canApply) return refused('invalid_target');
  }
  if (command === 'grants.markReviewed') {
    if (fields.reviewed === undefined) return refused('unavailable');
    if (fields.reviewed) return refused('duplicate');
  }
  if (command === 'grants.updateApplication' && args.status === fields.status && !Object.hasOwn(args, 'resultMemo')) {
    return refused('duplicate');
  }
  return ready;
}

export const manualsGrantsAdapters = Object.freeze([
  'manuals.create', 'manuals.createDraftFromMemo', ...Object.keys(targets),
].map(command => Object.freeze({ command, lookups, prepare })));
