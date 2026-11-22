import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PermanentStreamError, type StreamEnvelope, type StreamHandler } from '../../../../packages/streams/index.ts';
import { quoteCouponDiscount, type RedeemLine, type Terms } from './benefit.ts';
import type { PosBill, PosBillReader, SaleLink } from './clients.ts';
import { appendCouponEvents } from './commands.ts';
import { bumpRevision, effectiveStatus, findCodeByText, lockCode, lockCoupon, type CodeRow, type CouponRow, type Scope } from './records.ts';
import { conflict, confirmation, fingerprint, integer, invalid, isRecord, isUuid, missing, object, revisionAggregate, text, unavailable, uuid } from './wire.ts';

/** A held claim keeps one use of the code reserved for one open POS bill. */
const holdMs = 10 * 60_000;
type State = 'held' | 'committed' | 'released' | 'reversed';
export type Redemption = {
  redemptionId: string; codeId: string; couponId: string; actorId: string; requestKey: string; requestHash: string; commandKey: string | null;
  billId: string; customerId: string | null; discount: number; scope: { kind: 'bill' | 'line'; targetLineIds: string[] };
  terms: Terms; businessDate: string; state: State; heldAt: Date; holdUntil: Date; settlementId: string | null; orderId: string | null;
  committedAt: Date | null; releaseReason: string | null; releasedAt: Date | null; correctionId: string | null; reversedAt: Date | null;
  revision: number;
};
const columns = `redemption_id AS "redemptionId", code_id AS "codeId", coupon_id AS "couponId", actor_id AS "actorId",
  request_key AS "requestKey", request_hash AS "requestHash", command_key AS "commandKey", bill_id AS "billId",
  customer_id AS "customerId", discount, scope, terms, business_date::text AS "businessDate", state, held_at AS "heldAt",
  hold_until AS "holdUntil", settlement_id AS "settlementId", order_id AS "orderId", committed_at AS "committedAt",
  release_reason AS "releaseReason", released_at AS "releasedAt", correction_id AS "correctionId", reversed_at AS "reversedAt", revision`;
export const redemptionSources = ['coupon-status', 'marketing-performance', 'marketing-today', 'pos'] as const;

export function redemptionView(row: Redemption) {
  return {
    redemptionId: row.redemptionId, codeId: row.codeId, couponId: row.couponId, commandKey: row.commandKey, billId: row.billId,
    customerId: row.customerId, discount: row.discount, scope: row.scope, terms: row.terms, businessDate: row.businessDate,
    state: row.state, heldAt: row.heldAt.toISOString(), holdUntil: row.holdUntil.toISOString(),
    sale: row.settlementId ? { settlementId: row.settlementId, billId: row.billId, orderId: row.orderId } : null,
    committedAt: row.committedAt?.toISOString() ?? null, releaseReason: row.releaseReason, releasedAt: row.releasedAt?.toISOString() ?? null,
    correctionId: row.correctionId, reversedAt: row.reversedAt?.toISOString() ?? null, revision: row.revision,
  };
}

function parseLines(raw: unknown): RedeemLine[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) throw invalid('lines', 'LINES_REQUIRED');
  return raw.map((value, index) => {
    const line = object(value, ['lineId', 'menuId', 'gross', 'basePrice', 'options'], `lines.${index}`);
    const options = line.options === undefined ? [] : Array.isArray(line.options) && line.options.length <= 30 ? line.options : null;
    if (!options) throw invalid(`lines.${index}.options`);
    return {
      lineId: text(line.lineId, `lines.${index}.lineId`, 80, 'INVALID_REQUEST'),
      menuId: text(line.menuId, `lines.${index}.menuId`, 80, 'INVALID_REQUEST').toLowerCase(),
      gross: integer(line.gross, `lines.${index}.gross`, 0, 100_000_000),
      basePrice: integer(line.basePrice, `lines.${index}.basePrice`, 0, 100_000_000),
      options: options.map((option, optionIndex) => {
        const parsed = object(option, ['optionId', 'extraPrice'], `lines.${index}.options.${optionIndex}`);
        return { optionId: text(parsed.optionId, `lines.${index}.options.${optionIndex}.optionId`, 120, 'INVALID_REQUEST'),
          extraPrice: integer(parsed.extraPrice, `lines.${index}.options.${optionIndex}.extraPrice`, 0, 100_000_000) };
      }),
    };
  });
}

