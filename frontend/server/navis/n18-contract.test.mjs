import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { createServer } from 'vite';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, navisAgentFakeFetch } from '../fixtures/navis-eval-fake.mjs';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest } from '../../shared/navis-agent-schema.mjs';
import { evidence, readCafeScenarios, readTrace, scenarioVariant } from './scenario-fixtures.mjs';

const trace = readTrace();
const assigned = trace.filter(row => row.slice_id === 'N18');
const required = trace.filter(row => row.required_slices.split('|').includes('N18'));
const corpus = new Map(JSON.parse(evidence('MERGED.json')).map(scenario => [scenario.id, scenario]));
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json'));
const unnamedPeriod = 'The first wording refers to a previous month without naming a widget or establishing it in a prior turn.';
const vite = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envDir: false, logLevel: 'silent',
  server: { middlewareMode: true, watch: null, ws: false, hmr: false },
});
const load = path => vite.ssrLoadModule(`/src/${path}.ts`);
const reviewedPromo = new Set(['S6-009', 'S6-019', 'S6-023']);
let data, guards, state, testSession, presets, motion, catalog, provider, navigation, promo, fakePromo, locale, reviewed;
try {
  [data, guards, state, testSession, presets, motion, catalog, provider, navigation, promo, fakePromo, locale] = await Promise.all([
    load('data/widget-data'), load('data/marketing/commands'), load('state/index'), load('app/test-session'),
    load('layout/presets'), load('ui/motion'), load('catalog/index'), load('features/assistant/provider'),
    load('screens/dashboard/navis-navigation'), load('features/widgets/mkt-promo/promo-session'),
    load('features/widgets/mkt-promo/promo-test-server'), load('features/assistant/messages'),
  ]);
  ({ corpus: reviewed } = await readCafeScenarios(vite));
} finally {
  await vite.close();
}

const tr = locale.navisTranslator('ko');
const normal = { kind: 'default' };
const posted = { 'S6-033': 'clip', 'S6-034': 'reels', 'S6-035': 'shorts', 'S6-040': 'clip' };
const finished = new Set(['S6-032', ...Object.keys(posted), 'S6-036', 'S6-037', 'S6-039', 'S6-041', 'S6-042', 'S6-045', 'S6-010', 'S5-092', 'S8-170']);
const assistedMake = new Set(['S6-028', 'S6-029', 'S8-170']);
const completeMake = new Set(['S6-028', 'S8-170']);
const neededEstimate = new Set([...assistedMake, 'S6-007']);
const active = new Set(['S6-004', 'S6-005', 'S6-030', 'S6-031', 'S6-046']);
const draftChanges = {
  'S6-016': { moods: ['warm'] }, 'S6-017': { moods: ['warm', 'clean'] },
  'S6-021': { memo: '비 오는 날 따뜻한 한 입' }, 'S6-025': { lengthSec: 15 },
};
const details = {
  'S5-096': { featureId: 'promo-video', view: 'create', focus: 'action' },
  'S6-044': { featureId: 'promo-video', view: 'create', focus: 'action' },
  'S6-045': { featureId: 'promo-video', view: 'create' },
  'S6-046': { featureId: 'promo-video', view: 'create' },
  'S6-047': { featureId: 'promo-video', view: 'create', prefill: { tab: 2 } },
  'S6-161': { featureId: 'customer-groups', view: 'regular' },
  'S6-162': { featureId: 'customer-groups', view: 'reach-out', focus: 'action' },
};

