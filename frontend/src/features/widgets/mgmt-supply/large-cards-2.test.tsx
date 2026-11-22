// D-333 (LARGE-CARDS-2): the tall month card of the 캘린더 also lists the rest of this week's entries, and writes nothing the data does not hold.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellSpan } from '../../../contracts';
import { createWidgetDataStore, readModel } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { SupplyPanel, createTestHost } from './testing';

afterEach(cleanup);
vi.setConfig({ testTimeout: 60_000 });

type Store = ReturnType<typeof createWidgetDataStore>;
const panel = (width: CellSpan, height: CellSpan, store: Store) => renderWithKit(<SupplyPanel id="calendar" width={width} height={height} host={createTestHost('calendar')} />, { store });
const titles = (container: HTMLElement) => [...container.querySelectorAll('.ms-list__title')].map((el) => el.textContent);
const listRows = (container: HTMLElement, title: string) => {
  const list = [...container.querySelectorAll('.ms-list')].find((el) => el.querySelector('.ms-list__title')?.textContent === title);
  return list ? [...list.querySelectorAll('[data-row]')] : [];
};

describe('캘린더 on large cards (D-333)', () => {
  it('4x4 lists the other days of this week under today\'s entries, dated, in the week card\'s order', () => {
    const store = createWidgetDataStore();
    const model = readModel(store.getSnapshot(), 'calendar');
    const rest = model.weekEntries.filter((e) => e.date !== model.today);
    expect(rest.length).toBeGreaterThan(0);
    const { container } = panel(4, 4, store);
    expect(titles(container)).toEqual(['오늘 일정', '이번 주 일정']);
    const rows = listRows(container, '이번 주 일정');
    expect(rows.map((row) => row.getAttribute('data-row-id'))).toEqual(rest.slice(0, 8).map((e) => e.id));
    for (const row of rows) expect(row.querySelector('.ms-row__lead')?.textContent).toMatch(/^\d{1,2}\/\d{1,2}\(.\)/);
    expect(listRows(container, '오늘 일정').map((row) => row.getAttribute('data-row-id'))).toEqual(model.todayEntries.slice(0, 8).map((e) => e.id));
  });
  it('3x4 shows the week list too; 4x3, 3x3 and 2x2 keep the single today list', () => {
    const store = createWidgetDataStore();
    const wide = panel(3, 4, store);
    expect(titles(wide.container)).toContain('이번 주 일정');
    cleanup();
    for (const [width, height] of [[4, 3], [3, 3]] as const) {
      const { container } = panel(width, height, store);
      expect(titles(container)).toEqual(['오늘 일정']);
      cleanup();
    }
  });
  it('writes no list for a calendar the data does not hold', () => {
    const { container } = renderWithKit(<SupplyPanel id="calendar" width={4} height={4} host={createTestHost('calendar')} />, { preview: { family: 'empty', overrides: {} } });
    expect(container.querySelectorAll('.ms-list')).toHaveLength(0);
    expect(titles(container)).toEqual([]);
  });
});
