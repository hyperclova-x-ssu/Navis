/**
 * R1-F17: Navis facts for a widget that has not been opened yet load through the F00 port before any projection reads them, and a
 * domain that could not be read is `unavailable` for Navis (the fixture seed rows are never shown as the store's facts).
 */
import { describe, expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../data/widget-data';
import type { RealTaxSnapshot, TaxPeriodRead } from '../../data/reality/18/dto';
import { menuCommandAdapter } from './domains/menu';
import type { AgentRequest } from '../../../shared/navis-agent-schema.mjs';
import { assistantDomains, buildAgentRequest, projectAgentWidget, storeFactSource } from './snapshot';
import { createAssistantProvider } from './provider';
import { gateUnreadable } from './real-gate';
import { replyResponse } from './stream-fixture';
import { rig } from './real-card-rig';
import { createMoneyDomain } from './domains/money';
import { widgetHandoffRef } from './widget-handoff';

const serverOnly = '서버에만 있는 라테';
const menuNames = (t: ReturnType<typeof rig>) => t.store.getSnapshot().tables.menuItem.map(item => item.name && 'raw' in item.name ? item.name.raw : item.nameKey);
const emptyTaxPeriod = (from: string, to: string): TaxPeriodRead => ({
  reviews: [],
  preview: { from, to, asOf: '2026-11-22T00:00:00Z', sourceRevision: 1,
    verification: { status: 'verified' }, estimate: null, connections: [], officialLinks: { hometax: '' },
    preview: { sales: { total: 0 }, deposits: { total: 0 }, expenses: { total: 0, count: 0, evidenceRecorded: 0, missingEvidence: 0 },
      reviews: { needsCheck: 0, checked: 0 }, taxPayments: { count: 1, paidTotal: 0, unpaidTotal: 0, withEvidenceFile: 0 },
      cashReceipts: null, rowCount: 1 } },
});
const realTax: RealTaxSnapshot = { today: '2026-11-22', month: emptyTaxPeriod('2026-11-01', '2026-11-22'), last: emptyTaxPeriod('2026-10-01', '2026-10-31') };

it.each(['missing', 'unavailable'] as const)('advertises the current stock condition for a %s read', status => {
  const store = createWidgetDataStore(undefined, { runId: 'stock-date' });
  store.hydrate({ realStock: [{ businessDate: '2026-11-21', items: [], movements: [], movementsComplete: true, batches: [], batchesComplete: true, forecast: null }] });
  const snapshot = store.getSnapshot();
  const condition = { kind: 'snapshot', asOf: '2026-11-21' } as const;
  const featureId = 'inventory-booking';
  const request = buildAgentRequest(snapshot, { kind: 'read', featureId, condition }, 'ko', 'management', [],
    { snapshot: [{ featureId, condition, status }], searches: [] });
  const conditions = request?.catalog.find(row => row.id === featureId)?.conditions;
  expect(conditions).toContainEqual(condition);
  expect(conditions).toContainEqual({ kind: 'dateRange', start: '2026-11-15', end: '2026-11-21' });
  expect(conditions).not.toContainEqual({ kind: 'snapshot', asOf: '2026-11-17' });
  const unexpected: AgentRequest['snapshot'][number] = { featureId, condition: { kind: 'snapshot', asOf: '2026-11-17' }, facts: [] };
  expect(buildAgentRequest(snapshot, { kind: 'read', featureId }, 'ko', 'management', [], { snapshot: [unexpected], searches: [] })
    ?.catalog.find(row => row.id === featureId)?.conditions).toEqual(conditions);
});

it('uses the tax service date for today’s cash receipt question', () => {
  const store = createWidgetDataStore(undefined, { runId: 'tax-date' });
  const base = store.getSnapshot();
  const snapshot = { ...base, pos: { ...base.pos!, businessDate: '2026-11-21' }, tables: { ...base.tables, realTax } };
  const result = createMoneyDomain().route?.('오늘 현금영수증 몇 건 발행했어?', snapshot, 'ko');
  expect(result).toMatchObject({ intent: { featureId: 'tax', condition: { kind: 'dateRange', start: '2026-11-22', end: '2026-11-22' } } });
});

it('opens the payment row for evidence removal without expanding an upload form', () => {
  const base = createWidgetDataStore().getSnapshot();
  const payment = { ...base.tables.taxPayment[0], taxPaymentId: 'selected-tax', type: { raw: '부가세' } };
  const snapshot = { ...base, tables: { ...base.tables, taxPayment: [payment], realTax } };
  const result = createMoneyDomain().route?.('부가세 증빙 파일 지워줘', snapshot, 'ko');
  expect(result).toMatchObject({ kind: 'refusal', reason: 'widget_only' });
  if (!result || !('kind' in result) || result.kind !== 'refusal' || !result.alternative) throw new Error('Missing handoff');
  expect(widgetHandoffRef(result.alternative)).toEqual({ featureId: 'tax', view: 'evidence', itemId: 'selected-tax', focus: 'action' });
});

describe('preloading facts through the port', () => {
  it('loads every http domain once before the first question reads the snapshot, and not again for the next one', async () => {
    const t = rig();
    t.server.push(t.row('m-server', serverOnly, 4_800));
    let statusWhenChatStarted: string | undefined;
    const fetcher = vi.fn(async () => { statusWhenChatStarted ??= t.port.state('menu').status; return replyResponse({ answer: '답', panels: [] }); });
    const provider = createAssistantProvider({ store: t.store, fetcher });
    expect(menuNames(t)).not.toContain(serverOnly);
    await provider.ask({ text: '오늘 얼마 벌었어?', signal: new AbortController().signal });
    // The load finished before the question's own request started, so the snapshot it read already holds the server's rows.
    expect(statusWhenChatStarted).toBe('ready');
    expect(menuNames(t)).toContain(serverOnly);
    expect(t.port.state('menu').status).toBe('ready');
    const loaded = t.port.state('menu').sourceRevision;
    await provider.ask({ text: '오늘 얼마 벌었어?', signal: new AbortController().signal });
    expect(t.port.state('menu').sourceRevision).toBe(loaded);
    expect(fetcher).toHaveBeenCalled();
  });

  it('exposes the same warm-up for the dashboard to start when the chat opens', async () => {
    const t = rig();
    t.server.push(t.row('m-server', serverOnly, 4_800));
    const provider = createAssistantProvider({ store: t.store });
    expect(provider.preloadFacts).toBeTypeOf('function');
    await provider.preloadFacts!();
    expect(menuNames(t)).toContain(serverOnly);
    await provider.preloadFacts!();
    expect(t.port.state('menu').status).toBe('ready');
  });

  it('does nothing without a port: a fixture store answers synchronously as before', async () => {
    const store = createWidgetDataStore(undefined, { runId: 'fixture-facts' });
    const provider = createAssistantProvider({ store, fetcher: vi.fn(async () => replyResponse({ answer: '답', panels: [] })) });
    await expect(provider.preloadFacts!()).resolves.toBeUndefined();
  });

  it('does not wait forever for a slow server: the question goes on with that domain unavailable', async () => {
    const t = rig();
    t.control.hold = new Promise(() => {});
    vi.useFakeTimers();
    try {
      const provider = createAssistantProvider({ store: t.store });
      const done = provider.preloadFacts!();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(done).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

describe('a domain Navis could not read', () => {
  it('withholds margin facts when its HTTP menu dependency is unopened, including the simple reply source', () => {
    const t = rig();
    const gated = gateUnreadable(assistantDomains, t.store);
    const condition = { kind: 'default' } as const;
    expect(projectAgentWidget(t.store.getSnapshot(), 'margin', condition, 'ko', gated)).toMatchObject({ status: 'unavailable', facts: [] });
    expect(storeFactSource(t.store).view('margin', condition)).toMatchObject({ status: 'error' });
  });
  it('is unavailable for widget facts and record search, and a card for it is not prepared', async () => {
    const t = rig();
    t.control.failLoad = true;
    await t.port.load('menu');
    expect(t.port.state('menu').status).toBe('error');
    const gated = gateUnreadable(assistantDomains, t.store);
    const snapshot = t.store.getSnapshot();
    expect(projectAgentWidget(snapshot, 'menu', { kind: 'default' }, 'ko', gated)).toMatchObject({ status: 'unavailable', facts: [] });
    expect(gated.reader('menu')!.search({ snapshot, locale: 'ko', query: '아메리카노', privateLookup: false })).toEqual([]);
    const blocked = gated.command('menu.create')!.preflight({ name: '새 메뉴', category: 'drink', price: 4_000 }, { snapshot, proposalId: 'p', idempotencyKey: 'k' });
    expect(blocked).toMatchObject({ kind: 'invalid', messageKey: 'data.real.error.SOURCE_UNAVAILABLE' });
  });

  it('reads through unchanged once the domain loaded, keeping adapter identity', async () => {
    const t = rig();
    await t.port.load('menu');
    const gated = gateUnreadable(assistantDomains, t.store);
    expect(gated.command('menu.create')).toBe(menuCommandAdapter);
    expect(gated.reader('menu')).toBe(assistantDomains.reader('menu'));
    expect(projectAgentWidget(t.store.getSnapshot(), 'menu', { kind: 'default' }, 'ko', gated).status).toBe('ready');
  });

  it('never gates a fixture store or a widget without a data domain', () => {
    const store = createWidgetDataStore(undefined, { runId: 'fixture-gate' });
    const gated = gateUnreadable(assistantDomains, store);
    expect(gated.command('menu.create')).toBe(menuCommandAdapter);
    expect(projectAgentWidget(store.getSnapshot(), 'menu', { kind: 'default' }, 'ko', gated).status).toBe('ready');
  });

  it('shows the failing load as stale data, not unavailable, once a first load succeeded', async () => {
    const t = rig();
    await t.port.load('menu');
    t.control.failLoad = true;
    await t.port.retry('menu');
    expect(t.port.state('menu').status).toBe('stale');
    const gated = gateUnreadable(assistantDomains, t.store);
    expect(projectAgentWidget(t.store.getSnapshot(), 'menu', { kind: 'default' }, 'ko', gated).status).toBe('ready');
  });
});
