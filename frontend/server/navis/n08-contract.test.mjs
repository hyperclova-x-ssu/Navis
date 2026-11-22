import assert from 'node:assert/strict';
import test from 'node:test';
import { URL, fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, navigationRequest } from '../fixtures/navis-eval-fake.mjs';
import { validateAgentDetailRef, validateAgentFrame } from '../../shared/navis-agent-schema.mjs';
import { readCafeScenarios, readTrace } from './scenario-fixtures.mjs';

const trace = readTrace();
const assigned = trace.filter(row => row.slice_id === 'N08');
const dependencies = trace.filter(row => row.required_slices.split('|').includes('N08'));
const vite = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, envDir: false, logLevel: 'silent',
  server: { middlewareMode: true, watch: null, ws: false, hmr: false },
});
let data, tr, createBrowserRun, corpus;
try {
  data = await vite.ssrLoadModule('/src/data/widget-data.ts');
  ({ createBrowserRun } = await vite.ssrLoadModule('/src/app/run.ts'));
  tr = (await vite.ssrLoadModule('/src/features/assistant/messages.ts')).navisTranslator('ko');
  ({ corpus } = await readCafeScenarios(vite));
} finally {
  await vite.close();
}
const { createWidgetDataStore, previewVariants, selectPosClosing, TODAY } = data;
const view = { innerWidth: 1920, innerHeight: 1080, location: { search: '' }, performance: { now: () => 0 } };
const fact = (key, value, label, display = String(value), unit = '') => ({ key, value, label, display, unit });
const ui = (section, facts) => ({ tool: 'get_ui_state', args: section ? { section } : {}, facts });
const amount = value => tr.format.money(value, 'full');
const count = value => tr.format.count(value, 'count');

const clarifications = {
  'S7-121': ['settings.set_theme', {}, 'theme', ['light', 'dark']],
  'S7-128': ['settings.set_locale', {}, 'locale', ['zh-Hans', 'zh-Hant']],
  'S7-139': ['settings.set_preview_variant', { featureId: 'inventory-booking' }, 'variant', []],
};
const refusals = {
  'S7-161': ['closing.closeDay', 'pos-closing'],
  'S7-162': ['closing.undoDay', 'pos-closing'],
  'S7-163': ['pos.drawerMovement', 'pos-closing'],
  'S7-164': ['pos.drawerMovement', 'pos-closing'],
  'S7-165': ['pos.drawerMovement', 'pos-closing'],
  'S7-166': ['pos.refund', 'pos'],
  'S7-167': ['pos.payment', 'pos'],
};

function configureFixture(run, id) {
  if (['S7-119', 'S7-120'].includes(id)) run.actions.setTheme('dark');
  if (id === 'S7-123') run.actions.setTextScale(125);
  if (id === 'S7-129') run.actions.setLocale('en');
  if (['S7-135', 'S7-192'].includes(id)) run.actions.setPreviewFamily('empty');
  if (['S7-135', 'S7-192'].includes(id)) run.actions.setPreviewVariant('inventory-booking', 'partial-data');
  if (id === 'S7-141') {
    run.actions.setPreviewVariant('inventory-booking', 'error');
    run.actions.setPreviewVariant('menu', 'no-menus');
  }
  if (id === 'S7-144') run.actions.setClosingPreview('error');
  if (['S7-168', 'S7-169'].includes(id)) run.actions.setPreviewFamily('empty');
}

function variantFacts(featureId) {
  return previewVariants(featureId).map(variant =>
    fact(`ui.preview.variant.${featureId}`, variant.id, tr.t(`widget.${featureId}.title`), tr.t(variant.labelKey)));
}

