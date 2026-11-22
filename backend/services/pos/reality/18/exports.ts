import { randomUUID } from 'node:crypto';
import { applyCommand } from '../../ledger.ts';
import { commandReceipt, integer, methods, object, PosError } from '../../wire.ts';
import { readFinance } from '../09/finance.ts';
import { money, revision as contentRevision, type FinanceTx } from '../09/input.ts';
import { encodeCsv, encodeXlsx, sha256, type ExportRow, type SummaryRow } from './files.ts';
import { cursorInput, day, limitInput, maxPeriodDays, query, taxPeriod } from './input.ts';
import { reviewCounts } from './reviews.ts';

const categoryLabels: Record<string, string> = {
  ingredients: '원재료', operations: '운영비', supplies: '소모품', labor: '인건비', rent: '임대료', other: '기타',
};
const evidenceLabels: Record<string, string> = { receipt: '영수증', 'tax-invoice': '세금계산서', card: '카드 내역', none: '증빙 없음' };
const methodLabels = { card: '카드', easy_pay: '간편결제', cash: '현금' } as const;
export const maxExportRows = 20_000;
/** D-347: Navis does not file, pay or look up taxes. The owner opens the official site. */
export const officialLinks = { hometax: 'https://www.hometax.go.kr/' } as const;
const contentTypes = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as const;
type Format = keyof typeof contentTypes;

type ExpenseDb = { expenseId: string; date: string; category: string; amount: number; evidence: string; memo: string | null; receiptId: string | null };
type PaymentDb = { taxPaymentId: string; type: string; amount: number; dueOn: string; paidOn: string | null; status: 'paid' | 'unpaid'; files: number };

function total(rows: readonly ExportRow[], kind: ExportRow['kind']) {
  return money(rows.filter(row => row.kind === kind).reduce((sum, row) => sum + BigInt(row.amount), 0n));
}

/**
 * Builds the accountant ledger from B09's finance read (`readFinance`) plus the expense and tax payment rows,
 * then verifies that the rows add up to the same ledger totals the widgets show.
 */
