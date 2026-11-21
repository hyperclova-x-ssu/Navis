import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellSpan, PreviewSelection } from '../../../contracts';
import { createWidgetDataStore, readModel } from '../../../data/widget-data';
import { KitProviders, renderWithKit } from '../../../ui/test-utils';
import { DetailStack, SupplyPanel, createTestHost, moduleOf } from './testing';
import { BEANS, CUPS, MILK, OVERDUE_PO, itemOf, shortDate, supplyWeek } from './testing-cafe';
import { TODAY } from '../../../data/widget-data';
import { addIsoDays } from './shared';

afterEach(cleanup);
// The order grid holds the cafe's 128 past orders, so a screen that opens it takes longer than the default 5 s on a busy machine.
vi.setConfig({ testTimeout: 60_000 });
const preview = (family: PreviewSelection['family'], overrides: PreviewSelection['overrides'] = {}): PreviewSelection => ({ family, overrides });
const week = () => supplyWeek();
const panel = (width: CellSpan, height: CellSpan, opts: Parameters<typeof renderWithKit>[1] = {}, host = createTestHost('suppliers')) =>
  renderWithKit(<SupplyPanel id="suppliers" width={width} height={height} host={host} />, { store: week().store, ...opts });
const body = () => document.querySelector<HTMLElement>('[data-widget="suppliers"]')!;
const rowTexts = () => [...body().querySelectorAll('[data-row-id]')].map((r) => r.textContent);
/** Names come from the cafe tables, so a renamed seed item does not break the screen tests. */
const raw = (value: { name?: unknown } | undefined) => (value!.name as { raw: string }).raw;
const names = (store: ReturnType<typeof createWidgetDataStore>) => {
  const t = store.getSnapshot().tables, supplierOf = (itemId: string) => raw(t.supplier.find((v) => v.supplierId === t.purchaseItem.find((p) => p.itemId === itemId)!.supplierId));
  return { milk: raw(itemOf(t, MILK)), beans: raw(itemOf(t, BEANS)), cups: raw(itemOf(t, CUPS)), milkSupplier: supplierOf(MILK), beansSupplier: supplierOf(BEANS) };
};
const DOT = ' · ';

