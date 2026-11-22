/**
 * "최근 결제된 거 있어?", "주문 확인해줘": the newest POS orders with their payment state. A Connect kiosk order is named by its source
 * (and tender) so the owner can tell which order just arrived. The facts join the `pos` source next to the closing facts.
 */
import type { Locale } from '../../../contracts';
import { connectOrigin } from '../../../connect-kiosk/channel';
import { posReadForFacts } from '../../../data/facts';
import type { DataSnapshot } from '../../../data/db/types';
import { selectOrderSummary } from '../../../pos/status';
import type { OrderPaymentStatus } from '../../../pos/status';
import type { AgentFact } from '../../../../shared/navis-agent-schema.mjs';
import { navisTranslator } from '../messages';

export const RECENT_ORDER_COUNT = 3;
const METHOD = { card: '카드', easy_pay: '간편결제', cash: '현금' } as const;
const PREPARATION = { accepted: '접수', preparing: '준비 중', completed: '준비 완료' } as const;

const STATUS: Readonly<Record<OrderPaymentStatus, { readonly ko: string; readonly en: string }>> = {
  paid: { ko: '결제 완료', en: 'Paid' }, unpaid: { ko: '결제 전', en: 'Not paid yet' }, partial: { ko: '일부 결제', en: 'Partly paid' },
  canceled: { ko: '취소', en: 'Canceled' }, refunded: { ko: '환불', en: 'Refunded' }, partially_refunded: { ko: '일부 환불', en: 'Partly refunded' },
  partially_canceled: { ko: '일부 취소', en: 'Partly canceled' },
};

export function recentOrderFacts(snapshot: DataSnapshot, locale: Locale): readonly AgentFact[] {
  const read = posReadForFacts(snapshot);
  if (!read) return [];
  const tr = navisTranslator(locale);
  const rows = selectOrderSummary(read, { filter: 'all' }).rows.filter(row => row.preparation !== 'canceled').slice(0, RECENT_ORDER_COUNT);
  const date = read.pos.businessDate;
  return rows.map((row): AgentFact => {
    const origin = connectOrigin({ orderNo: row.no, memo: row.memo });
    const status = STATUS[row.paymentStatus][locale === 'ko' ? 'ko' : 'en'];
    const time = row.orderedAt.slice(11, 16);
    const label = locale === 'ko' ? `${row.no}번 주문` : `Order ${row.no}`;
    // The order line total is the price before discounts. A paid order shows what the bills were actually paid for, and the discount when there was one.
    const billIds = new Set(row.billIds);
    const paid = read.pos.payments.filter(payment => payment.status === 'paid' && billIds.has(payment.billId)).reduce((sum, payment) => sum + payment.amount, 0);
    const settled = row.paymentStatus === 'paid' && paid > 0 ? paid : row.amount;
    const discount = row.paymentStatus === 'paid' && paid > 0 && paid < row.amount ? row.amount - paid : 0;
    const prepared = row.preparation === 'canceled' ? undefined : PREPARATION[row.preparation];
    const display = [time, row.menuText, tr.format.money(settled, 'full'), locale === 'ko' ? prepared : undefined, status, discount > 0 && (locale === 'ko' ? `할인 ${tr.format.money(discount, 'full')}` : `Discount ${tr.format.money(discount, 'full')}`),
      origin && `${origin.source} ${origin.payment}`].filter(Boolean).join(' · ');
    return { key: 'orders.recent.row', label, value: settled, unit: 'KRW', display, date };
  });
}

/**
 * "최근 결제된 거 있어?": the newest payments (time, amount, method, state) and what today's payments add up to. A payment is a money fact, apart from the
 * order it paid for; refunds and cancellations are not listed as paid.
 */
export function recentPaymentFacts(snapshot: DataSnapshot, locale: Locale): readonly AgentFact[] {
  const read = posReadForFacts(snapshot);
  if (!read || locale !== 'ko') return [];
  const tr = navisTranslator(locale), date = read.pos.businessDate;
  const orders = selectOrderSummary(read, { filter: 'all' }).rows;
  const paid = [...read.pos.payments].filter(payment => payment.status === 'paid').sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq);
  const rows = paid.slice(0, RECENT_ORDER_COUNT).map((payment): AgentFact => {
    const methods = [...new Set(payment.splits.map(split => METHOD[split.method]))].join('·') || METHOD[payment.countedMethod];
    const order = orders.find(row => row.billIds.includes(payment.billId));
    const connect = order && connectOrigin({ orderNo: order.no, memo: order.memo });
    return { key: 'payments.recent.row', label: '최근 결제', value: payment.amount, unit: 'KRW',
      display: [payment.at.slice(11, 16), tr.format.money(payment.amount, 'full'), methods, '결제 완료', connect?.source].filter(Boolean).join(' · '), date };
  });
  if (!paid.length) return [{ key: 'payments.today.total', label: '오늘 결제', value: 0, unit: 'KRW', display: '0건 · 0원', date }];
  const total = paid.reduce((sum, payment) => sum + payment.amount, 0);
  return [...rows, { key: 'payments.today.total', label: '오늘 결제', value: total, unit: 'KRW', display: `${paid.length}건 · ${tr.format.money(total, 'full')}`, date }];
}

/** The hour with the most orders today, from the loaded POS orders ("오늘 제일 붐비는 시간이 언제야?"). */
export function peakOrderFacts(snapshot: DataSnapshot, locale: Locale): readonly AgentFact[] {
  const read = posReadForFacts(snapshot);
  if (!read) return [];
  const byHour = new Map<number, number>();
  for (const order of read.pos.orders) {
    if (order.preparation === 'canceled') continue;
    const hour = Number(order.orderedAt.slice(11, 13));
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
  }
  const best = [...byHour].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  if (!best) return [];
  const [hour, count] = best;
  const display = locale === 'ko' ? `${hour}시~${hour + 1}시 · 주문 ${count}건` : `${hour}:00–${hour + 1}:00 · ${count} orders`;
  return [{ key: 'orders.peak.hour', label: locale === 'ko' ? '오늘 주문이 가장 많은 시간' : 'Busiest hour today', value: hour, unit: 'hour', display, date: read.pos.businessDate }];
}

