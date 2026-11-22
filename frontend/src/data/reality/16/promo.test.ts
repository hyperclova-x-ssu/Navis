import { describe, expect, it, vi } from 'vitest';
import { beginDashboard } from '../../../app/test-session';
import { getRegistry } from '../../../catalog';
import { createAgentActions } from '../../../features/assistant/agent-actions';
import { promoSession } from '../../../features/widgets/mkt-promo/promo-session';
import { createFakeServer } from '../../../features/widgets/mkt-promo/promo-test-server';
import { screenPresets } from '../../../layout';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { createWidgetDataStore } from '../../db/store';
import type { PromoVideoInput } from '../../marketing/types';
import { readModel } from '../../widget-data';
import { createRealPort } from '../00';
import { fakeBackend, reply } from '../00/testing';
import { promoAdapter } from './adapter';
import { executePromo } from './commands';

const base = '/marketing/promo';
const asOf = '2026-11-21T06:45:00.000Z';
const menuId = 'owner-menu';
const input: PromoVideoInput = {
  menuIds: [menuId], photoIds: ['photo-1', 'photo-2', 'photo-3', 'photo-4', 'photo-5'],
  moods: ['warm'], concepts: ['new-item'], memo: '점주 메모', referenceId: 'ref-1', lengthSec: 15, locale: 'ko',
};
const page = <T>(items: readonly T[]) => ({ items, nextCursor: null, asOf, sourceRevision: 'c'.repeat(64) });

function setup(retry = false) {
  const backend = fakeBackend();
  const assets = input.photoIds.map(photoId => ({ photoId, menuId, url: `/owner/${photoId}.jpg`, fileId: null, width: 720, height: 960 }));
  const drafts: { draftId: string; input: Partial<PromoVideoInput>; revision: number; jobId: string | null; updatedAt: string }[] = retry
    ? [{ draftId: 'failed-draft', input, revision: 2, jobId: 'failed-job', updatedAt: asOf }] : [];
  const publications: object[] = [];
  const receipt = (resourceId: string, revision = 1) => ({ resourceId, revision, receiptId: `${resourceId}-${revision}`, affectedSources: ['promo', 'marketing-today', 'marketing-performance'] });
  backend.on('GET', `${base}/assets`, () => ({ ...page(assets), eligiblePhotoCount: assets.length,
    store: { name: '내 카페', location: '동작구', exteriorPhotoId: 'facade', exteriorUrl: '/owner/facade.jpg' },
    menus: [{ menuId, names: { ko: '내 라테', en: 'Latte', 'zh-Hans': '拿铁', 'zh-Hant': '拿鐵' }, photoIds: input.photoIds }],
  }));
  backend.on('GET', `${base}/drafts`, () => page(drafts));
  backend.on('GET', `${base}/publications`, () => page(publications));
  backend.on('POST', `${base}/assets`, ({ body }) => {
    expect(body).toEqual({ fileId: 'photo-file', menuId, rightsConfirmed: true });
    assets.push({ photoId: 'uploaded', menuId, url: '/owner/upload.jpg', fileId: null, width: 720, height: 960 });
    return receipt('uploaded');
  });
  backend.on('POST', `${base}/drafts`, ({ body }) => {
    drafts.push({ draftId: 'draft', input: body as Partial<PromoVideoInput>, revision: 1, jobId: null, updatedAt: asOf });
    return receipt('draft');
  });
  backend.on('PATCH', `${base}/drafts/draft`, ({ body }) => {
    const { expectedRevision, patch } = body as { expectedRevision: number; patch: Partial<PromoVideoInput> };
    expect(expectedRevision).toBe(1);
    Object.assign(drafts[0], { input: { ...drafts[0].input, ...patch }, revision: 2 });
    return receipt('draft', 2);
  });
  backend.on('POST', `${base}/drafts/draft/generate`, ({ body, headers }) => {
    expect(body).toEqual({ expectedRevision: 2, confirmed: true });
    expect(headers.get('Idempotency-Key')).toBe('confirm-generation');
    drafts[0].jobId = 'job';
    return receipt('job');
  });
  backend.on('GET', '/promo/jobs/job', () => ({ jobId: 'job', status: 'done', stage: 'merge', stageState: 'done', startedAt: asOf,
    result: { durationSec: 15, sizeBytes: 200, music: null } }));
  backend.on('POST', `${base}/jobs/job/place-news`, () => reply(409, { code: 'CONFLICT', reason: 'MANUAL_UPLOAD_REQUIRED' }));
  backend.on('POST', `${base}/jobs/job/attest`, ({ body }) => {
    expect(body).toEqual({ confirmed: true, extraConfirmed: true, route: 'place-news', link: 'https://m.place.naver.com/restaurant/123/feed' });
    publications.push({ publicationId: 'post', jobId: 'job', channel: 'place-news', method: 'attestation', state: 'published', revision: 1,
      providerRef: null, link: 'https://m.place.naver.com/restaurant/123/feed', createdAt: asOf, videoUrl: null });
    return receipt('post');
  });
  const open = (runId?: string) => {
    const store = createWidgetDataStore(undefined, { runId });
    const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [promoAdapter], reconcileDelaysMs: [] });
    store.bindReal(port);
    return { store, port };
  };
  return { backend, open, drafts, receipt };
}

