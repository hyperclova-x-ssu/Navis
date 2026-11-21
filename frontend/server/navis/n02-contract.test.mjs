import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { createBridge } from '../bridge.mjs';
import { createNavisContractFake, navisAgentFakeFetch } from '../fixtures/navis-eval-fake.mjs';
import { validateAgentFrame } from '../../shared/navis-agent-schema.mjs';
import { normalizeConversationAlias, normalizeConversationTurn } from './conversation.mjs';

import { readCafeScenarios, readTrace, scenarioVariant } from './scenario-fixtures.mjs';

const { corpus: data, facts: cafe, overlay } = await readCafeScenarios();
const selected = readTrace().filter(row => row.required_slices.split('|').includes('N02'));
const businessDate = cafe.today;
const defaultCondition = { kind: 'default' };
const base = {
  runId: 'n02-run', snapshotRevision: 8, locale: 'ko', layer: 'management', page: 1, businessDate, conversation: true,
  catalog: [], slots: [], snapshot: [], searches: [],
};
const fixtureClock = { now: () => 0, setTimeout, clearTimeout };
const menuIntent = { kind: 'menu.create', category: 'drink' };
const widgetIntent = (featureId, condition = defaultCondition) => ({ kind: 'read', featureId, condition });
const control = (action, extra = {}) => ({ kind: 'conversation', action, ...extra });
const menuSearch = { kind: 'menu', querySlot: 'name', matches: [] };
const record = (handle, label, match = 'exact') => ({ handle, label, match });
const menu = (matches = []) => ({ ...menuSearch, matches });
const widget = (id, condition = defaultCondition, layer = 'management') => ({ id, name: id, layer, conditions: [condition] });
const salesFact = (locale = 'ko', yesterday = false) => ({
  key: 'ledger.sales.net', value: yesterday ? cafe.yesterdayNet : cafe.net, unit: 'KRW',
  label: cafe.displays[locale].salesLabel, display: cafe.displays[locale][yesterday ? 'yesterday' : 'today'],
});
const restockFact = { key: 'inventory.restock.count', value: cafe.stock.restock, unit: 'item', label: '보충 필요', display: String(cafe.stock.restock) };
const costFact = (item, display) => ({ key: 'menu.cost', value: item.cost, unit: 'KRW', label: item.name, display });
const taxFact = { key: 'tax.payment.next', value: cafe.nextTax.amount, unit: 'KRW', label: cafe.nextTax.label, display: cafe.nextTax.display };

function rig(t, { agentFetch = navisAgentFakeFetch, ...options } = {}) {
  let now = 0;
  const transcript = [];
  const receipts = [];
  const bridge = createBridge({
    ...options,
    clock: { ...fixtureClock, now: () => now },
    fetchImpl() { throw new Error('legacy transport touched'); },
    agentUndoReceipts: () => receipts,
    async agentFetchImpl(url, request) {
      const response = await agentFetch(url, request);
      const body = JSON.parse(await response.clone().text().then(text => text.split('\n').find(line => line.startsWith('data: ')).slice(6)));
      const call = body.message.toolCalls?.[0]?.function;
      if (call) transcript.push({ name: call.name, args: call.arguments });
      return response;
    },
  });
  t.after(() => bridge.close());
  async function turn(intent, extra = {}, { acceptsCancellation = false } = {}) {
    const start = transcript.length;
    const input = { ...base, ...extra, intent };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
      method: 'POST', url: '/api/navis/chat', socket: { localAddress: '127.0.0.1', localPort: 5211 },
      headers: { host: '127.0.0.1:5211', origin: 'http://127.0.0.1:5211', 'content-type': 'application/json', 'x-navis-protocol': 'agent-v1' },
    });
    let raw = '';
    const res = new Writable({ write(chunk, _encoding, done) { raw += chunk; done(); } });
    res.writeHead = code => { res.statusCode = code; return res; };
    await bridge(req, res);
    assert.equal(res.statusCode, 200, 'bridge rejected valid metadata');
    const frames = raw.trim().split('\n\n').map(frame => {
      const [event, json] = frame.split('\n');
      return { event: event.slice(7), value: JSON.parse(json.slice(6)) };
    });
    assert.ok(frames.every(frame => validateAgentFrame(frame.event, frame.value)), 'invalid wire frame');
    if (acceptsCancellation && frames.at(-1)?.value.code === 'CANCELLED') return { cancelled: true };
    assert.equal(frames.at(-1)?.event, 'done', frames.at(-1)?.value.code);
    assert.ok(frames.every(frame => frame.event !== 'action_result'), 'bridge emitted a local mutation result');
    return {
      done: frames.at(-1).value,
      text: frames.filter(frame => frame.event === 'text_delta').map(frame => frame.value.delta).join(''),
      proposal: frames.find(frame => frame.event === 'action_proposal')?.value,
      calls: transcript.slice(start),
    };
  }
  return {
    turn, receipts, tick(ms) { now += ms; },
    async decision(action, value, extra, fields) {
      const result = await turn(control(action, fields), extra);
      assert.deepEqual(result.calls, [], 'a local control reached model tools');
      assert.equal(result.proposal, undefined);
      assert.deepEqual(result.done, { outcome: 'conversation', resolution: value });
      return result;
    },
  };
}

