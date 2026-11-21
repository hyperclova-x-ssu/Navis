import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { createServer } from 'vite';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, createNavisContractFake } from '../fixtures/navis-eval-fake.mjs';
import { agentCommandRefs, validateAgentFrame } from '../../shared/navis-agent-schema.mjs';
import { normalizeConversationTurn } from './conversation.mjs';
import { evidence, readTrace } from './scenario-fixtures.mjs';

const vite = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
  envFile: false, envDir: false, logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false } });
let data, dates, notices, translator, handlers, createAgentActions, createDomainRegistry, createCalendarStaffDomain;
try {
  [data, dates, notices, translator, { handlers }, { createAgentActions }, { createDomainRegistry }, { createCalendarStaffDomain }] = await Promise.all([
    vite.ssrLoadModule('/src/data/widget-data.ts'),
    vite.ssrLoadModule('/src/data/db/time.ts'),
    vite.ssrLoadModule('/src/data/iteration7/notices/selectors.ts'),
    vite.ssrLoadModule('/src/features/assistant/messages.ts'),
    vite.ssrLoadModule('/src/data/commands/handlers.ts'),
    vite.ssrLoadModule('/src/features/assistant/agent-actions.ts'),
    vite.ssrLoadModule('/src/features/assistant/domains/registry.ts'),
    vite.ssrLoadModule('/src/features/assistant/domains/calendar-staff.ts'),
  ]);
} finally {
  await vite.close();
}
const { createWidgetDataStore, TODAY, NOW_TIME, selectCalendar, selectStaffSchedule } = data;
const { addDays, WEEK_START, WEEK_END, MONTH_START } = dates;
const tomorrow = addDays(TODAY, 1), afterTomorrow = addDays(TODAY, 2);
const nextMonth = `${addDays(MONTH_START, 32).slice(0, 7)}-01`;
const monthEnd = addDays(nextMonth, -1);
const nextMonday = addDays(WEEK_START, 7);
const baseCondition = { kind: 'default' };
const ranged = (start, end = start) => ({ kind: 'dateRange', start, end });
const catalog = conditions => [
  { id: 'calendar', name: '캘린더', layer: 'management', conditions },
  { id: 'staff-schedule', name: '근무표', layer: 'management', conditions },
  { id: 'community', name: '커뮤니티', layer: 'marketing', conditions },
];
const corpus = new Map(JSON.parse(evidence('MERGED.json')).map(row => [row.id, row]));
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json'));
const trace = readTrace();
const assigned = trace.filter(row => row.slice_id === 'N10');
const required = trace.filter(row => row.required_slices.split('|').includes('N10'));
const clientDomains = createDomainRegistry([createCalendarStaffDomain({ allowClosureWrites: true, allowSingleDeletes: true })]);
const tr = translator.navisTranslator('ko');
const label = value => data.resolveDataText(tr.t, value);
const raw = value => ({ raw: value });
const slot = name => ({ slot: name });

const exceptions = new Map([
  ['S3-259', 'N02/N03 and N10 R5: previous-calendar-record binding is missing in the client.'],
  ['S8-043', 'N02 and N10 R5: typed date edits of the pending generic calendar card are missing in the client.'],
]);
const staffIdFor = { 'staff-1': 'sample-staff-1', 'staff-2': 'sample-staff-2', 'staff-3': 'sample-staff-3',
  'staff-4': 'sample-staff-4', 'staff-5': 'sample-staff-5' };
const staffFor = (snapshot, index) => snapshot.tables.staff.find(row => row.staffId === staffIdFor[`staff-${index}`]);
const todayShift = (snapshot, index) => snapshot.tables.staffSchedule.find(row => row.staffId === staffFor(snapshot, index).staffId && row.date === TODAY);
const eventRow = (id, title, date, time = null) => ({ eventId: id, kind: 'event', title: raw(title), date, time, memo: null, revision: 1, categoryId: 'store-operations' });
const hygiene = eventRow('ev-hygiene', '위생 점검', TODAY, '14:00');
const board = eventRow('ev-menuboard', '메뉴판 교체', addDays(TODAY, -2), '16:00');
const filter = eventRow('ev-filter', '에어컨 필터 청소', addDays(TODAY, -3), '10:00');
const closure = { ...eventRow('fixture-closure', '임시 휴무', tomorrow), memo: raw('매장 정비로 하루 쉬어요'),
  storeClosure: { kind: 'temporary', endDate: tomorrow } };
