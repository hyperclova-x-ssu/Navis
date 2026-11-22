import { expect, it } from 'vitest';
import { getRegistry } from '../../catalog';
import { assistantDomains, buildAgentRequest, buildAssistantContext, isMenuCreateRequest, orderedRead, parseMenuCreateInput, plainReadQuery, projectAgentWidget, storeFactSource, type SnapshotEntry } from './snapshot';
import type { DomainTurnInput } from './domains/registry';
import { createWidgetDataStore } from '../../data/widget-data';
import { emptyTotals, type MarginDto, type RealFinanceSnapshot } from '../../data/reality/09/dto';

const sourceEntries = (snapshot: readonly SnapshotEntry[]) => snapshot.filter(entry => 'sourceId' in entry);

it.each(['missing', 'unavailable'] as const)('advertises the business-day stock conditions for a %s projection', status => {
  const snapshot = { ...createWidgetDataStore().getSnapshot(), runId: 'stock-run' };
  const businessDate = '2026-11-22';
  const hydrated = { ...snapshot, tables: { ...snapshot.tables, realStock: [{
    businessDate, items: [], movements: [], movementsComplete: false, batches: [], batchesComplete: false, forecast: null,
  }] } };
  const featureId = 'inventory-booking';
  const condition = { kind: 'snapshot', asOf: businessDate } as const;
  const supported = [
    condition, { kind: 'dateRange', start: businessDate, end: businessDate },
    { kind: 'dateRange', start: '2026-11-16', end: businessDate }, { kind: 'default' },
  ] as const;
  const domains = { ...assistantDomains, projectWidget: () => ({ status }) };
  for (const condition of supported) {
    const entry = { featureId, condition, status };
    const request = buildAgentRequest(hydrated, { kind: 'read', featureId, condition }, 'ko', 'management', [],
      { snapshot: [entry], searches: [] });
    expect(request?.catalog.find(widget => widget.id === featureId)?.conditions).toEqual(supported);
    expect(projectAgentWidget(hydrated, featureId, condition, 'ko', domains)).toMatchObject({ args: { condition }, status });
  }
  expect(projectAgentWidget(hydrated, featureId, { kind: 'snapshot', asOf: '2026-11-17' }, 'ko', domains).status)
    .toBe('unsupported_period');
  expect(plainReadQuery('재고 0인 거', '2026-11-17', businessDate)?.intent).toEqual({ kind: 'read', featureId, condition });
});

it.each([
  ['최근 7일 카페라테 판매 원가 얼마야?', 'margin.menu.salesCost'],
  ['카페라테 오늘 판매 마진율 얼마야?', 'margin.menu.salesRate'],
  ['카페라테 마진율 얼마야?', 'margin.menu.rate'],
] as const)('uses %s with the corresponding menu fact', (text, key) => {
  const read = plainReadQuery(text, '2026-11-17');
  expect(read?.intent).toMatchObject({ kind: 'read', featureId: 'margin' });
  const facts = [key, 'margin.menu.unitCost'].flatMap((factKey, i) => ['카페라떼', '바닐라 라떼'].map(label =>
    ({ key: factKey, label, value: 35 + i, unit: '', display: '35' })));
  expect(read?.narrow?.(facts)).toEqual([facts[0]]);
});

it('keeps both sale metrics on the supported trailing-seven-day condition', () => {
  expect(plainReadQuery('최근 7일 카페라테 판매 원가랑 마진율 얼마야?', '2026-11-17')).toMatchObject({
    intent: { kind: 'read', featureId: 'margin', condition: { kind: 'dateRange', start: '2026-11-11', end: '2026-11-17' } },
    factKeys: ['margin.menu.salesCost', 'margin.menu.salesRate'],
  });
  expect(plainReadQuery('어제 카페라테 판매 원가 얼마야?', '2026-11-17')?.unsupported)
    .toEqual({ featureId: 'margin', condition: { kind: 'dateRange', start: '2026-11-16', end: '2026-11-16' } });
});

