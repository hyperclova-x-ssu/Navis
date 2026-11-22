import { cafeWeek, cafeFacts } from './__fixtures__/cafe';
import { navisTranslator } from './messages';
import { destinationOpenLabel } from './destinations';
import { replyResponse } from './stream-fixture';
import '@testing-library/jest-dom/vitest';
import navisAsset from '../../assets/brand/navis-symbol.svg';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiConversation, CandidateCard, type ConversationMessage } from './conversation';
import { UiProvider } from '../../ui/UiProvider';
import { screenPresets } from '../../layout';
import { analyzeText } from './analysis';
import { createAssistantProvider } from './provider';
import { I18nProvider } from '../../i18n';
import type { Locale } from '../../contracts';
import type { AssistantReply, Candidate } from './types';
import { createWidgetDataStore } from '../../data/widget-data';
import { selectPromptSuggestions } from './prompt-suggestions';
import { storeFactSource } from './snapshot';
import * as recording from './media/pcm-recording';

afterEach(cleanup);
const signal = () => new AbortController().signal;
const fetcher = (panels: unknown[], answer = '매출이에요') => vi.fn().mockResolvedValue(replyResponse({ answer, panels }));
const inLocale = (locale: Locale, node: ReactNode) => <I18nProvider locale={locale}>{node}</I18nProvider>;
const weeklyNet = Number(cafeFacts('ledger', cafeWeek).find(fact => fact.key === 'ledger.sales.net')!.value);
const noop = { onDraftChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn(), onClose: vi.fn() };

