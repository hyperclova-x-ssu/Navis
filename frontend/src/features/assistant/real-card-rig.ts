/**
 * Test support (R1-F17): a tiny menu domain over an in-memory "server" behind the F00 port, so card tests can run a real-bound press.
 * The fixture menu rows are the server's first state. Not imported by app code.
 */
import { createRealPort, defineBinding, PortError, type DomainAdapter } from '../../data/reality/00';
import { fakeBackend, reply } from '../../data/reality/00/testing';
import type { MenuItem } from '../../data/db/types';
import { createWidgetDataStore } from '../../data/widget-data';
import { createAgentActions } from './agent-actions';

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export const asOf = '2026-11-21T09:00:00.000Z';
export const name = '동백 라테';
export const draft = { name, category: 'drink', price: 5500 } as const;
export const frame = { command: 'menu.create', args: { name: { slot: 'name' }, category: 'drink', price: { slot: 'price' } }, snapshotRevision: 0 } as const;
export const undoUntil = '2999-01-01T00:00:00.000Z';

/** A tiny menu domain over an in-memory "server": the fixture rows are the server's first state. */
export function rig(options: { runId?: string; failCreate?: () => ReturnType<typeof reply> | undefined } = {}) {
  const runId = options.runId ?? 'real-card';
  const store = createWidgetDataStore(undefined, { runId });
  const server: MenuItem[] = structuredClone([...store.getSnapshot().tables.menuItem]) as MenuItem[];
  const revisions = new Map(server.map(row => [row.menuId, 1]));
  let sourceRevision = 0, undone = 0;
  const stored = new Map<string, object>();
  /** Flip `failLoad` to make the next reads of this domain fail like an unreachable server. */
  const control: { failLoad: boolean; hold?: Promise<void> } = { failLoad: false };
  const backend = fakeBackend();
  const adapter: DomainAdapter = {
    domain: 'menu', sources: ['menu'], tables: ['menuItem'],
    errorKeys: { PRICE_INVALID: 'data.management.error.PRICE_INVALID' },
    async load() {
      if (control.hold) await control.hold;
      if (control.failLoad) throw new PortError(503, 'SERVICE_UNAVAILABLE');
      return { tables: { menuItem: server.map(row => ({ ...row })) }, asOf, sourceRevision: ++sourceRevision, complete: true,
        revisions: Object.fromEntries(server.map(row => [`menu:${row.menuId}`, revisions.get(row.menuId) ?? 1])) };
    },
    commands: [
      defineBinding({ type: 'menu.create', receiptBase: '/inventory', noticeKey: 'data.management.notice.saved',
        request: c => ({ method: 'POST', path: '/inventory/menu', body: { name: c.name, category: c.category, price: c.price } }) }),
      defineBinding({ type: 'menu.setSaleStatus', receiptBase: '/inventory', noticeKey: 'data.management.notice.saved',
        request: (c, ctx) => ({ method: 'PATCH', path: `/inventory/menu/${c.menuId}`, body: { saleStatus: c.status }, expectedRevision: ctx.revision(`menu:${c.menuId}`) }) }),
    ],
  };
  const receipt = (id: string, resourceId: string, revision: number) => ({ resourceId, revision, receiptId: id, undoUntil, affectedSources: ['menu'], changed: true });
  const row = (menuId: string, label: string, price: number): MenuItem => ({
    menuId, kind: 'menu', category: 'drink', name: { raw: label }, nameKey: 'data.menu.x', price, categoryKey: 'data.menuCategory.coffee',
    recipe: [], costEffectiveFrom: '2026-11-01', saleStatus: 'selling',
  });
  backend.on('POST', '/inventory/menu', call => {
    const fail = options.failCreate?.();
    if (fail) return fail;
    const key = call.headers.get('idempotency-key') ?? '';
    const prior = stored.get(key);
    if (prior) return prior;
    const body = call.body as { name: string; price: number };
    server.push(row('m-new', body.name, body.price));
    revisions.set('m-new', 1);
    const made = receipt('rc-1', 'm-new', 1);
    stored.set(key, made);
    return made;
  });
  backend.on('PATCH', /^\/inventory\/menu\/.+$/, call => {
    const id = call.path.split('/').at(-1)!;
    const body = call.body as { saleStatus: 'selling' | 'sold_out'; expectedRevision: number };
    if (body.expectedRevision !== revisions.get(id)) return reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' });
    const target = server.find(item => item.menuId === id)!;
    (target as Mutable<MenuItem>).saleStatus = body.saleStatus;
    revisions.set(id, body.expectedRevision + 1);
    return receipt(`rc-status-${body.expectedRevision}`, id, body.expectedRevision + 1);
  });
  backend.on('POST', /^\/inventory\/receipts\/.+\/undo$/, () => {
    undone += 1;
    const at = server.findIndex(item => item.menuId === 'm-new');
    if (at >= 0) server.splice(at, 1);
    return receipt('rc-undo', 'm-new', 2);
  });
  const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [adapter], sleep: async () => {}, reconcileDelaysMs: [0, 0],
    uuid: (() => { let n = 0; return () => `key-${++n}`; })(), now: () => Date.parse('2026-11-21T09:00:00Z') });
  store.bindReal(port);
  const actions = createAgentActions(store);
  const names = () => store.getSnapshot().tables.menuItem.map(item => item.name && 'raw' in item.name ? item.name.raw : item.nameKey);
  const create = () => actions.propose(frame, draft, store.getSnapshot())!;
  const statusCard = (status: 'sold_out' | 'selling' = 'sold_out') => {
    const snapshot = store.getSnapshot();
    const prepared = actions.prepare({ command: 'menu.setSaleStatus', args: { menuId: { handle: 'selected' }, status }, snapshotRevision: snapshot.revision,
      proposalId: 'wire-1', runId, layer: 'management', tier: 'normal' }, {}, snapshot, () => true, new Map([['selected', { kind: 'menu' as const, id: 'm-americano' }]]));
    if (prepared.kind !== 'proposal') throw new Error(prepared.kind);
    return prepared.proposal;
  };
  return { store, port, backend, server, revisions, actions, names, create, statusCard, undoCalls: () => undone, runId, control, row };
}

