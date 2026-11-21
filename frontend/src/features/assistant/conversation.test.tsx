import { cafeWeek, cafeFacts } from './__fixtures__/cafe';
import { navisTranslator } from './messages';
import { replyResponse } from './stream-fixture';
import '@testing-library/jest-dom/vitest';
import navisAsset from '../../assets/brand/navis-symbol.svg';
import navisLogo from '../../assets/brand/navis-logo.svg';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiConversation, CandidateCard, type ConversationMessage } from './conversation';
import { UiProvider } from '../../ui/UiProvider';
import { screenPresets } from '../../layout';
import { analyzeText } from './analysis';
import { createAssistantProvider } from './provider';
import { I18nProvider } from '../../i18n';
import type { Locale } from '../../contracts';
import type { AssistantReply, Candidate } from './types';

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
  it('fills an example and honors IME, Shift+Enter and cancellation', () => {
    const change = vi.fn(), submit = vi.fn(), cancel = vi.fn(), close = vi.fn();
    render(<AiConversation draft="hello" onDraftChange={change} messages={[]} phase="idle" onSubmit={submit} onCancel={cancel} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: '오늘 일정을 보여줘' })); expect(change).toHaveBeenCalledWith('오늘 일정을 보여줘');
    const input = screen.getByLabelText('자유롭게 질문해 주세요');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' }); expect(submit).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: 'Escape' }); expect(cancel).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it('shows the full Navis logo (mark + gradient wordmark, same asset and class as the app header) in the title and the symbol in assistant messages only', () => {
    render(<AiConversation draft="" messages={[{ id: 'a', role: 'assistant', text: '안녕하세요' }, { id: 'u', role: 'user', text: '안녕' }]} phase="idle" {...noop} />);
    const title = screen.getByRole('heading', { name: 'Navis' });
    const logo = title.querySelector('img')!; expect(logo).toHaveAttribute('src', navisLogo); expect(logo).toHaveAttribute('alt', 'Navis'); expect(logo).toHaveClass('navis-logo');
    // The wordmark is part of the picture, not typed text next to it.
    expect(title.textContent).toBe('');
    const assistant = screen.getByText('안녕하세요').closest('[data-role=assistant]')!; expect(assistant.querySelector('strong img')).toHaveAttribute('src', navisAsset);
    expect(screen.getByText('안녕').closest('[data-role=user]')!.querySelector('img')).toBeNull();
    expect(screen.getByText('사장님')).toBeTruthy();
  });
  it('asks the question once: the hint is the placeholder in every language and the label is only read by screen readers (U-B)', () => {
    const prompts: Record<Locale, string> = { ko: '자유롭게 질문해 주세요', en: 'Tell me what you need', 'zh-Hans': '请告诉我您需要什么', 'zh-Hant': '請告訴我您需要什麼' };
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
    ko: { send: '요청 보내기', prompt: '자유롭게 질문해 주세요', thinking: '생각 중이에요', speaker: '사장님', candidates: '추천 패널' },
    en: { send: 'Send', prompt: 'Tell me what you need', thinking: '생각 중이에요', speaker: 'You', candidates: 'Suggested panels' },
    'zh-Hans': { send: '发送', prompt: '请告诉我您需要什么', thinking: '생각 중이에요', speaker: '您', candidates: '推荐小组件' },
    'zh-Hant': { send: '傳送', prompt: '請告訴我您需要什麼', thinking: '생각 중이에요', speaker: '您', candidates: '推薦小工具' },
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
    // fixed controls follow the current language
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    expect(reply.panels[0].reason).toMatch(/^You can check /);
  });
});

