import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PosSaleCorrected } from '../../packages/contracts/events.ts';
import { apportion, eventLine, nullableSum, saleCost, type SaleLine } from './catalog.ts';
import { appendOutbox, applyCommand, nextBusinessSequence, openDay } from './ledger.ts';
import { insertTerminal, readTerminal, requireTerminal, type PaymentChannel, type TerminalRecord } from './reality/02/terminal.ts';
import { applied, commandReceipt, fingerprint, integer, object, PosError, splits, uuid, type MethodSplit, type PosTx } from './wire.ts';
import { accountSources } from './reality/05/accounts.ts';
import { memberCorrectionEntries, reverseMemberEntries } from './reality/05/corrections.ts';

type Kind = 'cancel' | 'refund';
type ReversalInput = {
  kind: Kind;
  lines?: { orderLineId: string; qty: number }[];
  amount?: number;
  methodAmounts?: MethodSplit[];
};
type CorrectionLine = {
  allocationId: string; qty: number; amount: number; gross: number; discount: number; cost: number | null;
};
type Correction = {
  correctionId: string; kind: Kind; at: Date; seq: number; amount: number;
  methods: MethodSplit[]; allocations: CorrectionLine[]; terminal: TerminalRecord | null;
};
type Sale = {
  paymentId: string | null; settlementId: string; billId: string; orderId: string; orderNos: number[]; businessDate: string;
  storeName: string | null; at: Date; amount: number; splits: MethodSplit[];
  transactionNo: string | null; approvalNo: string | null; preparation: 'accepted' | 'preparing' | 'completed';
  channel: PaymentChannel | null; terminal: TerminalRecord | null;
  source: 'connect' | 'naver' | null; naverPayPaymentId: string | null; smartstoreProductOrderId: string | null;
  memberId: string | null; containsMemberValue: boolean | null; memberAllocations: unknown[] | null;
  lines: { line: SaleLine; recognitionId: string; orderId: string; orderNo: number; preparation: Sale['preparation'] }[];
  corrections: Correction[];
};

export function parseReversal(value: unknown): ReversalInput {
  const input = object(value, ['kind', 'lines', 'amount', 'methodAmounts', 'restockRetail']);
  if (input.kind !== 'cancel' && input.kind !== 'refund') throw new PosError(400, 'INVALID_REQUEST');
  if (input.restockRetail !== undefined && typeof input.restockRetail !== 'boolean') throw new PosError(400, 'INVALID_REQUEST');
  if (input.restockRetail) throw new PosError(400, 'RETAIL_REQUIRED');
  const parsed: ReversalInput = { kind: input.kind };
  if (input.lines !== undefined) {
    if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100 || input.amount !== undefined) {
      throw new PosError(400, 'INVALID_SELECTION');
    }
    parsed.lines = input.lines.map((row) => {
      const line = object(row, ['orderLineId', 'qty']);
      return { orderLineId: uuid(line.orderLineId), qty: integer(line.qty, 1, 99, 'QTY_LIMIT') };
    }).sort((a, b) => a.orderLineId.localeCompare(b.orderLineId));
    if (new Set(parsed.lines.map((row) => row.orderLineId)).size !== parsed.lines.length) {
      throw new PosError(400, 'INVALID_SELECTION');
    }
  }
  if (input.amount !== undefined) {
    if (input.kind === 'cancel') throw new PosError(400, 'INVALID_SELECTION');
    parsed.amount = integer(input.amount, 1, Number.MAX_SAFE_INTEGER, 'INVALID_AMOUNT');
  }
  if (input.methodAmounts !== undefined) parsed.methodAmounts = splits(input.methodAmounts);
  return parsed;
}