describe('assistant conversation', () => {
  it('shows the human-readable analysis period exactly once in the answer card', async () => {
    const result = await analyzeText('최근 7일 매출 분석해줘');
    if (!result.ok) throw new Error(result.code);
    render(<AiConversation draft="" messages={[{ id: '1', role: 'assistant', text: '', analysis: result.answer }]} phase="idle" {...noop} />);
    expect(screen.getAllByText(navisTranslator('ko').format.dateRange(cafeWeek.start, cafeWeek.end))).toHaveLength(1);
    expect(screen.queryByText(`${cafeWeek.start}~${cafeWeek.end}`)).toBeNull();
    expect(screen.getByText(navisTranslator('ko').format.money(weeklyNet, 'compact'))).toBeTruthy();
    expect(screen.getByText('손익 분석')).toBeTruthy();
  });
  it('fills an empty draft from a data-backed prompt and honors IME and Shift+Enter', () => {
    const change = vi.fn(), submit = vi.fn(), cancel = vi.fn(), close = vi.fn();
    const prompts = selectPromptSuggestions(createWidgetDataStore().getSnapshot());
    const view = (draft: string) => <AiConversation draft={draft} prompts={prompts} onDraftChange={change} messages={[]} phase="idle" onSubmit={submit} onCancel={cancel} onClose={close} />;
    const { rerender } = render(view('수정 중인 질문'));
    const suggestion = screen.getByRole('button', { name: new RegExp(prompts[0].readTemplate.text.replace('?', '\\?')) });
    fireEvent.click(suggestion);
    expect(change).not.toHaveBeenCalled();
    rerender(view(''));
    fireEvent.click(suggestion);
    expect(change).toHaveBeenCalledExactlyOnceWith(prompts[0].readTemplate.text);
    expect(suggestion).toHaveTextContent(prompts[0].countLabel);
    expect(submit).not.toHaveBeenCalled();
    const input = screen.getByLabelText('질문하거나 요청해 주세요');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' }); expect(submit).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: 'Escape' }); expect(cancel).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
  it('shows only the greeting when no prompt qualifies', () => {
    render(<AiConversation draft="" messages={[]} phase="idle" {...noop} />);
    const transcript = screen.getByRole('region', { name: '대화 기록' });
    expect(transcript).toHaveTextContent('무엇을 도와드릴까요?');
    expect(transcript.querySelector('button')).toBeNull();
  });
  it('discards an older transcription when a card continuation starts a new request', async () => {
    const start = vi.spyOn(recording, 'startRecording').mockResolvedValue({
      stop: async () => new Blob(['sample'], { type: 'audio/wav' }),
    });
    let finish!: (response: Response) => void;
    const fetch = vi.fn((_url: string, _options: RequestInit) => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const change = vi.fn();
    const owner = { id: 'question', role: 'user', text: '메뉴 추가해줘' } as const;
    const request = { id: 'continuation', role: 'assistant', text: '', requestText: owner.text, delivery: 'waiting' } as const;
    try {
      const { rerender } = render(<AiConversation {...noop} draft="고친 질문" messages={[owner]} phase="idle" onDraftChange={change} />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '말로 입력' })); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '듣기 멈추기' })); });
      expect(fetch).toHaveBeenCalledOnce();
      rerender(<AiConversation {...noop} draft="고친 질문" messages={[owner, request]} phase="interpreting" onDraftChange={change} />);
      expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
      await act(async () => { finish(Response.json({ requestId: 'old-voice', text: '늦은 받아쓰기' })); });
      expect(change).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox')).toHaveValue('고친 질문');
    } finally {
      start.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it('shows the period and named destination for a verified read without rewriting its answer (C-03, AC-1580)', () => {
    const open = vi.fn();
    const answer = '오늘 순매출은 2,000원이에요.';
    const reply: AssistantReply = { answer, panels: [], locale: 'ko', turn: { kind: 'read', evidence: [{
      tool: 'get_widget', args: { featureId: 'ledger', condition: { kind: 'default' } }, status: 'ready',
      facts: [{ key: 'ledger.sales.net', label: '순매출', display: '2,000원', value: 2000, unit: 'KRW', date: '2026-11-17' }],
    }] } };
    render(<AiConversation draft="" messages={[{ id: 'a', role: 'assistant', text: answer, reply }]} phase="idle" onOpenEvidence={open} {...noop} />);
    // The key figure sits in its own bold element (M-05), but the sentence itself is not reworded.
    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === answer)).toBeInTheDocument();
    expect(screen.getByText('2,000원', { selector: 'strong.ai-conversation__figure' })).toBeInTheDocument();
    expect(screen.getByText('근거 · 손익 · 11월 17일')).toBeInTheDocument();
    const target = screen.getByRole('button', { name: '손익 열기' });
    fireEvent.click(target);
    expect(open).toHaveBeenCalledExactlyOnceWith({ featureId: 'ledger', view: 'sales' }, target);
  });
  it('shows the Navis mark once in the title (M-02) and only the text label in assistant messages (M-25)', () => {
    render(<AiConversation draft="" messages={[{ id: 'a', role: 'assistant', text: '안녕하세요' }, { id: 'u', role: 'user', text: '안녕' }]} phase="idle" {...noop} />);
    const title = screen.getByRole('heading', { name: 'Navis', level: 2 });
    const mark = title.querySelector('img')!; expect(mark).toHaveAttribute('src', navisAsset); expect(mark).toHaveAttribute('alt', '');
    expect(title.textContent).toBe('Navis');
    // CHAT-UI M-25: the label is text only; the mark appears once, in the header.
    const assistant = screen.getByText('안녕하세요').closest('[data-role=assistant]')!; expect(assistant.querySelector('h3 img')).toBeNull();
    expect(screen.getByText('안녕').closest('[data-role=user]')!.querySelector('img')).toBeNull();
    expect(screen.getByText('사장님')).toBeTruthy();
  });
  it('asks the question once: the hint is the placeholder in every language and the label is only read by screen readers (U-B)', () => {
    const prompts: Record<Locale, string> = { ko: '질문하거나 요청해 주세요', en: '질문하거나 요청해 주세요', 'zh-Hans': '질문하거나 요청해 주세요', 'zh-Hant': '질문하거나 요청해 주세요' };
    for (const [locale, prompt] of Object.entries(prompts) as [Locale, string][]) {
      const { unmount } = render(inLocale(locale, <AiConversation draft="" messages={[]} phase="idle" {...noop} />));
      const input = screen.getByLabelText(prompt) as HTMLTextAreaElement;
      expect(input.tagName).toBe('TEXTAREA'); expect(input).toHaveAttribute('placeholder', prompt);
      const label = screen.getByText(prompt, { selector: 'label' });
      expect(label).toHaveClass('ui-sr-only'); expect(label).toHaveAttribute('for', input.id);
      expect(screen.getAllByText(prompt)).toHaveLength(1); // the placeholder is not text content
      unmount();
    }
  });
  it('renders validated candidates with a custom wrapper', async () => {
    const reply = await createAssistantProvider({ fetcher: fetcher([{ featureId: 'ledger', reason: '살펴보세요', size: { width: 2, height: 1 } }]) }).ask({ text: '매출', signal: signal() });
    render(<AiConversation draft="" messages={[{ id: 'a', role: 'assistant', text: reply.answer, reply }]} phase="idle" {...noop} renderCandidate={(c) => <div>사용자 카드 {c.size.width}×{c.size.height}</div>} />);
    expect(screen.getByText('사용자 카드 2×1')).toBeTruthy(); expect(screen.getByText('추천 패널')).toBeTruthy();
  });
});

