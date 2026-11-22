import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { runner } from 'node-pg-migrate';
import type { Pool } from 'pg';
import { createClient } from 'redis';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { INPUT, PHOTO_META, fakeSpawn, photoSource, refs, resultLine, sceneHtml, validStory } from '../../../../frontend/server/promo/test/helpers.mjs';
import { checkVideo } from '../../../../frontend/server/promo/recorder.mjs';
import { dbConfig, dbPool } from '../../../packages/db/index.ts';
import { RedisStreams } from '../../../packages/streams/redis.ts';
import { parseEnvelope } from '../../../packages/streams/envelope.ts';
import { registerPromoFileRoutes } from '../../account/files/routes.ts';
import { createLocalPromoStorage } from '../../account/files/storage.ts';
import { createInsightApp } from '../../insight/app.ts';
import { saveProposal } from '../../insight/actions.ts';
import { inStore } from '../transaction.ts';
import { enqueuePromo } from './jobs.ts';
import { registerPromoRoutes, promoJobsPath } from './routes.ts';
import type { PromoArtifacts, PromoInput } from './contracts.ts';
import { createArtifactClient, createUsageClient } from '../../../workers/marketing-worker/promo/clients.ts';
import { createPromoConsumer, promoGroup } from '../../../workers/marketing-worker/promo/events.ts';
import { createFakePromoProvider } from '../../../workers/marketing-worker/promo/providers.ts';
import { createPromoWorker } from '../../../workers/marketing-worker/promo/worker.ts';

const redisUrl = process.env.NAVIS_PROMO_TEST_REDIS_URL;
const token = () => randomUUID();
const ownerToken = token();
const gatewayToken = token();
const readToken = token();
const accountToken = token();
const usageToken = token();
const actor = randomUUID();
const store = randomUUID();
const anotherStore = randomUUID();
const input: PromoInput = { ...INPUT, moods: ['warm'], concepts: ['new-item'] };
const marketing = Fastify();
const account = Fastify();
let insight: ReturnType<typeof createInsightApp>;
let database: Pool;
let accountDb: Pool;
let insightDb: Pool;
let streams: RedisStreams;
let artifacts: ReturnType<typeof createArtifactClient>;
let meter: ReturnType<typeof createUsageClient>;
let storage: string;
let video: Buffer;
let alternateVideo: Buffer;
let ffmpeg: { ffprobe: string; ffmpeg: string };
let photoBindings: Record<string, { resourceId: string; fileId: string }>;
let published: number;
const jobsUrl = (storeId = store) => promoJobsPath.replace(':storeId', storeId);
const headers = (storeId = store, bearer = ownerToken, role = 'owner') => ({
  authorization: `Bearer ${bearer}`, 'x-navis-store-id': storeId,
  'x-navis-store-role': role, 'x-navis-user-id': actor,
});
const card = (proposalId = randomUUID()) => ({
  body: { source: 'card', proposalId, snapshotRevision: 7, input },
  key: `navis:${proposalId}`,
});
const submit = (proposal: ReturnType<typeof card>, actorHeaders = headers(), storeId = store) => marketing.inject({
  method: 'POST', url: jobsUrl(storeId), headers: { ...actorHeaders, 'idempotency-key': proposal.key }, payload: proposal.body,
});
const jobView = (jobId: string, storeId = store) =>
  marketing.inject({ method: 'GET', url: `${jobsUrl(storeId)}/${jobId}`, headers: headers(storeId, readToken) });

