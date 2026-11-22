import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../../data/db/store';
import { readModel } from '../../../data/widget-data';
import { openWidget } from './parity-harness';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([
  ['message', '답변 초안', '톡톡으로 답변 보내기', '찾아 주셔서 감사해요. 오늘은 오후 8시까지 문을 열어요.'],
  ['review', '답글 초안', '답글 올리기', '정성스러운 리뷰 고맙습니다. 다음에도 들러 주세요! ☕'],
] as const)('saves and completes one local %s reply only on the two owner presses', async (view, label, reply, body) => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const store = createWidgetDataStore();
  const initial = store.getSnapshot();
  const thread = initial.tables.inquiryThread.find(row => row.type === view && row.status === 'waiting')!;
  expect(thread).toBeDefined();
  const read = () => store.getSnapshot().tables.inquiryThread.find(row => row.threadId === thread.threadId);
  const waiting = () => readModel(store.getSnapshot(), 'ai-response').waitingCount;
  const initialWaiting = waiting();
  const detailRef = { view, itemId: thread.threadId, focus: 'action' } as const;
  const opened = openWidget('ai-response', 'Detail', 'example', { store, detailRef });
  const field = screen.getByRole('textbox', { name: label });
  const save = () => screen.getByRole('button', { name: '초안 저장하기' });
  const send = () => screen.getByRole('button', { name: reply });

  await waitFor(() => expect(field).toHaveFocus());
  expect(save()).toBeDisabled();
  expect(send()).toBeDisabled();
  fireEvent.change(field, { target: { value: body } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(store.getSnapshot()).toBe(initial);
  expect(send()).toHaveProperty('disabled', view === 'review');

  await act(async () => { const button = save(); button.click(); button.click(); });
  expect(read()).toMatchObject({ status: 'waiting', replyDraft: { body, revision: 2 } });
  expect(waiting()).toBe(initialWaiting);
  expect(opened.notify).toHaveBeenCalledTimes(1);
  expect(save()).toBeDisabled();
  expect(send()).toBeEnabled();

  fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value: `${body} 고친 내용` } });
  expect(send()).toHaveProperty('disabled', view === 'review');
  opened.unmount();
  const reopened = openWidget('ai-response', 'Detail', 'example', { store, detailRef });
  expect(screen.getByRole('textbox', { name: label })).toHaveValue(body);
  await act(async () => { const button = send(); button.click(); button.click(); });
  expect(read()).toMatchObject({ status: 'done', replyDraft: { body, revision: 2 } });
  expect(waiting()).toBe(initialWaiting - 1);
  expect(reopened.notify).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status')).toHaveTextContent('답변함');
  expect(screen.getByText(body)).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps the saved draft and waiting count when the example send fails', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const { store, notify } = openWidget('ai-response', 'Detail', 'example', {
    modules: { preview: { family: 'normal', overrides: { 'ai-response': 'send-failure' } } },
  });
  const body = '문의해 주신 내용을 확인했어요.';
  const waiting = () => readModel(store.getSnapshot(), 'ai-response').waitingCount;
  const count = waiting();
  const editor = () => screen.getByRole('textbox', { name: '답변 초안' });
  fireEvent.change(editor(), { target: { value: body } });
  fireEvent.click(screen.getByRole('button', { name: '초안 저장하기' }));
  const send = screen.getByRole('button', { name: '톡톡으로 답변 보내기' });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('보내지 못했어요. 채널이 응답하지 않아요');
  expect(within(alert).getByRole('button', { name: '다시 시도하기' })).toBeEnabled();
  expect(editor()).toHaveValue(body);
  expect(waiting()).toBe(count);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});
