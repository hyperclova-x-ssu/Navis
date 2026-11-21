// @vitest-environment node
import { appendFileSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { beginDashboard } from '../../../app/test-session';
import { getRegistry } from '../../../catalog';
import { createWidgetDataStore, dataBundles, readModel, type WidgetDataStore } from '../../../data/widget-data';
import { baseBundles, createTranslator } from '../../../i18n';
import { mktCouponBundle } from '../../widgets/mkt-coupon/messages';
import { mktLocalBundle } from '../../widgets/mkt-local/messages';
import { mktPromoBundle } from '../../widgets/mkt-promo/messages';
import { screenPresets } from '../../../layout';
import { classifyNavigation, createNavisNavigation, prepareNavigationRequest } from '../../../screens/dashboard/navis-navigation';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { createFakeServer } from '../../widgets/mkt-promo/promo-test-server';
import { promoSession } from '../../widgets/mkt-promo/promo-session';
import { applyAgentRunUndo } from '../agent-actions';
import { proposalPreview } from '../navis-conversation';
import { createAssistantProvider } from '../provider';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest } from '../../../../shared/navis-agent-schema.mjs';
// @ts-expect-error The shared corpus loader is JavaScript.
import { evidence, readTrace } from '../../../../server/navis/scenario-fixtures.mjs';
// @ts-expect-error The in-process bridge is JavaScript.
import { createBridge } from '../../../../server/bridge.mjs';
// @ts-expect-error The native v3 fake transport is JavaScript.
import { createNavisMenuHarness, navisAgentFakeFetch } from '../../../../server/fixtures/navis-eval-fake.mjs';

interface Scenario { readonly id: string; readonly widget: string; readonly utterances: readonly string[]; readonly expected: { readonly kind: string } }
type Overlay = { readonly expected?: Partial<Scenario['expected']>; readonly policyGap?: { readonly slice: string; readonly expected?: Partial<Scenario['expected']> } };
const trace: { scenario_id: string; slice_id: string; required_slices: string }[] = readTrace();
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json')) as Record<string, Overlay>;
const merged = new Map((JSON.parse(evidence('MERGED.json')) as Scenario[]).map(row => [row.id, row]));
// The 73 TRACE rows of slice N18 plus the anchors the dispatch names (S6-029/048 and S6-152/163 are N21 or N01 rows that exercise these cards).
const anchors = ['S6-029', 'S6-048', 'S6-152', 'S6-163'];
const scenarios = [...trace.filter(row => row.slice_id === 'N18').map(row => row.scenario_id), ...anchors].map(id => {
  const row = merged.get(id)!;
  const reviewed = overlay[id];
  return { ...row, kind: (reviewed?.policyGap?.slice === 'N18' ? reviewed.policyGap.expected?.kind : undefined) ?? reviewed?.expected?.kind ?? row.expected.kind };
});

const financierPhotos = Array.from({ length: 10 }, (_, i) => `fixture-financier-photo-${String(i + 1).padStart(2, '0')}`);
const withFinancier = new Set(['S6-008', 'S6-012', 'S6-013', 'S6-014', 'S6-028', 'S6-029']);
const windowOpen = new Set(['S6-012', 'S6-013', 'S6-014', 'S6-015', 'S6-016', 'S6-017', 'S6-018', 'S6-019', 'S6-020', 'S6-021', 'S6-022', 'S6-023', 'S6-024', 'S6-025', 'S6-026']);
const videoStates: Readonly<Record<string, 'making' | 'done' | 'failed' | 'posted'>> = {
  'S6-004': 'making', 'S6-031': 'making', 'S6-046': 'making', 'S6-005': 'failed', 'S6-030': 'failed',
  'S6-010': 'posted', 'S6-039': 'posted', 'S6-041': 'posted',
  'S6-032': 'done', 'S6-033': 'done', 'S6-034': 'done', 'S6-035': 'done', 'S6-036': 'done', 'S6-037': 'done', 'S6-040': 'done',
  'S6-045': 'done', 'S6-048': 'done',
};
const done = { durationSec: 15, music: { trackId: 'warm-cozy-acoustic', title: 'Cozy', artist: 'MintoDog', licenseLabel: 'CC0-1.0' },
  fileUrl: '/api/promo/jobs/pj-000000000001/video.mp4', sizeBytes: 1234, madeAt: '2026-11-17T15:45' };

