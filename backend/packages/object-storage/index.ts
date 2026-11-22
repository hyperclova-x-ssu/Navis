import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createObjectStorageSigner } from './sign.ts';

export interface StoredObject {
  body: Readable;
  contentLength: number | null;
  contentType: string | null;
  contentRange?: string | null;
}

export interface ObjectStorage {
  put(key: string, bytes: Buffer, contentType: string, signal?: AbortSignal): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<StoredObject | undefined>;
  getRange?(key: string, range: string, signal?: AbortSignal): Promise<StoredObject | undefined>;
  remove(key: string, signal?: AbortSignal): Promise<void>;
}

const bucketName = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const mimeName = /^[\w.+-]+\/[\w.+-]+$/;
const singleRange = /^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/;

function keyPath(key: string) {
  const segments = key.split('/');
  if (Buffer.byteLength(key) > 1024 || segments.some(segment => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new Error('Invalid object key');
  }
  return segments.map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

export function createObjectStorage(env: NodeJS.ProcessEnv = process.env, {
  read = (path: string) => readFileSync(path, 'utf8'), fetcher = fetch, now = () => new Date(),
} = {}): (ObjectStorage & Required<Pick<ObjectStorage, 'getRange'>>) | undefined {
  const mode = env.NAVIS_OBJECT_STORAGE_MODE ?? 'off';
  if (mode === 'off') return;
  const endpoint = URL.parse(env.NAVIS_OBJECT_STORAGE_ENDPOINT ?? '');
  const bucket = env.NAVIS_OBJECT_STORAGE_BUCKET ?? '';
  const region = env.NAVIS_OBJECT_STORAGE_REGION ?? 'kr-standard';
  if (mode !== 's3' || !endpoint || !['https:', 'http:'].includes(endpoint.protocol)
    || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !bucketName.test(bucket) || isIP(bucket) || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(region)) {
    throw new Error('Invalid NAVIS object storage configuration');
  }
  function credential(name: string) {
    const file = env[name];
    if (file && isAbsolute(file)) {
      let value: string | undefined;
      try { value = read(file).trim(); } catch { /* Report the variable name only. */ }
      if (value && !/\s/.test(value)) return value;
    }
    throw new Error(`Missing or invalid object storage credential file: ${name}`);
  }
  const sign = createObjectStorageSigner(credential('NAVIS_OBJECT_STORAGE_ACCESS_KEY_FILE'), now, region);
  const secret = credential('NAVIS_OBJECT_STORAGE_SECRET_KEY_FILE');

  async function request(method: string, key: string, headers: Headers, body?: Buffer, signal?: AbortSignal) {
    const url = new URL(`/${bucket}/${keyPath(key)}`, endpoint!);
    new Headers(sign({ method, url, body, headers }, secret)).forEach((value, name) => headers.set(name, value));
    const timeout = AbortSignal.timeout(15_000);
    try {
      return await fetcher(url, { method, headers, body: body && new Uint8Array(body), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      throw new Error('Object storage request unavailable');
    }
  }

  async function get(key: string, signal?: AbortSignal, range?: string) {
    const headers = new Headers(range ? { range } : {});
    const response = await request('GET', key, headers, undefined, signal);
    if (response.status === (range ? 206 : 200) && response.body) {
      const size = response.headers.get('content-length');
      return {
        body: Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
        contentLength: size !== null && /^\d+$/.test(size) && Number.isSafeInteger(Number(size)) ? Number(size) : null,
        contentType: response.headers.get('content-type'), contentRange: response.headers.get('content-range'),
      };
    }
    await response.body?.cancel().catch(() => {});
    if (response.status === 404) return undefined;
    throw new Error(`Object storage read rejected (${response.status})`);
  }

  return {
    async put(key, bytes, contentType, signal) {
      if (!mimeName.test(contentType)) throw new Error('Invalid object content type');
      const result = await request('PUT', key, new Headers({ 'content-type': contentType }), bytes, signal);
      await result.body?.cancel().catch(() => {});
      if (!result.ok) throw new Error(`Object storage write rejected (${result.status})`);
    },
    get: (key, signal) => get(key, signal),
    async getRange(key, range, signal) {
      if (!singleRange.test(range)) throw new Error('Invalid object byte range');
      return get(key, signal, range);
    },
    async remove(key, signal) {
      const result = await request('DELETE', key, new Headers(), undefined, signal);
      await result.body?.cancel().catch(() => {});
      if (!result.ok && result.status !== 404) throw new Error(`Object storage deletion rejected (${result.status})`);
    },
  };
}