function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
function model(snapshot, featureId) {
  const view = data.selectWidget(snapshot, featureId, normal, 'normal');
  assert.equal(view.status, 'ready', JSON.stringify({ featureId, status: view.status }));
  return view.model;
}
function videoInput(snapshot, menuId = 'm-americano', count = 6) {
  return {
    menuIds: [menuId], photoIds: snapshot.tables.marketing.promoPhoto.filter(photo => photo.menuId === menuId).slice(0, count).map(photo => photo.photoId),
    moods: ['warm'], concepts: ['review-roundup'], memo: '', lengthSec: 15, referenceId: 'ref-2', locale: 'ko',
  };
}
function seedFixtureVideo(store, id, input) {
  const videoId = ok(store.dispatch({ type: 'video.make', input, idempotencyKey: `fixture-video-${id}` })).value.videoId;
  if (finished.has(id)) {
    ok(store.dispatch({ type: 'video.settle', videoId, outcome: { kind: 'done', result: {
      durationSec: input.lengthSec, music: { trackId: 'fixture', title: 'Fixture', artist: 'Fixture', licenseLabel: 'Fixture' },
      fileUrl: '/fixture/video.mp4', sizeBytes: 1, madeAt: data.NOW,
    } } }));
  }
  if (['S6-005', 'S6-030'].includes(id)) ok(store.dispatch({ type: 'video.settle', videoId, outcome: { kind: 'failed', reason: 'AI_TIMEOUT' } }));
  if (['S6-010', 'S6-039', 'S6-041', 'S5-092'].includes(id)) {
    ok(store.dispatch({ type: 'video.markPosted', videoId, route: id === 'S6-010' ? 'reels' : 'clip', idempotencyKey: `fixture-post-${id}` }));
  }
  return videoId;
}
function seedSlotSend(store, all) {
  const slots = model(store.getSnapshot(), 'slot-coupon');
  const selected = all ? slots.openSlots : slots.openSlots.filter(slot => slot.regularIds.length).slice(0, 1);
  const recipients = slots.recipients.filter(row => row.selectable && row.slotIds.some(id => selected.some(slot => slot.slotId === id)));
  ok(store.dispatch({ type: 'coupon.sendSlot', slotIds: selected.map(s => s.slotId), recipientIds: recipients.map(row => row.customerId),
    benefit: 'free-shot', idempotencyKey: 'n18-fixture-slot-send' }));
}

async function fixture(t, id) {
  const run = state.createRunStore({ screenPreset: presets.screenPresets.A, catalog: catalog.getRegistry('A'), time: motion.timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  testSession.beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  if (!id.startsWith('S7-')) run.actions.switchLayer('marketing');
  const draftRef = reviewed.get(id)?.n18PromoDraft ?? overlay[id]?.n18PromoDraft;
  if (draftRef) run.actions.openDetailRef(draftRef, 'navis');
  const seed = data.createWidgetDataStore().getSnapshot().tables;
  const hasFinancier = ['S6-012', 'S6-013', 'S6-029'].includes(id);
  const marketing = hasFinancier ? {
    ...seed.marketing,
    promoMenu: [...seed.marketing.promoMenu, {
      menuId: 'fixture-financier', names: { ko: '휘낭시에', en: 'Financier', 'zh-Hans': '费南雪', 'zh-Hant': '費南雪' }, order: seed.marketing.promoMenu.length,
    }],
    promoPhoto: [...seed.marketing.promoPhoto, ...overlay['S6-029'].expected.tools[0].args.args.photoIds.map((photoId, order) => ({
      photoId, menuId: 'fixture-financier', order, width: 1280, height: 960, url: '/fixture/photo.jpg',
    }))],
  } : seed.marketing;
  const waiting = seed.inquiryThread.filter(row => row.status !== 'done');
  const inquiryThread = ['S5-051', 'S5-092'].includes(id) ? seed.inquiryThread.map(row =>
    id === 'S5-051' && row === waiting[0] ? row : { ...row, status: 'done' }) : seed.inquiryThread;
  const store = data.createWidgetDataStore({ marketing, inquiryThread }, { runId: run.getState().runId });
  assert.equal(data.NOW, '2026-11-17T15:45');
  const promoSession = promo.promoSession(store);
  t.after(() => promoSession.dispose());
  const draft = videoInput(store.getSnapshot(), hasFinancier ? 'fixture-financier' : undefined, hasFinancier ? 10 : undefined);
  if (id === 'S6-028') draft.memo = draftChanges['S6-021'].memo;
  if (neededEstimate.has(id) || id === 'no-estimate') {
    const fields = { ...draft };
    delete fields.locale;
    promoSession.setDraft(id === 'S6-029' ? { ...fields, menuIds: [], photoIds: [], referenceId: null } : fields);
  }
  if (id === 'S6-013') promoSession.setDraft({ menuIds: draft.menuIds });
  const videoId = finished.has(id) || active.has(id) ? seedFixtureVideo(store, id, draft) : undefined;
  if (id === 'S6-040') {
    const couponId = store.getSnapshot().tables.marketing.coupon.find(row => row.status === 'active').couponId;
    ok(store.dispatch({ type: 'coupon.pause', couponId }));
  }
  if (['S5-092', 'S6-184'].includes(id)) seedSlotSend(store, id === 'S5-092');
  if (id === 'S5-092') {
    const items = model(store.getSnapshot(), 'expiry-coupon').items;
    for (const { itemId } of items) ok(store.dispatch({ type: 'coupon.createExpiry', itemId,
      benefit: { kind: 'percent', value: 40 }, route: 'place_news', idempotencyKey: `fixture-expiry-${itemId}` }));
  }
  const simulated = fakePromo.createFakeServer();
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = (url, init) => {
    paths.push(String(url));
    assert.equal(paths.at(-1), '/api/promo/estimate-model', 'Unexpected external request in N18 replay');
    return simulated.fetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    assert.deepEqual(paths, neededEstimate.has(id) ? ['/api/promo/estimate-model'] : [], 'Offline promo request scope changed');
  });
  if (neededEstimate.has(id)) await promoSession.loadEstimate();

  const bridge = createNavisMenuHarness(options => createBridge({ ...options, agentMode: 'fixture', onDiagnostics() {} }), validateAgentFrame, navisAgentFakeFetch);
  t.after(bridge.close);
  const requests = [], calls = [];
  const assistant = provider.createAssistantProvider({ store, run, async fetcher(_url, init) {
    const request = JSON.parse(init.body);
    assert.equal(validateAgentRequest(request), true, JSON.stringify(request.intent));
    requests.push(request);
    const result = await bridge.run(request);
    assert.equal(result.status, 200, result.raw);
    assert.equal(result.terminal.code, undefined, result.raw);
    calls.push(...result.calls);
    return new globalThis.Response(result.raw, { status: 200,
      headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL, 'content-type': 'text/event-stream' } });
  } });
  const nav = navigation.createNavisNavigation(run, { highlight() {}, closeChat() {} });
  const ask = async (text, continuation) => {
    const before = store.getSnapshot(), beforeDraft = promoSession.getState().draft;
    const plan = navigation.classifyNavigation(text, run.getState(), before);
    const prepared = plan && navigation.prepareNavigationRequest(plan, run.getState(), nav);
    let detail;
    const reply = await assistant.ask({ text, locale: 'ko', layer: run.getState().layer, signal: new globalThis.AbortController().signal,
      ...(continuation && { continuation }),
      ...(prepared && { agentTurn: prepared.agentTurn, onNavigation: intent => { detail = prepared.resolve(intent); } }),
    });
    assert.equal(store.getSnapshot(), before, 'Text changed the store');
    assert.equal(promoSession.getState().draft, beforeDraft, 'Text changed the promo draft');
    if (detail && plan) assert.equal(await nav.execute(plan.command, detail), 'opened');
    return { reply, detail, before };
  };
  return { ask, store, run, nav, promoSession, draft, videoId, requests, calls, simulated };
}

