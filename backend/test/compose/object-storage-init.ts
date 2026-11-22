import { setTimeout } from 'node:timers/promises';
import { fileSecret, requiredEnv } from '../../packages/db/index.ts';
import { createObjectStorageSigner } from '../../packages/object-storage/sign.ts';

const origin = new URL(requiredEnv('NAVIS_OBJECT_STORAGE_ENDPOINT'));
if (origin.href !== 'http://minio:9000/') throw new Error('The test bucket initializer requires the Compose MinIO service');
const region = requiredEnv('NAVIS_OBJECT_STORAGE_REGION');
const bucket = requiredEnv('NAVIS_OBJECT_STORAGE_BUCKET');
if (!/^[a-z0-9-]{3,63}$/.test(bucket) || !/^[a-z0-9-]{2,32}$/.test(region)) throw new Error('Invalid test bucket configuration');
const sign = createObjectStorageSigner(fileSecret('NAVIS_OBJECT_STORAGE_ACCESS_KEY_FILE'), () => new Date(), region);
const secret = fileSecret('NAVIS_OBJECT_STORAGE_SECRET_KEY_FILE');
const url = new URL(`/${bucket}`, origin);

async function request(method: string, body?: Buffer) {
  const headers = new Headers(body ? { 'content-type': 'application/xml' } : {});
  new Headers(sign({ method, url, headers, body }, secret)).forEach((value, name) => headers.set(name, value));
  const response = await fetch(url, { method, headers, body: body && new Uint8Array(body), redirect: 'error', signal: AbortSignal.timeout(4_000) });
  await response.body?.cancel();
  return response.status;
}

let ready = false;
for (let attempt = 0; attempt < 60 && !ready; attempt++) {
  const response = await fetch(new URL('/minio/health/ready', origin), { signal: AbortSignal.timeout(1000), redirect: 'error' }).catch(() => null);
  ready = Boolean(response?.ok);
  await response?.body?.cancel();
  if (!ready) await setTimeout(500);
}
if (!ready) throw new Error('MinIO did not become ready');

const alreadyExists = await request('HEAD');
if (alreadyExists === 404) {
  const xml = Buffer.from(`<CreateBucketConfiguration><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`);
  const status = await request('PUT', xml);
  if (status !== 200 && status !== 409) throw new Error(`Test bucket creation rejected (${status})`);
} else if (alreadyExists !== 200) {
  throw new Error(`Test bucket lookup rejected (${alreadyExists})`);
}
if (await request('HEAD') !== 200) throw new Error('Test bucket unavailable after initialization');
console.info('Private MinIO trial bucket ready');
