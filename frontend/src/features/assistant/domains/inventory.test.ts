import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { woff2Cmap } from '../../../assets/fonts/dev/woff2-cmap';
import { createWidgetDataStore, deriveSuggestions, readModel, selectStockHistory } from '../../../data/widget-data';
import { createSeedTables } from '../../../data/db/seed';
import type { InventoryItem } from '../../../data/db/types';
import { TODAY, addDays } from '../../../data/db/time';
import { createAgentActions } from '../agent-actions';
import { createAssistantProvider } from '../provider';
import { proposalPreview } from '../navis-conversation';
import { validateAgentFrame, validateAgentRequest, type AgentRequest } from '../../../../shared/navis-agent-schema.mjs';
import { createDomainRegistry } from './registry';
import { inventoryCopy, inventoryDomain, inventoryDetailEntry, inventoryNavigation, projectInventoryFacts, readInventoryTurn } from './inventory';

const featureId = 'inventory-booking' as const;
const today = { kind: 'snapshot', asOf: TODAY } as const;

describe('N05 inventory client', () => {
  it('projects milk in the current display unit from the café source and gives no fabricated historical snapshot', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    const facts = projectInventoryFacts(snapshot, featureId, today, 'ko');
    expect(facts).toMatchObject({ facts: expect.arrayContaining([
      expect.objectContaining({ key: 'inventory.item.sku.i-milk', label: expect.stringContaining('목장 1등급 우유'), value: 'RM-004' }),
      expect.objectContaining({ key: 'inventory.stock.i-milk', label: expect.stringContaining('목장 1등급 우유'), value: 20400, unit: 'mL' }),
    ]) });
    expect(projectInventoryFacts(snapshot, featureId, { kind: 'snapshot', asOf: addDays(TODAY, -8) }, 'ko'))
      .toEqual({ status: 'unsupported_period' });
  });

  it('treats a catalog with no retail rows as missing per-product evidence', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    const facts = projectInventoryFacts(snapshot, featureId, today, 'en');
    expect(facts).toHaveProperty('facts');
    if (!facts || !('facts' in facts)) throw new Error('Expected facts');
    expect(facts.facts.some(fact => fact.key.startsWith('product.'))).toBe(false);
  });

  it('opens a live history row and admits only validated, compatible new-item fields', () => {
    const model = readModel(createWidgetDataStore().getSnapshot(), featureId);
    expect(inventoryDetailEntry({ featureId, view: 'history', itemId: 'i-milk' }, model)).toMatchObject({ tab: 'ingredients', itemId: 'i-milk' });
    expect(inventoryDetailEntry({ featureId, view: 'history', itemId: 'missing' }, model).itemId).toBeUndefined();
    expect(inventoryDetailEntry({ featureId, view: 'register', prefill: {
      kind: 'widget-draft', command: 'inventory.createItem', fields: { sku: 'OAT-01', name: '귀리우유', unit: 'L', stock: 4, threshold: 2, trackRestock: false },
    } }, model)).toMatchObject({ register: true, prefill: { stock: 4, trackRestock: false } });
    expect(inventoryDetailEntry({ featureId, view: 'products', prefill: {
      kind: 'widget-draft', command: 'inventory.createItem', fields: { name: '귀리우유' },
    } }, model)).toMatchObject({ tab: 'products', register: false });
  });

  it('S1-153 resolves a private unit-aware draft, confirms one history adjustment, and undoes it', () => {
    const store = createWidgetDataStore(undefined, { runId: 'n05-inventory-test' });
    const snapshot = store.getSnapshot();
    const route = readInventoryTurn('우유 재고 5리터로 바꿔줘', snapshot, 'ko');
    if (!route || !('intent' in route) || route.intent.kind !== 'command' || route.intent.command !== 'inventory.updateItem') throw new Error('Expected update');
    const registry = createDomainRegistry([inventoryDomain]);
    const reader = registry.reader('stock')!;
    const search = { snapshot, query: '우유', locale: 'ko', privateLookup: true } as const;
    const match = reader.search(search)[0];
    const targets = new Map([[match.handle, { kind: 'stock' as const, id: reader.resolve!(search, match.handle)! }]]);
    const prepared = createAgentActions(store, registry).prepare({
      proposalId: 'inventory-test', snapshotRevision: snapshot.revision,
      runId: 'n05-inventory-test', layer: 'management', tier: 'normal', command: route.intent.command, args: route.intent.args!,
    }, route.slots ?? {}, snapshot, () => true, targets);
    if (prepared.kind !== 'proposal') throw new Error(JSON.stringify(prepared));
    expect(store.getSnapshot()).toBe(snapshot);
    const receipt = prepared.proposal.confirm(store);
    expect(receipt.frame.outcome).toBe('applied');
    expect(readModel(store.getSnapshot(), featureId).ingredients.find(row => row.itemId === 'i-milk')?.stock).toBe(5000);
    expect(selectStockHistory(store.getSnapshot(), { itemId: 'i-milk', period: 'today' }).dayGroups[0].rows.at(-1))
      .toMatchObject({ kind: 'adjust', delta: -15400, balanceDisplay: 5000 });
    expect(prepared.proposal.confirm(store).frame).toEqual(receipt.frame);
    expect(store.undo(receipt.undoToken!).ok).toBe(true);
    expect(readModel(store.getSnapshot(), featureId).ingredients.find(row => row.itemId === 'i-milk')?.stock).toBe(20400);
  });
});

it('updates tracking without writing quantity history and preserves the undo token', () => {
  const store = createWidgetDataStore();
  const before = store.getSnapshot();
  const result = store.dispatch({ type: 'inventory.setTracking', itemId: 'i-milk', trackRestock: false });
  expect(result.ok).toBe(true);
  if (!result.ok || !result.undoToken) throw new Error('Expected an undoable tracking change');
  const after = store.getSnapshot();
  expect(after.tables.stockAdjustment).toEqual(before.tables.stockAdjustment);
  expect(readModel(after, featureId).ingredients.find(row => row.itemId === 'i-milk')).toMatchObject({ trackRestock: false, stock: 20400 });
  expect(store.dispatch({ type: 'inventory.setTracking', itemId: 'i-milk' }).ok).toBe(false);
  expect(store.getSnapshot()).toBe(after);
  expect(store.undo(result.undoToken).ok).toBe(true);
  expect(store.getSnapshot().tables.inventoryItem.find(item => item.itemId === 'i-milk')?.trackRestock).toBe(true);
});

