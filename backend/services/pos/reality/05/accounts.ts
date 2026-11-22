import { randomUUID } from 'node:crypto';
import { appendOutbox } from '../../ledger.ts';
import { object, PosError, uuid, type PosTx } from '../../wire.ts';
import { validDate } from '../02/terminal.ts';

export type Account = 'charge' | 'receivable';
export type Balance = { memberId: string; chargeBalance: number; receivableBalance: number; revision: number };
export type SourceAmount = { txnId: string; amount: number };
type Entry = { txnId: string; memberId: string; account: Account; kind: 'topup' | 'use' | 'sale' | 'collection' | 'reversal';
  amount: number; settlementId: string; businessDate: string; at: Date; originalTxnId: string | null; correctionId: string | null };
export const accountSources = ['pos.member-accounts', 'pos.deposits', 'pos.closings', 'pos.receipts', 'members', 'memberships'];
const balanceFields = `a.member_id AS "memberId", a.revision,
  COALESCE(sum(e.amount) FILTER (WHERE e.account='charge'), 0)::double precision AS "chargeBalance",
  COALESCE(sum(e.amount) FILTER (WHERE e.account='receivable'), 0)::double precision AS "receivableBalance"`;
const entryFields = `e.txn_id AS "txnId", e.member_id AS "memberId", e.account, e.kind, e.amount::double precision AS amount,
  e.settlement_id AS "settlementId", e.business_date::text AS "businessDate", e.at, e.original_txn_id AS "originalTxnId",
  e.correction_id AS "correctionId", NULL AS "allocationId", e.kind AS reason`;

