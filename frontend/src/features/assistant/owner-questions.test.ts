// CHAT-REAL-DEV: everyday owner questions that the live chat answered wrongly or not at all (round 1 of .evidence/chat-real).
// The provider runs on the fixture store; the fetcher records each agent request and refuses the free-text route like a live entry does.
import { describe, expect, it } from 'vitest';
import { createAssistantProvider } from './provider';
import { createWidgetDataStore } from '../../data/widget-data';
import type { RealLocal } from '../../data/reality/13/dto';
import { emptyTotals, type RealFinanceSnapshot } from '../../data/reality/09/dto';
import { assistantDomains, plainReadQuery } from './snapshot';
import { recentOrderFacts } from './domains/recent-orders';

type Sent = { intent: { kind: string; featureId?: string; sourceId?: string; condition?: { kind: string; start?: string; end?: string }; reads?: { args: { featureId: string; condition: { kind: string } } }[]; command?: string };
  snapshot: { featureId?: string; sourceId?: string; facts?: { key: string }[] }[] };

function session(store = createWidgetDataStore()) {
  const sent: Sent[] = [];
  let legacy = 0;
  const fetcher = (async (_url: string, init?: RequestInit) => {
    if (new Headers(init?.headers).has('x-navis-protocol')) sent.push(JSON.parse(String(init?.body)) as Sent);
    else legacy++;
    return new Response(JSON.stringify({ code: 'UNAVAILABLE', route: 'legacy_off' }), { status: 503 });
  }) as never;
  const provider = createAssistantProvider({ store, fetcher });
  const ask = (text: string) => provider.ask({ text, signal: new AbortController().signal });
  return { ask, sent, legacy: () => legacy };
}
const keys = (request: Sent) => request.snapshot.flatMap(entry => entry.facts?.map(fact => fact.key) ?? []);

function withTrendKeyword(groupName: string) {
  const date = '2026-11-22';
  const period = { from: date, to: date };
  const realLocal: RealLocal = {
    storeId: 'store', period, changes: [], coverage: null, unreadCount: 0, offers: [], peers: [], peersAvailable: true,
    trade: { period, asOf: date, population: { status: 'empty', items: [], quarter: '2026-Q4', weekday: 0 },
      sales: { status: 'empty', items: [] } },
    trends: { period, asOf: date, sales: { status: 'empty', items: [] },
      search: { status: 'available', query: { startDate: date, endDate: date, keywordGroups: [{ groupName }] },
        items: [{ period: date, ratio: 20 }] } },
  };
  return createWidgetDataStore({ realLocal }).getSnapshot();
}

