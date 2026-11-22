import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { PERSONA_ACCOUNT_HEADER, PERSONA_TOKEN_HEADER } from '../../../../packages/naver/config/index.ts';
import { createGateway } from '../../../../gateway/app.ts';
import { createNaverMarketing } from '../../naver/index.ts';
import { ACCOUNT, CAFE, marketingProvider, preparePersonaDatabase, startPersona, STORE_ID } from '../../naver/test/persona.ts';
import { createPersonaApp } from '../../../naver-virtual/app.ts';
import { personaCapability as pn11 } from '../../../naver-virtual/capabilities/pn11/index.ts';
import { createPersonaOwnerGrants } from '../../../account/naver/persona-grants.ts';
import { pn17Cafe } from '../13/cafe.ts';
import { pn10SearchInterest } from '../13/sources.ts';
import { inStore } from '../../transaction.ts';
import { navisReviewDraft } from './gap-providers.ts';
import { registerLocalMarketingRoutes } from '../13/routes.ts';
import { registerNoticeApprovals, verifyNoticeApproval } from './approval.ts';
import { registerNoticeReplyRoutes } from './routes.ts';

// Exercise the proposed route table additions without changing the Composer's files.
vi.mock('../../../../gateway/records.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../gateway/records.ts')>();
  // Append only what the real allowlist lacks; R1 checkpoint 7 registered these routes, and duplicates fail at startup.
  const add = (list: typeof actual.marketingNoticeRoutes, extra: (readonly [string, string])[]) => [...list,
    ...extra.filter(([method, path]) => !list.some(([m, p]) => m === method && p === path))];
  return { ...actual,
    marketingLocalRoutes: add(actual.marketingLocalRoutes, [['GET', '/community/cafe-boards'], ['GET', '/community/cafe-posts']]),
    marketingNoticeRoutes: add(actual.marketingNoticeRoutes, [['POST', '/reviews/:id/navis-draft-preview'],
      ['POST', '/approvals'], ['POST', '/community/cafe-posts'], ['GET', '/notices/:id/sms-reservation'], ['POST', '/notices/:id/cancel-sms']]),
  };
});

const databaseUrl = process.env.GAP_MKT_TEST_DATABASE_URL;
const personaDatabaseUrl = process.env.GAP_MKT_TEST_PERSONA_URL;