const seed = createSeedTables();
const retail: readonly InventoryItem[] = [
  { itemId: 'it-beans200', sku: 'PD-001', nameKey: 'data.item.beans200', kind: 'retail', unit: 'pcs', restockThreshold: null,
    trackRestock: false, lowStockPerChannel: 30, sales7d: null, updatedAt: TODAY, trackExpiry: false, expiresOn: null },
  { itemId: 'it-dripbag', sku: 'PD-002', nameKey: 'data.item.dripBagSet', kind: 'retail', unit: 'pcs', restockThreshold: null,
    trackRestock: false, lowStockPerChannel: 30, sales7d: null, updatedAt: TODAY, trackExpiry: false, expiresOn: null },
];
const stockedRetail = [
  { itemId: 'it-beans200', channel: 'store', qty: 120 },
  { itemId: 'it-beans200', channel: 'online', qty: 40 },
  { itemId: 'it-dripbag', channel: 'store', qty: 60 },
  { itemId: 'it-dripbag', channel: 'online', qty: 28 },
] as const;
const cafeWithRetail = (rows: readonly { readonly itemId: string; readonly channel: 'store' | 'online'; readonly qty: number }[] = stockedRetail) => createWidgetDataStore({
  inventoryItem: [...seed.inventoryItem, ...retail], inventoryStock: [...seed.inventoryStock, ...rows],
});

const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
function makeProvider(store: ReturnType<typeof createWidgetDataStore>) {
  const requests: AgentRequest[] = [];
  const fake = createAssistantProvider({ store, fetcher: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as AgentRequest;
    expect(validateAgentRequest(request)).toBe(true);
    requests.push(request);
    let stream = event('status', { step: 'accepted' }) + event('panels', { panels: [] });
    if (request.intent.kind === 'command') {
      const frame = { command: request.intent.command, args: request.intent.args, proposalId: 'n05-fake-proposal',
        runId: request.runId, layer: request.layer, snapshotRevision: request.snapshotRevision,
        tier: request.intent.command === 'inventory.deleteItem' ? 'extra-confirm' : 'normal' };
      expect(validateAgentFrame('action_proposal', frame)).toBe(true);
      stream += event('action_proposal', frame) + event('done', { outcome: 'proposal' });
    } else {
      expect(request.intent.kind).toBe('read');
      stream += event('done', { outcome: 'reply' });
    }
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'x-navis-protocol': 'agent-v1' } });
  } });
  return { requests, ask: (text: string, continuation?: Parameters<typeof fake.ask>[0]['continuation']) =>
    fake.ask({ text, locale: 'ko', signal: new AbortController().signal, continuation }) };
}

it('S1-138 reads only the named retail product and requested channel', async () => {
  for (const [text, quantities] of [
    ['원두 200g 매장이랑 온라인 재고 각각 알려줘', ['120개', '40개']],
    ['원두 200그램 온라인에 몇 개 있어?', ['40개']],
    ['원두200g 재고', ['120개', '40개']],
  ] as const) {
    const store = cafeWithRetail();
    const before = store.getSnapshot();
    const reply = await makeProvider(store).ask(text);
    expect(reply.turn?.kind).toBe('read');
    const values = reply.answer.match(/\d+개/gu);
    expect(values).toEqual(quantities);
    expect(store.getSnapshot()).toBe(before);

    const empty = await makeProvider(createWidgetDataStore()).ask(text);
    expect(empty.turn?.kind).toBe('read');
    expect(empty.answer).toContain('없어요');
    expect(empty.answer).not.toMatch(/\d+\s*(?:g|개)/u);
  }
});

it.each([40, null])('scopes the real channel read when online stock is %s', online => {
  const itemId = '35a259a3-ca1f-455f-aa41-b97d8d152345';
  const businessDate = addDays(TODAY, 4);
  const store = createWidgetDataStore({
    inventoryItem: [{ ...retail[0], itemId }],
    inventoryStock: [{ itemId, channel: 'store', qty: 120 }, { itemId, channel: 'online', qty: online }],
    realStock: [{ businessDate, items: [{
      itemId, sku: 'PD-001', name: '원두 200g', kind: 'retail', unit: 'pcs', baseUnit: 'pcs',
      thresholdBase: '30', trackRestock: false, trackExpiry: false, revision: 1, updatedAt: null,
      businessDate, stock: null, onlineStock: null, expiresOn: null, referenced: false,
    }], movements: [], movementsComplete: true, batches: [], batchesComplete: true, forecast: null }],
  });
  const snapshot = store.getSnapshot();
  expect(readInventoryTurn('원두 200g 온라인 재고 알려줘', snapshot, 'ko')).toMatchObject({
    intent: { kind: 'read', featureId, condition: { kind: 'snapshot', asOf: businessDate } },
    factKeys: [`product.channelBalance.${itemId}.online`],
  });
  const result = projectInventoryFacts(snapshot, featureId, { kind: 'snapshot', asOf: businessDate }, 'ko');
  expect(result && 'facts' in result ? result.facts.find(fact => fact.key === `product.channelBalance.${itemId}.online`) : undefined)
    .toMatchObject({ value: online ?? '확인할 수 없어요', unit: online === null ? '' : 'pcs', date: businessDate });
  expect(projectInventoryFacts(snapshot, featureId, today, 'ko')).toEqual({ status: 'unsupported_period' });
});

