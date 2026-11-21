import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAgentDetailRef, validateAgentNavigationWireArgs, validateAgentRequest, validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { createAgentDomainRegistry } from './registry.mjs';

const slot = slot => ({ slot });
const handle = handle => ({ handle });
const exact = (handle, fields) => ({ handle, match: 'exact', fields });
const ready = (...matches) => ({ status: 'ready', matches });
const lookup = (kind, querySlot) => ({ name: 'search_records', args: { kind, querySlot } });
const request = (command, args, searches = [], querySlot) => ({
  runId: 'n14-test', snapshotRevision: 0, businessDate: '2026-11-17', layer: 'management', locale: 'ko',
  slots: ['name', 'title', 'memo', 'stepChange'], catalog: [], snapshot: [], searches,
  intent: { kind: 'command', command, args, ...(querySlot && { querySlot }) },
});
const refused = reason => ({ outcome: 'refused', reason });

function adapter(command) {
  const registered = createAgentDomainRegistry().get(command);
  assert.ok(registered, `Missing ${command} adapter`);
  return registered;
}

test('checklist proposals require the named checklist and an explicit desired state', () => {
  const command = 'manuals.toggleStep';
  const args = { manualId: handle('opening'), stepNo: slot('stepChange'), checked: true };
  const opening = exact('opening', { section: 'handover', checklist: true, stepNumbers: [1, 2], checkedSteps: [1] });
  const input = request(command, args, [{ kind: 'manual', querySlot: 'name', matches: [opening] }]);
  assert.equal(validateAgentRequest(input), true);
  const legacyArgs = { manualId: args.manualId, stepNo: args.stepNo };
  assert.equal(validateAgentToolArgs('propose_action', { command, args: legacyArgs }), true);
  assert.deepEqual(adapter(command).lookups(input), [lookup('manual', 'name')]);
  const prepare = (args, match = opening) => adapter(command).prepare({ input: request(command, args), reads: [ready(match)] });
  assert.deepEqual(prepare(args), { outcome: 'ready', args });
  assert.deepEqual(prepare(legacyArgs), { outcome: 'clarify', field: 'checked' });
  assert.deepEqual(prepare(args, exact('opening', { ...opening.fields, checklist: false })), refused('invalid_target'));
  assert.deepEqual(prepare(args, exact('closing', opening.fields)), refused('invalid_target'));
});

test('D-326 requires extra confirmation to unpublish one currently published manual', () => {
  const command = 'manuals.setPublished';
  const args = { manualId: handle('opening'), published: false };
  const match = exact('opening', { published: true });
  const input = request(command, args, [{ kind: 'manual', querySlot: 'name', matches: [match] }]);
  assert.ok(validateAgentRequest(input));
  assert.deepEqual(adapter(command).lookups(input), [lookup('manual', 'name')]);
  const prepare = fields => adapter(command).prepare({ input, reads: [ready(exact('opening', fields))] });
  assert.deepEqual(prepare(match.fields), { outcome: 'ready', args });
  assert.deepEqual(prepare({ published: false }), refused('duplicate'));
  assert.deepEqual(prepare({}), refused('unavailable'));
  assert.equal(validateAgentToolArgs('propose_action', { command, args: { ...args, published: true } }), false);
});

test('grant application cards require a current local window and no existing record', () => {
  const command = 'grants.apply';
  const args = { noticeId: handle('grant') };
  const grant = exact('grant', { canApply: true, applied: false });
  const input = request(command, args, [{ kind: 'grantNotice', querySlot: 'name', matches: [grant] }]);
  assert.equal(validateAgentRequest(input), true);
  const prepare = match => adapter(command).prepare({ input, reads: [ready(match)] });
  assert.deepEqual(prepare(grant), { outcome: 'ready', args });
  assert.deepEqual(prepare(exact('grant', { canApply: false, applied: false })), refused('invalid_target'));
  assert.deepEqual(prepare(exact('grant', { canApply: false, applied: true })), refused('duplicate'));
  assert.deepEqual(prepare(exact('grant', { applied: false })), refused('unavailable'));
});

test('draft creation requires only a memo slot and saving or discarding requires the active draft handle', () => {
  const create = 'manuals.createDraftFromMemo';
  const args = { memo: slot('memo'), section: 'handover' };
  assert.deepEqual(adapter(create).prepare({ input: request(create, args), reads: [] }), { outcome: 'ready', args });
  for (const command of ['manuals.saveDraft', 'manuals.discardDraft']) {
    const args = { draftId: handle('draft') };
    const input = request(command, args, [], 'title');
    assert.deepEqual(adapter(command).lookups(input), [lookup('manualDraft', 'title')]);
    assert.deepEqual(adapter(command).prepare({ input, reads: [ready(exact('draft', { section: 'handover' }))] }), { outcome: 'ready', args });
    assert.deepEqual(adapter(command).prepare({ input, reads: [{ status: 'missing', matches: [] }] }), refused('invalid_target'));
  }
});

test('manual creation refuses an exact existing title but permits a similar title', () => {
  const command = 'manuals.create';
  const args = { title: slot('title'), section: 'handover', category: 'cleaning', steps: slot('memo') };
  const input = request(command, args);
  assert.deepEqual(adapter(command).lookups(input), [lookup('manual', 'title')]);
  assert.deepEqual(adapter(command).prepare({ input, reads: [ready({ handle: 'other', match: 'similar' })] }), { outcome: 'ready', args });
  assert.deepEqual(adapter(command).prepare({ input, reads: [ready(exact('same', {}))] }), refused('duplicate'));
});

test('an ambiguous target is surfaced before a delete can be proposed', () => {
  const command = 'manuals.delete';
  const input = request(command, { manualId: handle('opening') });
  assert.deepEqual(adapter(command).prepare({ input, reads: [ready(exact('opening', {}), exact('closing', {}))] }),
    { outcome: 'ambiguous', lookupIndex: 0, field: 'manualId' });
});

test('grant draft navigation allows an unsaved bounded body on the template tab', () => {
  const template = { featureId: 'grants', view: 'template', focus: 'action' };
  assert.equal(validateAgentDetailRef({ ...template, itemId: 'notice', prefill: { body: '검토할 내용' } }), true);
  assert.equal(validateAgentNavigationWireArgs('ui.openDetail', { ...template, itemId: handle('notice'), prefill: { body: slot('body') } }), true);
  assert.equal(validateAgentDetailRef({ ...template, prefill: { body: '가'.repeat(901) } }), false);
  assert.equal(validateAgentDetailRef({ ...template, view: 'applications', prefill: { body: '검토할 내용' } }), false);
});