const accepted = result => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
function setup(id) {
  const store = createWidgetDataStore();
  const snapshot = store.getSnapshot(), { tables } = snapshot;
  const owned = ({
    'S3-222': hygiene, 'S3-226': hygiene, 'S3-227': hygiene, 'S3-228': board, 'S3-229': filter,
    'S3-230': hygiene, 'S3-232': hygiene, 'S3-237': filter, 'S3-239': closure, 'S3-255': hygiene, 'S3-259': hygiene, 'S8-054': hygiene,
  })[id];
  if (owned) {
    const seeded = createWidgetDataStore({ calendarEvent: [...tables.calendarEvent, owned] });
    if (id === 'S3-239') {
      const { value: { noticeId, revision } } = accepted(seeded.dispatch({
        type: 'notice.importClosure', eventId: closure.eventId, idempotencyKey: 'n10-linked-closure',
      }));
      accepted(seeded.dispatch({ type: 'notice.preview', noticeId, draftRevision: revision }));
    }
    return seeded;
  }
  if (id === 'S3-152') {
    const source = todayShift(snapshot, 5);
    return createWidgetDataStore({ staffSchedule: tables.staffSchedule.map(row => row.scheduleId === source.scheduleId
      ? { ...row, kind: 'off', start: null, end: null, breakMinutes: 0 } : row) });
  }
  if (id === 'S3-235' || id === 'S3-238') {
    const milk = tables.purchaseItem.find(row => row.itemId === 'i-milk');
    accepted(store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: milk.purchaseItemId, qty: milk.minimumQty, dueDate: tomorrow, idempotencyKey: 'n10-delivery' }));
  }
  return store;
}

function request(before, intent, extras = {}) {
  return { runId: before.runId, snapshotRevision: before.revision, businessDate: TODAY, layer: 'management', locale: 'ko',
    catalog: catalog([baseCondition]), slots: [], searches: [], snapshot: [], intent, ...extras };
}

function replayDraft(snapshot, type, command, mockEvent) {
  const searches = [], slots = {}, args = {}, targets = new Map();
  for (const [field, value] of Object.entries(command)) {
    const kind = { eventId: 'event', staffId: 'staff', scheduleId: 'shift' }[field];
    if (kind) {
      const handle = `target-${kind}`;
      const querySlot = field;
      slots[querySlot] = value;
      let fields;
      if (kind === 'event') {
        const event = snapshot.tables.calendarEvent.find(row => row.eventId === value);
        fields = mockEvent ?? (event && {
          date: event.date, kind: event.kind, source: 'direct', closure: Boolean(event.storeClosure),
          ...(event.storeClosure ? { linkedDraftCount: snapshot.tables.noticeDraft.filter(row => row.closureEventId === value).length } : {}),
          ...(event.time ? { time: event.time } : {}),
        });
      } else if (kind === 'shift') {
        const row = snapshot.tables.staffSchedule.find(shift => shift.scheduleId === value);
        fields = row && { date: row.date, kind: row.kind, breakMinutes: row.breakMinutes,
          ...(row.start && row.end ? { start: row.start, end: row.end } : {}) };
      } else if (snapshot.tables.staff.some(staff => staff.staffId === value)) fields = {};
      searches.push({ kind, querySlot, matches: fields ? [{ handle, match: 'exact', fields }] : [] });
      if (fields) targets.set(handle, { kind, id: value });
      args[field] = { handle };
    } else if (field === 'storeClosure' && value) {
      slots.endDate = value.endDate;
      args.storeClosure = { kind: value.kind, endDate: slot('endDate') };
    } else if (typeof value === 'boolean' && field !== 'confirmDuplicate' || ['source', 'categoryId', 'kind'].includes(field) || value === null) {
      args[field] = value;
    } else {
      slots[field] = value;
      args[field] = slot(field);
    }
  }
  return { intent: { kind: 'command', command: type, args }, extras: { searches, slots: Object.keys(slots) }, slots, targets };
}

function authoredDraft(snapshot, fixture) {
  const { command: type, args } = fixture;
  const command = { ...args };
  // Legacy assumptions in cases outside the reviewed overlay still need their
  // ordinary slot expansion. The reviewed dates and current IDs go through unchanged.
  if (staffIdFor[command.staffId]) command.staffId = staffIdFor[command.staffId];
  if (/^staff-shift-/u.test(command.scheduleId ?? '')) {
    command.scheduleId = todayShift(snapshot, Number(command.scheduleId.at(-1))).scheduleId;
  }
  return { type, command };
}

function assertApplied(before, after, type, command) {
  assert.equal(after.revision, before.revision + 1);
  const t = after.tables;
  if (type === 'calendar.deleteEvent') assert.deepEqual(t.calendarEvent, before.tables.calendarEvent.filter(row => row.eventId !== command.eventId));
  else if (type === 'calendar.setCategoryVisible') assert.equal(t.categoryVisibility[command.categoryId], command.visible);
  else if (type === 'calendar.setSourceVisible') assert.equal(t.calendarSettings[command.source], command.visible);
  else if (type.startsWith('calendar.')) {
    const row = t.calendarEvent.find(item => command.eventId ? item.eventId === command.eventId
      : !before.tables.calendarEvent.some(original => original.eventId === item.eventId));
    assert.ok(row);
    if ('title' in command) assert.equal(label(row.title), command.title);
    if ('memo' in command) assert.equal(label(row.memo), command.memo);
    if ('time' in command) assert.equal(row.time, command.time);
    if ('date' in command || type !== 'calendar.updateEvent') assert.equal(row.date, command.date ?? TODAY);
    if ('categoryId' in command) assert.equal(row.categoryId, command.categoryId);
    if (type === 'calendar.addTodo') assert.equal(row.kind, 'todo');
    if (command.title === '임시 휴무') assert.equal(row.storeClosure, null);
  } else {
    assert.ok(t.staffScheduleChange.length > before.tables.staffScheduleChange.length, type);
    if (type === 'staff.create' || type === 'staff.update') {
      const person = t.staff.find(row => command.staffId ? row.staffId === command.staffId :
        !before.tables.staff.some(original => original.staffId === row.staffId));
      assert.equal(person?.name, command.name);
    }
    if (type === 'staff.deleteSchedule') assert.deepEqual(t.staffSchedule, before.tables.staffSchedule.filter(row => row.scheduleId !== command.scheduleId));
    if (type === 'staff.saveSchedule') {
      const row = t.staffSchedule.find(item => command.scheduleId ? item.scheduleId === command.scheduleId
        : !before.tables.staffSchedule.some(original => original.scheduleId === item.scheduleId));
      assert.ok(row);
      assert.deepEqual([row.staffId, row.date, row.kind, row.start, row.end, row.breakMinutes],
        [command.staffId, command.date, command.kind, command.start ?? null, command.end ?? null, command.breakMinutes ?? 0]);
      assert.ok(selectCalendar(after, { date: command.date }).staffEntries.some(item =>
        item.sourceId === row.scheduleId && item.sourceFeatureId === 'staff-schedule' && !item.editable));
    }
    if (type === 'staff.moveHandoff') {
      const calendar = selectCalendar(after, { date: command.date });
      assert.ok(calendar.todayEntries.some(row => row.source === 'shift' && row.time === command.toTime));
      assert.ok(!calendar.todayEntries.some(row => row.source === 'shift' && row.time === command.fromTime));
    }
  }
}