function kind({ reply, detail }) {
  if (detail) return 'navigate';
  return { clarification: 'clarify', ambiguity: 'clarify', refusal: 'refuse', handoff: 'refuse', proposal: 'proposal' }[reply.turn?.kind] ?? 'answer';
}
function checkFields(actual, expected) {
  for (const [field, value] of Object.entries(expected)) assert.deepEqual(actual[field], value, field);
}

async function press(env, result, command, tier = 'normal') {
  const card = result.reply.proposalSession;
  assert.ok(card?.isPending(), result.reply.answer);
  const { proposal } = card.getSnapshot();
  assert.equal(proposal.command, command);
  assert.equal(proposal.tier, tier);
  assert.ok(env.calls.some(call => call.name === 'propose_action' && call.args.command === command));
  assert.equal(card.confirm(env.store, 'other-proposal'), undefined);
  const foreignStore = data.createWidgetDataStore(undefined, { runId: result.before.runId });
  assert.equal(card.confirm(foreignStore, proposal.id)?.frame.outcome, 'conflict');
  await env.ask('확인');
  assert.equal(env.store.getSnapshot(), result.before);
  if (tier === 'extra-confirm') {
    const challenge = card.confirm(env.store, proposal.id);
    assert.equal(challenge?.requiresExtraConfirmation, true);
    assert.equal(env.store.getSnapshot(), result.before);
    await env.ask('정말 확인');
    assert.equal(env.store.getSnapshot(), result.before);
  }
  const receipt = card.confirm(env.store, proposal.id, tier === 'extra-confirm');
  assert.equal(receipt?.frame.outcome, 'applied', JSON.stringify(receipt));
  assert.equal(receipt.notice?.messageKey, receipt.frame.messageKey);
  const after = env.store.getSnapshot();
  card.confirm(env.store, proposal.id);
  assert.equal(env.store.getSnapshot(), after);
  if (command !== 'promo.draft.set') {
    assert.equal(after.revision, result.before.revision + 1);
    assert.equal(receipt.undoToken, undefined);
  }
  return { receipt, after };
}