it('reads sale-time menu cost and margin from a recognized POS row', () => {
  const snapshot = createWidgetDataStore().getSnapshot();
  const today = '2026-11-17';
  const from = '2026-11-11';
  const totals = emptyTotals();
  const sale: MarginDto = {
    marginId: 'recognition', kind: 'menu', menuId: 'm-cafe-latte', name: '카페라테', recipeVersion: 'sold-recipe',
    settlementId: 'paid-bill', sourceId: 'paid-line', quantity: 2, sales: 9_000, discount: 0, refund: 0,
    unitPrice: 4_500, unitCost: 1_500, cost: 3_000, knownCost: 3_000, unknownCostCount: 0,
    contribution: 6_000, unitMargin: 3_000,
  };
  const asOf = '2026-11-17T06:45:00Z';
  const finance: RealFinanceSnapshot = {
    today, from, to: today, asOf, days: {}, hours: [], deposits: [], depositsComplete: true, closings: [],
    closing: { businessDate: today, status: 'open', revision: 0, totals, pendingBills: [], writable: true,
      closingId: null, closedAt: null, reopenedAt: null, drawer: {
        opening: 0, actual: null, memo: '', expected: 0, difference: null, in: 0, out: 0, cashApproved: 0, cashReturned: 0, movements: [],
      } },
    margins: { today: [], last7: [sale], last30: [sale] }, marginsComplete: true,
  };
  const hydrated = { ...snapshot, tables: { ...snapshot.tables, realFinance: finance } };
  const read = plainReadQuery('최근 7일 카페라테 판매 원가랑 마진율 얼마야?', today);
  if (!read?.intent.condition) throw new Error('Missing margin period');
  const projection = projectAgentWidget(hydrated, 'margin', read.intent.condition, 'ko');
  expect(read.narrow?.(projection.facts)).toMatchObject([
    { key: 'margin.menu.salesCost', value: 3_000, display: '3,000원', start: from, end: today },
    { key: 'margin.menu.salesRate', value: 66.7, display: '66.7%', start: from, end: today },
  ]);
  const current = projectAgentWidget(hydrated, 'margin', { kind: 'default' }, 'ko');
  expect(read.narrow?.(current.facts)).toEqual([]);
});

