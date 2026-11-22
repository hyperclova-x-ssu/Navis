import { MediaError } from './errors.mjs';
import { documentReceiptResult, generalReceiptResult } from './receipt.mjs';

const SPEECH_HOST = 'clovaspeech-gw.ncloud.com';
const SPEECH_PATH = '/recog/v1/stt';

function validRetryAfter(value) {
  if (!value) return undefined;
  if (/^[0-9]+$/.test(value)) return value;
  return new Date(value).toUTCString() === value ? value : undefined;
}

async function providerJson(fetchImpl, url, init) {
  try {
    const response = await fetchImpl(url, { ...init, method: 'POST', redirect: 'error' });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 429) {
        throw new MediaError('RATE_LIMITED', { retryAfter: validRetryAfter(response.headers.get('retry-after')) });
      }
      throw new MediaError('UNAVAILABLE');
    }
    init.signal.throwIfAborted();
    if (response.status === 204 || response.status === 205) return null;
    return await response.json();
  } catch (error) {
    init.signal.throwIfAborted();
    if (error instanceof MediaError) throw error;
    throw new MediaError('UNAVAILABLE');
  }
}

function receiptEndpoint(value, live) {
  try {
    const url = new URL(value);
    const validHost = !live || /^[a-z0-9-]+\.apigw\.ntruss\.com$/.test(url.hostname);
    if (validHost && url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash) {
      if (url.pathname.endsWith('/document/receipt')) return { url: url.href, general: false };
      if (url.pathname.endsWith('/general')) return { url: url.href, general: true };
    }
  } catch { /* Keep configuration details out of errors. */ }
  throw new MediaError('UNAVAILABLE');
}

function speechEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === SPEECH_HOST && !url.port
        && !url.username && !url.password && !url.hash) {
      const path = url.pathname.replace(/\/+$/, '');
      url.pathname = path.endsWith(SPEECH_PATH) ? path : path + SPEECH_PATH;
      url.searchParams.set('lang', 'Kor');
      return url.href;
    }
  } catch { /* Keep configuration details out of errors. */ }
  throw new MediaError('UNAVAILABLE');
}

export function createProviders({ fetchImpl, live = false, receiptUrl, receiptSecret, speechUrl, speechSecret, now = Date.now }) {
  return {
    async receipt({ bytes, type, info, requestId, signal }) {
      if (live && !receiptSecret) throw new MediaError('UNAVAILABLE');
      const { url, general } = receiptEndpoint(receiptUrl, live);
      const { format } = info;
      const image = { format, name: requestId };
      const message = { version: 'V2', requestId, timestamp: now(), images: [image] };
      const headers = receiptSecret ? { 'X-OCR-SECRET': receiptSecret } : {};
      if (general) {
        headers['Content-Type'] = 'application/json';
        image.data = bytes.toString('base64');
        const payload = await providerJson(fetchImpl, url, { headers, body: JSON.stringify(message), signal });
        return { suggestion: generalReceiptResult(payload, requestId) };
      }

      const body = new FormData();
      body.set('message', JSON.stringify(message));
      body.set('file', new Blob([bytes], { type }), `${requestId}.${format}`);
      const payload = await providerJson(fetchImpl, url, { headers, body, signal });
      return { suggestion: documentReceiptResult(payload, requestId) };
    },
    async speech({ bytes, requestId, signal }) {
      const headers = { 'Content-Type': 'application/octet-stream' };
      const url = live ? speechEndpoint(speechUrl) : speechUrl;
      if (live) {
        if (!speechSecret) throw new MediaError('UNAVAILABLE');
        headers['X-CLOVASPEECH-API-KEY'] = speechSecret;
      }
      const payload = await providerJson(fetchImpl, url, { headers, body: bytes, signal });
      const transcript = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (!transcript) throw new MediaError('MEDIA_UNREADABLE');
      return { suggestion: { requestId, text: transcript } };
    },
  };
}