function projectedSettings(state, featureId) {
  const { theme, textScale, locale, detailDialogFullscreen, preview, posUi } = state;
  return [
    ui('display', [
      fact('ui.theme', theme, '화면 모드', tr.t(`app.mode.${theme}`)),
      fact('ui.textScale', textScale, '큰 글자', textScale === 125 ? '켜짐' : '꺼짐'),
      fact('ui.locale', locale, '언어', tr.t(`language.${locale}`)),
      fact('ui.detailFullscreen', Number(detailDialogFullscreen), '자세히 보기'),
    ]),
    ui('preview', [
      fact('ui.preview.family', preview.family, '예시 상태', tr.t(`preview.family.${preview.family}`)),
      fact('ui.preview.overrideCount', Object.keys(preview.overrides).length, '예시 상태',
        tr.t('preview.family.byWidgetChip', { n: Object.keys(preview.overrides).length })),
      fact('ui.preview.closing', preview.closing ?? 'inherit', '마감 정산 예시'),
      fact('ui.preview.pos', preview.pos ?? 'inherit', '주문/결제 예시'),
      ...Object.entries(preview.overrides).map(([id, value]) => fact(`ui.preview.override.${id}`, value, '패널별 예시 상태')),
      ...(featureId ? variantFacts(featureId) : []),
    ]),
    ui('pos', [fact('ui.pos.approvalPending', Number(posUi.approval?.status === 'pending'), '결제 승인')]),
  ];
}

function assertReadonly(turn) {
  assert.equal(turn.status, 200, turn.raw);
  assert.equal(turn.proposal, undefined);
  assert.doesNotMatch(turn.raw, /^event: action_result$/mu);
  assert.ok(turn.raw.includes('event: panels\ndata: {"panels":[]}'));
}

function assertRead(turn, call, expectedCopy) {
  assertReadonly(turn);
  assert.deepEqual(turn.terminal, { outcome: 'reply' });
  assert.deepEqual(turn.calls, [call]);
  for (const fragment of expectedCopy) assert.ok(turn.answer.includes(fragment), `${fragment} missing from ${turn.answer}`);
}

