import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellSpan, PreviewSelection } from '../../../contracts';
import { useWidgetView } from '../../../data/react';
import { createWidgetDataStore, readModel } from '../../../data/widget-data';
import { KitProviders, renderWithKit } from '../../../ui/test-utils';
import { DetailStack, SupplyPanel, createTestHost, moduleOf } from './testing';
import { BEANS, CUPS, MILK, itemOf, placeOrder, shortage, withRetail } from './testing-cafe';
import { TODAY } from '../../../data/widget-data';
import { addIsoDays } from './shared';

afterEach(cleanup);
// The cafe seed holds 26 ingredients, so a screen that opens the grid takes longer than the default 5 s on a busy machine.
vi.setConfig({ testTimeout: 60_000 });
const preview = (family: PreviewSelection['family'], overrides: PreviewSelection['overrides'] = {}): PreviewSelection => ({ family, overrides });
/** The cafe seed has nothing to restock and no retail product: this is the screens' shortage (milk out, beans and cups low) plus two retail items. */
const staged = () => shortage(withRetail().store);
const raw = (store: ReturnType<typeof createWidgetDataStore>, itemId: string) => (itemOf(store.getSnapshot().tables, itemId).name as { raw: string }).raw;
const panel = (width: CellSpan, height: CellSpan, opts: Parameters<typeof renderWithKit>[1] = {}, host = createTestHost('inventory-booking')) =>
  renderWithKit(<SupplyPanel id="inventory-booking" width={width} height={height} host={host} />, { store: staged().store, ...opts });
const body = () => document.querySelector<HTMLElement>('[data-widget="inventory-booking"]')!;
const rowTexts = () => [...body().querySelectorAll('[data-row-id]')].map((r) => r.textContent);
const model = (store: ReturnType<typeof createWidgetDataStore>) => readModel(store.getSnapshot(), 'inventory-booking');
const grams = (n: number) => `${n.toLocaleString('en-US')} g`;
const mL = (n: number) => `${n.toLocaleString('en-US')} mL`;

/** Reads the sell-today coupon from the same store (the marketing widget is another owner's; its model is the source). */
function ExpiryProbe() {
  const view = useWidgetView('expiry-coupon');
  return <output aria-label="expiry-probe">{view.status === 'ready' ? view.model.target?.qty ?? 0 : view.status}</output>;
}

