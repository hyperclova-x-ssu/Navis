import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { createGateway } from '../../../../gateway/app.ts';
import { createNoticeSmsWorker } from '../../../../workers/marketing-worker/notice/sms.ts';
import { createSensWire } from '../../../../workers/marketing-worker/naver/pn13-sens.ts';
import { registerSmsRecipientRoute, smsRecipientsRoute } from '../../../customer/reality/05/sms-recipients.ts';
import { NaverAdapterError } from '../../naver/errors.ts';
import { marketingProvider, preparePersonaDatabase, SENDER, SERVICE_IDS, startPersona, STORE_ID } from '../../naver/test/persona.ts';
import { advertisingSmsText } from '../../sms-text.ts';
import { inStore } from '../../transaction.ts';
import { registerNoticeApprovals, verifyNoticeApproval } from './approval.ts';
import { scheduledSmsProvider } from './gap-providers.ts';
import { createNoticeRecipients } from './recipients.ts';
import { registerNoticeReplyRoutes } from './routes.ts';

// Proposed gateway allowlist additions (the composition layer owns gateway/records.ts).
vi.mock('../../../../gateway/records.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../gateway/records.ts')>();
  // Append only the routes the real allowlist does not have yet (R1 checkpoint 7 registered the GAP-MKT ones).
  const add = (list: typeof actual.marketingNoticeRoutes, extra: (readonly [string, string])[]) => [...list,
    ...extra.filter(([method, path]) => !list.some(([m, p]) => m === method && p === path))];
  return { ...actual, marketingNoticeRoutes: add(actual.marketingNoticeRoutes, [['POST', '/approvals'],
    ['GET', '/notices/:id/sms-reservation'], ['POST', '/notices/:id/cancel-sms'], ['GET', '/notice-recipient-groups'],
    ['POST', '/notice-recipient-groups']]) };
});

const adminUrl = process.env.FIX_GAP_B_PG_URL;

async function database(admin: pg.Pool, name: string, setup: string, migrations?: { dir: string; schema: string; role: string }) {
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl!);
  url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.href, max: 2 });
  const db = await pool.connect();
  try {
    await db.query(setup);
    if (migrations) {
      await db.query(`SET ROLE ${migrations.role}`);
      await runner({ dbClient: db, dir: migrations.dir, schema: migrations.schema, migrationsSchema: migrations.schema,
        migrationsTable: 'schema_migrations', direction: 'up', verbose: false, log: () => {} });
    }
  } finally { db.release(); await pool.end(); }
  return url.href;
}

