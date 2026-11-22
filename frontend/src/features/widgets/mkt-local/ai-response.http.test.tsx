import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { reply } from '../../../data/reality/00/testing';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { ids, service } from '../../../data/reality/15/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';

afterEach(cleanup);

function open(backend: ReturnType<typeof service>['backend'], detailRef: { itemId?: string; view?: string } = {}) {
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'inbox' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const notify = vi.fn();
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify, acknowledgeBriefing() {} };
  const Detail = widgets.find(widget => widget.id === 'ai-response')!.Detail!;
  renderWithKit(<Detail featureId="ai-response" condition={{ kind: 'default' }} detailRef={{ featureId: 'ai-response', ...detailRef }} host={host} />, { modules: widgets, store });
  return { store, notify };
}
const writes = (backend: ReturnType<typeof service>['backend']) => backend.calls.filter(call => call.method !== 'GET');

it('lists the service records and sends nothing until a button is pressed', async () => {
  const { backend } = service();
  backend.on('GET', `/marketing/talktalk/consultations/tt-1`, () => ({ ref: 'tt-1', status: 'waiting', messages: [{ text: '손님이 보낸 원문', from: 'user' }] }));
  open(backend);
  expect(await screen.findAllByText('일요일에도 문 여나요?')).not.toHaveLength(0);
  expect(await screen.findByText(/손님이 보낸 원문/)).toBeInTheDocument();
  expect(screen.getByText(/^답변 대기 3건 · 메시지/)).toBeInTheDocument();
  expect(screen.queryByText(/예시|연결 대기|시연/)).toBeNull();
  expect(writes(backend)).toHaveLength(0);
});

it('saves a draft, then records the reply once on a double press, and the sent reply is there in a new session', async () => {
  const { backend, state } = service();
  backend.on('GET', `/marketing/talktalk/consultations/tt-1`, () => ({ ref: 'tt-1', status: 'waiting', messages: [] }));
  const { store, notify } = open(backend);
  const field = await screen.findByRole('textbox', { name: '답변 초안' });
  const send = screen.getByRole('button', { name: '톡톡으로 답변 보내기' });
  expect(send.closest('.mkt-reply-footer')).toBeInTheDocument();
  expect(send).toBeDisabled();
  fireEvent.change(field, { target: { value: '일요일은 쉬어요' } });
  expect(screen.getByText('초안을 저장한 뒤에 보낼 수 있어요')).toBeInTheDocument();
  expect(send).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '초안 저장' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '톡톡으로 답변 보내기' })).toBeEnabled());
  expect(state.log).toEqual([]);
  expect(writes(backend).map(call => call.method + ' ' + call.path)).toEqual([`PATCH /marketing/inquiries/${ids.talk}/draft`]);
  const button = screen.getByRole('button', { name: '톡톡으로 답변 보내기' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(await screen.findByText('톡톡에서 받았어요')).toBeInTheDocument();
  expect(backend.callsTo('POST', `/marketing/inquiries/${ids.talk}/reply`)).toHaveLength(1);
  expect(state.log).toEqual(['approval:inquiry.post:press', 'action:inquiry.post']);
  expect(screen.getByText('일요일은 쉬어요')).toBeInTheDocument();
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.real.inbox.replyDone' }));
  expect(store.getSnapshot().tables.inquiryThread.find(row => row.threadId === ids.talk)?.status).toBe('done');
  cleanup();
  open(backend, { itemId: ids.talk });
  expect(await screen.findByText('일요일은 쉬어요')).toBeInTheDocument();
});

it('shows the review author-notification sentence from the service and asks twice before removing a reply', async () => {
  const { backend, state } = service();
  open(backend, { view: 'review' });
  expect(await screen.findByText('답글을 올리면 리뷰 작성자에게 알림이 가요.')).toBeInTheDocument();
  // T-52 (D-381/D-382, W21-F9): before the press, the same line also says not to write personal information.
  expect(screen.getByText('개인정보는 적지 않아요')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: '답글 초안' }), { target: { value: '감사합니다' } });
  fireEvent.click(screen.getByRole('button', { name: '초안 저장' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '답글 올리기' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '답글 올리기' }));
  fireEvent.click(await screen.findByRole('button', { name: '답글 지우기' }));
  expect(screen.getByText(/이 리뷰 답글을 지울까요/)).toBeInTheDocument();
  expect(backend.callsTo('DELETE', /reply/)).toHaveLength(0);
  state.log.length = 0;
  fireEvent.click(screen.getByRole('button', { name: '네, 지울게요' }));
  await waitFor(() => expect(backend.callsTo('DELETE', /reply/)).toHaveLength(1));
  expect(state.log).toEqual(['approval:inquiry.deleteReply:press', 'approval:inquiry.deleteReply:confirm', 'action:inquiry.deleteReply']);
});