describe('promo HTTP cutover', () => {
  it.each([
    ['PROMO_SELECTION_UNAVAILABLE', 'promo.error.selectionUnavailable'],
    ['PROMO_NOT_READY', 'promo.error.notReady'],
  ])('maps the %s rejection to the promo guidance', async (code, messageKey) => {
    const { backend, open } = setup();
    const { store, port } = open();
    await port.load('promo');
    expect(await executePromo(store, { type: 'promo.saveDraft', patch: input })).toMatchObject({ ok: true });
    backend.on('POST', `${base}/drafts/draft/generate`, () => reply(409, { code }));
    expect(await store.execute({ type: 'video.make', input, idempotencyKey: 'confirm-generation' }))
      .toMatchObject({ ok: false, reason: code, messageKey });
  });

  it('projects authoritative assets, draft revision, job and publication after a fresh session', async () => {
    const { backend, open } = setup();
    const { store, port } = open();
    await port.load('promo');
    expect(store.getSnapshot().tables.marketing.promoPhoto).toHaveLength(5);
    expect(readModel(store.getSnapshot(), 'marketing-today')?.cells.find(row => row.kind === 'video')?.params.photos).toBe(5);
    expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);

    expect(await executePromo(store, { type: 'promo.addPhoto', fileId: 'photo-file', menuId, rightsConfirmed: true })).toMatchObject({ ok: true });
    expect(store.getSnapshot().tables.marketing.promoPhoto).toHaveLength(6);
    expect(readModel(store.getSnapshot(), 'marketing-today')?.cells.find(row => row.kind === 'video')?.params.photos).toBe(6);
    expect(await executePromo(store, { type: 'promo.saveDraft', patch: input })).toMatchObject({ ok: true });
    expect(await executePromo(store, { type: 'promo.saveDraft', draftId: 'draft', expectedRevision: 1, patch: { memo: '새 메모' } })).toMatchObject({ ok: true });
    expect(await store.execute({ type: 'video.make', input: { ...input, memo: '새 메모' }, idempotencyKey: 'confirm-generation' })).toMatchObject({ ok: true });
    expect(store.getSnapshot().tables.marketing.promoVideo[0]).toMatchObject({ jobId: 'job', status: 'done' });

    expect(await executePromo(store, { type: 'promo.publishPlaceNews', jobId: 'job', text: '가게 소식' })).toMatchObject({ ok: false, reason: 'MANUAL_UPLOAD_REQUIRED' });
    expect(backend.callsTo('POST', `${base}/jobs/job/clip`)).toHaveLength(0);
    expect(await executePromo(store, { type: 'promo.attestLink', jobId: 'job', route: 'place-news', link: 'https://m.place.naver.com/restaurant/123/feed' })).toMatchObject({ ok: true });

    const fresh = open();
    await fresh.port.load('promo');
    expect(fresh.store.getSnapshot().tables.realPromo?.drafts[0]).toMatchObject({ revision: 2, input: { memo: '새 메모' }, jobId: 'job' });
    expect(fresh.store.getSnapshot().tables.realPromo?.publications[0]).toMatchObject({ channel: 'place-news', state: 'published', link: expect.stringContaining('naver.com') });
    expect(fresh.store.getSnapshot().tables.marketing.promoVideo[0]?.status).toBe('posted');
    expect(readModel(fresh.store.getSnapshot(), 'marketing-performance')?.byVideo).toEqual(expect.arrayContaining([
      expect.objectContaining({ publication: { channel: 'place-news', link: 'https://m.place.naver.com/restaurant/123/feed' } }),
    ]));
    expect(readModel(fresh.store.getSnapshot(), 'marketing-today')?.cells.find(row => row.kind === 'video')).toBeUndefined();
    fresh.port.reset();
    expect(fresh.store.getSnapshot().tables.realPromo).toBeUndefined();
    expect(fresh.store.getSnapshot().tables.marketing.promoPhoto).toHaveLength(0);
    expect(fresh.store.getSnapshot().tables.marketing.promoVideo).toHaveLength(0);
  });

  it('rejects linkless legacy posting and unprepared generation before sending a write', async () => {
    const { backend, open } = setup();
    const { store, port } = open();
    await port.load('promo');
    expect(await store.execute({ type: 'video.markPosted', videoId: 'job', route: 'clip', idempotencyKey: 'no-url' })).toMatchObject({ ok: false, reason: 'POST_LINK_REQUIRED' });
    expect(await store.execute({ type: 'video.make', input, idempotencyKey: 'unsaved' })).toMatchObject({ ok: false, reason: 'DRAFT_REQUIRED' });
    expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('keeps another owner’s marketing fields during promo load and clear', async () => {
    const { backend, open } = setup();
    const { store, port } = open();
    const marketing = store.getSnapshot().tables.marketing;
    backend.on('GET', `${base}/publications`, () => {
      store.hydrate({ marketing: { ...store.getSnapshot().tables.marketing, mktVisit: [] } });
      return page([]);
    });
    expect(marketing.mktVisit.length).toBeGreaterThan(0);
    await port.load('promo');
    expect(store.getSnapshot().tables.marketing.mktVisit).toHaveLength(0);
    expect(store.getSnapshot().tables.marketing.coupon).toEqual(marketing.coupon);
    port.reset();
    expect(store.getSnapshot().tables.marketing.mktVisit).toHaveLength(0);
    expect(store.getSnapshot().tables.marketing.coupon).toEqual(marketing.coupon);
  });

  it.each([['video.make', false], ['video.retry', false], ['video.make', true]] as const)(
    'requires a card press and awaits draft save, read-back and generation for %s (lost receipt %s)', async (command, loseReceipt) => {
    const retry = command === 'video.retry';
    const { backend, open, drafts, receipt } = setup(retry);
    backend.on('GET', '/promo/jobs/failed-job', () => ({ jobId: 'failed-job', startedAt: asOf, status: 'failed', stage: 'look', stageState: 'failed', failReason: 'AI_TIMEOUT' }));
    let effects = 0;
    backend.on('POST', `${base}/drafts/draft/generate`, ({ body }) => {
      expect(body).toEqual({ expectedRevision: 1, confirmed: true });
      const draft = drafts.find(row => row.draftId === 'draft')!;
      expect(draft.input).toEqual(input);
      if (!draft.jobId) {
        Object.assign(draft, { jobId: 'job', revision: 2 });
        effects += 1;
        if (loseReceipt) return reply(503, { code: 'SERVICE_UNAVAILABLE' });
      }
      return receipt('job');
    });
    const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
      theme: 'light', clock: () => 0, reducedMotion: true });
    beginDashboard(run, 'cafe');
    run.actions.dismissCoach();
    run.actions.switchLayer('marketing');
    const runId = run.getState().runId;
    const { store, port } = open(runId);
    await port.load('promo');
    const session = promoSession(store);
    vi.stubGlobal('fetch', createFakeServer().fetch);
    try {
      if (!retry) {
        session.setDraft(input);
        await session.loadEstimate();
      }
      const snapshot = store.getSnapshot();
      const actions = createAgentActions(store, undefined, run);
      const prepared = actions.prepare({ command, args: retry ? { videoId: { handle: 'selected' } } : {
        menuIds: { slot: 'menuIds' }, photoIds: { slot: 'photoIds' }, moods: { slot: 'moods' }, concepts: { slot: 'concepts' }, memo: { slot: 'memo' },
        lengthSec: input.lengthSec, locale: input.locale, referenceId: input.referenceId,
      },
        snapshotRevision: snapshot.revision, proposalId: 'promo-card', runId, layer: 'marketing', tier: 'normal' },
      { ...input }, snapshot, () => true, new Map([['selected', { kind: 'promoVideo' as const, id: 'failed-job' }]]));
      if (prepared.kind !== 'proposal') throw new Error(prepared.kind);
      const { proposal } = prepared;
      expect(backend.calls.filter(call => call.method === 'POST')).toHaveLength(0);
      expect(proposal.confirm(store).pending).toBe(true);
      expect(proposal.confirm(store).pending).toBe(true);
      if (loseReceipt) {
        expect(await proposal.settled()).toMatchObject({ uncertain: true, recheckable: true });
        expect(proposal.recheck(store).pending).toBe(true);
      }
      expect((await proposal.settled()).frame).toMatchObject({ outcome: 'applied', messageKey: 'data.marketing.notice.videoStarted' });
      const calls = backend.calls.map(call => `${call.method} ${call.path}`);
      const save = calls.indexOf(`POST ${base}/drafts`);
      const generate = calls.indexOf(`POST ${base}/drafts/draft/generate`);
      expect(save).toBeGreaterThanOrEqual(0);
      expect(calls.slice(save + 1, generate)).toContain(`GET ${base}/drafts`);
      const attempts = backend.callsTo('POST', `${base}/drafts/draft/generate`);
      expect(attempts).toHaveLength(loseReceipt ? 2 : 1);
      expect(new Set(attempts.map(call => call.headers.get('Idempotency-Key'))).size).toBe(1);
      expect(effects).toBe(1);
      expect(store.getSnapshot().tables.marketing.promoVideo).toEqual(expect.arrayContaining([expect.objectContaining({ jobId: 'job', status: 'done' })]));
    } finally {
      session.dispose();
      vi.unstubAllGlobals();
    }
  });
});
