import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, navisAgentFakeFetch } from '../fixtures/navis-eval-fake.mjs';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest } from '../../shared/navis-agent-schema.mjs';
import { readCafeScenarios, readTrace, scenarioVariant } from './scenario-fixtures.mjs';

const trace = readTrace();
const assigned = trace.filter(row => row.slice_id === 'N13');
const dependencies = trace.filter(row => row.required_slices.split('|').includes('N13') && row.slice_id !== 'N13');
const vite = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, envDir: false,
  logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false },
});
const load = path => vite.ssrLoadModule(`/src/${path}.ts`);
let corpus, facts, data, seed, money, provider, actions, nav, runs, catalog, presets, motion, session, dates, domains, coordinator;
try {
  ({ corpus, facts } = await readCafeScenarios(vite));
  [data, seed, money, provider, actions, nav, runs, catalog, presets, motion, session, dates] = await Promise.all([
    load('data/widget-data'), load('data/iteration7/custom-orders/seed'), load('data/pos/projection'),
    load('features/assistant/provider'), load('features/assistant/agent-actions'), load('screens/dashboard/navis-navigation'), load('state/index'),
    load('catalog/index'), load('layout/presets'), load('ui/motion'), load('app/test-session'), load('data/db/time'),
  ]);
  const [{ createDomainRegistry }, { customDomain, withCustomPickup }, { bookingDomain }, { membersDomain }] = await Promise.all([
    load('features/assistant/domains/registry'), load('features/assistant/domains/custom'),
    load('features/assistant/domains/booking'), load('features/assistant/domains/members'),
  ]);
  domains = createDomainRegistry([customDomain, withCustomPickup(bookingDomain), membersDomain]);
  coordinator = await load('app/session-actions'); // D-326 bound pickup receipt.
} finally {
  await vite.close();
}