async function checkWrite(harness, store, scenario, tool) {
  const { id, utterances } = scenario;
  const before = store.getSnapshot();
  const { type, command } = authoredDraft(before, tool.args);
  const wire = replayDraft(before, type, command);
  let earlier;
  if (id === 'S8-043') {
    const previous = replayDraft(before, type, { ...command, date: tomorrow });
    const result = await harness.run(request(before, previous.intent, { ...previous.extras, conversation: true }));
    earlier = result.proposal?.proposalId;
    assert.ok(earlier, result.raw);
    const action = normalizeConversationTurn(utterances[0], { pending: true }).kind;
    assert.equal(action, 'edit');
    const edit = await harness.run(request(before, { kind: 'conversation', action, pendingId: earlier }, { conversation: true }));
    assert.deepEqual(edit.terminal?.resolution, { type: 'edit', pendingId: earlier }, edit.raw);
  }
  if (id === 'S3-259') {
    const search = wire.extras.searches[0];
    const scope = { searches: [search], slots: [search.querySlot], conversation: true };
    const read = await harness.run(request(before, { kind: 'read', recordKind: 'event', querySlot: search.querySlot }, scope));
    assert.equal(read.terminal?.outcome, 'reply', read.raw);
    const action = normalizeConversationTurn(utterances[0]).kind;
    assert.equal(action, 'refer');
    const refer = await harness.run(request(before, { kind: 'conversation', action, recordKind: 'event' }, scope));
    assert.deepEqual(refer.terminal?.resolution, { type: 'record', recordKind: 'event',
      querySlot: search.querySlot, handle: search.matches[0].handle }, refer.raw);
  }
  const input = request(before, wire.intent, { ...wire.extras, ...(earlier ? { conversation: true } : {}) });
  const response = await harness.run(input);
  if (type === 'staff.delete') {
    assert.equal(response.terminal?.refusal?.reason, 'widget_only', response.raw);
    assert.equal(response.terminal.refusal.alternative.featureId, 'staff-schedule');
    assert.equal(response.proposal, undefined);
    assert.equal(store.getSnapshot(), before);
    return;
  }
  const guarded = ['calendar.deleteEvent', 'staff.deleteSchedule'].includes(type);
  assert.equal(response.terminal?.outcome, 'proposal', response.raw);
  assert.deepEqual(response.proposal?.args, wire.intent.args);
  assert.equal(response.proposal?.tier, guarded || id === 'S3-160' ? 'extra-confirm' : 'normal');
  assert.equal(response.proposal?.snapshotRevision, before.revision);
  if (earlier) assert.notEqual(response.proposal?.proposalId, earlier);
  assert.equal(response.calls.at(-1)?.name, 'propose_action');
  assert.ok(agentCommandRefs(type, response.proposal.args).every(ref => ref.slot || ref.handle));
  assert.equal(store.getSnapshot(), before, 'Wire proposal must not dispatch');
  const actions = createAgentActions(store, clientDomains);
  const prepared = actions.prepare(response.proposal, wire.slots, before, () => true, wire.targets);
  assert.equal(prepared.kind, 'proposal', JSON.stringify(prepared));
  assert.equal(store.getSnapshot(), before, 'A local preview is also read-only');
  if (id === 'S3-239') {
    assert.ok(prepared.proposal.preview.fields.some(field => field.label === '연결된 공지 초안' && field.before === '1건'));
  }
  if (prepared.proposal.tier === 'extra-confirm') {
    assert.equal(prepared.proposal.confirm(store).requiresExtraConfirmation, true);
    assert.equal(store.getSnapshot(), before);
  }
  const result = prepared.proposal.confirm(store, prepared.proposal.id);
  assert.equal(result.frame.outcome, 'applied');
  const after = store.getSnapshot();
  assertApplied(before, after, type, command);
  assert.deepEqual(prepared.proposal.confirm(store, prepared.proposal.id).frame, result.frame);
  assert.equal(store.getSnapshot(), after);
  if (id === 'S3-239') {
    const draft = after.tables.noticeDraft.find(row => row.closureEventId === closure.eventId);
    assert.equal(draft.closureRevision, 1);
    assert.equal(notices.selectDraftClosureLink(after, draft), 'removed');
    assert.equal(store.dispatch({ type: 'notice.preview', noticeId: draft.noticeId, draftRevision: draft.revision }).reason, 'PREVIEW_STALE');
  }
  if (guarded) {
    assert.ok(result.undoToken);
    accepted(store.undo(result.undoToken));
    assert.deepEqual(store.getSnapshot().tables.calendarEvent, before.tables.calendarEvent);
    assert.deepEqual(store.getSnapshot().tables.staffSchedule, before.tables.staffSchedule);
  }
}