describe('chrome in four languages (AC-222, AC-223)', () => {
  const expected: Record<Locale, { send: string; prompt: string; thinking: string; speaker: string; candidates: string }> = {
    ko: { send: '요청 보내기', prompt: '질문하거나 요청해 주세요', thinking: '생각 중이에요', speaker: '사장님', candidates: '추천 패널' },
    en: { send: '요청 보내기', prompt: '질문하거나 요청해 주세요', thinking: '생각 중이에요', speaker: '사장님', candidates: 'Suggested panels' },
    'zh-Hans': { send: '요청 보내기', prompt: '질문하거나 요청해 주세요', thinking: '생각 중이에요', speaker: '사장님', candidates: '推荐小组件' },
    'zh-Hant': { send: '요청 보내기', prompt: '질문하거나 요청해 주세요', thinking: '생각 중이에요', speaker: '사장님', candidates: '推薦小工具' },
  };
  it.each(Object.entries(expected) as [Locale, (typeof expected)['ko']][])('%s', async (locale, text) => {
    const reply = await createAssistantProvider({ fetcher: vi.fn().mockRejectedValue(new Error()) }).ask({ text: '재고', signal: signal(), locale });
    render(inLocale(locale, <AiConversation draft="" phase="interpreting" messages={[{ id: 'u', role: 'user', text: '재고' }, { id: 'a', role: 'assistant', text: reply.answer, reply }]} {...noop} />));
    expect(screen.getByRole('button', { name: text.send })).toBeTruthy();
    expect(screen.getByLabelText(text.prompt)).toBeTruthy();
    expect(screen.getByText(text.thinking)).toBeTruthy();
    expect(screen.getByText(text.speaker)).toBeTruthy();
    expect(screen.getByText(text.candidates)).toBeTruthy();
    // the card shows the localized widget name and size sentence, never a key
    expect(document.body.textContent).not.toMatch(/navis\.|widget\.|common\.|page\./u);
  });
  it('keeps an earlier bubble in its own language when the setting changes (AC-224)', async () => {
    const reply = await createAssistantProvider({ fetcher: vi.fn().mockRejectedValue(new Error()) }).ask({ text: 'show my sales', signal: signal(), locale: 'en' });
    const messages = [{ id: 'a', role: 'assistant' as const, text: reply.answer, reply }];
    const { rerender } = render(inLocale('en', <AiConversation draft="" messages={messages} phase="idle" {...noop} />));
    const bubble = () => screen.getByText(/^From /).closest('[data-role=assistant]')!.textContent;
    expect(bubble()).toContain(reply.answer);
    rerender(inLocale('zh-Hans', <AiConversation draft="" messages={messages} phase="idle" {...noop} />));
    expect(screen.getByText(/^From /)).toBeTruthy();
    expect(bubble()).toContain(reply.answer);
    // D-329 keeps fixed chat controls in Korean
    expect(screen.getByRole('button', { name: '요청 보내기' })).toBeTruthy();
    expect(reply.panels[0].reason).toMatch(/^You can check /);
  });
});

it.each(['ko', 'en', 'zh-Hans', 'zh-Hant'] as const)('uses the registered destination title in %s', locale => {
  const translator = navisTranslator(locale);
  expect(destinationOpenLabel({ featureId: 'tax' }, translator)).toBe(`${translator.t('widget.tax.title')} 열기`);
  expect(destinationOpenLabel({ featureId: 'unknown' }, translator)).toBeUndefined();
});

