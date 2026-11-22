// D-371: the browser side of read-only intent classification.
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../data/widget-data';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentRequest } from '../../../shared/navis-agent-schema.mjs';
import { createAssistantProvider } from './provider';
import { keepHinted, planToRoute, readPlanFrames, requestIntentPlan, widgetLines, type IntentPlan } from './classify';
import { projectAgentWidget, type SnapshotFact } from './snapshot';

const store = createWidgetDataStore();
const snapshot = store.getSnapshot();
const frames = (...pairs: [string, unknown][]) => pairs.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const fact = (label: string, display: string, key = 'k'): SnapshotFact => ({ key, value: 1, unit: 'KRW', label, display });

describe('widget list', () => {
  it('has one id|name|labels line per widget of the layer, within the schema limits', () => {
    const lines = widgetLines(snapshot, 'ko', 'management');
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.length).toBeLessThanOrEqual(64);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(400);
      expect(line.split('|')).toHaveLength(3);
    }
    const ledger = lines.find(line => line.startsWith('ledger|'))!;
    expect(ledger).toContain('매출');
    expect(ledger).toContain('지출');
    expect(lines.find(line => line.startsWith('margin|'))).toContain('메뉴별 판매 수량');
  });
});

describe('reading the plan frames', () => {
  const plan: IntentPlan = { kind: 'read', confidence: 'high', reads: [{ featureId: 'ledger', period: 'month', hints: ['지출'] }] };
  it('returns the plan from an intent_plan frame', () => {
    expect(readPlanFrames(frames(['status', { step: 'accepted' }], ['intent_plan', { plan }], ['done', { outcome: 'reply' }]))).toEqual(plan);
  });
  it.each([
    ['an error frame', frames(['status', { step: 'accepted' }], ['error', { code: 'INVALID_OUTPUT' }])],
    ['a plan outside the schema', frames(['intent_plan', { plan: { kind: 'command', command: 'menu.delete' } }])],
    ['no plan', frames(['done', { outcome: 'reply' }])],
    ['broken data', 'event: intent_plan\ndata: {oops\n\n'],
  ])('returns null for %s', (_name, body) => { expect(readPlanFrames(body)).toBeNull(); });
});

describe('asking for a plan', () => {
  const reply = (body: string, ok = true, protocol: string = AGENT_PROTOCOL) => new Response(body, { status: ok ? 200 : 503, headers: { [AGENT_PROTOCOL_HEADER]: protocol } });
  it('sends one valid classify request that holds the sentence and no store data', async () => {
    const sent: Record<string, unknown>[] = [];
    const plan: IntentPlan = { kind: 'unsupported' };
    const result = await requestIntentPlan({ snapshot, locale: 'ko', layer: 'management', text: '아아 몇 잔 나갔냐', previous: '이번 주 매출',
      fetcher: async (_url, init) => { sent.push(JSON.parse(String(init.body))); return reply(frames(['intent_plan', { plan }])); } });
    expect(result).toEqual(plan);
    expect(sent).toHaveLength(1);
    expect(validateAgentRequest(sent[0])).toBe(true);
    expect(sent[0]).toMatchObject({ intent: { kind: 'classify', text: '아아 몇 잔 나갔냐', previous: '이번 주 매출' }, snapshot: [], searches: [], catalog: [] });
  });
  it('returns null when the route is unavailable, answers with another protocol or throws', async () => {
    const ask = (fetcher: (url: string, init: RequestInit) => Promise<Response>) => requestIntentPlan({ snapshot, locale: 'ko', layer: 'management', text: '질문', fetcher });
    expect(await ask(async () => reply('', false))).toBeNull();
    expect(await ask(async () => reply(frames(['intent_plan', { plan: { kind: 'unsupported' } }]), true, 'other'))).toBeNull();
    expect(await ask(async () => { throw new Error('offline'); })).toBeNull();
  });
});

