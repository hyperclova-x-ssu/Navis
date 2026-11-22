import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireOwner, type StoreParams } from '../../scope.ts';
import { businessDay } from '../11/commands.ts';
import {
  readQuery, recommendationDetail, recommendationList, reviewInsights, searchAdsReport, type NaverInsightPort,
} from './reads.ts';

export type NaverReadOptions = {
  gatewayToken: string;
  /** PN-A3 adapter (`createInsightNaver`) bound to the FAKE transport or the NAVER virtual server. */
  naver?: NaverInsightPort;
  /** Navis stores whose provider account is linked on the server (the persona binding's store). */
  linkedStores?: readonly string[];
  /** The linked Search Ads record (campaign) resolved on the server, never taken from the browser. */
  adsRecord?: string;
  now?: () => Date;
};

type Params = StoreParams & { ref?: string };
type Request = FastifyRequest<{ Params: Params }>;
const prefix = '/internal/v1/insight/stores/:storeId';

// Gateway owns the public allowlist (`/api/v1/stores/:storeId` + path). Read routes only.
export const naverInsightRoutes = [
  ['GET', '/insight/financial-center/recommendations'],
  ['GET', '/insight/financial-center/recommendations/:ref'],
  ['GET', '/insight/review-insights'],
  ['GET', '/insight/channel-reports/search-ads'],
] as const satisfies ReadonlyArray<readonly ['GET', string]>;

export function registerNaverInsightReads(app: FastifyInstance, options: NaverReadOptions) {
  const { gatewayToken, naver = {}, linkedStores = [], adsRecord, now = () => new Date() } = options;
  const linked = new Set(linkedStores);
  const onRequest = async (req: Request) => { requireOwner(req, gatewayToken); };
  const scope = (req: Request) => {
    const { storeId } = requireOwner(req, gatewayToken);
    const at = now();
    return { storeId: linked.has(storeId) ? storeId : null, at,
      businessDate: () => businessDay(at, req.headers['x-navis-store-timezone'], req.headers['x-navis-business-day-start']) };
  };
  const [list, detail, reviews, ads] = naverInsightRoutes.map(([, path]) => prefix + path);

  app.get<{ Params: Params }>(list!, { onRequest }, req => {
    readQuery(req.query, []);
    const { storeId, at } = scope(req);
    return recommendationList(naver, storeId, at);
  });
  app.get<{ Params: Params }>(detail!, { onRequest }, req => {
    readQuery(req.query, []);
    const { storeId, at } = scope(req);
    return recommendationDetail(naver, storeId, req.params.ref ?? '', at);
  });
  app.get<{ Params: Params }>(reviews!, { onRequest }, req => {
    const query = readQuery(req.query, ['unit', 'to']);
    const { storeId, at, businessDate } = scope(req);
    return reviewInsights(naver, storeId, query, businessDate(), at);
  });
  app.get<{ Params: Params }>(ads!, { onRequest }, req => {
    const query = readQuery(req.query, ['date', 'unit']);
    const { storeId, at, businessDate } = scope(req);
    return searchAdsReport(naver, storeId, adsRecord, query, businessDate(), at);
  });
}
