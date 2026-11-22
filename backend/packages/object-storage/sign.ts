import { createHash, createHmac } from 'node:crypto';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Path-style S3 SigV4 for NCP Object Storage and MinIO. */
export function createObjectStorageSigner(accessKeyId: string, now = () => new Date(), region = 'kr-standard') {
  return ({ method, url, body, headers }: {
    method: string; url: URL; body?: Uint8Array; headers: Headers;
  }, secret: string): HeadersInit => {
    const amzDate = now().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = hash(body ?? '');
    const canonical: Record<string, string> = {
      host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate,
    };
    for (const name of ['content-type', 'range']) {
      const value = headers.get(name);
      if (value) canonical[name] = value.trim().replace(/\s+/g, ' ');
    }
    const names = Object.keys(canonical).sort();
    const signed = names.join(';');
    const request = [method, url.pathname, '', names.map(name => `${name}:${canonical[name]}\n`).join(''), signed, payloadHash].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const key = scope.split('/').reduce<Buffer | string>((key, part) =>
      createHmac('sha256', key).update(part).digest(), 'AWS4' + secret);
    const signature = createHmac('sha256', key)
      .update(['AWS4-HMAC-SHA256', amzDate, scope, hash(request)].join('\n')).digest('hex');
    return {
      'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    };
  };
}