describe('suppliers panel (SCR-30, AC-273)', () => {
  it('1×1: 7일 내 입고 예정 3건 (ko, en, zh-Hant)', () => {
    panel(1, 1);
    expect(body()).toHaveTextContent('7일 내 입고 예정');
    expect(body().querySelector('.ui-metric-fit__value')).toHaveTextContent('3');
    expect(body().querySelector('.ui-metric-fit__unit')).toHaveTextContent('건');
    expect(body()).toHaveTextContent('입고 확인 필요 1건');
    cleanup();
    panel(1, 1, { locale: 'en' });
    expect(body()).toHaveTextContent('Deliveries due within 7 days');
    expect(body().querySelector('.ui-metric-fit__unit')).toHaveTextContent('orders');
    cleanup();
    panel(1, 1, { locale: 'zh-Hant' });
    expect(body()).toHaveTextContent('未來 7 天預計到貨');
    expect(body().querySelector('.ui-metric-fit__unit')).toHaveTextContent('筆訂單');
  });
  it('1×1 on the cafe seed alone: nothing is due in 7 days and nothing is overdue', () => {
    renderWithKit(<SupplyPanel id="suppliers" width={1} height={1} host={createTestHost('suppliers')} />, { store: createWidgetDataStore() });
    expect(body()).toHaveTextContent('7일 내 입고 예정');
    expect(body().querySelector('.ui-metric-fit__value')).toHaveTextContent('0');
    expect(body()).not.toHaveTextContent('입고 확인 필요');
  });
  it('2×1: 오늘 우유 · 한강목장 first; 1×2: 오늘 우유 12 L · 내일 원두 5 kg · 모레 컵 500개', () => {
    const { store } = week(), n = names(store);
    renderWithKit(<SupplyPanel id="suppliers" width={2} height={1} host={createTestHost('suppliers')} />, { store });
    expect(rowTexts()).toEqual([`오늘 ${n.milk}${DOT}${n.milkSupplier}`, `내일 ${n.beans}${DOT}${n.beansSupplier}`]);
    cleanup();
    renderWithKit(<SupplyPanel id="suppliers" width={1} height={2} host={createTestHost('suppliers')} />, { store });
    expect(rowTexts()).toEqual([`오늘 ${n.milk} 12 L`, `내일 ${n.beans} 5 kg`, `모레 ${n.cups} 500개`]);
    cleanup();
    renderWithKit(<SupplyPanel id="suppliers" width={1} height={2} host={createTestHost('suppliers')} />, { store, locale: 'en' });
    expect(rowTexts()).toEqual([`Today${DOT}${n.milk}${DOT}12 L`, `Tomorrow${DOT}${n.beans}${DOT}5 kg`, `In 2 days${DOT}${n.cups}${DOT}500 pcs`]);
  });
  it('2×2 shows upcoming orders and the suggestion/month summary', () => {
    panel(2, 2);
    expect(body()).toHaveTextContent('예정 입고');
    expect(body()).toHaveTextContent('발주 제안 0건');
    expect(body()).toHaveTextContent('이번 달 발주');
  });
  it('key sentence in ko and en, with the overdue count in the special state', () => {
    const { store } = week();
    const hook = (locale: 'ko' | 'en', p?: PreviewSelection) => renderHook(() => moduleOf('suppliers').useSummary({ featureId: 'suppliers', condition: { kind: 'default' } }), { wrapper: ({ children }) => <KitProviders locale={locale} preview={p} store={store}>{children}</KitProviders> });
    expect(hook('ko').result.current).toBe('7일 내 입고 예정 3건, 입고 확인 필요 1건');
    expect(hook('en').result.current).toBe('Deliveries due within 7 days: 3 orders, 1 delivery to check');
    expect(hook('ko', preview('special')).result.current).toBe('7일 내 입고 예정 3건, 입고 확인 필요 1건');
  });
});

