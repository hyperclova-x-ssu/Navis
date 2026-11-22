import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { inStore } from '../../transaction.ts';
import type { CouponSources, NaverCouponPorts, PosBillReader } from './clients.ts';
import { execute, type CommandName } from './commands.ts';
import { createNaverCoupons, type NaverOperation } from './naver.ts';
import { readCoupon, readCoupons, readUsage, sourceRevision, type Scope } from './records.ts';
import { claimRedemption, listRedemptions, quoteRedemption, readRedemption, reconcileRedemption, releaseRedemption } from './redemptions.ts';
import { CouponError, idempotencyKey, invalid, isoDate, isUuid, listing, object, storeClock, uuid } from './wire.ts';

export const couponRoot = '/internal/v1/marketing/stores/:storeId';
type Params = { storeId: string; id?: string; ref?: string };
type Request = FastifyRequest<{ Params: Params }>;
type Identity = { storeId: string; actorId: string; timezone: string; dayStart: string };
const digest = (value: string) => createHash('sha256').update(value).digest();

export type CouponRouteOptions = {
  gatewayToken: string;
  sources: CouponSources;
  pos?: PosBillReader;
  naver?: NaverCouponPorts;
  naverWriteMode?: 'fake';
  now?: () => Date;
};

/** Gateway-relative routes under `/api/v1/stores/:storeId/marketing` (gateway prefix `/marketing`, clock `all`). */
export const couponGatewayRoutes = [
  ['GET', '/coupons'], ['GET', '/coupons/usage'], ['GET', '/coupons/:id'], ['POST', '/coupons/slot'], ['POST', '/coupons/expiry'],
  ['PATCH', '/coupons/:id'], ['POST', '/coupons/:id/pause'], ['POST', '/coupons/:id/resume'], ['POST', '/coupons/:id/extend'],
  ['POST', '/coupons/:id/end'], ['POST', '/coupons/:id/notify-ending'], ['POST', '/coupons/receipts/:id/undo'],
  ['POST', '/coupon-codes/:id/mark-posted'], ['POST', '/coupon-codes/:id/unpublish'],
  ['POST', '/coupon-redemptions/quote'], ['POST', '/coupon-redemptions'], ['GET', '/coupon-redemptions'],
  ['GET', '/coupon-redemptions/:id'], ['POST', '/coupon-redemptions/:id/reconcile'], ['POST', '/coupon-redemptions/:id/release'],
  ['POST', '/naver-coupon-approvals'], ['GET', '/naver-coupons'], ['GET', '/naver-coupons/place/:ref/issues'], ['POST', '/naver-coupons/place'],
  ['DELETE', '/naver-coupons/place/:ref'], ['PATCH', '/naver-coupons/issues/:ref/usage'], ['POST', '/naver-coupons/promotions'],
  ['POST', '/naver-coupons/promotions/:ref/extend'], ['POST', '/naver-coupons/promotions/:ref/end'],
] as const;

