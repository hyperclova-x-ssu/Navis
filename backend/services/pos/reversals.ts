import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PosSaleCorrected } from '../../packages/contracts/events.ts';
import { apportion, eventLine, nullableSum, saleCost, type SaleLine } from './catalog.ts';
import { appendOutbox, applyCommand, nextBusinessSequence, openDay } from './ledger.ts';
import { applied, fingerprint, integer, object, PosError, splits, uuid, type MethodSplit, type PosTx } from './wire.ts';

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
  methods: MethodSplit[]; allocations: CorrectionLine[];
};
type Sale = {
  paymentId: string; settlementId: string; billId: string; orderId: string; orderNo: number; businessDate: string;
  storeName: string | null; at: Date; amount: number; splits: MethodSplit[];
  transactionNo: string; approvalNo: string; preparation: 'accepted' | 'preparing' | 'completed';
  lines: { line: SaleLine; recognitionId: string }[];
  corrections: Correction[];
};

export function parseReversal(value: unknown): ReversalInput {
  const input = object(value, ['kind', 'lines', 'amount', 'methodAmounts', 'restockRetail']);
  if (input.kind !== 'cancel' && input.kind !== 'refund') throw new PosError(400, 'INVALID_REQUEST');
  if (input.restockRetail !== undefined && typeof input.restockRetail !== 'boolean') throw new PosError(400, 'INVALID_REQUEST');
  if (input.restockRetail) throw new PosError(400, 'RETAIL_REQUIRED');
  const parsed: ReversalInput = { kind: input.kind };
  if (input.lines !== undefined) {
    if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 25 || input.amount !== undefined) {
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
  const { rows: header } = await db.query<Omit<Sale, 'lines' | 'corrections'>>(`
    SELECT p.payment_id AS "paymentId", p.settlement_id AS "settlementId", s.bill_id AS "billId",
      o.order_id AS "orderId", o.order_no AS "orderNo", o.business_date::text AS "businessDate", o.preparation,
      st.display_name AS "storeName", p.at, p.amount::double precision AS amount, p.splits,
      p.transaction_no AS "transactionNo", p.approval_no AS "approvalNo"
    FROM pos.payment p
    JOIN pos.settlement s USING (store_id, settlement_id)
    JOIN pos.pos_order o ON (s.store_id, s.bill_id) = (o.store_id, o.origin_bill_id)
    JOIN pos.store st ON st.store_id = p.store_id
    WHERE p.store_id = $1 AND p.payment_id = $2
  `, [storeId, paymentId]);
  if (!header[0]) throw new PosError(404, 'PAYMENT_NOT_FOUND');

  const { rows: lines } = await db.query<Sale['lines'][number]>(`
    SELECT l.snapshot AS line, r.recognition_id AS "recognitionId"
    FROM pos.settlement_line l
    JOIN pos.sales_recognition r USING (store_id, settlement_id, allocation_id)
    WHERE l.store_id = $1 AND l.settlement_id = $2 AND r.correction_id IS NULL
    ORDER BY l.allocation_id
  `, [storeId, header[0].settlementId]);
  const { rows: corrections } = await db.query<Correction>(`
    SELECT correction_id AS "correctionId", kind, at, seq, amount::double precision AS amount, methods, allocations
    FROM pos.payment_correction WHERE store_id = $1 AND payment_id = $2 ORDER BY seq
  `, [storeId, paymentId]);
  return { ...header[0], lines, corrections };
}

function saleBalances(sale: Sale) {
  const methods = sale.splits.map((split) => ({ ...split }));
  const lines = sale.lines.map(({ line }) => ({
    line, qty: line.qty, amount: line.amount, gross: line.gross, discount: line.discount,
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
  const refunded = sale.corrections.some((row) => row.kind === 'refund');
  const status = refunded ? (balance.remaining ? 'partially_refunded' : 'refunded')
    : sale.corrections.length ? (balance.remaining ? 'partially_canceled' : 'canceled') : 'paid';
  const lines = sale.lines.map(({ line }) => ({
    orderLineId: line.orderLineId, menuId: line.menuId, name: line.name, qty: line.qty,
    options: line.options, request: '', gross: line.gross, discount: line.discount, amount: line.amount,
  }));
  const gross = lines.reduce((sum, line) => sum + line.gross, 0);
  const discount = lines.reduce((sum, line) => sum + line.discount, 0);
  const currentPrepared = sale.preparation !== 'accepted';
  return {
    paymentId, settlementId: sale.settlementId, billId: sale.billId, storeName: sale.storeName,
    orderNos: [sale.orderNo], transactionNo: sale.transactionNo, approvalNo: sale.approvalNo, at: sale.at,
    amount: sale.amount, gross, discount, remaining: balance.remaining, status, splits: sale.splits, lines,
    discounts: discount ? [{ source: 'direct', amount: discount }] : [],
    member: null, cashReceipt: null, canIssueCashReceipt: false,
    sourceSnapshot: { amount: sale.amount, splits: sale.splits, lines },
    currentPrepared, wholeBillDiscount: discount > 0,
    reversalLines: balance.lines.filter((row) => row.qty > 0 && balance.remaining > 0).map(({ line, qty }) => ({
      allocationId: line.allocationId, orderLineId: line.orderLineId, menuId: line.menuId, name: line.name,
      quantity: qty, prepared: currentPrepared,
    })),
    corrections: sale.corrections.map(({ allocations: _allocations, ...correction }) => ({ ...correction, restockRetail: false })),
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
    requested.size ? requested.has(line.orderLineId) : qty > 0 || amount > 0);
  if (requested.size && selected.length !== requested.size) throw new PosError(400, 'INVALID_SELECTION');
  if (cancel && balance.lines.some(({ line }) => line.discount > 0) && requested.size
      && (selected.length !== balance.lines.filter(({ qty }) => qty > 0).length
        || selected.some(({ line, qty }) => requested.get(line.orderLineId) !== qty))) {
    throw new PosError(409, 'WHOLE_BILL_DISCOUNT');
  }
  if (input.amount !== undefined && input.amount > balance.remaining) {
    throw new PosError(409, 'REFUND_LIMIT', { remaining: balance.remaining });
  }
  const amountShares = input.amount === undefined ? undefined : apportion(input.amount,
    selected.map(({ line, amount }) => ({ id: line.orderLineId, weight: amount })));

  const allocations = selected.map((row, index): CorrectionLine => {
    const targetQty = requested.get(row.line.orderLineId) ?? row.qty;
    if (targetQty > row.qty || (requested.size && !targetQty)) throw new PosError(409, 'QTY_LIMIT');
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
  return fingerprint({ day, preparation: sale.preparation, corrections: sale.corrections.map((row) => row.correctionId) });
}

async function correctionDay(tx: PosTx, sale: Sale) {
  const day = await openDay(tx);
  // TODO(Q5): Confirm post-close processing day and generation, audited reopen and frozen-snapshot policy.
  if (day !== sale.businessDate) throw new PosError(409, 'DAY_CLOSED');
  return day;
}

export async function quoteReversal(tx: PosTx, tokens: Tokens, paymentId: string, input: ReversalInput) {
  const sale = await loadSale(tx, paymentId);
  const stockEffect = input.kind === 'cancel' ? 'restore' : 'keep';
  try {
    const day = await correctionDay(tx, sale);
    const write = plan(sale, input);
    return {
      quoteToken: tokens.encode({ storeId: tx.storeId, actorId: tx.actorId, paymentId, input, revision: revision(sale, day) }),
      kind: input.kind, amount: write.amount, remaining: write.remaining, methods: write.methods,
      salesEffect: stockEffect, stockEffect, couponEffect: 'keep', membershipEffect: 'keep', canSubmit: true, issues: [],
      lines: write.allocations.map((row) => {
        const { line } = sale.lines.find(({ line }) => line.allocationId === row.allocationId)!;
        return { orderLineId: line.orderLineId, menuId: line.menuId, name: line.name, qty: row.qty, amount: row.amount };
      }),
    };
  } catch (error) {
    if (!(error instanceof PosError)) throw error;
    const { reason, messageKey, details } = error.result;
    return {
      quoteToken: '', kind: input.kind, amount: 0, remaining: saleBalances(sale).remaining, methods: [],
      salesEffect: stockEffect, stockEffect, couponEffect: 'keep', membershipEffect: 'keep',
      canSubmit: false, issues: [{ reason, messageKey, details }], lines: [],
    };
  }
}

export async function correctPayment(tx: PosTx, tokens: Tokens, key: string, quoteToken: string) {
  return applyCommand(tx, 'payment.reverse', key, { quoteToken }, async () => {
    const parsed = tokens.decode(quoteToken);
    if (parsed.storeId !== tx.storeId || parsed.actorId !== tx.actorId) throw new PosError(409, 'QUOTE_CHANGED');
    const sale = await loadSale(tx, parsed.paymentId);
    const day = await correctionDay(tx, sale);
    if (parsed.revision !== revision(sale, day)) throw new PosError(409, 'QUOTE_CHANGED');
    const planResult = plan(sale, parsed.input);
    const correctionId = randomUUID();
    const seq = await nextBusinessSequence(tx, day);
    const { db, storeId, actorId, at } = tx;
    const { kind } = parsed.input;
    const { allocations, amount, methods } = planResult;
    await db.query(`
      INSERT INTO pos.payment_correction
        (store_id, correction_id, payment_id, business_date, created_by, kind, amount, methods, allocations, seq, at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [storeId, correctionId, sale.paymentId, day, actorId, kind, amount, JSON.stringify(methods), JSON.stringify(allocations), seq, at]);

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
    await appendOutbox<PosSaleCorrected>(tx, 'pos.sale_corrected.v1', correctionId, {
      billId: sale.billId, orderId: sale.orderId, paymentId: sale.paymentId, settlementId: sale.settlementId,
      businessDate: day, lines: allocations.map((row) => eventLine(originals.get(row.allocationId)!.line, cancel ? row.qty : 0)),
      correctionId, kind, target: 'recognized_sale', usageEffect: cancel ? 'restore' : 'keep', amountDelta: -amount,
      costDelta, incompleteMarginCoverage: costDelta === null,
    });
    return applied({ correctionId, paymentId: sale.paymentId }, correctionId);
  });
}
