import assert from 'node:assert/strict';
import test from 'node:test';
import { URL, fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createBridge } from '../bridge.mjs';
import { runNavisBookingFixture } from '../fixtures/navis-eval-fake.mjs';
import * as schema from '../../shared/navis-agent-schema.mjs';
import { readCafeScenarios, readTrace } from './scenario-fixtures.mjs';

const dependencies = readTrace().filter(row => row.required_slices.split('|').includes('N06'));
const assigned = dependencies.filter(row => row.slice_id === 'N06');
const defaultCondition = { kind: 'default' };
const dateRange = date => ({ kind: 'dateRange', start: date, end: date });
const slot = name => ({ slot: name });
const handle = name => ({ handle: name });
const lookup = (kind, querySlot) => ({ name: 'search_records', args: { kind, querySlot } });
const booking = (type, args) => ({ type: `booking.${type}`, ...args });
const createWire = { guest: { name: slot('name') }, date: slot('date'), time: slot('time'), partySize: slot('partySize'), tableChoice: 'auto' };

const vite = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)),
  configFile: false, envFile: false, logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false } });
let data, addDays, allocateReservation, slotHasPassed, tr, bookingDomain, corpus, assistantDomains, projectAgentSearch;
try {
  data = await vite.ssrLoadModule('/src/data/widget-data.ts');
  ({ addDays } = await vite.ssrLoadModule('/src/data/db/time.ts'));
  ({ allocateReservation } = await vite.ssrLoadModule('/src/data/derive/reservations.ts'));
  ({ slotHasPassed } = await vite.ssrLoadModule('/src/data/commands/business-clock.ts'));
  tr = (await vite.ssrLoadModule('/src/features/assistant/messages.ts')).navisTranslator('ko');
  ({ bookingDomain } = await vite.ssrLoadModule('/src/features/assistant/domains/booking.ts'));
  ({ assistantDomains, projectAgentSearch } = await vite.ssrLoadModule('/src/features/assistant/snapshot.ts'));
  ({ corpus } = await readCafeScenarios(vite));
} finally {
  await vite.close();
}
const { TODAY, createWidgetDataStore, selectReservations, selectCalendar, selectBriefing, selectMembers, readModel, tableLayoutEnabled } = data;
const tomorrow = addDays(TODAY, 1), saturday = addDays(TODAY, 4);
const todayRows = snapshot => selectReservations(snapshot, { date: TODAY });
const visitRows = snapshot => snapshot.tables.reservation.filter(row => row.kind !== 'pickup' && !row.variant);
const conditionCatalog = [{ id: 'voice-booking', name: '예약', layer: 'management', conditions: [defaultCondition, dateRange(tomorrow), dateRange(saturday)] }];
const fact = (key, value, display, label = tr.t('data.fact.booking.today.count')) => ({ key, value, unit: '', display, label });
const party = count => tr.format.quantity(count, 'person');
const count = total => tr.format.quantity(total, 'reservation');
const run = (snapshot, intent, { slots = [], searches = [], facts = [], readings = [] } = {}, calls = [], reply) => runNavisBookingFixture(
  createBridge, schema.validateAgentFrame, { runId: snapshot.runId, snapshotRevision: snapshot.revision,
    businessDate: TODAY, layer: 'management', catalog: conditionCatalog, intent, slots, searches, snapshot: facts, readings }, calls, reply,
);
function searchProjection(kind, querySlot, matches) { return { kind, querySlot, matches }; }
function visitMatch(row, id = 'visit-target') {
  const { date, time, status, source, partySize, allocationWarning } = row;
  return { handle: id, match: 'exact', fields: { kind: 'visit', date, time, status, source, partySize,
    ...(allocationWarning ? { allocationWarning } : {}), visitStarted: slotHasPassed(date, time) } };
}
async function widgetRead(snapshot, condition, facts) {
  const scope = { featureId: 'voice-booking', condition };
  const result = await run(snapshot, { kind: 'read', ...scope }, { facts: [{ ...scope, facts }] },
    [{ name: 'get_widget', args: scope }], { outcome: 'reply', facts: facts.map((_, index) => `f${index}`) });
  assert.equal(result.done.outcome, 'reply');
  for (const { display } of facts) assert.ok(result.text.includes(display), display);
  return result.text;
}
async function readSearch(snapshot, matches = [], querySlot = 'q1') {
  const call = lookup('reservation', querySlot);
  return run(snapshot, { kind: 'read', recordKind: 'reservation', querySlot },
    { slots: [querySlot], searches: [searchProjection('reservation', querySlot, matches)] }, [call]);
}
function localResult(store, command) {
  const before = store.getSnapshot();
  const result = store.dispatch({ ...command, baseRevision: before.revision });
  if (!result.ok) assert.equal(store.getSnapshot(), before);
  return result;
}
function accepted(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function proposed(store, type, args, searches = []) {
  const before = store.getSnapshot();
  const command = `booking.${type}`;
  const slots = [...new Set([...searches.map(entry => entry.querySlot), ...schema.agentCommandRefs(command, args).flatMap(ref => ref.slot ?? [])])];
  const calls = [...searches.map(({ kind, querySlot }) => lookup(kind, querySlot)), { name: 'propose_action', args: { command, args } }];
  const result = await run(before, { kind: 'command', command, args }, { slots, searches }, calls);
  assert.equal(result.done.outcome, 'proposal');
  const { revision, runId } = before;
  assert.deepEqual({ ...result.proposal, proposalId: 'fixture' }, { command, args, snapshotRevision: revision,
    runId, proposalId: 'fixture', layer: 'management', tier: type === 'cancel' ? 'extra-confirm' : 'normal' });
  assert.equal(store.getSnapshot(), before);
  return result.proposal;
}
async function clarifyCreate(store, args, field) {
  const before = store.getSnapshot();
  const slots = schema.agentCommandRefs('booking.create', args).flatMap(ref => ref.slot ?? []);
  const result = await run(before, { kind: 'command', command: 'booking.create', args }, { slots });
  assert.equal(result.done.outcome, 'clarify');
  assert.equal(result.done.clarification.field, field);
  assert.equal(result.requests.length, 0);
  assert.equal(store.getSnapshot(), before);
}
function calendarVisit(snapshot, id, day) {
  return selectCalendar(snapshot, { date: day }).todayEntries.find(row => row.id === `reservation:${id}`);
}
function assertCalendarVisit(snapshot, row) {
  const event = calendarVisit(snapshot, row.reservationId, row.date);
  assert.ok(event);
  assert.equal(event.time, row.time);
  assert.equal(event.title.params.party, row.partySize);
  assert.deepEqual(event.ref, { featureId: 'voice-booking', itemId: row.reservationId });
}
function createCommand(args = {}) {
  return booking('create', { guest: { name: '김서연' }, date: TODAY, time: '19:00', partySize: 4,
    tableChoice: 'auto', idempotencyKey: 'navis:booking-create', ...args });
}
const invalidCreates = {
  '025': [{ guest: { name: '윤하늘', phone: '12345' } }, 'guest'],
  '032': [{ partySize: 0 }, 'partySize'], '033': [{ date: '2026-11-31' }, 'date'], '034': [{ time: '25:00' }, 'time'],
  '035': [{ date: addDays(TODAY, -1) }, 'date'], '036': [{ time: '10:00' }, 'time'],
};
const missingCreates = { '026': 'guest', '027': 'date', '028': 'time', '029': 'partySize', '030': 'guest' };

async function checkCreate(store, expected) {
  const { name, phone } = expected.tools[0].args.guest;
  const command = createCommand({
    ...expected.tools[0].args, idempotencyKey: 'navis:booking-create',
    guest: { name: /^<slot:name (.+)>$/u.exec(name)[1], ...(phone ? { phone: /^<slot:phone (\d+)>$/u.exec(phone)[1] } : {}) },
  });
  const wire = { ...createWire, guest: { ...createWire.guest, ...(command.guest.phone ? { phone: slot('phone') } : {}) } };
  const intentReceipt = await proposed(store, 'create', wire);
  assert.equal(intentReceipt.args.guest.phone?.slot, command.guest.phone && 'phone');
  const before = store.getSnapshot();
  const beforeRead = selectReservations(before, { date: command.date });
  const result = accepted(localResult(store, command));
  const after = store.getSnapshot();
  const row = visitRows(after).find(candidate => candidate.reservationId === result.value.reservationId);
  const allocation = allocateReservation(before.tables, row, 'auto');
  assert.equal(row.status, allocation.status);
  assert.equal(row.tableId, allocation.tableId);
  assert.equal(row.allocationWarning, allocation.allocationWarning);
  assert.equal(row.partySize, command.partySize);
  assert.equal(row.source, 'direct');
  assert.equal(after.tables.reservationChange.length, before.tables.reservationChange.length + 1);
  const change = after.tables.reservationChange.at(-1);
  assert.equal(change.kind, 'created');
  assert.deepEqual(change.after, row);
  assert.equal(selectReservations(after, { date: command.date }).partyTotal, beforeRead.partyTotal + row.partySize);
  const briefing = selectBriefing(after, { date: TODAY });
  assert.equal((command.date === TODAY ? briefing.reservations : briefing.tomorrowReservations).count, beforeRead.count + 1);
  assert.equal(calendarVisit(after, row.reservationId, command.date), undefined);
  if (command.guest.phone) assert.deepEqual(row.phone, { raw: '010-****-7890' });
  assert.equal(accepted(localResult(store, command)).duplicate, true);
  assert.equal(store.getSnapshot(), after);
  accepted(store.undo(result.undoToken));
  assert.deepEqual(store.getSnapshot().tables.reservationChange, before.tables.reservationChange);
  assert.deepEqual(store.getSnapshot().tables.reservation, before.tables.reservation);
  assert.deepEqual({ tableId: row.tableId, status: row.status, warning: row.allocationWarning ?? null }, expected.allocation);
}

async function checkScenario(id, scenario) {
  const key = id.replace(/^S4-/u, '');
  const store = createWidgetDataStore();
  const before = store.getSnapshot();
  const selected = todayRows(before);
  const { expected, n06Missing } = scenario;
  const assertAnswer = reply => {
    assert.ok(expected.answer_must_contain?.length, id);
    for (const fragment of expected.answer_must_contain) assert.ok(reply.includes(fragment), fragment);
  };

  if (scenario.n06Retargeted) {
    const [lookup, step] = expected.tools;
    const { reservationId, patch } = step.args;
    const candidate = selected.rows.find(visit => visit.reservationId === reservationId);
    assert.ok(candidate?.request?.raw && candidate.status === 'confirmed');
    assert.ok(scenario.utterances[0].includes(candidate.time));
    const reader = bookingDomain.reads[0];
    const input = { snapshot: before, locale: 'ko', query: JSON.stringify({ date: TODAY, time: candidate.time }) };
    const matches = reader.search(input);
    assert.equal(matches.length, 1);
    assert.equal(reader.resolve(input, matches[0].handle), reservationId);
    const type = step.name.replace('booking.', '');
    const wire = { reservationId: handle(matches[0].handle),
      ...(patch ? { patch: patch.time ? { time: slot('time') } : { request: patch.request } } : {}) };
    await proposed(store, type, wire, [searchProjection('reservation', lookup.args.querySlot, matches)]);
    const receipt = accepted(localResult(store, booking(type, step.args)));
    const after = store.getSnapshot();
    const actual = visitRows(after).find(visit => visit.reservationId === reservationId);
    if (patch?.time) assert.equal(actual.time, patch.time);
    else if (patch) {
      assert.equal(actual.request, null);
      assert.equal(actual.requestKey, null);
    } else assert.equal(actual.status, 'canceled');
    assert.equal(after.tables.reservationChange.length, before.tables.reservationChange.length + 1);
    accepted(store.undo(receipt.undoToken));
    assert.deepEqual(store.getSnapshot().tables.reservation, before.tables.reservation);
    assert.deepEqual(store.getSnapshot().tables.reservationChange, before.tables.reservationChange);
    return;
  }

  if (n06Missing) {
    const name = /[가-힣]○[○가-힣]/u.exec(scenario.utterances[0])?.[0];
    const query = name ? { name } : { date: id === 'S7-090' ? tomorrow : TODAY, time: id === 'S7-090' ? '12:00' : '11:00' };
    const matches = bookingDomain.reads[0].search({ snapshot: before, locale: 'ko', query: JSON.stringify(query) });
    assert.deepEqual(matches, []);
    assert.equal(expected.kind, 'answer');
    const { querySlot } = expected.tools[0].args;
    const result = await readSearch(before, matches, querySlot);
    assert.equal(result.done.outcome, 'reply');
    assert.deepEqual([result.text], expected.answer_must_contain);
    assert.equal(result.proposal, undefined);
    assert.deepEqual(result.requests.at(-1).messages.filter(entry => entry.role === 'assistant')
      .flatMap(entry => entry.toolCalls ?? []).map(call => ({ name: call.function.name, args: call.function.arguments })), expected.tools);
    if (n06Missing.navigation) {
      const navigation = await run(before, { kind: 'command', command: 'ui.openDetail', args: { featureId: 'voice-booking' }, querySlot },
        { slots: [querySlot], searches: [searchProjection('reservation', querySlot, matches)] });
      assert.equal(navigation.done.outcome, 'clarify');
      assert.equal(navigation.done.clarification.field, 'itemId');
      assert.equal(navigation.proposal, undefined);
    }
    assert.equal(store.getSnapshot(), before);
    return;
  }
  if (expected.allocation) return checkCreate(store, expected);
  if (Object.hasOwn(invalidCreates, key)) {
    const [args, field] = invalidCreates[key];
    assert.equal(expected.kind, 'clarify');
    assert.equal(expected.ask[0], key === '025' ? 'phone' : field);
    assert.equal(localResult(store, createCommand(args)).field, field);
    return;
  }
  if (Object.hasOwn(missingCreates, key)) {
    const field = missingCreates[key];
    assert.deepEqual(expected.ask, [field]);
    const draft = key === '030' ? {} : Object.fromEntries(Object.entries(createWire).filter(([name]) => name !== field));
    return clarifyCreate(store, draft, field);
  }
  switch (key) {
    case '002': {
      const text = await widgetRead(before, defaultCondition, [fact('booking.date.people', selected.partyTotal, party(selected.partyTotal))]);
      assertAnswer(text);
      break;
    }
    case '008': {
      const reader = bookingDomain.reads[0];
      const query = { snapshot: before, locale: 'ko', query: JSON.stringify({ date: TODAY, mode: 'requests' }), privateLookup: true };
      const matches = reader.search(query);
      assert.equal(matches.length, expected.answer_must_contain.length);
      const local = matches.map(match => reader.describe(match, 'ko', query)).join(' ');
      assertAnswer(local);
      const result = await readSearch(before, matches);
      assert.equal(result.done.outcome, 'ambiguous');
      for (const request of expected.answer_must_contain) assert.ok(!JSON.stringify(result.requests).includes(request));
      break;
    }
    case '009': {
      const phone = selected.rows.filter(row => row.counts && row.source === 'phone_ai').length;
      const direct = selected.rows.filter(row => row.counts && row.source === 'direct').length;
      const text = await widgetRead(before, defaultCondition, [fact('booking.source.phone', phone, count(phone)), fact('booking.source.direct', direct, count(direct))]);
      assertAnswer(text);
      break;
    }
    case '011': {
      const completed = selected.rows.filter(row => row.status === 'completed').length;
      const elapsed = selected.rows.filter(row => row.canMarkCompleted).length;
      const text = await widgetRead(before, defaultCondition, [fact('booking.completed', completed, count(completed)), fact('booking.eligible', elapsed, count(elapsed))]);
      assertAnswer(text);
      break;
    }
    case '012': {
      const args = { date: slot('date'), time: slot('time'), partySize: slot('partySize') };
      const allocation = allocateReservation(before.tables, { date: TODAY, time: '17:00', partySize: 4 }, 'auto');
      assert.equal(allocation.status, 'confirmed');
      const reading = { tool: 'check_booking_capacity', args, facts: [fact('booking.capacity.available', 1, '가능')] };
      const result = await run(before, { kind: 'read', tool: reading.tool }, { slots: ['date', 'time', 'partySize'], readings: [reading] },
        [{ name: reading.tool, args }], { outcome: 'reply', facts: ['f0'] });
      assert.equal(result.done.outcome, 'reply');
      assert.deepEqual(expected.tools, [{ name: reading.tool, args: { date: TODAY, time: '17:00', partySize: 4 } }]);
      assertAnswer(result.text);
      break;
    }
    case '015':
    case '016': {
      const date = key === '015' ? tomorrow : saturday;
      const model = selectReservations(before, { date });
      assert.deepEqual(expected.tools, [{ name: 'get_widget', args: { featureId: 'voice-booking', condition: dateRange(date) } }]);
      const text = await widgetRead(before, dateRange(date), [fact('booking.date.count', model.count, count(model.count)),
        fact('booking.date.people', model.partyTotal, party(model.partyTotal))]);
      assertAnswer(text);
      break;
    }
    case '040':
    case '041': {
      assert.equal(tableLayoutEnabled(before.tables.shopSettings), expected.tableLayoutEnabled);
      assert.equal(expected.kind, 'refuse');
      const [search] = expected.tools;
      // A3_BATCH2 B22/B26 keep the missing table lookup read-only and the widget link in the browser's fallback.
      const route = bookingDomain.route(scenario.utterances[0], before, 'ko');
      assert.deepEqual(route?.intent, { kind: 'read', recordKind: 'table', querySlot: 'tableId' });
      assert.equal(route.onMissing?.reason, 'invalid_target');
      assert.deepEqual(route.onMissing?.alternative, { featureId: 'voice-booking' });
      assertAnswer(route.onMissing.answer);
      const page = projectAgentSearch(assistantDomains, before, search.args, route.slots.tableId, 'ko');
      assert.deepEqual(page, { ...search.args, matches: [], status: 'missing' });
      const read = await run(before, route.intent, { slots: ['tableId'], searches: [page] }, [search]);
      assert.equal(read.done.outcome, 'reply');
      assert.equal(read.proposal, undefined);
      const lookupResult = read.requests.at(-1).messages.find(message => message.role === 'tool');
      assert.deepEqual(JSON.parse(lookupResult.content), { status: 'missing', matches: [] });

      const args = { ...createWire, tableChoice: { tableId: handle('table-fixture') } };
      const result = await run(before, { kind: 'command', command: 'booking.create', args },
        { slots: ['date', 'time', 'partySize', 'name', 'tableId'], searches: [page] }, [search]);
      assert.equal(result.done.outcome, 'refused');
      assert.deepEqual(result.done.refusal, { reason: 'invalid_target' });
      assert.equal(result.proposal, undefined);
      assert.equal(result.requests.length, 1);
      break;
    }
    case '061': {
      const { reservationId } = expected.tools[1].args;
      const row = selected.rows.find(visit => visit.reservationId === reservationId);
      assert.ok(row?.canConfirm);
      const draft = { reservationId: handle('visit-target') };
      const searches = [searchProjection('reservation', 'reservationId', [visitMatch(row)])];
      await proposed(store, 'confirm', draft, searches);
      const receipt = accepted(localResult(store, booking('confirm', { reservationId })));
      const after = store.getSnapshot();
      assert.equal(todayRows(after).rows.find(visit => visit.reservationId === reservationId).status, 'confirmed');
      assert.equal(todayRows(after).needsCheckCount, selected.needsCheckCount - 1);
      accepted(store.undo(receipt.undoToken));
      assert.deepEqual(store.getSnapshot().tables.reservation, before.tables.reservation);
      return;
    }
    case '063': {
      assert.equal(expected.kind, 'answer');
      const scope = { featureId: 'voice-booking', condition: defaultCondition };
      const waitingCount = selected.needsCheckCount;
      const result = await run(before, { kind: 'read', ...scope }, { facts: [{ ...scope,
        facts: [fact('booking.needsCheck.count', waitingCount, count(waitingCount))] }] }, expected.tools, { outcome: 'reply', facts: ['f0'] });
      assert.equal(result.done.outcome, 'reply');
      assertAnswer(result.text);
      assert.equal(result.proposal, undefined);
      break;
    }
    case '069': {
      const result = await readSearch(before);
      assert.equal(result.done.outcome, 'reply');
      assert.ok(result.text);
      assert.equal(result.proposal, undefined);
      break;
    }
    case '070':
    case '071': {
      assert.equal(expected.kind, 'refuse');
      const result = await run(before, { kind: 'unsupported' });
      assert.equal(result.done.outcome, 'refused');
      assert.equal(result.proposal, undefined);
      assert.equal(result.requests.length, 0);
      break;
    }
    case '079':
    case '081': {
      const { args } = expected.tools[0];
      const result = await run(before, { kind: 'command', command: 'ui.openDetail', args });
      assert.equal(result.done.outcome, 'navigate');
      assert.deepEqual(result.done.navigation.args, args);
      assert.equal(result.requests.length, 0);
      break;
    }
    default: assert.fail(`No booking assertion for ${id}`);
  }
  assert.equal(store.getSnapshot(), before);
}

test('N06 evaluates every assigned booking scenario and accounts for all booking dependencies', async t => {
  assert.equal(assigned.length, 67);
  assert.equal(dependencies.length, 83);
  assert.equal(new Set(dependencies.map(row => row.scenario_id)).size, 83);
  const external = dependencies.filter(row => row.slice_id !== 'N06');
  const owners = new Map([...new Set(external.map(row => row.slice_id))].map(slice => [slice, external.filter(row => row.slice_id === slice)]));
  assert.deepEqual(Object.fromEntries([...owners].map(([slice, rows]) => [slice, rows.length])), { N19: 4, N12: 5, N21: 6, N07: 1 });
  for (const [slice, rows] of owners) t.diagnostic(`${slice} dependency checks remain in their owning slices: ${rows.map(row => row.scenario_id).join(', ')}`);
  let passed = 0;
  const failures = [];
  for (const { scenario_id: id } of assigned) {
    const scenario = corpus.get(id);
    try {
      assert.ok(scenario?.utterances.length, `Missing scenario ${id}`);
      await checkScenario(id, scenario);
      passed++;

    } catch (error) {
      failures.push(`${id} ${error.stack}`);
    }
  }
  t.diagnostic(`${passed} of 67 passed the N06 server checks`);
  assert.deepEqual(failures, []);
  assert.equal(passed, assigned.length);
});

const reservationSearch = row => searchProjection('reservation', 'reservationId', [visitMatch(row)]);
const scopedVisit = { reservationId: handle('visit-target') };
const createCalendarVisible = () => {
  const store = createWidgetDataStore();
  accepted(localResult(store, { type: 'calendar.setSourceVisible', source: 'reservation', visible: true }));
  return store;
};

test('a reviewed café visit moves one calendar entry and keeps the member and undo history', async () => {
  const store = createCalendarVisible();
  const before = store.getSnapshot();
  const model = todayRows(before);
  const target = model.rows.find(row => row.status === 'confirmed' && row.memberId && row.request?.raw);
  assert.ok(target);
  assertCalendarVisit(before, target);
  const calendarCount = selectCalendar(before, { date: TODAY }).todayEntries.length;
  const { reservationId, memberId } = target;
  const args = { ...scopedVisit, patch: { date: slot('date'), time: slot('time'), request: null } };
  await proposed(store, 'update', args, [reservationSearch(target)]);
  const command = booking('update', { reservationId, patch: { date: tomorrow, time: '14:00', request: null } });
  const receipt = accepted(localResult(store, command));
  const after = store.getSnapshot();
  const moved = selectReservations(after, { date: tomorrow }).rows.find(row => row.reservationId === reservationId);
  assert.equal(moved.memberId, memberId);
  assert.equal(moved.request, null);
  assert.equal(moved.requestKey, null);
  assert.equal(moved.time, '14:00');
  assert.equal(calendarVisit(after, reservationId, TODAY), undefined);
  assertCalendarVisit(after, moved);
  assert.equal(selectCalendar(after, { date: TODAY }).todayEntries.length, calendarCount - 1);
  const member = selectMembers(after, {}).rows.find(row => row.memberId === memberId);
  assert.equal(member.reservations.filter(row => row.reservationId === reservationId).length, 1);
  assert.equal(member.reservations.find(row => row.reservationId === reservationId).date, tomorrow);
  assert.equal(selectBriefing(after, { date: TODAY }).tomorrowReservations.count, 1);
  const change = after.tables.reservationChange.at(-1);
  assert.equal(change.kind, 'updated');
  assert.equal(change.before.date, TODAY);
  assert.equal(change.after.date, tomorrow);
  assert.equal(after.tables.reservationChange.length, before.tables.reservationChange.length + 1);
  assert.equal(localResult(store, command).revision, after.revision);
  assert.equal(store.getSnapshot(), after);
  assert.equal(store.dispatch({ ...command, baseRevision: before.revision }).reason, 'STALE_REVISION');
  accepted(store.undo(receipt.undoToken));
  assert.deepEqual(store.getSnapshot().tables.reservation, before.tables.reservation);
  assert.deepEqual(store.getSnapshot().tables.reservationChange, before.tables.reservationChange);
  assertCalendarVisit(store.getSnapshot(), target);
  assert.equal(calendarVisit(store.getSnapshot(), reservationId, tomorrow), undefined);
});

test('cancel needs extra confirmation and preserves a reversible change instead of deleting a visit', async () => {
  const store = createCalendarVisible();
  const before = store.getSnapshot();
  const target = todayRows(before).rows.find(row => row.status === 'confirmed');
  assert.ok(target);
  const { reservationId } = target;
  assertCalendarVisit(before, target);
  await proposed(store, 'cancel', scopedVisit, [reservationSearch(target)]);
  const receipt = accepted(localResult(store, booking('cancel', { reservationId })));
  const after = store.getSnapshot();
  const canceled = visitRows(after).find(row => row.reservationId === reservationId);
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.tableId, null);
  assert.equal(calendarVisit(after, reservationId, TODAY), undefined);
  assert.equal(todayRows(after).count, todayRows(before).count - 1);
  assert.equal(after.tables.reservationChange.at(-1).kind, 'canceled');
  assert.equal(after.tables.reservationChange.at(-1).before.status, target.status);
  assert.equal(after.tables.reservationChange.at(-1).after.status, canceled.status);
  accepted(store.undo(receipt.undoToken));
  assert.deepEqual(store.getSnapshot().tables.reservation, before.tables.reservation);
  assert.deepEqual(store.getSnapshot().tables.reservationChange, before.tables.reservationChange);
  assertCalendarVisit(store.getSnapshot(), target);
});

