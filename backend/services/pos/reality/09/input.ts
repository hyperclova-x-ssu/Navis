import { listInput } from '../02/reads.ts';
import { validDate } from '../02/terminal.ts';
import { fingerprint, PosError, type PosTx } from '../../wire.ts';

export type FinanceTx = PosTx & { clock?: { timezone: string; dayStart: string } };

export function date(value: unknown) {
  if (typeof value !== 'string' || !validDate(value)) throw new PosError(400, 'INVALID_BUSINESS_DATE');
  return value;
}

export function text(value: unknown, max: number) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new PosError(400, 'INVALID_TEXT');
  return value.trim();
}

export function confirmed(value: unknown) {
  if (value !== true) throw new PosError(400, 'CONFIRMATION_REQUIRED');
}

export function revision(value: unknown) {
  return Number.parseInt(fingerprint(value).slice(0, 13), 16);
}

export function money(value: string | number | bigint) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new PosError(503, 'FINANCE_TOTAL_UNAVAILABLE');
  return amount;
}

export function timezone(tx: FinanceTx) {
  return tx.clock?.timezone ?? 'Asia/Seoul';
}

export async function currentDay(tx: FinanceTx) {
  const { rows: [row] } = await tx.db.query<{ date: string }>(`
    SELECT coalesce(
      (SELECT business_date FROM pos.business_day WHERE store_id = $1 AND starts_at <= $2 AND ends_at > $2
        ORDER BY starts_at DESC LIMIT 1),
      (($2::timestamptz AT TIME ZONE $3) - ($4::time - time '00:00'))::date
    )::text AS date
  `, [tx.storeId, tx.at, timezone(tx), tx.clock?.dayStart ?? '00:00:00']);
  return row.date;
}

export async function period<Filter extends string>(tx: FinanceTx, query: unknown, filters: readonly Filter[]) {
  const input = listInput(query, filters, true);
  const from = input.from ?? await currentDay(tx);
  return { ...input, from, to: input.to ?? from };
}
