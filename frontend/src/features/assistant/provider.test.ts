import { cafeSnapshot, cafeTodayNet } from './__fixtures__/cafe';
import { replyResponse } from './stream-fixture';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantProvider, parseModelOutput } from './provider';
import { buildAssistantContext } from './snapshot';
import { storeFactSource, type WidgetFactSource } from './snapshot';
import { matchWidget, simpleReply } from './simple';
import { navisTranslator } from './messages';
import { getRegistry } from '../../catalog';
import { createWidgetDataStore, demandFacts, TOMORROW, widgetFacts, type ModelFact } from '../../data/widget-data';
import type { FeatureId, Locale } from '../../contracts';

const signal = () => new AbortController().signal;
const okFetch = (body: unknown) => vi.fn().mockResolvedValue(replyResponse(body));
const bodyOf = (fetcher: ReturnType<typeof vi.fn>) => JSON.parse(fetcher.mock.calls[0][1].body);
const LOCALES: readonly Locale[] = ['ko', 'en', 'zh-Hans', 'zh-Hant'];
const failing = () => vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

/** Stand-in facts for the plan-2 widgets whose data store (T-058) may not exist yet. */
const fake = (key: string, value: number | string, unit: ModelFact['unit']): ModelFact => ({ key, value, unit, labelKey: `data.fact.${key}`, labelText: { raw: key } });
const injected: Partial<Record<FeatureId, readonly ModelFact[]>> = {
  'marketing-today': [fake('Slots empty', 3, 'count'), fake('Regulars', 5, 'person')],
  'slot-coupon': [fake('Empty slots', 3, 'count'), fake('Regulars', 5, 'person')],
  'expiry-coupon': [fake('Max discount', 40, 'percent'), fake('Margin', 65.7, 'percent')],
  'promo-video': [fake('Photos', 6, 'count'), fake('Reviews', 14, 'count')],
  'coupon-status': [fake('Issued', 3, 'count'), fake('Used', 13, 'count')],
  'customer-groups': [fake('Lapsed regulars', 7, 'person')],
  'marketing-performance': [fake('Redeemed', 23, 'percent'), fake('Revenue', 624000, 'KRW')],
};
function withInjected(): WidgetFactSource {
  const real = storeFactSource(createWidgetDataStore());
  return {
    view: (id, condition) => (injected[id] ? { status: 'ready', featureId: id, condition, variant: 'normal', model: { injected: true } } : real.view(id, condition)),
    facts: (view) => (view.status === 'ready' && injected[view.featureId] && (view.model as { injected?: boolean })?.injected ? injected[view.featureId]! : widgetFacts(view)),
  };
}

