import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { createBridge } from '../bridge.mjs';
import { createNavisContractFake } from '../fixtures/navis-eval-fake.mjs';

import test from 'node:test';
import * as schema from '../../shared/navis-agent-schema.mjs';
import { evidence, readCafeScenarios, readTrace, releasedScenario } from './scenario-fixtures.mjs';

const { corpus, facts: cafe } = await readCafeScenarios();
const authoredPhotoDrafts = new Map(JSON.parse(evidence('MERGED.json'))
  .filter(({ id }) => id === 'S6-012' || id === 'S6-013').map(({ id, expected }) => [id, expected.tools]));

test('command and tool schemas validate nested slots, domain enums, and record kinds', () => {
  assert.equal(schema.validateAgentToolArgs('get_board', { layer: 'pos', page: 1 }), true);
  assert.equal(schema.validateAgentToolArgs('get_ui_state', {}), true);
  assert.equal(schema.validateAgentToolArgs('get_closing_state', { tab: 'history' }), true);
  assert.equal(schema.validateAgentToolArgs('get_widget', { featureId: 'menu', condition: { kind: 'snapshot', asOf: '2026-02-30' } }), false);
  assert.equal(schema.validateAgentToolArgs('search_records', { kind: 'purchaseOrder', querySlot: 'name' }), true);
  assert.equal(schema.validateAgentToolArgs('search_records', { kind: 'order', querySlot: 'name' }), false);
  assert.equal(schema.validateAgentCommandArgs('notice.saveDraft', {
    kind: 'hours_change', title: 'Test', body: 'Test', startDate: '2026-10-26', endDate: '2026-10-27', audience: 'group', groupIds: ['regular'],
  }), true);
  assert.equal(schema.validateAgentCommandArgs('menu.update', { menuId: 'm1', patch: {} }), false);
  const proposal = { command: 'menu.update', args: { menuId: { handle: 'h1' }, patch: { price: { slot: 'price' } } } };
  assert.equal(schema.validateAgentToolArgs('propose_action', proposal), true);
  assert.equal(schema.validateAgentToolArgs('propose_action', { ...proposal, args: { ...proposal.args, patch: { price: 5500 } } }), false);
  assert.equal(schema.validateAgentToolArgs('propose_action', { command: 'notice.send', args: {} }), false);
  assert.equal(schema.validateAgentCommandArgs('tax.createPayment', { taxType: 'VAT', amount: 123, dueOn: '2026-02-29' }), false);
  const evidence = { taxPaymentId: { handle: 'payment' }, evidence: 'none' };
  assert.equal(schema.agentCommandPolicy('tax.setEvidence', evidence).policy, 'widget-only');
  assert.equal(schema.validateAgentToolArgs('propose_action', { command: 'tax.setEvidence', args: evidence }), false);
});

test('compiled read intent accepts defaults and the order alias at input only', () => {
  const input = {
    runId: 'compiled', snapshotRevision: 0, layer: 'management', businessDate: '2026-10-26',
    slots: ['name'], catalog: [], snapshot: [], searches: [],
  };
  const order = { name: 'search_records', args: { kind: 'order', querySlot: 'name' } };
  const pos = { name: 'get_source', args: { sourceId: 'pos' } };
  const read = (reads, extra) => schema.validateAgentRequest({ ...input, intent: { kind: 'read', reads, ...extra } });
  assert.equal(read([pos, order]), true);
  assert.equal(schema.validateAgentToolArgs(pos.name, pos.args), false);
  assert.equal(schema.validateAgentToolArgs(order.name, order.args), false);
  assert.equal(read([pos], { featureId: 'ledger' }), false);
  assert.equal(read([{ ...order, args: { ...order.args, querySlot: 'other' } }]), false);
  assert.equal(read([{ name: 'get_widget', args: { featureId: 'ledger', condition: { kind: 'dateRange', start: '2026-10-27', end: '2026-10-26' } } }]), false);
  assert.equal(read([{ name: 'propose_action', args: {} }]), false);
});

