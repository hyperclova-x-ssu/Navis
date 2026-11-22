import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inStore } from '../../transaction.ts';
import type { CouponBenefit, PlaceCouponWrite, PromotionWrite } from '../../../../packages/naver/contracts/pn05/index.ts';
import type { NaverCouponPort, NaverCouponPorts } from './clients.ts';
import { cardApprovalLifetimeMs } from '../15/approval.ts';
import { bumpRevision, sourceRevision } from './records.ts';
import {
  choice, confirmation, conflict, CouponError, fingerprint, integer, invalid, isoDate, isRecord, object, text, uuid,
} from './wire.ts';

/**
 * PN05 NAVER Place coupons, Order promotions and named membership benefits. They are a separate class from Navis
 * codes: no menu-specific NAVER coupon, no cancel of a downloaded coupon, no revive and no seven-day bulk extension
 * (I10/I13). Each write is one owner card command recorded in `naver_coupon_action` before the provider call and
 * settled after it. A pending row requires reconciliation before another write.
 */
const operations = ['place.create', 'place.delete', 'issue.usage', 'promotion.create', 'promotion.extend', 'promotion.end'] as const;
export type NaverOperation = typeof operations[number];
type Owner = { storeId: string; actorId: string };
const destructive = (operation: NaverOperation) => operation === 'place.delete' || operation === 'promotion.end';
const cardRequired = () => new CouponError(403, 'CARD_REQUIRED');
type Action = { actionId: string; commandHash: string; state: 'pending' | 'applied' | 'failed'; result: Record<string, unknown> | null;
  errorCode: string | null; operation: NaverOperation; targetRef: string | null; request: Record<string, unknown> };
export const naverSources = ['slot-coupon', 'expiry-coupon', 'coupon-status', 'marketing-performance'] as const;
export const officialCouponScreen = 'https://help.naver.com/service/30026/contents/20833?lang=ko';

const ref = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw invalid(field, 'REF_INVALID');
  return value;
};
function couponBenefit(value: unknown): CouponBenefit {
  const { type } = object(value, ['type', 'item', 'value'], 'benefit');
  if (type === 'gift') {
    const { item } = object(value, ['type', 'item'], 'benefit');
    return { type, item: text(item, 'benefit.item', Infinity) };
  }
  const benefitType = choice(type, ['amount', 'percent'] as const, 'benefit.type');
  const input = object(value, ['type', 'value'], 'benefit');
  if (benefitType === 'amount') return { type: benefitType, value: integer(input.value, 'benefit.value', 1, Number.MAX_SAFE_INTEGER) };
  if (typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value <= 0 || input.value > 100) throw invalid('benefit.value');
  return { type: benefitType, value: input.value };
}

function placeCoupon(body: unknown): PlaceCouponWrite {
  // `menuId`/`menuIds` are deliberately not accepted: NAVER Place coupons apply to the whole booking/order product scope (I13).
  const input = object(body, ['type', 'name', 'benefit', 'audience', 'displayPeriod', 'quantity', 'conditions']);
  const audience = choice(input.audience, ['all', 'benefit-subscribers', 'marketing-message'] as const, 'audience');
  if (audience === 'marketing-message') {
    if (input.displayPeriod !== undefined) throw invalid('displayPeriod');
    if (input.quantity !== undefined) throw invalid('quantity');
  }
  const period = input.displayPeriod == null ? input.displayPeriod : object(input.displayPeriod, ['from', 'to'], 'displayPeriod');
  const displayPeriod = period == null ? period : { from: isoDate(period.from, 'displayPeriod.from'), to: isoDate(period.to, 'displayPeriod.to') };
  if (displayPeriod && displayPeriod.from > displayPeriod.to) throw invalid('displayPeriod');
  return {
    type: choice(input.type, ['place', 'booking', 'order'] as const, 'type'),
    name: text(input.name, 'name', Infinity), benefit: couponBenefit(input.benefit), audience,
    ...(displayPeriod !== undefined && { displayPeriod }),
    ...(input.quantity !== undefined && { quantity: input.quantity === null ? null : integer(input.quantity, 'quantity', 1) }),
    ...(input.conditions !== undefined && { conditions: input.conditions === null ? null : text(input.conditions, 'conditions', Infinity) }),
  };
}