async function loadSale({ db, storeId }: PosTx, paymentId: string): Promise<Sale> {
  const { rows: header } = await db.query<Omit<Sale, 'lines' | 'corrections' | 'terminal' | 'orderId' | 'orderNos' | 'preparation'> & {
    terminalApproval: string | null; terminalReceipt: string | null; terminalAt: Date | null;
  }>(`
    SELECT p.payment_id AS "paymentId", s.settlement_id AS "settlementId", s.bill_id AS "billId",
      b.business_date::text AS "businessDate",
      st.display_name AS "storeName", s.at, s.amount::double precision AS amount, COALESCE(p.splits, '[]') AS splits,
      p.transaction_no AS "transactionNo", p.approval_no AS "approvalNo", p.channel,
      coalesce(p.source, CASE WHEN link.order_ref IS NOT NULL THEN 'naver' END) AS source,
      link.naver_pay_payment_id AS "naverPayPaymentId", link.smartstore_product_order_id AS "smartstoreProductOrderId",
      m.member_id AS "memberId", m.contains_member_value AS "containsMemberValue", m.allocations AS "memberAllocations",
      t.approval_no AS "terminalApproval", t.receipt_no AS "terminalReceipt", t.occurred_at AS "terminalAt"
    FROM pos.settlement s
    LEFT JOIN pos.payment p USING (store_id, settlement_id)
    LEFT JOIN pos.naver_order_link link USING (store_id, payment_id)
    LEFT JOIN pos.member_sale m USING (store_id, settlement_id)
    JOIN pos.bill b USING (store_id, bill_id)
    JOIN pos.store st ON st.store_id = s.store_id
    LEFT JOIN pos.terminal_record t ON (t.store_id, t.record_id) = (p.store_id, p.payment_id)
    WHERE s.store_id = $1 AND (p.payment_id = $2 OR (m.member_id IS NOT NULL AND s.settlement_id = $2))
  `, [storeId, paymentId]);
  if (!header[0]) throw new PosError(404, 'PAYMENT_NOT_FOUND');

  const { rows: lines } = await db.query<Sale['lines'][number]>(`
    SELECT l.snapshot AS line, r.recognition_id AS "recognitionId", o.order_id AS "orderId", o.order_no AS "orderNo", o.preparation
    FROM pos.settlement_line l
    JOIN pos.sales_recognition r USING (store_id, settlement_id, allocation_id)
    JOIN pos.bill_allocation a USING (store_id, allocation_id)
    JOIN pos.order_line ol USING (store_id, order_line_id)
    JOIN pos.pos_order o USING (store_id, order_id)
    WHERE l.store_id = $1 AND l.settlement_id = $2 AND r.correction_id IS NULL
    ORDER BY o.order_no, l.allocation_id
  `, [storeId, header[0].settlementId]);
  const { rows: corrections } = await db.query<Omit<Correction, 'terminal'> & {
    approvalNo: string | null; receiptNo: string | null; occurredAt: Date | null;
  }>(`
    SELECT c.correction_id AS "correctionId", c.kind, c.at, c.seq,
      COALESCE(c.member_sale_amount, c.amount)::double precision AS amount, c.methods, c.allocations,
      t.approval_no AS "approvalNo", t.receipt_no AS "receiptNo", t.occurred_at AS "occurredAt"
    FROM pos.payment_correction c
    LEFT JOIN pos.terminal_record t ON (t.store_id, t.record_id) = (c.store_id, c.correction_id)
    WHERE c.store_id = $1 AND (c.payment_id = $2 OR c.member_sale_settlement_id = $3) ORDER BY c.seq
  `, [storeId, header[0].paymentId, header[0].settlementId]);
  const { terminalApproval, terminalReceipt, terminalAt, ...sale } = header[0];
  if (!lines.length) throw new Error('Missing recognized POS settlement lines');
  const orderNos = [...new Set(lines.map(line => line.orderNo))];
  const preparation = lines.some(line => line.preparation === 'completed') ? 'completed'
    : lines.some(line => line.preparation === 'preparing') ? 'preparing' : 'accepted';
  return { ...sale, lines, orderId: lines[0].orderId, orderNos, preparation,
    terminal: readTerminal({ approvalNo: terminalApproval, receiptNo: terminalReceipt, occurredAt: terminalAt }),
    corrections: corrections.map(({ approvalNo, receiptNo, occurredAt, ...correction }) => ({
      ...correction, terminal: readTerminal({ approvalNo, receiptNo, occurredAt }),
    })) };
}

function saleBalances(sale: Sale) {
  const methods = sale.splits.map((split) => ({ ...split }));
  const lines = sale.lines.map(({ line, preparation }) => ({
    line, preparation, qty: line.qty, amount: line.amount, gross: line.gross, discount: line.discount,
  }));
  const byAllocation = new Map(lines.map((row) => [row.line.allocationId, row]));
  for (const correction of sale.corrections) {
    for (const split of correction.methods) {
      const remaining = methods.find((candidate) => candidate.method === split.method);
      if (!remaining) throw new Error('Missing original payment method');
      remaining.amount -= split.amount;
    }
    for (const allocation of correction.allocations) {
      const remaining = byAllocation.get(allocation.allocationId);
      if (!remaining) throw new Error('Missing original settlement allocation');
      remaining.qty -= allocation.qty;
      remaining.amount -= allocation.amount;
      remaining.gross -= allocation.gross;
      remaining.discount -= allocation.discount;
    }
  }
  return { methods, lines, remaining: methods.reduce((sum, method) => sum + method.amount, 0) };
}