async function buildExport(tx: FinanceTx, from: string, to: string) {
  const finance = await readFinance(tx, from, to);
  const rows: ExportRow[] = [];
  const blank = { evidence: '', evidenceFiles: null, paidOn: null, memo: '', sourceId: '' };
  for (const { businessDate, sales } of finance.days) {
    if (!sales.gross && !sales.discount && !sales.refund && !sales.total) continue;
    rows.push({ ...blank, kind: 'sales', date: businessDate, item: '순매출',
      detail: `총매출 ${sales.gross} · 할인 ${sales.discount} · 환불 ${sales.refund}`, amount: sales.total });
  }
  for (const { businessDate, deposits } of finance.days) {
    for (const method of methods) {
      const gross = deposits.byMethodGross[method], returned = deposits.byMethodReturned[method];
      if (!gross && !returned) continue;
      rows.push({ ...blank, kind: 'deposit', date: businessDate, item: '실제 입금',
        detail: returned ? `${methodLabels[method]} · 받은 금액 ${gross} · 돌려준 금액 ${returned}` : methodLabels[method],
        amount: deposits.byMethod[method] });
    }
  }
  const { rows: expenses } = await tx.db.query<ExpenseDb>(`
    SELECT expense_id AS "expenseId", business_date::text AS date, category, amount::double precision AS amount,
      evidence, memo, receipt_id AS "receiptId"
    FROM pos.expense WHERE store_id = $1 AND business_date BETWEEN $2 AND $3 AND status = 'confirmed'
    ORDER BY business_date, expense_id
  `, [tx.storeId, from, to]);
  for (const expense of expenses) {
    rows.push({ kind: 'expense', date: expense.date, item: categoryLabels[expense.category] ?? expense.category,
      detail: expense.receiptId ? '발주 입고' : '', amount: expense.amount, evidence: evidenceLabels[expense.evidence] ?? expense.evidence,
      evidenceFiles: null, paidOn: null, memo: expense.memo ?? '', sourceId: expense.expenseId });
  }
  const { rows: payments } = await tx.db.query<PaymentDb>(`
    SELECT p.tax_payment_id AS "taxPaymentId", p.tax_type AS type, p.amount::double precision AS amount,
      p.due_on::text AS "dueOn", p.paid_on::text AS "paidOn", p.status,
      (SELECT count(*) FROM pos.tax_evidence e WHERE e.store_id = p.store_id AND e.tax_payment_id = p.tax_payment_id
        AND e.detached_at IS NULL)::integer AS files
    FROM pos.tax_payment p
    WHERE p.store_id = $1 AND p.deleted_at IS NULL AND (p.due_on BETWEEN $2 AND $3 OR p.paid_on BETWEEN $2 AND $3)
    ORDER BY p.due_on, p.tax_payment_id
  `, [tx.storeId, from, to]);
  for (const payment of payments) {
    rows.push({ kind: 'tax-payment', date: payment.dueOn, item: payment.type,
      detail: payment.status === 'paid' ? '납부 완료(사장님 기록)' : '납부 전', amount: payment.amount,
      evidence: payment.files ? '증빙 파일 있음' : '증빙 파일 없음', evidenceFiles: payment.files, paidOn: payment.paidOn,
      memo: '', sourceId: payment.taxPaymentId });
  }

  const reviews = await reviewCounts(tx, from, to);
  const { sales, deposits } = finance.totals;
  const paid = payments.filter(payment => payment.status === 'paid');
  const preview = {
    from, to,
    sales: { gross: sales.gross, discount: sales.discount, refund: sales.refund, total: sales.total, bySource: sales.bySource },
    deposits: { total: deposits.total, byMethod: deposits.byMethod },
    expenses: { total: finance.totals.expenses, count: expenses.length,
      evidenceRecorded: expenses.filter(expense => expense.evidence !== 'none').length,
      missingEvidence: expenses.filter(expense => expense.evidence === 'none').length },
    reviews: { needsCheck: reviews.needsCheck, checked: reviews.checked },
    taxPayments: { count: payments.length, paidTotal: money(paid.reduce((sum, row) => sum + BigInt(row.amount), 0n)),
      unpaidTotal: money(payments.filter(row => row.status === 'unpaid').reduce((sum, row) => sum + BigInt(row.amount), 0n)),
      withEvidenceFile: payments.filter(row => row.files > 0).length },
    // POS keeps no cash-receipt issuance records; the widget must show this as unavailable, not as zero.
    cashReceipts: null,
    rowCount: rows.length,
  };
  const checks = [
    { check: 'sales-total', expected: sales.total, actual: total(rows, 'sales') },
    { check: 'deposit-total', expected: deposits.total, actual: total(rows, 'deposit') },
    { check: 'expense-total', expected: finance.totals.expenses, actual: total(rows, 'expense') },
  ];
  const verification = { status: checks.every(item => item.expected === item.actual) ? 'verified' as const : 'mismatch' as const, checks };
  const deductible = money(expenses.filter(expense => expense.evidence === 'tax-invoice' || expense.evidence === 'card')
    .reduce((sum, expense) => sum + BigInt(expense.amount), 0n));
  // Same rule as the widget: shown only when every review item is checked.
  const estimate = reviews.needsCheck === 0 ? {
    amount: Math.max(0, Math.round((sales.total - deductible) / 11 / 10) * 10), basisDate: to,
    salesTotal: sales.total, deductibleExpenses: deductible, assumption: 'vat-included-10-percent' as const,
  } : null;
  const connections = [
    { source: 'sales' as const, status: 'connected' as const },
    { source: 'expenses' as const, status: 'connected' as const },
    { source: 'evidence' as const, status: reviews.needsCheck > 0 ? 'partial' as const : 'connected' as const },
  ];
  const summary: SummaryRow[] = [
    ['기간', `${from} ~ ${to}`], ['순매출', sales.total], ['총매출', sales.gross], ['할인', sales.discount], ['환불', sales.refund],
    ['실제 입금 합계', deposits.total], ...methods.map((method): SummaryRow => [`${methodLabels[method]} 입금`, deposits.byMethod[method]]),
    ['지출 합계', finance.totals.expenses], ['지출 건수', expenses.length], ['증빙 구분을 기록한 지출', preview.expenses.evidenceRecorded],
    ['증빙 없는 지출', preview.expenses.missingEvidence], ['납부 완료로 기록한 세금', preview.taxPayments.paidTotal],
    ['납부 전 세금', preview.taxPayments.unpaidTotal], ['현금영수증', 'POS 기록 없음'],
    ['검증', verification.status === 'verified' ? '장부 합계와 일치' : '장부 합계와 다름'],
    ['안내', '세금 신고·납부는 홈택스에서 직접 해요. 납부 완료는 사장님이 적은 기록이에요.'],
  ];
  return { rows, summary, preview, verification, estimate, connections,
    sourceRevision: contentRevision({ from, to, rows, preview }) };
}

