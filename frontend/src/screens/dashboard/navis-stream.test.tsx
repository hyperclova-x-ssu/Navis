import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { beginDashboard } from '../../app/test-session';
import type { Locale, RunStore } from '../../contracts';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { createRunStore } from '../../state';
import { timePolicy } from '../../ui';
import { KitProviders } from '../../ui/test-utils';
import { createWidgetDataStore, readModel } from '../../data/widget-data';
import { navisTranslator } from '../../features/assistant/messages';
import { controlledResponse } from '../../features/assistant/stream-fixture';
import { AGENT_PROTOCOL_HEADER, type AgentRequest } from '../../../shared/navis-agent-schema.mjs';
import { DashboardNavis } from './navis';
import type { DashboardController } from './controller';

const currentSales = (locale: Locale = 'ko') => navisTranslator(locale).format.money(
  readModel(createWidgetDataStore().getSnapshot(), 'ledger').sales.net, 'compact');
const runs: RunStore[] = [];
let streams: ReturnType<typeof controlledResponse>[] = [];
/** What the screen showed right after each React commit (C-1: the answer and the cards must share one commit). */
const commits: { answer: boolean; cards: boolean; waiting: boolean }[] = [];
const shown = () => ({ answer: !!document.querySelector('[data-role=assistant] .ai-conversation__answer'), cards: !!document.querySelector('[data-role=assistant] .ai-candidate'), waiting: !!document.querySelector('.ai-wait') });
const flush = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => {
  vi.useFakeTimers(); streams = []; commits.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    const protocol = new Headers(options?.headers).get(AGENT_PROTOCOL_HEADER);
    const stream = controlledResponse(protocol ? { [AGENT_PROTOCOL_HEADER]: protocol } : undefined);
    streams.push(stream);
    return stream.response;
  }));
});
afterEach(() => { cleanup(); for (const run of runs.splice(0)) run.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function host(locale: Locale = 'ko', reducedMotion = true) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => Date.now(), reducedMotion: true });
  runs.push(run); beginDashboard(run, 'cafe'); run.actions.dismissCoach(); run.actions.setLocale(locale);
  const tap = vi.fn();
  render(<KitProviders locale={locale} reducedMotion={reducedMotion} store={createWidgetDataStore(undefined, { runId: run.getState().runId })}><Profiler id="navis" onRender={() => commits.push(shown())}><DashboardNavis run={run} controller={{ tap } as unknown as DashboardController} readRect={() => ({ x: 0, y: 0, width: 1, height: 1 })} dragging={false} visible onShowPanel={() => {}} onCreated={() => {}} /></Profiler></KitProviders>);
  fireEvent.click(screen.getByRole('button', { name: /Navis/ }));
  const send = (text: string) => { fireEvent.change(screen.getByRole('textbox'), { target: { value: text } }); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }); };
  const bubble = () => document.querySelectorAll('[data-role=assistant]');
  return { run, tap, send, bubble };
}
it('keeps streamed words off screen, then shows the answer and the valid cards in one commit with no board writes', async () => {
  const { run, tap, send, bubble } = host('ko', false); const before = run.getState();
  send('오늘 얼마 벌었어?'); expect(screen.queryByText('생각 중이에요')).toBeNull();
  expect(document.querySelector('.ai-wait')).toBeNull();
  expect(screen.getByRole('button', { name: '요청 보내기' })).toBeEnabled();
  streams[0].frame('text_delta', { delta: '오늘 매출은 ' }); await flush();
  await advance(300);
  expect(bubble()).toHaveLength(1); expect(document.querySelector('.ai-wait__step')).toHaveTextContent('생각 중이에요');
  expect(document.body).not.toHaveTextContent('오늘 매출은');
  const scroll = document.querySelector('.ai-conversation__body')!;
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { configurable: true, value: 400 } });
  scroll.scrollTop = 100; fireEvent.scroll(scroll);
  streams[0].frame('text_delta', { delta: '128.4만 원이에요' }); streams[0].frame('panels', { panels: [{ featureId: 'ledger', size: { width: 1, height: 1 }, reason: '매출' }, { featureId: 'demand', size: { width: 1, height: 1 }, reason: '무효' }] }); await flush();
  expect(document.body).not.toHaveTextContent('128.4만 원이에요'); expect(screen.queryByText('추천 패널')).toBeNull();
  expect(screen.queryByRole('button', { name: '새 답변 보기' })).toBeNull();
  commits.length = 0;
  streams[0].frame('done', {}); await flush();
  expect(bubble()).toHaveLength(1); expect(screen.getByText('오늘 매출은 128.4만 원이에요')).toBeInTheDocument();
  expect(screen.getByText('추천 패널')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '답 멈추기' })).toBeNull();
  expect(commits.find(commit => commit.answer || commit.cards)).toEqual({ answer: true, cards: true, waiting: false });
  expect(commits.every(commit => commit.answer === commit.cards)).toBe(true);
  expect(bubble()[0].querySelector('.ai-conversation__reveal')).toHaveAttribute('data-fade', 'true');
  expect(scroll.scrollTop).toBe(100);
  const completed = bubble()[0] as HTMLElement;
  Object.defineProperties(completed, { offsetHeight: { value: 850 }, offsetTop: { value: 700 } });
  expect(document.activeElement).not.toBe(completed);
  fireEvent.click(screen.getByRole('button', { name: '새 답변 보기' }));
  expect(scroll.scrollTop).toBe(700);
  expect(completed).toHaveFocus();
  expect(screen.queryByRole('button', { name: '새 답변 보기' })).toBeNull();
  expect(run.getState().boards).toEqual(before.boards); expect(run.getState().layoutRevision).toBe(before.layoutRevision); expect(run.getState().undo).toEqual(before.undo); expect(tap).not.toHaveBeenCalled();
});