it.skipIf(!adminUrl)('sends a scheduled notice SMS only to recipients whose consent and closure are current at send time', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='marketing_mig') THEN CREATE ROLE marketing_mig; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='marketing_run') THEN CREATE ROLE marketing_run; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='customer_mig') THEN CREATE ROLE customer_mig; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='customer_run') THEN CREATE ROLE customer_run; END IF; END $$`);
  const marketingDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
  expect((await readdir(marketingDir)).filter(name => name.endsWith('.sql')).at(-1)).toBe('20261122002004_real_notice_sms_dispatch.sql');
  const marketingUrl = await database(admin, 'fgb_m_' + suffix, `CREATE SCHEMA marketing AUTHORIZATION marketing_mig;
    GRANT USAGE ON SCHEMA marketing TO marketing_run`, { dir: marketingDir, schema: 'marketing', role: 'marketing_mig' });
  const customerUrl = await database(admin, 'fgb_c_' + suffix, `CREATE SCHEMA customer AUTHORIZATION customer_mig;
    GRANT USAGE ON SCHEMA customer TO customer_run`,
  { dir: fileURLToPath(new URL('../../../customer/migrations/', import.meta.url)), schema: 'customer', role: 'customer_mig' });
  const personaUrl = await database(admin, 'fgb_p_' + suffix, 'SELECT 1');

  let clock = new Date('2026-11-22T06:00:00Z'); // 15:00 KST
  const now = () => clock;
  const store = STORE_ID;
  const actor = randomUUID();
  const pool = new pg.Pool({ connectionString: marketingUrl, options: '-c role=marketing_run', max: 4 });
  const customerPool = new pg.Pool({ connectionString: customerUrl, options: '-c role=customer_run', max: 2 });
  const superCustomer = new pg.Pool({ connectionString: customerUrl, max: 1 });
  const superMarketing = new pg.Pool({ connectionString: marketingUrl, max: 1 });

  // 150 members of the B19 first-visit group with SMS advertising consent; phones live only in Customer.
  const members = Array.from({ length: 150 }, (_, index) => ({ id: randomUUID(), phone: '0100000' + (1000 + index) }));
  for (const member of members) {
    await superCustomer.query(`INSERT INTO customer.member (store_id, member_id, name, phone, contact_allowed, marketing_allowed, created_at)
      VALUES ($1,$2,'가상손님',$3,true,true,$4)`, [store, member.id, member.phone, clock]);
    await superMarketing.query(`INSERT INTO marketing.r19_member (store_id, member_id, member_revision, active, contact_allowed,
      marketing_allowed, event_id, updated_at) VALUES ($1,$2,1,true,true,true,$3,$4)`, [store, member.id, randomUUID(), clock]);
    await superMarketing.query(`INSERT INTO marketing.r19_sale (store_id, settlement_id, business_date, occurred_at, member_id, amount,
      incomplete_margin, event_id) VALUES ($1,$2,'2026-11-20','2026-11-20T03:00:00Z',$3,4500,false,$4)`, [store, randomUUID(), member.id, randomUUID()]);
  }

  await preparePersonaDatabase(personaUrl, clock);
  const persona = await startPersona({ databaseUrl: personaUrl, now });
  const { provider, guard } = marketingProvider({ target: persona.address, now });

  const customer = Fastify();
  const recipientToken = 'marketing-sms-recipient-workload';
  registerSmsRecipientRoute(customer, customerPool, { marketingToken: recipientToken });
  const customerOrigin = await customer.listen({ host: '127.0.0.1', port: 0 });
  const recipientReads: number[] = [];
  const readCustomer = async (storeId: string, body: object) => {
    const response = await fetch(new URL(smsRecipientsRoute.replace(':storeId', storeId), customerOrigin), {
      method: 'POST', body: JSON.stringify(body),
      headers: { authorization: 'Bearer ' + recipientToken, 'x-navis-store-id': storeId, 'content-type': 'application/json' } });
    recipientReads.push(response.status);
    return response;
  };

  const closureId = randomUUID();
  let closureRevision = 1;
  let campaignFailure: Error | null = new NaverAdapterError('INVALID_INPUT', { detail: 'audience' });
  const workerToken = 'marketing-worker-notice-sms';
  const makeApp = () => {
    const app = Fastify();
    registerNoticeApprovals(app, pool, 'gateway', now, 'approved-card');
    registerNoticeReplyRoutes(app, pool, {
      gatewayToken: 'gateway', now, verifyApproval: verifyNoticeApproval(now), smsWorkerToken: workerToken,
      readClosure: async (_scope, id) => id === closureId
        ? { eventId: id, revision: closureRevision, date: '2026-11-24', endDate: '2026-11-24' } : null,
      provider: {
        mode: 'virtual',
        async audiences() { return { items: [{ audience: 'benefit-subscribers' }], quota: { month: '2026-11', assigned: 8 } }; },
        async campaign() {
          if (campaignFailure) { const failure = campaignFailure; campaignFailure = null; throw failure; }
          return { state: 'accepted' };
        },
      },
      scheduledSms: scheduledSmsProvider({ mode: 'virtual',
        recipients: createNoticeRecipients({ pool, senderNumber: SENDER.sms, readCustomer, now }) }),
    });
    return app;
  };
  let app = makeApp();
  let origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const keys = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...await exportJWK(keys.publicKey), alg: 'ES256', use: 'sig', kid: 'fix-gap-b' }] };
  const gateway = createGateway({
    accountUrl: 'http://account:3000', accountToken: 'account-test', inventoryUrl: 'http://inventory:3000', inventoryToken: 'inventory-test',
    marketingRecords: { url: 'http://marketing:3000', token: 'gateway' }, accountOrigin: 'http://fix-gap-b.invalid', logging: false,
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
  type Options = { body?: object; key?: string; token?: string; method?: string };
  async function request(path: string, expected: number, options: Options = {}) {
    const method = options.method ?? (options.body ? 'POST' : 'GET');
    const key = options.key ?? randomUUID();
    if (!options.token) {
      const session = await new SignJWT({ sid: randomUUID(), store_id: store, role: 'owner' })
        .setProtectedHeader({ alg: 'ES256', kid: 'fix-gap-b' }).setSubject(actor)
        .setIssuer('navis-account').setAudience('navis-api').setIssuedAt().setExpirationTime('10m').sign(keys.privateKey);
      const response = await gateway.inject({ method: method as 'GET', url: '/api/v1/stores/' + store + '/marketing' + path,
        headers: { host: 'fix-gap-b.invalid', origin: 'http://fix-gap-b.invalid', authorization: 'Bearer ' + session, 'idempotency-key': key },
        payload: options.body });
      expect(response.statusCode, response.body).toBe(expected);
      return response.json();
    }
    const response = await fetch(origin + '/internal/v1/marketing/stores/' + store + path, {
      method, headers: { authorization: 'Bearer ' + options.token, 'x-navis-store-id': store, 'x-navis-store-role': 'owner',
        'x-navis-user-id': actor, 'idempotency-key': key, ...(options.body && { 'content-type': 'application/json' }) },
      body: options.body && JSON.stringify(options.body),
    });
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(expected);
    return data;
  }
  async function approve(operation: string, resourceId: string, command: { expectedRevision: number; scheduledFor?: string },
    confirm = false) {
    if (operation === 'notice.cancelSms' || command.scheduledFor !== undefined) {
      // CARD-AUTH shared owner card: `sms.schedule`, and `sms.cancel` with a second confirmation.
      const cancel = operation === 'notice.cancelSms';
      const card = { operation: cancel ? 'sms.cancel' : 'sms.schedule', targetRef: resourceId,
        expectedRevision: command.expectedRevision, command: cancel ? {} : { scheduledFor: command.scheduledFor } };
      const pressed = await request('/approvals', 200, { body: { ...card, stage: 'press' } });
      if (confirm) await request('/approvals', 200, { body: { ...card, stage: 'confirm', approvalId: pressed.approvalId } });
      return pressed.approvalId as string;
    }
    const approvalId = randomUUID();
    const body = { approvalId, resourceId, operation, command };
    await request('/notice-reply-approvals', 200, { token: 'gateway', body: { ...body, stage: 'press' } });
    if (confirm) await request('/notice-reply-approvals', 200, { token: 'gateway', body: { ...body, stage: 'confirm' } });
    return approvalId;
  }
  let group = { recipientGroupId: '' };
  async function schedule(text: string, scheduledFor: string, closure?: object) {
    const notice = await request('/notices', 200, { body: { title: '공지', text, channel: 'sms', recipientGroupId: group.recipientGroupId,
      ...(closure && { closure }) } });
    const command = { expectedRevision: 1, scheduledFor };
    const approvalId = await approve('notice.send', notice.resourceId, command);
    const send = { body: { ...command, approvalId }, key: randomUUID() };
    const receipt = await request('/notices/' + notice.resourceId + '/send', 200, send);
    return { id: notice.resourceId as string, receipt, send };
  }
  const worker = createNoticeSmsWorker({ marketingUrl: new URL(origin), token: workerToken, storeId: store, now,
    sens: createSensWire(provider, { serviceIds: { sms: SERVICE_IDS.sms }, clock: { now } }),
    fetcher: (input, init) => fetch(new URL(new URL(String(input)).pathname, origin), init) });
  const smsCalls = () => guard.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages'));
  try {
    // Recipient group mapping: opaque UUID per store and B19 group; the browser never sees member IDs or phones.
    await request('/notice-recipient-groups', 400, { body: { groupId: 'everyone' } });
    group = await request('/notice-recipient-groups', 200, { body: { groupId: 'first-visit' } });
    expect(await request('/notice-recipient-groups', 200, { body: { groupId: 'first-visit' } })).toEqual(group);
    const groups = await request('/notice-recipient-groups', 200);
    expect(groups.items).toEqual([
      { groupId: 'churn-risk', recipientGroupId: null, memberCount: 0 },
      { groupId: 'first-visit', recipientGroupId: group.recipientGroupId, memberCount: 150 },
      { groupId: 'regular', recipientGroupId: null, memberCount: 0 }]);
    await request('/notices', 409, { body: { title: '공지', text: '새 소식', channel: 'sms', recipientGroupId: randomUUID() } });

    // RV-GAP-B-2: the card preview is the exact final advertising text, counted against the SMS/LMS byte budget.
    const draft = await request('/notices', 200, { body: { title: '공지', text: '새 소식', channel: 'sms', recipientGroupId: group.recipientGroupId } });
    const detail = await request('/notices/' + draft.resourceId, 200);
    const finalText = advertisingSmsText('새 소식');
    expect(finalText).toBe('(광고) 스토어사스 테스트 매장 (연락처: 테스트 전용)\n새 소식\n무료수신거부 테스트 전용');
    expect(detail.smsPreview).toEqual({ content: finalText, contentType: 'AD', type: 'SMS', bytes: 84, recipientCount: 150,
      maxRecipients: 500, sendAllowed: true, reasons: [] });
    expect(JSON.stringify(detail)).not.toMatch(/0100000\d{4}/);

    // RV-GAP-B-3: the press writes our ledger only. Nothing reaches SENS until the scheduled minute.
    const first = await schedule('새 소식', '2026-11-23T10:00');
    expect(first.receipt).toMatchObject({ state: 'scheduled', revision: 2 });
    expect(await request('/notices/' + first.id + '/send', 200, first.send)).toEqual(first.receipt);
    expect(await request('/notices/' + first.id + '/sms-reservation', 200)).toMatchObject({ status: 'READY', scheduledFor: '2026-11-23T10:00' });
    expect(smsCalls()).toHaveLength(0);
    await worker.step();
    expect(smsCalls()).toHaveLength(0);

    // Consent revoked after scheduling: that recipient is dropped at send time.
    await superCustomer.query('UPDATE customer.member SET marketing_allowed=false, revision=revision+1 WHERE store_id=$1 AND member_id=$2',
      [store, members[0].id]);
    const closed = await schedule('휴무 안내', '2026-11-23T10:00', { eventId: closureId, revision: 1 });
    const canceled = await schedule('취소할 소식', '2026-11-23T11:00');
    const cancelCommand = { expectedRevision: 2 };
    await request('/notices/' + canceled.id + '/cancel-sms', 403, { body: { ...cancelCommand, approvalId: await approve('notice.cancelSms', canceled.id, cancelCommand) } });
    const cancelId = await approve('notice.cancelSms', canceled.id, cancelCommand, true);
    expect(await request('/notices/' + canceled.id + '/cancel-sms', 200, { body: { ...cancelCommand, approvalId: cancelId } }))
      .toMatchObject({ state: 'canceled', revision: 3 });
    closureRevision = 2; // The linked closure moved after the press.

    clock = new Date('2026-11-23T02:01:00Z'); // 11:01 KST: all three are due.
    await worker.step();
    const calls = smsCalls();
    expect(calls).toHaveLength(2);
    const bodies = calls.map(call => JSON.parse(call.body!));
    for (const body of bodies) {
      expect(body).toMatchObject({ type: 'SMS', contentType: 'AD', from: SENDER.sms, content: finalText });
      expect(body.reserveTime).toBeUndefined();
    }
    const sent = bodies.flatMap(body => body.messages.map((message: { to: string }) => message.to));
    expect(bodies.map(body => body.messages.length)).toEqual([100, 49]);
    expect(sent).not.toContain(members[0].phone);
    expect(new Set(sent).size).toBe(149);
    expect(await request('/notices/' + first.id + '/sms-reservation', 200)).toMatchObject({
      status: 'DONE', dispatchState: 'sent', recipientCount: 149, acceptedCount: 149, failedCount: 0, unknownCount: 0 });
    expect((await request('/notices/' + first.id, 200)).result).toMatchObject({ state: 'sent', scheduledFor: '2026-11-23T10:00' });
    expect(await request('/notices/' + closed.id + '/sms-reservation', 200)).toMatchObject({ status: 'SKIP', reason: 'CLOSURE_CHANGED' });
    expect(await request('/notices/' + canceled.id + '/sms-reservation', 200)).toMatchObject({ status: 'CANCELED' });
    await worker.step();
    expect(smsCalls()).toHaveLength(2);
    const lateCancel = await approve('notice.cancelSms', first.id, { expectedRevision: 3 }, true);
    expect(await request('/notices/' + first.id + '/cancel-sms', 409, { body: { expectedRevision: 3, approvalId: lateCancel } }))
      .toMatchObject({ code: 'SMS_NOT_CANCELABLE' });

    // Every consent withdrawn before the minute: nothing is sent.
    clock = new Date('2026-11-23T03:00:00Z');
    const empty = await schedule('마지막 소식', '2026-11-23T13:00');
    await superCustomer.query('UPDATE customer.member SET marketing_allowed=false WHERE store_id=$1', [store]);
    clock = new Date('2026-11-23T04:00:00Z');
    await worker.step();
    expect(smsCalls()).toHaveLength(2);
    expect(await request('/notices/' + empty.id + '/sms-reservation', 200)).toMatchObject({ status: 'SKIP', reason: 'SMS_CONSENT_REQUIRED' });

    // RV-GAP-B-5: a provider rejection known to have sent nothing finishes as rejected and does not lock the notice.
    const talk = await request('/notices', 200, { body: { title: '톡톡', text: '소식', channel: 'talktalk', audience: 'benefit-subscribers' } });
    const talkSend = { body: { expectedRevision: 1, approvalId: await approve('notice.send', talk.resourceId, { expectedRevision: 1 }) }, key: randomUUID() };
    const rejected = await request('/notices/' + talk.resourceId + '/send', 409, talkSend);
    expect(rejected).toMatchObject({ code: 'PROVIDER_INVALID_INPUT', receiptId: expect.any(String) });
    expect(await request('/notices/' + talk.resourceId + '/send', 409, talkSend)).toEqual(rejected);
    expect(await request('/notice-reply-receipts/' + rejected.receiptId, 200)).toMatchObject({ state: 'rejected', reason: 'PROVIDER_INVALID_INPUT', revision: 1 });
    const retry = { expectedRevision: 1, approvalId: await approve('notice.send', talk.resourceId, { expectedRevision: 1 }) };
    expect(await request('/notices/' + talk.resourceId + '/send', 200, { body: retry })).toMatchObject({ state: 'accepted', revision: 2 });

    // The private dispatch routes take only the worker credential.
    const forged = await fetch(origin + '/internal/v1/marketing/notice-sms-dispatch/stores/' + store, { headers: { authorization: 'Bearer gateway' } });
    expect(forged.status).toBe(401);

    // Restart and a new session re-read the same ledger state.
    const before = await request('/notices/' + first.id + '/sms-reservation', 200);
    await app.close();
    app = makeApp();
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    expect(await request('/notices/' + first.id + '/sms-reservation', 200)).toEqual(before);

    const rows = await inStore(pool, store, async db => (await db.query<{ aggregate_id: string; payload: { state: string; calendarProjection: { entry: unknown } } }>(
      `SELECT aggregate_id, payload FROM marketing.outbox WHERE store_id=$1 AND event_type='marketing.message_status_changed.v1'
       ORDER BY store_seq`, [store])).rows);
    const events = rows.map(row => row.payload);
    const history = (id: string) => rows.filter(row => row.aggregate_id === id)
      .map(row => [row.payload.state, row.payload.calendarProjection.entry]);
    expect(history(first.id)).toEqual([['saved', null], ['scheduled', { date: '2026-11-23' }], ['sent', { date: '2026-11-23' }]]);
    expect(history(closed.id)).toEqual([['saved', null], ['scheduled', { date: '2026-11-24' }], ['skipped', null]]);
    expect(history(canceled.id)).toEqual([['saved', null], ['scheduled', { date: '2026-11-23' }], ['canceled', null]]);
    expect(history(empty.id)).toEqual([['saved', null], ['scheduled', { date: '2026-11-23' }], ['skipped', null]]);
    expect(history(talk.resourceId)).toEqual([['saved', null], ['accepted', null]]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/0100000\d{4}/);
    expect(serialized).not.toContain('새 소식');
    expect(guard.blocked).toEqual([]);
    expect(guard.calls.filter(call => call.path.includes('/reservations'))).toHaveLength(0);
    expect(recipientReads.every(status => status === 200)).toBe(true);
    console.info(JSON.stringify({ store, smsRequests: calls.length, recipientsSent: sent.length, dropped: 1,
      skipped: ['CLOSURE_CHANGED', 'SMS_CONSENT_REQUIRED'], canceled: 1, rejectedReceipt: rejected.receiptId, unauthorizedWrites: 0 }));
  } finally {
    await gateway.close(); await app.close(); await customer.close(); await persona.close();
    await Promise.all([pool.end(), customerPool.end(), superCustomer.end(), superMarketing.end()]);
    for (const name of ['fgb_m_', 'fgb_c_', 'fgb_p_']) await admin.query(`DROP DATABASE IF EXISTS ${name + suffix} WITH (FORCE)`);
    await admin.end();
  }
});