function menuTurn(fixture, { price = true, matches = [], revision = base.snapshotRevision } = {}) {
  return fixture.turn(menuIntent, {
    snapshotRevision: revision, slots: price ? ['name', 'price'] : ['name'], searches: [menu(matches)],
  });
}
const searchCall = { name: 'search_records', args: { kind: 'menu', querySlot: 'name' } };
const createCall = { name: 'propose_action', args: { command: 'menu.create', args: { name: { slot: 'name' }, category: 'drink', price: { slot: 'price' } } } };
function expectMenuProposal(result) {
  assert.equal(result.done.outcome, 'proposal');
  assert.deepEqual(result.calls, [searchCall, createCall]);
  assert.deepEqual(result.proposal.args, createCall.args.args);
  assert.equal(result.proposal.tier, 'normal');
  return result.proposal.proposalId;
}
function readProjection(featureId, facts, condition = defaultCondition, locale = base.locale) {
  return { catalog: [widget(featureId, condition)], snapshot: [{ featureId, condition, facts }], locale };
}
function expectRead(result, featureId, condition = defaultCondition, contains) {
  assert.equal(result.done.outcome, 'reply');
  assert.deepEqual(result.calls, [{ name: 'get_widget', args: { featureId, condition } }]);
  if (contains) assert.ok(result.text.includes(contains), 'grounded output missing expected display');
}
const unavailable = reason => ({ type: 'unavailable', reason });
const pendingCommand = (command, args) => ({ kind: 'command', command, args });

const updateAdapter = {
  command: 'menu.setSaleStatus',
  lookups: () => [searchCall],
  prepare: ({ input }) => ({ outcome: 'ready', args: input.intent.args }),
};
const deleteAdapter = {
  ...updateAdapter, command: 'menu.delete',
};
const knownTarget = { menuId: { handle: 'menu-first' } };
const targetSearch = { slots: ['name'], searches: [menu([record('menu-first', 'Sample Menu')])] };
async function targetProposal(fixture, command = 'menu.setSaleStatus') {
  const args = command === 'menu.delete' ? knownTarget : { ...knownTarget, status: 'sold_out' };
  const result = await fixture.turn(pendingCommand(command, args), targetSearch);
  assert.equal(result.done.outcome, 'proposal');
  assert.deepEqual(result.calls, [searchCall, { name: 'propose_action', args: { command, args } }]);
  return result.proposal.proposalId;
}

const cases = new Map();
function group(ids, verify) {
  for (const id of ids.split(' ')) {
    assert.ok(!cases.has(id));
    cases.set(id, verify);
  }
}
const kind = (utterance, expected, pending = false) => {
  const parsed = normalizeConversationTurn(utterance, { pending });
  assert.equal(parsed.kind, expected, 'unexpected input classification');
  return parsed;
};

