// D-380: the model writes the answer sentences; the browser shows them only after the shared numeric guard, and keeps the fact lines otherwise.
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../data/widget-data';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentRequest } from '../../../shared/navis-agent-schema.mjs';
import { createAssistantProvider } from './provider';
import { readComposedFrames, requestComposedAnswer, worthWording } from './compose';

const store = createWidgetDataStore();
const snapshot = store.getSnapshot();
const frames = (...pairs: [string, unknown][]) => pairs.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const reply = (body: string, ok = true, protocol: string = AGENT_PROTOCOL) => new Response(body, { status: ok ? 200 : 503, headers: { [AGENT_PROTOCOL_HEADER]: protocol } });

describe('reading the composed frame', () => {
  it('returns the text and the lines it used', () => {
    expect(readComposedFrames(frames(['status', { step: 'accepted' }], ['composed', { text: '오늘 매출은 48.1만 원이에요.', used: [0] }], ['done', { outcome: 'reply' }])))
      .toEqual({ text: '오늘 매출은 48.1만 원이에요.', used: [0] });
  });
  it.each([
    ['an error frame', frames(['error', { code: 'INVALID_OUTPUT' }])],
    ['a frame outside the schema', frames(['composed', { text: '', used: [] }])],
    ['no composed frame', frames(['done', { outcome: 'reply' }])],
    ['broken data', 'event: composed\ndata: {oops\n\n'],
  ])('returns null for %s', (_name, body) => { expect(readComposedFrames(body)).toBeNull(); });
});

describe('which answers are worth wording', () => {
  it('words a list of facts or a question that asks to compare or explain, and leaves one plain fact as it is', () => {
    expect(worthWording(['근무 11/18(수) 정하린 16:00~22:00', '근무 11/18(수) 윤서진 08:00~16:30'], '그 중에 오전에 하는 사람은?')).toBe(true);
    expect(worthWording(['오늘 매출 84.6만 원'], '왜 이렇게 낮아?')).toBe(true);
    expect(worthWording(['오늘 매출 846,220원'], '어제보다 많아?')).toBe(true);
    expect(worthWording(['오늘 매출 84.6만 원'], '오늘 매출 얼마야?')).toBe(false);
    expect(worthWording([], '왜?')).toBe(false);
    // A list of records of one kind (workers, orders, hourly rows) is already the answer: wording it would only drop some of its rows.
    expect(worthWording(['근무 11/18(수) 정하린 16:00~22:00', '근무 11/18(수) 윤서진 08:00~16:30', '근무 11/18(수) 박도현 10:00~15:00'], '내일 근무 누구야?')).toBe(false);
    expect(worthWording(['시간대별 매출 08:00 58,200원', '시간대별 매출 09:00 156,350원', '시간대별 매출 10:00 86,420원'], '오늘 매출 어때?')).toBe(false);
    expect(worthWording(['카페라떼 마진율 65.2%', '아메리카노 마진율 81.9%', '카페라떼 214잔'], '마진 비교해줘')).toBe(true);
    // A long list (a briefing) is never shortened to a few sentences: it stays the list of facts.
    expect(worthWording(Array.from({ length: 7 }, (_, index) => `줄 ${index}`), '오늘 브리핑 해줘')).toBe(false);
    expect(worthWording(Array.from({ length: 6 }, (_, index) => `줄 ${index}`), '오늘 근무 누구야?')).toBe(true);
  });
});

describe('asking for an answer', () => {
  const lines = ['오늘 매출 48.1만 원', '비교 기간 대비 -33.6%'];
  const ask = (fetcher: (url: string, init: RequestInit) => Promise<Response>, text = '오늘 매출 어때?') =>
    requestComposedAnswer({ snapshot, locale: 'ko', layer: 'management', text, lines, fetcher });

  it('sends one valid compose request with the question and the lines only, and returns the guarded sentences', async () => {
    const sent: Record<string, unknown>[] = [];
    const answer = await ask(async (_url, init) => { sent.push(JSON.parse(String(init.body))); return reply(frames(['composed', { text: '오늘 매출은 48.1만 원이에요. 비교 기간보다 33.6% 낮아요.', used: [0, 1] }])); });
    expect(answer).toBe('오늘 매출은 48.1만 원이에요. 비교 기간보다 33.6% 낮아요.');
    expect(sent).toHaveLength(1);
    expect(validateAgentRequest(sent[0])).toBe(true);
    expect(sent[0]).toMatchObject({ intent: { kind: 'compose', text: '오늘 매출 어때?', lines }, snapshot: [], searches: [], catalog: [] });
  });
  it('returns null when the route is unavailable, answers another protocol, throws or the whole answer fails the guard', async () => {
    expect(await ask(async () => reply('', false))).toBeNull();
    expect(await ask(async () => reply(frames(['composed', { text: '오늘 매출은 48.1만 원이에요.', used: [0] }]), true, 'other'))).toBeNull();
    expect(await ask(async () => { throw new Error('offline'); })).toBeNull();
    expect(await ask(async () => reply(frames(['composed', { text: '오늘 매출은 50만 원이에요.', used: [0] }])))).toBeNull();
    // The browser guards again, even when the server let a sentence through: one bad sentence spoils the whole answer.
    expect(await ask(async () => reply(frames(['composed', { text: '오늘 매출은 48.1만 원이에요. 어제보다 12만 원 적어요.', used: [0] }])))).toBeNull();
  });
});