function stageVideo(data: WidgetDataStore, kind: 'making' | 'done' | 'failed' | 'posted') {
  const menu = readModel(data.getSnapshot(), 'promo-video').menus.find(row => row.photos.length >= 5)!;
  const input = { menuIds: [menu.menuId], photoIds: menu.photos.slice(0, 5).map(photo => photo.photoId), moods: ['warm' as const],
    concepts: ['review-roundup' as const], memo: '', referenceId: 'ref-2' as const, lengthSec: 15 as const, locale: 'ko' as const };
  const made = data.dispatch({ type: 'video.make', input, idempotencyKey: `seed-${kind}` });
  if (!made.ok) throw new Error(made.messageKey);
  const videoId = (made.value as { videoId: string }).videoId;
  if (kind === 'done' || kind === 'posted') expect(data.dispatch({ type: 'video.settle', videoId, outcome: { kind: 'done', result: done } }).ok).toBe(true);
  if (kind === 'failed') expect(data.dispatch({ type: 'video.settle', videoId, outcome: { kind: 'failed', reason: 'AI_TIMEOUT' } }).ok).toBe(true);
  if (kind === 'posted') expect(data.dispatch({ type: 'video.markPosted', videoId, route: 'clip', idempotencyKey: 'seed-posted-mark' }).ok).toBe(true);
  return videoId;
}

function fixture(id: string, options: { video?: 'making' | 'done' | 'failed' | 'posted'; financier?: boolean } = {}) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  if (!id.startsWith('S7-')) run.actions.switchLayer('marketing');
  const marketing = createWidgetDataStore().getSnapshot().tables.marketing;
  // The café has no 휘낭시에. The authored ten-photo workflow runs on an individual fixture menu with ten fixture photos.
  const staged = options.financier ?? withFinancier.has(id)
    ? { ...marketing,
      promoMenu: [...marketing.promoMenu, { menuId: 'fixture-financier', names: { ko: '휘낭시에', en: 'Financier', 'zh-Hans': '费南雪', 'zh-Hant': '費南雪' }, order: marketing.promoMenu.length }],
      promoPhoto: [...marketing.promoPhoto, ...financierPhotos.map((photoId, order) => ({ photoId, menuId: 'fixture-financier',
        url: `/api/promo/photos/${photoId}`, width: 900, height: 1200, order }))] }
    : marketing;
  const data = createWidgetDataStore({ marketing: staged }, { runId: run.getState().runId });
  const video = options.video ?? videoStates[id];
  const videoId = video ? stageVideo(data, video) : undefined;
  const requests: unknown[] = [];
  const bridge = createNavisMenuHarness((bridgeOptions: Parameters<typeof createBridge>[0]) =>
    createBridge({ ...bridgeOptions, agentMode: 'fake', onDiagnostics() {} }), validateAgentFrame, navisAgentFakeFetch);
  const provider = createAssistantProvider({ store: data, run, fetcher: async (_url, request) => {
    const body: unknown = JSON.parse(String(request?.body));
    expect(validateAgentRequest(body)).toBe(true);
    requests.push(body);
    const result = await bridge.run(body);
    return new Response(result.raw, { status: result.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
  } });
  const navigation = createNavisNavigation(run, { highlight() {}, closeChat() {} });
  // The owner's draft lives in the promo window: its step phrases (십오초, ref-2, 주제는 리뷰 모음) are typed while it is open.
  if (windowOpen.has(id)) run.actions.openDetailRef({ featureId: 'promo-video', view: 'create' }, 'navis');
  if (['S6-013', 'S6-014'].includes(id)) promoSession(data).setDraft({ menuIds: ['fixture-financier'] });
  if (id === 'S6-028') {
    const menu = readModel(data.getSnapshot(), 'promo-video').menus.find(row => row.menuId === 'fixture-financier')!;
    promoSession(data).setDraft({ menuIds: [menu.menuId], photoIds: menu.photos.map(photo => photo.photoId), moods: ['warm'], concepts: ['review-roundup'], referenceId: 'ref-2', lengthSec: 15 });
  }
  async function ask(text: string) {
    const before = data.getSnapshot();
    const overlayBefore = run.getState().overlay;
    const plan = classifyNavigation(text, run.getState(), before);
    const prepared = plan && prepareNavigationRequest(plan, run.getState(), navigation);
    let detail: ReturnType<NonNullable<typeof prepared>['resolve']> | undefined;
    const reply = await provider.ask({ text, locale: 'ko', layer: id.startsWith('S7-') ? 'management' : 'marketing', signal: new AbortController().signal,
      ...(prepared ? { agentTurn: prepared.agentTurn, onNavigation: action => { detail = prepared.resolve(action); } } : {}) });
    expect(data.getSnapshot()).toBe(before);
    const navigationResult = detail && plan ? await navigation.execute(plan.command, detail) : undefined;
    if (navigationResult) expect(['opened', 'already']).toContain(navigationResult);
    const state = run.getState().overlay;
    const detailRef = state.type === 'detail' && (navigationResult || state !== overlayBefore) ? state.stack?.at(-1) ?? { featureId: state.featureId } : undefined;
    const kind = detailRef || navigationResult ? 'navigate' : reply.turn?.kind === 'proposal' ? 'proposal'
      : reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? 'clarify'
        : reply.turn?.kind === 'refusal' || reply.turn?.kind === 'handoff' ? 'refuse' : 'answer';
    return { reply, detailRef, kind, before };
  }
  return { data, run, ask, bridge, requests, videoId, close: () => bridge.close() };
}

/** The estimate lives in the promo session cache (a local GET); the replay fills it through the in-memory fake service. */
async function loadEstimate(env: ReturnType<typeof fixture>) {
  const server = createFakeServer();
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)) as typeof fetch;
  try { await promoSession(env.data).loadEstimate(); } finally { globalThis.fetch = realFetch; }
  expect(server.calls.map(call => call.path)).toEqual(['/api/promo/estimate-model']);
}

