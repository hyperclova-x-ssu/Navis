import type { PosDayTotals, PosDrawerSnapshot, PosReadSnapshot } from '../../contracts/pos';
import { selectM2DayTotals, selectM2Drawer } from './projection';
import type { DataSnapshot } from '../db/types';
import type { ClosingScenario } from '../db/management-types';
import { deepFreeze } from '../db/freeze';
import { DataQueryError, requireDate } from '../derive/common';
import { selectClosing, selectPosPayments, type PaymentQuery } from '../derive/payments';

export type PosHistoricalDrawer = Pick<PosDrawerSnapshot, 'opening' | 'cashNet' | 'movements' | 'expected' | 'actual' | 'difference' | 'memo'>;
export interface PosClosingHistoryRow {
  readonly businessDate: string; readonly closedAt: string; readonly closingId: string | null; readonly generation: number;
  readonly gross: number; readonly discount: number; readonly refund: number; readonly revenue: number;
  readonly paymentCount: number; readonly refundCount: number; readonly cancelCount: number;
  readonly byMethod: PosDayTotals['byMethod']; readonly methodCounts: PosDayTotals['methodCounts'];
  readonly cashDrawer: PosHistoricalDrawer; readonly totals: PosDayTotals | null; readonly today: boolean;
  readonly detailAvailable: boolean;
}
export interface PosClosingQuery {
  readonly date: string; readonly scenario: ClosingScenario; readonly method?: PaymentQuery['method'];
  readonly mixed?: boolean; readonly onlyMixed?: boolean; readonly sort?: PaymentQuery['sort'];
}
const dataSnapshot = (read: DataSnapshot | PosReadSnapshot): DataSnapshot => {
  if ('tables' in read) return read;
  const source = read.data.source as DataSnapshot | undefined;
  if (!source?.tables || source.pos !== read.pos) throw new DataQueryError('VALIDATION', 'source');
  return source;
};
export function selectPosClosingHistory(read: DataSnapshot | PosReadSnapshot, { scenario = 'normal' }: { readonly scenario?: ClosingScenario } = {}): readonly PosClosingHistoryRow[] {
  const snapshot = dataSnapshot(read);
  const date = snapshot.pos?.businessDate;
  const rows = new Map(snapshot.tables.dayClosing.filter(row => row.scenario === scenario).map(row => [row.businessDate, row]));
  const history: PosClosingHistoryRow[] = [...rows.values()].flatMap(row => {
    if (row.status !== 'closed' || !row.drawerSnapshot) return [];
    const totals = row.posTotalsSnapshot ?? null;
    const t = row.salesSnapshot;
    const today = date === row.businessDate;
    return { businessDate: row.businessDate, closedAt: row.closedAt, closingId: row.closingId, generation: row.generation,
      gross: t.gross, discount: t.discount, refund: t.refund, revenue: t.net, paymentCount: t.paymentCount, refundCount: t.refundCount,
      cancelCount: totals?.cancelCount ?? 0, byMethod: t.byMethod, methodCounts: t.methodCounts, cashDrawer: row.drawerSnapshot,
      totals, today, detailAvailable: today };
  });
  return deepFreeze(history.sort((a, b) => b.businessDate.localeCompare(a.businessDate)));
}
/** API-249: one read for closing, receipt rows, cash and history; filtering never changes totals. */
export function selectPosClosing(read: DataSnapshot | PosReadSnapshot, query: PosClosingQuery) {
  requireDate(query.date);
  const snapshot = dataSnapshot(read), pos = snapshot.pos;
  if (!pos) throw new DataQueryError('VALIDATION', 'pos');
  const closing = selectClosing(snapshot, query);
  const stored = snapshot.tables.dayClosing.find(c => c.closingId === closing.closingId && c.status === 'closed');
  const empty = query.scenario === 'empty' || query.date !== pos.businessDate;
  const live = selectM2DayTotals(pos,empty?'empty':'normal');
  const totals = stored?.posTotalsSnapshot ?? live;
  // Empty preview changes display only; unpaid normal bills still block the command.
  const pendingBills = pos.bills.filter(b => b.status === 'open' || b.status === 'partial');
  const approvalPending = 'posUi' in read && read.posUi.approval?.status === 'pending';
  const payments = selectPosPayments(snapshot, { ...query, onlyMixed: query.mixed ?? query.onlyMixed });
  return deepFreeze({ ...closing, totals, rows: payments.rows,
    pendingBills, received: selectM2DayTotals(pos).pendingReceived, approvalPending,
    canClose: closing.status !== 'closed' && !pendingBills.length && !approvalPending,
    drawer: stored?.drawerSnapshot ?? selectM2Drawer(pos, empty ? 'empty' : 'normal'),
    history: selectPosClosingHistory(snapshot, query) });
}