describe('request assembly (API-10 v4/v4.1)', () => {
  it('sends the active layer registry with localized names, layers and conditions, no hard-coded list', () => {
    const registry = getRegistry('A');
    for (const locale of LOCALES) {
      const { catalog } = buildAssistantContext({ locale });
      expect(catalog.map((c) => c.id)).toEqual(registry.filter(r => r.layer === 'management').map((r) => r.id));
      expect(catalog.length).toBe(17);
      expect(catalog.length).toBeLessThanOrEqual(32);
      expect(catalog.find((c) => c.id === 'ledger')).toMatchObject({ layer: 'management' });
      expect(catalog.some((c) => c.id === 'marketing-today')).toBe(false);
      expect(catalog.every((c) => c.name && c.conditions.length)).toBe(true);
      expect(catalog.some((c) => c.id === ('stock-sync' as FeatureId))).toBe(false);
    }
    expect(buildAssistantContext({ locale: 'en' }).catalog.find((c) => c.id === 'inventory-booking')!.name).toBe(buildAssistantContext({ locale: 'ko' }).catalog.find((c) => c.id === 'inventory-booking')!.name);
  });
  it('gives the same sales as a language-specific display (AC-220)', () => {
    const display = (locale: Locale) => {
      const entry = buildAssistantContext({ locale, text: '오늘 매출' }).snapshot.find((s) => 'featureId' in s && s.featureId === 'ledger' && 'facts' in s && s.condition.kind === 'default');
      const fact = entry && 'facts' in entry ? entry.facts.find((f) => f.key === 'ledger.sales.net')! : undefined;
      return fact ? { display: fact.display, value: fact.value, label: fact.label } : undefined;
    };
    for (const locale of LOCALES) expect(display(locale)).toMatchObject({
      display: navisTranslator(locale).format.money(cafeTodayNet, 'compact'), value: cafeTodayNet,
    });
    expect(display('en')!.label).not.toBe(display('ko')!.label);
  });
  it('marks widgets without facts as unavailable and reads new widgets once their facts exist', () => {
    const { snapshot } = buildAssistantContext({ source: withInjected(), locale: 'en', text: '홍보 한산 할인 영상 쿠폰 단골 성과' });
    for (const id of Object.keys(injected) as FeatureId[]) {
      const entry = snapshot.find((s) => 'featureId' in s && s.featureId === id)!;
      expect('facts' in entry && entry.facts.length).toBeGreaterThan(0);
    }
    const none = buildAssistantContext({ text: '매출', source: { view: (id) => ({ status: 'empty', featureId: id, variant: 'normal', messageKey: 'x' }), facts: () => [] } });
    expect(none.snapshot.every((s) => 'unavailable' in s)).toBe(true);
  });
  it('excludes draft manuals and names the source manual (AC-262)', () => {
    const store = createWidgetDataStore();
    const before = buildAssistantContext({ store, locale: 'ko', text: '마감 매뉴얼' }).snapshot.find((s) => 'featureId' in s && s.featureId === 'manuals')!;
    store.dispatch({ type: 'manuals.createDraftFromMemo', memo: '비밀초안메모XYZ' });
    const after = buildAssistantContext({ store, locale: 'ko', text: '마감 매뉴얼' }).snapshot.find((s) => 'featureId' in s && s.featureId === 'manuals')!;
    expect(JSON.stringify(after)).not.toContain('비밀초안메모XYZ');
    const steps = 'facts' in after ? after.facts.filter((f) => f.key === 'manuals.step') : [];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((f) => f.source && f.text)).toBe(true);
    expect(JSON.stringify(before)).toBe(JSON.stringify(after));
  });
  it('posts {text, locale, layer, snapshot, catalog} under the body limit', async () => {
    const fetcher = okFetch({ answer: 'ok', panels: [] });
    await createAssistantProvider({ fetcher }).ask({ text: '오늘 얼마 벌었어?', signal: signal(), locale: 'en', layer: 'marketing' });
    const body = bodyOf(fetcher);
    expect(Object.keys(body).sort()).toEqual(['catalog', 'layer', 'locale', 'snapshot', 'text']);
    expect(body).toMatchObject({ locale: 'en', layer: 'marketing', text: '오늘 얼마 벌었어?' });
    expect(body.catalog).toHaveLength(13);
    expect(new TextEncoder().encode(fetcher.mock.calls[0][1].body).length).toBeLessThan(256 * 1024);
  });
  it.each(['management', 'marketing'] as const)('posts all %s facts for a narrow sales question', async layer => {
    const fetcher = okFetch({ answer: '답', panels: [] });
    await createAssistantProvider({ fetcher }).ask({ text: '오늘 얼마 벌었어?', signal: signal(), layer });
    const body = bodyOf(fetcher);
    const expectedIds = getRegistry('A').filter(entry => entry.layer === layer).map(entry => entry.id);
    const actualIds = new Set(body.snapshot.map((entry: { featureId?: string }) => entry.featureId));
    expect(expectedIds.every(id => actualIds.has(id))).toBe(true);
    const members = body.snapshot.find((entry: { featureId?: string }) => entry.featureId === (layer === 'management' ? 'members' : 'coupon-status'));
    expect(members.facts.length).toBeGreaterThan(0);
  });
  it('defaults to ko and management when the host passes neither (iteration 3 callers)', async () => {
    const fetcher = okFetch({ answer: '답', panels: [] });
    const reply = await createAssistantProvider({ fetcher }).ask({ text: '매출', signal: signal() });
    expect(bodyOf(fetcher)).toMatchObject({ locale: 'ko', layer: 'management' });
    expect(reply.locale).toBe('ko');
  });
});