// Independent grading found "유통기한 임박한 재료랑 재고 모자란 재료" answered with "등록된 품목이 없어요" while the service held two lots expiring that day.
describe('expiring lots', () => {
  const itemId = '35a259a3-ca1f-455f-aa41-b97d8d152345', otherId = '9a2c0e5a-1111-4a3b-8c0d-2f7d2a9a0001';
  const stockItem = (id: string, name: string) => ({
    itemId: id, sku: `PD-${id.slice(-3)}`, name, kind: 'retail' as const, unit: 'pcs' as const, baseUnit: 'pcs' as const,
    thresholdBase: '30', trackRestock: false, trackExpiry: false, revision: 1, updatedAt: null,
    businessDate: TODAY, stock: null, onlineStock: null, expiresOn: null, referenced: false,
  });
  const batch = (batchId: string, id: string, expiresOn: string, remaining: string, discardedAt: string | null = null) => ({
    batchId, itemId: id, quantityBase: '20', remainingQuantityBase: remaining, expiresOn, receivedAt: `${TODAY}T01:00:00.000Z`, discardedAt, revision: 1,
  });
  const storeWith = (batches: ReturnType<typeof batch>[]) => createWidgetDataStore({
    inventoryItem: [{ ...retail[0], itemId }],
    inventoryStock: [{ itemId, channel: 'store', qty: 120 }, { itemId, channel: 'online', qty: 10 }],
    realStock: [{ businessDate: TODAY, items: [stockItem(itemId, '바스크 치즈케이크(조각)'), stockItem(otherId, '버터 소금빵')], movements: [], movementsComplete: true,
      batches, batchesComplete: true, forecast: null }],
  });
  const lots = [batch('b-today', itemId, TODAY, '8'), batch('b-soon', otherId, addDays(TODAY, 2), '12'),
    batch('b-far', itemId, addDays(TODAY, 9), '20'), batch('b-gone', itemId, TODAY, '5', `${TODAY}T02:00:00.000Z`), batch('b-empty', otherId, TODAY, '0')];

  it('projects a count and one fact per live lot that expires within three days, with its date and remaining quantity', () => {
    const snapshot = storeWith(lots).getSnapshot();
    const result = projectInventoryFacts(snapshot, featureId, { kind: 'snapshot', asOf: TODAY }, 'ko');
    if (!result || !('facts' in result)) throw new Error('Expected facts');
    const expiry = result.facts.filter(fact => fact.key.startsWith('inventory.expiry.'));
    expect(expiry.map(fact => fact.key)).toEqual(['inventory.expiry.count', 'inventory.expiry.b-today', 'inventory.expiry.b-soon']);
    expect(expiry[0]).toMatchObject({ value: 2, label: '유통기한 임박(3일 안)' });
    expect(expiry[1]).toMatchObject({ value: 8, unit: 'pcs', date: TODAY, label: expect.stringContaining('바스크 치즈케이크(조각)') });
    expect(expiry[1].label).toContain('유통기한');
    expect(expiry[2]).toMatchObject({ value: 12, date: addDays(TODAY, 2) });
  });

  it('says zero when no live lot is close to its date, and gives no expiry facts when the lots were not all read', () => {
    const none = projectInventoryFacts(storeWith([batch('b-far', itemId, addDays(TODAY, 9), '20')]).getSnapshot(), featureId, { kind: 'snapshot', asOf: TODAY }, 'ko');
    if (!none || !('facts' in none)) throw new Error('Expected facts');
    expect(none.facts.find(fact => fact.key === 'inventory.expiry.count')).toMatchObject({ value: 0 });
    const partial = createWidgetDataStore({
      inventoryItem: [{ ...retail[0], itemId }], inventoryStock: [{ itemId, channel: 'store', qty: 120 }, { itemId, channel: 'online', qty: 10 }],
      realStock: [{ businessDate: TODAY, items: [stockItem(itemId, '바스크 치즈케이크(조각)')], movements: [], movementsComplete: true, batches: lots, batchesComplete: false, forecast: null }],
    }).getSnapshot();
    const incomplete = projectInventoryFacts(partial, featureId, { kind: 'snapshot', asOf: TODAY }, 'ko');
    if (!incomplete || !('facts' in incomplete)) throw new Error('Expected facts');
    expect(incomplete.facts.some(fact => fact.key.startsWith('inventory.expiry.'))).toBe(false);
  });

  // D-413: no phrase route for expiry. A sentence that names no stock item is the planner's, and what it reads are the general expiry facts above.
  it('answers an expiry sentence from the expiry facts the planner reads, not with the router\'s unchecked "no registered item"', async () => {
    const store = storeWith(lots);
    const text = '유통기한 임박한 재료랑 재고 모자란 재료 같이 알려줘';
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { intent: { kind: string } };
      if (body.intent.kind !== 'classify') return new Response('', { status: 503 });
      const frames = [['status', { step: 'accepted' }], ['intent_plan', { plan: { kind: 'read', confidence: 'high',
        reads: [{ featureId, period: 'default', hints: ['유통기한'] }] } }], ['done', { outcome: 'reply' }]];
      return new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { status: 200, headers: { 'x-navis-protocol': 'agent-v1' } });
    }) as never;
    const reply = await createAssistantProvider({ store, fetcher, classify: true, compose: false }).ask({ text, signal: new AbortController().signal });
    expect(reply.turn?.kind).toBe('read');
    expect(reply.answer).not.toContain('등록된 품목이 없어요');
    expect(reply.answer).toContain('유통기한 임박(3일 안) 2개');
    expect(reply.answer).toContain('바스크 치즈케이크(조각)');
  });
});

it('keeps a missing package size separate from another stocked product with the same name', async () => {
  const stockedProduct: InventoryItem = { ...retail[0], name: { raw: '허브 200g' } };
  const store = createWidgetDataStore({ inventoryItem: [...seed.inventoryItem, stockedProduct], inventoryStock: [...seed.inventoryStock, ...stockedRetail.slice(0, 2)] });
  const before = store.getSnapshot();
  const { ask } = makeProvider(store);
  const reply = await ask('허브 500g 매장 재고 알려줘');
  expect(reply.turn?.kind).toBe('read');
  expect(reply.answer).toContain('확인할 수 있는 매장 자료가 없어요.');
  expect(reply.answer).not.toContain('120개');
  const move = await ask('허브 500g 20개 온라인으로 옮겨줘');
  expect(move.turn?.kind).toBe('refusal');
  expect(store.getSnapshot()).toBe(before);
});

