// D-371: the browser side of read-only intent classification.
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../data/widget-data';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentRequest } from '../../../shared/navis-agent-schema.mjs';
import { createAssistantProvider } from './provider';
import { inferCompute, keepHinted, periodNameOf, planToRoute, readPlanFrames, requestIntentPlan, widgetLines, type IntentPlan } from './classify';
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
    const last = [{ featureId: 'ledger', condition: { kind: 'default' as const } }];
    const plan: IntentPlan = { kind: 'read', confidence: 'high', reads: [{ featureId: 'ledger', period: 'tomorrow', hints: ['매출'] }] };
    expect(planToRoute(plan, snapshot, 'ko', last)).toMatchObject({ intent: { kind: 'read', featureId: 'ledger' } });
    expect(planToRoute(plan, snapshot, 'ko', [])).toMatchObject({ kind: 'answer' });
  });
  it('reads the shifts of tomorrow with the widget\'s own one-day range, so the people and their hours are shown', () => {
    const route = planToRoute({ kind: 'read', confidence: 'high', reads: [{ featureId: 'staff-schedule', period: 'tomorrow', hints: ['오전'] }] }, snapshot) as
      { intent: { kind: string; featureId: string; condition: { kind: string; start: string; end: string } } };
    expect(route.intent).toMatchObject({ kind: 'read', featureId: 'staff-schedule', condition: { kind: 'dateRange' } });
    expect(route.intent.condition.start).toBe(route.intent.condition.end);
    expect(route.intent.condition.start > (snapshot.pos?.businessDate ?? '')).toBe(true);
  });
  it('keeps the shifts that overlap the part of the day named in the hints (오전·오후·저녁), whatever else the facts say', () => {
    const shifts = [fact('근무 2명', '근무 2명'), fact('근무 11/18(수)', '박도현 16:00~22:00'), fact('근무 11/18(수)', '윤서진 08:00~16:30'), fact('근무 11/18(수)', '한소은 10:00~15:00')];
    const names = (hints: string[]) => keepHinted(hints)(shifts).map(item => item.display);
    expect(names(['오전'])).toEqual(['윤서진 08:00~16:30', '한소은 10:00~15:00']);
    expect(names(['오후'])).toEqual(['박도현 16:00~22:00', '윤서진 08:00~16:30', '한소은 10:00~15:00']);
    expect(names(['저녁'])).toEqual(['박도현 16:00~22:00']);
    expect(names(['오전', '윤서진'])).toEqual(['윤서진 08:00~16:30']);
    expect(names(['새벽'])).toEqual([]);
  });
  it('puts the facts with a time range first when the sentence asks until when or what time and the model named nothing', () => {
    const shifts = [fact('근무 2명', '근무 2명'), fact('직원', '직원 5명'), fact('근무 11/18(수)', '박도현 16:00~22:00')];
    expect(keepHinted([], { timeWords: true })(shifts).map(item => item.display)).toEqual(['박도현 16:00~22:00', '근무 2명', '직원 5명']);
    expect(keepHinted([])(shifts).map(item => item.display)).toEqual(['근무 2명', '직원 5명', '박도현 16:00~22:00']);
  });
});

