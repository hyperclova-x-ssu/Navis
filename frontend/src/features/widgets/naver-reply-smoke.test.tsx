import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { openWidget } from './mkt-local/parity-harness';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('completes one exact review edit in the example inbox without calling a provider', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const { store, notify } = openWidget('ai-response', 'Detail', 'example', { detailRef: { view: 'review' } });
  const question = '소금빵이 다 나가서 다음 나오는 시간까지 기다려야';
  const target = store.getSnapshot().tables.inquiryThread.find(row => row.bodyKey.includes(question))!;
  const read = () => store.getSnapshot().tables.inquiryThread.find(row => row.threadId === target.threadId);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(question) }));
  const editor = screen.getByRole('textbox', { name: '답글 초안' });
  const edited = '의견 남겨 주셔서 감사합니다.';
  fireEvent.change(editor, { target: { value: edited } });
  const send = screen.getByRole('button', { name: '답글 올리기' });
  expect(send).toBeDisabled();
  expect(read()?.replyDraft).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: '초안 저장' }));
  await waitFor(() => expect(send).toBeEnabled());
  expect(read()).toMatchObject({ replyDraft: { body: edited } });
  expect(read()?.status).not.toBe('done');
  await act(async () => { send.click(); send.click(); });
  expect(screen.getByRole('status')).toHaveTextContent('답변함');
  expect(screen.getByText(edited)).toBeVisible();
  expect(read()).toMatchObject({ status: 'done', replyDraft: { body: edited } });
  expect(notify).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
});
