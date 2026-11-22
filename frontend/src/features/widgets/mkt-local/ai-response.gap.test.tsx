/** SCR-31 · ai-response: read-only draft previews and the `리뷰 AI 통계` tab with the conditional average. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { reply } from '../../../data/reality/00/testing';
import { ids, reviewInsights, service } from '../../../data/reality/15/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';

afterEach(cleanup);

function open(backend: ReturnType<typeof service>['backend'], detailRef: { itemId?: string; view?: string } = {}) {
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'inbox' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify: vi.fn(), acknowledgeBriefing() {} };
  const Detail = widgets.find(widget => widget.id === 'ai-response')!.Detail!;
  renderWithKit(<Detail featureId="ai-response" condition={{ kind: 'default' }} detailRef={{ featureId: 'ai-response', ...detailRef }} host={host} />, { modules: widgets, store });
  return { store };
}
const writes = (backend: ReturnType<typeof service>['backend']) => backend.calls.filter(call => call.method !== 'GET' && !call.path.endsWith('draft-preview'));

it('fills the editor from a Navis or NAVER draft preview, labels its source and saves nothing until 초안 저장', async () => {
  const { backend, state } = service();
  const { store } = open(backend, { view: 'review' });
  const previewPath = `/marketing/inquiries/${ids.review}/navis-draft-preview`;
  const fact = '매장 주소는 상도로 1입니다.';
  const draft = `안녕하세요.\n${fact}\n감사합니다.`;
  backend.on('POST', previewPath, () => ({ text: draft, facts: [fact] }));
  const navis = await screen.findByRole('button', { name: 'Navis로 초안 쓰기' });
  const naver = screen.getByRole('button', { name: '네이버 초안 만들기' });
  expect(screen.getByText(/만든 초안은 미리보기예요/)).toBeInTheDocument();
  fireEvent.click(navis);
  fireEvent.click(navis);
  await waitFor(() => expect(screen.getByRole('textbox', { name: '답글 초안' })).toHaveValue(draft));
  expect(screen.getByText('Navis 초안')).toBeInTheDocument();
  expect(backend.callsTo('POST', previewPath)).toHaveLength(1);
  expect(state.log).toEqual([]);
  expect(writes(backend)).toHaveLength(0);
  fireEvent.click(naver);
  await waitFor(() => expect(screen.getByRole('textbox', { name: '답글 초안' })).toHaveValue('방문해 주셔서 감사합니다. 또 들러 주세요'));
  expect(screen.getByText('네이버 초안')).toBeInTheDocument();
  expect(screen.queryByText('Navis 초안')).toBeNull();
  // The owner edits the NAVER draft and saves it: it keeps its source and is still not posted.
  fireEvent.change(screen.getByRole('textbox', { name: '답글 초안' }), { target: { value: '방문해 주셔서 감사합니다. 라떼 맛있게 드셨다니 기뻐요' } });
  fireEvent.click(screen.getByRole('button', { name: '초안 저장하기' }));
  await waitFor(() => expect(backend.callsTo('PATCH', `/marketing/inquiries/${ids.review}/draft`)).toHaveLength(1));
  expect(backend.callsTo('PATCH', `/marketing/inquiries/${ids.review}/draft`)[0]!.body).toEqual({ text: '방문해 주셔서 감사합니다. 라떼 맛있게 드셨다니 기뻐요', draftSource: 'naver-ai', expectedRevision: 1 });
  await waitFor(() => expect(store.getSnapshot().tables.realInbox?.inquiries.find(row => row.id === ids.review)?.draft?.source).toBe('naver-ai'));
  expect(await screen.findByText('네이버 초안')).toBeInTheDocument();
  expect(backend.callsTo('POST', /reply$/)).toHaveLength(0);
});

it('blocks a public review reply with a phone number or email before anything is saved', async () => {
  const { backend } = service();
  open(backend, { view: 'review' });
  fireEvent.change(await screen.findByRole('textbox', { name: '답글 초안' }), { target: { value: '문의는 010-1234-5678로 주세요' } });
  expect(screen.getByText('전화번호나 이메일은 답글에 넣을 수 없어요')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '초안 저장하기' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: '답글 초안' }), { target: { value: '메일 owner@example.com' } });
  expect(screen.getByRole('button', { name: '초안 저장하기' })).toBeDisabled();
  expect(writes(backend)).toHaveLength(0);
});

it('keeps the owner text and offers a retry when a draft cannot be made, with only the Navis draft button on TalkTalk', async () => {
  const { backend } = service();
  backend.on('POST', /navis-draft-preview$/, () => reply(503, { code: 'PROVIDER_UNAVAILABLE' }));
  open(backend, { view: 'review' });
  const field = await screen.findByRole('textbox', { name: '답글 초안' });
  fireEvent.change(field, { target: { value: '제가 쓰던 글' } });
  fireEvent.click(screen.getByRole('button', { name: 'Navis로 초안 쓰기' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('초안을 만들지 못했어요');
  expect(within(alert).getByRole('button', { name: '다시 시도하기' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: '답글 초안' })).toHaveValue('제가 쓰던 글');
  cleanup();
  backend.on('GET', '/marketing/talktalk/consultations/tt-1', () => ({ ref: 'tt-1', status: 'waiting', messages: [] }));
  open(backend, { itemId: ids.talk });
  expect(await screen.findByRole('textbox', { name: '답변 초안' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Navis로 초안 쓰기' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '네이버 초안 만들기' })).toBeNull();
});

it('shows review AI statistics with the two-day lag and the average only when NAVER shows it', async () => {
  const { backend } = service();
  open(backend, { view: 'stats' });
  expect(await screen.findByText('이틀 전까지의 자료예요')).toBeInTheDocument();
  expect(screen.getByText('평균 별점 4.6')).toBeInTheDocument();
  expect(screen.getByText(/출처: 네이버 리뷰 AI 통계/)).toBeInTheDocument();
  expect(screen.getByText('긍정 4건 · 부정 1건')).toBeInTheDocument();
  expect(screen.getByText('고소한 라떼 · 3건')).toBeInTheDocument();
  expect(screen.getByText('좁은 자리 · 1건')).toBeInTheDocument();
  expect(backend.callsTo('GET', '/insight/review-insights').at(-1)!.query).toEqual({ unit: 'week' });
  fireEvent.click(screen.getByRole('radio', { name: '월별' }));
  await waitFor(() => expect(backend.callsTo('GET', '/insight/review-insights').at(-1)!.query).toEqual({ unit: 'month' }));
  expect(screen.queryByText(/예시|연결 대기/)).toBeNull();
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  cleanup();
  backend.on('GET', '/insight/review-insights', () => reviewInsights({ average: 'hidden', empty: true }));
  open(backend, { view: 'stats' });
  expect(await screen.findByText('이 기간에는 통계가 없어요')).toBeInTheDocument();
  expect(screen.queryByText(/평균 별점/)).toBeNull();
  cleanup();
  backend.on('GET', '/insight/review-insights', () => reply(503, { code: 'UNAVAILABLE' }));
  open(backend, { view: 'review' });
  expect(await screen.findByRole('textbox', { name: '답글 초안' })).toBeInTheDocument();
  expect(screen.queryByText(/평균 별점/)).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: '리뷰 AI 통계' }));
  expect(await screen.findByText('통계를 불러오지 못했어요')).toBeInTheDocument();
  backend.on('GET', '/insight/review-insights', () => reviewInsights());
  fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
  expect(await screen.findByText('이틀 전까지의 자료예요')).toBeInTheDocument();
});