describe('arithmetic the sentence asks for', () => {
  const read = (hints: string[], featureId = 'ledger', period: 'today' | 'month' | 'default' = 'month') => ({ featureId, period, hints });
  const base = { kind: 'read' as const, confidence: 'high' as const };
  it('adds a difference for "빼면 얼마 남아", keeping sales on the left whatever order the model gave', () => {
    const plan = inferCompute({ ...base, reads: [read(['지출']), read(['매출'])] }, '이번달 매출에서 지출 빼면 얼마 남아?');
    expect(plan).toMatchObject({ compute: { op: 'diff', left: 1, right: 0 } });
  });
  it('adds a sum for "합치면" and a share (sales as the divisor) for "몇 퍼센트"', () => {
    expect(inferCompute({ ...base, reads: [read(['부가세'], 'tax', 'default'), read(['지출'])] }, '부가세 낼 돈이랑 이번달 지출 합치면 얼마야?'))
      .toMatchObject({ compute: { op: 'sum', left: 0, right: 1 } });
    expect(inferCompute({ ...base, reads: [read(['원재료', '매출'])] }, '재료비가 매출에서 몇 퍼센트 차지해?'))
      .toMatchObject({ reads: [{ hints: ['원재료'] }, { hints: ['매출'] }], compute: { op: 'ratio', left: 0, right: 1 } });
  });
  it('leaves a plan alone when the model already chose arithmetic, no cue is in the sentence, or the reads are not a pair', () => {
    const own = { ...base, compute: { op: 'sum' as const, left: 0, right: 1 }, reads: [read(['매출']), read(['지출'])] };
    expect(inferCompute(own, '빼면 얼마')).toBe(own);
    const plain = { ...base, reads: [read(['매출']), read(['지출'])] };
    expect(inferCompute(plain, '이번달 매출이랑 지출 알려줘')).toBe(plain);
    const three = { ...base, reads: [read(['a']), read(['b']), read(['c'])] };
    expect(inferCompute(three, '합치면 얼마')).toBe(three);
  });
  it('answers with the derived amount among the shown facts', () => {
    const facts = projectAgentWidget(snapshot, 'ledger', { kind: 'default' }, 'ko').facts as readonly SnapshotFact[];
    const sales = facts.find(item => item.label.includes('매출') && item.unit === 'KRW')!;
    const spent = facts.find(item => item.label.includes('지출') && item.unit === 'KRW')!;
    const route = planToRoute({ ...base, reads: [read(['매출'], 'ledger', 'today'), read(['지출'], 'ledger', 'today')] }, snapshot, 'ko', [], '오늘 매출에서 지출 빼면 얼마 남아?') as
      { narrow: (f: readonly SnapshotFact[]) => readonly SnapshotFact[] };
    expect(route.narrow(facts).find(item => item.key === 'derived.diff')?.value).toBe(Number(sales.value) - Number(spent.value));
  });
});