function openRun() {
  const run = runs.createRunStore({ screenPreset: presets.screenPresets.A, catalog: catalog.getRegistry('A'), time: motion.timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  session.beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  return run;
}

const cafe = data.createWidgetDataStore().getSnapshot();
const tomorrow = dates.addDays(facts.today, 1);
const afterTomorrow = dates.addDays(facts.today, 2);
const now = `${facts.today}T${facts.clock}`;
const cafeReads = new Set(['S1-070', 'S1-071', 'S1-072', 'S1-074', 'S1-075', 'S1-079', 'S1-080', 'S1-121', 'S1-123']);
const custom = store => data.selectCustomOrders(data.selectCustomOrderRead(store.getSnapshot()));
const order = (store, id = 'CO-002') => custom(store).orders.find(row => row.customOrderId === id);

function apply(store, command) {
  const receipt = store.dispatch(command);
  assert.ok(receipt.ok, JSON.stringify({ command: command.type, receipt }));
  return receipt.value;
}

function fixtureStore(id, runId) {
  // Use the actual café seed unless the authored scenario needs a different
  // order state. Explicit scenario arrangements never alter runtime seed data.
  if (corpus.get(id).n13Cafe || cafeReads.has(id)) return data.createWidgetDataStore(undefined, { runId });
  const fixture = seed.createLegacyCustomOrderSeed();
  const date = stamp => stamp?.replace('2026-10-26', facts.today).replace('2026-10-27', tomorrow) ?? null;
  const { customTemplate, customOrder, reservation } = fixture.tables;
  const templates = customTemplate.map(row => id === 'S1-122' && row.templateId === 'CT-CAKE'
    ? { ...row, templateId: 'fixture-cake-template', fields: facts.template.fields } : row);
  const store = data.createWidgetDataStore({
    customTemplate: templates,
    customOrder: customOrder.map(row => {
      const templateSnapshot = templates.find(template => template.name === row.templateSnapshot.name);
      return { ...row, templateId: templateSnapshot.templateId, templateSnapshot,
        desiredPickupAt: date(row.desiredPickupAt), proposedPickupAt: date(row.proposedPickupAt),
        history: row.history.map(entry => ({ ...entry, at: date(entry.at) })) };
    }),
    reservation: [...cafe.tables.reservation.filter(row => row.kind === 'visit'), ...reservation.map(row => ({ ...row, date: date(row.date), updatedAt: date(row.updatedAt) }))],
  }, { runId, pos: money.applyCustomMoney(cafe.pos, {
    ...fixture.money, settlements: fixture.money.settlements.map(row => ({ ...row, at: date(row.at) })),
    payments: fixture.money.payments.map(row => ({ ...row, at: date(row.at) })),
  }) });

  // The older proposal fixtures name the same explicit synthetic member.
  apply(store, { type: 'members.update', memberId: 'M-0001', name: '김도현', phone: '01055552481' });
  if (['S1-104', 'S1-107', 'S1-110', 'S1-119'].includes(id)) {
    apply(store, { type: 'customOrder.recordDecision', customOrderId: 'CO-002', quoteRevision: 1, decision: 'approved',
      paymentTiming: id === 'S1-110' ? 'advance' : 'on_pickup', idempotencyKey: id });
  }
  if (id === 'S1-113') apply(store, { type: 'customOrder.receive', customOrderId: 'CO-001', idempotencyKey: id });
  return store;
}

function assertReflection(id, store, before, variant) {
  const previous = data.selectCustomOrders(data.selectCustomOrderRead(before));
  const selected = custom(store);
  const cake = order(store, 'CO-001');
  const gift = order(store);
  switch (id) {
    case 'S1-081':
    case 'S1-085':
    case 'S1-089': {
      const created = order(store, 'CO-003');
      const member = id === 'S1-081' ? null : 'M-0001';
      assert.equal(created.memberId, member);
      assert.equal(created.stage, 'received');
      assert.equal(created.quoteRevision, 0);
      assert.equal(created.pickup, null);
      assert.equal(selected.summary.inProgress, previous.summary.inProgress + 1);
      assert.equal(created.desiredPickupAt, id === 'S1-081' ? `${tomorrow}T15:00` : id === 'S1-085' ? `${afterTomorrow}T14:00` : `${tomorrow}T17:00`);
      if (id === 'S1-089') assert.deepEqual(created.answers.extras, ['candle']);
      if (id === 'S1-081') assert.equal(created.answers.message, '생일 축하해요');
      break;
    }
    case 'S1-090':
      assert.equal(cake.request, ['초 5개 꽂아주세요', '초 5개 꽂아달라고', '초 5개'][variant]);
      assert.equal(cake.quoteRevision, previous.orders[0].quoteRevision);
      assert.deepEqual(cake.payment, previous.orders[0].payment);
      break;
    case 'S1-091':
    case 'S1-093':
      assert.equal(gift.quoteRevision, 2);
      assert.equal(gift.stage, 'quote_pending');
      assert.equal(gift.approvedQuoteRevision, null);
      assert.equal(gift.pickup, null);
      assert.equal(id === 'S1-091' ? gift.quantity : gift.desiredPickupAt, id === 'S1-091' ? 30 : `${afterTomorrow}T14:00`);
      break;
    case 'S1-094':
      assert.equal(gift.quoteAmount, 65000);
      assert.equal(gift.quoteRevision, 2);
      assert.equal(gift.customerDecision, 'pending');
      assert.equal(gift.proposedPickupAt, `${tomorrow}T14:00`);
      break;
    case 'S1-099':
    case 'S1-101': {
      assert.equal(gift.stage, id === 'S1-099' ? 'in_production' : 'payment_pending');
      assert.equal(gift.approvedQuoteRevision, gift.quoteRevision);
      assert.equal(gift.pickup?.status, 'confirmed');
      assert.equal(gift.confirmedPickupAt, `${tomorrow}T14:00`);
      const pickup = data.selectCalendar(store.getSnapshot(), { date: tomorrow }).pickupEntries
        .find(event => event.id === 'custom-pickup:CO-002');
      assert.ok(pickup, 'approved order appears in the calendar');
      assert.equal(pickup.source, 'pickup');
      assert.equal(pickup.time, '14:00');
      assert.ok(!data.selectReservations(store.getSnapshot(), { date: tomorrow }).rows.some(row => row.reservationId === gift.pickupReservationId));
      break;
    }
    case 'S1-102':
    case 'S1-103':
      assert.equal(gift.customerDecision, id === 'S1-102' ? 'rejected' : 'revision_requested');
      assert.equal(gift.stage, id === 'S1-102' ? 'quote_pending' : 'revision_requested');
      assert.equal(gift.pickup, null);
      break;
    case 'S1-107':
      assert.equal(gift.stage, 'production_complete');
      break;
    case 'S1-114':
    case 'S1-119':
      assert.equal(gift.stage, 'canceled');
      assert.equal(selected.summary.inProgress, previous.summary.inProgress - 1);
      if (id === 'S1-119') {
        assert.equal(gift.pickup.status, 'canceled');
        assert.equal(selected.summary.tomorrowPickup, previous.summary.tomorrowPickup - 1);
      }
      break;
    case 'S1-116':
      assert.equal(cake.pickup.time, '18:00');
      assert.equal(cake.history.at(-1).kind, 'rescheduled');
      break;
    case 'S1-120':
      assert.match(selected.templates.find(template => template.templateId === 'CT-001').name, /쿠키 주문서 · 선물/u);
      break;
    case 'S1-122': {
      const template = selected.templates.find(template => template.templateId === 'fixture-cake-template');
      assert.equal(template.name, '생일 케이크 주문서');
      assert.equal(template.revision, 2);
      assert.deepEqual(template.fields, facts.template.fields);
      break;
    }
    case 'S1-124':
      assert.ok(!selected.templates.some(template => template.templateId === 'CT-GIFT'));
      assert.deepEqual(gift.templateSnapshot, previous.orders.find(row => row.customOrderId === 'CO-002').templateSnapshot);
      break;
    default:
      assert.fail(`Missing reflection assertion for ${id}`);
  }
}

function capture(run, store) {
  const replies = [];
  const harness = createNavisMenuHarness(options => createBridge({
    ...options, agentMode: 'fake', onDiagnostics() {},
  }), validateAgentFrame, navisAgentFakeFetch);
  const assistant = provider.createAssistantProvider({ run, store, domains, async fetcher(_url, init) {
    const input = JSON.parse(init.body);
    assert.equal(init.headers[AGENT_PROTOCOL_HEADER], AGENT_PROTOCOL);
    assert.ok(validateAgentRequest(input));
    const result = await harness.run(input);
    replies.push({ input, result });
    return new Response(result.raw, { status: result.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL, 'content-type': 'text/event-stream' } });
  } });
  return { assistant, replies, close: harness.close };
}

function kindOf(reply, route) {
  if (route) return 'navigate';
  if (reply.turn?.kind === 'proposal') return 'proposal';
  if (['refusal', 'handoff'].includes(reply.turn?.kind)) return 'refuse';
  if (['clarification', 'ambiguity'].includes(reply.turn?.kind)) return 'clarify';
  return reply.answer ? 'answer' : 'unavailable';
}

const clarificationFields = {
  template: ['templateId'],
  size: ['answers'],
  guest: ['phone'],
  proposedPickupAt: ['date', 'time'],
  field: ['fields'],
};

function assertProposalCalls({ input, result }, command) {
  const { args } = result.proposal;
  const targets = [
    ['customOrder', args.customOrderId], ['customTemplate', args.templateId],
    ['reservation', args.reservationId], ['member', args.memberId],
  ];
  const calls = targets.filter(([, ref]) => ref?.handle).map(([kind, { handle }]) => {
    const lookup = input.searches.find(search => search.kind === kind && search.matches.some(match => match.handle === handle));
    assert.ok(lookup, `Scoped ${kind} lookup`);
    return { name: 'search_records', args: { kind, querySlot: lookup.querySlot } };
  });
  assert.deepEqual(result.calls, [...calls, { name: 'propose_action', args: { command, args } }]);
}

async function checkUtterance(scenario, text, variant) {
  const { id, expected: original } = scenarioVariant(scenario, variant);
  // D-326 supersedes the older widget-only expectation for the staged paid order.
  const expected = id === 'S1-111' ? { kind: 'proposal' } : original;
  const run = openRun();
  const store = fixtureStore(id, run.getState().runId);
  const before = store.getSnapshot();
  const { assistant, replies, close } = capture(run, store);
  const ask = (message, extra) => assistant.ask({ text: message, locale: 'ko', layer: 'management', signal: new AbortController().signal, ...extra });
  try {
    const navigation = nav.createNavisNavigation(run, { highlight() {}, closeChat() {} });
    const plan = nav.classifyNavigation(text, run.getState(), before);
    const prepared = plan && nav.prepareNavigationRequest(plan, run.getState(), navigation);
    let route;
    const reply = await ask(text, prepared && { agentTurn: prepared.agentTurn, onNavigation: action => { route = prepared.resolve(action); } });
    assert.equal(store.getSnapshot(), before, 'typing must not write');
    assert.equal(kindOf(reply, route), expected.kind, `${text} | ${reply.answer}`);

    if (id === 'S1-111') {
      const card = reply.proposalSession;
      const { id: proposalId } = card.getSnapshot().proposal;
      assertProposalCalls(replies.at(-1), 'customOrder.receive');
      await ask('확인');
      assert.equal(store.getSnapshot(), before);
      const receipt = card.confirm(store, proposalId);
      assert.equal(receipt.frame.outcome, 'applied');
      const after = store.getSnapshot();
      assert.equal(order(store, 'CO-001').pickup.status, 'completed');
      assert.deepEqual(after.pos.money.payments, before.pos.money.payments);
      assert.ok(after.pos.customRecognitions.some(row => row.sourceId === 'CO-001' && row.amount === 45_000));
      run.actions.showNotice(receipt.notice);
      await ask('되돌려줘');
      assert.equal(store.getSnapshot(), after);
      assert.ok(receipt.undoToken);
      assert.ok(actions.applyAgentRunUndo(run, store, receipt.undoToken));
      assert.equal(order(store, 'CO-001').pickup.status, 'confirmed');
      assert.deepEqual(store.getSnapshot().pos.money, before.pos.money);
    } else if (['answer', 'refuse', 'clarify'].includes(expected.kind)) {
      const missingGuestName = id === 'S1-083' && variant === 2 && reply.turn.field === 'guestName';
      if (missingGuestName) {
        assert.equal(reply.proposalSession, undefined);
        return 'N13 R5: variant 3 asks again for the supplied guest name.';
      }
      for (const part of expected.answer_must_contain ?? []) assert.ok(reply.answer.includes(part), `${text} | missing ${part} | ${reply.answer}`);
      if (expected.kind === 'clarify' && expected.ask?.length) {
        const fields = expected.ask.flatMap(field => [field, ...(clarificationFields[field] ?? [])]);
        assert.ok(fields.includes(reply.turn.field), `${text} | unexpected field ${reply.turn.field}`);
      }
    } else if (expected.kind === 'navigate') {
      assert.equal(await navigation.execute(plan.command, route), 'opened');
      assert.equal(run.getState().overlay.stack?.at(-1)?.featureId, 'custom-order');
    } else if (expected.kind === 'proposal') {
      const { proposal } = reply.turn;
      const command = expected.tools.find(tool => tool.name === 'propose_action')?.args.command;
      const observed = replies.at(-1)?.result;
      assert.equal(observed?.terminal.outcome, 'proposal');
      assert.equal(proposal.command, command);
      assertProposalCalls(replies.at(-1), command);
      assert.equal(proposal.tier, /(?:cancel|delete)$/u.test(command) ? 'extra-confirm' : 'normal');

      await ask('확인');
      assert.equal(store.getSnapshot(), before, 'typed confirmation must not write');
      if (proposal.tier === 'extra-confirm') {
        assert.equal(proposal.confirm(store).requiresExtraConfirmation, true);
        assert.equal(store.getSnapshot(), before);
      }
      const receipt = proposal.confirm(store, proposal.id);
      assert.equal(receipt?.frame.outcome, 'applied', `${text} | ${JSON.stringify(receipt)}`);
      const after = store.getSnapshot();
      assert.equal(after.revision, before.revision + 1);
      assert.deepEqual(after.pos.money, before.pos.money, 'local order changes leave accounting untouched');
      assertReflection(id, store, before, variant);
      proposal.confirm(store, proposal.id);
      assert.equal(store.getSnapshot(), after, 'repeat confirmation must not write twice');
      if (/^되돌리기/u.test(expected.undo)) {
        assert.equal(receipt.notice?.undo?.target, 'run');
        assert.equal(receipt.notice.undo.token, receipt.undoToken);
        run.actions.showNotice(receipt.notice);
        await ask('되돌려줘');
        assert.equal(store.getSnapshot(), after, 'typed undo must leave the receipt unchanged');
        assert.ok(actions.applyAgentRunUndo(run, store, receipt.undoToken));
        assert.equal(actions.applyAgentRunUndo(run, store, receipt.undoToken), false);
        assert.deepEqual(custom(store), data.selectCustomOrders(data.selectCustomOrderRead(before)));
      } else {
        assert.equal(receipt.undoToken, undefined);
      }
    }
  } finally {
    close();
  }
}

test('D-326 pickup card records and undoes sales atomically, and sends payment-at-pickup to payment', async t => {
  const run = openRun();
  const store = data.createWidgetDataStore(undefined, { runId: run.getState().runId, pos: run.getState().pos, sessionGate: coordinator.sessionGateFor(run) });
  const { custom } = coordinator.createSessionActions(run, store);
  const sameDay = `${facts.today}T17:00`;
  const paidId = custom.read().tables.customOrder.find(row => row.quoteRevision === 0).customOrderId;
  const cashId = custom.read().tables.customOrder.find(row => row.paymentTiming === 'on_pickup' && row.stage === 'in_production').customOrderId;
  apply(store, { type: 'customOrder.quote', customOrderId: paidId, quoteAmount: 45_600, proposedPickupAt: sameDay, idempotencyKey: 'quote' });
  apply(store, { type: 'customOrder.recordDecision', customOrderId: paidId, quoteRevision: 1, decision: 'approved', paymentTiming: 'advance', idempotencyKey: 'approve' });
  const quote = custom.quoteSettlement({ customOrderId: paidId, allocations: [{ kind: 'method', method: 'card', amount: 45_600 }] });
  assert.ok(custom.beginApproval({ quote, idempotencyKey: 'pay' }).ok);
  assert.ok(custom.finishApproval({ runId: run.getState().runId, attemptId: custom.approval().attemptId, outcome: 'approved' }).ok);
  custom.dismissApproval();
  for (const customOrderId of [paidId, cashId]) apply(store, { type: 'customOrder.setStage', customOrderId, nextStage: 'production_complete', idempotencyKey: `made-${customOrderId}` });
  const { assistant, replies, close } = capture(run, store);
  t.after(close);
  const ask = text => assistant.ask({ text, locale: 'ko', layer: 'management', signal: new AbortController().signal });
  const before = store.getSnapshot();
  const blocked = await ask(`${cashId} 수령 완료 처리해줘`);
  assert.equal(blocked.turn?.alternative?.command, 'customOrder.openPayment', blocked.answer);
  assert.equal(blocked.proposalSession, undefined);
  const reply = await ask(`${paidId} 수령 완료 처리해줘`);
  assert.equal(reply.turn?.proposal?.command, 'customOrder.receive', reply.answer);
  assertProposalCalls(replies.at(-1), 'customOrder.receive');
  await ask('확인');
  assert.equal(store.getSnapshot(), before);
  const receipt = reply.proposalSession.confirm(store, reply.turn.proposal.id);
  assert.equal(receipt.frame.outcome, 'applied');
  const after = store.getSnapshot();
  assert.equal(after.pos, run.getState().pos);
  assert.equal(order(store, paidId).pickup.status, 'completed');
  assert.equal(after.pos.money.recognitions.find(row => row.sourceId === paidId).amount, 45_600);
  assert.deepEqual(after.pos.money.payments, before.pos.money.payments);
  assert.deepEqual(after.pos.money.settlements, before.pos.money.settlements);
  assert.deepEqual(after.pos.money.accountTxns, before.pos.money.accountTxns);
  run.actions.showNotice(receipt.notice);
  await ask('되돌려줘');
  assert.equal(store.getSnapshot(), after);
  assert.ok(actions.applyAgentRunUndo(run, store, receipt.undoToken));
  const restored = store.getSnapshot();
  assert.equal(restored.pos, run.getState().pos);
  assert.deepEqual(restored.pos.money.recognitions, before.pos.money.recognitions);
  assert.deepEqual(restored.pos.money.payments, before.pos.money.payments);
  assert.deepEqual(restored.tables.reservation, before.tables.reservation);
  assert.equal(order(store, paidId).stage, 'production_complete');
});

test('N13 covers 52 primary scenarios and two downstream dependencies', () => {
  assert.equal(assigned.length, 52);
  assert.equal(assigned.reduce((total, { scenario_id }) => total + corpus.get(scenario_id).utterances.length, 0), 156);
  assert.equal(trace.filter(row => row.required_slices.split('|').includes('N13')).length, 54);
  assert.deepEqual(dependencies.map(({ scenario_id, slice_id }) => [scenario_id, slice_id]), [['S1-323', 'N21'], ['S1-324', 'N21']]);
  assert.equal(now, '2026-11-17T15:45');
});

for (const { scenario_id: id } of assigned) {
  test(`N13 ${id}`, async t => {
    const scenario = corpus.get(id);
    assert.ok(scenario, id);
    const failures = [];
    let clientException;
    for (const [index, utterance] of scenario.utterances.entries()) {
      try {
        const exception = await checkUtterance(scenario, utterance, index);
        clientException ??= exception;
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        failures.push(`Variant ${index + 1}: ${error.message}`);
      }
    }
    assert.deepEqual(failures, []);
    if (clientException) t.todo(clientException);
  });
}
