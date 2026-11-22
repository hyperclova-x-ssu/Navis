/** PAR-1 (D-384, D-355): the 메뉴 window shows the same tabs, buttons, 업체 정보 form and 플레이스에 올리기 card over HTTP as with the example data. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../../data/db/store';
import { TODAY } from '../../../data/db/time';
import { createRealPort } from '../../../data/reality/00';
import { menuAdapter } from '../../../data/reality/01/adapter';
import type { MenuDto } from '../../../data/reality/01/menu-dto';
import { renderWithKit } from '../../../ui/test-utils';
import { structureDifference, windowStructure } from '../mgmt-money/parity-structure';
import { MenuDetail } from './menu';

afterEach(cleanup);
const storeId = '11111111-1111-4111-8111-111111111111';
const item: MenuDto = {
  menuId: '22222222-2222-4222-8222-222222222222', name: '아메리카노', category: 'drink', price: 3100, saleStatus: 'selling',
  memo: null, prepMin: 3, photoKey: null, photoFileId: null, groups: [], recipeLines: [], recipeVersion: null, unitCost: null, revision: 1,
};
const base = `/api/v1/stores/${storeId}`;
const venue = { name: '안숭잘부 카페', address: '서울 동작구', phone: '02-000-0000', keywords: ['카페'], photos: [] };

function setup(mode: 'http' | 'example', menu: MenuDto = item) {
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (url === '/api/v1/auth/refresh') return Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
    if (url === '/api/v1/auth/demo') return Response.json({ accessToken: 'demo-access', expiresIn: 600, storeId });
    if (url === `${base}/inventory/menu?limit=50`) return Response.json({ items: [menu], nextCursor: null, asOf: '2026-11-21T10:00:00Z', sourceRevision: 1 });
    if (url === `${base}/pos/coupon-sales?businessDate=${TODAY}&view=today`) return Response.json({ businessDate: TODAY, soldToday: [{ menuId: menu.menuId, quantity: 12 }] });
    if (url === `${base}/inventory/place/venue`) return Response.json(venue);
    if (url === `${base}/inventory/place/menu`) return Response.json({ items: [{ name: item.name, price: item.price }] });
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  const store = createWidgetDataStore();
  if (mode === 'http') store.bindReal(createRealPort({ store, fetch: fetcher, source: () => 'http', adapters: [menuAdapter] }));
  const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
  return { fetcher, ...renderWithKit(<MenuDetail host={host} featureId="menu" condition={{ kind: 'default' }} detailRef={{ featureId: 'menu' }} />, { store, reducedMotion: true }) };
}

it('shows 업체 정보 above the category tabs and the same form inside it over HTTP and with the example data', async () => {
  const seen = [];
  for (const mode of ['http', 'example'] as const) {
    const ui = setup(mode);
    await screen.findByRole('tab', { name: '커피' });
    const first = windowStructure(ui.container);
    const table = screen.getByRole('grid');
    expect(table.style.getPropertyValue('--data-grid-columns')).toMatch(/^minmax\(264px, 1fr\) /);
    fireEvent.click(screen.getByRole('button', { name: '업체 정보' }));
    const section = ui.container.querySelector('.menu-publication-venue')!;
    await within(section as HTMLElement).findByRole('textbox', { name: '이름' });
    seen.push({ first, venue: windowStructure(section) });
    cleanup();
  }
  const [http, example] = seen;
  expect(http!.first.tabs).toEqual(['전체', '커피', '티', '음료', '디저트']);
  expect(http!.first.buttons).toContain('업체 정보');
  expect(structureDifference(http!.first, example!.first)).toEqual({});
  expect(structureDifference(http!.venue, example!.venue)).toEqual({});
  expect(http!.venue.buttons).toEqual(expect.arrayContaining(['사진 올리기']));
});

it('offers 플레이스에 올리기 in the menu panel of both modes and previews the change from the Place menu', async () => {
  const seen = [];
  for (const mode of ['http', 'example'] as const) {
    setup(mode);
    fireEvent.click((await screen.findAllByRole('gridcell', { name: /메뉴 이름/ }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: '플레이스에 올리기' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '미리보기' })).toBeInTheDocument());
    seen.push(windowStructure(screen.getByRole('button', { name: '플레이스에 올리기' }).closest('section')!));
    cleanup();
  }
  const [http, example] = seen;
  expect(http!.buttons).toContain('플레이스에 올리기');
  expect(example!.buttons).toContain('플레이스에 올리기');
  expect(structureDifference(http!, example!)).toEqual({});
});

it('walks the example 업체 정보 through preview, the owner press and the saved listing without any request', async () => {
  const ui = setup('example');
  await screen.findByRole('tab', { name: '커피' });
  fireEvent.click(screen.getByRole('button', { name: '업체 정보' }));
  const phone = await screen.findByRole('textbox', { name: '전화' });
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  expect(await screen.findByText('플레이스와 같아서 올릴 것이 없어요')).toBeInTheDocument();
  fireEvent.change(phone, { target: { value: '02-111-2222' } });
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  expect(await screen.findByText(/변경 후 02-111-2222/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '플레이스에 올리기' }));
  expect(await screen.findByText(/저장했어요/)).toBeInTheDocument();
  expect(await screen.findByRole('textbox', { name: '전화' })).toHaveValue('02-111-2222');
  expect(ui.fetcher).not.toHaveBeenCalled();
});

it('lists each recipe line\'s use today under the recipe over HTTP too: the menus sold times the line quantity', async () => {
  setup('http', { ...item, recipeLines: [{ recipeLineId: 'line-1', itemId: '33333333-3333-4333-8333-333333333333', quantity: 18, unit: 'g' }] });
  fireEvent.click(await screen.findByRole('gridcell', { name: /메뉴 이름/ }));
  expect(await screen.findByText(/오늘 사용량 216g \(12잔\)/)).toBeInTheDocument();
});