describe('picking the facts a question is about', () => {
  const hourly = (hour: string, display: string) => ({ ...fact(`시간대별 매출 ${hour}`, display, 'ledger.sales.hourly') });
  it('keeps the hours of a named part of the day (점심 = 11~13시) from facts that carry a single hour', () => {
    const rows = [hourly('10:00', '86,420원'), hourly('11:00', '73,900원'), hourly('12:00', '156,740원'), hourly('13:00', '115,240원'), hourly('14:00', '105,370원')];
    expect(keepHinted(['점심'])(rows).map(item => item.label)).toEqual(['시간대별 매출 11:00', '시간대별 매출 12:00', '시간대별 매출 13:00']);
    expect(keepHinted(['저녁'])(rows)).toEqual([]);
  });
  it('maps peak, per-day and per-hour words to the fact kinds that hold them', () => {
    const rows = [fact('오늘 매출', '83만', 'ledger.sales.net'), hourly('12:00', '156,740원'), { ...fact('시간대별 매출 12:00', '156,740원', 'ledger.sales.peak') },
      fact('11월 16일', '1,077,440원', 'ledger.sales.daily'), fact('11월 17일', '831,220원', 'ledger.sales.daily')];
    expect(keepHinted(['피크 시간']).call(null, rows).map(item => item.key)).toEqual(['ledger.sales.peak']);
    expect(keepHinted(['요일별']).call(null, rows).map(item => item.label)).toEqual(['11월 16일', '11월 17일']);
    expect(keepHinted(['시간대별'])(rows).every(item => item.key === 'ledger.sales.hourly')).toBe(true);
  });
  it('puts the exact menu name and the kind of number the sentence asks for (rate or count) first', () => {
    const rows = [fact('헤이즐넛 아메리카노', '36,064원'), fact('아메리카노', '1,123,040원'), { ...fact('헤이즐넛 아메리카노', '77.1%'), unit: 'percent' }, { ...fact('아메리카노', '81.8%'), unit: 'percent' },
      { ...fact('아메리카노', '475잔'), unit: 'count' }];
    expect(keepHinted(['아메리카노'], { prefer: 'percent' })(rows).map(item => item.display)[0]).toBe('81.8%');
    // Two named items: each gets its own best fact first, so a comparison shows both rates before anything else.
    const two = [...rows, { ...fact('카페라떼', '65.2%'), unit: 'percent' }, fact('카페라떼', '273,492원')];
    expect(keepHinted(['카페라떼', '아메리카노'], { prefer: 'percent' })(two).map(item => item.display).slice(0, 2)).toEqual(['65.2%', '81.8%']);
    expect(keepHinted(['아메리카노'], { prefer: 'count' })(rows).map(item => item.display)[0]).toBe('475잔');
  });
  it('picks the lowest or highest day for "제일 한가했던 요일", with its weekday, and nothing when there is only one day', () => {
    const days = [{ ...fact('11월 15일', '830,000원', 'ledger.sales.daily'), value: 830000, date: '2026-11-15' }, { ...fact('11월 16일', '1,077,440원', 'ledger.sales.daily'), value: 1077440, date: '2026-11-16' },
      { ...fact('11월 17일', '600,000원', 'ledger.sales.daily'), value: 600000, date: '2026-11-17' }];
    const low = inferCompute({ kind: 'read', confidence: 'high', reads: [{ featureId: 'ledger', period: 'week', hints: [] }] }, '이번 주에 제일 한가했던 요일이 언제야?');
    expect(low).toMatchObject({ compute: { op: 'min', left: 0, right: 0 } });
    const route = planToRoute({ kind: 'read', confidence: 'high', reads: [{ featureId: 'ledger', period: 'week', hints: [] }] }, snapshot, 'ko', [], '이번 주에 제일 한가했던 요일이 언제야?') as
      { narrow: (f: readonly SnapshotFact[]) => readonly SnapshotFact[] };
    const shown = route.narrow(days);
    expect(shown.find(item => item.key === 'derived.min')).toMatchObject({ value: 600000, display: expect.stringContaining('화요일') });
    expect(route.narrow([days[0]]).some(item => item.key === 'derived.min')).toBe(false);
  });
  it('writes the month and day of the lowest day, not the year twice', () => {
    const days = [{ ...fact('11월 15일', '830,000원', 'ledger.sales.daily'), value: 830000, date: '2026-11-15' }, { ...fact('11월 16일', '1,077,440원', 'ledger.sales.daily'), value: 1077440, date: '2026-11-16' }];
    const route = planToRoute({ kind: 'read', confidence: 'high', reads: [{ featureId: 'ledger', period: 'week', hints: [] }] }, snapshot, 'ko', [], '이번 주에 제일 한가했던 요일이 언제야?') as
      { narrow: (f: readonly SnapshotFact[]) => readonly SnapshotFact[] };
    expect(route.narrow(days).find(item => item.key === 'derived.min')?.display).toBe('11월 15일(일요일) 830,000원');
    // The per-day rows come from the widget's rolling window, so the answer names that window instead of passing for the calendar week.
    expect(route.narrow(days).find(item => item.key === 'derived.min')?.label).toMatch(/^최근 7일\(\d\d\/\d\d~\d\d\/\d\d\) 중 가장 낮은 날$/u);
  });
  it('says a state-only widget has no history when two of its periods are asked for', () => {
    const route = planToRoute({ kind: 'read', confidence: 'high', reads: [{ featureId: 'members', period: 'week', hints: ['단골'] }, { featureId: 'members', period: 'lastWeek', hints: ['단골'] }] }, snapshot);
    expect(route).toMatchObject({ kind: 'answer', answer: expect.stringContaining('비교할 수 없어요') });
  });
  it('reads a periodless widget (tax, menu, members, stock) as its current state for whatever period the model wrote', () => {
    for (const period of ['month', 'lastMonth', 'week', 'default'] as const) {
      expect(planToRoute({ kind: 'read', confidence: 'high', reads: [{ featureId: 'tax', period, hints: ['부가세'] }] }, snapshot)).toMatchObject({ intent: { kind: 'read', featureId: 'tax' } });
    }
  });
});

