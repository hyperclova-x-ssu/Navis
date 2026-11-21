import { listen } from '../../infra/http.ts';
import { dbPool, readSecret } from '../../packages/db/index.ts';
import { createAccountApp } from './app.ts';
import { loadSigningKeys } from './keys.ts';

const keyPath = process.env.NAVIS_ACCOUNT_SIGNING_KEY_FILE;
const workloadTokenPath = process.env.NAVIS_GATEWAY_ACCOUNT_TOKEN_FILE;
if (!keyPath || !workloadTokenPath) throw new Error('Account requires signing and workload secret files');
const marketingTokenPath = process.env.NAVIS_MARKETING_ACCOUNT_TOKEN_FILE;
const storageDirectory = process.env.NAVIS_ACCOUNT_PROMO_STORAGE_DIR;
if (Boolean(marketingTokenPath) !== Boolean(storageDirectory)) {
  throw new Error('Local promo files require a marketing credential file and storage directory');
}

const keys = await loadSigningKeys(keyPath);
const gatewayToken = readSecret(workloadTokenPath);
const pool = dbPool('account');
const app = createAccountApp({
  pool, keys, gatewayToken,
  demoAuth: process.env.NAVIS_BACKEND_DEMO_AUTH,
  publicOrigin: process.env.NAVIS_ACCOUNT_PUBLIC_ORIGIN,
  promoFiles: marketingTokenPath && storageDirectory
    ? { marketingToken: readSecret(marketingTokenPath), storageDirectory }
    : undefined,
});
pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));
app.addHook('onClose', async () => pool.end());
await listen(app);