beforeAll(async () => {
  if (!redisUrl) return;
  for (const service of ['account', 'insight', 'marketing'] as const) {
    await runner({
      databaseUrl: dbConfig(service, 'migrate', 'test'),
      dir: fileURLToPath(new URL(`../../${service}/migrations/`, import.meta.url)),
      schema: service, migrationsSchema: service, direction: 'up',
      migrationsTable: service === 'insight' ? 't311_test_migrations' : 'schema_migrations',
      log: () => undefined,
    });
  }
  storage = await mkdtemp(join(tmpdir(), 't313-files-'));
  [video, alternateVideo] = await Promise.all(['ref-1', 'ref-2'].map(ref =>
    readFile(new URL(`../../../../frontend/server/promo/references/${ref}/preview.mp4`, import.meta.url))));
  // Exercise the existing video checker using deterministic probe/luma output and prerecorded bytes.
  const ffprobe = join(storage, 'fake-ffprobe');
  const luma = join(storage, 'fake-ffmpeg');
  await writeFile(ffprobe, [
    '#!/bin/sh', 'for clip do :; done',
    'if cmp -s "$clip" "$(dirname "$0")/fixture.mp4" || cmp -s "$clip" "$(dirname "$0")/alternate.mp4"; then duration=10; else duration=1; fi',
    'printf \'{"format":{"duration":%s},"streams":[{"codec_type":"video","codec_name":"h264","width":720,"height":1280,"r_frame_rate":"30/1"},{"codec_type":"audio","codec_name":"aac"}]}\\n\' "$duration"',
    '',
  ].join('\n'), { mode: 0o700 });
  await writeFile(luma, '#!/bin/sh\nprintf "lavfi.signalstats.YAVG=80\\n"\n', { mode: 0o700 });
  await writeFile(join(storage, 'fixture.mp4'), video);
  await writeFile(join(storage, 'alternate.mp4'), alternateVideo);
  ffmpeg = { ffprobe, ffmpeg: luma };
  database = dbPool('marketing', 'runtime', 'test');
  accountDb = dbPool('account', 'runtime', 'test');
  insightDb = dbPool('insight', 'runtime', 'test');
  const accountMigrate = dbPool('account', 'migrate', 'test');
  try {
    await accountMigrate.query(
      `INSERT INTO account.store (store_id, display_name, business_type, payment_style, pos_start_tab, settings_revision, created_at, updated_at)
        VALUES ($1, 'T313 Cafe', 'cafe', 'prepaid', 'order', 1, now(), now())`, [store]);
  } finally {
    await accountMigrate.end();
  }
  registerPromoFileRoutes(account, accountDb, createLocalPromoStorage(storage), { marketingToken: accountToken, storageDirectory: storage });
  artifacts = createArtifactClient({ baseUrl: await account.listen({ host: '127.0.0.1', port: 0 }), token: accountToken });
  const catalog = photoSource.listCatalog();
  photoBindings = {};
  for (const photoId of [...input.photoIds, catalog.store.exteriorPhotoId]) {
    const resourceId = photoId;
    const bytes = Buffer.from(`synthetic ${photoId}`);
    const fileId = await artifacts.put({ storeId: store, resourceId }, photoId, 'promo_input', 'image/jpeg', bytes);
    photoBindings[photoId] = { resourceId, fileId };
  }
  registerPromoRoutes(marketing, database, {
    confirmToken: ownerToken, readToken, references: refs, artifacts,
    catalogForStore: async id => id === store ? {
      catalog, photos: photoBindings, exterior: photoSource.photoInfo(catalog.store.exteriorPhotoId)!,
    } : null,
  });
  insight = createInsightApp(insightDb, {
    gatewayToken, promoToken: usageToken, logging: false, cctvEnabled: false,
    marketing: { baseUrl: await marketing.listen({ host: '127.0.0.1', port: 0 }), token: ownerToken },
  });
  meter = createUsageClient({ baseUrl: await insight.listen({ host: '127.0.0.1', port: 0 }), token: usageToken });
  const client = createClient({ url: redisUrl, disableOfflineQueue: true });
  await client.connect();
  streams = new RedisStreams(client);
  const rebuild = await streams.beginRebuild('marketing', [promoGroup]);
  expect(await streams.finishRebuild('marketing', rebuild)).toBe(true);
  published = 0;
}, 25_000);

afterAll(async () => {
  streams?.close();
  await Promise.all([marketing.close(), account.close(), insight?.close()]);
  await Promise.all([database?.end(), accountDb?.end(), insightDb?.end()]);
  if (storage) await rm(storage, { recursive: true, force: true });
});

