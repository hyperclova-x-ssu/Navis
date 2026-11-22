import { randomUUID } from 'node:crypto';
import { appendOutbox, applyCommand, nextBusinessSequence, openDay } from '../../ledger.ts';
import { commandReceipt, integer, object, PosError, splits, uuid, type MethodSplit, type PosTx } from '../../wire.ts';
import { insertTerminal, parseTerminal, readTerminal, requireTerminal, type TerminalRecord } from '../02/terminal.ts';
import { accountSources, allocateSources, balance, bumpAccount, publishBalance, writeEntry, type SourceAmount } from './accounts.ts';
import type { MemberSource } from './customer-client.ts';

const purposes = ['charge_topup', 'receivable_collection', 'membership_sale'] as const;
type Purpose = typeof purposes[number];
type Funding = { settlementId: string; paymentId: string; membershipId: string | null; productId: string | null;
  memberId: string; purpose: Purpose; amount: number; businessDate: string; at: Date; splits: MethodSplit[];
  revision: number; approvalNo: string | null; receiptNo: string | null; occurredAt: Date | null };
type Refund = { correctionId: string; amount: number; methods: MethodSplit[]; at: Date } & Pick<Funding, 'approvalNo' | 'receiptNo' | 'occurredAt'>;
const sum = (methods: MethodSplit[]) => methods.reduce((total, row) => total + row.amount, 0);