export async function receipt(tx: PosTx, paymentId: string) {
  const sale = await loadSale(tx, paymentId);
  const balance = saleBalances(sale);
  const remaining = sale.containsMemberValue ? (sale.corrections.length ? 0 : sale.amount) : balance.remaining;
  const refunded = sale.corrections.some((row) => row.kind === 'refund');
  const status = refunded ? (remaining ? 'partially_refunded' : 'refunded')
    : sale.corrections.length ? (remaining ? 'partially_canceled' : 'canceled') : 'paid';
  const lines = sale.lines.map(({ line }) => ({
    orderLineId: line.orderLineId, menuId: line.menuId, name: line.name, qty: line.qty,
    options: line.options, request: '', gross: line.gross, discount: line.discount, amount: line.amount,
  }));
  const gross = lines.reduce((sum, line) => sum + line.gross, 0);
  const discount = lines.reduce((sum, line) => sum + line.discount, 0);
  const currentPrepared = sale.preparation !== 'accepted';
  const saleLines = new Map(sale.lines.map(({ line }) => [line.allocationId, line]));
  return {
    paymentId: sale.paymentId, settlementId: sale.settlementId, billId: sale.billId, storeName: sale.storeName,
    orderNos: sale.orderNos, transactionNo: sale.transactionNo, approvalNo: sale.approvalNo, at: sale.at,
    ...(sale.source && { source: sale.source }),
    ...(sale.naverPayPaymentId && { naverPayPaymentId: sale.naverPayPaymentId }),
    ...(sale.smartstoreProductOrderId && { smartstoreProductOrderId: sale.smartstoreProductOrderId }),
    ...(sale.channel && sale.channel !== 'fixture' && { channel: sale.channel, terminal: sale.terminal, revision: sale.corrections.length + 1 }),
    ...(sale.memberId && { memberId: sale.memberId, containsMemberValue: sale.containsMemberValue, revision: sale.corrections.length + 1,
      ...(sale.memberAllocations && { memberAllocations: sale.memberAllocations }),
      realAmount: sale.splits.reduce((total, row) => total + row.amount, 0) }),
    amount: sale.amount, gross, discount, remaining, status, splits: sale.splits, lines,
    discounts: discount ? [{ source: 'direct', amount: discount }] : [],
    member: null, cashReceipt: null, canIssueCashReceipt: false,
    sourceSnapshot: { amount: sale.amount, splits: sale.splits, lines },
    currentPrepared, wholeBillDiscount: discount > 0,
    reversalLines: balance.lines.filter((row) => row.qty > 0 && (!sale.containsMemberValue ? remaining > 0 : !sale.corrections.length)).map(({ line, qty, preparation }) => ({
      allocationId: line.allocationId, orderLineId: line.orderLineId, menuId: line.menuId, name: line.name,
      quantity: qty, prepared: preparation !== 'accepted',
    })),
    corrections: sale.corrections.map(({ allocations, terminal, ...correction }) => ({
      ...correction, restockRetail: false, ...(terminal && { terminal }),
      lines: allocations.map(({ allocationId, qty, gross, discount, amount }) => ({
        allocationId, orderLineId: saleLines.get(allocationId)!.orderLineId, qty, gross, discount, amount,
      })),
    })),
  };
}

const portion = (amount: number, qty: number, total: number) =>
  Number(BigInt(amount) * BigInt(qty) / BigInt(total));

