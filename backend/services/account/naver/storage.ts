import { createHash, createHmac } from 'node:crypto';
import { approval, checked, NaverError, ownerRequest, selector, type NaverTransport, type OwnerApproval, type OwnerContext } from './wire.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

type Action = 'put' | 'get' | 'delete';
type ObjectAccess = (ctx: OwnerContext, action: Action, objectId: string) => Promise<{ bucket: string; key: string }>;

// https://api.ncloud-docs.com/docs/storage-objectstorage
// The scope resolver authorizes owner metadata and private bucket/prefix. P0 signs exact bytes with SigV4.
export function createNaverObjectStorage(transport: NaverTransport, authorizeObject: ObjectAccess) {
  async function access(ctx: OwnerContext, action: Action, objectId: string, init?: { headers: HeadersInit; body: BodyInit }) {
    const { bucket, key } = await authorizeObject(ctx, action, objectId);
    const path = '/' + selector(bucket) + '/' + key.split('/').map(selector).join('/');
    return ownerRequest(transport, ctx)('pn16.object.' + action, path, {
      ...init, approvalScope: { actorId: ctx.actorId, objectId },
    });
  }
  return {
    async read(ctx: OwnerContext, objectId: string) {
      const response = await access(ctx, 'get', objectId);
      if (response.status === 404) { await response.body?.cancel(); return undefined; }
      await checked(response);
      return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type'),
        etag: response.headers.get('etag') };
    },
    async write(ctx: OwnerContext, card: OwnerApproval, objectId: string, bytes: Uint8Array, contentType: string) {
      approval(card);
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw new NaverError(400, 'INVALID_OBJECT_CONTENT_TYPE');
      const response = await checked(await access(ctx, 'put', objectId, {
        headers: { 'content-type': contentType }, body: Uint8Array.from(bytes),
      }));
      await response.body?.cancel();
      return { etag: response.headers.get('etag') };
    },
    async remove(ctx: OwnerContext, card: OwnerApproval, objectId: string) {
      approval(card, true);
      const response = await checked(await access(ctx, 'delete', objectId));
      await response.body?.cancel();
    },
  };
}

/* NCP S3 path-style SigV4 for the account file adapter.
   https://api.ncloud-docs.com/docs/common-objectstorageapi-objectstorageapi */
export function createObjectStorageSigner(accessKeyId: string, now = () => new Date()) {
  return ({ method, url, body, headers }: {
    method: string; url: URL; body?: Uint8Array; headers: Headers;
  }, secret: string): HeadersInit => {
    const amzDate = now().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = hash(body ?? '');
    const canonical: Record<string, string> = {
      host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate,
    };
    const contentType = headers.get('content-type');
    if (contentType) canonical['content-type'] = contentType.trim().replace(/\s+/g, ' ');
    const names = Object.keys(canonical).sort();
    const signed = names.join(';');
    const request = [method, url.pathname, '', names.map(name => name + ':' + canonical[name] + '\n').join(''), signed, payloadHash].join('\n');
    const scope = day + '/kr-standard/s3/aws4_request';
    const key = scope.split('/').reduce<Buffer | string>((key, part) =>
      createHmac('sha256', key).update(part).digest(), 'AWS4' + secret);
    const signature = createHmac('sha256', key)
      .update(['AWS4-HMAC-SHA256', amzDate, scope, hash(request)].join('\n')).digest('hex');
    return {
      'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate,
      authorization: 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + signature,
    };
  };
}