group('S1-026 S8-006', async (t, { id, menuMatch }, utterance) => {
  const name = id === 'S1-026'
    ? utterance.match(/바닐라\s*라(?:테|떼)/u)?.[0]
    : utterance.match(/(?:카|까)\s*페\s*라\s*(?:테|떼)/u)?.[0];
  assert.equal(normalizeConversationAlias(name).key, id === 'S1-026' ? '바닐라라테' : '카페라테');
  const result = await menuTurn(rig(t), { matches: [record('duplicate', menuMatch.label, menuMatch.match)] });
  assert.equal(result.done.refusal.reason, 'duplicate');
  assert.deepEqual(result.calls, [searchCall]);
  assert.equal(result.proposal, undefined);
});

group('S3-198 S4-150 S7-171 S7-172 S7-173 S7-174 S7-175 S7-176 S8-057 S8-058 S8-059 S8-061 S8-062 S6-123', async (t, { id, n02 }, utterance) => {
  const parsed = kind(utterance, n02?.control ?? 'undo');
  const fake = rig(t);
  const dataCommands = {
    'S3-198': 'staff.saveSchedule', 'S4-150': 'localChanges.acknowledge', 'S6-123': 'coupon.pause',
    'S7-174': 'menu.create', 'S7-175': 'menu.create',
    'S8-057': 'menu.setSaleStatus', 'S8-059': 'menu.update', 'S8-061': 'menu.update',
  };
  const layoutCommands = { 'S7-171': 'layout.remove_widget', 'S7-172': 'layout.remove_widget',
    'S7-175': 'layout.remove_widget', 'S8-062': 'layout.add_widget' };
  const featureId = id.startsWith('S7-17') ? 'margin' : 'inventory-booking';
  const common = { runId: base.runId, revision: base.snapshotRevision, expiresAt: 6000 };
  const dataReceipt = dataCommands[id] && { ...common, command: dataCommands[id], id: 'data-receipt', target: 'data', token: 'local-only' };
  const layoutReceipt = layoutCommands[id] && { ...common, command: layoutCommands[id], id: 'layout-receipt', target: 'layout', featureId };
  fake.receipts.push(...[dataReceipt, layoutReceipt].filter(Boolean));
  if (id === 'S7-172') {
    fake.tick(10_000);
    const expired = await fake.decision('undo', { ...unavailable(n02.resolution), featureId });
    assert.ok(expired.text.includes('위젯'));
  } else if (id === 'S7-175') {
    await fake.decision('undo', { type: 'choose', choices: [
      { type: 'undo', receiptId: 'data-receipt', target: 'data' },
      { type: 'undo', receiptId: 'layout-receipt', target: 'layout' },
    ] });
    await fake.decision('undo', { type: 'undo', receiptId: 'layout-receipt', target: 'layout' }, {}, { featureId });
  } else if (id === 'S7-176') {
    await fake.decision('undo', { ...unavailable(n02.resolution), featureId: 'settings' }, {}, { featureId: 'settings' });
  } else if (parsed.previous || fake.receipts.length === 0) {
    await fake.decision('undo', unavailable('undo_unavailable'), {}, { previous: parsed.previous ?? false });
  } else {
    const active = fake.receipts[0];
    await fake.decision('undo', { type: 'undo', receiptId: active.id, target: active.target });
    active.consumed = true;
    await fake.decision('undo', unavailable('undo_unavailable'));
    if (id === 'S8-057') {
      active.consumed = false;
      fake.tick(common.expiresAt);
      await fake.decision('undo', { ...unavailable('undo_expired'), featureId: 'menu' });
    }
  }
});