it.skipIf(!databaseUrl || !personaDatabaseUrl)('persists Café card receipts and keeps the NAVER and Navis review previews separate', async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const db = await admin.connect();
  try {
    await db.query(`CREATE ROLE marketing_mig; CREATE ROLE marketing_run; CREATE ROLE marketing_wrk; CREATE SCHEMA marketing AUTHORIZATION marketing_mig;
      GRANT USAGE ON SCHEMA marketing TO marketing_run; SET ROLE marketing_mig`);
    const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const baseCount = (await readdir(dir)).filter(name => name.endsWith('.sql') && name < '20261122002001').length;
    const migration = { dbClient: db, dir, schema: 'marketing', migrationsSchema: 'marketing',
      migrationsTable: 'schema_migrations', direction: 'up' as const, verbose: false, log: () => {} };
    await runner({ ...migration, count: baseCount });
    expect((await runner(migration)).slice(0, 2).map(step => step.name)).toEqual([
      '20261122002001_real_cafe_post', '20261122002002_real_sms_reservation',
    ]);
  } finally { db.release(); await admin.end(); }

  const pool = new pg.Pool({ connectionString: databaseUrl, options: '-c role=marketing_run' });
  const now = () => new Date('2026-11-21T15:00:00Z');
  const store = STORE_ID, actor = randomUUID();
  await preparePersonaDatabase(personaDatabaseUrl!, now());
  const persona = await startPersona({ databaseUrl: personaDatabaseUrl!, now });
  const grantPool = new pg.Pool({ connectionString: personaDatabaseUrl, options: '-c role=nvirtual_run' });
  const grantToken = 'synthetic-owner-grant-workload';
  const grantOperation = 'pn11.fixture.owner-grant';
  const grantApp = createPersonaApp({ pool: grantPool, capabilities: [pn11], now, logging: false, grants: [{
    accountId: ACCOUNT, workload: 'account', token: grantToken, operations: [grantOperation],
    providerCredentials: { [grantOperation]: { actorId: actor, storeId: store, scopes: 'calendar,cafe' } },
  }] });
  const requestGrant = async (payload: unknown) => grantApp.inject({ method: 'POST', url: '/partner-assumed/v1/fixture/owner-grants',
    headers: { [PERSONA_TOKEN_HEADER]: grantToken, [PERSONA_ACCOUNT_HEADER]: ACCOUNT }, payload: payload as object });
  const ownerGrant = createPersonaOwnerGrants({ owner: { storeId: store, actorId: actor }, scopes: ['calendar', 'cafe'], now, bindings: [{
    storeId: store, providerAccount: ACCOUNT, operation: grantOperation, mode: 'fake', method: 'POST', grade: 'P',
    route: /^\/partner-assumed\/v1\/fixture\/owner-grants$/,
    async handler(call) {
      const response = await requestGrant(JSON.parse(Buffer.from(call.body!).toString()));
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    },
  }] });
  const { provider, guard } = marketingProvider({ target: persona.address, now });
  const naver = createNaverMarketing(provider, { clock: { now } });
  const makeApp = () => {
    const app = Fastify();
    registerLocalMarketingRoutes(app, pool, {
      now, readToken: 'gateway', commandToken: 'local',
      cafe: pn17Cafe({ mode: 'virtual', forOwner: () => provider,
        grantFor: async owner => owner.actorId === actor
          ? { accessToken: await ownerGrant.resolve(owner, 'cafe'), boards: [{ clubid: CAFE.clubid, menuid: CAFE.menuid }] } : null }),
      searchInterest: pn10SearchInterest(() => naver.search),
      searchLinks: async (_store, channel, query) => (await naver.search.search(channel, { query, display: 10 })).result,
    });
    registerNoticeApprovals(app, pool, 'gateway', now, 'approved-card');
    registerNoticeReplyRoutes(app, pool, {
      gatewayToken: 'gateway', now, verifyApproval: verifyNoticeApproval(now),
      provider: {
        mode: 'virtual',
        review: (_owner, ref) => naver.reply.readReview(ref),
        reviewDraft: (_owner, { ref, style, length }) => naver.reply.draft({ reviewRef: ref, style, length }),
      },
      navisReviewDraft: navisReviewDraft(() => provider),
    });
    return app;
  };
  let app = makeApp();
  let origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const keys = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...await exportJWK(keys.publicKey), alg: 'ES256', use: 'sig', kid: 'gap-mkt' }] };
  const gateway = createGateway({
    accountUrl: 'http://account:3000', accountToken: 'account-test',
    inventoryUrl: 'http://inventory:3000', inventoryToken: 'inventory-test',
    marketingRecords: { url: 'http://marketing:3000', token: 'gateway' },
    accountOrigin: 'http://gap-mkt.invalid', logging: false,
    async fetcher(input, init) {
      const url = new URL(String(input));
      if (url.hostname === 'marketing') return fetch(new URL(url.pathname + url.search, origin), init);
      if (url.hostname === 'account') {
        if (url.pathname === '/internal/v1/auth/jwks') return Response.json(jwks);
        if (url.pathname === '/internal/v1/auth/authorize') return new Response(null, { status: 204 });
        if (url.pathname.endsWith('/operating-clock')) return Response.json({ timezone: 'Asia/Seoul', businessDayStart: '05:00' });
      }
      throw new Error('Unexpected fixture upstream');
    },
  });
  async function request(path: string, expected: number, options: { body?: object; key?: string; token?: string; actor?: string } = {}) {
    const method = options.body ? 'POST' : 'GET';
    const key = options.key ?? randomUUID();
    if (!options.token) {
      const token = await new SignJWT({ sid: randomUUID(), store_id: store, role: 'owner' })
        .setProtectedHeader({ alg: 'ES256', kid: 'gap-mkt' }).setSubject(options.actor ?? actor)
        .setIssuer('navis-account').setAudience('navis-api').setIssuedAt().setExpirationTime('10m').sign(keys.privateKey);
      const response = await gateway.inject({ method, url: '/api/v1/stores/' + store + '/marketing' + path,
        headers: { host: 'gap-mkt.invalid', origin: 'http://gap-mkt.invalid', authorization: 'Bearer ' + token, 'idempotency-key': key },
        payload: options.body });
      expect(response.statusCode, response.body).toBe(expected);
      return response.json();
    }
    const response = await fetch(origin + '/internal/v1/marketing/stores/' + store + path, {
      method, headers: { authorization: 'Bearer ' + options.token, 'x-navis-store-id': store,
        'x-navis-store-role': 'owner', 'x-navis-user-id': options.actor ?? actor,
        'idempotency-key': key, ...(options.body && { 'content-type': 'application/json' }) },
      body: options.body && JSON.stringify(options.body),
    });
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(expected);
    return data;
  }
  try {
    expect((await requestGrant({ storeId: store, actorId: randomUUID(), scope: 'cafe' })).statusCode).toBe(403);
    expect((await requestGrant({ storeId: randomUUID(), actorId: actor, scope: 'calendar' })).statusCode).toBe(403);
    expect(await ownerGrant.resolve({ storeId: store, actorId: actor }, 'calendar')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const draft = { body: { style: '정중하게', length: '짧게' } };
    const naverDraft = await request('/reviews/review-03/draft-preview', 200, draft);
    const navisDraft = await request('/reviews/review-03/navis-draft-preview', 200, draft);
    expect(naverDraft.source).toBe('naver-ai');
    expect(navisDraft).toMatchObject({ source: 'navis', text: expect.stringContaining('감사합니다') });
    const trends = await request('/local-trends?from=2026-11-18&to=2026-11-22&keyword=' + encodeURIComponent('커피'), 200);
    expect(trends.search).toMatchObject({ unit: 'relative-index', items: [{ ratio: 80 }, { ratio: 100 }] });
    expect(trends).not.toHaveProperty('links');
    const cafe = { body: { clubid: CAFE.clubid, menuid: CAFE.menuid, subject: '공지', text: '안녕하세요' },
      key: 'navis:' + randomUUID() };
    await request('/community/cafe-posts', 403, cafe);
    expect((await request('/community/cafe-boards', 200)).items).toEqual([{ clubid: CAFE.clubid, menuid: CAFE.menuid }]);
    const cafeCard = { operation: 'cafe.post', command: cafe.body, expectedRevision: 0 };
    const pressed = await request('/approvals', 200, { body: { ...cafeCard, stage: 'press' } });
    expect(pressed.requiresConfirmation).toBe(true);
    cafe.key = 'navis:' + pressed.approvalId;
    await request('/community/cafe-posts', 403, cafe);
    const confirmCafe = { body: { ...cafeCard, stage: 'confirm', approvalId: pressed.approvalId } };
    await request('/approvals', 403, { ...confirmCafe, actor: randomUUID() });
    await request('/approvals', 200, confirmCafe);
    await request('/community/cafe-posts', 403, { ...cafe, body: { ...cafe.body, menuid: '2' } });
    expect((await request('/community/cafe-posts', 200)).items).toEqual([]);
    const posted = await request('/community/cafe-posts', 200, cafe);
    expect(posted).toMatchObject({ state: 'published', articleId: expect.stringMatching(/^\d+$/) });
    expect(await request('/community/cafe-posts', 200, cafe)).toEqual(posted);
    expect((await request('/community/cafe-posts', 200, { actor: randomUUID() })).items).toEqual([]);

    await app.close();
    app = makeApp();
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    expect((await request('/community/cafe-posts', 200)).items[0]).toMatchObject({ id: posted.id, state: 'published' });
    const events = await inStore(pool, store, async db =>
      (await db.query(`SELECT event_type, payload FROM marketing.outbox
        WHERE store_id=$1 AND event_type = 'marketing.cafe_post_published.v1' ORDER BY store_seq`, [store])).rows);
    expect(events.map(row => row.payload)).toEqual([{ postId: posted.id, revision: 2 }]);
    expect(guard.blocked).toEqual([]);
    expect(guard.calls.filter(call => call.method === 'POST' && call.path.endsWith('/articles'))).toHaveLength(1);
    // Scheduled notice SMS moved to the Marketing ledger and marketing-worker (sms-dispatch.postgres.test.ts).
    expect(guard.calls.filter(call => call.path.includes('/sms/'))).toHaveLength(0);
  } finally { await gateway.close(); await app.close(); await pool.end(); await persona.close(); await grantApp.close(); await grantPool.end(); }
});