describe('candidate cards (SCR-23, SCR-34)', () => {
  const candidateOf = async (panels: unknown[], layer: 'management' | 'marketing' = 'management'): Promise<Candidate[]> => (await createAssistantProvider({ fetcher: fetcher(panels) }).ask({ text: 'x', signal: signal(), layer })).panels as Candidate[];
  const asReply = (panels: readonly Candidate[]): AssistantReply => ({ answer: 'a', panels });
  void asReply;
  it('shows an explicit add button and hides the size sentence', async () => {
    const [plain, ranged] = await candidateOf([{ featureId: 'ledger', reason: '기본', size: { width: 2, height: 1 } }, { featureId: 'ledger', reason: '기간', condition: cafeWeek, size: { width: 1, height: 2 } }]);
    const { rerender } = render(<CandidateCard candidate={plain} />);
    expect(screen.queryByText('가로 2칸, 세로 1칸')).toBeNull();
    expect(screen.getByRole('button',{name:'추가하기'})).toBeTruthy();
    rerender(<CandidateCard candidate={ranged} />);
    expect(screen.queryByText(/가로 1칸, 세로 2칸/)).toBeNull();
    expect(screen.getByRole('button',{name:'추가하기'})).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: '보드에서 보기' })); expect(view).toHaveBeenCalledOnce();
    expect(screen.queryByText('끌어 놓거나 눌러 추가')).toBeNull();
  });
  it('lets AiConversation pass findPlacement results to the cards', async () => {
    const panels = await candidateOf([{ featureId: 'calendar', reason: '일정', size: { width: 1, height: 1 } }]);
    const view = vi.fn();
    render(<AiConversation draft="" messages={[{ id: 'a', role: 'assistant', text: 'a', reply: { answer: 'a', panels } }]} phase="idle" {...noop} placedOf={() => ({ pageIndex: 2, onViewedPage: false })} onViewCandidateOnBoard={view} />);
    fireEvent.click(screen.getByRole('button', { name: '보드에서 보기' })); expect(view).toHaveBeenCalledWith(panels[0]);
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
  const text = '첫 줄\n둘째 줄\n\n1. 세 번째\n2. 네 번째';
  const {container} = render(<AiConversation draft="" messages={[{id:'a',role:'assistant',text}]} phase="idle" {...noop}/>);
  const paragraphs = container.querySelectorAll('.ai-conversation__answer p');
  expect([...paragraphs].map(p => p.textContent)).toEqual(['첫 줄\n둘째 줄', '1. 세 번째\n2. 네 번째']);
  expect(getComputedStyle(paragraphs[0]).whiteSpace).toBe('pre-line');
});

