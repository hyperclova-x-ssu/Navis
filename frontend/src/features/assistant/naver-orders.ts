// Order answers state what the order status screen states: the NAVER orders still open (read from the same service endpoint the screen reads), and, on
// a day with no POS orders yet, the latest day that did have sales. Both are facts of the read, so the guard and the evidence treat them like any other.
import { humanDate } from '../../data/facts';
import type { NaverOrder, NpaySettlement } from '../../data/reality/02/naver';
import { projectNaverOrderStatus } from '../../data/reality/02/naver';
import type { FinanceTotalsDto } from '../../data/reality/09/dto';
import type { WidgetDataStore } from '../../data/widget-data';
import type { AgentFact } from '../../../shared/navis-agent-schema.mjs';

const MAX_LISTED = 3;
const STATE: Readonly<Record<NaverOrder['status'], string>> = { received: '접수', preparing: '준비 중', 'picked-up': '픽업 완료' };

export function naverOrderFacts(orders: readonly NaverOrder[] | undefined, date: string): readonly AgentFact[] {
  if (!orders?.length) return [];
  const rows = orders.map((order, index) => projectNaverOrderStatus(order, index + 1)).filter(row => row.naver.status !== 'picked-up');
  return [
    { key: 'orders.naver.open.count', label: '네이버 주문 진행 중', value: rows.length, unit: 'order', display: `${rows.length}건`, date },
    ...rows.slice(0, MAX_LISTED).map((row): AgentFact => {
      const minutes = row.naver.preparationMinutes;
      return { key: 'orders.naver.row', label: `네이버 주문 ${row.publicOrderNumber ?? row.ordinal}`, value: row.ordinal, unit: '',
        display: `${STATE[row.naver.status]}${row.naver.status === 'preparing' && minutes ? ` ${minutes}분` : ''}`, date };
    }),
  ];
}

/** The latest day before `today` whose recognized sales were above zero, as one fact (used when today has no order yet). */
export function lastPaidDayFact(days: Readonly<Record<string, Pick<FinanceTotalsDto, 'sales'>>> | undefined, today: string): AgentFact | undefined {
  const day = Object.keys(days ?? {}).filter(date => date < today && (days?.[date]?.sales.total ?? 0) > 0).sort().at(-1);
  if (!day) return undefined;
  const total = days![day].sales.total;
  return { key: 'orders.lastPaid.day', label: '가장 최근 결제가 있었던 날', value: total, unit: 'KRW', display: `${humanDate(day)} · 매출 ${total.toLocaleString('ko-KR')}원`, date: day };
}

/** The NAVER orders of the store, from the service the order status screen reads. Undefined when the store is not connected or the read fails. */
export async function readNaverOrders(store: WidgetDataStore, signal: AbortSignal): Promise<readonly NaverOrder[] | undefined> {
  const port = store.real;
  if (!port) return undefined;
  try {
    const page = await port.transport.request<{ items: NaverOrder[] }>({ method: 'GET', path: '/pos/naver/orders', signal });
    return page.items;
  } catch { return undefined; }
}

/** The Npay approvals behind the NAVER orders, from the same per-payment read the order status screen makes (one call per distinct Npay payment id). */
export async function readNpaySettlements(store: WidgetDataStore, orders: readonly NaverOrder[] | undefined, signal: AbortSignal): Promise<readonly NpaySettlement[]> {
  const port = store.real;
  const ids = [...new Set((orders ?? []).flatMap(order => order.naverPayPaymentId ? [order.naverPayPaymentId] : []))];
  if (!port || !ids.length) return [];
  const reads = await Promise.allSettled(ids.map(id => port.transport.request<NpaySettlement>({
    method: 'GET', path: `/pos/naver/npay/payments/${encodeURIComponent(id)}`, query: { page: 1 }, signal })));
  return reads.flatMap(read => read.status === 'fulfilled' ? [read.value] : []);
}

const won = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;

/** One fact per Npay payment: the approval (date, amount) and what was canceled of it; a payment with no approval line is left out. */
export function npayApprovalFacts(settlements: readonly NpaySettlement[]): readonly AgentFact[] {
  return settlements.flatMap((settlement): AgentFact[] => {
    const approval = settlement.items.find(item => item.kind === 'approval');
    const match = approval && /^(\d{4})-?(\d{2})-?(\d{2})/u.exec(approval.payDate);
    if (!approval || !match) return [];
    const date = match.slice(1, 4).join('-');
    const canceled = settlement.items.filter(item => item.kind === 'cancellation').reduce((sum, item) => sum + Math.abs(item.paySettleAmount), 0);
    return [{ key: 'payments.npay.row', label: '네이버페이 승인', value: approval.paySettleAmount, unit: 'KRW',
      display: [humanDate(date), '네이버페이', won(approval.paySettleAmount), '승인', canceled > 0 && `취소 ${won(canceled)}`].filter(Boolean).join(' · '), date }];
  });
}