async function usage(scope: Scope, codeId: string) {
  const { rows: [row] } = await scope.db.query<{ taken: number }>(`SELECT count(*)::int AS taken FROM marketing.coupon_redemption
    WHERE store_id = $1 AND code_id = $2 AND state IN ('held', 'committed')`, [scope.storeId, codeId]);
  return row.taken;
}

/** Which terms a presented code redeems under (D-326) and why it cannot be redeemed. */
async function eligibility(scope: Scope, codeText: string, customerId: string | null) {
  const code = await findCodeByText(scope, codeText);
  if (!code) throw missing('COUPON_CODE_NOT_FOUND', 'code');
  const locked = await lockCode(scope, code.codeId);
  const coupon = await lockCoupon(scope, locked.couponId);
  const today = scope.clock.businessDate;
  const status = effectiveStatus(coupon, today);
  const issued = locked.issuedTerms;
  if (status === 'paused') throw conflict('COUPON_PAUSED', 'code');
  if (status === 'ended' && !(issued && issued.endsOn >= today)) throw conflict('COUPON_ENDED', 'code');
  if (!locked.activatedAt) throw conflict('COUPON_CODE_INACTIVE', 'code');
  if (locked.unpublishedAt && !issued) throw conflict('COUPON_CODE_INACTIVE', 'code');
  const terms: Terms = {
    benefitType: issued?.benefitType ?? coupon.benefitType, benefitValue: issued?.benefitValue ?? coupon.benefitValue,
    targetRef: issued?.targetRef ?? coupon.targetRef, endsOn: issued?.endsOn ?? coupon.endsOn,
    startsOn: coupon.startsOn, validHours: coupon.validHours,
  };
  if (locked.route === 'sms') {
    const { rowCount } = await scope.db.query(`SELECT 1 FROM marketing.coupon_target WHERE store_id = $1 AND code_id = $2 AND customer_id = $3`,
      [scope.storeId, locked.codeId, customerId]);
    if (!customerId || !rowCount) throw conflict('COUPON_MEMBER_REQUIRED', 'customerId');
  }
  const taken = await usage(scope, locked.codeId);
  if (taken >= locked.issueCount) throw conflict('COUPON_EXHAUSTED', 'code', { issueCount: locked.issueCount });
  return { code: locked, coupon, terms, remaining: locked.issueCount - taken };
}

function quote(scope: Scope, terms: Terms, lines: RedeemLine[]) {
  const outcome = quoteCouponDiscount(terms, lines, { date: scope.clock.businessDate, weekday: scope.clock.weekday,
    hour: scope.clock.hour + scope.clock.minute / 60 });
  if (!outcome.ok) throw conflict(outcome.reason, 'lines');
  const gross = lines.reduce((sum, line) => sum + line.gross, 0);
  if (outcome.amount >= gross) throw conflict('COUPON_INVALID_BENEFIT', 'lines');
  return outcome;
}

const codeInput = (value: unknown) => {
  if (typeof value !== 'string') throw invalid('code', 'COUPON_CODE_INVALID');
  const normalized = value.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{6,16}$/.test(normalized)) throw invalid('code', 'COUPON_CODE_INVALID');
  return normalized;
};

/** Read-only validation for the POS screen: no use is reserved. */
export async function quoteRedemption(scope: Scope, body: unknown) {
  const input = object(body, ['code', 'lines', 'customerId']);
  const customerId = input.customerId === undefined || input.customerId === null ? null : uuid(input.customerId, 'customerId');
  const { code, coupon, terms, remaining } = await eligibility(scope, codeInput(input.code), customerId);
  const discount = quote(scope, terms, parseLines(input.lines));
  return { codeId: code.codeId, couponId: coupon.couponId, couponName: coupon.name, route: code.route, discount: discount.amount,
    scope: { kind: discount.scope, targetLineIds: discount.targetLineIds }, terms, remaining };
}

async function lockRedemption(scope: Scope, id: string) {
  const { rows: [row] } = await scope.db.query<Redemption>(`SELECT ${columns} FROM marketing.coupon_redemption
    WHERE store_id = $1 AND redemption_id = $2 FOR UPDATE`, [scope.storeId, id]);
  if (!row) throw missing('REDEMPTION_NOT_FOUND', 'redemptionId');
  return row;
}

export async function readRedemption(scope: Scope, id: string) {
  return redemptionView(await lockRedemption(scope, uuid(id, 'redemptionId')));
}