test('capacity and duplicate previews agree with the canonical allocator and keep overrides explicit', async () => {
  const store = createWidgetDataStore();
  const before = store.getSnapshot();
  const seats = todayRows(before).totalSeats;
  const command = createCommand({ partySize: seats + 1 });
  const estimate = allocateReservation(before.tables, command, 'auto');
  assert.deepEqual(estimate, { status: 'needs-check', tableId: null, allocationWarning: 'SEAT_LIMIT' });
  assert.equal(store.getSnapshot(), before);
  await proposed(store, 'create', createWire);
  const created = accepted(localResult(store, command));
  assert.deepEqual(created.value, { reservationId: created.value.reservationId, ...estimate });
  const pending = store.getSnapshot();
  const duplicate = localResult(store, { ...command, idempotencyKey: 'navis:booking-duplicate' });
  assert.equal(duplicate.reason, 'BOOKING_DUPLICATE');
  assert.equal(duplicate.details.reservationId, created.value.reservationId);
  const target = todayRows(pending).rows.find(row => row.reservationId === created.value.reservationId);
  await proposed(store, 'confirm', scopedVisit, [reservationSearch(target)]);
  const confirmed = accepted(localResult(store, booking('confirm', { reservationId: target.reservationId })));
  const after = store.getSnapshot();
  const row = visitRows(after).find(visit => visit.reservationId === target.reservationId);
  assert.equal(row.status, 'confirmed');
  assert.equal(row.confirmedBy, 'person');
  assert.equal(row.capacityOverride, true);
  assert.equal(row.allocationWarning, estimate.allocationWarning);
  assert.equal(row.tableId, null);
  assert.equal(after.tables.reservationChange.at(-1).kind, 'status');
  assert.equal(todayRows(after).count, todayRows(pending).count);
  accepted(store.undo(confirmed.undoToken));
  assert.deepEqual(store.getSnapshot().tables.reservation, pending.tables.reservation);
  assert.deepEqual(store.getSnapshot().tables.reservationChange, pending.tables.reservationChange);
});

