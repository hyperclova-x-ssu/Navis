import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createServer } from 'vite';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, navisAgentFakeFetch } from '../fixtures/navis-eval-fake.mjs';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest } from '../../shared/navis-agent-schema.mjs';
import { evidence, readTrace } from './scenario-fixtures.mjs';

const trace = readTrace();
const scenarios = trace.filter(row => row.slice_id === 'N19');
const required = trace.filter(row => row.required_slices.split('|').includes('N19'));
const corpus = new Map(JSON.parse(evidence('MERGED.json')).map(row => [row.id, row]));
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json'));
const vite = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, envDir: false,
  envPrefix: 'N19_TEST_ONLY_', logLevel: 'silent',
  server: { middlewareMode: true, watch: null, ws: false, hmr: false },
});
const load = path => vite.ssrLoadModule(`/src/${path}.ts`);
let data, guard, session, catalog, state, presets, motion, provider, nav, mode, messages, cctvSample;
try {
  [data, guard, session, catalog, state, presets, motion, provider, nav, mode, messages, cctvSample] = await Promise.all([
    load('data/widget-data'), load('data/commands/management-guards'), load('app/test-session'), load('catalog/index'),
    load('state/index'), load('layout/presets'), load('ui/motion'), load('features/assistant/provider'),
    load('screens/dashboard/navis-navigation'), load('features/cctv/live/mode'), load('features/assistant/messages'), load('data/cctv/snapshot'),
  ]);
} finally {
  await vite.close();
}

const day = data.TODAY;
const normal = { kind: 'default' };
const tr = messages.navisTranslator('ko');
const errata = {
  'S2-224': 'The sample camera snapshot has no tables needing clearing.',
  'S2-227': 'Hourly visits come from the current café observation rows.',
  'S2-228': 'Noon café visits come from the current sample hourly row.',
  'S2-229': 'The least-busy counted hour is derived from the café observations.',
  'S2-232': 'There are two sample cameras in the café.',
  'S2-233': 'The camera-disconnected preview changes the last seeded camera. Normal facts still show both cameras connected.',
  'S2-234': 'Normal data has a partial 15:00 sample. The 12:00 and 13:00 gaps belong to a presentation preview.',
  'S2-239': 'Review uses the café business day, November 17.',
  'S2-240': 'The representative 20:00 request has no recorded visit interval. The literal 09:00 and 15:00 variants have same-day observations in this café.',
  'S2-253': 'D-324 requires a card press to change the local display mode.',
  'S2-258': 'The café counted 180 total sample visits as of 15:45. Historical comparison requires comparable coverage.',
  'S2-259': 'The normal café sample has two connected cameras. Reconnection is handled in the CCTV widget.',
  'S3-003': 'Use the café sensor measurement and the stored inclusive ranges.',
  'S3-005': 'Use the maximum of the stored café trend. The latest 15:45 point is a separate reading.',
  'S3-009': 'Use the playlist names from the current café seed.',
  'S3-010': 'The selected café list is 오후의 재즈.',
  'S3-012': 'D-324 uses normal facts for a general read, independent of the abnormal preview.',
  'S3-013': 'Pausing preserves the café volume of 28% and selected track.',
  'S3-020': 'The café volume is 28%.',
  'S3-022': 'The literal request for 55% changes the café volume of 28%. The unchanged replay uses the current volume.',
  'S3-024': 'Playlist choice labels come from the café seed.',
  'S3-025': 'The unchanged replay uses the current café playlist name.',
  'S3-027': 'Exact song requests use environment.selectTrack, preserving the requested target.',
  'S4-010': 'Cancellation count comes from the current café reservations.',
  'S4-099': 'The café briefing has tax and checklist alerts.',
  'S4-103': 'The café briefing lists the current confirmed reservation count and party total.',
  'S4-104': 'Use the café closing selector totals.',
  'S4-105': 'November 18 schedule and booking facts replace the October example.',
  'S4-107': 'Yesterday is November 16 in the café.',
  'S4-121': 'The café has zero restock alerts. Inventory opens without a selected alert.',
  'S4-122': 'The café withholding-tax alert points to the current tax row.',
  'S4-128': 'Use the November 18 calendar and reservations, with current stock facts when available.',
};
// EXPECT-4. D-327 resolves the live-camera and arrival replay expectations.
const exceptions = {
  'S2-255': 'N19 R5 with N18 R5: café CCTV playback routes to Promo Video.',
  'S4-128': 'N21 with N19: the combined calendar, booking and inventory handoff remains open.',
};

