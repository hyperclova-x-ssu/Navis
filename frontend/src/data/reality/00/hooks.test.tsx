import '../../../ui/test-setup';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../db/store';
import { createTranslator } from '../../../i18n';
import { dataBundles } from '../../messages';
import { useDataExecute, useDomainState, useWidgetView, WidgetDataProvider } from '../../react';
import { createRealPort, defineBinding, type DomainAdapter, type RealDomain } from './index';
import { fakeBackend, reply } from './testing';

const asOf = '2026-11-21T09:00:00.000Z';
const menuRow = (menuId: string, name: string) => ({ menuId, kind: 'menu' as const, category: 'drink' as const, name: { raw: name }, nameKey: 'data.menu.x', price: 4_000, categoryKey: 'data.menuCategory.coffee', recipe: [], costEffectiveFrom: '2026-11-01', saleStatus: 'selling' as const });
const adapter = (): DomainAdapter => ({
  domain: 'menu', tables: ['menuItem'],
  async load({ reads }) {
    const page = await reads.all<{ menuId: string; name: string }>({ resource: 'menu', path: '/inventory/menu' });
    return { tables: { menuItem: page.items.map(m => menuRow(m.menuId, m.name)) }, asOf: page.asOf, sourceRevision: page.sourceRevision, complete: page.complete };
  },
  commands: [defineBinding({ type: 'menu.delete', receiptBase: '/inventory', request: c => ({ method: 'DELETE', path: `/inventory/menu/${c.menuId}` }) })],
});

function harness(source: 'http' | 'fixture', backend = fakeBackend()) {
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, source: () => source, adapters: [adapter()], sleep: async () => {}, reconcileDelaysMs: [] });
  store.bindReal(port);
  const wrapper = ({ children }: { children: ReactNode }) => <WidgetDataProvider store={store}>{children}</WidgetDataProvider>;
  return { backend, store, port, wrapper };
}

const simpleAdapter = (domain: RealDomain, path: string): DomainAdapter => ({
  domain, tables: [], commands: [],
  async load({ reads }) { const page = await reads.page({ resource: domain, path }); return { tables: {}, asOf: page.asOf, sourceRevision: page.sourceRevision, complete: true }; },
});
const emptyPage = { items: [], nextCursor: null, asOf, sourceRevision: 1 };

describe('widget dependencies', () => {
  function dependent(adapters: DomainAdapter[], backend = fakeBackend()) {
    const store = createWidgetDataStore();
    const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters, sleep: async () => {}, reconcileDelaysMs: [] });
    store.bindReal(port);
    const wrapper = ({ children }: { children: ReactNode }) => <WidgetDataProvider store={store}>{children}</WidgetDataProvider>;
    return { backend, port, wrapper };
  }

  it('loads every domain a widget depends on and shows loading until all of them are in, so no fixture rows leak', async () => {
    const { backend, port, wrapper } = dependent([simpleAdapter('staff', '/staff'), simpleAdapter('members', '/members')]);
    backend.on('GET', '/staff', () => emptyPage);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    backend.on('GET', '/members', async () => { await held; return emptyPage; });
    const { result } = renderHook(() => useWidgetView('ai-response'), { wrapper });
    await waitFor(() => expect(port.state('staff').status).toBe('ready'));
    expect(result.current).toMatchObject({ status: 'empty', messageKey: 'data.real.loading' });
    release();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(port.state('members').status).toBe('ready');
  });

  it('shows the error view when a dependency fails, and recovers on retry', async () => {
    const { backend, port, wrapper } = dependent([simpleAdapter('staff', '/staff'), simpleAdapter('members', '/members')]);
    backend.on('GET', '/staff', () => emptyPage);
    let down = true;
    backend.on('GET', '/members', () => down ? reply(503, { code: 'SERVICE_UNAVAILABLE' }) : emptyPage);
    const { result } = renderHook(() => useWidgetView('ai-response'), { wrapper });
    await waitFor(() => expect(result.current).toMatchObject({ status: 'error', messageKey: 'data.real.error' }));
    down = false;
    await act(async () => { await port.retry('members'); });
    expect(result.current.status).toBe('ready');
  });

  it('does not wait for a dependency that has no HTTP adapter (fixture)', async () => {
    const { backend, wrapper } = dependent([simpleAdapter('staff', '/staff')]);
    backend.on('GET', '/staff', () => emptyPage);
    const { result } = renderHook(() => useWidgetView('ai-response'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });
});

