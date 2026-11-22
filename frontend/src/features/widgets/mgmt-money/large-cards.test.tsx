// D-333 (LARGE-CARDS-1): on a large card the money widgets show more of the real data they have, and never invent rows.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CellSpan, ContentShape, FeatureId, PreviewSelection, WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';
import { TAX_LARGE_FIT } from './tax';
import { MONEY_FIT } from './shared';
import { ledgerOf, manWon, marginOf } from './test-values';
import { selectWidget, TODAY } from '../../../data/widget-data';
import type { TaxModel } from '../../../data/widget-data';

afterEach(cleanup);
const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
const host: WidgetHost = { layer: 'management', resetPreview: () => {}, openClosing: () => true, openLinked: () => {}, openDetail: () => {}, notify: () => {}, acknowledgeBriefing: () => {} };
function panel(id: FeatureId, w: CellSpan, h: CellSpan, preview?: PreviewSelection, store?: ReturnType<typeof createWidgetDataStore>) {
  const Panel = widgets.find((m) => m.id === id)!.Panel;
  return renderWithKit(<div data-testid="p"><Panel featureId={id} condition={{ kind: 'default' }} width={w} height={h} shape={shapeOf(w, h)} presetId="A" editing={false} host={host} /></div>, { preview, store });
}
const rows = () => [...document.querySelectorAll<HTMLElement>('.mm-row')];
const names = () => rows().map((r) => r.querySelector('.mm-row__name')!.textContent);

describe('손익 4×4 (D-333)', () => {
  const sales = ledgerOf(createWidgetDataStore()).sales;
  const valueOf = (rowId: string) => rows().find((r) => r.getAttribute('data-row-id') === rowId)?.querySelector('.mm-row__value')?.textContent;
  it('adds the paid amount and the discount the sales hold below the 6 basic rows', () => {
    expect(sales.discount).toBeGreaterThan(0);
    panel('ledger', 4, 4);
    expect(names().slice(6)).toEqual(['결제 금액', '할인']);
    expect(valueOf('gross')).toBe(manWon(sales.gross));
    expect(valueOf('discount')).toBe(manWon(sales.discount));
    // no refund in the data: no refund row
    expect(sales.refund).toBe(0);
    expect(valueOf('refund')).toBeUndefined();
  });
  it('keeps the shorter cards as before', () => {
    panel('ledger', 4, 3);
    expect(rows()).toHaveLength(6);
    cleanup();
    panel('ledger', 4, 2);
    expect(rows()).toHaveLength(6);
    cleanup();
    panel('ledger', 2, 2);
    expect(rows()).toHaveLength(3);
  });
  it('lists the expense categories only when the day has two of them (one would repeat the expenses row)', () => {
    panel('ledger', 4, 4);
    expect(names().filter((n) => / 지출$/.test(n ?? ''))).toEqual([]);
    cleanup();
    const store = createWidgetDataStore();
    expect(store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount: 30000, evidence: 'receipt' }).ok).toBe(true);
    const split = ledgerOf(store).expenses.byCategory.filter((c) => c.amount > 0);
    expect(split.length).toBeGreaterThanOrEqual(2);
    panel('ledger', 4, 4, undefined, store);
    const categoryRows = rows().filter((r) => /^category-/.test(r.getAttribute('data-row-id') ?? ''));
    expect(categoryRows.map((r) => r.getAttribute('data-row-id'))).toEqual(split.map((c) => `category-${c.category}`));
    expect(categoryRows.map((r) => r.querySelector('.mm-row__value')!.textContent)).toEqual(split.map((c) => manWon(c.amount)));
    for (const row of categoryRows) expect(row.querySelector('.mm-row__name')!.textContent).toMatch(/ 지출$/);
  });
});

describe('마진 4×4 (D-333)', () => {
  const menus = marginOf().menus;
  it('lists more menu rows than the 4 of a 4×3 card, up to the menus the data has', () => {
    expect(menus.length).toBeGreaterThan(4);
    panel('margin', 4, 3);
    const short = rows().length;
    cleanup();
    panel('margin', 4, 4);
    expect(rows().length).toBeGreaterThan(short);
    expect(rows().length).toBeGreaterThan(7);
    expect(rows().length).toBeLessThanOrEqual(3 + menus.length);
    expect(rows().length).toBe(3 + menus.length);
  });
  it('never lists a menu twice or one the data does not have', () => {
    panel('margin', 4, 4);
    const ids = rows().map((r) => r.getAttribute('data-row-id'));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids.slice(3)) expect(menus.some((m) => m.menuId === id)).toBe(true);
  });
});

describe('세무관리 4×4 (D-333)', () => {
  const model = (): TaxModel => { const view = selectWidget(createWidgetDataStore().getSnapshot(), 'tax', { kind: 'default' }, 'normal') as { status: string; model: TaxModel }; return view.model; };
  it('shows the date, the status badge and the amount on every item row', () => {
    const items = model().items;
    expect(items.length).toBeGreaterThan(5);
    panel('tax', 4, 4);
    const itemRows = rows().filter((r) => items.some((i) => i.refId === r.getAttribute('data-row-id')));
    expect(itemRows.length).toBeGreaterThan(0);
    for (const row of itemRows) {
      const item = items.find((i) => i.refId === row.getAttribute('data-row-id'))!;
      expect(row.querySelector('.mm-row__sub')).not.toBeNull();
      expect(row.querySelector('.mm-row__badge')).not.toBeNull();
      expect(row.querySelector('.mm-row__value')!.textContent).toBe(manWon(item.amount));
    }
  });
  it('a card of 2 rows high keeps the plain rows (no amount column)', () => {
    const items = model().items;
    panel('tax', 4, 2);
    const itemRows = rows().filter((r) => items.some((i) => i.refId === r.getAttribute('data-row-id')));
    for (const row of itemRows) expect(row.querySelector('.mm-row__value')).toBeNull();
  });
  it('the large fit order drops rows before it drops a row\'s date or badge; the short order is unchanged', () => {
    const at = (order: readonly { selector: string }[], selector: string) => order.findIndex((p) => p.selector === selector);
    expect(at(TAX_LARGE_FIT, '.mm-row')).toBeGreaterThanOrEqual(0);
    expect(at(TAX_LARGE_FIT, '.mm-row')).toBeLessThan(at(TAX_LARGE_FIT, '.mm-row__sub'));
    expect(at(TAX_LARGE_FIT, '.mm-row')).toBeLessThan(at(TAX_LARGE_FIT, '.mm-row__badge'));
    expect(at(MONEY_FIT, '.mm-row__badge')).toBeLessThan(at(MONEY_FIT, '.mm-row'));
    // nothing is lost: the same parts, only in another order
    expect(new Set(TAX_LARGE_FIT.map((p) => p.selector))).toEqual(new Set([...MONEY_FIT.map((p) => p.selector), '.mm-state-chip']));
  });
});