const defaultCondition = { kind: 'default' };
const readTools = new Set(['get_widget', 'get_source', 'list_widget_ids', 'search_records']);
const detailAliases = new Map([
  ['open_detail', 'ui.openDetail'], ['ui.open_detail', 'ui.openDetail'], ['NEW:navigate', 'ui.openDetail'],
  ['open_closing', 'ui.open_closing'],
]);
const localEvents = new Set([
  'data.undo', 'undo_last', 'undo_last_action', 'NEW:undoLast', 'proposal.cancel',
  'edit (UI action)', 'confirm (UI action)', 'confirm (UI action, no model call)',
]);
const namedPolicy = new Map([
  ['S8-179', 'tax.markPaid'],
  ['S4-160', 'notice.send'], ['S4-210', 'notice.send'],
]);
function check(value, reason) {
  if (!value) throw new Error(reason);
}
function same(actual, expected, reason) {
  check(isDeepStrictEqual(actual, expected), reason);
}

class FixtureException extends Error {}
function fixtureCheck(value, reason) {
  if (!value) throw new FixtureException(reason);
}
function fixtureBranch(choices, value) {
  return choices.find(choice => value && typeof value === 'object' && Object.keys(value).every(field => choice.properties?.[field])
    && Object.entries(value).every(([field, member]) => !choice.properties[field].enum || choice.properties[field].enum.includes(member)));
}
function fixtureCodec() {
  const slots = new Map(), handles = new Map(), queries = new Map(), namedSlots = new Map();
  const next = (map, prefix, value) => {
    if (!map.has(value)) map.set(value, `${prefix}${map.size + 1}`);
    return map.get(value);
  };
  function encode(rule, value, original = value) {
    if (rule.properties?.slot) {
      const named = authoredSlot(original) ?? rule.properties.slot.enum?.[0];
      if (!named) return { slot: next(slots, 'slot', value) };
      namedSlots.set(named, value);
      return { slot: named };
    }
    if (rule.properties?.handle) return { handle: next(handles, 'handle', value) };
    if (rule.enum || rule.type === 'boolean' || rule.type === 'string') return value;
    if ((rule.type === 'integer' || rule.type === 'number') && typeof value === 'number') return value;
    if (rule.type === 'array' && Array.isArray(value)) {
      return value.map((item, index) => encode(rule.items, item, original?.[index]));
    }
    if (rule.anyOf) {
      const literal = rule.anyOf.find(choice => choice.enum?.includes(value));
      if (literal) return value;
      const branch = rule.anyOf.find(choice => choice.properties?.handle || choice.properties?.slot) ?? fixtureBranch(rule.anyOf, value);
      fixtureCheck(branch, 'fixture does not select a wire slot branch');
      return encode(branch, value, original);
    }
    check(rule.properties && value && typeof value === 'object', 'fixture value has no wire representation');
    return Object.fromEntries(Object.entries(value).map(([field, child]) => {
      fixtureCheck(rule.properties[field], 'fixture contains an unsupported wire field');
      return [field, encode(rule.properties[field], child, original?.[field])];
    }));
  }
  function expand(value, original, rule) {
    if (!value || typeof value !== 'object') return value;
    if (Object.hasOwn(value, 'slot')) {
      if (namedSlots.has(value.slot)) return namedSlots.get(value.slot);
      return [...slots].find(([, slot]) => slot === value.slot)?.[0];
    }
    if (Object.hasOwn(value, 'handle')) return [...handles].find(([, handle]) => handle === value.handle)?.[0];
    const branch = (rule?.anyOf && fixtureBranch(rule.anyOf, value)) ?? rule;
    if (Array.isArray(value)) return value.map((item, index) => expand(item, original[index], branch?.items));
    return Object.fromEntries(Object.entries(value).map(([field, child]) => [field, expand(child, original[field], branch?.properties?.[field])]));
  }
  return { encode, expand, queries, slots, handles, query: value => next(queries, 'query', value) };
}

function authoredSlot(value) {
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.slot === 'string') return value.slot;
  return typeof value === 'string' ? /^<slot[: ]+([A-Za-z][A-Za-z0-9_]*)(?: [^>]*)?>$/u.exec(value)?.[1] : undefined;
}

