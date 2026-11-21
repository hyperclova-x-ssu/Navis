import type { BusinessType, PaymentStyle, StoreTable, TableLayout } from '../contracts';

const integerIn = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
const freeze = (layout: TableLayout): TableLayout => Object.freeze({ ...layout, tables: Object.freeze(layout.tables.map(t => Object.freeze({ ...t }))) });

/** Store tables occupy one cell, independently of the dashboard's panel geometry. */
export function validateTableLayout(value: unknown): value is TableLayout {
  if (!value || typeof value !== 'object') return false;
  const layout=value as Partial<TableLayout>;
  if (layout.columns !== 9 || layout.rows !== 6 || typeof layout.layoutId !== 'string' || !layout.layoutId.trim() || typeof layout.revision !== 'number' || !Number.isSafeInteger(layout.revision) || layout.revision < 0 || !Array.isArray(layout.tables) || !integerIn(layout.tables.length, 1, 20)) return false;
  const ids = new Set<string>(), numbers = new Set<number>(), positions = new Set<string>();
  for (const table of layout.tables) {
    if (!table || typeof table.tableId !== 'string' || !table.tableId.trim() || ids.has(table.tableId) || !integerIn(table.number, 1, 20) || numbers.has(table.number) || !integerIn(table.seats, 1, 12) || !integerIn(table.column, 0, 8) || !integerIn(table.row, 0, 5)) return false;
    const cell = `${table.column}:${table.row}`;
    if (positions.has(cell)) return false;
    ids.add(table.tableId); numbers.add(table.number); positions.add(cell);
  }
  return true;
}

export const tableLayoutEnabled = (businessType: BusinessType | null, paymentStyle: PaymentStyle | null): boolean => paymentStyle === 'postpaid' && (businessType === 'cafe' || businessType === 'restaurant' || businessType === 'pub');

export function createTableLayout(layoutId = 'store-tables'): TableLayout {
  return freeze({ layoutId, columns: 9, rows: 6, revision: 0, tables: Array.from({ length: 6 }, (_, index) => ({ tableId: `T${index + 1}`, number: index + 1, seats: index < 3 ? 2 : 4, column: 1 + index % 3 * 3, row: index < 3 ? 1 : 3 })) });
}

export function resizeTableCount(layout: TableLayout, count: number): TableLayout | null {
  if (!validateTableLayout(layout) || !integerIn(count, 1, 20)) return null;
  if (layout.tables.length === count) return layout;
  const tables: StoreTable[] = [...layout.tables].sort((a, b) => a.number - b.number).slice(0, count);
  while (tables.length < count) {
    const occupied = new Set(tables.map(t => `${t.column}:${t.row}`));
    const candidates = [{ column: 1, row: 5 }, { column: 4, row: 5 }, { column: 7, row: 5 }, ...Array.from({ length: 54 }, (_, i) => ({ column: i % 9, row: Math.floor(i / 9) }))];
    const position = candidates.find(p => !occupied.has(`${p.column}:${p.row}`))!;
    const number = Array.from({length:20},(_,index)=>index+1).find(number=>!tables.some(t=>t.number===number))!;
    let tableId = `T${number}`;
    while (tables.some(t => t.tableId === tableId)) tableId += '-new';
    tables.push({ tableId, number, seats: 2, ...position });
  }
  return freeze({ ...layout, tables, revision: layout.revision + 1 });
}

/** null tableId updates all seats; a rejected edit leaves the caller's draft intact. */
export function setTableSeats(layout: TableLayout, tableId: string | null, seats: number): TableLayout | null {
  if (!validateTableLayout(layout) || !integerIn(seats, 1, 12) || tableId !== null && !layout.tables.some(t => t.tableId === tableId)) return null;
  const tables = layout.tables.map(t => tableId === null || t.tableId === tableId ? { ...t, seats } : t);
  return tables.every((t, i) => t.seats === layout.tables[i].seats) ? layout : freeze({ ...layout, tables, revision: layout.revision + 1 });
}

export function moveTable(layout: TableLayout, tableId: string, column: number, row: number): TableLayout | null {
  if (!validateTableLayout(layout) || !integerIn(column, 0, 8) || !integerIn(row, 0, 5) || !layout.tables.some(t => t.tableId === tableId) || layout.tables.some(t => t.tableId !== tableId && t.column === column && t.row === row)) return null;
  const table = layout.tables.find(t => t.tableId === tableId)!;
  if (table.column === column && table.row === row) return layout;
  return freeze({ ...layout, revision: layout.revision + 1, tables: layout.tables.map(t => t.tableId === tableId ? { ...t, column, row } : t) });
}