describe('candidate cards (SCR-23, SCR-34)', () => {
  const candidateOf = async (panels: unknown[], layer: 'management' | 'marketing' = 'management'): Promise<Candidate[]> => (await createAssistantProvider({ fetcher: fetcher(panels) }).ask({ text: 'x', signal: signal(), layer })).panels as Candidate[];
  const asReply = (panels: readonly Candidate[]): AssistantReply => ({ answer: 'a', panels });
  void asReply;
  it('shows an explicit add button and hides the size sentence', async () => {
    const [plain, ranged] = await candidateOf([{ featureId: 'ledger', reason: '기본', size: { width: 2, height: 1 } }, { featureId: 'ledger', reason: '기간', condition: cafeWeek, size: { width: 1, height: 2 } }]);
    const { rerender } = render(<CandidateCard candidate={plain} />);
    expect(screen.queryByText('가로 2칸, 세로 1칸')).toBeNull();
    expect(screen.getByRole('button',{name:'패널 놓기'})).toBeTruthy();
    rerender(<CandidateCard candidate={ranged} />);
    expect(screen.queryByText(/가로 1칸, 세로 2칸/)).toBeNull();
    expect(screen.getByRole('button',{name:'패널 놓기'})).toBeTruthy();
  });
  it('uses the grounded booking count where the compact preview starts with pickups', () => {
    const condition = { kind: 'default' } as const;
    const preview = storeFactSource(createWidgetDataStore()).view('voice-booking', condition);
    render(<CandidateCard candidate={{ featureId: 'voice-booking', condition, size: { width: 1, height: 1 }, reason: '예약', preview,
      placement: 'current-layer', summary: { label: '오늘 예약', display: '4건' } }} />);
    expect(screen.getByText('오늘 예약 4건')).toBeTruthy();
    expect(screen.queryByText(/픽업/u)).toBeNull();
  });
  it('selects on press when it can be placed', async () => {
    const [candidate] = await candidateOf([{ featureId: 'calendar', reason: '일정', size: { width: 1, height: 1 } }]);
    const select = vi.fn();
    render(<CandidateCard candidate={candidate} onSelect={select} />);
    fireEvent.click(screen.getByRole('button')); expect(select).toHaveBeenCalledOnce();
  });
  it.each([['ko', '손익은 관리에 있어요'], ['en', '손익 is in Management'], ['zh-Hans', '손익在管理中'], ['zh-Hant', '손익在管理中']] as const)('other-layer card is read-only in %s', async (locale, sentence) => {
    const [candidate] = await candidateOf([{ featureId: 'ledger', reason: 'r', size: { width: 1, height: 1 } }], 'marketing');
    expect(candidate.placement).toBe('other-layer');
    const select = vi.fn();
    render(inLocale(locale, <CandidateCard candidate={candidate} onSelect={select} />));
    expect(screen.queryByRole('button')).toBeNull();
    const group = screen.getByRole('group');
    expect(group.getAttribute('aria-label')).toContain(sentence);
    expect(screen.getAllByText(sentence)).toHaveLength(1);
    expect(group.tabIndex).toBe(-1);
    fireEvent.click(group); expect(select).not.toHaveBeenCalled();
  });
  it('shows already placed with the page, and views it on the board', async () => {
    const [candidate] = await candidateOf([{ featureId: 'calendar', reason: '일정', size: { width: 1, height: 1 } }]);
    const view = vi.fn();
    const { rerender } = render(<CandidateCard candidate={candidate} placed={{ pageIndex: 0, onViewedPage: true }} onViewOnBoard={view} />);
    expect(screen.getByText(/이미 있어요/)).toBeTruthy();
    rerender(<CandidateCard candidate={candidate} placed={{ pageIndex: 1, onViewedPage: false }} onViewOnBoard={view} />);
    expect(screen.getByText('2페이지에 이미 있어요')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '대시보드에서 보기' })); expect(view).toHaveBeenCalledOnce();
    expect(screen.queryByText('끌어 놓거나 눌러 추가')).toBeNull();
  });
  it('lets AiConversation pass findPlacement results to the cards', async () => {
    const panels = await candidateOf([{ featureId: 'calendar', reason: '일정', size: { width: 1, height: 1 } }]);
    const view = vi.fn();
    render(<AiConversation draft="" messages={[{ id: 'a', role: 'assistant', text: 'a', reply: { answer: 'a', panels } }]} phase="idle" {...noop} placedOf={() => ({ pageIndex: 2, onViewedPage: false })} onViewCandidateOnBoard={view} />);
    fireEvent.click(screen.getByRole('button', { name: '대시보드에서 보기' })); expect(view).toHaveBeenCalledWith(panels[0]);
    expect(screen.getByText('3페이지에 이미 있어요')).toBeTruthy();
  });
});

