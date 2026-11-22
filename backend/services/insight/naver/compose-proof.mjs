import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { Pool } from 'pg';
import { createInsightNaver, searchAdsAuthorization } from './index.ts';
import { createNaverTransport } from '../../../packages/naver/transport/index.ts';
import { createPersonaApp } from '../../naver-virtual/app.ts';
import { migratePersona } from '../../naver-virtual/migrate.ts';
import { personaTransaction } from '../../naver-virtual/db.ts';
import { PERSONA_ACCOUNT_ID as providerAccount } from '../../naver-virtual/clock.ts';
import { createSeedContext } from '../../../packages/db/seed-context.ts';
import { createClovaStudio } from '../../../../frontend/server/clova-studio.mjs';
import { createProviders } from '../../../../frontend/server/media/providers.mjs';

const now = () => new Date('2026-11-17T06:45:00Z');
const storeId = '00000000-0000-4000-8000-000000000001';
const origin = 'http://naver-virtual:3000';
const prefix = '/partner-assumed/v1';
const receiptPath = '/custom/v1/1/compose/document/receipt';
const studioPath = '/v3/chat-completions/HCX-005';
const draftRoute = /^\/partner-assumed\/v1\/reviews\/[\w-]+\/reply-draft$/;
const token = 'test-only-pna3-account-token';
const secret = 'test-only-pna3-wire-secret';
const ads = searchAdsAuthorization('1', 'fixture', now);
const providerCredentials = {
  'pn12.ads': { key: secret, keyId: 'fixture', customerId: '1' },
  'pn14.chat': { apiKey: secret },
  'pn15.speech': { secret },
  'pn15.receipt': { secret, domainId: '1', invokeKey: 'compose' },
};
const routes = [
  ['pn03.reviews.list', 'P', 'GET', prefix + '/reviews'],
  ['pn03.reviews.get', 'P', 'GET', /^\/partner-assumed\/v1\/reviews\/[\w-]+$/],
  ['pn03.stats.read', 'O', 'GET', prefix + '/review-statistics'],
  ['pn03.reply.draft', 'O', 'POST', draftRoute],
  ['pn08.smartcall.calls', 'O', 'GET', prefix + '/smartcall/calls'],
  ['pn09.financial-center.list', 'O', 'GET', prefix + '/financial-center/recommendations'],
  ['pn09.financial-center.read', 'O', 'GET', /^\/partner-assumed\/v1\/financial-center\/recommendations\/[\w-]+$/],
  ['pn12.place', 'P', 'GET', prefix + '/reports/place'],
  ['pn12.blog', 'O', 'GET', prefix + '/reports/blog'],
  ['pn12.clip', 'O', 'GET', prefix + '/reports/clip'],
  ['pn12.ads', 'W', 'GET', '/stats', (_, credential) => ads(credential)],
  ['pn14.chat', 'W', 'POST', studioPath, (_, credential) => ({ authorization: 'Bearer ' + credential })],
  ['pn15.speech', 'W', 'POST', '/recog/v1/stt', (_, credential) => ({ 'X-CLOVASPEECH-API-KEY': credential })],
  ['pn15.receipt', 'W', 'POST', receiptPath, (_, credential) => ({ 'X-OCR-SECRET': credential })],
];

function db(user) {
  return new Pool({ user, host: 'db', database: 'naver_virtual', connectionTimeoutMillis: 2_000 });
}

async function serve() {
  const capabilities = await Promise.all(['pn03', 'pn08', 'pn09', 'pn12', 'pn14', 'pn15'].map(async id =>
    (await import('../../naver-virtual/capabilities/' + id + '/index.ts')).personaCapability));
  const admin = db('postgres');
  try {
    await admin.query(`
      CREATE ROLE nvirtual_mig LOGIN;
      CREATE ROLE nvirtual_run LOGIN;
      CREATE SCHEMA naver_virtual AUTHORIZATION nvirtual_mig;
      GRANT USAGE ON SCHEMA naver_virtual TO nvirtual_run;
    `);
  } finally {
    await admin.end();
  }
  const migration = db('nvirtual_mig');
  try {
    await migratePersona(migration, capabilities);
    await personaTransaction(migration, providerAccount, async connection => {
      const seed = { accountId: providerAccount, now: now(), generation: now().toISOString(), cafe: createSeedContext() };
      await connection.query('INSERT INTO naver_virtual.seed_generation VALUES ($1,$2)', [providerAccount, seed.generation]);
      for (const capability of capabilities) {
        if (!capability.seed) continue;
        await capability.seed(connection, seed);
        await connection.query('INSERT INTO naver_virtual.seed_revision VALUES ($1,$2,$3)', [providerAccount, capability.id, seed.generation]);
      }
    });
  } finally {
    await migration.end();
  }
  const app = createPersonaApp({
    pool: db('nvirtual_run'), now, capabilities,
    grants: [{ workload: 'insight', accountId: providerAccount, token, operations: routes.map(([operation]) => operation), providerCredentials }],
  });
  await app.listen({ host: '0.0.0.0', port: 3000 });
}

