import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { trendPath } from '../../../data/reality/13/trend-hooks';
import { getLocalTrendRanking, trendSource } from '../../../data/reality/13/trend-ranking';
import { localBackend, openWidget, structure, type Mode } from './parity-harness';

afterEach(() => { cleanup(); localStorage.clear(); });

const at = '2026-11-22T06:45:00Z';
const period = { from: '2026-11-08', to: '2026-11-21' };
const points = Array.from({ length: 14 }, (_, index) => ({ period: `2026-11-${String(index + 8).padStart(2, '0')}`, ratio: 70 + index }));
const growth = { rank: 1, keyword: '소금빵', changePercent: 25, changePoints: 1.2, anchorLevel: 2.4,
  sameWeekChangePercent: -16.7, points, classification: 'rising' };
const menuName = '겉바속촉 버터 소금빵';
const providerAnswer = { status: 'ready', items: [growth], period, fetchedAt: at, recommendations: {
  version: '2026-11', source: 'rule', items: [{ id: 'chestnut', keyword: '밤 라떼' }],
} };

function setup() {
  const backend = localBackend();
  let revision = 1;
  let candidates = [{ id: 'bread', keyword: '소금빵', suggested: true }];
  backend.on('GET', trendPath, ({ query }) => {
    const base = { asOf: at, period, sales: { status: 'empty', items: [] } };
    if (query.keyword) return { ...base, search: { status: 'available', query: {
      startDate: period.from, endDate: period.to, keywordGroups: [{ groupName: query.keyword }],
    }, items: points }, links: { blog: { status: 'empty', items: [] }, cafearticle: { status: 'empty', items: [] } } };
    return { ...base, search: null, sourceRevision: revision, candidates, ranking: { ...providerAnswer, items: [
      { ...growth, id: 'bread', isMenu: true, menuName },
    ] } };
  });
  backend.on('POST', `${trendPath}/preview`, () => providerAnswer);
  backend.on('POST', `${trendPath}/candidates`, ({ body }) => {
    candidates = [...candidates, { id: 'new-candidate', keyword: (body as { keyword: string }).keyword, suggested: false }];
    return { resourceId: 'new-candidate', revision: ++revision, receiptId: 'add-receipt', affectedSources: ['local-trends'] };
  });
  backend.on('DELETE', `${trendPath}/candidates/new-candidate`, () => {
    candidates = candidates.filter(item => item.id !== 'new-candidate');
    return { resourceId: 'new-candidate', revision: ++revision, receiptId: 'remove-receipt', affectedSources: ['local-trends'] };
  });
  return backend;
}

function openTrends(mode: Mode) {
  const backend = setup();
  const store = createWidgetDataStore(mode === 'example' ? { exampleLocalTrends: {
    candidates: [{ id: '소금빵', keyword: '소금빵', suggested: true }],
  } } : undefined);
  if (mode === 'example') store.bindReal(createRealPort({ store, fetch: backend.fetch, adapters: [], source: () => 'fixture' }));
  return { backend, view: openWidget('local-trends', 'Detail', mode, { backend, store }) };
}

