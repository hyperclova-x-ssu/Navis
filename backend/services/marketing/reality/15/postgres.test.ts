import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { it } from 'vitest';
import { createGateway } from '../../../../gateway/app.ts';
import { withCustomerStore } from '../../../customer/claims.ts';
import { projectCalendarSource } from '../../../customer/reality/07/projection.ts';
import { registerCalendarStaffRoutes } from '../../../customer/reality/07/routes.ts';
import { registerTalkTalkInbound, talkTalkInboundPath } from '../../naver/pn06-talktalk.ts';
import { registerNoticeApprovals, verifyNoticeApproval } from './approval.ts';
import { createTalkTalkInbox } from './inbox.ts';
import { inStore } from '../../transaction.ts';
import { createClosureReader } from './closure.ts';
import type { Approval, NoticeReplyOptions } from './ports.ts';
import { registerNoticeReplyRoutes } from './routes.ts';

const databaseUrl = process.env.NAVIS_B15_TEST_DB_URL;
const customerUrl = process.env.NAVIS_B15_TEST_CUSTOMER_URL;

it.skipIf(!databaseUrl || !customerUrl)('reads persisted inquiries and notices through authenticated gateway HTTP and B07', async () => {
  const storeId = randomUUID();
  const actorId = randomUUID();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const customerPool = new pg.Pool({ connectionString: customerUrl });
  const customer = Fastify();
  const customerToken = 'customer-fixture-workload';
  registerCalendarStaffRoutes(customer, customerPool, customerToken, { now: () => new Date('2026-11-21T06:00:00Z') });
  const customerOrigin = await customer.listen({ host: '127.0.0.1', port: 0 });
  const calendarEvent = (scope: { storeId: string; actorId: string }, id = '', init?: RequestInit) =>
    fetch(new URL(`/internal/v1/customer/stores/${scope.storeId}/calendar/events${id ? '/' + id : ''}`, customerOrigin), {
      ...init,
      headers: { authorization: `Bearer ${customerToken}`, 'x-navis-store-id': scope.storeId, 'x-navis-user-id': scope.actorId,
        'x-navis-store-role': 'owner', ...init?.headers },
    });
  const writeCalendar = (method: 'POST' | 'PATCH', body: object, id?: string) => calendarEvent({ storeId, actorId }, id, {
    method, headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(body),
  });
  const approvals = new Map<string, Partial<Approval>>();
  let writes = 0;
  const talkTalkReplies: string[] = [];
  let providerReply: string | null = null;
  const options: NoticeReplyOptions = {
    gatewayToken: 'marketing-fixture-workload',
    now: () => new Date('2026-11-21T06:00:00Z'),
    provider: {
      mode: 'virtual',
      async talkTalkReply(_scope, { user, text }) {
        talkTalkReplies.push(user + ':' + text);
        return { state: 'accepted' };
      },
      async review(_scope, ref) {
        return { ref, text: '맛있었어요.', keywords: [], media: [], stars: null,
          reply: providerReply, hasReply: providerReply !== null };
      },
      async reviewReply(_scope, input) {
        providerReply = input.operation === 'delete' ? null : input.text;
        return { state: 'saved' };
      },
      async audiences() { return { items: [{ audience: 'benefit-subscribers' }], quota: { month: '2026-11', assigned: 8 } }; },
      async campaign() { writes++; return { state: 'accepted' }; },
    },
    readClosure: createClosureReader(calendarEvent),
    async verifyApproval(approval, db) {
      const known = approvals.get(approval.approvalId);
      if (!known) return verifyNoticeApproval(options.now!)(approval, db);
      return Object.entries(known).every(([key, value]) => approval[key as keyof Approval] === value);
    },
  };
  const makeService = () => {
    const app = Fastify();
    registerNoticeReplyRoutes(app, pool, options);
    registerNoticeApprovals(app, pool, options.gatewayToken, options.now);
    registerTalkTalkInbound(app, { mode: 'fake', callbackToken: 'fixture-callback',
      onEvent: createTalkTalkInbox(pool, storeId, options.now) });
    return app;
  };
  let marketing = makeService();
  let marketingUrl = await marketing.listen({ host: '127.0.0.1', port: 0 });
  const keys = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...await exportJWK(keys.publicKey), alg: 'ES256', use: 'sig', kid: 'b15-fixture' }] };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'account') {
      if (url.pathname === '/internal/v1/auth/jwks') return Response.json(jwks);
      if (url.pathname === '/internal/v1/auth/authorize') return new Response(null, { status: 204 });
      if (url.pathname === `/internal/v1/account/stores/${storeId}/operating-clock`) {
        return Response.json({ timezone: 'Asia/Seoul', businessDayStart: '05:00' });
      }
    }
    if (url.hostname === 'marketing') return fetch(new URL(url.pathname + url.search, marketingUrl), init);
    throw new Error('Unexpected fixture upstream');
  };
  const config = {
    accountUrl: 'http://account:3000', accountToken: 'account-fixture-workload',
    inventoryUrl: 'http://inventory:3000', inventoryToken: 'inventory-fixture-workload',
    marketingRecords: { url: 'http://marketing:3000', token: options.gatewayToken },
    accountOrigin: 'http://b15.invalid', fetcher, logging: false,
  };
  const gateway = createGateway(config);
  const makeToken = () => new SignJWT({ sid: randomUUID(), store_id: storeId, role: 'owner' })
    .setProtectedHeader({ alg: 'ES256', kid: 'b15-fixture' }).setSubject(actorId).setIssuer('navis-account')
    .setAudience('navis-api').setIssuedAt().setExpirationTime('10m').sign(keys.privateKey);
  let token = await makeToken();
  const base = `/api/v1/stores/${storeId}/marketing`;
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', suffix: string, payload?: object, key = randomUUID() as string) =>
    gateway.inject({ method, url: base + suffix, payload,
      headers: { host: 'b15.invalid', origin: 'http://b15.invalid', authorization: `Bearer ${token}`, 'idempotency-key': key } });
  const checked = async (...input: Parameters<typeof request>) => {
    const res = await request(...input);
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  try {
    const event = { event: 'send', user: 'pseudonymous-user', textContent: { text: '자리 있나요?' } };
    const inbound = (payload: object, authorization?: string) => marketing.inject({
      method: 'POST', url: talkTalkInboundPath, headers: authorization ? { authorization } : {}, payload,
    });
    assert.equal((await inbound(event)).statusCode, 401);
    const callbacks = await Promise.all([event, event, { ...event, event: 'echo' }]
      .map(payload => inbound(payload, 'Bearer fixture-callback')));
    for (const response of callbacks) {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.body, '');
    }
    await marketing.close();
    marketing = makeService();
    marketingUrl = await marketing.listen({ host: '127.0.0.1', port: 0 });
    token = await makeToken();
    const list = await checked('GET', '/inquiries');
    const candidates = list.items.filter((item: { source: string }) => item.source === 'talktalk');
    assert.equal(candidates.length, 1);
    const candidate = candidates[0];
    assert.equal(candidate.text, event.textContent.text);
    assert.equal(candidate.status, 'waiting');
    assert.ok(!JSON.stringify(candidate).includes(event.user));
    const candidateDraft = await checked('PATCH', '/inquiries/' + candidate.id + '/draft',
      { expectedRevision: 1, text: '자리 있습니다.', draftSource: 'owner' });
    const replyPath = '/inquiries/' + candidate.id + '/reply';
    const candidateApproval = randomUUID();
    const reply = { expectedRevision: candidateDraft.revision, approvalId: candidateApproval };
    assert.equal((await request('POST', replyPath, reply)).statusCode, 403);
    assert.deepEqual(talkTalkReplies, []);
    await checked('POST', '/notice-reply-approvals', {
      stage: 'press', operation: 'inquiry.post', resourceId: candidate.id, approvalId: candidateApproval,
      command: { expectedRevision: candidateDraft.revision },
    });
    await checked('POST', replyPath, reply);
    assert.deepEqual(talkTalkReplies, ['pseudonymous-user:자리 있습니다.']);

    const audiences = await marketing.inject({
      url: `/internal/v1/marketing/stores/${storeId}/talktalk/marketing/audiences`,
      headers: { authorization: `Bearer ${options.gatewayToken}`, 'x-navis-store-id': storeId,
        'x-navis-user-id': actorId, 'x-navis-store-role': 'owner' },
    });
    assert.equal(audiences.statusCode, 200, audiences.body);
    assert.deepEqual(audiences.json(), {
      items: [{ audience: 'benefit-subscribers' }], quota: { month: '2026-11', assigned: 8 },
    });
    const closure = await writeCalendar('POST', { kind: 'event', title: '임시 휴무', date: '2026-11-22',
      storeClosure: { kind: 'temporary', endDate: '2026-11-22' } });
    assert.equal(closure.status, 201);
    const closureId = (await closure.json()).resourceId as string;
    const inquiry = await checked('POST', '/inquiries', { title: '방문 문의', text: '내일 오후에 방문할 수 있나요?' });
    const inquiryPath = `/inquiries/${inquiry.resourceId}`;
    const draft = await checked('PATCH', inquiryPath + '/draft', { expectedRevision: 1, text: '네, 방문하실 수 있어요.' });
    assert.equal((await checked('GET', '/inquiries')).waitingCount, 1);
    const approvalId = randomUUID();
    const attestation = { expectedRevision: draft.revision, approvalId };
    const denied = await request('POST', inquiryPath + '/attestation', attestation);
    assert.equal(denied.statusCode, 403);
    assert.equal((await checked('GET', inquiryPath)).revision, 2);
    approvals.set(approvalId, { operation: 'inquiry.attest', resourceId: inquiry.resourceId, revision: 2 });
    const receipt = await checked('POST', inquiryPath + '/attestation', attestation, 'inquiry-attest');
    assert.deepEqual(await checked('POST', inquiryPath + '/attestation', attestation, 'inquiry-attest'), receipt);
    assert.equal((await checked('GET', '/inquiries')).waitingCount, 0);

    const notice = await checked('POST', '/notices', { title: '휴무 안내', text: '임시 휴무입니다.', channel: 'talktalk',
      audience: 'benefit-subscribers', closure: { eventId: closureId, revision: 1 } });
    const noticePath = `/notices/${notice.resourceId}`;
    const sendId = randomUUID();
    approvals.set(sendId, { operation: 'notice.send', resourceId: notice.resourceId, revision: 1 });
    const changedClosure = await writeCalendar('PATCH',
      { expectedRevision: 1, storeClosure: { kind: 'temporary', endDate: '2026-11-23' } }, closureId);
    assert.equal(changedClosure.status, 200);
    assert.equal((await checked('GET', noticePath)).closureStatus, 'changed');
    assert.equal((await request('POST', noticePath + '/send', { expectedRevision: 1, approvalId: sendId })).json().code,
      'CLOSURE_CHANGED');
    assert.equal(writes, 0);
    const updated = await checked('PATCH', noticePath + '/draft', { expectedRevision: 1, title: '휴무 안내',
      text: '변경된 휴무입니다.', channel: 'talktalk', audience: 'benefit-subscribers', closure: { eventId: closureId, revision: 2 } });
    approvals.set(sendId, { operation: 'notice.send', resourceId: notice.resourceId, revision: 2 });
    const send = { expectedRevision: updated.revision, approvalId: sendId };
    const accepted = await checked('POST', noticePath + '/send', send, 'notice-send');
    assert.equal(accepted.state, 'accepted');
    assert.deepEqual(await checked('POST', noticePath + '/send', send, 'notice-send'), accepted);
    assert.equal(writes, 1);
    assert.equal((await checked('GET', noticePath)).result.state, 'accepted');

    await marketing.close();
    marketing = makeService();
    marketingUrl = await marketing.listen({ host: '127.0.0.1', port: 0 });
    token = await makeToken();
    assert.equal((await checked('GET', inquiryPath)).reply.state, 'recorded');
    assert.equal((await checked('GET', noticePath)).closure.revision, 2);
    assert.deepEqual(await checked('GET', '/notice-reply-receipts/' + accepted.receiptId), accepted);
    const events = await inStore(pool, storeId, db => db.query('SELECT event_type, payload FROM marketing.outbox ORDER BY store_seq'));
    assert.equal(events.rowCount, 9);
    assert.deepEqual(events.rows.slice(0, 3).map(row => [row.event_type, row.payload.revision, row.payload.status]), [
      ['marketing.inquiry_changed.v1', 1, 'waiting'],
      ['marketing.inquiry_changed.v1', 2, 'draft_ready'],
      ['marketing.inquiry_changed.v1', 3, 'done'],
    ]);
    assert.ok(!JSON.stringify(events.rows).includes(event.user));
    assert.ok(!JSON.stringify(events.rows).includes(event.textContent.text));
    assert.equal(events.rows[8].event_type, 'marketing.message_status_changed.v1');
    assert.deepEqual(events.rows[8].payload.calendarProjection,
      { source: 'notice', sourceId: notice.resourceId, revision: 3, entry: { date: '2026-11-22', endDate: '2026-11-23' } });
    await withCustomerStore(customerPool, storeId, async db => {
      for (const { payload } of events.rows) if (payload.calendarProjection) {
        await projectCalendarSource(db, storeId, 'marketing', payload.calendarProjection);
      }
    });
    const projected = await fetch(new URL(`/internal/v1/customer/stores/${storeId}/calendar/projections`, customerOrigin), {
      headers: { authorization: `Bearer ${customerToken}`, 'x-navis-store-id': storeId, 'x-navis-user-id': actorId,
        'x-navis-store-role': 'owner' },
    });
    assert.equal(projected.status, 200);
    const projections = await projected.json();
    assert.deepEqual(projections.items.map(({ sourceId, sourceRevision }: { sourceId: string; sourceRevision: number }) =>
      ({ sourceId, sourceRevision })), [{ sourceId: notice.resourceId, sourceRevision: 3 }]);
    assert.equal(JSON.stringify(events.rows).includes('임시 휴무입니다.'), false);
    assert.equal((await pool.query('SELECT 1 FROM marketing.reply_notice_record')).rowCount, 0);

    const review = await checked('POST', '/inquiries', { source: 'review', providerRef: 'review-fixture' });
    const reviewPath = '/inquiries/' + review.resourceId;
    await checked('PATCH', reviewPath + '/draft', { expectedRevision: 1, text: '방문해 주셔서 감사합니다.' });
    const postId = randomUUID();
    approvals.set(postId, { operation: 'inquiry.post', resourceId: review.resourceId, revision: 2 });
    await checked('POST', reviewPath + '/reply', { expectedRevision: 2, approvalId: postId });
    assert.equal(providerReply, '방문해 주셔서 감사합니다.');
    const deleteId = randomUUID();
    approvals.set(deleteId, { operation: 'inquiry.deleteReply', resourceId: review.resourceId, revision: 3,
      secondConfirmation: false });
    assert.equal((await request('DELETE', reviewPath + '/reply', { expectedRevision: 3, approvalId: deleteId })).statusCode, 403);
    assert.equal(providerReply, '방문해 주셔서 감사합니다.');
    approvals.set(deleteId, { operation: 'inquiry.deleteReply', resourceId: review.resourceId, revision: 3,
      secondConfirmation: true });
    await checked('DELETE', reviewPath + '/reply', { expectedRevision: 3, approvalId: deleteId });
    assert.equal(providerReply, null);

    // An SMS draft names an opaque recipient group that Marketing mapped to a B19 group (FIX-GAP-B).
    assert.equal((await request('POST', '/notices', { title: '문자 공지', text: '오늘 쉽니다.', channel: 'sms',
      recipientGroupId: randomUUID() })).json().code, 'UNKNOWN_RECIPIENT_GROUP');
    const group = (await marketing.inject({ method: 'POST', url: `/internal/v1/marketing/stores/${storeId}/notice-recipient-groups`,
      headers: { authorization: `Bearer ${options.gatewayToken}`, 'x-navis-store-id': storeId, 'x-navis-user-id': actorId,
        'x-navis-store-role': 'owner' }, payload: { groupId: 'regular' } })).json();
    const sms = await checked('POST', '/notices', { title: '문자 공지', text: '오늘 쉽니다.', channel: 'sms',
      recipientGroupId: group.recipientGroupId });
    const smsApproval = randomUUID();
    approvals.set(smsApproval, { operation: 'notice.send', resourceId: sms.resourceId, revision: 1 });
    assert.equal((await request('POST', '/notices/' + sms.resourceId + '/send',
      { expectedRevision: 1, approvalId: smsApproval })).json().code, 'A6_DISABLED');
    assert.equal((await checked('GET', '/notices/' + sms.resourceId)).status, 'draft');
    const draftDeleteId = randomUUID();
    approvals.set(draftDeleteId, { operation: 'notice.deleteDraft', resourceId: sms.resourceId, revision: 1,
      secondConfirmation: true });
    const deleted = await checked('DELETE', '/notices/' + sms.resourceId + '/draft',
      { expectedRevision: 1, approvalId: draftDeleteId });
    assert.equal(deleted.undoUntil, '2026-11-21T06:00:06.000Z');
    const undo = '/notice-reply-receipts/' + deleted.receiptId + '/undo';
    const restored = await checked('POST', undo, {}, 'restore-notice');
    assert.deepEqual(await checked('POST', undo, {}, 'restore-notice'), restored);
    assert.equal((await checked('GET', '/notices/' + sms.resourceId)).status, 'draft');

    console.info(JSON.stringify({ storeId, inquiry, reply: receipt, notice, accepted, events: events.rowCount,
      dependentCalendarRecords: projections.items.length, fakeCampaignWrites: writes, unauthorizedWrites: 0 }));
  } finally {
    await Promise.all([gateway.close(), marketing.close(), customer.close(), pool.end(), customerPool.end()]);
  }
});