export async function previewExport(tx: FinanceTx, value: unknown) {
  const { from, to } = await taxPeriod(tx, query(value, ['from', 'to']));
  const { preview, verification, estimate, connections, sourceRevision } = await buildExport(tx, from, to);
  return { from, to, preview, verification, estimate, connections, officialLinks, asOf: tx.at.toISOString(), sourceRevision };
}

function files(from: string, to: string, csv: Buffer, xlsx: Buffer) {
  const base = `navis-tax-${from}_${to}`;
  return {
    csv: { filename: `${base}.csv`, contentType: contentTypes.csv, size: csv.length, sha256: sha256(csv) },
    xlsx: { filename: `${base}.xlsx`, contentType: contentTypes.xlsx, size: xlsx.length, sha256: sha256(xlsx) },
  };
}

/**
 * `tax.export({period})`: freezes the verified rows. Pass the preview's `sourceRevision` as `expectedSourceRevision`
 * so the file can only be made from the figures the owner saw.
 */
export function createExport(tx: FinanceTx, key: string, body: unknown) {
  const input = object(body, ['from', 'to', 'expectedSourceRevision']);
  let from: string, to: string;
  try {
    from = day(input.from);
    to = day(input.to);
  } catch {
    throw new PosError(400, 'INVALID_PERIOD');
  }
  if (from > to || (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > maxPeriodDays) throw new PosError(400, 'INVALID_PERIOD');
  const expected = input.expectedSourceRevision === undefined ? null : integer(input.expectedSourceRevision, 0);
  return applyCommand(tx, 'tax.export.create', key, { from, to, expected }, async () => {
    const built = await buildExport(tx, from, to);
    if (expected !== null && built.sourceRevision !== expected) {
      throw new PosError(409, 'TAX_EXPORT_PREVIEW_CHANGED', { sourceRevision: built.sourceRevision, preview: built.preview });
    }
    if (built.verification.status !== 'verified') throw new PosError(503, 'TAX_EXPORT_UNVERIFIED', { checks: built.verification.checks });
    if (built.rows.length > maxExportRows) throw new PosError(400, 'TAX_EXPORT_TOO_LARGE', { max: maxExportRows });
    const exportId = randomUUID();
    const csv = encodeCsv(built.rows), xlsx = encodeXlsx(built.rows, built.summary, tx.at);
    const info = files(from, to, csv, xlsx);
    await tx.db.query(`
      INSERT INTO pos.tax_export (store_id, export_id, from_date, to_date, created_by, created_at, source_revision, row_count,
        csv_sha256, xlsx_sha256, snapshot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [tx.storeId, exportId, from, to, tx.actorId, tx.at, built.sourceRevision, built.rows.length, info.csv.sha256, info.xlsx.sha256,
      { rows: built.rows, summary: built.summary, preview: built.preview, verification: built.verification }]);
    return { ...commandReceipt(exportId, 1, ['pos.tax-exports']), exportId, from, to, createdAt: tx.at.toISOString(),
      rowCount: built.rows.length, preview: built.preview, verification: built.verification, sourceRevision: built.sourceRevision, files: info };
  });
}

type ExportDb = {
  exportId: string; from: string; to: string; createdAt: Date; rowCount: number; sourceRevision: string;
  csvSha256: string; xlsxSha256: string; snapshot: { rows: ExportRow[]; summary: SummaryRow[]; preview: unknown; verification: unknown };
};
const exportColumns = `export_id AS "exportId", from_date::text AS "from", to_date::text AS "to", created_at AS "createdAt",
  row_count AS "rowCount", source_revision AS "sourceRevision", csv_sha256 AS "csvSha256", xlsx_sha256 AS "xlsxSha256"`;

async function readExport(tx: FinanceTx, exportId: string, withRows = false) {
  const { rows: [row] } = await tx.db.query<ExportDb>(`
    SELECT ${exportColumns}, ${withRows ? 'snapshot' : `jsonb_build_object('preview', snapshot->'preview', 'verification', snapshot->'verification') AS snapshot`}
    FROM pos.tax_export WHERE store_id = $1 AND export_id = $2
  `, [tx.storeId, exportId]);
  if (!row) throw new PosError(404, 'TAX_EXPORT_NOT_FOUND');
  return row;
}

function exportDto(row: ExportDb) {
  return { exportId: row.exportId, from: row.from, to: row.to, createdAt: row.createdAt.toISOString(), rowCount: row.rowCount,
    sourceRevision: Number(row.sourceRevision), preview: row.snapshot.preview, verification: row.snapshot.verification,
    files: { csv: { sha256: row.csvSha256 }, xlsx: { sha256: row.xlsxSha256 } } };
}

export async function exportDetail(tx: FinanceTx, exportId: string) {
  return { ...exportDto(await readExport(tx, exportId)), asOf: tx.at.toISOString() };
}

export async function listExports(tx: FinanceTx, value: unknown) {
  const input = query(value, ['cursor', 'limit']);
  const limit = limitInput(input.limit);
  const cursor = cursorInput(input.cursor);
  const { rows } = await tx.db.query<ExportDb>(`
    SELECT ${exportColumns}, jsonb_build_object('preview', snapshot->'preview', 'verification', snapshot->'verification') AS snapshot
    FROM pos.tax_export WHERE store_id = $1
      AND ($2::uuid IS NULL OR (created_at, export_id) < (SELECT created_at, export_id FROM pos.tax_export WHERE store_id = $1 AND export_id = $2))
    ORDER BY created_at DESC, export_id DESC LIMIT $3
  `, [tx.storeId, cursor, limit + 1]);
  const items = rows.slice(0, limit).map(exportDto);
  const nextCursor = rows.length > limit ? items[limit - 1].exportId : null;
  return { items, nextCursor, asOf: tx.at.toISOString(), sourceRevision: contentRevision({ items, nextCursor }) };
}

/** The SPA holds its bearer token in memory, so the file is returned as base64 JSON for a Blob download. */
export async function exportFile(tx: FinanceTx, exportId: string, value: unknown) {
  const input = query(value, ['format']);
  const format: Format = input.format === undefined ? 'csv' : input.format === 'csv' || input.format === 'xlsx' ? input.format : (() => {
    throw new PosError(400, 'INVALID_FORMAT');
  })();
  const row = await readExport(tx, exportId, true);
  const csv = encodeCsv(row.snapshot.rows);
  const xlsx = encodeXlsx(row.snapshot.rows, row.snapshot.summary, row.createdAt);
  const info = files(row.from, row.to, csv, xlsx);
  if (info.csv.sha256 !== row.csvSha256 || info.xlsx.sha256 !== row.xlsxSha256) throw new PosError(503, 'TAX_EXPORT_INTEGRITY');
  const content = format === 'csv' ? csv : xlsx;
  return { exportId, format, ...info[format], contentBase64: content.toString('base64'), asOf: tx.at.toISOString(),
    sourceRevision: Number(row.sourceRevision) };
}
