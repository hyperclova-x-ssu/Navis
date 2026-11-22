import { createHmac, randomUUID } from 'node:crypto';
import type { CustomFailure, CustomReversalQuote, CustomSettlementQuote } from '../../../../../frontend/src/data/iteration7/custom-orders/types.ts';
import { applyCommand, nextBusinessSequence, openDay } from '../../ledger.ts';
import { fingerprint, integer, methods, object, PosError, type MethodSplit, type PosTx } from '../../wire.ts';
import { insertTerminal, parseTerminal, requireTerminal, type TerminalRecord } from '../02/terminal.ts';
import { accountSources, balance, type Account } from '../05/accounts.ts';
import { choice, confirm, invalid, stale, text, verifyMember, type OrderDependencies } from './input.ts';
import { apportion, memberKinds, planMemberReturns, postMemberReturns, postMemberValues, remainingMemberValue, total,
  type Posting, type Return } from './member-value.ts';
import { active, approved, closePickup, readOrder, writeOrder, type Order } from './records.ts';
import { adjustRecognition, originalRecognition } from './recognition.ts';
import { registerUndo, type UndoEffect } from './undo.ts';

const channelFor = (splits: readonly MethodSplit[]) => splits.some(split => split.method !== 'cash') ? 'terminal_record' : 'cash_record';
type Allocation = { kind: 'method' } & MethodSplit | { kind: Account; amount: number };

function parseAllocations(value: unknown) {
  if (!Array.isArray(value) || value.length > 12) return invalid('allocations', 'INVALID_SETTLEMENT_KIND');
  const amounts = new Map<MethodSplit['method'] | Account, number>();
  for (const item of value) {
    const row = object(item, ['kind', 'method', 'amount', 'allocationId']);
    const kind = (['method', ...memberKinds] as const).find(candidate => candidate === row.kind)
      ?? invalid('allocations', 'INVALID_SETTLEMENT_KIND');
    if (kind !== 'method') object(item, ['kind', 'amount']);
    const key = kind === 'method' ? choice(row.method, methods, 'method') : kind;
    const next = (amounts.get(key) ?? 0) + integer(row.amount, kind === 'method' ? 0 : 1, Number.MAX_SAFE_INTEGER, 'AMOUNT_POSITIVE_REQUIRED');
    if (!Number.isSafeInteger(next)) return invalid('amount', 'AMOUNT_POSITIVE_REQUIRED');
    amounts.set(key, next);
  }
  const splits = methods.flatMap(method => {
    const amount = amounts.get(method);
    return amount ? [{ method, amount }] : [];
  });
  const memberValue = memberKinds.flatMap(kind => {
    const amount = amounts.get(kind);
    return amount ? [{ kind, amount }] : [];
  });
  const allocations: Allocation[] = [...splits.map(row => ({ kind: 'method' as const, ...row })), ...memberValue];
  if (!Number.isSafeInteger(total(allocations))) return invalid('amount', 'AMOUNT_POSITIVE_REQUIRED');
  return { splits, memberValue, allocations };
}

function quoteId(tx: PosTx, secret: string, type: string, order: Order, input: unknown) {
  return createHmac('sha256', secret).update(fingerprint({
    type, orderId: order.customOrderId, revision: order.revision, storeId: tx.storeId, actorId: tx.actorId, input,
  })).digest('base64url');
}

function issue(reason: string, code: CustomFailure['code'] = 'CONFLICT', details?: Record<string, unknown>): CustomFailure {
  return { ok: false, code, reason, messageKey: 'data.custom.error.' + reason, ...(details && { details }) };
}

type SettlementQuote = Omit<CustomSettlementQuote, 'allocations' | 'accountEffects'> & {
  allocations: Allocation[];
  accountEffects: Posting[];
};

