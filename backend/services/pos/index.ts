import { listen } from '../../infra/http.ts';
import { disposableReplayClock } from '../../packages/contracts/replay-clock.ts';
import { dbPool, readSecret } from '../../packages/db/index.ts';
import { createPosApp } from './app.ts';
import { posNaverFromEnv } from './reality/02/naver/runtime.ts';
import { createCustomerMemberClient } from './reality/05/customer-client.ts';
import { createCustomReferenceVerifier } from './reality/08/input.ts';
import { createTaxEvidenceVerifier } from './reality/18/evidence-client.ts';

const gatewayFile = process.env.NAVIS_GATEWAY_POS_TOKEN_FILE;
const customerFile = process.env.NAVIS_CUSTOMER_POS_TOKEN_FILE;
const fixtureNow = process.env.NAVIS_POS_FIXTURE_NOW;
const replayNow = disposableReplayClock();
if (fixtureNow && !Number.isFinite(Date.parse(fixtureNow))) throw new Error('Invalid NAVIS_POS_FIXTURE_NOW');
const inventoryBase = process.env.NAVIS_POS_INVENTORY_URL;
const inventoryFile = process.env.NAVIS_POS_INVENTORY_TOKEN_FILE;
if (Boolean(inventoryBase) !== Boolean(inventoryFile)) throw new Error('POS catalog requires an inventory URL and credential file');
const inventory = inventoryBase && new URL(inventoryBase);
const inventoryToken = inventoryFile && readSecret(inventoryFile);
const customerBase = process.env.NAVIS_CUSTOMER_URL;
const memberFile = process.env.NAVIS_POS_CUSTOMER_TOKEN_FILE;
if (Boolean(customerBase) !== Boolean(memberFile)) throw new Error('POS member routes require a customer URL and credential file');
const gatewayToken = gatewayFile ? readSecret(gatewayFile) : undefined;
const customerToken = customerFile ? readSecret(customerFile) : undefined;
const memberToken = memberFile && readSecret(memberFile);
if (memberToken && (memberToken === gatewayToken || memberToken === customerToken || memberToken === inventoryToken)) {
  throw new Error('POS member workload credential must be distinct');
}
const accountOrigin = process.env.NAVIS_POS_ACCOUNT_URL;
const accountTokenFile = process.env.NAVIS_POS_ACCOUNT_TOKEN_FILE;
if (Boolean(accountOrigin) !== Boolean(accountTokenFile)) throw new Error('POS reference files require an account URL and credential file');
const accountToken = accountTokenFile && readSecret(accountTokenFile);
if (accountToken && [gatewayToken, customerToken, inventoryToken, memberToken].includes(accountToken)) {
  throw new Error('POS reference workload credential must be distinct');
}
const briefingSecret = process.env.NAVIS_INSIGHT_POS_READ_TOKEN_FILE;
const briefingToken = briefingSecret && readSecret(briefingSecret);
if (briefingToken && [accountToken, inventoryToken, memberToken].includes(briefingToken)) {
  throw new Error('POS briefing workload credential must be distinct');
}
const couponFile = process.env.NAVIS_MARKETING_POS_TOKEN_FILE;
const couponToken = couponFile && readSecret(couponFile);
if (couponToken && [accountToken, inventoryToken, memberToken].includes(couponToken)) {
  throw new Error('POS coupon read credential must be distinct');
}

const pool = dbPool('pos');
const app = createPosApp(pool, {
  gatewayToken, customerToken, briefingToken, couponToken,
  naverOrders: posNaverFromEnv(),
  memberCustomer: customerBase && memberToken ? createCustomerMemberClient(customerBase, memberToken) : undefined,
  verifyReference: accountOrigin && accountToken ? createCustomReferenceVerifier(accountOrigin, accountToken) : undefined,
  verifyTaxEvidence: accountOrigin && accountToken ? createTaxEvidenceVerifier(accountOrigin, accountToken) : undefined,
  now: replayNow ?? (() => fixtureNow ? new Date(fixtureNow) : new Date()),
  operating: !fixtureNow,
  readCatalog: inventory && inventoryToken ? async ({ storeId, actorId, menuIds }) => {
    const url = new URL(`/internal/v1/inventory/stores/${storeId}/catalog-snapshot`, inventory);
    for (const id of menuIds) url.searchParams.append('menuId', id);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${inventoryToken}`, 'x-navis-store-id': storeId, 'x-navis-user-id': actorId, 'x-navis-store-role': 'owner' },
      signal: AbortSignal.timeout(2_500), redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Inventory catalog lookup failed');
    }
    return response.json();
  } : undefined,
  readReceiptStatus: inventory && inventoryToken ? async ({ storeId, actorId, receiptId }) => {
    const url = new URL(`/internal/v1/inventory/stores/${storeId}/purchase-receipt-status/${receiptId}`, inventory);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${inventoryToken}`, 'x-navis-store-id': storeId, 'x-navis-user-id': actorId, 'x-navis-store-role': 'owner' },
      signal: AbortSignal.timeout(2_500), redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Inventory receipt status lookup failed');
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('status' in payload)
      || (payload.status !== 'pending' && payload.status !== 'active' && payload.status !== 'voided')) {
      throw new Error('Inventory receipt status is invalid');
    }
    return { status: payload.status };
  } : undefined,
});
pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));
app.addHook('onClose', async () => pool.end());
await listen(app);