export function recordFunding(tx: PosTx, customer: MemberSource, key: string, memberId: string, body: unknown) {
  const input = object(body, ['purpose', 'amount', 'expectedRevision', 'productId', 'receivableTxnId', 'splits', 'terminal']);
  const purpose = purposes.find(value => value === input.purpose);
  if (!purpose) throw new PosError(400, 'INVALID_SETTLEMENT_KIND');
  if ((purpose === 'membership_sale') !== (input.productId !== undefined) ||
    (input.receivableTxnId !== undefined && purpose !== 'receivable_collection')) throw new PosError(400, 'INVALID_REQUEST');
  const productId = input.productId === undefined ? undefined : uuid(input.productId);
  const receivableTxnId = input.receivableTxnId === undefined ? undefined : uuid(input.receivableTxnId);
  const expectedRevision = integer(input.expectedRevision, 0);
  const methods = splits(input.splits);
  const amount = input.amount === undefined && purpose === 'membership_sale' ? sum(methods)
    : integer(input.amount, 1, Number.MAX_SAFE_INTEGER, 'AMOUNT_POSITIVE_REQUIRED');
  if (!Number.isSafeInteger(amount) || sum(methods) !== amount) throw new PosError(400, 'ALLOCATION_SUM_MISMATCH');
  const terminal = parseTerminal(input.terminal);
  const channel = methods.some(method => method.method !== 'cash') ? 'terminal_record' : 'cash_record';
  requireTerminal(channel, terminal);
  return applyCommand(tx, 'member.fund', key, { purpose, amount, expectedRevision, productId, receivableTxnId, memberId, methods, terminal }, async () => {
    const day = await openDay(tx);
    const member = await customer.member(tx.storeId, memberId, day, productId);
    if (member.memberId !== memberId || !member.active) throw new PosError(404, 'MEMBER_NOT_FOUND');
    const product = member.product;
    if (productId && (!product || product.productId !== productId)) throw new PosError(404, 'MEMBERSHIP_PRODUCT_NOT_FOUND');
    if (product && product.soldPrice !== amount) throw new PosError(409, 'QUOTE_CHANGED', { amountDue: product.soldPrice });
    const account = await balance(tx, memberId);
    if (account.revision !== expectedRevision) throw new PosError(409, 'STALE_REVISION', { revision: account.revision });
    const sources = purpose === 'receivable_collection' ? await allocateSources(tx, memberId, 'receivable', amount, receivableTxnId) : [];
    if (purpose === 'charge_topup' && !Number.isSafeInteger(account.chargeBalance + amount)) throw new PosError(409, 'CHARGE_LIMIT');
    const revision = await bumpAccount(tx, memberId);
    const settlementId = randomUUID();
    const paymentId = randomUUID();
    const membershipId = product ? randomUUID() : null;
    const at = terminal ? new Date(terminal.occurredAt) : tx.at;
    const receiptNo = '기록-' + paymentId;
    await tx.db.query(`INSERT INTO pos.settlement (store_id,settlement_id,purpose,amount,at) VALUES ($1,$2,$3,$4,$5)`,
      [tx.storeId, settlementId, purpose, amount, at]);
    await tx.db.query(`INSERT INTO pos.payment
      (store_id,payment_id,settlement_id,created_by,amount,splits,transaction_no,approval_no,at,channel)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tx.storeId, paymentId, settlementId, tx.actorId, amount, JSON.stringify(methods), receiptNo,
      terminal?.approvalNo ?? terminal?.receiptNo ?? receiptNo, at, channel]);
    if (terminal) await insertTerminal(tx, day, paymentId, null, terminal);
    await tx.db.query(`INSERT INTO pos.member_funding (store_id,settlement_id,member_id,business_date,membership_id,product_id,expires_on)
      VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $7::int IS NOT NULL THEN $4::date+$7-1 END)`,
    [tx.storeId, settlementId, memberId, day, membershipId, productId ?? null, product?.validDays ?? null]);
    if (purpose !== 'membership_sale') await writeEntry(tx, { memberId, settlementId, businessDate: day, at,
      ...(purpose === 'charge_topup' ? { account: 'charge', kind: 'topup', amount }
        : { account: 'receivable', kind: 'collection', amount: -amount }) }, sources);
    await publishBalance(tx, memberId, settlementId);
    await appendOutbox(tx, 'pos.member_funding_recorded.v1', settlementId, { memberId, settlementId, paymentId, purpose,
      amount, businessDate: day, membershipId, ...(product && { productId, productRevision: product.revision }) });
    return { ...commandReceipt(memberId, revision, accountSources, paymentId), settlementId, paymentId, memberId,
      purpose, ...(membershipId && { membershipId }) };
  });
}

export async function readFunding(tx: PosTx, id: string) {
  const { rows: [row] } = await tx.db.query<Funding>(`SELECT s.settlement_id AS "settlementId", p.payment_id AS "paymentId",
    f.member_id AS "memberId", f.membership_id AS "membershipId", f.product_id AS "productId", s.purpose,
    s.amount::double precision AS amount, f.business_date::text AS "businessDate", s.at, p.splits, f.revision,
    t.approval_no AS "approvalNo", t.receipt_no AS "receiptNo", t.occurred_at AS "occurredAt"
    FROM pos.member_funding f JOIN pos.settlement s USING (store_id,settlement_id) JOIN pos.payment p USING (store_id,settlement_id)
    LEFT JOIN pos.terminal_record t ON t.store_id=p.store_id AND t.record_id=p.payment_id
    WHERE f.store_id=$1 AND (s.settlement_id=$2 OR p.payment_id=$2)`, [tx.storeId, id]);
  if (!row) throw new PosError(404, 'FUNDING_NOT_FOUND');
  const { rows: prior } = await tx.db.query<Refund>(`SELECT c.correction_id AS "correctionId", c.amount::double precision AS amount,
    c.methods, c.at, t.approval_no AS "approvalNo", t.receipt_no AS "receiptNo", t.occurred_at AS "occurredAt"
    FROM pos.payment_correction c LEFT JOIN pos.terminal_record t ON t.store_id=c.store_id AND t.record_id=c.correction_id
    WHERE c.store_id=$1 AND c.payment_id=$2 ORDER BY c.at,c.correction_id`, [tx.storeId, row.paymentId]);
  const { approvalNo, receiptNo, occurredAt, ...funding } = row;
  const returned = new Map<MethodSplit['method'], number>();
  const refunds = prior.map(({ approvalNo, receiptNo, occurredAt, ...refund }) => {
    for (const method of refund.methods) returned.set(method.method, (returned.get(method.method) ?? 0) + method.amount);
    return { ...refund, terminal: readTerminal({ approvalNo, receiptNo, occurredAt }) };
  });
  const remainingMethods = funding.splits.map(method => ({ ...method, amount: method.amount - (returned.get(method.method) ?? 0) }))
    .filter(method => method.amount > 0);
  return { ...funding, terminal: readTerminal({ approvalNo, receiptNo, occurredAt }),
    remainingRefundable: sum(remainingMethods), remainingMethods, refunds };
}

async function refundSources(tx: PosTx, funding: Awaited<ReturnType<typeof readFunding>>, amount: number) {
  const { rows: [original] } = await tx.db.query<{ txnId: string }>(`SELECT txn_id AS "txnId" FROM pos.member_account_entry
    WHERE store_id=$1 AND settlement_id=$2 AND kind IN ('topup','collection')`, [tx.storeId, funding.settlementId]);
  if (!original) throw new Error('Missing funding account entry');
  if (funding.purpose === 'charge_topup') return {
    originalTxnId: original.txnId, sources: await allocateSources(tx, funding.memberId, 'charge', amount, original.txnId),
  };
  const { rows } = await tx.db.query<SourceAmount>(`SELECT s.source_id AS "txnId",
    (s.consumed+COALESCE((SELECT sum(src.consumed) FROM pos.member_entry_source src JOIN pos.member_account_entry e
      USING (store_id,txn_id) WHERE src.store_id=s.store_id AND src.source_id=s.source_id AND e.original_txn_id=$2),0))
      ::double precision AS amount
    FROM pos.member_entry_source s WHERE s.store_id=$1 AND s.txn_id=$2 ORDER BY s.source_id`,
  [tx.storeId, original.txnId]);
  let remaining = amount;
  const sources: SourceAmount[] = [];
  for (const row of rows) {
    const refunded = Math.min(remaining, row.amount);
    if (refunded > 0) sources.push({ txnId: row.txnId, amount: -refunded });
    remaining -= Math.max(refunded, 0);
  }
  if (remaining) throw new PosError(409, 'REFUND_LIMIT');
  return { originalTxnId: original.txnId, sources };
}

export function refundFunding(tx: PosTx, key: string, fundingId: string, body: unknown, customer?: MemberSource) {
  const input = object(body, ['amount', 'expectedRevision', 'terminal', 'confirmed']);
  if (input.confirmed !== true) throw new PosError(400, 'CONFIRMATION_REQUIRED');
  const amount = integer(input.amount, 1, Number.MAX_SAFE_INTEGER, 'AMOUNT_POSITIVE_REQUIRED');
  const expectedRevision = integer(input.expectedRevision, 1);
  const terminal = parseTerminal(input.terminal);
  return applyCommand(tx, 'member.funding.refund', key, { fundingId, amount, expectedRevision, terminal }, async () => {
    const day = await openDay(tx);
    const funding = await readFunding(tx, fundingId);
    if (funding.revision !== expectedRevision) throw new PosError(409, 'STALE_REVISION', { revision: funding.revision });
    if (funding.purpose === 'membership_sale') throw new PosError(409, 'MEMBERSHIP_REFUND_UNAVAILABLE');
    if (amount > funding.remainingRefundable) throw new PosError(409, 'REFUND_LIMIT', { remaining: funding.remainingRefundable });
    if (customer && !(await customer.member(tx.storeId, funding.memberId, day)).active) throw new PosError(404, 'MEMBER_NOT_FOUND');
    const { originalTxnId, sources } = await refundSources(tx, funding, amount);
    let remaining = amount;
    const methods: MethodSplit[] = [];
    for (const method of funding.remainingMethods) {
      const refunded = Math.min(remaining, method.amount);
      if (refunded) methods.push({ ...method, amount: refunded });
      remaining -= refunded;
    }
    const channel = methods.some(method => method.method !== 'cash') ? 'terminal_record' : 'cash_record';
    requireTerminal(channel, terminal);
    const correctionId = randomUUID();
    await insertFundingCorrection(tx, day, funding.paymentId, correctionId, amount, methods, terminal);
    const revision = expectedRevision + 1;
    await tx.db.query('UPDATE pos.member_funding SET revision=$3 WHERE store_id=$1 AND settlement_id=$2',
      [tx.storeId, funding.settlementId, revision]);
    await bumpAccount(tx, funding.memberId);
    await writeEntry(tx, { memberId: funding.memberId, settlementId: funding.settlementId, businessDate: day,
      at: terminal ? new Date(terminal.occurredAt) : tx.at, kind: 'reversal', originalTxnId, correctionId,
      ...(funding.purpose === 'charge_topup' ? { account: 'charge', amount: -amount } : { account: 'receivable', amount }) }, sources);
    await publishBalance(tx, funding.memberId, funding.settlementId);
    return { ...commandReceipt(funding.settlementId, revision, accountSources, correctionId),
      settlementId: funding.settlementId, paymentId: funding.paymentId, correctionId };
  });
}

async function insertFundingCorrection(tx: PosTx, day: string, paymentId: string, id: string, amount: number,
  methods: MethodSplit[], terminal: TerminalRecord | null) {
  const seq = await nextBusinessSequence(tx, day);
  await tx.db.query(`INSERT INTO pos.payment_correction
    (store_id,correction_id,payment_id,business_date,created_by,kind,amount,methods,allocations,seq,at)
    VALUES ($1,$2,$3,$4,$5,'refund',$6,$7,'[]',$8,$9)`, [tx.storeId, id, paymentId, day, tx.actorId,
    amount, JSON.stringify(methods), seq, terminal ? new Date(terminal.occurredAt) : tx.at]);
  if (terminal) await insertTerminal(tx, day, paymentId, id, terminal);
}