describe('turning a plan into typed reads', () => {
  it('turns one read into a single typed widget read that keeps the hinted facts', () => {
    const route = planToRoute({ kind: 'read', confidence: 'high', reads: [{ featureId: 'ledger', period: 'today', hints: ['지출'] }] }, snapshot);
    expect(route).toMatchObject({ intent: { kind: 'read', featureId: 'ledger' } });
    const narrow = (route as { narrow: (facts: readonly SnapshotFact[]) => readonly SnapshotFact[] }).narrow;
    expect(narrow([fact('매출', '10원'), fact('지출', '5원')]).map(item => item.label)).toEqual(['지출']);
  });
  it('turns several widgets into an ordered read list, one narrowing part per read, without repeats', () => {
    const read = { featureId: 'ledger', period: 'today' as const, hints: ['매출'] };
    const route = planToRoute({ kind: 'read', confidence: 'low', reads: [read, { ...read, featureId: 'margin' }, read] }, snapshot);
    expect(route).toMatchObject({ intent: { kind: 'read', reads: [{ name: 'get_widget' }, { name: 'get_widget' }] } });
    expect((route as unknown as { readParts: unknown[] }).readParts).toHaveLength(2);
  });
  it('never lets today stand in for a period the widget cannot show: it says which periods exist', () => {
    const route = planToRoute({ kind: 'read', confidence: 'high', reads: [{ featureId: 'margin', period: 'lastMonth', hints: [] }, { featureId: 'ledger', period: 'today', hints: [] }] }, snapshot);
    expect(route).toMatchObject({ kind: 'answer' });
    expect((route as { answer: string }).answer).toContain('이 기간의 자료는 제공되지 않아요');
    expect((route as { answer: string }).answer).toContain('볼 수 있는 기간');
  });
  it('asks the model-written question back, and leaves an unsupported plan to the existing fallback', () => {
    expect(planToRoute({ kind: 'clarify', ask: '어느 기간인가요?' }, snapshot)).toEqual({ kind: 'answer', answer: '어느 기간인가요?' });
    expect(planToRoute({ kind: 'unsupported' }, snapshot)).toBeUndefined();
  });
  it('keeps the first four facts when no hint matches, never more than six, and drops repeated lines', () => {
    const many = Array.from({ length: 12 }, (_, index) => fact(`항목${index}`, `${index}원`));
    expect(keepHinted(['없는말'])(many)).toHaveLength(4);
    expect(keepHinted([])(many)).toHaveLength(6);
    expect(keepHinted(['항목3'])(many).map(item => item.label)).toEqual(['항목3']);
    expect(keepHinted([])([fact('매출', '1원'), fact('매출', '1원'), fact('지출', '2원')]).map(item => item.label)).toEqual(['매출', '지출']);
    const menus = [fact('소금빵', '판매 88건'), fact('소금빵', '마진 55%'), fact('소금빵', '매출 1원'), fact('베이글', '판매 20건'), fact('베이글', '마진 61%')];
    expect(keepHinted(['소금빵', '베이글'])(menus).map(item => `${item.label} ${item.display}`)).toEqual(['소금빵 판매 88건', '베이글 판매 20건', '소금빵 마진 55%', '베이글 마진 61%', '소금빵 매출 1원']);
  });
  it('merges reads of one widget and period into one wire read and appends the derived difference', () => {
    const route = planToRoute({ kind: 'read', confidence: 'high', compute: { op: 'diff', left: 0, right: 1 },
      reads: [{ featureId: 'ledger', period: 'today', hints: ['매출'] }, { featureId: 'ledger', period: 'today', hints: ['지출'] }] }, snapshot) as
      { intent: { kind: string; featureId?: string }; narrow: (facts: readonly SnapshotFact[]) => readonly SnapshotFact[] };
    expect(route.intent).toMatchObject({ kind: 'read', featureId: 'ledger' });
    const facts = projectAgentWidget(snapshot, 'ledger', { kind: 'default' }, 'ko').facts as readonly SnapshotFact[];
    const sales = facts.find(item => item.label.includes('매출') && item.unit === 'KRW')!;
    const spent = facts.find(item => item.label.includes('지출') && item.unit === 'KRW')!;
    const derived = route.narrow(facts).find(item => item.key === 'derived.diff')!;
    expect(derived.value).toBe(Number(sales.value) - Number(spent.value));
    expect(derived.display).toBe(`${(Number(sales.value) - Number(spent.value)).toLocaleString('ko-KR')}원`);
  });
  it('adds a ratio as a percent and adds nothing when an amount is missing or the divisor is zero', () => {
    const base = { kind: 'read' as const, confidence: 'high' as const };
    const facts = projectAgentWidget(snapshot, 'ledger', { kind: 'default' }, 'ko').facts as readonly SnapshotFact[];
    const ratio = planToRoute({ ...base, compute: { op: 'ratio', left: 0, right: 1 },
      reads: [{ featureId: 'ledger', period: 'today', hints: ['지출'] }, { featureId: 'ledger', period: 'today', hints: ['매출'] }] }, snapshot) as { narrow: (f: readonly SnapshotFact[]) => readonly SnapshotFact[] };
    const shown = ratio.narrow(facts).find(item => item.key === 'derived.ratio');
    expect(shown?.unit).toBe('percent');
    const none = planToRoute({ ...base, compute: { op: 'sum', left: 0, right: 1 },
      reads: [{ featureId: 'ledger', period: 'today', hints: ['매출'] }, { featureId: 'ledger', period: 'today', hints: ['없는항목이름'] }] }, snapshot) as { narrow: (f: readonly SnapshotFact[]) => readonly SnapshotFact[] };
    expect(none.narrow(facts).some(item => item.key.startsWith('derived.'))).toBe(false);
  });
  it('keeps the period of the read a follow-up stays on when the widget has none for the new one', () => {
    const last = [{ featureId: 'staff-schedule', condition: { kind: 'default' as const } }];
    const plan: IntentPlan = { kind: 'read', confidence: 'high', reads: [{ featureId: 'staff-schedule', period: 'tomorrow', hints: ['오전'] }] };
    expect(planToRoute(plan, snapshot, 'ko', last)).toMatchObject({ intent: { kind: 'read', featureId: 'staff-schedule' } });
    expect(planToRoute(plan, snapshot, 'ko', [])).toMatchObject({ kind: 'answer' });
  });
});