it.each(['우유 재고 -3리터로 해줘', '우유 마이너스 3리터', '우유 재고 -3L', '우유 재고 마이너스 3'])(
  'S1-156 explains why %s needs a new stock amount', async text => {
    const store = createWidgetDataStore();
    const before = store.getSnapshot();
    const { ask, requests } = makeProvider(store);
    const reply = await ask(text);
    expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'stock' });
    expect(reply.answer).toContain('0 이상');
    expect(requests).toHaveLength(0);
    expect(store.getSnapshot()).toBe(before);
  },
);

it('accepts a corrected stock amount while preserving the requested threshold', async () => {
  const store = createWidgetDataStore();
  const before = store.getSnapshot();
  const { ask, requests } = makeProvider(store);
  const reply = await ask('우유 재고 -3L, 안전 재고 6L로 바꿔줘');
  if (reply.turn?.kind !== 'clarification') throw new Error(reply.answer);
  const clarificationId = reply.turn.id;
  await ask('-1L', { clarificationId, value: '-1L' });
  expect(requests).toHaveLength(0);
  const corrected = await ask('5L', { clarificationId, value: '5L' });
  if (corrected.turn?.kind !== 'proposal') throw new Error(corrected.answer);
  expect(store.getSnapshot()).toBe(before);
  expect(corrected.turn.proposal.confirm(store).frame.outcome).toBe('applied');
  expect(readModel(store.getSnapshot(), featureId).ingredients.find(row => row.itemId === 'i-milk'))
    .toMatchObject({ stock: 5000, threshold: 6000 });
});

it('S8-126 parses a spoken quantity ahead of the stock label', async () => {
  const store = createWidgetDataStore();
  const { ask } = makeProvider(store);
  for (const text of ['원두 삼 킬로로 재고 맞춰줘', '원두 2500g 재고 맞춰줘']) {
    expect((await ask(text)).turn?.kind).toBe('proposal');
  }
});

it.each(['원두 재고 2500그램으로 바꿔줘', '원두 2500g로 맞춰줘', '원두 재고 2천5백 그램'])(
  'S1-158 adjusts only the house beans after a card press for %s', async text => {
    const store = cafeWithRetail();
    const before = store.getSnapshot();
    const { ask } = makeProvider(store);
    const reply = await ask(text);
    expect(reply.turn?.kind).toBe('proposal');
    if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
    const { proposal } = reply.turn;
    expect(proposalPreview(proposal.preview)).toMatchObject({
      target: '하우스 블렌드 원두',
      fields: expect.arrayContaining([{ label: '현재 재고', before: '5,688 g', after: '2,500 g' }]),
    });
    await ask('네 해줘');
    await ask('응');
    expect(store.getSnapshot()).toBe(before);
    const receipt = proposal.confirm(store);
    expect(receipt.frame.outcome).toBe('applied');
    const after = store.getSnapshot();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.tables.stockAdjustment.slice(before.tables.stockAdjustment.length)).toMatchObject([
      { itemId: 'i-bean-house', deltaBase: -3188, reason: 'cell-edit' },
    ]);
    expect(after.tables.inventoryStock).toEqual(before.tables.inventoryStock);
    expect(deriveSuggestions(after, { date: TODAY }).find(row => row.itemId === 'i-bean-house'))
      .toMatchObject({ qty: 7, unit: 'kg' });
    expect(proposal.confirm(store).frame).toEqual(receipt.frame);
    expect(store.getSnapshot()).toBe(after);
    expect(store.undo(receipt.undoToken!).ok).toBe(true);
    expect(store.getSnapshot().tables.stockAdjustment).toEqual(before.tables.stockAdjustment);
    expect(deriveSuggestions(store.getSnapshot(), { date: TODAY })).toEqual(deriveSuggestions(before, { date: TODAY }));
  },
);

it('asks which ingredient to change when the ordinary bean alias has multiple candidates', () => {
  const store = createWidgetDataStore();
  expect(store.dispatch({ type: 'inventory.createItem', sku: 'BEAN-2', name: '싱글 오리진 원두', unit: 'kg', stock: 1, threshold: 1, idempotencyKey: 'extra-beans' }).ok).toBe(true);
  const before = store.getSnapshot();
  expect(readInventoryTurn('원두 재고 2.5kg으로 바꿔줘', before, 'ko')).toMatchObject({ kind: 'clarification', field: 'target' });
  expect(store.getSnapshot()).toBe(before);
});

it.each([
  ['드립백 세트 재고 50개로 수정해줘', 'read'],
  ['드립백 세트 30개 온라인에서 매장으로 옮겨줘', 'refusal'],
  ['원두 200그램 두 개 반 온라인', 'read'],
] as const)('keeps %s scoped to the missing retail record', async (text, kind) => {
  const store = createWidgetDataStore();
  const before = store.getSnapshot();
  const { ask, requests } = makeProvider(store);
  const reply = await ask(text);
  expect(reply.turn?.kind).toBe(kind);
  expect(reply.answer).toContain('확인할 수 있는 매장 자료가 없어요.');
  expect(requests[0]?.intent).toMatchObject({ kind: 'read', recordKind: 'stock' });
  expect(store.getSnapshot()).toBe(before);
});

it('S1-168 sets a requested threshold on the eligible item while preserving its alert setting', async () => {
  const item: InventoryItem = { ...retail[0], itemId: 'test-croissant', sku: 'CROIS-01', kind: 'ingredient',
    name: { raw: '크루아상' }, trackRestock: false, restockThreshold: null };
  const store = createWidgetDataStore({ inventoryItem: [...seed.inventoryItem, item] });
  const before = store.getSnapshot();
  const { ask } = makeProvider(store);
  const reply = await ask('크루아상 부족하면 알려줘 기준 20개로');
  if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
  expect(store.getSnapshot()).toBe(before);
  const receipt = reply.turn.proposal.confirm(store);
  expect(receipt.frame.outcome).toBe('applied');
  const after = store.getSnapshot();
  expect(after.tables.inventoryItem.find(row => row.itemId === item.itemId)).toMatchObject({ trackRestock: false, restockThreshold: 20 });
  expect(after.tables.stockAdjustment).toEqual(before.tables.stockAdjustment);
  expect(deriveSuggestions(after, { date: TODAY })).toEqual(deriveSuggestions(before, { date: TODAY }));
  expect(store.undo(receipt.undoToken!).ok).toBe(true);
  expect(store.getSnapshot().tables.inventoryItem).toEqual(before.tables.inventoryItem);
});

