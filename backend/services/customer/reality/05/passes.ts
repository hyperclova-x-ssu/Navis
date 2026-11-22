import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { StreamEnvelope } from '../../../../packages/streams/index.ts';
import { PermanentStreamError } from '../../../../packages/streams/index.ts';
import { isRecord, isUuid } from '../../pos-client.ts';
import { apply, event, id, integer, limit, MemberError, object, page, sourceRevision, text, type CustomerTx } from './wire.ts';

export type Product = { productId: string; name: string; kind: 'count' | 'period'; soldPrice: number;
  totalUses: number | null; validDays: number; dailyLimit: number | null; menuIds: string[]; revision: number };
const fields = `product_id AS "productId", name, kind, sold_price::double precision AS "soldPrice", total_uses AS "totalUses",
  valid_days AS "validDays", daily_limit AS "dailyLimit", menu_ids AS "menuIds", revision`;
const sources = ['members', 'memberships', 'pos.member-accounts'];

function terms(input: Record<string, unknown>) {
  const { kind } = input;
  if (kind !== 'count' && kind !== 'period') throw new MemberError(400, 'INVALID_REQUEST');
  const menuIds = input.menuIds;
  if (!Array.isArray(menuIds) || menuIds.length < 1 || menuIds.length > 100) throw new MemberError(400, 'INVALID_REQUEST');
  const menus = menuIds.map(id);
  if (new Set(menus).size !== menus.length || (kind === 'period' && input.totalUses != null)) {
    throw new MemberError(400, 'INVALID_REQUEST');
  }
  return { kind, name: text(input.name, 100), soldPrice: integer(input.soldPrice, 1, Number.MAX_SAFE_INTEGER),
    totalUses: kind === 'count' ? integer(input.totalUses, 1, 10_000) : null,
    validDays: integer(input.validDays, 1, 3660), dailyLimit: input.dailyLimit == null ? null : integer(input.dailyLimit, 1, 100),
    menuIds: menus };
}

