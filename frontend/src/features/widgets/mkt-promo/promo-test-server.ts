/**
 * T-083 fake promo server for unit tests: answers `/api/promo/*` like API_CONTRACT v4.4 with a job whose stage the test
 * moves by hand (`advance`), so the screen can only follow what the server says (AC-335). Not part of the app bundle.
 */
import type { PromoCatalogInput, PromoFailReason, PromoStage, WidgetDataStore } from '../../../data/widget-data';
import { catalogForSource } from '../../../data/marketing/promo';
import type { EstimateModel, PromoJob, ReferenceList } from './promo-api';

/** The cafe menu the tests give photos to (아메리카노) and one that stays without (구운 플레인 베이글), by the cafe seed's menu ids. */
export const PHOTO_MENU = 'm-americano';
export const NO_PHOTO_MENU = 'm-bagel-plain';
/**
 * An API-20 catalog for the 안숭잘부 카페 seed: the store's own menus, `photosByMenu[menuId]` photos for each (none for the others), keyed by the cafe's
 * menu ids. Built here, in the test, so a unit test does not depend on which photos the real catalog happens to carry (photo source: PV-PHOTOS).
 */
export function cafeCatalog(store: WidgetDataStore, photosByMenu: Readonly<Record<string, number>> = { [PHOTO_MENU]: 10 }): PromoCatalogInput {
  const marketing = store.getSnapshot().tables.marketing;
  const menus = marketing.promoMenu.map((row) => ({ menuId: row.menuId, names: row.names, photoIds: Array.from({ length: photosByMenu[row.menuId] ?? 0 }, (_, i) => `${row.menuId}-${String(i + 1).padStart(2, '0')}`) }));
  const photos = menus.flatMap((menu) => menu.photoIds.map((photoId) => ({ photoId, menuId: menu.menuId, url: `/api/promo/photos/${photoId}`, width: 900, height: 1200 })));
  const shop = marketing.promoStore[0];
  return { sourceId: 'cafe', store: { name: shop.name, location: shop.location, exteriorPhotoId: 'cafe-storefront', exteriorUrl: '/api/promo/photos/cafe-storefront' }, menus, photos };
}
/** A cafe store whose catalog already holds the photos (what the first surface sync gives once the server answers). */
export function syncedCafeStore(store: WidgetDataStore, photosByMenu?: Readonly<Record<string, number>>): WidgetDataStore {
  store.dispatch({ type: 'promo.syncCatalog', catalog: cafeCatalog(store, photosByMenu) });
  return store;
}

const STAGES: readonly PromoStage[] = ['look', 'story', 'scenes', 'merge'];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function fakeEstimate(): EstimateModel {
  const row = (len: number) => Array.from({ length: 11 }, (_, n) => ({ photoCount: n, seconds: 40 + len * 2 + n * 3, costUsd: 0.1, costKrw: 100 + len * 4 + n * 7 }));
  return { version: 1, basis: 'spike', sampleCount: 0, fx: { krwPerUsd: 1400, checkedOn: '2026-11-10', kind: 'configured-estimate' }, table: { 10: row(10), 15: row(15), 30: row(30) }, available: { claude: true, browser: true, ffmpeg: true } };
}
export function fakeReferences(): ReferenceList {
  const aspects = ['9:16', '1:1', '4:5', '9:16', '4:5', '1:1'];
  const moods = [['lively', 'warm'], ['warm'], ['clean'], ['lively'], ['warm', 'clean'], ['elegant']] as const;
  return {
    referenceVersion: '1',
    references: aspects.map((cardAspect, i) => ({
      id: `ref-${i + 1}` as ReferenceList['references'][number]['id'], nameKey: `promo.ref.ref-${i + 1}.name`, cardAspect,
      posterUrl: `/api/promo/references/ref-${i + 1}/poster.jpg`, previewUrl: `/api/promo/references/ref-${i + 1}/preview.mp4`,
      preview: { durationSec: 4, width: 360, height: 640, fps: 30, hasAudio: false }, moods: [...moods[i]], concepts: i === 0 ? ['new-item', 'todays-deal'] : ['review-roundup'],
    })),
  };
}