group('S7-178 S8-045 S8-046 S8-047 S8-048 S8-049 S8-051 S8-052 S8-053 S8-054 S8-060 S8-196 S8-197', async (t, { id, n02 }, utterance) => {
  const expected = n02?.control ?? {
    'S7-178': 'cancel', 'S8-046': 'hold', 'S8-047': 'cancel', 'S8-048': 'edit',
    'S8-049': 'hold', 'S8-051': 'hold', 'S8-060': 'cancel', 'S8-196': 'hold', 'S8-197': 'hold',
  }[id];
  const typed = kind(utterance, expected, id !== 'S8-049');
  const fake = rig(t, { agentAdapters: [updateAdapter, deleteAdapter] });
  if (id === 'S8-049') {
    await fake.decision(typed.kind, { type: 'hold' });
    await fake.decision('confirm', unavailable('pending_missing'), {}, { pendingId: 'absent' });
    return;
  }
  const pendingId = await targetProposal(fake, id === 'S8-054' ? 'menu.delete' : undefined);
  if (typed.kind === 'hold') await fake.decision(typed.kind, { type: 'hold' }, id === 'S8-052' ? { snapshotRevision: 9 } : {});
  // The following controls simulate pressing the card after the typed turn.
  if (id === 'S8-052') {
    await fake.decision('confirm', { type: n02.resolution, pendingId, command: 'menu.setSaleStatus' },
      { snapshotRevision: 9 }, { pendingId });
    await fake.decision('confirm', unavailable('pending_missing'), {}, { pendingId });
  } else if (id === 'S8-054') {
    await fake.decision('confirm_extra', unavailable('target_required'), {}, { pendingId, challengeId: 'typed-guess' });
    const prompt = await fake.turn(control('confirm', { pendingId, target: 'menu-first' }));
    const { challengeId } = prompt.done.resolution;
    assert.equal(prompt.done.resolution.type, 'extra_confirm');
    assert.deepEqual(prompt.calls, []);
    await fake.decision(typed.kind, { type: 'hold' });
    await fake.decision('confirm_extra', { type: 'confirm', pendingId }, {}, { pendingId, challengeId });
  } else if (expected === 'hold') {
    await fake.decision('confirm', { type: 'confirm', pendingId }, {}, { pendingId });
    await fake.decision('confirm', unavailable('pending_missing'), {}, { pendingId });
  } else {
    await fake.decision(expected, { type: expected, pendingId }, {}, { pendingId });
    await fake.decision('confirm', unavailable('pending_missing'), {}, { pendingId });
  }
});

group('S8-021 S8-022 S8-023 S8-024 S8-031 S8-034 S8-035', async (t, { id, expected, n02 }, utterance) => {
  const parsed = kind(utterance, 'refer');
  if (id === 'S8-031') {
    const ids = n02.choices;
    const calls = ids.map(featureId => ({ name: 'get_widget', args: { featureId, condition: defaultCondition } }));
    const fake = rig(t, { agentFetch: createNavisContractFake(calls, { outcome: 'reply', facts: ['f0', 'f1'] }).fetchImpl });
    const config = {
      catalog: ids.map(featureId => widget(featureId)),
      snapshot: ids.map((featureId, index) => ({
        featureId, condition: defaultCondition,
        facts: [{ key: 'count', value: index + 1, unit: 'items', label: 'Items', display: String(index + 1) }],
      })),
    };
    const result = await fake.turn({ kind: 'read' }, config);
    assert.deepEqual(result.calls, calls);
    const choices = ids.map(featureId => ({ type: 'widget', featureId }));
    await fake.decision('refer', parsed.ordinal ? choices[parsed.ordinal - 1] : { type: 'choose', choices },
      config, { ordinal: parsed.ordinal });
    return;
  }
  const fake = rig(t);
  const search = menu(id === 'S8-024' ? [record('first-menu', cafe.latte.name), record('second-menu', cafe.vanilla.name)]
    : [{ ...record('first-menu', cafe.latte.name), price: cafe.latte.price }]);
  const config = id === 'S8-022' ? {} : { slots: ['name'], searches: [search] };
  const readTarget = { kind: 'read', recordKind: 'menu', querySlot: 'name' };
  if (['S8-021', 'S8-023', 'S8-024', 'S8-034', 'S8-035'].includes(id)) {
    const searchTurn = await fake.turn(readTarget, config);
    assert.deepEqual(searchTurn.calls, [searchCall]);
  }
  if (id === 'S8-023' || id === 'S8-034') {
    const temporal = readProjection('ledger', [salesFact()]);
    const count = id === 'S8-034' ? 4 : 2;
    for (let i = 0; i < count; i += 1) await fake.turn(widgetIntent('ledger'), temporal);
  }
  const choice = handle => ({ type: 'record', recordKind: 'menu', querySlot: 'name', handle });
  if (id === 'S8-024') {
    await fake.decision('refer', { type: 'choose', choices: [choice('first-menu'), choice('second-menu')] }, config, { recordKind: 'menu' });
  } else if (id === 'S8-021' || id === 'S8-023') {
    await fake.decision('refer', choice('first-menu'), config, { recordKind: 'menu' });
    if (id === 'S8-023') assert.deepEqual(expected.answer_must_contain, [search.matches[0].label, cafe.menuDisplay.lattePrice]);
  } else {
    const scope = id === 'S8-035' ? { ...config, runId: 'new-run' } : config;
    await fake.decision('refer', unavailable(n02?.resolution ?? 'reference_missing'), scope, { recordKind: 'menu' });
  }
});