export async function listRedemptions(scope: Scope, filter: { codeId: string | null; couponId: string | null; cursor: string | null; limit: number }) {
  const { rows } = await scope.db.query<Redemption>(`SELECT ${columns} FROM marketing.coupon_redemption
    WHERE store_id = $1 AND ($2::uuid IS NULL OR code_id = $2) AND ($3::uuid IS NULL OR coupon_id = $3)
      AND ($4::uuid IS NULL OR redemption_id > $4) ORDER BY redemption_id LIMIT $5`,
  [scope.storeId, filter.codeId, filter.couponId, filter.cursor, filter.limit + 1]);
  const items = rows.slice(0, filter.limit).map(redemptionView);
  return { items, nextCursor: rows.length > filter.limit ? items[items.length - 1].redemptionId : null };
}

type PosSale = { kind: 'sale'; sale: SaleLink } | { kind: 'bill'; bill: PosBill };

/**
 * Reserve one use of a code for an open POS bill. POS remains authoritative for the sale: the bill must already
 * carry exactly the coupon discount computed from its own quote lines, so a later payment of that bill is the use.
 */
export async function claimRedemption(scope: Scope, pos: PosBillReader | undefined, requestKey: string, body: unknown) {
  const input = object(body, ['code', 'billId', 'customerId', 'commandKey']);
  const hash = fingerprint(input);
  const { rows: [existing] } = await scope.db.query<Redemption>(`SELECT ${columns} FROM marketing.coupon_redemption
    WHERE store_id = $1 AND actor_id = $2 AND request_key = $3`, [scope.storeId, scope.actorId, requestKey]);
  if (existing) {
    if (existing.requestHash !== hash) throw conflict('IDEMPOTENCY_MISMATCH');
    return { status: 200, body: claimReceipt(existing) };
  }
  const billId = uuid(input.billId, 'billId');
  const commandKey = input.commandKey === undefined ? null : text(input.commandKey, 'commandKey', 160, 'COMMAND_KEY_INVALID');
  if (commandKey !== null && !/^[A-Za-z0-9_:.~-]{1,160}$/.test(commandKey)) throw invalid('commandKey', 'COMMAND_KEY_INVALID');
  const customerId = input.customerId === undefined || input.customerId === null ? null : uuid(input.customerId, 'customerId');
  const { code, coupon, terms } = await eligibility(scope, codeInput(input.code), customerId);
  if (!pos) throw unavailable('POS_UNAVAILABLE');
  const bill = await pos.bill(scope, billId);
  if (bill === null) throw unavailable('POS_UNAVAILABLE');
  if (bill === 'missing') throw missing('BILL_NOT_FOUND', 'billId');
  if (bill.status !== 'open') throw conflict('BILL_NOT_OPEN', 'billId', { status: bill.status });
  const discount = quote(scope, terms, bill.lines);
  if (bill.discount !== discount.amount) {
    throw conflict('BILL_DISCOUNT_MISMATCH', 'billId', { couponDiscount: discount.amount, billDiscount: bill.discount });
  }
  const { rowCount } = await scope.db.query(`SELECT 1 FROM marketing.coupon_redemption WHERE store_id = $1 AND bill_id = $2
    AND state IN ('held', 'committed')`, [scope.storeId, billId]);
  if (rowCount) throw conflict('BILL_ALREADY_HAS_COUPON', 'billId');
  const redemptionId = randomUUID();
  const holdUntil = new Date(scope.now.getTime() + holdMs);
  await scope.db.query(`INSERT INTO marketing.coupon_redemption (store_id, redemption_id, code_id, coupon_id, actor_id, request_key,
      request_hash, command_key, bill_id, customer_id, discount, scope, terms, business_date, state, held_at, hold_until, revision)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'held',$15,$16,1)`,
  [scope.storeId, redemptionId, code.codeId, coupon.couponId, scope.actorId, requestKey, hash, commandKey, billId, customerId,
    discount.amount, JSON.stringify({ kind: discount.scope, targetLineIds: discount.targetLineIds }), JSON.stringify(terms),
    scope.clock.businessDate, scope.now, holdUntil]);
  await bumpRevision(scope, 'redemptions');
  return { status: 201, body: claimReceipt(await lockRedemption(scope, redemptionId)) };
}

function claimReceipt(row: Redemption) {
  return { resourceId: row.redemptionId, revision: row.revision, receiptId: row.redemptionId, changed: true,
    affectedSources: redemptionSources, redemption: redemptionView(row) };
}