function fixtureValue(rule, value, path) {
  if (!rule) return value;
  if (rule.anyOf) {
    if (rule.anyOf.some(choice => choice.enum?.includes(value))) return value;
    const branch = fixtureBranch(rule.anyOf, value) ?? rule.anyOf.find(choice => choice.type !== undefined);
    return fixtureValue(branch, value, path);
  }
  const slotName = authoredSlot(value);
  if (slotName) {
    if (rule.format === 'date') return cafe.today;
    if (rule.format === 'local-date-time') return `${cafe.today}T${cafe.clock}`;
    if (rule.type === 'integer' || rule.type === 'number') return Math.max(rule.minimum, 1);
    if (rule.type === 'string') return /phone$/u.test(path) ? '01000000000' : `Fixture ${slotName}`;
  }
  if (rule.type === 'string' && rule.pattern === '^[A-Za-z0-9_-]+$' && typeof value === 'string') {
    const handle = /^<handle:\s*([A-Za-z0-9_-]+)>$/u.exec(value);
    if (handle) return handle[1];
    if (/^<(?:new |id of |finished |candidate |created |active |handle of |codeId of )[^>]+>$/u.test(value)) {
      return `fixture_${path.replaceAll('.', '_')}`;
    }
  }
  if (rule.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([field, child]) => [
      field, fixtureValue(rule.properties[field] ?? rule.additionalProperties, child, `${path}.${field}`),
    ]));
  }
  if (rule.type === 'array' && Array.isArray(value)) return value.map((item, index) => fixtureValue(rule.items, item, `${path}.${index}`));
  return value;
}

function normalizeRead(name, args, codec) {
  if (name === 'search_records') {
    return { ...args, kind: args.kind === 'order' ? 'purchaseOrder' : args.kind, querySlot: codec.query(args.querySlot) };
  }
  if (name === 'get_source') return { condition: defaultCondition, ...args };
  if (name === 'get_recipe' || name === 'simulate_menu_price' || name === 'calc_expiry_discount' || name === 'notice.preview') {
    const rule = schema.AGENT_TOOLS[name].function.parameters;
    const wire = codec.encode(rule, args);
    same(codec.expand(wire, args, rule), args, `lossy ${name} normalization`);
    return wire;
  }
  return args;
}

function normalizeCommands(step, codec) {
  const { name, args } = step;
  const command = name === 'propose_action' ? args.command : detailAliases.get(name) ?? name;
  // Executor metadata, rather than a model-controlled command slot.
  const authored = { ...(name === 'propose_action' ? args.args : args) };
  delete authored.idempotencyKey;
  const expanded = fixtureValue(schema.AGENT_COMMAND_SCHEMAS[command], authored, command);
  if (command === 'ui.switch_layer' && expanded.layer === 'orders-payment') expanded.layer = 'pos';
  if (name === 'propose_action' && schema.validateAgentToolArgs(name, args)) return { call: step };
  if (command === 'notice.preview') return { call: { name: command, args: normalizeRead(command, expanded, codec) } };
  const policy = schema.agentCommandPolicy(command, expanded);
  check(policy, `unknown command ${command}`);
  fixtureCheck(schema.validateAgentCommandArgs(command, expanded), `expanded ${command} args violate the slot schema`);
  if (policy.policy !== 'propose') {
    const typedDraft = schema.agentDraftSchema(command);
    const draft = codec.encode(typedDraft, expanded, authored);
    same(codec.expand(draft, expanded, typedDraft), expanded, `lossy ${command} handoff normalization`);
    check(schema.validateAgentDraft(command, draft), `invalid ${command} handoff draft`);
    return { policy: { command, draft, expected: policy.policy === 'handoff' ? 'handoff' : 'refused' } };
  }
  const rule = schema.agentProposalTool(command).function.parameters.properties.args;
  const wire = codec.encode(rule, expanded, authored);
  same(codec.expand(wire, expanded, rule), expanded, `lossy ${command} proposal normalization`);
  return { call: { name: 'propose_action', args: { command, args: wire } } };
}

function validateTranscript(scenario) {
  const codec = fixtureCodec();
  const steps = [], exceptions = [];
  for (const step of scenario.expected.tools) {
    try {
      if (localEvents.has(step.name)) {
        fixtureCheck(step.args && typeof step.args === 'object' && !Array.isArray(step.args), 'invalid browser-local event payload');
        steps.push({ local: step.name });
        continue;
      }
      if (step.name === '(refused)') {
        check(schema.agentCommandPolicy(step.args.command)?.policy === 'widget-only', 'unknown restricted step');
        steps.push({ policy: { command: step.args.command, draft: {}, expected: 'refused' } });
        continue;
      }
      if (step.name === '(clarify)') {
        fixtureCheck(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(step.args.field), 'invalid clarification marker');
        steps.push({ local: 'clarification' });
        continue;
      }
      const normalized = Object.hasOwn(schema.AGENT_TOOLS, step.name) && step.name !== 'propose_action'
        ? { call: { name: step.name, args: normalizeRead(step.name, step.args, codec) } }
        : normalizeCommands(step, codec);
      if (normalized.call) {
        const { name, args } = normalized.call;
        check(schema.validateAgentToolArgs(name, args), `invalid ${name} wire args`);
      }
      steps.push(normalized);
    } catch (error) {
      if (!(error instanceof FixtureException)) throw error;
      exceptions.push(error.message);
    }
  }
  return { steps, exceptions };
}

