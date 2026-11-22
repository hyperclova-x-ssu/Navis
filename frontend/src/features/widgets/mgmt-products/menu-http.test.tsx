import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../../data/db/store';
import { TODAY } from '../../../data/db/time';
import { createRealPort } from '../../../data/reality/00';
import { menuAdapter } from '../../../data/reality/01/adapter';
import type { MenuDto } from '../../../data/reality/01/menu-dto';
import { renderWithKit } from '../../../ui/test-utils';
import { MenuPanel, MenuDetail } from './menu';

const storeId = '11111111-1111-4111-8111-111111111111';
const item: MenuDto = {
  menuId: '22222222-2222-4222-8222-222222222222',
  name: 'HTTP 아메리카노', category: 'drink', price: 3100, saleStatus: 'selling',
  memo: null, prepMin: 3, photoKey: null, photoFileId: null, groups: [], recipeLines: [], recipeVersion: null, unitCost: null, revision: 1,
};
const loadingText = '화면을 준비하고 있어요';
const menuPath = `/api/v1/stores/${storeId}/inventory/menu`;
const menuUrl = `${menuPath}?limit=50`;
const salesUrl = `/api/v1/stores/${storeId}/pos/coupon-sales?businessDate=${TODAY}&view=today`;
const initialAuth = ['/api/v1/auth/refresh', '/api/v1/auth/demo'];
const list = (items: readonly MenuDto[]) => ({ items, nextCursor: null, asOf: '2026-11-21T10:00:00Z', sourceRevision: 1 });

function setup(mode: 'http' | 'fixture') {
  const readMenu = vi.fn<() => Promise<Response>>(async () => { throw new Error('Unexpected menu read'); });
  const writeMenu = vi.fn<(init?: RequestInit) => Promise<Response>>(async () => { throw new Error('Unexpected menu write'); });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/api/v1/auth/refresh') return Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
    if (url === '/api/v1/auth/demo') return Response.json({ accessToken: 'demo-access', expiresIn: 600, storeId });
    if (url === menuUrl) return readMenu();
    if (url === salesUrl) {
      return Response.json({ businessDate: TODAY, soldToday: [{ menuId: item.menuId, quantity: 12 }] });
    }
    if (url === menuPath && init?.method === 'POST' || url === `${menuPath}/${item.menuId}` && init?.method === 'PATCH') return writeMenu(init);
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: fetcher, source: () => mode, adapters: [menuAdapter] });
  store.bindReal(port);
  const host = {
    layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(),
    notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true),
  };
  const props = { host, featureId: 'menu' as const, condition: { kind: 'default' as const } };
  return {
    fetcher,
    readMenu,
    writeMenu,
    reloadMenu: () => port.retry('menu'),
    renderPanel: () => renderWithKit(<MenuPanel {...props} width={2} height={2} shape="Q" presetId="A" editing={false} />, { store }),
    renderDetail: (itemId?: string) => renderWithKit(<MenuDetail {...props} detailRef={{ featureId: 'menu', itemId }} />, { store, reducedMotion: true }),
  };
}

function holdResponse() {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>(complete => { resolve = complete; });
  return { response, resolve };
}

afterEach(cleanup);

it('keeps the same side panel DOM when the owner selects another menu row', async () => {
  const ui = setup('http');
  const other = { ...item, menuId: '33333333-3333-4333-8333-333333333333', name: 'HTTP 라테' };
  ui.readMenu.mockResolvedValueOnce(Response.json(list([item, other])));
  ui.renderDetail();
  fireEvent.click(await screen.findByRole('gridcell', { name: /HTTP 아메리카노, 메뉴 이름/ }));
  const panel = screen.getByRole('region', { name: item.name });
  fireEvent.click(screen.getByRole('gridcell', { name: /HTTP 라테, 메뉴 이름/ }));
  expect(screen.getByRole('region', { name: other.name })).toBe(panel);
  expect(panel).toBeInTheDocument();
});

it('shows the authoritative sold quantity from the POS day aggregate', async () => {
  const ui = setup('http');
  ui.readMenu.mockResolvedValueOnce(Response.json(list([item])));
  ui.renderDetail();
  const sold = await screen.findByText('12잔');
  expect(sold.closest('[data-grid-column-id="sold"]')).toBeInTheDocument();
});

it('creates a menu from the empty widget and waits for a committed read before showing it', async () => {
  const ui = setup('http');
  const write = holdResponse(), refresh = holdResponse();
  ui.readMenu.mockResolvedValueOnce(Response.json(list([]))).mockImplementationOnce(() => refresh.response);
  ui.writeMenu.mockImplementationOnce(() => write.response);
  ui.renderDetail();

  fireEvent.click(await screen.findByRole('button', { name: '메뉴 추가하기' }));
  const form = screen.getByRole('form', { name: '새 메뉴' });
  fireEvent.change(within(form).getByLabelText('메뉴 이름'), { target: { value: item.name } });
  fireEvent.change(within(form).getByLabelText('판매가'), { target: { value: '3100' } });
  fireEvent.click(within(form).getByRole('button', { name: '저장하기' }));
  await waitFor(() => expect(ui.writeMenu).toHaveBeenCalledOnce());
  expect(ui.writeMenu.mock.calls[0]?.[0]).toMatchObject({
    headers: { 'idempotency-key': expect.stringMatching(/^menu-create-/) },
    body: JSON.stringify({ name: item.name, category: 'beverage', price: 3100, memo: null }),
  });
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(within(form).getByRole('button', { name: '저장하기' })).toBeDisabled();
  expect(screen.queryByRole('gridcell', { name: /HTTP 아메리카노/ })).not.toBeInTheDocument();
  write.resolve(Response.json({ resourceId: item.menuId, revision: 1, receiptId: item.menuId, affectedSources: ['menu', 'pos'], changed: true }));
  await waitFor(() => expect(ui.readMenu).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('gridcell', { name: /HTTP 아메리카노/ })).not.toBeInTheDocument();
  refresh.resolve(Response.json(list([item])));

  expect(await screen.findByRole('gridcell', { name: /HTTP 아메리카노, 메뉴 이름/ })).toBeInTheDocument();
  expect(ui.writeMenu).toHaveBeenCalledOnce();
});