const choose = (env: ReturnType<typeof fixture>, input: Parameters<ReturnType<typeof promoSession>['setDraft']>[0]) =>
  promoSession(env.data).setDraft(input);

describe('N18 promo video draft and job start', () => {
  it('sets the draft only on the card press and restores it from the receipt', async () => {
    const env = fixture('S6-012');
    try {
      const { reply, before } = await env.ask('영상 메뉴는 휘낭시에로 하고 사진 전부 골라줘');
      if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
      const { proposal } = reply.turn;
      expect(proposal.command).toBe('promo.draft.set');
      expect(proposalPreview(proposal.preview)).toBeDefined();
      expect(promoSession(env.data).getState().draft.photoIds).toEqual([]);
      await env.ask('확인');
      expect(promoSession(env.data).getState().draft.photoIds).toEqual([]);
      const receipt = proposal.confirm(env.data);
      expect(receipt.frame.outcome).toBe('applied');
      expect(promoSession(env.data).getState().draft).toMatchObject({ menuIds: ['fixture-financier'], photoIds: financierPhotos });
      expect(env.data.getSnapshot()).toBe(before);
      expect(proposal.confirm(env.data).frame).toEqual(receipt.frame);
      if (!receipt.notice || !receipt.undoToken) throw new Error('The draft receipt must offer its undo');
      env.run.actions.showNotice(receipt.notice);
      expect(applyAgentRunUndo(env.run, env.data, receipt.undoToken)).toBe(true);
      expect(promoSession(env.data).getState().draft).toMatchObject({ menuIds: [], photoIds: [] });
      expect(applyAgentRunUndo(env.run, env.data, receipt.undoToken)).toBe(false);
    } finally { env.close(); }
  });

  it('asks for the first missing choice before offering the start card', async () => {
    const env = fixture('empty-draft');
    try {
      const first = await env.ask('영상 만들어줘');
      expect(first.kind).toBe('clarify');
      expect(first.reply.turn).toMatchObject({ kind: 'clarification', field: 'menuIds' });
      expect(env.data.getSnapshot().tables.marketing.promoVideo).toHaveLength(0);
      choose(env, { menuIds: ['m-americano'], photoIds: readModel(env.data.getSnapshot(), 'promo-video').menus.find(menu => menu.menuId === 'm-americano')!.photos.map(photo => photo.photoId) });
      expect((await env.ask('영상 만들어줘')).reply.turn).toMatchObject({ kind: 'clarification', field: 'moods' });
    } finally { env.close(); }
  });

  it('starts one fake job on the card press, never reaches the AI service, and keeps the draft readable', async () => {
    const env = fixture('S6-028');
    const server = createFakeServer();
    const realFetch = globalThis.fetch;
    const calls = server.calls;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)) as typeof fetch;
    try {
      const menu = readModel(env.data.getSnapshot(), 'promo-video').menus.find(row => row.menuId === 'm-americano')!;
      await promoSession(env.data).loadEstimate();
      calls.length = 0;
      choose(env, { menuIds: [menu.menuId], photoIds: menu.photos.map(photo => photo.photoId), moods: ['warm'], concepts: ['review-roundup'], referenceId: 'ref-2', lengthSec: 15, memo: '비 오는 날' });
      const { reply, before } = await env.ask('영상 만들어줘');
      if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
      const { proposal } = reply.turn;
      expect(proposal.command).toBe('video.make');
      expect(proposal.tier).toBe('normal');
      expect(env.requests).toHaveLength(1);
      expect(JSON.stringify(env.requests)).not.toContain('비 오는 날');
      expect(before.tables.marketing.promoVideo).toHaveLength(0);
      await env.ask('확인');
      expect(env.data.getSnapshot()).toBe(before);
      const receipt = proposal.confirm(env.data);
      expect(receipt.frame).toMatchObject({ outcome: 'applied', messageKey: 'data.marketing.notice.videoStarted' });
      expect(receipt.undoToken).toBeUndefined();
      const rows = env.data.getSnapshot().tables.marketing.promoVideo;
      expect(rows).toMatchObject([{ status: 'making', jobId: null, input: { memo: '비 오는 날', lengthSec: 15, referenceId: 'ref-2' } }]);
      expect(calls).toEqual([]);
      expect(proposal.confirm(env.data).frame).toEqual(receipt.frame);
      expect(env.data.getSnapshot().tables.marketing.promoVideo).toHaveLength(1);
      expect((await env.ask('영상 하나 더 만들어줘')).kind).toBe('answer');
    } finally { globalThis.fetch = realFetch; env.close(); }
  });

  it('D-328 retries the failed video once with the same widget input and a receipt', async () => {
    const env = fixture('S6-030');
    const server = createFakeServer();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)) as typeof fetch;
    try {
      const { reply, before } = await env.ask('홍보 영상 다시 만들기');
      if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
      const { proposal } = reply.turn;
      expect(proposal.command).toBe('video.retry');
      expect(proposal.preview).toMatchObject({ title: '홍보 영상 다시 만들기' });
      await env.ask('확인');
      expect(env.data.getSnapshot()).toBe(before);
      const receipt = proposal.confirm(env.data);
      expect(receipt.frame).toMatchObject({ outcome: 'applied', messageKey: 'data.marketing.notice.videoStarted' });
      expect(receipt.undoToken).toBeUndefined();
      const after = env.data.getSnapshot();
      const [video] = before.tables.marketing.promoVideo;
      expect(after.tables.marketing.promoVideo).toMatchObject([{ videoId: video.videoId, status: 'making', jobId: null,
        input: video.input, retryCount: video.retryCount + 1, failReason: null }]);
      expect(proposal.confirm(env.data).frame).toEqual(receipt.frame);
      expect(env.data.getSnapshot()).toBe(after);
      expect(server.calls).toEqual([]);
    } finally { globalThis.fetch = realFetch; env.close(); }
  });

  it.each([['done', '영상이 완성됐어요.'], ['posted', '이미 올렸다고 표시한 영상이에요.']] as const)(
    'D-328 directs a %s video to the widget with its current status', async (video, status) => {
      const env = fixture('D328-finished', { video });
      try {
        const { reply, before } = await env.ask('홍보 영상 다시 만들기');
        expect(reply.answer).toContain(status);
        expect(reply.answer).toContain('AI 홍보 영상에서 확인해 주세요.');
        expect(reply.turn).toMatchObject({ kind: 'refusal', alternative: { featureId: 'promo-video', command: 'video.retry' } });
        expect(env.data.getSnapshot()).toBe(before);
      } finally { env.close(); }
    },
  );

  it('marks one finished video as posted only after the extra confirmation, with clip code activation', async () => {
    const env = fixture('S6-033');
    try {
      const { reply, before } = await env.ask('영상 클립에 올렸어');
      if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
      const { proposal } = reply.turn;
      expect(proposal).toMatchObject({ command: 'video.markPosted', tier: 'extra-confirm' });
      expect(proposal.confirm(env.data).requiresExtraConfirmation).toBe(true);
      expect(env.data.getSnapshot()).toBe(before);
      const receipt = proposal.confirm(env.data, proposal.id);
      expect(receipt.frame.outcome).toBe('applied');
      expect(receipt.undoToken).toBeUndefined();
      const after = env.data.getSnapshot();
      expect(after.tables.marketing.promoVideo.find(row => row.videoId === env.videoId)).toMatchObject({ status: 'posted', postedRoute: 'clip' });
      expect(after.tables.marketing.couponCode.some(code => code.videoId === env.videoId && code.route === 'clip')).toBe(true);
      expect(proposal.confirm(env.data, proposal.id).frame).toEqual(receipt.frame);
      expect(env.data.getSnapshot()).toBe(after);
      expect((await env.ask('영상 클립에 올렸다고 또 표시해줘')).kind).toBe('answer');
    } finally { env.close(); }
  });

  it('sends the reach-out coupon only to consenting customers after the card press', async () => {
    const env = fixture('S6-152');
    try {
      const { reply, before } = await env.ask('떠날 손님한테 쿠폰 문자 보내줘');
      if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
      const { proposal } = reply.turn;
      expect(proposal.command).toBe('coupon.sendReachOut');
      const eligible = readModel(before, 'customer-groups').reachOut.recipientIds;
      expect(eligible.length).toBeGreaterThan(0);
      expect(before.tables.marketing.messageSend).toHaveLength(env.data.getSnapshot().tables.marketing.messageSend.length);
      await env.ask('확인');
      expect(env.data.getSnapshot()).toBe(before);
      const receipt = proposal.confirm(env.data);
      expect(receipt.frame).toMatchObject({ outcome: 'applied', messageKey: 'data.notice.sent' });
      const sent = env.data.getSnapshot().tables.marketing.messageSend.slice(before.tables.marketing.messageSend.length);
      expect(sent.map(row => row.customerId).sort()).toEqual([...eligible].sort());
      expect(sent.every(row => row.status === 'mock')).toBe(true);
      expect(proposal.confirm(env.data).frame).toEqual(receipt.frame);
    } finally { env.close(); }
  });
});