it('renders the analysis card in the current language', async () => {
  const result = await analyzeText('Analyze the last 7 days of sales', { locale: 'en' });
  if (!result.ok) throw new Error(result.code);
  render(inLocale('en', <AiConversation draft="" messages={[{ id: '1', role: 'assistant', text: '', analysis: result.answer }]} phase="idle" {...noop} />));
  expect(screen.getByText('손익 analysis')).toBeTruthy();
  expect(screen.getByText(navisTranslator('en').format.money(weeklyNet, 'compact'))).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Place 손익 as a panel' })).toBeTruthy();
});

it('keeps single line breaks and separates blank-line paragraphs in the answer', () => {
  const text = '첫 줄\n둘째 줄\n\n마지막 문단';
  const {container} = render(<AiConversation draft="" messages={[{id:'a',role:'assistant',text}]} phase="idle" {...noop}/>);
  const paragraphs = container.querySelectorAll('.ai-conversation__answer p');
  expect([...paragraphs].map(p => p.textContent)).toEqual(['첫 줄\n둘째 줄', '마지막 문단']);
  expect(getComputedStyle(paragraphs[0]).whiteSpace).toBe('pre-line');
});

describe('CHAT-UI-SALVAGE answer rendering (M-05, M-06)', () => {
  const answerOf = (text: string, role: 'assistant' | 'user' = 'assistant') => {
    const { container } = render(<AiConversation draft="" messages={[{ id: 'a', role, text }]} phase="idle" {...noop} />);
    return container.querySelector<HTMLElement>('.ai-conversation__answer')!;
  };
  const figures = (answer: HTMLElement) => [...answer.querySelectorAll('strong.ai-conversation__figure')].map(node => node.textContent);

  it('bolds each key figure as one unbreakable unit and leaves the sentence text unchanged (M-05)', () => {
    const text = '오늘 순매출은 831,000원이에요. 어제보다 12% 늘었고 주문은 52건이에요.';
    const answer = answerOf(text);
    expect(figures(answer)).toEqual(['831,000원', '12%', '52건']);
    expect(answer.textContent).toBe(text);
    // The CSS keeps a figure on one line and heavier than the sentence.
    const css = readFileSync(resolve(__dirname, 'conversation.css'), 'utf8');
    expect(css).toMatch(/\.ai-conversation__figure\s*\{[^}]*white-space:\s*nowrap/u);
    expect(css).toMatch(/\.ai-conversation__answer :is\(b, strong\)\s*\{[^}]*font-weight:\s*var\(--weight-metric\)/u);
  });
  it('keeps the arrow and its number together and does not bold dates, times or ordinals', () => {
    const answer = answerOf('어제보다 ▲ 2명 늘었어요. 11월 22일 14:00 기준이고 3번째 달이에요. 3개월 전보다 낮아요.');
    expect(figures(answer)).toEqual(['▲ 2명']);
  });
  it('bolds comma-grouped amounts with or without a unit and keeps a decimal percent whole', () => {
    expect(figures(answerOf('합계 1,234,000 이고 증가율은 +3.5%예요.'))).toEqual(['1,234,000', '+3.5%']);
  });
  it('does not restyle the owner\'s own words', () => {
    const answer = answerOf('매출 831,000원 알려줘\n1. 하나\n2. 둘', 'user');
    expect(figures(answer)).toEqual([]);
    expect(answer.querySelector('ol, ul')).toBeNull();
  });
  it('renders numbered steps as a real ordered list with a lead-in paragraph (M-06)', () => {
    const answer = answerOf('이렇게 해 보세요\n1. 메뉴를 열어요\n2. 가격을 고쳐요\n3. 확인 카드를 눌러요');
    expect([...answer.children].map(node => node.tagName)).toEqual(['P', 'OL']);
    expect(answer.querySelector('p')!.textContent).toBe('이렇게 해 보세요');
    expect([...answer.querySelectorAll('ol > li')].map(item => item.textContent)).toEqual(['메뉴를 열어요', '가격을 고쳐요', '확인 카드를 눌러요']);
    expect(answer.textContent).not.toMatch(/1\.\s/u);
  });
  it('renders dash and bullet lines as a real unordered list, also when items are blank-line separated', () => {
    const answer = answerOf('- 우유가 모자라요\n- 원두가 모자라요\n\n• 컵\n\n• 뚜껑');
    expect([...answer.children].map(node => node.tagName)).toEqual(['UL', 'UL']);
    expect([...answer.querySelectorAll('li')].map(item => item.textContent)).toEqual(['우유가 모자라요', '원두가 모자라요', '컵', '뚜껑']);
  });
  it('bolds figures inside list items too', () => {
    const answer = answerOf('1. 우유 3개\n2. 원두 2kg');
    expect(figures(answer)).toEqual(['3개', '2kg']);
  });
  it('leaves a single marker line, a dated line and a list that does not start at 1 as plain paragraphs', () => {
    const lone = answerOf('1. 하나뿐인 줄');
    expect(lone.querySelector('ol, ul')).toBeNull();
    cleanup();
    const dated = answerOf('11. 22. 오늘 매출이에요\n12. 3일 전과 비교했어요');
    expect(dated.querySelector('ol, ul')).toBeNull();
    expect(dated.textContent).toBe('11. 22. 오늘 매출이에요\n12. 3일 전과 비교했어요');
  });
  it('keeps the fallback, error and stopped notices readable with the same figure rules', () => {
    const answer = answerOf('답변을 가져오지 못했어요');
    expect(answer.textContent).toBe('답변을 가져오지 못했어요');
  });
});