describe('candidates', () => {
  it('validates each independently, rejects invalid sizes and keeps the other layer as read-only data (AC-179)', async () => {
    const fetcher = okFetch({ answer: '확인했어요', panels: [
      { featureId: 'unknown', reason: 'x' },
      { featureId: 'ledger', reason: '매출', size: { width: 2, height: 1 } },
      { featureId: 'local-trends', reason: '잘못된 크기', size: { width: 5, height: 1 } },
      { featureId: 'local-trends', reason: '키워드', size: { width: 1, height: 1 } },
      { featureId: 'ledger', reason: '무효', condition: { kind: 'snapshot', asOf: '2026-10-26' } },
      { featureId: 'stock-sync', reason: '없는 위젯' },
    ] });
    // D-324 domain reads handle named store data before legacy transport.
    const reply = await createAssistantProvider({ fetcher }).ask({ text: '내용을 정리해줘', signal: signal(), layer: 'marketing' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(reply.panels.map((p) => [p.featureId, p.placement, p.size])).toEqual([
      ['ledger', 'other-layer', { width: 2, height: 1 }],
      ['local-trends', 'current-layer', { width: 1, height: 1 }],
    ]);
    expect(reply.panels[0].preview.status).toBe('ready');
  });
  it('discards a candidate without data while keeping a valid one', async () => {
    const real = storeFactSource(createWidgetDataStore());
    const source: WidgetFactSource = { view: (id, c) => (id === 'ledger' ? { status: 'empty', featureId: id, variant: 'normal', messageKey: 'x' } : real.view(id, c)), facts: real.facts };
    const reply = await createAssistantProvider({ source, fetcher: okFetch({ answer: '답', panels: [{ featureId: 'ledger', reason: '매출', size: { width: 1, height: 1 } }, { featureId: 'calendar', reason: '일정', size: { width: 1, height: 1 } }] }) }).ask({ text: '일정', signal: signal() });
    expect(reply.panels.map((x) => x.featureId)).toEqual(['calendar']);
  });
  it('accepts plan-2 widgets once they have facts and rejects non-default conditions for them', async () => {
    const fetcher = okFetch({ answer: '답', panels: [{ featureId: 'slot-coupon', reason: 'a', size: { width: 1, height: 1 } }, { featureId: 'promo-video', reason: 'b', condition: { kind: 'dateRange', start: '2026-10-20', end: '2026-10-26' } }] });
    const reply = await createAssistantProvider({ source: withInjected(), fetcher }).ask({ text: 'x', signal: signal(), layer: 'marketing' });
    expect(reply.panels.map((p) => p.featureId)).toEqual(['slot-coupon']);
  });
  it('rejects malformed top-level output', () => {
    expect(() => parseModelOutput({ answer: '', panels: [] })).toThrow();
    expect(() => parseModelOutput({ answer: '답', panels: 'x' })).toThrow();
    expect(() => parseModelOutput({ answer: '답', panels: new Array(23).fill({}) })).toThrow();
  });
});

describe('simple mode in four languages', () => {
  const ask = (text: string, locale: Locale, layer: 'management' | 'marketing' = 'management', source?: WidgetFactSource) => createAssistantProvider({ source, fetcher: failing() }).ask({ text, signal: signal(), locale, layer });
  it.each([['How many customers tomorrow?', 'en'], ['내일 손님 얼마나 와?', 'ko'], ['明天会来多少客人？', 'zh-Hans'], ['明天會來多少客人？', 'zh-Hant']] as const)('answers %s from the same base (AC-221, AC-225)', async (text, locale) => {
    for (const answerLocale of LOCALES) {
      const reply = await ask(text, answerLocale);
      expect(reply.mode).toBe('simple');
      expect(reply.panels).toEqual([]);
      const expected = demandFacts(cafeSnapshot).filter(fact => fact.date === TOMORROW && ['demand.expected.total', 'demand.expected.band'].includes(fact.key));
      expect(expected).toHaveLength(4);
      for (const fact of expected) expect(reply.answer).toContain(navisTranslator(answerLocale).format.count(Number(fact.value), 'person'));
    }
    void locale;
  });
  it('answers in the setting language whatever the question language is (AC-220)', async () => {
    const en = await ask('오늘 얼마 벌었어?', 'en');
    expect(en.answer).toContain(navisTranslator('en').format.money(cafeTodayNet, 'compact'));
    expect(en.answer).toContain(navisTranslator('en').t('data.fact.ledger.sales.net'));
    const hans = await ask('오늘 얼마 벌었어?', 'zh-Hans');
    expect(hans.answer).toContain(navisTranslator('zh-Hans').format.money(cafeTodayNet, 'compact'));
    expect(hans.answer).toContain(navisTranslator('zh-Hans').t('data.fact.ledger.sales.net'));
  });
  it('keeps the card reason, notice and examples in the setting language (AC-222, AC-223)', async () => {
    const hans = await ask('inventory', 'zh-Hans');
    expect(hans.panels[0].featureId).toBe('inventory-booking');
    expect(hans.panels[0].reason).toMatch(/[一-鿿]/u);
    expect(hans.panels[0].reason).toContain('재고');
    const hant = await ask('우주를 알려줘', 'zh-Hant');
    expect(hant.examples).toHaveLength(3);
    expect(hant.examples!.every((e) => !/[가-힣]/u.test(e))).toBe(true);
    expect(hant.answer).toContain('範例');
    const noData = await ask('지난달 매출 알려줘', 'zh-Hant');
    expect(noData.answer).toBe('沒有您要的資料，請換個時間範圍或內容試試');
    expect(noData.panels).toEqual([]);
  });
  it('falls back the same way for busy, failure and timeout', async () => {
    for (const fetcher of [vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({}) }), vi.fn().mockRejectedValue(new Error('offline')), vi.fn().mockReturnValue(new Promise(() => {}))]) {
      const reply = await createAssistantProvider({ fetcher, timeoutMs: 5 }).ask({ text: 'show my sales', signal: signal(), locale: 'en' });
      expect(reply.mode).toBe('simple');
      expect(reply.locale).toBe('en');
      expect(reply.panels[0].featureId).toBe('ledger');
      expect(reply.answer).toMatch(/^From /);
    }
  });
  it('sends "online/offline stock" to Stock management without creating a widget (AC-271)', async () => {
    for (const locale of LOCALES) {
      const text = { ko: '온오프라인 재고 통합 위젯 놓아 줘', en: 'online and offline stock widget please', 'zh-Hans': '放一个线上线下库存小组件', 'zh-Hant': '放一個線上線下庫存小工具' }[locale];
      const reply = await ask(text, locale);
      expect(reply.panels.map((p) => p.featureId)).toEqual(['inventory-booking']);
      expect(reply.answer.length).toBeGreaterThan(20);
    }
    expect(matchWidget('판매 상품 재고')).toBe('inventory-booking');
  });
  it('marks a marketing widget asked in management as other-layer (read-only card)', async () => {
    const reply = await ask('오늘 뭐 홍보하면 좋을까?', 'ko', 'management', withInjected());
    expect(reply.panels[0]).toMatchObject({ featureId: 'marketing-today', placement: 'other-layer' });
    const there = await ask('오늘 뭐 홍보하면 좋을까?', 'ko', 'marketing', withInjected());
    expect(there.panels[0].placement).toBe('current-layer');
  });
  it('does not substitute default data for an unsupported period', async () => {
    const reply = await ask('지난달 매출 알려줘', 'ko');
    expect(reply.answer).toContain('데이터가 없어요');
    expect(reply.panels).toEqual([]);
  });
  it('reports unavailable data without inventing a candidate', async () => {
    const source: WidgetFactSource = { view: (id) => ({ status: 'error', featureId: id, variant: 'normal', messageKey: 'x' }), facts: () => [] };
    const reply = await ask('매출 알려줘', 'ko', 'management', source);
    expect(reply.panels).toEqual([]);
    expect(reply.answer).toContain('데이터가 없어요');
  });
});