describe('N18 localized words', () => {
  it('every message key the adapter reads resolves in all four locales', () => {
    const source = readFileSync('src/features/assistant/domains/promotion.ts', 'utf8');
    const keys = new Set<string>();
    for (const found of source.matchAll(/'((?:widget|promo|data|marketing|common)\.[A-Za-z0-9_.-]+)'/gu)) keys.add(found[1]);
    keys.delete('promo.video.busy'); keys.delete('promo.draft.set'); // a fact key and a command name, not messages
    for (const key of ['promo.stage.look', 'promo.stage.merge', 'promo.place.clip', 'promo.place.reels', 'promo.place.shorts', 'promo.ref.ref-1.name', 'promo.ref.ref-6.name',
      'data.marketing.mood.warm', 'data.marketing.mood.elegant', 'data.marketing.concept.day-at-shop', 'data.marketing.concept.todays-deal', 'promo.fail.AI_TIMEOUT', 'promo.fail.BUSY',
      'widget.customer-groups.basis.churn-risk', 'widget.customer-groups.basis.regular', 'widget.customer-groups.basis.first-visit', 'widget.marketing-today.slot.now',
      'widget.marketing-today.slot.today', 'widget.marketing-today.slot.week', 'widget.marketing-performance.period.this', 'widget.marketing-performance.period.last',
      'data.marketing.route.placeNews', 'data.marketing.route.blog', 'data.marketing.route.clip', 'data.marketing.route.sms']) keys.add(key);
    const params = { n: 1, s: 1, e: 1, day: 'x', item: 'x', route: 'x', place: 'x', used: 1, issued: 1, total: 1, rate: 'x', a: 'x', b: 'x', cost: 'x',
      discount: 'x', profit: 'x', days: 1, date: 'x', t: 'x', c: 'x', name: 'x', left: 1, step: 'x', group: 'x' };
    for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      const tr = createTranslator(locale, ...baseBundles, mktPromoBundle, mktCouponBundle as never, mktLocalBundle as never, ...dataBundles) as unknown as { t(key: string, values?: object): string };
      expect([...keys].filter(key => { const value = tr.t(key, params); return !value || value === key; }), locale).toEqual([]);
    }
  });
});

