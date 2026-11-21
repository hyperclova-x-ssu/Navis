import { cafeSnapshot } from './__fixtures__/cafe';
import { navisTranslator } from './messages';
import { replyResponse } from './stream-fixture';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantProvider } from './provider';
import { buildAssistantContext } from './snapshot';
import { createWidgetDataStore, readDemand, selectMembers, selectMenus, selectTaxPayments, selectWidget, TODAY } from '../../data/widget-data';
import { getPaymentBillId, quotePaymentBill } from '../../pos/loyalty';
import { setup as setupPos } from '../../pos/loyalty/test-setup';

const signal = () => new AbortController().signal;
const offline = vi.fn().mockRejectedValue(new Error('offline'));
const format = navisTranslator('ko').format;
const forecast = readDemand(cafeSnapshot).day;
const ask = (text: string, store = createWidgetDataStore()) => createAssistantProvider({ store, fetcher: offline }).ask({ text, signal: signal() });

describe('API-200', () => {
  it('sends the management catalog and a separate non-candidate demand source', () => {
    const { catalog, snapshot } = buildAssistantContext({ text: '내일 손님' });
    expect(catalog).toHaveLength(17);
    const demand = snapshot.find((entry) => 'sourceId' in entry && entry.sourceId === 'demand');
    expect(demand).toMatchObject({ sourceId: 'demand', condition: { kind: 'default' }, candidateAllowed: false });
    if (!demand || !('facts' in demand)) throw new Error('missing demand');
    expect(demand.facts.find((f) => f.key === 'demand.expected.total')?.value).toBe(forecast.expected);
    expect(demand.facts.filter((f) => f.key === 'demand.expected.band').map((f) => f.value)).toEqual(forecast.bands.map(band => band.expected));
    expect(catalog.some((entry) => entry.id === ('demand' as never))).toBe(false);
    const facts = snapshot.flatMap((entry) => 'facts' in entry ? entry.facts : []);
    expect(facts.filter((fact) => fact.label === fact.key).map((fact) => fact.key)).toEqual([]);
  });
  it('keeps preview variants and private customer data out of the request', async () => {
    const customer = { ...cafeSnapshot.tables.marketing.mktCustomer[0], name: '테스트 전용 고객', phone: '01000001234' };
    const marketing = { ...cafeSnapshot.tables.marketing, mktCustomer: [customer, ...cafeSnapshot.tables.marketing.mktCustomer.slice(1)] };
    const store = createWidgetDataStore({ marketing });
    const baseline = buildAssistantContext({ store, text: '매출' });
    expect(selectWidget(store.getSnapshot(), 'ledger', { kind: 'default' }, 'no-sales').status).toBe('empty');
    expect(buildAssistantContext({ store, text: '매출' })).toEqual(baseline);
    const fetcher = vi.fn().mockResolvedValue(replyResponse({ answer: '답', panels: [] }));
    await createAssistantProvider({ store, fetcher }).ask({ text: '매출', signal: signal() });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.snapshot).toEqual(baseline.snapshot);
    expect(JSON.stringify(body)).not.toContain('preview');
    expect(store.getSnapshot().tables.marketing.mktCustomer[0]).toMatchObject({ name: customer.name, phone: customer.phone });
    expect(JSON.stringify(body)).not.toContain(customer.phone!);
    expect(JSON.stringify(body)).not.toContain(customer.name!);
  });
  it('rejects removed ids, invalid sizes, malformed conditions and candidates without facts', async () => {
    const fetcher = vi.fn().mockResolvedValue(replyResponse({ answer: '답', panels: [
      { featureId: 'demand', reason: '수요', size: { width: 1, height: 1 } },
      { featureId: 'floor-plan', reason: '자리', size: { width: 1, height: 1 } },
      { featureId: 'ledger', reason: '크기', size: { width: 5, height: 1 } },
      { featureId: 'ledger', reason: '조건', condition: { kind: 'default', extra: true }, size: { width: 1, height: 1 } },
      { featureId: 'ledger', reason: '정상', size: { width: 2, height: 1 } },
    ] }) );
    const reply = await createAssistantProvider({ fetcher }).ask({ text: '매출', signal: signal() });
    expect(reply.panels.map((p) => p.reason)).toEqual(['정상']);
  });
  it('answers removed panels and demand without candidates and keeps old names separate', async () => {
    for (const text of ['알바모집 패널 놓아 줘', '자리 배치 보여 줘', '매장 인테리어']) {
      const reply = await ask(text);
      expect(reply.answer).toContain('지금은 그 패널이 없어요');
      expect(reply.panels).toEqual([]);
    }
    const demand = await ask('내일 손님 얼마나 와?');
    expect(demand.answer).toContain(format.count(forecast.expected, 'person'));
    expect(demand.panels).toEqual([]);
    expect((await ask('가계부 보여줘')).panels[0]?.featureId).toBe('ledger');
    expect((await ask('회원권 보여줘')).panels[0]?.featureId).toBe('members');
    const booking = await ask('예약 메뉴 열어 줘');
    expect(booking.answer).toContain('관리 > 일정');
    expect(booking.panels[0]?.featureId).toBe('voice-booking');
  });
  it('answers menu cost, member count and tax payment from normal facts', async () => {
    const latte = selectMenus(cafeSnapshot, {}).rows.find(row => row.menuId === 'm-cafe-latte')!;
    expect(latte.cost).not.toBeNull();
    expect(latte.rate).not.toBeNull();
    const menu = await ask('카페라테 원가 얼마야?');
    expect(menu.panels[0]?.featureId).toBe('menu');
    expect(menu.answer).toContain(format.money(latte.cost!, 'compact'));
    expect(menu.answer).toContain(format.percent(latte.rate!));
    for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      const reply = await createAssistantProvider({ fetcher: offline }).ask({ text: '카페라테 원가 얼마야?', locale, signal: signal() });
      expect(reply.panels[0]?.featureId).toBe('menu');
      expect(reply.answer).toContain(navisTranslator(locale).format.percent(latte.rate!));
    }
    const members = await ask('단골 몇 명이야?');
    expect(members.panels[0]?.featureId).toBe('members');
    const memberModel = selectMembers(cafeSnapshot, {});
    const regulars = memberModel.gradeCounts.regular;
    expect(members.answer).toContain(format.count(regulars, 'person'));
    expect((await ask('단골 보여줘')).panels[0]?.featureId).toBe('customer-groups');
    expect(members.answer).not.toContain(format.count(memberModel.total, 'person'));
    const store = createWidgetDataStore();
    const regularId = memberModel.rows.find(row => row.grade === 'regular')!.memberId;
    expect(store.dispatch({ type: 'members.setGrade', memberId: regularId, grade: 'inactive' }).ok).toBe(true);
    expect((await ask('단골 몇 명이야?', store)).answer).toContain(format.count(regulars - 1, 'person'));
    const tax = await ask('세금 낼 거 있어?');
    const unpaid = selectTaxPayments(cafeSnapshot, { date: TODAY }).filter(payment => payment.status === 'unpaid');
    expect(unpaid.length).toBeGreaterThan(0);
    for (const payment of unpaid) {
      expect(tax.answer).toContain(format.money(payment.amount, 'compact'));
      expect(tax.answer).toContain(format.date(payment.dueOn, 'monthDay'));
    }
  });
  it('reads milk usage from current normal data', async () => {
    const { data: store, pos, meta, finish } = setupPos();
    const usage = () => {
      const view = selectWidget(store.getSnapshot(), 'inventory-booking', { kind: 'default' }, 'normal');
      if (view.status !== 'ready') throw new Error('Missing inventory');
      return view.model.ingredients.find(row => row.itemId === 'i-milk')!.usedToday;
    };
    const before = usage();
    const reply = await ask('오늘 우유 얼마나 썼어?', store);
    expect(reply.answer).toContain(format.quantity(before, 'mL'));
    expect(reply.panels[0]?.featureId).toBe('inventory-booking');
    const menuId = 'm-cafe-latte';
    const lines = store.getSnapshot().tables.recipeLine.filter(row => row.menuId === menuId)
      .map(row => row.itemId === 'i-milk' ? { ...row, quantity: row.quantity - 10 } : row);
    expect(store.dispatch({ type: 'menu.setRecipe', menuId, lines }).ok).toBe(true);
    expect(usage()).toBe(before);
    const menu = pos.read().data.catalog.items.find(item => item.menuId === menuId)!;
    const optionIds = menu.groups.filter(group => group.required).map(group => group.options.find(option => option.extraPrice === 0)!.optionId);
    expect(pos.execute({ type: 'cart.add', menuId, optionIds, meta: meta() }).ok).toBe(true);
    const read = pos.read();
    const quote = quotePaymentBill(read, getPaymentBillId(read));
    expect(pos.beginApproval({ cartId: read.pos.cart.cartId, quoteRevision: quote.revision,
      splits: [{ method: 'card', amount: menu.price }], meta: meta() })).toMatchObject({ ok: true, status: 'pending' });
    expect(finish()).toMatchObject({ ok: true, value: { settled: true } });
    expect(usage()).toBe(before + lines.find(row => row.itemId === 'i-milk')!.quantity);
    const after = await ask('오늘 우유 얼마나 썼어?', store);
    expect(after.answer).toContain(format.quantity(usage(), 'mL'));
    expect(after.answer).not.toContain(format.quantity(before, 'mL'));
  });
});