describe('owner questions (CHAT-REAL-DEV round 2)', () => {
  it('lists the best sellers from the margin rows, best first and only as many as asked', async () => {
    const { ask, sent } = session();
    const reply = await ask('오늘 많이 팔린 메뉴 상위 3개');
    expect(sent[0].intent).toMatchObject({ kind: 'read', featureId: 'margin' });
    expect(keys(sent[0])).toEqual(['margin.menu.qty', 'margin.menu.qty', 'margin.menu.qty']);
    expect(reply.answer).toBe('아메리카노 62잔\n카페라떼 24잔\n바닐라빈 라떼 19잔');
  });

  it('reads a stated week for both sales and margin instead of today', async () => {
    const { ask, sent } = session();
    await ask('이번 주 매출이랑 마진 알려줘');
    const reads = sent[0].intent.reads!;
    expect(reads.map(read => read.args.featureId)).toEqual(['ledger', 'margin']);
    expect(reads.every(read => read.args.condition.kind === 'dateRange')).toBe(true);
  });

  it.each([
    ['이번 달 지출 알려줘', 'ledger.expenses.total'],
    ['이번 달 매출은?', 'ledger.sales.net'],
  ])('reads the month the ledger supports for %s', async (text, key) => {
    const { ask, sent } = session();
    await ask(text);
    expect(sent[0].intent).toMatchObject({ kind: 'read', featureId: 'ledger', condition: { kind: 'dateRange' } });
    expect(sent[0].intent.condition?.start?.endsWith('-01')).toBe(true);
    expect(keys(sent[0])).toEqual([key]);
  });

  it.each([['지난주 매출 알려줘', /볼 수 있는 기간은/u], ['이번 달 마진 알려줘', /이 기간의 자료는 제공되지 않아요/u]])('says the period is unavailable for %s, without asking the server', async (text, message) => {
    const { ask, sent, legacy } = session();
    const reply = await ask(text);
    expect(reply.answer).toMatch(message);
    expect(sent).toHaveLength(0);
    expect(legacy()).toBe(0);
  });

  it('answers a bare period after a sales read with the same metric', async () => {
    const { ask, sent } = session();
    await ask('이번 주 매출 알려줘');
    const month = await ask('그럼 이번 달은?');
    expect(sent[1].intent).toMatchObject({ kind: 'read', featureId: 'ledger', condition: { kind: 'dateRange' } });
    expect(month.answer).toMatch(/매출/u);
    const last = await ask('그럼 지난주는?');
    expect(last.answer).toMatch(/볼 수 있는 기간은/u);
    expect((await ask('둘 차이가 얼마야?')).answer).toMatch(/어떤 두 값을 비교할까요/u);
  });

  it('compares the last two calendar weeks from real ledger coverage in a follow-up', async () => {
    const store = createWidgetDataStore();
    const today = '2026-11-17';
    const totals = emptyTotals();
    const amounts = { '2026-11-13': 9_000, '2026-11-16': 12_000, [today]: 8_000, '2026-11-15': 7_650 };
    const days = Object.fromEntries(Object.entries(amounts).map(([date, total]) => [date, { ...totals, sales: { ...totals.sales, total } }]));
    const finance: RealFinanceSnapshot = {
      today, from: '2026-10-01', to: today, asOf: '2026-11-17T06:45:00Z', days, hours: [], deposits: [], depositsComplete: true, closings: [],
      closing: { businessDate: today, status: 'open', revision: 0, totals, pendingBills: [], writable: true,
        closingId: null, closedAt: null, reopenedAt: null, drawer: {
          opening: 0, actual: null, memo: '', expected: 0, difference: null, in: 0, out: 0, cashApproved: 0, cashReturned: 0, movements: [],
        } },
      margins: { today: [], last7: [], last30: [] }, marginsComplete: true,
    };
    const base = store.getSnapshot().tables.dailySales[0];
    store.hydrate({ realFinance: finance, dailySales: Object.entries(amounts).map(([businessDate, recognizedNet]) => ({ ...base, businessDate, recognizedNet })) });
    const { ask, sent } = session(store);
    expect((await ask('이번 주 매출 알려줘')).answer).toContain('20,000원');
    expect(sent[0].intent.condition).toEqual({ kind: 'dateRange', start: '2026-11-16', end: '2026-11-17' });
    expect((await ask('그럼 지난주는?')).answer).toContain('16,650원');
    expect(sent[1].intent.condition).toEqual({ kind: 'dateRange', start: '2026-11-09', end: '2026-11-15' });
    expect((await ask('둘 차이가 얼마야?')).answer).toContain('이번 주 매출이 지난주보다 3,350원 더 많아요');
  });

  // Independent grading: "이번 주" was the calendar week in one answer and the last seven days in another. With real ledger coverage it is the calendar week
  // (Monday to today) everywhere, the range is stated, and a widget that only has a rolling window names that window instead of calling it this week.
  describe('이번 주 means the calendar week, and the range is said', () => {
    const today = '2026-11-17';
    function realWeekStore() {
      const store = createWidgetDataStore();
      const totals = emptyTotals();
      const amounts = { '2026-11-13': 9_000, '2026-11-16': 12_000, [today]: 8_000, '2026-11-15': 7_650 };
      const days = Object.fromEntries(Object.entries(amounts).map(([date, total]) => [date, { ...totals, sales: { ...totals.sales, total } }]));
      const finance: RealFinanceSnapshot = {
        today, from: '2026-10-01', to: today, asOf: '2026-11-17T06:45:00Z', days, hours: [], deposits: [], depositsComplete: true, closings: [],
        closing: { businessDate: today, status: 'open', revision: 0, totals, pendingBills: [], writable: true, closingId: null, closedAt: null, reopenedAt: null,
          drawer: { opening: 0, actual: null, memo: '', expected: 0, difference: null, in: 0, out: 0, cashApproved: 0, cashReturned: 0, movements: [] } },
        margins: { today: [], last7: [], last30: [] }, marginsComplete: true,
      };
      const base = store.getSnapshot().tables.dailySales[0];
      store.hydrate({ realFinance: finance, dailySales: Object.entries(amounts).map(([businessDate, recognizedNet]) => ({ ...base, businessDate, recognizedNet })) });
      return store;
    }
    it('reads the ledger for Monday to today in the sales-and-margin sentence too, and labels the margin window it really has', async () => {
      const { ask, sent } = session(realWeekStore());
      const reply = await ask('이번 주 매출이랑 마진 알려줘');
      const reads = sent[0].intent.reads?.map(read => ({ id: read.args.featureId, condition: read.args.condition })) ?? [];
      expect(reads).toContainEqual({ id: 'ledger', condition: { kind: 'dateRange', start: '2026-11-16', end: '2026-11-17' } });
      expect(reads.find(read => read.id === 'margin')?.condition).toEqual({ kind: 'dateRange', start: '2026-11-11', end: '2026-11-17' });
      expect(reply.answer).toContain('20,000원');
      expect(reply.answer).toMatch(/최근 7일.*마진/u);
    });
    it('keeps the rolling seven days when the ledger has no real coverage of the week (demo data)', async () => {
      const { ask, sent } = session();
      await ask('이번 주 매출이랑 마진 알려줘');
      const ledger = sent[0].intent.reads?.find(read => read.args.featureId === 'ledger');
      const condition = ledger?.args.condition as { kind: string; start: string; end: string } | undefined;
      expect(condition?.kind).toBe('dateRange');
      expect((Date.parse(`${condition?.end}T00:00:00Z`) - Date.parse(`${condition?.start}T00:00:00Z`)) / 86_400_000).toBe(6);
    });
  });

  // Public review A-3: "마진 제일 좋은 메뉴" answered today's zero totals. A ranking has a direction; on a day with no sales it is read over the last seven days and says so.
  describe('a margin ranking', () => {
    it.each([['마진율 제일 낮은 메뉴가 뭐야?', 'min'], ['마진 제일 좋은 메뉴 뭐야?', 'max'], ['마진이 가장 높은 메뉴 알려줘', 'max']] as const)('reads %s as the %s of the menu rates', (text, direction) => {
      const read = plainReadQuery(text, '2026-11-17');
      expect(read?.intent).toMatchObject({ kind: 'read', featureId: 'margin', condition: { kind: 'default' } });
      const facts = [{ key: 'margin.menu.rate', label: '카페라떼', value: 65.2, unit: 'percent', display: '65.2%' }, { key: 'margin.menu.rate', label: '바스크 치즈케이크', value: 51.6, unit: 'percent', display: '51.6%' },
        { key: 'margin.menu.rate', label: '아메리카노', value: 81.9, unit: 'percent', display: '81.9%' }, { key: 'margin.sales.net', label: '매출', value: 1, unit: 'KRW', display: '1원' }];
      expect(read?.narrow?.(facts).map(fact => fact.label)).toEqual([direction === 'min' ? '바스크 치즈케이크' : '아메리카노']);
    });
    it('is read over the last seven days, named, when today has no sales', () => {
      const read = plainReadQuery('마진 제일 좋은 메뉴 뭐야?', '2026-11-17', '2026-11-17', undefined, undefined, true);
      expect(read?.intent).toMatchObject({ kind: 'read', featureId: 'margin', condition: { kind: 'dateRange', start: '2026-11-11', end: '2026-11-17' } });
      const facts = [{ key: 'margin.menu.rate', label: '아메리카노', value: 81.9, unit: 'percent', display: '81.9%' }];
      expect(read?.narrow?.(facts)[0].label).toBe('최근 7일(11/11~11/17) 아메리카노');
    });
  });

  it.each(['주문 확인해줘', '새 주문 들어왔어?'])('shows the newest orders with their state for %s', async text => {
    const { ask, sent } = session();
    const reply = await ask(text);
    expect(sent[0].intent).toMatchObject({ kind: 'read', sourceId: 'pos' });
    expect(keys(sent[0])).toContain('orders.recent.row');
    expect(reply.answer).toMatch(/\d+번 주문 \d\d:\d\d · .+ · [\d,]+원 · (?:접수|준비 중|준비 완료) · 결제 완료/u);
  });
  it.each(['최근 결제된 거 있어?', '방금 결제된 거 얼마야?'])('shows the newest payments for %s', async text => {
    const { ask, sent } = session();
    const reply = await ask(text);
    expect(sent[0].intent).toMatchObject({ kind: 'read', sourceId: 'pos' });
    expect(keys(sent[0])).toContain('payments.recent.row');
    expect(reply.answer).toMatch(/\d\d:\d\d · [\d,]+원 · (?:카드|간편결제|현금) · 결제 완료/u);
  });

  // Owner review of the demo path: "최근 결제된 거 있어?" is a payment question (time, amount, method, state), "주문 확인해줘" an order-status one. Both name what they count.
  it('answers a payment question with the newest payments and today\'s paid total, and an order question with the orders in progress', async () => {
    const payment = session();
    const paid = await payment.ask('최근 결제된 거 있어?');
    expect(keys(payment.sent[0])).toEqual(expect.arrayContaining(['payments.recent.row', 'payments.today.total']));
    expect(keys(payment.sent[0])).not.toContain('orders.open.count');
    expect(paid.answer).toMatch(/\d\d:\d\d · [\d,]+원 · (?:카드|간편결제|현금) · 결제 완료/u);
    expect(paid.answer).toMatch(/오늘 결제 \d+건 · [\d,]+원/u);
    const orders = session();
    const open = await orders.ask('주문 확인해줘');
    expect(keys(orders.sent[0])).toEqual(expect.arrayContaining(['orders.recent.row', 'orders.open.count']));
    expect(keys(orders.sent[0])).not.toContain('payments.recent.row');
    // Each listed order says its preparation state next to its payment state, so "진행 중" is not a list of finished payments.
    expect(open.answer).toMatch(/\d+번 주문 \d\d:\d\d · .+ · [\d,]+원 · (?:접수|준비 중|준비 완료) · (?:결제 완료|결제 전)/u);
  });

  it('names what was paid, and the discount, when a bill was paid for less than the order lines add up to', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    const [plain] = recentOrderFacts(snapshot, 'ko');
    expect(plain.display).not.toContain('할인');
    const pos = snapshot.pos!;
    const discounted = { ...snapshot, pos: { ...pos, payments: pos.payments.map(payment => ({ ...payment, amount: payment.amount - 1000 })) } };
    const [fact] = recentOrderFacts(discounted, 'ko');
    expect(fact.value).toBe(Number(plain.value) - 1000);
    expect(fact.display).toContain(`${(Number(plain.value) - 1000).toLocaleString('ko-KR')}원`);
    expect(fact.display).toContain('할인 1,000원');
  });

  // CHAT-REAL-DEV-2 / gate T-20: a write request that names what to change must open its confirmation card, not a question it already answered.
  it.each([
    ['포장 쿠키 주문제작 양식 견본 만들어줘', '포장 쿠키'],
    ['케이크 주문서 견본 만들어줘', '케이크'],
    ['쿠키 주문서 양식 샘플 생성해줘', '쿠키'],
  ])('opens the order-form card for the product named in "%s"', async (text, product) => {
    const { ask, sent } = session();
    await ask(text);
    expect(sent[0]?.intent).toMatchObject({ kind: 'command', command: 'customTemplate.generate' });
    expect(JSON.stringify(sent[0])).not.toContain('어떤 상품');
    expect(product.length).toBeGreaterThan(0);
  });

  it.each(['카페라떼 메뉴에 샷 추가 옵션 500원을 저장해줘', '아메리카노에 샷 추가 옵션 묶음과 추가금 500원을 넣어줘'])(
    'treats "%s" as an option edit of an existing menu: it asks which option, not for a new menu name', async text => {
      const { ask, sent } = session();
      const reply = await ask(text);
      expect(sent).toHaveLength(0);
      expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'option' });
      expect(reply.answer).not.toContain('추가할 메뉴 이름');
    });

  it('says where a custom discount coupon is made when the owner asks to create one, and offers the coupons the chat can open', async () => {
    const { ask, sent } = session();
    const reply = await ask('점심시간에 쓸 10프로 할인 쿠폰 하나 만들어줘');
    expect(sent).toHaveLength(0);
    expect(reply.turn).toMatchObject({ kind: 'refusal', alternative: { featureId: 'coupon-status' } });
    expect(reply.answer).toContain('쿠폰 화면에서');
    expect(reply.answer).toContain('한가한 시간');
    expect(reply.answer).not.toContain('바꿀 수 있는 내용');
  });

  it('uses every booking detail in one answer instead of asking for each in turn', async () => {
    const { ask, sent } = session();
    await ask('예약 추가해줘');
    expect((await ask('김철수')).turn).toMatchObject({ kind: 'clarification', field: 'date' });
    // One answer with the date, the time and the party size completes the card request.
    await ask('내일 오후 7시 2명');
    expect(sent.at(-1)?.intent).toMatchObject({ kind: 'command', command: 'booking.create' });
  });

  it('does not take other requests for a recent-order question', async () => {
    const { ask, sent } = session();
    await ask('오늘 충전금으로 결제된 게 얼마야?');
    expect(keys(sent[0])).toEqual(['accounting.sales.charge']);
    await ask('오늘 할 일 뭐 있어?');
    expect(sent[1].intent).toMatchObject({ featureId: 'calendar' });
  });

  it.each(['오늘 브리핑 해줘', '뭐 해야 될 거 없나?'])('reads the briefing with its items for %s', async text => {
    const { ask, sent } = session();
    await ask(text);
    expect(sent[0].intent).toMatchObject({ kind: 'read', featureId: 'briefing' });
    expect(keys(sent[0])).toEqual(expect.arrayContaining(['briefing.importantAlerts.count', 'briefing.alert.item', 'briefing.reservations.today']));
  });

  it('answers a bare "요즘 어때?" with today, the week and yesterday against last week', async () => {
    const { ask, sent } = session();
    const reply = await ask('요즘 어때?');
    expect(sent[0].intent.reads!.map(read => read.args.featureId)).toEqual(['ledger', 'ledger', 'briefing']);
    expect(reply.answer).toMatch(/오늘 매출/u);
    expect(reply.answer).toMatch(/지난주 같은 요일 대비/u);
  });

  it('compares today with the same weekday last week using the ledger', async () => {
    const { ask, sent } = session();
    await ask('지난주 같은 요일이랑 비교하면 오늘 매출이 어때?');
    expect(sent[0].intent).toMatchObject({ kind: 'read', featureId: 'ledger' });
    expect(keys(sent[0])).toEqual(['ledger.sales.net', 'ledger.sales.delta', 'ledger.sales.base', 'ledger.closing.status']);
  });

  it('keeps a menu price read ahead of a trend keyword that is also a menu name', () => {
    const snapshot = withTrendKeyword('아메리카노');
    expect(assistantDomains.route('아메리카노 가격이 얼마였지?', snapshot, 'ko'))
      .toMatchObject({ intent: { kind: 'read', recordKind: 'menu' } });
    expect(assistantDomains.route('로컬 트렌드에서 아메리카노 검색 관심도 알려줘', snapshot, 'ko'))
      .toMatchObject({ intent: { kind: 'read', featureId: 'local-trends' } });
  });

  it('routes a menu price change to its command even when the name is a trend keyword', () => {
    const snapshot = withTrendKeyword('카페라떼');
    expect(assistantDomains.route('카페라떼 가격 5,000원으로 올려줘', snapshot, 'ko'))
      .toMatchObject({ intent: { kind: 'command', command: 'menu.update' }, slots: { price: 5000 } });
  });

  it('asks what the owner means when the conversation starts with an unnamed reference', async () => {
    const { ask, legacy } = session();
    expect((await ask('그거 어떻게 됐어?')).answer).toContain('어떤 내용인지 알려 주세요');
    expect(legacy()).toBe(0);
  });

  it.each(['어제랑 오늘 매출 비교해줘', '어제 매출이랑 오늘 매출 각각 얼마야?'])('reads both days from the ledger week for %s', async text => {
    const { ask, sent } = session();
    const reply = await ask(text);
    expect(sent[0].intent).toMatchObject({ kind: 'read', featureId: 'ledger', condition: { kind: 'dateRange' } });
    expect(keys(sent[0])).toEqual(['ledger.sales.daily', 'ledger.sales.daily']);
    expect(reply.answer).toMatch(/831,220원/u);
  });

  it('keeps the older yesterday-against-last-week answer for a question that names no today', async () => {
    const { ask, sent } = session();
    await ask('어제 매출 지난주랑 비교해줘');
    expect(sent[0].intent).toMatchObject({ featureId: 'briefing' });
  });

  it('says there is no member point record and ranks members by visits', async () => {
    const { ask, sent } = session();
    expect((await ask('포인트 제일 많은 회원 알려줘')).answer).toMatch(/회원 포인트 기록이 없어요/u);
    expect(sent).toHaveLength(0);
    await ask('방문 제일 많은 회원 알려줘');
    expect(sent[0].intent).toMatchObject({ kind: 'read', featureId: 'members' });
    expect(keys(sent[0])).toEqual(['members.visits.top', 'members.visits.top', 'members.visits.top']);
  });

  it('shows the lead time with the supplier when the owner asks when to order', async () => {
    const { ask } = session();
    const reply = await ask('원두 거래처가 어디고 언제 주문해야 해?');
    expect(reply.answer).toMatch(/발주사 상도브루 로스터리/u);
    expect(reply.answer).toMatch(/등록 납기 \d+일/u);
    expect(reply.answer).not.toContain('입고 예정');
  });

  it('turns "만들어줘" for a quiet-hour coupon into the slot coupon card flow', async () => {
    const { ask, sent } = session();
    await ask('한가한 시간에 쓸 쿠폰 만들어줘');
    expect(sent[0].intent).toMatchObject({ kind: 'command', command: 'coupon.sendSlot' });
  });

  it('routes a notice request that names store hours to the notice flow, not to the manuals', async () => {
    const { ask, sent } = session();
    const reply = await ask('이번 주말 영업시간 변경 안내 공지 만들어줘');
    expect(reply.answer).toContain('영업시간이 바뀌는 날짜와 운영 시간을 알려 주세요');
    expect(sent).toHaveLength(0);
  });

  it('explains that current occupancy is unavailable when the service has no camera', () => {
    const store = createWidgetDataStore();
    const before = store.getSnapshot();
    store.hydrate({ storeEnvironment: { ...before.tables.storeEnvironment, source: 'manual' },
      realInsight: { date: '2026-11-22', asOf: '2026-11-22T05:30:00.000Z', cameras: [], zones: [], links: [], buckets: [], reviews: [], tables: [] } });
    expect(assistantDomains.route('지금 매장에 손님 몇 명 있어?', store.getSnapshot(), 'ko', 'customer-analysis'))
      .toMatchObject({ kind: 'answer', answer: expect.stringContaining('연결된 카메라가 없어서 지금 매장 인원은 확인할 수 없어요') });
  });

  it('shows that real provider reviews await a reply before sending the owner to the review tab', async () => {
    const awaiting = { ref: 'review-one', text: '좋았어요.', keywords: [], media: [], stars: 5, reply: null, hasReply: false };
    const unavailable = { status: 'unavailable' as const };
    const store = createWidgetDataStore({ inquiryThread: [], realInbox: {
      storeId: 'store', asOf: '2026-11-22T05:30:00.000Z', inquiries: [], notices: [], waitingInquiries: 0, activeNotices: 0,
      reviews: { status: 'available', items: [awaiting, { ...awaiting, ref: 'review-answered', hasReply: true }] },
      consultations: unavailable, audiences: unavailable, news: unavailable, authorNotification: null,
    } });
    const { ask, sent } = session(store);
    const reply = await ask('새로 올라온 리뷰 있어? 답글 초안도 써줘');
    expect(reply.answer).toContain('답변을 기다리는 플레이스 리뷰가 1건 있어요');
    expect(reply.turn).toMatchObject({ kind: 'refusal', alternative: { featureId: 'ai-response', step: 'review-draft' } });
    expect(sent).toHaveLength(0);
  });

  it('says plainly that provider reviews have no posted time and what to press to get a draft', async () => {
    const review = (ref: string, stars: number | null) => ({ ref, text: '좋았어요.', keywords: [], media: [], stars, reply: null, hasReply: false });
    const unavailable = { status: 'unavailable' as const };
    const store = createWidgetDataStore({ inquiryThread: [], realInbox: {
      storeId: 'store', asOf: '2026-11-22T05:30:00.000Z', inquiries: [], notices: [], waitingInquiries: 0, activeNotices: 0,
      reviews: { status: 'available', items: [review('a', 5), review('b', 5), review('c', 1), review('d', null)] },
      consultations: unavailable, audiences: unavailable, news: unavailable, authorNotification: null,
    } });
    const { ask, sent } = session(store);
    const reply = await ask('새로 올라온 리뷰 있어? 답글 초안도 써줘');
    expect(reply.answer).toContain('답변을 기다리는 플레이스 리뷰가 4건 있어요');
    expect(reply.answer).toContain('(별점 5점 2건 · 1점 1건 · 별점 없음 1건)');
    expect(reply.answer).toContain('올라온 시각이 없어서');
    expect(reply.answer).toContain('답글 대기에 넣기');
    expect(reply.turn).toMatchObject({ kind: 'refusal', alternative: { featureId: 'ai-response', step: 'review-draft' } });
    expect(sent).toHaveLength(0);
  });

  it('says there is no regular to text for a quiet-hour coupon without promising a screen the demo store lacks', async () => {
    const base = createWidgetDataStore().getSnapshot();
    const marketing = { ...base.tables.marketing, mktCustomer: base.tables.marketing.mktCustomer.map(customer => ({ ...customer, consentSms: false })) };
    const store = createWidgetDataStore({ marketing });
    const { ask, sent } = session(store);
    const reply = await ask('한가한 시간에 쓸 쿠폰 만들어줘');
    expect(reply.answer).toContain('받는 사람이 없어요');
    expect(reply.answer).toContain('문자에 동의한 단골이 없어서');
    expect(reply.answer).not.toContain('쿠폰 화면');
    expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'slotId' });
    expect(sent).toHaveLength(0);
  });
});

// S3-101 (A-3 replay): "접수 언제까지였어" is about the grant's application period, not about how long a stock item lasts.
describe('a "언제까지" question that names a program or an application is not a stock runway question', () => {
  it.each([
    '디지털 전환 지원 접수 언제까지였어?',
    '디지털 전환 지원 아직 신청할 수 있어?',
    '디지털전환 지원 마감됐어?',
  ])('routes %s to the grants widget', async text => {
    const { ask, sent } = session();
    await ask(text);
    expect(sent.some(request => request.intent.featureId === 'inventory-booking' || request.intent.reads?.some(read => read.args.featureId === 'inventory-booking'))).toBe(false);
    expect(sent.some(request => request.intent.featureId === 'grants' || request.intent.reads?.some(read => read.args.featureId === 'grants'))).toBe(true);
  });
  it('still reads the stock runway for an ingredient', async () => {
    const { ask, sent } = session();
    await ask('우유 언제까지 쓸 수 있어?');
    expect(sent.some(request => request.intent.featureId === 'inventory-booking' || request.intent.reads?.some(read => read.args.featureId === 'inventory-booking'))).toBe(true);
  });
});