describe('suppliers states (AC-274)', () => {
  it('special: 입고 확인 필요 1건 badge; empty: 거래처 등록; no-upcoming with the overdue count; error retry', () => {
    panel(1, 1, { preview: preview('special') });
    expect(body()).toHaveTextContent('입고 확인 필요 1건');
    cleanup();
    const onDetail = vi.fn();
    panel(1, 1, { preview: preview('empty') }, createTestHost('suppliers', { onDetail }));
    expect(screen.getByText('아직 등록한 발주사가 없어요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '발주사 추가하기, 발주' }));
    expect(onDetail).toHaveBeenCalledWith({ featureId: 'suppliers', view: 'register', focus: 'action' });
    cleanup();
    panel(1, 1, { preview: preview('normal', { suppliers: 'no-upcoming' }) });
    expect(body()).toHaveTextContent('7일 내 입고 예정이 없어요');
    expect(body()).toHaveTextContent('입고 확인 필요 1건');
    cleanup();
    const onReset = vi.fn();
    panel(1, 1, { preview: preview('error') }, createTestHost('suppliers', { onReset }));
    expect(screen.getByText('입고 일정을 불러오지 못했어요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기, 발주' }));
    expect(onReset).toHaveBeenCalledWith('suppliers');
  });
  it('발주사 추가하기는 새 원본을 만들고 undo로 제거할 수 있다', () => {
    const store = createWidgetDataStore();
    renderWithKit(<DetailStack root={{ featureId: 'suppliers', view: 'register' }} />, { store, locale: 'en' });
    fireEvent.change(within(screen.getByRole('form', { name: '발주사 추가하기' })).getByRole('textbox',{name:'발주사'}), { target: { value: '새 농장' } });
    fireEvent.change(screen.getByLabelText('담당'), { target: { value: '김사장' } });
    fireEvent.change(screen.getByLabelText('연락처'), { target: { value: '01012345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(store.getSnapshot().tables.supplier.some(r => r.name && 'raw' in r.name && r.name.raw === '새 농장')).toBe(true);
    expect(screen.getByRole('grid', { name: '발주사' })).toHaveTextContent('새 농장');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('grid', { name: '발주사' })).not.toHaveTextContent('새 농장');
  });
  it('발주사 추가하기: an empty name says 발주사 이름을 넣어 주세요 and saves nothing', () => {
    const store = createWidgetDataStore(), suppliers = store.getSnapshot().tables.supplier.length;
    renderWithKit(<DetailStack root={{ featureId: 'suppliers', view: 'register' }} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(within(screen.getByRole('form', { name: '발주사 추가하기' })).getByRole('alert')).toHaveTextContent('발주사 이름을 넣어 주세요');
    expect(store.getSnapshot().tables.supplier).toHaveLength(suppliers);
  });
});

describe('suppliers detail (SCR-31, AC-273, AC-236~238 order side)', () => {
  const open = (opts: Parameters<typeof renderWithKit>[1] = {}, events = {}, pick: 'milk' | 'none' = 'milk') => {
    const w = week(), store = opts.store ?? w.store;
    const root = pick === 'milk' ? { featureId: 'suppliers' as const, view: 'order', itemId: w.milk } : { featureId: 'suppliers' as const };
    const view = renderWithKit(<><DetailStack root={root} events={events} /><SupplyPanel id="suppliers" width={1} height={1} /></>, { ...opts, store });
    return { ...view, ...w, store, milkPo: w.milk };
  };

  it('발주 내역 표는 열린 주문이 먼저이고 선택 주문의 수량·금액·잔량을 보여준다', () => {
    const { store, milkPo } = open();
    const grid = screen.getByRole('grid', { name: '발주 내역' });
    const orders = readModel(store.getSnapshot(), 'suppliers').orders;
    expect(grid.querySelectorAll('[data-grid-row]')).toHaveLength(orders.length);
    // open orders first, the overdue one before the ones still to come, then the closed ones, newest first
    const ids = [...grid.querySelectorAll('[data-grid-row]')].map((r) => r.getAttribute('data-grid-row'));
    expect(ids.slice(0, 4)).toEqual([OVERDUE_PO, milkPo, expect.any(String), expect.any(String)]);
    expect(ids.slice(4, 6).every((id) => orders.find((o) => o.poId === id)!.status === 'complete')).toBe(true);
    const row = grid.querySelector(`[data-grid-row="${milkPo}"]`) as HTMLElement;
    const price = store.getSnapshot().tables.purchaseItem.find((p) => p.itemId === MILK)!.unitPrice;
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(within(row).getByRole('gridcell', { name: /주문 수량/ })).toHaveTextContent('12 L');
    expect(within(row).getByRole('gridcell', { name: /총 주문 금액/ })).toHaveTextContent(`${(12 * price).toLocaleString('en-US')}원`);
    expect(within(row).getByRole('gridcell', { name: /받은·남은 수량/ })).toHaveTextContent('0 / 12 L');
    expect(within(row).getByRole('gridcell', { name: /입고 예정일/ })).toHaveTextContent(shortDate(TODAY));
    fireEvent.click(screen.getByRole('tab', { name: '발주사' }));
    const dairy = store.getSnapshot().tables.supplier.find((v) => v.supplierId === 's-dairy')!;
    const supplier = screen.getByRole('grid', { name: '발주사' }).querySelector('[data-grid-row="s-dairy"]') as HTMLElement;
    expect(supplier).toHaveTextContent(dairy.phoneMask);
    expect(supplier).not.toHaveTextContent(/010-?\d{4}-?\d{4}/);
  });

  it('a multi-item order lists every item, quantity and received amount on its own line', () => {
    const { store } = open();
    const multi = readModel(store.getSnapshot(), 'suppliers').orders.find((o) => o.lines.length > 2)!;
    const row = screen.getByRole('grid', { name: '발주 내역' }).querySelector(`[data-grid-row="${multi.poId}"]`) as HTMLElement;
    const lines = (column: string) => [...row.querySelectorAll(`[data-grid-column-id="${column}"] .ms-lines > span`)].map((n) => n.textContent);
    expect(lines('item')).toEqual(multi.lines.map((l) => raw(itemOf(store.getSnapshot().tables, l.itemId))));
    expect(lines('qty')).toHaveLength(multi.lines.length);
    expect(lines('remaining')).toHaveLength(multi.lines.length);
  });

  it('reserves room for both order status chips at 125%', () => {
    const { store } = open({ textScale: 125, reducedMotion: true });
    const orders = within(screen.getByRole('grid', { name: '발주 내역' }));
    expect(orders.getByRole('columnheader', { name: '발주 상태' })).toHaveStyle({ minWidth: '328px' });
    const bagel = raw(itemOf(store.getSnapshot().tables, 'i-bagel-plain'));
    const status = orders.getByRole('gridcell', { name: new RegExp(`${bagel}, 발주 상태, 입고 대기 · 입고 확인 필요`) });
    expect([...status.querySelectorAll('.ui-status-chip')].map(chip => chip.textContent)).toEqual(['입고 대기', '입고 확인 필요']);
  });

  it('records 8 L: remaining 4 L, still due, one receipt for a double press, undo offered', () => {
    const onNotify = vi.fn();
    const { store, milkPo } = open({}, { onNotify });
    const stockBefore = readModel(store.getSnapshot(), 'inventory-booking').ingredients.find((r) => r.itemId === MILK)!.stock!;
    const amount = screen.getByRole('spinbutton', { name: '받은 수량' });
    expect(amount).toHaveValue(12);
    expect(screen.getByText('받은·남은 수량 12 L')).toBeInTheDocument();
    fireEvent.change(amount, { target: { value: '8' } });
    const record = screen.getByRole('button', { name: '입고 기록하기' });
    fireEvent.click(record);
    fireEvent.click(record);
    const tables = store.getSnapshot().tables, polIds = tables.purchaseOrderLine.filter((l) => l.poId === milkPo).map((l) => l.polId);
    expect(tables.receipt.filter((r) => polIds.includes(r.polId))).toHaveLength(1);
    // 8 L received = 8,000 mL on the shelf (the purchase unit is converted to the stock unit once)
    expect(readModel(store.getSnapshot(), 'inventory-booking').ingredients.find((r) => r.itemId === MILK)!.stock).toBe(stockBefore + 8000);
    expect(readModel(store.getSnapshot(), 'suppliers').upcomingCount).toBe(3);
    expect(screen.getByRole('button', { name: '입고 기록하기' })).toBeDisabled();
    expect(screen.getByText('입고를 기록했어요')).toBeInTheDocument();
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ messageKey: 'data.notice.receiptRecorded', undoToken: expect.any(String) }));
    const row = screen.getByRole('grid', { name: '발주 내역' }).querySelector(`[data-grid-row="${milkPo}"]`) as HTMLElement;
    expect(within(row).getByRole('gridcell', { name: /주문 수량/ })).toHaveTextContent('12 L');
    expect(within(row).getByRole('gridcell', { name: /받은·남은 수량/ })).toHaveTextContent('8 / 4 L');
    expect(screen.getAllByText('일부 입고').length).toBeGreaterThan(0);
  });

  it('cannot record more than what is left and says why once it is pressed up to the limit', () => {
    open();
    // it opens on the full remaining amount without a red sentence; going to the limit says why
    expect(screen.getByRole('button', { name: '늘리기' })).toBeDisabled();
    expect(screen.queryByText('남은 수량보다 많이 기록할 수 없어요')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '줄이기' }));
    expect(screen.getByRole('spinbutton', { name: '받은 수량' })).toHaveValue(11);
    fireEvent.click(screen.getByRole('button', { name: '늘리기' }));
    expect(screen.getByRole('button', { name: '늘리기' })).toBeDisabled();
    expect(screen.getByText('남은 수량보다 많이 기록할 수 없어요')).toBeInTheDocument();
  });

  it('changes the due date to tomorrow; the calendar delivery moves (AC-232, AC-273)', () => {
    const onNotify = vi.fn();
    const { store, milkPo } = open({}, { onNotify });
    const tomorrow = addIsoDays(TODAY, 1);
    const row = screen.getByRole('grid', { name: '발주 내역' }).querySelector(`[data-grid-row="${milkPo}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole('gridcell', { name: /입고 예정일/ }));
    const input = within(row).getByRole('textbox');
    fireEvent.change(input, { target: { value: tomorrow } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const calendar = readModel(store.getSnapshot(), 'calendar');
    expect(calendar.todayEntries.some((e) => e.sourceId === milkPo)).toBe(false);
    expect(calendar.weekEntries.find((e) => e.sourceId === milkPo)!.date).toBe(tomorrow);
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({ messageKey: 'data.notice.dueDateChanged', undoToken: expect.any(String) }));
    expect(within(row).getByRole('gridcell', { name: /입고 예정일/ })).toHaveTextContent(shortDate(tomorrow));
  });

  it('with nothing due in 7 days the detail says so and offers 발주 추가하기 (H1)', () => {
    const onReset = vi.fn();
    open({ preview: preview('normal', { suppliers: 'no-upcoming' }) }, { onReset }, 'none');
    const detail = within(screen.getByRole('region', { name: 'detail:suppliers' }));
    expect(detail.getByText('7일 내 입고 예정이 없어요')).toBeInTheDocument();
    expect(detail.getByText('입고 확인 필요 1건')).toBeInTheDocument();
    fireEvent.click(detail.getByRole('button', { name: '발주 추가하기' }));
    expect(onReset).toHaveBeenCalledWith('suppliers');
  });

  it('the special state on the cafe seed alone shows PRD 2.4.7\'s 12 L milk order due yesterday first as ‘입고 확인 필요’, the same one the panel counts', () => {
    const store = createWidgetDataStore();
    const real = readModel(store.getSnapshot(), 'suppliers');
    expect(real.overdueCount).toBe(0);
    open({ store, preview: preview('special') }, {}, 'none');
    const detail = within(screen.getByRole('region', { name: 'detail:suppliers' }));
    const grid = detail.getByRole('grid', { name: '발주 내역' });
    const rows = [...grid.querySelectorAll<HTMLElement>('[data-grid-row]')];
    expect(rows).toHaveLength(real.orders.length + 1);
    const first = rows[0]!;
    expect(first).toHaveTextContent('입고 확인 필요');
    expect(first).toHaveTextContent(names(store).milk);
    expect(within(first).getByRole('gridcell', { name: /주문 수량/ })).toHaveTextContent('12 L');
    expect(within(first).getByRole('gridcell', { name: /입고 예정일/ })).toHaveTextContent(shortDate(addIsoDays(TODAY, -1)));
    expect(within(first).getByRole('gridcell', { name: /받은·남은 수량/ })).toHaveTextContent('0 / 12 L');
    // only the example is overdue: every other row is the cafe's own
    expect(rows.slice(1).some((row) => row.textContent?.includes('입고 확인 필요'))).toBe(false);
    expect(document.querySelector('.ui-feature-panel [data-widget="suppliers"]')).toHaveTextContent('입고 확인 필요 1건');
  });

  it('the special state shows the overdue order first as ‘입고 확인 필요’; error offers retry', () => {
    const { store } = open({ preview: preview('special') }, {}, 'none');
    const grid = screen.getByRole('grid', { name: '발주 내역' });
    const ids = [...grid.querySelectorAll('[data-grid-row]')].map(r=>r.getAttribute('data-grid-row'));
    expect(ids[0]).toBe(OVERDUE_PO);
    expect(grid.querySelector(`[data-grid-row="${OVERDUE_PO}"]`)).toHaveTextContent('입고 확인 필요');
    expect(readModel(store.getSnapshot(), 'suppliers').overdueCount).toBe(1);
    cleanup();
    const onReset = vi.fn();
    open({ preview: preview('error') }, { onReset });
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
    expect(onReset).toHaveBeenCalledWith('suppliers');
  });
});
