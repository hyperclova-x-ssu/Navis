import { PosError, type PosTx } from '../../wire.ts';
import { balance, bumpAccount, publishBalance, writeEntry, type Account, type SourceAmount } from './accounts.ts';

type OriginalEntry = { txnId: string; account: Account; amount: number; sources: SourceAmount[] };

export async function memberCorrectionEntries(tx: PosTx, memberId: string, settlementId: string) {
  const { rows } = await tx.db.query<OriginalEntry>(`SELECT e.txn_id AS "txnId", e.account,
    e.amount::double precision AS amount, COALESCE((
      SELECT jsonb_agg(jsonb_build_object('txnId',s.source_id,'amount',-s.consumed) ORDER BY s.source_id)
      FROM pos.member_entry_source s WHERE s.store_id=e.store_id AND s.txn_id=e.txn_id),'[]') AS sources
    FROM pos.member_account_entry e WHERE e.store_id=$1 AND e.settlement_id=$2
      AND e.member_id=$3 AND e.kind IN ('sale','use') ORDER BY e.account`, [tx.storeId, settlementId, memberId]);
  for (const entry of rows) {
    if (entry.account !== 'receivable') continue;
    const { rows: collections } = await tx.db.query<{ txnId: string; settlementId: string; amount: number }>(`SELECT
      c.txn_id AS "txnId", c.settlement_id AS "settlementId", sum(s.consumed)::double precision AS amount
      FROM pos.member_entry_source s JOIN pos.member_account_entry e USING (store_id,txn_id)
      JOIN pos.member_account_entry c ON c.store_id=e.store_id AND c.txn_id=COALESCE(e.original_txn_id,e.txn_id)
      WHERE s.store_id=$1 AND s.source_id=$2 AND c.kind='collection'
      GROUP BY c.txn_id,c.settlement_id HAVING sum(s.consumed)>0 ORDER BY c.txn_id`, [tx.storeId, entry.txnId]);
    if (collections.length) throw new PosError(409, 'RECEIVABLE_ALREADY_COLLECTED', {
      settlementId, receivableTxnId: entry.txnId, collections,
    });
    entry.sources = [{ txnId: entry.txnId, amount: entry.amount }];
  }
  const charge = rows.find(entry => entry.account === 'charge');
  if (charge && !Number.isSafeInteger((await balance(tx, memberId)).chargeBalance - charge.amount)) {
    throw new PosError(409, 'CHARGE_LIMIT');
  }
  return rows;
}

export async function reverseMemberEntries(tx: PosTx, memberId: string, settlementId: string, correctionId: string,
  businessDate: string, at: Date, entries: OriginalEntry[]) {
  await bumpAccount(tx, memberId);
  for (const entry of entries) {
    await writeEntry(tx, { memberId, settlementId, businessDate, at, kind: 'reversal', originalTxnId: entry.txnId,
      correctionId, account: entry.account, amount: -entry.amount }, entry.sources);
  }
  await publishBalance({ ...tx, at }, memberId, settlementId);
}