group('S8-027 S8-028 S8-029 S8-030 S8-201', async (t, { id, expected, n02 }, utterance) => {
  const picked = kind(utterance, id === 'S8-029' ? 'refer' : 'repeat_read');
  const fake = rig(t);
  const tool = expected.tools.find(step => step.name === 'get_widget');
  const featureId = tool?.args.featureId ?? 'ledger';
  const condition = n02?.scope ? cafe[n02.scope] : tool?.args.condition ?? defaultCondition;
  const fact = id === 'S8-029' ? costFact(cafe.vanilla, cafe.menuDisplay.vanillaCost)
    : id === 'S8-030' ? restockFact : salesFact('ko', id === 'S8-027');
  const setup = id === 'S8-030' ? condition : defaultCondition;
  await fake.turn(widgetIntent(featureId, setup), readProjection(featureId, [featureId === 'ledger' ? salesFact() : fact], setup));
  if (id === 'S8-029') {
    await fake.decision('refer', { type: 'widget', featureId }, readProjection(featureId, [fact]), { featureId });
    expectRead(await fake.turn(widgetIntent(featureId), readProjection(featureId, [fact])), featureId, defaultCondition, expected.answer_must_contain[0]);
    return;
  }
  const period = picked.period === 'month' ? { period: picked.period, month: picked.month } : picked.period ? { period: picked.period } : {};
  const projection = id === 'S8-028' ? { catalog: [widget(featureId)], snapshot: [
    { featureId, condition, status: 'unsupported_period' },
  ] } : readProjection(featureId, [fact], condition);
  const result = await fake.turn(control('repeat_read', period), projection);
  expectRead(result, featureId, condition, expected.answer_must_contain[0]);
});

group('S8-032 S8-033 S8-041 S8-056', async (t, { id, expected, n02 }, utterance) => {
  const fake = rig(t);
  const asked = await menuTurn(fake, { price: false });
  assert.equal(asked.done.clarification.field, 'price');
  assert.deepEqual(asked.calls, [searchCall]);
  const { pendingId } = asked.done;
  assert.ok(pendingId);
  const answer = normalizeConversationTurn(utterance, { pending: true });
  if (id === 'S8-041') {
    assert.equal(answer.kind, 'edit');
    await fake.decision('edit', { type: 'edit', pendingId }, {}, { pendingId });
    const replacement = await menuTurn(fake, { price: false });
    assert.notEqual(replacement.done.pendingId, pendingId);
    assert.equal(replacement.done.clarification.field, 'price');
  } else if (id === 'S8-032' || n02?.continue) {
    assert.equal(answer.kind, 'value');
    await fake.decision('continue', { type: 'continue', pendingId, field: 'price' }, {}, { pendingId });
    expectMenuProposal(await menuTurn(fake));
    if (n02?.continue) assert.equal(expected.kind, 'proposal');
  } else {
    assert.equal(answer.kind, 'hold');
    await fake.decision('hold', { type: 'hold' });
    await fake.decision('continue', { type: 'continue', pendingId, field: 'price' }, {}, { pendingId });
  }
});

