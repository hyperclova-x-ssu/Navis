import { addDays } from '../../db/time';
import type { TaxPayment } from '../../db/management-types';
import { defineBinding, PortError, type CommandContext, type DomainAdapter } from '../00';
import type { TaxExportPreviewDto, TaxPaymentDto, TaxPaymentsDto, TaxReviewDto } from './dto';

const payments = '/pos/tax-payments';
const reviews = '/pos/tax-reviews';
const exportsPath = '/pos/tax-exports';
const receiptBase = '/pos/tax';
const saved = 'data.management.notice.saved';
const paymentPath = (id: string) => `${payments}/${encodeURIComponent(id)}`;
const paymentKey = (id: string) => `tax-payment:${id}`;
const reviewKey = (id: string) => `tax-review-expense:${id}`;
const exportKey = (from: string, to: string) => `tax-preview:${from}:${to}`;
const stale = () => new PortError(409, 'CONFLICT', 'STALE_REVISION');

function revision(ctx: CommandContext, key: string): number {
  const current = ctx.revision(key);
  if (current === undefined) throw stale();
  return current;
}

function toPayment(row: TaxPaymentDto): TaxPayment {
  return {
    taxPaymentId: row.taxPaymentId, type: { raw: row.type }, amount: row.amount, status: row.status,
    dueOn: row.dueOn, paidOn: row.paidOn, evidence: 'none',
    real: { revision: row.revision, overdue: row.overdue, evidenceFiles: row.evidence === 'attached' ? row.evidenceFiles : [] },
  };
}

export const taxAdapter: DomainAdapter = {
  domain: 'tax',
  sources: ['pos.tax', 'pos.tax-payments', 'pos.tax-exports', 'pos.expenses', 'pos.ledger', 'pos.sales', 'pos.receipts', 'pos.member-accounts', 'pos.member-funding', 'pos.custom-orders'],
  tables: ['taxPayment', 'taxReview', 'realTax'],
  clear: () => ({ taxPayment: [], taxReview: [], realTax: undefined }),
  errorKeys: {
    TAX_PAYMENT_EXISTS: 'data.management.error.TAX_PAYMENT_EXISTS',
    TAX_TYPE_REQUIRED: 'data.management.error.TAX_TYPE_REQUIRED',
    TAX_TYPE_TOO_LONG: 'data.management.error.TAX_TYPE_REQUIRED',
    AMOUNT_INVALID: 'data.management.error.AMOUNT_INVALID',
    DATE_INVALID: 'data.error.dateInvalid',
    PAID_ON_FUTURE: 'data.error.dateInvalid',
    INVALID_PERIOD: 'data.error.periodRequired',
  },
  async load({ reads, signal }) {
    const paymentRead = { resource: 'tax-payments', path: payments, query: { limit: 50 } };
    const first = await reads.page<TaxPaymentDto>(paymentRead, { signal }) as TaxPaymentsDto;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(first.today)) throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
    const monthFrom = `${first.today.slice(0, 8)}01`;
    const lastTo = addDays(monthFrom, -1);
    const lastFrom = `${lastTo.slice(0, 8)}01`;
    const readPeriod = async (from: string, to: string) => {
      const [list, preview] = await Promise.all([
        reads.all<TaxReviewDto>({ resource: 'tax-reviews', path: reviews, query: { from, to, limit: 50 } }, { signal }),
        reads.one<TaxExportPreviewDto>({ resource: 'tax-preview', path: `${exportsPath}/preview`, query: { from, to } }, { signal }),
      ]);
      return { preview, reviews: list.items, complete: list.complete };
    };
    const [paymentList, month, last] = await Promise.all([
      first.nextCursor ? reads.all<TaxPaymentDto>(paymentRead, { signal }) : { ...first, complete: true },
      readPeriod(monthFrom, first.today), readPeriod(lastFrom, lastTo),
    ]);
    const allReviews = [...month.reviews, ...last.reviews];
    return {
      tables: {
        taxPayment: paymentList.items.map(toPayment),
        taxReview: allReviews.map(({ refType, refId, status }) => ({ refType, refId, status })),
        realTax: { today: first.today, month, last },
      },
      revisions: Object.fromEntries([
        ...paymentList.items.map(row => [paymentKey(row.taxPaymentId), row.revision]),
        ...allReviews.map(row => [reviewKey(row.refId), row.expenseRevision]),
        ...[month.preview, last.preview].map(row => [exportKey(row.from, row.to), row.sourceRevision]),
      ]),
      asOf: month.preview.asOf,
      sourceRevision: month.preview.sourceRevision,
      complete: paymentList.complete && month.complete && last.complete,
    };
  },
  commands: [
    defineBinding({ type: 'tax.createPayment', receiptBase, noticeKey: saved, request: ({ taxType, amount, dueOn, confirmDuplicate }) => ({
      method: 'POST', path: payments, body: { taxType, amount, dueOn, ...(confirmDuplicate ? { confirmDuplicate } : {}) },
    }) }),
    defineBinding({ type: 'tax.updatePayment', receiptBase, noticeKey: saved, request: ({ taxPaymentId, patch }, ctx) => ({
      method: 'PATCH', path: paymentPath(taxPaymentId), body: patch, expectedRevision: revision(ctx, paymentKey(taxPaymentId)),
    }) }),
    defineBinding({ type: 'tax.deletePayment', receiptBase, noticeKey: 'data.management.notice.deleted', request: ({ taxPaymentId }, ctx) => ({
      method: 'DELETE', path: paymentPath(taxPaymentId), body: { confirmed: true }, expectedRevision: revision(ctx, paymentKey(taxPaymentId)),
    }) }),
    defineBinding({ type: 'tax.markPaid', receiptBase, noticeKey: saved, request: ({ taxPaymentId }, ctx) => ({
      method: 'POST', path: `${paymentPath(taxPaymentId)}/paid`, expectedRevision: revision(ctx, paymentKey(taxPaymentId)),
    }) }),
    defineBinding({ type: 'tax.setEvidence', request: () => {
      throw new PortError(400, 'VALIDATION', 'SOURCE_UNAVAILABLE');
    } }),
    defineBinding({ type: 'tax.attachEvidence', receiptBase, noticeKey: saved, request: ({ taxPaymentId, fileId, expectedRevision }) => ({
      method: 'POST', path: `${paymentPath(taxPaymentId)}/evidence`, body: { fileId }, expectedRevision,
    }) }),
    defineBinding({ type: 'tax.detachEvidence', receiptBase, noticeKey: saved, request: ({ taxPaymentId, fileId, expectedRevision }) => ({
      method: 'DELETE', path: `${paymentPath(taxPaymentId)}/evidence/${encodeURIComponent(fileId)}`, body: { confirmed: true }, expectedRevision,
    }) }),
    defineBinding({ type: 'tax.markChecked', receiptBase, noticeKey: 'data.notice.taxChecked', request: ({ refId }, ctx) => ({
      method: 'POST', path: `${reviews}/${encodeURIComponent(refId)}/check`, body: { expenseRevision: revision(ctx, reviewKey(refId)) },
    }) }),
    defineBinding({ type: 'tax.export', request: ({ period }, ctx) => ({
      method: 'POST', path: exportsPath,
      body: { from: period.start, to: period.end, expectedSourceRevision: revision(ctx, exportKey(period.start, period.end)) },
    }) }),
  ],
};
