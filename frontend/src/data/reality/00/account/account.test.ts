import { describe, expect, it, vi } from 'vitest';
import type { DashboardLayerId, DashboardPage, LayoutAdapter, LayoutWorkerRequest, LayoutWorkerResponse, Locale, Theme } from '../../../../contracts';
import { getCatalog, getRegistry } from '../../../../catalog';
import { preview, screenPresets } from '../../../../layout';
import { testTime } from '../../../../layout/test-policy';
import { createRunStore } from '../../../../state';
import { completeEmptyOnboarding } from '../../../../state/test-fixtures';
import { createPortTransport } from '../transport';
import { fakeBackend, reply } from '../testing';
import { createAccountClient } from './client';
import { createAccountSync } from './sync';

const preset = screenPresets.A;
const solve = (request: LayoutWorkerRequest): LayoutWorkerResponse => ({ ...request, result: preview(request.beforePanels, request.intent, screenPresets[request.presetId].grid, getCatalog(request.presetId)) });
const syncAdapter = (): LayoutAdapter => ({ ready: async () => {}, submit: (request, receive) => receive(solve(request)), cancel() {}, dispose() {} });
function newRun() {
  let now = 0;
  return createRunStore({ screenPreset: preset, catalog: getRegistry('A'), time: testTime, clock: () => now++, theme: 'light', layoutAdapter: syncAdapter() });
}

interface Stored {
  profile: Record<string, unknown> & { revision: number }; preferences: Record<string, unknown> & { revision: number };
  boards: Partial<Record<DashboardLayerId, { boardId: DashboardLayerId; revision: number; currentPage: number; pages: DashboardPage[] }>>;
}
/** An in-memory account service speaking PORT.md §10, with the revision checks of the real one. */
function accountBackend() {
  const backend = fakeBackend();
  const db: Stored = {
    profile: { storeId: backend.storeId, name: '모아 카페', businessType: null, paymentStyle: null, tableLayout: null, onboardingDone: false, revision: 0 },
    preferences: { theme: 'light', textScale: 100, locale: 'ko', revision: 0 },
    boards: {},
  };
  const stale = (current: number, call: { body: unknown }) => (call.body as { expectedRevision?: number }).expectedRevision !== current ? reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' }) : null;
  const receipt = (resourceId: string, revision: number) => ({ resourceId, revision, receiptId: `rc-${resourceId}-${revision}`, affectedSources: ['account'], changed: true });
  backend.on('GET', '/profile', () => db.profile);
  backend.on('GET', '/preferences', () => db.preferences);
  backend.on('GET', '/boards', () => ({ items: Object.values(db.boards), nextCursor: null, asOf: '2026-11-21T09:00:00.000Z', sourceRevision: 1 }));
  backend.on('GET', '/api/v1/stores', () => ({ items: [{ storeId: backend.storeId, name: '모아 카페', role: 'owner', current: true }], nextCursor: null, asOf: '2026-11-21T09:00:00.000Z', sourceRevision: 1 }));
  backend.on('PATCH', '/profile', call => {
    const conflict = stale(db.profile.revision, call); if (conflict) return conflict;
    const { expectedRevision, ...patch } = call.body as Record<string, unknown>; void expectedRevision;
    db.profile = { ...db.profile, ...patch, revision: db.profile.revision + 1 };
    return receipt('profile', db.profile.revision);
  });
  backend.on('PATCH', '/preferences', call => {
    const conflict = stale(db.preferences.revision, call); if (conflict) return conflict;
    const { expectedRevision, ...patch } = call.body as Record<string, unknown>; void expectedRevision;
    db.preferences = { ...db.preferences, ...patch, revision: db.preferences.revision + 1 };
    return receipt('preferences', db.preferences.revision);
  });
  backend.on('PUT', /^\/boards\/(management|marketing)$/, call => {
    const boardId = call.path.split('/')[2] as DashboardLayerId;
    const conflict = stale(db.boards[boardId]?.revision ?? 0, call); if (conflict) return conflict;
    const body = call.body as { pages: DashboardPage[]; currentPage: number };
    db.boards[boardId] = { boardId, revision: (db.boards[boardId]?.revision ?? 0) + 1, currentPage: body.currentPage, pages: body.pages };
    return receipt(boardId, db.boards[boardId]!.revision);
  });
  return { backend, db };
}