it('reveals only the answer when the reply has no panels and uses the reduced variant', async () => {
  const { send, bubble } = host('ko', true);
  send('우주 여행 가고 싶어');
  streams[0].frame('text_delta', { delta: '그건 아직 잘 몰라요.' }); streams[0].frame('panels', { panels: [] }); await flush();
  expect(document.body).not.toHaveTextContent('그건 아직 잘 몰라요.');
  streams[0].frame('done', {}); await flush();
  expect(screen.getByText('그건 아직 잘 몰라요.')).toBeInTheDocument();
  expect(screen.queryByText('추천 패널')).toBeNull(); expect(document.querySelector('.ai-candidate')).toBeNull();
  expect(bubble()[0].querySelector('.ai-conversation__reveal')).toHaveAttribute('data-fade', 'true');
  expect(bubble()[0].closest('.ai-conversation')).toHaveAttribute('data-motion', 'reduced');
  expect(screen.queryByText('답을 정리하고 있어요')).toBeNull();
});

it('waits 300 ms, then holds the still line until a real status or ten seconds without progress', async () => {
  const { send } = host();
  send('재고 알려줘');
  const line = () => document.querySelector('.ai-wait__step');
  await advance(299); expect(line()).toBeNull();
  await advance(1); expect(line()).toHaveTextContent('생각 중이에요');
  expect(document.querySelectorAll('.ai-wait__dots span')).toHaveLength(3);
  await advance(9699); expect(line()).toHaveTextContent('생각 중이에요');
  await advance(1); expect(screen.getByText('답이 늦어지고 있어요', { selector: 'p' })).toBeInTheDocument();
});

it('escapes IME, then stops once, then closes the chat', async () => {
  const { send } = host(); send('매출'); await flush();
  const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
  expect(screen.getByRole('button', { name: '답 멈추기' })).toBeInTheDocument();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Navis 닫기' })).toBeInTheDocument();
  expect(screen.getByText('답을 멈췄어요', { selector: 'p' })).toBeInTheDocument();
  expect(streams[0].cancelled).toBe(true);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Navis 열기' })).toBeInTheDocument();
});