group('S8-036 S8-037 S8-038 S8-040 S8-042 S8-043 S8-044 S8-050', async (t, { id, expected, n02 }, utterance) => {
  const fake = rig(t);
  const pendingId = expectMenuProposal(await menuTurn(fake));
  kind(utterance, 'edit', true);
  await fake.decision('edit', { type: 'edit', pendingId }, {}, { pendingId });
  const old = await fake.decision('confirm', unavailable('pending_missing'), {}, { pendingId });
  assert.equal(old.proposal, undefined);
  if (n02?.recheck) {
    const fresh = await menuTurn(fake);
    assert.notEqual(expectMenuProposal(fresh), pendingId);
    assert.deepEqual(fresh.calls, expected.tools);
    const nowDuplicate = await menuTurn(fake, { matches: [record('new-match', '동백 라테', 'exact')] });
    assert.equal(nowDuplicate.done.refusal.reason, 'duplicate');
    assert.deepEqual(nowDuplicate.calls, [searchCall]);
    assert.equal(nowDuplicate.proposal, undefined);
  }
  if (id === 'S8-036') {
    const searches = [menu(cafe.latteChoices.map(({ id, name }) => record(id, name, 'similar')))];
    const next = await fake.turn({ kind: 'read', recordKind: 'menu', querySlot: 'name' }, { slots: ['name'], searches });
    assert.equal(next.done.outcome, 'ambiguous');
    assert.deepEqual(next.done.clarification.choices.map(choice => choice.label), expected.answer_must_contain);
    assert.deepEqual(next.calls, [searchCall]);
  }
});

group('S8-025 S8-026 S8-055', async (t, { id }, utterance) => {
  kind(utterance, 'repeat_command');
  const fake = rig(t, { agentAdapters: [updateAdapter] });
  const pendingId = await targetProposal(fake);
  await fake.decision(id === 'S8-055' ? 'cancel' : 'confirm', { type: id === 'S8-055' ? 'cancel' : 'confirm', pendingId }, {}, { pendingId });
  await fake.decision('repeat_command', { type: 'reprepare', command: 'menu.setSaleStatus' });
});

group('S8-079 S8-086', async (t, { n02 }, utterance) => {
  const parsed = kind(utterance, 'alias');
  const label = n02?.label ?? cafe.americano.name;
  assert.equal(parsed.target, n02?.alias ?? '아메리카노');
  const searches = [menu([record('matching-alias', label, 'similar')])];
  const reply = await rig(t).turn({ kind: 'read', recordKind: 'menu', querySlot: 'name' }, { slots: ['name'], searches });
  assert.equal(reply.done.outcome, 'ambiguous');
  assert.equal(reply.done.clarification.choices[0].label, label);
  assert.deepEqual(reply.calls, [searchCall]);
});

group('S8-083 S8-090 S8-096 S8-134 S8-135 S8-139 S8-144 S8-193 S8-194 S8-195 S8-200',
  async (t, { id, expected, n02 }, utterance, index) => {
    const fake = rig(t, { agentAdapters: [updateAdapter] });
    const hasPending = ['S8-193', 'S8-194', 'S8-195', 'S8-200'].includes(id);
    const pendingId = hasPending ? await targetProposal(fake) : undefined;
    const parsed = normalizeConversationTurn(utterance, { pending: hasPending });
    if (n02?.control === 'edit') {
      assert.equal(parsed.kind, 'edit');
      await fake.decision('edit', { type: 'edit', pendingId }, {}, { pendingId });
      await fake.decision('confirm', unavailable('pending_missing'), {}, { pendingId });
      return;
    }
    const locale = n02?.locale ?? (id === 'S8-135' ? 'en' : 'ko');
    if (n02?.scope === 'yesterdayRange') {
      assert.equal(parsed.kind, 'repeat_read');
      await fake.turn(widgetIntent('ledger'), readProjection('ledger', [salesFact(locale)], defaultCondition, locale));
      const { condition } = expected.tools[0].args;
      expectRead(await fake.turn(control('repeat_read', { period: parsed.period }), readProjection('ledger', [salesFact(locale, true)], condition, locale)),
        'ledger', condition, expected.answer_must_contain[0]);
      return;
    }
    assert.equal(parsed.kind, 'read');
    const featureId = n02?.projection ?? (id === 'S8-096' ? 'menu' : id === 'S8-200' && index === 2 ? 'tax'
      : id === 'S8-194' && index === 2 || id === 'S8-200' && index === 1 ? 'inventory-booking' : 'ledger');
    assert.equal(parsed.featureId, featureId);
    const fact = featureId === 'menu' ? costFact(cafe.americano, cafe.menuDisplay.americanoCost)
      : featureId === 'inventory-booking' ? restockFact : featureId === 'tax' ? taxFact : salesFact(locale);
    const condition = featureId === 'inventory-booking' ? cafe.inventoryToday : defaultCondition;
    const answer = await fake.turn(widgetIntent(featureId, condition), readProjection(featureId, [fact], condition, locale));
    expectRead(answer, featureId, condition, fact.display);
    if (pendingId) await fake.decision('confirm', { type: 'confirm', pendingId }, {}, { pendingId });
  });

