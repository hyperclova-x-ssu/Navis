import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame } from '../../shared/navis-agent-schema.mjs';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness } from '../fixtures/navis-eval-fake.mjs';
import { readCafeScenarios, readTrace } from './scenario-fixtures.mjs';

const trace = readTrace();
const assigned = trace.filter(row => row.slice_id === 'N11');
const dependencies = trace.filter(row => row.required_slices.split('|').includes('N11'));
const vite = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, envDir: false,
  logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false },
});
let data, clock, runtime, domain, provider, registry, layout, catalog, stateFixtures, guards, testTime, navigation, corpus;
try {
  data = await vite.ssrLoadModule('/src/data/widget-data.ts');
  clock = await vite.ssrLoadModule('/src/data/db/time.ts');
  runtime = await vite.ssrLoadModule('/src/state/index.ts');
  domain = await vite.ssrLoadModule('/src/features/assistant/domains/money.ts');
  provider = await vite.ssrLoadModule('/src/features/assistant/provider.ts');
  registry = await vite.ssrLoadModule('/src/features/assistant/domains/registry.ts');
  layout = await vite.ssrLoadModule('/src/layout/index.ts');
  ({ testTime } = await vite.ssrLoadModule('/src/layout/test-policy.ts'));
  catalog = await vite.ssrLoadModule('/src/catalog/index.ts');
  stateFixtures = await vite.ssrLoadModule('/src/state/test-fixtures.ts');
  guards = await vite.ssrLoadModule('/src/data/commands/management-guards.ts');
  navigation = await vite.ssrLoadModule('/src/screens/dashboard/navis-navigation.ts');
  ({ corpus } = await readCafeScenarios(vite));
} finally {
  await vite.close();
}

const { TODAY, readModel, selectCalendar, selectWidget, widgetFacts } = data;
const approved = { allowExpenseEntry: true, allowExpenseEdit: true, allowTaxDelete: true };
const appDomains = registry.createDomainRegistry([
  domain.createMoneyDomain(approved), ...registry.registeredDomains.filter(adapter => adapter !== domain.moneyDomain),
]);
const bridge = options => createBridge({ ...options, onDiagnostics() {} });
const standard = { kind: 'default' };
const nextDue = snapshot => guards.selectNextTaxPayment(readModel(snapshot, 'tax').payments);