it('shows the text of a stream that fails after some text arrived, in one reveal', async () => {
  const { send, bubble } = host();
  send('우주 여행 가고 싶어');
  streams[0].frame('text_delta', { delta: '여기까지 받은 답이에요.' }); await flush();
  expect(document.body).not.toHaveTextContent('여기까지 받은 답이에요.');
  commits.length = 0; streams[0].close(); await flush();
  expect(screen.getByText('여기까지 받은 답이에요.')).toBeInTheDocument();
  expect(bubble()[0].querySelector('.ai-wait')).toBeNull(); expect(screen.queryByText('답을 멈췄어요')).toBeNull();
  expect(commits.every(commit => !commit.waiting || !commit.answer)).toBe(true);
});

const inventoryCandidate = { featureId: 'inventory-booking', size: { width: 2, height: 1 }, reason: '재고 확인' };
const modelDenial = '재고 위젯 추가는 앱 내에서 직접 할 수 없습니다.';

function finishLayout() {
  const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as AgentRequest;
  if (request.intent.kind !== 'command') throw new Error('Expected layout command');
  streams[0].frame('action_proposal', { command: request.intent.command, args: request.intent.args, proposalId: 'layout-stream',
    tier: 'normal', runId: request.runId, layer: request.layer, page: request.page, snapshotRevision: request.snapshotRevision });
  streams[0].frame('done', { outcome: 'proposal' });
}

it('keeps the waiting line until a verified placement card is ready for approval', async () => {
  const { run, send, bubble } = host();
  send('재고 위젯 2x1로 추가해줘');
  streams[0].frame('text_delta', { delta: modelDenial }); await advance(300);
  expect(bubble()[0].querySelector('.ai-wait__step')).toHaveTextContent('생각 중이에요');
  streams[0].frame('status', { step: 'read_started', featureId: 'inventory-booking' }); await flush();
  expect(bubble()[0].querySelector('.ai-wait__step')).toHaveTextContent('재고');
  streams[0].frame('status', { step: 'assembling' }); await flush();
  expect(bubble()[0].querySelector('.ai-wait__step')).toHaveTextContent('답을 정리하고 있어요');
  expect(bubble()[0]).not.toHaveTextContent(modelDenial);
  expect(run.getState().panels).toEqual([]);

  streams[0].frame('panels', { panels: [] });
  finishLayout(); await flush();
  const answer = bubble()[0] as HTMLElement;
  expect(answer.querySelector('.ai-conversation__answer')).toBeNull();
  expect(answer.querySelector('.ai-wait')).toBeNull();
  expect(run.getState().panels).toEqual([]);
  fireEvent.click(within(answer).getByRole('button', { name: '패널 놓기' }));
  expect(run.getState().panels).toMatchObject([{ featureId: 'inventory-booking', width: 2, height: 1 }]);
});

it('places only the explicitly requested widget after a card press, with no text deltas', async () => {
  const { run, send, bubble } = host();
  send('재고 위젯 2x1로 추가해줘');
  const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as AgentRequest;
  expect(request.intent).toMatchObject({ kind: 'command', command: 'layout.add_widget', args: { featureId: 'inventory-booking' } });
  streams[0].frame('panels', { panels: [] });
  await flush();
  expect(run.getState().panels).toEqual([]);

  finishLayout(); await flush();
  const answer = bubble()[0] as HTMLElement;
  expect(run.getState().panels).toEqual([]);
  fireEvent.click(within(answer).getByRole('button', { name: '패널 놓기' }));
  expect(run.getState().panels).toMatchObject([{ featureId: 'inventory-booking', width: 2, height: 1 }]);
  expect(within(answer).getByText('변경을 적용했어요')).toBeInTheDocument();
  expect(bubble()[0].querySelector('.ai-conversation__answer')).toBeNull();
});