it.each(['귀리우유 품목 삭제해줘', '재고에서 귀리우유 지워', '귀리우유 품목 없애줘'])('S1-189 requires extra confirmation for %s', async text => {
  const oat: InventoryItem = { ...retail[0], itemId: 'test-oat', sku: 'OAT-01', kind: 'ingredient', unit: 'L', name: { raw: '귀리우유' } };
  const purchase = { ...seed.purchaseItem[0], purchaseItemId: 'test-purchase-oat', itemId: oat.itemId };
  const store = createWidgetDataStore({ inventoryItem: [...seed.inventoryItem, oat], purchaseItem: [...seed.purchaseItem, purchase] });
  const before = store.getSnapshot();
  const { ask } = makeProvider(store);
  const reply = await ask(text);
  if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
  const { proposal } = reply.turn;
  await ask('네 해줘');
  expect(proposal.confirm(store).requiresExtraConfirmation).toBe(true);
  await ask('응');
  expect(store.getSnapshot()).toBe(before);
  const receipt = proposal.confirm(store, proposal.id);
  expect(receipt.frame.outcome).toBe('applied');
  const after = store.getSnapshot();
  expect(after.revision).toBe(before.revision + 1);
  expect(after.tables.inventoryItem.find(row => row.itemId === oat.itemId)?.deletedAt).toBeDefined();
  expect(after.tables.purchaseItem).toEqual(seed.purchaseItem);
  expect(proposal.confirm(store, proposal.id).frame).toEqual(receipt.frame);
  expect(store.getSnapshot()).toBe(after);
  expect(store.undo(receipt.undoToken!).ok).toBe(true);
  expect(store.getSnapshot().tables.purchaseItem).toEqual(before.tables.purchaseItem);
  expect(store.getSnapshot().tables.inventoryItem).toEqual(before.tables.inventoryItem);
});

it('refuses a missing target for a safety stock change without proposing a write', async () => {
  const store = createWidgetDataStore();
  const before = store.getSnapshot();
  const { ask, requests } = makeProvider(store);
  const reply = await ask('크루아상 보충 기준 20개로 설정해줘');
  expect(reply.turn).toMatchObject({ kind: 'refusal', reason: 'invalid_target' });
  expect(requests[0]?.intent).toMatchObject({ kind: 'read', recordKind: 'stock' });
  expect(store.getSnapshot()).toBe(before);
});

it.each(['원두 200그램 가격', '원두 200g 얼마야?'])(
  'leaves the price question %s to the appropriate widget', text => {
    const snapshot = createWidgetDataStore().getSnapshot();
    expect(readInventoryTurn(text, snapshot, 'ko')).toBeUndefined();
  },
);