async function verifyMakeHandoff(env, result) {
  assert.equal(kind(result), 'refuse', result.reply.answer);
  assert.equal(result.reply.proposalSession, undefined);
  assert.equal(result.reply.turn.alternative?.command, 'video.make');
  assert.equal(await env.nav.handoff(result.reply.turn.alternative), 'opened');
  const ref = env.run.getState().overlay.stack?.at(-1);
  assert.equal(ref?.featureId, 'promo-video');
  assert.deepEqual(ref?.prefill?.fields, { tab: 0, composing: true });
  assert.equal(env.store.getSnapshot(), result.before);
  assert.equal(env.simulated.job, null);
  assert.ok(env.requests.every(request => request.intent.command !== 'video.make'));
}

async function verifyMake(env, result) {
  assert.equal(kind(result), 'proposal', result.reply.answer);
  const fields = result.reply.proposalSession.getSnapshot().preview.fields;
  assert.ok(fields.some(field => field.after === `${env.draft.photoIds.length}장`));
  assert.ok(fields.some(field => field.after.includes('예상 시간') && field.after.includes('예상 비용')));
  const { receipt } = await press(env, result, 'video.make');
  assert.equal(receipt.frame.messageKey, 'data.marketing.notice.videoStarted');
  const rows = env.store.getSnapshot().tables.marketing.promoVideo;
  assert.equal(rows.length, result.before.tables.marketing.promoVideo.length + 1);
  const row = rows.at(-1);
  assert.deepEqual(row.input, env.draft);
  assert.equal(row.status, 'failed');
  assert.match(row.jobId, /^pj-/u);
  assert.equal(env.simulated.job, null);
}

async function verifyPosted(env, result, route, expectedIssue) {
  const fields = result.reply.proposalSession?.getSnapshot().preview?.fields;
  const couponImpact = fields?.find(field => field.label === '쿠폰 코드');
  if (expectedIssue) assert.ok(couponImpact?.after.includes(`${expectedIssue}장`), 'The posted card must disclose coupon issuance');
  else assert.equal(couponImpact, undefined);
  const { receipt, after } = await press(env, result, 'video.markPosted', 'extra-confirm');
  assert.equal(receipt.frame.messageKey, expectedIssue ? 'data.marketing.notice.counting' : 'data.marketing.notice.videoMarkedPosted');
  const row = after.tables.marketing.promoVideo.find(video => video.videoId === env.videoId);
  assert.equal(row.status, 'posted');
  assert.equal(row.postedRoute, route);
  assert.equal(row.postedAt, data.NOW);
  assert.equal(model(after, 'promo-video').postedCount, model(result.before, 'promo-video').postedCount + 1);
  const code = after.tables.marketing.couponCode.find(code => code.videoId === row.videoId);
  assert.equal(code?.issueCount ?? 0, expectedIssue);
  const report = model(after, 'marketing-performance');
  assert.equal(report.issued, model(result.before, 'marketing-performance').issued + expectedIssue);
  assert.equal(report.used, model(result.before, 'marketing-performance').used);
  assert.ok(report.byVideo.some(video => video.videoId === row.videoId && video.postedRoute === route && video.issued === expectedIssue));
  await env.ask('되돌려 줘');
  assert.equal(env.store.getSnapshot(), after, 'Typed undo changed the posted record');
}

async function verifyReachOut(env, result) {
  const recipients = model(result.before, 'customer-groups').reachOut.recipientIds;
  const fields = result.reply.proposalSession?.getSnapshot().preview?.fields;
  assert.ok(fields?.some(field => field.after.includes(`${recipients.length}명`)), 'The reach-out card must disclose the eligible audience');
  assert.ok(fields.some(field => field.after === tr.t('data.marketing.sms.reachOut')), 'The reach-out card must disclose the outgoing coupon message');
  const { receipt, after } = await press(env, result, 'coupon.sendReachOut');
  assert.equal(receipt.frame.messageKey, 'data.notice.sent');
  const sends = after.tables.marketing.messageSend.slice(result.before.tables.marketing.messageSend.length);
  assert.deepEqual(sends.map(row => row.customerId), recipients);
  assert.ok(sends.every(row => row.status === 'mock' && row.body.key === 'data.marketing.sms.reachOut'));
  assert.equal(model(after, 'marketing-performance').issued, model(result.before, 'marketing-performance').issued + recipients.length);
  assert.equal(model(after, 'marketing-performance').used, model(result.before, 'marketing-performance').used);
  assert.equal(model(after, 'customer-groups').sent.length, model(result.before, 'customer-groups').sent.length + 1);
  assert.ok(env.requests.every(request => recipients.every(id => !JSON.stringify(request).includes(id))));
  await env.ask('되돌려 줘');
  assert.equal(env.store.getSnapshot(), after, 'Typed undo changed the reach-out receipt');
}