it.each([
  { kind: 'no text deltas', delta: undefined },
  { kind: 'whitespace-only text', delta: ' \n ' },
])('shows a finished answer with its cards and keeps it in history with $kind', async ({ delta }) => {
  const { run, send, bubble } = host();
  const question = '재고 위젯이 뭐야?';
  const fixedLine = '요청한 데이터가 없어요. 다른 기간이나 내용을 요청해 주세요';
  send(question); await advance(10000);
  if (delta !== undefined) streams[0].frame('text_delta', { delta });
  streams[0].frame('panels', { panels: [inventoryCandidate] }); await flush();
  expect(screen.getByText('답이 늦어지고 있어요', { selector: 'p' })).toBeInTheDocument();
  expect(screen.queryByText('추천 패널')).toBeNull();

  streams[0].frame('done', {}); await flush();
  const answer = within(bubble()[0] as HTMLElement);
  expect(answer.getAllByText(fixedLine)).toHaveLength(1);
  expect(answer.getByText('추천 패널')).toBeInTheDocument();
  expect(answer.getByRole('button', { name: '패널 놓기' })).toBeInTheDocument();
  expect(answer.queryByText(/답을 멈췄어요|생각 중이에요|답이 늦어지고 있어요/u)).toBeNull();
  expect(answer.queryByRole('button', { name: '다시 물어보기' })).toBeNull();
  expect(run.getState().panels).toEqual([]);

  send('다른 말');
  const body = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
  expect(body.history).toEqual([{ role: 'user', text: question }, { role: 'assistant', text: fixedLine }]);
});

it('uses simple mode when the completed stream has neither text nor cards', async () => {
  const { send } = host();
  send('매출');
  streams[0].frame('panels', { panels: [] });
  streams[0].frame('done', {}); await flush();
  expect(screen.getByRole('button', { name: '다시 물어보기' })).toBeInTheDocument();
  expect(document.body).toHaveTextContent(currentSales());
});

it('clarifies an unnamed placement without requesting a proposal or changing the board', async () => {
  const { run, send, bubble } = host();
  send('위젯 하나 추가해줘'); await flush();
  const answer = bubble()[0] as HTMLElement;
  expect(within(answer).getByText('어느 패널을 놓을까요?')).toBeInTheDocument();
  expect(streams).toHaveLength(0);
  expect(run.getState().panels).toEqual([]);
});

it.each(['empty stream result', 'transport fallback'])('leaves a named placement uncommitted without a proposal (%s)', async source => {
  const { run, send, bubble } = host();
  if (source === 'transport fallback') vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
  send('재고 위젯 추가해줘');
  if (source === 'empty stream result') {
    streams[0].frame('text_delta', { delta: '설정 메뉴에서 직접 추가하세요.' });
    streams[0].frame('panels', { panels: [] });
    streams[0].frame('done', { outcome: 'reply' });
  }
  await flush();
  expect(bubble()[0].querySelector('.ai-conversation__answer')).toBeInTheDocument();
  expect(within(bubble()[0] as HTMLElement).queryByRole('button', { name: '패널 놓기' })).toBeNull();
  expect(run.getState().panels).toEqual([]);
});

it('shows the model text of a widget question only after the reply resolves, without placing the candidate', async () => {
  const { run, send } = host();
  send('재고 위젯이 뭐야?');
  const text = '재고 위젯에서 재고를 확인할 수 있어요.';
  streams[0].frame('text_delta', { delta: text }); await flush();
  expect(screen.queryByText(text)).toBeNull();
  streams[0].frame('panels', { panels: [inventoryCandidate] });
  streams[0].frame('done', {}); await flush();
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '패널 놓기' })).toBeInTheDocument();
  expect(run.getState().panels).toEqual([]);
});

it('stops a placement order once and ignores its text and late completion', async () => {
  const { run, send, bubble } = host();
  send('재고 위젯 추가해줘');
  streams[0].frame('text_delta', { delta: modelDenial });
  streams[0].frame('panels', { panels: [] }); await flush();
  const stop = screen.getByRole('button', { name: '답 멈추기' });
  fireEvent.click(stop); fireEvent.click(stop);
  finishLayout(); await flush();
  expect(screen.getAllByText('답을 멈췄어요', { selector: 'p' })).toHaveLength(1);
  expect(bubble()[0]).toHaveTextContent('답을 멈췄어요');
  expect(streams[0].cancelled).toBe(true);
  expect(screen.queryByRole('button', { name: '패널 놓기' })).toBeNull();
  expect(run.getState().panels).toEqual([]);
});

