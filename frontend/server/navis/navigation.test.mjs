import assert from 'node:assert/strict';
import test from 'node:test';
import * as schema from '../../shared/navis-agent-schema.mjs';
import { createBridge } from '../bridge.mjs';

import {
  createNavisNavigationHarness, navigationRequest, reading,
} from '../fixtures/navis-eval-fake.mjs';

const createRequestHarness = () => createNavisNavigationHarness(createBridge, schema.validateAgentFrame);

test('DetailRef rejects unknown keys, invalid routes, incompatible views and unsupported periods', () => {
  const valid = [
    { featureId: 'menu', view: 'register', prefill: { name: 'Fixture item', price: 5500 } },
    { featureId: 'calendar', tab: 'day', date: '2026-10-30' },
    { featureId: 'tax', tab: 'payments', itemId: 'tax-1' },
    { featureId: 'ledger', condition: { kind: 'dateRange', start: '2026-10-20', end: '2026-10-26' } },
  ];
  for (const ref of valid) assert.equal(schema.validateAgentDetailRef(ref), true);
  for (const ref of [
    { featureId: 'weather' }, { featureId: 'menu', tab: 'ledger' },
    { featureId: 'menu', tab: 'register', view: 'list' }, { featureId: 'menu', date: '2026-10-30' },
    { featureId: 'calendar', date: '2026-02-30' }, { featureId: 'briefing', itemId: 'ref' },
    { featureId: 'menu', view: 'register', prefill: { dispatch: 'send' } },
    { featureId: 'slot-coupon', view: 'send', prefill: { sendMode: 'now', sendTime: '09:00' } },
    { featureId: 'ledger', condition: { kind: 'dateRange', start: '2026-11-01', end: '2026-10-26' } },
    { featureId: 'tax', condition: { kind: 'snapshot', asOf: '2026-10-26' } },
    { featureId: 'menu', view: 'register', itemId: 'same-item' },
    { featureId: 'menu', extra: true },
  ]) assert.equal(schema.validateAgentDetailRef(ref), false, JSON.stringify(ref));
});

test('bridge opens off-board details, scopes targets and clarifies rejected detail fields', async t => {
  const harness = createRequestHarness();
  t.after(harness.close);
  const command = 'ui.openDetail';
  const args = { featureId: 'slot-coupon', view: 'send', prefill: { messageText: { slot: 'draft' } } };
  const input = navigationRequest(command, args, { slots: ['draft'] });
  assert.deepEqual(await harness.run(input), { outcome: 'navigate', navigation: {
    command, args, runId: input.runId, snapshotRevision: 7, layer: 'management', page: 1,
  } });
  let turn = 0;
  for (const [args, field] of [
    [{ featureId: 'menu', unknown: true }, 'target'],
    [{ featureId: 'menu', tab: 'payments' }, 'tab'],
    [{ featureId: 'menu', itemId: { handle: 'foreign' } }, 'itemId'],
    [{ featureId: 'menu', prefill: { price: { slot: 'price' } } }, 'prefill'],
    [{ featureId: 'menu', prefill: { price: 5500 } }, 'prefill'],
    [{ featureId: 'slot-coupon', prefill: { overrideConsent: true } }, 'prefill'],
  ]) {
    const result = await harness.run(navigationRequest(command, args, { runId: `detail-${turn++}` }));
    assert.equal(result.outcome, 'clarify');
    assert.equal(result.clarification.field, field);
  }
  const target = { featureId: 'menu', itemId: { handle: 'selected' } };
  for (const kind of ['menu', 'member']) {
    const result = await harness.run(navigationRequest(command, target, {
      slots: ['name'], searches: [{ kind, querySlot: 'name', matches: [{ handle: 'selected', match: 'exact' }] }],
    }));
    assert.equal(result.outcome, kind === 'menu' ? 'navigate' : 'clarify');
  }
});