export async function balance(tx: PosTx, memberId: string) {
  const { rows: [row] } = await tx.db.query<Balance>(`SELECT ${balanceFields} FROM pos.member_account a
    LEFT JOIN pos.member_account_entry e USING (store_id,member_id)
    WHERE a.store_id=$1 AND a.member_id=$2 GROUP BY a.member_id,a.revision`, [tx.storeId, memberId]);
  return row ?? { memberId, chargeBalance: 0, receivableBalance: 0, revision: 0 };
}
function input(query: unknown, extra: string[]) {
  const fields = object(query ?? {}, ['cursor', 'limit', ...extra]);
  const take = fields.limit === undefined ? 50 : Number(fields.limit);
  if (!Number.isInteger(take) || take < 1 || take > 200 || (fields.limit !== undefined &&
      (typeof fields.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(fields.limit)))) throw new PosError(400, 'INVALID_REQUEST');
  return { fields, take, cursor: fields.cursor === undefined ? null : uuid(fields.cursor) };
}
function date(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !validDate(value)) throw new PosError(400, 'INVALID_REQUEST');
  return value;
}
async function page<T>(tx: PosTx, rows: T[], take: number, key: (row: T) => string) {
  const { rows: [scope] } = await tx.db.query<{ last_seq: string }>('SELECT last_seq FROM pos.outbox_scope WHERE store_id=$1', [tx.storeId]);
  return { items: rows.slice(0, take), nextCursor: rows.length > take ? key(rows[take - 1]) : null,
    asOf: tx.at.toISOString(), sourceRevision: Number(scope?.last_seq ?? 0) };
}
export async function balances(tx: PosTx, query: unknown) {
  const { cursor, take } = input(query, []);
  const { rows } = await tx.db.query<Balance & { hasEntries: boolean }>(`
    SELECT ${balanceFields}, count(e.txn_id) > 0 AS "hasEntries" FROM pos.member_account a
    LEFT JOIN pos.member_account_entry e USING (store_id,member_id)
    WHERE a.store_id=$1 AND ($2::uuid IS NULL OR a.member_id>$2)
    GROUP BY a.member_id,a.revision ORDER BY a.member_id LIMIT $3`, [tx.storeId, cursor, take + 1]);
  return page(tx, rows, take, row => row.memberId);
}
export async function entries(tx: PosTx, memberId: string, query: unknown) {
  const { fields, cursor, take } = input(query, ['start', 'end', 'kind']);
  const start = date(fields.start);
  const end = date(fields.end);
  if (start && end && start > end) throw new PosError(400, 'INVALID_REQUEST');
  const { kind } = fields;
  if (kind !== undefined && !['opening', 'topup', 'use', 'sale', 'collection', 'reversal'].some(value => value === kind)) {
    throw new PosError(400, 'INVALID_REQUEST');
  }
  const { rows } = await tx.db.query<Omit<Entry, 'kind' | 'settlementId'> & { kind: Entry['kind'] | 'opening';
    settlementId: string | null; sourceAmounts: SourceAmount[]; sourceRef: { kind: string; id: string } | null }>(`
    SELECT ${entryFields}, CASE WHEN s.settlement_id IS NOT NULL THEN jsonb_build_object('kind',s.purpose,'id',s.settlement_id) END AS "sourceRef",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('txnId',source_id,'amount',abs(consumed)) ORDER BY source_id)
        FROM pos.member_entry_source WHERE store_id=e.store_id AND txn_id=e.txn_id),'[]') AS "sourceAmounts"
    FROM pos.member_account_entry e LEFT JOIN pos.settlement s USING (store_id,settlement_id)
    WHERE e.store_id=$1 AND e.member_id=$2 AND ($3::uuid IS NULL OR e.txn_id>$3)
      AND ($4::date IS NULL OR e.business_date>=$4) AND ($5::date IS NULL OR e.business_date<=$5)
      AND ($6::text IS NULL OR e.kind=$6) ORDER BY e.txn_id LIMIT $7
  `, [tx.storeId, memberId, cursor, start, end, kind ?? null, take + 1]);
  return page(tx, rows, take, row => row.txnId);
}
export async function bumpAccount(tx: PosTx, memberId: string) {
  const { rows: [row] } = await tx.db.query<{ revision: number }>(`INSERT INTO pos.member_account (store_id,member_id,revision)
    VALUES ($1,$2,1) ON CONFLICT (store_id,member_id) DO UPDATE SET revision=pos.member_account.revision+1 RETURNING revision`,
  [tx.storeId, memberId]);
  return row.revision;
}
export async function publishBalance(tx: PosTx, memberId: string, settlementId: string) {
  const value = await balance(tx, memberId);
  await appendOutbox(tx, 'pos.member_balance_changed.v1', memberId, { ...value, settlementId });
}
export async function writeEntry(tx: PosTx, entry: Omit<Entry, 'txnId' | 'originalTxnId' | 'correctionId'> &
  { originalTxnId?: string; correctionId?: string }, sources: SourceAmount[] = []) {
  const txnId = randomUUID();
  await tx.db.query(`INSERT INTO pos.member_account_entry
    (store_id,txn_id,member_id,settlement_id,account,kind,amount,business_date,at,original_txn_id,correction_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [tx.storeId, txnId, entry.memberId, entry.settlementId,
    entry.account, entry.kind, entry.amount, entry.businessDate, entry.at, entry.originalTxnId ?? null, entry.correctionId ?? null]);
  if (sources.length) await tx.db.query(`INSERT INTO pos.member_entry_source (store_id,member_id,account,txn_id,source_id,consumed)
    SELECT $1,$2,$3,$4,src."txnId",src.amount FROM jsonb_to_recordset($5) AS src("txnId" uuid,amount bigint)`,
  [tx.storeId, entry.memberId, entry.account, txnId, JSON.stringify(sources)]);
  return txnId;
}
export async function allocateSources(tx: PosTx, memberId: string, account: Account, amount: number, sourceId?: string) {
  const { rows } = await tx.db.query<SourceAmount>(`SELECT e.txn_id AS "txnId",
    (e.amount-COALESCE((SELECT sum(s.consumed) FROM pos.member_entry_source s WHERE s.store_id=e.store_id AND s.source_id=e.txn_id),0))
      ::double precision AS amount
    FROM pos.member_account_entry e WHERE e.store_id=$1 AND e.member_id=$2 AND e.account=$3
      AND e.kind IN ('opening','topup','sale') AND ($4::uuid IS NULL OR e.txn_id=$4) ORDER BY e.at,e.txn_id`,
  [tx.storeId, memberId, account, sourceId ?? null]);
  let remaining = amount;
  const allocated: SourceAmount[] = [];
  for (const source of rows) {
    const used = Math.min(remaining, source.amount);
    if (used > 0) allocated.push({ txnId: source.txnId, amount: used });
    remaining -= Math.max(0, used);
    if (remaining === 0) break;
  }
  if (remaining) throw new PosError(409, account === 'charge' ? 'CHARGE_BALANCE_EXCEEDED' : 'RECEIVABLE_LIMIT',
    account === 'charge' ? { available: amount - remaining } : { remaining: amount - remaining });
  return allocated;
}
