/** GAPUI-MKT (SCR-31 · local-trends, PN10): blog/Café search result links for a keyword, display only and apart from the interest index. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  let cafeFails = true;
  backend.on('GET', `${base}/local-changes`, ({ query }) => ({ ...page, coverage: null, unreadCount: 0, period: { from: query.from, to: query.to } }));
  backend.on('GET', `${base}/trade-area`, ({ query }) => ({ asOf: at, period: query, population: { status: 'unavailable', items: [] }, sales: { status: 'empty', items: [] } }));
  backend.on('GET', `${base}/local-trends`, ({ query }) => ({ asOf: at, period: { from: query.from, to: query.to },
    search: query.keyword ? { status: 'available', unit: 'relative-index', query: { startDate: query.from, endDate: query.to, timeUnit: 'date', keywordGroups: [{ groupName: query.keyword, keywords: [query.keyword] }] }, items: [{ period: TODAY, ratio: 80 }] } : null,
    sales: { status: 'available', items: [{ menuId: 'menu-1', menuName: '카페라떼', businessDate: TODAY, quantity: 9 }] },
    ...(query.keyword ? { links: { source: 'naver-search', use: 'display-only',
      blog: { status: 'available', items: [{ title: '상도동 <카페> 라떼 후기 & 사진', url: 'https://blog.naver.com/a/1' }, { title: '주말 산책', url: 'http://blog.naver.com/b/2' }] },
      cafearticle: cafeFails ? { status: 'unavailable', items: [] } : { status: 'empty', items: [] } } } : {}) }));
  backend.on('GET', `${base}/offers`, () => page);
  backend.on('GET', `${base}/offers/peers`, () => ({ status: 'available', items: [] }));
  backend.on('GET', `${base}/community/cafe-posts`, () => page);
  return { backend, recover: () => { cafeFails = false; } };
}

function open(backend: ReturnType<typeof fakeBackend>) {
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'local' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify: vi.fn(), acknowledgeBriefing() {} };
  const Detail = widgets.find(widget => widget.id === 'local-trends')!.Detail!;
  renderWithKit(<Detail featureId="local-trends" condition={{ kind: 'default' }} detailRef={{ featureId: 'local-trends' }} host={host} />, { modules: widgets, store });
  return { store };
}

it('shows blog and Café result links only after a keyword, as plain titles with their links, and keeps them out of the snapshot', async () => {
  const { backend, recover } = setup();
  const { store } = open(backend);
  fireEvent.change(await screen.findByRole('textbox', { name: /검색어/ }), { target: { value: '라떼' } });
  expect(screen.queryByText(/검색 결과 링크/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '관심도 보기' }));
  const section = await screen.findByRole('region', { name: /^검색 결과 링크\s·\s네이버 검색$/ });
  // The title is plain text (no markup is interpreted), shown once as text and once as the link's accessible name.
  expect(within(section).getAllByText('상도동 <카페> 라떼 후기 & 사진')[0]).toHaveClass('mkt-row__text');
  expect(within(section).getByRole('link', { name: /상도동/ })).toHaveAttribute('href', 'https://blog.naver.com/a/1');
  expect(within(section).getByRole('link', { name: /상도동/ })).toHaveAttribute('target', '_blank');
  // A non-HTTPS result is not linked.
  expect(within(section).queryByText('주말 산책')).toBeNull();
  // Display only: the snapshot (Navis facts, model context) holds the search index, never the links.
  expect(JSON.stringify(store.getSnapshot().tables.realLocal)).not.toContain('blog.naver.com');
  expect(store.getSnapshot().tables.realLocal?.trends.search?.items).toEqual([{ period: TODAY, ratio: 80 }]);
  // One failed channel fails alone and retries.
  fireEvent.click(within(section).getByRole('tab', { name: '카페 글' }));
  expect(within(section).getByRole('alert')).toHaveTextContent('검색 결과를 불러오지 못했어요');
  recover();
  fireEvent.click(within(section).getByRole('button', { name: '다시 시도하기' }));
  await waitFor(() => expect(screen.getByRole('region', { name: /^검색 결과 링크/ })).toHaveTextContent('검색 결과가 없어요'));
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});
