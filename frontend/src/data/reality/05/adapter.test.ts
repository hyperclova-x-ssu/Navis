import { expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../db/store';
import { selectMembers } from '../../derive/members';
import { createRealPort } from '../00';
import { autoloadedAdapters } from '../00/autoload';
import { fakeBackend, reply } from '../00/testing';
import { createAgentActions } from '../../../features/assistant/agent-actions';

it('registers once through HTTP and reads the masked member from a new store', async () => {
  const backend = fakeBackend();
  const page = (items: readonly unknown[]) => ({ items, nextCursor: null, asOf: '2026-11-21T06:00:00Z', sourceRevision: items.length });
  const members: unknown[] = [];
  backend.on('GET', '/customers', () => page(members));
  backend.on('GET', '/membership-products', () => page([]));
  backend.on('GET', '/memberships', () => page([]));
  backend.on('GET', '/pos/member-accounts', () => page([]));
  backend.on('POST', '/customers', () => {
    members.push({ memberId: 'member', customerId: 'customer', name: '테스트손님', phoneMasked: '010-****-0101',
      grade: 'occasional', gradeOverride: null, consent: { contactAllowed: true, marketingAllowed: false }, notes: [],
      joinedOn: '2026-11-21', visitCount: 0, lastVisitAt: null, revision: 1 });
    return { resourceId: 'member', receiptId: 'receipt', revision: 1, affectedSources: ['members'] };
  });
  const session = async () => {
    const store = createWidgetDataStore();
    const port = createRealPort({ store, source: domain => domain === 'members' ? 'http' : 'fixture', adapters: autoloadedAdapters(), fetch: backend.fetch });
    store.bindReal(port);
    expect((await port.load('members')).status).toBe('ready');
    return store;
  };
  const store = await session();
  expect(selectMembers(store.getSnapshot(), {}).rows).toEqual([]);
  const command = { type: 'members.create', name: '테스트손님', phone: '01000000101', idempotencyKey: 'one-member' } as const;
  const outcomes = await Promise.all([store.execute(command), store.execute(command)]);
  expect(outcomes[0]).toMatchObject({ ok: true, value: { resourceId: 'member' } });
  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(backend.callsTo('POST', '/customers')).toHaveLength(1);
  expect(backend.callsTo('POST', '/customers')[0].body).toEqual({ name: command.name, phone: command.phone });
  const reloaded = await session();
  expect(selectMembers(reloaded.getSnapshot(), {}).rows).toMatchObject([
    { memberId: 'member', name: '테○○○님', phone: '010-****-0101', consentSms: false },
  ]);
  expect(JSON.stringify(reloaded.getSnapshot().tables)).not.toContain(command.phone);
  backend.on('GET', '/customers', () => reply(403, { code: 'STORE_FORBIDDEN' }));
  await reloaded.real!.retry('members');
  const cleared = reloaded.getSnapshot().tables;
  expect(cleared.realMembers).toBeUndefined();
  expect(cleared.marketing.mktCustomer).toEqual([]);
  expect(cleared.marketing.mktVisit).toEqual([]);
});

it('runs the same member HTTP command only when the Navis card is confirmed', async () => {
  const backend = fakeBackend();
  const page = { items: [], nextCursor: null, asOf: '2026-11-21T06:00:00Z', sourceRevision: 0 };
  for (const path of ['/customers', '/membership-products', '/memberships', '/pos/member-accounts']) backend.on('GET', path, () => page);
  const undoUntil = '2999-01-01T00:00:00Z';
  backend.on('POST', '/customers', () => ({ resourceId: 'member', memberId: 'member', receiptId: 'member-receipt', revision: 1, undoUntil, affectedSources: ['members'] }));
  backend.on('POST', '/members/receipts/member-receipt/undo', () => ({ resourceId: 'member', receiptId: 'undo-receipt', revision: 2, affectedSources: ['members'] }));
  const store = createWidgetDataStore(undefined, { runId: 'member-http' });
  const port = createRealPort({ store, source: () => 'http', adapters: autoloadedAdapters().filter(adapter => adapter.domain === 'members'), fetch: backend.fetch });
  store.bindReal(port);
  await port.load('members');
  const snapshot = store.getSnapshot();
  const command = { command: 'members.create', args: { name: { slot: 'name' }, phone: { slot: 'phone' } }, snapshotRevision: snapshot.revision,
    proposalId: 'wire-member', runId: 'member-http', layer: 'management', tier: 'normal' } as const;
  const prepared = createAgentActions(store).prepare(command, { name: '시험회원', phone: '01000000405' }, snapshot);
  if (prepared.kind !== 'proposal') throw Error(`Navis member card did not resolve (${prepared.kind})`);
  const card = prepared.proposal;
  expect(backend.callsTo('POST', '/customers')).toHaveLength(0);
  expect(card.confirm(store)).toMatchObject({ pending: true });
  card.confirm(store);
  expect(await card.settled()).toMatchObject({ frame: { outcome: 'applied' }, undoToken: 'real-undo:member-receipt' });
  expect(backend.callsTo('POST', '/customers')).toHaveLength(1);
  expect(await port.undo('real-undo:member-receipt')).toMatchObject({ ok: true });
  expect(backend.callsTo('POST', '/members/receipts/member-receipt/undo')).toHaveLength(1);
});

it('clears member scope on account switch and when a direct receipt read loses access', async () => {
  const backend = fakeBackend();
  const page = { items: [], nextCursor: null, asOf: '2026-11-21T06:00:00Z', sourceRevision: 0 };
  for (const suffix of ['customers', 'membership-products', 'memberships', 'pos/member-accounts']) {
    backend.on('GET', new RegExp(`/${suffix}$`), () => page);
  }
  backend.on('POST', '/api/v1/auth/store', () => ({ accessToken: 'token-next', expiresIn: 600, storeId: 'another-store' }));
  backend.on('GET', /\/pos\/member-funding\/denied$/u, () => reply(403, { code: 'STORE_FORBIDDEN' }));
  vi.stubEnv('VITE_NAVIS_DATA_SOURCE', 'http');
  vi.stubGlobal('fetch', backend.fetch);
  try {
    const { createAppRealPort, appTransport } = await import('../00/app-port');
    const { createAccountClient } = await import('../00/account/client');
    const store = createWidgetDataStore();
    const port = createAppRealPort(store)!;
    await port.load('members');
    expect(store.getSnapshot().tables.realMembers).toBeDefined();
    await createAccountClient(appTransport()).switchStore('another-store', 'switch');
    expect(store.getSnapshot().tables.realMembers).toBeUndefined();
    expect(port.state('members').status).toBe('idle');
    await port.load('members');
    expect(store.getSnapshot().tables.realMembers).toBeDefined();
    await expect(port.reads.one({ resource: 'funding', path: '/pos/member-funding/denied' })).rejects.toMatchObject({ status: 403 });
    expect(store.getSnapshot().tables.realMembers).toBeUndefined();
    expect(port.state('members').status).toBe('error');
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