async function runBridge(request, fake) {
  const bridge = createBridge({
    fetchImpl: () => { throw new Error('unexpected legacy transport'); },
    agentFetchImpl: fake.fetchImpl,
  });
  const req = Readable.from([Buffer.from(JSON.stringify(request))]);
  Object.assign(req, {
    method: 'POST', url: '/api/navis/chat', socket: { localAddress: '127.0.0.1', localPort: 5211 },
    headers: { host: '127.0.0.1:5211', origin: 'http://127.0.0.1:5211', 'content-type': 'application/json', 'x-navis-protocol': 'agent-v1' },
  });
  let raw = '';
  const response = new Writable({ write(chunk, _encoding, done) { raw += chunk.toString(); done(); } });
  response.writeHead = code => { response.statusCode = code; return response; };
  try {
    await bridge(req, response);
    check(response.statusCode === 200, `bridge status ${response.statusCode}`);
  } finally {
    bridge.close();
  }
  const frames = raw.split('\n\n').filter(Boolean).map(frame => {
    const [event, data] = frame.split('\n');
    return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
  });
  check(frames.at(-1)?.event === 'done', `bridge terminal ${frames.at(-1)?.data?.code ?? 'missing'}`);
  check(frames.every(({ event, data }) => schema.validateAgentFrame(event, data)), 'invalid bridge frame');
  return frames;
}

const marketing = new Set([
  'notice-send', 'local-changes', 'trade-area', 'local-trends', 'ai-response', 'community', 'marketing-today',
  'slot-coupon', 'expiry-coupon', 'promo-video', 'coupon-status', 'customer-groups',
]);
function requestFor(id, calls, intent = { kind: 'read' }, slots = []) {
  const catalog = new Map(), snapshot = new Map(), searches = new Map();
  const allSlots = new Set(slots);
  for (const { name, args } of calls) {
    if (name === 'get_widget') {
      const { featureId, condition } = args;
      if (!catalog.has(featureId)) catalog.set(featureId, {
        id: featureId, name: featureId, layer: marketing.has(featureId) ? 'marketing' : 'management', conditions: [],
      });
      const entry = catalog.get(featureId);
      if (!entry.conditions.some(allowed => isDeepStrictEqual(allowed, condition))) entry.conditions.push(condition);
      snapshot.set(JSON.stringify([featureId, condition]), { featureId, condition, facts: [] });
    }
    if (name === 'get_source') {
      const { sourceId, condition } = args;
      snapshot.set(JSON.stringify([sourceId, condition]), { sourceId, condition, facts: [], candidateAllowed: false });
    }
    if (name === 'search_records') {
      allSlots.add(args.querySlot);
      searches.set(JSON.stringify(args), { ...args, matches: [] });
    }
  }
  return {
    runId: id, snapshotRevision: 0, businessDate: cafe.today, layer: 'management', intent,
    slots: [...allSlots], catalog: [...catalog.values()], snapshot: [...snapshot.values()], searches: [...searches.values()],
  };
}

function assertNoEffects(frames) {
  check(!frames.some(frame => frame.event === 'action_proposal' || frame.event === 'action_result'
    || frame.event === 'panels' && frame.data.panels.length), 'disallowed turn emitted an effect frame');
}
function assertTranscript(fake, expected, { finalProposal = false } = {}) {
  const last = fake.requests.at(-1);
  const consumed = (last?.messages ?? []).filter(entry => entry.role === 'assistant').flatMap(entry =>
    entry.toolCalls.map(call => ({ name: call.function.name, args: call.function.arguments })));
  same(consumed, finalProposal ? expected.slice(0, -1) : expected, 'bridge consumed a different tool transcript');
  if (last) {
    const toolCount = finalProposal ? expected.length : expected.length + 1;
    check(fake.requests.length === toolCount, 'bridge consumed an unexpected number of model rounds');
  }
}

