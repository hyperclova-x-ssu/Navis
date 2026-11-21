import {menuItem} from './menu';
import {ORDER_ROWS} from './rows';
import type {OrderLine, OrderRecord, OrderRuntime} from './types';

/** 지금 = 2026-10-26 20:40 고정. 시계는 흐르지 않는다(DATA_MODEL 13.1). */
export const ORDER_NOW = '20:40';
export const ORDER_DATE_LABEL = '10월 26일 월요일';
export { ORDER_UNDO_MS, toMinutes } from './time';
const parseLines = (text: string): readonly OrderLine[] => text.split(' + ').map(part => {
  const [menu, qty] = part.split('×');
  const item = menuItem(menu);
  return {menuId: item.menuId, menu, qty: Number(qty), unitPrice: item.unitPrice};
});
const pad = (n: number) => String(n).padStart(3, '0');

export const ORDER_RECORDS: readonly OrderRecord[] = ORDER_ROWS.map(([no, orderedAt, items, amount, doneAt]) => ({
  id: `O-${pad(no)}`, no, orderedAt, lines: parseLines(items), amount,
  initialStatus: doneAt ? 'done' : 'open', initialDoneAt: doneAt,
}));
export const ORDER_BY_ID: ReadonlyMap<string, OrderRecord> = new Map(ORDER_RECORDS.map(r => [r.id, r]));

/** 새 실행의 OrderRuntime 초기값(D-04). */
export function initialOrders(): readonly OrderRuntime[] {
  return ORDER_RECORDS.map(r => ({id: r.id, status: r.initialStatus, doneAt: r.initialDoneAt, completedInRun: false}));
}
