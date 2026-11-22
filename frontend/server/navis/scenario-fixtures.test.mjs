import assert from 'node:assert/strict';
import test from 'node:test';
import { readCafeScenarios, scenarioVariant } from './scenario-fixtures.mjs';
import { expectedContract } from '../dev/navis-scenario-contract.mjs';

test('a supplied overlay resolves against facts extended after loading the café selectors', async () => {
  const overlay = {
    'S1-001': { reason: 'injected overlay', expected: { answer_must_contain: ['{{reviewed.proof}}'] } },
  };
  const { corpus, facts } = await readCafeScenarios(undefined, {
    overlay, extendFacts: base => ({ ...base, reviewed: { proof: `reviewed-${base.today}` } }),
  });
  assert.deepEqual(corpus.get('S1-001').expected.answer_must_contain, [`reviewed-${facts.today}`]);
  assert.equal(corpus.get('S1-001').review, 'injected overlay');
  assert.deepEqual(Object.keys(overlay), ['S1-001']);
});

test('resolves approved promotion labels and compiles the reviewed second design to the stable wire field', async () => {
  const { corpus } = await readCafeScenarios(undefined, { overlay: {
    'S6-009': { reason: 'approved designs', expected: { tools: [], answer_must_contain: ['{{promo.designs.names}}'] } },
    'S6-019': { reason: 'approved themes', expected: { tools: [], answer_must_contain: ['{{promo.themes}}'] } },
    'S6-023': { reason: 'numbered design', expected: { kind: 'clarify', ask: ['designRef'], tools: [] },
      variants: { 2: { expected: { kind: 'proposal', ask: [], tools: [{
        name: 'propose_action', args: { command: 'promo.draft.set', args: { designRef: '{{promo.designs.1.id}}', lengthSec: 15 } },
      }] } } } },
  } });
  for (const id of ['S6-009', 'S6-019', 'S6-023']) assert.equal(corpus.get(id).fixtureBlock, undefined);
  assert.deepEqual(expectedContract(corpus.get('S6-009')).answer, [
    '단톡방 대화 + 남은 수량 카운트다운', '디자인 2번', '진열대 천천히 훑기', '손에 든 한 입 클로즈업', '우리 가게 하루 타임라인', '손글씨 감성 카드',
  ]);
  assert.deepEqual(expectedContract(corpus.get('S6-019')).answer, [
    '매장 소개', '만드는 과정', '오늘의 할인', '신메뉴 소개', '우리 가게 하루',
  ]);
  const scenario = corpus.get('S6-023');
  assert.deepEqual(expectedContract(scenario).ask, ['referenceId']);
  const numbered = scenarioVariant(scenario, 1);
  assert.equal(numbered.fixtureBlock, undefined);
  assert.deepEqual(expectedContract(numbered).wire, [{
    name: 'propose_action', args: { command: 'promo.draft.set', args: { referenceId: 'ref-2', lengthSec: 15 } },
  }]);
});

test('an unknown scenario or variant token blocks only that entry', async () => {
  const { corpus } = await readCafeScenarios(undefined, { overlay: {
    'S1-001': { reason: 'scenario token absent', expected: { answer_must_contain: ['{{unknown.scenario}}'] } },
    'S1-002': { reason: 'variant token absent', expected: { answer_must_contain: ['{{today}}'] },
      variants: { 1: { expected: { answer_must_contain: ['{{unknown.variant}}'] } }, 2: { expected: { answer_must_contain: ['sibling'] } } } },
  } });
  assert.equal(corpus.get('S1-001').fixtureBlock, 'missing-token unknown.scenario');
  const second = corpus.get('S1-002');
  assert.equal(second.fixtureBlock, undefined);
  assert.equal(scenarioVariant(second, 0).fixtureBlock, 'missing-token unknown.variant');
  assert.equal(scenarioVariant(second, 1).fixtureBlock, undefined);
  assert.deepEqual(scenarioVariant(second, 1).expected.answer_must_contain, ['sibling']);
});

test('the reviewed tax evidence requests expect a local widget handoff with no chat write', async () => {
  const { corpus } = await readCafeScenarios();
  for (const id of ['S2-088', 'S2-091']) {
    const scenario = corpus.get(id);
    const contract = expectedContract(scenario);
    assert.equal(contract.kind, 'refuse');
    assert.equal(contract.widgetOnly, true);
    assert.equal(contract.state, 'unchanged');
    assert.deepEqual(contract.wire, []);
    assert.equal(scenario.writes, 'none');
  }
});