async function deliver(jobId: string, consumerName: string, copies = 1) {
  const event = await inStore(database, store, async db => {
    const { rows: [row] } = await db.query(`
      SELECT event_id AS "eventId", producer, store_id AS "storeId", scope_key AS "scopeKey",
        store_seq::text AS "storeSeq", event_type AS "eventType", schema_version AS "schemaVersion",
        aggregate_id AS "aggregateId", occurred_at::text AS "occurredAt", payload
      FROM marketing.outbox WHERE aggregate_id = $1`, [jobId]);
    return parseEnvelope(row, 'marketing');
  });
  const epoch = (await streams.readyEpoch('marketing'))!;
  for (let copy = 0; copy < copies; copy++) expect(await streams.append('marketing', epoch, event)).toBe(true);
  const consumer = createPromoConsumer({ database, redis: streams, name: consumerName });
  expect(await consumer.step()).toBe(copies);
  expect(await streams.pending('marketing', promoGroup)).toBe(0);
  published++;
}

function fakeProvider(options: { loseStory?: boolean; reconcile?: 'found' | 'not_sent'; badLook?: boolean; missingUsage?: boolean } = {}) {
  const calls: string[] = [];
  const replies = new Map<string, Response>();
  let loseStory = options.loseStory;
  let badLook = options.badLook;
  const provider = createFakePromoProvider({
    env: {},
    naverFetch: (stage, attemptId) => async (url, init) => {
      calls.push(stage);
      const request = JSON.parse(String(init?.body));
      const rawStory = validStory();
      const story = { scenes: rawStory.scenes, texts: rawStory.texts, ending: rawStory.ending };
      if (stage === 'story') {
        expect(String(url).endsWith('/HCX-007')).toBe(true);
        expect(request.responseFormat).toMatchObject({ type: 'json', schema: { required: ['scenes', 'texts', 'ending'] } });
        expect(request.thinking).toEqual({ effort: 'none' });
      }
      const invalid = stage === 'look' && badLook;
      if (invalid) badLook = false;
      const result = Response.json({ status: { code: '20000' }, result: {
        finishReason: 'stop', message: { role: 'assistant', content: JSON.stringify(invalid ? {} : stage === 'look' ? PHOTO_META : story) },
        ...(invalid ? {} : { usage: { promptTokens: 5, completionTokens: 2 } }),
      } });
      if (stage === 'story' && loseStory) {
        loseStory = false;
        if (options.reconcile === 'found') replies.set(attemptId, result);
        throw Error('fake transport disconnected');
      }
      return result;
    },
    claudeSpawn: () => fakeSpawn(() => {
      calls.push('scenes');
      return { stdout: resultLine({ html: sceneHtml() }) };
    }) as unknown as ReturnType<Parameters<typeof createFakePromoProvider>[0]['claudeSpawn']>,
    reconcile: async (_stage, attemptId) => replies.has(attemptId)
      ? { state: 'received', output: (() => {
        const { scenes, texts, ending } = validStory();
        return { scenes, texts, ending };
      })(), usage: options.missingUsage ? null : { outcome: 'success', inputTokens: 5, outputTokens: 2, latencyMs: 1 } }
      : options.reconcile === 'not_sent' ? { state: 'not_sent' } : { state: 'unknown' },
  });
  return { calls, provider };
}

function worker(provider: ReturnType<typeof fakeProvider>['provider'], {
  render, files = artifacts, reconcileWindowMs,
}: { render?: () => Promise<Buffer>; files?: PromoArtifacts; reconcileWindowMs?: number } = {}) {
  return createPromoWorker({
    database, artifacts: files, meter, provider, references: refs, music: [], musicDir: tmpdir(),
    checkScene: async () => ({ violations: [], checkMs: 0 }),
    renderVideo: async ({ outFile }) => { await writeFile(outFile, render ? await render() : video); },
    checkVideo: ({ file, lengthSec }) =>
      checkVideo({ file, lengthSec, ffmpeg, rules: refs.rules, width: 720, height: 1280, expectAudio: true }),
    retryDelayMs: 0, reconcileWindowMs,
  });
}

