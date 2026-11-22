import { createHash } from 'node:crypto';
import type { Provider } from '../../../services/marketing/naver/binding.ts';
import { NaverAdapterError } from '../../../services/marketing/naver/errors.ts';
import { call, type CallResult } from '../../../services/marketing/naver/transport.ts';

/**
 * PN16 Object Storage consumer for promo artifacts in marketing-worker (W, S3-compatible, path style).
 * Contract: packages/naver/contracts/pn16 (`pn16.object.{put,get,delete}`) · persona capability pn16.
 * AWS Signature V4 (region kr-standard) is added by the PN-P0 binding.
 *
 * Sources: https://api.ncloud-docs.com/docs/storage-objectstorage (endpoint, Signature V4, errors) ·
 * PUT/GET/DELETE Object pages linked there.
 * Scope: the configured bucket and key prefix granted to this workload, then `{storeId}/{artifactId}`.
 * `account` keeps file metadata, access and browser bytes (PN-A1); wiring an object reference into
 * the account artifact registry is an open handoff (README).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARTIFACT = /^[A-Za-z0-9_-]{1,80}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^(?:[A-Za-z0-9_.-]{1,100}\/){1,4}$/;
const MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'application/json']);
const MAX_BYTES = 32 * 1024 * 1024;
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const errorCode = (result: CallResult) => /<Code>([^<]{1,64})<\/Code>/.exec(result.body.toString('utf8'))?.[1];

export function createPromoObjectStore(provider: Provider, location: { bucket: string; keyPrefix: string }) {
  if (!BUCKET.test(location.bucket) || !PREFIX.test(location.keyPrefix)) throw new Error('Invalid promo object location');
  function target(scope: { storeId: string; artifactId: string }) {
    if (!UUID.test(scope.storeId) || !ARTIFACT.test(scope.artifactId)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'key' });
    const key = `${location.keyPrefix}${scope.storeId}/${scope.artifactId}`;
    return { key, path: `/${location.bucket}/${key}` };
  }
  const refuse = (result: CallResult, write: boolean): never => {
    const info = { providerStatus: result.status, providerCode: errorCode(result) };
    if (result.status === 403) throw new NaverAdapterError('FORBIDDEN', info);
    if (result.status === 404) throw new NaverAdapterError('NOT_FOUND', info);
    if (result.status >= 500) throw new NaverAdapterError(write ? 'UNKNOWN_OUTCOME' : 'UNAVAILABLE', info);
    throw new NaverAdapterError('REJECTED', info);
  };

  return {
    async put(scope: { storeId: string; artifactId: string }, bytes: Uint8Array, contentType: string, signal?: AbortSignal) {
      if (!MIME.has(contentType) || !bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new NaverAdapterError('INVALID_INPUT', { detail: 'object' });
      const { key, path } = target(scope);
      const result = await call(provider, 'pn16.object.put', path, { body: bytes, headers: { 'content-type': contentType }, signal });
      if (result.status !== 200) refuse(result, true);
      // A single-part PUT ETag is the MD5 of the object; check it when returned.
      const etag = result.headers.get('etag')?.replace(/"/g, '');
      if (etag && etag !== createHash('md5').update(bytes).digest('hex')) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: 'etag' });
      return { bucket: location.bucket, key, sha256: sha256(bytes), sizeBytes: bytes.byteLength };
    },

    async get(scope: { storeId: string; artifactId: string }, expectedSha256?: string, signal?: AbortSignal) {
      const { path } = target(scope);
      const result = await call(provider, 'pn16.object.get', path, { signal });
      if (result.status !== 200) refuse(result, false);
      if (expectedSha256 && sha256(result.body) !== expectedSha256) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: 'sha256' });
      return { bytes: result.body, contentType: result.headers.get('content-type') ?? '' };
    },

    async remove(scope: { storeId: string; artifactId: string }, signal?: AbortSignal) {
      const { path } = target(scope);
      const result = await call(provider, 'pn16.object.delete', path, { signal });
      if (result.status === 204 || result.status === 404) return { removed: true as const };
      return refuse(result, true);
    },
  };
}