describe('the provider hook', () => {
  type Sent = { intent: { kind: string; featureId?: string } };
  const planFetcher = (plan: unknown, sent: Sent[]) => (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    if (body.intent.kind === 'classify') {
      return new Response(plan ? frames(['intent_plan', { plan }], ['done', { outcome: 'reply' }]) : frames(['error', { code: 'INVALID_OUTPUT' }]),
        { headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
    }
    return new Response('', { status: 503 });
  }) as never;
  const ask = (text: string, plan: unknown, sent: Sent[]) => createAssistantProvider({ store: createWidgetDataStore(), fetcher: planFetcher(plan, sent), classify: true })
    .ask({ text, signal: new AbortController().signal });

  it('asks for a plan only for a sentence no router placed, then sends the planned typed read', async () => {
    const sent: Sent[] = [];
    await ask('뭔가 처음 보는 말투로 물어봐요 가나다', { kind: 'read', confidence: 'high', reads: [{ featureId: 'ledger', period: 'today', hints: ['지출'] }] }, sent);
    expect(sent.map(item => item.intent.kind)).toEqual(['classify', 'read']);
    expect(sent[1].intent.featureId).toBe('ledger');
  });
  it('answers the question the model wrote back, without a second request', async () => {
    const sent: Sent[] = [];
    const reply = await ask('뭔가 처음 보는 말투로 물어봐요 가나다', { kind: 'clarify', ask: '어느 기간인가요?' }, sent);
    expect(reply.answer).toBe('어느 기간인가요?');
    expect(sent).toHaveLength(1);
  });
  it('keeps the existing answer when the plan is unsupported or the route fails', async () => {
    for (const plan of [{ kind: 'unsupported' }, undefined]) {
      const sent: Sent[] = [];
      const reply = await ask('뭔가 처음 보는 말투로 물어봐요 가나다', plan, sent);
      expect(sent.filter(item => item.intent?.kind === 'classify')).toHaveLength(1);
      expect(sent.some(item => item.intent?.kind === 'read')).toBe(false);
      expect(reply.answer).toBeTruthy();
    }
  });
  const kinds = (sent: Sent[]) => sent.map(item => item.intent?.kind);
  it('lets the plan replace a router read when the sentence is a comparison, and keeps the router read when the plan fails', async () => {
    const plan = { kind: 'read', confidence: 'high', reads: [{ featureId: 'ledger', period: 'today', hints: ['매출'] }] };
    const sent: Sent[] = [];
    await ask('카페라떼랑 아메리카노 마진 비교해줘', plan, sent);
    expect(kinds(sent).slice(0, 2)).toEqual(['classify', 'read']);
    expect(sent[1].intent.featureId).toBe('ledger');
    const kept: Sent[] = [];
    await ask('카페라떼랑 아메리카노 마진 비교해줘', undefined, kept);
    expect(kinds(kept)[0]).toBe('classify');
    expect(kept.find(item => item.intent?.kind === 'read')?.intent.featureId).not.toBe('ledger');
  });
  it('asks for a plan before a router dead end is shown, and still shows the dead end when the plan is unusable', async () => {
    const plan = { kind: 'read', confidence: 'high', reads: [{ featureId: 'tax', period: 'default', hints: ['부가세'] }] };
    const sent: Sent[] = [];
    await ask('지난달 지출 알려줘', plan, sent);
    expect(kinds(sent)).toContain('classify');
    expect(sent.find(item => item.intent?.kind === 'read')?.intent.featureId).toBe('tax');
    const failed: Sent[] = [];
    const reply = await ask('지난달 지출 알려줘', undefined, failed);
    expect(reply.answer).toBeTruthy();
  });
  it('never asks for a plan for the reviewed comparison phrasing', async () => {
    const sent: Sent[] = [];
    await ask('지난주 같은 요일이랑 비교하면 오늘 매출이 어때?', { kind: 'unsupported' }, sent);
    expect(kinds(sent)).not.toContain('classify');
  });
  it('never classifies a sentence a router already answers', async () => {
    const sent: Sent[] = [];
    await ask('오늘 매출 얼마야?', { kind: 'unsupported' }, sent);
    expect(sent.map(item => item.intent.kind)).not.toContain('classify');
  });
});