describe('naming the period an earlier read used, for a follow-up', () => {
  const today = '2026-11-17';
  it.each([
    [{ kind: 'default' }, 'default'], [{ kind: 'snapshot', asOf: today }, 'today'],
    [{ kind: 'dateRange', start: today, end: today }, 'today'], [{ kind: 'dateRange', start: '2026-11-18', end: '2026-11-18' }, 'tomorrow'],
    [{ kind: 'dateRange', start: '2026-11-16', end: '2026-11-16' }, 'yesterday'], [{ kind: 'dateRange', start: '2026-11-11', end: today }, 'week'],
    [{ kind: 'dateRange', start: '2026-11-16', end: today }, 'week'], [{ kind: 'dateRange', start: '2026-11-09', end: '2026-11-15' }, 'lastWeek'],
    [{ kind: 'dateRange', start: '2026-11-01', end: today }, 'month'], [{ kind: 'dateRange', start: '2026-10-19', end: today }, 'last30'],
    [{ kind: 'dateRange', start: '2026-10-01', end: '2026-10-31' }, 'lastMonth'], [{ kind: 'dateRange', start: '2026-03-02', end: '2026-03-04' }, 'default'],
  ] as const)('%j is %s', (condition, name) => { expect(periodNameOf(condition, today)).toBe(name); });
});

describe('the provider hook', () => {
  type Sent = { intent: { kind: string; featureId?: string; previous?: string } };
  const planFetcher = (plan: unknown, sent: Sent[]) => (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    if (body.intent.kind === 'classify') {
      return new Response(plan ? frames(['intent_plan', { plan }], ['done', { outcome: 'reply' }]) : frames(['error', { code: 'INVALID_OUTPUT' }]),
        { headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
    }
    return new Response('', { status: 503 });
  }) as never;
  const ask = (text: string, plan: unknown, sent: Sent[]) => createAssistantProvider({ store: createWidgetDataStore(), fetcher: planFetcher(plan, sent), classify: true, compose: false })
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
  it.each([false, true])('answers a classified current ranking with one grounded promotion handoff (follow-up %s)', async followUp => {
    const sent: Sent[] = [];
    const data = createWidgetDataStore({ exampleLocalTrends: { candidates: [], ranking: {
      status: 'ready', period: { from: '2026-10-13', to: '2026-11-16' }, fetchedAt: '2026-11-17T06:45:00Z',
      items: [{ rank: 1, id: 'scone', keyword: '호두 스콘', changePercent: 17.2, points: [], isMenu: true,
        menuName: '버터 호두 스콘', classification: 'rising' }],
    } } });
    const current = { featureId: 'local-trends', period: 'default', hints: ['가게 활용'] };
    const reads = followUp ? [{ featureId: 'local-changes', period: 'default', hints: [] }, current,
      { featureId: 'trade-area', period: 'default', hints: [] }] : [current];
    const fetcher = planFetcher({ kind: 'read', confidence: 'high', reads }, sent);
    const provider = createAssistantProvider({ store: data, fetcher, classify: true, compose: false });
    if (followUp) {
      await provider.ask({ text: '최근 인기 검색어 순위 알려 줘', layer: 'marketing', signal: new AbortController().signal });
    }
    const reply = await provider.ask({
      text: '최근 인기를 끄는 것 중 우리 매장에 접목할 아이디어가 있나?', layer: 'marketing', signal: new AbortController().signal,
    });
    expect(sent.map(item => item.intent.kind)).toEqual(['classify']);
    if (followUp) {
      expect(sent[0].intent.previous).toContain('local-trends@default');
      expect(planToRoute({ kind: 'read', confidence: 'high', reads: [
        { featureId: 'local-changes', period: 'default', hints: [] },
        { featureId: 'local-trends', period: 'default', hints: [] },
      ] }, data.getSnapshot(), 'ko', [{ featureId: 'local-trends', condition: { kind: 'default' } }],
      '동네 변화도 인기 검색어와 함께 알려줘')).toMatchObject({ intent: { kind: 'read', reads: [{ name: 'get_widget' }, { name: 'get_widget' }] } });
    }
    expect(reply.answer).toContain('호두 스콘 · 4주 대비 +17.2%');
    expect(reply.turn).toEqual({ kind: 'handoff', destination: { featureId: 'promo-video', step: 'place-video' } });
    expect(reply.proposalSession).toBeUndefined();
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