export function registerCouponRoutes(app: FastifyInstance, pool: Pool, options: CouponRouteOptions) {
  const expected = digest(options.gatewayToken);
  const now = options.now ?? (() => new Date());
  const naver = createNaverCoupons(pool, options.naver, options.naverWriteMode, now);

  async function authorize(req: Request, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!bearer || !timingSafeEqual(expected, digest(bearer))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    if (!isUuid(req.params.storeId)) return reply.code(400).send(invalid('storeId').toJSON());
    const store = req.headers['x-navis-store-id'];
    if (!isUuid(store) || store.toLowerCase() !== req.params.storeId.toLowerCase() || !isUuid(req.headers['x-navis-user-id'])
      || req.headers['x-navis-store-role'] !== 'owner') return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
  }

  function identity(req: Request): Identity {
    const timezone = typeof req.headers['x-navis-store-timezone'] === 'string' ? req.headers['x-navis-store-timezone'] : 'Asia/Seoul';
    const dayStart = typeof req.headers['x-navis-business-day-start'] === 'string' ? req.headers['x-navis-business-day-start'] : '00:00';
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      throw invalid('x-navis-store-timezone');
    }
    return { storeId: req.params.storeId.toLowerCase(), actorId: String(req.headers['x-navis-user-id']).toLowerCase(), timezone, dayStart };
  }

  function requestKey(req: Request) {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !idempotencyKey.test(key)) throw invalid('Idempotency-Key', 'IDEMPOTENCY_KEY_REQUIRED');
    return key;
  }

  function scoped<T>(who: Identity, run: (scope: Scope) => Promise<T>, serialize = false) {
    const at = now();
    return inStore(pool, who.storeId, db => run({ db, storeId: who.storeId, actorId: who.actorId, now: at,
      clock: storeClock(at, who.timezone, who.dayStart), timezone: who.timezone, dayStart: who.dayStart }), { serialize });
  }

  function route(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string,
    handler: (req: Request, reply: FastifyReply, who: Identity) => Promise<unknown>) {
    app.route<{ Params: Params }>({
      method, url: couponRoot + path, exposeHeadRoute: false, onRequest: authorize, bodyLimit: 64 * 1024,
      async handler(req, reply) {
        try {
          return await handler(req, reply, identity(req));
        } catch (error) {
          if (!(error instanceof CouponError)) throw error;
          return reply.code(error.status).send(error.toJSON());
        }
      },
    });
  }

  function command(method: 'POST' | 'PATCH', path: string, name: CommandName, created = false) {
    route(method, path, async (req, reply, who) => {
      const key = requestKey(req);
      const result = await scoped(who, scope => execute({ ...scope, sources: options.sources }, key, name, req.params.id, req.body), true);
      if (created && result.changed) reply.code(201);
      return result;
    });
  }

  route('GET', '/coupons', async (req, _reply, who) => scoped(who, async scope => {
    const { input, limit, cursor } = listing(req.query, ['status', 'origin', 'lotKey', 'businessDate']);
    const page = await readCoupons(scope, { ...input, cursor, limit });
    return { ...page, asOf: scope.now.toISOString(), businessDate: scope.clock.businessDate, sourceRevision: await sourceRevision(scope, 'coupons') };
  }));
  route('GET', '/coupons/usage', async (req, _reply, who) => scoped(who, async scope => {
    const input = object(req.query, ['from', 'to'], 'query');
    const from = isoDate(input.from ?? scope.clock.businessDate.slice(0, 8) + '01', 'from');
    const to = isoDate(input.to ?? scope.clock.businessDate, 'to');
    if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw invalid('to', 'INVALID_DATE_RANGE');
    return { ...await readUsage(scope, from, to), asOf: scope.now.toISOString(),
      sourceRevision: await sourceRevision(scope, 'coupons') + await sourceRevision(scope, 'redemptions') };
  }));
  route('GET', '/coupons/:id', async (req, _reply, who) => scoped(who, scope => readCoupon(scope, uuid(req.params.id, 'couponId'))));
  command('POST', '/coupons/slot', 'slot', true);
  command('POST', '/coupons/expiry', 'expiry', true);
  command('PATCH', '/coupons/:id', 'update');
  for (const [suffix, name] of [['pause', 'pause'], ['resume', 'resume'], ['extend', 'extend'], ['end', 'end'], ['notify-ending', 'notify']] as const) {
    command('POST', `/coupons/:id/${suffix}`, name);
  }
  command('POST', '/coupons/receipts/:id/undo', 'undo');
  command('POST', '/coupon-codes/:id/mark-posted', 'markPosted');
  command('POST', '/coupon-codes/:id/unpublish', 'unpublish');

  route('POST', '/coupon-redemptions/quote', async (req, _reply, who) => scoped(who, scope => quoteRedemption(scope, req.body)));
  route('POST', '/coupon-redemptions', async (req, reply, who) => {
    const key = requestKey(req);
    const result = await scoped(who, scope => claimRedemption(scope, options.pos, key, req.body), true);
    return reply.code(result.status).send(result.body);
  });
  route('GET', '/coupon-redemptions', async (req, _reply, who) => scoped(who, async scope => {
    const { input, limit, cursor } = listing(req.query, ['codeId', 'couponId']);
    const page = await listRedemptions(scope, { limit, cursor, codeId: input.codeId === undefined ? null : uuid(input.codeId, 'codeId'),
      couponId: input.couponId === undefined ? null : uuid(input.couponId, 'couponId') });
    return { ...page, asOf: scope.now.toISOString(), sourceRevision: await sourceRevision(scope, 'redemptions') };
  }));
  route('GET', '/coupon-redemptions/:id', async (req, _reply, who) => scoped(who, scope => readRedemption(scope, req.params.id ?? '')));
  route('POST', '/coupon-redemptions/:id/reconcile', async (req, reply, who) => {
    const result = await scoped(who, scope => reconcileRedemption(scope, options.pos, req.params.id ?? '', req.body), true);
    return reply.code(result.status).send(result.body);
  });
  route('POST', '/coupon-redemptions/:id/release', async (req, reply, who) => {
    const result = await scoped(who, scope => releaseRedemption(scope, options.pos, req.params.id ?? '', req.body), true);
    return reply.code(result.status).send(result.body);
  });

  route('GET', '/naver-coupons', async (req, _reply, who) => naver.read(who,
    object(req.query, ['placeCursor', 'promotionCursor'], 'query')));
  route('GET', '/naver-coupons/place/:ref/issues', async (req, _reply, who) => naver.issues(who, req.params.ref ?? '',
    object(req.query, ['couponNumber', 'cursor'], 'query')));
  route('POST', '/naver-coupon-approvals', (req, _reply, who) => naver.approve(who, req.body));
  const naverWrite = (method: 'POST' | 'PATCH' | 'DELETE', path: string, operation: NaverOperation) => route(method, path, async (req, reply, who) => {
    const result = await naver.command(who, requestKey(req), operation, req.params.ref, req.body);
    return reply.code(result.status).send(result.body);
  });
  naverWrite('POST', '/naver-coupons/place', 'place.create');
  naverWrite('DELETE', '/naver-coupons/place/:ref', 'place.delete');
  naverWrite('PATCH', '/naver-coupons/issues/:ref/usage', 'issue.usage');
  naverWrite('POST', '/naver-coupons/promotions', 'promotion.create');
  naverWrite('POST', '/naver-coupons/promotions/:ref/extend', 'promotion.extend');
  naverWrite('POST', '/naver-coupons/promotions/:ref/end', 'promotion.end');
}
