/** PAR-3 (D-384, D-355): the example (fixture) 상권분석 and the real one are the same screen — the same parts in the same places, only the numbers differ. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../../data/db/store';
import { exampleHourlySales, exampleTrade, examplePeriod, SEOUL_POPULATION_URL } from './example-local';
import { loaded, localBackend, openWidget, plain, structure } from './parity-harness';

afterEach(cleanup);

async function both(which: 'Panel' | 'Detail', options: Parameters<typeof openWidget>[3] = {}) {
  const example = openWidget('trade-area', which, 'example', options);
  await loaded(example.container);
  const a = structure(example.container);
  const exampleText = plain(example.container);
  cleanup();
  const real = openWidget('trade-area', which, 'real', { ...options, backend: localBackend() });
  await loaded(real.container);
  return { example: a, real: structure(real.container), exampleText, realText: plain(real.container), container: real.container };
}

it('panel: the same label, source line, bars and rows in both modes', async () => {
  for (const shape of [{ shape: 'L', width: 4, height: 4 }, { shape: 'S', width: 2, height: 2 }, { shape: 'T', width: 2, height: 1 }] as const) {
    const { example, real, exampleText, realText } = await both('Panel', { panel: shape });
    expect(example).toEqual(real);
    expect(screen.getByText('많은 시간')).toBeInTheDocument();
    // The movement estimate and its Seoul source, never the old foot-traffic wording.
    for (const text of [exampleText, realText]) { expect(text).toMatch(/\d+~\d+시 · 이동량\(추정\)/); expect(text).toMatch(shape.height === 1 ? /서울 공개 자료/ : /서울 공개 자료 · /); expect(text).not.toMatch(/유동인구|시간대별 일평균/); }
    cleanup();
  }
});

it('retains the visible data source beside the estimate in the smallest panel', async () => {
  const { container, example, real } = await both('Panel', { panel: { shape: 'Q', width: 1, height: 1 } });
  expect(example).toEqual(real);
  const source = container.querySelector('[data-slot="trade-area.metric.source"]');
  expect(source).toBeVisible();
  expect(source).toHaveTextContent('서울 공개 자료');
});

it('detail: the same source lines, hour chart, hour card (movement, source, original link, our sales) and trends button in both modes', async () => {
  const { example, real, exampleText, realText } = await both('Detail');
  expect(example).toEqual(real);
  expect(example.links).toEqual(['원문 열기']);
  expect(example.buttons).toEqual(['요즘 뜨는 검색어 보기']);
  for (const text of [exampleText, realText]) {
    expect(text).toMatch(/출처: 서울 공개 자료 · /);
    expect(text).toMatch(/이동량\(추정\) · [\d,]+명/);
    expect(text).toMatch(/서울 동작구 상도동 · \d{4}년 \d분기 · 자료 기준일 \d+(?:월 |\/)\d+/);
    expect(text.match(/서울 공개 자료/g)).toHaveLength(1);
    expect(text).toContain('우리 매장 시간대별 판매');
    expect(text).toMatch(/POS · /);
    expect(text).not.toContain('네이버 지도 · 매장 주소 · 자료가 없어요');
  }
});

it('detail: geocoding adds the resolved address and keeps it outside the movement and POS card', async () => {
  const backend = localBackend();
  backend.on('GET', '/marketing/trade-area', ({ query }) => ({ asOf: '2026-11-17T06:45:00.000Z',
    period: { from: query.from, to: query.to }, population: { status: 'unavailable', items: [] },
    sales: { status: 'available', items: [{ hour: 10, quantity: 21, settlementIds: ['s1'] }] },
    location: { source: 'naver-maps', status: 'available', items: [{ address: '서울 동작구 상도로 1', longitude: 126.95, latitude: 37.49 }] },
  }));
  const { container } = openWidget('trade-area', 'Detail', 'real', { backend });
  const address = await screen.findByText(/네이버 지도 · 매장 주소.*서울 동작구 상도로 1/);
  expect(address.closest('.mkt-card')).toBeNull();
  expect(container.querySelector('[data-slot="trade-area.metric.value"]')).toHaveTextContent('판매 수량 21개');
});

it('detail: an hour that was tapped keeps the same card parts in both modes', async () => {
  const options = { detailRef: { hour: 10 } } as const;
  const example = openWidget('trade-area', 'Detail', 'example', options);
  await loaded(example.container);
  fireEvent.click(screen.getByRole('button', { name: /^10~11시/ }));
  const a = structure(example.container, { card: '[data-slot="trade-area.metric.value"]' });
  cleanup();
  const real = openWidget('trade-area', 'Detail', 'real', { ...options, backend: localBackend() });
  await loaded(real.container);
  fireEvent.click(screen.getByRole('button', { name: /^10~11시/ }));
  expect(structure(real.container, { card: '[data-slot="trade-area.metric.value"]' })).toEqual(a);
  // 10~11시 has our hourly sales in the real answer, so the ledger button shows there; the example card has the same sales line and button where the fixture sold something.
  expect(within(real.container).getByRole('button', { name: '가계부에서 보기' })).toBeInTheDocument();
});

it('example data: our hourly sales and the movement bands come from the fixture, with the Seoul dataset as the official link', () => {
  const snapshot = createWidgetDataStore().getSnapshot();
  const period = examplePeriod();
  const sales = exampleHourlySales(snapshot, period);
  expect(sales.length).toBeGreaterThan(3);
  expect(sales.every(row => row.quantity > 0 && row.hour >= 0 && row.hour < 24)).toBe(true);
  expect(sales.map(row => row.hour)).toEqual([...sales.map(row => row.hour)].sort((a, b) => a - b));
  const trade = exampleTrade(snapshot, '2026-11-17T15:45');
  expect(trade.population.items.map(row => row.estimate)).toEqual(snapshot.tables.footTraffic.map(row => row.estPeople));
  expect(new Set(trade.population.items.map(row => row.sourceUrl))).toEqual(new Set([SEOUL_POPULATION_URL]));
  expect(trade.population.items.every(row => row.endHour === row.startHour + 1 && row.refreshedAt === '2026-11-17T15:45')).toBe(true);
});

it('example detail: a store with POS orders shows the hour card’s sales line and the ledger button', async () => {
  const example = openWidget('trade-area', 'Detail', 'example', { detailRef: { hour: 9 } });
  await loaded(example.container);
  fireEvent.click(screen.getByRole('button', { name: /^9~10시/ }));
  const card = example.container.querySelector('[data-slot="trade-area.metric.value"]') as HTMLElement;
  expect(card).toHaveTextContent(/우리 매장 시간대별 판매 · 판매 수량 \d+개/);
  fireEvent.click(within(card).getByRole('button', { name: '가계부에서 보기' }));
  expect(example.host.openLinked).toHaveBeenCalledWith(expect.objectContaining({ featureId: 'ledger', condition: expect.objectContaining({ kind: 'dateRange' }) }));
});
