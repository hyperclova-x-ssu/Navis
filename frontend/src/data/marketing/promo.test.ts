/** DATA_MODEL 10.16.12 (F-50, D-80): one photo count, the 8 commands, widget states, few-photos, clip-only code. AC-323~327·329~332·335·342~347. */
import { describe, expect, it } from 'vitest';
import type { FeatureId, QueryCondition } from '../../contracts';
import { createWidgetDataStore, selectWidget, TODAY, type DataCommandResult, type ModelOf, type WidgetDataStore } from '../widget-data';
import catalogJson from './promo-catalog.json';
import { catalogForSource, isCatalogInput, promoTablesFromCatalog } from './promo';
import { createLegacyMarketingSeed } from './seed';
import { dispatchOk, inputOf, JOB_ID, makeDone, RESULT } from './promo-fixtures';

function modelOf<F extends FeatureId>(store: WidgetDataStore, id: F, condition: QueryCondition = { kind: 'default' }, variant = 'normal'): ModelOf<F> {
  const view = selectWidget(store.getSnapshot(), id, condition, variant);
  if (view.status !== 'ready') throw new Error(`${id} not ready: ${view.status}`);
  return view.model as ModelOf<F>;
}
function createLegacyPromoStore() {
  const marketing = createLegacyMarketingSeed();
  // Keep the historical fixture in the current demo month so its clip coupon remains active.
  const currentMonth = (date: string) => TODAY.slice(0, 7) + date.slice(7);
  return createWidgetDataStore({
    marketing: {
      ...marketing,
      coupon: marketing.coupon.map(coupon => ({
        ...coupon, startsOn: currentMonth(coupon.startsOn), endsOn: currentMonth(coupon.endsOn), createdAt: currentMonth(coupon.createdAt),
      })),
      couponCode: marketing.couponCode.map(code => ({
        ...code, activatedAt: code.activatedAt === null ? null : currentMonth(code.activatedAt),
      })),
    },
  });
}
const weekCell = (store: WidgetDataStore) => modelOf(store, 'marketing-today').cells.find((c) => c.slot === 'week');
const clipIssued = (store: WidgetDataStore) => modelOf(store, 'marketing-performance').routes.find((r) => r.route === 'clip')?.issued;
const make = (store: WidgetDataStore, key: string, n = 5) => store.dispatch({ type: 'video.make', input: inputOf(store, n), idempotencyKey: key });
const idOf = (r: DataCommandResult) => (r as { value: { videoId: string } }).value.videoId;

