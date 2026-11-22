import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { inStore } from '../../transaction.ts';
import { readChannelReports } from './channels.ts';
import { checkReachOut, groupId, groupIds, readGroupCustomers, readGroups } from './groups.ts';
import { readPerformance } from './performance.ts';
import type { ChannelReportPort, CouponLedger, TodaySources } from './ports.ts';
import { readToday } from './today.ts';
import { businessDay, clockOf, errorCode, GroupsError, isRecord, ownerGuard, type ReadScope } from './wire.ts';

export { assertReachOutRecipients, slotRegulars } from './groups.ts';
export { groupCustomerHandlers, performancePosHandlers } from './projection.ts';

export type GroupsPerformanceOptions = {
  gatewayToken: string;
  now?: () => Date;
  memberCodes?: MemberCodeReader;
  /** B14 coupon code and redemption ledger. */
  coupons?: CouponLedger;
  /** PN12 owner channel reports (PN-A3 `channelReport`), FAKE transport until A6. */
  channels?: ChannelReportPort;
  /** B14 slot/expiry candidates, B15 reply queue and B16 eligible assets. */
  today?: TodaySources;
};

type Params = { storeId: string; groupId?: string };
type Route = { Params: Params; Querystring: unknown; Body: unknown };
type Request = FastifyRequest<Route>;
const root = '/internal/v1/marketing/stores/:storeId';

type MemberCodeScope = Pick<ReadScope, 'storeId' | 'actorId'>;
type MemberCodeReader = (scope: MemberCodeScope, ids: string[]) => Promise<ReadonlyMap<string, string>>;

export function createGroupMemberCodeReader(origin: string, token: string): MemberCodeReader {
  const customer = new URL(origin);
  return async ({ storeId, actorId }, ids) => {
    const url = new URL(`/internal/v1/customer/stores/${storeId}/member-codes`, customer);
    url.searchParams.set('memberIds', ids.join(','));
    try {
      const reply = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2000),
        headers: { authorization: `Bearer ${token}`, 'x-navis-store-id': storeId,
          'x-navis-user-id': actorId, 'x-navis-store-role': 'owner' } });
      if (!reply.ok) {
        await reply.body?.cancel();
        throw new Error('Customer member codes unavailable');
      }
      const data: unknown = await reply.json();
      if (!isRecord(data) || !Array.isArray(data.items)) throw new Error('Invalid member code response');
      const allowed = new Set(ids);
      const codes = new Map<string, string>();
      for (const item of data.items) {
        if (!isRecord(item) || typeof item.memberId !== 'string' || !allowed.delete(item.memberId)
          || typeof item.memberCode !== 'string' || !/^M-[0-9]{4,19}$/.test(item.memberCode)) {
          throw new Error('Invalid member code response');
        }
        codes.set(item.memberId, item.memberCode);
      }
      return codes;
    } catch {
      throw new GroupsError(503, 'CUSTOMER_UNAVAILABLE');
    }
  };
}

/**
 * B19 read routes. Public paths are `/api/v1/stores/{storeId}/marketing{suffix}`; the gateway forwards the suffix.
 * All are owner-only reads with `cache-control: no-store`. None of them writes.
 */
export function registerGroupsPerformanceRoutes(app: FastifyInstance, pool: Pool, options: GroupsPerformanceOptions) {
  const now = options.now ?? (() => new Date());
  const guard = ownerGuard(options.gatewayToken);

  const handle = (run: (req: Request) => Promise<unknown>) => async (req: Request, reply: FastifyReply) => {
    try {
      return await run(req);
    } catch (error) {
      if (!(error instanceof GroupsError)) throw error;
      return reply.code(error.status).send({ code: errorCode(error.status), reason: error.reason,
        ...(error.field && { field: error.field }), ...(error.details && { details: error.details }) });
    }
  };
  const memberScope = (req: Request) => ({ storeId: req.params.storeId, actorId: String(req.headers['x-navis-user-id']) });
  const scoped = <T>(req: Request, read: (scope: ReadScope) => Promise<T>) => {
    const at = now();
    const clock = clockOf(req);
    const scope = memberScope(req);
    return inStore(pool, scope.storeId, db => read({ db, ...scope, at, day: businessDay(at, clock), clock }));
  };
  const get = (path: string, run: (req: Request) => Promise<unknown>) =>
    app.get<Route>(root + path, { onRequest: guard }, handle(run));

  const codesFor = (req: Request, rows: { memberId: string }[]) => {
    const ids = [...new Set(rows.map(row => row.memberId))];
    return ids.length ? options.memberCodes?.(memberScope(req), ids) : undefined;
  };
  function withCode<Row extends { memberId: string }>(row: Row, codes?: ReadonlyMap<string, string>) {
    const memberCode = codes?.get(row.memberId);
    return memberCode ? { ...row, memberCode } : row;
  }
  get('/groups', async req => {
    const groups = await scoped(req, readGroups);
    const codes = await codesFor(req, Object.values(groups.preview).flat());
    const preview = Object.fromEntries(groupIds.map(id => [id, groups.preview[id].map(row => withCode(row, codes))]));
    return { ...groups, preview };
  });
  get('/groups/:groupId/customers', async req => {
    const id = groupId(req.params.groupId);
    const page = await scoped(req, scope => readGroupCustomers(scope, id, req.query));
    const codes = await codesFor(req, page.items);
    return { ...page, items: page.items.map(row => withCode(row, codes)) };
  });
  app.post<Route>(root + '/groups/:groupId/reach-out-check', { onRequest: guard }, handle(req => {
    const id = groupId(req.params.groupId);
    return scoped(req, scope => checkReachOut(scope, id, req.body));
  }));
  get('/performance', req => scoped(req, scope => readPerformance(scope, req.query, options.coupons)));
  get('/channel-reports', async req => {
    const at = now();
    const day = businessDay(at, clockOf(req));
    return { asOf: at.toISOString(), businessDate: day,
      items: await readChannelReports(req.params.storeId, day, req.query, options.channels) };
  });
  get('/recommendations', req => scoped(req, scope => readToday(scope, options.today)));
}