it.each(['management', 'marketing'] as const)('sends every %s widget and all its normal facts for a narrow question', layer => {
  const source = storeFactSource(createWidgetDataStore());
  const text = layer === 'management' ? '오늘 얼마 벌었어?' : '지금 돌고 있는 쿠폰 뭐 있어?';
  const context = buildAssistantContext({ source, text, layer });
  expect(context.catalog.map(entry => entry.id)).toEqual(getRegistry('A').filter(r => r.layer === layer).map(r => r.id));
  expect([...new Set(context.snapshot.flatMap(entry => 'featureId' in entry ? [entry.featureId] : []))]).toEqual(context.catalog.map(entry => entry.id));
  for (const widget of context.catalog) for (const condition of widget.conditions) {
    const entry = context.snapshot.find(entry => 'featureId' in entry && entry.featureId === widget.id && JSON.stringify(entry.condition) === JSON.stringify(condition));
    const view = source.view(widget.id, condition), facts = view.status === 'ready' ? source.facts(view) : [];
    if (!facts.length) { expect(entry).toMatchObject({ unavailable: true }); continue; }
    expect(entry && 'facts' in entry && entry.facts.map(({ key, value, unit }) => ({ key, value, unit }))).toEqual(facts.map(({ key, value, unit }) => ({ key, value, unit })));
  }
  expect(sourceEntries(context.snapshot)).toEqual([]);
  if (layer === 'management') {
    const facts = context.snapshot.flatMap(entry => 'facts' in entry ? entry.facts : []);
    expect(facts.some(fact => fact.key === 'inventory.stock' && fact.label.includes('원두'))).toBe(true);
    expect(facts.some(fact => fact.key === 'ledger.expenses.total')).toBe(true);
    expect(facts.some(fact => fact.key === 'members.count')).toBe(true);
  }
});
it('retains item/topic selection for other-layer facts while sending the full active layer', () => {
  const context = buildAssistantContext({ text: '오늘 매출과 우유 재고 사용량', layer: 'marketing' });
  const activeIds = new Set(context.catalog.map(entry => entry.id));
  const other = context.snapshot.filter(entry => 'featureId' in entry && !activeIds.has(entry.featureId));
  expect(other.flatMap(entry => 'featureId' in entry ? [entry.featureId] : []).sort()).toEqual(['inventory-booking', 'ledger']);
  const stock = other.find(entry => 'featureId' in entry && entry.featureId === 'inventory-booking');
  expect(stock && 'facts' in stock && stock.facts.every(fact => fact.label.includes('우유'))).toBe(true);
  expect(JSON.stringify(other)).not.toContain('원두');
  const ledger = other.find(entry => 'featureId' in entry && entry.featureId === 'ledger');
  expect(ledger && 'facts' in ledger && ledger.facts.map(fact => fact.key)).toEqual(['ledger.sales.net', 'ledger.sales.delta']);
});
it('keeps demand/POS source-only and does not add unrelated other-layer CCTV', () => {
  const missing = buildAssistantContext({ text: '누락 주문 있어?', layer: 'marketing' });
  expect(sourceEntries(missing.snapshot)).toEqual([expect.objectContaining({ sourceId: 'pos', candidateAllowed: false })]);
  expect(missing.snapshot.some(entry => 'featureId' in entry && entry.featureId === 'customer-analysis')).toBe(false);
  const demand = buildAssistantContext({ text: '내일 손님 얼마나 와?', layer: 'marketing' });
  expect(sourceEntries(demand.snapshot)).toEqual([expect.objectContaining({ sourceId: 'demand', candidateAllowed: false })]);
  for (const text of ['우주 여행', '알바모집 패널']) {
    const context = buildAssistantContext({ text });
    expect([...new Set(context.snapshot.flatMap(entry => 'featureId' in entry ? [entry.featureId] : []))]).toEqual(context.catalog.map(entry => entry.id));
    expect(sourceEntries(context.snapshot)).toEqual([]);
  }
});
it('preserves supported other-layer periods and all current-layer unavailable markers', () => {
  const week = buildAssistantContext({ text: '최근 일주일 매출', layer: 'marketing' }).snapshot.filter(entry => 'featureId' in entry && entry.featureId === 'ledger');
  expect(week).toHaveLength(1); expect(week[0].condition.kind).toBe('dateRange');
  const past = buildAssistantContext({ text: '지난달 매출', layer: 'marketing' }).snapshot.filter(entry => 'featureId' in entry && entry.featureId === 'ledger');
  expect(past).toEqual([expect.objectContaining({ featureId: 'ledger', unavailable: true })]);
  const empty = buildAssistantContext({ text: '매출', source: { view: id => ({ status: 'empty', variant: 'normal', featureId: id, messageKey: 'empty' }), facts: () => [] } });
  expect(empty.snapshot.every(entry => 'unavailable' in entry)).toBe(true);
  expect([...new Set(empty.snapshot.flatMap(entry => 'featureId' in entry ? [entry.featureId] : []))]).toEqual(empty.catalog.map(entry => entry.id));
});
it('retains published-manual and aggregate item selection in the other layer without recipes or member rows', () => {
  const store = createWidgetDataStore(); store.dispatch({ type: 'manuals.createDraftFromMemo', memo: 'PRIVATE_DRAFT' });
  const manuals = buildAssistantContext({ store, text: '마감 매뉴얼', layer: 'marketing' });
  const facts = manuals.snapshot.flatMap(entry => 'featureId' in entry && entry.featureId === 'manuals' && 'facts' in entry ? entry.facts : []);
  expect(facts.length).toBeGreaterThan(0); expect(facts.every(fact => fact.source && fact.text && fact.source.includes('마감'))).toBe(true);
  expect(JSON.stringify(manuals)).not.toContain('PRIVATE_DRAFT');
  const source = storeFactSource(store);
  const members = buildAssistantContext({ source, text: '단골 몇 명', layer: 'marketing' }).snapshot.flatMap(entry => 'featureId' in entry && entry.featureId === 'members' && 'facts' in entry ? entry.facts : []);
  expect(members.map(fact => fact.key)).toEqual(['members.regular.count']);
  const menu = buildAssistantContext({ source, text: '카페라테 원가', layer: 'marketing' }).snapshot.flatMap(entry => 'featureId' in entry && entry.featureId === 'menu' && 'facts' in entry ? entry.facts : []);
  expect(menu.map(fact => fact.key)).toEqual(['menu.cost', 'menu.marginRate']);
  expect(menu.every(fact => fact.label.includes('카페라떼'))).toBe(true);
});
it('retains unavailable other-layer and source-only periods and supports the exact requested date', () => {
  const future = buildAssistantContext({ text: '내일 매출', layer: 'marketing' }).snapshot.filter(entry => 'featureId' in entry && entry.featureId === 'ledger');
  expect(future).toEqual([expect.objectContaining({ featureId: 'ledger', unavailable: true })]);
  expect(sourceEntries(buildAssistantContext({ text: '지난달 누락 주문' }).snapshot)).toEqual([expect.objectContaining({ sourceId: 'pos', facts: [] })]);
  const source = storeFactSource(createWidgetDataStore());
  const current = source.view('ledger', { kind: 'default' });
  const today = source.facts(current).find(fact => fact.key === 'ledger.sales.net')!.date!;
  const dated = buildAssistantContext({ source, text: `${today} 매출`, layer: 'marketing' }).snapshot.filter(entry => 'featureId' in entry && entry.featureId === 'ledger');
  expect(dated).toHaveLength(1); expect(dated[0]).toMatchObject({ featureId: 'ledger', condition: { kind: 'default' }, facts: [expect.objectContaining({ key: 'ledger.sales.net' }), expect.anything()] });
});
it('keeps independent other-layer periods and both source topics in compound questions', () => {
  const context = buildAssistantContext({ text: '오늘 매출과 내일 손님, 누락 주문', layer: 'marketing' });
  const sales = context.snapshot.find(entry => 'featureId' in entry && entry.featureId === 'ledger');
  expect(sales && 'facts' in sales && sales.facts.some(fact => fact.key === 'ledger.sales.net')).toBe(true);
  expect(sourceEntries(context.snapshot).map(entry => 'sourceId' in entry && entry.sourceId)).toEqual(['demand', 'pos']);
  expect(context.snapshot.some(entry => 'featureId' in entry && entry.featureId === 'customer-analysis')).toBe(false);
});

