import { randomUUID } from 'node:crypto';
import { listen } from '../../infra/http.ts';
import { dbPool, readSecret } from '../../packages/db/index.ts';
import { connectStreams } from '../../packages/streams/index.ts';
import { createCustomerApp } from './app.ts';
import { createCustomerConsumer } from './consumer.ts';
import { createPosClient } from './pos-client.ts';

const gatewayFile = process.env.NAVIS_GATEWAY_CUSTOMER_TOKEN_FILE;
const posFile = process.env.NAVIS_CUSTOMER_POS_TOKEN_FILE;
const posOrigin = process.env.NAVIS_POS_URL;
const fixtureNow = process.env.NAVIS_CUSTOMER_FIXTURE_NOW;
if (gatewayFile && (!posFile || !posOrigin)) throw new Error('Customer claim routes require scoped POS credentials and origin');
if (fixtureNow && !Number.isFinite(Date.parse(fixtureNow))) throw new Error('Invalid NAVIS_CUSTOMER_FIXTURE_NOW');

const gatewayToken = gatewayFile ? readSecret(gatewayFile) : undefined;
const posToken = posFile ? readSecret(posFile) : undefined;
if (gatewayToken && gatewayToken === posToken) throw new Error('Customer workload credentials must be distinct');
const pos = posOrigin && posToken ? createPosClient(posOrigin, posToken) : undefined;
const consume = Boolean(process.env.NAVIS_REDIS_URL);
const pool = dbPool('customer');
const app = createCustomerApp(pool, { gatewayToken, pos, consume, now: () => fixtureNow ? new Date(fixtureNow) : new Date() });
pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));

const stop = new AbortController();
const redis = consume ? await connectStreams('customer') : undefined;
const worker = redis ? createCustomerConsumer(pool, redis, `customer-${randomUUID()}`).run(stop.signal) : undefined;
app.addHook('onClose', async () => {
  stop.abort();
  redis?.close();
  await worker;
  await pool.end();
});
await listen(app);
