import { dbPool, fileSecret, requiredEnv } from '../../../packages/db/index.ts';
import { createArtifactClient } from '../../../workers/marketing-worker/promo/clients.ts';
import { isUuid } from './contracts.ts';
import { backfillPromoJobMedia, configuredPromoMediaStorage } from './media.ts';

const storeId = process.argv[2];
const storage = configuredPromoMediaStorage();
if (!isUuid(storeId) || !storage) throw new Error('Usage: node backfill-job-media.ts <store UUID> with S3 media enabled');
const artifacts = createArtifactClient({ baseUrl: requiredEnv('NAVIS_ACCOUNT_BASE_URL'),
  token: fileSecret('NAVIS_MARKETING_ACCOUNT_TOKEN_FILE') });
const database = dbPool('marketing', 'worker');
try {
  const copied = await backfillPromoJobMedia(database, storage, artifacts, storeId);
  console.info('Promo job media copied', { copied });
} finally { await database.end(); }