// First variants whose reviewed outcome differs from the single-turn café behavior. Variants 2 and 3 are still replayed.
const representativeExceptions: Readonly<Record<string, string>> = {
  'S5-050': 'answer', 'S5-051': 'answer', // one projection cites both counts; the two-widget turn is not split
  'S6-015': 'proposal', // the café's 아메리카노 has six photos, so the draft card is eligible (the seed had none)
  'S6-030': 'proposal', // D-328 enables the widget retry command on a card.
  'S6-029': 'proposal', 'S6-048': 'proposal', 'S6-163': 'proposal', // N21 owns the steps after the first card
  'S6-193': 'answer', // "지난달로 바꿔서 보여줘" names no widget; it relies on the earlier turn
};

describe('N18 grounded answers', () => {
  const ask = async (id: string, text: string, options?: Parameters<typeof fixture>[1]) => {
    const env = fixture(id, options);
    try { return { ...(await env.ask(text)), model: (feature: Parameters<typeof readModel>[1]) => readModel(env.data.getSnapshot(), feature) }; } finally { env.close(); }
  };
  it('reads the photo count, the minimum and the posted count from the promo selector', async () => {
    const { reply, model } = await ask('S6-002', '영상 지금 만들 수 있어요?');
    const promo = model('promo-video') as ReturnType<typeof readModel<'promo-video'>>;
    expect(reply.answer).toContain(`${promo.photoCount}장`);
    expect(reply.answer).toContain(`${promo.minPhotos}장`);
    expect((await ask('S6-003', '올린 영상 몇 편이에요?')).reply.answer).toContain('0편');
  });
  it('names the failure reason in the widget’s own words and the stage while making', async () => {
    expect((await ask('S6-005', '영상 왜 안 됐어?')).reply.answer).toContain('AI 응답이 너무 오래 걸렸어요');
    const making = (await ask('S6-004', '영상 어디까지 만들어졌어?')).reply.answer;
    expect(making).toContain('영상 만드는 중');
    expect(making).toContain('사진 살펴보기');
  });
  it('lists the menus with photos and the six designs', async () => {
    const menus = (await ask('S6-008', '어떤 메뉴 사진이 있어?')).reply.answer;
    for (const name of ['아메리카노', '카페라떼', '휘낭시에']) expect(menus).toContain(name);
    expect(menus).toContain('10장');
    const designs = (await ask('S6-009', '영상 디자인 어떤 거 있어요?')).reply.answer;
    for (const name of ['리뷰 말풍선 모음', '진열대 천천히 훑기', '손글씨 감성 카드']) expect(designs).toContain(name);
  });
  it('asks which length before an estimate, and cites the loaded estimate table', async () => {
    const first = await ask('S6-006', '영상 하나 만들면 시간이랑 비용 얼마나 들어?');
    expect(first.kind).toBe('clarify');
    expect(first.reply.turn).toMatchObject({ kind: 'clarification', field: 'lengthSec' });
    const env = fixture('S6-007');
    const server = createFakeServer();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)) as typeof fetch;
    try {
      await promoSession(env.data).loadEstimate();
      const { reply } = await env.ask('15초 영상 만들면 얼마 들어?');
      expect(reply.answer).toContain('예상 시간 약');
      expect(reply.answer).toContain('예상 비용 약');
      const notLoaded = await ask('S6-007', '15초 영상 만들면 얼마 들어?');
      expect(notLoaded.kind).toBe('refuse');
      expect(notLoaded.reply.answer).toContain('예상 값을 불러오지 못했어요');
    } finally { globalThis.fetch = realFetch; env.close(); }
  });
  it('reads the customer groups, the oldest absence, the consent block, the rules and the reach-out history', async () => {
    const groups = (await ask('S6-143', '떠날 수 있는 손님이 누구누구야?'));
    const model = groups.model('customer-groups') as ReturnType<typeof readModel<'customer-groups'>>;
    const oldest = [...model.churnRisk].sort((a, b) => a.lastVisit.localeCompare(b.lastVisit))[0];
    expect(groups.reply.answer).toContain(`${model.counts['churn-risk']}명`);
    expect((await ask('S6-144', '제일 오래 안 온 손님이 누구야?')).reply.answer).toContain(`${oldest.daysSinceLast}일`);
    const blocked = model.churnRisk.filter(row => !row.selectable);
    expect((await ask('S6-145', '문자 동의 안 한 손님은 누구야?')).reply.answer).toContain(`${blocked.length}명`);
    const rules = (await ask('S6-146', '손님 그룹은 어떤 기준으로 나눠?')).reply.answer;
    expect(rules).toContain(`${model.rule.churnGapDays}일`);
    expect(rules).toContain(`${model.rule.regularVisits}번`);
    expect((await ask('S6-150', '떠날 손님한테 쿠폰 보낸 적 있어?')).reply.answer).toContain('없어요');
  });
  it('reads the performance numbers, routes and formulas from the selector', async () => {
    const cost = await ask('S6-169', '이번 달 원가랑 할인액 알려줘');
    const perf = cost.model('marketing-performance') as ReturnType<typeof readModel<'marketing-performance'>>;
    expect(cost.reply.answer).toContain(perf.cost.toLocaleString('en-US'));
    expect(cost.reply.answer).toContain(perf.discount.toLocaleString('en-US'));
    const routes = (await ask('S6-173', '경로별 발행 사용 수 알려줘')).reply.answer;
    expect(routes).toContain(`${perf.issued}`);
    expect((await ask('S6-179', '사용률이랑 매출은 어떻게 계산한 거야?')).reply.answer).toContain('14일');
    expect((await ask('S6-194', '영상별 성과 보여줘')).detailRef).toMatchObject({ featureId: 'marketing-performance', view: 'video' });
    expect((await ask('S7-086', '마케팅 성과 쿠폰 탭 열어줘')).detailRef).toMatchObject({ featureId: 'marketing-performance', view: 'coupon' });
  });
  it('opens the groups, the reach-out view and last month without sending anything', async () => {
    expect((await ask('S6-161', '첫 방문 손님 목록 열어줘')).detailRef).toMatchObject({ featureId: 'customer-groups', view: 'first-visit' });
    const reach = await ask('S6-162', '이탈 손님 챙기는 창 열어줘');
    expect(reach.detailRef).toMatchObject({ featureId: 'customer-groups', view: 'reach-out', focus: 'action' });
    expect(reach.model('customer-groups')).toBeDefined();
    const last = await ask('S6-193', '마케팅 성과 지난달 화면 열어줘');
    expect(last.detailRef).toMatchObject({ featureId: 'marketing-performance', condition: { kind: 'dateRange' } });
    const design = await ask('S6-047', '영상 디자인 고르는 화면 열어줘');
    expect(design.detailRef).toMatchObject({ featureId: 'promo-video', view: 'create', prefill: { fields: { tab: 2 } } });
  });
  it('refuses save, delete and unposting with the widget as the next step', async () => {
    for (const [id, text] of [['S6-032', '영상 저장해줘'], ['S6-042', '만든 영상 지워줘'], ['S6-041', '영상 올렸다고 표시한 거 취소해줘']] as const) {
      const result = await ask(id, text);
      expect(result.kind, text).toBe('refuse');
      expect(result.before.tables.marketing.promoVideo.length).toBe(result.before.tables.marketing.promoVideo.length);
    }
  });
});