it('shows a delay at ten seconds and falls back at thirty seconds with a retry for the original question', async () => {
  const { send } = host(); send('매출'); await advance(9900);
  expect(screen.queryByText('답이 늦어지고 있어요')).toBeNull(); await advance(100);
  expect(screen.getByText('답이 늦어지고 있어요', { selector: 'p' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '답 멈추기' })).toBeInTheDocument();
  expect(document.querySelector('[data-role="assistant"] button')).toBeNull();
  await advance(19900); expect(screen.getByText('답이 늦어지고 있어요', { selector: 'p' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '다시 물어보기' })).toBeNull();
  await advance(100); expect(screen.queryByText('답이 늦어지고 있어요')).toBeNull(); expect(document.body).toHaveTextContent(currentSales());
  expect(streams[0].cancelled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '다시 물어보기' }));
  expect(document.querySelectorAll('[data-role=user]')).toHaveLength(1); expect(document.querySelectorAll('[data-role=assistant]')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: '다시 물어보기' })).toBeNull(); expect(document.querySelector('.ai-wait')).toBeNull();
  streams[1].frame('text_delta', { delta: '다시 받은 답' }); streams[1].frame('panels', { panels: [] }); streams[1].frame('done', {}); await flush();
  expect(screen.getByText('다시 받은 답')).toBeInTheDocument(); expect(screen.queryByText('답을 멈췄어요')).toBeNull();
});
it('retains grounded agent read facts at the total deadline and discards model wording', async () => {
  const { send } = host();
  send('메뉴 몇 개 등록돼 있어?');
  streams[0].frame('text_delta', { delta: '검증되지 않은 답이에요.' });
  await advance(59999);
  expect(screen.queryByText('검증되지 않은 답이에요.')).toBeNull();
  expect(screen.getByRole('button', { name: '답 멈추기' })).toBeInTheDocument();
  await advance(1);
  expect(screen.getByText((_, element) => element?.tagName === 'P' && /^등록된 메뉴는 [\d,]+개예요$/u.test(element.textContent ?? ''))).toBeInTheDocument();
  expect(screen.getByText('간단히 답했어요')).toBeInTheDocument();
  expect(screen.queryByText('검증되지 않은 답이에요.')).toBeNull();
  expect(document.querySelector('[data-readonly="proposal"]')).toBeNull();
});

it.each([30000, 60000])('ends a write after %i ms with one error and no action controls', async deadline => {
  const { run, send } = host();
  send('검은콩 라테 5500원 메뉴에 넣어줘');
  await flush();
  if (deadline === 60000) streams[0].frame('text_delta', { delta: '확인한 문장이에요.' });
  await advance(deadline - 1);
  expect(screen.getByRole('button', { name: '답 멈추기' })).toBeInTheDocument();
  await advance(1);
  expect(document.querySelector('.ai-conversation__announcer[aria-live="assertive"]')).toHaveTextContent('답변을 가져오지 못했어요');
  expect(document.querySelector('[data-readonly="proposal"]')).toBeNull();
  expect(screen.queryByText('확인한 문장이에요.')).toBeNull();
  expect(run.getState().undo).toBeNull();
  expect(streams[0].cancelled).toBe(true);
  expect(screen.getByRole('button', { name: '다시 시도하기' })).toBeInTheDocument();
});

