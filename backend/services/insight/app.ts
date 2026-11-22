import type { Pool } from 'pg';
import { createApp } from '../../infra/http.ts';
import { confirmProposal, confirmationSchema, type CardConfirmation, type MarketingEndpoint } from './actions.ts';
import { aggregateSchema, ingestAggregate, readCctv, type Aggregate } from './cctv.ts';
import type { NavisProvider } from './navis.ts';
import { registerB10Routes, undoObservationReceipt } from './reality/10/routes.ts';
import { registerManualsGrants } from './reality/11/routes.ts';
import { registerBriefing, type BriefingOptions } from './reality/12/routes.ts';
import { registerNaverInsightReads, type NaverReadOptions } from './reality/gap-ins/routes.ts';
import { readSales } from './sales.ts';
import { bearer, InsightError, requireOwner, requireStore, type StoreParams } from './scope.ts';
import { promoUsageSchema, recordUsage, type PromoUsage } from './usage.ts';

const root = '/internal/v1/insight';
const stores = root + '/stores/:storeId';
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const salesQuery = { type: 'object', required: ['from', 'to'], additionalProperties: false,
  properties: { from: date, to: date } };

export function createInsightApp(pool: Pool, {
  gatewayToken, promoToken, forecastToken, provider, marketing, manualsGrants, briefing, naverReads, now = () => new Date(), logging = true, cctvEnabled = true,
}: {
  gatewayToken?: string; promoToken?: string; forecastToken?: string; marketing?: MarketingEndpoint;
  manualsGrants?: Pick<Parameters<typeof registerManualsGrants>[2], 'verifyPhoto' | 'provider'>;
  briefing?: Pick<BriefingOptions, 'readers' | 'readOpenings'>;
  naverReads?: Omit<NaverReadOptions, 'gatewayToken' | 'now'>;
  provider?: NavisProvider; now?: () => Date; logging?: boolean; cctvEnabled?: boolean;
} = {}) {
  const tokens = [gatewayToken, promoToken, forecastToken].filter(Boolean);
  const credentials = marketing ? [...tokens, marketing.token] : tokens;
  if (new Set(credentials).size !== credentials.length) throw new Error('Insight workload credentials must be distinct');
  const app = createApp('insight', async () => {
    await pool.query(tokens.length || cctvEnabled ? 'SELECT 1 FROM insight.people_count_bucket LIMIT 0' : 'SELECT 1');
  }, logging);
  app.addHook('onRequest', async (_req, reply) => { reply.header('cache-control', 'no-store'); });
  app.register(async routes => {
    routes.setErrorHandler((error, req, reply) => {
      if (error instanceof InsightError) return reply.code(error.status).send({ code: error.code });
      const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return reply.code(status).send({ code: 'INVALID_REQUEST' });
      }
      req.log.error('Insight request failed');
      return reply.code(503).send({ code: 'SERVICE_UNAVAILABLE' });
    });

    if (gatewayToken) {
      registerB10Routes(routes, pool, gatewayToken, now, { registerUndo: false });
      registerManualsGrants(routes, pool, {
        ...manualsGrants, gatewayToken, now,
        undoObservation: ({ now: at, storeId, actorId, db }, id, body, query, key) =>
          undoObservationReceipt({ at, storeId, actorId, db }, id, body, query, key),
      });
      registerBriefing(routes, pool, { ...briefing, gatewayToken, now });
      registerNaverInsightReads(routes, { ...naverReads, gatewayToken, now });
      routes.get<{ Params: StoreParams }>(stores + '/briefing/cctv', async req =>
        readCctv(pool, requireOwner(req, gatewayToken).storeId));
      if (marketing) {
        routes.post<{ Params: StoreParams & { proposalId: string }; Body: CardConfirmation }>(
          stores + '/navis/proposals/:proposalId/confirm', {
            schema: { body: confirmationSchema }, onRequest: async req => { requireOwner(req, gatewayToken); },
          }, async (req, reply) => {
            const result = await confirmProposal(pool, marketing, requireOwner(req, gatewayToken), req.params.proposalId, req.body, now());
            return reply.code(202).send(result);
          });
      }
      if (provider) routes.register(async plugin => {
        const { createNavis } = await import('./navis.ts');
        const navis = createNavis(pool, provider, now, () => app.log.error('Navis persistence failed'));
        plugin.addHook('onClose', (_instance, done) => { navis.close(); done(); });
        plugin.post<{ Params: StoreParams }>(stores + '/navis/chat', {
          bodyLimit: 256 * 1024, onRequest: async req => { requireOwner(req, gatewayToken); },
        }, async (req, reply) => {
          const scope = requireOwner(req, gatewayToken);
          await navis.chat(req.raw, reply.raw, scope, req.body, () => {
            reply.hijack();
            reply.raw.setHeader('x-request-id', req.id);
          });
        });
      });
    }
    if (promoToken) routes.post<{ Params: StoreParams; Body: PromoUsage }>(stores + '/ai/usage', {
      schema: { body: promoUsageSchema }, onRequest: async req => { requireStore(req, promoToken); },
    }, async (req, reply) => {
      const duplicate = await recordUsage(pool, req.params.storeId, 'promo', req.body, req.body.stage);
      return reply.code(duplicate ? 200 : 201).send({ duplicate });
    });
    if (forecastToken) routes.get<{ Params: StoreParams; Querystring: { from: string; to: string } }>(stores + '/sales', {
      schema: { querystring: salesQuery }, onRequest: async req => { requireStore(req, forecastToken); },
    }, async req => readSales(pool, req.params.storeId, req.query.from, req.query.to));

    if (cctvEnabled) routes.post<{ Body: Aggregate }>(root + '/cctv/aggregates', {
      schema: { body: aggregateSchema }, onRequest: async req => { if (!bearer(req)) throw new InsightError(401, 'UNAUTHENTICATED'); },
    }, async (req, reply) => {
      const duplicate = await ingestAggregate(pool, bearer(req)!, req.body, now());
      return reply.code(duplicate ? 200 : 201).send({ duplicate });
    });
  });
  return app;
}
