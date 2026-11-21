import '../test-setup';
import '@testing-library/jest-dom/vitest';
import { useState, type ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiProvider } from '../UiProvider';
import { screenPresets } from '../../layout/presets';
import { DataGrid, type GridColumn, type GridSort } from './data-grid';
import { planColumnDrops, ACTIONS_COLUMN } from './data-grid-columns';

/**
 * K-D item 3 (DS 12.1 "사이드 패널 열림 시 DataGrid 열 덜어내기 규칙(B2 확정)"): while an overlay DetailSidePanel sits beside the grid the
 * grid hides columns by their `dropOrder` until the rest fits, never the first column, and restores them when the panel is gone.
 * jsdom has no layout, so the available width and the lengths behind CSS variables are stubbed; the real widths are measured in headless Chrome.
 */
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('planColumnDrops (pure plan)', () => {
  const cols = [
    { id: 'name', minWidth: 200 },
    { id: 'status', minWidth: 120, dropOrder: 7 },
    { id: 'photo', minWidth: 180, dropOrder: 1 },
    { id: 'category', minWidth: 112, dropOrder: 6 },
    { id: 'price', minWidth: 140 },
    { id: 'cost', minWidth: 160, dropOrder: 4 },
    { id: 'rate', minWidth: 120, dropOrder: 3 },
    { id: 'sold', minWidth: 168, dropOrder: 5 },
  ];
  const actions = { width: 112, dropOrder: 2 };
  it('drops nothing while everything fits', () => {
    expect(planColumnDrops({ columns: cols, available: 1312, fixedWidth: 0, actions })).toEqual([]);
    expect(planColumnDrops({ columns: cols, available: 5000, fixedWidth: 0, actions })).toEqual([]);
  });
  it('drops the lowest dropOrder first, one by one, and stops as soon as the rest fits', () => {
    expect(planColumnDrops({ columns: cols, available: 1140, fixedWidth: 0, actions })).toEqual(['photo']);
    expect(planColumnDrops({ columns: cols, available: 1100, fixedWidth: 0, actions })).toEqual(['photo', ACTIONS_COLUMN]);
    expect(planColumnDrops({ columns: cols, available: 1000, fixedWidth: 0, actions })).toEqual(['photo', ACTIONS_COLUMN, 'rate']);
    expect(planColumnDrops({ columns: cols, available: 700, fixedWidth: 0, actions })).toEqual(['photo', ACTIONS_COLUMN, 'rate', 'cost', 'sold']);
  });
  it('counts the fixed width (expand column) and the actions column in what has to fit', () => {
    expect(planColumnDrops({ columns: cols, available: 1140, fixedWidth: 48, actions })).toEqual(['photo', ACTIONS_COLUMN]);
  });
  it('never hides the first column, a column without dropOrder, or anything when nothing is droppable (scroll is the last resort)', () => {
    const first = [{ id: 'name', minWidth: 200, dropOrder: 1 }, { id: 'a', minWidth: 300 }, { id: 'b', minWidth: 300, dropOrder: 2 }];
    expect(planColumnDrops({ columns: first, available: 100, fixedWidth: 0, actions: null })).toEqual(['b']);
    expect(planColumnDrops({ columns: [{ id: 'name', minWidth: 400 }, { id: 'a', minWidth: 400 }], available: 100, fixedWidth: 0, actions: null })).toEqual([]);
  });
  it('breaks a tie by hiding the later column first and ignores a non-numeric order', () => {
    const tie = [{ id: 'name', minWidth: 100 }, { id: 'a', minWidth: 100, dropOrder: 1 }, { id: 'b', minWidth: 100, dropOrder: 1 }, { id: 'c', minWidth: 100, dropOrder: Number.NaN }];
    expect(planColumnDrops({ columns: tie, available: 300, fixedWidth: 0, actions: null })).toEqual(['b']);
    expect(planColumnDrops({ columns: tie, available: 100, fixedWidth: 0, actions: null })).toEqual(['b', 'a']);
  });
});