function harness(account = accountBackend(), options: { retryDelaysMs?: number[] } = {}) {
  const run = newRun();
  const timers = new Map<number, () => void>();
  let id = 0;
  const conflicts = vi.fn(), ended = vi.fn();
  const sync = createAccountSync({
    client: createAccountClient(createPortTransport(account.backend.fetch)), run, uuid: (() => { let n = 0; return () => `key-${++n}`; })(),
    schedule: callback => { timers.set(++id, callback); return id; }, cancel: handle => { timers.delete(handle as number); },
    onConflict: conflicts, onSessionEnded: ended, retryDelaysMs: options.retryDelaysMs ?? [10],
  });
  /** Fire the pending timer(s) and let the save settle. */
  const settle = async () => { for (const [key, callback] of [...timers]) { timers.delete(key); await callback(); } };
  return { ...account, run, sync, settle, conflicts, ended, timers };
}
const finishOnboarding = (run: ReturnType<typeof newRun>) => { completeEmptyOnboarding(run, 'cafe'); run.actions.visualSettled(); };
const writes = (backend: ReturnType<typeof fakeBackend>) => backend.calls.filter(c => c.method !== 'GET');

describe('account sync', () => {
  it('leaves a new store in onboarding and writes nothing until onboarding is done', async () => {
    const h = harness();
    await h.sync.load();
    h.sync.attach();
    expect(h.run.getState()).toMatchObject({ screen: 'business-question', onboarding: { step: 'business' } });
    h.run.actions.chooseBusiness('cafe');
    await h.settle();
    expect(writes(h.backend)).toHaveLength(0);
  });

  it('saves the profile, then each changed board against the confirmed revision, and a later session restores them', async () => {
    const h = harness();
    await h.sync.load();
    h.sync.attach();
    finishOnboarding(h.run);
    expect(h.run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' }).status).toBe('accepted');
    expect(h.timers.size).toBeGreaterThan(0);
    await h.settle();
    const sent = writes(h.backend);
    expect(sent.map(c => `${c.method} ${c.path}`)).toEqual(['PATCH /profile', 'PUT /boards/management']);
    expect(sent[0].body).toMatchObject({ businessType: 'cafe', paymentStyle: 'prepaid', onboardingDone: true, expectedRevision: 0 });
    expect(sent[1].body).toMatchObject({ currentPage: 0, expectedRevision: 0 });
    expect(h.db.boards.management?.pages[0].panels.map(p => p.featureId)).toEqual(['ledger']);
    expect(h.sync.getState().status).toBe('idle');

    // New session: a fresh run reads the same account.
    const next = newRun();
    const again = createAccountSync({ client: createAccountClient(createPortTransport(h.backend.fetch)), run: next, schedule: () => 0, cancel() {} });
    const writesBefore = writes(h.backend).length;
    await again.load();
    again.attach();
    expect(next.getState()).toMatchObject({ screen: 'dashboard', onboarding: { step: 'done' }, businessType: 'cafe', shopSettings: { paymentStyle: 'prepaid', revision: 1 } });
    expect(next.getState().boards.management.pages[0].panels.map(p => p.featureId)).toEqual(['ledger']);
    expect(next.getState().guidance).toMatchObject({ dashboardReady: true, queue: [], active: null });
    await again.flush();
    expect(writes(h.backend)).toHaveLength(writesBefore);
  });

  it('coalesces preference changes into one write', async () => {
    const h = harness();
    await h.sync.load();
    h.sync.attach();
    finishOnboarding(h.run);
    await h.settle();
    const before = writes(h.backend).length;
    h.run.actions.setTheme('dark' satisfies Theme);
    h.run.actions.setLocale('en' satisfies Locale);
    h.run.actions.setTextScale(125);
    await h.settle();
    const sent = writes(h.backend).slice(before);
    expect(sent.map(c => `${c.method} ${c.path}`)).toEqual(['PATCH /preferences']);
    expect(sent[0].body).toMatchObject({ theme: 'dark', locale: 'en', textScale: 125, expectedRevision: 0 });
    expect(h.db.preferences).toMatchObject({ theme: 'dark', locale: 'en', textScale: 125, revision: 1 });
  });

  it('restores the stored state and tells the owner when another tab changed the board', async () => {
    const h = harness();
    await h.sync.load();
    h.sync.attach();
    finishOnboarding(h.run);
    await h.settle();
    // Another tab places "calendar" first.
    h.db.boards.management = { boardId: 'management', revision: 5, currentPage: 0, pages: [{ pageId: 'management-1', panels: [{ featureId: 'calendar', column: 0, row: 0, width: 2, height: 2 }] }] };
    expect(h.run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' }).status).toBe('accepted');
    await h.settle();
    expect(h.conflicts).toHaveBeenCalledTimes(1);
    expect(h.run.getState().boards.management.pages[0].panels.map(p => p.featureId)).toEqual(['calendar']);
    expect(h.run.getState().boards.management.revision).toBe(5);
    expect(h.sync.getState().status).toBe('idle');
  });

  it('keeps the change when the connection drops and retries with the same Idempotency-Key', async () => {
    const h = harness();
    await h.sync.load();
    h.sync.attach();
    finishOnboarding(h.run);
    await h.settle();
    let down = true;
    h.backend.on('PUT', '/boards/management', call => {
      if (down) return reply(503, { code: 'SERVICE_UNAVAILABLE' });
      h.db.boards.management = { boardId: 'management', revision: 1, currentPage: 0, pages: (call.body as { pages: DashboardPage[] }).pages };
      return { resourceId: 'management', revision: 1, receiptId: 'rc', affectedSources: ['account'], changed: true };
    });
    h.run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' });
    await h.settle();
    expect(h.sync.getState()).toMatchObject({ status: 'error', error: { code: 'SERVICE_UNAVAILABLE' } });
    down = false;
    await h.settle();
    expect(h.sync.getState().status).toBe('idle');
    const keys = writes(h.backend).filter(c => c.path === '/boards/management').map(c => c.headers.get('idempotency-key'));
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1);
    expect(h.db.boards.management?.pages[0].panels.map(p => p.featureId)).toEqual(['ledger']);
  });

  it('preserves the settings view when a stale preference save reloads account state', async () => {
    const h = harness();
    await h.sync.load();
    finishOnboarding(h.run);
    await h.sync.flush();
    expect(h.run.actions.openSettings()).toBe(true);
    const { transitionToken } = h.run.getState();
    h.db.preferences = { ...h.db.preferences, locale: 'en', revision: 1 };
    h.run.actions.setTheme('dark');
    expect(await h.sync.flush()).toBe('conflict');
    expect(h.run.getState()).toMatchObject({ transitionToken, overlay: { type: 'settings' }, theme: 'light', locale: 'en' });
  });

  it('retries a lost write with its original body before saving a newer change', async () => {
    const h = harness();
    await h.sync.load();
    finishOnboarding(h.run);
    await h.sync.flush();
    h.sync.attach();
    let fail = true;
    h.backend.on('PATCH', '/preferences', call => {
      const body = call.body as { theme: Theme; textScale: 100 | 125; expectedRevision: number };
      if (fail) return reply(503, { code: 'SERVICE_UNAVAILABLE' });
      h.db.preferences = { ...h.db.preferences, theme: body.theme, textScale: body.textScale, revision: body.expectedRevision + 1 };
      return { resourceId: 'preferences', revision: h.db.preferences.revision, receiptId: 'rc', affectedSources: ['account'], changed: true };
    });
    h.run.actions.setTheme('dark');
    await h.settle();
    expect(h.sync.getState().status).toBe('error');
    expect(h.timers.size).toBe(1);
    h.run.actions.setTextScale(125);
    fail = false;
    await h.settle();
    expect(h.sync.getState().status).toBe('idle');
    const calls = h.backend.callsTo('PATCH', '/preferences');
    expect(calls).toHaveLength(3);
    expect(calls[1].body).toEqual(calls[0].body);
    expect(calls[1].headers.get('idempotency-key')).toBe(calls[0].headers.get('idempotency-key'));
    expect(calls[2].body).toMatchObject({ textScale: 125, expectedRevision: 1 });
    expect(calls[2].headers.get('idempotency-key')).not.toBe(calls[0].headers.get('idempotency-key'));
  });

  it('cancels the debounce and restores account state after a rejected explicit flush', async () => {
    const h = harness();
    await h.sync.load();
    finishOnboarding(h.run);
    await h.sync.flush();
    h.sync.attach();
    h.backend.on('PATCH', '/preferences', () => reply(503, { code: 'SERVICE_UNAVAILABLE' }));
    h.run.actions.setTheme('dark');
    expect(h.timers.size).toBe(1);
    expect(await h.sync.flush()).toBe('error');
    expect(h.timers.size).toBe(0);
    expect(h.run.getState().theme).toBe('light');
    expect(h.backend.callsTo('PATCH', '/preferences')).toHaveLength(1);
  });

  it('keeps page navigation and display-session changes out of board and preference writes', async () => {
    const h = harness();
    await h.sync.load();
    h.sync.attach();
    finishOnboarding(h.run);
    expect(h.run.actions.addPage().ok).toBe(true);
    await h.settle();
    const before = writes(h.backend).length;
    expect(h.run.actions.goToPage(0)).toBe(true);
    h.run.actions.setDetailDialogFullscreen(true);
    await h.settle();
    expect(writes(h.backend)).toHaveLength(before);
  });

  it('drains edits made while a save is in flight before flush resolves', async () => {
    const h = harness();
    await h.sync.load();
    finishOnboarding(h.run);
    await h.sync.flush();
    let unblock!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { unblock = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    h.backend.on('PATCH', '/preferences', async call => {
      const body = call.body as { theme: Theme; textScale: 100 | 125; expectedRevision: number };
      if (body.expectedRevision === 0) { started(); await pending; }
      h.db.preferences = { ...h.db.preferences, theme: body.theme, textScale: body.textScale, revision: body.expectedRevision + 1 };
      return { resourceId: 'preferences', revision: h.db.preferences.revision, receiptId: 'rc', affectedSources: ['account'], changed: true };
    });
    h.run.actions.setTheme('dark');
    const flush = h.sync.flush();
    await entered;
    h.run.actions.setTextScale(125);
    unblock();
    await flush;
    expect(h.db.preferences).toMatchObject({ theme: 'dark', textScale: 125, revision: 2 });
  }, 1000);

  it('stops retrying and reports it when the session ended', async () => {
    const h = harness();
    await h.sync.load();
    h.sync.attach();
    finishOnboarding(h.run);
    await h.settle();
    h.backend.on('PATCH', '/preferences', () => reply(401, { code: 'UNAUTHENTICATED' }));
    h.run.actions.setTheme('dark');
    await h.settle();
    expect(h.ended).toHaveBeenCalledTimes(1);
    expect(h.sync.getState()).toMatchObject({ status: 'error', error: { code: 'UNAUTHENTICATED' } });
    expect(h.timers.size).toBe(0);
  });

  it('refuses a stored layout that is not valid for this screen instead of showing a broken board', async () => {
    const h = harness();
    h.db.profile = { ...h.db.profile, onboardingDone: true, businessType: 'cafe', paymentStyle: 'prepaid' };
    h.db.boards.management = { boardId: 'management', revision: 2, currentPage: 0, pages: [{ pageId: 'management-1', panels: [{ featureId: 'ledger', column: 40, row: 40, width: 2, height: 2 }] }] };
    await expect(h.sync.load()).rejects.toMatchObject({ reason: 'BAD_RESPONSE' });
    expect(h.run.getState().onboarding.step).toBe('business');
  });
});

describe('account client', () => {
  it('lists stores and adopts the new session on a store switch', async () => {
    const { backend } = accountBackend();
    backend.on('POST', '/api/v1/auth/store', () => ({ accessToken: 'store-2-token', expiresIn: 600, storeId: backend.storeId }));
    backend.on('GET', '/api/v1/stores', () => ({ items: [{ storeId: 'a', name: 'A', role: 'owner', current: true }, { storeId: 'b', name: 'B', role: 'owner', current: false }], nextCursor: null, asOf: 'x', sourceRevision: 1 }));
    backend.on('GET', '/profile', () => ({ storeId: 'b', name: 'B', businessType: null, paymentStyle: null, tableLayout: null, onboardingDone: false, revision: 0 }));
    const transport = createPortTransport(backend.fetch);
    const client = createAccountClient(transport);
    expect((await client.stores()).map(s => s.storeId)).toEqual(['a', 'b']);
    await client.switchStore('b', 'k-1');
    expect(backend.calls.at(-1)?.headers.get('idempotency-key')).toBe('k-1');
    await transport.request({ method: 'GET', path: '/profile' });
    expect(backend.calls.at(-1)?.headers.get('authorization')).toBe('Bearer store-2-token');
  });

  it('signs in and out through the session', async () => {
    const { backend } = accountBackend();
    backend.on('POST', '/api/v1/auth/login', call => (call.body as { password: string }).password === 'pw' ? { accessToken: 'login-token', expiresIn: 600, storeId: backend.storeId } : reply(401, { code: 'UNAUTHENTICATED', reason: 'BAD_CREDENTIALS' }));
    backend.on('POST', '/api/v1/auth/logout', () => reply(204, null));
    const transport = createPortTransport(backend.fetch);
    const client = createAccountClient(transport);
    await expect(client.login('owner', 'nope')).rejects.toMatchObject({ code: 'UNAUTHENTICATED', reason: 'BAD_CREDENTIALS' });
    await client.login('owner', 'pw');
    await transport.request({ method: 'GET', path: '/profile' });
    expect(backend.calls.at(-1)?.headers.get('authorization')).toBe('Bearer login-token');
    backend.authCalls.length = 0;
    await expect(createPortTransport(backend.fetch).storeId()).resolves.toBe(backend.storeId);
    expect(backend.authCalls).toEqual(['refresh']);
    await client.logout();
    expect(transport.session.current).toBeUndefined();
    backend.authCalls.length = 0;
    backend.on('POST', '/api/v1/auth/demo', () => reply(404, { code: 'NOT_FOUND' }));
    await expect(createPortTransport(backend.fetch).storeId()).rejects.toMatchObject({ reason: 'SESSION_REQUIRED' });
    expect(backend.authCalls).toEqual(['demo']);
  });
});