async function checkScenario(scenario, ask, state, snapshot) {
  const { id, expected } = scenario;
  const call = expected.tools[0];
  const authored = call?.name ?? '';
  const copy = expected.answer_must_contain ?? [];

  if (id in clarifications) {
    const [command, args, field, choices] = clarifications[id];
    assert.deepEqual(expected.ask, [field]);
    const turn = await ask({ kind: 'command', command, args }, { readings: projectedSettings(state, args.featureId) });
    assertReadonly(turn);
    assert.equal(turn.terminal.outcome, 'clarify');
    assert.equal(turn.terminal.clarification.field, field);
    for (const value of choices) assert.ok(turn.terminal.clarification.choices.some(choice => choice.value === value));
    assert.deepEqual(turn.calls, []);
    if (id === 'S7-139') assert.ok(previewVariants(args.featureId).filter(variant => variant.family === 'empty').length > 1);
    return;
  }

  if (id in refusals) {
    assert.equal(expected.kind, 'refuse');
    const [command, featureId] = refusals[id];
    if (['S7-162', 'S7-167'].includes(id)) assert.equal(selectPosClosing(snapshot, { date: TODAY, scenario: 'normal' }).status, 'closed');
    const turn = await ask({ kind: 'command', command });
    assertReadonly(turn);
    assert.equal(turn.terminal.outcome, 'refused');
    assert.equal(turn.terminal.refusal.reason, 'widget_only');
    assert.equal(turn.terminal.refusal.alternative.featureId, featureId);
    assert.deepEqual(turn.calls, []);
    return;
  }

  if (['S7-119', 'S7-131'].includes(id)) {
    assert.equal(expected.kind, 'answer');
    const [command, args, key, display] = id === 'S7-119'
      ? [authored, call.args, 'ui.theme', '다크'] : ['settings.set_locale', { locale: 'ko' }, 'ui.locale', '한국어'];
    const readings = projectedSettings(state);
    const noop = await ask({ kind: 'command', command, args }, { readings });
    assertReadonly(noop);
    assert.equal(noop.terminal.refusal.reason, 'unavailable');
    assert.deepEqual(noop.calls, []);
    const current = ui('display', readings[0].facts.filter(item => item.key === key));
    assertRead(await ask({ kind: 'read', tool: current.tool }, { readings: [current] }),
      { name: current.tool, args: current.args }, [display]);
    if (id === 'S7-119') {
      const light = ui('display', [fact('ui.theme', 'light', '화면 모드', tr.t('app.mode.light'))]);
      assertRead(await ask({ kind: 'read', tool: light.tool }, { readings: [light] }),
        { name: light.tool, args: light.args }, ['라이트']);
    }
    return;
  }

  if (id === 'S7-181') {
    const featureId = 'inventory-booking';
    const variants = variantFacts(featureId);
    const current = ui('preview', variants);
    assert.ok(variants.length >= 2);
    assertRead(await ask({ kind: 'read', tool: current.tool }, { readings: [current] }),
      { name: current.tool, args: current.args }, variants.map(fact => fact.display));
    return;
  }

  if (authored.startsWith('settings.')) {
    // Released action policy requires a card. The two authored steps in S7-145
    // are represented by one atomic POS preview command.
    assert.equal(expected.confirm, 'none');
    const { name: command, args: authoredArgs } = expected.tools.at(-1);
    const args = command === 'settings.set_closing_preview' ? { scenario: authoredArgs.variant } : authoredArgs;
    const intent = { kind: 'command', command, args };
    const turn = await ask(intent, { readings: projectedSettings(state, args.featureId) });
    assert.equal(turn.status, 200, turn.raw);
    assert.deepEqual(turn.terminal, { outcome: 'proposal' });
    assert.deepEqual(turn.calls, [{ name: 'propose_action', args: { command, args } }]);
    assert.equal(turn.proposal.runId, state.runId);
    assert.equal(turn.proposal.snapshotRevision, snapshot.revision);
    assert.equal(turn.proposal.tier, 'normal');
    assert.deepEqual(turn.proposal.args, args);
    assert.doesNotMatch(turn.raw, /^event: action_result$/mu);
    return;
  }

  if (authored.endsWith('open_closing')) {
    const turn = await ask({ kind: 'command', command: 'ui.open_closing', args: call.args });
    assertReadonly(turn);
    assert.equal(turn.terminal.outcome, 'navigate');
    assert.deepEqual(turn.terminal.navigation.args, call.args);
    assert.equal(turn.terminal.navigation.command, 'ui.open_closing');
    assert.deepEqual(turn.calls, []);
    return;
  }

  if (authored === 'get_source') {
    assert.equal(state.preview.family, 'empty');
    const { sourceId, condition } = call.args;
    const actual = selectPosClosing(snapshot, { date: TODAY, scenario: 'normal' });
    assert.equal(actual.status, 'open');
    assert.equal(actual.pendingBills.length, 0);
    assert.equal(actual.canClose, true);
    const facts = [fact('closing.status', actual.status, '마감 상태', '미마감'),
      fact('closing.pendingBills', actual.pendingBills.length, '미결제 주문', count(actual.pendingBills.length), 'count'),
      fact('closing.canClose', Number(actual.canClose), '마감 가능', '가능')];
    assertRead(await ask({ kind: 'read', sourceId, condition }, { snapshot: [{ ...call.args, facts }] }),
      { name: authored, args: call.args }, [...copy, ...(id === 'S7-169' ? ['0건', '가능'] : ['미마감'])]);
    return;
  }

  assert.equal(authored, 'get_ui_state', id);
  const [display, preview] = projectedSettings(state);
  const shop = snapshot.tables.shopSettings;
  const facts = id === 'S7-190' ? display.facts.slice(0, 1)
    : id === 'S7-191' ? display.facts.slice(1, 3)
    : id === 'S7-192' ? preview.facts.slice(0, 2) : [
      fact('ui.shop.businessType', shop.businessType, '업종', '카페'),
      fact('ui.shop.paymentStyle', shop.paymentStyle, '결제 방식', '선불형'),
    ];
  if (id === 'S7-193') assert.deepEqual([shop.businessType, shop.paymentStyle], ['cafe', 'prepaid']);
  assertRead(await ask({ kind: 'read', tool: authored }, { readings: [ui(undefined, facts)] }),
    { name: authored, args: call.args }, copy);
}

