import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { trendPath } from '../../../data/reality/13/trend-hooks';
import { localBackend, openWidget } from './parity-harness';

afterEach(cleanup);

it('opens a direct NAVER search link without requesting or exposing Search API results', async () => {
  const backend = localBackend();
  const keyword = '유자 차 & 홍차';
  const fetchedAt = '2026-11-22T06:45:00Z';
  const period = { from: '2026-10-18', to: '2026-11-21' };
  backend.on('GET', trendPath, () => ({
    asOf: fetchedAt, period, search: null, sales: { status: 'empty', items: [] }, candidates: [], sourceRevision: 1,
    ranking: { status: 'ready', fetchedAt, period, items: [{ id: 'tea', keyword, rank: 1, changePercent: 15,
      classification: 'new', points: [{ period: period.from, ratio: 3 }, { period: period.to, ratio: 5 }] }] },
    links: { blog: { status: 'available', items: [{ title: '구형 검색 API 원문', url: 'https://blog.naver.com/legacy' }] } },
  }));
  const { store } = openWidget('local-trends', 'Detail', 'real', { backend });
  fireEvent.click(await screen.findByRole('button', { name: /^1\. 유자 차/ }));
  const link = screen.getByRole('link', { name: '네이버 검색 열기' });
  const url = new URL(link.getAttribute('href')!);
  expect(url.origin + url.pathname).toBe('https://search.naver.com/search.naver');
  expect([...url.searchParams]).toEqual([['query', keyword]]);
  expect(link).toHaveAttribute('target', '_blank');
  expect(screen.queryByText('구형 검색 API 원문')).toBeNull();
  expect(JSON.stringify(store.getSnapshot().tables.realLocal)).not.toContain('blog.naver.com/legacy');
  expect(backend.callsTo('GET', trendPath).every(call => call.query.keyword === undefined)).toBe(true);
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});
