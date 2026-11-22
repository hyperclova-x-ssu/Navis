import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../../data/db/store';
import { catalogForSource } from '../../../data/marketing/promo';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend, reply, TEST_STORE_ID } from '../../../data/reality/00/testing';
import { promoAdapter } from '../../../data/reality/16/adapter';
import { renderWithKit } from '../../../ui/test-utils';
import { PromoVideoDetail, PromoVideoPanel } from './promo-video';
import { cafeCatalog, createFakeServer, fakeReferences, syncedCafeStore } from './promo-test-server';
import { makeHost } from './test-helpers';

const promo = '/marketing/promo';
const asOf = '2026-11-21T06:45:00.000Z';
const page = <T,>(items: readonly T[]) => ({ items, asOf, sourceRevision: 1, nextCursor: null });
const photoIds = ['photo-1', 'photo-2', 'photo-3', 'photo-4', 'photo-5'];
const input = { menuIds: ['latte'], photoIds, moods: ['warm'], concepts: ['new-item'], memo: '점주가 남긴 메모', referenceId: 'ref-1', lengthSec: 15, locale: 'ko' };

function open(finished: boolean, placeNews: () => unknown = () => reply(409, { code: 'CONFLICT', reason: 'MANUAL_UPLOAD_REQUIRED' }), photos = finished ? photoIds.length : 0, fixture = false, panel = false,
  photoRequest?: (url: string, init?: RequestInit) => Promise<Response> | undefined) {
  const backend = fakeBackend();
  const owned = photoIds.slice(0, photos);
  backend.on('GET', `${promo}/assets`, () => ({ ...page(owned.map(photoId => ({ photoId, menuId: 'latte', url: `/owner/${photoId}.jpg`, fileId: null, width: 180, height: 300 }))),
    store: null, menus: [{ menuId: 'latte', names: { ko: '라테', en: 'Latte', 'zh-Hans': '拿铁', 'zh-Hant': '拿鐵' }, photoIds: owned }], eligiblePhotoCount: owned.length }));
  backend.on('GET', `${promo}/drafts`, () => page(finished ? [{ draftId: 'draft', revision: 2, input, jobId: 'job', updatedAt: asOf }] : []));
  backend.on('GET', `${promo}/publications`, () => ({ ...page([]), uploadTargets: { 'place-news': 'https://new.smartplace.naver.com/' } }));
  backend.on('GET', '/promo/jobs/job', () => ({ jobId: 'job', startedAt: asOf, status: 'done', stage: 'merge', stageState: 'done', result: { durationSec: 15, sizeBytes: 123, music: null } }));
  backend.on('GET', '/promo/references', () => fakeReferences());
  backend.on('POST', `${promo}/jobs/job/place-news`, placeNews);
  backend.on('POST', `${promo}/jobs/job/attest`, () => ({ resourceId: 'post', revision: 1, receiptId: 'receipt', affectedSources: ['promo'] }));
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: (url, init) => photoRequest?.(String(url), init) ?? backend.fetch(url, init),
    source: () => 'http', adapters: [promoAdapter], reconcileDelaysMs: [] });
  if (fixture) syncedCafeStore(store); else store.bindReal(port);
  const host = makeHost();
  renderWithKit(<>
    {panel && <PromoVideoPanel featureId="promo-video" condition={{ kind: 'default' }} width={3} height={3} shape="S" presetId="A" editing={false} host={host} />}
    <PromoVideoDetail featureId="promo-video" condition={{ kind: 'default' }} detailRef={{ featureId: 'promo-video', view: 'create' }} host={host} />
  </>, { store });
  return backend;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('uses store-authorized reference list and poster bytes in the live gallery', async () => {
  const path = `/api/v1/stores/${TEST_STORE_ID}/promo/references`;
  const headers = vi.fn();
  const originalURL = globalThis.URL;
  class TestURL extends URL {
    static createObjectURL = vi.fn(() => 'blob:gallery-media');
    static revokeObjectURL = vi.fn();
  }
  globalThis.URL = TestURL;
  try {
    open(false, undefined, 5, false, false, (url, init) => {
      if (url !== path && !url.startsWith(`${path}/ref-1/`)) return;
      headers(url, new Headers(init?.headers).get('authorization'));
      if (url !== path) return Promise.resolve(new Response('media', { headers: { 'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' } }));
      return Promise.resolve(Response.json({ referenceVersion: 'proof', references: [{
        ...fakeReferences().references[0], posterUrl: `${path}/ref-1/poster.jpg`, previewUrl: `${path}/ref-1/preview.mp4`,
      }] }));
    });
    const tabs = await screen.findAllByRole('tab');
    fireEvent.click(tabs[2]);
    const card = await screen.findByRole('radio');
    await waitFor(() => expect(card.querySelector('img')).toHaveAttribute('src', 'blob:gallery-media'));
    expect(headers).toHaveBeenCalledWith(path, expect.stringMatching(/^Bearer token-/));
    expect(headers).toHaveBeenCalledWith(`${path}/ref-1/poster.jpg`, expect.stringMatching(/^Bearer token-/));
    cleanup();
  } finally { globalThis.URL = originalURL; }
});