it('rejects late events after a timeout and shows only retry when there is no local answer', async () => {
  const { send, bubble } = host(); send('배송이 어떻게 되나요?'); await advance(30000);
  expect(bubble()).toHaveLength(1); expect(screen.getByRole('button', { name: '다시 시도하기' })).toBeInTheDocument();
  expect(screen.getByText('답변을 가져오지 못했어요', { selector: 'p' })).toBeInTheDocument();
  expect(document.querySelectorAll('.ai-conversation__message button')).toHaveLength(1);
  streams[0].frame('text_delta', { delta: '늦은 글' }); await advance(30000);
  expect(screen.queryByText('늦은 글')).toBeNull(); expect(bubble()).toHaveLength(1);
});
it('records explicit stops and rejects old chunks after close without a marker (AC-1581, AC-1584)', async () => {
  const { send, bubble } = host(); send('매출'); streams[0].frame('text_delta', { delta: '받은 글' }); await flush();
  const stop = screen.getByRole('button', { name: '답 멈추기' }); fireEvent.click(stop); fireEvent.click(stop); fireEvent.click(stop);
  expect(screen.getAllByText('답을 멈췄어요', { selector: 'p' })).toHaveLength(1); expect(screen.queryByText('받은 글')).toBeNull(); expect(document.querySelector('.ai-wait')).toBeNull(); expect(streams[0].cancelled).toBe(true);
  send('재고'); streams[1].frame('text_delta', { delta: '재고 부분' }); await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Navis 닫기' })); streams[1].frame('text_delta', { delta: '닫은 뒤 글' });
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' })); expect(screen.queryByText('재고 부분')).toBeNull(); expect(screen.getAllByText('답을 멈췄어요', { selector: 'p' })).toHaveLength(1);
  send('새 매출'); streams[2].frame('text_delta', { delta: '옛 답' }); await flush(); send('새 재고');
  streams[2].frame('text_delta', { delta: '섞이면 안 됨' }); streams[3].frame('text_delta', { delta: '새 답' }); streams[3].frame('panels', { panels: [] }); streams[3].frame('done', {}); await flush();
  expect(screen.getByText('새 답')).toBeInTheDocument(); expect(screen.queryByText(/섞이면 안 됨|닫은 뒤 글/)).toBeNull(); expect(bubble()).toHaveLength(3);
});
it('replaces waiting questions and keeps the pending turn across a layer switch', async () => {
  const { run, send } = host(); send('매출'); await advance(12000); send('재고');
  expect(screen.queryByText('답이 늦어지고 있어요')).toBeNull(); expect(screen.getByText('답을 멈췄어요', { selector: 'p' })).toBeInTheDocument();
  await advance(18000); expect(screen.getAllByRole('button', { name: '다시 물어보기' })).toHaveLength(1);
  act(() => { run.actions.switchLayer('marketing'); });
  expect(screen.getByRole('button', { name: 'Navis 닫기' })).toBeInTheDocument();
  expect(screen.getAllByText('답을 멈췄어요', { selector: 'p' })).toHaveLength(1);
  expect(streams[1].cancelled).toBe(false);
});
it('keeps 3-second first text through 40-second completion, and partial text through a 60-second server error', async () => {
  const { send } = host(); send('매출'); await advance(3000); streams[0].frame('text_delta', { delta: '첫 글자' }); await advance(37000);
  expect(screen.queryByRole('button', { name: '다시 물어보기' })).toBeNull(); expect(screen.queryByText('답이 늦어지고 있어요')).toBeNull();
  streams[0].frame('panels', { panels: [] }); streams[0].frame('done', {}); await flush(); expect(screen.getByText('첫 글자')).toBeInTheDocument();
  send('매출'); streams[1].frame('text_delta', { delta: '남겨 둔 글' }); await advance(59999); streams[1].frame('error', { code: 'TIMEOUT' }); await flush();
  expect(screen.getByText('남겨 둔 글')).toBeInTheDocument(); expect(screen.queryByText('답을 멈췄어요')).toBeNull(); expect(screen.getAllByText('추천 패널')).toHaveLength(2); expect(screen.queryByRole('button', { name: '다시 물어보기' })).toBeNull();
});
it.each(['en', 'zh-Hans'] as const)('uses Korean waiting and retry controls with a %s fallback answer', async locale => {
  const { send } = host(locale); send('매출'); await advance(10000); expect(screen.getByText('답이 늦어지고 있어요', { selector: 'p' })).toBeInTheDocument();
  await advance(20000);
  expect(screen.getByRole('button', { name: '다시 물어보기' })).toBeInTheDocument(); expect(document.body.textContent).toContain(currentSales(locale));
  vi.mocked(fetch).mockRejectedValueOnce(new Error('PRIVATE_CODE'));
  send('시재'); await flush(); expect(screen.getAllByRole('button', { name: '다시 물어보기' })).toHaveLength(2); expect(document.body.textContent).not.toContain('PRIVATE_CODE');
});
it('falls back on connection failure and fences an interrupted answer after unmount (AC-1581, AC-1584)', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error('private upstream failure'));
  const { run, send } = host(); send('매출'); await flush();
  expect(screen.getByRole('button', { name: '다시 물어보기' })).toBeInTheDocument(); expect(document.body).toHaveTextContent(currentSales());
  vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 503 })); send('재고'); await flush();
  expect(screen.getAllByRole('button', { name: '다시 물어보기' })).toHaveLength(2);
  send('메뉴'); streams[0].frame('text_delta', { delta: '다음 방문에도 남는 글' }); await flush();
  cleanup(); expect(streams[0].cancelled).toBe(true);
  render(<KitProviders reducedMotion><DashboardNavis run={run} controller={{ tap: vi.fn() } as unknown as DashboardController} readRect={() => ({ x: 0, y: 0, width: 1, height: 1 })} dragging={false} visible onShowPanel={() => {}} onCreated={() => {}} /></KitProviders>);
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  expect(screen.queryByText('다음 방문에도 남는 글')).toBeNull(); expect(screen.queryByText('답을 멈췄어요', { selector: 'p' })).toBeNull();
  expect(document.body).not.toHaveTextContent('private upstream failure');
});
it('clears the ten-second notice on first text while keeping the answer hidden (AC-1582)', async () => {
  const { send } = host();
  send('재고 위젯 2x1로 추가해줘'); await advance(3000);
  streams[0].frame('status', { step: 'assembling' }); await advance(7000);
  expect(screen.getByText('답이 늦어지고 있어요', { selector: 'p' })).toBeInTheDocument();
  await advance(2000);
  streams[0].frame('text_delta', { delta: '확인한 첫 글' }); await flush();
  expect(screen.queryByText('답이 늦어지고 있어요', { selector: 'p' })).toBeNull();
  expect(screen.queryByText('확인한 첫 글')).toBeNull();
  expect(document.querySelector('.ai-wait__dots')).toBeInTheDocument();
});
it('keeps the delayed line and first-content deadline when only whitespace arrives after ten seconds', async () => {
  const { send } = host(); send('매출'); await advance(10000);
  streams[0].frame('text_delta', { delta: ' \n ' }); await flush();
  expect(screen.getByText('답이 늦어지고 있어요', { selector: 'p' })).toBeInTheDocument();
  await advance(20000); expect(screen.getByRole('button', { name: '다시 물어보기' })).toBeInTheDocument();
});

