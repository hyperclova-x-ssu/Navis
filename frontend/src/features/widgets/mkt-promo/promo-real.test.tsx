import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { promoAdapter } from '../../../data/reality/16/adapter';
import { renderWithKit } from '../../../ui/test-utils';
import { PromoVideoDetail } from './promo-video';
import { makeHost } from './test-helpers';

const promo = '/marketing/promo';
const asOf = '2026-11-21T06:45:00.000Z';
const page = <T,>(items: readonly T[]) => ({ items, asOf, sourceRevision: 1, nextCursor: null });
const photoIds = ['photo-1', 'photo-2', 'photo-3', 'photo-4', 'photo-5'];
const input = { menuIds: ['latte'], photoIds, moods: ['warm'], concepts: ['new-item'], memo: '점주가 남긴 메모', referenceId: 'ref-1', lengthSec: 15, locale: 'ko' };

function open(finished: boolean, placeNews: () => unknown = () => reply(409, { code: 'CONFLICT', reason: 'MANUAL_UPLOAD_REQUIRED' }), photos = finished ? photoIds.length : 0) {
  const backend = fakeBackend();
  const owned = photoIds.slice(0, photos);
  backend.on('GET', `${promo}/assets`, () => ({ ...page(owned.map(photoId => ({ photoId, menuId: 'latte', url: `/owner/${photoId}.jpg`, fileId: null, width: 180, height: 300 }))),
    store: null, menus: [{ menuId: 'latte', names: { ko: '라테', en: 'Latte', 'zh-Hans': '拿铁', 'zh-Hant': '拿鐵' }, photoIds: owned }], eligiblePhotoCount: owned.length }));
  backend.on('GET', `${promo}/drafts`, () => page(finished ? [{ draftId: 'draft', revision: 2, input, jobId: 'job', updatedAt: asOf }] : []));
  backend.on('GET', `${promo}/publications`, () => ({ ...page([]), uploadTargets: { 'place-news': 'https://new.smartplace.naver.com/' } }));
  backend.on('GET', '/promo/jobs/job', () => ({ jobId: 'job', startedAt: asOf, status: 'done', stage: 'merge', stageState: 'done', result: { durationSec: 15, sizeBytes: 123, music: null } }));
  backend.on('POST', `${promo}/jobs/job/place-news`, placeNews);
  backend.on('POST', `${promo}/jobs/job/attest`, () => ({ resourceId: 'post', revision: 1, receiptId: 'receipt', affectedSources: ['promo'] }));
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [promoAdapter], reconcileDelaysMs: [] });
  store.bindReal(port);
  renderWithKit(<PromoVideoDetail featureId="promo-video" condition={{ kind: 'default' }} detailRef={{ featureId: 'promo-video', view: 'create' }} host={makeHost()} />, { store });
  return backend;
}

afterEach(cleanup);

it('lets a store with zero eligible photos enter the rights-confirmed upload flow', async () => {
  const backend = open(false);
  const input = await screen.findByLabelText('사진 파일');
  fireEvent.change(input, { target: { files: [new File(['image'], 'latte.jpg', { type: 'image/jpeg' })] } });
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
  expect(await screen.findByText('영상에 쓸 매장 사진 5장')).toBeInTheDocument();
});