const plans = {
  'S2-239': { command: 'cctv.markPeakForReview', receipt: 'data.notice.peakMarked', hour: 14 },
  'S2-253': { command: 'ui.setCctvMode', receipt: 'data.notice.cctvModeMock', mode: 'mock' },
  'S3-013': { command: 'environment.setPlaying', receipt: 'data.environment.playingSet', patch: { playing: false } },
  'S3-014': { command: 'environment.setPlaying', receipt: 'data.environment.playingSet', patch: { playing: true } },
  'S3-016': { command: 'environment.skipTrack', receipt: 'data.environment.trackSkipped', patch: { trackId: 'afternoon-2' } },
  'S3-017': { command: 'environment.skipTrack', receipt: 'data.environment.trackSkipped', patch: { trackId: 'afternoon-2' } },
  'S3-018': { command: 'environment.setVolume', receipt: 'data.environment.volumeSet', patch: { volumePct: 70 } },
  'S3-019': { command: 'environment.setVolume', receipt: 'data.environment.volumeSet', patch: { volumePct: 0 } },
  'S3-023': { command: 'environment.selectPlaylist', receipt: 'data.environment.playlistSelected', patch: { playlistId: 'morning', trackId: 'morning-1' } },
  'S3-027': { command: 'environment.selectTrack', receipt: 'data.environment.trackSelected', patch: { trackId: 'afternoon-2' } },
  'S4-114': { command: 'ui.acknowledgeBriefing', receipt: 'data.notice.briefingAcknowledged', acknowledge: true },
};
const details = {
  'S2-251': { featureId: 'customer-analysis' }, 'S2-254': { featureId: 'customer-analysis', hour: 14 },
  'S2-255': { featureId: 'customer-analysis' }, 'S4-119': { featureId: 'briefing' },
  'S4-120': { featureId: 'briefing', view: 'closing' }, 'S4-121': { featureId: 'inventory-booking' },
  'S4-122': { featureId: 'tax' },
  'S4-123': { featureId: 'briefing', view: 'alerts' },
};

function accepted(result) {
  assert.equal(result?.ok, true, JSON.stringify(result));
  return result;
}