it('keeps the sale status on a stale write and requires another press with the re-read revision', async () => {
  const ui = setup('http');
  ui.readMenu.mockResolvedValueOnce(Response.json(list([item])))
    .mockResolvedValueOnce(Response.json(list([{ ...item, revision: 2 }])))
    .mockResolvedValueOnce(Response.json(list([{ ...item, revision: 3, saleStatus: 'sold_out' }])));
  ui.writeMenu.mockResolvedValueOnce(Response.json({ code: 'CONFLICT', reason: 'STALE_REVISION' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ resourceId: item.menuId, revision: 3, receiptId: item.menuId, affectedSources: ['menu'], changed: true }));
  ui.renderDetail(item.menuId);
  const soldOut = await screen.findByRole('radio', { name: '품절' });
  fireEvent.click(soldOut);
  expect(await screen.findByRole('alert')).toHaveTextContent('자료가 바뀌었어요');
  expect(soldOut).not.toBeChecked();
  expect(ui.writeMenu).toHaveBeenCalledOnce();

  fireEvent.click(soldOut);
  await waitFor(() => expect(soldOut).toBeChecked());
  expect(ui.writeMenu.mock.calls.map(([request]) => JSON.parse(String(request?.body)))).toEqual([
    { saleStatus: 'sold_out', expectedRevision: 1 }, { saleStatus: 'sold_out', expectedRevision: 2 },
  ]);
});

it.each(['renderPanel', 'renderDetail'] as const)('%s shows loading, then the HTTP empty state', async (view) => {
  const ui = setup('http');
  const catalog = holdResponse();
  ui.readMenu.mockImplementationOnce(() => catalog.response);
  ui[view]();
  expect(screen.getByRole('status')).toHaveTextContent(loadingText);
  await waitFor(() => expect(ui.fetcher).toHaveBeenCalledWith(menuUrl, expect.anything()));
  catalog.resolve(Response.json(list([])));
  expect(await screen.findByText('아직 등록한 메뉴가 없어요')).toBeInTheDocument();
  expect(screen.queryByText(loadingText)).not.toBeInTheDocument();
});

it.each(['renderPanel', 'renderDetail'] as const)('%s shows the HTTP error and retries the menu', async (view) => {
  const ui = setup('http');
  ui.readMenu
    .mockResolvedValueOnce(Response.json({ code: 'SERVICE_UNAVAILABLE' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json(list([item])));
  ui[view]();
  expect(await screen.findByText('메뉴를 불러오지 못했어요')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /다시 시도하기/ }));
  expect(await screen.findByText(item.name)).toBeInTheDocument();
  expect(ui.fetcher.mock.calls.map(([url]) => url)).toEqual([...initialAuth, menuUrl, menuUrl, salesUrl]);
});

it('keeps the ready panel and the focused, scrolled detail grid during refresh', async () => {
  const ui = setup('http');
  const refresh = holdResponse();
  ui.readMenu
    .mockResolvedValueOnce(Response.json(list([item])))
    .mockImplementationOnce(() => refresh.response);
  const detail = ui.renderDetail();
  const grid = await within(detail.container).findByRole('grid', { name: '메뉴 목록' });
  const cell = within(grid).getByRole('gridcell', { name: /HTTP 아메리카노, 메뉴 이름/ });
  const scroller = grid.closest('.ui-data-grid__scroll')!;
  const panel = ui.renderPanel();
  const panelRow = within(panel.container).getByText(item.name);
  act(() => {
    cell.focus();
    scroller.scrollTop = 48;
    scroller.scrollLeft = 32;
    void ui.reloadMenu();
  });

  expect(within(detail.container).getByRole('grid')).toBe(grid);
  expect(within(panel.container).getByText(item.name)).toBe(panelRow);
  expect(within(detail.container).getByText(loadingText)).toHaveAttribute('role', 'status');
  expect(within(panel.container).getByText(loadingText)).toHaveAttribute('role', 'status');
  expect(cell).toHaveFocus();
  expect(scroller.scrollTop).toBe(48);
  expect(scroller.scrollLeft).toBe(32);

  refresh.resolve(Response.json(list([{ ...item, name: '새 HTTP 아메리카노' }])));
  expect(await within(grid).findByText('새 HTTP 아메리카노')).toBeInTheDocument();
  expect(within(panel.container).getByText('새 HTTP 아메리카노')).toBe(panelRow);
  expect(screen.queryByText(loadingText)).not.toBeInTheDocument();
  expect(cell).toHaveFocus();
  expect(scroller.scrollTop).toBe(48);
  expect(scroller.scrollLeft).toBe(32);
  expect(ui.fetcher.mock.calls.map(([url]) => url)).toEqual([...initialAuth, menuUrl, salesUrl, menuUrl, salesUrl]);
});

it('renders the fixture panel and detail without any /api/v1 requests', () => {
  const ui = setup('fixture');
  const panel = ui.renderPanel();
  const detail = ui.renderDetail();
  expect(within(panel.container).getByText('등록한 메뉴')).toBeInTheDocument();
  expect(within(detail.container).getByRole('gridcell', { name: '아메리카노, 메뉴 이름, 아메리카노' })).toBeInTheDocument();
  expect(ui.fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/v1'))).toEqual([]);
});
