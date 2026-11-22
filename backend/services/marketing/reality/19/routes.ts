import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { inStore } from '../../transaction.ts';
import { readChannelReports } from './channels.ts';
import { checkReachOut, groupId, readGroupCustomers, readGroups } from './groups.ts';
import { readPerformance } from './performance.ts';
import type { ChannelReportPort, CouponLedger, TodaySources } from './ports.ts';
import { readToday } from './today.ts';
import { businessDay, clockOf, errorCode, GroupsError, ownerGuard, type ReadScope } from './wire.ts';

export { assertReachOutRecipients, slotRegulars } from './groups.ts';
export { groupCustomerHandlers, performancePosHandlers } from './projection.ts';

export type GroupsPerformanceOptions = {
  gatewayToken: string;
  now?: () => Date;
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
  const scoped = <T>(req: Request, read: (scope: ReadScope) => Promise<T>) => {
    const at = now();
    const clock = clockOf(req);
    const { storeId } = req.params;
    const actorId = String(req.headers['x-navis-user-id']);
    return inStore(pool, storeId, db => read({ db, storeId, actorId, at, day: businessDay(at, clock), clock }));
  };
  const get = (path: string, run: (req: Request) => Promise<unknown>) =>
    app.get<Route>(root + path, { onRequest: guard }, handle(run));

  get('/groups', req => scoped(req, readGroups));
  get('/groups/:groupId/customers', req => {
    const id = groupId(req.params.groupId);
    return scoped(req, scope => readGroupCustomers(scope, id, req.query));
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
