import { listen } from '../../infra/http.ts';
import { disposableReplayClock } from '../../packages/contracts/replay-clock.ts';
import { dbPool, readSecret } from '../../packages/db/index.ts';
import { createAccountApp } from './app.ts';
import { createNcpPromoStorage } from './files/ncp-storage.ts';
import { uuidPattern } from './sessions.ts';
import { loadSigningKeys } from './keys.ts';

const keyPath = process.env.NAVIS_ACCOUNT_SIGNING_KEY_FILE;
const workloadTokenPath = process.env.NAVIS_GATEWAY_ACCOUNT_TOKEN_FILE;
if (!keyPath || !workloadTokenPath) throw new Error('Account requires signing and workload secret files');
const marketingTokenPath = process.env.NAVIS_MARKETING_ACCOUNT_TOKEN_FILE;
const storageDirectory = process.env.NAVIS_ACCOUNT_PROMO_STORAGE_DIR;
const inventoryFilesTokenPath = process.env.NAVIS_INVENTORY_ACCOUNT_TOKEN_FILE;
const posReferenceTokenPath = process.env.NAVIS_POS_ACCOUNT_TOKEN_FILE;
const insightFilesTokenPath = process.env.NAVIS_INSIGHT_ACCOUNT_TOKEN_FILE;
const communityTokenFile = process.env.NAVIS_MARKETING_COMMUNITY_ACCOUNT_TOKEN_FILE;
const communityPairs: unknown = JSON.parse(process.env.NAVIS_ACCOUNT_COMMUNITY_PAIRS ?? '[]');
const isPeerPair = (value: unknown): value is [string, string] =>
  Array.isArray(value) && value.length === 2 && value.every(id => typeof id === 'string' && new RegExp(uuidPattern).test(id))
  && value[0].toLowerCase() !== value[1].toLowerCase();
if (!Array.isArray(communityPairs) || communityPairs.length > 200 || !communityPairs.every(isPeerPair)
  || (communityPairs.length > 0 && !communityTokenFile)) throw new Error('Invalid configured community peer pairs');
if (Boolean(marketingTokenPath) !== Boolean(storageDirectory)) {
  throw new Error('Local promo files require a marketing credential file and storage directory');
}

const keys = await loadSigningKeys(keyPath);
const gatewayToken = readSecret(workloadTokenPath);
const pool = dbPool('account');
const replayDemoAuth = Boolean(disposableReplayClock());
const storage = replayDemoAuth ? undefined : createNcpPromoStorage();
if (!replayDemoAuth && process.env.NAVIS_NCP_OBJECT_STORAGE_PROVIDER === 'live' && (!storage || !marketingTokenPath || !storageDirectory)) {
  throw new Error('Live Object Storage requires the mounted NCP file configuration and the promo artifact service');
}
const app = createAccountApp({
  pool, keys, gatewayToken,
  demoAuth: process.env.NAVIS_BACKEND_DEMO_AUTH,
  replayDemoAuth,
  hostedDemoAuth: process.env.NAVIS_HOSTED_DEMO_AUTH,
  publicOrigin: process.env.NAVIS_ACCOUNT_PUBLIC_ORIGIN,
  inventoryFilesToken: inventoryFilesTokenPath && readSecret(inventoryFilesTokenPath),
  posReferenceToken: posReferenceTokenPath && readSecret(posReferenceTokenPath),
  insightFilesToken: insightFilesTokenPath && readSecret(insightFilesTokenPath),
  community: communityTokenFile ? {
    token: readSecret(communityTokenFile), pairs: communityPairs.map(([left, right]) => [left.toLowerCase(), right.toLowerCase()]),
  } : undefined,
  sensStoreId: process.env.NAVIS_NCP_SENS_STORE_ID,
  promoFiles: marketingTokenPath && storageDirectory
    ? { marketingToken: readSecret(marketingTokenPath), storageDirectory, storage }
    : undefined,
});
pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));
app.addHook('onClose', async () => pool.end());
await listen(app);
