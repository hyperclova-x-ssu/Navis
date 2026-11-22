import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createClient } from 'redis';
import { checkVideo } from '../../../frontend/server/promo/recorder.mjs';
import { PHOTO_META, fakeSpawn, refs, resultLine, sceneHtml, validStory } from '../../../frontend/server/promo/test/helpers.mjs';
import { disposableReplayClock } from '../../packages/contracts/replay-clock.ts';
import { dbPool, fileSecret, readSecret, requiredEnv } from '../../packages/db/index.ts';
import { virtualSigningClock } from '../../packages/naver/config/clock.ts';
import { RedisStreams } from '../../packages/streams/redis.ts';
import { createFixtureSms, fixtureStore } from '../../services/marketing/app.ts';
import { createMarketingProvider } from '../../services/marketing/naver/index.ts';
import type { CatalogSnapshot, PromoInput } from '../../services/marketing/promo/contracts.ts';
import { inStore } from '../../services/marketing/transaction.ts';
import { createSensWire } from './naver/pn13-sens.ts';
import { createNoticeSmsWorker, noticeSmsOperations } from './notice/sms.ts';
import { createArtifactClient, createUsageClient } from './promo/clients.ts';
import { createPromoConsumer } from './promo/events.ts';
import { createFakePromoProvider } from './promo/providers.ts';
import { createPromoWorker } from './promo/worker.ts';
import { dispatchTestSms, messageQueued } from './sens/events.ts';
import type { FakeSensTransport, ProviderOutcome } from './sens/transport.ts';
import { createSensWorker } from './sens/worker.ts';
import { createSupplierWorker } from './supplier/index.ts';

const clip = fileURLToPath(new URL('../../../frontend/server/promo/references/ref-1/preview.mp4', import.meta.url));

function createFixturePromoProvider(database: Pool, storeId: string) {
  const captions = {
    ko: ['오늘의 메뉴', '준비한 한 잔', '가게에서 만나요'],
    en: ['Today’s menu', 'Freshly prepared', 'See you at the shop'],
    'zh-Hans': ['今日菜单', '新鲜制作', '店里见'],
    'zh-Hant': ['今日菜單', '新鮮製作', '店裡見'],
  } as const;
  async function approvedContext(attemptId: string) {
    const { rows: [row] } = await inStore(database, storeId, db => db.query<{
      input: PromoInput; catalog: CatalogSnapshot['catalog'];
    }>(`
      SELECT job.input, job.catalog_snapshot->'catalog' AS catalog
      FROM marketing.promo_attempt attempt JOIN marketing.promo_job job USING (store_id, job_id)
      WHERE attempt.store_id=$1 AND attempt.attempt_id=$2`, [storeId, attemptId]));
    if (!row) throw new Error('FAKE promo attempt has no approved context');
    return row;
  }
  async function renderInput(attemptId: string) {
    const { input, catalog } = await approvedContext(attemptId);
    const { name, location, exteriorPhotoId } = catalog.store;
    const [first, second] = input.photoIds;
    const copy = captions[input.locale];
    const original = validStory();
    const photos = [first, second, exteriorPhotoId];
    const texts = original.texts.map((entry, index) => ({
      ...entry, text: index === 3 ? name : index === 4 ? location : copy[index],
    }));
    const scenes = original.scenes.map((scene, index) => ({ ...scene, photoIds: [photos[index]] }));
    const htmlText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    let html = sceneHtml({ s1Photo: first, s2Photo: second, storeName: htmlText(name), storeLocation: htmlText(location) })
      .replaceAll('store-exterior', exteriorPhotoId);
    for (const [index, text] of original.texts.slice(0, 3).entries()) html = html.replaceAll(text.text, htmlText(copy[index]));
    return { story: { scenes, texts, ending: original.ending }, html };
  }
  return createFakePromoProvider({
    env: { NAVIS_PROMO_SCENE_PROVIDER: process.env.NAVIS_PROMO_SCENE_PROVIDER },
    naverFetch: (stage, attemptId) => async () => {
      let content: unknown = { ...PHOTO_META, subject: 'Menu photo', items: [], flavors: [], captionHints: [] };
      if (stage !== 'look') {
        const approved = await renderInput(attemptId);
        content = stage === 'story' ? approved.story : { html: approved.html };
      }
      return Response.json({ status: { code: '20000' }, result: {
        finishReason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) },
        usage: { promptTokens: 5, completionTokens: 2 },
      } });
    },
    claudeSpawn(attemptId) {
      const spawn = fakeSpawn(async () => {
        try {
          return { stdout: resultLine({ html: (await renderInput(attemptId)).html }) };
        } catch {
          return { code: 1 };
        }
      });
      return spawn as unknown as ReturnType<Parameters<typeof createFakePromoProvider>[0]['claudeSpawn']>;
    },
  });
}