export interface FakeServer {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly calls: { readonly method: string; readonly path: string; readonly body: unknown }[];
  job: PromoJob | null;
  /** Moves the server job to the next stage (or `done` after merge). */
  advance(): void;
  fail(reason: PromoFailReason): void;
  /** Answer of POST /jobs: 202 (default), or an HTTP error. */
  startStatus: number;
  catalogSource: string;
  /** When set, GET /api/promo/catalog answers this (a cafe catalog); otherwise the example catalog of `catalogSource`. */
  catalog: PromoCatalogInput | null;
  down: boolean;
}

export function createFakeServer(): FakeServer {
  let seq = 0;
  const server: FakeServer = {
    calls: [],
    job: null,
    startStatus: 202,
    catalogSource: 'example',
    catalog: null,
    down: false,
    advance() {
      const job = server.job;
      if (!job || job.status === 'done' || job.status === 'failed') return;
      const i = STAGES.indexOf(job.stage);
      if (i === STAGES.length - 1) {
        server.job = { ...job, status: 'done', stageState: 'done', result: { durationSec: 15.0, width: 720, height: 1280, fps: 30, sizeBytes: 1234, fileUrl: `/api/promo/jobs/${job.jobId}/video.mp4`, music: { trackId: 'warm-cozy-acoustic', title: 'Cozy Puzzle In-Game 3', artist: 'MintoDog', license: 'CC0-1.0' }, fixCount: 0 } };
      } else server.job = { ...job, status: 'running', stage: STAGES[i + 1], stageState: 'active' };
    },
    fail(reason) { if (server.job) server.job = { ...server.job, status: 'failed', stageState: 'failed', failReason: reason }; },
    async fetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
      server.calls.push({ method, path: url, body });
      if (server.down) throw new TypeError('network');
      if (url === '/api/promo/catalog') return json(200, server.catalog ?? catalogForSource(server.catalogSource));
      if (url === '/api/promo/estimate-model') return json(200, fakeEstimate());
      if (url === '/api/promo/references') return json(200, fakeReferences());
      if (method === 'POST' && url === '/api/promo/jobs') {
        if (server.startStatus !== 202) return json(server.startStatus, { code: server.startStatus === 409 ? 'BUSY' : 'UNAVAILABLE' });
        seq += 1;
        server.job = { jobId: `pj-${String(seq).padStart(12, '0')}`, status: 'queued', stage: 'look', stageState: 'active', lookCount: (body as { input: { photoIds: string[] } }).input.photoIds.length, startedAt: '2026-11-10T00:00:00.000Z', failReason: null, result: null };
        return json(202, server.job);
      }
      const retry = /^\/api\/promo\/jobs\/(pj-[0-9a-f]{12})\/retry$/.exec(url);
      if (method === 'POST' && retry) {
        if (!server.job || server.job.jobId !== retry[1]) return json(404, { code: 'NOT_FOUND' });
        if (server.job.status !== 'failed') return json(400, { code: 'BAD_REQUEST', field: 'status' });
        seq += 1;
        server.job = { jobId: `pj-${String(seq).padStart(12, '0')}`, status: 'queued', stage: 'look', stageState: 'active', lookCount: server.job.lookCount, startedAt: '2026-11-10T00:00:00.000Z', failReason: null, result: null, retryOf: retry[1] };
        return json(202, server.job);
      }
      const get = /^\/api\/promo\/jobs\/(pj-[0-9a-f]{12})$/.exec(url);
      if (get) return server.job && server.job.jobId === get[1] ? json(200, server.job) : json(404, { code: 'NOT_FOUND' });
      if (method === 'HEAD' && /video\.mp4(\?download=1)?$/.test(url)) return new Response(null, { status: server.job?.status === 'done' ? 200 : 404, headers: { 'Content-Disposition': `attachment; filename="navis-promo.mp4"; filename*=UTF-8''${encodeURIComponent('미학당-20261110-1.mp4')}` } });
      return json(404, { code: 'NOT_FOUND' });
    },
  };
  return server;
}