// These prompts avoid the word 질문: N17 reads it as a customer inquiry and answers from the stored queue before the legacy model path (D-311).
it('sends completed conversation history and excludes a stopped exchange', async () => {
  const { send } = host();
  send('첫 말'); streams[0].frame('text_delta', { delta: '첫 답.' }); streams[0].frame('panels', { panels: [] }); streams[0].frame('done', {}); await flush();
  send('멈춘 말'); streams[1].frame('text_delta', { delta: '멈춘 답.' }); streams[1].frame('panels', { panels: [{ featureId: 'ledger', reason: '매출', size: { width: 1, height: 1 } }] }); await flush(); fireEvent.click(screen.getByRole('button', { name: '답 멈추기' }));
  expect(screen.getAllByText('답을 멈췄어요', { selector: 'p' })).toHaveLength(1); expect(screen.queryByText('추천 패널')).toBeNull();
  send('마지막 말');
  const body = JSON.parse(vi.mocked(fetch).mock.calls[2][1]!.body as string);
  expect(body.history).toEqual([{ role: 'user', text: '첫 말' }, { role: 'assistant', text: '첫 답.' }]);
});

it('shows scope refusal with example buttons, no retry or cards, and excludes it from later history', async () => {
  const { send, run } = host(); send('우주 여행 가고 싶어');
  streams[0].frame('error', { code: 'OUT_OF_SCOPE' }); await flush();
  expect(screen.getByText(/가게 운영과 Navis 사용에 관한 질문에 답할 수 있어요/u)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '오늘 얼마 벌었어?' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '다시 물어보기' })).toBeNull();
  expect(screen.queryByText('추천 패널')).toBeNull(); expect(run.getState().panels).toEqual([]);
  send('매출 알려줘');
  const body = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
  expect(body.history ?? []).toEqual([]);
});
