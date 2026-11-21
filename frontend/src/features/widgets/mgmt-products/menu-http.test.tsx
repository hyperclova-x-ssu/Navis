import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const storeId = '11111111-1111-4111-8111-111111111111';
const item = {
  menuId: '22222222-2222-4222-8222-222222222222',
  name: 'HTTP 아메리카노', category: 'drink', price: 3100, saleStatus: 'selling',
};
const loadingText = '화면을 준비하고 있어요';
const catalogUrl = `/api/v1/inventory/catalog?storeId=${storeId}`;

async function setup(mode: 'http' | 'fixture') {
  vi.resetModules();
  vi.stubEnv('VITE_NAVIS_DATA_SOURCE', mode);
  const readCatalog = vi.fn<() => Promise<Response>>(async () => { throw new Error('Unexpected catalog read'); });
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (url === '/api/v1/auth/demo') return Response.json({ accessToken: 'demo-access', expiresIn: 600, storeId });
    if (url === catalogUrl) return readCatalog();
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const { MenuPanel, MenuDetail } = await import('./menu');
  const { reloadBackendCatalog } = await import('../../../data/backend-catalog/react');
  const { renderWithKit } = await import('../../../ui/test-utils');
  const host = {
    layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(),
    notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true),
  };
  const props = { host, featureId: 'menu' as const, condition: { kind: 'default' as const } };
  return {
    fetcher,
    readCatalog,
    reloadBackendCatalog,
    renderPanel: () => renderWithKit(<MenuPanel {...props} width={2} height={2} shape="Q" presetId="A" editing={false} />),
    renderDetail: () => renderWithKit(<MenuDetail {...props} detailRef={{ featureId: 'menu' }} />, { reducedMotion: true }),
  };
}

function holdResponse() {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>(complete => { resolve = complete; });
  return { response, resolve };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(['renderPanel', 'renderDetail'] as const)('%s shows loading, then the HTTP empty state', async (view) => {
  const ui = await setup('http');
  const catalog = holdResponse();
  ui.readCatalog.mockImplementationOnce(() => catalog.response);
  ui[view]();
  expect(screen.getByRole('status')).toHaveTextContent(loadingText);
  await waitFor(() => expect(ui.fetcher).toHaveBeenCalledWith(catalogUrl, expect.anything()));
  catalog.resolve(Response.json({ items: [] }));
  expect(await screen.findByText('아직 등록한 메뉴가 없어요')).toBeInTheDocument();
  expect(screen.queryByText(loadingText)).not.toBeInTheDocument();
});

it.each(['renderPanel', 'renderDetail'] as const)('%s shows the HTTP error and retries the catalog', async (view) => {
  const ui = await setup('http');
  ui.readCatalog
    .mockResolvedValueOnce(Response.json({ code: 'SERVICE_UNAVAILABLE' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ items: [item] }));
  ui[view]();
  expect(await screen.findByText('메뉴를 불러오지 못했어요')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /다시 시도하기/ }));
  expect(await screen.findByText(item.name)).toBeInTheDocument();
  expect(ui.fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/v1/auth/demo', catalogUrl, catalogUrl]);
});

it('keeps the ready panel and the focused, scrolled detail grid during refresh', async () => {
  const ui = await setup('http');
  const refresh = holdResponse();
  ui.readCatalog
    .mockResolvedValueOnce(Response.json({ items: [item] }))
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
    ui.reloadBackendCatalog();
    ui.reloadBackendCatalog();
  });

  expect(within(detail.container).getByRole('grid')).toBe(grid);
  expect(within(panel.container).getByText(item.name)).toBe(panelRow);
  expect(within(detail.container).getByText(loadingText)).toHaveAttribute('role', 'status');
  expect(within(panel.container).getByText(loadingText)).toHaveAttribute('role', 'status');
  expect(cell).toHaveFocus();
  expect(scroller.scrollTop).toBe(48);
  expect(scroller.scrollLeft).toBe(32);

  refresh.resolve(Response.json({ items: [{ ...item, name: '새 HTTP 아메리카노' }] }));
  expect(await within(grid).findByText('새 HTTP 아메리카노')).toBeInTheDocument();
  expect(within(panel.container).getByText('새 HTTP 아메리카노')).toBe(panelRow);
  expect(screen.queryByText(loadingText)).not.toBeInTheDocument();
  expect(cell).toHaveFocus();
  expect(scroller.scrollTop).toBe(48);
  expect(scroller.scrollLeft).toBe(32);
  expect(ui.fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/v1/auth/demo', catalogUrl, catalogUrl]);
});

it('renders the fixture panel and detail without any /api/v1 requests', async () => {
  const ui = await setup('fixture');
  const panel = ui.renderPanel();
  const detail = ui.renderDetail();
  expect(within(panel.container).getByText('등록한 메뉴')).toBeInTheDocument();
  expect(within(detail.container).getByRole('gridcell', { name: '아메리카노, 메뉴 이름, 아메리카노' })).toBeInTheDocument();
  expect(ui.fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/v1'))).toEqual([]);
});