test('N18 validators use the same eligibility as the widget commands and return their own receipts', () => {
  const store = data.createWidgetDataStore(), snapshot = store.getSnapshot();
  const draft = videoInput(snapshot);
  assert.deepEqual(guards.previewVideoMake(snapshot, draft), { ok: true, input: draft });
  const invalid = { ...draft, photoIds: [...draft.photoIds.slice(0, 4), draft.photoIds[0]] };
  const makeError = guards.previewVideoMake(snapshot, invalid);
  assert.equal(makeError.messageKey, 'data.marketing.error.fewPhotos');
  assert.deepEqual(store.dispatch({ type: 'video.make', input: invalid, idempotencyKey: 'n18-invalid' }), makeError);
  const groups = model(snapshot, 'customer-groups');
  const audience = groups.reachOut.recipientIds.slice(0, 1);
  assert.deepEqual(guards.previewReachOut(snapshot, [...audience, ...audience]), { ok: true, recipientIds: audience });
  const selectBlocked = guards.previewReachOut(snapshot, groups.reachOut.blockedIds.slice(0, 1));
  assert.equal(selectBlocked.messageKey, 'data.marketing.error.noConsent');
  assert.deepEqual(store.dispatch({ type: 'coupon.sendReachOut', recipientIds: groups.reachOut.blockedIds.slice(0, 1), idempotencyKey: 'n18-blocked' }), selectBlocked);
  assert.equal(store.getSnapshot(), snapshot);
  const started = ok(store.dispatch({ type: 'video.make', input: draft, idempotencyKey: 'n18-valid' }));
  assert.equal(started.noticeKey, 'data.marketing.notice.videoStarted');
  const making = store.getSnapshot();
  assert.equal(guards.previewVideoMake(making, draft).messageKey, 'data.marketing.error.busy');
  const markError = guards.previewVideoMarkPosted(making, started.value.videoId, 'clip');
  assert.equal(markError.messageKey, 'data.marketing.error.notReady');
  assert.deepEqual(store.dispatch({ type: 'video.markPosted', videoId: started.value.videoId, route: 'clip', idempotencyKey: 'n18-not-ready' }), markError);
  assert.deepEqual(store.dispatch({ type: 'video.make', input: draft, idempotencyKey: 'n18-valid' }), { ...started, duplicate: true });
  assert.equal(store.getSnapshot(), making);
});

test('N18 has 73 assigned scenarios and 79 required_slices', () => {
  assert.equal(assigned.length, 73);
  assert.equal(new Set(assigned.map(row => row.scenario_id)).size, 73);
  assert.equal(required.length, 79);
  assert.deepEqual(required.filter(row => row.slice_id !== 'N18').map(row => row.scenario_id),
    ['S6-029', 'S6-048', 'S6-137', 'S6-163', 'S6-164', 'S8-071']);
});

function expectedFor(id) {
  const original = corpus.get(id).expected;
  return overlay[id]?.policyGap?.expected ?? { ...original, ...overlay[id]?.expected };
}

function readFragments(id, snapshot) {
  const video = () => model(snapshot, 'promo-video');
  const perf = () => model(snapshot, 'marketing-performance');
  const groups = () => model(snapshot, 'customer-groups');
  const replyCount = () => model(snapshot, 'ai-response').waitingCount;
  const route = name => perf().routes.find(row => row.route === name);
  const displayText = value => data.resolveDataText(tr.t, value);
  const leadingCoupon = () => [...perf().byCoupon].filter(row => row.rate !== null).sort((a, b) => b.rate - a.rate)[0];
  const won = amount => `${new Intl.NumberFormat('ko-KR').format(amount)}원`;
  switch (id) {
    case 'S5-050': case 'S5-051': return [`${replyCount()}건`];
    case 'S6-001': return [`${video().photoCount}장`];
    case 'S6-002': return [`${video().photoCount}장`, '5장'];
    case 'S6-007': return ['예상 시간', '예상 비용'];
    case 'S6-008': return video().menus.filter(menu => menu.hasPhotos).map(menu => menu.names.ko);
    case 'S6-011': return [];
    case 'S6-043': return [`${video().photoCount}장`];
    case 'S6-106': case 'S6-176': {
      const best = leadingCoupon();
      return [displayText(best.name), `${best.rate}%`];
    }
    case 'S6-143': return [displayText(groups().churnRisk[0].name)];
    case 'S6-144': {
      const oldest = groups().churnRisk[0];
      return [displayText(oldest.name), `${oldest.daysSinceLast}일`];
    }
    case 'S6-145': return [`${groups().reachOut.blockedIds.length}명`];
    case 'S6-146': {
      const { regularDays, regularVisits, churnGapDays } = groups().rule;
      return [`${regularDays}일`, `${regularVisits}번`, `${churnGapDays}일`, '카드'];
    }
    case 'S6-149': return [];
    case 'S6-169': return [won(perf().discount)];
    case 'S6-173': return [`${route('sms').issued}장`, `${route('sms').used}장`];
    case 'S6-177': return ['블로그'];
    case 'S6-179': return [won(perf().revenue.total), won(perf().revenue.coupon), won(perf().revenue.attributed), '14일'];
    case 'S6-184': return [`${perf().issued}장`, `${perf().used}장`];
    case 'S6-186': return ['14일'];
    default: return expectedFor(id).answer_must_contain ?? [];
  }
}

