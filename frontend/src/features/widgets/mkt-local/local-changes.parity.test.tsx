/** PAR-3 (D-384, D-355): the example (fixture) 동네 변화 알림 and the real one are the same screen. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createSeedTables } from '../../../data/db/seed';
import { createWidgetDataStore } from '../../../data/db/store';
import { TODAY } from '../../../data/db/time';
import { loaded, localBackend, openWidget, plain, structure } from './parity-harness';

afterEach(cleanup);

/** Three open changes in each mode: the owner's record without a link, a licence and an event, each with an official link. */
async function pair(which: 'Panel' | 'Detail', options: Parameters<typeof openWidget>[3] = {}, backend = localBackend()) {
  const example = openWidget('local-changes', which, 'example', options);
  await loaded(example.container);
  const a = structure(example.container);
  const exampleText = plain(example.container);
  cleanup();
  const real = openWidget('local-changes', which, 'real', { ...options, backend });
  await loaded(real.container);
  return { example: a, real: structure(real.container), exampleText, realText: plain(real.container), ...real };
}

it('panel: the same label, count, kind chips and source/update line in both modes', async () => {
  for (const panel of [{ shape: 'L', width: 4, height: 4 }, { shape: 'S', width: 2, height: 2 }, { shape: 'W', width: 4, height: 1 }] as const) {
    const { example, real, exampleText, realText } = await pair('Panel', { panel });
    expect(example).toEqual(real);
    for (const text of [exampleText, realText]) {
      expect(text).toContain('확인할 동네 변화');
      expect(text).toMatch(/3개/);
      expect(text).not.toMatch(/매장에서 \d+m|공사 기간|행사 기간|개점일/);
    }
    cleanup();
  }
  const large = await pair('Panel', { panel: { shape: 'L', width: 4, height: 4 } });
  for (const text of [large.exampleText, large.realText]) { expect(text).toMatch(/출처: 서울특별시 동작구/); expect(text).toMatch(/음식점 인허가/); expect(text).toMatch(/직접 기록/); }
});

it('detail: the same coverage lines, record button, heading and cards (kind chip, title, when · area, source, link, button) in both modes', async () => {
  const { example, real, exampleText, realText } = await pair('Detail');
  expect(example).toEqual(real);
  expect(example.buttons).toEqual(['동네 변화 기록하기']);
  expect(example.sections).toEqual(['새로 확인할 변화']);
  for (const text of [exampleText, realText]) {
    expect(text).toMatch(/^확인할 동네 변화 3개 · /);
    expect(text).toMatch(/공식 공고 \d+\/\d+\(.\) 기준 · 서울 동작구 상도동/);
    expect(text).not.toContain('음식점 인허가 · 행사');
    expect(text).not.toMatch(/매장 주변 500m|매장에서 \d+m/);
  }
});

it('detail: both modes list the owner’s record first-class like the others, and the licence and event cards link to their official source', async () => {
  const { container } = await pair('Detail');
  const links = [...container.querySelectorAll('li.mkt-card a')].map(a => a.getAttribute('href'));
  expect(links).toHaveLength(2);
  cleanup();
  const example = openWidget('local-changes', 'Detail', 'example');
  await loaded(example.container);
  expect([...example.container.querySelectorAll('li.mkt-card a')].map(a => a.getAttribute('href'))).toEqual(links);
  const cards = [...example.container.querySelectorAll('li.mkt-card')].map(li => [...li.children].map(el => el.className || el.tagName.toLowerCase()).join(','));
  expect(cards[0]).toBe(['mkt-card__badges', 'mkt-card__title', 'mkt-card__line', 'mkt-card__meta', 'ui-button ui-button--secondary ui-button--default '].join(','));
  expect(cards[1]).toBe(['mkt-card__badges', 'mkt-card__title', 'mkt-card__line', 'mkt-card__meta', 'p', 'ui-button ui-button--secondary ui-button--default '].join(','));
});

