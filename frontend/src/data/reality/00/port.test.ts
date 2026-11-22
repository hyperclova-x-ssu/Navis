import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../db/store';
import type { DataTables, MenuItem } from '../../db/types';
import {
  createPortReads, createPortTransport, createRealPort, defineBinding, dataSourceFor, PortError,
  type DomainAdapter, type RealDomain, type RealSource,
} from './index';
import { fakeBackend, reply, TEST_STORE_ID } from './testing';

const asOf = '2026-11-21T09:00:00.000Z';
const row = (menuId: string, name: string, saleStatus: 'selling' | 'sold_out' = 'selling', price = 4_000): MenuItem => ({
  menuId, kind: 'menu', category: 'drink', name: { raw: name }, nameKey: 'data.menu.x', price, categoryKey: 'data.menuCategory.coffee', recipe: [], costEffectiveFrom: '2026-11-01', saleStatus,
});
const receipt = (over: Record<string, unknown> = {}) => ({ resourceId: 'r-1', revision: 2, receiptId: 'rc-1', undoUntil: '2999-01-01T00:00:00.000Z', affectedSources: ['menu'], changed: true, ...over });

/** A menu-like adapter: `menuItem` from GET /inventory/menu; one optimistic and one pending-until-confirmed command. */
function menuAdapter(extra: Partial<DomainAdapter> = {}): DomainAdapter {
  return {
    domain: 'menu', sources: ['menu'], tables: ['menuItem'],
    async load({ reads }) {
      const page = await reads.all<{ menuId: string; name: string; saleStatus: 'selling' | 'sold_out'; price: number; revision: number }>({ resource: 'menu', path: '/inventory/menu' });
      return {
        tables: { menuItem: page.items.map(m => row(m.menuId, m.name, m.saleStatus, m.price)) } satisfies Partial<DataTables>,
        revisions: Object.fromEntries(page.items.map(m => [`menu:${m.menuId}`, m.revision])),
        asOf: page.asOf, sourceRevision: page.sourceRevision, complete: page.complete,
      };
    },
    commands: [
      defineBinding({
        type: 'menu.setSaleStatus', optimistic: 'local', receiptBase: '/inventory',
        request: (c, ctx) => ({ method: 'PATCH', path: `/inventory/menu/${c.menuId}`, body: { saleStatus: c.status }, expectedRevision: ctx.revision(`menu:${c.menuId}`) }),
      }),
      defineBinding({ type: 'menu.delete', receiptBase: '/inventory', request: (c, ctx) => ({ method: 'DELETE', path: `/inventory/menu/${c.menuId}`, expectedRevision: ctx.revision(`menu:${c.menuId}`) }) }),
      defineBinding({
        type: 'menu.create', receiptBase: '/inventory', noticeKey: 'data.notice.undone',
        request: c => ({ method: 'POST', path: '/inventory/menu', body: { name: c.name, category: c.category, price: c.price, memo: c.memo ?? null } }),
      }),
    ],
    ...extra,
  };
}

function page(items: unknown[], over: Record<string, unknown> = {}) {
  return { items, nextCursor: null, asOf, sourceRevision: 3, ...over };
}
const menuRead = (backend: ReturnType<typeof fakeBackend>, items: unknown[]) => backend.on('GET', '/inventory/menu', () => page(items));
const a = { menuId: 'm-a', name: '서버 아메리카노', saleStatus: 'selling', price: 4_000, revision: 1 };

function setup(options: { source?: (domain: RealDomain) => RealSource; adapters?: DomainAdapter[]; delays?: number[] } = {}) {
  const backend = fakeBackend();
  const store = createWidgetDataStore();
  const adapters = options.adapters ?? [menuAdapter()];
  const port = createRealPort({ store, fetch: backend.fetch, source: options.source ?? (() => 'http'), adapters, sleep: async () => {}, reconcileDelaysMs: options.delays ?? [0, 0], uuid: (() => { let n = 0; return () => `key-${++n}`; })(), now: () => Date.parse('2026-11-21T09:00:00Z') });
  store.bindReal(port);
  return { backend, store, port };
}
const names = (store: ReturnType<typeof createWidgetDataStore>) => store.getSnapshot().tables.menuItem.map(m => m.name && 'raw' in m.name ? m.name.raw : m.nameKey);

