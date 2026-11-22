import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createClient } from 'redis';
import { listen } from '../../infra/http.ts';
import { disposableReplayClock } from '../../packages/contracts/replay-clock.ts';
import { dbPool, readSecret } from '../../packages/db/index.ts';
import { virtualSigningClock } from '../../packages/naver/config/clock.ts';
import { createNaverTransport } from '../../packages/naver/transport/index.ts';
import { RedisStreams } from '../../packages/streams/redis.ts';
import { createInsightApp } from './app.ts';
import { createInsightSalesConsumer, createInsightTableConsumer } from './sales.ts';
import { InsightError, isUuid } from './scope.ts';
import { createInsightNaver, searchAdsAuthorization } from './naver/index.ts';
import { personaSources, recordSources } from './reality/12/sources.ts';

const fileSecret = (name: string) => {
  const path = process.env[name];
  return path ? readSecret(path) : undefined;
};

const fixtureNow = process.env.NAVIS_INSIGHT_FIXTURE_NOW;
if (fixtureNow && process.env.NAVIS_PHASE3_FIXTURES !== '1') {
  throw new Error('NAVIS_INSIGHT_FIXTURE_NOW requires NAVIS_PHASE3_FIXTURES=1');
}
const at = fixtureNow ? new Date(fixtureNow) : undefined;
const replayNow = disposableReplayClock();
if (at && !Number.isFinite(at.getTime())) throw new Error('Invalid Insight fixture time');
const pool = dbPool('insight');
const marketingUrl = process.env.NAVIS_MARKETING_BASE_URL;
const marketingToken = fileSecret('NAVIS_INSIGHT_MARKETING_TOKEN_FILE');
if (Boolean(marketingUrl) !== Boolean(marketingToken)) throw new Error('Incomplete Insight marketing configuration');
const accountOrigin = process.env.NAVIS_INSIGHT_ACCOUNT_URL;
const accountToken = fileSecret('NAVIS_INSIGHT_ACCOUNT_TOKEN_FILE');
if (Boolean(accountOrigin) !== Boolean(accountToken)) throw new Error('Incomplete Insight attachment verification configuration');
const account = accountOrigin && new URL(accountOrigin);
const gatewayToken = fileSecret('NAVIS_GATEWAY_INSIGHT_TOKEN_FILE');
const forecastToken = fileSecret('NAVIS_FORECAST_INSIGHT_TOKEN_FILE');
const promoToken = fileSecret('NAVIS_PROMO_INSIGHT_TOKEN_FILE');
if (accountToken && [gatewayToken, forecastToken, promoToken, marketingToken].includes(accountToken)) {
  throw new Error('Insight verification credential must be distinct');
}
const sources: Partial<Record<'customer' | 'inventory' | 'pos' | 'marketing', { url: string; token: string }>> = {};
const workloadTokens = new Set([accountToken, gatewayToken, forecastToken, promoToken, marketingToken].filter(Boolean));
for (const service of ['customer', 'inventory', 'pos', 'marketing'] as const) {
  const name = service.toUpperCase();
  const url = process.env[`NAVIS_INSIGHT_${name}_URL`];
  const token = fileSecret(`NAVIS_INSIGHT_${name}_READ_TOKEN_FILE`);
  if (Boolean(url) !== Boolean(token)) throw new Error(`Incomplete Insight ${service} read configuration`);
  if (!token || !url) continue;
  if (workloadTokens.has(token)) throw new Error('Insight source credentials must be distinct');
  workloadTokens.add(token);
  sources[service] = { url, token };
}
const {
  NAVIS_NAVER_VIRTUAL_ORIGIN: origin,
  NAVIS_NAVER_VIRTUAL_TOKEN_FILE: privateTokenFile,
  NAVIS_NAVER_VIRTUAL_STORE_ID: storeId,
  NAVIS_NAVER_VIRTUAL_ACCOUNT_ID: providerAccount,
} = process.env;
if ((storeId || providerAccount) && (!isUuid(storeId) || !providerAccount || !origin || !privateTokenFile)) {
  throw new Error('Incomplete private Insight provider configuration');
}
const adsRecord = process.env.NAVIS_INSIGHT_ADS_RECORD;
const credentialsDir = process.env.NAVIS_NAVER_VIRTUAL_PROVIDER_CREDENTIALS_DIR;
const providerNow = replayNow ?? (at ? () => at : virtualSigningClock());
if (adsRecord && (!/^[A-Za-z0-9_-]{1,100}$/.test(adsRecord) || !credentialsDir || !storeId)) {
  throw new Error('Incomplete Insight Search Ads configuration');
}
const adsBindings = adsRecord && credentialsDir ? [{
  operation: 'pn12.ads', route: /^\/stats$/, grade: 'W' as const,
  credentialFile: join(credentialsDir, 'nvirtual_ads_key'),
  authorize: (_request: unknown, key: string) => searchAdsAuthorization(
    readSecret(join(credentialsDir, 'nvirtual_ads_customer')), readSecret(join(credentialsDir, 'nvirtual_ads_id')),
    providerNow,
  )(key),
}] : [];
const naver = storeId && providerAccount && origin && privateTokenFile ? createInsightNaver(createNaverTransport({
  bindings: [
    ...[
      { operation: 'pn03.stats.read', route: /^\/partner-assumed\/v1\/review-statistics$/ },
      { operation: 'pn03.reviews.list', route: /^\/partner-assumed\/v1\/reviews$/ },
      { operation: 'pn08.smartcall.calls', route: /^\/partner-assumed\/v1\/smartcall\/calls$/ },
      { operation: 'pn09.financial-center.list', route: /^\/partner-assumed\/v1\/financial-center\/recommendations$/ },
      { operation: 'pn09.financial-center.read', route: /^\/partner-assumed\/v1\/financial-center\/recommendations\/[A-Za-z0-9_-]{1,64}$/ },
    ].map(binding => ({ ...binding, grade: 'O' as const })),
    ...adsBindings,
  ].map(binding => ({ ...binding, storeId, providerAccount, origin, privateTokenFile,
    mode: 'virtual', method: 'GET', timeoutMs: 2_000 })),
})) : undefined;
const app = createInsightApp(pool, {
  gatewayToken, forecastToken, promoToken,
  briefing: { readers: { ...recordSources(sources), ...personaSources(naver ?? {}) } },
  naverReads: naver && storeId ? { naver, linkedStores: [storeId], adsRecord } : undefined,
  manualsGrants: account && accountToken ? {
    async verifyPhoto({ storeId, actorId }, fileId) {
      const url = new URL(`/internal/v1/account/stores/${storeId}/files/${fileId}/manual-evidence-verify`, account);
      const response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2_000),
        headers: { authorization: `Bearer ${accountToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ actorId }),
      });
      await response.body?.cancel();
      if (response.status === 204) return true;
      if (response.status === 404) return false;
      throw new InsightError(503, 'FILE_VERIFICATION_UNAVAILABLE');
    },
  } : undefined,
  marketing: marketingUrl && marketingToken ? { baseUrl: marketingUrl, token: marketingToken } : undefined,
  provider: process.env.NAVIS_INSIGHT_AGENT_MODE === 'fixture' ? { mode: 'fixture' } : undefined,
  cctvEnabled: process.env.NAVIS_INSIGHT_CCTV_ENABLED === '1',
  now: replayNow ?? (at ? () => at : undefined),
});
pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));

const stop = new AbortController();
const redisPassword = fileSecret('NAVIS_INSIGHT_REDIS_PASSWORD_FILE');
let consumers: Promise<void>[] = [];
let redis: RedisStreams | undefined;
if (redisPassword) {
  const client = createClient({
    url: process.env.NAVIS_REDIS_URL ?? 'redis://redis:6379', username: 'insight', password: redisPassword,
    disableOfflineQueue: true, commandOptions: { timeout: 3_000 }, socket: { connectTimeout: 2_000 },
  });
  client.on('error', () => app.log.error('Insight Streams connection unavailable'));
  await client.connect();
  redis = new RedisStreams(client);
  consumers = [
    createInsightSalesConsumer(pool, redis, randomUUID()),
    createInsightTableConsumer(pool, redis, randomUUID()),
  ].map(consumer => consumer.run(stop.signal));
}
app.addHook('onClose', async () => {
  stop.abort();
  await Promise.all(consumers);
  redis?.close();
  await pool.end();
});
await listen(app);