describe('example chips', () => {
  it('every suggested question is understood by simple mode in its own language', () => {
    const expected = [['ledger'], [null], ['inventory-booking'], ['ledger'], ['calendar'], ['marketing-today']];
    for (const locale of LOCALES) {
      const t = navisTranslator(locale);
      expect([1, 2, 3, 4, 5, 6].map((n) => matchWidget(t.t(`navis.example.${n}`)))).toEqual(expected.flat());
    }
  });
});

describe('plan-2 widgets in simple mode (AC-321)', () => {
  const cases: readonly [Locale, string, FeatureId, readonly string[]][] = [
    ['ko', '오늘 뭐 홍보하면 좋을까?', 'marketing-today', ['3', '5']],
    ['ko', '다음 주 한산한 시간 채워줘', 'slot-coupon', ['3', '5']],
    ['ko', '크루아상 얼마까지 할인해도 돼?', 'expiry-coupon', ['40%', '65.7%']],
    ['ko', '리뷰로 홍보 영상 만들어줘', 'promo-video', ['6', '14']],
    ['ko', '지금 돌고 있는 쿠폰 뭐 있어?', 'coupon-status', ['3', '13']],
    ['ko', '요즘 안 오는 단골 누구야?', 'customer-groups', ['7']],
    ['ko', '이번 달 홍보 효과 어땠어?', 'marketing-performance', ['23%', '62.4만 원']],
    ['en', 'Which croissant discount is safe?', 'expiry-coupon', ['40%', '65.7%']],
    ['en', 'Which coupons are running now?', 'coupon-status', ['3', '13']],
    ['en', 'Make a promo video from reviews', 'promo-video', ['6', '14']],
    ['en', 'How did my promotion results look?', 'marketing-performance', ['23%', '₩624,000']],
    ['zh-Hans', '周边安静的时段怎么推广？', 'slot-coupon', ['3', '5']],
    ['zh-Hans', '最近没来的常客有谁？', 'customer-groups', ['7']],
    ['zh-Hant', '最近有哪些優惠券在用？', 'coupon-status', ['3', '13']],
    ['zh-Hant', '推廣成效如何？', 'marketing-performance', ['23%', '62.4萬韓元']],
  ];
  it.each(cases)('%s "%s" -> %s', (locale, text, id, values) => {
    // Exercise the AC-321 keyword fallback. Agent turns use café data and the
    // D-323/D-326 video and coupon rules before the legacy fallback.
    const reply = simpleReply({ source: withInjected(), text, locale, layer: 'marketing' });
    expect(reply.panels[0]?.featureId).toBe(id);
    expect(reply.panels[0].placement).toBe('current-layer');
    for (const value of values) expect(reply.answer).toContain(value);
  });
  it('answers "no data" for a plan-2 widget whose facts do not exist yet instead of guessing', async () => {
    const source: WidgetFactSource = { view: (id) => ({ status: 'error', featureId: id, variant: 'normal', messageKey: 'x' }), facts: () => [] };
    const reply = await createAssistantProvider({ source, fetcher: failing() }).ask({ text: '쿠폰 있어?', signal: signal(), layer: 'marketing' });
    expect(reply.panels).toEqual([]);
  });
});