it('detail: news references use the same section in both modes and never join actionable changes or the snapshot', async () => {
  const example = openWidget('local-changes', 'Detail', 'example');
  const name = /^참고 뉴스\s·\s네이버 검색$/;
  expect(screen.queryByRole('region', { name })).toBeNull();
  example.unmount();

  const backend = localBackend();
  backend.on('GET', '/marketing/local-changes', ({ query }) => ({
    items: [], nextCursor: null, asOf: `${TODAY}T06:45:00.000Z`, sourceRevision: 1, unreadCount: 0,
    coverage: { region: '서울 동작구 상도동', kinds: ['festival'], referenceDate: TODAY }, period: { from: query.from, to: query.to },
    ...(query.includeNews === '1' && { newsReferences: { source: 'naver-search', use: 'display-only', status: 'available',
      region: '서울 동작구 상도동', period: { from: query.from, to: query.to },
      items: [{ title: '외부 기사', url: 'https://example.org/article', publishedAt: `${TODAY}T00:00:00.000Z` }] } }),
  }));
  const { store } = openWidget('local-changes', 'Detail', 'real', { backend });
  const references = within(await screen.findByRole('region', { name }));
  expect(await references.findByRole('link', { name: /외부 기사/ })).toHaveAttribute('href', 'https://example.org/article');
  expect(references.queryByRole('button', { name: /확인 완료/ })).toBeNull();
  expect(store.getSnapshot().tables.realLocal).toMatchObject({ changes: [], unreadCount: 0 });
  expect(JSON.stringify(store.getSnapshot().tables.realLocal)).not.toContain('example.org/article');
});