function fact(key, value, display = String(value)) {
  return { key, value, display, label: '확인한 값', unit: '' };
}
function readCase(before, id) {
  const staff = selectStaffSchedule(before, { startDate: WEEK_START, endDate: WEEK_END });
  const rows = staff.rows.filter(row => row.date === TODAY);
  const some = row => staff.staff.find(person => person.staffId === row.staffId).name;
  const active = rows.filter(row => row.start <= NOW_TIME && NOW_TIME < row.end);
  const calendars = (start, end = start) => selectCalendar(before, { date: TODAY, start, end }).entries;
  const namedShift = (index, key, value, display) => ({
    facts: [fact(key, value, display)], match: { kind: 'shift', fields: { date: TODAY, kind: 'work' },
      label: staffFor(before, index).name },
  });
  const staffData = {
    'S3-136': () => [fact('staff.current.count', active.length, `${active.length}명`)],
    'S3-139': () => rows.filter(row => row.kind === 'work').map(row => fact('staff.work.row', some(row), `${some(row)} ${row.start}~${row.end}`)),
    'S3-140': () => [fact('staff.off.count', staff.today.offCount, `휴무 ${staff.today.offCount}명`)],
    'S3-141': () => namedShift(1, 'staff.end', todayShift(before, 1).end),
    'S3-142': () => namedShift(2, 'staff.break', todayShift(before, 2).breakMinutes, `${todayShift(before, 2).breakMinutes}분`),
    'S3-143': () => {
      const working = staff.rows.filter(row => row.date === tomorrow).length;
      return [fact('staff.work.count', working, `${working}명`)];
    },
    'S3-144': () => [fact('staff.week.count', staff.rows.length, `${staff.rows.length}건`)],
    'S3-145': () => [fact('staff.roster.count', staff.staff.length, `${staff.staff.length}명`), ...staff.staff.map(row => fact('staff.roster.name', row.name))],
    'S3-146': () => [fact('staff.change.count', staff.changes.length, staff.changes.length ? String(staff.changes.length) : '변경이 없어요')],
    'S3-147': () => {
      const minutes = staff.rows.filter(row => row.staffId === staffFor(before, 1).staffId).reduce((sum, row) => {
        const minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
        return sum + minute(row.end) - minute(row.start) - row.breakMinutes;
      }, 0);
      return [fact('staff.week.minutes', minutes, `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`)];
    },
  }[id];
  if (staffData) {
    const values = staffData();
    const condition = id === 'S3-143' ? ranged(tomorrow) : ['S3-144', 'S3-147'].includes(id) ? ranged(WEEK_START, WEEK_END) : baseCondition;
    return { featureId: 'staff-schedule', condition, ...(Array.isArray(values) ? { facts: values } : values) };
  }
  if (id === 'S3-207') return { featureId: 'calendar', condition: baseCondition, facts: [], match: { kind: 'event' } };
  const range = id === 'S3-205' ? ranged(nextMonday, addDays(nextMonday, 6)) : id === 'S3-206' ? ranged(MONTH_START, monthEnd) : ranged(TODAY);
  if (id === 'S3-205' || id === 'S3-206') {
    const reply = clientDomains.projectWidget(before, 'calendar', range, 'ko');
    const facts = reply.facts.filter(item => /^calendar\.(?:entries\.count|entry\.\d+)$/u.test(item.key)).slice(0, 10);
    return { featureId: 'calendar', condition: range, facts };
  }
  let entries = calendars(range.start, range.end);
  if (id === 'S3-208') entries = entries.filter(row => row.time && row.time >= NOW_TIME);
  if (id === 'S3-212') entries = entries.filter(row => row.kind === 'todo');
  assert.ok(['S3-208', 'S3-212'].includes(id), id);
  const facts = id === 'S3-212' ? [fact('calendar.todo.count', entries.length, entries.length ? `${entries.length}개` : '할 일이 없어요')]
    : [fact('calendar.entry.count', entries.length, `${entries.length}개`),
      ...entries.slice(0, 10).map(row => fact('calendar.entry', label(row.title), [row.time, label(row.title)].filter(Boolean).join(' ')))];
  return { featureId: 'calendar', condition: range, facts };
}

