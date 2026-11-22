import { PosError, type PosTx } from '../../wire.ts';
import { allocateSources, balance, bumpAccount, publishBalance, writeEntry,
  type Account, type SourceAmount } from '../05/accounts.ts';

export const memberKinds = ['charge', 'receivable'] as const;

type MemberEffect = { memberId: string; account: Account; amount: number };
export type Posting = MemberEffect & { kind: 'use' | 'sale' };
export type Return = MemberEffect & { kind: 'reversal'; originalTxnId: string };
type PlannedReturn = { effect: Return; sources: SourceAmount[] };

export const total = (parts: readonly { amount: number }[]) => parts.reduce((sum, part) => sum + part.amount, 0);

/** Split the return across remaining amounts using stable largest remainders in the supplied order. */
export function apportion<T extends { amount: number }>(amount: number, available: T[]): T[] {
  const denominator = BigInt(total(available));
  const ranked = available.map((row, index) => {
    const product = BigInt(amount) * BigInt(row.amount);
    return { row: { ...row, amount: Number(product / denominator) }, remainder: product % denominator, index };
  });
  const extra = amount - total(ranked.map(({ row }) => row));
  const largest = [...ranked].sort((a, b) => a.remainder === b.remainder
    ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const { row } of largest.slice(0, extra)) row.amount += 1;
  return ranked.map(({ row }) => row).filter(row => row.amount > 0);
}

type PostingContext = { settlementId: string; businessDate: string; at: Date };

export async function postMemberValues(tx: PosTx, memberId: string, context: PostingContext, effects: Posting[]) {
  const charge = effects.find(effect => effect.account === 'charge');
  const sources = charge ? await allocateSources(tx, memberId, 'charge', -charge.amount) : [];
  await bumpAccount(tx, memberId);
  for (const effect of effects) {
    await writeEntry(tx, { ...context, ...effect }, effect.account === 'charge' ? sources : []);
  }
  await publishBalance({ ...tx, at: context.at }, memberId, context.settlementId);
}

export async function remainingMemberValue(tx: PosTx, settlementId: string) {
  const { rows } = await tx.db.query<{ account: Account; txnId: string; memberId: string; amount: number }>(`
    SELECT e.account, e.txn_id AS "txnId", e.member_id AS "memberId",
      abs(e.amount + coalesce(r.amount, 0))::double precision AS amount
    FROM pos.member_account_entry e
    LEFT JOIN LATERAL (
      SELECT sum(amount) AS amount FROM pos.member_account_entry
      WHERE store_id=e.store_id AND original_txn_id=e.txn_id AND kind='reversal'
    ) r ON true
    WHERE e.store_id=$1 AND e.settlement_id=$2 AND e.kind IN ('use','sale')
    ORDER BY e.account`, [tx.storeId, settlementId]);
  return rows.filter(row => row.amount > 0);
}

async function remainingChargeSources(tx: PosTx, txnId: string) {
  const { rows } = await tx.db.query<SourceAmount>(`
    SELECT original.source_id AS "txnId",
      (original.consumed + coalesce(restored.amount, 0))::double precision AS amount
    FROM pos.member_entry_source original
    LEFT JOIN LATERAL (
      SELECT sum(s.consumed) AS amount FROM pos.member_account_entry r
      JOIN pos.member_entry_source s USING (store_id,txn_id)
      WHERE r.store_id=original.store_id AND r.original_txn_id=original.txn_id
        AND r.kind='reversal' AND s.source_id=original.source_id
    ) restored ON true
    WHERE original.store_id=$1 AND original.txn_id=$2
    ORDER BY original.source_id`, [tx.storeId, txnId]);
  return rows.filter(row => row.amount > 0);
}

export async function planMemberReturns(tx: PosTx, settlementId: string, parts: Awaited<ReturnType<typeof remainingMemberValue>>) {
  const postings: PlannedReturn[] = [];
  for (const { memberId, account, txnId, amount } of parts) {
    if (account === 'charge') {
      const { chargeBalance } = await balance(tx, memberId);
      if (!Number.isSafeInteger(chargeBalance + amount)) throw new PosError(409, 'CHARGE_LIMIT');
      const available = await remainingChargeSources(tx, txnId);
      if (total(available) < amount) throw new Error('Missing charge posting sources for custom order');
      postings.push({ effect: { memberId, account, kind: 'reversal', originalTxnId: txnId, amount },
        sources: apportion(amount, available).map(source => ({ ...source, amount: -source.amount })) });
      continue;
    }
    let sources;
    try {
      sources = await allocateSources(tx, memberId, 'receivable', amount, txnId);
    } catch (error) {
      if (error instanceof PosError && error.result.reason === 'RECEIVABLE_LIMIT') {
        throw new PosError(409, 'RECEIVABLE_ALREADY_COLLECTED', { settlementId, receivableTxnId: txnId, ...error.result.details });
      }
      throw error;
    }
    postings.push({ effect: { memberId, account, kind: 'reversal', originalTxnId: txnId, amount: -amount }, sources });
  }
  return postings;
}

export async function postMemberReturns(tx: PosTx, context: PostingContext & { correctionId: string }, postings: PlannedReturn[]) {
  const memberId = postings[0].effect.memberId;
  await bumpAccount(tx, memberId);
  for (const { effect, sources } of postings) {
    await writeEntry(tx, { ...context, ...effect }, sources);
  }
  await publishBalance({ ...tx, at: context.at }, memberId, context.settlementId);
}
