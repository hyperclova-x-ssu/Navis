import type { DataSnapshot } from '../../db/types';
import type { TaxModel } from '../../models/types';

export function realTaxModel(snapshot: DataSnapshot, previousMonth: boolean): TaxModel | undefined {
  const real = snapshot.tables.realTax;
  if (!real) return;
  const { preview: read, reviews } = previousMonth ? real.last : real.month;
  const { preview, estimate, connections } = read;
  return {
    real: read,
    today: real.today,
    payments: snapshot.tables.taxPayment.map(payment => ({ ...payment, overdue: payment.real?.overdue ?? false })),
    period: { start: read.from, end: read.to },
    items: reviews.map(({ refId, refType, date, amount, category, memo, status }) => ({
      refId, refType, date, amount, category, status, categoryKey: `data.expenseCategory.${category}`,
      memo: memo ? { raw: memo } : null, reasonKey: 'data.tax.reason.missingEvidence',
    })),
    reviewCount: reviews.filter(item => item.status === 'needs-check').length,
    estimate: estimate && { ...estimate, assumptionKey: 'data.tax.assumption' },
    connections: connections.map(({ source, status }) => ({
      source, status, sourceKey: `data.tax.source.${source}`, statusKey: `data.tax.connection.${status}`,
    })),
    exportPreview: {
      salesTotal: preview.sales.total, expenseTotal: preview.expenses.total,
      withEvidence: preview.expenses.evidenceRecorded, missingEvidence: preview.expenses.missingEvidence,
      cashReceipts: preview.cashReceipts,
    },
  };
}