async function checkRead(harness, store, scenario) {
  const id = scenario.id, before = store.getSnapshot();
  const { featureId, condition, facts, match } = readCase(before, id);
  const searches = match ? [{ kind: match.kind, querySlot: 'name', matches: match.label
    ? [{ handle: 'looked-up-row', match: 'exact', label: match.label, fields: match.fields }] : [] }] : [];
  const answer = await harness.run(request(before, { kind: 'read', featureId, condition, ...(match ? { recordKind: match.kind, querySlot: 'name' } : {}) }, {
    catalog: catalog(condition.kind === 'default' ? [baseCondition] : [baseCondition, condition]),
    snapshot: [{ featureId, condition, facts }], slots: match ? ['name'] : [], searches,
  }));
  assert.equal(answer.terminal?.outcome, 'reply', answer.raw);
  assert.equal(answer.proposal, undefined);
  if (match) assert.equal(answer.calls[0]?.name, 'search_records');
  if (facts.length) {
    assert.ok(answer.calls.some(call => call.name === 'get_widget' && call.args.featureId === featureId), answer.raw);
    for (const { display } of facts) assert.ok(answer.answer.includes(display), answer.raw);
  } else assert.ok(/없어요/u.test(answer.answer), answer.raw);
  for (const text of scenario.expected.answer_must_contain ?? []) assert.ok(answer.answer.includes(text), answer.raw);
  assert.equal(store.getSnapshot(), before);
}

function assertRejected(store, type, command, reason) {
  const before = store.getSnapshot();
  const result = store.dispatch({ type, idempotencyKey: 'n10-rejected', ...command });
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  assert.equal(store.getSnapshot(), before);
  return result;
}