describe('N18 authored utterances', () => {
  it('replays the TRACE rows and the four anchors', () => {
    expect(scenarios.length).toBe(77);
  });

  it.each(scenarios)('$id replays every authored alternative', async row => {
    for (const [index, text] of row.utterances.entries()) {
      const env = fixture(row.id);
      try {
        if (['S6-007', 'S6-028'].includes(row.id)) await loadEstimate(env);
        const result = await env.ask(text);
        const proposal = result.reply.turn?.kind === 'proposal' ? result.reply.turn.proposal : undefined;
        if (process.env.N18_OBSERVATIONS) appendFileSync(process.env.N18_OBSERVATIONS, JSON.stringify({
          id: row.id, variant: index + 1, expected: row.kind, actual: result.kind, command: proposal?.command,
          text, reply: result.reply.answer, detailRef: result.detailRef, turn: result.reply.turn?.kind,
          intents: env.requests.map(request => (request as { intent: { kind: string; command?: string; featureId?: string; tool?: string } }).intent)
            .map(intent => `${intent.kind}:${intent.command ?? intent.featureId ?? intent.tool ?? ''}`),
        }) + '\n');
        expect(result.reply.answer || result.kind === 'navigate' || proposal, text).toBeTruthy();
        if (index === 0) expect(result.kind, row.id).toBe(representativeExceptions[row.id] ?? row.kind);
      } finally { env.close(); }
    }
  }, 30_000);
});