function plan(sale: Sale, input: ReversalInput) {
  const balance = saleBalances(sale);
  if (!balance.remaining) throw new PosError(409, 'ALREADY_REVERSED');
  const cancel = input.kind === 'cancel';
  if (cancel && sale.preparation !== 'accepted') throw new PosError(409, 'USE_REFUND');
  if (!cancel && sale.preparation === 'accepted') throw new PosError(409, 'USE_CANCEL');

  const requested = new Map(input.lines?.map((line) => [line.orderLineId, line.qty]));
  const selected = balance.lines.filter(({ line, qty, amount }) =>
    requested.size ? requested.has(line.orderLineId) && qty > 0 : qty > 0 || amount > 0);
  if (requested.size && new Set(selected.map(({ line }) => line.orderLineId)).size !== requested.size) {
    throw new PosError(400, 'INVALID_SELECTION');
  }
  const availableQty = new Map<string, number>();
  for (const { line, qty } of selected) availableQty.set(line.orderLineId, (availableQty.get(line.orderLineId) ?? 0) + qty);
  if ([...requested].some(([id, qty]) => qty > availableQty.get(id)!)) throw new PosError(409, 'QTY_LIMIT');
  if (cancel && balance.lines.some(({ line }) => line.discount > 0) && requested.size
      && (selected.length !== balance.lines.filter(({ qty }) => qty > 0).length
        || [...requested].some(([id, qty]) => qty !== availableQty.get(id)))) {
    throw new PosError(409, 'WHOLE_BILL_DISCOUNT');
  }
  if (input.amount !== undefined && input.amount > balance.remaining) {
    throw new PosError(409, 'REFUND_LIMIT', { remaining: balance.remaining });
  }
  const amountShares = input.amount === undefined ? undefined : apportion(input.amount,
    selected.map(({ line, amount }) => ({ id: line.allocationId, weight: amount })));

  const allocations = selected.map((row, index): CorrectionLine => {
    const targetQty = Math.min(requested.get(row.line.orderLineId) ?? row.qty, row.qty);
    if (requested.size) requested.set(row.line.orderLineId, requested.get(row.line.orderLineId)! - targetQty);
    const qty = input.amount === undefined ? targetQty : 0;
    const gross = cancel ? portion(row.gross, qty, row.qty) : 0;
    const discount = cancel ? portion(row.discount, qty, row.qty) : 0;
    const amount = cancel ? gross - discount
      : amountShares?.[index] ?? (requested.size ? portion(row.amount, qty, row.qty) : row.amount);
    if (amount > row.amount) throw new PosError(409, 'REFUND_LIMIT', { remaining: balance.remaining });
    const cost = cancel ? saleCost(row.line, qty) : 0;
    return { allocationId: row.line.allocationId, qty, amount, gross, discount, cost: cost === null ? null : -cost };
  }).filter(({ amount, qty }) => amount > 0 || qty > 0);

  const amount = allocations.reduce((sum, line) => sum + line.amount, 0);
  if (!(amount > 0)) throw new PosError(400, 'EMPTY_SELECTION');
  const available = balance.methods.filter((row) => row.amount > 0);
  let methodAmounts = input.methodAmounts;
  if (!methodAmounts) {
    if (amount === balance.remaining) methodAmounts = available;
    else if (available.length === 1) methodAmounts = [{ method: available[0].method, amount }];
    else throw new PosError(409, 'METHOD_REQUIRED');
  }
  if (methodAmounts.reduce((sum, row) => sum + row.amount, 0) !== amount
      || methodAmounts.some((row) => row.amount > (available.find(({ method }) => method === row.method)?.amount ?? 0))) {
    throw new PosError(409, 'METHOD_LIMIT', { remaining: balance.remaining });
  }
  return { allocations, amount, methods: methodAmounts, remaining: balance.remaining };
}

export function createReversalTokens(key: string) {
  const sign = (value: string) => createHmac('sha256', key).update('navis:pos:reversal:v1:').update(value).digest();
  return {
    encode(token: { storeId: string; actorId: string; paymentId: string; input: ReversalInput; revision: string }) {
      const encoded = Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
      return `${encoded}.${sign(encoded).toString('base64url')}`;
    },
    decode(token: string) {
      const [encoded, signature, ...extra] = token.split('.');
      if (!encoded || !signature || extra.length) throw new PosError(400, 'INVALID_REQUEST');
      const provided = Buffer.from(signature, 'base64url');
      const expected = sign(encoded);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new PosError(400, 'INVALID_REQUEST');
      return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
        storeId: string; actorId: string; paymentId: string; input: ReversalInput; revision: string;
      };
    },
  };
}

type Tokens = ReturnType<typeof createReversalTokens>;

function revision(sale: Sale, day: string) {
  return fingerprint({ day, preparation: sale.lines.map(row => row.preparation), corrections: sale.corrections.map(row => row.correctionId) });
}

