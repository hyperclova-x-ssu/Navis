import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { inboxClock as noticeClock } from '../../../data/reality/15/hooks';
import { reply } from '../../../data/reality/00/testing';
import { closureId, ids, service } from '../../../data/reality/15/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { createNoticeWidget } from './module';

afterEach(cleanup);
beforeEach(() => { noticeClock.now = () => new Date('2026-11-21T03:00:00.000Z'); }); // 12:00 in Seoul
const widget = createNoticeWidget('notice-send', () => ({ view: { status: 'empty' }, port: {} as never }));

function open(backend: ReturnType<typeof service>['backend'], detailRef: { itemId?: string; view?: string } = {}, seed?: (store: ReturnType<typeof createWidgetDataStore>) => void) {
  const store = createWidgetDataStore();
  seed?.(store);
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'inbox' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const notify = vi.fn();
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify, acknowledgeBriefing() {} };
  const Detail = widget.Detail!;
  renderWithKit(<Detail featureId="notice-send" condition={{ kind: 'default' }} detailRef={{ featureId: 'notice-send', ...detailRef }} host={host} />, { modules: [widget], store });
  return { store, notify };
}

it('records a manual notice once from the button and shows it in the sent history after a new session', async () => {
  const { backend, state } = service();
  open(backend, { itemId: ids.notice });
  const send = await screen.findByRole('button', { name: '직접 알렸다고 기록하기' });
  expect(screen.getByRole('tab', { name: '공지 작성' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '공지 제목' })).toHaveValue('휴무 안내');
  expect(send.closest('.i7-notice-footbar')).toBeInTheDocument();
  expect(send).toBeDisabled();
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  await waitFor(() => expect(send).toBeEnabled());
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  fireEvent.click(send);
  fireEvent.click(send);
  await waitFor(() => expect(state.log).toEqual(['approval:notice.attest:press', 'action:notice.attest']));
  expect(backend.callsTo('POST', `/marketing/notices/${ids.notice}/attestation`)).toHaveLength(1);
  expect(await screen.findByText('직접 알렸다고 기록했어요')).toBeInTheDocument();
  cleanup();
  open(backend, { view: 'history' });
  expect(await screen.findByText('휴무 안내')).toBeInTheDocument();
  expect(screen.getByText('직접 알렸다고 기록했어요')).toBeInTheDocument();
});

it('previews a new TalkTalk notice without writes and sends it once on the owner press, FAKE', async () => {
  const { backend, state } = service();
  open(backend);
  fireEvent.click(await screen.findByRole('radio', { name: '톡톡 마케팅' }));
  fireEvent.change(screen.getByRole('textbox', { name: /제목/ }), { target: { value: '신메뉴' } });
  fireEvent.change(screen.getByRole('textbox', { name: '공지 내용' }), { target: { value: '새 메뉴가 나왔어요' } });
  expect(screen.getByRole('button', { name: '임시 저장하기' })).toBeDisabled(); // an audience is required
  fireEvent.click(await screen.findByRole('radio', { name: '혜택 알림받기 손님 · 12명' }));
  expect(screen.getByText('이번 달 배정 3건')).toBeInTheDocument();
  expect(screen.queryByText(/남은/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  expect(await screen.findByText('새 메뉴가 나왔어요', { selector: '.i7-notice-preview-body' })).toBeInTheDocument();
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  expect(state.log).toEqual([]);
  const send = await screen.findByRole('button', { name: '톡톡으로 보내기' });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  fireEvent.click(send);
  await waitFor(() => expect(state.log).toEqual(['approval:notice.send:press', 'action:notice.send']));
  expect(backend.callsTo('POST', '/marketing/notices')).toHaveLength(1);
  expect(backend.callsTo('POST', '/marketing/notices')[0]!.body).toMatchObject({ title: '신메뉴', text: '새 메뉴가 나왔어요', channel: 'talktalk', audience: 'benefit-subscribers' });
  expect(backend.callsTo('POST', /\/marketing\/notices\/[^/]+\/send$/)).toHaveLength(1);
  expect(await screen.findByText('톡톡이 받았어요')).toBeInTheDocument();
});

it('previews an edited notice without saving it until the explicit save press', async () => {
  const { backend } = service();
  open(backend, { itemId: ids.notice });
  fireEvent.change(await screen.findByRole('textbox', { name: '공지 내용' }), { target: { value: '내용을 고쳤어요' } });
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  expect(await screen.findByText('내용을 고쳤어요', { selector: '.i7-notice-preview-body' })).toBeInTheDocument();
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '임시 저장하기' }));
  expect(await screen.findByText('임시 저장했어요')).toBeInTheDocument();
  expect(backend.callsTo('PATCH', `/marketing/notices/${ids.notice}/draft`)).toHaveLength(1);
});