// Persist fake provider acceptance independently of the send ledger so it can
// lose the response and still recognize the same dispatch across worker restarts.
function createFixtureSmsTransport(directory: string): FakeSensTransport {
  async function receipt(dispatchId: string) {
    const file = join(directory, dispatchId + '.json');
    try {
      return JSON.parse(await readFile(file, 'utf8')) as { requestId: string; acceptedAt: number };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    }
  }
  return {
    kind: 'fake',
    async send({ dispatchId }, signal) {
      signal.throwIfAborted();
      const pending = await mkdtemp(join(directory, 'send-'));
      try {
        const file = join(pending, 'receipt.json');
        await writeFile(file, JSON.stringify({ requestId: `fake-${randomUUID()}`, acceptedAt: Date.now() }));
        try { await link(file, join(directory, dispatchId + '.json')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } finally { await rm(pending, { recursive: true, force: true }); }
      throw new DOMException('Fake response lost after acceptance', 'TimeoutError');
    },
    async reconcile({ dispatchId, requestId }, signal): Promise<ProviderOutcome> {
      signal.throwIfAborted();
      const found = await receipt(dispatchId);
      const age = found ? Date.now() - found.acceptedAt : 0;
      if (!found || (requestId && requestId !== found.requestId) || age < 3_000) return { state: 'unknown' };
      return { state: 'accepted', requestId: found.requestId, delivery: age >= 6_000 ? 'delivered' : undefined };
    },
  };
}

async function main() {
  if (process.env.NAVIS_PHASE3_FIXTURES !== '1') throw new Error('The local marketing worker requires fake providers');
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  const redis = createClient({
    url: requiredEnv('NAVIS_REDIS_URL'), username: 'marketing-worker', password: fileSecret('NAVIS_MARKETING_REDIS_PASSWORD_FILE'),
    disableOfflineQueue: true, commandOptions: { timeout: 3_000 }, socket: { connectTimeout: 2_000 },
  });
  redis.on('error', () => console.error('Marketing Streams connection unavailable'));
  const streams = new RedisStreams(redis);
  const database = dbPool('marketing', 'worker');
  database.on('error', () => console.error('Marketing database connection unavailable'));
  const scratch = await mkdtemp(join(tmpdir(), 'navis-fixture-'));
  try {
    const ffprobe = join(scratch, 'fake-ffprobe');
    const ffmpeg = join(scratch, 'fake-ffmpeg');
    await writeFile(ffprobe, [
      '#!/bin/sh', 'for media do :; done',
      `cmp -s "$media" "${clip}" || exit 1`,
      'printf \'{"format":{"duration":10},"streams":[{"codec_type":"video","codec_name":"h264","width":720,"height":1280,"r_frame_rate":"30/1"},{"codec_type":"audio","codec_name":"aac"}]}\\n\'',
      '',
    ].join('\n'), { mode: 0o700 });
    await writeFile(ffmpeg, '#!/bin/sh\nprintf "lavfi.signalstats.YAVG=80\\n"\n', { mode: 0o700 });
    const storeId = fixtureStore;
    const promo = createPromoWorker({
      database, provider: createFixturePromoProvider(database, storeId), references: refs, music: [], musicDir: scratch,
      artifacts: createArtifactClient({ baseUrl: requiredEnv('NAVIS_ACCOUNT_BASE_URL'),
        token: fileSecret('NAVIS_MARKETING_ACCOUNT_TOKEN_FILE') }),
      meter: createUsageClient({ baseUrl: requiredEnv('NAVIS_INSIGHT_BASE_URL'), token: fileSecret('NAVIS_PROMO_INSIGHT_TOKEN_FILE') }),
      checkScene: async () => ({ violations: [], checkMs: 0 }),
      renderVideo: async ({ outFile }) => copyFile(clip, outFile),
      checkVideo: ({ file, lengthSec }) =>
        checkVideo({ file, lengthSec, ffmpeg: { ffprobe, ffmpeg }, rules: refs.rules, width: 720, height: 1280, expectAudio: true }),
      onError: code => console.error(code),
    });
    const sms = createSensWorker(database, {
      policy: createFixtureSms(fileSecret('NAVIS_FIXTURE_SMS_KEY_FILE'), process.env.NAVIS_FIXTURE_SMS_ENABLED === '1').policy,
      transport: createFixtureSmsTransport(requiredEnv('NAVIS_FIXTURE_SMS_STATE_DIR')),
    });
    const consumer = createPromoConsumer({ database, redis: streams, name: randomUUID(), handlers: {
      async [messageQueued](db, event) {
        const { couponId, codeId, kind, reminderId } = event.payload;
        // Coupon and reminder messages remain queued while A6 is off.
        if (typeof couponId === 'string' && ((kind === 'coupon' && typeof codeId === 'string' && couponId === event.aggregateId)
          || (kind === 'reminder' && reminderId === event.aggregateId))) return;
        await dispatchTestSms(db, event);
      },
    } });
    const supplierUrl = process.env.NAVIS_SUPPLIER_INVENTORY_URL;
    const supplierTokenFile = process.env.NAVIS_MARKETING_WORKER_INVENTORY_TOKEN_FILE;
    if (Boolean(supplierUrl) !== Boolean(supplierTokenFile)) throw new Error('Incomplete supplier dispatch settings');
    const noticeUrl = process.env.NAVIS_MARKETING_BASE_URL;
    const noticeTokenFile = process.env.NAVIS_MARKETING_SMS_WORKER_TOKEN_FILE;
    if (Boolean(noticeUrl) !== Boolean(noticeTokenFile)) throw new Error('Incomplete notice SMS dispatch settings');
    const virtual = supplierUrl || noticeUrl ? (() => {
      const directory = requiredEnv('NAVIS_NAVER_VIRTUAL_PROVIDER_CREDENTIALS_DIR');
      const file = (name: string) => join(directory, `nvirtual_${name}`);
      const credentials = new Map([['sms', file('sms_id')], ['mail', file('mail_id')]]);
      return {
        file,
        provider: {
          storeId: requiredEnv('NAVIS_NAVER_VIRTUAL_STORE_ID'), providerAccount: requiredEnv('NAVIS_NAVER_VIRTUAL_ACCOUNT_ID'),
          virtualOrigin: requiredEnv('NAVIS_NAVER_VIRTUAL_ORIGIN'), privateTokenFile: requiredEnv('NAVIS_NAVER_VIRTUAL_TOKEN_FILE'),
          now: virtualSigningClock(),
          readCredential(path: string) {
            for (const [product, id] of credentials) {
              if (path === id) return JSON.stringify({ accessKey: readSecret(id), secretKey: readSecret(file(`${product}_key`)) });
            }
            return readSecret(path);
          },
        },
      };
    })() : undefined;
    const supplier = supplierUrl && supplierTokenFile && virtual ? createSupplierWorker({
      inventoryUrl: new URL(supplierUrl), token: readSecret(supplierTokenFile), database, redis: streams, name: randomUUID(),
      provider: { ...virtual.provider, operationCredentialFiles: {
        'pn13.sms.send': virtual.file('sms_id'), 'pn13.sms.list': virtual.file('sms_id'),
        'pn13.mail.send': virtual.file('mail_id'), 'pn13.mail.request': virtual.file('mail_id'),
      } },
      serviceIds: { sms: readSecret(virtual.file('sms_service')), mail: readSecret(virtual.file('mail_service')) },
      senderNumber: readSecret(virtual.file('sms_sender')), senderAddress: readSecret(virtual.file('mail_sender')),
    }) : undefined;
    const replayNow = disposableReplayClock();
    const notice = noticeUrl && noticeTokenFile && virtual ? createNoticeSmsWorker({
      marketingUrl: new URL(noticeUrl), token: readSecret(noticeTokenFile), storeId: virtual.provider.storeId,
      now: replayNow,
      sens: createSensWire(createMarketingProvider({ ...virtual.provider, mode: 'virtual', operations: noticeSmsOperations,
        operationCredentialFiles: { 'pn13.sms.send': virtual.file('sms_id') } }), {
        serviceIds: { sms: readSecret(virtual.file('sms_service')) }, clock: replayNow && { now: replayNow },
      }),
    }) : undefined;
    const interval = Number(process.env.NAVIS_PROMO_FIXTURE_STAGE_INTERVAL_MS ?? 250);
    if (!Number.isSafeInteger(interval) || interval < 250 || interval > 5_000) throw new Error('Invalid fixture stage interval');

    async function poll(run: () => Promise<void>, wait: number) {
      while (!stop.signal.aborted) {
        try { await run(); }
        catch { console.error('Marketing durable work iteration failed'); }
        await delay(wait, undefined, { signal: stop.signal }).catch(() => undefined);
      }
    }
    await redis.connect();
    await Promise.all([
      consumer.run(stop.signal),
      ...(supplier ? [supplier.consumer.run(stop.signal), poll(() => supplier.step(stop.signal), interval)] : []),
      ...(notice ? [poll(() => notice.step(stop.signal), Math.max(2_000, interval))] : []),
      poll(async () => { await promo.runNext(storeId, stop.signal); }, interval),
      poll(async () => {
        await sms.runNext(storeId);
        const pending = await inStore(database, storeId, db => db.query<{ receipt_id: string }>(`
          SELECT receipt_id FROM marketing.sens_attempt WHERE store_id=$1 AND
            (state IN ('sending','uncertain') OR (state='accepted' AND delivery_state='pending'))`, [storeId]));
        for (const { receipt_id } of pending.rows) await sms.reconcile(storeId, receipt_id);
      }, 250),
    ]);
  } finally {
    if (redis.isOpen) streams.close();
    await Promise.all([database.end(), rm(scratch, { recursive: true, force: true })]);
  }
}

await main().catch(() => {
  console.error('Marketing worker initialization failed');
  process.exitCode = 1;
});