it.each(['example', 'real'] as const)('supports rank, graph, plain link and owner candidate controls in %s mode', async mode => {
  const { backend, view } = openTrends(mode);
  const { store } = view;
  const row = await screen.findByRole('button', { name: /^1\. 소금빵/ });
  expect(row).toHaveTextContent('4주 대비 +25.0%');
  expect(row).toHaveTextContent('작년 같은 주 대비 -16.7%');
  expect(row).toHaveTextContent(`우리 메뉴: ${menuName}`);
  fireEvent.click(row);
  expect(screen.getByRole('img')).toHaveAccessibleName(/소금빵/);
  const chart = view.container.querySelector('[data-slot="local-trends.chart"]')!;
  expect(chart.querySelector('[data-slot="local-trends.chart.latest"] .mkt-trend-chart__marker')).toBeInTheDocument();
  expect(within(chart as HTMLElement).getByText('+25.0%')).toBeInTheDocument();
  expect(within(chart as HTMLElement).getByText('-16.7%')).toBeInTheDocument();
  expect(view.container).not.toHaveTextContent(/앵커|%p/);
  expect(chart.querySelectorAll('.ui-chart-endpoints span')).toHaveLength(2);
  expect(screen.getByText(value => value.startsWith(trendSource))).toBeInTheDocument();
  const search = within(chart as HTMLElement).getByRole('link', { name: '네이버 검색 열기' });
  expect(new URL(search.getAttribute('href')!).searchParams.get('query')).toBe('소금빵');
  expect(within(chart as HTMLElement).getAllByRole('link')).toEqual([search]);
  expect(within(chart as HTMLElement).getAllByRole('button')).toHaveLength(2);
  fireEvent.click(within(chart as HTMLElement).getByRole('button', { name: '쿠폰 만들기' }));
  expect(view.host.openLinked).toHaveBeenCalledWith({ featureId: 'slot-coupon', view: 'send', focus: 'action' });
  fireEvent.click(within(chart as HTMLElement).getByRole('button', { name: '홍보 영상 만들기' }));
  expect(view.host.openLinked).toHaveBeenCalledWith({ featureId: 'promo-video', view: 'create', focus: 'action' });
  expect(view.container).not.toHaveTextContent(/POS|판매 수량|언급/);
  expect(getLocalTrendRanking(store.getSnapshot())?.items[0]).toMatchObject({ keyword: '소금빵', changePercent: 25 });

  fireEvent.click(screen.getByText('후보 검색어 관리'));
  const field = screen.getByRole('textbox', { name: '후보 검색어' });
  fireEvent.change(field, { target: { value: '라임 에이드' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(backend.callsTo('POST', `${trendPath}/candidates`)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '검색어 추가하기' }));
  await screen.findByRole('button', { name: '라임 에이드 지우기' });
  fireEvent.click(screen.getByRole('button', { name: '라임 에이드 지우기' }));
  expect(backend.callsTo('DELETE', `${trendPath}/candidates/new-candidate`)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '검색어 지우기' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '라임 에이드 지우기' })).toBeNull());

  expect(backend.callsTo('GET', trendPath).every(call => call.query.keyword === undefined)).toBe(true);
  expect(getLocalTrendRanking(store.getSnapshot())?.items[0].keyword).toBe('소금빵');

  const mutations = backend.calls.filter(call => /\/candidates/u.test(call.path));
  if (mode === 'example') {
    expect(mutations).toEqual([]);
    expect(JSON.stringify(store.getSnapshot().tables.exampleLocalTrends)).not.toContain('라임 에이드');
  } else {
    expect(mutations.map(call => call.method)).toEqual(['POST', 'DELETE']);
    expect(mutations.every(call => !!call.headers.get('idempotency-key'))).toBe(true);
    expect(mutations[1].body).toEqual({ expectedRevision: 2, confirmed: true });
  }
});

it.each(['example', 'real'] as const)('adds dictionary recommendations only on the owner press in %s mode', async mode => {
  const { backend, view } = openTrends(mode);
  const tray = await screen.findByText('운영 사전 2026-11');
  expect(tray).toBeInTheDocument();
  expect(backend.callsTo('POST', `${trendPath}/candidates`)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '후보에 추가' }));
  if (mode === 'example') {
    expect(view.store.getSnapshot().tables.exampleLocalTrends?.candidates).toContainEqual(expect.objectContaining({ keyword: '밤 라떼' }));
    expect(backend.callsTo('POST', `${trendPath}/candidates`)).toHaveLength(0);
  } else {
    await waitFor(() => expect(backend.callsTo('POST', `${trendPath}/candidates`)).toHaveLength(1));
    expect(backend.callsTo('POST', `${trendPath}/candidates`)[0].body).toEqual({ keyword: '밤 라떼' });
  }
});

it('uses identical chart, ranking, link and candidate editor structure in both modes', async () => {
  async function renderedStructure(mode: Mode) {
    const { view } = openTrends(mode);
    fireEvent.click(await screen.findByRole('button', { name: /^1\. 소금빵/ }));
    fireEvent.click(screen.getByText('후보 검색어 관리'));
    const result = structure(view.container, { card: '[data-slot="local-trends.chart"]' });
    cleanup();
    return result;
  }
  const example = await renderedStructure('example');
  const real = await renderedStructure('real');
  expect(real).toEqual(example);
  expect(real.slots).toEqual(expect.arrayContaining(['local-trends.list', 'local-trends.chart', 'local-trends.chart.latest']));
  expect(real.fields).toEqual(['후보 검색어']);
  expect(real.buttons).toEqual(['검색어 추가하기']);
});
