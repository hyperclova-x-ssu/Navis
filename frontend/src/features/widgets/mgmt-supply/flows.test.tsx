/**
 * Screen-level flows across the three widgets on one store (F-25, AC-232·236·237·238·239), on the cafe seed:
 * milk is counted out (0 mL) with 20 L on order for today → 재고 → 발주 주문(출처 열기) → 8 L 기록 → 재고 8,000 mL·보충 필요 그대로 →
 * 나머지 12 L → 20,000 mL·보충 0·예정 0·캘린더/브리핑에서 빠짐.
 */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataCommand } from '../../../data/widget-data';
import { useWidgetView } from '../../../data/react';
import { TODAY, createWidgetDataStore, readModel } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { DetailStack, SupplyPanel } from './testing';
import { MILK, itemOf, shortMilk } from './testing-cafe';
import { addIsoDays } from './shared';

afterEach(cleanup);
// The order grid holds the cafe's 128 past orders, so a flow that opens it takes longer than the default 5 s on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const ORDER = 20, FIRST = 8, REST = ORDER - FIRST;
/** The briefing reads the same snapshot (the briefing card belongs to T-053; its model is the source of truth). */
function BriefingProbe() {
  const view = useWidgetView('briefing');
  const value = (id: string) => (view.status === 'ready' ? view.model.arrival.find((i) => i.featureId === id)?.value ?? 0 : -1);
  return <output aria-label="briefing">{`restock:${value('inventory-booking')};calendar:${value('calendar')}`}</output>;
}
const k = (id: string) => document.querySelector(`[data-widget="${id}"] .ui-metric-fit__value`)!.textContent;
const detail = (id: string) => screen.getByRole('region', { name: `detail:${id}` });
const nameOf = (store: ReturnType<typeof createWidgetDataStore>, itemId: string) => (itemOf(store.getSnapshot().tables, itemId).name as { raw: string }).raw;

function board(root: Parameters<typeof DetailStack>[0]['root']) {
  const { store, poId } = shortMilk(createWidgetDataStore(), ORDER);
  const dispatched: DataCommand[] = [];
  const original = store.dispatch.bind(store);
  vi.spyOn(store, 'dispatch').mockImplementation((command) => { dispatched.push(command); return original(command); });
  renderWithKit(<>
    <DetailStack root={root} />
    <SupplyPanel id="inventory-booking" width={1} height={1} />
    <SupplyPanel id="suppliers" width={1} height={1} column={2} />
    <SupplyPanel id="calendar" width={1} height={2} column={3} />
    <BriefingProbe />
  </>, { store });
  return { store, dispatched, poId };
}
const milk = (store: ReturnType<typeof createWidgetDataStore>) => readModel(store.getSnapshot(), 'inventory-booking').ingredients.find((r) => r.itemId === MILK)!;

