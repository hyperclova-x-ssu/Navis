import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { listen } from '../../infra/http.ts';
import { dbPool, readSecret } from '../../packages/db/index.ts';
import { RedisStreams } from '../../packages/streams/redis.ts';
import { createInsightApp } from './app.ts';
import { createInsightSalesConsumer } from './sales.ts';

const fileSecret = (name: string) => {
  const path = process.env[name];
  return path ? readSecret(path) : undefined;
};

const pool = dbPool('insight');
const fixtureNow = process.env.NAVIS_INSIGHT_FIXTURE_NOW;
const at = fixtureNow ? new Date(fixtureNow) : undefined;
if (at && !Number.isFinite(at.getTime())) throw new Error('Invalid Insight fixture time');
const marketingUrl = process.env.NAVIS_MARKETING_BASE_URL;
const marketingToken = fileSecret('NAVIS_INSIGHT_MARKETING_TOKEN_FILE');
if (Boolean(marketingUrl) !== Boolean(marketingToken)) throw new Error('Incomplete Insight marketing configuration');
const app = createInsightApp(pool, {
  gatewayToken: fileSecret('NAVIS_GATEWAY_INSIGHT_TOKEN_FILE'),
  forecastToken: fileSecret('NAVIS_FORECAST_INSIGHT_TOKEN_FILE'),
  promoToken: fileSecret('NAVIS_PROMO_INSIGHT_TOKEN_FILE'),
  marketing: marketingUrl && marketingToken ? { baseUrl: marketingUrl, token: marketingToken } : undefined,
  provider: process.env.NAVIS_INSIGHT_AGENT_MODE === 'fixture' ? { mode: 'fixture' } : undefined,
  cctvEnabled: process.env.NAVIS_INSIGHT_CCTV_ENABLED === '1',
  now: at ? () => at : undefined,
});
pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));

const stop = new AbortController();
const redisPassword = fileSecret('NAVIS_INSIGHT_REDIS_PASSWORD_FILE');
let consumer: Promise<void> | undefined;
let redis: RedisStreams | undefined;
if (redisPassword) {
  const client = createClient({
    url: process.env.NAVIS_REDIS_URL ?? 'redis://redis:6379', username: 'insight', password: redisPassword,
    disableOfflineQueue: true, commandOptions: { timeout: 3_000 }, socket: { connectTimeout: 2_000 },
  });
  client.on('error', () => app.log.error('Insight Streams connection unavailable'));
  await client.connect();
  redis = new RedisStreams(client);
  consumer = createInsightSalesConsumer(pool, redis, randomUUID()).run(stop.signal);
}
app.addHook('onClose', async () => {
  stop.abort();
  await consumer;
  redis?.close();
  await pool.end();
});
await listen(app);
