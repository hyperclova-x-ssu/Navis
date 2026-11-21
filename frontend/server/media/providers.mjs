import { MediaError } from './errors.mjs';

const SPEECH_URL = 'https://clovaspeech-gw.ncloud.com/recog/v1/stt?lang=Kor';
const REVIEW_THRESHOLD = 0.80;

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

function receiptEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.pathname.endsWith('/document/receipt')
        && !url.username && !url.password && !url.search && !url.hash) return url.href;
  } catch { /* Keep configuration details out of errors. */ }
  throw new MediaError('UNAVAILABLE');
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function won(value) {
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^₩\s*|\s*원$/g, '');
    if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(cleaned)) return null;
    value = Number(cleaned.replaceAll(',', ''));
  }
  return Number.isSafeInteger(value) ? value : null;
}

function quantity(value) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

function date(value) {
  let parts;
  if (typeof value === 'object' && value !== null) {
    parts = [value.year, value.month, value.day].map(part => String(part ?? ''));
  } else if (typeof value === 'string') {
    parts = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*(?:일|\.)?$/.exec(value.trim())?.slice(1)
      ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim())?.slice(1);
  }
  if (!parts || !/^\d{4}$/.test(parts[0]) || parts[0] === '0000' || parts.slice(1).some(part => !/^\d{1,2}$/.test(part))) return null;
  const iso = parts.map(part => part.padStart(2, '0')).join('-');
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

function field(source, parse) {
  const formatted = source?.formatted;
  const value = parse(formatted?.value) ?? parse(formatted) ?? parse(source?.text);
  if (value === null) return null;
  const score = source?.confidenceScore;
  return { value, needsReview: !Number.isFinite(score) || score < REVIEW_THRESHOLD || score > 1 };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function receiptResult(payload, requestId) {
  const images = asArray(payload?.images);
  const image = images[0];
  const result = image?.receipt?.result;
  if (images.length !== 1 || image?.inferResult !== 'SUCCESS' || !result) throw new MediaError('MEDIA_UNREADABLE');

  const merchant = field(result.storeInfo?.name, text);
  const recognizedDate = field(result.paymentInfo?.date, date);
  const totalWon = field(result.totalPrice?.price, value => {
    const amount = won(value);
    return amount > 0 ? amount : null;
  });
  const items = asArray(result.subResults).flatMap(group => asArray(group?.items)).map(item => ({
    name: field(item?.name, text),
    quantity: field(item?.count, quantity),
    amountWon: field(item?.price?.price, won),
  })).filter(item => item.name || item.quantity || item.amountWon);

  if (!merchant && !recognizedDate && !totalWon && !items.length) throw new MediaError('MEDIA_UNREADABLE');
  return { requestId, merchant, date: recognizedDate, totalWon, items };
}

// Fetch is always supplied by the caller. The app supplies the fake transport.
export function createProviders({ fetchImpl, receiptUrl, receiptSecret, speechSecret, now = Date.now }) {
  return {
    async receipt({ bytes, type, info, requestId, signal }) {
      const url = receiptEndpoint(receiptUrl);
      const { format } = info;
      const body = new FormData();
      body.set('message', JSON.stringify({ version: 'V2', requestId, timestamp: now(), images: [{ format, name: requestId }] }));
      body.set('file', new Blob([bytes], { type }), `${requestId}.${format}`);
      const headers = receiptSecret ? { 'X-OCR-SECRET': receiptSecret } : {};
      const payload = await providerJson(fetchImpl, url, { headers, body, signal });
      return { suggestion: receiptResult(payload, requestId) };
    },
    async speech({ bytes, requestId, signal }) {
      const headers = { 'Content-Type': 'application/octet-stream' };
      if (speechSecret) headers['X-CLOVASPEECH-API-KEY'] = speechSecret;
      const payload = await providerJson(fetchImpl, SPEECH_URL, { headers, body: bytes, signal });
      const rawQuota = payload?.quota;
      const quota = typeof rawQuota === 'string' && /^\d{1,12}(?:\.\d{1,6})?$/.test(rawQuota) ? Number(rawQuota) : rawQuota;
      const providerQuota = Number.isFinite(quota) && quota >= 0 && quota <= Number.MAX_SAFE_INTEGER ? quota : undefined;
      const transcript = text(payload?.text);
      if (!transcript) throw new MediaError('MEDIA_UNREADABLE', { providerQuota });
      return { suggestion: { requestId, text: transcript }, providerQuota };
    },
  };
}
