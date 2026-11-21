import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { runner } from 'node-pg-migrate';
import type { Pool } from 'pg';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { dbConfig, dbPool } from '../../packages/db/index.ts';
import { transact } from '../../packages/streams/transaction.ts';
import { RedisStreams } from '../../packages/streams/redis.ts';
import type { StreamEnvelope } from '../../packages/streams/index.ts';
import { createInsightApp } from './app.ts';
import { createInsightSalesConsumer } from './sales.ts';
import { registerCamera } from './cctv.ts';
import { navisAgentFakeFetch } from '../../../frontend/server/fixtures/navis-eval-fake.mjs';

const storeId = randomUUID();
const otherStoreId = randomUUID();
const actorId = randomUUID();
const token = () => randomBytes(32).toString('base64url');
const gatewayToken = token();
const promoToken = token();
const marketingToken = token();
const forecastToken = token();
const deviceToken = token();
const cameraId = randomUUID();
const zoneId = randomUUID();
const paths = '/internal/v1/insight/stores/';
const root = paths + storeId;
const now = () => new Date('2026-11-17T06:45:00Z');
const day = '2026-11-17';
const forecastHeaders = { authorization: `Bearer ${forecastToken}`, 'x-navis-store-id': storeId };
const owner = {
  authorization: `Bearer ${gatewayToken}`, 'x-navis-store-id': storeId,
  'x-navis-user-id': actorId, 'x-navis-store-role': 'owner', 'x-navis-protocol': 'agent-v1',
};
const agent = {
  conversation: true, runId: 't311-run', snapshotRevision: 7, locale: 'en', layer: 'marketing',
  businessDate: day, slots: [], catalog: [], snapshot: [], searches: [],
};
const promoDraft = {
  menuIds: ['m1'], photoIds: ['p1', 'p2', 'p3', 'p4', 'p5'], concepts: ['new-item'],
  moods: ['clean'], lengthSec: 15, locale: 'en', referenceId: 'ref-1', memo: '',
};
const { menuIds, photoIds, moods, concepts, memo, ...promoEnums } = promoDraft;
const actionSlots = { menuIds, photoIds, moods, concepts, memo };
const wireArgs = { ...promoEnums, ...Object.fromEntries(Object.keys(actionSlots).map(key => [key, { slot: key }])) };
const decode = (sse: string, event: string) => sse.split('\n\n').flatMap(frame => {
  const [kind, data] = frame.split('\n');
  return kind === `event: ${event}` && data?.startsWith('data: ') ? [JSON.parse(data.slice(6))] : [];
});
const calls: Array<{ store: unknown; actor: unknown; body: unknown; key: unknown }> = [];
const domain = Fastify();
let runtime: Pool;
let app: ReturnType<typeof createInsightApp>;
let retry = true;
let outbound = 0;
let revision = 7;
let loseResponse = false;
const domainJobs = new Map<string, string>();

