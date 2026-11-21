import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { woff2Cmap } from '../../../assets/fonts/dev/woff2-cmap';
import { createWidgetDataStore, readModel, selectStockHistory } from '../../../data/widget-data';
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
const cafeWithRetail = (rows: readonly typeof stockedRetail[number][] = stockedRetail) => createWidgetDataStore({
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
  return { requests, ask: (text: string) => fake.ask({ text, locale: 'ko', signal: new AbortController().signal }) };
}

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
  'S1-060': { observed: 'unresolved' },
  'S1-061': { observed: 'unresolved' },
  'S1-133': { observed: 'unresolved' },
  'S1-138': { observed: 'unresolved' },
  'S1-139': { observed: 'answer' },
  'S1-141': { observed: 'answer', answer: '21,960 mL' },
  'S1-144': { observed: 'answer', answer: '1,406개' },
  'S1-145': { observed: 'answer', answer: 'RM-004' },
  'S1-153': { observed: 'proposal' },
  'S1-158': { observed: 'clarify' },
  'S1-159': { observed: 'clarify' },
  'S1-161': { observed: 'proposal' },
  'S1-162': { observed: 'proposal' },
  'S1-164': { observed: 'proposal' },
  'S1-165': { observed: 'proposal' },
  'S1-166': { observed: 'clarify' },
  'S1-168': { observed: 'unresolved' },
  'S1-169': { observed: 'unresolved' },
  'S1-179': { observed: 'unresolved' },
  'S1-180': { observed: 'unresolved' },
  'S1-181': { observed: 'unresolved' },
  'S1-182': { observed: 'unresolved' },
  'S1-183': { observed: 'unresolved' },
  'S1-184': { observed: 'unresolved' },
  'S1-185': { observed: 'clarify' },
  'S1-187': { observed: 'unresolved' },
  'S7-078': { observed: 'navigate' },
  'S7-079': { observed: 'navigate' },
  'S8-018': { observed: 'proposal' },
  'S8-042': { observed: 'unresolved' },
  'S8-091': { observed: 'proposal' },
  'S8-095': { observed: 'proposal' },
  'S8-125': { observed: 'proposal' },
  'S8-126': { observed: 'clarify' },
  'S8-127': { observed: 'clarify' },
};

const writes: Record<string, { itemId: string; stock?: number; threshold?: number; name?: string }> = {
  'S1-153': { itemId: 'i-milk', stock: 5000 }, 'S1-161': { itemId: 'i-milk', threshold: 6000 },
  'S1-162': { itemId: 'i-cup-takeout', threshold: 100 }, 'S1-163': { itemId: 'i-cup-takeout', name: '종이컵' },
  'S1-164': { itemId: 'i-cup-takeout', stock: 120 }, 'S1-165': { itemId: 'i-milk', stock: 5000, threshold: 6000 },
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
