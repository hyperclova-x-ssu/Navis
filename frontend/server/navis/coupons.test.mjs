import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { agentCommandPolicy, validateAgentFrame, validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, navigationRequest, reading } from '../fixtures/navis-eval-fake.mjs';
import { createAgentDomainRegistry } from './registry.mjs';

const registry = createAgentDomainRegistry();
const handle = { handle: 'h-target' };
const send = { slotId: handle, benefitId: 'free-shot', sendAt: { slot: 'sendAt' }, body: { slot: 'body' } };

function prepare(command, args, kind, querySlot, matches, status = 'ready') {
  const adapter = registry.get(command);
  assert.ok(adapter, `${command} must be registered`);
  const input = {
    intent: { kind: 'command', command, args, querySlot },
    slots: [querySlot, 'body', 'sendAt'],
    searches: [{ kind, querySlot, matches }],
  };
  assert.deepEqual(adapter.lookups(input), [{ name: 'search_records', args: { kind, querySlot } }]);
  return adapter.prepare({ input, reads: [{ status, matches }] });
}

const exact = (fields, ref = handle.handle) => ({ handle: ref, match: 'exact', fields });
const status = (value, fields = {}) => ({ status: value, date: '2026-11-19', ...fields });

test('coupon writes are scoped to the widget command and exact supplied slots', () => {
  assert.equal(agentCommandPolicy('coupon.createExpiry').policy, 'widget-only');
  assert.equal(agentCommandPolicy('coupon.markPosted', { codeId: handle }).confirmation, 'extra-confirm');
  for (const command of ['coupon.sendSlot', 'coupon.notifyEnding', 'coupon.markPosted']) {
    assert.equal(agentCommandPolicy(command).policy, 'widget-only');
  }
  assert.ok(validateAgentToolArgs('propose_action', { command: 'coupon.sendSlot', args: send }));
  assert.ok(!validateAgentToolArgs('propose_action', { command: 'coupon.sendSlot', args: { ...send, sendAt: '2026-11-18T21:30' } }));
  assert.ok(!validateAgentToolArgs('propose_action', { command: 'coupon.sendSlot', args: { ...send, recipientIds: ['customer-1'] } }));
  assert.ok(!validateAgentToolArgs('propose_action', { command: 'coupon.notifyEnding', args: { couponId: handle, body: { slot: 'body' } } }));
  assert.ok(!validateAgentToolArgs('propose_action', { command: 'coupon.extend', args: { couponId: handle, days: { slot: 'days' } } }));
});

test('D-326 scopes coupon creation and changes to exact eligible targets', () => {
  const args = { itemId: handle, discountRate: { slot: 'rate' }, route: 'place_news' };
  const available = { expiryEligible: true, expiryHandled: false };
  const check = fields => prepare('coupon.createExpiry', args, 'stock', 'itemQuery', [exact(fields)]);
  assert.deepEqual(check(available), { outcome: 'ready', args });
  assert.deepEqual(check({ ...available, expiryHandled: true }), { outcome: 'refused', reason: 'duplicate' });
  assert.deepEqual(check({ ...available, expiryEligible: false }), { outcome: 'refused', reason: 'invalid_target' });
  assert.ok(!validateAgentToolArgs('propose_action', { command: 'coupon.createExpiry', args: { ...args, route: 'sms' } }));
  assert.equal(agentCommandPolicy('coupon.createExpiry', { ...args, withSet: true }).policy, 'widget-only');
  const change = { couponId: handle, quantity: { slot: 'quantity' } };
  assert.equal(prepare('coupon.update', change, 'coupon', 'couponQuery', [exact(status('active'))]).outcome, 'ready');
  assert.equal(prepare('coupon.update', change, 'coupon', 'couponQuery', [exact(status('ended'))]).outcome, 'refused');
  assert.ok(!validateAgentToolArgs('propose_action', { command: 'coupon.update', args: { couponId: handle } }));
  assert.equal(agentCommandPolicy('coupon.endEarly', { couponId: handle }).confirmation, 'extra-confirm');
  assert.equal(agentCommandPolicy('coupon.unpublish', { codeId: handle }).confirmation, 'extra-confirm');
  const unpublish = fields => prepare('coupon.unpublish', { codeId: handle }, 'couponCode', 'codeQuery', [exact(fields)]);
  assert.equal(unpublish({ route: 'place_news', activated: true, unpublished: false }).outcome, 'ready');
  assert.equal(unpublish({ route: 'place_news', activated: false, unpublished: false }).outcome, 'refused');
  assert.equal(unpublish({ route: 'sms', activated: true, unpublished: false }).outcome, 'refused');
});

