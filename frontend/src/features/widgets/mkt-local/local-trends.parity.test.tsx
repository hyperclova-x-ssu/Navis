/** FIX-RV3 (RV-REALVERIFY-3): the trends window keeps its original keyword-card list in HTTP mode; the search-interest lookup sits after it. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { TODAY } from '../../../data/db/time';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { fakeBackend } from '../../../data/reality/00/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';

afterEach(cleanup);

const at = `${TODAY}T06:45:00.000Z`;
const base = '/marketing';
const page = { items: [], nextCursor: null, asOf: at, sourceRevision: 1 };

function setup() {
  const backend = fakeBackend();
  backend.on('GET', `${base}/local-changes`, ({ query }) => ({ ...page, coverage: null, unreadCount: 0, period: { from: query.from, to: query.to } }));
  backend.on('GET', `${base}/trade-area`, ({ query }) => ({ asOf: at, period: query, population: { status: 'unavailable', items: [] }, sales: { status: 'empty', items: [] } }));
  // The service names no menu: the name comes from the menu catalog, which can arrive after this domain.
  backend.on('GET', `${base}/local-trends`, ({ query }) => ({ asOf: at, period: { from: query.from, to: query.to }, search: null,
    sales: { status: 'available', items: [
      { menuId: 'menu-late', businessDate: TODAY, quantity: 9 }, { menuId: 'menu-late', businessDate: '2026-11-21', quantity: 4 }, { menuId: 'menu-b', menuName: '바닐라 라떼', businessDate: TODAY, quantity: 3 },
    ] } }));
  backend.on('GET', `${base}/offers`, () => page);
  backend.on('GET', `${base}/offers/peers`, () => ({ status: 'available', items: [] }));
  backend.on('GET', `${base}/community/cafe-posts`, () => page);
  return backend;
}

async function open(backend: ReturnType<typeof fakeBackend>) {
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'local' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify: vi.fn(), acknowledgeBriefing() {} };
  const Detail = widgets.find(widget => widget.id === 'local-trends')!.Detail!;
  const view = renderWithKit(<Detail featureId="local-trends" condition={{ kind: 'default' }} detailRef={{ featureId: 'local-trends' }} host={host} />, { modules: widgets, store });
  return { store, ...view };
}

it('names each keyword card by its menu even when the menu catalog arrives after this domain', async () => {
  const { store, container } = await open(setup());
  await screen.findByText('바닐라 라떼');
  expect(screen.queryByText('메뉴 보기', { selector: '.mkt-pick__title' })).not.toBeNull();
  act(() => { store.hydrate({ menuItem: [...store.getSnapshot().tables.menuItem, { menuId: 'menu-late', name: { raw: '아인슈페너' } } as never] }); });
  expect(await screen.findByText('아인슈페너', { selector: '.mkt-pick__title' })).toBeInTheDocument();
  expect(container.querySelectorAll('.mkt-pick__title')).toHaveLength(2);
});

it('names sales from the store catalog when the trends window opens before the menu widget', async () => {
  const backend = setup();
  backend.on('GET', '/inventory/menu', () => ({ ...page, items: [{ menuId: 'menu-late', name: '아인슈페너' }] }));
  const { store } = await open(backend);
  expect(await screen.findByText('아인슈페너', { selector: '.mkt-pick__title' })).toBeInTheDocument();
  expect(store.getSnapshot().tables.trendKeyword.find(row => row.keywordId === 'menu-late')?.keywordKey).toBe('seed:아인슈페너');
  expect(backend.callsTo('GET', '/inventory/menu')).toHaveLength(1);
});

it('lists the keyword cards first and puts the search-interest lookup after them, without a second heading or table rows in the cards', async () => {
  const { store, container } = await open(setup());
  await screen.findByText('바닐라 라떼');
  act(() => { store.hydrate({ menuItem: [...store.getSnapshot().tables.menuItem, { menuId: 'menu-late', name: { raw: '아인슈페너' } } as never] }); });
  const list = container.querySelector('[data-slot="local-trends.list"]') as HTMLElement;
  const lookup = screen.getByRole('textbox', { name: /검색어/ });
  // Document order: the keyword list, then the lookup.
  expect(list.compareDocumentPosition(lookup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole('heading', { name: '우리 메뉴 판매 추이' })).toBeNull();
  // The opened card is the original card: title, lines and a meta line (no table rows).
  const card = list.querySelector('.mkt-card') as HTMLElement;
  expect(card.querySelector('.mkt-card__title')).toHaveTextContent('아인슈페너');
  expect(card.querySelectorAll('.mkt-card__line').length).toBeGreaterThan(0);
  expect(card.querySelector('.mkt-row')).toBeNull();
});
