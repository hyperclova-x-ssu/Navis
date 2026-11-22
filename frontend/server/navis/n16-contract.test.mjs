import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { createServer } from 'vite';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, navisAgentFakeFetch } from '../fixtures/navis-eval-fake.mjs';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest } from '../../shared/navis-agent-schema.mjs';
import { evidence, readTrace } from './scenario-fixtures.mjs';
import { couponAdapters } from './coupons.mjs';

const trace = readTrace();
const assigned = trace.filter(row => row.slice_id === 'N16');
const dependencies = trace.filter(row => row.required_slices.split('|').includes('N16'));
const authored = new Map(JSON.parse(evidence('MERGED.json')).map(row => [row.id, row]));
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json'));

const vite = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, envDir: false,
  logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false },
});
const load = path => vite.ssrLoadModule(`/src/${path}.ts`);
let data, dates, calc, session, catalog, state, presets, motion, provider, nav, text, translator, loyalty, discounts, actions, legacySeed;
try {
  [data, dates, calc, session, catalog, state, presets, motion, provider, nav, text, translator, loyalty, discounts, actions, legacySeed] = await Promise.all([
    load('data/widget-data'), load('data/db/time'), load('data/marketing/calc'), load('app/test-session'),
    load('catalog/index'), load('state/index'), load('layout/presets'), load('ui/motion'), load('features/assistant/provider'),
    load('screens/dashboard/navis-navigation'), load('data/text'), load('features/assistant/messages'),
    load('data/pos/loyalty'), load('pos/loyalty/discounts'), load('features/assistant/agent-actions'), load('data/db/legacy-seed'),
  ]);
} finally {
  await vite.close();
}

const campaignName = '오후 한산시간 디저트 1,000원 할인 쿠폰';
const pauseText = `${campaignName} 잠깐 멈춰줘`;
const extendText = `${campaignName} 일주일 연장해줘`;
const slotFeature = 'slot-coupon';
const expiryFeature = 'expiry-coupon';
const statusFeature = 'coupon-status';
const couponFeatures = [slotFeature, expiryFeature, statusFeature];
const accept = result => {
  assert.equal(result?.ok, true, JSON.stringify(result));
  return result;
};