async function verifyPolicy(id, { command, draft, expected }) {
  const fake = { fetchImpl: () => { throw new Error('restricted command reached the model'); } };
  const refs = schema.agentCommandRefs(command, draft);
  const slots = refs.flatMap(ref => ref.slot ? [ref.slot] : []);
  const request = requestFor(id, [], { kind: 'command', command, args: draft }, slots);
  for (const [index, ref] of refs.filter(ref => ref.handle).entries()) {
    const querySlot = `target${index}`;
    request.slots.push(querySlot);
    request.searches.push({ kind: ref.kinds?.[0] ?? 'menu', querySlot, matches: [{ handle: ref.handle, match: 'exact' }] });
  }
  const frames = await runBridge(request, fake);
  const result = frames.at(-1).data;
  check(result.outcome === expected, `incorrect policy outcome for ${command}`);
  assertNoEffects(frames);
  const route = result.handoff ?? result.refusal?.alternative;
  check(route?.command === command && route.runId === request.runId, 'missing scoped widget alternative');
  same(route.draft, draft, 'widget alternative lost a verified draft slot');
}

async function verifyRead(id, calls, denied, scenario) {
  const fact = scenario?.n01Fact;
  const unavailableFact = scenario?.expected.unavailableFact;
  const fake = createNavisContractFake(calls, denied ? { outcome: 'refused' } : fact || unavailableFact
    ? { outcome: 'reply', facts: fact ? ['f0'] : [] } : undefined);
  const request = requestFor(id, calls);
  if (fact) request.snapshot[0].facts = [fact];
  if (unavailableFact) {
    const [read] = request.snapshot;
    assert.equal(Object.hasOwn(cafe.widget[read.featureId], unavailableFact), false);
    delete read.facts;
    read.unavailable = true;
  }
  // Notes are readable only when explicitly selected by the local intent.
  const note = calls.find(call => call.name === 'search_records' && call.args.kind === 'note');
  if (note) request.intent.recordKind = 'note';
  const frames = await runBridge(request, fake);
  check(frames.at(-1).data.outcome === (denied ? 'refused' : 'reply'), 'incorrect read or refusal outcome');
  if (denied) assertNoEffects(frames);
  if (fact) {
    const text = frames.filter(frame => frame.event === 'text_delta').map(frame => frame.data.delta).join('');
    for (const expected of scenario.expected.answer_must_contain) check(text.includes(expected), 'reply omitted a café-backed expectation');
  }
  if (unavailableFact) {
    assertNoEffects(frames);
    const text = frames.filter(frame => frame.event === 'text_delta').map(frame => frame.data.delta).join('');
    same([text], scenario.expected.answer_must_contain, 'unavailable metric must use the fixed reply without a numeric claim');
  }
  assertTranscript(fake, calls);
}

async function verifyMenu(scenario, calls) {
  const { id, expected } = scenario;
  const proposal = calls.find(call => call.name === 'propose_action');
  const hasCategory = !['S1-024', 'S8-003'].includes(id);
  const search = calls.find(call => call.name === 'search_records');
  if (search) search.args.querySlot = 'name';
  const invalidPrice = ['S1-028', 'S1-029', 'S1-030'].includes(id);
  const slots = [
    ...(search || proposal || invalidPrice ? ['name'] : []),
    ...(proposal || id === 'S8-004' ? ['price'] : []),
    ...(proposal?.args.args.memo ? ['memo'] : []),
  ];
  const category = proposal?.args.args.category ?? 'drink';
  const intent = hasCategory && !invalidPrice ? { kind: 'menu.create', category } : {
    kind: 'command', command: 'menu.create', args: { name: { slot: 'name' }, ...(hasCategory ? { category } : {}) },
  };
  const request = requestFor(id, calls, intent, slots);
  const duplicate = expected.kind === 'refuse';
  if (duplicate) {
    request.searches[0].matches = [{ handle: 'duplicate-menu', match: scenario.menuMatch?.match ?? 'exact' }];
  }
  const fake = createNavisContractFake(calls, { outcome: 'clarify', field: 'price' });
  const frames = await runBridge(request, fake);
  const terminal = frames.at(-1).data;
  check(terminal.outcome === expected.kind || duplicate && terminal.outcome === 'refused', 'incorrect menu outcome');
  if (duplicate) check(terminal.refusal?.reason === 'duplicate', 'missing duplicate refusal');
  if (proposal) {
    const frame = frames.find(frame => frame.event === 'action_proposal')?.data;
    same(frame && { command: frame.command, args: frame.args }, proposal.args, 'incorrect menu proposal args');
    assertTranscript(fake, calls, { finalProposal: true });
  } else {
    assertNoEffects(frames);
    if (!duplicate) check(terminal.clarification?.field === (!hasCategory ? 'category' : search || invalidPrice ? 'price' : 'name'), 'incorrect menu question field');
    if (duplicate || !hasCategory || invalidPrice) {
      check(fake.requests.length === calls.length, 'unexpected round after target check');
      if (calls.length) same(fake.requests[0].toolChoice.function.name, calls[0].name, 'incorrect target check tool');
    }
    else assertTranscript(fake, calls);
  }
}