it('treats opening the register window as navigation, not as a create request (B28)', () => {
  expect(isMenuCreateRequest('메뉴 새로 등록하는 창 열어')).toBe(false);
  expect(isMenuCreateRequest('메뉴 새로 하나 등록해줘')).toBe(true);
});

it('compiles plain questions to one typed read and leaves writes, layout and navigation alone (A3-B21)', () => {
  const day = '2026-11-17';
  expect(plainReadQuery('우유 언제 들어와?', day)?.intent).toEqual({ kind: 'read', featureId: 'suppliers', condition: { kind: 'default' } });
  expect(plainReadQuery('9월 세금 예상액 얼마야', day)?.unsupported).toMatchObject({ featureId: 'tax' });
  for (const text of ['카페라테 원가랑 마진 얼마야?', '카페라테 원가 마진 알려줘', '아메리카노 오천원 받으면 마진율 얼마야', '마진 보여줘', '재고 위젯 추가해줘', '우유 발주 넣어줘', '세금 화면 열어줘', '마진 낮은 메뉴 삭제해줘', '']) {
    expect(plainReadQuery(text, day)).toBeUndefined();
  }
});

it.each(['이번 주 매출 알려줘', '이번주 매출 얼마야?', '이번 주 얼마 벌었어?', '이번 주 장사 어때?'])('reads %s as today and then the rolling seven days of the ledger (S8-016)', text => {
  const day = '2026-11-17';
  const read = plainReadQuery(text, day);
  expect(read?.intent).toEqual({ kind: 'read', reads: [
    { name: 'get_widget', args: { featureId: 'ledger', condition: { kind: 'default' } } },
    { name: 'get_widget', args: { featureId: 'ledger', condition: { kind: 'dateRange', start: '2026-11-11', end: day } } },
  ] });
  expect(read?.parts).toHaveLength(2);
  expect(read?.parts?.map(part => part.factKeys)).toEqual([['ledger.sales.net'], ['ledger.sales.net']]);
});

it('leaves the other week and period questions on their own paths (S8-016)', () => {
  const day = '2026-11-17';
  for (const text of ['지난주 매출 알려줘', '다음 주 매출 알려줘', '이번 주 재고 알려줘', '오늘 매출 알려줘', '이번 주 매출 위젯 추가해줘']) {
    const read = plainReadQuery(text, day);
    expect(read?.intent && 'reads' in read.intent ? read.intent.reads : undefined, text).toBeUndefined();
  }
});