describe('inventory panel (SCR-30·32, AC-268·269)', () => {
  it('1×1 counts ingredients only: 보충 필요 3개 품목, 품절 1개 품목 (ko, en, zh-Hant)', () => {
    panel(1, 1);
    expect(body()).toHaveTextContent('보충 필요');
    expect(body().querySelector('.ui-metric-fit__value')).toHaveTextContent('3');
    expect(body().querySelector('.ui-metric-fit__unit')).toHaveTextContent('개 품목');
    expect(body()).toHaveTextContent('품절 1개 품목');
    expect(body()).not.toHaveTextContent('248');
    cleanup();
    panel(1, 1, { locale: 'en' });
    expect(body()).toHaveTextContent('Needs restocking');
    expect(body().querySelector('.ui-metric-fit__unit')).toHaveTextContent('items');
    expect(body()).toHaveTextContent('1 item out of stock');
    cleanup();
    panel(1, 1, { locale: 'zh-Hant' });
    expect(body()).toHaveTextContent('需要補貨');
    expect(body().querySelector('.ui-metric-fit__unit')).toHaveTextContent('種商品');
  });

  it('on the cafe seed alone nothing needs restocking', () => {
    renderWithKit(<SupplyPanel id="inventory-booking" width={1} height={1} host={createTestHost('inventory-booking')} />, { store: createWidgetDataStore() });
    expect(body().querySelector('.ui-metric-fit__value')).toHaveTextContent('0');
    expect(body()).toHaveTextContent('보충이 필요한 품목이 없어요');
  });

  it('places the current value before its label and shows the 3×2 stock table and channel split', () => {
    panel(3, 2);
    const value = body().querySelector('[data-slot="inventory-booking.metric.value"]')!;
    const label = body().querySelector('[data-slot="inventory-booking.metric.label"]')!;
    expect(value.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const table = screen.getByRole('table', { name: '원자재' });
    for (const header of ['이름', '현재 재고', '안전 재고', '상태', '오늘 사용량']) expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    expect(table).toHaveTextContent('품절');
    expect(screen.getByRole('img', { name: '매장 180개, 온라인 68개' })).toBeInTheDocument();
  });

  it('1×2 lists stock / threshold out of stock first and never the sell-today items', () => {
    const { store } = staged(), milk = raw(store, MILK), beans = raw(store, BEANS), cups = raw(store, CUPS);
    renderWithKit(<SupplyPanel id="inventory-booking" width={1} height={2} host={createTestHost('inventory-booking')} />, { store });
    expect(rowTexts()).toEqual([`${milk}품절0 mL안전 재고 12,000 mL`, `${beans}3,000 g안전 재고 4,000 g`, `${cups}400개안전 재고 500개`]);
    expect(body()).not.toHaveTextContent(raw(store, 'i-basque-cake'));
    cleanup();
    renderWithKit(<SupplyPanel id="inventory-booking" width={1} height={2} host={createTestHost('inventory-booking')} />, { store, locale: 'en' });
    expect(rowTexts()[0]).toBe(`${milk}Out of stock0 mLThreshold 12,000 mL`);
  });

  it('2×1 shows the ingredient row and the products line (248 = 180 + 68)', () => {
    const { store } = staged();
    renderWithKit(<SupplyPanel id="inventory-booking" width={2} height={1} host={createTestHost('inventory-booking')} />, { store });
    expect(rowTexts()).toEqual([`재료${raw(store, MILK)}품절0 mL안전 재고 12,000 mL`, '판매 상품248개매장 180 · 온라인 68']);
    const products = body().querySelector('[data-row-id="products"]')!;
    expect(Number(products.getAttribute('data-drop'))).toBeGreaterThan(Number(body().querySelector(`[data-row-id="${MILK}"]`)!.getAttribute('data-drop')));
  });

  it('2×2 shows the store / online split bar and two kinds of rows; 3×3 the products list', () => {
    const { store } = staged();
    renderWithKit(<SupplyPanel id="inventory-booking" width={2} height={2} host={createTestHost('inventory-booking')} />, { store });
    expect(screen.getByRole('img', { name: '매장 180개, 온라인 68개' })).toBeInTheDocument();
    expect(body()).toHaveTextContent('전체 재고 248개');
    // the order is in litres: 12 L due today
    expect(body()).toHaveTextContent('오늘 12 L 입고 예정');
    cleanup();
    renderWithKit(<SupplyPanel id="inventory-booking" width={3} height={3} host={createTestHost('inventory-booking')} />, { store, locale: 'en' });
    const table = screen.getByRole('table', { name: '원자재' });
    expect(table).toHaveTextContent(raw(store, BEANS));
    expect(body()).toHaveTextContent('보충 필요');
    expect(table).toHaveTextContent(grams(3000));
    expect(table).toHaveTextContent(mL(model(store).ingredients.find((r) => r.itemId === MILK)!.usedToday));
  });

  it('key sentence (accessible name) in ko and en', () => {
    const { store } = staged();
    const hook = (locale: 'ko' | 'en') => renderHook(() => moduleOf('inventory-booking').useSummary({ featureId: 'inventory-booking', condition: { kind: 'default' } }), { wrapper: ({ children }) => <KitProviders locale={locale} store={store}>{children}</KitProviders> });
    expect(hook('ko').result.current).toBe('보충 필요 3개 품목, 품절 1개 품목');
    expect(hook('en').result.current).toBe('Needs restocking: 3 items, 1 out of stock');
  });
});

describe('inventory states (AC-272, DS 11.5)', () => {
  it('empty: ‘아직 등록한 품목이 없어요’ + ‘품목 추가하기’ opens the detail form', () => {
    const onDetail = vi.fn();
    panel(1, 1, { preview: preview('empty') }, createTestHost('inventory-booking', { onDetail }));
    expect(screen.getByText('아직 등록한 품목이 없어요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '품목 추가하기, 재고' }));
    expect(onDetail).toHaveBeenCalledWith({ featureId: 'inventory-booking', view: 'register', focus: 'action' });
  });
  it('partial: ‘확인된 품목 중 보충 필요 0개’ with ‘확인 필요’, never a bare 0', () => {
    panel(1, 1, { preview: preview('normal', { 'inventory-booking': 'partial-zero' }) });
    expect(body()).toHaveTextContent('확인된 품목 중 보충 필요 0개');
    expect(body()).toHaveTextContent('확인 필요');
    expect(body().querySelector('.ui-metric-fit')).toBeNull();
  });
  it('needs-review, no-restock, no-products and error', () => {
    panel(1, 1, { preview: preview('normal', { 'inventory-booking': 'needs-review' }) });
    expect(screen.getByText('현재 재고와 안전 재고를 확인해 주세요')).toBeInTheDocument();
    cleanup();
    panel(1, 1, { preview: preview('normal', { 'inventory-booking': 'no-restock' }) });
    expect(body()).toHaveTextContent('보충이 필요한 품목이 없어요');
    cleanup();
    panel(2, 1, { preview: preview('normal', { 'inventory-booking': 'no-products' }) });
    expect(body()).toHaveTextContent('아직 등록한 판매 상품이 없어요');
    cleanup();
    const onReset = vi.fn();
    panel(1, 1, { preview: preview('error') }, createTestHost('inventory-booking', { onReset }));
    expect(screen.getByText('재고를 불러오지 못했어요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기, 재고' }));
    expect(onReset).toHaveBeenCalledWith('inventory-booking');
  });
  it('품목 추가하기은 실제 새 원자재와 처음 등록 기록을 만들고 undo를 제공한다', () => {
    const onNotify = vi.fn(), store = createWidgetDataStore();
    renderWithKit(<DetailStack root={{ featureId: 'inventory-booking', view: 'register', focus: 'action' }} events={{ onNotify }} />, { store });
    fireEvent.change(screen.getByLabelText('코드(SKU)'), { target: { value: 'RM-NEW' } });
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '시럽' } });
    fireEvent.change(screen.getByLabelText('처음 수량'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    const item = store.getSnapshot().tables.inventoryItem.find(i => i.sku === 'RM-NEW');
    expect(item).toBeTruthy();
    expect(store.getSnapshot().tables.stockAdjustment.filter(a => a.itemId === item?.itemId)).toMatchObject([{ reason: 'initial', deltaBase: 2 }]);
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ undoToken: expect.any(String) }));
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    expect(store.getSnapshot().tables.inventoryItem.some(i => i.sku === 'RM-NEW' && !i.deletedAt)).toBe(false);
  });
  it('품목 추가하기: each empty or wrong field says what to enter and nothing is saved (AC-1046, AC-1049)', () => {
    const store = createWidgetDataStore(), revision = store.getSnapshot().revision;
    renderWithKit(<DetailStack root={{ featureId: 'inventory-booking', view: 'register', focus: 'action' }} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    const form = within(screen.getByRole('form', { name: '품목 추가하기' }));
    expect(form.getAllByRole('alert').map((a) => a.textContent)).toEqual([expect.stringContaining('코드(SKU)를 넣어 주세요'), expect.stringContaining('이름을 넣어 주세요')]);
    expect(form.getByLabelText('코드(SKU)')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(form.getByLabelText('코드(SKU)'), { target: { value: 'RM-NEW' } });
    fireEvent.change(form.getByLabelText('이름'), { target: { value: '시럽' } });
    fireEvent.change(form.getByLabelText('처음 수량'), { target: { value: '-1' } });
    fireEvent.change(form.getByLabelText('안전 재고'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(form.getAllByRole('alert').map((a) => a.textContent)).toEqual([expect.stringContaining('0 이상의 숫자를 넣어 주세요'), expect.stringContaining('0 이상의 숫자를 넣어 주세요')]);
    expect(store.getSnapshot().revision).toBe(revision);
  });
});

describe('inventory detail: 재료 | 판매 상품 (SCR-32, AC-268~270, plan-2 8.13)', () => {
  const open = (opts: Parameters<typeof renderWithKit>[1] = {}, events = {}) => {
    const { store, poId } = opts.store ? { store: opts.store, poId: '' } : staged();
    const view = renderWithKit(<><DetailStack root={{ featureId: 'inventory-booking' }} events={events} /><SupplyPanel id="inventory-booking" width={1} height={1} /><ExpiryProbe /></>, { ...opts, store });
    return { ...view, store, poId };
  };
  const SELL_TODAY = 'i-basque-cake';

  it('원자재 표는 상태 순이며 당일 소진은 보충 필요 집계에 섞이지 않는다', () => {
    const { store } = open();
    const grid = screen.getByRole('grid', { name: '재료' });
    const ids = [...grid.querySelectorAll('[data-grid-row]')].map(r => r.getAttribute('data-grid-row'));
    expect(ids).toHaveLength(26);
    expect(ids.slice(0, 3)).toEqual([MILK, BEANS, CUPS]);
    expect(ids.slice(-2).sort()).toEqual(['i-basque-cake', 'i-saltbread']);
    const sellToday = grid.querySelector(`[data-grid-row="${SELL_TODAY}"]`) as HTMLElement;
    expect(within(sellToday).getByRole('gridcell', { name: /현재 재고/ })).toHaveTextContent('18개');
    expect(sellToday).toHaveTextContent('당일 소진');
    expect(sellToday).toHaveTextContent('오늘까지');
    expect(model(store).restockCount).toBe(3);
    expect(document.querySelector('[data-widget="inventory-booking"] .ui-metric-fit__value')).toHaveTextContent('3');
  });

  it('numbers carry their unit behind them in the stock unit (g, mL, 개) and there is no separate 단위 column (DS 12.1)', () => {
    open();
    const grid = screen.getByRole('grid', { name: '재료' });
    expect(within(grid).queryByRole('columnheader', { name: '단위' })).toBeNull();
    const beans = grid.querySelector(`[data-grid-row="${BEANS}"]`) as HTMLElement;
    expect(within(beans).getByRole('gridcell', { name: /현재 재고/ })).toHaveTextContent(grams(3000));
    expect(within(beans).getByRole('gridcell', { name: /안전 재고/ })).toHaveTextContent(grams(4000));
    const used = model(createWidgetDataStore()).ingredients.find((r) => r.itemId === BEANS)!.usedToday;
    expect(within(beans).getByRole('gridcell', { name: /오늘 사용량/ })).toHaveTextContent(grams(used));
  });

  it('reserves width for the longest inventory status and history chips at 125%', () => {
    const { store } = open({ textScale: 125, reducedMotion: true });
    const sellToday = raw(store, SELL_TODAY);
    const ingredients = screen.getByRole('grid', { name: '재료' });
    const statusHeader = within(ingredients).getByRole('columnheader', { name: '상태' });
    expect(statusHeader).toHaveStyle({ minWidth: '232px' });
    const status = within(ingredients).getByRole('gridcell', { name: new RegExp(`${sellToday.replace(/[()]/g, '\\$&')}, 상태, 당일 소진`) });
    expect(status).toHaveTextContent('당일 소진');
    expect(status).toHaveTextContent('오늘까지');

    fireEvent.click(within(ingredients).getByRole('button', { name: `${sellToday} 재고 변동 기록` }));
    const history = screen.getByRole('grid', { name: new RegExp(`${sellToday.replace(/[()]/g, '\\$&')} 재고 변동 기록`) });
    expect(within(history).getByRole('columnheader', { name: '종류' })).toHaveStyle({ minWidth: '176px' });

    fireEvent.click(screen.getByRole('tab', { name: '판매 상품' }));
    const products = screen.getByRole('grid', { name: '판매 상품' });
    expect(within(products).getByRole('columnheader', { name: '상태' })).toHaveStyle({ minWidth: '176px' });
    expect(within(products).getByRole('gridcell', { name: /상태, 보충 필요/ })).toBeInTheDocument();
  });

  it('products tab: 248 = 180 + 68 per product, 7-day sales, running low, sell-today items excluded (AC-269)', () => {
    open();
    fireEvent.click(screen.getByRole('tab', { name: '판매 상품' }));
    expect(screen.getByText('248개')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '매장 180개, 온라인 68개' })).toBeInTheDocument();
    expect(screen.getByText('당일 소진 품목은 포함하지 않아요')).toBeInTheDocument();
    const table = screen.getByRole('grid', { name: '판매 상품' });
    const rows = [...table.querySelectorAll('[data-grid-row]')].map(r => [...r.querySelectorAll('.ui-data-grid__value')].map(c => c.textContent!.replace(/\s+/g, ' ').trim()));
    expect(rows).toEqual([['원두 200g', '120', '40', '160', '52', '충분'], ['드립백 세트', '60', '28', '88', '36', '보충 필요']]);
    expect(table).not.toHaveTextContent('바스크');
  });

  it('on the cafe seed alone the 판매 상품 tab says there is no product yet without an unsupported product-registration action', () => {
    open({ store: createWidgetDataStore() });
    fireEvent.click(screen.getByRole('tab', { name: '판매 상품' }));
    expect(screen.getByText('아직 등록한 판매 상품이 없어요')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '상품 추가하기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('grid', { name: '판매 상품' })).not.toBeInTheDocument();
  });

  it('moves 20 from store to online: 160 / 88, total 248, undo offered; a double press moves once (AC-270)', () => {
    const onNotify = vi.fn();
    const { store } = open({}, { onNotify });
    fireEvent.click(screen.getByRole('tab', { name: '판매 상품' }));
    fireEvent.click(screen.getByRole('grid', { name: '판매 상품' }).querySelector('[data-grid-row="it-beans200"] [data-grid-column-id="name"]')!);
    fireEvent.change(screen.getByRole('spinbutton', { name: '매장 → 온라인' }), { target: { value: '20' } });
    const move = screen.getByRole('button', { name: '옮기기' });
    act(() => { move.click(); move.click(); });
    const products = model(store).products;
    expect(products.byChannel).toEqual({ store: 160, online: 88 });
    expect(products.total).toBe(248);
    expect(screen.getByRole('img', { name: '매장 160개, 온라인 88개' })).toBeInTheDocument();
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ messageKey: 'data.notice.channelMoved', undoToken: expect.any(String) }));
    fireEvent.click(within(screen.getByRole('list', { name: 'notices' })).getByRole('button', { name: '되돌리기' }));
    expect(model(store).products.byChannel).toEqual({ store: 180, online: 68 });
  });

  it('editing a sell-today count changes the sell-today coupon count (AC-294·317)', () => {
    const { store } = open();
    const coupons = Number(screen.getByLabelText('expiry-probe').textContent);
    expect(coupons).toBeGreaterThan(0);
    // the coupon counts what can still be sold of the expiring batch (8 of the 18 on the shelf), so it follows an edit below that batch
    const batch = readModel(store.getSnapshot(), 'expiry-coupon').target!.stock;
    const row = screen.getByRole('grid', { name: '재료' }).querySelector(`[data-grid-row="${SELL_TODAY}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole('gridcell', { name: /현재 재고/ }));
    const field = within(row).getByRole('textbox');
    expect(field).toHaveValue(String(model(store).ingredients.find((r) => r.itemId === SELL_TODAY)!.stock));
    fireEvent.change(field, { target: { value: String(batch - 1) } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByLabelText('expiry-probe')).toHaveTextContent(String(coupons - 1));
    // the sell-today items stay out of the product total (AC-269)
    expect(model(store).products.total).toBe(248);
  });

  it('edits stock and threshold of an ingredient (restock 3 → 2 when milk is 13,000 mL)', () => {
    const onNotify = vi.fn();
    const { store } = open({}, { onNotify });
    const row = screen.getByRole('grid', { name: '재료' }).querySelector(`[data-grid-row="${MILK}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole('gridcell', { name: /현재 재고/ }));
    let field = within(row).getByRole('textbox');
    fireEvent.change(field, { target: { value: '13000' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(model(store).restockCount).toBe(2);
    expect(document.querySelector('[data-widget="inventory-booking"] .ui-metric-fit__value')).toHaveTextContent('2');
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ messageKey: 'data.notice.itemUpdated', undoToken: expect.any(String) }));
    fireEvent.click(within(row).getByRole('gridcell', { name: /안전 재고/ }));
    field = within(row).getByRole('textbox');
    fireEvent.change(field, { target: { value: '-1' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('0 이상의 숫자를 넣어 주세요');
    expect(model(store).ingredients.find(i => i.itemId === MILK)?.threshold).toBe(12000);
  });

  it('opens the nearest supplier order through the secondary action', () => {
    const onLinked = vi.fn();
    const { poId } = open({}, { onLinked });
    const grid = within(screen.getByRole('grid', { name: '재료' }));
    expect(grid.getByRole('columnheader', { name: '발주 보기' })).toBeInTheDocument();
    const button = grid.getByRole('button', { name: '발주 보기' });
    expect(button).toHaveClass('ui-button--secondary');
    fireEvent.click(button);
    expect(onLinked).toHaveBeenCalledExactlyOnceWith({ featureId: 'suppliers', view: 'order', itemId: poId });
  });

  it('keeps the purchase unit in the expanded nearest-delivery link', () => {
    const { store } = staged();
    placeOrder(store, BEANS, 5, addIsoDays(TODAY, 1));
    open({ store });
    const grid = within(screen.getByRole('grid', { name: '재료' }));
    fireEvent.click(grid.getByRole('button', { name: `${raw(store, BEANS)} 재고 변동 기록` }));
    expect(grid.getByRole('button', { name: /^5 kg · / })).toBeInTheDocument();
  });

  it.each(['Enter', ' '])('opens a linked order with %j from the focused grid cell', key => {
    const onLinked = vi.fn();
    const { store, poId } = open({}, { onLinked });
    const cell = screen.getByRole('gridcell', { name: `${raw(store, MILK)}, 발주 보기, 발주 보기` });
    act(() => cell.focus());
    expect(cell).toHaveFocus();
    fireEvent.keyDown(cell, { key });
    expect(onLinked).toHaveBeenCalledExactlyOnceWith({ featureId: 'suppliers', view: 'order', itemId: poId });
  });

  it('renders a dash for an ingredient without an order', () => {
    open();
    const cell = screen.getAllByRole('gridcell', { name: /발주 보기, —$/ })[0]!;
    expect(cell).toHaveTextContent(/^—$/);
    expect(cell.querySelector('button, a, svg')).toBeNull();
  });

  it('a search that matches nothing offers 검색어 지우기 and the search box says it finds by name or code', () => {
    open();
    const search = screen.getAllByRole('searchbox')[0] ?? screen.getAllByRole('textbox', { name: /이름이나 코드로/ })[0]!;
    expect(search).toHaveAttribute('placeholder', '이름이나 코드로 찾아보세요');
    fireEvent.change(search, { target: { value: '없는 품목' } });
    expect(screen.getByText('찾는 항목이 없어요')).toBeInTheDocument();
    fireEvent.click(within(document.querySelector<HTMLElement>('.ui-data-grid__empty')!).getByRole('button', { name: '검색어 지우기' }));
    expect(screen.getByRole('grid', { name: '재료' }).querySelectorAll('[data-grid-row]')).toHaveLength(26);
    // the SKU is searched too (RM-004 is the milk)
    fireEvent.change(search, { target: { value: 'RM-004' } });
    expect([...screen.getByRole('grid', { name: '재료' }).querySelectorAll('[data-grid-row]')].map((r) => r.getAttribute('data-grid-row'))).toEqual([MILK]);
  });

  it('the needs-review sample state offers 재고 다시 확인하기 in the detail, not only a sentence (H1)', () => {
    const onReset = vi.fn();
    renderWithKit(<DetailStack root={{ featureId: 'inventory-booking' }} events={{ onReset }} />, { preview: preview('normal', { 'inventory-booking': 'needs-review' }) });
    expect(screen.getByText('현재 재고와 안전 재고를 확인해 주세요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '재고 다시 확인하기' }));
    expect(onReset).toHaveBeenCalledWith('inventory-booking');
  });

  it('error and no-products states in the detail', () => {
    const onReset = vi.fn();
    renderWithKit(<DetailStack root={{ featureId: 'inventory-booking' }} events={{ onReset }} />, { preview: preview('error') });
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
    expect(onReset).toHaveBeenCalledWith('inventory-booking');
    cleanup();
    renderWithKit(<DetailStack root={{ featureId: 'inventory-booking', view: 'products' }} />, { preview: preview('normal', { 'inventory-booking': 'no-products' }), locale: 'zh-Hans' });
    expect(screen.getByText('尚未添加在售商品')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加在售商品' })).not.toBeInTheDocument();
  });
});