/**
 * D-365: the 마케팅 성과 widget is gone. These rows opened it or read its numbers; the chat now answers plainly that the screen or
 * the number is no longer shown, opens nothing and never reads the removed widget. (A-3 expectation patch for B17: each id below,
 * kind answer, text from couponChatCopy.performanceGone / performanceStopped.)
 */
const retiredPerformance = new Set(['S6-169', 'S6-173', 'S6-177', 'S6-179', 'S6-184', 'S6-186', 'S6-191', 'S6-192', 'S6-193', 'S6-194', 'S7-086', 'S7-087']);

async function verifyRetired(env, result) {
  assert.equal(kind(result), 'answer', result.reply.answer);
  assert.match(result.reply.answer, /마케팅 성과 화면은 없어졌어요|이제 따로 보여 드리지 않아요/u);
  assert.equal(result.detail, undefined);
  assert.ok(!JSON.stringify(env.calls).includes('marketing-performance'), 'The removed widget was read or opened');
  assert.ok(!env.calls.some(call => call.name === 'propose_action'), 'A retired read admitted a write');
  assert.equal(env.store.getSnapshot(), result.before);
}

async function verifyScenario(t, id, variant = 0) {
  const env = await fixture(t, id);
  const result = await env.ask(corpus.get(id).utterances[variant]);
  // S6-193's first wording names no widget (a known TODO row); only its explicit second wording is retired.
  if (retiredPerformance.has(id) && !(id === 'S6-193' && variant === 0)) return verifyRetired(env, result);
  const expected = expectedFor(id);
  // Cross-widget comparisons use a read-only reply with no proposal.
  // S6-015 uses the café's six real Americano photos, so selecting them is a valid draft patch.
  const expectedKind = completeMake.has(id) || ['S6-015', 'S6-030'].includes(id) ? 'proposal'
    : assistedMake.has(id) ? 'refuse' : expected.kind === 'multi' ? 'answer' : expected.kind;
  assert.equal(kind(result), expectedKind, result.reply.answer);
  if (id === 'S6-030') {
    const video = result.before.tables.marketing.promoVideo.find(row => row.videoId === env.videoId);
    const { receipt, after } = await press(env, result, 'video.retry');
    assert.equal(receipt.frame.messageKey, 'data.marketing.notice.videoStarted');
    assert.equal(receipt.notice.params.videoId, video.videoId);
    assert.equal(after.tables.marketing.promoVideo.length, result.before.tables.marketing.promoVideo.length);
    const retried = after.tables.marketing.promoVideo.find(row => row.videoId === env.videoId);
    assert.deepEqual(retried.input, video.input);
    assert.equal(retried.retryCount, video.retryCount + 1);
    await Promise.resolve();
    const settled = env.store.getSnapshot().tables.marketing.promoVideo.find(row => row.videoId === env.videoId);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.failReason, 'AI_UNAVAILABLE');
    assert.match(settled.jobId, /^pj-/);
    assert.equal(env.simulated.job, null);
    assert.ok(env.simulated.calls.every(call => call.path === '/api/promo/estimate-model'));
    return;
  }
  if (posted[id]) return verifyPosted(env, result, posted[id], id === 'S6-033' ? 10 : 0);
  if (completeMake.has(id)) return verifyMake(env, result);
  if (assistedMake.has(id)) return verifyMakeHandoff(env, result);
  if (id === 'S6-014') {
    assert.equal(result.reply.turn.field, 'photoCount');
    assert.deepEqual(env.calls, []);
    assert.deepEqual(env.promoSession.getState().draft.photoIds, []);
  }
  const patch = draftChanges[id] ?? (['S6-012', 'S6-013', 'S6-015'].includes(id) ? {
    menuIds: env.draft.menuIds, photoIds: env.draft.photoIds.slice(0, id === 'S6-013' ? 5 : undefined),
  } : undefined);
  if (patch) {
    const before = env.promoSession.getState().draft;
    await press(env, result, 'promo.draft.set');
    checkFields(env.promoSession.getState().draft, patch);
    assert.notEqual(env.promoSession.getState().draft, before);
    assert.equal(env.store.getSnapshot(), result.before);
    if (patch.memo) assert.ok(!JSON.stringify(env.requests).includes(patch.memo), 'Draft memo crossed the bridge');
    return;
  }
  assert.ok(!env.calls.some(call => call.name === 'propose_action'), 'Read or handoff admitted a write');
  if (id === 'S5-050' || id === 'S5-051') {
    const awaiting = model(result.before, 'ai-response').waitingCount;
    const today = model(result.before, 'marketing-today').cells.find(cell => cell.kind === 'replies');
    assert.equal(today?.params.count, awaiting);
    assert.match(result.reply.answer, id === 'S5-050' ? /같/u : /오늘 할 홍보/u);
  }
  if (id === 'S5-093') {
    const target = model(result.before, 'marketing-today').tapTarget;
    checkFields(result.detail, target);
    return;
  }
  if (id === 'S6-011') {
    assert.equal(model(result.before, 'promo-video').postedCount, 0);
    assert.equal(model(result.before, 'marketing-performance').byVideo.length, 0);
    assert.match(result.reply.answer, /0편|영상이 (?:아직 )?없/u);
    assert.doesNotMatch(result.reply.answer, /19%/u);
  }
  if (details[id]) {
    checkFields(result.detail, details[id]);
    return;
  }
  for (const fragment of readFragments(id, result.before)) {
    assert.ok(result.reply.answer.includes(fragment), `Missing ${fragment} in ${result.reply.answer}`);
  }
}