async function emitUse(scope: Scope, row: Redemption, operation: 'redeemed' | 'released' | 'reversed') {
  const { rows: [code] } = await scope.db.query<CodeRow & { used: number }>(`SELECT c.code_id AS "codeId", c.coupon_id AS "couponId",
      c.code, c.route, c.issue_count AS "issueCount",
      (SELECT count(*) FROM marketing.coupon_redemption r WHERE r.store_id = c.store_id AND r.code_id = c.code_id AND r.state = 'committed')::int AS used
    FROM marketing.coupon_code c WHERE c.store_id = $1 AND c.code_id = $2`, [scope.storeId, row.codeId]);
  await appendCouponEvents(scope, [{ type: 'marketing.coupon_code_changed.v1',
    aggregateId: revisionAggregate(row.redemptionId, row.revision),
    payload: { codeId: code.codeId, couponId: code.couponId, code: code.code, route: code.route, issueCount: code.issueCount,
      operation, redemptionId: row.redemptionId, billId: row.billId, used: code.used, discount: row.discount,
      ...(row.settlementId && { settlementId: row.settlementId }), ...(row.correctionId && { correctionId: row.correctionId }) } }]);
}

async function transition(scope: Scope, row: Redemption, state: State, fields: Partial<Record<'settlementId' | 'orderId' | 'releaseReason' | 'correctionId', string>>) {
  const revision = row.revision + 1;
  await scope.db.query(`UPDATE marketing.coupon_redemption SET state = $3, revision = $4,
      settlement_id = coalesce($5::uuid, settlement_id), order_id = coalesce($6::uuid, order_id),
      committed_at = CASE WHEN $3 = 'committed' THEN $9 ELSE committed_at END,
      release_reason = coalesce($7, release_reason), released_at = CASE WHEN $3 = 'released' THEN $9 ELSE released_at END,
      correction_id = coalesce($8::uuid, correction_id), reversed_at = CASE WHEN $3 = 'reversed' THEN $9 ELSE reversed_at END
    WHERE store_id = $1 AND redemption_id = $2`,
  [scope.storeId, row.redemptionId, state, revision, fields.settlementId ?? null, fields.orderId ?? null, fields.releaseReason ?? null,
    fields.correctionId ?? null, scope.now]);
  const next = { ...row, state, revision, settlementId: fields.settlementId ?? row.settlementId, orderId: fields.orderId ?? row.orderId,
    correctionId: fields.correctionId ?? row.correctionId };
  await emitUse(scope, next, state === 'committed' ? 'redeemed' : state === 'released' ? 'released' : 'reversed');
  await bumpRevision(scope, 'redemptions');
  return lockRedemption(scope, row.redemptionId);
}

/** Apply what POS recorded for the claimed bill. A paid bill without the coupon discount is not a use. */
export async function settle(scope: Scope, row: Redemption, outcome: PosSale) {
  const sale = outcome.kind === 'sale' ? outcome.sale : outcome.bill.status === 'paid' && outcome.bill.settlementId && outcome.bill.orderId
    ? { settlementId: outcome.bill.settlementId, billId: outcome.bill.billId, orderId: outcome.bill.orderId } : null;
  if (row.state !== 'held') {
    if (sale && row.state === 'committed' && row.settlementId !== sale.settlementId) throw conflict('POS_OUTCOME_MISMATCH');
    return row;
  }
  if (sale && sale.billId !== row.billId) throw conflict('POS_OUTCOME_MISMATCH', 'billId');
  if (outcome.kind === 'bill' && outcome.bill.status === 'paid' && outcome.bill.discount < row.discount) {
    return transition(scope, row, 'released', { releaseReason: 'rejected' });
  }
  if (sale) return transition(scope, row, 'committed', { settlementId: sale.settlementId, orderId: sale.orderId });
  if (outcome.kind === 'bill' && outcome.bill.status === 'void') return transition(scope, row, 'released', { releaseReason: 'aborted' });
  return row;
}

async function readBill(scope: Scope, pos: PosBillReader | undefined, billId: string) {
  if (!pos) throw unavailable('POS_UNAVAILABLE');
  const bill = await pos.bill(scope, billId);
  if (bill === null) throw unavailable('POS_UNAVAILABLE');
  return bill;
}

export async function reconcileRedemption(scope: Scope, pos: PosBillReader | undefined, id: string, body: unknown) {
  object(body, []);
  const row = await lockRedemption(scope, uuid(id, 'redemptionId'));
  if (row.state !== 'held') return { status: 200, body: redemptionView(row) };
  const bill = await readBill(scope, pos, row.billId);
  const settled = bill === 'missing' ? row : await settle(scope, row, { kind: 'bill', bill });
  return { status: settled.state === 'held' ? 202 : 200, body: redemptionView(settled) };
}

