import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardLayerId, DashboardPage, Panel } from '../contracts';
import { REMOVED_WIDGET_IDS, getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { timePolicy } from '../ui';
import { createRunStore, type AccountRestore, type PresentationRunStore } from './index';
import { dropRemovedWidgets } from './removed-widgets';

/** D-365: a board saved with the removed 마케팅 성과 widget loads cleanly, without a gap, instead of failing the whole account restore. */
const grid = screenPresets.A.grid;
const cell = (featureId: string, column: number, row: number, width = 2, height = 1): Panel => ({ featureId: featureId as Panel['featureId'], column, row, width, height });
const page = (pageId: string, panels: readonly Panel[]): DashboardPage => ({ pageId, panels });
const xy = (panels: readonly Panel[]) => panels.map(p => [p.featureId, p.column, p.row, p.width, p.height]);

describe('dropRemovedWidgets', () => {
  it('knows the removed widget', () => {
    expect(REMOVED_WIDGET_IDS).toEqual(['marketing-performance']);
    expect(getRegistry('A').some(f => REMOVED_WIDGET_IDS.includes(f.id))).toBe(false);
  });

  it('keeps a board that holds only catalog widgets exactly as it is', () => {
    const pages = [page('marketing-1', [cell('marketing-today', 0, 0, 4), cell('slot-coupon', 0, 2)])];
    const result = dropRemovedWidgets(pages, 0, grid);
    expect(result.changed).toBe(false);
    expect(result.pages).toBe(pages);
    expect(result.currentPage).toBe(0);
  });

  it('removes the widget at the bottom of the default layout and leaves the rest where it was', () => {
    const pages = [page('marketing-1', [cell('marketing-today', 0, 0, 4), cell('ai-response', 0, 1), cell('marketing-performance', 0, 3, 4)])];
    const result = dropRemovedWidgets(pages, 0, grid);
    expect(result.changed).toBe(true);
    expect(xy(result.pages[0].panels)).toEqual([['marketing-today', 0, 0, 4, 1], ['ai-response', 0, 1, 2, 1]]);
  });

  it('closes the gap of a widget removed from the middle: later widgets move up in reading order and keep their size', () => {
    const pages = [page('marketing-1', [
      cell('marketing-today', 0, 0, 4), cell('marketing-performance', 0, 1, 4), cell('ai-response', 0, 2), cell('promo-video', 2, 2), cell('slot-coupon', 0, 3, 2, 1),
    ])];
    const result = dropRemovedWidgets(pages, 0, grid);
    expect(xy(result.pages[0].panels)).toEqual([
      ['marketing-today', 0, 0, 4, 1], ['ai-response', 0, 1, 2, 1], ['promo-video', 2, 1, 2, 1], ['slot-coupon', 0, 2, 2, 1],
    ]);
  });

  it('only reflows the page that held the removed widget', () => {
    const second = page('marketing-2', [cell('community', 2, 2)]);
    const pages = [page('marketing-1', [cell('marketing-today', 0, 0, 4), cell('marketing-performance', 0, 1, 4), cell('ai-response', 0, 2)]), second];
    const result = dropRemovedWidgets(pages, 0, grid);
    expect(result.pages[1]).toBe(second);
    expect(xy(result.pages[0].panels)).toEqual([['marketing-today', 0, 0, 4, 1], ['ai-response', 0, 1, 2, 1]]);
  });

  it('drops a page that only held the removed widget and keeps the current page on the same content', () => {
    const pages = [page('a', [cell('marketing-today', 0, 0, 4)]), page('b', [cell('marketing-performance', 0, 0, 4)]), page('c', [cell('community', 0, 0)])];
    const onLast = dropRemovedWidgets(pages, 2, grid);
    expect(onLast.pages.map(p => p.pageId)).toEqual(['a', 'c']);
    expect(onLast.currentPage).toBe(1);
    const onRemoved = dropRemovedWidgets(pages, 1, grid);
    expect(onRemoved.pages.map(p => p.pageId)).toEqual(['a', 'c']);
    expect(onRemoved.currentPage).toBe(1);
  });

  it('keeps the only page of a board even when it becomes empty', () => {
    const result = dropRemovedWidgets([page('marketing-1', [cell('marketing-performance', 0, 0, 4)])], 0, grid);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].panels).toEqual([]);
    expect(result.currentPage).toBe(0);
  });

  it('keeps widgets beside the removed one in place and never overlaps or leaves the grid', () => {
    const panels = [cell('marketing-performance', 0, 0, 1, 1), cell('community', 3, 0, 1, 4), cell('ai-response', 0, 1, 3, 1), cell('slot-coupon', 0, 2, 3, 2)];
    const result = dropRemovedWidgets([page('p', panels)], 0, grid);
    const placed = result.pages[0].panels;
    expect(xy(placed)).toEqual([['community', 3, 0, 1, 4], ['ai-response', 0, 0, 3, 1], ['slot-coupon', 0, 1, 3, 2]]);
    const cells = new Set<number>();
    for (const p of placed) for (let y = p.row; y < p.row + p.height; y++) for (let x = p.column; x < p.column + p.width; x++) {
      expect(y).toBeLessThan(grid.rows); expect(x).toBeLessThan(grid.columns);
      const key = y * grid.columns + x; expect(cells.has(key)).toBe(false); cells.add(key);
    }
  });

  it('does not pull widgets into empty space that was never the removed widget\'s (a board with whitespace beside it)', () => {
    const panels = [cell('marketing-today', 0, 0, 4), cell('marketing-performance', 0, 1, 2), cell('community', 4, 3, 2)];
    const result = dropRemovedWidgets([page('p', panels)], 0, grid);
    expect(xy(result.pages[0].panels)).toEqual([['marketing-today', 0, 0, 4, 1], ['community', 4, 3, 2, 1]]);
  });
});