async function verifyReviewedPromo(t, id, variant) {
  const scenario = scenarioVariant(reviewed.get(id), variant);
  assert.equal(scenario.fixtureBlock, undefined);
  const env = await fixture(t, id);
  const beforeDraft = env.promoSession.getState().draft;
  const result = await env.ask(scenario.utterances[variant]);
  const { expected } = scenario;
  assert.equal(kind(result), expected.kind, result.reply.answer);
  for (const fragment of (expected.answer_must_contain ?? []).flat()) assert.ok(result.reply.answer.includes(fragment), fragment);
  for (const fragment of expected.answer_must_not_contain ?? []) assert.ok(!result.reply.answer.includes(fragment), fragment);
  if (expected.kind === 'proposal') {
    const [{ args: { command, args } }] = expected.tools;
    assert.deepEqual(env.calls.at(-1), { name: 'propose_action', args: { command, args } });
    const { receipt } = await press(env, result, command);
    checkFields(env.promoSession.getState().draft, args);
    assert.ok(receipt.notice.undo, 'The local draft receipt offers undo');
  } else {
    assert.deepEqual(env.calls, expected.tools);
    assert.equal(result.reply.proposalSession, undefined);
    assert.equal(env.promoSession.getState().draft, beforeDraft);
    if (expected.kind === 'clarify') assert.deepEqual([result.reply.turn.field], expected.ask);
  }
  assert.equal(env.store.getSnapshot(), result.before);
}

for (const { scenario_id: id } of assigned) {
  test(`N18 ${id}`, { todo: id === 'S6-193' ? unnamedPeriod : undefined }, async t => {
    if (!reviewedPromo.has(id)) return verifyScenario(t, id);
    for (const [variant] of reviewed.get(id).utterances.entries()) {
      await t.test(`variant ${variant + 1}`, subtest => verifyReviewedPromo(subtest, id, variant));
    }
  });
}
test('N18 S6-193 explicit performance request', t => verifyScenario(t, 'S6-193', 1));

for (const [id, variant, field] of [['S6-014', 2, 'photoCount'], ['S6-020', 1, 'concept']]) {
  test(`N18 ${id} clarifies ${field} on the marketing board`, async t => {
    const env = await fixture(t, id);
    const result = await env.ask(corpus.get(id).utterances[variant]);
    assert.equal(kind(result), 'clarify', result.reply.answer);
    assert.equal(result.reply.turn.field, field);
    assert.deepEqual(env.calls, []);
  });
}

test('N18 S6-029 asks for the missing design before offering a job', async t => {
  const env = await fixture(t, 'S6-029');
  const photos = await env.ask(corpus.get('S6-012').utterances[0]);
  await press(env, photos, 'promo.draft.set');
  assert.deepEqual(env.promoSession.getState().draft.photoIds, env.draft.photoIds);
  assert.equal(env.promoSession.getState().draft.referenceId, null);
  const result = await env.ask('영상 만들어줘');
  assert.equal(kind(result), 'clarify');
  assert.equal(result.reply.turn.field, 'referenceId');
  assert.equal(env.store.getSnapshot(), result.before);
  assert.equal(env.simulated.job, null);
});