type Row = { id: string; name: string };
const rows: Row[] = [{ id: 'a', name: '아메리카노' }, { id: 'b', name: '카페라떼' }];
const widths = { scroll: 1140 };
const column = (id: string, minWidth: number, dropOrder?: number, kind: GridColumn<Row>['kind'] = 'text'): GridColumn<Row> => ({ id, header: id, kind, minWidth, value: r => `${id}:${r.name}`, ...(dropOrder ? { dropOrder } : {}) });
const menuColumns: GridColumn<Row>[] = [
  { ...column('name', 200), sortable: true, editable: () => true },
  column('status', 120, 7), column('photo', 180, 1), column('category', 112, 6), column('price', 140),
  column('cost', 160, 4), column('rate', 120, 3), column('sold', 168, 5),
];
const ids = () => [...document.querySelectorAll('thead th[role="columnheader"]')].map(th => th.textContent);
const dropped = () => document.querySelector('.ui-data-grid')?.getAttribute('data-dropped-columns') ?? '';

let observers: ResizeObserver[] = [];
beforeEach(() => {
  observers = [];
  widths.scroll = 1140;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).classList?.contains('ui-data-grid__scroll') ? widths.scroll : 0; } });
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const expr = this.getAttribute?.('data-grid-length-probe');
    if (expr) return { width: expr.includes('table-action-width') ? 112 : expr.includes('target-default') ? 48 : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    return rect.call(this);
  });
  vi.stubGlobal('ResizeObserver', class { constructor(cb: ResizeObserverCallback) { observers.push(this as unknown as ResizeObserver); (this as unknown as { cb: ResizeObserverCallback }).cb = cb; } observe() {} unobserve() {} disconnect() { observers = observers.filter(o => o !== (this as unknown as ResizeObserver)); } });
});
const fireResize = () => act(() => { for (const o of observers) (o as unknown as { cb: ResizeObserverCallback }).cb([], o); });

function Host({ panel = 'overlay', columns = menuColumns, withActions = true, obscured, expand = false }: { panel?: 'overlay' | 'flow' | 'none'; columns?: GridColumn<Row>[]; withActions?: boolean; obscured?: ReadonlySet<string>; expand?: boolean }) {
  const [sort, setSort] = useState<GridSort>(null);
  const wrap = (children: ReactNode) => <UiProvider screenPreset={screenPresets.A} reducedMotion>{children}</UiProvider>;
  return wrap(<div className="detail-body">
    <DataGrid id="menu" label="메뉴" rows={rows} columns={columns} getRowId={r => r.id} getRowLabel={r => r.name}
      sort={sort} onSortChange={setSort} focus={null} onFocusChange={() => {}} selectedRowId={null} expandedRowIds={new Set()} emptyContent="없어요"
      obscuredCells={obscured}
      {...(withActions ? { getRowActions: (r: Row) => [{ id: 'delete', label: `${r.name} 지우기`, onPress: () => {} }], rowActionsDropOrder: 2 } : {})}
      {...(expand ? { getExpandAction: () => ({ label: '펼치기' }) } : {})} />
    {panel === 'none' ? null : <aside className="ui-detail-side-panel" data-layout={panel} role="region" aria-label="메뉴 편집" />}
  </div>);
}
const actionButtons = () => screen.queryAllByRole('button', { name: /지우기$/ });