it.each([
  '메뉴에 마들렌 삼천오백 원에 추가해줘', '메뉴에 마들렌 삼천오백원 넣어줘', '메뉴에 마들렌 3천5백원 등록해줘', '메뉴에 마들렌 삼천 오백 원에 추가해줘',
])('keeps the spoken price out of the menu name for %s (S8-100)', text => {
  expect(parseMenuCreateInput(text)).toMatchObject({ name: '마들렌', price: 3500 });
  expect(parseMenuCreateInput(text)).not.toHaveProperty('invalidPrice');
});

it('keeps only the lowest margin rows and only the out-of-stock rows (A3-B21)', () => {
  const fact = (key: string, label: string, display: string, value: number | string = display) => ({ key, label, display, value, unit: '' });
  const narrow = plainReadQuery('마진 꼴찌 메뉴 알려줘', '2026-11-17')!.narrow!;
  const rows = [fact('margin.menu.row', 'A', '1원 · 51.6% · 3건'), fact('margin.menu.row', 'B', '1원 · 50.0% · 1건'), fact('margin.menu.row', 'C', '1원 · 50.0% · 2건'), fact('margin.coverage', '마진', '70.6%')];
  expect(narrow(rows).map(row => row.label)).toEqual(['B', 'C']);
  const stock = plainReadQuery('재고 0인 거', '2026-11-17')!.narrow!;
  const stocks = [fact('inventory.outOfStock.count', '품절', '1개', 1), fact('inventory.stock.milk', '우유 · 현재 재고', '0 L', 0), fact('inventory.stock.beans', '원두 · 현재 재고', '2 kg', 2)];
  expect(stock(stocks).map(row => row.label)).toEqual(['품절', '우유 · 현재 재고']);
});

it('compiles a routed member fact or order suggestion into its ordered pair of reads and leaves other reads alone (B27)', () => {
  const day = '2026-11-17';
  const widget = (featureId: string, condition: object = { kind: 'default' }) => ({ name: 'get_widget', args: { featureId, condition } });
  const suggestion = orderedRead({ intent: { kind: 'read', featureId: 'suppliers', condition: { kind: 'default' } }, factKeys: ['suppliers.suggestions.item', 'suppliers.suggestions.status'] }, day);
  expect(suggestion.intent).toEqual({ kind: 'read', reads: [widget('inventory-booking', { kind: 'snapshot', asOf: day }), widget('suppliers')] });
  expect(suggestion.readParts).toEqual([{ factKeys: ['inventory.restock.count'] }, { factKeys: ['suppliers.suggestions.item', 'suppliers.suggestions.status'] }]);

  const visit = orderedRead({ intent: { kind: 'read', recordKind: 'member', querySlot: 'lastVisit' }, slots: { lastVisit: '이준호' } }, day);
  expect(visit.intent).toEqual({ kind: 'read', reads: [{ name: 'search_records', args: { kind: 'member', querySlot: 'lastVisit' } }, widget('members')] });
  expect(visit.readParts).toEqual([{}, { context: true }]);
  expect(visit.slots).toEqual({ lastVisit: '이준호' });
  for (const slot of ['charge', 'receivable', 'balance', 'chargeHistory']) {
    expect(orderedRead({ intent: { kind: 'read', recordKind: 'member', querySlot: slot }, slots: { [slot]: '이준호' } }, day).intent)
      .toEqual({ kind: 'read', reads: [{ name: 'search_records', args: { kind: 'member', querySlot: slot } }, widget('credit-receivable')] });
  }

  const unchanged: readonly DomainTurnInput[] = [
    { intent: { kind: 'read', featureId: 'suppliers', condition: { kind: 'default' } }, factKeys: ['suppliers.delivery'] },
    { intent: { kind: 'read', featureId: 'ledger', condition: { kind: 'default' } } },
    { intent: { kind: 'read', recordKind: 'member', querySlot: 'consent' }, slots: { consent: '이준호' } },
    { intent: { kind: 'read', recordKind: 'menu', querySlot: 'name' }, slots: { name: '카페라떼' } },
    { intent: { kind: 'read', reads: [widget('ledger'), widget('margin')] } as never },
    { intent: { kind: 'command', command: 'menu.setSaleStatus', args: {} } },
  ];
  for (const turn of unchanged) expect(orderedRead(turn, day)).toBe(turn);
});