describe('widget hooks over the data port', () => {
  it('adds the widget rejection prefix and next step while giving Navis a bare reason', async () => {
    const { backend, store, wrapper } = harness('http');
    backend.on('DELETE', '/inventory/menu/m-a', () => reply(400, { code: 'VALIDATION' }));
    const translate = createTranslator<string>('ko', ...dataBundles);
    const { result } = renderHook(() => useDataExecute(), { wrapper });
    const command = { type: 'menu.delete', menuId: 'm-a' } as const;
    const widget = await result.current(command);
    const navis = await store.execute(command);
    expect(widget.ok ? '' : translate.t(widget.messageKey)).toBe('실행하지 못했어요 · 입력한 내용이 맞지 않아요. 입력값을 확인해 주세요');
    expect(navis.ok ? '' : translate.t(navis.messageKey)).toBe('입력한 내용이 맞지 않아요');
  });

  it('loads on first read: loading → the HTTP rows, without a manual load call', async () => {
    const { backend, wrapper } = harness('http');
    backend.on('GET', '/inventory/menu', () => ({ items: [{ menuId: 'm-a', name: '서버 메뉴' }], nextCursor: null, asOf, sourceRevision: 1 }));
    const { result } = renderHook(() => ({ view: useWidgetView('menu'), domain: useDomainState('menu') }), { wrapper });
    expect(result.current.view).toMatchObject({ status: 'empty', messageKey: 'data.real.loading' });
    await waitFor(() => expect(result.current.view.status).toBe('ready'));
    expect(result.current.domain).toMatchObject({ mode: 'http', status: 'ready' });
    expect(backend.callsTo('GET', '/inventory/menu')).toHaveLength(1);
  });

  it('shows the error view after a failed first load and the stale note after a failed refresh', async () => {
    const { backend, port, wrapper } = harness('http');
    let down = true;
    backend.on('GET', '/inventory/menu', () => down ? reply(503, { code: 'SERVICE_UNAVAILABLE' }) : { items: [{ menuId: 'm-a', name: '서버 메뉴' }], nextCursor: null, asOf, sourceRevision: 1 });
    const { result } = renderHook(() => useWidgetView('menu'), { wrapper });
    await waitFor(() => expect(result.current).toMatchObject({ status: 'error', messageKey: 'data.real.error' }));
    down = false;
    await act(async () => { await port.retry('menu'); });
    expect(result.current.status).toBe('ready');
    down = true;
    await act(async () => { await port.retry('menu'); });
    expect(result.current).toMatchObject({ status: 'ready', notes: [{ messageKey: 'data.real.stale' }] });
  });

  it('ignores a stored sample-state preview in HTTP mode, so fixture rows can never show', async () => {
    const { backend, store } = harness('http');
    backend.on('GET', '/inventory/menu', () => ({ items: [{ menuId: 'm-a', name: '서버 메뉴' }], nextCursor: null, asOf, sourceRevision: 1 }));
    const wrapper = ({ children }: { children: ReactNode }) => <WidgetDataProvider store={store} preview={{ family: 'empty', overrides: { menu: 'empty' } }}>{children}</WidgetDataProvider>;
    const { result } = renderHook(() => useWidgetView('menu'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('keeps the exact fixture behavior when the domain is fixture', () => {
    const { backend, wrapper } = harness('fixture');
    const { result } = renderHook(() => ({ view: useWidgetView('menu'), domain: useDomainState('menu') }), { wrapper });
    expect(result.current.view.status).toBe('ready');
    expect(result.current.domain.status).toBe('fixture');
    expect(backend.calls).toHaveLength(0);
  });

  it('useDataExecute always returns a Promise, also for a fixture command', async () => {
    const { wrapper, store } = harness('fixture');
    const { result } = renderHook(() => useDataExecute(), { wrapper });
    const first = store.getSnapshot().tables.menuItem[0];
    const promise = result.current({ type: 'menu.update', menuId: first.menuId, patch: { price: first.price + 100 } });
    expect(promise).toBeInstanceOf(Promise);
    expect(await promise).toMatchObject({ ok: true });
  });
});
