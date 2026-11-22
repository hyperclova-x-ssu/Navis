import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { runner } from 'node-pg-migrate';
import type { Pool } from 'pg';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { dbConfig, dbPool } from '../../../packages/db/index.ts';
import { parseEnvelope } from '../../../packages/streams/envelope.ts';
import { RedisStreams } from '../../../packages/streams/redis.ts';
import { createPromoConsumer, promoGroup } from '../../../workers/marketing-worker/promo/events.ts';
import { dispatchTestSms, messageQueued } from '../../../workers/marketing-worker/sens/events.ts';
import { createFakeSensTransport } from '../../../workers/marketing-worker/sens/fake.ts';
import { createSensWorker } from '../../../workers/marketing-worker/sens/worker.ts';
import { inStore } from '../transaction.ts';
import type { SensPolicy } from './policy.ts';
import { registerSensRoutes, sensAttemptsPath } from './routes.ts';

const redisUrl = process.env.NAVIS_SENS_TEST_REDIS_URL;
const body = '방문해 주셔서 감사합니다.';
const number = '00000000001';
const sender = '00000000002';
const targetId = 'synthetic-test-target';

describe.skipIf(!redisUrl)('T-314 isolated Compose test-SMS ledger', () => {
  let database: Pool;
  let redis: RedisStreams;

  beforeAll(async () => {
    await runner({
      databaseUrl: dbConfig('marketing', 'migrate', 'test'),
      dir: fileURLToPath(new URL('../migrations/', import.meta.url)), direction: 'up',
      schema: 'marketing', migrationsSchema: 'marketing', migrationsTable: 'schema_migrations',
      log: () => undefined,
    });
    database = dbPool('marketing', 'runtime', 'test');
    const client = createClient({ url: redisUrl, disableOfflineQueue: true });
    await client.connect();
    redis = new RedisStreams(client);
    const rebuild = await redis.beginRebuild('marketing', [promoGroup]);
    expect(await redis.finishRebuild('marketing', rebuild)).toBe(true);
  });

  afterAll(async () => {
    redis?.close();
    await database?.end();
  });

  async function fixture(run: (env: ReturnType<typeof setup>) => Promise<void>) {
    const env = setup();
    try { await run(env); } finally { await env.app.close(); }
  }

  function setup() {
    const actorId = randomUUID();
    const storeId = randomUUID();
    const draftId = randomUUID();
    const confirmToken = randomUUID();
    const readToken = randomUUID();
    const credentials: { serviceId: string; accessKey: string; secretKey: string; senderNumber: string } = {
      serviceId: 'fixture-service', accessKey: randomUUID(), secretKey: randomUUID(), senderNumber: sender,
    };
    const target = { number, consentSms: true };
    const settings = { enabled: true, credentials, targets: new Map([[targetId, target]]) };
    const draft = { sampleId: 'sample-inquiry', sessionId: randomUUID(), expiresAt: new Date(Date.now() + 600_000),
      approved: [body, '다시 방문해 주세요.'] as readonly string[] };
    const policy: SensPolicy = {
      settingsForStore: async id => id === storeId ? settings : null,
      draftForOwner: async (scope, id) => scope.storeId === storeId && scope.actorId === actorId && id === draftId ? draft : null,
    };
    const app = Fastify();
    registerSensRoutes(app, database, { confirmToken, readToken, policy });
    const url = sensAttemptsPath.replace(':storeId', storeId);
    const headers = { 'x-navis-store-id': storeId, 'x-navis-user-id': actorId, 'x-navis-store-role': 'owner' };
    const payload = { source: 'card', proposalId: randomUUID(), snapshotRevision: 7, input: { draftId, targetId, body } };
    const submit = (value: typeof payload & { input: Record<string, unknown> } = payload,
      overrides: Record<string, string> = {}) => app.inject({
      method: 'POST', url, payload: value,
      headers: { ...headers, authorization: `Bearer ${confirmToken}`, 'idempotency-key': `navis:${value.proposalId}`, ...overrides },
    });
    const view = (receiptId: string, overrides: Record<string, string> = {}) => app.inject({
      method: 'GET', url: `${url}/${receiptId}`, headers: { ...headers, authorization: `Bearer ${readToken}`, ...overrides },
    });
    const events = () => inStore(database, storeId, async db => {
      const { rows } = await db.query(`
        SELECT event_id AS "eventId", producer, store_id AS "storeId", scope_key AS "scopeKey",
          store_seq::text AS "storeSeq", event_type AS "eventType", schema_version AS "schemaVersion",
          aggregate_id AS "aggregateId", occurred_at::text AS "occurredAt", payload
        FROM marketing.outbox ORDER BY store_seq`);
      return rows.map(row => parseEnvelope(row, 'marketing'));
    });
    const deliver = async (copies = 1, receiptId?: string) => {
      const published = await events();
      const event = receiptId ? published.find(candidate => candidate.aggregateId === receiptId)! : published[0];
      const epoch = (await redis.readyEpoch('marketing'))!;
      for (let i = 0; i < copies; i++) expect(await redis.append('marketing', epoch, event)).toBe(true);
      const consumer = createPromoConsumer({ database, redis, name: randomUUID(), handlers: { [messageQueued]: dispatchTestSms } });
      expect(await consumer.step()).toBe(copies);
      expect(await redis.pending('marketing', promoGroup)).toBe(0);
    };
    const start = async () => {
      const created = await submit();
      expect(created.statusCode).toBe(202);
      const { receiptId } = created.json();
      await deliver();
      return receiptId as string;
    };
    // Advance only the isolated ledger clock for the rolling claim limit and crash recovery.
    const age = async (receiptId: string) => {
      await inStore(database, storeId, db => db.query(`
        UPDATE marketing.sens_attempt SET first_send_at = clock_timestamp() - interval '2 minutes'
        WHERE receipt_id = $1`, [receiptId]));
    };
    const worker = (transport: Parameters<typeof createSensWorker>[1]['transport']) => createSensWorker(database, { policy, transport });
    return { app, policy, settings, target, draft, payload, submit, view, events, deliver, start, age, worker, storeId };
  }

  test('denies an unauthenticated or unconfirmed card and enforces the exact registered, consenting address and approved text', () => fixture(async env => {
    expect((await env.submit(env.payload, { authorization: 'Bearer invalid' })).statusCode).toBe(401);
    expect((await env.submit(env.payload, { 'x-navis-store-role': 'staff' })).statusCode).toBe(403);
    expect((await env.submit(env.payload, { 'x-navis-store-id': randomUUID() })).statusCode).toBe(403);
    expect((await env.submit(env.payload, { 'x-navis-user-id': randomUUID() })).statusCode).toBe(404);
    expect((await env.submit({ ...env.payload, source: 'text' })).statusCode).toBe(400);
    expect((await env.submit(env.payload, { 'idempotency-key': randomUUID() })).statusCode).toBe(400);
    expect((await env.submit({ ...env.payload, input: { ...env.payload.input, targetId: number } })).statusCode).toBe(403);
    expect((await env.submit({ ...env.payload, input: { ...env.payload.input, number } })).statusCode).toBe(400);
    expect((await env.submit({ ...env.payload, input: { ...env.payload.input, body: '가'.repeat(41) } })).statusCode).toBe(422);
    expect((await env.submit({ ...env.payload, input: { ...env.payload.input, body: 'unapproved text' } })).statusCode).toBe(422);
    env.draft.expiresAt = new Date(0);
    expect((await env.submit()).statusCode).toBe(404);
    env.draft.expiresAt = new Date(Date.now() + 600_000);
    env.target.consentSms = false;
    expect((await env.submit()).statusCode).toBe(403);
    env.target.consentSms = true;
    env.settings.enabled = false;
    expect((await env.submit()).statusCode).toBe(503);
    env.settings.enabled = true;
    env.settings.credentials.senderNumber = '';
    expect((await env.submit()).statusCode).toBe(503);
    env.settings.credentials.senderNumber = sender;
    env.settings.credentials.secretKey = '';
    expect((await env.submit()).statusCode).toBe(503);
    expect(await env.events()).toEqual([]);
  }));

  test('resolves SMS settings and draft with the store advisory lock available', () => fixture(async env => {
    const { policy, storeId } = env;
    const { settingsForStore, draftForOwner } = policy;
    const checkLock = () => inStore(database, storeId, async db => {
      const { rows: [lock] } = await db.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('marketing:' || $1, 0)) AS acquired", [storeId]);
      expect(lock.acquired).toBe(true);
    });
    policy.settingsForStore = async id => { await checkLock(); return settingsForStore(id); };
    policy.draftForOwner = async (scope, id) => { await checkLock(); return draftForOwner(scope, id); };
    expect((await env.submit()).statusCode).toBe(202);
    expect(await env.events()).toHaveLength(1);
  }));

  test('commits one private event and atomically claims concurrent deliveries across workers and restart', () => fixture(async env => {
    const provider = createFakeSensTransport({
      send: request => {
        expect({ number: request.number === number, sender: request.senderNumber === sender, body: request.body === body })
          .toEqual({ number: true, sender: true, body: true });
        return 'accepted';
      },
    });
    const [first, repeat] = await Promise.all([env.submit(), env.submit()]);
    expect([first.statusCode, repeat.statusCode]).toEqual([202, 202]);
    const { receiptId } = first.json();
    expect(repeat.json()).toEqual(first.json());
    expect(await env.worker(provider).runNext(env.storeId)).toBe(false);
    expect(provider.sendCount()).toBe(0);
    expect(await env.events()).toMatchObject([{ eventType: messageQueued, aggregateId: receiptId }]);
    expect((await env.events()).map(event => event.payload)).toEqual([{ receiptId }]);
    const conflict = await env.submit({ ...env.payload, input: { ...env.payload.input, body: '다시 방문해 주세요.' } });
    expect(conflict.statusCode).toBe(409);
    await env.deliver(2);
    const racing = await Promise.all([env.worker(provider).runNext(env.storeId), env.worker(provider).runNext(env.storeId)]);
    expect(racing.sort()).toEqual([false, true]);
    expect(await env.worker(provider).runNext(env.storeId)).toBe(false);
    expect(provider.sendCount()).toBe(1);
    const accepted = (await env.view(receiptId)).json();
    expect(accepted).toMatchObject({ receiptId, state: 'accepted', acceptance: { requestId: expect.any(String) }, delivery: { status: 'pending' } });
    expect((await env.submit()).json()).toEqual(accepted);
    expect((await env.view(receiptId, { 'x-navis-user-id': randomUUID() })).statusCode).toBe(404);
    expect((await inStore(database, randomUUID(), db => db.query('SELECT receipt_id FROM marketing.sens_attempt WHERE receipt_id=$1', [receiptId]))).rowCount).toBe(0);
    const otherOwner = await env.submit(env.payload, { 'x-navis-user-id': randomUUID() });
    expect(otherOwner.statusCode).toBe(404);
  }));

  test('reconciles a response lost after acceptance with one provider send, then records delivery independently', () => fixture(async env => {
    const receiptId = await env.start();
    const provider = createFakeSensTransport({ send: () => 'lose_after_acceptance' });
    expect(await env.worker(provider).runNext(env.storeId)).toBe(true);
    expect((await env.submit()).json()).toEqual({ receiptId, state: 'uncertain', acceptance: null, delivery: null });
    expect(await env.worker(provider).runNext(env.storeId)).toBe(false);
    await env.worker(provider).reconcile(env.storeId, receiptId);
    const accepted = (await env.view(receiptId)).json();
    expect(accepted).toMatchObject({ state: 'accepted', acceptance: { requestId: expect.any(String) }, delivery: { status: 'pending' } });
    await env.worker(provider).reconcile(env.storeId, receiptId);
    expect((await env.view(receiptId)).json()).toEqual(accepted);
    provider.setDelivery(accepted.acceptance.requestId, 'delivered');
    await env.worker(provider).reconcile(env.storeId, receiptId);
    const delivered = (await env.view(receiptId)).json();
    expect(delivered).toMatchObject({ acceptance: accepted.acceptance, delivery: { status: 'delivered', recordedAt: expect.any(String) } });
    expect((await env.submit()).json()).toEqual(delivered);
    expect(provider.sendCount()).toBe(1);
  }));

  test('retains a request ID from an ambiguous response and rules out retry while it exists', () => fixture(async env => {
    const receiptId = await env.start();
    const provider = createFakeSensTransport({ send: () => 'unknown_with_request_id' });
    await env.worker(provider).runNext(env.storeId);
    const requestId = await inStore(database, env.storeId, async db => {
      const { rows: [row] } = await db.query<{ provider_request_id: string }>(
        'SELECT provider_request_id FROM marketing.sens_attempt WHERE receipt_id = $1', [receiptId]);
      return row.provider_request_id;
    });
    expect(requestId).toMatch(/^fake-/);
    const contradictory = env.worker({ ...provider, reconcile: async () => ({ state: 'not_sent' }) });
    await contradictory.reconcile(env.storeId, receiptId);
    expect(await contradictory.runNext(env.storeId)).toBe(false);
    expect((await env.view(receiptId)).json().state).toBe('uncertain');
    await env.worker(provider).reconcile(env.storeId, receiptId);
    expect((await env.view(receiptId)).json()).toMatchObject({ state: 'accepted', acceptance: { requestId } });
    expect(provider.sendCount()).toBe(1);
  }));

  test('enforces one sample per draft session and the stored minute and day budgets', () => fixture(async env => {
    const provider = createFakeSensTransport();
    const worker = env.worker(provider);
    await env.start();
    await worker.runNext(env.storeId);
    const newCard = () => ({ ...env.payload, proposalId: randomUUID() });
    expect((await env.submit(newCard())).statusCode).toBe(409);
    env.draft.sampleId = 'second-sample';
    const minuteLimited = await env.submit(newCard());
    expect(minuteLimited.statusCode).toBe(429);
    expect(Number(minuteLimited.headers['retry-after'])).toBeGreaterThan(0);

    const migrationRole = dbPool('marketing', 'migrate', 'test');
    try {
      const backdate = () => inStore(migrationRole, env.storeId, db => db.query(`
        UPDATE marketing.sens_attempt SET created_at=created_at - interval '2 minutes',
          first_send_at=first_send_at - interval '2 minutes' WHERE store_id=$1`, [env.storeId]));
      for (const sampleId of ['second-sample', 'third-sample']) {
        await backdate();
        env.draft.sampleId = sampleId;
        const accepted = await env.submit(newCard());
        expect(accepted.statusCode).toBe(202);
        await env.deliver(1, accepted.json().receiptId);
        expect(await worker.runNext(env.storeId)).toBe(true);
      }
      await backdate();
    } finally {
      await migrationRole.end();
    }
    env.draft.sampleId = 'fourth-sample';
    const dayLimited = await env.submit(newCard());
    expect(dayLimited.statusCode).toBe(429);
    expect(Number(dayLimited.headers['retry-after'])).toBeGreaterThan(23 * 60 * 60);
    expect(provider.sendCount()).toBe(3);
    expect(await env.events()).toHaveLength(3);
  }));

  test('waits for a definitive no-send and the rolling limit before one revalidated retry', () => fixture(async env => {
    let fenced = false;
    const provider = createFakeSensTransport({
      send: () => fenced ? 'accepted' : 'unknown',
      fenceUnknown: () => fenced,
    });
    const receiptId = await env.start();
    await env.worker(provider).runNext(env.storeId);
    await env.worker(provider).reconcile(env.storeId, receiptId);
    expect((await env.submit()).json().state).toBe('uncertain');
    expect(await env.worker(provider).runNext(env.storeId)).toBe(false);
    fenced = true;
    await env.worker(provider).reconcile(env.storeId, receiptId);
    expect((await env.submit()).json().state).toBe('retryable');
    expect(await env.worker(provider).runNext(env.storeId)).toBe(false);
    await env.age(receiptId);
    expect(await env.worker(provider).runNext(env.storeId)).toBe(true);
    expect((await env.submit()).json().state).toBe('accepted');
    expect(provider.sendCount()).toBe(2);
  }));

  test('blocks the retry if the alias resolves to a different number after the claim', () => fixture(async env => {
    const provider = createFakeSensTransport({ send: () => 'unknown', fenceUnknown: () => true });
    const receiptId = await env.start();
    await env.worker(provider).runNext(env.storeId);
    await env.worker(provider).reconcile(env.storeId, receiptId);
    await env.age(receiptId);
    env.target.number = '00000000003';
    expect(await env.worker(provider).runNext(env.storeId)).toBe(false);
    expect((await env.submit()).json().state).toBe('blocked');
    expect(provider.sendCount()).toBe(1);
  }));

  test('reconciles an abandoned claim conservatively and never sends it again on a plain restart', () => fixture(async env => {
    const receiptId = await env.start();
    const provider = createFakeSensTransport();
    const token = randomUUID();
    await inStore(database, env.storeId, db => db.query(`
      UPDATE marketing.sens_attempt SET state='sending', send_token=$2, first_send_at=clock_timestamp()
      WHERE receipt_id=$1`, [receiptId, token]));
    expect(await env.worker(provider).runNext(env.storeId)).toBe(false);
    await env.worker(provider).reconcile(env.storeId, receiptId);
    expect((await env.submit()).json().state).toBe('sending');
    await env.age(receiptId);
    await env.worker(provider).reconcile(env.storeId, receiptId);
    expect((await env.submit()).json().state).toBe('uncertain');
    expect(provider.sendCount()).toBe(0);
  }));
});
