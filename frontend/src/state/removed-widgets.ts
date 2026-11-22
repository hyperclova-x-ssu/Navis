import type { DashboardLayerId, DashboardPage, GridSpec, Panel } from '../contracts';
import { REMOVED_WIDGET_IDS } from '../catalog';
import { cellMask, readingOrder } from '../layout';
import type { AccountRestore } from './index';

/**
 * D-365: a board saved before a widget left the product (마케팅 성과) must still load. The removed widget is dropped and the
 * widgets below it slide up into the space it freed (same columns, same sizes, never above its old top row), so no hole stays
 * where it was; widgets beside or above it, and a board with nothing below the removed widget, keep their saved places.
 * A page that held nothing else is dropped when other pages remain; the only page of a board is kept, empty.
 * Any other invalid board is left to the caller's own validation: only the explicit removed ids are touched.
 */
export interface CleanedBoard { readonly pages: readonly DashboardPage[]; readonly currentPage: number; readonly changed: boolean }

function closeGap(kept: readonly Panel[], gone: readonly Panel[], grid: GridSpec): readonly Panel[] {
  const panels = [...kept];
  for (const removed of readingOrder(gone)) {
    const columns = new Set<number>();
    for (let x = removed.column; x < removed.column + removed.width; x++) columns.add(x);
    for (const original of readingOrder(panels)) {
      const index = panels.indexOf(original);
      const panel = panels[index];
      if (panel.row < removed.row || ![...Array(panel.width).keys()].some(offset => columns.has(panel.column + offset))) continue;
      const others = panels.reduce((mask, other, at) => at === index ? mask : mask | cellMask(other, grid), 0n);
      let row = panel.row;
      while (row > removed.row && !(cellMask({ ...panel, row: row - 1 }, grid) & others)) row--;
      if (row !== panel.row) panels[index] = { ...panel, row };
      for (let x = panel.column; x < panel.column + panel.width; x++) columns.add(x);
    }
  }
  return panels;
}

export function dropRemovedWidgets(pages: readonly DashboardPage[], currentPage: number, grid: GridSpec, removed: readonly string[] = REMOVED_WIDGET_IDS): CleanedBoard {
  if (!pages.some(page => page.panels.some(panel => removed.includes(panel.featureId)))) return { pages, currentPage, changed: false };
  const cleaned = pages.map(page => {
    const kept = page.panels.filter(panel => !removed.includes(panel.featureId));
    if (kept.length === page.panels.length) return { page, dropped: false };
    const gone = page.panels.filter(panel => removed.includes(panel.featureId));
    return { page: { ...page, panels: closeGap(kept, gone, grid) }, dropped: kept.length === 0 };
  });
  const keep = cleaned.map(entry => !entry.dropped);
  if (!keep.some(Boolean)) keep[0] = true; // a board always keeps one page, even if it is empty
  const result = cleaned.filter((_, index) => keep[index]).map(entry => entry.page);
  const before = keep.slice(0, currentPage).filter(Boolean).length;
  return { pages: result, currentPage: Math.min(before, result.length - 1), changed: true };
}

/** The account restore with every board cleaned. Boards that are missing or hold no removed widget are returned as they came. */
export function withoutRemovedWidgets(restore: AccountRestore, grid: GridSpec): AccountRestore {
  let changed = false;
  const boards = { ...restore.boards } as Record<DashboardLayerId, AccountRestore['boards'][DashboardLayerId]>;
  for (const layer of Object.keys(boards) as DashboardLayerId[]) {
    const board = boards[layer];
    if (!board || !Array.isArray(board.pages)) continue;
    const cleaned = dropRemovedWidgets(board.pages, board.currentPage, grid);
    if (!cleaned.changed) continue;
    changed = true;
    boards[layer] = { ...board, pages: cleaned.pages, currentPage: cleaned.currentPage };
  }
  return changed ? { ...restore, boards } : restore;
}