test('N08 accounts for all 44 assigned scenarios and all 50 required-slice rows', () => {
  assert.equal(assigned.length, 44);
  assert.equal(new Set(assigned.map(row => row.scenario_id)).size, 44);
  assert.equal(dependencies.length, 50);
  assert.deepEqual(dependencies.filter(row => row.slice_id !== 'N08').map(row => row.scenario_id),
    ['S7-206', 'S7-207', 'S7-208', 'S7-209', 'S7-212', 'S7-215']);
});

// D-365: S7-140 previewed the empty state of the removed 마케팅 성과 widget. The row stays accounted for above; the widget does not exist any more.
const retired = new Set(['S7-140']);
for (const { scenario_id: id } of assigned) {
  const scenario = corpus.get(id);
  assert.ok(scenario, id);
  if (retired.has(id)) {
    test(`${id} ${scenario.utterances[0]} is retired with the widget (D-365)`, () => {
      assert.equal(scenario.widget, 'marketing-performance');
      assert.equal(validateAgentDetailRef({ featureId: 'marketing-performance', view: 'route' }), false);
    });
    continue;
  }
  test(`${id} ${scenario.utterances[0]}`, async t => {
    const harness = createNavisMenuHarness(createBridge, validateAgentFrame);
    const run = createBrowserRun({ theme: 'light', reducedMotion: false }, view);
    t.after(() => { harness.close(); run.dispose(); });
    configureFixture(run, id);
    const state = run.getState();
    const store = createWidgetDataStore(undefined, { runId: state.runId });
    if (['S7-162', 'S7-167'].includes(id)) {
      assert.equal(store.dispatch({ type: 'closing.closeDay', date: TODAY, scenario: 'normal',
        expectedGeneration: 0, idempotencyKey: 'n08-fixture-close' }).ok, true);
    }
    const snapshot = store.getSnapshot();
    const ask = (intent, extra = {}) => harness.run(navigationRequest('', {}, {
      runId: state.runId, snapshotRevision: snapshot.revision, businessDate: TODAY, locale: state.locale, intent, ...extra,
    }));
    await checkScenario(scenario, ask, state, snapshot);
    assert.equal(run.getState(), state);
    assert.equal(store.getSnapshot(), snapshot);
  });
}

test('closing drawer and history are grounded in the normal café snapshot', async t => {
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame);
  t.after(() => harness.close());
  const store = createWidgetDataStore();
  const before = store.getSnapshot();
  const normal = selectPosClosing(before, { date: TODAY, scenario: 'normal' });
  const preview = selectPosClosing(before, { date: TODAY, scenario: 'empty' });
  assert.deepEqual([normal.totals.revenue, normal.totals.paymentCount, normal.drawer.expected, normal.drawer.actual, normal.history.length],
    [831220, 153, 256900, null, 89]);
  assert.deepEqual([preview.totals.revenue, preview.history.length], [0, 0]);
  for (const [tab, facts] of Object.entries({
    drawer: [fact('closing.drawer.expected', normal.drawer.expected, '예상 현금', amount(normal.drawer.expected), 'KRW'),
      fact('closing.drawer.actual', 'unconfirmed', '실제 현금', tr.t('data.pos.drawer.unconfirmed'))],
    history: [fact('closing.history.count', normal.history.length, '정산 이력', count(normal.history.length), 'count')],
  })) {
    const tool = 'get_closing_state';
    const args = { tab, date: TODAY };
    const turn = await harness.run(navigationRequest('', {}, {
      intent: { kind: 'read', tool }, readings: [{ tool, args, facts }], businessDate: TODAY,
    }));
    assertRead(turn, { name: tool, args }, facts.map(fact => fact.display));
  }
  assert.equal(store.getSnapshot(), before);
});
