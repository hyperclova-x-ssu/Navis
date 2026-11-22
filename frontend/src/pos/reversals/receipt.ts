import type { PosReadSnapshot, PosReceiptView, PosState } from '../../contracts/pos';
import { freezePos } from '../domain/common';
import { paymentSettlementShares } from '../domain/settlement';
import { selectPaymentRemaining } from './balances';

export function maskReceiptIdentifier(kind: 'income' | 'business', identifier: string): string {
  return kind === 'income' ? `${identifier.slice(0, identifier.startsWith('02') ? 2 : 3)}-****-${identifier.slice(-4)}`
    : `${identifier.slice(0, 3)}-**-**${identifier.slice(-3)}`;
}
export function selectCashReceiptTotals(pos: PosState, period = { start: pos.businessDate, end: pos.businessDate }) {
  const rows = pos.cashReceipts.filter(r => r.status === 'issued' && r.issuedAt.slice(0, 10) >= period.start && r.issuedAt.slice(0, 10) <= period.end);
  return { count: rows.length, amount: rows.reduce((n, r) => n + r.cashAmount, 0) };
}
const cache = new WeakMap<PosReadSnapshot, Map<string, PosReceiptView | null>>();
export function selectReceipt(read: PosReadSnapshot, { paymentId }: { readonly paymentId: string }): PosReceiptView | null {
  let reads = cache.get(read); if (!reads) { reads = new Map(); cache.set(read, reads); }
  if (reads.has(paymentId)) return reads.get(paymentId)!;
  const payment = read.pos.payments.find(p => p.paymentId === paymentId), bill = read.pos.bills.find(b => b.billId === payment?.billId);
  if (!bill || !payment || read.scenario === 'error' || read.scenario === 'empty') return null;
  const balance = selectPaymentRemaining(read.pos, paymentId)!;
  const shares = paymentSettlementShares(read.pos, bill).filter(l => l.paymentId === paymentId && (l.qty || l.gross));
  const corrections = [
    ...read.pos.cancellations.filter(c => c.paymentId === paymentId).map(c => ({ correctionId: c.cancellationId, kind: 'cancel' as const, at: c.at, seq: c.seq, amount: c.amount, methods: c.methodAmounts, restockRetail: c.restockRetail })),
    ...read.pos.refunds.filter(c => c.paymentId === paymentId).map(c => ({ correctionId: c.refundId, kind: 'refund' as const, at: c.at, seq: c.seq, amount: c.amount, methods: c.methodAmounts, restockRetail: false })),
  ].sort((a, b) => a.seq - b.seq);
  const cashReceipt = [...read.pos.cashReceipts].reverse().find(r => r.paymentId === paymentId && r.status === 'issued')
    ?? [...read.pos.cashReceipts].reverse().find(r => r.paymentId === paymentId) ?? null;
  const member = read.data.loyalty?.members.find(m => m.memberId === bill.memberId);
  // The loyalty adapter already masks source members. Mask raw names/phones supplied by other adapters too.
  const rawName = typeof member?.name === 'string' ? member.name : member?.name && 'raw' in member.name ? member.name.raw : null;
  const letters = [...(rawName ?? '')];
  const memberName = rawName === null ? member?.name : rawName.includes('○') ? rawName
    : letters.length < 3 ? `${letters[0] ?? ''}○` : `${letters[0]}${'○'.repeat(letters.length - 2)}${letters.at(-1)}`;
  const lines = shares.map(s => {
    const line = read.pos.orders.flatMap(o => o.lines).find(l => l.orderLineId === s.orderLineId)!;
    return { orderLineId: line.orderLineId, menuId: s.menuId, name: line.nameAtOrder, options: line.optionsAtOrder, request: line.request, qty: s.qty, gross: s.gross, discount: s.discount, amount: s.net };
  });
  const discounts = (['membership', 'coupon', 'direct'] as const).map(source => ({ source, amount: shares.reduce((n, s) => n + s.discountAllocations.filter(d => bill.discounts.some(x => x.discountId === d.discountId && x.source === source)).reduce((n, d) => n + d.amount, 0), 0) })).filter(d => d.amount > 0);
  const refunded = corrections.some(c => c.kind === 'refund'), canceled = corrections.some(c => c.kind === 'cancel');
  const result: PosReceiptView = freezePos({ paymentId, billId: bill.billId, storeName: read.data.storeDisplayName ?? null, at: payment.at,
    orderNos: read.pos.orders.filter(o => o.lines.some(l => shares.some(s => s.orderLineId === l.orderLineId))).map(o => o.orderNo),
    transactionNo: payment.transactionNo, approvalNo: payment.approvalNo, amount: payment.amount, gross: shares.reduce((n, s) => n + s.gross, 0), discount: shares.reduce((n, s) => n + s.discount, 0), remaining: balance.remaining,
    status: payment.status === 'canceled' ? 'canceled' : refunded ? balance.remaining === 0 ? 'refunded' : 'partially_refunded' : canceled ? 'partially_canceled' : 'paid',
    splits: payment.splits, lines, discounts, member: member && memberName ? { memberId: member.memberId, memberCode: member.memberCode, name: memberName, phone: member.phone.includes('*') ? member.phone : maskReceiptIdentifier('income', member.phone) } : null,
    cashReceipt, canIssueCashReceipt: !!balance.methods.find(m => m.method === 'cash' && m.amount > 0) && cashReceipt?.status !== 'issued', corrections });
  reads.set(paymentId, result); return result;
}