describe('D-329 chat layout and waiting', () => {
  const user: ConversationMessage = { id: 'u', role: 'user', text: '질문' };
  const waiting: ConversationMessage = { id: 'w', role: 'assistant', text: '', requestText: '메뉴 알려줘', delivery: 'waiting' };

  it('keeps each turn accessible in one transcript with separate live announcers', () => {
    const reply: AssistantReply = { answer: '답변', panels: [] };
    const messages = [user, { id: 'a', role: 'assistant', text: reply.answer, reply },
      { id: 'b', role: 'assistant', text: '후속 답변' }] satisfies ConversationMessage[];
    const { container } = render(<AiConversation draft="" messages={messages} phase="idle" {...noop}
      renderAgentReply={() => <button type="button">제안 확인</button>} />);
    const transcript = screen.getByRole('region', { name: '대화 기록' });
    expect(transcript).toHaveAttribute('tabindex', '0');
    expect(transcript.querySelectorAll('h3')).toHaveLength(3);
    expect(transcript.querySelectorAll('h3 img')).toHaveLength(0);
    expect(transcript.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    expect(transcript).toContainElement(screen.getByRole('button', { name: '제안 확인' }));
    expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument();
    expect(container.querySelector('[aria-live="assertive"]')).toBeInTheDocument();
    expect(screen.queryByText('무엇을 도와드릴까요?')).toBeNull();
  });

  it('keeps the counter and both submit paths consistent and retains an oversized draft', () => {
    const submit = vi.fn();
    const props = { ...noop, onSubmit: submit, messages: [user, waiting], phase: 'interpreting' as const };
    const { rerender } = render(<AiConversation {...props} draft={'가'.repeat(4001)} />);
    const input = screen.getByRole('textbox');
    const send = screen.getByRole('button', { name: '요청 보내기' });
    const stop = screen.getByRole('button', { name: '답 멈추기' });
    expect(stop.parentElement).toBe(send.parentElement);
    expect(send).toBeDisabled();
    expect(screen.getByText('4,001 / 4,000')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.click(send);
    expect(submit).not.toHaveBeenCalled();
    expect(input).toHaveValue('가'.repeat(4001));
    expect(document.querySelector('[aria-live="assertive"]')).toHaveTextContent('질문을 4,000자 이하로 줄여 주세요');
    rerender(<AiConversation {...props} draft={'가'.repeat(4000)} />);
    expect(send).toBeEnabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).toHaveBeenCalledOnce();
  });

  it('lets IME consume Escape ahead of the card and stops a request ahead of closing chat', () => {
    const cancel = vi.fn(), close = vi.fn(), editorEscape = vi.fn();
    const reply: AssistantReply = { answer: '답변', panels: [] };
    render(<AiConversation draft="임시" messages={[{ id: 'a', role: 'assistant', text: reply.answer, reply }, waiting]}
      phase="interpreting" {...noop} onCancel={cancel} onClose={close}
      renderAgentReply={() => <input aria-label="편집기" onKeyDown={editorEscape} />} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '편집기' }), { key: 'Escape', isComposing: true });
    expect(editorEscape).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: '질문하거나 요청해 주세요' }), { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('renders static dots under reduced motion and keeps their status outside the transcript', () => {
    const { container } = render(<UiProvider screenPreset={screenPresets.A} reducedMotion>
      <AiConversation draft="" messages={[user, { ...waiting, waitingVisible: true }]} phase="interpreting" {...noop} />
    </UiProvider>);
    expect(container.querySelector('.ai-wait')).toHaveAttribute('data-motion', 'reduced');
    expect(container.querySelector('.ai-wait__step')).toHaveTextContent('생각 중이에요');
    expect(container.querySelector('.ai-wait__dots')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('생각 중이에요');
    const css = readFileSync(resolve(__dirname, 'conversation.css'), 'utf8');
    expect(css).toMatch(/\.ai-wait\[data-motion="reduced"\][^{]*\{[^}]*animation:\s*none/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
  });
});

describe('same-render reveal (C-1)', () => {
  const user: ConversationMessage = { id: 'u', role: 'user', text: '질문' };
  const finalMessage = async (): Promise<ConversationMessage> => {
    const reply = await createAssistantProvider({ fetcher: fetcher([{ featureId: 'ledger', reason: '살펴보세요', size: { width: 1, height: 1 } }]) }).ask({ text: '매출', signal: signal() });
    return { id: 'a', role: 'assistant', text: reply.answer, reply, requestText: '매출' };
  };
  const waiting: ConversationMessage = { id: 'a', role: 'assistant', text: '', requestText: '매출', delivery: 'waiting' };

  it('puts the answer, panel cards, and proposal into one new element with one fade, nothing before', async () => {
    const final = await finalMessage();
    const renderAgentReply = vi.fn(() => <div>제안 카드</div>);
    const view = render(<AiConversation draft="" messages={[user, { ...final, ...waiting }]} phase="interpreting" {...noop} renderAgentReply={renderAgentReply} />);
    expect(view.container.querySelector('[data-role=assistant] .ai-conversation__answer')).toBeNull();
    expect(view.container.querySelector('.ai-candidate')).toBeNull();
    expect(view.container.querySelector('[data-role=assistant] .ai-conversation__reveal')).toBeNull();
    expect(renderAgentReply).not.toHaveBeenCalled();
    view.rerender(<AiConversation draft="" messages={[user, final]} phase="idle" {...noop} renderAgentReply={renderAgentReply} />);
    const reveal = view.container.querySelector('[data-role=assistant] .ai-conversation__reveal')!;
    expect(reveal).toHaveAttribute('data-fade', 'true');
    expect(reveal.querySelector('.ai-conversation__answer')).toHaveTextContent('매출이에요');
    expect(reveal.querySelector('.ai-candidate')).not.toBeNull();
    expect(reveal).toContainElement(screen.getByText('제안 카드'));
    expect(renderAgentReply).toHaveBeenCalledWith(final.reply, final);
    expect(view.container.querySelector('.ai-wait')).toBeNull();
  });

  it('shows only the answer when the reply has no panels', async () => {
    const final = await finalMessage();
    const view = render(<AiConversation draft="" messages={[user, waiting]} phase="interpreting" {...noop} />);
    view.rerender(<AiConversation draft="" messages={[user, { ...final, reply: { ...final.reply!, panels: [] } }]} phase="idle" {...noop} />);
    expect(view.container.querySelector('[data-role=assistant] .ai-conversation__answer')).toHaveTextContent('매출이에요');
    expect(view.container.querySelector('.ai-candidate')).toBeNull(); expect(screen.queryByText('추천 패널')).toBeNull();
  });

  it('uses the reduced-motion fade and skips the fade for history', async () => {
    const final = await finalMessage();
    const reduced = (node: ReactNode) => <UiProvider screenPreset={screenPresets.A} reducedMotion>{node}</UiProvider>;
    const view = render(reduced(<AiConversation draft="" messages={[user, waiting]} phase="interpreting" {...noop} />));
    view.rerender(reduced(<AiConversation draft="" messages={[user, final]} phase="idle" {...noop} />));
    expect(view.container.querySelector('[data-role=assistant] .ai-conversation__reveal')).toHaveAttribute('data-fade', 'true');
    expect(view.container.querySelector('.ai-conversation')).toHaveAttribute('data-motion', 'reduced');
    expect(view.container.querySelector('.ai-candidate')).not.toBeNull();
    view.unmount();
    const history = render(<AiConversation draft="" messages={[user, final]} phase="idle" {...noop} />);
    expect(history.container.querySelector('[data-role=assistant] .ai-conversation__reveal')).not.toHaveAttribute('data-fade');
  });
});