it('rejects an inventory card after an intervening update', async () => {
  const store = createWidgetDataStore();
  const { ask } = makeProvider(store);
  const reply = await ask('원두 재고 2500g으로 바꿔줘');
  if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
  expect(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-bean-house', stock: 3000 }).ok).toBe(true);
  const latest = store.getSnapshot();
  expect(reply.turn.proposal.confirm(store, reply.turn.proposal.id).frame.outcome).toBe('conflict');
  expect(store.getSnapshot()).toBe(latest);
});

it.each([
  ['원두 2.0005kg', 'stock'],
  ['원두 재고 이점영영영오 킬로', 'stock'],
  ['우유 재고 5박스로', 'unit'],
  ['컵 두 박스 있어', 'packSize'],
  ['귀리우유 품목코드 RM-001 리터 4 2', 'sku'],
  ['귀리우유 OAT-01 단위 개 두 개 반', 'stock'],
])('asks for %s correction without sending a command', (text, field) => {
  const snapshot = createWidgetDataStore().getSnapshot();
  expect(readInventoryTurn(text, snapshot, 'ko')).toMatchObject({ kind: 'clarification', field });
});

it('S8-127 keeps the named ingredient and converts half kilos to base grams', () => {
  const snapshot = createWidgetDataStore().getSnapshot();
  for (const [text, name, stock] of [
    ['원두 반 키로로 바꿔줘', '하우스 블렌드 원두', 500],
    ['원두 한 킬로 반으로 바꿔줘', '하우스 블렌드 원두', 1500],
    ['우유 한 리터 반으로 맞춰줘', '목장 1등급 우유', 1500],
  ] as const) {
    expect(readInventoryTurn(text, snapshot, 'ko')).toMatchObject({ intent: { command: 'inventory.updateItem' }, slots: { stock, name } });
  }
});

it('S1-177 registers a measured quantity with alerts off through a card', async () => {
  const store = createWidgetDataStore();
  const before = store.getSnapshot();
  const { ask } = makeProvider(store);
  const reply = await ask('재고에 참깨 SES-01 2kg 보충알림 끔');
  expect(reply.turn?.kind).toBe('proposal');
  if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
  expect(store.getSnapshot()).toBe(before);
  const receipt = reply.turn.proposal.confirm(store);
  expect(receipt.frame.outcome).toBe('applied');
  const item = readModel(store.getSnapshot(), featureId).ingredients.find(row => row.sku === 'SES-01');
  expect(item).toMatchObject({ trackRestock: false, stock: 2, unit: 'kg', threshold: 0 });
  expect(store.undo(receipt.undoToken!).ok).toBe(true);
  expect(store.getSnapshot().tables.inventoryItem).toEqual(before.tables.inventoryItem);
});

it('S1-179 conserves the two stored channel balances and requires both records', async () => {
  const store = cafeWithRetail();
  const before = store.getSnapshot();
  const reply = await makeProvider(store).ask('원두 200g 20개 매장에서 온라인으로 옮겨줘');
  if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
  const preview = proposalPreview(reply.turn.proposal.preview);
  expect(preview?.fields).toEqual([
    { label: '매장', before: '120개', after: '100개' },
    { label: '온라인', before: '40개', after: '60개' },
  ]);
  expect(store.getSnapshot()).toBe(before);
  const receipt = reply.turn.proposal.confirm(store);
  expect(receipt.frame.outcome).toBe('applied');
  expect(readModel(store.getSnapshot(), featureId).products).toMatchObject({ total: 248, byChannel: { store: 160, online: 88 } });
  expect(store.getSnapshot().tables.inventoryTxn.slice(-2)).toMatchObject([{ qty: -20, channel: 'store' }, { qty: 20, channel: 'online' }]);
  expect(store.undo(receipt.undoToken!).ok).toBe(true);
  expect(store.getSnapshot().tables.inventoryStock).toEqual(before.tables.inventoryStock);

  const partial = cafeWithRetail(stockedRetail.filter(row => row.itemId !== 'it-beans200' || row.channel !== 'online'));
  const previous = partial.getSnapshot();
  const missing = await makeProvider(partial).ask('원두 200g 20개 매장에서 온라인으로 옮겨줘');
  expect(missing.turn?.kind).toBe('refusal');
  expect(partial.getSnapshot()).toBe(previous);
});

it.each([
  ['원두 200그램 20개 온라인으로 옮겨줘 매장 거에서', 'it-beans200', 100, 60],
  ['원두200g 매장->온라인 20개 이동', 'it-beans200', 100, 60],
  ['드립백 세트 10개 온라인에서 매장으로 옮겨줘', 'it-dripbag', 70, 18],
  ['드립백 온라인 거 10개 매장으로', 'it-dripbag', 70, 18],
  ['드립백세트 온라인->매장 10개', 'it-dripbag', 70, 18],
  ['원두 20개만 온라인 쪽으로', 'it-beans200', 100, 60],
  ['원두 온라인으로 20개', 'it-beans200', 100, 60],
] as const)('scopes the eligible transfer %s and refuses if the retail record is absent', async (text, itemId, inStore, online) => {
  const store = cafeWithRetail();
  const reply = await makeProvider(store).ask(text);
  if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
  const receipt = reply.turn.proposal.confirm(store);
  expect(receipt.frame.outcome).toBe('applied');
  const balances = store.getSnapshot().tables.inventoryStock.filter(row => row.itemId === itemId);
  expect(balances).toEqual(expect.arrayContaining([
    expect.objectContaining({ channel: 'store', qty: inStore }), expect.objectContaining({ channel: 'online', qty: online }),
  ]));
  const absent = createWidgetDataStore();
  const before = absent.getSnapshot();
  const missing = await makeProvider(absent).ask(text);
  expect(missing.turn?.kind).toBe('refusal');
  expect(absent.getSnapshot()).toBe(before);
});

it('rejects an explicitly incompatible starting quantity when registering a stock item', () => {
  const snapshot = createWidgetDataStore().getSnapshot();
  const volume = readInventoryTurn('귀리우유 OAT-01 단위 L 재고 500mL 기준 2로 추가해줘', snapshot, 'ko');
  expect(volume).toMatchObject({ intent: { command: 'inventory.createItem' }, slots: { stock: 0.5 } });
  const mass = readInventoryTurn('귀리우유 OAT-01 단위 L 재고 2kg 기준 2로 추가해줘', snapshot, 'ko');
  expect(mass).toMatchObject({ kind: 'clarification', field: 'stock' });
});

it('keeps the Chinese inventory copy inside both production font weights', () => {
  const scripts = { 'zh-Hans': 'NavisHans', 'zh-Hant': 'NavisHant' } as const;
  for (const locale of ['zh-Hans', 'zh-Hant'] as const) {
    const characters = [...new Set(Object.values(inventoryCopy[locale]).join(''))]
      .filter(character => /[·‐-‧⺀-⿟\u3000-〿㐀-䶿一-鿿豈-﫿！-｠￠-￦]/u.test(character));
    for (const weight of [500, 700]) {
      const file = resolve(process.cwd(), 'src/assets/fonts', `${scripts[locale]}-${weight}.woff2`);
      const cmap = woff2Cmap(readFileSync(file));
      expect(characters.filter(character => !cmap.has(character.codePointAt(0)!))).toEqual([]);
    }
  }
});

const corpusPath = resolve(process.cwd(), '../.evidence/navis-scenarios');
type Scenario = { id: string; utterances: string[]; expected: { kind: string; ask?: string[]; answer_must_contain?: string[]; tools?: {name: string; args: { command?: string; view?: string; itemId?: string }}[] } };
const corpus = new Map((JSON.parse(readFileSync(resolve(corpusPath, 'MERGED.json'), 'utf8')) as Scenario[]).map(row => [row.id, row]));
const overlay = JSON.parse(readFileSync(resolve(corpusPath, 'CAFE-OVERLAY.json'), 'utf8')) as Record<string, { expected?: Partial<Scenario['expected']> }>;
const trace = readFileSync(resolve(corpusPath, 'TRACE.csv'), 'utf8').trim().split(/\r?\n/u).slice(1)
  .map(line => [...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/gu)].map(([, quoted, literal]) => quoted ?? literal));
const primary = trace.filter(row => row[9] === 'N05');
const dependent = trace.filter(row => row[8].split('|').includes('N05'));

it('accounts for all 63 primary IDs and 18 additional dependency IDs in TRACE', () => {
  expect(new Set(primary.map(row => row[0])).size).toBe(63);
  expect(new Set(dependent.map(row => row[0])).size).toBe(81);
  expect(dependent.filter(row => row[9] !== 'N05')).toHaveLength(18);
});