describe('receive flow (AC-236·237·238·239)', () => {
  it('8 L then the rest, from 재고 through the linked supplier order', () => {
    const { store, dispatched, poId } = board({ featureId: 'inventory-booking' });
    // Milk is counted out, 20 L is due today: one item to restock, one delivery to come.
    expect(milk(store)).toMatchObject({ stock: 0, outOfStock: true, needsRestock: true });
    expect(k('inventory-booking')).toBe('1');
    expect(k('suppliers')).toBe('1');
    expect(screen.getByLabelText('briefing')).toHaveTextContent('restock:1;');
    expect(document.querySelector('.ui-feature-panel [data-widget="inventory-booking"]')).toHaveTextContent('품절 1개 품목');
    const calendarBefore = readModel(store.getSnapshot(), 'calendar').todayCount;
    expect(k('calendar')).toBe(String(calendarBefore));

    // 우유 → 발주 보기 → 발주 주문 상세
    const milkRow = within(detail('inventory-booking')).getByRole('grid', { name: '재료' }).querySelector(`[data-grid-row="${MILK}"]`) as HTMLElement;
    expect(milkRow).toHaveTextContent('품절');
    expect(within(milkRow).getByRole('gridcell', { name: /현재 재고/ })).toHaveTextContent('0 mL');
    fireEvent.click(within(milkRow).getByRole('button', { name: '발주 보기' }));
    expect(within(detail('suppliers')).getByRole('grid', { name: '발주 내역' }).querySelector(`[data-grid-row="${poId}"]`)).toHaveAttribute('aria-selected', 'true');

    // 8 L, pressed twice in the same frame
    fireEvent.change(screen.getByRole('spinbutton', { name: '받은 수량' }), { target: { value: String(FIRST) } });
    const record = screen.getByRole('button', { name: '입고 기록하기' });
    act(() => { record.click(); record.click(); });
    // the receipt is in litres, the stock in millilitres: 8 L = 8,000 mL
    expect(milk(store).stock).toBe(FIRST * 1000);
    const polIds = store.getSnapshot().tables.purchaseOrderLine.filter((l) => l.poId === poId).map((l) => l.polId);
    expect(store.getSnapshot().tables.receipt.filter((r) => polIds.includes(r.polId))).toHaveLength(1);
    expect(k('inventory-booking')).toBe('1');
    expect(document.querySelector('.ui-feature-panel [data-widget="inventory-booking"]')).not.toHaveTextContent('품절');
    expect(k('suppliers')).toBe('1');
    // 12 L of the order is still open, so its calendar entry stays.
    expect(k('calendar')).toBe(String(calendarBefore));
    expect(screen.getByLabelText('briefing')).toHaveTextContent('restock:1;');
    const row = within(detail('suppliers')).getByRole('grid', { name: '발주 내역' }).querySelector(`[data-grid-row="${poId}"]`) as HTMLElement;
    expect(within(row).getByRole('gridcell', { name: /받은·남은 수량/ })).toHaveTextContent(`${FIRST} L / ${REST} L`);
    // AC-239: an expense candidate (8 L × the milk's purchase price) that does not change the confirmed total.
    const ledgerBefore = readModel(store.getSnapshot(), 'ledger');
    const price = store.getSnapshot().tables.purchaseItem.find((p) => p.itemId === MILK)!.unitPrice;
    expect(ledgerBefore.candidates.map((c) => c.amount)).toContain(FIRST * price);

    // AC-238 with the same key: the form's key re-sent applies once.
    const sent = dispatched.filter((c): c is Extract<DataCommand, { type: 'suppliers.recordReceipt' }> => c.type === 'suppliers.recordReceipt');
    expect(sent).toHaveLength(1);
    const again = store.dispatch(sent[0]!);
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(milk(store).stock).toBe(FIRST * 1000);

    // Back to 재고: the view comes back with milk at 8,000 mL.
    fireEvent.click(screen.getByRole('button', { name: '돌아가기' }));
    const restored = within(detail('inventory-booking')).getByRole('grid', { name: '재료' }).querySelector(`[data-grid-row="${MILK}"]`) as HTMLElement;
    expect(within(restored).getByRole('gridcell', { name: /현재 재고/ })).toHaveTextContent('8,000 mL');
    expect(k('inventory-booking')).toBe('1');

    // The rest (12 L): a new form, a new key.
    fireEvent.click(within(restored).getByRole('button', { name: '발주 보기' }));
    expect(screen.getByRole('spinbutton', { name: '받은 수량' })).toHaveValue(REST);
    fireEvent.click(screen.getByRole('button', { name: '입고 기록하기' }));
    const keys = dispatched.filter((c) => c.type === 'suppliers.recordReceipt').map((c) => (c as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(milk(store).stock).toBe(ORDER * 1000);
    // 20,000 mL is above the 12,000 mL safe stock: nothing to restock, nothing coming.
    expect(milk(store)).toMatchObject({ needsRestock: false, outOfStock: false });
    expect(k('suppliers')).toBe('0');
    expect(within(detail('suppliers')).getByRole('grid', { name: '발주 내역' }).querySelector(`[data-grid-row="${poId}"]`)).toHaveTextContent('입고 완료');
    // The briefing no longer counts the item. The calendar drops the delivery with the last quantity received (a delivery stays on the
    // calendar only while quantity is open, DATA_MODEL; the same rule keeps the cafe's received 08:00 cup delivery off today's list):
    // the count goes down by one (AC-237 on the cafe seed).
    expect(document.querySelector('[data-widget="calendar"]')).not.toHaveTextContent(nameOf(store, MILK));
    expect(k('calendar')).toBe(String(calendarBefore - 1));
    expect(screen.getByLabelText('briefing')).toHaveTextContent('restock:0;');
  });

  it('the calendar delivery moves when the due date changes in its source (AC-232)', () => {
    const { store, poId } = board({ featureId: 'calendar' });
    const title = `${nameOf(store, MILK)} 입고`;
    const before = readModel(store.getSnapshot(), 'calendar');
    expect(document.querySelector('[data-widget="calendar"]')).toHaveTextContent(title);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${title}.*발주 자세히 보기`) }));
    const row = within(detail('suppliers')).getByRole('grid', { name: '발주 내역' }).querySelector(`[data-grid-row="${poId}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole('gridcell', { name: /입고 예정일/ }));
    const input = within(row).getByRole('textbox');
    const tomorrow = addIsoDays(TODAY, 1);
    fireEvent.change(input, { target: { value: tomorrow } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.querySelector('[data-widget="calendar"]')).not.toHaveTextContent(title);
    expect(k('calendar')).toBe(String(before.todayCount - 1));
    fireEvent.click(screen.getByRole('button', { name: '돌아가기' }));
    fireEvent.click(screen.getByRole('radio', { name: '주' }));
    // the week starts on Monday: Monday + Tuesday (today) + the day after
    const days = [...document.querySelectorAll('.ms-week-grid__day')];
    expect(days[2]).toHaveTextContent(`${title}`);
    expect(days[1]).not.toHaveTextContent(title);
    expect(readModel(store.getSnapshot(), 'calendar').weekCount).toBe(before.weekCount);
  });
});
