// Run from 04_app after the owner approves the service, credit and synthetic fixture.
// node server/media/smoke.mjs receipt --approve-live /path/to/synthetic-receipt.png
// node server/media/smoke.mjs speech --approve-live /path/to/synthetic-korean-16k-mono.wav
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { request } from 'node:https';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { MediaError, withProviderDeadline } from './errors.mjs';
import { createProviders } from './providers.mjs';
import { MAX_BYTES, readBounded, validateMedia } from './validation.mjs';

const fixtureTypes = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.wav', 'audio/wav'],
]);

async function fetchOnce(url, { method, headers, body, signal }) {
  // HTTPS request has no redirect or replay behavior, including on HTTP 421.
  const response = await new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method, headers: Object.fromEntries(headers), signal, agent: false,
    }, resolve);
    outgoing.once('error', reject);
    outgoing.end(body);
  });
  const { statusCode: status, headers: responseHeaders } = response;
  const withoutBody = status === 204 || status === 205 || status === 304;
  if (withoutBody) response.resume();
  return new Response(withoutBody ? null : Readable.toWeb(response), { status, headers: responseHeaders });
}

async function readFixture(service, fixturePath) {
  if (typeof fixturePath !== 'string' || !fixtureTypes.has(extname(fixturePath).toLowerCase())) {
    throw new MediaError('BAD_REQUEST');
  }
  const file = await open(fixturePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new MediaError('BAD_REQUEST');
    if (stat.size > MAX_BYTES[service]) throw new MediaError('PAYLOAD_TOO_LARGE');
    return await readBounded(file.createReadStream({ autoClose: false }), MAX_BYTES[service]);
  } finally {
    await file.close();
  }
}

export async function runSmoke({ service, approved, fixturePath, env = process.env, fetchImpl = fetchOnce }) {
  const started = performance.now();
  const requestId = randomUUID();
  let outboundCalls = 0;
  let info;
  function report(outcome, details) {
    const durationSeconds = info?.durationSeconds;
    const estimatedUnits = durationSeconds === undefined ? undefined : Math.ceil(durationSeconds / 15);
    return {
      service, requestId, outboundCalls, elapsedMs: Math.round(performance.now() - started), outcome,
      ...(durationSeconds !== undefined && { durationSeconds }),
      ...(outboundCalls > 0 && (service === 'receipt' ? { estimatedPhotoUnits: 1 } : {
        estimated15SecondUnits: estimatedUnits,
        estimatedChargeWon: estimatedUnits * 4,
      })),
      ...details,
    };
  }

  if (service !== 'receipt' && service !== 'speech') return report('failed', { reason: 'BAD_SERVICE' });
  if (approved !== true) return report('pending', { reason: 'APPROVAL_REQUIRED' });

  const receiptUrl = service === 'receipt' ? env.CLOVA_OCR_RECEIPT_INVOKE_URL : undefined;
  const receiptSecret = service === 'receipt' ? env.CLOVA_OCR_RECEIPT_SECRET : undefined;
  const speechSecret = service === 'speech' ? env.CLOVA_SPEECH_SHORT_SECRET : undefined;
  if (service === 'receipt' ? !receiptUrl?.trim() || !receiptSecret?.trim() : !speechSecret?.trim()) {
    return report('pending', { reason: 'CREDENTIALS_REQUIRED' });
  }

  let bytes;
  let type;
  try {
    bytes = await readFixture(service, fixturePath);
    type = fixtureTypes.get(extname(fixturePath).toLowerCase());
    info = validateMedia(service, type, bytes);
  } catch (error) {
    return report('failed', { reason: error instanceof MediaError ? error.code : 'BAD_REQUEST' });
  }

  const providers = createProviders({
    receiptUrl, receiptSecret, speechSecret,
    fetchImpl: async (url, init) => {
      if (outboundCalls !== 0) throw new MediaError('UNAVAILABLE');
      // Serialize the multipart boundary and buffer the bounded request before counting a call.
      const wire = new Request(url, init);
      const body = Buffer.from(await wire.arrayBuffer());
      wire.headers.set('Content-Length', String(body.length));
      init.signal.throwIfAborted();
      outboundCalls++;
      return fetchImpl(url, { ...init, headers: wire.headers, body });
    },
  });
  const cancellation = new AbortController();
  try {
    const { providerQuota } = await withProviderDeadline(signal => (
      providers[service]({ bytes, type, info, requestId, signal })
    ), cancellation.signal);
    return report('succeeded', providerQuota === undefined ? {} : { providerQuota });
  } catch (error) {
    const failure = error instanceof MediaError ? error : new MediaError('UNAVAILABLE');
    return report('failed', {
      reason: failure.code,
      ...(failure.providerQuota !== undefined && { providerQuota: failure.providerQuota }),
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, flag, fixturePath, ...extra] = process.argv.slice(2);
  // Echo only known service names and keep operator-supplied paths out of output.
  const service = mode === 'receipt' || mode === 'speech' ? mode : 'unknown';
  const result = await runSmoke({ service, fixturePath, approved: flag === '--approve-live' && !!fixturePath && extra.length === 0 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.outcome === 'succeeded' ? 0 : result.outcome === 'pending' ? 2 : 1;
}