function accept(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function receiveMilk(store) {
  const row = store.getSnapshot().tables.purchaseItem.find(item => item.itemId === 'i-milk');
  const order = accept(store.dispatch({
    type: 'suppliers.createOrder', purchaseItemId: row.purchaseItemId, qty: 8, dueDate: TODAY, idempotencyKey: 'n11-milk-order',
  }));
  const line = store.getSnapshot().tables.purchaseOrderLine.find(item => item.poId === order.value.poId);
  accept(store.dispatch({ type: 'suppliers.recordReceipt', polId: line.polId, qty: line.qtyOrdered, idempotencyKey: 'n11-milk-receipt' }));
  return store.getSnapshot().tables.expense.find(item => item.status === 'candidate');
}

function addTax(store, taxType, amount, dueOn) {
  return accept(store.dispatch({ type: 'tax.createPayment', taxType, amount, dueOn, idempotencyKey: `n11-tax-${taxType}` })).value.taxPaymentId;
}

function scenarioState(id) {
  const run = runtime.createRunStore({
    screenPreset: layout.screenPresets.A, catalog: catalog.getRegistry('A'),
    theme: 'light', time: testTime, clock: () => 0,
  });
  stateFixtures.completeEmptyOnboarding(run);
  const store = data.createWidgetDataStore(id === 'D326-open-expense' ? { dayClosing: [] } : undefined, { runId: run.getState().runId });
  const setup = {};
  if (id === 'D326-open-expense' || id === 'D326-closed-expense') {
    const businessDate = id === 'D326-open-expense' ? clock.addDays(TODAY, -1)
      : store.getSnapshot().tables.dayClosing.find(row => row.scenario === 'normal' && row.status === 'closed').businessDate;
    setup.expenseId = accept(store.dispatch({ type: 'ledger.recordExpense', date: businessDate, category: 'supplies',
      memo: '유리컵 교체', amount: 23_000 })).value.expenseId;
  }
  if (['S7-001', 'S7-007', 'S7-041'].includes(id)) {
    const panels = catalog.getManagementTemplates({ businessType: 'cafe', paymentStyle: 'prepaid', presetId: layout.screenPresets.A.id })[0].panels;
    assert.equal(run.actions.applyLayoutIntent({ type: 'restore', panels }).status, 'accepted');
    if (id !== 'S7-001') {
      accept(run.actions.addPage());
      run.actions.goToPage(1);
    }
  }
  if (['S1-294', 'S1-309', 'S1-311'].includes(id)) {
    setup.candidate = receiveMilk(store);
    assert.ok(setup.candidate);
    if (id === 'S1-311') accept(store.dispatch({ type: 'ledger.confirmCandidate', expenseId: setup.candidate.expenseId }));
  }
  if (id === 'S1-307') {
    accept(store.dispatch({ type: 'ledger.recordExpense', date: clock.addDays(TODAY, -1), category: 'rent', amount: 1_800_000 }));
  }
  if (['S2-053', 'S2-054'].includes(id)) {
    const result = accept(store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'supplies',
      amount: 52_000, memo: '냅킨·빨대', evidence: 'none' }));
    setup.reviewId = result.value.expenseId;
    if (id === 'S2-054') accept(store.dispatch({ type: 'tax.markChecked', refId: setup.reviewId }));
  }
  if (id === 'S2-055') {
    for (const [amount, memo] of [[30_000, '청소용품'], [15_000, '포장지']]) {
      accept(store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount, evidence: 'none', memo }));
    }
  }
  if (id === 'S2-069') {
    const seed = store.getSnapshot();
    assert.equal(guards.findTaxDuplicate(seed.tables.taxPayment, { type: '원천세(10월분)', amount: 132_000, dueOn: '2026-11-10' }), undefined);
    setup.duplicateId = addTax(store, '원천세(10월분)', 132_000, '2026-11-10');
  }
  if (id === 'S2-074') addTax(store, '원천세(10월분)', 132_000, '2026-11-10');
  if (id === 'S2-085') accept(store.dispatch({ type: 'tax.deletePayment', taxPaymentId: nextDue(store.getSnapshot()).taxPaymentId }));
  if (id === 'S2-090') accept(store.dispatch({ type: 'tax.setEvidence', taxPaymentId: nextDue(store.getSnapshot()).taxPaymentId, evidence: 'none' }));
  if (id === 'S2-091') {
    const income = addTax(store, '종합소득세(2025년 귀속)', 2_315_000, '2026-06-01');
    accept(store.dispatch({ type: 'tax.updatePayment', taxPaymentId: income, patch: { status: 'paid', paidOn: '2026-05-28' } }));
    accept(store.dispatch({ type: 'tax.setEvidence', taxPaymentId: income, evidence: 'example' }));
  }
  return { run, store, setup };
}