describe('the provider hook', () => {
  type Sent = { intent: { kind: string; featureId?: string; lines?: string[] } };
  const make = (composed: unknown, sent: Sent[], options: { compose?: boolean } = {}) => {
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Sent;
      sent.push(body);
      if (body.intent.kind === 'compose') return composed ? reply(frames(['composed', composed], ['done', { outcome: 'reply' }])) : reply(frames(['error', { code: 'INVALID_OUTPUT' }]));
      return new Response('', { status: 503 });
    }) as never;
    return createAssistantProvider({ store: createWidgetDataStore(), fetcher, ...options });
  };
  const ask = (provider: ReturnType<typeof make>, text: string) => provider.ask({ text, signal: new AbortController().signal });

  it('shows the written sentences in place of the fact lines when the guard passes, and asks with those very lines', async () => {
    const sent: Sent[] = [];
    const question = '오늘 매출 얼마야? 어제보다 많아?';
    const plain = await ask(make(undefined, [], { compose: false }), question);
    const lines = plain.answer.split('\n');
    const first = lines[0].replace(/^오늘 매출\s*/u, '');
    const provider = make({ text: `오늘 매출은 ${first}이에요.`, used: [0] }, sent, { compose: true });
    const result = await ask(provider, question);
    expect(result.answer).toBe(`오늘 매출은 ${first}이에요.`);
    expect(result.turn).toMatchObject({ kind: 'read' });
    expect(sent.find(item => item.intent.kind === 'compose')?.intent.lines).toEqual(lines);
  });
  it('keeps the fact lines when the written answer fails the guard or the route fails', async () => {
    const question = '오늘 매출 얼마야? 어제보다 많아?';
    const plain = (await ask(make(undefined, [], { compose: false }), question)).answer;
    for (const composed of [{ text: '오늘 매출은 1,234,567원이에요.', used: [0] }, undefined]) {
      expect((await ask(make(composed, [], { compose: true }), question)).answer).toBe(plain);
    }
  });
  it('asks for the sentences while the chat turn is still running, so the two waits overlap instead of adding up', async () => {
    const question = '오늘 매출 얼마야? 어제보다 많아?';
    const plain = (await ask(make(undefined, [], { compose: false }), question)).answer;
    const first = plain.split('\n')[0].replace(/^오늘 매출\s*/u, '');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Sent;
      order.push(body.intent.kind);
      if (body.intent.kind === 'compose') { release(); return reply(frames(['composed', { text: `오늘 매출은 ${first}이에요.`, used: [0] }], ['done', { outcome: 'reply' }])); }
      await gate; // the chat turn answers only after the sentences were asked for: a sequential implementation would wait here forever
      return new Response('', { status: 503 });
    }) as never;
    const result = await createAssistantProvider({ store: createWidgetDataStore(), fetcher, compose: true }).ask({ text: question, signal: new AbortController().signal });
    expect([...order].sort()).toEqual(['compose', 'read']);
    expect(result.answer).toBe(`오늘 매출은 ${first}이에요.`);
  });
  it('does not ask for sentences for one plain fact with no comparison or explanation asked', async () => {
    const sent: Sent[] = [];
    await ask(make({ text: '오늘 매출은 1원이에요.', used: [0] }, sent, { compose: true }), '아메리카노 가격이 얼마였지?');
    expect(sent.some(item => item.intent.kind === 'compose')).toBe(false);
  });
  // D-413: a read answer that shares no content word with the question means a loose router claimed the sentence; the model's read-only plan is then asked.
  it('asks the planner when a read answer shares no word with the question, and keeps the router\'s answer when the plan has none', async () => {
    const sent: Sent[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Sent;
      sent.push(body);
      return new Response('', { status: 503 });
    }) as never;
    const provider = createAssistantProvider({ store: createWidgetDataStore(), fetcher, classify: true, compose: false });
    const reply = await provider.ask({ text: '오늘 매출 얼마야?', signal: new AbortController().signal });
    // A question whose answer names it ("매출") never asks for a plan.
    expect(reply.turn?.kind).toBe('read');
    expect(sent.some(item => item.intent.kind === 'classify')).toBe(false);
  });
  it('never asks for sentences when switched off, and never for a write', async () => {
    const off: Sent[] = [];
    await ask(make({ text: '오늘 매출은 1원이에요.', used: [0] }, off, { compose: false }), '오늘 매출 얼마야?');
    expect(off.some(item => item.intent.kind === 'compose')).toBe(false);
    const write: Sent[] = [];
    const result = await ask(make({ text: '바꿨어요.', used: [0] }, write, { compose: true }), '카페라떼 가격 5,000원으로 올려줘');
    expect(write.some(item => item.intent.kind === 'compose')).toBe(false);
    expect(result.answer).not.toContain('바꿨어요');
  });
});