async function correctionDay(tx: PosTx, sale: Sale) {
  const day = await openDay(tx);
  // TODO(Q5): Confirm post-close processing day and generation, audited reopen and frozen-snapshot policy.
  if (day !== sale.businessDate) throw new PosError(409, 'DAY_CLOSED');
  return day;
}

async function memberPlan(tx: PosTx, sale: Sale, input: ReversalInput) {
  if (!sale.memberId) throw new PosError(409, 'MEMBER_REVERSAL_REQUIRED');
  if (sale.corrections.length) throw new PosError(409, 'ALREADY_REVERSED');
  if (input.kind === 'cancel' && sale.preparation !== 'accepted') throw new PosError(409, 'USE_REFUND');
  if (input.kind === 'refund' && sale.preparation === 'accepted') throw new PosError(409, 'USE_CANCEL');
  if (input.amount || input.methodAmounts ||
    (input.lines && (input.lines.length !== sale.lines.length ||
      sale.lines.some(({ line }) => !input.lines?.some(row => row.orderLineId === line.orderLineId && row.qty === line.qty))))) {
    throw new PosError(409, 'FULL_MEMBER_CORRECTION_REQUIRED');
  }
  const entries = await memberCorrectionEntries(tx, sale.memberId, sale.settlementId);
  const allocations = sale.lines.map(({ line }) => ({ allocationId: line.allocationId, qty: line.qty, amount: line.amount,
    gross: line.gross, discount: line.discount,
    cost: input.kind === 'cancel' ? negateCost(saleCost(line, line.qty)) : 0 }));
  return { entries, allocations, amount: sale.amount, remaining: sale.amount, methods: sale.splits };
}

function negateCost(cost: number | null) {
  return cost === null ? null : -cost;
}

export async function quoteReversal(tx: PosTx, tokens: Tokens, paymentId: string, input: ReversalInput) {
  const sale = await loadSale(tx, paymentId);
  const stockEffect = input.kind === 'cancel' ? 'restore' : 'keep';
  try {
    const day = await correctionDay(tx, sale);
    const write = sale.containsMemberValue ? await memberPlan(tx, sale, input) : plan(sale, input);
    return {
      quoteToken: tokens.encode({ storeId: tx.storeId, actorId: tx.actorId, paymentId: sale.paymentId ?? sale.settlementId,
        input, revision: revision(sale, day) }),
      kind: input.kind, amount: write.amount, remaining: write.remaining, methods: write.methods,
      salesEffect: stockEffect, stockEffect, couponEffect: 'keep', membershipEffect: sale.containsMemberValue ? 'restore' : 'keep',
      canSubmit: true, issues: [],
      lines: write.allocations.map((row) => {
        const { line } = sale.lines.find(({ line }) => line.allocationId === row.allocationId)!;
        return { orderLineId: line.orderLineId, menuId: line.menuId, name: line.name, qty: row.qty, amount: row.amount };
      }),
    };
  } catch (error) {
    if (!(error instanceof PosError)) throw error;
    const { reason, messageKey, details } = error.result;
    return {
      quoteToken: '', kind: input.kind, amount: 0,
      remaining: sale.containsMemberValue ? (sale.corrections.length ? 0 : sale.amount) : saleBalances(sale).remaining, methods: [],
      salesEffect: stockEffect, stockEffect, couponEffect: 'keep', membershipEffect: 'keep',
      canSubmit: false, issues: [{ reason, messageKey, details }], lines: [],
    };
  }
}