describe('transport', () => {
  beforeEach(() => localStorage.clear());

  it('scopes the path to the session store, sends bearer + Idempotency-Key and merges expectedRevision into the JSON body', async () => {
    const backend = fakeBackend();
    backend.on('PATCH', '/inventory/menu/m-a', () => receipt());
    const transport = createPortTransport(backend.fetch);
    await transport.request({ method: 'PATCH', path: '/inventory/menu/m-a', body: { price: 4_200 }, expectedRevision: 1, idempotencyKey: 'k-1', query: { skip: undefined, a: 1 } });
    const call = backend.calls[0];
    expect(call).toMatchObject({ method: 'PATCH', path: '/inventory/menu/m-a', query: { a: '1' }, body: { price: 4_200, expectedRevision: 1 } });
    expect(call.headers.get('authorization')).toBe('Bearer token-1');
    expect(call.headers.get('idempotency-key')).toBe('k-1');
    expect(call.headers.get('content-type')).toBe('application/json');
  });

  it('starts a fresh browser session directly through demo', async () => {
    const backend = fakeBackend();
    backend.on('POST', '/api/v1/auth/refresh', () => reply(401, { code: 'UNAUTHENTICATED' }));
    await expect(createPortTransport(backend.fetch).storeId()).resolves.toBe(backend.storeId);
    expect(backend.authCalls).toEqual(['demo']);
  });

  it('refreshes a returning browser session', async () => {
    const backend = fakeBackend();
    await createPortTransport(backend.fetch).storeId();
    await expect(createPortTransport(backend.fetch).storeId()).resolves.toBe(backend.storeId);
    expect(backend.authCalls).toEqual(['demo', 'refresh']);
  });

  it('starts a new demo session when refresh rejects a returning session', async () => {
    const backend = fakeBackend();
    await createPortTransport(backend.fetch).storeId();
    backend.on('POST', '/api/v1/auth/refresh', () => reply(401, { code: 'UNAUTHENTICATED' }));
    await expect(createPortTransport(backend.fetch).storeId()).resolves.toBe(backend.storeId);
    expect(backend.authCalls).toEqual(['demo', 'refresh', 'demo']);
  });

  it('asks for sign-in with demo disabled and stops retrying a rejected refresh cookie', async () => {
    const closed = fakeBackend();
    await createPortTransport(closed.fetch).storeId();
    closed.on('POST', '/api/v1/auth/refresh', () => reply(401, { code: 'UNAUTHENTICATED' }));
    closed.on('POST', '/api/v1/auth/demo', () => reply(404, { code: 'NOT_FOUND' }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(createPortTransport(closed.fetch).storeId()).rejects.toMatchObject({ code: 'UNAUTHENTICATED', reason: 'SESSION_REQUIRED' });
    }
    expect(closed.authCalls).toEqual(['demo', 'refresh', 'demo', 'demo']);
  });

  it('shares one session start between parallel requests', async () => {
    const backend = fakeBackend();
    backend.on('POST', '/api/v1/auth/refresh', () => reply(401, { code: 'UNAUTHENTICATED' }));
    backend.on('GET', '/x', () => ({}));
    const transport = createPortTransport(backend.fetch);
    await Promise.all([transport.request({ method: 'GET', path: '/x' }), transport.request({ method: 'GET', path: '/x' }), transport.request({ method: 'GET', path: '/x' })]);
    expect(backend.authCalls).toEqual(['demo']);
  });

  it('keeps a root-scoped path as given', async () => {
    const backend = fakeBackend();
    backend.on('GET', '/api/v1/stores', () => ({ items: [] }));
    await createPortTransport(backend.fetch).request({ method: 'GET', path: '/api/v1/stores', scope: 'root' });
    expect(backend.calls[0].path).toBe('/api/v1/stores');
  });

  it('maps backend errors, and marks only unconfirmed writes as outcome-unknown', async () => {
    const backend = fakeBackend();
    backend.on('PATCH', '/x/stale', () => reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' }));
    backend.on('POST', '/x/bad', () => reply(400, { code: 'VALIDATION', reason: 'UNIT_MISMATCH', field: 'lines.0.unit' }));
    backend.on('POST', '/x/down', () => reply(503, { code: 'SERVICE_UNAVAILABLE' }));
    backend.on('GET', '/x/down', () => reply(503, { code: 'SERVICE_UNAVAILABLE' }));
    const transport = createPortTransport(backend.fetch);
    await expect(transport.request({ method: 'PATCH', path: '/x/stale' })).rejects.toMatchObject({ status: 409, code: 'CONFLICT', reason: 'STALE_REVISION', outcomeUnknown: false });
    await expect(transport.request({ method: 'POST', path: '/x/bad' })).rejects.toMatchObject({ code: 'VALIDATION', reason: 'UNIT_MISMATCH', field: 'lines.0.unit' });
    await expect(transport.request({ method: 'POST', path: '/x/down' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', outcomeUnknown: true });
    await expect(transport.request({ method: 'GET', path: '/x/down' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', outcomeUnknown: false });
  });

  it('treats a network failure as unknown for a write and plain NETWORK for a read', async () => {
    const backend = fakeBackend();
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).includes('/auth/')) return backend.fetch(input, init);
      throw new TypeError('network down');
    };
    const transport = createPortTransport(flaky);
    await expect(transport.request({ method: 'POST', path: '/x' })).rejects.toMatchObject({ code: 'NETWORK', outcomeUnknown: true });
    await expect(transport.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({ code: 'NETWORK', outcomeUnknown: false });
  });
});

describe('reads', () => {
  it('follows cursors up to the bound and never silently truncates', async () => {
    const backend = fakeBackend();
    backend.on('GET', '/list', call => call.query.cursor === 'c3' ? page([4]) : call.query.cursor === 'c2' ? page([3], { nextCursor: 'c3' }) : call.query.cursor === 'c1' ? page([2], { nextCursor: 'c2' }) : page([1], { nextCursor: 'c1' }));
    const reads = createPortReads(createPortTransport(backend.fetch));
    expect(await reads.all({ resource: 'list', path: '/list' }, { maxPages: 2 })).toMatchObject({ items: [1, 2], complete: false });
    expect(await reads.all({ resource: 'list', path: '/list' }, { maxPages: 5 })).toMatchObject({ items: [1, 2, 3, 4], complete: true });
    expect(backend.calls.every(c => Number(c.query.limit) <= 200)).toBe(true);
  });

  it('rejects a page without the {items,nextCursor,asOf,sourceRevision} envelope', async () => {
    const backend = fakeBackend();
    backend.on('GET', '/list', () => ({ items: [] }));
    await expect(createPortReads(createPortTransport(backend.fetch)).page({ resource: 'list', path: '/list' })).rejects.toMatchObject({ reason: 'BAD_RESPONSE' });
  });
});

describe('source switch', () => {
  it('is http only when the build asks for it and the domain is not forced to fixture', () => {
    expect(dataSourceFor('menu', {})).toBe('fixture');
    expect(dataSourceFor('menu', { VITE_NAVIS_DATA_SOURCE: 'http' })).toBe('http');
    expect(dataSourceFor('menu', { VITE_NAVIS_DATA_SOURCE: 'http', VITE_NAVIS_FIXTURE_DOMAINS: 'pos, menu' })).toBe('fixture');
    expect(dataSourceFor('pos', { VITE_NAVIS_DATA_SOURCE: 'http', VITE_NAVIS_FIXTURE_DOMAINS: 'menu' })).toBe('http');
  });

  it('keeps a domain on the fixture store when its mode is fixture or no adapter is registered', async () => {
    const { backend, store, port } = setup({ source: () => 'fixture' });
    expect(port.state('menu')).toMatchObject({ mode: 'fixture', status: 'fixture' });
    await port.load('menu');
    expect(backend.calls).toHaveLength(0);
    expect(port.state('pos').mode).toBe('fixture');
    const first = store.getSnapshot().tables.menuItem[0];
    const result = await store.execute({ type: 'menu.setSaleStatus', menuId: first.menuId, status: 'sold_out' });
    expect(result).toMatchObject({ ok: true });
    expect(store.getSnapshot().tables.menuItem.find(m => m.menuId === first.menuId)?.saleStatus).toBe('sold_out');
    expect(backend.calls).toHaveLength(0);
  });
});

describe('domain loads', () => {
  it('fills the store tables from HTTP, replacing the fixture rows, and walks idle → loading → ready', async () => {
    const { backend, store, port } = setup();
    menuRead(backend, [a]);
    const seen: string[] = [];
    port.subscribe(() => seen.push(port.state('menu').status));
    expect(port.state('menu').status).toBe('idle');
    const state = await port.load('menu');
    expect(names(store)).toEqual(['서버 아메리카노']);
    expect(state).toMatchObject({ mode: 'http', status: 'ready', asOf, sourceRevision: 3, complete: true, pending: 0 });
    expect(seen).toEqual(['loading', 'ready']);
  });

  it('shares one request between concurrent loads and does not re-read a loaded domain', async () => {
    const { backend, port } = setup();
    menuRead(backend, [a]);
    await Promise.all([port.load('menu'), port.load('menu')]);
    await port.load('menu');
    expect(backend.callsTo('GET', '/inventory/menu')).toHaveLength(1);
    await port.retry('menu');
    expect(backend.callsTo('GET', '/inventory/menu')).toHaveLength(2);
  });

  it('shows an error after a failed first load, keeps data as stale after a failed refresh, and recovers on retry', async () => {
    const { backend, store, port } = setup();
    let fail = true;
    backend.on('GET', '/inventory/menu', () => fail ? reply(503, { code: 'SERVICE_UNAVAILABLE' }) : page([a]));
    expect(await port.load('menu')).toMatchObject({ status: 'error', error: { code: 'SERVICE_UNAVAILABLE' } });
    fail = false;
    expect(await port.retry('menu')).toMatchObject({ status: 'ready' });
    fail = true;
    expect(await port.retry('menu')).toMatchObject({ status: 'stale', error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(names(store)).toEqual(['서버 아메리카노']);
    fail = false;
    expect((await port.retry('menu')).status).toBe('ready');
  });

  it('does not bump the store revision when a refresh returns the same rows', async () => {
    const { backend, store, port } = setup();
    menuRead(backend, [a]);
    await port.load('menu');
    const revision = store.getSnapshot().revision;
    await port.retry('menu');
    expect(store.getSnapshot().revision).toBe(revision);
  });

  it('marks a truncated list as incomplete', async () => {
    const { backend, port } = setup();
    backend.on('GET', '/inventory/menu', () => page([a], { nextCursor: 'more' }));
    expect(await port.load('menu')).toMatchObject({ status: 'ready', complete: false });
  });
});

describe('structured error details', () => {
  it('passes sanitized server details to the command result', async () => {
    const adapter = menuAdapter({ errorKeys: { DUPLICATE_MEMBER: 'data.members.error.DUPLICATE' } });
    const { backend, port } = setup({ adapters: [adapter] });
    menuRead(backend, [a]);
    backend.on('POST', '/inventory/menu', () => reply(409, { code: 'CONFLICT', reason: 'DUPLICATE_MEMBER', details: {
      memberId: 'm-1', matches: [{ memberId: 'm-1', maskedPhone: '010-****-1234' }], note: 'x'.repeat(500), __proto__: { admin: true }, nested: { a: { b: { c: { d: 1 } } } },
    } }));
    await port.load('menu');
    const result = await port.execute({ type: 'menu.create', name: 'X', category: 'drink', price: 1_000, idempotencyKey: 'k' });
    expect(result).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'DUPLICATE_MEMBER', messageKey: 'data.members.error.DUPLICATE' });
    const details = (result as { details?: Record<string, unknown> }).details!;
    expect(details.memberId).toBe('m-1');
    expect(details.matches).toEqual([{ memberId: 'm-1', maskedPhone: '010-****-1234' }]);
    expect((details.note as string).length).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(details, 'admin')).toBe(false);
    expect(JSON.stringify(details.nested)).not.toContain('"d"');
  });

  it('marks an unknown outcome on the result', async () => {
    const { backend, port } = setup({ delays: [] });
    menuRead(backend, [a]);
    backend.on('POST', '/inventory/menu', () => reply(503, { code: 'SERVICE_UNAVAILABLE', reason: 'UPSTREAM_BUSY' }));
    await port.load('menu');
    const result = await port.execute({ type: 'menu.create', name: 'X', category: 'drink', price: 1_000, idempotencyKey: 'k' });
    expect(result).toMatchObject({ ok: false, reason: 'UPSTREAM_BUSY', outcomeUnknown: true });
  });
});

describe('lost access', () => {
  it('drops the rows of every HTTP domain on 401/403 on a read instead of keeping them as stale', async () => {
    const { backend, store, port } = setup();
    let denied = false;
    backend.on('GET', '/inventory/menu', () => denied ? reply(403, { code: 'STORE_FORBIDDEN' }) : page([a]));
    await port.load('menu');
    expect(names(store)).toEqual(['서버 아메리카노']);
    denied = true;
    const state = await port.retry('menu');
    expect(state).toMatchObject({ status: 'error', error: { code: 'STORE_FORBIDDEN' } });
    expect(store.getSnapshot().tables.menuItem).toEqual([]);
  });

  it('drops the rows when a write is answered with an ended session, and refuses undo of earlier receipts', async () => {
    const { backend, store, port } = setup();
    menuRead(backend, [a]);
    backend.on('POST', '/inventory/menu', () => receipt());
    await port.load('menu');
    const done = await port.execute({ type: 'menu.create', name: 'X', category: 'drink', price: 1_000, idempotencyKey: 'k1' });
    backend.on('POST', '/inventory/menu', () => reply(401, { code: 'UNAUTHENTICATED' }));
    const result = await port.execute({ type: 'menu.create', name: 'Y', category: 'drink', price: 1_000, idempotencyKey: 'k2' });
    expect(result).toMatchObject({ ok: false, reason: 'SESSION_ENDED', messageKey: 'data.real.error.SESSION_ENDED' });
    expect(port.state('menu')).toMatchObject({ status: 'error' });
    expect(store.getSnapshot().tables.menuItem).toEqual([]);
    expect(await port.undo(done.ok && done.undoToken ? done.undoToken : '')).toMatchObject({ ok: false, reason: 'UNDO_UNAVAILABLE' });
  });

  it('keeps stale rows for a transient read failure', async () => {
    const { backend, store, port } = setup();
    let down = false;
    backend.on('GET', '/inventory/menu', () => down ? reply(503, { code: 'SERVICE_UNAVAILABLE' }) : page([a]));
    await port.load('menu');
    down = true;
    expect(await port.retry('menu')).toMatchObject({ status: 'stale' });
    expect(names(store)).toEqual(['서버 아메리카노']);
  });
});

describe('commands', () => {
  it('sends the mapped request once, re-reads the domain, and returns the receipt with an undo token', async () => {
    const { backend, store, port } = setup();
    let items: unknown[] = [a];
    backend.on('GET', '/inventory/menu', () => page(items));
    backend.on('POST', '/inventory/menu', () => { items = [a, { ...a, menuId: 'm-b', name: '새 메뉴', revision: 1 }]; return receipt({ resourceId: 'm-b', revision: 1 }); });
    await port.load('menu');
    const result = await port.execute({ type: 'menu.create', name: '새 메뉴', category: 'drink', price: 3_800, idempotencyKey: 'ui-key-1' });
    expect(result).toMatchObject({ ok: true, value: { receiptId: 'rc-1', resourceId: 'm-b' }, undoToken: 'real-undo:rc-1', noticeKey: 'data.notice.undone' });
    const sent = backend.callsTo('POST', '/inventory/menu');
    expect(sent).toHaveLength(1);
    expect(sent[0].headers.get('idempotency-key')).toBe('ui-key-1');
    expect(sent[0].body).toEqual({ name: '새 메뉴', category: 'drink', price: 3_800, memo: null });
    expect(names(store)).toEqual(['서버 아메리카노', '새 메뉴']);
  });

  it('generates one key per logical attempt when the command has none, and sends no undo token for a no-op', async () => {
    const { backend, port } = setup();
    menuRead(backend, [a]);
    backend.on('PATCH', '/inventory/menu/m-a', () => receipt({ changed: false, undoUntil: undefined }));
    await port.load('menu');
    const result = await port.execute({ type: 'menu.setSaleStatus', menuId: 'm-a', status: 'selling' });
    expect(result.ok && 'undoToken' in result).toBe(false);
    expect(backend.callsTo('PATCH', '/inventory/menu/m-a')[0].headers.get('idempotency-key')).toBe('key-1');
  });

  it('returns the same promise for a repeated press while pending, so the server sees one request', async () => {
    const { backend, port } = setup();
    menuRead(backend, [a]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    backend.on('POST', '/inventory/menu', async () => { await held; return receipt(); });
    await port.load('menu');
    const command = { type: 'menu.create' as const, name: 'X', category: 'drink' as const, price: 3_000, idempotencyKey: 'k' };
    const first = port.execute(command), second = port.execute({ ...command });
    await vi.waitFor(() => expect(port.state('menu').pending).toBe(1));
    release();
    expect(await first).toEqual(await second);
    expect(backend.callsTo('POST', '/inventory/menu')).toHaveLength(1);
    expect(port.state('menu').pending).toBe(0);
  });

  it('rejects before sending when the binding throws a validation error', async () => {
    const adapter = menuAdapter({ commands: [defineBinding({ type: 'menu.create', request: () => { throw new PortError(400, 'VALIDATION', 'NAME_REQUIRED', 'name'); } })], errorKeys: { NAME_REQUIRED: 'data.menu.error.NAME_REQUIRED' } });
    const { backend, port } = setup({ adapters: [adapter] });
    menuRead(backend, [a]);
    await port.load('menu');
    expect(await port.execute({ type: 'menu.create', name: '', category: 'drink', price: 1, idempotencyKey: 'k' })).toEqual({ ok: false, code: 'VALIDATION', reason: 'NAME_REQUIRED', field: 'name', messageKey: 'data.menu.error.NAME_REQUIRED' });
    expect(backend.callsTo('POST', '/inventory/menu')).toHaveLength(0);
  });

  it('answers a stale revision with a re-read and a CONFLICT the owner must re-confirm', async () => {
    const { backend, store, port } = setup();
    let items: unknown[] = [a];
    backend.on('GET', '/inventory/menu', () => page(items));
    backend.on('PATCH', '/inventory/menu/m-a', () => { items = [{ ...a, price: 5_000, revision: 2 }]; return reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' }); });
    await port.load('menu');
    const result = await port.execute({ type: 'menu.setSaleStatus', menuId: 'm-a', status: 'sold_out' });
    expect(result).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'STALE_REVISION', messageKey: 'data.real.error.STALE_REVISION' });
    expect(backend.callsTo('PATCH', '/inventory/menu/m-a')[0].body).toEqual({ saleStatus: 'sold_out', expectedRevision: 1 });
    expect(store.getSnapshot().tables.menuItem[0]).toMatchObject({ price: 5_000, saleStatus: 'selling' });
  });

  it('reconciles an unknown outcome by resending the same key and never creates a second record', async () => {
    const { backend, port } = setup({ delays: [0, 0] });
    menuRead(backend, [a]);
    let attempts = 0;
    backend.on('POST', '/inventory/menu', () => ++attempts < 3 ? reply(503, { code: 'SERVICE_UNAVAILABLE' }) : receipt());
    await port.load('menu');
    const result = await port.execute({ type: 'menu.create', name: 'X', category: 'drink', price: 3_000, idempotencyKey: 'once' });
    expect(result).toMatchObject({ ok: true });
    const keys = backend.callsTo('POST', '/inventory/menu').map(c => c.headers.get('idempotency-key'));
    expect(keys).toEqual(['once', 'once', 'once']);
  });

  it('keeps the key of a still-unknown outcome so a later press resumes it', async () => {
    const { backend, port } = setup({ delays: [0] });
    menuRead(backend, [a]);
    let down = true;
    backend.on('DELETE', '/inventory/menu/m-a', () => down ? reply(503, { code: 'SERVICE_UNAVAILABLE' }) : receipt());
    await port.load('menu');
    const command = { type: 'menu.delete' as const, menuId: 'm-a' };
    const first = await port.execute(command);
    expect(first).toMatchObject({ ok: false, reason: 'OUTCOME_UNKNOWN', messageKey: 'data.real.error.OUTCOME_UNKNOWN' });
    down = false;
    expect(await port.execute(command)).toMatchObject({ ok: true });
    const keys = backend.callsTo('DELETE', '/inventory/menu/m-a').map(c => c.headers.get('idempotency-key'));
    expect(keys.length).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(1);
  });

  it('re-reads every domain that lists an affected source', async () => {
    const posReads = vi.fn();
    const pos: DomainAdapter = { domain: 'pos', sources: ['pos'], tables: [], commands: [], async load() { posReads(); return { tables: {}, asOf, sourceRevision: 1, complete: true }; } };
    const { backend, port } = setup({ adapters: [menuAdapter(), pos] });
    menuRead(backend, [a]);
    backend.on('POST', '/inventory/menu', () => receipt({ affectedSources: ['menu', 'pos'] }));
    await Promise.all([port.load('menu'), port.load('pos')]);
    expect(posReads).toHaveBeenCalledTimes(1);
    await port.execute({ type: 'menu.create', name: 'X', category: 'drink', price: 3_000, idempotencyKey: 'k' });
    expect(posReads).toHaveBeenCalledTimes(2);
  });

  it('makes the sync dispatch loud for a command that must wait for its receipt', async () => {
    const { backend, store, port } = setup();
    menuRead(backend, [a]);
    await port.load('menu');
    expect(store.dispatch({ type: 'menu.create', name: 'X', category: 'drink', price: 3_000, idempotencyKey: 'k' })).toMatchObject({ ok: false, reason: 'ASYNC_REQUIRED', messageKey: 'data.real.error.ASYNC_REQUIRED' });
    expect(backend.callsTo('POST', '/inventory/menu')).toHaveLength(0);
  });
});

describe('optimistic commands', () => {
  it('previews locally with pending:true, then replaces the preview with the server rows', async () => {
    const { backend, store, port } = setup();
    let items: unknown[] = [a];
    backend.on('GET', '/inventory/menu', () => page(items));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    backend.on('PATCH', '/inventory/menu/m-a', async () => { await held; items = [{ ...a, saleStatus: 'sold_out', revision: 2 }]; return receipt(); });
    await port.load('menu');
    const result = store.dispatch({ type: 'menu.setSaleStatus', menuId: 'm-a', status: 'sold_out' });
    expect(result).toMatchObject({ ok: true, pending: true });
    expect(store.getSnapshot().tables.menuItem[0].saleStatus).toBe('sold_out');
    expect(port.state('menu').pending).toBe(1);
    release();
    await vi.waitFor(() => expect(port.state('menu').pending).toBe(0));
    expect(store.getSnapshot().tables.menuItem[0].saleStatus).toBe('sold_out');
    expect(backend.callsTo('GET', '/inventory/menu')).toHaveLength(2);
  });

  it('rolls the preview back and reports the failure when the server rejects it', async () => {
    const { backend, store, port } = setup();
    menuRead(backend, [a]);
    backend.on('PATCH', '/inventory/menu/m-a', () => reply(400, { code: 'VALIDATION', reason: 'STATUS_INVALID', field: 'saleStatus' }));
    await port.load('menu');
    const failures: unknown[] = [];
    port.onFailure(event => failures.push(event.result));
    expect(store.dispatch({ type: 'menu.setSaleStatus', menuId: 'm-a', status: 'sold_out' })).toMatchObject({ ok: true, pending: true });
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toMatchObject({ ok: false, code: 'VALIDATION', field: 'saleStatus' });
    expect(store.getSnapshot().tables.menuItem[0].saleStatus).toBe('selling');
  });

  it('does not call the server when the local guard already rejects the command', async () => {
    const { backend, store, port } = setup();
    menuRead(backend, [a]);
    await port.load('menu');
    expect(store.dispatch({ type: 'menu.setSaleStatus', menuId: 'missing', status: 'sold_out' })).toMatchObject({ ok: false });
    expect(backend.callsTo('PATCH', /.*/)).toHaveLength(0);
  });
});

describe('undo', () => {
  it('posts the receipt undo, re-reads, and refuses after undoUntil', async () => {
    const { backend, store, port } = setup();
    let items: unknown[] = [a];
    backend.on('GET', '/inventory/menu', () => page(items));
    backend.on('POST', '/inventory/menu', () => { items = [a, { ...a, menuId: 'm-b', name: '새 메뉴' }]; return receipt({ resourceId: 'm-b' }); });
    backend.on('POST', '/inventory/receipts/rc-1/undo', () => { items = [a]; return receipt({ receiptId: 'rc-undo', undoUntil: undefined }); });
    await port.load('menu');
    const done = await port.execute({ type: 'menu.create', name: '새 메뉴', category: 'drink', price: 1_000, idempotencyKey: 'k' });
    expect(done.ok && done.undoToken).toBe('real-undo:rc-1');
    expect(await port.undo('real-undo:rc-1')).toMatchObject({ ok: true, noticeKey: 'data.notice.undone' });
    expect(backend.callsTo('POST', '/inventory/receipts/rc-1/undo')[0]).toMatchObject({ body: {} });
    expect(names(store)).toEqual(['서버 아메리카노']);
    expect(await port.undo('real-undo:rc-1')).toMatchObject({ ok: false, reason: 'UNDO_UNAVAILABLE' });
  });

  it('refuses an expired undo without calling the server', async () => {
    const { backend, port } = setup();
    menuRead(backend, [a]);
    backend.on('POST', '/inventory/menu', () => receipt({ undoUntil: '2026-11-21T08:59:00.000Z' }));
    await port.load('menu');
    const done = await port.execute({ type: 'menu.create', name: 'X', category: 'drink', price: 1_000, idempotencyKey: 'k' });
    expect(await port.undo(done.ok && done.undoToken ? done.undoToken : '')).toMatchObject({ ok: false, reason: 'UNDO_EXPIRED', messageKey: 'data.real.error.UNDO_EXPIRED' });
    expect(backend.callsTo('POST', /undo/)).toHaveLength(0);
  });
});

describe('reset', () => {
  it('removes array and object tables of HTTP domains on reset while preserving fixture domains', async () => {
    const adapter = menuAdapter({ tables: ['menuItem', 'realMembers'], async load() {
      return { tables: { menuItem: [row('old-menu', '이전 매장 메뉴')], realMembers: {
        profiles: {}, products: [], passes: [], uses: [], accounts: {}, entries: [], businessDates: {}, businessDate: '2026-11-21',
      } }, asOf, sourceRevision: 8, complete: true };
    } });
    const { store, port } = setup({ source: domain => domain === 'menu' ? 'http' : 'fixture', adapters: [adapter] });
    const staff = store.getSnapshot().tables.staff;
    await port.load('menu');
    expect(store.getSnapshot().tables.realMembers).toBeDefined();
    port.reset();
    expect(store.getSnapshot().tables.realMembers).toBeUndefined();
    expect(store.getSnapshot().tables.menuItem).toEqual([]);
    expect(store.getSnapshot().tables.staff).toEqual(staff);
  });

  it('discards an old-store load after reset without overwriting a new-store load', async () => {
    const { backend, store, port } = setup();
    let finish!: (data: ReturnType<typeof page>) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    backend.on('GET', '/inventory/menu', () => new Promise(resolve => { finish = resolve; started(); }));
    const old = port.load('menu');
    await requestStarted;
    port.reset();
    menuRead(backend, [{ ...a, menuId: 'new', name: '새 매장 메뉴' }]);
    await port.load('menu');
    finish(page([a]));
    await old;
    expect(names(store)).toEqual(['새 매장 메뉴']);
  });

  it('forgets loaded state so the next read starts a new session', async () => {
    const { backend, port } = setup();
    menuRead(backend, [a]);
    await port.load('menu');
    port.reset();
    expect(port.state('menu')).toMatchObject({ status: 'idle', pending: 0 });
    await port.load('menu');
    expect(backend.calls.filter(c => c.path === '/inventory/menu')).toHaveLength(2);
    expect(TEST_STORE_ID).toBeTruthy();
  });
});
