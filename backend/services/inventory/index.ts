import { join } from 'node:path';
import { listen } from '../../infra/http.ts';
import { disposableReplayClock } from '../../packages/contracts/replay-clock.ts';
import { dbPool, readSecret } from '../../packages/db/index.ts';
import { bcrypt } from '../../packages/naver/commerce/bcrypt.ts';
import { createCommerceTokens } from '../../packages/naver/commerce/tokens.ts';
import { virtualSigningClock } from '../../packages/naver/config/clock.ts';
import type { NaverBinding, NaverRequestScope } from '../../packages/naver/config/index.ts';
import { createNaverTransport } from '../../packages/naver/transport/index.ts';
import { createAccountNaver, createCommerceTokenExchange } from '../account/naver/index.ts';
import { NaverError } from '../account/naver/wire.ts';
import { createInventoryApp } from './app.ts';
import { createInventoryNaver } from './naver/index.ts';
import type { VerifyMenuPhoto } from './reality/01/commands.ts';

const gatewayToken = readSecret(process.env.NAVIS_GATEWAY_INVENTORY_TOKEN_FILE ?? '/run/secrets/gateway_inventory_token');
const forecastTokenFile = process.env.NAVIS_FORECAST_INVENTORY_TOKEN_FILE;
const forecastToken = forecastTokenFile ? readSecret(forecastTokenFile) : undefined;
const fixtureTime = process.env.NAVIS_POS_FIXTURE_NOW;
const fixtureNow = fixtureTime ? new Date(fixtureTime) : undefined;
const replayNow = disposableReplayClock();
if (fixtureNow && !Number.isFinite(+fixtureNow)) throw new Error('Invalid NAVIS_POS_FIXTURE_NOW');
const pool = dbPool('inventory');
const accountBase = process.env.NAVIS_INVENTORY_ACCOUNT_URL;
const accountTokenPath = process.env.NAVIS_INVENTORY_ACCOUNT_TOKEN_FILE;
const posCatalogPath = process.env.NAVIS_POS_INVENTORY_TOKEN_FILE;
const briefingSecret = process.env.NAVIS_INSIGHT_INVENTORY_READ_TOKEN_FILE;
if (Boolean(accountBase) !== Boolean(accountTokenPath)) throw new Error('Inventory menu photos require an account URL and credential file');
const accountToken = accountTokenPath && readSecret(accountTokenPath);
const account = accountBase && new URL(accountBase);
const couponFile = process.env.NAVIS_MARKETING_INVENTORY_TOKEN_FILE;
const couponToken = couponFile && readSecret(couponFile);
if (couponToken && couponToken === accountToken) throw new Error('Inventory coupon read credential must be distinct');
const verifyPhoto: VerifyMenuPhoto | undefined = account && accountToken
  ? async ({ storeId, actorId, fileId }) => {
    const response = await fetch(new URL(`/internal/v1/account/stores/${storeId}/files/${fileId}/menu-photo-verify`, account), {
      method: 'POST', headers: { authorization: `Bearer ${accountToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ actorId }), signal: AbortSignal.timeout(1800), redirect: 'error',
    });
    await response.body?.cancel();
    if (response.status === 204) return true;
    if (response.status === 404) return false;
    throw new Error('Account photo verifier unavailable');
  } : undefined;
const {
  NAVIS_NAVER_VIRTUAL_STORE_ID: storeId, NAVIS_NAVER_VIRTUAL_ACCOUNT_ID: providerAccount,
  NAVIS_NAVER_VIRTUAL_ORIGIN: origin, NAVIS_NAVER_VIRTUAL_TOKEN_FILE: privateTokenFile,
  NAVIS_NAVER_VIRTUAL_PROVIDER_CREDENTIALS_DIR: credentialsDir,
  NAVIS_MARKETING_WORKER_INVENTORY_TOKEN_FILE: supplierTokenFile,
} = process.env;
if ((storeId || providerAccount || supplierTokenFile)
  && (!storeId || !providerAccount || !origin || !privateTokenFile || !credentialsDir)) {
  throw new Error('Incomplete Inventory NAVER virtual configuration');
}
const operations = [
  ['pn01.menu.read', 'GET', 'P', /^\/partner-assumed\/v1\/place\/menu$/],
  ['pn01.menu.update', 'PATCH', 'P', /^\/partner-assumed\/v1\/place\/menu$/],
  ['pn01.place.read', 'GET', 'O', /^\/partner-assumed\/v1\/place$/],
  ['pn01.place.update', 'PATCH', 'O', /^\/partner-assumed\/v1\/place$/],
  ['pn16.commerce.token', 'POST', 'W', /^\/external\/v1\/oauth2\/token$/],
  ['pn16.commerce.products.search', 'POST', 'W', /^\/external\/v1\/products\/search$/],
  ['pn16.commerce.products.read', 'GET', 'W', /^\/external\/v2\/products\/origin-products\/[0-9]+$/],
  ['pn16.commerce.options.update', 'PUT', 'W', /^\/external\/v1\/products\/origin-products\/[0-9]+\/option-stock$/],
] as const;

function naverTransport(binding: { storeId: string; providerAccount: string; origin: string; privateTokenFile: string }, directory: string) {
  const clock = virtualSigningClock();
  const now = () => +clock();
  const credentialFile = join(directory, 'nvirtual_inventory_commerce_id');
  const tokens = createCommerceTokens(createCommerceTokenExchange({ request: (...args) => transport.request(...args) }, async () => {
    const salt = readSecret(join(directory, 'nvirtual_inventory_commerce_salt'));
    return { clientId: readSecret(credentialFile), sign: async value => bcrypt(value, salt) };
  }, now), now);
  async function authorize(scope: NaverRequestScope) {
    const actorId = (scope.approvalScope as { actorId?: unknown } | undefined)?.actorId;
    if (typeof actorId !== 'string') throw new Error('NAVER request lacks the owner context');
    return { authorization: 'Bearer ' + await tokens.token({ storeId: scope.storeId, actorId }) };
  }
  const transport = createNaverTransport({ bindings: operations.map(([operation, method, grade, route]): NaverBinding => {
    const base = { ...binding, operation, method, grade, route, mode: 'virtual' as const, timeoutMs: 2_000 };
    return grade === 'W' && operation !== 'pn16.commerce.token' ? { ...base, credentialFile, authorize } : base;
  }) });
  return transport;
}

const commerce = storeId && providerAccount && origin && privateTokenFile && credentialsDir
  ? naverTransport({ storeId, providerAccount, origin, privateTokenFile }, credentialsDir) : undefined;
const supplierToken = supplierTokenFile && readSecret(supplierTokenFile);
if (supplierToken && supplierToken === accountToken) throw new Error('Inventory supplier credential must be distinct');
const app = createInventoryApp(pool, gatewayToken, true, replayNow ?? (fixtureNow ? () => fixtureNow : undefined), forecastToken, {
  briefingToken: briefingSecret && readSecret(briefingSecret), couponToken, verifyPhoto,
  posCatalogToken: posCatalogPath ? readSecret(posCatalogPath) : undefined,
  commerce,
  place: commerce ? {
    inventory: createInventoryNaver(commerce),
    account: createAccountNaver(commerce, async (owner, photos) => {
      if (!verifyPhoto) throw new NaverError(503, 'PHOTO_SERVICE_UNAVAILABLE');
      for (const fileId of photos) {
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(fileId)
          || !await verifyPhoto({ ...owner, fileId })) throw new NaverError(403, 'PHOTO_RIGHTS_REQUIRED');
      }
    }),
  } : undefined,
  supplier: supplierToken && storeId ? { workerToken: supplierToken, storeId } : undefined,
});
pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));
app.addHook('onClose', async () => pool.end());
await listen(app);