beforeAll(async () => {
  // The shared migration-runner test owns insight.schema_migrations on test-db.
  await runner({
    databaseUrl: dbConfig('insight', 'migrate', 'test'),
    dir: fileURLToPath(new URL('./migrations/', import.meta.url)),
    schema: 'insight',
    migrationsSchema: 'insight',
    migrationsTable: 't311_test_migrations',
    direction: 'up',
    verbose: false,
    log: message => process.stdout.write(`[insight] ${message}\n`),
  });
  const migrate = dbPool('insight', 'migrate', 'test');
  try {
    await registerCamera(migrate, {
      storeId, cameraId, zoneRevision: 4, zoneIds: [zoneId], deviceId: randomUUID(),
      token: deviceToken, expiresAt: new Date('2026-11-18T00:00:00Z'),
    });
  } finally {
    await migrate.end();
  }
  domain.post<{ Params: { storeId: string }; Body: { snapshotRevision: number } }>(
    '/internal/v1/marketing/stores/:storeId/promo/jobs', async (req, reply) => {
      if (req.headers.authorization !== `Bearer ${marketingToken}`) return reply.code(401).send();
      calls.push({ store: req.params.storeId, actor: req.headers['x-navis-user-id'],
        body: req.body, key: req.headers['idempotency-key'] });
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string') return reply.code(400).send();
      const saved = domainJobs.get(key);
      if (saved) return reply.code(200).send({ jobId: saved });
      if (req.body.snapshotRevision !== revision) return reply.code(409).send({ code: 'STALE_SNAPSHOT' });
      const jobId = randomUUID();
      domainJobs.set(key, jobId);
      if (loseResponse) {
        loseResponse = false;
        reply.hijack();
        reply.raw.destroy();
        return;
      }
      return reply.code(202).send({ jobId });
    },
  );
  const address = await domain.listen({ host: '127.0.0.1', port: 0 });
  runtime = dbPool('insight', 'runtime', 'test');
  app = createInsightApp(runtime, {
    gatewayToken, promoToken, forecastToken, now, logging: false,
    marketing: { baseUrl: address, token: marketingToken },
    provider: { mode: 'fixture', fetch: async (url, init) => {
      outbound++;
      const prompt = init.body;
      expect(prompt).not.toContain(promoDraft.photoIds[0]);
      expect(prompt).not.toContain(promoDraft.menuIds[0]);
      if (retry) {
        retry = false;
        return Response.json({ status: { code: '42901' } }, { status: 429, headers: { 'retry-after': '0' } });
      }
      const response = await navisAgentFakeFetch(url, init);
      const text = await response.text();
      const data = JSON.parse(text.split('data: ')[1].trim());
      return new Response(`event: result\ndata: ${JSON.stringify({
        ...data, usage: { promptTokens: 21, completionTokens: 5, totalTokens: 26 },
      })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } },
  });
});

afterAll(async () => {
  await app?.close();
  await domain.close();
  await runtime?.end();
});

async function scoped<T>(run: Parameters<typeof transact<T>>[1]) {
  return transact(runtime, async db => {
    await db.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
    return run(db);
  });
}

async function prepare() {
  const response = await app.inject({
    method: 'POST', url: root + '/navis/chat', headers: owner,
    payload: { turn: { ...agent, slots: Object.keys(actionSlots),
      intent: { kind: 'command', command: 'video.make', args: wireArgs } }, actionSlots },
  });
  expect(response.statusCode).toBe(200);
  expect(decode(response.body, 'done')).toEqual([{ outcome: 'proposal' }]);
  return decode(response.body, 'action_proposal')[0];
}

describe('T-311 local Insight acceptance', () => {
  test('completes a typed SSE read and meters both outbound calls when the first lacks usage', async () => {
    const response = await app.inject({ method: 'POST', url: root + '/navis/chat', headers: owner,
      payload: { ...agent, layer: 'management', intent: { kind: 'read', sourceId: 'pos' } } });
    expect(response.statusCode).toBe(200);
    expect(decode(response.body, 'done')).toEqual([{ outcome: 'reply' }]);
    const usage = await scoped(db => db.query(
      `SELECT outcome, input_tokens::int, output_tokens::int, reasoning_tokens, latency_ms
       FROM insight.ai_usage WHERE feature='navis' ORDER BY recorded_at, attempt_id`));
    expect(usage.rows).toHaveLength(outbound);
    expect(usage.rows[0]).toMatchObject({ outcome: 'rate_limited', input_tokens: null, output_tokens: null, reasoning_tokens: null });
    expect(usage.rows[1]).toMatchObject({ outcome: 'success', input_tokens: 21, output_tokens: 5, reasoning_tokens: null });
    expect(usage.rows[0].latency_ms).toBeGreaterThanOrEqual(0);
    expect(await runtime.query('SELECT 1 FROM insight.ai_usage')).toMatchObject({ rowCount: 0 });
    expect(calls).toHaveLength(0);
  });

  test('prepares a card, ignores conversational confirmation, and dispatches exactly one scoped marketing action', async () => {
    const proposal = await prepare();
    expect(proposal).toMatchObject({ snapshotRevision: 7, command: 'video.make', args: wireArgs });
    const response = await app.inject({ method: 'POST', url: root + '/navis/chat', headers: owner,
      payload: { ...agent, intent: { kind: 'conversation', action: 'confirm', pendingId: proposal.proposalId } } });
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(0);
    const url = root + `/navis/proposals/${proposal.proposalId}/confirm`;
    const payload = { source: 'card', snapshotRevision: 7, runId: agent.runId };
    const confirm = (headers = owner, body = payload, target = url) => app.inject({ method: 'POST', url: target, headers, payload: body });
    expect((await confirm(owner, { ...payload, source: 'text' })).statusCode).toBe(400);
    expect((await confirm(owner, { ...payload, snapshotRevision: 8 })).statusCode).toBe(409);
    expect((await confirm({ ...owner, 'x-navis-store-role': 'staff' })).statusCode).toBe(403);
    expect((await confirm({ ...owner, 'x-navis-user-id': randomUUID() })).statusCode).toBe(404);
    expect((await confirm({ ...owner, 'x-navis-store-id': otherStoreId }, payload, url.replace(storeId, otherStoreId))).statusCode).toBe(404);
    const [first, second] = await Promise.all([confirm(), confirm()]);
    expect(first.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    expect(calls).toEqual([{
      store: storeId, actor: actorId, key: `navis:${proposal.proposalId}`,
      body: { proposalId: proposal.proposalId, snapshotRevision: 7, input: promoDraft, source: 'card' },
    }]);
  });

  test('preserves a stale-domain response at the card boundary', async () => {
    const proposal = await prepare();
    revision++;
    try {
      const response = await app.inject({ method: 'POST', url: root + `/navis/proposals/${proposal.proposalId}/confirm`,
        headers: owner, payload: { source: 'card', snapshotRevision: 7, runId: agent.runId } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code: 'STALE_SNAPSHOT' });
    } finally {
      revision--;
    }
  });

  test('recovers the original marketing job after losing the response to a confirmed card', async () => {
    const proposal = await prepare();
    const key = `navis:${proposal.proposalId}`;
    const confirm = () => app.inject({ method: 'POST', url: root + `/navis/proposals/${proposal.proposalId}/confirm`,
      headers: owner, payload: { source: 'card', snapshotRevision: 7, runId: agent.runId } });
    loseResponse = true;
    expect((await confirm()).statusCode).toBe(503);
    expect(domainJobs.has(key)).toBe(true);
    const repeated = await confirm();
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json()).toEqual({ jobId: domainJobs.get(key) });
    expect(calls.slice(-2).map(call => call.key)).toEqual([key, key]);
  });

  test('accepts promo attempt metrics idempotently and leaves missing usage and reservations out of token counts', async () => {
    const url = root + '/ai/usage';
    const headers = { authorization: `Bearer ${promoToken}`, 'x-navis-store-id': storeId };
    const attempt = { attemptId: randomUUID(), correlationId: randomUUID(), stage: 'scene_plan',
      model: 'HCX-007', mode: 'structured_outputs', latencyMs: 17, outcome: 'success',
      inputTokens: 10, outputTokens: 3, reasoningTokens: null };
    const post = (payload: object, requestHeaders = headers) => app.inject({ method: 'POST', url, headers: requestHeaders, payload });
    expect((await post(attempt, forecastHeaders)).statusCode).toBe(401);
    expect((await post(attempt)).statusCode).toBe(201);
    expect((await post(attempt)).statusCode).toBe(200);
    expect((await post({ ...attempt, inputTokens: 11 })).statusCode).toBe(409);
    expect((await post({ ...attempt, attemptId: randomUUID(), reservedTokens: 120 })).statusCode).toBe(400);
    expect((await post({ ...attempt, attemptId: randomUUID(), reasoningTokens: 8 })).statusCode).toBe(400);
    expect((await post({ ...attempt, attemptId: randomUUID(), mode: 'text', reasoningTokens: 2 })).statusCode).toBe(201);
    const { inputTokens, outputTokens, reasoningTokens, ...withoutUsage } = attempt;
    expect((await post({ ...withoutUsage, attemptId: randomUUID(), outcome: 'rate_limited' })).statusCode).toBe(201);
    expect((await scoped(db => db.query(`SELECT count(*)::int AS count, count(input_tokens)::int AS reported,
      sum(reasoning_tokens)::int AS reasoning FROM insight.ai_usage WHERE feature='promo'`))).rows)
      .toEqual([{ count: 3, reported: 2, reasoning: 2 }]);
  });

  test.skipIf(!process.env.NAVIS_INSIGHT_TEST_REDIS_URL)('commits projected sale and correction before ACK and ignores replays', async () => {
    const client = createClient({ url: process.env.NAVIS_INSIGHT_TEST_REDIS_URL, disableOfflineQueue: true });
    await client.connect();
    const redis = new RedisStreams(client);
    try {
      const epoch = await redis.beginRebuild('pos', ['insight']);
      expect(await redis.finishRebuild('pos', epoch)).toBe(true);
      const readyEpoch = (await redis.readyEpoch('pos'))!;
      const saleId = randomUUID();
      const correctionId = randomUUID();
      const allocationId = randomUUID();
      const menuId = randomUUID();
      const line = { menuId, allocationId, orderLineId: randomUUID(), recipeVersion: 'fixture', options: [], quantity: 2 };
      const first: StreamEnvelope = {
        producer: 'pos', storeId, scopeKey: storeId, schemaVersion: 1, eventId: randomUUID(), storeSeq: '1',
        eventType: 'pos.sale_recognized.v1', aggregateId: saleId, occurredAt: '2026-11-16T20:20:00Z',
        payload: { billId: randomUUID(), orderId: randomUUID(), paymentId: randomUUID(), settlementId: saleId,
          businessDate: day, lines: [line], amount: 6000, cost: null, incompleteMarginCoverage: true },
      };
      const correction: StreamEnvelope = { ...first, eventId: randomUUID(), storeSeq: '2', aggregateId: correctionId,
        eventType: 'pos.sale_corrected.v1', occurredAt: '2026-11-17T06:30:00Z',
        payload: { ...first.payload, lines: [{ ...line, quantity: 1 }], correctionId, kind: 'cancel',
          target: 'recognized_sale', usageEffect: 'restore', amountDelta: -3000, costDelta: null } };
      const refundId = randomUUID();
      const refund: StreamEnvelope = { ...correction, eventId: randomUUID(), storeSeq: '3', aggregateId: refundId,
        payload: { ...correction.payload, correctionId: refundId, kind: 'refund', usageEffect: 'keep',
          lines: [{ ...line, quantity: 0 }], amountDelta: -500 } };
      await redis.append('pos', readyEpoch, first);
      await redis.append('pos', readyEpoch, correction);
      await redis.append('pos', readyEpoch, refund);
      const consumer = createInsightSalesConsumer(runtime, redis, 't311-a', { reclaimIdleMs: 1, afterCommit: async () => {
        const read = await app.inject({ url: root + `/sales?from=${day}&to=${day}`, headers: forecastHeaders });
        expect(read.json().hours).toEqual([{ businessDate: day, saleHour: 5, netSales: 6000 }]);
        const checkpoint = await scoped(async db => {
          await db.query("SELECT set_config('app.stream_scope', $1, true)", [storeId]);
          return db.query('SELECT last_seq FROM insight.stream_checkpoint');
        });
        expect(checkpoint.rows).toEqual([{ last_seq: '1' }]);
        throw new Error('simulated stop before ACK');
      } });
      await expect(consumer.step()).rejects.toThrow('simulated stop before ACK');
      expect(await redis.pending('pos', 'insight')).toBe(3);
      await delay(10);
      const restarted = createInsightSalesConsumer(runtime, redis, 't311-b', { reclaimIdleMs: 1 });
      await restarted.step();
      await redis.append('pos', readyEpoch, first);
      await redis.append('pos', readyEpoch, correction);
      await redis.append('pos', readyEpoch, { ...correction, eventId: randomUUID(), storeSeq: '4' });
      await restarted.step();
      expect(await redis.pending('pos', 'insight')).toBe(0);
      const read = await app.inject({ url: root + `/sales?from=${day}&to=${day}`, headers: forecastHeaders });
      expect(read.json()).toEqual({
        days: [{ businessDate: day, netSales: 2500, menu: [{ menuId, quantity: 1 }] }],
        hours: [{ businessDate: day, saleHour: 5, netSales: 2500 }],
      });
      expect((await app.inject({ url: paths + otherStoreId + `/sales?from=${day}&to=${day}`, headers: forecastHeaders })).statusCode).toBe(403);
      const empty = await app.inject({ url: paths + otherStoreId + `/sales?from=${day}&to=${day}`,
        headers: { ...forecastHeaders, 'x-navis-store-id': otherStoreId } });
      expect(empty.json()).toEqual({ days: [], hours: [] });
      const chat = await app.inject({ method: 'POST', url: root + '/navis/chat', headers: owner,
        payload: { ...agent, layer: 'management', intent: { kind: 'read', sourceId: 'pos' },
          snapshot: [{ sourceId: 'pos', candidateAllowed: false, condition: { kind: 'default' },
            facts: [{ key: 'ledger.sales.net', label: 'Net sales', value: 999, display: '999', unit: 'KRW' }] }] } });
      expect(decode(chat.body, 'done')).toEqual([{ outcome: 'reply' }]);
      const answer = decode(chat.body, 'text_delta').map(frame => frame.delta).join('');
      expect(answer).toContain('2,500');
      expect(answer).not.toContain('999');
    } finally { redis.close(); }
  });

  test('accepts only closed registered CCTV buckets and distinguishes zero from unmeasured for briefing', async () => {
    const url = '/internal/v1/insight/cctv/aggregates';
    const headers = { authorization: `Bearer ${deviceToken}` };
    const payload = { schema_version: 1, camera_id: cameraId, zone_set_revision: 4,
      bucket_start: '2026-11-17T06:35:00Z', bucket_minutes: 5, observed_until: '2026-11-17T06:40:00Z',
      status: 'ok', avg_in_store: 0, max_in_store: 0,
      entries: [{ zone_version_id: zoneId, occupied_seconds: 0, finished_sessions: 0, finished_seconds_sum: 0, to_clear_events: 0 }] };
    const post = (body: object, requestHeaders = headers) => app.inject({ method: 'POST', url, headers: requestHeaders, payload: body });
    expect((await post(payload, owner)).statusCode).toBe(401);
    expect((await post({ ...payload, store_id: otherStoreId })).statusCode).toBe(400);
    expect((await post({ ...payload, camera_id: randomUUID() })).statusCode).toBe(403);
    expect((await post({ ...payload, zone_set_revision: 5 })).statusCode).toBe(409);
    expect((await post({ ...payload, entries: [{ ...payload.entries[0], zone_version_id: randomUUID() }] })).statusCode).toBe(409);
    expect((await post({ ...payload, bucket_start: '2026-11-17T06:45:00Z', observed_until: '2026-11-17T06:50:00Z' })).statusCode).toBe(400);
    expect((await post(payload)).statusCode).toBe(201);
    expect((await post({ ...payload, bucket_start: '2026-11-17T06:35:00.000Z' })).statusCode).toBe(200);
    expect((await post({ ...payload, max_in_store: 1 })).statusCode).toBe(409);
    expect((await post({ ...payload, bucket_start: '2026-11-17T06:40:00Z', observed_until: '2026-11-17T06:40:00Z',
      status: 'none', avg_in_store: null, max_in_store: null, entries: [] })).statusCode).toBe(201);
    const read = await app.inject({ method: 'GET', url: root + '/briefing/cctv', headers: owner });
    expect(read.json()).toMatchObject({ buckets: [
      { status: 'none', avg_in_store: null, max_in_store: null, entries: [] },
      { status: 'ok', avg_in_store: 0, max_in_store: 0, entries: payload.entries },
    ] });
  });
});
