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
  const skipped = { status: null, textLength: 0, exitCode: 2 };
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
    // OCR reports lengths of recognized names, dates and amounts, never their values.
    const fields = service === 'speech' ? [suggestion.text] : [
      suggestion.merchant?.value, suggestion.date?.value, suggestion.totalWon?.value,
      ...suggestion.items.flatMap(item => [item.name?.value, item.quantity?.value, item.amountWon?.value]),
    ];
    const textLength = fields.reduce((length, value) => length + String(value ?? '').length, 0);
    return { status, textLength, exitCode: 0 };
  } catch {
    return { status, textLength: 0, exitCode: 1 };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [service, flag, fixturePath, ...extra] = process.argv.slice(2);
  const { status, textLength, exitCode } = await runSmoke({ service, fixturePath, approved: flag === '--approve-live' && !!fixturePath && extra.length === 0 });
  process.stdout.write(`${JSON.stringify({ status, textLength })}\n`);
  process.exitCode = exitCode;
}