test('shell guards use captured board and display facts, and closing is read-only', async t => {
  const harness = createRequestHarness();
  t.after(harness.close);
  const readings = [
    reading('get_board', { layer: 'management' }, { 'board.pageCount': 2, 'board.panel.ledger.page': 2 }),
    reading('get_ui_state', { section: 'display' }, { 'ui.overlay': 'detail', 'ui.editing': true }),
    reading('get_closing_state', { tab: 'history' }, { 'closing.status': 'closed' }),
  ];
  let turn = 0;
  const get = (cmd, args, extra = {}) => harness.run(navigationRequest(cmd, args, { runId: `shell-${turn++}`, readings, ...extra }));
  assert.equal((await get('ui.go_to_page', { page: 2 })).outcome, 'navigate');
  assert.equal((await get('ui.go_to_page', { page: 3 })).clarification.field, 'page');
  assert.deepEqual((await get('ui.show_panel', { featureId: 'ledger' })).navigation.args, { featureId: 'ledger', layer: 'management', page: 2 });
  assert.equal((await get('ui.show_panel', { featureId: 'menu' })).refusal.reason, 'unavailable');
  assert.equal((await get('ui.go_back', {})).outcome, 'navigate');
  assert.equal((await get('ui.exit_layout_edit', {})).outcome, 'navigate');
  assert.equal((await get('ui.open_settings', { view: 'preview' })).outcome, 'navigate');
  assert.equal((await get('ui.open_closing', { tab: 'history' })).outcome, 'navigate');
  assert.equal((await get('ui.open_closing', { closeDay: true })).outcome, 'clarify');
  assert.equal((await get('ui.switch_layer', { layer: 'marketing' }, {
    readings: [reading('get_ui_state', { section: 'display' }, { 'ui.busy': true })],
  })).refusal.reason, 'unavailable');
  assert.equal((await get('ui.open_closing', { tab: 'history' }, {
    readings: [{ tool: 'get_closing_state', args: { tab: 'history' }, status: 'unavailable' }],
  })).outcome, 'navigate');
});

test('policy handoffs preserve scoped draft inputs and never authorize execution', async t => {
  const harness = createRequestHarness();
  t.after(harness.close);
  const cases = [
    ['notice.send', { title: { slot: 'title' }, body: { slot: 'body' } }, 'notice-send'],
    ['video.make', { lengthSec: 15, memo: { slot: 'memo' } }, 'promo-video'],
    ['pos.payment', { amount: { slot: 'amount' } }, 'pos'],
    ['closing.closeDay', { date: { slot: 'date' } }, 'pos-closing'],
  ];
  for (const [command, draft, featureId] of cases) {
    const input = navigationRequest(command, draft, { slots: ['title', 'body', 'memo', 'amount', 'date'] });
    const { outcome, refusal } = await harness.run(input);
    assert.equal(outcome, 'refused');
    assert.equal(refusal.reason, 'widget_only');
    assert.deepEqual(refusal.alternative, { command, draft, featureId, runId: input.runId, snapshotRevision: 7 });
  }
  assert.equal((await harness.run(navigationRequest('ui.openSettlement', {
    purpose: 'charge_topup', amount: { slot: 'amount' },
  }, { slots: ['amount'] }))).clarification.field, 'memberId');
  assert.equal((await harness.run(navigationRequest('ui.setDraftField', {
    featureId: 'customer-groups', view: 'reach-out', field: 'sendNow', value: { slot: 'value' },
  }, { slots: ['value'] }))).clarification.field, 'value');
  assert.equal(schema.validateAgentPrefill('promo-video', { lengthSec: 17 }), false);
  assert.equal(schema.validateAgentPrefill('promo-video', { tab: 2, lengthSec: 15 }), true);
});

test('navigation frames reject unsupported operations and invalid wire inputs', () => {
  const navigation = { command: 'ui.openDetail', args: { featureId: 'menu' }, runId: 'r1', snapshotRevision: 7, layer: 'management' };
  assert.equal(schema.validateAgentFrame('done', { outcome: 'navigate', navigation }), true);
  for (const data of [
    { ...navigation, command: 'closing.closeDay' },
    { ...navigation, args: { featureId: 'menu', itemId: 'raw-menu-id' } },
    { ...navigation, args: { featureId: 'menu', prefill: { name: 'raw-input' } } },
    { ...navigation, runId: undefined },
  ]) assert.equal(schema.validateAgentFrame('done', { outcome: 'navigate', navigation: data }), false);
});
