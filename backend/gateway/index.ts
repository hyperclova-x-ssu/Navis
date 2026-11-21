import { listen } from '../infra/http.ts';
import { readSecret } from '../packages/db/index.ts';
import { createGateway } from './app.ts';

const {
  NAVIS_ACCOUNT_URL: accountUrl,
  NAVIS_INVENTORY_URL: inventoryUrl,
  NAVIS_GATEWAY_ACCOUNT_TOKEN_FILE: accountSecret,
  NAVIS_GATEWAY_INVENTORY_TOKEN_FILE: inventorySecret,
} = process.env;

if (!accountUrl || !inventoryUrl || !accountSecret || !inventorySecret) {
  throw new Error('Gateway requires account and inventory URLs and workload secret files');
}

await listen(createGateway({
  accountUrl, inventoryUrl, accountToken: readSecret(accountSecret), inventoryToken: readSecret(inventorySecret),
}));
