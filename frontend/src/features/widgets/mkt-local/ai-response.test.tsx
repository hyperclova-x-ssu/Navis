import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { readModel } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { aiResponseModule } from './ai-response';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const reviewDraft = '오래 기다리시게 해서 죄송해요.';
const editedReview = '기다리게 해 드려 죄송합니다.';
const messageDraft = '불편을 드려 죄송합니다.';
const aliases = [{ id: 'alias-1', label: '테스트 번호 1' }, { id: 'alias-2', label: '테스트 번호 2' }];
const host: WidgetHost = { layer: 'marketing', openClosing: () => true, openDetail() {}, openLinked() {}, resetPreview() {}, notify() {}, acknowledgeBriefing() {} };
/* The app runs on the cafe seed: the threads under test are read from the same model the widget shows, never copied. */
const ai = readModel(createWidgetDataStore().getSnapshot(), 'ai-response');
const bodyOf = (th: { readonly body: unknown }): string => (th.body as { readonly key: string }).key.replace(/^seed:/, '');
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstMessage = ai.priority.find((th) => th.type !== 'review')!;
const firstReview = ai.priority.find((th) => th.type === 'review')!;
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const send = () => screen.getByRole('button', { name: '테스트 문자 보내기' });
const preview = () => click('보낼 내용 확인하기');

function renderReply(view: 'message' | 'review' = 'review') {
  const Detail = aiResponseModule.Detail!;
  return renderWithKit(<Detail featureId="ai-response" condition={{ kind: 'default' }} detailRef={{ featureId: 'ai-response', view }} host={host} />);
}

function mockRoutes({ mode = 'fake', targets = aliases, draftResponse, sendResponse }: {
  mode?: 'off' | 'fake' | 'sens'; targets?: typeof aliases;
  draftResponse?: (id: string) => Promise<Response>; sendResponse?: () => Promise<Response>;
} = {}) {
  const sends = vi.fn();
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    switch (input) {
      case '/api/navis/reply-test-targets': return Response.json({ mode, targets });
      case '/api/navis/widget-drafts': {
        const { sampleId } = JSON.parse(init?.body as string);
        return draftResponse ? draftResponse(sampleId) : draft(sampleId);
      }
      case '/api/navis/reply-test-send':
        sends(JSON.parse(init?.body as string), new Headers(init?.headers).get('Idempotency-Key'));
        return sendResponse ? sendResponse() : Response.json({ status: 'simulated', receiptId: 'test' });
      default: throw new Error('Unexpected route');
    }
  });
  return { sends, transport };
}

const draft = (sampleId: string) => sampleId === 'th-empty' ? Response.json({ status: 'empty' }) : Response.json({
  draftId: sampleId, kind: 'reply', content: { body: sampleId === firstReview.threadId ? reviewDraft : messageDraft }, sourceLabels: ['예시 원문'],
});

async function generateReply() {
  click(new RegExp(escapeRe(bodyOf(firstReview).slice(0, 16))));
  click('답글 초안 만들기');
  const editor = await screen.findByRole('textbox', { name: '답글 초안' });
  await waitFor(() => expect(screen.getByRole('button', { name: '보낼 내용 확인하기' })).toBeEnabled());
  return editor;
}

it('generates the message and review variants, suppresses repeat generation, and preserves edits on error', async () => {
  let resolveDraft!: (response: Response) => void;
  const first = new Promise<Response>(resolve => { resolveDraft = resolve; });
  const draftResponse = vi.fn().mockReturnValueOnce(first)
    .mockResolvedValueOnce(Response.json({ code: 'TIMEOUT' }, { status: 504 }))
    .mockImplementation(async id => draft(id));
  mockRoutes({ draftResponse });
  renderReply('message');
  click('답변 초안 만들기');
  click('답변 초안 만들기');
  expect(screen.getByText('초안을 만들고 있어요')).toHaveAttribute('role', 'status');
  expect(draftResponse).toHaveBeenCalledExactlyOnceWith(firstMessage.threadId);
  resolveDraft(draft('th-1'));
  const editor = await screen.findByRole('textbox', { name: '답변 초안' });
  expect(editor).toHaveValue(messageDraft);
  fireEvent.change(editor, { target: { value: '말씀해 주신 내용을 확인하겠습니다.' } });
  click('답변 초안 만들기');
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('응답 시간이 초과됐어요');
  expect(editor).toHaveValue('말씀해 주신 내용을 확인하겠습니다.');
  fireEvent.click(within(alert).getByRole('button', { name: '다시 시도하기' }));
  await waitFor(() => expect(editor).toHaveValue(messageDraft));
  click('자료가 없는 예시');
  click('답변 초안 만들기');
  expect(await screen.findByText('초안을 만들 예시 자료가 없어요')).toBeVisible();
  expect(screen.getByRole('button', { name: '보낼 내용 확인하기' })).toBeDisabled();
  fireEvent.click(screen.getByRole('tab', { name: '리뷰' }));
  expect(await generateReply()).toHaveValue(reviewDraft);
});