async function checkEdge(harness, store, scenario) {
  const { id, expected } = scenario;
  const before = store.getSnapshot();
  const first = todayShift(before, 1);
  const work = { staffId: first.staffId, date: TODAY, kind: 'work', start: first.start, end: first.end, breakMinutes: first.breakMinutes };
  switch (id) {
    case 'S3-178': {
      const command = { staffId: staffFor(before, 5).staffId, cascadeSchedules: true };
      const wire = replayDraft(before, 'staff.delete', command);
      const result = await harness.run(request(before, wire.intent, wire.extras));
      assert.equal(expected.kind, 'refuse');
      assert.equal(result.terminal?.refusal?.reason, 'widget_only', result.raw);
      assert.equal(result.terminal.refusal.alternative.featureId, 'staff-schedule');
      assert.equal(result.proposal, undefined);
      assert.equal(store.getSnapshot(), before);
      return;
    }
    case 'S3-214':
    case 'S3-223':
    case 'S8-119': {
      const result = clientDomains.route(scenario.utterances[0], before, 'ko');
      assert.equal(expected.kind, 'clarify');
      assert.equal(result?.kind, 'clarification');
      assert.equal(result.field, expected.ask[0]);
      assert.equal(store.getSnapshot(), before);
      return;
    }

    case 'S3-164':
      assertRejected(store, 'staff.saveSchedule', { ...work, date: tomorrow, start: '22:00', end: '02:00' }, 'INVALID_SHIFT');
      return;
    case 'S3-168':
    case 'S3-169': {
      const result = assertRejected(store, 'staff.saveSchedule', id === 'S3-168' ? work : { ...work, start: '14:00', end: '18:00' }, 'STAFF_SHIFT_OVERLAP');
      assert.equal(result.details.conflicts[0].scheduleId, first.scheduleId);
      assert.deepEqual(result.details.conflicts.map(row => [row.start, row.end]), [[first.start, first.end]]);
      return;
    }
    case 'S3-171':
    case 'S3-172':
      assertRejected(store, 'staff.moveHandoff', { date: id === 'S3-171' ? TODAY : tomorrow, fromTime: '17:00', toTime: '07:00' },
        id === 'S3-171' ? 'INVALID_SHIFT' : 'NOT_FOUND');
      return;
    case 'S3-174':
    case 'S3-177': {
      const type = id === 'S3-174' ? 'staff.create' : 'staff.update';
      const wire = replayDraft(before, type, id === 'S3-174' ? {} : { staffId: first.staffId });
      const result = await harness.run(request(before, wire.intent, wire.extras));
      assert.equal(result.terminal?.clarification?.field, expected.ask[0], result.raw);
      assert.equal(result.proposal, undefined);
      return;
    }
    case 'S3-175': {
      const wire = replayDraft(before, 'staff.create', { name: staffFor(before, 1).name });
      const result = await harness.run(request(before, wire.intent, { ...wire.extras,
        searches: [{ kind: 'staff', querySlot: 'name', matches: [{ handle: 'existing-name', match: 'exact' }] }],
      }));
      assert.equal(result.terminal?.refusal?.reason, 'duplicate', result.raw);
      assert.equal(result.proposal, undefined);
      return;
    }
    case 'S3-180': {
      const rows = before.tables.staffSchedule.filter(row => row.staffId === staffFor(before, 2).staffId).slice(0, 2);
      assert.equal(rows.length, 2);
      const wire = replayDraft(before, 'staff.deleteSchedule', { scheduleId: rows[0].scheduleId });
      wire.extras.searches[0].matches = rows.map((row, index) => ({
        handle: index ? 'other-shift' : 'target-shift', match: 'exact', label: row.date, fields: { date: row.date, kind: row.kind },
      }));
      const result = await harness.run(request(before, wire.intent, wire.extras));
      assert.equal(result.terminal?.outcome, 'ambiguous', result.raw);
      assert.equal(result.terminal?.clarification?.field, 'scheduleId');
      assert.equal(result.proposal, undefined);
      return;
    }
    case 'S3-222': {
      const result = assertRejected(store, 'calendar.addEvent', { title: '위생점검', date: TODAY, time: '14:00' }, 'CALENDAR_DUPLICATE');
      assert.equal(result.details.eventId, hygiene.eventId);
      return;
    }
    case 'S3-232': {
      const command = { type: 'calendar.updateEvent', eventId: hygiene.eventId, time: hygiene.time };
      const result = handlers[command.type]({ tables: before.tables, nextId: () => assert.fail('no allocation for a no-op') }, command);
      assert.equal(result.ok, true);
      assert.equal(result.tables, before.tables);
      assert.equal(store.getSnapshot(), before);
      return;
    }
    case 'S3-234': {
      const result = await harness.run(request(before, { kind: 'read', recordKind: 'event', querySlot: 'name' }, {
        slots: ['name'], searches: [{ kind: 'event', querySlot: 'name', matches: [] }],
      }));
      assert.equal(result.terminal?.outcome, 'reply', result.raw);
      assert.ok(result.answer.includes('없어요'), result.raw);
      assert.equal(result.proposal, undefined);
      return;
    }
    case 'S3-235':
    case 'S3-238': {
      const linked = selectCalendar(before, { date: TODAY }).entries.find(row => row.source === 'delivery');
      assert.equal(linked.ref.featureId, 'suppliers');
      assert.equal(linked.editable, false);
      const type = id === 'S3-235' ? 'calendar.updateEvent' : 'calendar.deleteEvent';
      const command = { eventId: linked.id, ...(id === 'S3-235' ? { time: '16:00' } : {}) };
      const wire = replayDraft(before, type, command, { source: linked.source, date: linked.date, closure: false });
      const result = await harness.run(request(before, wire.intent, wire.extras));
      assert.equal(result.terminal?.refusal?.reason, 'invalid_target', result.raw);
      assert.equal(result.proposal, undefined);
      assertRejected(store, type, command, 'AUTO_EVENT_READ_ONLY');
      const source = await harness.run(request(before, { kind: 'command', command: 'ui.openDetail', args: {
        featureId: 'suppliers', view: 'order', itemId: { handle: 'source-order' },
      } }, {
        catalog: [...catalog([baseCondition]), { id: 'suppliers', name: '발주', layer: 'management', conditions: [baseCondition] }],
        slots: ['order'], searches: [{ kind: 'purchaseOrder', querySlot: 'order', matches: [{ handle: 'source-order', match: 'exact' }] }],
      }));
      assert.equal(source.terminal?.navigation?.args?.itemId?.handle, 'source-order', source.raw);
      return;
    }
    case 'S8-054': {
      const wire = replayDraft(before, 'calendar.deleteEvent', { eventId: hygiene.eventId });
      const input = request(before, wire.intent, { ...wire.extras, conversation: true });
      const result = await harness.run(input);
      assert.equal(result.proposal?.tier, 'extra-confirm', result.raw);
      const action = normalizeConversationTurn(scenario.utterances[0], { pending: true }).kind;
      assert.equal(action, 'hold');
      const response = await harness.run(request(before, { kind: 'conversation', action }, { conversation: true }));
      assert.deepEqual(response.terminal?.resolution, { type: 'hold' }, response.raw);
      assert.equal(response.proposal, undefined);
      const { proposalId: pendingId } = result.proposal;
      const challenged = await harness.run(request(before, { kind: 'conversation', action: 'confirm', pendingId, target: 'target-event' }, {
        ...wire.extras, conversation: true,
      }));
      assert.equal(challenged.terminal?.resolution?.type, 'extra_confirm', challenged.raw);
      assert.equal(store.getSnapshot(), before);
      const second = await harness.run(request(before, {
        kind: 'conversation', action: 'confirm_extra', pendingId, challengeId: challenged.terminal.resolution.challengeId,
      }, { ...wire.extras, conversation: true }));
      assert.deepEqual(second.terminal?.resolution, { type: 'confirm', pendingId }, second.raw);
      assert.equal(second.proposal, undefined);
      assert.equal(store.getSnapshot(), before);
      return;
    }
    case 'S8-113':
    case 'S8-114':
    case 'S8-115':
    case 'S8-117': {
      // The client retains the unresolved date phrase locally; the server can ask
      // for the missing date but cannot supply one from the café clock alone.
      const result = await harness.run(request(before, {
        kind: 'command', command: 'calendar.addEvent', args: { title: slot('title') },
      }, { slots: ['title'] }));
      assert.equal(result.terminal?.clarification?.field, expected.ask[0], result.raw);
      assert.equal(result.proposal, undefined);
      return;
    }
    case 'S8-121':
    case 'S8-122': {
      // A time is optional for all-day events. A spoken time that remains
      // ambiguous belongs to the originating parser and stays off the wire.
      const result = await harness.run(request(before, {
        kind: 'command', command: 'calendar.addEvent', args: { title: slot('title'), date: slot('date'), time: slot('time') },
      }, { slots: ['title', 'date'] }));
      assert.equal(result.terminal?.clarification?.field, 'time', result.raw);
      assert.equal(result.proposal, undefined);
      return;
    }
    default:
      assert.fail(`No N10 edge contract for ${id}`);
  }
}

