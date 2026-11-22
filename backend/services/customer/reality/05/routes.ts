import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { ClaimError, reserveClaim, withCustomerStore } from '../../claims.ts';
import { isUuid, type PosClient, type PrivateMemberResponse } from '../../pos-client.ts';
import { changeMember, changeNote, createMember, getMember, members, undoArchiveTarget, undoMember } from './members.ts';
import { createProduct, memberships, passMember, passUseSource, products, readPass, readProduct, uses } from './passes.ts';
import { confirm, id, integer, key, MemberError, object, type CustomerTx } from './wire.ts';

const root = '/internal/v1/customer/stores/:storeId';
type Params = { storeId: string; id?: string; noteId?: string; useId?: string };
type Request = FastifyRequest<{ Params: Params }>;
type Options = { gatewayToken: string; privateToken?: string; pos?: PosClient; now?: () => Date };
const hash = (value: string) => createHash('sha256').update(value).digest();
const seoulDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });

export function registerMemberRoutes(app: FastifyInstance, pool: Pool, { gatewayToken, privateToken, pos, now = () => new Date() }: Options) {
  if (gatewayToken === privateToken) throw new Error('Member workload credentials must be distinct');
  const edge = hash(gatewayToken);
  const workload = privateToken ? hash(privateToken) : undefined;
  const auth = (expected: Buffer, owner: boolean) => async (request: Request, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const bearer = request.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!bearer || !timingSafeEqual(expected, hash(bearer))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    const { headers, params } = request;
    if (!isUuid(headers['x-navis-store-id']) || headers['x-navis-store-id'] !== params.storeId.toLowerCase()
      || (owner && (headers['x-navis-store-role'] !== 'owner' || !isUuid(headers['x-navis-user-id'])))) {
      return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    }
  };
  function day(request: Request, at: Date) {
    const zone = request.headers['x-navis-store-timezone'];
    const boundary = request.headers['x-navis-business-day-start'];
    if (typeof zone === 'string' && typeof boundary === 'string' &&
      /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?$/.test(boundary)) {
      const [hours, minutes, seconds] = boundary.split(':').map(Number);
      return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short' })
        .format(new Date(at.getTime() - (hours * 3600 + minutes * 60 + seconds) * 1000));
    }
    return seoulDate.format(new Date(at.getTime() - 5 * 3_600_000));
  }
  const actor = (req: Request) => id(req.headers['x-navis-user-id']);
  const store = (req: Request) => id(req.params.storeId);
  const requestKey = (req: Request) => key(req.headers['idempotency-key']);
  const tx = <T>(req: Request, actorId: string, handle: (scope: CustomerTx) => Promise<T>, businessDay?: string) => {
    const at = now();
    const storeId = store(req);
    return withCustomerStore(pool, storeId, db => handle({ db, storeId, actorId, at, day: businessDay ?? day(req, at) }));
  };
  type Handler = (req: Request, reply: FastifyReply) => Promise<unknown>;
  function route(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, handler: Handler, privateRoute = false) {
    const token = privateRoute ? workload : edge;
    if (!token) return;
    app.route<{ Params: Params }>({ method, url: root + path, onRequest: auth(token, !privateRoute),
      async handler(request, reply) {
        try {
          return await handler(request, reply);
        } catch (error) {
          if (!(error instanceof MemberError || error instanceof ClaimError)) throw error;
          const { status, reason } = error;
          const code = status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT'
            : status >= 500 ? 'SERVICE_UNAVAILABLE' : 'VALIDATION';
          return reply.code(status).send({ code, reason, ...(error instanceof MemberError && { field: error.field, details: error.details }) });
        }
      },
    });
  }
  const respond = (reply: FastifyReply, result: PrivateMemberResponse | null | undefined) => {
    if (!result) throw new MemberError(503, 'POS_UNAVAILABLE');
    return reply.code(result.status).send(result.body);
  };
  route('GET', '/customers', req => tx(req, actor(req), scope => members(scope, req.query)));
  route('GET', '/customers/:id', req => tx(req, actor(req), scope => members(scope, {}, id(req.params.id))));
  route('POST', '/customers', req => tx(req, actor(req), scope => createMember(scope, requestKey(req), req.body)));
  route('PATCH', '/customers/:id', req => tx(req, actor(req), scope => changeMember(scope, requestKey(req), id(req.params.id), req.body, 'profile')));
  route('PATCH', '/customers/:id/consents', req => tx(req, actor(req), scope =>
    changeMember(scope, requestKey(req), id(req.params.id), req.body, 'consent')));
  route('DELETE', '/customers/:id', async (req, reply) => {
    const input = object(req.body, ['expectedRevision', 'confirmed']);
    confirm(input.confirmed);
    return respond(reply, await pos?.memberArchive?.(store(req), { memberId: id(req.params.id), actorId: actor(req),
      key: requestKey(req), expectedRevision: integer(input.expectedRevision), confirmed: true, businessDate: day(req, now()) }, false));
  });
  route('POST', '/members/:id/notes', req => tx(req, actor(req), scope => changeNote(scope, requestKey(req), id(req.params.id), null, req.body)));
  route('PATCH', '/members/:id/notes/:noteId', req => tx(req, actor(req), scope =>
    changeNote(scope, requestKey(req), id(req.params.id), id(req.params.noteId), req.body)));
  route('DELETE', '/members/:id/notes/:noteId', req => tx(req, actor(req), scope =>
    changeNote(scope, requestKey(req), id(req.params.id), id(req.params.noteId), req.body, true)));
  route('POST', '/members/receipts/:id/undo', async (req, reply) => {
    object(req.body ?? {}, []);
    const receiptId = id(req.params.id);
    const actorId = actor(req);
    const commandKey = requestKey(req);
    const target = await tx(req, actorId, scope => undoArchiveTarget(scope, receiptId));
    if (!target) return tx(req, actorId, scope => undoMember(scope, commandKey, receiptId, null));
    return respond(reply, await pos?.memberArchive?.(store(req), { memberId: target, actorId, key: commandKey,
      receiptId, businessDate: day(req, now()) }, true));
  });
  route('GET', '/membership-products', req => tx(req, actor(req), scope => products(scope, req.query)));
  route('POST', '/membership-products', req => tx(req, actor(req), scope => createProduct(scope, requestKey(req), req.body)));
  route('GET', '/memberships', req => tx(req, actor(req), scope => memberships(scope, req.query)));
  route('GET', '/memberships/:id/uses', req => tx(req, actor(req), scope => uses(scope, id(req.params.id), req.query)));
  route('POST', '/memberships/:id/uses', async (req, reply) => {
    const membershipId = id(req.params.id);
    const actorId = actor(req);
    const key = requestKey(req);
    const input = object(req.body ?? {}, ['billId', 'allocationId', 'quantity', 'expectedRevision']);
    if (!input.billId || !input.allocationId || input.quantity !== 1) throw new MemberError(409, 'MEMBERSHIP_POS_CONTEXT_REQUIRED');
    const billId = id(input.billId);
    const allocationId = id(input.allocationId);
    const expectedRevision = integer(input.expectedRevision);
    const source = await tx(req, actorId, scope => passMember(scope, membershipId));
    return respond(reply, await pos?.useMemberPass?.(store(req), { actorId, key, ...source, membershipId, billId, allocationId, expectedRevision }));
  });
  route('POST', '/memberships/:id/uses/:useId/cancel', async (req, reply) => {
    const membershipId = id(req.params.id);
    const useId = id(req.params.useId);
    const actorId = actor(req);
    const key = requestKey(req);
    confirm(object(req.body, ['confirmed']).confirmed);
    const source = await tx(req, actorId, scope => passUseSource(scope, membershipId, useId));
    return respond(reply, await pos?.cancelMemberUse?.(store(req), { ...source, useId, actorId, key, confirmed: true }));
  });
  route('POST', '/member-source', req => {
    const input = object(req.body, ['memberId', 'productId', 'membershipId', 'businessDate', 'requestKey']);
    const memberId = id(input.memberId);
    return tx(req, '', async scope => {
      const member = await getMember(scope, memberId);
      return { memberId, active: true, product: input.productId ? await readProduct(scope, id(input.productId)) : null,
        pass: input.membershipId ? await readPass(scope, id(input.membershipId), memberId,
          input.requestKey === undefined ? undefined : key(input.requestKey)) : null, revision: member.revision };
    }, privateDay(input.businessDate));
  }, true);
  route('POST', '/member-source/claims', req => {
    const input = object(req.body, ['actorId', 'memberId', 'membershipId', 'sourceVersion', 'requestKey', 'businessDate']);
    return tx(req, id(input.actorId), async scope => {
      const memberId = id(input.memberId);
      await getMember(scope, memberId);
      const sourceId = id(input.membershipId);
      const requestKey = key(input.requestKey);
      await readPass(scope, sourceId, memberId, requestKey);
      return reserveClaim(scope.db, scope.storeId, 'membership_use',
        { sourceId, sourceVersion: integer(input.sourceVersion), actorId: scope.actorId, requestKey, memberId }, scope.day);
    }, privateDay(input.businessDate));
  }, true);
  route('POST', '/member-archive', req => {
    const input = object(req.body, ['memberId', 'actorId', 'key', 'expectedRevision', 'confirmed', 'businessDate', 'purchasedMembershipIds']);
    const memberId = id(input.memberId);
    return tx(req, id(input.actorId), async scope => {
      await checkProjected(scope, memberId, input.purchasedMembershipIds);
      return changeMember(scope, key(input.key), memberId,
        { expectedRevision: integer(input.expectedRevision), confirmed: input.confirmed }, 'archive');
    }, privateDay(input.businessDate));
  }, true);
  route('POST', '/member-archive/undo', req => {
    const input = object(req.body, ['memberId', 'actorId', 'key', 'receiptId', 'businessDate', 'purchasedMembershipIds']);
    const memberId = id(input.memberId);
    return tx(req, id(input.actorId), async scope => {
      await checkProjected(scope, memberId, input.purchasedMembershipIds);
      return undoMember(scope, key(input.key), id(input.receiptId), memberId);
    }, privateDay(input.businessDate));
  }, true);
}

async function checkProjected(scope: CustomerTx, memberId: string, input: unknown) {
  if (!Array.isArray(input) || input.length > 1000) throw new MemberError(409, 'MEMBERSHIP_PROJECTION_PENDING');
  const ids = input.map(id);
  if (!ids.length) return;
  const { rowCount } = await scope.db.query(`SELECT 1 FROM customer.membership
    WHERE store_id=$1 AND member_id=$2 AND membership_id=ANY($3::uuid[])`, [scope.storeId, memberId, ids]);
  if (rowCount !== ids.length) throw new MemberError(409, 'MEMBERSHIP_PROJECTION_PENDING');
}

function privateDay(input: unknown) {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(input) || !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString().slice(0, 10) !== input) throw new MemberError(400, 'INVALID_REQUEST');
  return input;
}