export async function correctPayment(tx: PosTx, tokens: Tokens, key: string, quoteToken: string,
  record?: { settlementId: string; terminal: TerminalRecord | null }) {
  return applyCommand(tx, 'payment.reverse', key, { quoteToken, ...record }, async () => {
    const parsed = tokens.decode(quoteToken);
    if (parsed.storeId !== tx.storeId || parsed.actorId !== tx.actorId) throw new PosError(409, 'QUOTE_CHANGED');
    const sale = await loadSale(tx, parsed.paymentId);
    if (record && record.settlementId !== sale.settlementId) throw new PosError(404, 'SETTLEMENT_NOT_FOUND');
    if (!record && sale.channel !== 'fixture') throw new PosError(400, 'RECORDING_ROUTE_REQUIRED');
    if (record && sale.channel === 'fixture') throw new PosError(409, 'FIXTURE_PAYMENT');
    requireTerminal(sale.channel ?? 'cash_record', record?.terminal ?? null);
    if (record?.terminal && sale.terminal && record.terminal.occurredAt < sale.terminal.occurredAt) {
      throw new PosError(400, 'TERMINAL_TIME_INVALID');
    }
    const day = await correctionDay(tx, sale);
    if (parsed.revision !== revision(sale, day)) throw new PosError(409, 'QUOTE_CHANGED');
    const member = sale.containsMemberValue && sale.memberId ? sale.memberId : null;
    const memberReversal = member ? await memberPlan(tx, sale, parsed.input) : null;
    const planResult = memberReversal ?? plan(sale, parsed.input);
    const correctionId = randomUUID();
    const seq = await nextBusinessSequence(tx, day);
    const { db, storeId, actorId } = tx;
    const at = record?.terminal ? new Date(record.terminal.occurredAt) : tx.at;
    const { kind } = parsed.input;
    const { allocations, amount, methods } = planResult;
    if (member && memberReversal) {
      const realAmount = methods.reduce((sum, method) => sum + method.amount, 0);
      await db.query(`INSERT INTO pos.payment_correction
        (store_id,correction_id,payment_id,business_date,created_by,kind,amount,methods,allocations,seq,at,
          member_sale_settlement_id,member_sale_amount)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [storeId, correctionId, sale.paymentId, day, actorId, kind, realAmount, JSON.stringify(methods), JSON.stringify(allocations),
        seq, at, sale.settlementId, amount]);
      await reverseMemberEntries(tx, member, sale.settlementId, correctionId, day, at, memberReversal.entries);
    } else await db.query(`
      INSERT INTO pos.payment_correction
        (store_id, correction_id, payment_id, business_date, created_by, kind, amount, methods, allocations, seq, at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [storeId, correctionId, sale.paymentId, day, actorId, kind, amount, JSON.stringify(methods), JSON.stringify(allocations), seq, at]);
    if (record?.terminal && sale.paymentId) await insertTerminal(tx, day, sale.paymentId, correctionId, record.terminal);

    const originals = new Map(sale.lines.map((row) => [row.line.allocationId, row]));
    const recognition = allocations.map((row) => ({
      ...row, id: randomUUID(), originalId: originals.get(row.allocationId)!.recognitionId,
    }));
    await db.query(`
      INSERT INTO pos.sales_recognition
        (store_id, recognition_id, settlement_id, allocation_id, business_date, amount, cost, correction_id, original_recognition_id, at)
      SELECT $1, (row->>'id')::uuid, $2, (row->>'allocationId')::uuid, $3, -(row->>'amount')::bigint,
        (row->>'cost')::bigint, $4, (row->>'originalId')::uuid, $5
      FROM jsonb_array_elements($6::jsonb) AS row
    `, [storeId, sale.settlementId, day, correctionId, at, JSON.stringify(recognition)]);

    const cancel = kind === 'cancel';
    const costDelta = nullableSum(allocations.map((row) => row.cost));
    const event: Omit<PosSaleCorrected['payload'], 'paymentId'> & {
      paymentId?: string; memberId?: string; memberVisitVoided?: boolean; memberUseRestored?: boolean;
    } = {
      billId: sale.billId, orderId: sale.orderId, ...(sale.paymentId && { paymentId: sale.paymentId }), settlementId: sale.settlementId,
      businessDate: day, lines: allocations.map((row) => eventLine(originals.get(row.allocationId)!.line, cancel ? row.qty : 0)),
      correctionId, kind, target: 'recognized_sale', usageEffect: cancel ? 'restore' : 'keep', amountDelta: -amount,
      costDelta, incompleteMarginCoverage: costDelta === null,
      ...(sale.memberId && cancel && planResult.remaining === amount && { memberVisitVoided: true }),
      ...(member && { memberId: member, memberUseRestored: true }),
    };
    await appendOutbox({ ...tx, at }, 'pos.sale_corrected.v1', correctionId, event);
    if (!record) return applied({ correctionId, paymentId: sale.paymentId }, correctionId);
    const sources = ['pos.orders', 'pos.receipts', 'pos.sales'];
    if (member) sources.push(...accountSources.filter(source => !sources.includes(source)));
    return { ...commandReceipt(correctionId, sale.corrections.length + 2, sources, correctionId),
      ...(sale.paymentId && { paymentId: sale.paymentId }), settlementId: sale.settlementId };
  });
}