test('local member and table handles resolve independently and the allocator keeps 120-minute boundaries', async () => {
  const seed = createWidgetDataStore().getSnapshot();
  const store = createWidgetDataStore({ shopSettings: { ...seed.tables.shopSettings, paymentStyle: 'postpaid', layoutActivated: true } });
  const before = store.getSnapshot();
  assert.ok(tableLayoutEnabled(before.tables.shopSettings));
  const smallTable = before.tables.shopSettings.tableLayout.tables.find(row => row.seats === 2);
  const member = selectMembers(before, {}).rows[0];
  assert.ok(member && smallTable);
  const create = { ...createWire };
  delete create.guest;
  const query = member.memberCode ?? member.memberId;
  const memberSearch = projectAgentSearch(assistantDomains, before, { kind: 'member', querySlot: 'memberQuery' }, query, 'ko', true, 'booking.create');
  assert.equal(memberSearch.matches.length, 1);
  const [memberTarget] = memberSearch.matches;
  assert.notEqual(memberTarget.handle, member.memberId);
  const memberId = assistantDomains.reader('member').resolve({
    snapshot: before, locale: 'ko', query, command: 'booking.create', querySlot: 'memberQuery', privateLookup: true,
  }, memberTarget.handle);
  assert.equal(memberId, member.memberId);
  const args = { ...create, memberId: handle(memberTarget.handle), tableChoice: { tableId: handle('table-fixture') } };
  await proposed(store, 'create', args, [memberSearch,
    searchProjection('table', 'tableId', [{ handle: 'table-fixture', match: 'exact' }])]);
  const input = { memberId, date: tomorrow, time: '14:00', partySize: 2, tableChoice: { tableId: smallTable.tableId }, idempotencyKey: 'navis:fixture-manual' };
  const original = accepted(localResult(store, booking('create', input)));
  assert.equal(original.value.tableId, smallTable.tableId);
  const snapshot = store.getSnapshot();
  const candidate = { date: tomorrow, time: '15:59', partySize: 2 };
  assert.equal(allocateReservation(snapshot.tables, candidate, input.tableChoice).allocationWarning, 'NO_MATCHING_TABLE');
  assert.equal(allocateReservation(snapshot.tables, { ...candidate, time: '16:00' }, input.tableChoice).tableId, smallTable.tableId);
  assert.equal(allocateReservation(snapshot.tables, { ...candidate, reservationId: original.value.reservationId }, input.tableChoice).tableId, smallTable.tableId);
  assert.equal(store.getSnapshot(), snapshot);
});

