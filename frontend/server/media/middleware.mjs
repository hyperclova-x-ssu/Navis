import { randomUUID } from 'node:crypto';
import { privateOriginAllowed } from '../private-origin.mjs';
import { MediaError, withProviderDeadline } from './errors.mjs';
import { FAKE_RECEIPT_URL, fakeMediaFetch } from './fake.mjs';
import { createProviders } from './providers.mjs';
import { MAX_BYTES, MEDIA_TYPES, readBounded, validateMedia } from './validation.mjs';

const routes = new Map([
  ['/api/navis/media/receipt-ocr', 'receipt'],
  ['/api/navis/media/transcription', 'speech'],
]);

const statusByError = {
  BAD_REQUEST: 400, FORBIDDEN: 403, METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415, MEDIA_UNREADABLE: 422,
  RATE_LIMITED: 429, UNAVAILABLE: 503, TIMEOUT: 504,
};

function json(res, status, body, headers) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function createMediaService({ allowedOrigins = new Map(), fetchImpl = fakeMediaFetch, timeoutMs, now } = {}) {
  const providers = createProviders({ fetchImpl, receiptUrl: FAKE_RECEIPT_URL, now });
  const active = new Map();
  let closed = false;

  async function middleware(req, res, next) {
    const service = routes.get((req.url || '').split('?')[0]);
    if (!service) return next();
    const requestId = randomUUID();
    const cancellation = new AbortController();
    function fail(code, headers) {
      json(res, statusByError[code], { error: code, requestId }, {
        ...headers,
        // The response can finish without consuming an invalid or oversized upload.
        ...(!req.readableEnded && { Connection: 'close' }),
      });
    }

    if (!privateOriginAllowed(req, allowedOrigins)) return fail('FORBIDDEN');
    if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', { Allow: 'POST' });
    const type = req.headers['content-type']?.trim().toLowerCase();
    if (!MEDIA_TYPES[service].includes(type)) return fail('UNSUPPORTED_MEDIA_TYPE');
    const length = req.headers['content-length'];
    if (length !== undefined && !/^\d+$/.test(length)) return fail('BAD_REQUEST');
    if (Number(length) > MAX_BYTES[service]) return fail('PAYLOAD_TOO_LARGE');
    if (closed) return fail('UNAVAILABLE');
    if (active.has(service)) return fail('RATE_LIMITED');

    const cancel = () => cancellation.abort();
    const signal = cancellation.signal;
    active.set(service, cancellation);
    req.once('aborted', cancel);
    res.once('close', cancel);
    try {
      const bytes = await readBounded(req.iterator({ destroyOnReturn: false }), MAX_BYTES[service], signal);
      signal.throwIfAborted();
      const info = validateMedia(service, type, bytes);
      const { suggestion } = await withProviderDeadline(providerSignal => (
        providers[service]({ bytes, type, info, requestId, signal: providerSignal })
      ), signal, timeoutMs);
      if (!signal.aborted && !res.destroyed) json(res, 200, suggestion);
    } catch (error) {
      if (signal.aborted || res.destroyed) return;
      const failure = error instanceof MediaError ? error : new MediaError('UNAVAILABLE');
      fail(failure.code, failure.retryAfter ? { 'Retry-After': failure.retryAfter } : undefined);
    } finally {
      req.off('aborted', cancel);
      res.off('close', cancel);
      active.delete(service);
    }
  }

  middleware.close = () => {
    closed = true;
    for (const cancellation of active.values()) cancellation.abort();
  };
  return middleware;
}
