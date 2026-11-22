import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { createObjectStorageSigner } from '../naver/storage.ts';
import { uuidPattern } from '../sessions.ts';
import { maxArtifactBytes } from './artifacts.ts';
import type { PromoStorage } from './storage.ts';

const origin = 'https://kr.object.ncloudstorage.com';
const uuid = new RegExp(uuidPattern);
const bucketName = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const cacheBudget = 32 * 1024 * 1024;

export function createNcpPromoStorage(env: NodeJS.ProcessEnv = process.env, options: {
  read?: (path: string) => string | undefined; fetcher?: typeof fetch; now?: () => Date;
} = {}): PromoStorage | undefined {
  const directory = env.NAVIS_NCP_SECRETS_DIR;
  if (env.NAVIS_NCP_OBJECT_STORAGE_PROVIDER !== 'live' || !directory || !isAbsolute(directory)) return;
  function file(name: string) {
    try {
      const path = join(directory!, name);
      return (options.read ? options.read(path) : readFileSync(path, 'utf8'))?.trim();
    } catch { return undefined; }
  }
  const bucket = file('NCP_OBJECT_STORAGE_BUCKET');
  const accessKey = file('NCP_ACCESS_KEY');
  const secret = file('NCP_SECRET_KEY');
  if (!bucket || !bucketName.test(bucket) || isIP(bucket) !== 0 || !accessKey || !secret || /\s/.test(accessKey + secret)) return;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const sign = createObjectStorageSigner(accessKey, now);
  const cache = new Map<string, { bytes: Buffer; until: number }>();
  let cachedBytes = 0;
  const path = (key: string, storeId: string) => {
    if (!uuid.test(storeId) || !uuid.test(key)) throw new Error('Invalid private object scope');
    return `/${bucket}/promo/${storeId}/${key}`;
  };
  function evict(key: string) {
    cachedBytes -= cache.get(key)?.bytes.length ?? 0;
    cache.delete(key);
  }
  async function request(method: string, key: string, body?: Buffer, mime?: string) {
    const url = new URL(key, origin);
    const headers = new Headers(mime ? { 'content-type': mime } : {});
    new Headers(sign({ method, url, body, headers }, secret!)).forEach((value, name) => headers.set(name, value));
    try {
      return await fetcher(url, { method, headers, body: body && Uint8Array.from(body),
        redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch { throw new Error('Promo Object Storage unavailable'); }
  }
  async function expectStatus(response: Response, ...statuses: number[]) {
    if (!statuses.includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Promo Object Storage rejected the request');
    }
  }
  return {
    async write(key, bytes, { storeId, mime }) {
      const target = path(key, storeId);
      if (!bytes.length || bytes.length > maxArtifactBytes) throw new Error('Invalid promo object size');
      await expectStatus(await request('PUT', target, bytes, mime), 200);
      evict(target);
    },
    async read(key, { storeId }) {
      const target = path(key, storeId);
      const hit = cache.get(target);
      if (hit && hit.until > +now()) return Buffer.from(hit.bytes);
      evict(target);
      const response = await request('GET', target);
      await expectStatus(response, 200, 404);
      if (response.status === 404) { await response.body?.cancel(); return; }
      if (!response.body) throw new Error('Promo Object Storage returned no content');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxArtifactBytes) throw new Error('Promo object exceeds size limit');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      evict(target);
      while (cachedBytes + bytes.length > cacheBudget || cache.size >= 64) evict(cache.keys().next().value!);
      cache.set(target, { bytes, until: +now() + 30_000 });
      cachedBytes += bytes.length;
      return Buffer.from(bytes);
    },
    async remove(key, { storeId }) {
      const target = path(key, storeId);
      await expectStatus(await request('DELETE', target), 204, 404);
      evict(target);
    },
  };
}
