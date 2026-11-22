import { listen } from '../infra/http.ts';
import { fileSecret, readSecret, requiredEnv } from '../packages/db/index.ts';
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

const phase3 = process.env.NAVIS_PHASE3_FIXTURES === '1';
const configuredOrigin = process.env.NAVIS_ACCOUNT_PUBLIC_ORIGIN;
// The first W5 apply provisions the ALB before Global Edge assigns the public hostname.
const origin = configuredOrigin === 'https://REPLACE_PUBLIC_HOSTNAME' ? undefined : configuredOrigin;
const hostedDemoEnabled = process.env.NAVIS_HOSTED_DEMO_AUTH === '1';
if (hostedDemoEnabled && !origin) throw new Error('Hosted demo requires a configured public origin');
const hostedDemo = hostedDemoEnabled && origin
  ? { origin, edgeProof: fileSecret('NAVIS_EDGE_DEMO_PROOF_FILE') }
  : undefined;
const marketing = phase3 || origin ? {
  marketingUrl: requiredEnv('NAVIS_MARKETING_BASE_URL'),
  marketingToken: fileSecret('NAVIS_GATEWAY_MARKETING_TOKEN_FILE'),
} : undefined;
const posUrl = process.env.NAVIS_POS_URL;
const posSecret = process.env.NAVIS_GATEWAY_POS_TOKEN_FILE;
if (Boolean(posUrl) !== Boolean(posSecret)) throw new Error('Gateway POS requires a URL and credential file');
const customerUrl = process.env.NAVIS_CUSTOMER_URL;
const customerSecret = process.env.NAVIS_GATEWAY_CUSTOMER_TOKEN_FILE;
if (customerUrl && !customerSecret) throw new Error('Gateway customer routes require a credential file');
const insightUrl = process.env.NAVIS_INSIGHT_BASE_URL;
const insightSecret = process.env.NAVIS_GATEWAY_INSIGHT_TOKEN_FILE;
if (Boolean(insightUrl) !== Boolean(insightSecret)) throw new Error('Gateway Insight requires a URL and credential file');
const insightRecords = insightUrl && insightSecret ? { url: insightUrl, token: readSecret(insightSecret) } : undefined;
const marketingRecordsUrl = process.env.NAVIS_MARKETING_BASE_URL;
const marketingRecordsFile = process.env.NAVIS_GATEWAY_MARKETING_TOKEN_FILE;
const marketingCommandFile = process.env.NAVIS_GATEWAY_MARKETING_LOCAL_COMMAND_TOKEN_FILE;
if (Boolean(marketingRecordsUrl) !== Boolean(marketingRecordsFile) || (marketingCommandFile && !marketingRecordsFile)) {
  throw new Error('Gateway Marketing requires a URL and credential file');
}
const marketingRecords = marketingRecordsUrl && marketingRecordsFile ? {
  url: marketingRecordsUrl, token: readSecret(marketingRecordsFile),
  localCommandToken: marketingCommandFile ? readSecret(marketingCommandFile) : undefined,
} : undefined;
await listen(createGateway({
  accountUrl, inventoryUrl, accountToken: readSecret(accountSecret), inventoryToken: readSecret(inventorySecret),
  accountOrigin: origin,
  pos: posUrl && posSecret ? { url: posUrl, token: readSecret(posSecret), fixture: Boolean(process.env.NAVIS_POS_FIXTURE_NOW) } : undefined,
  customer: customerUrl && customerSecret ? { url: customerUrl, token: readSecret(customerSecret) } : undefined,
  insightRecords, marketingRecords,
  hostedDemo,
  phase3: phase3 && marketing ? {
    ...marketing, insightUrl: requiredEnv('NAVIS_INSIGHT_BASE_URL'),
    insightToken: fileSecret('NAVIS_GATEWAY_INSIGHT_TOKEN_FILE'), smsToken: fileSecret('NAVIS_GATEWAY_SMS_CONFIRM_TOKEN_FILE'),
  } : undefined,
  browserApis: origin && marketing ? { ...marketing, origin, navisUrl: requiredEnv('NAVIS_INSIGHT_NAVIS_URL') } : undefined,
}));