it('uses the authenticated poster from a finished job', async () => {
  const path = `/api/v1/stores/${TEST_STORE_ID}/promo/jobs/job`;
  const originalURL = globalThis.URL;
  class TestURL extends URL {
    static createObjectURL = (blob: Blob) => `blob:promo-${blob.type.endsWith('jpeg') ? 'poster' : 'video'}`;
    static revokeObjectURL = vi.fn();
  }
  globalThis.URL = TestURL;
  try {
    const readPoster = vi.fn();
    open(true, undefined, 5, false, false, (url, init) => {
      if (url === path) return Promise.resolve(Response.json({ jobId: 'job', startedAt: asOf, status: 'done', stage: 'merge', stageState: 'done',
        result: { durationSec: 15, sizeBytes: 123, music: null, posterUrl: `${path}/poster.jpg` } }));
      if (url === `${path}/poster.jpg`) {
        readPoster(new Headers(init?.headers).get('authorization'));
        return Promise.resolve(new Response('poster', { headers: { 'content-type': 'image/jpeg' } }));
      }
      if (url === `${path}/video.mp4`) return Promise.resolve(new Response('video', { headers: { 'content-type': 'video/mp4' } }));
    });
    await waitFor(() => expect(document.querySelector('.pv-player video')).toHaveAttribute('poster', 'blob:promo-poster'));
    expect(readPoster).toHaveBeenCalledWith(expect.stringMatching(/^Bearer token-/));
    cleanup();
  } finally { globalThis.URL = originalURL; }
});

it.each(['s3', 'off'] as const)('shows API-returned photo URLs and retains selection IDs with server storage %s', async mode => {
  const listUrl = `/api/v1/stores/${TEST_STORE_ID}/marketing/photos`;
  const contentUrl = mode === 's3' ? `${listUrl}/${photoIds[0]}/content` : '/menu-photos/from-api.jpeg';
  const displayed = mode === 's3' ? 'blob:promo-photo' : contentUrl;
  const createObjectURL = vi.fn(() => displayed);
  const originalURL = globalThis.URL;
  class TestURL extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = vi.fn();
  }
  globalThis.URL = TestURL;
  try {
    const mediaHeaders = vi.fn();
    open(false, undefined, 5, false, false, (url, init) => {
      if (url === listUrl) return Promise.resolve(Response.json({
        items: [{ photoId: photoIds[0], menuId: 'latte', sha256: 'a'.repeat(64), width: 180, height: 300, contentUrl }], nextCursor: null,
      }));
      if (url === contentUrl && mode === 's3') {
        mediaHeaders(new Headers(init?.headers).get('authorization'));
        return Promise.resolve(new Response('photo bytes', { headers: { 'content-type': 'image/jpeg' } }));
      }
    });
    fireEvent.click(await screen.findByRole('checkbox', { name: /^라테\s·\s사진 5장$/ }));
    const tile = screen.getByRole('checkbox', { name: /^라테 사진 1/ });
    await waitFor(() => expect(tile.querySelector('img')).toHaveAttribute('src', displayed));
    fireEvent.click(tile);
    expect(tile).toHaveAttribute('data-photo', photoIds[0]);
    expect(tile).toHaveAttribute('aria-checked', 'true');
    if (mode === 's3') expect(mediaHeaders).toHaveBeenCalledWith(expect.stringMatching(/^Bearer token-/));
    else expect(createObjectURL).not.toHaveBeenCalled();
    cleanup();
  } finally {
    globalThis.URL = originalURL;
  }
});

