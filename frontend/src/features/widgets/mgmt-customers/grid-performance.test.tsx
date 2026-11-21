import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Locale } from '../../../contracts';
import type { DataGridProps } from '../../../ui';
import { KitProviders } from '../../../ui/test-utils';
import { MembersDetail } from './members';
import { MenuDetail } from '../mgmt-products/menu';
import { CustomerAnalysisDetail } from './customer-analysis';
import { VoiceBookingDetail } from './voice-booking';
import { createWidgetDataStore, selectMembers, selectMenus } from '../../../data/widget-data';

// Observe the adapter boundary while keeping the real grid, sorting and focus behavior.
const columns = vi.hoisted(() => new Map<string, readonly unknown[]>());
vi.mock('../../../ui', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../ui')>();
  return { ...actual, DataGrid<Row>(props: DataGridProps<Row>) {
    columns.set(props.id, props.columns);
    return <actual.DataGrid {...props} />;
  } };
});

const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
afterEach(() => { cleanup(); columns.clear(); });
// The café sample (D-313): the member count is read from the selector the grid uses.
const MEMBERS = selectMembers(createWidgetDataStore().getSnapshot(), {}).total;

it.each([
  ['members-grid', 'members', undefined],
  ['membership-grid', 'members', 'memberships'],
  ['menu-grid', 'menu', undefined],
  ['menu-recipe-grid', 'menu', 'm-americano'],
  ['camera-grid', 'customer-analysis', undefined],
  ['booking-grid', 'voice-booking', undefined],
] as const)('%s keeps columns on same-locale renders and refreshes them on locale change', (gridId, featureId, view) => {
  const fixture = (locale: Locale) => <KitProviders locale={locale}>
    {featureId === 'members'
      ? <MembersDetail featureId="members" condition={{ kind: 'default' }} host={host} detailRef={{ featureId: 'members', view }} />
      : featureId === 'menu' ? <MenuDetail featureId="menu" condition={{ kind: 'default' }} host={host} detailRef={{ featureId: 'menu', itemId: view }} />
      : featureId === 'customer-analysis' ? <CustomerAnalysisDetail featureId="customer-analysis" condition={{ kind: 'default' }} host={host} detailRef={{ featureId: 'customer-analysis' }} />
      : <VoiceBookingDetail featureId="voice-booking" condition={{ kind: 'default' }} host={host} detailRef={{ featureId: 'voice-booking' }} />}
  </KitProviders>;
  const result = render(fixture('ko'));
  const initial = columns.get(gridId);
  expect(initial).toBeDefined();
  result.rerender(fixture('ko'));
  expect(columns.get(gridId)).toBe(initial);
  result.rerender(fixture('en'));
  expect(columns.get(gridId)).not.toBe(initial);
  const english = columns.get(gridId);
  result.rerender(fixture('en'));
  expect(columns.get(gridId)).toBe(english);
});

it('refreshes booking columns when table allocation becomes available in the same locale', () => {
  const store = createWidgetDataStore();
  render(<KitProviders store={store}><VoiceBookingDetail featureId="voice-booking" condition={{ kind: 'default' }} host={host} detailRef={{ featureId: 'voice-booking' }} /></KitProviders>);
  const initial = columns.get('booking-grid');
  expect(screen.queryByRole('columnheader', { name: '테이블' })).not.toBeInTheDocument();
  const transaction = { transactionId: 'enable-tables', runId: store.getSnapshot().runId!, expectedDataRevision: store.getSnapshot().revision, expectedRunRevision: 0, transitionToken: 'enable-tables' };
  const prepared = store.session.prepare(transaction, { type: 'shop.updateSettings', businessType: 'cafe', paymentStyle: 'postpaid', tableLayout: { layoutId: 'tables', columns: 9, rows: 6, revision: 0, tables: [{ tableId: 'T1', number: 1, seats: 2, column: 0, row: 0 }] } });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.reason);
  act(() => { store.session.publish(prepared.change); store.session.flush(transaction.transactionId); });
  expect(columns.get('booking-grid')).not.toBe(initial);
  expect(screen.getByRole('columnheader', { name: '테이블' })).toBeInTheDocument();
});

it.each([['회원 ID', 'memberId'], ['이름', 'name'], ['회원 등급', 'grade'], ['최근 방문', 'lastVisit']])('sorts every member by %s in both directions with stable nodes and focus', (label, columnId) => {
  render(<KitProviders><MembersDetail featureId="members" condition={{ kind: 'default' }} host={host} detailRef={{ featureId: 'members' }} /></KitProviders>);
  const grid = screen.getByRole('grid', { name: '회원목록' });
  const initial = Array.from(grid.querySelectorAll('[data-grid-row]'));
  const nodes = new Set(initial);
  expect(initial).toHaveLength(MEMBERS);
  const header = screen.getByRole('button', { name: label });
  act(() => header.focus());
  for (const direction of ['ascending', 'descending']) {
    fireEvent.click(header);
    expect(header.closest('th')).toHaveAttribute('aria-sort', direction);
    expect(header).toHaveFocus();
    const rows = Array.from(grid.querySelectorAll('[data-grid-row]'));
    expect(rows).toHaveLength(MEMBERS);
    expect(rows.every(row => nodes.has(row))).toBe(true);
    const values = rows.map(row => row.querySelector(`[data-grid-column-id="${columnId}"]`)!.textContent!);
    const dateKey = (value: string) => { const match = /^(\d+)\/(\d+)/.exec(value); return match ? Number(match[1]) * 100 + Number(match[2]) : 0; };
    const ordered = [...values].sort((a, b) => columnId === 'lastVisit' ? dateKey(a) - dateKey(b) : a.localeCompare(b));
    expect(values).toEqual(direction === 'ascending' ? ordered : ordered.reverse());
    for (let i = 1; i < rows.length; i++) if (values[i] === values[i - 1]) {
      expect(rows[i - 1].getAttribute('data-grid-row')!.localeCompare(rows[i].getAttribute('data-grid-row')!)).toBeLessThan(0);
    }
  }
});

it('keeps menu numeric sorting in both directions', () => {
  render(<KitProviders><MenuDetail featureId="menu" condition={{ kind: 'default' }} host={host} detailRef={{ featureId: 'menu' }} /></KitProviders>);
  const grid = screen.getByRole('grid', { name: '메뉴 목록' });
  const order = () => Array.from(grid.querySelectorAll('[data-grid-row]'), row => row.getAttribute('data-grid-row'));
  // The café menu (D-313) is read from the selector the grid uses; a price tie keeps the menu id order in both directions.
  const menus = selectMenus(createWidgetDataStore().getSnapshot(), {}).rows;
  const byPrice = (direction: 1 | -1) => [...menus].sort((a, b) => (a.price - b.price) * direction || a.menuId.localeCompare(b.menuId)).map(row => row.menuId);
  fireEvent.click(screen.getByRole('button', { name: '판매가' }));
  expect(order()).toEqual(byPrice(1));
  fireEvent.click(screen.getByRole('button', { name: '판매가' }));
  expect(order()).toEqual(byPrice(-1));
});