async function checkNavigation(store, scenario) {
  const { args } = scenario.expected.tools[0];
  const expected = { ...args };
  if (scenario.id === 'S3-191') assert.equal(expected.date, nextMonday);
  const snapshot = store.getSnapshot();
  const fake = createNavisMenuHarness(createBridge, validateAgentFrame, () => assert.fail('Detail navigation reached the model'));
  try {
    const result = await fake.run(request(snapshot, { kind: 'command', command: 'ui.openDetail', args: expected }));
    assert.equal(result.terminal?.outcome, 'navigate', result.raw);
    assert.deepEqual(result.terminal.navigation.args, expected);
    assert.equal(result.proposal, undefined);
    assert.equal(store.getSnapshot(), snapshot);
  } finally {
    fake.close();
  }
}

async function checkCommunity(store) {
  const before = store.getSnapshot();
  const direct = before.tables.partnershipOffer.find(row => row.visibility === 'direct' && row.status === 'pending');
  assert.ok(direct);
  const start = direct.respondBy.slice(0, 10);
  const calendar = selectCalendar(before, { date: TODAY, start, end: start });
  const entry = calendar.entries.find(row => row.sourceId === direct.offerId);
  assert.equal(entry?.ref.featureId, 'community');
  const calls = ['calendar', 'community'].map(featureId => ({ name: 'get_widget', args: { featureId, condition: baseCondition } }));
  const fake = createNavisContractFake(calls, { outcome: 'reply', facts: ['f0', 'f1'] });
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame, fake.fetchImpl);
  try {
    const result = await harness.run(request(before, { kind: 'read' }, {
      snapshot: [
        { featureId: 'calendar', condition: baseCondition, facts: [fact('calendar.deadline.date', entry.date)] },
        { featureId: 'community', condition: baseCondition, facts: [fact('community.deadline.title', tr.t(direct.titleKey))] },
      ],
    }));
    assert.equal(result.terminal?.outcome, 'reply', result.raw);
    assert.deepEqual(result.calls, calls);
    assert.ok(result.answer.includes(entry.date), result.raw);
    assert.equal(result.proposal, undefined);
    assert.equal(store.getSnapshot(), before);
  } finally {
    harness.close();
  }
}

test('N10 fake HCX-005 contracts exercise all 91 assigned scenarios', async t => {
  assert.equal(TODAY, '2026-11-17');
  assert.equal(NOW_TIME, '15:45');
  assert.equal(assigned.length, 91);
  assert.equal(required.length, 114);
  assert.equal(new Set(assigned.map(row => row.scenario_id)).size, assigned.length);
  const failures = [], listed = [];
  let passed = 0;
  for (const { scenario_id: id } of assigned) {
    const harness = createNavisMenuHarness(createBridge, validateAgentFrame);
    try {
      const source = corpus.get(id);
      assert.ok(source?.utterances.length);
      const review = overlay[id];
      const scenario = { ...source, utterances: review?.utterances ?? source.utterances,
        expected: { ...source.expected, ...review?.expected } };
      const store = setup(id);
      const { expected } = scenario;
      if (expected.continuation) {
        const before = store.getSnapshot();
        const result = clientDomains.route(scenario.utterances[0], before, 'ko');
        assert.equal(expected.kind, 'clarify');
        assert.equal(result?.kind, 'clarification');
        assert.equal(result.field, expected.ask[0]);
        assert.equal(result.answer, expected.answer_must_contain[0]);
        assert.equal(result.choices[0].id, expected.continuation.choice);
        assert.equal(store.getSnapshot(), before);
        await checkWrite(harness, store, scenario, expected.continuation.tools[0]);
      }
      else if (expected.kind === 'navigate') await checkNavigation(store, scenario);
      else if (id === 'S5-081') {
        const route = clientDomains.route(scenario.utterances[0], store.getSnapshot(), 'ko');
        assert.equal(expected.kind, 'refuse');
        assert.equal(route?.kind, 'refusal');
        assert.equal(route.alternative?.featureId, 'community');
        await checkCommunity(store);
      }
      else if (expected.kind === 'proposal') await checkWrite(harness, store, scenario, expected.tools.find(tool => tool.name === 'propose_action'));
      else if (expected.kind === 'answer' && (id <= 'S3-147' || id >= 'S3-205' && id <= 'S3-212')) await checkRead(harness, store, scenario);
      else await checkEdge(harness, store, scenario);
      if (exceptions.has(id)) listed.push(id);
      else passed++;
    } catch (error) {
      failures.push(`${id} ${error.message}`);
    } finally {
      harness.close();
    }
  }
  t.diagnostic(`${passed} of 91 pass, ${listed.length} listed exceptions with reasons, ${failures.length} unexpected failures`);
  t.diagnostic(`${required.length} required_slices entries including ${assigned.length} primary and ${required.length - assigned.length} dependency-only`);
  for (const [id, reason] of exceptions) t.diagnostic(`${id} — ${reason}`);
  assert.deepEqual(failures, []);
  assert.deepEqual(new Set(listed), new Set(exceptions.keys()));
  assert.equal(passed + listed.length, assigned.length);
});