async function settlementQuote(tx: PosTx, deps: OrderDependencies, secret: string, order: Order,
  { allocations, splits, memberValue }: ReturnType<typeof parseAllocations>, day?: string): Promise<SettlementQuote> {
  const amountDue = Math.max(0, (order.quoteAmount ?? 0) - order.amountSettled + order.amountReturned);
  const remaining = amountDue - total(allocations);
  const issues = [];
  if (!approved(order)) issues.push(issue('APPROVAL_REQUIRED'));
  else if (!['payment_pending', 'in_production', 'production_complete'].includes(order.stage) || order.settlementId
    || order.pickup?.status !== 'confirmed') issues.push(issue('QUOTE_CHANGED'));
  else if (remaining || !amountDue) issues.push(issue('ALLOCATION_SUM_MISMATCH', 'VALIDATION'));
  const { memberId } = order.receipt;
  let accountRevision: number | undefined;
  const accountEffects: Posting[] = [];
  if (memberValue.length && !issues.length) {
    if (!memberId) issues.push(issue('MEMBER_REQUIRED', 'VALIDATION'));
    else {
      await verifyMember(tx, deps, day ?? await openDay(tx), memberId);
      const account = await balance(tx, memberId);
      accountRevision = account.revision;
      const charge = memberValue.find(row => row.kind === 'charge')?.amount ?? 0;
      const receivable = memberValue.find(row => row.kind === 'receivable')?.amount ?? 0;
      if (charge > account.chargeBalance) issues.push(issue('CHARGE_BALANCE_EXCEEDED', 'CONFLICT', { available: account.chargeBalance }));
      if (!Number.isSafeInteger(receivable + account.receivableBalance)) issues.push(issue('RECEIVABLE_LIMIT'));
      if (!issues.length) {
        if (charge) accountEffects.push({ memberId, account: 'charge', kind: 'use', amount: -charge });
        if (receivable) accountEffects.push({ memberId, account: 'receivable', kind: 'sale', amount: receivable });
      }
    }
  }
  return {
    quoteId: quoteId(tx, secret, 'settlement', order, memberValue.length ? { allocations, accountRevision } : splits),
    quoteRevision: order.revision, orderQuoteRevision: order.quoteRevision,
    target: { purpose: 'custom_order', customOrderId: order.customOrderId }, amountDue, realMethodSplits: splits,
    allocations, remaining, discounts: [], recognitionEffects: [], accountEffects, membershipEffects: [],
    canSubmit: !issues.length, issues,
  };
}

export async function quoteSettlement(tx: PosTx, deps: OrderDependencies, secret: string, id: string, body: unknown) {
  const input = object(body, ['allocations']);
  return settlementQuote(tx, deps, secret, await readOrder(tx, id), parseAllocations(input.allocations));
}

function assertQuote(current: { quoteId: string; issues: readonly CustomFailure[] }, id?: string) {
  if (id !== undefined && current.quoteId !== id) throw new PosError(409, 'QUOTE_CHANGED');
  const first = current.issues[0];
  if (first) throw new PosError(first.code === 'VALIDATION' ? 400 : first.code === 'NOT_FOUND' ? 404 : 409, first.reason, first.details);
}

function withMemberSources<T extends { affectedSources: string[] }>(receipt: T) {
  return { ...receipt, affectedSources: [...new Set([...receipt.affectedSources, ...accountSources])] };
}