test('D-328 accepts scoped won benefits via local values and disallows SMS or mixed benefits', () => {
  const command = 'coupon.createExpiry';
  const base = { itemId: handle, route: 'place_news' };
  const fields = { expiryEligible: true, expiryHandled: false };
  for (const kind of ['amount', 'setPrice']) {
    const args = { ...base, benefit: { kind, value: { slot: 'body' } } };
    assert.equal(agentCommandPolicy(command, args).policy, 'propose');
    assert.deepEqual(prepare(command, args, 'stock', 'itemQuery', [exact(fields)]), { outcome: 'ready', args });
  }
  const benefit = { kind: 'amount', value: { slot: 'body' } };
  for (const args of [{ ...base, benefit, route: 'sms' }, { ...base, benefit, discountRate: { slot: 'rate' } },
    { ...base, benefit: { kind: 'amount', value: 500 } }, { ...base, benefit: { kind: 'amount' } }]) {
    assert.equal(validateAgentToolArgs('propose_action', { command, args }), false);
  }
});

test('a slot proposal requires an unhandled slot with a positive eligible count', () => {
  const check = fields => prepare('coupon.sendSlot', send, 'slot', 'slotQuery', [exact(fields)]);
  assert.deepEqual(check({ handled: false, recipientCount: 2 }), { outcome: 'ready', args: send });
  assert.deepEqual(check({ handled: true, recipientCount: 2 }), { outcome: 'refused', reason: 'duplicate' });
  assert.deepEqual(check({ handled: false, recipientCount: 0 }), { outcome: 'refused', reason: 'invalid_target' });
  assert.deepEqual(check({ handled: false }), { outcome: 'refused', reason: 'unavailable' });
});

test('the supplied handle must match the unambiguous result of its exact lookup', () => {
  const fields = { handled: false, recipientCount: 2 };
  const check = matches => prepare('coupon.sendSlot', send, 'slot', 'slotQuery', matches);
  assert.deepEqual(check([exact(fields, 'other')]), { outcome: 'refused', reason: 'invalid_target' });
  assert.deepEqual(check([exact(fields), exact(fields, 'other')]), { outcome: 'ambiguous', lookupIndex: 0, field: 'slotId' });
  assert.deepEqual(check([]), { outcome: 'refused', reason: 'invalid_target' });
});

test('coupon lifecycle and ending reminder proposals require the corresponding current status', () => {
  const args = { couponId: handle };
  for (const [command, fields, expected] of [
    ['coupon.pause', status('active'), 'ready'],
    ['coupon.pause', status('paused'), 'refused'],
    ['coupon.resume', status('paused'), 'ready'],
    ['coupon.resume', status('ended'), 'refused'],
    ['coupon.extend', status('active'), 'ready'],
    ['coupon.extend', status('paused'), 'ready'],
    ['coupon.extend', status('ended'), 'refused'],
    ['coupon.notifyEnding', status('active', { endingSoon: true, reminderRecipients: 1 }), 'ready'],
    ['coupon.notifyEnding', status('active', { endingSoon: false, reminderRecipients: 1 }), 'refused'],
    ['coupon.notifyEnding', status('active', { endingSoon: true, reminderRecipients: 0 }), 'refused'],
    ['coupon.notifyEnding', status('paused', { endingSoon: true, reminderRecipients: 1 }), 'refused'],
    ['coupon.notifyEnding', status('active', { endingSoon: true }), 'refused'],
  ]) assert.equal(prepare(command, args, 'coupon', 'couponQuery', [exact(fields)]).outcome, expected, JSON.stringify({ command, fields }));
});

