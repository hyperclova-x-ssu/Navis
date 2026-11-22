import { isUuid, object, PosError, type PosTx } from '../../wire.ts';

export type TerminalRecord = { approvalNo: string | null; receiptNo: string | null; occurredAt: string };
export type PaymentChannel = 'fixture' | 'cash_record' | 'terminal_record';

/** The simulated kiosk submits its order UUID in the checkout key and a matching terminal marker. */
export function connectSource(key: string, quoteRevision: number, terminal: TerminalRecord | null) {
  const [, attemptId] = key.split(':');
  if (isUuid(attemptId) && key === `payment:${attemptId}:${quoteRevision}`
    && terminal?.approvalNo === `NC-${attemptId.replaceAll('-', '').slice(0, 12).toUpperCase()}`) return 'connect';
}

function reference(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value.trim())) {
    throw new PosError(400, 'TERMINAL_REFERENCE_INVALID');
  }
  return value.trim().toUpperCase();
}

export function parseTerminal(value: unknown): TerminalRecord | null {
  if (value === undefined) return null;
  const input = object(value, ['approvalNo', 'receiptNo', 'occurredAt']);
  const approvalNo = reference(input.approvalNo);
  const receiptNo = reference(input.receiptNo);
  if (!approvalNo && !receiptNo) throw new PosError(400, 'TERMINAL_REFERENCE_INVALID');
  const date = input.occurredAt;
  if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/.test(date)
      || !Number.isFinite(Date.parse(date)) || !validDate(date.slice(0, 10))) {
    throw new PosError(400, 'TERMINAL_TIME_INVALID');
  }
  return { approvalNo, receiptNo, occurredAt: new Date(date).toISOString() };
}

export function validDate(value: string) {
  if (!/^\d{4}-\d\d-\d\d$/.test(value) || value.startsWith('0000-')) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(`${value}T`);
}

export function requireTerminal(channel: PaymentChannel, terminal: TerminalRecord | null) {
  if (channel === 'terminal_record' && !terminal) throw new PosError(400, 'TERMINAL_RECORD_REQUIRED');
  if (channel !== 'terminal_record' && terminal) throw new PosError(400, 'TERMINAL_RECORD_UNEXPECTED');
}

export async function insertTerminal(
  { db, storeId, at }: PosTx, day: string, paymentId: string, correctionId: string | null, record: TerminalRecord,
) {
  if (Date.parse(record.occurredAt) > at.getTime()) throw new PosError(400, 'TERMINAL_TIME_INVALID');
  const boundary = await db.query(`
    SELECT 1 FROM pos.business_day WHERE store_id = $1 AND business_date = $2
      AND starts_at <= $3 AND ends_at > $3
  `, [storeId, day, record.occurredAt]);
  if (!boundary.rowCount) throw new PosError(400, 'TERMINAL_TIME_INVALID');

  const inserted = await db.query(`
    INSERT INTO pos.terminal_record
      (store_id, record_id, payment_id, correction_id, business_date, approval_no, receipt_no, occurred_at, recorded_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING
  `, [storeId, correctionId ?? paymentId, paymentId, correctionId, day, record.approvalNo, record.receiptNo, record.occurredAt, at]);
  if (!inserted.rowCount) throw new PosError(409, 'TERMINAL_REFERENCE_EXISTS');
}

export function readTerminal(row: { approvalNo: string | null; receiptNo: string | null; occurredAt: Date | null }): TerminalRecord | null {
  if (!row.occurredAt) return null;
  return { approvalNo: row.approvalNo, receiptNo: row.receiptNo, occurredAt: row.occurredAt.toISOString() };
}
