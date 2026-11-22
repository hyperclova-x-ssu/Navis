import { validDate } from '../02/terminal.ts';
import { currentDay, type FinanceTx } from '../09/input.ts';
import { integer, object, PosError, uuid } from '../../wire.ts';

/** Tax periods cover a VAT half-year or an annual simplified return, so they allow up to 366 days. */
export const maxPeriodDays = 366;
/** Same visible receipt deadline as the B09 finance commands. */
export const undoMillis = 6_000;
export const taxSources = ['pos.tax-payments', 'pos.tax'] as const;

/** Same normalization as the widget duplicate guard (`normalizeName`), so both report the same existing record. */
export function typeKey(value: string) {
  return value.normalize('NFKC').replace(/[\s·・.,'"\-_()[\]{}]+/g, '').toLowerCase();
}

export function taxType(value: unknown) {
  if (typeof value !== 'string' || value.includes('\0')) throw new PosError(400, 'TAX_TYPE_REQUIRED');
  const type = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  const key = typeKey(type);
  if (!type || !key) throw new PosError(400, 'TAX_TYPE_REQUIRED');
  if (type.length > 60) throw new PosError(400, 'TAX_TYPE_TOO_LONG');
  return { type, key };
}

export function amount(value: unknown) {
  return integer(value, 1, Number.MAX_SAFE_INTEGER, 'AMOUNT_INVALID');
}

export function day(value: unknown) {
  if (typeof value !== 'string' || !validDate(value)) throw new PosError(400, 'DATE_INVALID');
  return value;
}

export function revisionInput(value: unknown, reason = 'INVALID_REQUEST') {
  return integer(value, 1, 2_147_483_647, reason);
}

export function confirmed(value: unknown) {
  if (value !== true) throw new PosError(400, 'CONFIRMATION_REQUIRED');
}

export function limitInput(value: unknown) {
  if (value === undefined) return 30;
  const limit = typeof value === 'string' && /^[1-9]\d?$/.test(value) ? Number(value) : 0;
  if (!limit || limit > 50) throw new PosError(400, 'INVALID_LIMIT');
  return limit;
}

export function cursorInput(value: unknown) {
  return value === undefined ? null : uuid(value);
}

function spanDays(from: string, to: string) {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
}

export function addDays(date: string, days: number) {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Inclusive `from`/`to`. Without them the period is the current operating month up to today. */
export async function taxPeriod(tx: FinanceTx, input: Record<string, unknown>) {
  const { from, to } = input;
  if (from === undefined && to === undefined) {
    const today = await currentDay(tx);
    return { from: `${today.slice(0, 8)}01`, to: today, today };
  }
  if (typeof from !== 'string' || typeof to !== 'string' || !validDate(from) || !validDate(to)
    || from > to || spanDays(from, to) > maxPeriodDays) throw new PosError(400, 'INVALID_PERIOD');
  return { from, to, today: await currentDay(tx) };
}

export function query(value: unknown, keys: readonly string[]) {
  return object(value ?? {}, keys);
}