export function recordPayment(tx: PosTx, deps: OrderDependencies, secret: string, key: string, id: string, body: unknown) {
  const input = object(body, ['quoteId', 'expectedRevision', 'allocations', 'terminal']);
  const expectedRevision = integer(input.expectedRevision, 1);
  const quoted = text(input.quoteId, 'quoteId', 100);
  const parsed = parseAllocations(input.allocations);
  const { splits, memberValue } = parsed;
  const terminal = parseTerminal(input.terminal);
  const channel = channelFor(splits);
  return applyCommand(tx, 'customOrder.settle', key, { id, expectedRevision, quoted, splits, terminal,
    ...(memberValue.length && { memberValue }) }, async () => {
    const day = await openDay(tx);
    const order = await readOrder(tx, id);
    stale(expectedRevision, order.revision);
    const quote = await settlementQuote(tx, deps, secret, order, parsed, day);
    assertQuote(quote, quoted);
    requireTerminal(channel, terminal);
    if (!memberValue.length) await verifyMember(tx, deps, day, order.receipt.memberId);
    const settlementId = randomUUID(), paymentId = splits.length ? randomUUID() : null;
    const at = terminal ? new Date(terminal.occurredAt) : tx.at;
    await tx.db.query(`INSERT INTO pos.settlement (store_id,settlement_id,purpose,amount,at)
      VALUES ($1,$2,'custom_order',$3,$4)`, [tx.storeId, settlementId, quote.amountDue, at]);
    if (paymentId) {
      const transactionNo = '기록-' + paymentId;
      await tx.db.query(`INSERT INTO pos.payment
        (store_id,payment_id,settlement_id,created_by,amount,splits,transaction_no,approval_no,at,channel)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [tx.storeId, paymentId, settlementId, tx.actorId,
        total(splits), JSON.stringify(splits), transactionNo, terminal?.approvalNo ?? terminal?.receiptNo ?? transactionNo, at, channel]);
      if (terminal) await insertTerminal(tx, day, paymentId, null, terminal);
    }
    const member = quote.accountEffects[0]?.memberId;
    if (member) await postMemberValues(tx, member, { settlementId, businessDate: day, at }, quote.accountEffects);
    const stage = order.stage === 'payment_pending' ? 'in_production' : order.stage;
    const receipt = { ...await writeOrder(tx, order, { settlementId, stage },
      { kind: 'settled', detail: String(quote.amountDue), referenceId: settlementId },
      order.pickup, { money: true, receiptId: paymentId ?? settlementId }), paymentId };
    if (!member) return receipt;
    const affected = withMemberSources(receipt);
    if (paymentId) return affected;
    return registerUndo(tx, affected, 'customOrder.settle', key, { kind: 'payment', businessDate: day,
      customOrderId: id, revision: receipt.revision, settlementId, previousStage: order.stage });
  });
}

type ReversalInput = { kind: CustomReversalQuote['kind']; amount?: number };

function parseReversal(input: Record<string, unknown>): ReversalInput {
  return { kind: choice(input.kind, ['cancellation', 'refund'], 'kind'),
    amount: input.amount === undefined ? undefined : integer(input.amount, 1, Number.MAX_SAFE_INTEGER, 'REFUND_LIMIT') };
}

async function remainingTender(tx: PosTx, paymentId: string) {
  const { rows } = await tx.db.query<MethodSplit>(`
    SELECT original.split->>'method' AS method,
      ((original.split->>'amount')::bigint - coalesce(returns.amount, 0))::double precision AS amount
    FROM pos.payment p CROSS JOIN LATERAL jsonb_array_elements(p.splits) WITH ORDINALITY original(split, ordinal)
    LEFT JOIN LATERAL (
      SELECT sum((returned.item->>'amount')::bigint) AS amount
      FROM pos.payment_correction c CROSS JOIN LATERAL jsonb_array_elements(c.methods) AS returned(item)
      WHERE c.store_id=p.store_id AND c.payment_id=p.payment_id AND returned.item->>'method'=original.split->>'method'
    ) returns ON true
    WHERE p.store_id=$1 AND p.payment_id=$2 ORDER BY original.ordinal`, [tx.storeId, paymentId]);
  return rows.filter(row => row.amount > 0);
}

type ReversalQuote = CustomReversalQuote & { accountEffects: Return[] };

async function planReversal(tx: PosTx, secret: string, order: Order, input: ReversalInput) {
  const settlementId = order.settlementId ?? '';
  const tender = order.paymentId ? await remainingTender(tx, order.paymentId) : [];
  const values = settlementId && (order.chargeApplied || order.receivableAmount) ? await remainingMemberValue(tx, settlementId) : [];
  const available = [...tender, ...values];
  const remainingRefundable = total(available);
  const amount = input.amount ?? remainingRefundable;
  const issues: CustomFailure[] = [];
  if (!settlementId) issues.push(issue('PAYMENT_REQUIRED', 'NOT_FOUND'));
  else if (input.kind === 'cancellation' && !active(order.stage)) issues.push(issue('INVALID_STAGE_TRANSITION'));
  else if (amount <= 0 || amount > remainingRefundable || (input.kind === 'cancellation' && amount !== remainingRefundable)) {
    issues.push(issue('REFUND_LIMIT', 'VALIDATION'));
  }
  const parts = issues.length ? [] : apportion(amount, available);
  const realMethodReturns = parts.filter(part => 'method' in part);
  let memberReturns: Awaited<ReturnType<typeof planMemberReturns>> = [];
  try {
    memberReturns = await planMemberReturns(tx, settlementId, parts.filter(part => 'account' in part));
  } catch (error) {
    if (!(error instanceof PosError)) throw error;
    issues.push(issue(error.result.reason, 'CONFLICT', error.result.details));
  }
  const original = !issues.length && order.stage === 'received_by_customer' ? await originalRecognition(tx, order) : null;
  const quote: ReversalQuote = {
    quoteId: quoteId(tx, secret, 'reversal', order, { kind: input.kind, amount, realMethodReturns,
      ...(memberReturns.length && { memberReturns }) }), quoteRevision: order.revision,
    customOrderId: order.customOrderId, settlementId, kind: input.kind, amount, remainingRefundable, realMethodReturns,
    accountEffects: memberReturns.map(posting => posting.effect),
    recognitionEffects: original ? [{
      recognitionId: original, originalRecognitionId: original, sourceId: order.customOrderId, source: 'custom_pickup',
      businessDate: await openDay(tx), at: tx.at.toISOString(), amount: -amount, cost: null, settlementCategory: 'custom_pickup',
    }] : [],
    canSubmit: !issues.length, issues,
  };
  return { quote, memberReturns };
}

export async function quoteReversal(tx: PosTx, secret: string, id: string, body: unknown) {
  return (await planReversal(tx, secret, await readOrder(tx, id), parseReversal(object(body, ['kind', 'amount'])))).quote;
}

async function postCorrection(tx: PosTx, order: Order, day: string, terminal: TerminalRecord | null,
  { quote, memberReturns }: Awaited<ReturnType<typeof planReversal>>) {
  requireTerminal(channelFor(quote.realMethodReturns), terminal);
  const amount = total(quote.realMethodReturns);
  const paymentId = amount ? order.paymentId : null;
  if (amount && !paymentId) throw new Error('Missing recorded tender for custom correction');
  const correctionId = randomUUID();
  const seq = await nextBusinessSequence(tx, day);
  const at = terminal ? new Date(terminal.occurredAt) : tx.at;
  await tx.db.query(`INSERT INTO pos.payment_correction
    (store_id,correction_id,payment_id,business_date,created_by,kind,amount,methods,allocations,seq,at,
     custom_order_settlement_id,custom_order_amount)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]',$9,$10,$11,$12)`, [tx.storeId, correctionId, paymentId, day, tx.actorId,
    quote.kind === 'cancellation' ? 'cancel' : 'refund', amount, JSON.stringify(quote.realMethodReturns), seq, at,
    quote.settlementId, quote.amount]);
  if (terminal && paymentId) await insertTerminal(tx, day, paymentId, correctionId, terminal);
  if (memberReturns.length) {
    await postMemberReturns(tx, { settlementId: quote.settlementId, correctionId, businessDate: day, at }, memberReturns);
  }
  const recognitionId = quote.recognitionEffects.length ? await adjustRecognition(tx, order, {
    kind: 'refund', day, amount: -quote.amount, correctionId, at,
  }) : undefined;
  return { correctionId, ...(recognitionId && { recognitionId }) };
}

export function recordCorrection(tx: PosTx, secret: string, key: string, id: string, body: unknown) {
  const input = object(body, ['quoteId', 'expectedRevision', 'kind', 'amount', 'confirmed', 'terminal']);
  confirm(input.confirmed);
  const expectedRevision = integer(input.expectedRevision, 1);
  const quoted = text(input.quoteId, 'quoteId', 100);
  const reversal = parseReversal(input);
  const terminal = parseTerminal(input.terminal);
  return applyCommand(tx, 'customOrder.correct', key, { id, expectedRevision, quoted, reversal, terminal }, async () => {
    const day = await openDay(tx);
    const order = await readOrder(tx, id);
    stale(expectedRevision, order.revision);
    const plan = await planReversal(tx, secret, order, reversal);
    const { quote } = plan;
    assertQuote(quote, quoted);
    const correction = await postCorrection(tx, order, day, terminal, plan);
    const cancel = reversal.kind === 'cancellation';
    const result = await writeOrder(tx, order, cancel ? { stage: 'canceled' } : {},
      { kind: cancel ? 'canceled' : 'refunded', detail: String(quote.amount), referenceId: correction.correctionId },
      cancel ? closePickup(tx, order.pickup, 'canceled') : order.pickup, { money: true, receiptId: correction.correctionId });
    const receipt = { ...result, ...correction, paymentId: order.paymentId };
    return plan.memberReturns.length ? withMemberSources(receipt) : receipt;
  });
}

export async function undoPayment(tx: PosTx, secret: string, effect: Extract<UndoEffect, { kind: 'payment' }>) {
  const day = await openDay(tx);
  const order = await readOrder(tx, effect.customOrderId);
  if (day !== effect.businessDate || order.revision !== effect.revision || order.settlementId !== effect.settlementId
    || order.paymentId || order.amountReturned || order.pickup?.status !== 'confirmed') throw new PosError(409, 'UNDO_UNAVAILABLE');
  const plan = await planReversal(tx, secret, order, { kind: 'cancellation' });
  assertQuote(plan.quote);
  const { correctionId } = await postCorrection(tx, order, day, null, plan);
  const receipt = await writeOrder(tx, order, { settlementId: null, stage: effect.previousStage },
    { kind: 'refunded', detail: String(plan.quote.amount), referenceId: correctionId },
    order.pickup, { money: true, receiptId: correctionId });
  return withMemberSources({ ...receipt, correctionId, paymentId: null });
}