// C-1 CHAT-LIVE-FEEL: a live waiting indicator (one changing step line) and a same-render reveal of answer + cards.
describe('waiting indicator (C-1)', () => {
  const user: ConversationMessage = { id: 'u', role: 'user', text: '질문' };
  const waiting = (extra: Partial<ConversationMessage> = {}): ConversationMessage => ({ id: 'w', role: 'assistant', text: '', requestText: '아무 말이나 해 볼게요', delivery: 'waiting', ...extra });
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const mount = (messages: readonly ConversationMessage[], locale: Locale = 'ko') => render(inLocale(locale, <AiConversation draft="" messages={messages} phase="interpreting" {...noop} />));
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows no static "thinking" line: one step line from the question, three steps without a topic', () => {
    mount([user, waiting()]);
    expect(screen.queryByText('생각 중이에요')).toBeNull();
    expect(screen.getByText('질문을 살펴보고 있어요')).toBeInTheDocument();
    advance(1199); expect(screen.getByText('질문을 살펴보고 있어요')).toBeInTheDocument();
    advance(601); expect(screen.getByText('필요한 정보를 찾고 있어요')).toBeInTheDocument();
    expect(screen.queryByText('질문을 살펴보고 있어요')).toBeNull();
    advance(1800); expect(screen.getByText('답을 정리하고 있어요')).toBeInTheDocument();
    expect(screen.queryByText('필요한 정보를 찾고 있어요')).toBeNull();
  });

  it('holds the last step and never loops back', () => {
    mount([user, waiting()]);
    advance(1800); advance(1800); advance(60000);
    expect(screen.getByText('답을 정리하고 있어요')).toBeInTheDocument();
    expect(document.querySelectorAll('.ai-wait__step')).toHaveLength(1);
    expect(screen.queryByText(/살펴보고|찾고/u)).toBeNull();
  });

  it('names what the question touches, then checks numbers, then composes', () => {
    mount([user, waiting({ requestText: '메뉴 알려줘' })]);
    expect(screen.getByText('메뉴를 확인하고 있어요')).toBeInTheDocument();
    advance(1800); expect(screen.getByText('숫자를 맞춰 보고 있어요')).toBeInTheDocument();
    advance(1800); expect(screen.getByText('답을 정리하고 있어요')).toBeInTheDocument();
  });

  it('uses the featureName of the host for the topic and at most two topics', () => {
    render(<AiConversation draft="" messages={[user, waiting({ requestText: '매출이랑 재고랑 메뉴' })]} phase="interpreting" {...noop} featureName={(id) => `[${id}]`} />);
    const steps: string[] = [];
    for (let i = 0; i < 6; i++) { steps.push(document.querySelector('.ai-wait__step')!.textContent!); advance(1800); }
    expect(new Set(steps).size).toBe(4);
    expect(steps[0]).toMatch(/^\[[a-z-]+\]를? 확인하고 있어요$|^\[[a-z-]+\]을? 확인하고 있어요$/u);
    expect(steps.slice(-2)).toEqual(['답을 정리하고 있어요', '답을 정리하고 있어요']);
  });

  it('jumps to the last step once the first text has started and shows only the delayed line while waiting', () => {
    mount([user, waiting({ delivery: 'streaming' })]);
    expect(screen.getByText('답을 정리하고 있어요')).toBeInTheDocument();
    cleanup();
    mount([user, waiting({ delayed: true })]);
    expect(document.querySelector('.ai-wait__step')).toHaveTextContent('답이 늦어지고 있어요');
    expect(document.querySelector('[data-role="assistant"] button')).toBeNull();
    expect(screen.getByRole('button', { name: '답 멈추기' })).toBeInTheDocument();
  });

  it('keeps the stop control while waiting', () => {
    const cancel = vi.fn();
    render(<AiConversation draft="" messages={[user, waiting()]} phase="interpreting" {...noop} onCancel={cancel} />);
    fireEvent.click(screen.getByRole('button', { name: '답 멈추기' })); expect(cancel).toHaveBeenCalledOnce();
  });

  it('tells assistive technology only about a step change, and hides the moving dots', () => {
    const { container } = mount([user, waiting()]);
    const bubble = container.querySelector('[data-role=assistant]')!;
    expect(bubble).toHaveAttribute('role', 'status');
    expect(bubble).not.toHaveAttribute('aria-busy');
    expect(container.querySelector('.ai-wait__dots')).toHaveAttribute('aria-hidden', 'true');
    const observer = new MutationObserver(() => {}); observer.observe(bubble, { subtree: true, childList: true, characterData: true, attributes: true });
    advance(1100); expect(observer.takeRecords()).toHaveLength(0);
    advance(700); expect(observer.takeRecords().length).toBeGreaterThan(0);
    observer.disconnect();
  });

  it.each([
    ['en', ['Reading your question', 'Finding the information you need', 'Putting the answer together']],
    ['zh-Hans', ['正在了解您的问题', '正在查找所需信息', '正在整理回答']],
    ['zh-Hant', ['正在了解您的問題', '正在查找所需資訊', '正在整理回答']],
  ] as const)('speaks %s while waiting', (locale, [first, second, third]) => {
    mount([user, waiting()], locale);
    expect(screen.getByText(first)).toBeInTheDocument(); advance(1800);
    expect(screen.getByText(second)).toBeInTheDocument(); advance(1800);
    expect(screen.getByText(third)).toBeInTheDocument();
  });

  it('names the topic in every language', () => {
    for (const [locale, text] of [['en', /^Checking .+/u], ['zh-Hans', /^正在查看.+/u], ['zh-Hant', /^正在查看.+/u]] as const) {
      const view = mount([user, waiting({ requestText: '메뉴 알려줘' })], locale);
      expect(document.querySelector('.ai-wait__step')!.textContent).toMatch(text);
      expect(document.body.textContent).not.toMatch(/navis\.wait/u);
      view.unmount();
    }
  });

  it('animates by default and goes static under reduced motion while the steps still change', () => {
    const full = mount([user, waiting()]);
    expect(document.querySelector('.ai-wait')).toHaveAttribute('data-motion', 'full'); full.unmount();
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion><AiConversation draft="" messages={[user, waiting()]} phase="interpreting" {...noop} /></UiProvider>);
    expect(document.querySelector('.ai-wait')).toHaveAttribute('data-motion', 'reduced');
    expect(screen.getByText('질문을 살펴보고 있어요')).toBeInTheDocument(); advance(1800);
    expect(screen.getByText('필요한 정보를 찾고 있어요')).toBeInTheDocument();
  });

  it('ships a reduced-motion rule for the dots, the step fade and the reveal', () => {
    const css = readFileSync(resolve(__dirname, 'conversation.css'), 'utf8');
    expect(css).toMatch(/\.ai-wait\[data-motion="reduced"\][^{]*\{[^}]*animation:\s*none/u);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
    expect(css).toMatch(/\.ai-conversation__reveal\[data-fade\]/u);
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

  it('has no fade under reduced motion and none for messages that were already there', async () => {
    const final = await finalMessage();
    const reduced = (node: ReactNode) => <UiProvider screenPreset={screenPresets.A} reducedMotion>{node}</UiProvider>;
    const view = render(reduced(<AiConversation draft="" messages={[user, waiting]} phase="interpreting" {...noop} />));
    view.rerender(reduced(<AiConversation draft="" messages={[user, final]} phase="idle" {...noop} />));
    expect(view.container.querySelector('[data-role=assistant] .ai-conversation__reveal')).not.toHaveAttribute('data-fade');
    expect(view.container.querySelector('.ai-candidate')).not.toBeNull();
    view.unmount();
    const history = render(<AiConversation draft="" messages={[user, final]} phase="idle" {...noop} />);
    expect(history.container.querySelector('[data-role=assistant] .ai-conversation__reveal')).not.toHaveAttribute('data-fade');
  });
});
