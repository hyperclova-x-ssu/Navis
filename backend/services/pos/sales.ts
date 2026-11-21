import { randomUUID } from 'node:crypto';
import type { PosSaleRecognized } from '../../packages/contracts/events.ts';
import { eventLine, nullableSum, quoteBill, saleCost, type BillDraft, type BillInput, type BillQuote } from './catalog.ts';
import { appendOutbox, applyCommand, nextBusinessSequence, openDay, readCommand } from './ledger.ts';
import { applied, fingerprint, integer, object, PosError, splits, uuid, type MethodSplit, type PosTx } from './wire.ts';

export const approvalCommand = 'approval.begin';

export async function createBill(tx: PosTx, key: string, input: BillInput) {
  return applyCommand(tx, 'bill.create', key, input, async () => {
    const day = await openDay(tx);
    const quote = await quoteBill(tx, input);
    const billId = randomUUID();
    await tx.db.query(`
      INSERT INTO pos.bill (store_id, bill_id, business_date, draft, created_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [tx.storeId, billId, day, { request: input, quote } satisfies BillDraft, tx.at]);
    return applied({ billId, ...quote, canSubmit: true, issues: [] }, billId);
  });
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

async function readBill({ db, storeId }: PosTx, billId: string) {
  const { rows } = await db.query<{ day: string; status: string; draft: BillDraft }>(`
    SELECT business_date::text AS day, status, draft FROM pos.bill WHERE store_id = $1 AND bill_id = $2
  `, [storeId, billId]);
  if (!rows[0]) throw new PosError(404, 'BILL_NOT_FOUND');
  return rows[0];
}

async function currentQuote(tx: PosTx, input: ApprovalInput, day: string) {
  const bill = await readBill(tx, input.billId);
  if (bill.status !== 'open') throw new PosError(409, 'BILL_LOCKED');
  if (bill.day !== day) throw new PosError(409, 'DAY_CLOSED');
  const quote = await quoteBill(tx, bill.draft.request, bill.draft.quote);
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
  const active = await db.query(`
    SELECT 1 FROM pos.command_ledger WHERE store_id = $1 AND bill_id = $2
      AND command_type = 'approval.begin' AND status = 'pending'
  `, [storeId, input.billId]);
  if (active.rowCount) throw new PosError(409, 'APPROVAL_BUSY');

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

async function recognizeSale(tx: PosTx, approval: PinnedApproval, quote: BillQuote): Promise<CompletedReceipt> {
  const { db, storeId, at, actorId } = tx;
  const { billId, businessDate: day } = approval;
  const orderId = randomUUID();
  const paymentId = randomUUID();
  const settlementId = randomUUID();
  const seq = await nextBusinessSequence(tx, day);
  const transactionNo = `거래-${day.replaceAll('-', '')}-${String(seq).padStart(4, '0')}`;
  const approvalNo = `예시-${String(seq).padStart(6, '0')}`;
  await db.query(`
    UPDATE pos.bill SET status = 'paid', recognized_at = $3 WHERE store_id = $1 AND bill_id = $2
  `, [storeId, billId, at]);
  await db.query(`
    INSERT INTO pos.pos_order (store_id, order_id, origin_bill_id, business_date, order_no, ordered_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [storeId, orderId, billId, day, seq, at]);
  await db.query(`
    INSERT INTO pos.settlement (store_id, settlement_id, bill_id, purpose, amount, at)
    VALUES ($1, $2, $3, 'sale', $4, $5)
  `, [storeId, settlementId, billId, quote.payable, at]);
  await db.query(`
    INSERT INTO pos.payment (store_id, payment_id, settlement_id, created_by, amount, splits, transaction_no, approval_no, at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [storeId, paymentId, settlementId, actorId, quote.payable, JSON.stringify(approval.splits), transactionNo, approvalNo, at]);

  const ledgerLines = quote.lines.map((line) => ({
    line, recognitionId: randomUUID(), cost: saleCost(line, line.qty),
  }));
  const snapshots = JSON.stringify(ledgerLines);
  await db.query(`
    INSERT INTO pos.order_line (store_id, order_id, order_line_id, snapshot)
    SELECT $1, $2, (row->'line'->>'orderLineId')::uuid, row->'line'
    FROM jsonb_array_elements($3::jsonb) AS row
  `, [storeId, orderId, snapshots]);
  await db.query(`
    INSERT INTO pos.bill_allocation (store_id, bill_id, allocation_id, order_line_id, quantity)
    SELECT $1, $2, (row->'line'->>'allocationId')::uuid, (row->'line'->>'orderLineId')::uuid, (row->'line'->>'qty')::integer
    FROM jsonb_array_elements($3::jsonb) AS row
  `, [storeId, billId, snapshots]);
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
  await appendOutbox<PosSaleRecognized>(tx, 'pos.sale_recognized.v1', settlementId, {
    billId, orderId, paymentId, settlementId, businessDate: day, lines: quote.lines.map((line) => eventLine(line, line.qty)),
    amount: quote.payable, cost, incompleteMarginCoverage: cost === null,
    ...(approval.claimId && { claimId: approval.claimId }),
  });
  return applied({ settlementId, paymentId, billId, orderIds: [orderId], remaining: 0, settled: true,
    purpose: 'sale', sourceRef: { kind: 'bill', id: billId }, accountEffects: [] }, settlementId);
}

export async function setPreparation(tx: PosTx, key: string, orderId: string, status: 'preparing' | 'completed') {
  return applyCommand(tx, 'order.preparation', key, { orderId, status }, async () => {
    const { rows } = await tx.db.query<{ preparation: string }>(`
      SELECT preparation FROM pos.pos_order WHERE store_id = $1 AND order_id = $2
    `, [tx.storeId, orderId]);
    if (!rows[0]) throw new PosError(404, 'ORDER_NOT_FOUND');
    if (rows[0].preparation === 'completed' && status === 'preparing') throw new PosError(409, 'INVALID_STATUS_TRANSITION');
    const { rows: payments } = await tx.db.query(`
      SELECT 1 FROM pos.pos_order o
      JOIN pos.settlement s ON (s.store_id, s.bill_id) = (o.store_id, o.origin_bill_id)
      JOIN pos.payment p ON (p.store_id, p.settlement_id) = (s.store_id, s.settlement_id)
      JOIN pos.payment_correction c ON (c.store_id, c.payment_id) = (p.store_id, p.payment_id)
      WHERE o.store_id = $1 AND o.order_id = $2 AND c.kind = 'cancel'
      GROUP BY p.payment_id, p.amount HAVING sum(c.amount) = p.amount
    `, [tx.storeId, orderId]);
    if (payments.length) throw new PosError(409, 'ALREADY_REVERSED');
    await tx.db.query(`
      UPDATE pos.pos_order SET preparation = $3 WHERE store_id = $1 AND order_id = $2
    `, [tx.storeId, orderId, status]);
    return applied({ orderId, status }, randomUUID());
  });
}