it('cancels with no request and requires a new preview after text, target or draft changes', async () => {
  const { sends } = mockRoutes();
  renderReply();
  let editor = await generateReply();
  preview();
  expect(screen.getByRole('heading', { name: '보낼 내용 확인하기' })).toHaveFocus();
  click('닫기');
  expect(sends).not.toHaveBeenCalled();
  editor = screen.getByRole('textbox', { name: '답글 초안' });
  fireEvent.change(editor, { target: { value: editedReview } });
  fireEvent.click(screen.getByRole('radio', { name: '테스트 번호 2' }));
  expect(screen.queryByRole('button', { name: '테스트 문자 보내기' })).toBeNull();
  preview();
  expect(screen.getByText(editedReview)).toBeVisible();
  expect(screen.getByText('테스트 번호 2')).toBeVisible();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(sends).not.toHaveBeenCalled();
  click('답글 초안 만들기');
  expect(screen.queryByRole('button', { name: '테스트 문자 보내기' })).toBeNull();
  await waitFor(() => expect(screen.getByRole('textbox', { name: '답글 초안' })).toHaveValue(reviewDraft));
  preview();
  const confirm = send();
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(await screen.findByText('보냈어요(예시)')).toBeVisible();
  expect(sends).toHaveBeenCalledExactlyOnceWith({ draftId: firstReview.threadId, targetId: 'alias-2', body: reviewDraft, confirmed: true }, expect.any(String));
  expect(screen.getByText(`답변 대기 ${ai.waitingCount - 1}건 · 메시지 ${ai.byType.message} · 리뷰 ${ai.byType.review - 1}`)).toBeVisible();
});

it.each([['off', aliases], ['fake', []]] as const)('handles disabled send or no targets (%s)', async (mode, targets) => {
  const { sends } = mockRoutes({ mode, targets: [...targets] });
  renderReply();
  await generateReply();
  expect(screen.getByText('테스트 발송이 꺼져 있어요')).toBeVisible();
  expect(screen.queryByRole('radiogroup', { name: '테스트 받는 곳' })).toBeNull();
  preview();
  expect(send()).toBeDisabled();
  expect(screen.getByText('테스트 발송이 꺼져 있어요')).toBeVisible();
  fireEvent.click(send());
  expect(sends).not.toHaveBeenCalled();
});

it.each([
  [202, { status: 'accepted', receiptId: 'test' }, '테스트 문자 발송을 요청했어요'],
  [504, { code: 'SEND_UNKNOWN' }, '발송 결과를 확인해 주세요'],
  [503, { code: 'SEND_DISABLED' }, '테스트 발송이 꺼져 있어요'],
] as const)('shows the correct status for %s', async (status, payload, copy) => {
  const { sends } = mockRoutes({ mode: 'sens', sendResponse: async () => Response.json(payload, { status }) });
  renderReply();
  await generateReply();
  preview();
  fireEvent.click(send());
  expect(await screen.findByText(copy)).toBeVisible();
  if (status !== 202) expect(screen.getByRole('textbox', { name: '답글 초안' })).toHaveValue(reviewDraft);
  expect(sends).toHaveBeenCalledTimes(1);
});

it('shows reply validation under the editor and blocks another preview of the rejected text', async () => {
  const { sends } = mockRoutes({ sendResponse: async () => Response.json({ code: 'INVALID_REPLY' }, { status: 422 }) });
  renderReply();
  const editor = await generateReply();
  fireEvent.change(editor, { target: { value: '언제든 환불해 드립니다.' } });
  preview();
  fireEvent.click(send());
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('허용된 문장');
  expect(screen.getByRole('textbox', { name: '답글 초안' })).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('button', { name: '보낼 내용 확인하기' })).toBeDisabled();
  expect(sends).toHaveBeenCalledTimes(1);
});