export function createProduct(tx: CustomerTx, key: string, body: unknown) {
  const product = terms(object(body, ['name', 'kind', 'soldPrice', 'totalUses', 'validDays', 'dailyLimit', 'menuIds']));
  return apply(tx, key, 'membership.product.create', product, async () => {
    const productId = randomUUID();
    await tx.db.query(`INSERT INTO customer.membership_product
      (store_id,product_id,name,kind,sold_price,total_uses,valid_days,daily_limit,menu_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [tx.storeId, productId, product.name, product.kind, product.soldPrice, product.totalUses, product.validDays, product.dailyLimit, product.menuIds]);
    await event(tx, 'customer.member_changed.v1', productId, { productId, revision: 1 });
    return { receipt: { resourceId: productId, revision: 1, affectedSources: sources } };
  });
}

export async function readProduct(tx: CustomerTx, productId: string) {
  const { rows: [row] } = await tx.db.query<Product>(`SELECT ${fields} FROM customer.membership_product
    WHERE store_id=$1 AND product_id=$2`, [tx.storeId, productId]);
  if (!row) throw new MemberError(404, 'MEMBERSHIP_PRODUCT_NOT_FOUND');
  return row;
}

function listInput(query: unknown, extras: string[] = []) {
  const input = object(query ?? {}, ['cursor', 'limit', ...extras]);
  return { input, cursor: input.cursor === undefined ? null : id(input.cursor), take: limit(input.limit) };
}
export async function products(tx: CustomerTx, query: unknown) {
  const { cursor, take } = listInput(query);
  const { rows } = await tx.db.query<Product>(`SELECT ${fields} FROM customer.membership_product
    WHERE store_id=$1 AND ($2::uuid IS NULL OR product_id>$2) ORDER BY product_id LIMIT $3`, [tx.storeId, cursor, take + 1]);
  return page(rows, take, row => row.productId, tx, await sourceRevision(tx));
}

type Membership = { membershipId: string; memberId: string; memberCode: string; productId: string; startsOn: string; endsOn: string;
  usesLeft: number | null; status: 'active' | 'ended' | 'refunded'; terms: Product; saleSettlementId: string; revision: number };
const passFields = `p.membership_id AS "membershipId", p.member_id AS "memberId", m.member_code AS "memberCode", p.product_id AS "productId",
    starts_on::text AS "startsOn", ends_on::text AS "endsOn", CASE WHEN sold_terms->>'kind'='count' THEN uses_left END AS "usesLeft",
    CASE WHEN p.status='archived' THEN 'refunded' WHEN ends_on<$2::date THEN 'ended' ELSE 'active' END AS status,
    sold_terms AS terms, sale_settlement_id AS "saleSettlementId", version AS revision`;
const passMembers = 'FROM customer.membership p JOIN customer.member m USING (store_id,member_id)';
export async function readPass(tx: CustomerTx, membershipId: string, memberId: string, requestKey?: string) {
  const { rows: [row] } = await tx.db.query<Membership>(`SELECT ${passFields} ${passMembers}
    WHERE p.store_id=$1 AND p.membership_id=$3 AND p.member_id=$4`, [tx.storeId, tx.day, membershipId, memberId]);
  if (!row) throw new MemberError(404, 'MEMBERSHIP_NOT_FOUND');
  const { rows: [count] } = await tx.db.query<{ pending: boolean; daily: number; ownHold: boolean }>(`SELECT
    COALESCE(bool_or(state='held'),false) AS pending,
    COALESCE(bool_or(state='held' AND request_key=$4 AND operating_day=$3::date),false) AS "ownHold",
    count(*) FILTER (WHERE operating_day=$3::date AND state='committed')::int AS daily
    FROM customer.pos_claim WHERE store_id=$1 AND membership_id=$2 AND operating_day IS NOT NULL`,
  [tx.storeId, membershipId, tx.day, requestKey ?? null]);
  if (count.pending && !count.ownHold) throw new MemberError(409, 'MEMBERSHIP_CLAIM_PENDING');
  if (row.terms.dailyLimit !== null && count.daily >= row.terms.dailyLimit) throw new MemberError(409, 'MEMBERSHIP_DAILY_LIMIT');
  if (count.ownHold && row.usesLeft !== null) return { ...row, usesLeft: row.usesLeft + 1 };
  return row;
}
export async function memberships(tx: CustomerTx, query: unknown) {
  const { input, cursor, take } = listInput(query, ['memberId', 'status']);
  const memberId = input.memberId === undefined ? null : id(input.memberId);
  if (input.status !== undefined && !['active', 'ended', 'refunded'].some(value => value === input.status)) {
    throw new MemberError(400, 'INVALID_REQUEST');
  }
  const { rows } = await tx.db.query<Membership>(`SELECT * FROM (
    SELECT ${passFields} ${passMembers} WHERE p.store_id=$1
      AND ($3::uuid IS NULL OR p.member_id=$3) AND ($4::uuid IS NULL OR p.membership_id>$4)
    ) p WHERE ($5::text IS NULL OR status=$5) ORDER BY "membershipId" LIMIT $6`,
  [tx.storeId, tx.day, memberId, cursor, input.status ?? null, take + 1]);
  return page(rows, take, row => row.membershipId, tx, await sourceRevision(tx));
}

export async function uses(tx: CustomerTx, membershipId: string, query: unknown) {
  const { cursor, take } = listInput(query);
  const { rowCount } = await tx.db.query('SELECT 1 FROM customer.membership WHERE store_id=$1 AND membership_id=$2 AND member_id IS NOT NULL',
    [tx.storeId, membershipId]);
  if (!rowCount) throw new MemberError(404, 'MEMBERSHIP_NOT_FOUND');
  const { rows } = await tx.db.query<{ useId: string }>(`SELECT claim_id AS "useId", membership_id AS "membershipId",
    used_at AS "usedAt", restored_at AS "canceledAt", settlement_id AS "settlementId", bill_id AS "billId", order_id AS "orderId"
    FROM customer.pos_claim WHERE store_id=$1 AND membership_id=$2 AND state IN ('committed','restored') AND used_at IS NOT NULL
      AND ($3::uuid IS NULL OR claim_id>$3) ORDER BY claim_id LIMIT $4`, [tx.storeId, membershipId, cursor, take + 1]);
  return page(rows, take, row => row.useId, tx, await sourceRevision(tx));
}

export async function passUseSource(tx: CustomerTx, membershipId: string, useId: string) {
  const { rows: [use] } = await tx.db.query<{ settlementId: string; memberId: string }>(`SELECT
    c.settlement_id AS "settlementId", m.member_id AS "memberId"
    FROM customer.pos_claim c JOIN customer.membership m USING (store_id,membership_id)
    WHERE c.store_id=$1 AND c.membership_id=$2 AND c.claim_id=$3
      AND c.operating_day IS NOT NULL AND c.state IN ('committed','restored')`, [tx.storeId, membershipId, useId]);
  if (!use) throw new MemberError(404, 'MEMBERSHIP_USE_NOT_FOUND');
  return use;
}

export async function passMember(tx: CustomerTx, membershipId: string) {
  const { rows: [pass] } = await tx.db.query<{ memberId: string; kind: Product['kind'] }>(`SELECT member_id AS "memberId",
    sold_terms->>'kind' AS kind FROM customer.membership
    WHERE store_id=$1 AND membership_id=$2 AND member_id IS NOT NULL`, [tx.storeId, membershipId]);
  if (!pass) throw new MemberError(404, 'MEMBERSHIP_NOT_FOUND');
  return pass;
}

export async function projectFunding(db: PoolClient, envelope: StreamEnvelope) {
  const { storeId, payload, aggregateId, occurredAt } = envelope;
  if (!isRecord(payload) || !isUuid(storeId) || envelope.scopeKey !== storeId) throw new PermanentStreamError('INVALID_MEMBER_FUNDING');
  const { memberId, membershipId, productId, settlementId, businessDate, purpose, productRevision } = payload;
  if (purpose !== 'membership_sale') return;
  if (!isUuid(memberId) || !isUuid(membershipId) || !isUuid(productId) || !isUuid(settlementId) || settlementId !== aggregateId ||
    typeof businessDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(businessDate) || !Number.isInteger(productRevision)) {
    throw new PermanentStreamError('INVALID_MEMBER_FUNDING');
  }
  const tx = { db, storeId, at: new Date(occurredAt), actorId: '', day: businessDate };
  // Product terms are immutable within a version. The event only carries the source identity.
  const product = await readProduct(tx, productId);
  if (product.revision !== productRevision) throw new PermanentStreamError('MEMBERSHIP_PRODUCT_REVISION_CHANGED');
  const count = product.totalUses ?? product.validDays * (product.dailyLimit ?? 100);
  const { rowCount } = await db.query(`INSERT INTO customer.membership
    (store_id,membership_id,starts_on,ends_on,uses_total,uses_left,member_id,product_id,sale_settlement_id,sold_terms)
    VALUES ($1,$2,$3::date,$3::date+$4::int-1,$5,$5,$6,$7,$8,$9)
    ON CONFLICT (store_id,sale_settlement_id) DO NOTHING`,
  [storeId, membershipId, businessDate, product.validDays, count, memberId, productId, settlementId, product]);
  if (rowCount) await event(tx, 'customer.member_changed.v1', memberId, { memberId, membershipId, revision: 1 });
}
