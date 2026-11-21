import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingAdapters } from './booking.mjs';
import { agentCommandPolicy, validateAgentRequest, validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';

const adapter = command => bookingAdapters.find(entry => entry.command === `booking.${command}`);
const draftInput = (command, args, extra = {}) => ({ slots: ['reservationId', 'q1', 'memberId', 'tableId'], intent: { kind: 'command', command: `booking.${command}`, args, ...extra } });
const ref = handle => ({ handle });
const target = { reservationId: ref('visit-a') };
const match = (fields, handle = 'visit-a') => ({ handle, fields, match: 'exact' });
const search = (...matches) => ({ status: 'ready', matches });
const visit = { kind: 'visit', date: '2026-11-17', time: '15:44', partySize: 2, status: 'confirmed', source: 'direct', visitStarted: true };
const run = (command, args, ...reads) => adapter(command).prepare({ input: draftInput(command, args), reads });

test('booking accepts visit transitions by scoped exact match and requires extra confirmation to cancel', () => {
  assert.deepEqual(run('cancel', target, search(match(visit))), { outcome: 'ready', args: target, tier: 'extra-confirm' });
  for (const command of ['markCompleted', 'markNoShow']) {
    assert.deepEqual(run(command, target, search(match(visit))), { outcome: 'ready', args: target });
    assert.deepEqual(run(command, target, search(match({ ...visit, visitStarted: false }))), { outcome: 'refused', reason: 'invalid_target' });
  }
  const waiting = { ...visit, status: 'needs-check', allocationWarning: 'SEAT_LIMIT' };
  assert.deepEqual(run('confirm', target, search(match(waiting))), { outcome: 'ready', args: target });
  assert.equal(run('confirm', target, search(match(visit))).outcome, 'refused');
  assert.equal(run('update', { ...target, patch: { request: null } }, search(match({ ...visit, status: 'canceled' }))).outcome, 'refused');
});

test('booking refuses mismatched and pickup handles and presents recorded choices when targets are ambiguous', () => {
  assert.equal(run('cancel', target, search(match({ ...visit, kind: 'pickup' }))).outcome, 'refused');
  assert.equal(run('cancel', target, search(match(visit, 'other'))).outcome, 'refused');
  assert.equal(run('cancel', target, search(match({ kind: 'visit' }))).outcome, 'refused');
  assert.deepEqual(run('cancel', target, search(match(visit), match(visit, 'other'))), {
    outcome: 'ambiguous', lookupIndex: 0, field: 'reservationId',
  });
});

test('booking scopes each referenced record and keeps draft values as local slot refs', () => {
  const args = { ...target, patch: { memberId: ref('member-a'), tableChoice: { tableId: ref('table-a') }, request: null } };
  const input = draftInput('update', args, { querySlot: 'q1' });
  const lookups = adapter('update').lookups(input);
  assert.deepEqual(lookups, [
    { name: 'search_records', args: { kind: 'reservation', querySlot: 'q1' } },
    { name: 'search_records', args: { kind: 'member', querySlot: 'memberId' } },
    { name: 'search_records', args: { kind: 'table', querySlot: 'tableId' } },
  ]);
  assert.equal(adapter('update').prepare({ input, reads: [search(match(visit))] }).outcome, 'refused');
  assert.deepEqual(adapter('update').prepare({ input, reads: [search(match(visit)), search(match({}, 'member-a')), search(match({}, 'table-a'))] }),
    { outcome: 'ready', args });
});

test('booking wire exposes only operational visit fields and suggestion is a widget handoff', () => {
  const request = { ...draftInput('cancel', target), runId: 'test-run', layer: 'management', snapshotRevision: 0,
    businessDate: visit.date, slots: ['reservationId'], catalog: [], snapshot: [], searches: [
      { kind: 'reservation', querySlot: 'reservationId', matches: [match(visit)] },
    ] };
  assert.ok(validateAgentRequest(request));
  assert.equal(validateAgentRequest({ ...request, searches: [{ ...request.searches[0], matches: [match({ ...visit, phone: '01012345678' })] }] }), false);
  assert.equal(agentCommandPolicy('booking.propose').policy, 'handoff');
  assert.equal(validateAgentToolArgs('propose_action', { command: 'booking.propose', args: { ...target, time: { slot: 'time' } } }), false);
  assert.equal(validateAgentToolArgs('propose_action', { command: 'booking.update', args: { ...target, patch: { request: '' } } }), false);
  assert.ok(validateAgentToolArgs('propose_action', { command: 'booking.update', args: { ...target, patch: { request: null } } }));
});