function context(t, id) {
  const run = state.createRunStore({ screenPreset: presets.screenPresets.A, catalog: catalog.getRegistry('A'), time: motion.timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  session.beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const store = data.createWidgetDataStore(undefined, { runId: run.getState().runId });
  mode.setCctvMode(['S2-222', 'S2-253'].includes(id) ? 'live' : 'mock');
  t.after(() => mode.setCctvMode('mock'));
  if (['S2-242', 'S2-244'].includes(id)) accepted(store.dispatch({ type: 'cctv.markPeakForReview', date: day, hour: 14 }));
  if (id === 'S3-014') accepted(store.dispatch({ type: 'environment.setPlaying', playing: false }));
  const variants = { 'S2-233': 'camera-disconnected', 'S2-234': 'gaps', 'S2-259': 'camera-disconnected', 'S3-012': 'out_of_range' };
  if (variants[id]) run.actions.setPreviewVariant(id === 'S3-012' ? 'store-environment' : 'customer-analysis', variants[id]);
  if (id === 'S4-123') run.actions.acknowledgeBriefing();

  const harness = createNavisMenuHarness(options => createBridge({ ...options, agentMode: 'fake', onDiagnostics() {} }), validateAgentFrame, navisAgentFakeFetch);
  t.after(harness.close);
  const calls = [], requests = [];
  const assistant = provider.createAssistantProvider({ store, run, async fetcher(_url, init) {
    const request = JSON.parse(init.body);
    assert.equal(validateAgentRequest(request), true, JSON.stringify(request.intent));
    requests.push(request);
    const result = await harness.run(request);
    assert.equal(result.status, 200, result.raw);
    assert.equal(result.terminal.code, undefined, result.raw);
    calls.push(...result.calls);
    return new globalThis.Response(result.raw, { status: result.status,
      headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL, 'content-type': 'text/event-stream' } });
  } });
  const navigation = nav.createNavisNavigation(run, { highlight() {}, closeChat() {} });
  const ask = async text => {
    const snapshot = store.getSnapshot();
    const beforeRun = run.getState(), beforeMode = mode.getCctvMode();
    const plan = nav.classifyNavigation(text, beforeRun, snapshot);
    const prepared = plan && !plan.local && !plan.unsupportedPeriod && nav.prepareNavigationRequest(plan, beforeRun, navigation);
    let detail;
    const reply = await assistant.ask({ text, locale: 'ko', layer: 'management', signal: new globalThis.AbortController().signal,
      ...(prepared && { agentTurn: prepared.agentTurn, onNavigation: intent => { detail = prepared.resolve(intent); } }),
    });
    assert.equal(store.getSnapshot(), snapshot, 'Typed text leaves the café data unchanged');
    assert.equal(run.getState().briefing, beforeRun.briefing, 'Typed text leaves briefing acknowledgement unchanged');
    assert.equal(mode.getCctvMode(), beforeMode, 'Typed text leaves the local CCTV mode unchanged');
    if (detail && plan) assert.equal(await navigation.execute(plan.command, detail), 'opened');
    return { reply, detail, snapshot };
  };
  return { store, run, ask, calls, requests, harness };
}

const kind = ({ reply, detail }) => detail ? 'navigate' : ({ clarification: 'clarify', ambiguity: 'clarify',
  refusal: 'refuse', handoff: 'refuse', proposal: 'proposal' })[reply.turn?.kind] ?? 'answer';

function changedBusinessTables(before, after) {
  return Object.keys(before.tables).filter(key => !['appliedKeys', 'commandLedger'].includes(key)
    && !isDeepStrictEqual(before.tables[key], after.tables[key]));
}

async function confirm(env, result, plan) {
  const { reply, snapshot } = result;
  const card = reply.proposalSession;
  assert.ok(card?.isPending(), reply.answer);
  const proposal = card.getSnapshot().proposal;
  assert.equal(proposal.command, plan.command);
  assert.equal(proposal.tier, 'normal');
  const call = env.calls.find(call => call.name === 'propose_action' && call.args.command === plan.command);
  assert.ok(call, 'The fake CLOVA transport echoed the validated proposal');
  await env.ask('확인');
  assert.ok(card.isPending());
  assert.equal(env.store.getSnapshot(), snapshot);
  const receipt = card.confirm(env.store, proposal.id);
  assert.equal(receipt?.frame.outcome, 'applied', JSON.stringify(receipt));
  assert.equal(receipt.frame.messageKey, plan.receipt);
  assert.equal(receipt.notice?.messageKey, plan.receipt);
  const after = env.store.getSnapshot();
  card.confirm(env.store, proposal.id);
  assert.equal(env.store.getSnapshot(), after);
  if (plan.patch) {
    assert.equal(after.revision, snapshot.revision + 1);
    assert.deepEqual(changedBusinessTables(snapshot, after), ['storeEnvironment']);
    assert.deepEqual(after.tables.storeEnvironment, { ...snapshot.tables.storeEnvironment, ...plan.patch });
    assert.equal(receipt.undoToken, undefined);
  } else if (plan.hour) {
    const expected = snapshot.tables.cctvHourly.map(row => row.businessDate === day && row.hour === plan.hour ? { ...row, reviewMarked: true } : row);
    assert.equal(after.revision, snapshot.revision + 1);
    assert.deepEqual(changedBusinessTables(snapshot, after), ['cctvHourly']);
    assert.deepEqual(after.tables.cctvHourly, expected);
    assert.ok(receipt.undoToken);
    await env.ask('되돌려 줘');
    assert.equal(env.store.getSnapshot(), after);
    accepted(env.store.undo(receipt.undoToken));
    assert.deepEqual(changedBusinessTables(snapshot, env.store.getSnapshot()), []);
  } else {
    assert.equal(after, snapshot);
    if (plan.acknowledge) assert.equal(env.run.getState().briefing, 'dismissed');
    else assert.equal(mode.getCctvMode(), plan.mode);
  }
}

function cafeFacts(snapshot) {
  const get = (id, condition = normal) => {
    const view = data.selectWidget(snapshot, id, condition, 'normal');
    assert.equal(view.status, 'ready', id);
    return view.model;
  };
  const cameras = get('customer-analysis');
  const environment = get('store-environment');
  const briefing = get('briefing');
  const temperatures = environment.trend;
  const high = Math.max(...temperatures.map(row => row.temperatureC));
  const quiet = cameras.hours.filter(row => row.status === 'ok' && row.visits !== null)
    .reduce((best, row) => row.visits < best.visits ? row : best);
  return { cameras, environment, briefing, high, quiet };
}

function mustContain(reply, ...parts) {
  for (const part of parts) assert.ok(reply.answer.includes(part), `${JSON.stringify(part)} is missing from ${reply.answer}`);
}

function checkGrounding(id, expected, result, env) {
  const { reply, snapshot, detail } = result;
  const { cameras, environment, briefing, high, quiet } = cafeFacts(snapshot);
  const { music } = environment;
  const count = n => tr.format.count(n, 'count');
  const people = n => tr.format.count(n, 'person');
  const money = n => tr.format.money(n, 'compact');
  const reference = (featureId, key, value) => {
    assert.ok(env.requests.some(request => request.snapshot.some(entry => entry.featureId === featureId &&
      entry.facts?.some(fact => fact.key === key && fact.value === value))), `${featureId} evidence lost ${key}=${value}`);
    assert.ok(env.calls.some(call => call.name === 'get_widget' && call.args.featureId === featureId));
  };
  switch (id) {
    case 'S2-224': {
      const clear = cctvSample.CCTV_SNAPSHOT.tablesToClear.length;
      reference('customer-analysis', 'cctv.tables.toClear', clear);
      assert.doesNotMatch(reply.answer, /창가 부스/u);
      return;
    }
    case 'S2-227':
      for (const row of cameras.hours) reference('customer-analysis', `cctv.hour.${row.hour}.visits`, row.visits);
      for (const row of cameras.hours) mustContain(reply, count(row.visits));
      return;
    case 'S2-228': {
      const row = cameras.hours.find(row => row.hour === 12);
      reference('customer-analysis', 'cctv.hour.12.visits', row.visits);
      return mustContain(reply, count(row.visits));
    }
    case 'S2-229':
      reference('customer-analysis', 'cctv.quiet.hour', quiet.hour);
      return mustContain(reply, `${quiet.hour}시`, count(quiet.visits));
    case 'S2-230': case 'S2-231':
      assert.doesNotMatch(reply.answer, /86건|줄었어요/u);
      assert.match(reply.answer, /오늘|비교|자료/u);
      return;
    case 'S2-232': case 'S2-233': case 'S2-259':
      reference('customer-analysis', 'cctv.cameras.count', cameras.cameras.length);
      mustContain(reply, ...cameras.cameras.map(camera => data.resolveDataText(tr.t, camera.name)));
      assert.doesNotMatch(reply.answer, /재연결했|12시/u);
      return;
    case 'S2-234':
      reference('customer-analysis', 'cctv.gapHours', cameras.gapHours.length);
      for (const hour of cameras.gapHours) mustContain(reply, `${hour}시`);
      return;
    case 'S2-258':
      reference('customer-analysis', 'cctv.visits.total', cameras.totalVisits);
      return mustContain(reply, count(cameras.totalVisits));
    case 'S3-003':
      reference('store-environment', 'environment.temperature', environment.current.temperatureC);
      return mustContain(reply, `${environment.current.temperatureC}°C`, `${environment.current.humidityPct}%`, '적정 범위 안');
    case 'S3-005': {
      reference('store-environment', 'environment.temperature.max', high);
      assert.ok(environment.trend.some(row => row.temperatureC === high && reply.answer.includes(`${high}°C · ${row.measuredAt.slice(11)}`)), reply.answer);
      return;
    }
    case 'S3-009': return mustContain(reply, ...music.playlists.map(playlist => playlist.name));
    case 'S3-010': return mustContain(reply, music.playlists.find(playlist => playlist.id === music.playlistId).name);
    case 'S3-012':
      assert.equal(data.selectStoreEnvironment(snapshot, 'out_of_range').current.temperatureC, 28.5);
      assert.doesNotMatch(reply.answer, /28\.5/u);
      return mustContain(reply, `${environment.current.temperatureC}°C`);
    case 'S3-020': return mustContain(reply, `${music.volumePct}%`);
    case 'S3-022': return mustContain(reply, `이미 ${music.volumePct}%`);
    case 'S3-024': {
      const choices = reply.turn.choices.map(choice => choice.label);
      assert.ok(choices.includes(music.playlists.find(playlist => playlist.id === 'afternoon').name));
      assert.ok(choices.includes(music.playlists.find(playlist => playlist.id === 'closing').name));
      for (const choice of choices) assert.ok(music.playlists.some(playlist => playlist.name === choice));
      return;
    }
    case 'S3-025': return mustContain(reply, '이미', music.playlists.find(playlist => playlist.id === music.playlistId).name);
    case 'S4-010':
      return mustContain(reply, '취소', count(briefing.reservations.rows.filter(row => row.status === 'canceled').length));
    case 'S4-099':
      reference('briefing', 'briefing.importantAlerts.count', briefing.importantAlerts.count);
      return mustContain(reply, count(briefing.importantAlerts.count), '원천세', '체크리스트');
    case 'S4-100':
      reference('briefing', 'briefing.arrival.count', briefing.arrival.length);
      return;
    case 'S4-103':
      return mustContain(reply, count(briefing.reservations.count), people(briefing.reservations.partyTotal));
    case 'S4-104':
      return mustContain(reply, money(briefing.closingSummary.salesSnapshot.net), money(briefing.closingSummary.netProfit), '마감 전');
    case 'S4-105': {
      const tomorrow = briefing.tomorrowReservations.date;
      const event = briefing.schedules.entries.find(entry => entry.date === tomorrow && entry.source === 'direct');
      assert.ok(event);
      return mustContain(reply, count(briefing.tomorrowReservations.count), people(briefing.tomorrowReservations.partyTotal),
        data.resolveDataText(tr.t, event.title));
    }
    case 'S4-128':
      reference('briefing', 'briefing.tomorrow.reservations', briefing.tomorrowReservations.count);
      return mustContain(reply, count(briefing.tomorrowReservations.count), people(briefing.tomorrowReservations.partyTotal));
    case 'S4-107': {
      const yesterday = briefing.yesterday;
      assert.ok(env.requests.some(request => request.snapshot.some(entry =>
        entry.facts?.some(fact => fact.date === yesterday.date && fact.value === yesterday.netSales))));
      assert.ok(reply.answer.includes(money(yesterday.netSales)) || reply.answer.includes(tr.format.money(yesterday.netSales, 'full')), reply.answer);
      return;
    }
    case 'S4-122': {
      const tax = briefing.importantAlerts.groups.find(group => group.id === 'tax')?.items[0];
      assert.ok(tax);
      assert.equal(detail.itemId, tax.ref.itemId);
      return;
    }
    default:
      for (const part of expected.answer_must_contain ?? []) mustContain(reply, part);
  }
}

test('N19 café scenario contract uses the in-process fake transport and the local action boundary', async t => {
  assert.equal(data.NOW, '2026-11-17T15:45');
  assert.equal(scenarios.length, 62);
  assert.equal(required.length, 70);
  assert.deepEqual(required.filter(row => row.slice_id !== 'N19').map(row => row.scenario_id),
    ['S2-103', 'S2-256', 'S3-032', 'S3-033', 'S3-034', 'S4-093', 'S4-176', 'S4-178']);
  let passed = 0;
  const listed = [];
  for (const row of scenarios) {
    const id = row.scenario_id;
    const fixture = corpus.get(id);
    const expected = { ...fixture.expected, ...overlay[id]?.expected, ...overlay[id]?.policyGap?.expected };
    const gap = exceptions[id];
    if (gap) listed.push(id);
    await t.test(id, id === 'S2-255' ? { todo: gap } : {}, async sub => {
      const env = context(sub, id);
      const music = env.store.getSnapshot().tables.storeEnvironment;
      const activePlaylist = music.playlists.find(playlist => playlist.id === music.playlistId);
      const unchanged = overlay[id]?.n19CafeUnchanged;
      const text = id === 'S3-022' ? `볼륨 ${music.volumePct}로 해줘`
        : id === 'S3-025' ? `${activePlaylist.name}로 바꿔줘` : fixture.utterances[0];
      if (unchanged) assert.equal(text, unchanged.text);
      if (id === 'S3-022' || id === 'S3-025') {
        const original = await env.ask(fixture.utterances[0]);
        assert.equal(kind(original), expected.kind, original.reply.answer);
        if (id === 'S3-022') {
          const proposal = original.reply.proposalSession.getSnapshot().proposal;
          assert.equal(proposal.command, 'environment.setVolume');
          const call = env.calls.find(call => call.name === 'propose_action');
          assert.deepEqual(call.args.args.volumePct, { slot: 'volumePct' });
          assert.ok(proposal.preview.fields.some(field => field.before === '28%' && field.after === '55%'));
        } else {
          assert.equal(original.reply.turn.field, expected.ask[0]);
          mustContain(original.reply, ...expected.answer_must_contain);
        }
      }
      const result = await env.ask(text);
      const actual = kind(result);
      const requiredKind = ['S3-022', 'S3-025'].includes(id) ? 'answer' : plans[id] ? 'proposal' : expected.kind;
      assert.equal(actual, requiredKind, result.reply.answer);
      if (actual === 'proposal') await confirm(env, result, plans[id]);
      if (actual === 'clarify') assert.equal(result.reply.turn.field, expected.ask[0]);
      if (actual === 'navigate') {
        const expectedDetail = ['S4-121', 'S4-122', 'S4-123'].includes(id) ? expected.tools[0].args : details[id];
        for (const [key, value] of Object.entries(expectedDetail)) assert.equal(result.detail[key], value);
        assert.equal(env.run.getState().overlay.type, 'detail');
      }
      if (actual !== 'proposal' && id !== 'S3-022') assert.ok(env.calls.every(call => call.name !== 'propose_action'));
      for (const part of expected.answer_must_not_contain ?? []) assert.ok(!result.reply.answer.includes(part), result.reply.answer);
      if (id === 'S2-252') {
        assert.equal(mode.getCctvMode(), 'mock');
        assert.equal(result.reply.turn.reason, 'unavailable');
        assert.equal(result.reply.turn.alternative?.featureId, 'customer-analysis');
      }
      if (id === 'S4-123') assert.equal(env.run.getState().briefing, 'dismissed');
      checkGrounding(id, expected, result, env);
      for (const part of unchanged?.expected.answer_must_contain ?? []) mustContain(result.reply, part);
      if (errata[id]) sub.diagnostic(errata[id]);
      if (gap) sub.diagnostic(gap);
      else passed++;
    });
  }
  t.diagnostic(`${passed} of 62 pass, ${listed.length} listed exceptions with reasons; 70 required_slices references (62 assigned, 8 cross-slice)`);
  assert.deepEqual(listed, Object.keys(exceptions));
  assert.equal(passed + listed.length, scenarios.length);
});

test('N19 S2-255 explicit CCTV playback opens Customer Analysis', async t => {
  const env = context(t, 'S2-255');
  const result = await env.ask(corpus.get('S2-255').utterances[1]);
  assert.equal(kind(result), 'navigate', result.reply.answer);
  assert.equal(result.detail.featureId, 'customer-analysis');
});

test('the direct CCTV guard and fake endpoint refuse an existing historical row and a gap', async t => {
  const env = context(t, 'S2-243');
  const original = env.store.getSnapshot();
  const old = original.tables.cctvHourly.find(row => row.businessDate < day);
  assert.ok(old);
  assert.deepEqual(guard.selectCctvReviewTarget(original.tables, old.businessDate, old.hour), { reason: 'outside_hours' });
  assert.match(env.store.dispatch({ type: 'cctv.markPeakForReview', date: old.businessDate, hour: old.hour }).reason, /CCTV_TODAY_ONLY/u);
  assert.equal(env.store.getSnapshot(), original);

  const unobserved = original.tables.cctvHourly.map(row => row.businessDate === day && row.hour === 14
    ? { ...row, entries: null, status: 'none' } : row);
  const gapStore = data.createWidgetDataStore({ cctvHourly: unobserved });
  const initialGap = gapStore.getSnapshot();
  assert.deepEqual(guard.selectCctvReviewTarget(initialGap.tables, day, 14), { reason: 'unobserved' });
  assert.equal(gapStore.dispatch({ type: 'cctv.markPeakForReview', date: day, hour: 14 }).code, 'NOT_FOUND');
  assert.equal(gapStore.getSnapshot(), initialGap);

  const refs = { date: { slot: 'date' }, hour: { slot: 'hour' } };
  const request = { runId: original.runId, snapshotRevision: original.revision, layer: 'management', businessDate: day,
    intent: { kind: 'command', command: 'cctv.markPeakForReview', args: refs }, slots: ['date', 'hour'],
    catalog: [{ id: 'customer-analysis', name: 'CCTV', layer: 'management', conditions: [normal] }],
    snapshot: [], searches: [] };
  const check = async (date, hour, status) => env.harness.run({ ...request, readings: [{ tool: 'get_cctv_review', args: refs,
    facts: Object.entries({ 'cctv.review.date': date, 'cctv.review.hour': hour, 'cctv.review.status': status })
      .map(([key, value]) => ({ key, value, unit: '', label: key, display: String(value) })) }] });
  for (const packet of [await check(old.businessDate, old.hour, 'open'), await check(day, 14, 'unobserved')]) {
    assert.equal(packet.terminal.outcome, 'refused', packet.raw);
    assert.equal(packet.terminal.refusal.reason, 'invalid_target');
    assert.equal(packet.proposal, undefined);
    assert.deepEqual(packet.calls, []);
  }
});

test('the fake mode bridge prepares a card only when the browser projects live setup availability', async t => {
  const env = context(t, 'S2-252');
  const snapshot = env.store.getSnapshot();
  const command = 'ui.setCctvMode', args = { mode: 'live' };
  const request = { runId: snapshot.runId, snapshotRevision: snapshot.revision, layer: 'management', businessDate: day,
    intent: { kind: 'command', command, args }, slots: [], snapshot: [], searches: [],
    catalog: [{ id: 'customer-analysis', name: 'CCTV', layer: 'management', conditions: [normal] }] };
  const check = liveAvailable => env.harness.run({ ...request, readings: [{ tool: 'get_ui_state', args: { section: 'display' },
    facts: Object.entries({ 'cctv.mode': 'mock', 'cctv.mode.liveAvailable': liveAvailable })
      .map(([key, value]) => ({ key, value, unit: '', label: key, display: String(value) })) }] });
  const unavailable = await check(0);
  assert.equal(unavailable.terminal.refusal.reason, 'unavailable');
  assert.deepEqual(unavailable.calls, []);
  const available = await check(1);
  assert.equal(available.terminal.outcome, 'proposal');
  assert.deepEqual(available.calls, [{ name: 'propose_action', args: { command, args } }]);
  assert.equal(mode.getCctvMode(), 'mock');
  assert.equal(env.store.getSnapshot(), snapshot);
});
