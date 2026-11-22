import type { TableLayout } from '../contracts';
import { createTableLayout } from './table-layout';

/**
 * Test fixture only. The app default is the 11-table cafe (createTableLayout); kit and table-state tests that depend on exact tile cells
 * keep the six-table sample they were written against (T1~T3 2 seats, T4~T6 4 seats, 18 seats) so they do not move with the default.
 */
export function sixTableLayout(layoutId = 'store-tables'): TableLayout {
  const base = createTableLayout(layoutId);
  return Object.freeze({ ...base, tables: Object.freeze(Array.from({ length: 6 }, (_, index) => Object.freeze({ tableId: `T${index + 1}`, number: index + 1, seats: index < 3 ? 2 : 4, column: 1 + index % 3 * 3, row: index < 3 ? 1 : 3 }))) });
}