/** The owner removes a coupon from an unpaid bill (second confirmation). A paid bill is reconciled instead. */
export async function releaseRedemption(scope: Scope, pos: PosBillReader | undefined, id: string, body: unknown) {
  const input = object(body, ['confirmed']);
  confirmation(input.confirmed);
  const row = await lockRedemption(scope, uuid(id, 'redemptionId'));
  if (row.state === 'released') return { status: 200, body: redemptionView(row) };
  if (row.state !== 'held') throw conflict('ALREADY_REDEEMED', 'redemptionId');
  const bill = await readBill(scope, pos, row.billId);
  if (bill !== 'missing' && bill.status === 'paid') {
    const settled = await settle(scope, row, { kind: 'bill', bill });
    if (settled.state === 'committed') throw conflict('ALREADY_REDEEMED', 'redemptionId');
    return { status: 200, body: redemptionView(settled) };
  }
  const released = bill !== 'missing' && bill.status === 'void' ? await settle(scope, row, { kind: 'bill', bill })
    : await transition(scope, row, 'released', { releaseReason: 'owner_released' });
  return { status: 200, body: redemptionView(released) };
}

/* POS events. The consumer runs inside the marketing DB with the event's store scope already set. */
const invalidEvent = () => new PermanentStreamError('INVALID_COUPON_POS_EVENT');
function saleOf(event: StreamEnvelope): { storeId: string; sale: SaleLink; payload: Record<string, unknown> } {
  const { payload } = event;
  if (!isUuid(event.storeId) || event.scopeKey !== event.storeId || !isRecord(payload)) throw invalidEvent();
  const { settlementId, billId, orderId } = payload;
  if (!isUuid(settlementId) || !isUuid(billId) || !isUuid(orderId)) throw invalidEvent();
  return { storeId: event.storeId, sale: { settlementId, billId, orderId }, payload };
}
const eventScope = (db: PoolClient, storeId: string, event: StreamEnvelope): Scope => {
  const now = new Date(event.occurredAt);
  return { db, storeId, actorId: '00000000-0000-0000-0000-000000000000', now,
    clock: { date: '', time: '', weekday: 0, hour: 0, minute: 0, businessDate: '' } };
};

/** The recognized sale of a claimed bill is the use: the claim already proved the bill carries the coupon discount. */
async function recognized(db: PoolClient, event: StreamEnvelope) {
  const { storeId, sale } = saleOf(event);
  if (event.aggregateId !== sale.settlementId) throw invalidEvent();
  const scope = eventScope(db, storeId, event);
  const { rows } = await db.query<Redemption>(`SELECT ${columns} FROM marketing.coupon_redemption
    WHERE store_id = $1 AND bill_id = $2 AND state IN ('held', 'committed') FOR UPDATE`, [storeId, sale.billId]);
  for (const row of rows) {
    if (row.state === 'committed' && row.settlementId !== sale.settlementId) throw new PermanentStreamError('COUPON_POS_OUTCOME_MISMATCH');
    await settle(scope, row, { kind: 'sale', sale });
  }
}

/** A whole-bill cancel restores the coupon use (partial cancel of a coupon sale is refused by POS, I-17). */
async function corrected(db: PoolClient, event: StreamEnvelope) {
  const { storeId, sale, payload } = saleOf(event);
  if (payload.kind !== 'cancel') return;
  if (!isUuid(payload.correctionId)) throw invalidEvent();
  const scope = eventScope(db, storeId, event);
  const { rows } = await db.query<Redemption>(`SELECT ${columns} FROM marketing.coupon_redemption
    WHERE store_id = $1 AND (settlement_id = $2 OR (state = 'held' AND bill_id = $3)) AND state IN ('held', 'committed')
    ORDER BY redemption_id FOR UPDATE`, [storeId, sale.settlementId, sale.billId]);
  for (const row of rows) {
    // The cancel can arrive before the sale was reconciled: record the sale it proves, then reverse the use.
    const committed = row.state === 'held' ? await settle(scope, row, { kind: 'sale', sale }) : row;
    await transition(scope, committed, 'reversed', { correctionId: payload.correctionId });
  }
}

export const couponPosHandlers: Readonly<Record<string, StreamHandler>> = {
  'pos.sale_recognized.v1': recognized,
  'pos.sale_corrected.v1': corrected,
};

export type { CouponRow };