function fixtureTransport(harness) {
  const requests = [];
  const fetcher = async (_path, init) => {
    const request = JSON.parse(init.body);
    assert.equal(new Headers(init.headers).get(AGENT_PROTOCOL_HEADER), AGENT_PROTOCOL);
    const turn = await harness.run(request);
    requests.push({ ...turn, input: { intent: request.intent, slots: request.slots, catalog: request.catalog.map(entry => entry.id), page: request.page } });
    return new Response(turn.raw, { status: turn.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
  };
  return { requests, fetcher };
}

async function confirmCard(reply, ask, store, before) {
  const card = reply.turn.proposal;
  assert.ok(reply.proposalSession);
  assert.equal(card.confirm(data.createWidgetDataStore()).frame.outcome, 'conflict');
  await ask('응');
  await ask('되돌려줘');
  assert.equal(store.getSnapshot(), before, 'Typed confirmation and undo leave the data unchanged');
  assert.equal(reply.proposalSession.isPending(), true);
  if (card.tier === 'extra-confirm') {
    const first = reply.proposalSession.confirm(store, card.id);
    assert.equal(first.requiresExtraConfirmation, true);
    assert.equal(store.getSnapshot(), before);
  }
  const receipt = reply.proposalSession.confirm(store, card.id, card.tier === 'extra-confirm');
  assert.equal(receipt?.frame?.outcome, 'applied', JSON.stringify(receipt));
  const after = store.getSnapshot();
  assert.deepEqual(card.confirm(store).frame, receipt.frame);
  assert.equal(store.getSnapshot(), after);
  return { after, receipt };
}

function verifyWrite(command, authored, before, after, setup, id, run) {
  if (command === 'layout.add_widget') {
    assert.ok(run.getState().boards.management.pages[0].panels.some(panel => panel.featureId === 'tax'));
    assert.equal(before, after);
    return;
  }
  assert.equal(after.revision, before.revision + 1);
  if (command === 'ledger.recordExpense' || command === 'ledger.confirmCandidate') {
    const amount = authored.amount ?? setup.candidate.amount;
    const row = command === 'ledger.recordExpense' ? after.tables.expense.at(-1)
      : after.tables.expense.find(item => item.expenseId === setup.candidate.expenseId);
    assert.equal(row.amount, amount);
    assert.equal(row.status, 'confirmed');
    assert.equal(row.evidence, authored.evidence ?? setup.candidate?.evidence ?? 'none');
    if (authored.category) assert.equal(row.category, authored.category);
    if (authored.date) assert.equal(row.businessDate, authored.date);
    if (id === 'S1-308') assert.equal(row.memo.raw, '냅킨 보충');
    const ledgerBefore = readModel(before, 'ledger'), ledgerAfter = readModel(after, 'ledger');
    assert.equal(ledgerAfter.expenses.total - ledgerBefore.expenses.total, row.businessDate === TODAY ? amount : 0);
    assert.equal(ledgerAfter.netProfit - ledgerBefore.netProfit, row.businessDate === TODAY ? -amount : 0);
    assert.equal(ledgerAfter.candidates.length, ledgerBefore.candidates.length - (setup.candidate ? 1 : 0));
    if (command === 'ledger.recordExpense' && row.evidence === 'none') {
      assert.equal(ledgerAfter.missingEvidenceCount, ledgerBefore.missingEvidenceCount + 1);
      assert.equal(readModel(after, 'tax').reviewCount, readModel(before, 'tax').reviewCount + 1);
    }
    return;
  }
  if (command === 'tax.createPayment') {
    const row = after.tables.taxPayment.at(-1);
    assert.equal(after.tables.taxPayment.length, before.tables.taxPayment.length + 1);
    assert.deepEqual([row.type.raw, row.amount, row.dueOn, row.status, row.paidOn, row.evidence],
      ['지방소득세', 310_000, id === 'S2-062' ? '2026-11-30' : '2026-10-20', 'unpaid', null, 'none']);
    const calendar = selectCalendar(after, { date: TODAY, start: '2026-10-01', end: '2026-12-31' });
    assert.ok(calendar.entries.some(entry => entry.sourceId === row.taxPaymentId && entry.date === row.dueOn));
    assert.equal(nextDue(after).taxPaymentId, row.taxPaymentId);
    return;
  }
  if (command === 'tax.markChecked') {
    assert.equal(readModel(after, 'tax').reviewCount, readModel(before, 'tax').reviewCount - 1);
    assert.ok(after.tables.taxReview.some(row => row.refId === setup.reviewId && row.status === 'checked'));
    assert.deepEqual(after.tables.taxPayment, before.tables.taxPayment);
    return;
  }
  if (command === 'tax.deletePayment') {
    assert.equal(after.tables.taxPayment.length, before.tables.taxPayment.length - 1);
    const removed = before.tables.taxPayment.filter(row => !after.tables.taxPayment.some(item => item.taxPaymentId === row.taxPaymentId));
    assert.equal(removed[0].status, 'unpaid');
    return;
  }
  const changed = after.tables.taxPayment.filter(row => {
    const original = before.tables.taxPayment.find(item => item.taxPaymentId === row.taxPaymentId);
    return JSON.stringify(row) !== JSON.stringify(original);
  });
  assert.equal(changed.length, 1);
  if (command === 'tax.setEvidence') assert.equal(changed[0].evidence, authored.evidence);
  if (command === 'tax.updatePayment') {
    const original = before.tables.taxPayment.find(row => row.taxPaymentId === changed[0].taxPaymentId);
    assert.deepEqual([changed[0].paidOn, changed[0].status], [original.paidOn, original.status]);
    if (authored.patch.amount !== undefined) assert.equal(changed[0].amount, authored.patch.amount);
    const due = { 'S2-071': '2026-11-15', 'S2-072': '2026-11-27', 'S2-073': '2026-11-20' }[id];
    if (due) {
      assert.equal(changed[0].dueOn, due);
      const entries = selectCalendar(after, { date: TODAY, start: '2026-11-01', end: '2026-12-31' }).entries;
      assert.ok(entries.some(entry => entry.sourceId === changed[0].taxPaymentId && entry.date === due));
    }
    if (id === 'S2-074') assert.equal(changed[0].type.raw, '원천세(11월분)');
  }
}

test('TRACE accounts for 90 primary N11 scenarios and 13 downstream scenarios', () => {
  assert.equal(new Set(assigned.map(row => row.scenario_id)).size, 90);
  assert.equal(dependencies.length, 103);
  assert.ok(assigned.every(row => dependencies.includes(row)));
  assert.deepEqual(dependencies.filter(row => row.slice_id !== 'N11').map(row => row.scenario_id), [
    'S1-320', 'S1-323', 'S2-101', 'S2-102', 'S2-103', 'S4-104', 'S4-107',
    'S4-122', 'S7-211', 'S7-212', 'S8-066', 'S8-071', 'S8-072',
  ]);
});

const paidStatusRequests = new Set(['S2-057', 'S2-058', 'S2-059', 'S2-060', 'S2-075', 'S2-076', 'S2-081']);
const exceptions = {
  'S1-278': 'N11 R5: this calendar week is being read as the rolling seven-day period.',
  'S1-331': 'The combined prompt must return Ledger, inventory and suppliers from one store. The current single-widget route returns Ledger alone.',
};

function scenarioDriver(id) {
  const { store, run, setup } = scenarioState(id);
  const harness = createNavisMenuHarness(bridge, validateAgentFrame);
  const before = store.getSnapshot();
  const transport = fixtureTransport(harness);
  const client = provider.createAssistantProvider({ store, run, domains: appDomains, fetcher: transport.fetcher });
  const navigator = navigation.createNavisNavigation(run, { highlight() {}, closeChat() {} });
  const navigated = [];
  const ask = async (text, plan) => {
    const prepared = plan && navigation.prepareNavigationRequest(plan, run.getState(), navigator);
    return client.ask({ text, signal: new AbortController().signal, ...(prepared ? {
      agentTurn: prepared.agentTurn,
      onNavigation: value => navigated.push(prepared.resolve(value)),
    } : {}) });
  };
  return {
    before, store, run, setup, ask, navigator, navigated, requests: transport.requests,
    close() { harness.close(); run.dispose(); },
  };
}

test('D-326 expense edit shows old and new amounts, restores the row, and refuses a closed day', async t => {
  const open = scenarioDriver('D326-open-expense');
  const closed = scenarioDriver('D326-closed-expense');
  t.after(open.close);
  t.after(closed.close);
  const text = '유리컵 교체 지출 금액을 24000원으로 고쳐줘';
  const reply = await open.ask(text);
  assert.equal(reply.turn?.kind, 'proposal', reply.answer);
  assert.equal(reply.turn.proposal.command, 'ledger.updateExpense');
  assert.equal(open.requests.at(-1).proposal.command, 'ledger.updateExpense');
  const renderedPreview = JSON.stringify(reply.turn.proposal.preview);
  assert.match(renderedPreview, /23[,.]?000|2\.3만/u);
  assert.match(renderedPreview, /24[,.]?000|2\.4만/u);
  const { after, receipt } = await confirmCard(reply, open.ask, open.store, open.before);
  assert.equal(after.tables.expense.find(row => row.expenseId === open.setup.expenseId).amount, 24_000);
  assert.equal(after.tables.expense.length, open.before.tables.expense.length);
  await open.ask('되돌려줘');
  assert.equal(open.store.getSnapshot(), after);
  accept(open.store.undo(receipt.undoToken));
  assert.deepEqual(open.store.getSnapshot().tables.expense, open.before.tables.expense);

  const blocked = await closed.ask(text);
  assert.equal(blocked.turn?.reason, 'widget_only', blocked.answer);
  assert.equal(blocked.turn.alternative.featureId, 'ledger');
  assert.equal(blocked.proposalSession, undefined);
  const denied = closed.store.dispatch({ type: 'ledger.updateExpense', expenseId: closed.setup.expenseId, amount: 24_000, idempotencyKey: 'closed-edit' });
  assert.equal(denied.reason, 'DAY_CLOSED');
  assert.equal(closed.store.getSnapshot(), closed.before);
});

test('All 181 additional N11 utterances leave the store unchanged', async t => {
  let exercised = 0;
  for (const { scenario_id: id } of assigned) {
    const { utterances, expected } = corpus.get(id);
    for (const [index, text] of utterances.slice(1).entries()) {
      const { ask, before, close, navigated, requests, run, store } = scenarioDriver(id);
      try {
        if (id === 'S8-028') await ask('오늘 얼마 벌었어?');
        const plan = expected.kind === 'navigate' ? navigation.classifyNavigation(text, run.getState(), before) : undefined;
        const reply = await ask(text, plan);
        const outcome = navigated[0] ? 'navigate' : reply.turn?.kind ?? 'answer';
        t.diagnostic(`${id} utterance ${index + 2}: ${outcome}`);
        assert.equal(store.getSnapshot(), before, `${id} utterance ${index + 2}`);
        for (const { proposal, terminal } of requests) {
          assert.notEqual(proposal?.command, 'tax.markPaid');
          if (proposal?.command === 'tax.updatePayment') {
            assert.ok(!('status' in proposal.args.patch) && !('paidOn' in proposal.args.patch), id);
          }
          if (proposal?.command === 'tax.deletePayment') assert.equal(proposal.tier, 'extra-confirm');
          assert.notEqual(terminal?.outcome, 'applied');
        }
        exercised++;
      } finally {
        close();
      }
    }
  }
  assert.equal(exercised, 181);
});

for (const { scenario_id: id } of assigned) {
  const { utterances, expected } = corpus.get(id);
  test(`${id} ${utterances[0]}`, { todo: exceptions[id] }, async t => {
    if (paidStatusRequests.has(id)) t.diagnostic(`Policy update ${id}: paid-state requests stay in the tax widget.`);
    const { store, run, setup, before, requests, navigator, navigated, ask, close } = scenarioDriver(id);
    t.after(close);
    if (id === 'S8-028') await ask('오늘 얼마 벌었어?');
    const plan = expected.kind === 'navigate' ? navigation.classifyNavigation(utterances[0], run.getState(), before) : undefined;
    const reply = await ask(utterances[0], plan);
    assert.equal(store.getSnapshot(), before, 'Preparing the reply cannot mutate the store');

    if (paidStatusRequests.has(id)) {
      assert.equal(expected.kind, 'refuse');
      assert.equal(reply.turn?.kind, 'refusal');
      assert.equal(reply.turn.reason, 'widget_only');
      assert.equal(reply.turn.alternative?.featureId, 'tax');
      assert.ok(requests.every(turn => turn.proposal === undefined));
      if (id === 'S2-081') {
        const unpaid = nextDue(before);
        const paidOn = '2026-10-24';
        const calendar = snapshot => selectCalendar(snapshot, { date: TODAY, start: TODAY, end: '2026-12-31' }).entries;
        assert.ok(calendar(before).some(row => row.sourceId === unpaid.taxPaymentId));
        accept(store.dispatch({ type: 'tax.updatePayment', taxPaymentId: unpaid.taxPaymentId, patch: { status: 'paid', paidOn } }));
        const after = store.getSnapshot();
        const paid = after.tables.taxPayment.find(row => row.taxPaymentId === unpaid.taxPaymentId);
        assert.deepEqual([paid.status, paid.paidOn, paid.amount], ['paid', paidOn, unpaid.amount]);
        assert.ok(!calendar(after).some(row => row.sourceId === unpaid.taxPaymentId));
        assert.notEqual(nextDue(after)?.taxPaymentId, unpaid.taxPaymentId);
      }
      return;
    }

    if (['S1-298', 'S1-307', 'S2-087'].includes(id)) {
      if (id === 'S1-307') {
        const duplicate = store.dispatch({ type: 'ledger.recordExpense', category: 'rent', amount: 1_800_000, date: TODAY });
        assert.equal(duplicate.reason, 'LIKELY_DUPLICATE_EXPENSE');
      }
      assert.ok(['clarification', 'ambiguity', 'refusal'].includes(reply.turn?.kind), reply.answer);
      assert.ok(requests.every(turn => !turn.proposal));
      assert.equal(store.getSnapshot(), before);
      return;
    }

    const command = expected.tools.find(tool => tool.name === 'propose_action')?.args;
    if (expected.kind === 'proposal') {
      const wanted = command?.command ?? expected.tools[0].name;
      const response = requests.at(-1);
      assert.equal(reply.turn?.kind, 'proposal', [reply.answer, JSON.stringify(response?.input), JSON.stringify(response?.calls),
        response?.status, response?.raw].filter(Boolean).join('\n'));
      assert.equal(reply.turn.proposal.command, wanted);
      assert.ok(requests.some(turn => turn.proposal?.command === wanted), 'Missing scoped proposal from the fake bridge');
      const { after, receipt } = await confirmCard(reply, ask, store, before);
      verifyWrite(wanted, command?.args ?? {}, before, after, setup, id, run);
      if (wanted === 'ledger.recordExpense' || wanted === 'tax.deletePayment') {
        assert.equal(reply.turn.proposal.tier, wanted === 'tax.deletePayment' ? 'extra-confirm' : 'normal');
        assert.ok(receipt.undoToken);
      }
      if (receipt.undoToken && wanted !== 'layout.add_widget') {
        await ask('되돌려줘');
        assert.equal(store.getSnapshot(), after);
        accept(store.undo(receipt.undoToken));
        for (const table of ['expense', 'taxPayment', 'taxReview', 'dailySales']) {
          assert.deepEqual(store.getSnapshot().tables[table], before.tables[table], table);
        }
      }
      return;
    }

    assert.ok(requests.every(turn => turn.proposal === undefined), 'A read-only case offered a proposal');
    if (expected.kind === 'navigate') {
      const { args } = expected.tools[0];
      assert.equal(navigated.length, 1, reply.answer);
      const [detail] = navigated;
      assert.equal(detail.featureId, args.featureId);
      if (args.view) assert.equal(detail.view, args.view);
      if (['S1-295', 'S2-098'].includes(id)) assert.deepEqual(detail.condition, args.condition);
      if (id === 'S2-100') assert.equal(detail.itemId, args.itemId);
      assert.equal(await navigator.execute(plan.command, detail), 'opened');
      assert.equal(store.getSnapshot(), before);
      return;
    }
    if (expected.kind === 'clarify') {
      assert.ok(['clarification', 'ambiguity'].includes(reply.turn?.kind), reply.answer);
      if (id === 'S2-069') {
        const duplicate = { type: 'tax.createPayment', taxType: '원천세 10월분', amount: 132_000, dueOn: '2026-11-10', idempotencyKey: 'repeat-tax' };
        assert.equal(reply.turn.field, 'confirmDuplicate');
        const result = store.dispatch(duplicate);
        assert.equal(result.reason, 'TAX_PAYMENT_EXISTS');
        assert.equal(result.details.taxPaymentId, setup.duplicateId);
        assert.equal(store.getSnapshot(), before);
        const intentional = { ...duplicate, confirmDuplicate: true };
        const created = accept(store.dispatch(intentional));
        const after = store.getSnapshot();
        assert.equal(accept(store.dispatch(intentional)).value.taxPaymentId, created.value.taxPaymentId);
        assert.equal(store.getSnapshot(), after);
      }
      return;
    }
    if (expected.kind === 'refuse') {
      assert.equal(reply.turn?.kind, 'refusal', reply.answer);
      return;
    }

    assert.ok(reply.answer, 'Missing grounded answer');
    if (id === 'S1-278') {
      const read = requests.flatMap(turn => turn.calls).find(call => call.name === 'get_widget');
      assert.equal(read?.args.condition.start, clock.WEEK_START);
      return;
    }
    if (id === 'S1-331') {
      const reads = new Set(requests.flatMap(turn => turn.calls)
        .filter(call => call.name === 'get_widget').map(call => call.args.featureId));
      assert.deepEqual(reads, new Set(['ledger', 'inventory-booking', 'suppliers']));
      return;
    }
    if (id === 'S2-040') {
      for (const fragment of expected.answer_must_contain) assert.ok(reply.answer.includes(fragment), reply.answer);
      const earlier = addTax(store, '납부 일정 테스트', 25_000, clock.addDays(TODAY, -2));
      const after = store.getSnapshot();
      const fact = widgetFacts(selectWidget(after, 'tax', standard, 'normal')).find(entry => entry.key === 'tax.payment.next');
      const updated = await ask(utterances[0]);
      assert.equal(nextDue(after).taxPaymentId, earlier);
      assert.equal(fact.date, nextDue(after).dueOn);
      assert.match(updated.answer, /11월 15일/u);
      return;
    }
    if (['S1-277', 'S8-028', 'S8-159'].includes(id)) {
      assert.ok(reply.turn?.evidence.some(row => row.status === 'unsupported_period'));
    }
    for (const fragment of expected.answer_must_contain ?? []) {
      assert.ok(reply.answer.includes(fragment), `${fragment} missing in ${reply.answer}`);
    }
  });
}
