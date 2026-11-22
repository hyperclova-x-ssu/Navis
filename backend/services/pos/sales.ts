import { randomUUID } from 'node:crypto';
import type { PosSaleRecognized } from '../../packages/contracts/events.ts';
import { eventLine, nullableSum, quoteBill, saleCost, type BillDraft, type BillInput, type BillQuote, type ReadPosCatalog } from './catalog.ts';
import { appendOutbox, applyCommand, nextBusinessSequence, openDay, readCommand } from './ledger.ts';
import { insertTerminal, type TerminalRecord } from './reality/02/terminal.ts';
import { applied, commandReceipt, fingerprint, integer, object, PosError, splits, uuid, type MethodSplit, type PosTx } from './wire.ts';

export const approvalCommand = 'approval.begin';

export async function createBill(tx: PosTx, key: string, input: BillInput) {
  return applyCommand(tx, 'bill.create', key, input, async () => {
    const { billId, quote } = await insertBill(tx, input);
    return applied({ billId, ...quote, canSubmit: true, issues: [] }, billId);
  });
}

export async function insertBill(tx: PosTx, input: BillInput, readCatalog?: ReadPosCatalog, postpaid = false) {
  const day = await openDay(tx);
  const quote = await quoteBill(tx, input, undefined, readCatalog);
  const billId = randomUUID();
  await tx.db.query(`
    INSERT INTO pos.bill (store_id, bill_id, business_date, draft, created_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [tx.storeId, billId, day, { request: input, quote, ...(postpaid && { postpaid: true }) } satisfies BillDraft, tx.at]);
  return { billId, quote, day };
}

type ApprovalInput = { billId: string; quoteRevision: number; splits: MethodSplit[] };
type PinnedApproval = ApprovalInput & { businessDate: string; quoteFingerprint: string; actorId: string; claimId?: string };
type PendingReceipt = {
  ok: true; status: 'pending'; value: { attemptId: string; status: 'pending'; quoteFingerprint: string };
};
type Completion = {
  settlementId: string; paymentId: string; billId: string; orderIds: string[];
  remaining: 0; settled: true; purpose: 'sale'; sourceRef: { kind: 'bill'; id: string }; accountEffects: [];
};
type CompletedReceipt = ReturnType<typeof applied<Completion>>;

export function parseApproval(value: unknown): ApprovalInput {
  const input = object(value, ['billId', 'quoteRevision', 'splits']);
  return { billId: uuid(input.billId), quoteRevision: integer(input.quoteRevision, 0), splits: splits(input.splits) };
}

export async function readBill({ db, storeId }: PosTx, billId: string) {
  const { rows } = await db.query<{ day: string; status: string; revision: number; draft: BillDraft }>(`
    SELECT business_date::text AS day, status, revision, draft FROM pos.bill WHERE store_id = $1 AND bill_id = $2
  `, [storeId, billId]);
  if (!rows[0]) throw new PosError(404, 'BILL_NOT_FOUND');
  return rows[0];
}

export async function quoteOpenBill(tx: PosTx, billId: string, day: string, readCatalog?: ReadPosCatalog) {
  const bill = await readBill(tx, billId);
  if (bill.status !== 'open') throw new PosError(409, 'BILL_LOCKED');
  if (bill.day !== day) throw new PosError(409, 'DAY_CLOSED');
  return quoteBill(tx, bill.draft.request, bill.draft.quote, readCatalog, bill.draft.fixedDiscounts);
}

async function currentQuote(tx: PosTx, input: ApprovalInput, day: string) {
  const quote = await quoteOpenBill(tx, input.billId, day);
  const quoteFingerprint = fingerprint(quote);
  if (input.quoteRevision !== quote.quoteRevision) {
    throw new PosError(409, 'QUOTE_CHANGED', { quote });
  }
  return { quote, quoteFingerprint };
}

export async function beginApproval(tx: PosTx, key: string, input: ApprovalInput) {
  const { db, storeId, actorId } = tx;
  const digest = fingerprint(input);
  const existing = await readCommand<PendingReceipt, CompletedReceipt, PinnedApproval>(tx, approvalCommand, key);
  if (existing) {
    if (existing.status === 'aborted' && !existing.receipt) throw new PosError(409, 'COMMAND_ABORTED');
    if (existing.fingerprint !== digest || existing.approval?.actorId !== actorId) {
      throw new PosError(409, 'IDEMPOTENCY_MISMATCH');
    }
    return existing.receipt;
  }

  const { rows: [claim] } = await db.query<{ claimId: string }>(`
    SELECT claim_id AS "claimId" FROM pos.customer_claim WHERE store_id = $1 AND command_key = $2
  `, [storeId, key]);

  const day = await openDay(tx);
  const { quote, quoteFingerprint } = await currentQuote(tx, input, day);
  if (input.splits.reduce((sum, split) => sum + split.amount, 0) !== quote.payable) {
    throw new PosError(400, 'ALLOCATION_SUM_MISMATCH', { payable: quote.payable });
  }
  await assertNoPendingApproval(tx, input.billId);

  const attemptId = randomUUID();
  const approval: PinnedApproval = {
    ...input, actorId, quoteFingerprint, businessDate: day, ...(claim && { claimId: claim.claimId }),
  };
  const receipt: PendingReceipt = { ok: true, status: 'pending', value: { attemptId, status: 'pending', quoteFingerprint } };
  await db.query(`
    INSERT INTO pos.command_ledger
      (store_id, command_type, command_key, fingerprint, status, receipt, attempt_id, bill_id, approval)
    VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
  `, [storeId, approvalCommand, key, digest, receipt, attemptId, input.billId, approval]);
  return receipt;
}

export async function assertNoPendingApproval({ db, storeId }: PosTx, billId: string) {
  const active = await db.query(`
    SELECT 1 FROM pos.command_ledger WHERE store_id = $1 AND bill_id = $2
      AND command_type = 'approval.begin' AND status = 'pending'
  `, [storeId, billId]);
  if (active.rowCount) throw new PosError(409, 'APPROVAL_BUSY');
}

export function parseFinish(value: unknown) {
  const { expectedQuoteFingerprint } = object(value, ['expectedQuoteFingerprint']);
  if (typeof expectedQuoteFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedQuoteFingerprint)) {
    throw new PosError(400, 'INVALID_REQUEST');
  }
  return expectedQuoteFingerprint;
}

export async function finishApproval(
  tx: PosTx, key: string, attemptId: string, expectedQuoteFingerprint: string, approve: () => boolean,
) {
  const command = await readCommand<PendingReceipt, CompletedReceipt, PinnedApproval>(tx, approvalCommand, key);
  const approval = command?.approval;
  if (!command || !approval || command.attemptId !== attemptId
      || approval.quoteFingerprint !== expectedQuoteFingerprint || approval.actorId !== tx.actorId) {
    throw new PosError(409, 'STALE_ATTEMPT');
  }
  if (command.terminalReceipt) return command.terminalReceipt;

  let quote: BillQuote;
  try {
    const day = await openDay(tx);
    if (day !== approval.businessDate) throw new PosError(409, 'DAY_CLOSED');
    const current = await currentQuote(tx, approval, day);
    if (current.quoteFingerprint !== expectedQuoteFingerprint) throw new PosError(409, 'QUOTE_CHANGED', { quote: current.quote });
    if (!approve()) throw new PosError(422, 'APPROVAL_FAILED');
    quote = current.quote;
  } catch (error) {
    if (!(error instanceof PosError)) throw error;
    await setTerminal(tx, key, 'rejected', error.result);
    return error.result;
  }

  const result = await applyCommand(tx, 'approval.finish', key, { attemptId, expectedQuoteFingerprint }, async () =>
    recognizeSale(tx, approval, quote));
  await setTerminal(tx, key, 'committed', result);
  return result;
}

async function setTerminal(tx: PosTx, key: string, status: 'committed' | 'rejected', result: object) {
  const update = await tx.db.query(`
    UPDATE pos.command_ledger SET status = $4, terminal_receipt = $5
    WHERE store_id = $1 AND command_type = $2 AND command_key = $3 AND status = 'pending'
  `, [tx.storeId, approvalCommand, key, status, result]);
  if (update.rowCount !== 1) throw new Error('Missing pending approval');
}

type SaleApproval = Pick<PinnedApproval, 'billId' | 'businessDate' | 'splits' | 'claimId'>;
type RecordedSale = { terminal: TerminalRecord | null; source?: 'connect' };
type MemberRecordedSale = RecordedSale & { member: {
  memberId: string;
  beforePublish: (settlementId: string) => Promise<{ claimId?: string; membershipContributions?: { allocationId: string; quantity: number }[] }>;
} };
type MemberCompletion = Omit<Completion, 'paymentId'> & { paymentId?: string };

export async function insertOrder(tx: PosTx, billId: string, day: string, lines: BillQuote['lines'],
  seq: number, at = tx.at) {
  const { db, storeId } = tx;
  const orderId = randomUUID();
  const snapshots = JSON.stringify(lines);
  await db.query(`
    INSERT INTO pos.pos_order (store_id, order_id, origin_bill_id, business_date, order_no, ordered_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [storeId, orderId, billId, day, seq, at]);
  await db.query(`
    INSERT INTO pos.order_line (store_id, order_id, order_line_id, snapshot)
    SELECT $1, $2, (line->>'orderLineId')::uuid, line FROM jsonb_array_elements($3::jsonb) AS line
  `, [storeId, orderId, snapshots]);
  await db.query(`
    INSERT INTO pos.bill_allocation (store_id, bill_id, allocation_id, order_line_id, quantity)
    SELECT $1, $2, (line->>'allocationId')::uuid, (line->>'orderLineId')::uuid, (line->>'qty')::integer
    FROM jsonb_array_elements($3::jsonb) AS line
  `, [storeId, billId, snapshots]);
  return orderId;
}

export async function billOrderIds({ db, storeId }: PosTx, billId: string) {
  const { rows } = await db.query<{ orderId: string }>(`
    SELECT DISTINCT o.order_id AS "orderId", o.order_no FROM pos.bill_allocation a
    JOIN pos.order_line l USING (store_id, order_line_id)
    JOIN pos.pos_order o USING (store_id, order_id)
    WHERE a.store_id = $1 AND a.bill_id = $2 ORDER BY o.order_no
  `, [storeId, billId]);
  return rows.map(row => row.orderId);
}

export function recognizeSale(tx: PosTx, approval: SaleApproval, quote: BillQuote, record: MemberRecordedSale):
  Promise<ReturnType<typeof applied<MemberCompletion>>>;
export function recognizeSale(tx: PosTx, approval: SaleApproval, quote: BillQuote, record?: RecordedSale): Promise<CompletedReceipt>;
export async function recognizeSale(
  tx: PosTx, approval: SaleApproval, quote: BillQuote, record?: RecordedSale | MemberRecordedSale,
): Promise<ReturnType<typeof applied<MemberCompletion>>> {
  const { db, storeId, actorId } = tx;
  const at = record?.terminal ? new Date(record.terminal.occurredAt) : tx.at;
  const { billId, businessDate: day } = approval;
  const bill = await readBill(tx, billId);
  const member = record && 'member' in record ? record.member : undefined;
  const paidAmount = member ? approval.splits.reduce((sum, split) => sum + split.amount, 0) : quote.payable;
  const paymentId = paidAmount > 0 ? randomUUID() : undefined;
  const settlementId = randomUUID();
  const seq = await nextBusinessSequence(tx, day);
  const transactionNo = `거래-${day.replaceAll('-', '')}-${String(seq).padStart(4, '0')}`;
  const channel = !record ? 'fixture' : record.terminal ? 'terminal_record' : 'cash_record';
  const approvalNo = record ? record.terminal?.approvalNo ?? record.terminal?.receiptNo ?? transactionNo
    : `예시-${String(seq).padStart(6, '0')}`;
  await db.query(`
    UPDATE pos.bill SET status = 'paid', recognized_at = $3, draft = jsonb_set(draft, '{quote}', $4)
    WHERE store_id = $1 AND bill_id = $2
  `, [storeId, billId, at, quote]);
  const orderIds = bill.draft.postpaid ? await billOrderIds(tx, billId)
    : [await insertOrder(tx, billId, day, quote.lines, seq, at)];
  const [orderId] = orderIds;
  if (!orderId) throw new Error('Missing order for POS settlement');
  await db.query(`
    INSERT INTO pos.settlement (store_id, settlement_id, bill_id, purpose, amount, at)
    VALUES ($1, $2, $3, 'sale', $4, $5)
  `, [storeId, settlementId, billId, quote.payable, at]);
  if (paymentId) {
    await db.query(`
      INSERT INTO pos.payment (store_id, payment_id, settlement_id, created_by, amount, splits, transaction_no, approval_no, at, channel, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [storeId, paymentId, settlementId, actorId, paidAmount, JSON.stringify(approval.splits), transactionNo, approvalNo, at, channel,
      record?.source ?? null]);
    if (record?.terminal) await insertTerminal(tx, day, paymentId, null, record.terminal);
  }

  const ledgerLines = quote.lines.map((line) => ({
    line, recognitionId: randomUUID(), cost: saleCost(line, line.qty),
  }));
  const snapshots = JSON.stringify(ledgerLines);
  await db.query(`
    INSERT INTO pos.settlement_line (store_id, settlement_id, allocation_id, snapshot)
    SELECT $1, $2, (row->'line'->>'allocationId')::uuid, row->'line'
    FROM jsonb_array_elements($3::jsonb) AS row
  `, [storeId, settlementId, snapshots]);
  await db.query(`
    INSERT INTO pos.sales_recognition (store_id, settlement_id, allocation_id, recognition_id, business_date, amount, cost, at)
    SELECT $1, $2, (row->'line'->>'allocationId')::uuid, (row->>'recognitionId')::uuid, $3,
      (row->'line'->>'amount')::bigint, (row->>'cost')::bigint, $4
    FROM jsonb_array_elements($5::jsonb) AS row
  `, [storeId, settlementId, day, at, snapshots]);

  const cost = nullableSum(ledgerLines.map((line) => line.cost));
  const claim = await member?.beforePublish(settlementId);
  const saleEvent: Omit<PosSaleRecognized['payload'], 'paymentId'> & { paymentId?: string; memberId?: string } = {
    billId, orderId, ...(paymentId && { paymentId }), settlementId, businessDate: day, lines: quote.lines.map((line) => eventLine(line, line.qty)),
    amount: quote.payable, cost, incompleteMarginCoverage: cost === null,
    ...(approval.claimId && { claimId: approval.claimId }),
    ...(member && { memberId: member.memberId }), ...claim,
  };
  await appendOutbox({ ...tx, at }, 'pos.sale_recognized.v1', settlementId, saleEvent);
  return applied({ settlementId, ...(paymentId && { paymentId }), billId, orderIds, remaining: 0, settled: true,
    purpose: 'sale', sourceRef: { kind: 'bill', id: billId }, accountEffects: [] }, settlementId);
}

export async function setPreparation(tx: PosTx, key: string, orderId: string, status: 'preparing' | 'completed', expectedRevision?: number) {
  return applyCommand(tx, 'order.preparation', key, { orderId, status, expectedRevision }, async () => {
    const { rows } = await tx.db.query<{ preparation: string; revision: number; day: string }>(`
      SELECT preparation, revision, business_date::text AS day FROM pos.pos_order WHERE store_id = $1 AND order_id = $2
    `, [tx.storeId, orderId]);
    if (!rows[0]) throw new PosError(404, 'ORDER_NOT_FOUND');
    if (expectedRevision !== undefined) {
      if (expectedRevision !== rows[0].revision) throw new PosError(409, 'STALE_REVISION', { revision: rows[0].revision });
      if (await openDay(tx) !== rows[0].day) throw new PosError(409, 'DAY_CLOSED');
    }
    if (rows[0].preparation === 'completed' && status === 'preparing') throw new PosError(409, 'INVALID_STATUS_TRANSITION');
    const active = await tx.db.query(`
      SELECT 1 FROM pos.order_line l
      JOIN pos.bill_allocation a USING (store_id, order_line_id)
      JOIN pos.bill b USING (store_id, bill_id)
      LEFT JOIN pos.settlement s USING (store_id, bill_id)
      LEFT JOIN pos.payment p USING (store_id, settlement_id)
      WHERE l.store_id = $1 AND l.order_id = $2 AND b.status <> 'void'
        AND a.quantity > (
          SELECT coalesce(sum((entry->>'qty')::integer), 0)
          FROM pos.payment_correction c CROSS JOIN LATERAL jsonb_array_elements(c.allocations) entry
          WHERE c.store_id = l.store_id AND (c.payment_id = p.payment_id OR c.member_sale_settlement_id = s.settlement_id)
            AND c.kind = 'cancel' AND entry->>'allocationId' = a.allocation_id::text
        )
      LIMIT 1
    `, [tx.storeId, orderId]);
    if (!active.rowCount) throw new PosError(409, 'ALREADY_REVERSED');
    await tx.db.query(`
      UPDATE pos.pos_order SET preparation = $3, revision = revision + (preparation <> $3)::integer,
        preparing_at = CASE WHEN preparation = 'accepted' AND $3 = 'preparing' THEN $4 ELSE preparing_at END,
        completed_at = CASE WHEN preparation <> 'completed' AND $3 = 'completed' THEN $4 ELSE completed_at END
      WHERE store_id = $1 AND order_id = $2
    `, [tx.storeId, orderId, status, tx.at]);
    if (expectedRevision === undefined) return applied({ orderId, status }, randomUUID());
    return commandReceipt(orderId, expectedRevision + Number(rows[0].preparation !== status), ['pos.orders']);
  });
}