test('N18 S8-170 starts a complete draft despite an unposted video', async t => {
  const env = await fixture(t, 'S8-170');
  const result = await env.ask(corpus.get('S8-170').utterances[0]);
  assert.ok(result.reply.proposalSession?.getSnapshot().preview.fields.some(field => field.after === '아직 안 올린 영상이 1개 있어요'));
  await verifyMake(env, result);
  assert.equal(env.store.getSnapshot().tables.marketing.promoVideo.find(row => row.videoId === env.videoId).status, 'done');
});

test('N18 opens the widget for a new video without a cached estimate', async t => {
  const env = await fixture(t, 'no-estimate');
  await verifyMakeHandoff(env, await env.ask('영상 만들어줘'));
});

for (const text of ['완성된 영상 릴스에 올려줘', '영상 클립에 업로드해줘', '영상 클립에 아직 안 올렸어',
  '“영상 클립에 올렸어”라고 손님이 말했어', '영상 클립에 올렸다고 표시하지 마',
  '영상 클립에 올렸는지 확인해줘', '동료가 영상을 클립에 올렸대',
  '손님이 영상을 클립에 올렸다고 했어요', '영상 클립에 올렸다고 표시해 달라는 건 아니에요']) {
  test(`N18 cannot mark a video without attestation (${text})`, async t => {
    const env = await fixture(t, 'S6-033');
    const result = await env.ask(text);
    assert.notEqual(kind(result), 'proposal', result.reply.answer);
    assert.ok(!env.calls.some(call => call.name === 'propose_action'));
    assert.equal(env.store.getSnapshot().tables.marketing.promoVideo.at(-1).status, 'done');
  });
}

test('N18 asks which route when a video attestation names two publishing channels', async t => {
  const env = await fixture(t, 'S6-033');
  const result = await env.ask('영상 클립하고 쇼츠에 올렸어');
  assert.equal(kind(result), 'clarify');
  assert.equal(result.reply.turn.field, 'route');
  assert.deepEqual(env.calls, []);
  assert.equal(env.store.getSnapshot(), result.before);
});

test('N18 S6-152 sends exactly the eligible group after the owner card', async t => {
  const env = await fixture(t, 'S6-152');
  await verifyReachOut(env, await env.ask(corpus.get('S6-152').utterances[0]));
});

for (const text of ['이탈 손님한테 쿠폰 보내지 말아줘', '이탈 손님에게 동의 여부와 상관없이 문자 쿠폰 보내줘']) {
  test(`N18 keeps the reach-out card unavailable (${text})`, async t => {
    const env = await fixture(t, 'S6-152');
    const result = await env.ask(text);
    assert.notEqual(kind(result), 'proposal', result.reply.answer);
    assert.deepEqual(env.calls, []);
    assert.equal(env.store.getSnapshot(), result.before);
  });
}

test('N18 S6-163 sends only on the reach-out step after the group count', async t => {
  const env = await fixture(t, 'S6-163');
  const summary = await env.ask('떠날 손님 몇 명이야?');
  assert.equal(kind(summary), 'answer');
  const { counts } = model(summary.before, 'customer-groups');
  assert.ok(summary.reply.answer.includes(`${counts['churn-risk']}명`), summary.reply.answer);
  await verifyReachOut(env, await env.ask('떠날 손님한테 쿠폰 문자 보내줘'));
});

test('N18 stale and cancelled cards leave the widget tables untouched', async t => {
  const env = await fixture(t, 'S6-030');
  const first = await env.ask('홍보 영상 다시 만들기');
  const firstCard = first.reply.proposalSession;
  assert.ok(firstCard?.isPending(), first.reply.answer);
  const firstId = firstCard.getSnapshot().proposal.id;
  const couponId = first.before.tables.marketing.coupon.find(row => row.status === 'active').couponId;
  ok(env.store.dispatch({ type: 'coupon.pause', couponId }));
  const stale = env.store.getSnapshot();
  assert.equal(firstCard.confirm(env.store, firstId)?.frame.outcome, 'conflict');
  assert.equal(env.store.getSnapshot(), stale);
  const second = await env.ask('홍보 영상 다시 만들기');
  const secondCard = second.reply.proposalSession;
  assert.ok(secondCard?.isPending(), second.reply.answer);
  const secondId = secondCard.getSnapshot().proposal.id;
  assert.equal(secondCard.cancel()?.frame.outcome, 'cancelled');
  secondCard.confirm(env.store, secondId);
  assert.equal(env.store.getSnapshot(), stale);
  assert.equal(env.simulated.job, null);
});
