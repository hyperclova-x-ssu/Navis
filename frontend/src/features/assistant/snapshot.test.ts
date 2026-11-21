import { expect, it } from 'vitest';
import { getRegistry } from '../../catalog';
import { buildAssistantContext, storeFactSource, type SnapshotEntry } from './snapshot';
import { createWidgetDataStore } from '../../data/widget-data';

const sourceEntries = (snapshot: readonly SnapshotEntry[]) => snapshot.filter(entry => 'sourceId' in entry);

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