test('suggestion offers a scoped prefill and keeps outbound messaging outside chat', async () => {
  const snapshot = createWidgetDataStore().getSnapshot();
  const candidate = todayRows(snapshot).rows.find(row => row.status === 'needs-check');
  const args = { ...scopedVisit, time: slot('time') };
  const intent = { kind: 'command', command: 'booking.propose', args };
  const result = await run(snapshot, intent, { slots: ['reservationId', 'time'], searches: [reservationSearch(candidate)] });
  assert.equal(result.done.outcome, 'handoff');
  assert.deepEqual(result.done.handoff.draft, args);
  assert.equal(result.done.handoff.featureId, 'voice-booking');
  assert.equal(result.requests.length, 0);
  const unscoped = await run(snapshot, intent, { slots: ['reservationId', 'time'] });
  assert.equal(unscoped.done.outcome, 'clarify');
  assert.equal(unscoped.done.clarification.field, 'reservationId');
  assert.equal(unscoped.requests.length, 0);
});

test('booking completion and no-show fail at and after the business clock and record eligible transitions', async () => {
  const seed = createWidgetDataStore().getSnapshot();
  const past = todayRows(seed).rows.find(row => slotHasPassed(row.date, row.time));
  assert.ok(past);
  const rows = seed.tables.reservation.map(row => row.reservationId === past.reservationId ? { ...row, status: 'confirmed' } : row);
  for (const [type, status] of [['markCompleted', 'completed'], ['markNoShow', 'no-show']]) {
    const store = createWidgetDataStore({ reservation: rows });
    const future = accepted(localResult(store, createCommand({ time: '15:45' })));
    assert.equal(localResult(store, booking(type, { reservationId: future.value.reservationId })).reason, 'NOT_YET_TIME');
    const before = store.getSnapshot();
    const target = todayRows(before).rows.find(row => row.reservationId === past.reservationId);
    await proposed(store, type, scopedVisit, [reservationSearch(target)]);
    const receipt = accepted(localResult(store, booking(type, { reservationId: target.reservationId })));
    const after = store.getSnapshot();
    assert.equal(after.tables.reservationChange.at(-1).after.status, status);
    assert.equal(todayRows(after).count, todayRows(before).count);
    assert.equal(readModel(after, 'voice-booking').todayCount, todayRows(after).count);
    accepted(store.undo(receipt.undoToken));
    assert.deepEqual(store.getSnapshot().tables.reservation, before.tables.reservation);
  }
});