describe('DataGrid column drop beside an overlay side panel', () => {
  it('shows every column when no panel is open, however narrow the table is', () => {
    widths.scroll = 500;
    render(<Host panel="none" />);
    expect(ids()).toEqual(['name', 'status', 'photo', 'category', 'price', 'cost', 'rate', 'sold']);
    expect(dropped()).toBe('');
    expect(actionButtons()).toHaveLength(2);
  });
  it('hides 사진-like (dropOrder 1) first, then the actions column, then the next order, only until the rest fits', () => {
    widths.scroll = 1140;
    const first = render(<Host />);
    expect(dropped()).toBe('photo');
    expect(ids()).not.toContain('photo');
    first.unmount();
    widths.scroll = 1100;
    const second = render(<Host />);
    expect(dropped()).toBe('photo $actions');
    expect(actionButtons()).toHaveLength(0);
    expect(ids()).toEqual(['name', 'status', 'category', 'price', 'cost', 'rate', 'sold']);
    second.unmount();
    widths.scroll = 1000;
    render(<Host />);
    expect(dropped()).toBe('photo $actions rate');
    expect(ids()).toEqual(['name', 'status', 'category', 'price', 'cost', 'sold']);
  });
  it('never hides the first column or the required (no dropOrder) columns; horizontal scroll is the last resort', () => {
    widths.scroll = 200;
    render(<Host />);
    expect(ids()).toEqual(['name', 'price']);
    const table = document.querySelector('.ui-data-grid__table') as HTMLElement;
    expect(table.style.getPropertyValue('--data-grid-min-width')).toContain('340px');
    expect(table.getAttribute('aria-colcount')).toBe('2');
  });
  it('removes dropped cells and row actions from keyboard navigation (no target, no tab stop, ArrowRight skips them)', async () => {
    widths.scroll = 1100;
    render(<Host />);
    expect(document.querySelector('[data-grid-column-id="photo"]')).toBeNull();
    expect(document.querySelector('[data-grid-target*="photo"]')).toBeNull();
    expect(document.querySelector('[data-grid-target*="$action"]')).toBeNull();
    const user = userEvent.setup();
    const nameCell = document.querySelector('[data-grid-row-id="a"][data-grid-column-id="name"]') as HTMLElement;
    nameCell.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveAttribute('data-grid-column-id', 'status');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveAttribute('data-grid-column-id', 'category');
    await user.keyboard('{End}');
    expect(document.activeElement).toHaveAttribute('data-grid-column-id', 'sold');
  });
  it('does not mention a dropped column in obscuredCells handling and keeps the other cells focusable', () => {
    widths.scroll = 1140;
    render(<Host obscured={new Set(['a:photo', 'a:name'])} />);
    expect(dropped()).toBe('photo');
    expect(document.querySelector('[data-grid-row-id="a"][data-grid-column-id="name"]')).toHaveAttribute('aria-hidden', 'true');
    expect(document.querySelector('[data-grid-row-id="b"][data-grid-column-id="name"]')).not.toHaveAttribute('aria-hidden');
    expect(document.querySelectorAll('[data-grid-target*="photo"]')).toHaveLength(0);
  });
  it('restores every column the moment the panel is gone, and drops again when it comes back', () => {
    widths.scroll = 1100;
    const view = render(<Host />);
    expect(dropped()).toBe('photo $actions');
    view.rerender(<Host panel="none" />);
    expect(dropped()).toBe('');
    expect(ids()).toEqual(['name', 'status', 'photo', 'category', 'price', 'cost', 'rate', 'sold']);
    expect(actionButtons()).toHaveLength(2);
    view.rerender(<Host />);
    expect(dropped()).toBe('photo $actions');
  });
  it('re-plans on resize in both directions (wider shows columns again, narrower hides more)', () => {
    widths.scroll = 1140;
    render(<Host />);
    expect(dropped()).toBe('photo');
    widths.scroll = 1000; fireResize();
    expect(dropped()).toBe('photo $actions rate');
    widths.scroll = 1400; fireResize();
    expect(dropped()).toBe('');
  });
  it('re-plans when 125% text changes a column minWidth (same order, more columns hidden)', () => {
    widths.scroll = 1140;
    const view = render(<Host />);
    expect(dropped()).toBe('photo');
    const wider = menuColumns.map(c => ({ ...c, minWidth: Math.round(c.minWidth * 1.25) }));
    view.rerender(<Host columns={wider} />);
    expect(dropped()).toBe('photo $actions rate');
  });
  it('treats a panel that owns a grid column (data-layout="flow") as no panel', () => {
    widths.scroll = 600;
    render(<Host panel="flow" />);
    expect(dropped()).toBe('');
    expect(ids()).toHaveLength(8);
  });
  it('is inert for a grid that declares no dropOrder (nothing changes for existing widgets)', () => {
    widths.scroll = 300;
    render(<Host columns={menuColumns.map(({ dropOrder: _drop, ...c }) => c)} withActions={false} />);
    expect(dropped()).toBe('');
    expect(ids()).toHaveLength(8);
  });
  it('counts the expand column width in what has to fit', () => {
    widths.scroll = 1140;
    render(<Host expand />);
    // 1200 + 48 (expand) + 112 (actions) = 1360 -> photo (1180) -> actions (1068)
    expect(dropped()).toBe('photo $actions');
  });
});