it('records a typed inquiry and takes a visible NAVER review into the queue', async () => {
  const { backend } = service();
  open(backend);
  fireEvent.click(await screen.findByRole('button', { name: '문의 직접 적기' }));
  fireEvent.change(screen.getByRole('textbox', { name: /제목/ }), { target: { value: '단체 예약' } });
  fireEvent.change(screen.getByRole('textbox', { name: '받은 내용' }), { target: { value: '10명 가능한가요?' } });
  fireEvent.click(screen.getByRole('button', { name: '기록하기' }));
  await waitFor(() => expect(backend.callsTo('POST', '/marketing/inquiries')).toHaveLength(1));
  expect(backend.callsTo('POST', '/marketing/inquiries')[0]!.body).toEqual({ source: 'manual', type: 'message', title: '단체 예약', text: '10명 가능한가요?' });
  // The created record is read back from the service and opens in the reply pane (not only as a list excerpt).
  expect(await screen.findAllByText('10명 가능한가요?')).not.toHaveLength(0);
  expect(screen.getByRole('button', { name: /단체 예약 · 10명 가능한가요\?/ })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('textbox', { name: '답변 초안' })).toHaveValue('');
});

it('shows a failed read as an error with a retry instead of an empty list', async () => {
  const { backend } = service();
  backend.on('GET', '/marketing/inquiries', () => ({ status: 503, body: { code: 'UNAVAILABLE' } }));
  open(backend);
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.queryByText('일요일에도 문 여나요?')).toBeNull();
});

// FIX-PKG-C T-19 (W21-B4): the delete confirm is its own Esc step (the detail window presses its data-esc-close button), not a close of the whole window.
it('makes the reply delete confirm one Esc step that backs out and returns focus to the delete button', async () => {
  const { backend } = service();
  open(backend, { view: 'review' });
  await screen.findByText('답글을 올리면 리뷰 작성자에게 알림이 가요.');
  fireEvent.change(screen.getByRole('textbox', { name: '답글 초안' }), { target: { value: '감사합니다' } });
  fireEvent.click(screen.getByRole('button', { name: '초안 저장' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '답글 올리기' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '답글 올리기' }));
  fireEvent.click(await screen.findByRole('button', { name: '답글 지우기' }));
  const layer = screen.getByRole('group', { name: '답글 지우기' });
  expect(layer).toHaveAttribute('data-esc-layer');
  const close = layer.querySelector<HTMLElement>('[data-esc-close]');
  expect(close).toHaveTextContent('그대로 두기');
  fireEvent.click(close!);
  expect(screen.queryByRole('group', { name: '답글 지우기' })).toBeNull();
  await waitFor(() => expect(screen.getByRole('button', { name: '답글 지우기' })).toHaveFocus());
  expect(backend.callsTo('DELETE', /reply/)).toHaveLength(0);
});

// FIX-PKG-C T-18 (W21-H5): the tab comes back when the window is reopened without a requested view (a Navis card's view still wins).
it('reopens on the tab the owner left, and a requested view still wins', async () => {
  const { backend } = service();
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'inbox' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify: vi.fn(), acknowledgeBriefing() {} };
  const Detail = widgets.find(widget => widget.id === 'ai-response')!.Detail!;
  const mount = (view?: string) => renderWithKit(<Detail featureId="ai-response" condition={{ kind: 'default' }} detailRef={{ featureId: 'ai-response', ...(view ? { view } : {}) }} host={host} />, { modules: widgets, store });
  mount();
  fireEvent.click(await screen.findByRole('tab', { name: '리뷰' }));
  expect(screen.getByRole('tab', { name: '리뷰' })).toHaveAttribute('aria-selected', 'true');
  cleanup();
  mount();
  expect(await screen.findByRole('tab', { name: '리뷰' })).toHaveAttribute('aria-selected', 'true');
  cleanup();
  mount('message');
  expect(await screen.findByRole('tab', { name: '메시지' })).toHaveAttribute('aria-selected', 'true');
});

// FIX leftover (gate r1a W21 K9): a refused TalkTalk reply reads "실행하지 못했어요 · {이유}. {다음}", never the bare reason, and the draft stays.
it.each([
  ['REPLY_NOT_ALLOWED', '실행하지 못했어요 · 이 상담에는 답할 수 없어요. 최신 내용을 확인해 주세요'],
  ['REPLY_ALREADY_RECORDED', '실행하지 못했어요 · 이미 답변을 마친 문의예요. 최신 내용을 확인해 주세요'],
  ['DRAFT_REQUIRED', '실행하지 못했어요 · 먼저 답변 초안을 저장해 주세요'],
])('says what was refused and what to do when the TalkTalk reply is refused (%s)', async (code, line) => {
  const { backend } = service();
  backend.on('GET', `/marketing/talktalk/consultations/tt-1`, () => ({ ref: 'tt-1', status: 'waiting', messages: [] }));
  backend.on('POST', `/marketing/inquiries/${ids.talk}/reply`, () => reply(409, { code }));
  open(backend);
  fireEvent.change(await screen.findByRole('textbox', { name: '답변 초안' }), { target: { value: '일요일은 쉬어요' } });
  fireEvent.click(screen.getByRole('button', { name: '초안 저장' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '톡톡으로 답변 보내기' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '톡톡으로 답변 보내기' }));
  expect(await screen.findByText(line)).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '답변 초안' })).toHaveValue('일요일은 쉬어요');
});
