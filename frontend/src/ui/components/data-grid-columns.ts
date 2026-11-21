/**
 * DS 12.1 "사이드 패널 열림 시 DataGrid 열 덜어내기 규칙(B2 확정)": which columns a DataGrid hides while an overlay DetailSidePanel sits beside it.
 * Pure on purpose (the DOM reads live in data-grid.tsx), so the order and the stopping rule are unit tested without layout.
 */
/** Id used for the trailing per-row actions column (`getRowActions`, the '조작' column) in a drop plan and in `data-dropped-columns`. */
export const ACTIONS_COLUMN = '$actions';

export interface DropColumn {
  readonly id: string;
  /** Track minimum in px (the grid tracks are `minmax(minWidth, 1fr)`, so this is the width the column needs). */
  readonly minWidth: number;
  /** 1 = hidden first. A column without it is required and always stays. Ignored on the first column. */
  readonly dropOrder?: number;
}
export interface DropPlanInput {
  readonly columns: readonly DropColumn[];
  /** Width of the table area (the scroller's client width). */
  readonly available: number;
  /** Width of the columns that never go away (the expand column). */
  readonly fixedWidth: number;
  /** The trailing actions column, or null when the grid has none. It only counts as droppable when it has a `dropOrder`. */
  readonly actions: { readonly width: number; readonly dropOrder?: number } | null;
}

const orderOf = (value: number | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Column ids to hide, in the order they go: lowest `dropOrder` first, a tie hides the later column first, one at a time, and it stops as soon as
 * the remaining columns fit `available`. The first column, a column without `dropOrder` and the expand column always stay; when only those are
 * left and still do not fit, the grid scrolls sideways (the last resort in the DS).
 */
export function planColumnDrops({ columns, available, fixedWidth, actions }: DropPlanInput): readonly string[] {
  let required = fixedWidth + columns.reduce((sum, column) => sum + column.minWidth, 0) + (actions?.width ?? 0);
  const candidates: { id: string; width: number; order: number; index: number }[] = [];
  columns.forEach((column, index) => {
    const order = orderOf(column.dropOrder);
    if (index > 0 && order !== null) candidates.push({ id: column.id, width: column.minWidth, order, index });
  });
  const actionsOrder = orderOf(actions?.dropOrder);
  if (actions && actionsOrder !== null) candidates.push({ id: ACTIONS_COLUMN, width: actions.width, order: actionsOrder, index: columns.length });
  candidates.sort((a, b) => a.order - b.order || b.index - a.index);
  const dropped: string[] = [];
  for (const candidate of candidates) {
    if (required <= available) break;
    required -= candidate.width;
    dropped.push(candidate.id);
  }
  return dropped;
}
