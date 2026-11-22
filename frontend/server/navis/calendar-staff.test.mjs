import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness } from '../fixtures/navis-eval-fake.mjs';
import { agentCommandRefs, validateAgentCommandArgs, validateAgentFrame, validateAgentNavigationArgs, validateAgentPrefill, validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { createCalendarStaffAdapters } from './calendar-staff.mjs';

const condition = { kind: 'default' };
const catalog = [
  { id: 'calendar', name: '캘린더', layer: 'management', conditions: [condition] },
  { id: 'staff-schedule', name: '근무표', layer: 'management', conditions: [condition] },
];
const slot = name => ({ slot: name });
const handle = value => ({ handle: value });
const search = (kind, querySlot, ref, fields) => ({ kind, querySlot, matches: [{ handle: ref, match: 'exact', fields }] });
const shift = fields => search('shift', 'name', 'shift1', fields);
const staff = search('staff', 'staffId', 'staff1', {});
const event = (source, closure = false) => search('event', 'name', 'event1', {
  source, closure, date: '2026-11-17', kind: 'event', linkedDraftCount: closure ? 1 : 0,
});

async function command(command, args, searches = [], policy) {
  const bridge = policy ? options => createBridge({ ...options, agentAdapters: createCalendarStaffAdapters(policy) }) : createBridge;
  const harness = createNavisMenuHarness(bridge, validateAgentFrame);
  try {
    return await harness.run({
      runId: 'n10-fixture', snapshotRevision: 3, businessDate: '2026-11-17', layer: 'management', locale: 'ko', catalog,
      intent: { kind: 'command', command, args },
      slots: [...new Set([...searches.map(item => item.querySlot), ...agentCommandRefs(command, args).flatMap(ref => ref.slot ?? [])])],
      searches, snapshot: [],
    });
  } finally {
    harness.close();
  }
}

test('N10 keeps historical and duplicate intent local and validates staff detail orientation', () => {
  const args = { title: slot('title'), date: slot('date'), dateIntent: slot('dateIntent'), confirmDuplicate: slot('confirmDuplicate') };
  assert.equal(validateAgentToolArgs('propose_action', { command: 'calendar.addEvent', args }), true);
  assert.equal(validateAgentToolArgs('propose_action', { command: 'calendar.addEvent', args: { ...args, dateIntent: 'historical' } }), false);
  assert.equal(validateAgentToolArgs('propose_action', { command: 'calendar.addEvent', args: { ...args, confirmDuplicate: true } }), false);
  assert.equal(validateAgentPrefill('staff-schedule', { orientation: 'employee' }), true);
  assert.equal(validateAgentPrefill('staff-schedule', { orientation: 'month' }), false);
});

test('N10 accepts a café shift identifier after an opaque handle resolves locally', () => {
  const scheduleId = 'sample-shift:sample-staff-1:2026-11-17:08:00';
  assert.equal(validateAgentCommandArgs('staff.deleteSchedule', { scheduleId }), true);
  assert.equal(validateAgentNavigationArgs('ui.openDetail', { featureId: 'staff-schedule', view: 'week', itemId: scheduleId }), true);
  assert.equal(validateAgentToolArgs('propose_action', { command: 'staff.deleteSchedule', args: { scheduleId } }), false);
});

test('N10 prepares an ordinary event only from local slot references', async () => {
  const args = { title: slot('title'), date: slot('date'), time: slot('time') };
  const result = await command('calendar.addEvent', args);
  assert.deepEqual(result.proposal?.args, args);
  assert.equal(result.proposal?.tier, 'normal');
  assert.equal(result.proposal?.snapshotRevision, 3);
});

test('N10 historical intent uses the dedicated local choice slot', async () => {
  const args = { title: slot('title'), date: slot('date'), dateIntent: slot('title') };
  const alias = await command('calendar.addEvent', args);
  assert.equal(alias.terminal?.clarification?.field, 'dateIntent', alias.raw);
  assert.equal(alias.proposal, undefined);
  const chosen = { ...args, dateIntent: slot('dateIntent') };
  const result = await command('calendar.addEvent', chosen);
  assert.deepEqual(result.proposal?.args, chosen, result.raw);
});

test('N10 keeps date, clock and closure end bound to their own slots', async () => {
  const base = { title: slot('title'), date: slot('date'), time: slot('time') };
  const cases = [
    ['date', { ...base, date: slot('time') }],
    ['time', { ...base, time: slot('fromTime') }],
    ['storeClosure', { ...base, storeClosure: { kind: 'temporary', endDate: slot('date') } }],
  ];
  for (const [field, args] of cases) {
    const result = await command('calendar.addEvent', args);
    assert.equal(result.terminal?.clarification?.field, field, result.raw);
    assert.equal(result.proposal, undefined);
  }
});

test('N10 reads the staff widget before moving a handoff', async () => {
  const args = { date: slot('date'), fromTime: slot('fromTime'), toTime: slot('toTime') };
  const result = await command('staff.moveHandoff', args);
  assert.deepEqual(result.calls, [
    { name: 'get_widget', args: { featureId: 'staff-schedule', condition } },
    { name: 'propose_action', args: { command: 'staff.moveHandoff', args } },
  ], result.raw);
  assert.equal(result.proposal?.tier, 'normal', result.raw);
});

test('N10 creates a fresh staff card without emitting an empty lookup', async () => {
  const args = { name: slot('name') };
  const fresh = { kind: 'staff', querySlot: 'name', status: 'missing', matches: [] };
  const created = await command('staff.create', args, [fresh]);
  assert.deepEqual(created.calls, [{ name: 'propose_action', args: { command: 'staff.create', args } }], created.raw);
  const duplicate = await command('staff.create', args, [search('staff', 'name', 'existing', {})]);
  assert.equal(duplicate.proposal, undefined);
  assert.equal(duplicate.terminal?.refusal?.reason, 'duplicate', duplicate.raw);
});

test('N10 allows direct event and shift deletion while computed events and staff profiles remain blocked', async () => {
  const args = { eventId: handle('event1') };
  const direct = await command('calendar.deleteEvent', args, [event('direct')]);
  assert.equal(direct.proposal?.tier, 'extra-confirm', direct.raw);
  const shiftDelete = await command('staff.deleteSchedule', { scheduleId: handle('shift1') }, [shift({ kind: 'work' })]);
  assert.equal(shiftDelete.proposal?.tier, 'extra-confirm', shiftDelete.raw);
  for (const [type, payload, fields, reason] of [
    ['calendar.updateEvent', { ...args, time: slot('time') }, event('delivery'), 'invalid_target'],
    ['staff.delete', { staffId: handle('staff1'), cascadeSchedules: true }, staff, 'widget_only'],
  ]) {
    const result = await command(type, payload, [fields]);
    assert.equal(result.proposal, undefined);
    assert.equal(result.terminal?.refusal?.reason, reason, result.raw);
  }
  const profile = await command('staff.delete', { staffId: handle('staff1'), cascadeSchedules: true }, [staff], { allowSingleDeletes: true });
  assert.equal(profile.terminal?.refusal?.reason, 'widget_only', profile.raw);
  assert.equal(profile.proposal, undefined);
});

test('N10 offers closure creation and editing by default and retains the trusted opt-out', async () => {
  const draft = { title: slot('title'), date: slot('date'), storeClosure: { kind: 'temporary', endDate: slot('endDate') } };
  const closed = await command('calendar.addEvent', draft, [], { allowClosureWrites: false });
  assert.equal(closed.terminal?.refusal?.reason, 'widget_only', closed.raw);
  const enabled = await command('calendar.addEvent', draft);
  assert.deepEqual(enabled.proposal?.args, draft, enabled.raw);
  const args = { eventId: handle('event1') };
  const closure = [event('direct', true)];
  const edit = await command('calendar.updateEvent', { ...args, time: slot('time') }, closure);
  assert.equal(edit.proposal?.tier, 'normal', edit.raw);
  const removeClosure = await command('calendar.updateEvent', { ...args, storeClosure: null }, closure);
  assert.equal(removeClosure.proposal?.tier, 'extra-confirm', removeClosure.raw);
  const partial = await command('calendar.deleteEvent', args, closure, { allowClosureWrites: false });
  assert.equal(partial.terminal?.refusal?.reason, 'widget_only', partial.raw);
  const result = await command('calendar.deleteEvent', args, closure);
  assert.equal(result.proposal?.tier, 'extra-confirm', result.raw);
});

test('N10 requires extra confirmation when replacing an existing work shift with off', async () => {
  const args = { staffId: handle('staff1'), scheduleId: handle('shift1'), date: slot('date'), kind: 'off' };
  const result = await command('staff.saveSchedule', args, [
    staff, shift({ date: '2026-11-17', kind: 'work', start: '08:00', end: '16:30', breakMinutes: 0 }),
  ]);
  assert.deepEqual(result.proposal?.args, args);
  assert.equal(result.proposal?.tier, 'extra-confirm');
});

test('N10 checks a selected event handle against the intended lookup', async () => {
  const result = await command('calendar.updateEvent', { eventId: handle('different'), time: slot('time') }, [
    { ...event('direct'), matches: [...event('direct').matches, { handle: 'different', match: 'similar' }] },
  ]);
  assert.equal(result.proposal, undefined);
  assert.equal(result.terminal?.refusal?.reason, 'invalid_target', result.raw);
});
