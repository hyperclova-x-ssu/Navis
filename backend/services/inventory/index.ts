import { listen } from '../../infra/http.ts';
import { dbPool, readSecret } from '../../packages/db/index.ts';
import { createInventoryApp } from './app.ts';

const gatewayToken = readSecret(process.env.NAVIS_GATEWAY_INVENTORY_TOKEN_FILE ?? '/run/secrets/gateway_inventory_token');
const forecastTokenFile = process.env.NAVIS_FORECAST_INVENTORY_TOKEN_FILE;
const forecastToken = forecastTokenFile ? readSecret(forecastTokenFile) : undefined;
const fixtureTime = process.env.NAVIS_POS_FIXTURE_NOW;
const fixtureNow = fixtureTime ? new Date(fixtureTime) : undefined;
if (fixtureNow && !Number.isFinite(+fixtureNow)) throw new Error('Invalid NAVIS_POS_FIXTURE_NOW');
const pool = dbPool('inventory');
const app = createInventoryApp(pool, gatewayToken, true, fixtureNow ? () => fixtureNow : undefined, forecastToken);
pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));
app.addHook('onClose', async () => pool.end());
await listen(app);