const ref = slot => ({ slot });
const target = handle => ({ handle });
const calendarTitle = { title: ref('title') };
const calendarDate = { date: ref('date') };
const shiftStaff = { staffId: target('staff-target'), kind: 'work' };
const shiftDay = { ...shiftStaff, date: ref('date') };
const shiftStart = { ...shiftDay, start: ref('start') };
const shiftEnd = { ...shiftDay, end: ref('end') };
const missingQuestions = {
  'S2-166': ['members.create', 'name', { phone: ref('phone') }],
  'S2-167': ['members.create', 'phone', { name: ref('name') }],
  'S2-192': ['members.addNote', 'memberId', { body: ref('body') }],
  'S3-153': ['staff.saveSchedule', 'staffId', { date: ref('date'), kind: 'work' }],
  'S3-154': ['staff.saveSchedule', 'date', shiftStaff],
  'S3-155': ['staff.saveSchedule', 'start', shiftDay],
  'S3-156': ['staff.saveSchedule', 'end', shiftStart],
  'S3-163': ['staff.saveSchedule', 'end', shiftStart],
  'S3-165': ['staff.saveSchedule', 'breakMinutes', { ...shiftStart, ...shiftEnd, breakMinutes: ref('breakMinutes') }, ['breakMinutes']],
  'S3-166': ['staff.saveSchedule', 'date', shiftStaff],
  'S3-217': ['calendar.addEvent', 'title', calendarDate],
  'S3-218': ['calendar.addEvent', 'date', calendarTitle],
  'S3-219': ['calendar.addEvent', 'time', { ...calendarTitle, ...calendarDate, time: ref('time') }, ['time']],
  'S3-220': ['calendar.addEvent', 'date', calendarTitle],
  'S3-233': ['calendar.updateEvent', 'change', { eventId: target('event-target') }],
};
async function verifyMissing(id, [command, field, args, omitted = []]) {
  const fake = { fetchImpl: () => { throw new Error('a clarification reached the model'); } };
  const slots = schema.agentCommandRefs(command, args).flatMap(ref => ref.slot && !omitted.includes(ref.slot) ? [ref.slot] : []);
  const request = requestFor(id, [], { kind: 'command', command, args }, slots);
  const frames = await runBridge(request, fake);
  assertNoEffects(frames);
  const result = frames.at(-1).data;
  check(result.outcome === 'clarify' && result.clarification.field === field, 'wrong missing-slot question');
  check(result.clarification.choices.some(choice => choice.id === 'manual'), 'missing manual continuation');
}

const menuClarifies = new Set(['S1-022', 'S1-024', 'S1-028', 'S1-029', 'S1-030', 'S1-032', 'S8-001', 'S8-003', 'S8-004']);
const menuDuplicates = new Set(['S1-027', 'S8-005']);
const clarificationExceptions = {
  'S1-076': 'N13 · source-versus-custom-order clarification needs a typed routing choice',
  'S1-330': 'N09/N21 · mixed-domain next-action choices depend on projected stock and ordering',
  'S2-257': 'N10 · peak time clarification needs a historical shift preflight',
  'S3-157': 'N10 · staff ambiguity needs a scoped local selection',
  'S3-158': 'N10 · offering staff creation before the roster change needs the staff adapter',
  'S3-231': 'N10 · calendar duplicate choices need a scoped local selection',
  'S3-240': 'N10 · calendar delete choices need a scoped local selection',
};
const reviewedExceptions = clarificationExceptions;