it.each(['example', 'http'] as const)('offers the chestnut and D-409 menu photos in %s mode', async (mode) => {
  const catalog = catalogForSource('cafe');
  const server = createFakeServer();
  server.catalog = catalog;
  vi.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
  const store = createWidgetDataStore();
  if (mode === 'http') {
    const backend = fakeBackend();
    backend.on('GET', `${promo}/assets`, ({ query }) => {
      const offset = Number(query.cursor ?? 0);
      const limit = Number(query.limit);
      return {
        ...page(catalog.photos.slice(offset, offset + limit).map(photo => ({ ...photo, fileId: null }))),
        nextCursor: offset + limit < catalog.photos.length ? String(offset + limit) : null,
        store: catalog.store, menus: catalog.menus, eligiblePhotoCount: catalog.photos.length,
      };
    });
    backend.on('GET', `${promo}/drafts`, () => page([]));
    backend.on('GET', `${promo}/publications`, () => page([]));
    store.bindReal(createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [promoAdapter] }));
  }
  renderWithKit(<PromoVideoDetail featureId="promo-video" condition={{ kind: 'default' }}
    detailRef={{ featureId: 'promo-video', view: 'create' }} host={makeHost()} />, { store });
  fireEvent.click(await screen.findByRole('checkbox', { name: /^공주 보늬밤 라떼\s·\s사진 6장$/ }));
  const photos = screen.getAllByRole('checkbox', { name: /^공주 보늬밤 라떼 사진 \d/ });
  expect(photos).toHaveLength(6);
  photos.forEach(photo => fireEvent.click(photo));
  expect(screen.getAllByRole('checkbox', { name: /^공주 보늬밤 라떼 사진 \d/, checked: true })).toHaveLength(6);
  fireEvent.click(screen.getByRole('checkbox', { name: /^고흥 유자 캐모마일 티\s·\s사진 5장$/ }));
  expect(screen.getAllByRole('checkbox', { name: /^고흥 유자 캐모마일 티 사진 \d/ })).toHaveLength(5);
});

it('keeps the video panel, upload controls and draft footer across all four steps in both modes', async () => {
  const server = createFakeServer();
  server.catalog = cafeCatalog(createWidgetDataStore());
  vi.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
  async function structure(fixture: boolean) {
    open(false, undefined, photoIds.length, fixture, true);
    const tabs = await screen.findAllByRole('tab');
    fireEvent.click(screen.getByRole('button', { name: '사진 올리기' }));
    const upload = screen.queryByRole('region', { name: '사진 올리기' });
    const panel = document.querySelector('[data-widget="promo-video"].pv-panel');
    const steps: { label: string | null; heading?: string | null; save: boolean; designs: number }[] = [];
    const result = { panel: !!panel?.querySelector('.pv-panel__action button'), upload: upload && {
      inputs: Array.from(upload.querySelectorAll('input,select'), el => el.getAttribute('type') ?? el.tagName),
      button: upload.querySelector('button') !== null },
    steps };
    for (const [index, tab] of tabs.entries()) {
      fireEvent.click(tab);
      const step = document.querySelector<HTMLElement>('.pv-body')!;
      if (index === 2) await waitFor(() => expect(within(step).getAllByRole('radio')).toHaveLength(18));
      result.steps.push({ label: tab.textContent, heading: step.querySelector('h3')?.textContent,
        save: !!screen.queryByRole('button', { name: '초안 저장하기' }),
        designs: step.querySelectorAll('[data-ref]').length });
    }
    cleanup();
    return result;
  }
  const real = await structure(false);
  expect(real.steps).toHaveLength(4);
  expect(await structure(true)).toEqual(real);
});

it('adds a rights-confirmed photo to the example run and stores the draft without a provider request', async () => {
  const example = createFakeServer();
  example.catalog = cafeCatalog(createWidgetDataStore());
  vi.spyOn(globalThis, 'fetch').mockImplementation(example.fetch);
  vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close() {} }));
  try {
    open(false, undefined, 0, true);
    fireEvent.click(await screen.findByRole('button', { name: '사진 올리기' }));
    const upload = await screen.findByRole('region', { name: '사진 올리기' });
    const controls = within(upload);
    fireEvent.change(controls.getByLabelText('사진 파일'), { target: { files: [new File(['sample'], 'sample.jpg', { type: 'image/jpeg' })] } });
    fireEvent.change(controls.getByLabelText('사진에 나온 메뉴'), { target: { value: 'm-americano' } });
    expect(controls.getByRole('button', { name: '사진 올리기' })).toBeDisabled();
    fireEvent.click(controls.getByRole('checkbox', { name: '이 사진을 홍보에 쓸 권리가 있어요' }));
    fireEvent.click(controls.getByRole('button', { name: '사진 올리기' }));
    expect(await screen.findByText('영상에 쓸 사진 11장')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '초안 저장하기' }));
    expect(await screen.findByText('초안을 저장했어요')).toBeInTheDocument();
    expect(example.calls.every(call => call.method === 'GET')).toBe(true);
  } finally {
    Reflect.deleteProperty(globalThis, 'createImageBitmap');
  }
});