test.runIf(!!redisUrl)('accepts only a confirmed owner card and commits one scoped job and outbox event under concurrent repeats', async () => {
  const draft = card();
  expect((await submit(draft, headers(store, readToken))).statusCode).toBe(401);
  expect((await submit(draft, headers(store, ownerToken, 'staff'))).statusCode).toBe(403);
  expect((await submit({ ...draft, body: { ...draft.body, source: 'text' } })).statusCode).toBe(400);
  expect((await submit({ ...draft, key: 'wrong-key' })).statusCode).toBe(400);
  expect((await submit(draft, headers(anotherStore))).statusCode).toBe(403);
  const results = await Promise.all([submit(draft), submit(draft)]);
  expect(results.map(res => res.statusCode)).toEqual([202, 202]);
  expect(results[0].json()).toEqual(results[1].json());
  const { jobId } = results[0].json();
  expect((await jobView(jobId, anotherStore)).statusCode).toBe(404);
  const conflict = await submit({ ...draft, body: { ...draft.body, input: { ...input, memo: 'different' } } });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toEqual({ code: 'ACTION_CONFLICT' });
  const counts = await inStore(database, store, db => db.query(`
    SELECT (SELECT count(*)::int FROM marketing.promo_job) AS jobs,
           (SELECT count(*)::int FROM marketing.outbox) AS events`));
  expect(counts.rows[0]).toEqual({ jobs: 1, events: 1 });
  expect((await database.query('SELECT 1 FROM marketing.promo_job')).rowCount).toBe(0);
  expect((await submit(card())).json()).toEqual({ code: 'BUSY', activeJobId: jobId });
  const fake = fakeProvider({ badLook: true });
  const first = worker(fake.provider);
  expect(await first.runNext(store)).toBe(false);
  await deliver(jobId, 'first', 2);
  const second = worker(fake.provider);
  expect(await Promise.all([first.runNext(store), second.runNext(store)])).toEqual(expect.arrayContaining([true, false]));
  expect((await jobView(jobId)).json().stage).toBe('story');
  expect(fake.calls).toHaveLength(6);
  const restarted = worker(fake.provider);
  for (let stage = 0; stage < 3; stage++) expect(await restarted.runNext(store)).toBe(true);
  const result = (await jobView(jobId)).json();
  expect(result).toMatchObject({ jobId, status: 'done', stage: 'merge', stageState: 'done', result: { sizeBytes: video.length } });
  const ready = await artifacts.read({ storeId: store, resourceId: jobId }, result.assetId);
  expect(ready.bytes).toEqual(video);
  expect(fake.calls).toEqual([...Array(6).fill('look'), 'story', 'scenes']);
  expect((await submit(draft)).json()).toMatchObject({ jobId, status: 'done', assetId: result.assetId });
  const path = `${jobsUrl()}/${jobId}/video.mp4`;
  expect((await marketing.inject({ url: path })).statusCode).toBe(401);
  expect((await marketing.inject({ url: `${jobsUrl(anotherStore)}/${jobId}/video.mp4`, headers: headers(anotherStore, readToken) })).statusCode).toBe(404);
  const clip = await marketing.inject({ url: path, headers: { ...headers(store, readToken), range: 'bytes=0-19' } });
  expect(clip.statusCode).toBe(206);
  expect(clip.rawPayload).toEqual(video.subarray(0, 20));
  expect(clip.headers['content-range']).toBe(`bytes 0-19/${video.length}`);
  expect(await restarted.runNext(store)).toBe(false);
  const usage = await inStore(insightDb, store, db => db.query(`
    SELECT stage, count(*)::int AS calls, count(input_tokens)::int AS known
    FROM insight.ai_usage WHERE correlation_id = $1 GROUP BY stage ORDER BY stage`, [jobId]));
  expect(usage.rows).toEqual([{ stage: 'look', calls: 6, known: 5 }, { stage: 'scenes', calls: 1, known: 1 }, { stage: 'story', calls: 1, known: 1 }]);
});