function promotion(body: unknown): PromotionWrite {
  const input = object(body, ['name', 'from', 'to', 'orderAmountPerStamp', 'coupons', 'instructions']);
  if (!Array.isArray(input.coupons) || input.coupons.length < 1 || input.coupons.length > 10) throw invalid('coupons');
  const from = isoDate(input.from, 'from');
  const to = isoDate(input.to, 'to');
  if (from > to) throw invalid('to');
  return {
    name: text(input.name, 'name', 20), from, to,
    orderAmountPerStamp: integer(input.orderAmountPerStamp, 'orderAmountPerStamp', 1_000, 99_999_999),
    ...(input.instructions !== undefined && { instructions: text(input.instructions, 'instructions', 500) }),
    coupons: input.coupons.map((raw, index) => {
      const path = `coupons.${index}`;
      const coupon = object(raw, ['stampCount', 'name', 'validDays', 'canCombine', 'canUseAlone', 'instructions'], path);
      if (typeof coupon.canCombine !== 'boolean' || typeof coupon.canUseAlone !== 'boolean') throw invalid(path);
      return { stampCount: integer(coupon.stampCount, `${path}.stampCount`, 1, 10),
        name: text(coupon.name, `${path}.name`, 18), validDays: integer(coupon.validDays, `${path}.validDays`, 30, 999),
        canCombine: coupon.canCombine, canUseAlone: coupon.canUseAlone,
        ...(coupon.instructions !== undefined && { instructions: text(coupon.instructions, `${path}.instructions`, 100) }) };
    }),
  };
}

function prepare(operation: NaverOperation, target: string | undefined, body: unknown): { targetRef: string | null; request: Record<string, unknown> } {
  switch (operation) {
    case 'place.create': return { targetRef: null, request: { coupon: placeCoupon(body) } };
    case 'promotion.create': return { targetRef: null, request: { promotion: promotion(body) } };
    case 'place.delete':
    case 'promotion.end': {
      const input = object(body, ['confirmed']);
      confirmation(input.confirmed);
      return { targetRef: ref(target, 'ref'), request: { confirmed: true } };
    }
    case 'promotion.extend': {
      const input = object(body, ['endDate']);
      return { targetRef: ref(target, 'ref'), request: { endDate: isoDate(input.endDate, 'endDate') } };
    }
    case 'issue.usage': {
      const input = object(body, ['status']);
      return { targetRef: ref(target, 'ref'), request: { status: choice(input.status, ['used', 'unused'] as const, 'status') } };
    }
  }
}

async function call(port: NaverCouponPort, operation: NaverOperation, targetRef: string | null, request: Record<string, unknown>, attemptKey: string) {
  const signal = AbortSignal.timeout(8_000);
  switch (operation) {
    case 'place.create': return port.createPlaceCoupon({ coupon: request.coupon as PlaceCouponWrite, attemptKey, signal });
    case 'place.delete': return port.deletePlaceCoupon({ ref: targetRef!, attemptKey, confirmation: 'confirmed-twice', signal });
    case 'issue.usage': return port.setIssueUsage({ issueRef: targetRef!, used: request.status === 'used', attemptKey, signal });
    case 'promotion.create': return port.createOrderPromotion({ promotion: request.promotion as PromotionWrite, attemptKey, signal });
    case 'promotion.extend': return port.extendOrderPromotion({ ref: targetRef!, to: String(request.endDate), attemptKey, signal });
    case 'promotion.end': return port.endOrderPromotion({ ref: targetRef!, attemptKey, confirmation: 'confirmed-twice', signal });
  }
}