it('lets a store with zero eligible photos enter the rights-confirmed upload flow', async () => {
  const backend = open(false);
  const toggle = await screen.findByRole('button', { name: '사진 올리기' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(document.querySelector('input[type="file"]')).toBeNull();
  fireEvent.click(toggle);
  const input = await screen.findByLabelText('사진 파일');
  expect(input).toHaveAttribute('hidden');
  fireEvent.change(input, { target: { files: [new File(['image'], 'latte.jpg', { type: 'image/jpeg' })] } });
  expect(screen.getByText('latte.jpg')).toBeVisible();
  fireEvent.change(screen.getByLabelText('사진에 나온 메뉴'), { target: { value: 'latte' } });
  expect(screen.getByRole('button', { name: '사진 올리기' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: '이 사진을 홍보에 쓸 권리가 있어요' }));
  expect(screen.getByRole('button', { name: '사진 올리기' })).toBeEnabled();
  expect(backend.calls.filter(call => call.method === 'POST')).toHaveLength(0);
});

it('requires a separate Place card press and a second confirmation to attest a manual link', async () => {
  const backend = open(true);
  fireEvent.click(await screen.findByRole('radio', { name: '플레이스 소식에 올리기' }));
  fireEvent.change(screen.getByLabelText('소식 문구'), { target: { value: '라테가 나왔어요' } });
  expect(backend.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '확인하고 올리기' }));
  expect(await screen.findByRole('link', { name: '공식 업로더 열기' })).toHaveAttribute('href', 'https://new.smartplace.naver.com/');
  fireEvent.change(screen.getByLabelText('게시 링크'), { target: { value: 'https://m.place.naver.com/restaurant/123/feed' } });
  fireEvent.click(screen.getByRole('button', { name: '게시 링크 남기기' }));
  expect(backend.callsTo('POST', `${promo}/jobs/job/attest`)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '한 번 더 확인' }));
  await screen.findByText('게시 링크를 남겼어요');
  expect(backend.callsTo('POST', `${promo}/jobs/job/attest`)).toHaveLength(1);
  expect(backend.callsTo('POST', `${promo}/jobs/job/clip`)).toHaveLength(0);
});

// FIX-PKG-C T-34 (W26-C3): a finished video has one main (green) action, the download; "새 영상 만들기" is the quiet one.
it('keeps the download as the only main action on a finished video', async () => {
  open(true);
  const next = await screen.findByRole('button', { name: '새 영상 만들기' });
  expect(next).toHaveClass('ui-button--secondary');
  expect(screen.getByRole('button', { name: /받기/ })).not.toHaveClass('ui-button--secondary');
});

// FIX leftover (gate r1a W26 K9): this widget calls the store directly, so a refusal arrived as the bare reason; it reads "실행하지 못했어요 · {이유}. {다음}" like every other widget.
it('says what was refused and what to do when the publish request is refused', async () => {
  open(true, () => reply(409, { code: 'CONFLICT', reason: 'PUBLISHER_REJECTED' }));
  fireEvent.click(await screen.findByRole('radio', { name: '플레이스 소식에 올리기' }));
  fireEvent.change(screen.getByLabelText('소식 문구'), { target: { value: '라테가 나왔어요' } });
  fireEvent.click(screen.getByRole('button', { name: '확인하고 올리기' }));
  expect(await screen.findByText('실행하지 못했어요 · 현재 상태에선 진행할 수 없어요. 최신 내용을 확인해 주세요')).toBeInTheDocument();
});

// T-52 (W26-F1): step ① states how many store photos the video can use, before any menu is picked.
it('states how many store photos the video can use before any menu is picked', async () => {
  open(false, undefined, photoIds.length);
  expect(await screen.findByText('영상에 쓸 사진 5장')).toBeInTheDocument();
});