function keys(value, required, optional = []) {
  assert.ok(required.every(key => Object.hasOwn(value, key)));
  assert.ok(Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}

function wav() {
  const samples = 16_000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(samples, 24);
  bytes.writeUInt32LE(samples * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

async function verify() {
  for (let attempt = 0; ; attempt++) {
    if (await fetch(origin + '/readyz', { signal: AbortSignal.timeout(500) }).then(r => r.ok, () => false)) break;
    if (attempt >= 30) throw new Error('Private Persona fixture failed readiness');
    await pause(500);
  }
  const transport = createNaverTransport({
    bindings: routes.map(([operation, grade, method, path, authorize]) => ({
      operation, storeId, providerAccount, grade, method, route: typeof path === 'string' ? new RegExp('^' + path + '$') : path,
      mode: 'virtual', origin, privateTokenFile: 'fixture-account',
      ...(authorize && { credentialFile: 'fixture-wire', authorize }),
    })),
    readCredential: file => file === 'fixture-account' ? token : secret,
  });
  const date = '2026-11-15';
  const period = { startDate: date, endDate: date };
  const raw = new Map();
  const insight = createInsightNaver({
    async request(operation, ...args) {
      const response = await transport.request(operation, ...args);
      if (response.ok && response.headers.get('content-type')?.startsWith('application/json')) {
        raw.set(operation, await response.clone().json());
      }
      return response;
    },
  }, { now, receiptPath });
  const reviews = await insight.reviews(storeId, { scope: 'venue' });
  assert.ok(reviews.items.length);
  for (const item of reviews.items) {
    keys(item, ['ref', 'text', 'keywords', 'media', 'stars', 'reply', 'hasReply']);
    for (const media of item.media) keys(media, ['type', 'url']);
  }
  const reviewRef = reviews.items[0].ref;
  assert.equal((await insight.review(storeId, reviewRef)).ref, reviewRef);
  assert.ok((await insight.reviewDraft(storeId, reviewRef, { style: '정중하게', length: '짧게' })).text);
  const stats = await insight.reviewStatistics(storeId, { period: 'day', to: '2026-11-17' });
  assert.equal(stats.period.to, date);
  for (const theme of stats.themes) keys(theme, ['theme', 'positiveCount', 'negativeCount']);
  const call = await insight.smartCallSummary(storeId, period);
  keys(call, ['period', 'daily', 'channels']);
  assert.deepEqual(call.period, period);
  for (const day of call.daily) keys(day, ['date', 'totalCalls', 'connectedCalls', 'arsCalls', 'missedCalls',
    'busyCalls', 'averageDurationSeconds', 'callsAtLeastTenSeconds']);
  const funding = await insight.recommendations(storeId);
  assert.ok(funding.items.length);
  const detail = await insight.recommendation(storeId, funding.items[0].ref);
  keys(detail, ['title', 'officialNoticeUrl', 'overview', 'eligibility', 'applicationMethod'], ['startDate', 'endDate', 'documents']);
  for (const channel of ['place', 'blog', 'clip']) {
    const report = await insight.channelReport(storeId, channel);
    keys(report, ['source', 'period', 'cards']);
    for (const card of report.cards) keys(card, ['metric', 'value'], ['period', 'changeRate']);
    assert.ok(report.cards.length > 0);
  }
  const ad = await insight.adsReport(storeId, 'cmp-a001-01-000000000000001', period);
  assert.deepEqual(ad.cards.map(c => c.metric), ['impressions', 'clicks', 'cost']);
  const adWire = raw.get('pn12.ads');
  keys(adWire, ['data']);
  keys(adWire.data[0], ['id', 'impCnt', 'clkCnt', 'salesAmt']);
  const draft = await insight.studioDraft(storeId, '카페 공지 초안을 써줘');
  keys(draft, ['text', 'usage']);
  assert.ok(draft.text);
  const studio = createClovaStudio({ apiKey: 'transport-placeholder', baseUrl: 'https://navis-agent.invalid',
    fetchImpl: insight.studioFetch(storeId) });
  const events = [];
  for await (const event of studio.complete({ messages: [{ role: 'user', content: '오늘 매출 알려줘' }], maxTokens: 128 })) events.push(event);
  assert.ok(events.some(event => event.event === 'token'));
  assert.equal(events.at(-1)?.event, 'result');
  keys(events.at(-1).data.usage, ['promptTokens', 'completionTokens', 'totalTokens']);
  const providers = createProviders({ fetchImpl: insight.mediaFetch(storeId),
    receiptUrl: 'https://receipt-fixture.invalid/document/receipt', now: () => +now() });
  const signal = AbortSignal.timeout(5_000);
  const speech = await providers.speech({ bytes: wav(), requestId: 'synthetic-audio', signal });
  assert.ok(speech.suggestion.text);
  assert.equal(speech.providerQuota, 15);
  keys(raw.get('pn15.speech'), ['text', 'quota']);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4DwYMEAoAU7oL9ZisIGcAAAAASUVORK5CYII=', 'base64');
  const result = await providers.receipt({ bytes: png, type: 'image/png', info: { format: 'png' }, requestId: 'synthetic-receipt', signal });
  assert.equal(result.suggestion.totalWon.value, 12_000);
  assert.equal(result.suggestion.date.value, '2026-11-17');
  const ocrWire = raw.get('pn15.receipt');
  keys(ocrWire, ['version', 'requestId', 'timestamp', 'images']);
  keys(ocrWire.images[0], ['uid', 'name', 'inferResult', 'message', 'validationResult', 'receipt']);
  keys(ocrWire.images[0].receipt.result, ['storeInfo', 'paymentInfo', 'totalPrice', 'subResults']);

  assert.deepEqual(await insight.reviews(storeId, { scope: 'venue' }), reviews);
  await assert.rejects(insight.reviews('another-store', { scope: 'venue' }), { status: 503 });
  const denied = await fetch(origin + prefix + '/reviews');
  assert.equal(denied.status, 401);
  const wrongAccount = await fetch(origin + prefix + '/reviews', {
    headers: { 'x-navis-naver-virtual-token': token, 'x-navis-naver-virtual-account': 'other-cafe' },
  });
  assert.equal(wrongAccount.status, 403);
  console.log('PN-A3 private Compose HTTP and PostgreSQL proof passed');
}

if (process.argv[2] === 'serve') await serve();
else await verify();