it('holds a night TalkTalk send until tomorrow 8 (the SMS channel offers only a tomorrow-8 reservation, see sms.test.tsx)', async () => {
  noticeClock.now = () => new Date('2026-11-20T18:00:00.000Z'); // 03:00 in Seoul
  const { backend } = service();
  open(backend, { itemId: ids.notice });
  fireEvent.click(await screen.findByRole('radio', { name: '톡톡 마케팅' }));
  expect(screen.getByText(/내일 8시부터 보낼 수 있어요/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '톡톡으로 보내기' })).toBeDisabled();
});

it('asks twice before deleting a draft and offers the undo from the receipt', async () => {
  const { backend, state } = service();
  const { notify } = open(backend, { itemId: ids.notice });
  fireEvent.click(await screen.findByRole('button', { name: '임시 저장 지우기' }));
  expect(screen.getByText('공지 초안을 지울까요?')).toBeInTheDocument();
  expect(backend.callsTo('DELETE', /draft/)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '초안 지우기' }));
  await waitFor(() => expect(state.log).toEqual(['approval:notice.deleteDraft:press', 'approval:notice.deleteDraft:confirm', 'action:notice.deleteDraft']));
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ messageKey: 'data.notices.notice.deleted', undoToken: expect.stringMatching(/^real-undo:/), undoUntil: expect.any(String) })));
});

it('asks for a fresh calendar import when the closure moved and does not allow the send', async () => {
  const { backend, state } = service();
  state.notices = state.notices.map(row => row.id === ids.notice ? { ...row, closure: { eventId: closureId, revision: 2 } } : row);
  open(backend, { itemId: ids.notice }, store => store.hydrate({ calendarEvent: [{ eventId: closureId, revision: 3, kind: 'event', categoryId: 'store-operations', date: '2026-11-22', time: null,
    title: { raw: '임시 휴무' }, memo: { raw: '정비' }, storeClosure: { kind: 'temporary', endDate: '2026-11-22' } }] }));
  expect(await screen.findByRole('alert')).toHaveTextContent('휴무 일정이 바뀌었어요. 공지 초안에 다시 가져와 주세요');
  expect(screen.getByRole('button', { name: '직접 알렸다고 기록하기' })).toBeDisabled();
});

const staleSeed = (state: ReturnType<typeof service>['state']) => { state.notices = state.notices.map(row => row.id === ids.notice ? { ...row, closure: { eventId: closureId, revision: 2 } } : row); };
const movedClosure = (store: ReturnType<typeof createWidgetDataStore>) => store.hydrate({ calendarEvent: [{ eventId: closureId, revision: 3, kind: 'event', categoryId: 'store-operations', date: '2026-11-22', time: null,
  title: { raw: '임시 휴무' }, memo: { raw: '정비' }, storeClosure: { kind: 'temporary', endDate: '2026-11-22' } }] });

// FIX-PKG-C T-11 (W27-F2 / P4 / R3): saving a stale draft that was not edited sends nothing, so it must not say "임시 저장했어요".
it('does not say saved for a stale draft that was not edited: no write, the re-import offer takes focus', async () => {
  const { backend, state } = service();
  staleSeed(state);
  open(backend, { itemId: ids.notice }, movedClosure);
  expect(await screen.findByRole('alert')).toHaveTextContent('휴무 일정이 바뀌었어요. 공지 초안에 다시 가져와 주세요');
  fireEvent.click(screen.getByRole('button', { name: '임시 저장하기' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '캘린더에서 다시 가져오기' })).toHaveFocus());
  expect(screen.queryByText('임시 저장했어요')).toBeNull();
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

it('still saves and says saved when a stale draft was edited (a real write happened)', async () => {
  const { backend, state } = service();
  staleSeed(state);
  open(backend, { itemId: ids.notice }, movedClosure);
  await screen.findByRole('alert');
  fireEvent.change(screen.getByRole('textbox', { name: '공지 내용' }), { target: { value: '내용을 고쳤어요' } });
  fireEvent.click(screen.getByRole('button', { name: '임시 저장하기' }));
  expect(await screen.findByText('임시 저장했어요')).toBeInTheDocument();
  expect(backend.callsTo('PATCH', `/marketing/notices/${ids.notice}/draft`)).toHaveLength(1);
});

// FIX-PKG-C T-17 (W27-K9): a refused write says what was refused and what to do (PKG-F failure copy), not only "처리하지 못했어요".
it('shows the reason and the next step when the service refuses the draft save', async () => {
  const { backend } = service();
  backend.on('PATCH', `/marketing/notices/${ids.notice}/draft`, () => reply(400, { code: 'VALIDATION' }));
  open(backend, { itemId: ids.notice });
  fireEvent.change(await screen.findByRole('textbox', { name: '공지 내용' }), { target: { value: '내용을 고쳤어요' } });
  fireEvent.click(screen.getByRole('button', { name: '임시 저장하기' }));
  expect(await screen.findByText(/^실행하지 못했어요 · /)).toBeInTheDocument();
  expect(screen.queryByText('처리하지 못했어요. 다시 시도해 주세요')).toBeNull();
  expect(screen.queryByText('임시 저장했어요')).toBeNull();
});