let run: PresentationRunStore | undefined;
afterEach(() => { run?.dispose(); run = undefined; });
const settings = (store: PresentationRunStore): AccountRestore['settings'] => store.getState().shopSettings;
function restore(store: PresentationRunStore, boards: Partial<Record<DashboardLayerId, readonly DashboardPage[]>>, currentPage = 0): AccountRestore {
  const current = store.getState();
  const board = (layer: DashboardLayerId) => ({ pages: boards[layer] ?? current.boards[layer].pages, currentPage: boards[layer] ? currentPage : 0, revision: 3 });
  return { theme: 'light', textScale: 100, locale: 'ko', onboardingDone: true, settings: settings(store), boards: { management: board('management'), marketing: board('marketing') } };
}

describe('restoreAccount with a saved board that still holds 마케팅 성과 (D-365)', () => {
  it('accepts the account instead of failing, and loads the marketing board without the widget', () => {
    run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true }) as PresentationRunStore;
    const saved = [page('marketing-1', [
      cell('marketing-today', 0, 0, 4), cell('ai-response', 0, 1), cell('expiry-coupon', 2, 1), cell('promo-video', 4, 1),
      cell('slot-coupon', 0, 2), cell('coupon-status', 2, 2), cell('customer-groups', 4, 2), cell('marketing-performance', 0, 3, 4),
    ])];
    expect(run.actions.restoreAccount(restore(run, { marketing: saved }))).toBe(true);
    const marketing = run.getState().boards.marketing;
    const ids = marketing.pages.flatMap(p => p.panels.map(panel => panel.featureId));
    expect(ids).not.toContain('marketing-performance');
    expect(ids).toHaveLength(7);
    expect(marketing.pages[0].panels.find(p => p.featureId === 'marketing-today')).toMatchObject({ column: 0, row: 0, width: 4 });
  });

  it('closes the gap when the saved widget sat in the middle of the board', () => {
    run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true }) as PresentationRunStore;
    const saved = [page('marketing-1', [cell('marketing-today', 0, 0, 4), cell('marketing-performance', 0, 1, 4), cell('ai-response', 0, 2)])];
    expect(run.actions.restoreAccount(restore(run, { marketing: saved }))).toBe(true);
    expect(xy(run.getState().boards.marketing.pages[0].panels)).toEqual([['marketing-today', 0, 0, 4, 1], ['ai-response', 0, 1, 2, 1]]);
  });

  it('still rejects a board that is invalid for another reason', () => {
    run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true }) as PresentationRunStore;
    const bad = [page('marketing-1', [cell('menu', 0, 0)])];
    expect(run.actions.restoreAccount(restore(run, { marketing: bad }))).toBe(false);
  });
});