describe('cancellation', () => {
  it('does not fall back on explicit cancellation even if the transport resolves late', async () => {
    let resolve!: (value: unknown) => void;
    const fetcher = vi.fn().mockReturnValue(new Promise((r) => { resolve = r; }));
    const controller = new AbortController();
    const pending = createAssistantProvider({ fetcher }).ask({ text: '매출', signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    controller.abort();
    resolve({ ok: true, json: async () => ({ answer: '늦은 답', panels: [] }) });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('returns promptly when cancelled even if the transport ignores abort', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));
    const pending = createAssistantProvider({ fetcher, timeoutMs: 10000 }).ask({ text: '매출', signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    controller.abort();
    await expect(Promise.race([pending, new Promise((r) => setTimeout(() => r('not cancelled'), 50))])).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createAssistantProvider({ fetcher: failing() }).ask({ text: '매출', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('history and local candidates', () => {
  it('sends earlier conversation with the current request', async () => {
    const fetcher = okFetch({ answer: '답', panels: [] });
    const history = [{ role: 'user' as const, text: '매출?' }, { role: 'assistant' as const, text: '확인했어요.' }];
    await createAssistantProvider({ fetcher }).ask({ text: '어제는?', signal: signal(), history });
    expect(bodyOf(fetcher).history).toEqual(history);
  });
  it('uses local rules if no valid candidates arrive, and respects card-free categories', async () => {
    for (const [text, expected] of [['매출', 'ledger'], ['메뉴 추가해줘', 'menu'], ['시재와 매출', null], ['누락 주문과 매출', null], ['내일 손님 얼마나 와?', null], ['내일 손님 얼마나 와? 그리고 매출 보여줘', 'ledger']] as const) {
      const reply = await createAssistantProvider({ fetcher: okFetch({ answer: '확인했어요.', panels: [] }) }).ask({ text, signal: signal() });
      expect(reply.panels.map(p => p.featureId)).toEqual(expected ? [expected] : []);
    }
    const invalid = await createAssistantProvider({ fetcher: okFetch({ answer: '답', panels: [{ featureId: 'unknown', reason: 'x' }] }) }).ask({ text: '매출', signal: signal() });
    expect(invalid.panels.map(p => p.featureId)).toEqual(['ledger']);
    const source: WidgetFactSource = { view: id => ({ status: 'empty', featureId: id, variant: 'normal', messageKey: 'x' }), facts: () => [] };
    expect((await createAssistantProvider({ source, fetcher: okFetch({ answer: '답', panels: [] }) }).ask({ text: '매출', signal: signal() })).panels).toEqual([]);
  });
  it('offers the menu card when menu facts exist without a latte', async () => {
    const real = storeFactSource(createWidgetDataStore());
    const source: WidgetFactSource = { ...real, facts: view => view.status === 'ready' && view.featureId === 'menu' ? [fake('menu.count', 4, 'count')] : real.facts(view) };
    const reply = await createAssistantProvider({ source, fetcher: okFetch({ answer: '안내해요.', panels: [] }) }).ask({ text: '메뉴 추가', signal: signal() });
    expect(reply.panels.map(p => p.featureId)).toEqual(['menu']);
  });
  it('keeps validated server cards if the stream breaks after they arrive', async () => {
    const { controlledResponse } = await import('./stream-fixture');
    const wire = controlledResponse();
    const pending = createAssistantProvider({ fetcher: async () => wire.response }).ask({ text: '내용을 정리해줘', signal: signal() });
    wire.frame('text_delta', { delta: '답이에요.' });
    wire.frame('panels', { panels: [{ featureId: 'calendar', reason: '일정', size: { width: 1, height: 1 } }] });
    wire.frame('error', { code: 'UNAVAILABLE' });
    const reply = await pending;
    expect(reply.panels.map(p => p.featureId)).toEqual(['calendar']);
    expect(reply.status).toBeUndefined();
  });
  it('finishes normally after unsolicited CANCELLED following text', async () => {
    const { controlledResponse } = await import('./stream-fixture');
    const wire = controlledResponse();
    const pending = createAssistantProvider({ fetcher: async () => wire.response }).ask({ text: '매출', signal: signal() });
    wire.frame('text_delta', { delta: '받은 답이에요.' }); wire.frame('error', { code: 'CANCELLED' });
    const reply = await pending;
    expect(reply.answer).toBe('받은 답이에요.'); expect(reply.status).toBeUndefined();
    expect(reply.panels.map(p => p.featureId)).toEqual(['ledger']);
  });
  it('limits validated candidates to three', async () => {
    const panels = ['ledger', 'calendar', 'menu', 'inventory-booking'].map(featureId => ({ featureId, reason: '확인', size: { width: 1, height: 1 } }));
    const reply = await createAssistantProvider({ fetcher: okFetch({ answer: '답', panels }) }).ask({ text: '정보', signal: signal() });
    expect(reply.panels).toHaveLength(3);
  });
});

describe('store-only scope response', () => {
  it.each([
    ['ko', '저는 이 매장의 운영과 Navis 사용에 관한 질문에만 답할 수 있어요. 매출, 재고, 손님, 메뉴, 예약 같은 가게 이야기를 물어봐 주세요.'],
    ['en', 'I can only answer questions about running this store and using Navis. Try asking about sales, stock, customers, menu, or reservations.'],
    ['zh-Hans', '我只能回答与本店运营和使用 Navis 相关的问题。请问问销售额、库存、顾客、菜单、预约等店里的事。'],
    ['zh-Hant', '我只能回答與本店營運和使用 Navis 相關的問題。請問問銷售額、庫存、顧客、菜單、預約等店裡的事。'],
  ] as const)('returns the %s refusal and examples without simple mode or cards', async (locale, answer) => {
    const { controlledResponse } = await import('./stream-fixture'); const wire = controlledResponse();
    wire.frame('error', { code: 'OUT_OF_SCOPE' });
    const reply = await createAssistantProvider({ fetcher: async () => wire.response }).ask({ text: '파이썬 코드를 써줘', locale, signal: signal() });
    expect(reply).toMatchObject({ answer, locale, outOfScope: true, panels: [] });
    expect(reply.mode).toBeUndefined(); expect(reply.examples).toHaveLength(3);
  });
});