describe('catalog → tables (same JSON as the server example source)', () => {
  it('seed tables = catalog `example`: 1 store, 3 menus, 10 financier photos in catalog order, urls under /api/promo/photos, exterior left out', () => {
    const t = createLegacyPromoStore().getSnapshot().tables.marketing;
    expect(t.promoStore).toEqual([{ name: '미학당', location: '숭실대입구역 3번 출구 · 빨간 벽돌, 초록 문', exteriorPhotoId: 'store-exterior', exteriorUrl: '/api/promo/photos/store-exterior', sourceId: 'example' }]);
    expect(t.promoMenu.map((m) => [m.menuId, m.order])).toEqual([['financier', 0], ['croissant', 1], ['americano', 2]]);
    expect(t.promoPhoto.map((p) => p.photoId)).toEqual(catalogJson.sources.example);
    expect(t.promoPhoto.every((p) => p.menuId === 'financier' && p.url === `/api/promo/photos/${p.photoId}`)).toBe(true);
    expect(t.promoPhoto.map((p) => p.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it('the three sources give 10 · 7 · 4 photos and no other menu ever has one', () => {
    for (const [source, n] of [['example', 10], ['example-7', 7], ['example-4', 4]] as const) {
      const tables = promoTablesFromCatalog(catalogForSource(source));
      expect([source, tables.promoPhoto.length]).toEqual([source, n]);
      expect(tables.promoPhoto.every((p) => p.menuId === 'financier')).toBe(true);
    }
  });
  it('isCatalogInput accepts the real shape and rejects malformed ones', () => {
    expect(isCatalogInput(catalogForSource('example'))).toBe(true);
    const c = catalogForSource('example');
    for (const bad of [null, {}, { ...c, sourceId: '' }, { ...c, store: { ...c.store, name: 3 } }, { ...c, photos: [{ ...c.photos[0], width: 0 }] }, { ...c, photos: [{ ...c.photos[0], menuId: 'nope' }] },
      { ...c, menus: [{ ...c.menus[0], photoIds: ['zz-missing'] }] }, { ...c, menus: [{ ...c.menus[0], names: { ko: 'x' } }] }, { ...c, photos: [c.photos[0], c.photos[0]] }]) expect(isCatalogInput(bad)).toBe(false);
  });
});

describe('one photo number everywhere (AC-324): widget · window · today’s promotions', () => {
  it('shows the cafe storefront and photos under their existing menu ids after catalog sync', () => {
    const store = createWidgetDataStore();
    const cafe = catalogJson.sourceCatalogs.cafe;
    const url = (id: string) => `/api/promo/photos/${id}`;
    dispatchOk(store, {
      type: 'promo.syncCatalog',
      catalog: {
        sourceId: 'cafe',
        store: { ...cafe.store, exteriorUrl: url(cafe.store.exteriorPhotoId) },
        menus: cafe.menus,
        photos: cafe.photos.filter(p => p.menuId !== null).map(({ photoId, menuId, width, height }) => ({
          photoId, menuId, width, height, url: url(photoId),
        })),
      },
    });
    const model = modelOf(store, 'promo-video');
    expect(model.store).toMatchObject({
      name: '안숭잘부 카페', exteriorPhotoId: 'cafe-storefront', exteriorUrl: '/api/promo/photos/cafe-storefront',
    });
    expect(model.photoCount).toBe(177);
    expect(model.canMake).toBe(true);
    expect(model.menus).toHaveLength(25);
    for (const menuId of ['m-americano', 'm-cafe-latte', 'm-vanilla-latte', 'm-dolce-latte', 'm-deep-choco', 'm-strawberry-cake']) {
      expect(model.menus.find(m => m.menuId === menuId)?.photos).toHaveLength(10);
    }
    expect(model.menus.find(m => m.menuId === 'm-saltbread')?.photos).toHaveLength(14);
    for (const menuId of ['m-bagel-plain', 'm-basque-cake', 'm-cookie-choco']) {
      expect(model.menus.find(m => m.menuId === menuId)?.photos).toHaveLength(9);
    }
    expect(model.menus.find(m => m.menuId === 'm-chestnut-latte')?.photos).toHaveLength(6);
    expect(model.menus.filter(m => m.photos.length === 5)).toHaveLength(14);
  });

  it('seed 10: materials = photos = financier photos = today’s “영상에 쓸 매장 사진 10장”', () => {
    const store = createLegacyPromoStore();
    const v = modelOf(store, 'promo-video');
    expect([v.materialsCount, v.photoCount, v.menus[0].photos.length, weekCell(store)?.params]).toEqual([10, 10, 10, { photos: 10 }]);
    expect(weekCell(store)).toMatchObject({ kind: 'video', ref: { featureId: 'promo-video', view: 'create' } });
  });
  it('syncCatalog to 7 and 4 photos changes all three numbers together; at 4 the widget is empty and the cell is gone', () => {
    const store = createLegacyPromoStore();
    dispatchOk(store, { type: 'promo.syncCatalog', catalog: catalogForSource('example-7') });
    const v = modelOf(store, 'promo-video');
    expect([v.materialsCount, v.photoCount, v.menus[0].photos.length, weekCell(store)?.params, v.canMake]).toEqual([7, 7, 7, { photos: 7 }, true]);
    expect(v.menus[0].photos.map((p) => p.photoId)).toEqual(catalogJson.sources['example-7']);
    dispatchOk(store, { type: 'promo.syncCatalog', catalog: catalogForSource('example-4') });
    expect(store.getSnapshot().tables.marketing.promoPhoto).toHaveLength(4);
    expect(weekCell(store)).toBeUndefined();
    expect(selectWidget(store.getSnapshot(), 'promo-video', { kind: 'default' }, 'normal')).toMatchObject({ status: 'empty', messageKey: 'data.state.promo-video.few-photos' });
    expect(store.dispatch({ type: 'video.make', input: inputOf(store, 5), idempotencyKey: 'k' })).toMatchObject({ ok: false });
  });
  it('the same catalog again leaves the very same snapshot; a bad catalog changes nothing', () => {
    const store = createLegacyPromoStore();
    const before = store.getSnapshot();
    expect(dispatchOk(store, { type: 'promo.syncCatalog', catalog: catalogForSource('example') }).revision).toBe(before.revision);
    expect(store.getSnapshot()).toBe(before);
    expect(store.dispatch({ type: 'promo.syncCatalog', catalog: { sourceId: 'x' } as never })).toMatchObject({ ok: false, code: 'VALIDATION', field: 'catalog' });
    expect(store.getSnapshot()).toBe(before);
  });
  it('the few-photos sample state is the widget’s own display: 4 photos there, 10 everywhere else (AC-344)', () => {
    const store = createLegacyPromoStore();
    expect(selectWidget(store.getSnapshot(), 'promo-video', { kind: 'default' }, 'few-photos')).toMatchObject({ status: 'empty', messageKey: 'data.state.promo-video.few-photos' });
    expect(modelOf(store, 'promo-video').photoCount).toBe(10);
    expect(weekCell(store)?.params).toEqual({ photos: 10 });
  });
});

describe('video.make (AC-329~332·335)', () => {
  it('4 photos → VALIDATION, 5 → a `making` row at stage look/active with no job yet', () => {
    const store = createLegacyPromoStore();
    expect(make(store, 'a', 4)).toMatchObject({ ok: false, code: 'VALIDATION', field: 'photoIds', messageKey: 'data.marketing.error.fewPhotos' });
    expect(store.getSnapshot().revision).toBe(0);
    const id = idOf(okOf(make(store, 'b', 5)));
    const row = store.getSnapshot().tables.marketing.promoVideo[0];
    expect(row).toMatchObject({ videoId: id, jobId: null, status: 'making', stage: 'look', stageState: 'active', lookCount: 5, retryCount: 0, result: null, failReason: null });
    expect(modelOf(store, 'promo-video')).toMatchObject({ state: 'making', current: { videoId: id, stage: 'look', stageState: 'active', lookCount: 5, lengthSec: 15, photoCount: 5 }, postedCount: 0 });
  });
  it('validates menus, photos, moods, concepts, memo, reference, length, locale', () => {
    const store = createLegacyPromoStore();
    const bad = (extra: Record<string, unknown>, field: string, code = 'VALIDATION') => expect(store.dispatch({ type: 'video.make', input: inputOf(store, 5, extra as never), idempotencyKey: `k-${field}-${Math.random()}` }), field).toMatchObject({ ok: false, code, field });
    bad({ menuIds: [] }, 'menuIds');
    bad({ menuIds: ['pizza'] }, 'menuIds', 'NOT_FOUND');
    bad({ photoIds: ['fin-01', 'fin-02', 'fin-03', 'fin-04', 'nope'] }, 'photoIds', 'NOT_FOUND');
    bad({ menuIds: ['croissant'] }, 'photoIds'); // photos of a menu that is not chosen
    bad({ moods: [] }, 'moods');
    bad({ moods: ['gloomy'] }, 'moods');
    bad({ concepts: [] }, 'concepts');
    bad({ concepts: ['x'] }, 'concepts');
    bad({ memo: 'a'.repeat(101) }, 'memo');
    bad({ referenceId: 'ref-19' }, 'referenceId');
    bad({ lengthSec: 20 }, 'lengthSec');
    bad({ locale: 'ja' }, 'locale');
    expect(store.getSnapshot().revision).toBe(0);
    // memo counts code points: 100 emoji pass, an empty memo passes, multiple moods and concepts pass
    okOf(store.dispatch({ type: 'video.make', input: inputOf(store, 5, { memo: '😀'.repeat(100), moods: ['warm', 'lively'], concepts: ['new-item', 'todays-deal'], menuIds: ['financier', 'croissant'], lengthSec: 30, locale: 'zh-Hant', referenceId: 'ref-6' }), idempotencyKey: 'ok' }));
    expect(store.getSnapshot().tables.marketing.promoVideo[0].input).toMatchObject({ moods: ['warm', 'lively'], menuIds: ['financier', 'croissant'], lengthSec: 30, locale: 'zh-Hant' });
  });
  it('the same key twice makes one row; a second make while one is being made is BUSY', () => {
    const store = createLegacyPromoStore();
    const first = okOf(make(store, 'same'));
    expect(make(store, 'same')).toEqual({ ...first, duplicate: true });
    expect(store.getSnapshot().tables.marketing.promoVideo).toHaveLength(1);
    expect(make(store, 'other')).toMatchObject({ ok: false, code: 'CONFLICT', messageKey: 'data.marketing.error.busy' });
    expect(store.getSnapshot().tables.marketing.promoVideo).toHaveLength(1);
    expect(store.dispatch({ type: 'video.make', input: inputOf(store), idempotencyKey: '' })).toMatchObject({ ok: false, field: 'idempotencyKey' });
  });
});

describe('attachJob · progress · settle', () => {
  it('steps only go forward and a stale poll never rewinds the row', () => {
    const store = createLegacyPromoStore();
    const id = idOf(okOf(make(store, 'a')));
    dispatchOk(store, { type: 'video.attachJob', videoId: id, jobId: JOB_ID });
    expect(store.dispatch({ type: 'video.attachJob', videoId: id, jobId: 'pj-ffffffffffff' })).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(store.dispatch({ type: 'video.attachJob', videoId: id, jobId: 'nope' })).toMatchObject({ ok: false, field: 'jobId' });
    const rev = store.getSnapshot().revision;
    expect(dispatchOk(store, { type: 'video.attachJob', videoId: id, jobId: JOB_ID }).revision).toBe(rev);
    dispatchOk(store, { type: 'video.progress', videoId: id, stage: 'look', stageState: 'done', lookCount: 5 });
    dispatchOk(store, { type: 'video.progress', videoId: id, stage: 'story', stageState: 'active' });
    dispatchOk(store, { type: 'video.progress', videoId: id, stage: 'scenes', stageState: 'active' });
    const at = store.getSnapshot();
    expect(store.dispatch({ type: 'video.progress', videoId: id, stage: 'story', stageState: 'active' })).toMatchObject({ ok: false, code: 'CONFLICT', messageKey: 'data.marketing.error.stageBackward' });
    expect(store.dispatch({ type: 'video.progress', videoId: id, stage: 'look', stageState: 'done' })).toMatchObject({ ok: false, code: 'CONFLICT' });
    dispatchOk(store, { type: 'video.progress', videoId: id, stage: 'scenes', stageState: 'done' });
    expect(store.dispatch({ type: 'video.progress', videoId: id, stage: 'scenes', stageState: 'active' })).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(store.getSnapshot().tables.marketing.promoVideo[0]).toMatchObject({ stage: 'scenes', stageState: 'done', lookCount: 5 });
    expect(store.dispatch({ type: 'video.progress', videoId: id, stage: 'x' as never, stageState: 'active' })).toMatchObject({ ok: false, field: 'stage' });
    expect(at).not.toBe(store.getSnapshot());
    expect(store.dispatch({ type: 'video.progress', videoId: 'pv-none', stage: 'look', stageState: 'active' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
  it('settle done → `done` (not posted); settle failed → `failed` with the reason; the posted count never moves; only making rows settle', () => {
    const store = createLegacyPromoStore();
    const id = idOf(okOf(make(store, 'a')));
    expect(store.dispatch({ type: 'video.settle', videoId: id, outcome: { kind: 'failed', reason: 'NOPE' as never } })).toMatchObject({ ok: false, field: 'outcome' });
    expect(store.dispatch({ type: 'video.settle', videoId: id, outcome: { kind: 'done', result: { ...RESULT, fileUrl: '' } } })).toMatchObject({ ok: false, field: 'outcome' });
    dispatchOk(store, { type: 'video.settle', videoId: id, outcome: { kind: 'done', result: RESULT } });
    expect(modelOf(store, 'promo-video')).toMatchObject({ state: 'done', postedCount: 0, current: { status: 'done', stage: 'merge', stageState: 'done', result: RESULT } });
    expect(store.dispatch({ type: 'video.settle', videoId: id, outcome: { kind: 'failed', reason: 'RENDER_FAILED' } })).toMatchObject({ ok: false, code: 'CONFLICT' });
    const failed = createLegacyPromoStore();
    const fid = idOf(okOf(make(failed, 'f')));
    dispatchOk(failed, { type: 'video.progress', videoId: fid, stage: 'scenes', stageState: 'active' });
    dispatchOk(failed, { type: 'video.settle', videoId: fid, outcome: { kind: 'failed', reason: 'CODE_CHECK_FAILED' } });
    expect(modelOf(failed, 'promo-video')).toMatchObject({ state: 'failed', postedCount: 0, current: { status: 'failed', stage: 'scenes', stageState: 'failed', failReason: 'CODE_CHECK_FAILED', result: null } });
  });
});

describe('video.retry (AC-342)', () => {
  it('only a failed row; same input, same row, retry_count + 1, back to look/active with no job; posted count unchanged', () => {
    const store = createLegacyPromoStore();
    const id = idOf(okOf(store.dispatch({ type: 'video.make', input: inputOf(store, 6, { memo: '따뜻하게', moods: ['warm', 'clean'], referenceId: 'ref-3', lengthSec: 30 }), idempotencyKey: 'a' })));
    expect(store.dispatch({ type: 'video.retry', videoId: id, idempotencyKey: 'r0' })).toMatchObject({ ok: false, code: 'CONFLICT' }); // still making
    dispatchOk(store, { type: 'video.attachJob', videoId: id, jobId: JOB_ID });
    dispatchOk(store, { type: 'video.settle', videoId: id, outcome: { kind: 'failed', reason: 'AI_UNAVAILABLE' } });
    const input = store.getSnapshot().tables.marketing.promoVideo[0].input;
    dispatchOk(store, { type: 'video.retry', videoId: id, idempotencyKey: 'r1' });
    const row = store.getSnapshot().tables.marketing.promoVideo[0];
    expect(row).toMatchObject({ videoId: id, status: 'making', stage: 'look', stageState: 'active', jobId: null, failReason: null, retryCount: 1, lookCount: 6 });
    expect(row.input).toEqual(input);
    expect(store.getSnapshot().tables.marketing.promoVideo).toHaveLength(1);
    expect(modelOf(store, 'promo-video').postedCount).toBe(0);
    expect(store.dispatch({ type: 'video.retry', videoId: id, idempotencyKey: 'r1' })).toMatchObject({ ok: true, duplicate: true });
    expect(store.dispatch({ type: 'video.retry', videoId: 'pv-none', idempotencyKey: 'r2' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
  it('a failed row cannot retry while a newer video is being made (BUSY)', () => {
    const store = createLegacyPromoStore();
    const a = idOf(okOf(make(store, 'a')));
    dispatchOk(store, { type: 'video.settle', videoId: a, outcome: { kind: 'failed', reason: 'AI_TIMEOUT' } });
    okOf(make(store, 'b'));
    expect(store.dispatch({ type: 'video.retry', videoId: a, idempotencyKey: 'r' })).toMatchObject({ ok: false, code: 'CONFLICT', messageKey: 'data.marketing.error.busy' });
  });
});

describe('save · markPosted (AC-337·345~347)', () => {
  it('save changes no number and no revision', () => {
    const store = createLegacyPromoStore();
    const id = makeDone(store);
    const before = store.getSnapshot();
    expect(dispatchOk(store, { type: 'video.save', videoId: id }).noticeKey).toBe('data.marketing.notice.saveStarted');
    expect(store.getSnapshot()).toBe(before);
    expect(store.dispatch({ type: 'video.save', videoId: 'pv-none' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
  it('clip: +1 video, clip issued 16 → 26, total 130, rate 22, Tuesday coupon 4/30', () => {
    const store = createLegacyPromoStore();
    expect(clipIssued(store)).toBe(16);
    dispatchOk(store, { type: 'video.markPosted', videoId: makeDone(store), route: 'clip', idempotencyKey: 'p' });
    const perf = modelOf(store, 'marketing-performance');
    expect([clipIssued(store), perf.issued, perf.used, perf.rate]).toEqual([26, 130, 28, 22]);
    expect(modelOf(store, 'coupon-status').rows.find((r) => r.couponId === 'c-tue-shot')).toMatchObject({ issued: 30, used: 4 });
    expect(modelOf(store, 'promo-video')).toMatchObject({ state: 'posted', postedCount: 1, lastPostedRoute: 'clip', lastPostedCounting: true });
    expect(weekCell(store)).toBeUndefined(); // AC-325: after posting the week cell folds away
  });
  it('shorts and reels: +1 video, every coupon number unchanged', () => {
    const store = createLegacyPromoStore();
    const perf = modelOf(store, 'marketing-performance');
    const status = modelOf(store, 'coupon-status');
    dispatchOk(store, { type: 'video.markPosted', videoId: makeDone(store, 'a'), route: 'shorts', idempotencyKey: 'p1' });
    expect(modelOf(store, 'promo-video')).toMatchObject({ postedCount: 1, lastPostedRoute: 'shorts', lastPostedCounting: false });
    dispatchOk(store, { type: 'video.markPosted', videoId: makeDone(store, 'b'), route: 'reels', idempotencyKey: 'p2' });
    expect(modelOf(store, 'promo-video')).toMatchObject({ postedCount: 2, lastPostedRoute: 'reels' });
    const after = modelOf(store, 'marketing-performance');
    expect([after.issued, after.used, after.rate, after.routes, after.byCoupon]).toEqual([perf.issued, perf.used, perf.rate, perf.routes, perf.byCoupon]);
    expect(after.byVideo.map((v) => [v.postedRoute, v.couponId, v.issued])).toEqual([['shorts', null, 0], ['reels', null, 0]]);
    expect(clipIssued(store)).toBe(16);
    expect(modelOf(store, 'coupon-status').rows).toEqual(status.rows);
  });
  it('the “clip → shorts” sequence of AC-347: 1편 clip, then a new empty draft video posted to shorts → 2편, latest place shorts, clip stays 26', () => {
    const store = createLegacyPromoStore();
    dispatchOk(store, { type: 'video.markPosted', videoId: makeDone(store, 'a'), route: 'clip', idempotencyKey: 'p1' });
    dispatchOk(store, { type: 'video.markPosted', videoId: makeDone(store, 'b'), route: 'shorts', idempotencyKey: 'p2' });
    expect(modelOf(store, 'promo-video')).toMatchObject({ postedCount: 2, lastPostedRoute: 'shorts' });
    expect(clipIssued(store)).toBe(26);
  });
  it('a done video can be posted once; the route is required', () => {
    const store = createLegacyPromoStore();
    const id = makeDone(store);
    expect(store.dispatch({ type: 'video.markPosted', videoId: id, route: undefined as never, idempotencyKey: 'x' })).toMatchObject({ ok: false, field: 'route' });
    dispatchOk(store, { type: 'video.markPosted', videoId: id, route: 'clip', idempotencyKey: 'y' });
    expect(store.dispatch({ type: 'video.markPosted', videoId: id, route: 'shorts', idempotencyKey: 'z' })).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(modelOf(store, 'promo-video').postedCount).toBe(1);
  });
});

describe('widget model state (10.16.8)', () => {
  it('before → making → done → posted → (new) making → failed, each by the latest row', () => {
    const store = createLegacyPromoStore();
    const states: string[] = [modelOf(store, 'promo-video').state];
    const id = idOf(okOf(make(store, 'a')));
    states.push(modelOf(store, 'promo-video').state);
    dispatchOk(store, { type: 'video.settle', videoId: id, outcome: { kind: 'done', result: RESULT } });
    states.push(modelOf(store, 'promo-video').state);
    dispatchOk(store, { type: 'video.markPosted', videoId: id, route: 'clip', idempotencyKey: 'p' });
    states.push(modelOf(store, 'promo-video').state);
    const next = idOf(okOf(make(store, 'b')));
    states.push(modelOf(store, 'promo-video').state);
    dispatchOk(store, { type: 'video.settle', videoId: next, outcome: { kind: 'failed', reason: 'ENCODE_FAILED' } });
    states.push(modelOf(store, 'promo-video').state);
    expect(states).toEqual(['before', 'making', 'done', 'posted', 'making', 'failed']);
    expect(modelOf(store, 'promo-video').postedCount).toBe(1);
  });
  it('menus carry the current-language name key, the four names and their own photos', () => {
    const store = createLegacyPromoStore();
    const [fin, cro, ame] = modelOf(store, 'promo-video').menus;
    expect(fin).toMatchObject({ menuId: 'financier', name: { key: 'data.marketing.promoMenu.financier' }, names: { ko: '휘낭시에', en: 'Financier', 'zh-Hans': '费南雪', 'zh-Hant': '費南雪' }, hasPhotos: true });
    expect([cro.photos, cro.hasPhotos, ame.photos, ame.hasPhotos]).toEqual([[], false, [], false]);
  });
});

function okOf(r: DataCommandResult) {
  if (!r.ok) throw new Error(`command failed: ${r.code} ${r.messageKey} ${r.field ?? ''}`);
  return r;
}