function context(t, id) {
  const run = state.createRunStore({ screenPreset: presets.screenPresets.A, catalog: catalog.getRegistry('A'), time: motion.timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  session.beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  if (!['S7-008', 'S7-094'].includes(id)) run.actions.switchLayer('marketing');
  assert.equal(data.NOW, '2026-11-17T15:45');
  const initial = data.createWidgetDataStore().getSnapshot();
  const base = initial.tables.marketing;
  const campaign = base.coupon.find(row => row.status === 'active');
  assert.ok(campaign, 'café running campaign');
  const campaignId = campaign.couponId;
  const stagedEnding = ['S6-096', 'S6-108', 'S6-125', 'S6-131', 'S6-135', 'public-only'].includes(id);
  const stageTargets = ['S6-125', 'S6-135'].includes(id);
  const code = base.couponCode.find(row => row.couponId === campaignId);
  const testTargets = stageTargets ? base.mktCustomer.filter(row => row.consentSms && !row.deletedAt).slice(0, 2)
    .map(({ customerId }, index) => ({ couponId: campaignId, codeId: code.codeId, customerId, reason: 'regular', sendId: `n16-fixture-${index}` })) : [];
  const marketing = {
    ...base,
    coupon: base.coupon.map(row => stagedEnding && row === campaign ? { ...row, endsOn: dates.addDays(data.TODAY, 2) } : row),
    couponTarget: [...base.couponTarget, ...testTargets],
    ...(id === 'zero-slot' && { mktCustomer: base.mktCustomer.map(customer => ({ ...customer, consentSms: false })) }),
  };
  const legacy = id === 'authored-expiry' ? legacySeed.createLegacySeedTables() : undefined;
  const croissant = legacy?.inventoryItem.find(row => row.itemId === 'it-croissant');
  const croissantMenu = legacy?.menuItem.find(row => row.menuId === 'm-croissant');
  const expiryStock = legacy && croissant && croissantMenu ? {
    inventoryItem: [...initial.tables.inventoryItem, { ...croissant, expiresOn: data.TODAY }],
    inventoryStock: [...initial.tables.inventoryStock, { itemId: croissant.itemId, channel: 'store', qty: 6 }],
    stockOpening: [...initial.tables.stockOpening, { itemId: croissant.itemId, businessDate: data.TODAY, quantityBase: 6 }],
    menuItem: [...initial.tables.menuItem, croissantMenu],
    recipeLine: [...initial.tables.recipeLine, ...legacy.recipeLine.filter(row => row.menuId === croissantMenu.menuId)],
    purchaseItem: [...initial.tables.purchaseItem, ...legacy.purchaseItem.filter(row => row.itemId === croissant.itemId)],
  } : {};
  const store = data.createWidgetDataStore({ ...expiryStock, marketing: legacy ? {
    ...marketing, expiryForecast: [...marketing.expiryForecast, ...legacy.marketing.expiryForecast],
  } : marketing }, { runId: run.getState().runId });
  const model = (feature, snapshot = store.getSnapshot()) => data.readModel(snapshot, feature);
  const slot = model(slotFeature).openSlots.find(row => row.regularIds.length > 0);
  const item = model(expiryFeature).target;
  assert.ok(item);
  let expiryCodeId;
  if (['S5-114', 'S5-126', 'S5-137'].includes(id)) {
    assert.ok(slot);
    accept(store.dispatch({ type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: slot.regularIds,
      benefit: 'free-shot', idempotencyKey: 'n16-staged-slot' }));
  }
  if (['S5-152', 'S5-156'].includes(id)) {
    const result = accept(store.dispatch({ type: 'coupon.createExpiry', itemId: item.itemId, benefit: { kind: 'percent', value: 40 },
      route: 'place_news', idempotencyKey: 'n16-staged-expiry' }));
    expiryCodeId = result.value.codeId;
  }
  if (id === 'S5-153') {
    for (const row of model(expiryFeature).items) accept(store.dispatch({ type: 'inventory.updateItem', itemId: row.itemId, stock: 0 }));
  }
  if (['S6-113', 'S6-115'].includes(id)) accept(store.dispatch({ type: 'coupon.pause', couponId: campaignId }));
  if (id === 'S6-111') {
    const group = model('customer-groups');
    accept(store.dispatch({ type: 'coupon.sendReachOut', recipientIds: group.reachOut.recipientIds, idempotencyKey: 'n16-first-group' }));
    accept(store.dispatch({ type: 'coupon.sendReachOut', recipientIds: group.reachOut.recipientIds, idempotencyKey: 'n16-staged-group' }));
  }

  const harness = createNavisMenuHarness(options => createBridge({ ...options, agentMode: 'fake', onDiagnostics() {} }), validateAgentFrame, navisAgentFakeFetch);
  t.after(harness.close);
  const calls = [], requests = [];
  const assistant = provider.createAssistantProvider({ store, run, async fetcher(_url, init) {
    const request = JSON.parse(init.body);
    assert.equal(validateAgentRequest(request), true, JSON.stringify(request.intent));
    requests.push(request);
    const result = await harness.run(request);
    calls.push(...result.calls);
    return new globalThis.Response(result.raw, { status: result.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL, 'content-type': 'text/event-stream' } });
  } });
  const navigation = nav.createNavisNavigation(run, { highlight() {}, closeChat() {} });
  const ask = async (text, preferred = statusFeature) => {
    const snapshot = store.getSnapshot();
    const before = run.getState();
    const callIndex = calls.length;
    const requestIndex = requests.length;
    const plan = nav.classifyNavigation(text, before, snapshot, preferred);
    const prepared = plan && nav.prepareNavigationRequest(plan, before, navigation);
    let detail;
    const reply = await assistant.ask({ text, locale: 'ko', layer: before.layer, signal: new globalThis.AbortController().signal,
      ...(prepared ? { agentTurn: prepared.agentTurn, onNavigation: intent => { detail = prepared.resolve(intent); } }
        : { featureId: preferred }),
    });
    assert.equal(store.getSnapshot(), snapshot, 'typed input must leave data untouched');
    if (detail && plan) assert.ok(['opened', 'already'].includes(await navigation.execute(plan.command, detail)));
    const turn = reply.turn;
    const kind = detail ? 'navigate' : turn?.kind === 'proposal' || reply.proposalSession?.isPending() ? 'proposal'
      : ['clarification', 'ambiguity'].includes(turn?.kind) ? 'clarify'
        : ['refusal', 'handoff'].includes(turn?.kind) ? 'refuse' : 'answer';
    return { reply, detail, kind, snapshot, calls: calls.slice(callIndex), requests: requests.slice(requestIndex) };
  };
  return { ask, model, run, store, campaignId, expiryCodeId, item, testTargets };
}

const receiptKeys = {
  'coupon.createExpiry': 'data.marketing.notice.couponCreated',
  'coupon.update': 'data.management.notice.saved',
  'coupon.endEarly': 'data.marketing.notice.couponEnded',
  'coupon.unpublish': 'data.marketing.notice.couponUnpublished',
  'coupon.sendSlot': 'data.notice.sent',
  'coupon.notifyEnding': 'data.notice.sent',
  'coupon.markPosted': 'data.marketing.notice.counting',
  'coupon.pause': 'data.marketing.notice.paused',
  'coupon.resume': 'data.marketing.notice.resumed',
  'coupon.extend': 'data.marketing.notice.extended',
};

function confirm(env, result, command, messageKey = receiptKeys[command]) {
  const { store } = env;
  assert.equal(result.kind, 'proposal', result.reply.answer);
  const session = result.reply.proposalSession;
  assert.ok(session);
  const { proposal } = session.getSnapshot();
  const proposalId = proposal.id;
  assert.equal(proposal.command, command);
  assert.ok(result.calls.some(call => call.name === 'propose_action' && call.args.command === command));
  assert.equal(session.confirm(store, 'different-proposal'), undefined);
  const extra = ['coupon.markPosted', 'coupon.endEarly', 'coupon.unpublish'].includes(command);
  assert.equal(proposal.tier, extra ? 'extra-confirm' : 'normal');
  assert.equal(store.getSnapshot(), result.snapshot);
  if (extra) {
    const challenge = session.confirm(store, proposalId);
    assert.equal(challenge.requiresExtraConfirmation, true);
    assert.equal(store.getSnapshot(), result.snapshot);
  }
  const receipt = session.confirm(store, proposalId, extra);
  assert.equal(receipt.frame.outcome, 'applied', JSON.stringify(receipt.frame));
  assert.equal(receipt.frame.messageKey, messageKey);
  assert.equal(receipt.notice?.messageKey, receipt.frame.messageKey);
  const after = store.getSnapshot();
  assert.equal(after.revision, result.snapshot.revision + 1);
  assert.notEqual(after, result.snapshot);
  assert.equal(session.confirm(store, proposalId, extra), undefined);
  assert.deepEqual(proposal.confirm(store, proposalId).frame, receipt.frame);
  assert.equal(store.getSnapshot(), after, 'repeated press has no second effect');
  return { receipt, after };
}

function assertNotification(env, before, after) {
  const m = after.tables.marketing;
  const sends = m.messageSend.slice(before.tables.marketing.messageSend.length);
  assert.deepEqual(sends.map(row => row.customerId).sort(), env.testTargets.map(row => row.customerId).sort());
  assert.ok(sends.every(row => row.couponId === env.campaignId && row.kind === 'reminder' && row.status === 'mock'
    && row.body.key === 'data.marketing.sms.reminder' && row.scheduledAt === data.NOW));
  assert.equal(m.couponReminder.at(-1).recipients, sends.length);
  assert.deepEqual(m.coupon, before.tables.marketing.coupon);
  assert.deepEqual(m.couponCode, before.tables.marketing.couponCode);
}

// EXPECT-4. These are behavior gaps after correcting the café and policy values.
const exceptions = {
  'S5-111': 'N16 R5: the reply compares other offers and omits the requested free-shot comparison.',
  'S5-116': 'N16 R5 with N21: the future coupon window needs the requested weekday’s forecast, rather than elapsed hours today.',
  'S5-118': 'N16 R5: unavailable Wednesday 16:00 slot needs an explicit unavailable-slot answer or choice.',
  'S5-120': 'N16 R5: an unknown masked recipient opens the composer without applying or explaining the requested exclusion.',
  'S5-163': 'N16 R5: the café product wording opens Menu instead of preparing Expiry Coupon.',
  'S6-101': 'N16 R5: report the missing named coupon before summarizing unrelated campaigns.',
  'S6-104': 'N16 R5: the named benefit request returns aggregate cost instead of reporting the missing coupon.',
  'S6-105': 'N16 R5: the absent named coupon needs a missing-target answer instead of unrelated status counts.',
  'S6-119': 'N16 R5: a custom extension length needs the widget handoff under D-326 Q19.',
  'S6-120': 'N16 R5: a custom expiry date needs the widget handoff under D-326 Q19.',
  'S6-122': 'N02 with N16 R5: the repeat loses its confirmed coupon target. An explicit repeat prepares a fresh card.',
};

const reviewed = new Set([
  'S5-108', 'S5-109', 'S5-112', 'S5-114', 'S5-126', 'S5-137',
  'S5-143', 'S5-144', 'S5-145', 'S5-146', 'S5-148', 'S5-149', 'S5-150', 'S5-151',
  'S5-152', 'S5-153', 'S5-155', 'S6-096', 'S6-102', 'S6-107', 'S6-108', 'S6-109',
  'S6-110', 'S6-113', 'S6-114', 'S6-115', 'S6-117', 'S6-118', 'S6-121',
  'S6-123', 'S6-124', 'S6-128', 'S6-129', 'S6-133', 'S6-134', 'S6-195',
]);

const safeCopy = result => assert.doesNotMatch(result.reply.answer, /010[ -]?\d|customerId|recipientIds|idempotencyKey/u);
const traceTurn = result => JSON.stringify({
  answer: result.reply.answer, reason: result.reply.turn?.reason, intents: result.requests.map(request => request.intent),
  tools: result.calls.map(call => call.name),
});

async function setupContinuation(env, id) {
  if (id === 'S6-122') {
    const first = await env.ask(extendText);
    confirm(env, first, 'coupon.extend');
  }
  if (!['S6-123', 'S6-124'].includes(id)) return undefined;
  const pause = await env.ask(pauseText);
  const { receipt } = confirm(env, pause, 'coupon.pause');
  assert.ok(receipt.undoToken);
  env.run.actions.showNotice(receipt.notice);
  if (id === 'S6-124') accept(env.store.dispatch({ type: 'coupon.extend', couponId: env.campaignId }));
  return receipt;
}

async function checkProposal(env, result, command, id) {
  assert.equal(result.kind, 'proposal', result.reply.answer);
  await env.ask('확인');
  assert.equal(env.store.getSnapshot(), result.snapshot, 'typed confirmation must leave the proposal unexecuted');
  const { receipt, after } = confirm(env, result, command);
  const before = result.snapshot.tables.marketing;
  const m = after.tables.marketing;
  if (command === 'coupon.markPosted') {
    assert.equal(before.couponCode.find(row => row.codeId === env.expiryCodeId).activatedAt, null);
    assert.equal(m.couponCode.find(row => row.codeId === env.expiryCodeId).activatedAt, data.NOW);
    assert.deepEqual(m.messageSend, before.messageSend);
    assert.deepEqual(m.coupon, before.coupon);
    assert.equal(receipt.undoToken, undefined);
  } else if (command === 'coupon.notifyEnding') {
    assertNotification(env, result.snapshot, after);
    assert.equal(receipt.undoToken, undefined);
  } else {
    assert.deepEqual(m.messageSend, before.messageSend);
    assert.deepEqual(m.couponCode, before.couponCode);
    const changed = m.coupon.find(row => row.couponId === env.campaignId);
    const original = before.coupon.find(row => row.couponId === env.campaignId);
    if (command === 'coupon.pause') assert.equal(changed.status, 'paused');
    if (command === 'coupon.resume') assert.equal(changed.status, 'active');
    if (command === 'coupon.extend') assert.equal(changed.endsOn, dates.addDays(original.endsOn, 7));
    assert.ok(receipt.undoToken, id);
    await env.ask('되돌려 줘');
    assert.equal(env.store.getSnapshot(), after);
    accept(env.store.undo(receipt.undoToken));
    assert.deepEqual(env.store.getSnapshot().tables.marketing, before);
  }
}

function assertCalc(result, item, rate) {
  assert.equal(result.kind, 'answer');
  assert.deepEqual(result.calls.map(call => call.name), ['search_records', 'calc_expiry_discount']);
  assert.equal(result.calls[0].args.kind, 'stock');
  const estimate = calc.expiryDiscount(item.price, item.unitCost, rate, item.qty);
  const format = value => new Intl.NumberFormat('ko').format(Math.abs(value));
  assert.match(result.reply.answer, /예상|계산|할인/u);
  assert.ok(result.reply.answer.includes(format(estimate.discountedPrice)), result.reply.answer);
  assert.ok(result.reply.answer.includes(format(estimate.marginEach)), result.reply.answer);
}

test('N16 replays every assigned coupon scenario against the café store and native fake transport', async t => {
  assert.equal(assigned.length, 73);
  assert.equal(dependencies.length, 85);
  assert.deepEqual(dependencies.filter(row => row.slice_id !== 'N16').map(row => row.scenario_id),
    ['S4-178', 'S5-101', 'S5-136', 'S5-166', 'S6-106', 'S6-135', 'S6-136', 'S6-137', 'S6-138', 'S6-150', 'S6-177', 'S8-073']);
  let passed = 0;
  const listed = [];
  for (const row of assigned) {
    const id = row.scenario_id;
    const fixture = authored.get(id);
    const expected = { ...fixture.expected, ...overlay[id]?.expected, ...overlay[id]?.policyGap?.expected };
    const gap = exceptions[id];
    if (gap) listed.push(id);
    await t.test(id, async sub => {
      const env = context(sub, id);
      const priorReceipt = await setupContinuation(env, id);
      const feature = couponFeatures.includes(fixture.widget) ? fixture.widget : id === 'S5-094' ? slotFeature : statusFeature;
      const result = await env.ask(fixture.utterances[0], feature);
      safeCopy(result);
      if (id === 'S6-128' || id === 'S6-129') {
        // D-326 allows editing an identified coupon. The named October coupon
        // is absent here, and a relative amount does not authorize extra issuance.
        assert.equal(result.kind, 'clarify', traceTurn(result));
        assert.equal(result.reply.turn.field, 'couponId');
        assert.ok(!result.calls.some(call => call.name === 'propose_action'));
        assert.equal(expected.kind, 'clarify');
        assert.deepEqual(expected.ask, ['couponId']);
        assert.ok(result.reply.answer.includes(expected.answer_must_contain[0]));
        passed++;
        return;
      }
      if (reviewed.has(id) || gap) {
        assert.ok(result.reply.answer || result.detail || result.reply.turn?.kind === 'proposal');
        const fixtureText = overlay[id]?.n16CafeText;
        const adapted = fixtureText ? await env.ask(fixtureText, feature) : result;
        safeCopy(adapted);
        if (id === 'S5-144' || id === 'S5-145') assertCalc(adapted, env.item, id === 'S5-144' ? 50 : 70);
        if (id === 'S5-148') {
          assert.notEqual(result.kind, 'proposal', 'the croissant is absent in the current selector');
          await env.ask('확인');
          assert.equal(env.store.getSnapshot(), adapted.snapshot);
          const { receipt, after } = confirm(env, adapted, 'coupon.createExpiry');
          assert.equal(after.tables.marketing.coupon.at(-1).targetMenuId, env.item.menuId);
          assert.equal(after.tables.marketing.coupon.at(-1).benefitValue, 40);
          assert.equal(after.tables.marketing.couponCode.at(-1).activatedAt, null);
          assert.deepEqual(after.tables.marketing.messageSend, adapted.snapshot.tables.marketing.messageSend);
          env.run.actions.showNotice(receipt.notice);
          await env.ask('되돌려줘');
          assert.equal(env.store.getSnapshot(), after);
          assert.ok(receipt.undoToken);
          assert.ok(actions.applyAgentRunUndo(env.run, env.store, receipt.undoToken));
          assert.deepEqual(env.store.getSnapshot().tables.marketing, adapted.snapshot.tables.marketing);
        }
        if (id === 'S5-155') {
          assert.equal(adapted.kind, 'refuse');
          assert.match(adapted.reply.answer, /당일 소진 쿠폰에서/u);
          assert.ok(!adapted.calls.some(call => call.args.command === 'coupon.createExpiry'));
        }
        if (id === 'S5-152') {
          assert.equal(adapted.kind, 'answer');
          assert.match(adapted.reply.answer, /쿠폰을 이미 만들었어요/u);
          const duplicate = env.store.dispatch({ type: 'coupon.createExpiry', itemId: env.item.itemId,
            benefit: { kind: 'percent', value: 40 }, route: 'place_news', idempotencyKey: 'n16-duplicate' });
          assert.equal(duplicate.messageKey, 'data.marketing.error.expiryAlreadyMade');
          assert.equal(env.store.getSnapshot(), result.snapshot);
        }
        if (id === 'S5-153') {
          assert.equal(data.selectWidget(adapted.snapshot, expiryFeature, { kind: 'default' }, 'normal').status, 'empty');
          assert.notEqual(adapted.kind, 'proposal');
          assert.match(adapted.reply.answer, /기한이 다가오는 재고가 없어요/u);
        }
        if (id === 'S6-123') {
          assert.ok(priorReceipt.undoToken);
          assert.notEqual(result.kind, 'proposal');
          assert.deepEqual(priorReceipt.notice.undo, { target: 'data', token: priorReceipt.undoToken });
          assert.deepEqual(state.selectCommonNotice(env.run.getState())?.undo, priorReceipt.notice.undo);
          accept(env.store.undo(priorReceipt.undoToken));
          assert.equal(env.model(statusFeature).rows.find(row => row.couponId === env.campaignId).status, 'active');
        }
        if (id === 'S6-124') {
          assert.notEqual(result.kind, 'proposal');
          assert.equal(env.store.undo(priorReceipt.undoToken).ok, false);
          assert.equal(env.store.getSnapshot(), result.snapshot);
        }
        if (['S6-110', 'S6-115', 'S6-118', 'S6-122'].includes(id)) {
          if (id === 'S6-122') assert.equal(result.kind, 'clarify');
          await checkProposal(env, adapted, expected.tools.find(tool => tool.name === 'propose_action').args.command, id);
        }
        if (['S6-119', 'S6-120'].includes(id)) {
          assert.equal(result.kind, expected.kind, traceTurn(result));
          assert.equal(result.reply.turn.field, expected.ask[0]);
          assert.notEqual(adapted.kind, 'proposal');
        }
        if (id === 'S6-133') assert.equal(adapted.detail?.itemId, env.campaignId);
        if (id === 'S6-134') {
          assert.equal(result.kind, 'answer');
          assert.equal(adapted.detail?.featureId, statusFeature);
        }
        if (gap) {
          sub.diagnostic(gap);
        } else {
          assert.ok(overlay[id]?.reason, `Missing reviewed source for ${id}`);
          if (!['S6-123', 'S6-124'].includes(id)) assert.equal(adapted.kind, expected.kind, traceTurn(adapted));
          const field = id === 'S5-149' ? 'benefit' : expected.ask?.[0];
          if (field) assert.equal(adapted.reply.turn.field, field);
          // D-365: S6-109 (last month's coupon use) came from the removed 마케팅 성과 numbers; the chat now says so plainly.
          const fragments = id === 'S5-149' ? ['할인율', '할인 금액', '지정 가격'] : id === 'S6-109'
            ? ['이제 따로 보여 드리지 않아요', '진행 중인 쿠폰'] : expected.answer_must_contain ?? [];
          for (const part of fragments) {
            assert.ok(adapted.reply.answer.includes(part), `${part} missing from ${adapted.reply.answer}`);
          }
          passed++;
        }
        return;
      }
      assert.equal(result.kind, expected.kind, traceTurn(result));
      if (expected.kind === 'proposal') {
        const command = expected.confirmation?.command ?? expected.tools.find(tool => tool.name === 'propose_action').args.command;
        await checkProposal(env, result, command, id);
      }
      if (expected.kind === 'navigate') {
        const action = expected.tools.find(tool => tool.name.includes('open') || tool.name === 'get_widget');
        assert.equal(result.detail.featureId, action.args.featureId);
        if (action.args.view) assert.equal(result.detail.view, action.args.view);
        if (action.args.focus) assert.equal(result.detail.focus, action.args.focus);
        for (const [field, value] of Object.entries(action.args.prefill ?? {})) assert.deepEqual(result.detail.prefill?.[field], value, field);
      }
      if (expected.kind === 'answer' || expected.kind === 'refuse') {
        const semantic = {
          'S5-113': /보낸 쿠폰.*(?:0건|없어요)/u,
          'S5-115': /예약[\s\S]*동의/u,
          'S6-103': /중지.*(?:0장|0건|없어요)/u,
        }[id];
        if (semantic) assert.match(result.reply.answer, semantic);
        else for (const part of expected.answer_must_contain ?? []) assert.ok(result.reply.answer.includes(part), result.reply.answer);
      }
      if (!gap) passed++;
    });
  }
  t.diagnostic(`${passed} of 73 pass, ${listed.length} listed exceptions with reasons; 85 required_slices references (73 assigned, 12 dependencies)`);
  assert.equal(passed + listed.length, 73);
  assert.deepEqual(listed, assigned.map(row => row.scenario_id).filter(id => Object.hasOwn(exceptions, id)));
});

test('D-328 won benefits create draft codes with the widget limits and receipt undo', async t => {
  const env = context(t, 'S5-148');
  for (const [phrase, benefitType, benefitValue] of [['1,000원 할인', 'amount', 1000], ['세트 가격 5,000원', 'set_price', 5000]]) {
    const result = await env.ask(`바스크 치즈케이크 ${phrase} 당일 소진 쿠폰 만들어줘`, 'expiry-coupon');
    await env.ask('확인');
    const { receipt, after } = confirm(env, result, 'coupon.createExpiry');
    const coupon = after.tables.marketing.coupon.at(-1);
    const code = after.tables.marketing.couponCode.at(-1);
    assert.equal(coupon.benefitType, benefitType);
    assert.equal(coupon.benefitValue, benefitValue);
    assert.equal(coupon.targetMenuId, env.item.menuId);
    assert.equal(code.route, 'place_news');
    assert.equal(code.issueCount, 10);
    assert.equal(code.activatedAt, null);
    assert.deepEqual(after.tables.marketing.messageSend, result.snapshot.tables.marketing.messageSend);
    env.run.actions.showNotice(receipt.notice);
    assert.ok(actions.applyAgentRunUndo(env.run, env.store, receipt.undoToken));
    assert.deepEqual(env.store.getSnapshot().tables.marketing, result.snapshot.tables.marketing);
  }
});

test('S5-148 creates an inactive code and sends no messages for the exact authored croissant draft', async t => {
  const env = context(t, 'authored-expiry');
  const stock = env.model(expiryFeature).items.find(item => item.itemId === 'it-croissant');
  assert.ok(stock);
  assert.equal(stock.qty, 6);
  for (const utterance of authored.get('S5-148').utterances) {
    const result = await env.ask(utterance, expiryFeature);
    await env.ask('응');
    assert.equal(env.store.getSnapshot(), result.snapshot);
    const { receipt, after } = confirm(env, result, 'coupon.createExpiry');
    assert.deepEqual(after.tables.marketing.coupon.at(-1).originRef, { itemId: stock.itemId });
    assert.equal(after.tables.marketing.coupon.at(-1).benefitValue, 40);
    assert.equal(after.tables.marketing.couponCode.at(-1).activatedAt, null);
    assert.deepEqual(after.tables.marketing.messageSend, result.snapshot.tables.marketing.messageSend);
    env.run.actions.showNotice(receipt.notice);
    assert.ok(actions.applyAgentRunUndo(env.run, env.store, receipt.undoToken));
    assert.deepEqual(env.store.getSnapshot().tables.marketing, result.snapshot.tables.marketing);
  }
});

test('D-326 coupon edit, unpublish and end preserve the issued code through its original expiry', async t => {
  const env = context(t, 'S5-156');
  const { store, expiryCodeId, item } = env;
  accept(store.dispatch({ type: 'coupon.markPosted', codeId: expiryCodeId, idempotencyKey: 'd326-staged-publication' }));
  const created = store.getSnapshot().tables.marketing.couponCode.find(row => row.codeId === expiryCodeId);
  accept(store.dispatch({ type: 'coupon.extend', couponId: created.couponId }));
  const before = store.getSnapshot();
  const code = before.tables.marketing.couponCode.find(row => row.codeId === expiryCodeId);
  const coupon = before.tables.marketing.coupon.find(row => row.couponId === code.couponId);
  const name = text.resolveDataText(translator.navisTranslator('ko').t, coupon.name);
  function quote(snapshot, date = data.TODAY) {
    return discounts.quoteDiscount({ data: { loyalty: loyalty.selectPosLoyaltyRead(snapshot) } },
      { billId: 'd326-bill', memberId: null }, [{ lineId: 'd326-line', menuId: item.menuId, gross: item.price }],
      { source: 'coupon', couponId: coupon.couponId, codeId: expiryCodeId }, `${date}T15:45`);
  }
  const originalDiscount = Math.floor(item.price * 0.4);
  assert.equal(quote(before).discount?.amount, originalDiscount);
  const all = await env.ask('쿠폰 전부 일찍 끝내줘');
  assert.notEqual(all.kind, 'proposal');
  const customLength = await env.ask(`${name} 쿠폰 11월 30일까지 연장해줘`);
  assert.notEqual(customLength.kind, 'proposal');
  const benefitOnly = accept(store.dispatch({ type: 'coupon.update', couponId: coupon.couponId,
    benefitValue: 30, idempotencyKey: 'benefit-only' }));
  assert.equal(store.getSnapshot().tables.marketing.coupon.find(row => row.couponId === coupon.couponId).futureIssueCount,
    coupon.futureIssueCount);
  accept(store.undo(benefitOnly.undoToken));
  for (const [command, words] of [
    ['coupon.update', `혜택 30%와 발행 수량 18장으로 고쳐줘 ${name} 쿠폰`],
    ['coupon.unpublish', `${name} 쿠폰 게시 취소해줘`],
    ['coupon.endEarly', `${name} 쿠폰 일찍 끝내줘`],
  ]) {
    const proposed = await env.ask(words);
    assert.equal(proposed.kind, 'proposal', `${command} | ${traceTurn(proposed)}`);
    const notes = proposed.reply.proposalSession.getSnapshot().preview.fields.filter(field =>
      field.after === '이미 받은 쿠폰은 원래 종료일까지 주문/결제 화면에서 쓸 수 있어요');
    assert.equal(notes.length, command === 'coupon.update' ? 0 : 1);
    await env.ask('확인');
    assert.equal(store.getSnapshot().tables.marketing, before.tables.marketing);
    const { receipt, after } = confirm(env, proposed, command);
    const issued = after.tables.marketing.couponCode.find(row => row.codeId === expiryCodeId);
    assert.deepEqual([issued.issueCount, issued.activatedAt, issued.issuedTerms.benefitValue, issued.issuedTerms.endsOn],
      [code.issueCount, code.activatedAt, 40, coupon.endsOn]);
    if (command === 'coupon.update') {
      assert.equal(after.tables.marketing.coupon.find(row => row.couponId === coupon.couponId).benefitValue, 30);
      assert.equal(after.tables.marketing.couponCode.find(row => row.couponId === coupon.couponId && !row.activatedAt).issueCount, 18);
    }
    if (command === 'coupon.unpublish') assert.equal(issued.unpublishedAt, data.NOW);
    if (command === 'coupon.endEarly') {
      const ended = after.tables.marketing.coupon.find(row => row.couponId === coupon.couponId);
      assert.equal(ended.status, 'ended');
      assert.equal(ended.endsOn, data.TODAY);
    }
    assert.equal(quote(after).discount?.amount, originalDiscount);
    assert.equal(quote(after, coupon.endsOn).discount?.amount, originalDiscount);
    assert.equal(quote(after, dates.addDays(coupon.endsOn, 1)).ok, false);
    await env.ask('되돌려줘');
    assert.equal(store.getSnapshot(), after);
    assert.ok(receipt.undoToken);
    accept(store.undo(receipt.undoToken));
    assert.deepEqual(store.getSnapshot().tables.marketing, before.tables.marketing);
  }
});

for (const [id, stamp] of [['S5-130', '2026-11-17T15:45'], ['S5-131', '2026-11-18T09:00']]) {
  test(`${id} sends only the exact consented slot audience after a card press`, async t => {
    const env = context(t, id);
    const result = await env.ask(authored.get(id).utterances[0], slotFeature);
    assert.equal(result.kind, 'proposal', traceTurn(result));
    const foreignStore = data.createWidgetDataStore(result.snapshot.tables, { runId: result.snapshot.runId });
    const foreignSnapshot = foreignStore.getSnapshot();
    assert.equal(result.reply.turn.proposal.confirm(foreignStore).frame.outcome, 'conflict');
    assert.equal(foreignStore.getSnapshot(), foreignSnapshot);
    await env.ask('보내');
    assert.equal(env.store.getSnapshot(), result.snapshot);
    const { receipt, after } = confirm(env, result, 'coupon.sendSlot',
      id === 'S5-131' ? 'data.notices.notice.scheduled' : 'data.notice.sent');
    const original = result.snapshot.tables.marketing;
    const m = after.tables.marketing;
    const campaign = m.coupon.at(-1);
    assert.equal(campaign.origin, 'slot');
    const [slotId] = campaign.originRef.slotIds;
    const chosen = env.model(slotFeature, result.snapshot).openSlots.find(row => row.slotId === slotId);
    assert.ok(chosen);
    const sends = m.messageSend.slice(original.messageSend.length);
    const recipients = sends.map(row => row.customerId).sort();
    assert.deepEqual(recipients, [...chosen.regularIds].sort());
    assert.ok(sends.every(row => row.kind === 'coupon' && row.status === 'mock' && row.scheduledAt === stamp));
    assert.deepEqual(receipt.notice.params, { count: sends.length });
    assert.equal(receipt.undoToken, undefined);
  });
}

test('S6-125 holds a reminder when the ending café campaign has zero consenting text targets', async t => {
  const env = context(t, 'public-only');
  const result = await env.ask(authored.get('S6-125').utterances[0]);
  assert.equal(result.kind, 'clarify', result.reply.answer);
  assert.match(result.reply.answer, /알림을 보낼 수 있는 손님이 없어요/u);
  assert.ok(!result.calls.some(call => call.name === 'propose_action'));
  const row = env.model(statusFeature).rows.find(row => row.couponId === env.campaignId);
  assert.equal(row.endingSoon, true);
  assert.equal(row.reminderRecipients, 0);
});

test('S5-130 holds a slot send when consent has been withdrawn for the whole audience', async t => {
  const env = context(t, 'zero-slot');
  const current = env.store.getSnapshot();
  assert.ok(env.model(slotFeature).openSlots.length > 0);
  const result = await env.ask('빈 시간 쿠폰 지금 보내줘', slotFeature);
  assert.equal(result.kind, 'clarify', traceTurn(result));
  assert.match(result.reply.answer, /받는 사람이 없어요/u);
  assert.ok(!result.calls.some(call => call.name === 'propose_action'));
  assert.equal(env.store.getSnapshot(), current);
});

test('posting and unpublishing require evidence for the code’s current coupon state', () => {
  const handle = 'n16-couponCode-1';
  const target = { kind: 'couponCode', querySlot: 'codeId' };
  for (const [command, activated, statuses] of [
    ['coupon.markPosted', false, { active: 'ready', paused: 'refused', ended: 'refused' }],
    ['coupon.unpublish', true, { active: 'ready', paused: 'ready', ended: 'refused' }],
  ]) {
    const adapter = couponAdapters.find(candidate => candidate.command === command);
    for (const [status, expected] of Object.entries(statuses)) {
      const eligible = status === 'active' || (command === 'coupon.unpublish' && status === 'paused');
      const matches = [{ match: 'exact', handle, fields: { route: 'place_news', activated, eligible, unpublished: false } }];
      const input = { intent: { kind: 'command', command, args: { codeId: { handle } } }, slots: ['codeId'], searches: [{ ...target, matches }] };
      assert.equal(adapter.prepare({ input, reads: [{ ...target, status: 'ready', matches }] }).outcome, expected, `${command} ${status}`);
    }
  }
});

test('S6-135 rechecks the ending-soon audience after the extension receipt', async t => {
  const env = context(t, 'S6-135');
  const before = env.model(statusFeature).rows.find(row => row.couponId === env.campaignId);
  assert.equal(before.endingSoon, true);
  assert.ok(before.reminderRecipients > 0);
  const extended = await env.ask(`${campaignName} 일주일 연장하고 끝나기 전 알림도 보내줘`);
  const { after } = confirm(env, extended, 'coupon.extend');
  const changed = env.model(statusFeature).rows.find(row => row.couponId === env.campaignId);
  assert.equal(changed.daysLeft, before.daysLeft + 7);
  assert.equal(changed.endingSoon, false);
  const reminder = await env.ask(authored.get('S6-125').utterances[0]);
  assert.notEqual(reminder.kind, 'proposal', reminder.reply.answer);
  assert.ok(!reminder.calls.some(call => call.name === 'propose_action'));
  assert.deepEqual(after.tables.marketing.messageSend, extended.snapshot.tables.marketing.messageSend);
  assert.deepEqual(after.tables.marketing.couponReminder, extended.snapshot.tables.marketing.couponReminder);
});