test.runIf(!!redisUrl)('confirms through Insight, reconciles a lost response, and fences an upload that loses its lease', async () => {
  const draft = card();
  const proposalId = draft.body.proposalId;
  const runId = 't313-confirmation';
  await saveProposal(insightDb, { storeId: store, actorId: actor }, {
    command: 'video.make', args: {}, proposalId, runId, layer: 'marketing', tier: 'normal', snapshotRevision: 7,
  }, input, new Date());
  const confirm = (source: string) => insight.inject({
    method: 'POST', url: `/internal/v1/insight/stores/${store}/navis/proposals/${proposalId}/confirm`,
    headers: headers(store, gatewayToken), payload: { source, runId, snapshotRevision: 7 },
  });
  expect((await confirm('text')).statusCode).toBe(400);
  const accepted = await confirm('card');
  expect(accepted.statusCode).toBe(202);
  const { jobId } = accepted.json();
  expect((await confirm('card')).json()).toEqual({ jobId });
  await deliver(jobId, 'second');
  const fake = fakeProvider({ loseStory: true, reconcile: 'found', missingUsage: true });
  const first = worker(fake.provider);
  expect(await first.runNext(store)).toBe(true);
  expect(await first.runNext(store)).toBe(true);
  expect((await jobView(jobId)).json().stage).toBe('story');
  const resumed = worker(fake.provider);
  expect(await resumed.runNext(store)).toBe(true);
  expect(fake.calls.filter(stage => stage === 'story')).toHaveLength(1);
  expect(await resumed.runNext(store)).toBe(true);
  let unlock = () => {};
  let rendering = () => {};
  const paused = new Promise<void>(resolve => { unlock = resolve; });
  const started = new Promise<void>(resolve => { rendering = resolve; });
  const stale = worker(fake.provider, {
    render: async () => alternateVideo,
    files: {
      ...artifacts,
      async put(...args) {
        const fileId = await artifacts.put(...args);
        if (args[2] === 'promo_output') { rendering(); await paused; }
        return fileId;
      },
    },
  });
  const inFlight = stale.runNext(store);
  try {
    await Promise.race([started, inFlight.then(() => { throw new Error('expected the old worker to upload'); })]);
    await inStore(database, store, db => db.query(`
      UPDATE marketing.promo_job SET lease_until = clock_timestamp() - interval '1 second' WHERE job_id = $1`, [jobId]));
    expect(await resumed.runNext(store)).toBe(true);
    const result = (await jobView(jobId)).json();
    expect(result.status).toBe('done');
    unlock();
    await inFlight;
    expect((await jobView(jobId)).json()).toEqual(result);
    expect((await artifacts.read({ storeId: store, resourceId: jobId }, result.assetId)).bytes).toEqual(video);
    const attempt = await inStore(database, store, db => db.query(`
      SELECT attempt_id FROM marketing.promo_attempt
      WHERE job_id = $1 AND stage = 'story' AND state = 'received'`, [jobId]));
    expect(attempt.rows).toHaveLength(1);
    const usage = await inStore(insightDb, store, db => db.query(`
      SELECT attempt_id, outcome, latency_ms, input_tokens, output_tokens, reasoning_tokens
      FROM insight.ai_usage WHERE correlation_id = $1 AND stage = 'story'`, [jobId]));
    expect(usage.rows).toEqual([{ attempt_id: attempt.rows[0].attempt_id, outcome: 'success', latency_ms: expect.any(Number),
      input_tokens: null, output_tokens: null, reasoning_tokens: null }]);
    expect(usage.rows[0].latency_ms).toBeGreaterThanOrEqual(0);
    expect(published).toBe(2);
  } finally {
    unlock();
    await inFlight;
  }
});