const errata: Readonly<Partial<Record<string, { observed: 'proposal' | 'clarify' | 'answer' | 'unresolved' | 'navigate'; answer?: string }>>> = {
  'S1-014': { observed: 'answer', answer: '카페라떼' },
  'S1-061': { observed: 'unresolved' },
  'S1-133': { observed: 'unresolved' },
  'S1-139': { observed: 'answer', answer: '확인할 수 있는 매장 자료가 없어요.' },
  'S1-141': { observed: 'answer', answer: '21,960 mL' },
  'S1-144': { observed: 'answer', answer: '1,406개' },
  'S1-145': { observed: 'answer', answer: 'RM-004' },
  'S1-153': { observed: 'proposal' },
  'S1-159': { observed: 'clarify' },
  'S1-161': { observed: 'proposal' },
  'S1-162': { observed: 'proposal' },
  'S1-164': { observed: 'proposal' },
  'S1-165': { observed: 'proposal' },
  'S1-168': { observed: 'unresolved' },
  'S1-169': { observed: 'unresolved' },
  'S1-179': { observed: 'unresolved' },
  'S1-180': { observed: 'unresolved' },
  'S1-181': { observed: 'unresolved' },
  'S1-182': { observed: 'unresolved' },
  'S1-183': { observed: 'unresolved' },
  'S1-184': { observed: 'unresolved' },
  'S1-187': { observed: 'unresolved' },
  'S7-078': { observed: 'navigate' },
  'S7-079': { observed: 'navigate' },
  'S8-018': { observed: 'proposal' },
  'S8-042': { observed: 'unresolved' },
  'S8-091': { observed: 'proposal' },
  'S8-095': { observed: 'proposal' },
  'S8-125': { observed: 'proposal' },
};

const writes: Record<string, { itemId: string; stock?: number; threshold?: number; name?: string }> = {
  'S1-153': { itemId: 'i-milk', stock: 5000 }, 'S1-158': { itemId: 'i-bean-house', stock: 2500 }, 'S1-161': { itemId: 'i-milk', threshold: 6000 },
  'S1-162': { itemId: 'i-cup-takeout', threshold: 100 }, 'S1-163': { itemId: 'i-cup-takeout', name: '종이컵' },
  'S1-164': { itemId: 'i-cup-takeout', stock: 120 }, 'S1-165': { itemId: 'i-milk', stock: 5000, threshold: 6000 },
  'S1-166': { itemId: 'i-bean-house', stock: 3000 }, 'S8-126': { itemId: 'i-bean-house', stock: 3000 },
  'S8-127': { itemId: 'i-bean-house', stock: 500 },
  'S8-018': { itemId: 'i-milk', stock: 5 }, 'S8-091': { itemId: 'i-milk', stock: 5000 },
  'S8-095': { itemId: 'i-milk', stock: 5000 }, 'S8-125': { itemId: 'i-milk', stock: 5000 }, 'S8-128': { itemId: 'i-cup-takeout', stock: 200 },
};

describe('N05 client contract on the café seed', () => {
  it.each(primary.map(row => [row[0]] as const))('%s', async id => {
    const scenario = corpus.get(id)!;
    const expected = { ...scenario.expected, ...overlay[id]?.expected };
    const store = createWidgetDataStore();
    if (id === 'S1-189') {
      expect(store.dispatch({ type: 'inventory.createItem', sku: 'OAT-01', name: '귀리우유', unit: 'L', stock: 4, threshold: 2, idempotencyKey: id }).ok).toBe(true);
    }
    if (id === 'S1-167') {
      expect(store.dispatch({ type: 'inventory.createItem', sku: 'SYR-01', name: '카라멜 시럽', unit: 'L', stock: 4, threshold: 2, idempotencyKey: id }).ok).toBe(true);
    }
    const before = store.getSnapshot();
    const text = scenario.utterances[0];
    const exception = errata[id];
    const expectedKind = exception?.observed ?? expected.kind;
    if (expectedKind === 'navigate') {
      const entry = inventoryNavigation(text, before, 'ko');
      const tool = expected.tools?.at(-1);
      expect(entry?.args).toMatchObject({ featureId, view: tool?.args.view ?? 'history' });
      if (tool?.args.itemId) expect(entry?.args.itemId).toBe('i-milk');
      expect(store.getSnapshot()).toBe(before);
      return;
    }
    const { ask } = makeProvider(store);
    const reply = await ask(text);
    expect(store.getSnapshot()).toBe(before);
    if (expectedKind === 'unresolved') {
      expect(reply.turn?.kind).not.toBe('proposal');
      return;
    }
    if (expectedKind === 'proposal') {
      if (reply.turn?.kind !== 'proposal') throw new Error(`Expected proposal: ${reply.answer}`);
      const command = expected.tools?.find(tool => tool.name === 'propose_action')?.args.command;
      expect(reply.turn.proposal.command).toBe(command ?? 'inventory.updateItem');
      expect(proposalPreview(reply.turn.proposal.preview)).toBeDefined();
      if (command === 'inventory.deleteItem') {
        expect(reply.turn.proposal.confirm(store).requiresExtraConfirmation).toBe(true);
        expect(store.getSnapshot()).toBe(before);
      }
      const receipt = reply.turn.proposal.confirm(store, reply.turn.proposal.id);
      expect(receipt.frame.outcome).toBe('applied');
      const after = store.getSnapshot();
      expect(after.revision).toBe(before.revision + 1);
      const check = writes[id];
      if (check) {
        const row = readModel(after, featureId).ingredients.find(row => row.itemId === check.itemId);
        if (check.stock !== undefined) expect(row?.stock).toBe(check.stock);
        if (check.threshold !== undefined) expect(row?.threshold).toBe(check.threshold);
        if (check.name !== undefined) expect(row?.name).toEqual({ raw: check.name });
      }
      expect(receipt.undoToken).toBeDefined();
      expect(store.undo(receipt.undoToken!).ok).toBe(true);
      expect(store.getSnapshot().tables.inventoryItem).toEqual(before.tables.inventoryItem);
      expect(store.getSnapshot().tables.stockAdjustment).toEqual(before.tables.stockAdjustment);
      return;
    }
    if (expectedKind === 'clarify') {
      expect(['clarification', 'ambiguity']).toContain(reply.turn?.kind);
      return;
    }
    if (expectedKind === 'refuse') expect(reply.turn?.kind).toBe('refusal');
    if (expectedKind === 'answer') {
      expect(reply.turn?.kind).not.toBe('proposal');
      const evidence = exception ? (exception.answer ? [exception.answer] : []) : expected.answer_must_contain ?? [];
      for (const phrase of evidence) expect(reply.answer).toContain(phrase);
    }
  });
});

