import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentDomainRegistry } from './registry.mjs';
import { validateAgentRequest } from '../../shared/navis-agent-schema.mjs';

const slot = slot => ({ slot });
const handle = handle => ({ handle });
const exact = (handle, fields) => ({ handle, match: 'exact', ...(fields && { fields }) });
const ready = (...matches) => ({ status: 'ready', matches });
const missing = { status: 'missing', matches: [] };
const search = (kind, querySlot, ...matches) => ({ kind, querySlot, matches });
const lookup = (kind, querySlot) => ({ name: 'search_records', args: { kind, querySlot } });
const member = exact('member-a');
const note = exact('note-a', { ownerHandle: 'member-a' });
const memberArgs = { memberId: handle(member.handle) };
const input = (command, args, searches = []) => ({
  runId: 'fixture', snapshotRevision: 1, businessDate: '2026-11-17', layer: 'management',
  slots: ['memberQuery', 'noteQuery', 'name', 'phone', 'memo'], catalog: [], snapshot: [], searches,
  intent: { kind: 'command', command, args },
});
function registered(command) {
  const adapter = createAgentDomainRegistry().get(command);
  assert.ok(adapter, `${command} should have a member adapter`);
  return adapter;
}

test('member registration requires an authoritative full-phone lookup before proposing', () => {
  const command = 'members.create';
  const args = { name: slot('name'), phone: slot('phone') };
  const adapter = registered(command);
  const request = input(command, args);
  assert.deepEqual(adapter.lookups(request), [lookup('member', 'memberQuery')]);
  assert.deepEqual(adapter.prepare({ input: request, reads: [missing] }), { outcome: 'ready', args });
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(member)] }), { outcome: 'refused', reason: 'duplicate' });
  assert.deepEqual(adapter.prepare({ input: request, reads: [] }), { outcome: 'refused', reason: 'unavailable' });
});

test('changing a phone permits a self match and blocks a different holder', () => {
  const command = 'members.update';
  const args = { ...memberArgs, phone: slot('phone') };
  const adapter = registered(command);
  const request = input(command, args);
  assert.deepEqual(adapter.lookups(request), [lookup('member', 'memberQuery'), lookup('member', 'phone')]);
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(member), ready(member)] }), { outcome: 'ready', args });
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(member), ready(exact('other-holder'))] }),
    { outcome: 'refused', reason: 'duplicate' });
});

test('a note proposal needs an exact note whose owner matches the scoped member handle', () => {
  const command = 'members.updateNote';
  const args = { ...memberArgs, noteId: handle(note.handle), body: slot('memo') };
  const request = input(command, args, [search('member', 'memberQuery', member), search('note', 'noteQuery', note)]);
  assert.equal(validateAgentRequest(request), true);
  const adapter = registered(command);
  assert.deepEqual(adapter.lookups(request), [lookup('member', 'memberQuery'), lookup('note', 'noteQuery')]);
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(member), ready(note)] }), { outcome: 'ready', args });
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(member), ready(exact(note.handle, { ownerHandle: 'wrong' }))] }),
    { outcome: 'refused', reason: 'invalid_target' });
});

test('member archive requires a current clear blocker result in the default registry', async () => {
  const command = 'members.delete';
  const existing = registered(command);
  const { createMemberAdapters } = await import('./members.mjs');
  const disabled = createMemberAdapters({ allowMemberDelete: false }).find(adapter => adapter.command === command);
  assert.deepEqual(disabled.prepare({}), { outcome: 'refused', reason: 'widget_only' });
  const request = input(command, memberArgs);
  assert.deepEqual(existing.prepare({ input: request, reads: [ready(member)] }), { outcome: 'refused', reason: 'unavailable' });
  const blocked = exact(member.handle, { deleteBlocked: true });
  assert.equal(validateAgentRequest(input(command, memberArgs, [search('member', 'memberQuery', blocked)])), true);
  assert.deepEqual(existing.prepare({ input: request, reads: [ready(blocked)] }), { outcome: 'refused', reason: 'invalid_target' });
  assert.deepEqual(existing.prepare({ input: request, reads: [ready(exact(member.handle, { deleteBlocked: false }))] }),
    { outcome: 'ready', args: memberArgs });
});

test('booking can bind the member query independently of the visit query', () => {
  const command = 'booking.update';
  const args = { reservationId: handle('visit-a'), patch: memberArgs };
  const request = input(command, args);
  request.slots.push('reservationId');
  const adapter = registered(command);
  assert.deepEqual(adapter.lookups(request), [lookup('reservation', 'reservationId'), lookup('member', 'memberQuery')]);
  const visit = exact('visit-a', { kind: 'visit', status: 'confirmed' });
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(visit), ready(member)] }), { outcome: 'ready', args });
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(visit), ready(exact('other-member'))] }),
    { outcome: 'refused', reason: 'invalid_target' });
});