function protocolScenario(scenario) {
  const { id, expected } = scenario;
  let tools = authoredPhotoDrafts.get(id);
  if (id === 'S5-020') {
    // Provider draft origin stays in the review widget. The existing wire identifies a thread.
    tools = [{ name: 'search_records', args: { kind: 'thread', querySlot: 'name' } },
      { name: 'propose_action', args: { command: 'reply.draft', args: { threadId: 'th-4' } } }];
  }
  if (id === 'S5-159' || id === 'S6-087') {
    // Publication and scheduled SMS use the existing notice widget. An unsaved draft cannot become a model proposal.
    return { ...scenario, expected: { ...expected, kind: 'refuse', tools: [{ name: '(refused)', args: { command: 'notice.send' } }] } };
  }
  return tools ? { ...scenario, expected: { ...expected, tools } } : scenario;
}

async function verifyScenario(scenario, row, assigned) {
  const { steps, exceptions } = validateTranscript(scenario);
  const calls = steps.flatMap(step => step.call ? [step.call] : []);
  const denied = ['refused by policy', 'unavailable or product boundary'].includes(row.disposition)
    || scenario.expected.kind === 'refuse';
  const namedCommand = namedPolicy.get(scenario.id);
  if (namedCommand) {
    const draft = calls.find(call => call.args.command === 'notice.saveDraft')?.args.args ?? {};
    await verifyPolicy(scenario.id, { command: namedCommand, draft, expected: 'refused' });
  }
  for (const step of steps) if (step.policy) await verifyPolicy(scenario.id, step.policy);
  if (exceptions.length && !denied) throw new FixtureException(exceptions.join(', '));

  if (scenario.menuMatch || menuDuplicates.has(scenario.id) || assigned && (menuClarifies.has(scenario.id)
    || calls.some(call => call.args.command === 'menu.create') && scenario.expected.kind !== 'multi')) {
    // Some clarification fixtures describe a subsequent fully priced turn.
    // Verify that proposal as a separate turn while keeping its wire transcript.
    const isContinuation = scenario.expected.kind === 'clarify' && calls.some(call => call.args.command === 'menu.create');
    await verifyMenu(isContinuation ? { ...scenario, expected: { ...scenario.expected, kind: 'proposal' } } : scenario, calls);
    return;
  }
  if (denied) {
    // The authored read portions stay in scope. Restricted effects get checked
    // separately above, including policy steps within a compound transcript.
    if (!namedCommand && !steps.some(step => step.policy)) {
      const reads = calls.filter(call => readTools.has(call.name));
      if (!reads.length) {
        const frames = await runBridge(requestFor(scenario.id, [], { kind: 'unsupported' }), {
          fetchImpl: () => { throw new Error('unsupported intent reached the model'); },
        });
        check(frames.at(-1).data.outcome === 'refused', 'unsupported intent was not refused');
        assertNoEffects(frames);
      } else await verifyRead(scenario.id, reads, true);
    } else if (calls.some(call => readTools.has(call.name))) {
      await verifyRead(scenario.id, calls.filter(call => readTools.has(call.name)), true);
    }
    if (exceptions.length) throw new FixtureException(exceptions.join(', '));
    return;
  }
  // Later slices owe executable domain behavior. This pass measures their
  // schema compatibility and restricted-step outcomes only.
  if (!assigned) return;
  if (missingQuestions[scenario.id]) return verifyMissing(scenario.id, missingQuestions[scenario.id]);
  if (scenario.parserClarify) {
    same(steps, [{ local: 'clarification' }], 'missing reviewed local clarification');
    same(scenario.expected.ask, [scenario.parserClarify], 'incorrect clarification slot');
    return;
  }
  if (scenario.expected.kind === 'clarify') {
    throw new FixtureException(clarificationExceptions[scenario.id] ?? 'missing reviewed typed clarification fixture');
  }
  if (scenario.expected.kind === 'multi') {
    await verifyRead(scenario.id, calls, false);
    throw new FixtureException('authored compound result lacks typed steps after its read');
  }
  if (calls.every(call => readTools.has(call.name))) await verifyRead(scenario.id, calls, false, scenario);
  else check(steps.length > 0, 'missing executable contract steps');
}