describe('A3-B27 selector-backed inventory facts', () => {
  it.each(['컵 며칠이나 쓸 수 있어?', '컵 언제 떨어져?', '컵 재고로 하루 버텨?'])(
    'S1-144 states the cup stock and the days left with a day unit for %s', async text => {
      const store = createWidgetDataStore();
      const before = store.getSnapshot();
      const { ask, requests } = makeProvider(store);
      const reply = await ask(text);
      expect(reply.turn?.kind).toBe('read');
      expect(requests[0]?.intent).toMatchObject({ kind: 'read', featureId, condition: { kind: 'snapshot', asOf: TODAY } });
      expect(reply.answer).toContain('음료 컵·뚜껑·슬리브 세트 · 현재 재고 1,406개');
      expect(reply.answer).toMatch(/남은 일수 6일(?:$|\n)/u);
      expect(store.getSnapshot()).toBe(before);
    },
  );

  it('S1-144 says the days left cannot be calculated for an item with no usage today instead of staying silent', async () => {
    const store = createWidgetDataStore();
    expect(store.dispatch({ type: 'inventory.createItem', sku: 'OAT-01', name: '귀리우유', unit: 'L', stock: 4, threshold: 2, idempotencyKey: 'b27-days' }).ok).toBe(true);
    const reply = await makeProvider(store).ask('귀리우유 며칠 쓸 수 있어?');
    expect(reply.turn?.kind).toBe('read');
    expect(reply.answer).toContain('귀리우유 · 현재 재고 4 L');
    expect(reply.answer).toContain('귀리우유 · 오늘 사용량 기준 남은 일수 오늘 사용량이 없어 계산할 수 없어요');
    expect(reply.answer).not.toMatch(/0일/u);
  });

  it('keeps the day unit on the projected fact in every locale', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      const facts = projectInventoryFacts(snapshot, featureId, today, locale);
      if (!facts || !('facts' in facts)) throw new Error('Expected facts');
      const days = facts.facts.find(fact => fact.key === 'inventory.daysLeft.i-cup-takeout');
      expect(days).toMatchObject({ value: 6, unit: 'day' });
      expect(days?.display).toMatch(/6/u);
      expect(days?.display).not.toBe('6');
    }
  });

  it.each(['온라인 재고 부족한 상품 있어?', '채널별로 모자란 판매 상품', '온라인에 물건 부족한 거 있나'])(
    'S1-139 says the store has no product data when the catalog has no retail rows (%s)', async text => {
      const store = createWidgetDataStore();
      const before = store.getSnapshot();
      const { ask, requests } = makeProvider(store);
      const reply = await ask(text);
      expect(reply.turn?.kind).toBe('read');
      expect(requests[0]?.intent).toMatchObject({ kind: 'read', featureId, condition: { kind: 'snapshot', asOf: TODAY } });
      expect(reply.answer).toBe('확인할 수 있는 매장 자료가 없어요.');
      expect(store.getSnapshot()).toBe(before);
    },
  );

  it('S1-139 lists the low online channel with the product, channel and quantity', async () => {
    const store = cafeWithRetail();
    const before = store.getSnapshot();
    const { ask } = makeProvider(store);
    for (const text of ['온라인 재고 부족한 상품 있어?', '온라인에 물건 부족한 거 있나']) {
      const reply = await ask(text);
      expect(reply.turn?.kind).toBe('read');
      expect(reply.answer).toContain('드립백 세트 · 온라인 28개');
      expect(reply.answer).not.toContain('원두 200g');
      expect(reply.answer).not.toContain('확인할 수 있는 매장 자료가 없어요.');
    }
    expect(store.getSnapshot()).toBe(before);
  });

  it('S1-139 reads only low online balances even when a separate store channel is low', async () => {
    const store = cafeWithRetail(stockedRetail.map(row =>
      row.itemId === 'it-beans200' && row.channel === 'store' ? { ...row, qty: 5 } : row));
    const { ask } = makeProvider(store);
    const online = await ask('온라인 재고 부족한 상품 있어?');
    expect(online.answer).toContain('드립백 세트 · 온라인 28개');
    expect(online.answer).not.toContain('원두 200g');
    const both = await ask('채널별로 모자란 판매 상품');
    expect(both.answer).toContain('원두 200g · 매장 5개');
    expect(both.answer).toContain('드립백 세트 · 온라인 28개');
  });

  it('S1-139 reports a measured zero when every channel is above its threshold', async () => {
    const store = cafeWithRetail(stockedRetail.map(row => ({ ...row, qty: 90 })));
    const { ask } = makeProvider(store);
    const reply = await ask('온라인 재고 부족한 상품 있어?');
    expect(reply.turn?.kind).toBe('read');
    expect(reply.answer).toBe('재고가 부족한 판매 채널 0개');
    expect(reply.answer).not.toContain('확인할 수 있는 매장 자료가 없어요.');
  });

  it.each([['우유 코드가 뭐였지?', 'RM-004'], ['우유 SKU 알려줘', 'RM-004'], ['원두 품목 코드', 'RM-001']])(
    'S1-145 answers the SKU of the named item only (%s)', async (text, sku) => {
      const { ask, requests } = makeProvider(createWidgetDataStore());
      const reply = await ask(text);
      expect(requests[0]?.intent).toMatchObject({ kind: 'read', recordKind: 'stock', querySlot: 'name' });
      expect(reply.answer).toBe(sku);
    },
  );

  it.each(['참치 재고 얼마야?', '참치 몇 개 남았어', '참치캔 재고'])(
    'S1-146 says the item is not registered rather than zero for %s', async text => {
      const store = createWidgetDataStore();
      const before = store.getSnapshot();
      const { ask, requests } = makeProvider(store);
      const reply = await ask(text);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.intent).toMatchObject({ kind: 'read', recordKind: 'stock', querySlot: 'name' });
      expect(reply.turn?.kind).toBe('read');
      expect(reply.answer).toBe('등록된 품목이 없어요');
      expect(reply.answer).not.toMatch(/0\s*개/u);
      expect(store.getSnapshot()).toBe(before);
    },
  );

  it.each(['쿠폰 몇 개 남았어', '자리 몇 개 남았어', '오늘 재고', '이번 주 재고'])(
    'leaves the other-domain or date-only phrase %s unclaimed', text => {
      const snapshot = createWidgetDataStore().getSnapshot();
      expect(readInventoryTurn(text, snapshot, 'ko')).toBeUndefined();
    },
  );
});