function errorCode(error: unknown) {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'PROVIDER_FAILED';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'PROVIDER_FAILED';
}
/** Provider codes that prove the call had no effect; anything else stays pending for reconciliation. */
const definiteFailures = new Set(['NOT_CONFIGURED', 'LIVE_NOT_APPROVED', 'LIVE_CONTRACT_MISSING', 'INVALID_INPUT',
  'CONFIRMATION_REQUIRED', 'REJECTED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'UNAVAILABLE']);

function receipt(action: Action) {
  const applied = action.state === 'applied';
  return {
    resourceId: action.actionId, revision: 1, receiptId: action.actionId, changed: applied,
    affectedSources: applied ? naverSources : [], source: 'naver', operation: action.operation, state: action.state,
    ...(action.targetRef && { ref: action.targetRef }), ...(action.result && { result: action.result }),
    ...(action.errorCode && { errorCode: action.errorCode }),
  };
}

export function createNaverCoupons(pool: Pool, ports: NaverCouponPorts | undefined, writeMode?: 'fake', now = () => new Date()) {
  function assertEnabled() {
    if (writeMode !== 'fake') throw cardRequired();
  }
  async function assertRevision(db: PoolClient, storeId: string, expectedRevision: number) {
    if (await sourceRevision({ db, storeId }, 'naver') !== expectedRevision) throw conflict('STALE_REVISION');
  }
  async function approve(owner: Owner, raw: unknown) {
    assertEnabled();
    portFor(owner.storeId);
    const input = object(raw, ['stage', 'operation', 'targetRef', 'expectedRevision', 'command', 'approvalId']);
    const stage = choice(input.stage, ['press', 'confirm'] as const, 'stage');
    const operation = choice(input.operation, operations, 'operation');
    if (operation.endsWith('create') && input.targetRef !== undefined) throw invalid('targetRef');
    const target = input.targetRef === undefined ? undefined : ref(input.targetRef, 'targetRef');
    const prepared = prepare(operation, target, input.command);
    const revision = integer(input.expectedRevision, 'expectedRevision');
    const commandHash = fingerprint({ operation, ...prepared });
    const { storeId, actorId } = owner;
    return inStore(pool, storeId, async db => {
      const at = now();
      await assertRevision(db, storeId, revision);
      if (stage === 'press') {
        if (input.approvalId !== undefined) throw invalid('approvalId');
        const approvalId = randomUUID();
        const expiresAt = new Date(+at + cardApprovalLifetimeMs);
        await db.query(`INSERT INTO marketing.naver_coupon_approval
          (store_id, approval_id, actor_id, revision, fingerprint, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [storeId, approvalId, actorId, revision, commandHash, expiresAt]);
        return { approvalId, expiresAt, requiresConfirmation: destructive(operation) };
      }
      if (!destructive(operation)) throw cardRequired();
      const approvalId = uuid(input.approvalId, 'approvalId');
      const { rows: [confirmed] } = await db.query<{ expiresAt: Date }>(`
        UPDATE marketing.naver_coupon_approval SET confirmed_at=COALESCE(confirmed_at, $6)
        WHERE store_id=$1 AND approval_id=$2 AND actor_id=$3 AND revision=$4 AND fingerprint=$5
          AND expires_at>$6 AND consumed_at IS NULL RETURNING expires_at AS "expiresAt"`,
      [storeId, approvalId, actorId, revision, commandHash, at]);
      if (!confirmed) throw cardRequired();
      return { approvalId, expiresAt: confirmed.expiresAt, requiresConfirmation: false };
    }, { serialize: true });
  }

  const portFor = (storeId: string) => {
    const port = ports?.(storeId);
    if (!port) throw new CouponError(503, 'NAVER_COUPONS_UNAVAILABLE', undefined, { officialUrl: officialCouponScreen });
    return port;
  };

  async function read(scope: Pick<Owner, 'storeId'>, query: Record<string, unknown>) {
    const port = portFor(scope.storeId);
    const signal = AbortSignal.timeout(6_000);
    const cursor = (name: string) => typeof query[name] === 'string' ? String(query[name]) : undefined;
    const revision = await inStore(pool, scope.storeId, db => sourceRevision({ db, storeId: scope.storeId }, 'naver'));
    try {
      const [place, promotions, membership] = await Promise.all([
        port.listPlaceCoupons({ cursor: cursor('placeCursor'), signal }),
        port.listOrderPromotions({ cursor: cursor('promotionCursor'), signal }),
        port.readMembership(signal),
      ]);
      return { placeCoupons: place, orderPromotions: promotions, membership, source: 'naver', sourceRevision: revision,
        approvalsEnabled: writeMode === 'fake', asOf: now().toISOString() };
    } catch (error) {
      if (error instanceof CouponError) throw error;
      throw new CouponError(503, 'NAVER_COUPONS_UNAVAILABLE', undefined, { officialUrl: officialCouponScreen, providerCode: errorCode(error) });
    }
  }

  async function issues(scope: Pick<Owner, 'storeId'>, couponRef: string, query: Record<string, unknown>) {
    const port = portFor(scope.storeId);
    try {
      return await port.listCouponIssues({ couponRef: ref(couponRef, 'ref'),
        couponNumber: typeof query.couponNumber === 'string' ? query.couponNumber : undefined,
        cursor: typeof query.cursor === 'string' ? query.cursor : undefined, signal: AbortSignal.timeout(6_000) });
    } catch (error) {
      if (error instanceof CouponError) throw error;
      throw new CouponError(503, 'NAVER_COUPONS_UNAVAILABLE', undefined, { officialUrl: officialCouponScreen, providerCode: errorCode(error) });
    }
  }

  /** Record the intent, call the provider outside the DB transaction, then settle the same row. */
  async function command(identity: Owner, key: string, operation: NaverOperation, target: string | undefined, body: unknown) {
    assertEnabled();
    if (!isRecord(body)) throw invalid('body');
    const { approvalId: token, expectedRevision, ...payload } = body;
    const prepared = prepare(operation, target, payload);
    if (token === undefined) throw cardRequired();
    const approvalId = uuid(token, 'approvalId');
    const revision = integer(expectedRevision, 'expectedRevision');
    const commandHash = fingerprint({ operation, ...prepared });
    const hash = fingerprint({ commandHash, approvalId, revision });
    const port = portFor(identity.storeId);
    const { storeId, actorId } = identity;
    const reservation = await inStore(pool, storeId, async db => {
      const { rows: [stored] } = await db.query<Action>(`SELECT action_id AS "actionId", command_hash AS "commandHash", state, result,
          error_code AS "errorCode", operation, target_ref AS "targetRef", request
        FROM marketing.naver_coupon_action WHERE store_id = $1 AND actor_id = $2 AND command_key = $3`,
      [storeId, actorId, key]);
      if (stored) {
        if (stored.commandHash !== hash) throw conflict('IDEMPOTENCY_MISMATCH');
        return { action: stored, fresh: false };
      }
      const at = now();
      const { rowCount } = await db.query(`UPDATE marketing.naver_coupon_approval SET consumed_at=$6
        WHERE store_id=$1 AND approval_id=$2 AND actor_id=$3 AND revision=$4 AND fingerprint=$5
          AND expires_at>$6 AND consumed_at IS NULL AND (NOT $7::boolean OR confirmed_at IS NOT NULL)`,
      [storeId, approvalId, actorId, revision, commandHash, at, destructive(operation)]);
      if (!rowCount) throw cardRequired();
      await assertRevision(db, storeId, revision);
      const pending = await db.query(`SELECT 1 FROM marketing.naver_coupon_action
        WHERE store_id=$1 AND state='pending' AND approval_id IS NOT NULL LIMIT 1`, [storeId]);
      if (pending.rowCount) throw conflict('EFFECT_PENDING_RECONCILIATION');
      const action: Action = { actionId: randomUUID(), commandHash: hash, state: 'pending', result: null, errorCode: null, operation,
        targetRef: prepared.targetRef, request: prepared.request };
      await db.query(`INSERT INTO marketing.naver_coupon_action (store_id, action_id, actor_id, command_key, command_hash, operation,
          target_ref, state, request, created_at, approval_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10)`,
      [storeId, action.actionId, actorId, key, hash, operation, prepared.targetRef, JSON.stringify(prepared.request), at, approvalId]);
      return { action, fresh: true };
    }, { serialize: true });
    const { action } = reservation;
    if (!reservation.fresh) return { status: action.state === 'pending' ? 202 : 200, body: receipt(action) };
    let settled: Pick<Action, 'state' | 'result' | 'errorCode'>;
    try {
      const result = await call(port, operation, action.targetRef, action.request, `naver-coupon:${action.actionId}`);
      settled = { state: 'applied', result: result as Record<string, unknown>, errorCode: null };
    } catch (error) {
      const code = errorCode(error);
      if (!definiteFailures.has(code)) {
        // Unknown provider outcome: keep pending for reconciliation without another provider write.
        return { status: 202, body: { ...receipt(action), state: 'pending', errorCode: code } };
      }
      settled = { state: 'failed', result: null, errorCode: code };
    }
    const final = await inStore(pool, identity.storeId, async db => {
      await db.query(`UPDATE marketing.naver_coupon_action SET state = $3, result = $4, error_code = $5, settled_at = $6
        WHERE store_id = $1 AND action_id = $2 AND state = 'pending'`,
      [identity.storeId, action.actionId, settled.state, settled.result && JSON.stringify(settled.result), settled.errorCode, now()]);
      if (settled.state === 'applied') {
        await bumpRevision({ db, storeId: identity.storeId }, 'naver');
      }
      return { ...action, ...settled };
    }, { serialize: true });
    if (final.state === 'failed') {
      return { status: 422, body: { code: 'UNPROCESSABLE', reason: 'NAVER_REJECTED', details: { providerCode: final.errorCode, actionId: final.actionId } } };
    }
    return { status: operation.endsWith('create') ? 201 : 200, body: receipt(final) };
  }

  return { read, issues, approve, command };
}