test('N10 creates and changes a closure only on card press and restores the linked draft on undo', async t => {
  const store = setup('S3-239');
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame);
  t.after(harness.close);
  for (const [type, command] of [
    ['calendar.addEvent', { title: '매장 정비 휴무', date: tomorrow, storeClosure: { kind: 'temporary', endDate: tomorrow } }],
    ['calendar.updateEvent', { eventId: closure.eventId, date: afterTomorrow, storeClosure: { kind: 'temporary', endDate: afterTomorrow } }],
  ]) {
    const before = store.getSnapshot();
    const wire = replayDraft(before, type, command);
    const response = await harness.run(request(before, wire.intent, { ...wire.extras, conversation: true }));
    assert.equal(response.terminal?.outcome, 'proposal', response.raw);
    assert.deepEqual(response.proposal.args, wire.intent.args);
    assert.equal(response.proposal.tier, 'normal');
    const actions = createAgentActions(store, clientDomains);
    const prepared = actions.prepare(response.proposal, wire.slots, before, () => true, wire.targets);
    assert.equal(prepared.kind, 'proposal', JSON.stringify(prepared));
    const { proposal: card } = prepared;
    const date = tr.format.date(command.date, 'long');
    assert.ok(card.preview.fields.some(field => field.label === '날짜' && field.after === date));
    assert.ok(card.preview.fields.some(field => field.label === tr.t('common.navis.agent.closureOverlaps') && field.after));
    const linked = before.tables.noticeDraft.find(row => row.closureEventId === command.eventId);
    if (linked) {
      assert.ok(card.preview.fields.some(field => field.label === '연결된 공지 초안' && field.after === '다시 가져와 주세요'));
      assert.equal(notices.selectDraftClosureLink(before, linked), 'current');
    }
    const typed = await harness.run(request(before, { kind: 'conversation', action: 'confirm', pendingId: card.id }, { conversation: true }));
    assert.equal(typed.status, 200, typed.raw);
    assert.equal(typed.proposal, undefined);
    assert.equal(store.getSnapshot(), before);
    const applied = card.confirm(store);
    assert.equal(applied.frame.outcome, 'applied');
    assert.ok(applied.undoToken);
    const after = store.getSnapshot();
    assertApplied(before, after, type, command);
    const row = after.tables.calendarEvent.find(row => command.eventId ? row.eventId === command.eventId : label(row.title) === command.title);
    assert.deepEqual(row.storeClosure, command.storeClosure);
    if (linked) assert.equal(notices.selectDraftClosureLink(after, linked), 'changed');
    accepted(store.undo(applied.undoToken));
    const restored = store.getSnapshot();
    assert.deepEqual(restored.tables.calendarEvent, before.tables.calendarEvent);
    if (linked) assert.equal(notices.selectDraftClosureLink(restored, linked), 'current');
  }
});

test('N10 deletes one event, to-do or shift with an extra card press and restores it from the receipt', async t => {
  const store = createWidgetDataStore();
  const { value: { eventId } } = accepted(store.dispatch({ type: 'calendar.addTodo', title: '정수기 확인' }));
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame);
  t.after(harness.close);
  await checkWrite(harness, store, { id: 'single-todo' }, { args: { command: 'calendar.deleteEvent', args: { eventId } } });
  for (const id of ['S3-179', 'S3-237']) {
    const scenario = corpus.get(id);
    await checkWrite(harness, setup(id), scenario, scenario.expected.tools.find(tool => tool.name === 'propose_action'));
  }
});

test('N10 typed affirmation cannot apply a pending event deletion', async t => {
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame);
  t.after(harness.close);
  await checkEdge(harness, setup('S8-054'), corpus.get('S8-054'));
});

test('An N10 action card cannot apply to another store or to an older calendar revision', async () => {
  const store = createWidgetDataStore();
  const other = createWidgetDataStore();
  const before = store.getSnapshot(), otherBefore = other.getSnapshot();
  const wire = replayDraft(before, 'calendar.addEvent', { title: '거래처 미팅', date: tomorrow, time: '10:00' });
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame);
  try {
    const response = await harness.run(request(before, wire.intent, wire.extras));
    assert.equal(response.terminal?.outcome, 'proposal', response.raw);
    const actions = createAgentActions(store, clientDomains);
    const prepared = actions.prepare(response.proposal, wire.slots, before, () => true, wire.targets);
    assert.equal(prepared.kind, 'proposal');
    assert.equal(prepared.proposal.confirm(other).frame.outcome, 'conflict');
    assert.equal(other.getSnapshot(), otherBefore);
    accepted(store.dispatch({ type: 'calendar.addTodo', title: '정수기 확인' }));
    const current = store.getSnapshot();
    assert.equal(prepared.proposal.confirm(store).frame.outcome, 'conflict');
    assert.equal(store.getSnapshot(), current);
    assert.equal(current.tables.calendarEvent.some(row => label(row.title) === '거래처 미팅'), false);
  } finally {
    harness.close();
  }
});
