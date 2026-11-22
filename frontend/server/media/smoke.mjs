// Run from frontend after the owner approves the service, credit and synthetic fixture.
// node server/media/smoke.mjs receipt --approve-live /path/to/synthetic-receipt.png
// node server/media/smoke.mjs speech --approve-live /path/to/synthetic-korean-16k-mono.wav
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mediaLiveOptions, readMediaCredentials } from './config.mjs';
import { MediaError, withProviderDeadline } from './errors.mjs';
import { fetchMediaOnce } from './fetch-once.mjs';
import { createProviders } from './providers.mjs';
import { MAX_BYTES, readBounded, validateMedia } from './validation.mjs';

const fixtureTypes = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.wav', 'audio/wav'],
]);

async function readFixture(service, fixturePath) {
  if (typeof fixturePath !== 'string' || !fixtureTypes.has(extname(fixturePath).toLowerCase())) {
    throw new MediaError('BAD_REQUEST');
  }
  const file = await open(fixturePath, 'r');
  try {
    const limit = MAX_BYTES[service];
    const stat = await file.stat();
    if (!stat.isFile()) throw new MediaError('BAD_REQUEST');
    if (stat.size > limit) throw new MediaError('PAYLOAD_TOO_LARGE');
    return await readBounded(file.createReadStream({ autoClose: false }), limit);
  } finally {
    await file.close();
  }
}

export async function runSmoke({ service, approved, fixturePath, secretsDir, fetchImpl = fetchMediaOnce }) {
  const emptyResult = service === 'receipt' ? { fieldCount: 0, reviewFieldCount: 0 } : { textLength: 0 };
  const skipped = { status: null, ...emptyResult, exitCode: 2 };
  if (approved !== true || (service !== 'speech' && service !== 'receipt')) return skipped;

  let status = null;
  try {
    const credentials = mediaLiveOptions(readMediaCredentials(service, secretsDir ?? join(homedir(), '.navis-ncp', 'secrets')));
    const hasCredentials = service === 'speech'
      ? credentials.speechUrl && credentials.speechSecret
      : credentials.receiptUrl && credentials.receiptSecret;
    if (!hasCredentials) return skipped;

    const bytes = await readFixture(service, fixturePath);
    const type = fixtureTypes.get(extname(fixturePath).toLowerCase());
    const info = validateMedia(service, type, bytes);
    const providers = createProviders({
      ...credentials, live: true,
      fetchImpl: async (url, init) => {
        const response = await fetchImpl(url, init);
        status = response.status;
        return response;
      },
    });
    const requestId = randomUUID();
    const { suggestion } = await withProviderDeadline(signal => (
      providers[service]({ bytes, type, info, requestId, signal })
    ), new AbortController().signal);
    if (service === 'speech') return { status, textLength: suggestion.text.length, exitCode: 0 };
    const fields = [
      suggestion.merchant, suggestion.date, suggestion.totalWon,
      ...suggestion.items.flatMap(item => [item.name, item.quantity, item.amountWon]),
    ].filter(Boolean);
    return { status, fieldCount: fields.length, reviewFieldCount: fields.filter(field => field.needsReview).length, exitCode: 0 };
  } catch {
    return { status, ...emptyResult, exitCode: 1 };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [service, flag, fixturePath, ...extra] = process.argv.slice(2);
  const { exitCode, ...counts } = await runSmoke({ service, fixturePath, approved: flag === '--approve-live' && !!fixturePath && extra.length === 0 });
  process.stdout.write(`${JSON.stringify(counts)}\n`);
  process.exitCode = exitCode;
}