/** D-365: rows that open or read the removed 마케팅 성과 widget are retired with it (expectation patch for B17). */
const touchesRemovedWidget = scenario => JSON.stringify(scenario ?? {}).includes('marketing-performance');

test('N00/N01 corpus protocol and zero-effect policy coverage', async t => {
  const trace = readTrace();
  assert.equal(corpus.size, 1859);
  assert.equal(new Set(trace.map(row => row.scenario_id)).size, corpus.size);
  assert.ok(trace.every(row => corpus.has(row.scenario_id)));
  const selected = trace.filter(row => row.required_slices.split('|').some(slice => slice === 'N00' || slice === 'N01'));
  const assigned = selected.filter(row => row.slice_id === 'N00' || row.slice_id === 'N01');
  assert.equal(assigned.length, 466);
  assert.equal(selected.length, 1608);
  const failures = [], dependencyFailures = [], regressions = [];
  const policyGaps = [], dependencyPolicyGaps = [];
  for (const row of selected) {
    const inSlice = row.slice_id === 'N00' || row.slice_id === 'N01';
    const scenario = corpus.get(row.scenario_id);
    if (touchesRemovedWidget(scenario)) continue;
    try {
      await verifyScenario(protocolScenario(releasedScenario(scenario)), row, inSlice);
      if (scenario.policyGap) {
        const list = inSlice ? policyGaps : dependencyPolicyGaps;
        list.push(`${scenario.id} (${scenario.policyGap.slice})`);
      }
    } catch (error) {
      const list = inSlice ? failures : dependencyFailures;
      const known = error instanceof FixtureException && Object.hasOwn(reviewedExceptions, row.scenario_id);
      const reason = known ? `${reviewedExceptions[row.scenario_id]} (${error.message})`
        : error?.constructor === Error || error instanceof FixtureException ? error.message : 'unexpected runner error';
      list.push({ id: row.scenario_id, reason });
      if (!known) regressions.push(row.scenario_id);
    }
  }
  t.diagnostic(`${assigned.length - failures.length - policyGaps.length} of 466 assigned scenarios pass, ${failures.length} existing gaps and ${policyGaps.length} D-323 gaps`);
  for (const { id, reason } of failures) t.diagnostic(`Assigned ${id} — ${reason}`);
  const remaining = selected.length - assigned.length;
  t.diagnostic(`${remaining - dependencyFailures.length - dependencyPolicyGaps.length} of ${remaining} later-slice dependencies pass the N00/N01 checks, ${dependencyFailures.length} existing gaps and ${dependencyPolicyGaps.length} D-323 gaps`);
  for (const { id, reason } of dependencyFailures) t.diagnostic(`Dependency ${id} — ${reason}`);
  t.diagnostic(`D-323 deferred until the owning adapter supplies a confirmed action and verified receipt: ${[...policyGaps, ...dependencyPolicyGaps].join(', ')}`);
  assert.deepEqual(regressions, [], 'Unexpected protocol regressions');
  assert.deepEqual([...failures, ...dependencyFailures].map(({ id }) => id).sort(), Object.keys(reviewedExceptions).sort(),
    'Update the reviewed exception ledger when fixture coverage changes');
});

test('D-323 scenarios require card presses and one real receipt for every eligible approved action', () => {
  const pending = [...corpus.values()].filter(scenario => scenario.policyGap?.decision === 'D-323');
  assert.equal(pending.length, 31);
  for (const { id, expected, policyGap } of pending) {
    const card = expected.confirmation;
    const commands = card.command ? [card.command] : card.allowedCommands;
    assert.ok(commands.length && card.requires.length && card.when, id);
    for (const command of commands) {
      assert.notEqual(schema.agentCommandPolicy(command).policy, 'propose', `${id} should now run the D-323 contract in ${policyGap.slice}`);
    }
    assert.match(policyGap.slice, /^N(?:15|16|17|18|21)$/u);
    assert.equal(card.interaction, 'card-press');
    assert.equal(card.effectsBeforeConfirmation, 0);
    assert.equal(card.successfulEffectsPerConfirmation, 1);
    assert.equal(card.minimumPresses, card.command?.endsWith('.markPosted') ? 2 : 1);
    assert.equal(card.receipt, 'actual-action-result');
  }
});