group('S8-188', async (t, { expected }, utterance) => {
  const { featureId } = kind(utterance, 'read');
  const projection = readProjection(featureId, [salesFact()]);
  let first = true;
  const started = deferred();
  const release = deferred();
  const fake = rig(t, { async agentFetch(url, options) {
    if (first) {
      first = false;
      started.resolve();
      await release.promise;
    }
    return navisAgentFakeFetch(url, options);
  } });
  const earlier = fake.turn(widgetIntent(featureId), projection, { acceptsCancellation: true });
  await started.promise;
  try {
    const later = await fake.turn(widgetIntent(featureId), projection);
    expectRead(later, 'ledger', defaultCondition, expected.answer_must_contain[0]);
    assert.deepEqual(await earlier, { cancelled: true });
  } finally {
    release.resolve();
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

group('S8-092 S8-093 S8-136 S8-140 S8-189 S8-192', async (t, { id, expected, menuMatch }, utterance) => {
  const pending = id === 'S8-192';
  const parsed = normalizeConversationTurn(utterance);
  assert.equal(parsed.kind, 'intent');
  const key = normalizeConversationAlias(parsed.text).key;
  assert.match(key, /고구마라테|카라멜마키아토|흑임자라테|쑥라테|모카/u);
  const fake = rig(t);
  const pendingId = pending ? expectMenuProposal(await menuTurn(fake)) : undefined;
  if (id === 'S8-189') {
    // A local block (busy or editing) leaves canonical state alone. No new request.
    await fake.decision('hold', { type: 'hold' });
    return;
  }
  if (menuMatch) {
    const result = await menuTurn(fake, { matches: [record('duplicate', menuMatch.label, menuMatch.match)] });
    assert.equal(expected.kind, 'refuse');
    assert.equal(result.done.refusal.reason, 'duplicate');
    assert.deepEqual(result.calls, expected.tools);
    assert.equal(result.proposal, undefined);
  } else if (id === 'S8-136' || id === 'S8-140') {
    const missing = await menuTurn(fake, { price: false });
    assert.equal(missing.done.clarification.field, 'price');
    assert.deepEqual(missing.calls, [searchCall]);
  } else {
    const latest = expectMenuProposal(await menuTurn(fake));
    if (pendingId) {
      assert.notEqual(latest, pendingId);
      await fake.decision('confirm', unavailable('pending_missing'), {}, { pendingId });
    }
  }
});

group('S8-094 S8-099 S8-098 S8-143 S8-145 S8-146 S8-147 S8-148 S8-149', async (_t, { id }, utterance) => {
  const text = id === 'S8-094' ? `${'긴 메모 '.repeat(1000)}${utterance.slice(utterance.indexOf(')') + 1)}` : utterance;
  const reasons = {
    'S8-094': 'too_long', 'S8-099': 'automation', 'S8-098': 'declined', 'S8-143': 'unsupported_language',
    'S8-145': 'empty', 'S8-146': 'unsupported', 'S8-147': 'unsupported', 'S8-148': 'greeting', 'S8-149': 'unsupported',
  };
  const parsed = normalizeConversationTurn(text);
  assert.equal(parsed.reason, reasons[id]);
  assert.equal(parsed.kind, id === 'S8-094' || id === 'S8-099' ? 'refused' : 'reply');
  assert.equal('text' in parsed, false, 'ignored input was retained');
});

group('S8-077 S8-078 S8-080 S8-081 S8-082 S8-084 S8-085 S8-087 S8-088 S8-089 S8-091 S8-095 S8-097 S8-137 S8-138 S8-141 S8-142 S8-150',
  async (_t, _scenario, utterance) => {
    const parsed = kind(utterance, 'intent');
    const normalized = normalizeConversationAlias(parsed.text).key;
    assert.match(normalized, /아메리카노|카페라테|크루아상|휘낭시에|우유|위생점검/u, 'expected target lost in normalization');
    assert.match(normalized, /가격|판매가|값|price|품절|soldout|5000|5,000|4800|4천8백|5리터|5l|일정/u, 'expected operation lost in normalization');
  });

group('S8-198 S8-199', async (t, { id, n02 }, utterance) => {
  const parsed = normalizeConversationTurn(utterance);
  assert.ok(parsed.kind === 'intent');
  const fake = rig(t, { agentAdapters: [updateAdapter] });
  const pendingId = await targetProposal(fake);
  if (id === 'S8-198') {
    const replacementId = await targetProposal(fake);
    assert.notEqual(replacementId, pendingId);
    await fake.decision('confirm', unavailable('pending_missing'), {}, { pendingId });
  } else {
    await fake.decision('confirm', { type: n02.resolution, command: 'menu.setSaleStatus', pendingId }, { layer: 'marketing' }, { pendingId });
  }
});

test('N02 corpus contract: every assigned ID and every dependency has a per-variant check', async t => {
  assert.equal(selected.filter(row => row.slice_id === 'N02').length, 59);
  assert.equal(selected.length, 105);
  assert.equal(cases.size, selected.length);
  const totals = { assigned: 0, dependency: 0, variants: 0, errata: 0, failures: 0 };
  for (const row of selected) {
    const scenario = data.get(row.scenario_id);
    const verify = cases.get(row.scenario_id);
    assert.ok(scenario?.utterances.length && verify, `missing N02 case ${row.scenario_id}`);
    let passed = 0;
    await t.test(row.scenario_id, async sub => {
      for (const [index, utterance] of scenario.utterances.entries()) {
        try {
          await verify(sub, scenarioVariant(scenario, index), utterance, index);
          passed += 1;
        } catch (error) {
          // Report only scenario identity and assertion category, never an utterance.
          sub.diagnostic(`Variant ${index + 1}: ${error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : error.name}`);
        }
      }
      totals.variants += scenario.utterances.length;
      if (overlay[row.scenario_id]?.n02) {
        totals.errata += 1;
        sub.diagnostic(`Fixture erratum: ${scenario.review}`);
      }
      assert.equal(passed, scenario.utterances.length, 'N02 variant count');
    });
    if (passed !== scenario.utterances.length) totals.failures += 1;
    else totals[row.slice_id === 'N02' ? 'assigned' : 'dependency'] += 1;
  }
  t.diagnostic(`${totals.assigned} of 59 assigned and ${totals.assigned + totals.dependency} of 105 N02 dependencies passed their reviewed N02 checks, across ${totals.variants} variants, with ${totals.errata} fixture errata and ${totals.failures} failed scenarios.`);
});

test('stale menu confirmation rechecks an updated projection and emits a fresh card', async t => {
  const fake = rig(t);
  const oldId = expectMenuProposal(await menuTurn(fake));
  const next = await fake.turn(control('confirm', { pendingId: oldId }), {
    snapshotRevision: 9, slots: ['name', 'price'], searches: [menu()],
  });
  const nextId = expectMenuProposal(next);
  assert.notEqual(nextId, oldId);
  assert.equal(next.proposal.snapshotRevision, 9);
  await fake.decision('confirm', unavailable('pending_missing'), { snapshotRevision: 9 }, { pendingId: oldId });
  await fake.decision('confirm', { type: 'confirm', pendingId: nextId }, { snapshotRevision: 9 }, { pendingId: nextId });
});

test('a read preserves a pending typed clarification across the bridge', async t => {
  const fake = rig(t);
  const missing = await menuTurn(fake, { price: false });
  const facts = [salesFact()];
  const read = await fake.turn(widgetIntent('ledger'), readProjection('ledger', facts));
  expectRead(read, 'ledger');
  await fake.decision('continue', { type: 'continue', pendingId: missing.done.pendingId, field: 'price' }, {}, { pendingId: missing.done.pendingId });
});