it('folding: one acknowledged change moves to the same folded section with the same reopen button in both modes', async () => {
  const fold = async (mode: 'example' | 'real') => {
    const opened = mode === 'example' ? openWidget('local-changes', 'Detail', 'example') : openWidget('local-changes', 'Detail', 'real', { backend: ackable() });
    await loaded(opened.container);
    fireEvent.click(screen.getAllByRole('button', { name: /^확인 표시하기/ })[0]!);
    const toggle = await screen.findByRole('button', { name: '접어 둔 변화 1개' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const folded = await screen.findByRole('list', { name: '접어 둔 변화 1개' });
    const result = { structure: structure(opened.container), reopen: within(folded).getAllByRole('button', { name: /^소식을 미확인으로 표시하기/ }).length, badge: within(folded).getAllByText('확인함').length, summary: plain(opened.container).match(/^확인할 동네 변화 \d+개/)![0] };
    cleanup();
    return result;
  };
  const example = await fold('example');
  const real = await fold('real');
  expect(example).toEqual(real);
  expect(example).toMatchObject({ reopen: 1, badge: 1, summary: '확인할 동네 변화 2개' });
});

function ackable() {
  const backend = localBackend();
  let acked = false;
  const row = (id: string, kind: string, dateKind: string, url: string | null, authority: string, index: number) => ({ id, revision: acked && index === 0 ? 2 : 1, title: `변화 ${index + 1}`, kind, region: '서울 동작구 상도동', authority, sourceUrl: url, dateKind,
    referenceDate: TODAY, updatedAt: `${TODAY}T06:45:00.000Z`, acknowledgedAt: acked && index === 0 ? `${TODAY}T06:50:00.000Z` : null });
  backend.on('GET', '/marketing/local-changes', ({ query }) => ({
    items: [row('c1', 'owner-record', 'recorded-date', null, '사장님 기록', 0), row('c2', 'food-license', 'license-date', 'https://data.seoul.go.kr/dataList/OA-18696/S/1/datasetView.do', '서울특별시 동작구', 1),
      row('c3', 'festival', 'event-date', 'https://data.seoul.go.kr/dataList/OA-18671/S/1/datasetView.do', '서울특별시 동작구', 2)],
    nextCursor: null, asOf: `${TODAY}T06:45:00.000Z`, sourceRevision: 1, coverage: { region: '서울 동작구 상도동', kinds: ['food-license', 'festival'], referenceDate: TODAY }, unreadCount: acked ? 2 : 3, period: { from: query.from, to: query.to } }));
  backend.on('POST', /\/local-changes\/c1\/ack$/, () => { acked = true; return { resourceId: 'c1', revision: 2, receiptId: 'a1', affectedSources: ['local-changes'] }; });
  return backend;
}

it('record form: the same fields in both modes; in the example data a recorded change joins the list as an owner record', async () => {
  const names = async (mode: 'example' | 'real') => {
    const opened = mode === 'example' ? openWidget('local-changes', 'Detail', 'example') : openWidget('local-changes', 'Detail', 'real', { backend: localBackend() });
    await loaded(opened.container);
    fireEvent.click(screen.getByRole('button', { name: '동네 변화 기록하기' }));
    const form = screen.getByRole('form', { name: '동네 변화 기록하기' });
    const fields = [...form.querySelectorAll('input, textarea, select')].map(el => (el.closest('label')?.textContent ?? '').replace(/[\u00a0\s]+/g, ' ').trim());
    const buttons = [...form.querySelectorAll('button')].map(el => el.textContent);
    cleanup();
    return { fields, buttons };
  };
  const example = await names('example');
  expect(await names('real')).toEqual(example);
  expect(example.fields.length).toBeGreaterThanOrEqual(4);

  const opened = openWidget('local-changes', 'Detail', 'example');
  await loaded(opened.container);
  fireEvent.click(screen.getByRole('button', { name: '동네 변화 기록하기' }));
  fireEvent.change(screen.getByRole('textbox', { name: /^제목/ }), { target: { value: '앞 골목 가스관 공사' } });
  fireEvent.change(screen.getByRole('textbox', { name: /^원문 주소/ }), { target: { value: 'http://example.com/x' } });
  expect(screen.getByText('https로 시작하는 원문 주소를 적어 주세요')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: /^원문 주소/ }), { target: { value: 'https://www.dongjak.go.kr/notice' } });
  fireEvent.submit(screen.getByRole('form', { name: '동네 변화 기록하기' }));
  await waitFor(() => expect(opened.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.real.local.recorded' })));
  const card = (await screen.findByRole('heading', { name: '앞 골목 가스관 공사' })).closest('li')!;
  expect(within(card).getByText('직접 기록')).toBeInTheDocument();
  expect(card).toHaveTextContent('직접 기록');
  expect(card).not.toHaveTextContent('출처: 사장님 기록');
  expect(within(card).getByRole('link', { name: '원문 열기' })).toHaveAttribute('href', 'https://www.dongjak.go.kr/notice');
  const row = opened.store.getSnapshot().tables.localChange.find(c => c.sourceKey === 'seed:사장님 기록');
  expect(row).toMatchObject({ titleKey: 'seed:앞 골목 가스관 공사', ackedAt: null, sourceUrl: 'https://www.dongjak.go.kr/notice' });
});

it('empty: no change in either mode keeps the same heading, coverage lines and the record button with the same sentence', async () => {
  const store = createWidgetDataStore({ localChange: createSeedTables().localChange.slice(0, 0) });
  const example = openWidget('local-changes', 'Detail', 'example', { store });
  await loaded(example.container);
  const a = structure(example.container);
  const exampleText = plain(example.container);
  cleanup();
  const real = openWidget('local-changes', 'Detail', 'real', { backend: localBackend({ changes: false }) });
  await loaded(real.container);
  expect(structure(real.container)).toEqual(a);
  expect(a.buttons).toEqual(['동네 변화 기록하기']);
  expect(exampleText).toMatch(/자료가 없어요/);
  expect(plain(real.container)).toMatch(/자료가 없어요/);
});