test.runIf(!!redisUrl)('keeps an uncertain attempt pending until no-send is definitive and discards video that fails validation', async () => {
  const { jobId } = (await submit(card())).json();
  await deliver(jobId, 'third');
  const options: Parameters<typeof fakeProvider>[0] = { loseStory: true };
  const fake = fakeProvider(options);
  const recovering = worker(fake.provider, { render: async () => Buffer.from('invalid video fixture') });
  expect(await recovering.runNext(store)).toBe(true);
  expect(await recovering.runNext(store)).toBe(true);
  expect(await recovering.runNext(store)).toBe(true);
  expect((await jobView(jobId)).json().stage).toBe('story');
  expect(fake.calls.filter(stage => stage === 'story')).toHaveLength(1);
  options.reconcile = 'not_sent';
  expect(await recovering.runNext(store)).toBe(true);
  expect(fake.calls.filter(stage => stage === 'story')).toHaveLength(2);
  expect(await recovering.runNext(store)).toBe(true);
  expect(await recovering.runNext(store)).toBe(true);
  expect((await jobView(jobId)).json()).toMatchObject({ status: 'failed', stage: 'merge', assetId: null, result: null });
  expect((await marketing.inject({ url: `${jobsUrl()}/${jobId}/video.mp4`, headers: headers(store, readToken) })).statusCode).toBe(404);
  const states = await inStore(database, store, db => db.query(`
    SELECT attempt_no, state FROM marketing.promo_attempt WHERE job_id = $1 AND stage = 'story' ORDER BY attempt_no`, [jobId]));
  expect(states.rows).toEqual([{ attempt_no: 1, state: 'not_sent' }, { attempt_no: 2, state: 'received' }]);
});

test.runIf(!!redisUrl)('fails an unresolved promo by its deadline and lets the store enqueue again without resending', async () => {
  const { jobId } = (await submit(card())).json();
  await deliver(jobId, 'deadline');
  const { calls, provider } = fakeProvider({ loseStory: true });
  const first = worker(provider);
  expect(await first.runNext(store)).toBe(true);
  expect(await first.runNext(store)).toBe(true);
  expect(await first.runNext(store)).toBe(true);
  expect((await jobView(jobId)).json()).toMatchObject({ stage: 'story', status: 'running' });
  const nextCard = card();
  expect((await submit(nextCard)).json()).toEqual({ code: 'BUSY', activeJobId: jobId });

  const resumed = worker({
    ...provider,
    reconcile: async () => new Promise(() => {}),
  }, { reconcileWindowMs: 1_000 });
  expect(await resumed.runNext(store)).toBe(true);
  expect((await jobView(jobId)).json()).toMatchObject({ stage: 'story', status: 'failed', failReason: 'AI_TIMEOUT' });
  expect(await resumed.runNext(store)).toBe(false);
  expect(calls.filter(stage => stage === 'story')).toHaveLength(1);
  const attempts = await inStore(database, store, db => db.query(`
    SELECT attempt_no, state FROM marketing.promo_attempt WHERE job_id = $1 AND stage = 'story'`, [jobId]));
  expect(attempts.rows).toEqual([{ attempt_no: 1, state: 'pending' }]);
  expect((await submit(nextCard)).statusCode).toBe(202);
});

test.runIf(!!redisUrl)('resolves the promo catalog with the store advisory lock available', async () => {
  const { key, body } = card();
  const scope = { storeId: anotherStore, actorId: actor };
  const queued = await enqueuePromo(database, scope, key, { ...body, source: 'card' }, async () => {
    await inStore(database, anotherStore, async db => {
      const { rows: [lock] } = await db.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('marketing:' || $1, 0)) AS acquired", [anotherStore]);
      expect(lock.acquired).toBe(true);
    });
    const catalog = photoSource.listCatalog();
    return { catalog, photos: photoBindings, exterior: photoSource.photoInfo(catalog.store.exteriorPhotoId)! };
  });
  expect(queued.status).toBe('queued');
});