test('a posted attestation can activate only an eligible pending Place News code', () => {
  const args = { codeId: handle };
  const check = fields => prepare('coupon.markPosted', args, 'couponCode', 'codeQuery', [exact(fields)]);
  assert.equal(check({ route: 'place_news', activated: false, eligible: true }).outcome, 'ready');
  assert.deepEqual(check({ route: 'place_news', activated: true, eligible: true }), { outcome: 'refused', reason: 'duplicate' });
  assert.deepEqual(check({ route: 'clip', activated: false, eligible: true }), { outcome: 'refused', reason: 'invalid_target' });
  assert.deepEqual(check({ route: 'place_news', activated: false, eligible: false }), { outcome: 'refused', reason: 'invalid_target' });
  assert.deepEqual(check({ route: 'place_news', activated: false }), { outcome: 'refused', reason: 'unavailable' });
});

test('the native fake observes the scoped stock handle before citing an expiry estimate', async t => {
  const harness = createNavisMenuHarness(options => createBridge({ ...options, agentMode: 'fake', onDiagnostics() {} }), validateAgentFrame);
  t.after(harness.close);
  const args = { itemId: handle, rate: { slot: 'rate' } };
  const input = navigationRequest(undefined, undefined, {
    layer: 'marketing', locale: 'ko', slots: ['itemQuery', 'rate'],
    intent: { kind: 'read', tool: 'calc_expiry_discount', recordKind: 'stock', querySlot: 'itemQuery' },
    searches: [{ kind: 'stock', querySlot: 'itemQuery', matches: [exact({ unit: 'pcs' })] }],
    readings: [reading('calc_expiry_discount', args, { 'expiry.discount.price': 2600, 'expiry.discount.each': 82 })],
  });
  const result = await harness.run(input);
  assert.equal(result.terminal?.outcome, 'reply', result.raw);
  assert.deepEqual(result.calls, [
    { name: 'search_records', args: { kind: 'stock', querySlot: 'itemQuery' } },
    { name: 'calc_expiry_discount', args },
  ]);
  assert.match(result.answer, /2600/u);
  assert.match(result.answer, /82/u);
  assert.doesNotMatch(result.raw, /event: action_(proposal|result)/u);
});

test('widget commands reject past slot sends and activation of a paused expiry coupon', async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, envDir: false,
    logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false },
  });
  let data;
  try {
    data = await vite.ssrLoadModule('/src/data/widget-data.ts');
  } finally {
    await vite.close();
  }
  const store = data.createWidgetDataStore();
  const model = feature => data.selectWidget(store.getSnapshot(), feature, { kind: 'default' }, 'normal').model;
  const slot = model('slot-coupon').openSlots.find(row => row.regularIds.length > 0);
  const sendSlot = {
    type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: slot.regularIds, benefit: 'percent-10',
    idempotencyKey: 'n16-schedule', sendAt: '2026-11-17T15:44',
  };
  const before = store.getSnapshot();
  assert.equal(store.dispatch(sendSlot).messageKey, 'data.marketing.error.sendAtPast');
  assert.equal(store.getSnapshot(), before);
  const scheduled = store.dispatch({ ...sendSlot, sendAt: '2026-11-17T22:00' });
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.noticeKey, 'data.notice.sent');
  assert.ok(store.getSnapshot().tables.marketing.messageSend.every(row => row.status === 'mock' && row.scheduledAt === '2026-11-17T22:00'));

  const item = model('expiry-coupon').target;
  const created = store.dispatch({ type: 'coupon.createExpiry', itemId: item.itemId, benefit: { kind: 'percent', value: 40 },
    route: 'place_news', idempotencyKey: 'n16-expiry' });
  assert.equal(created.ok, true);
  assert.equal(store.dispatch({ type: 'coupon.pause', couponId: created.value.couponId }).ok, true);
  const paused = store.getSnapshot();
  const mark = { type: 'coupon.markPosted', codeId: created.value.codeId, idempotencyKey: 'n16-activate' };
  assert.equal(store.dispatch(mark).messageKey, 'data.marketing.error.couponNotActive');
  assert.equal(store.getSnapshot(), paused);
  assert.equal(store.dispatch({ type: 'coupon.resume', couponId: created.value.couponId }).ok, true);
  const posted = store.dispatch(mark);
  assert.equal(posted.noticeKey, 'data.marketing.notice.counting');
  assert.deepEqual(store.dispatch(mark), { ...posted, duplicate: true });
});
