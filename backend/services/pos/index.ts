import { listen } from '../../infra/http.ts';
import { dbPool, readSecret } from '../../packages/db/index.ts';
import { createPosApp } from './app.ts';

const gatewayFile = process.env.NAVIS_GATEWAY_POS_TOKEN_FILE;
const customerFile = process.env.NAVIS_CUSTOMER_POS_TOKEN_FILE;
const fixtureNow = process.env.NAVIS_POS_FIXTURE_NOW;
if ((gatewayFile || customerFile) && (!fixtureNow || !Number.isFinite(Date.parse(fixtureNow)))) {
  throw new Error('POS fixture routes require NAVIS_POS_FIXTURE_NOW');
}

const pool = dbPool('pos');
const app = createPosApp(pool, {
  gatewayToken: gatewayFile ? readSecret(gatewayFile) : undefined,
  customerToken: customerFile ? readSecret(customerFile) : undefined,
  now: () => fixtureNow ? new Date(fixtureNow) : new Date(),
});
pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));
app.addHook('onClose', async () => pool.end());
await listen(app);
