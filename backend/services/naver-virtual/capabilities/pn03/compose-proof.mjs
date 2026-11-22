import console from 'node:console';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createPersonaApp, loadPersonaCapabilities } from '../../app.ts';
import { migratePersona } from '../../migrate.ts';
import { createPersonaSeedContext, seedPersona } from '../../seed.ts';
import { personaTransaction } from '../../db.ts';
import { createPersonaCallback } from '../../../../packages/naver/transport/index.ts';

const capabilityIds = ['pn02', 'pn03', 'pn04', 'pn05', 'pn06', 'pn07'];
const capabilities = (await loadPersonaCapabilities(capabilityIds)).filter((capability) => capabilityIds.includes(capability.id));
const database = { host: 'postgres', database: 'naver_virtual' };
const admin = new Pool({ ...database, user: 'postgres' });
const migration = new Pool({ ...database, user: 'nvirtual_mig' });
const runtime = new Pool({ ...database, user: 'nvirtual_run' });
const prefix = '/partner-assumed/v1';
const received = [];
const callbackToken = randomUUID();
let callbackStatus = 204;
const marketing = createServer(async (req, res) => {
  assert.equal(req.url, '/internal/v1/naver/talktalk/webhook');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['content-type'], 'application/json;charset=UTF-8');
  assert.equal(req.headers.authorization, `Bearer ${callbackToken}`);
  let body = '';
  for await (const part of req) body += part;
  received.push(JSON.parse(body));
  res.writeHead(callbackStatus).end();
});

const seed = createPersonaSeedContext();
const account = seed.accountId;
const otherAccount = 'other-cafe-fixture';
const proofToken = randomUUID();
const deniedToken = randomUUID();
const otherToken = randomUUID();
const wireToken = randomUUID();
const fixturePath = '/internal/naver-virtual/v1/talktalk/webhook-fixtures/inbound-01/dispatch';
const wirePath = '/chatbot/v1/event';
const campaignPath = '/talktalk/marketing/sends';
let now = seed.now;
let app;
let origin;

const operations = [
  'pn02.bookings.read', 'pn02.bookings.cancel',
  'pn03.reviews.list', 'pn03.reviews.get', 'pn03.stats.read', 'pn03.reply.create', 'pn03.reply.update',
  'pn03.reply.delete', 'pn03.reply.draft', 'pn04.news.list', 'pn04.news.get', 'pn04.news.create',
  'pn04.news.update', 'pn04.news.delete', 'pn05.coupons.list', 'pn05.coupons.create', 'pn05.coupons.delete',
  'pn05.issues.list', 'pn05.issues.update', 'pn05.promotions.list', 'pn05.promotions.create', 'pn05.promotions.extend',
  'pn05.promotions.end', 'pn05.membership.list', 'pn06.consultations.list',
  'pn06.consultations.get', 'pn06.chatbot.send', 'pn06.fixture.dispatch', 'pn07.audiences.list', 'pn07.sends.create',
];

async function start() {
  app = createPersonaApp({
    pool: runtime, capabilities, now: () => now, logging: false,
    callback: createPersonaCallback({ talktalk: 'http://marketing:3000/internal/v1/naver/talktalk/webhook' }),
    grants: [
      { accountId: account, token: proofToken, workload: 'proof', operations,
        providerCredentials: { 'pn06.chatbot.send': { talktalkAuthorization: wireToken, talktalkCallbackToken: callbackToken },
          'pn06.fixture.dispatch': { talktalkCallbackToken: callbackToken } } },
      { accountId: account, token: deniedToken, workload: 'reader', operations: ['pn03.reviews.list'] },
      { accountId: otherAccount, token: otherToken, workload: 'other-proof', operations },
    ],
  });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
}

async function request(path, { method = 'GET', body, key, wire = false, authorization, status = 200,
  scopedAccount = account, token = proofToken } = {}) {
  const headers = {};
  if (token) headers['x-navis-naver-virtual-token'] = token;
  if (scopedAccount) headers['x-navis-naver-virtual-account'] = scopedAccount;
  if (key) headers['idempotency-key'] = key;
  if (authorization) headers.authorization = authorization;
  if (body !== undefined) headers['content-type'] = 'application/json;charset=UTF-8';
  const result = await fetch(origin + (wire ? path : prefix + path), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await result.text();
  assert.equal(result.status, status, `${method} ${path} returned ${result.status}: ${response}`);
  return response === '' ? undefined : JSON.parse(response);
}
const keys = (value, allowed) => assert.deepEqual(Object.keys(value).sort(), [...allowed].sort());
const mutate = (path, key, body, status = 200, method = 'POST') => request(path, { method, key, body, status });

try {
  await admin.query(`
    CREATE ROLE nvirtual_mig LOGIN;
    CREATE ROLE nvirtual_run LOGIN;
    CREATE SCHEMA naver_virtual AUTHORIZATION nvirtual_mig;
    GRANT USAGE ON SCHEMA naver_virtual TO nvirtual_run;
  `);
  const beforeDrops = capabilities.map((capability) => ['pn03', 'pn05'].includes(capability.id)
    ? { ...capability, migrations: capability.migrations.slice(0, -1) }
    : capability);
  await migratePersona(migration, beforeDrops);
  const deadColumns = () => migration.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'naver_virtual' AND (
      (table_name = 'pn03_reviews' AND column_name = 'reviewer_name')
      OR (table_name = 'pn05_membership_benefits' AND column_name IN ('issued', 'used'))
    ) ORDER BY column_name
  `);
  assert.deepEqual((await deadColumns()).rows.map((row) => row.column_name), ['issued', 'reviewer_name', 'used']);
  await migratePersona(migration, capabilities);
  assert.deepEqual((await deadColumns()).rows, []);
  await seedPersona(migration, capabilities, seed);
  marketing.listen(3000, '0.0.0.0');
  await once(marketing, 'listening');
  await start();
  await request('/readyz', { wire: true });

  await request('/reviews', { token: '', status: 401 });
  await request('/reviews', { scopedAccount: otherAccount, status: 403 });
  await request('/reviews/review-01/reply', { token: deniedToken, method: 'POST', body: { text: '등록' }, status: 403 });
  await request('/reviews/review-01', { token: otherToken, scopedAccount: otherAccount, status: 404 });
  assert.deepEqual((await runtime.query('SELECT ref FROM naver_virtual.pn03_reviews')).rows, []);

  const completedPath = '/bookings/booking-04';
  const completed = await request(completedPath);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.paymentAmount, 4500);
  const cancelReason = '예약 환불 요청';
  const cancel = { cancelReason, refund: { type: 'amount', value: 4500 } };
  await request(completedPath + '/cancel', {
    token: deniedToken, method: 'POST', key: 'denied-completed', body: cancel, status: 403,
  });
  await mutate(completedPath + '/cancel', 'missing-refund', { cancelReason }, 400);
  await mutate(completedPath + '/cancel', 'over-payment', { ...cancel, refund: { type: 'amount', value: 4501 } }, 400);
  assert.deepEqual(await request(completedPath), completed);
  const cancelled = await mutate(completedPath + '/cancel', 'completed-cancel', cancel);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await mutate(completedPath + '/cancel', 'completed-cancel', cancel), cancelled);
  assert.deepEqual(await request(completedPath), cancelled);
  await mutate(completedPath + '/cancel', 'second-cancel', cancel, 409);

  const review = await request('/reviews/review-01');
  keys(review, ['ref', 'text', 'keywords', 'media', 'stars', 'reply', 'hasReply']);
  keys(review.media[0], ['type', 'url']);
  assert.match(review.media[0].url, /^data:image\/png;base64,/);
  assert.equal(review.hasReply, false);
  assert.equal((await request('/reviews')).averageStars, 4.8);
  await personaTransaction(migration, account, (client) => client.query(
    "UPDATE naver_virtual.pn03_reviews SET visible = false WHERE ref = 'review-04'",
  ));
  assert.equal((await request('/reviews')).averageStars, null);
  await request('/reviews/review-04', { status: 404 });
  await personaTransaction(migration, account, (client) => client.query(
    "UPDATE naver_virtual.pn03_reviews SET visible = true WHERE ref = 'review-04'",
  ));
  const booking = await request('/reviews?scope=booking&rating=5&sort=use-date&hasReply=false');
  keys(booking.items[0], ['ref', 'text', 'keywords', 'media', 'stars', 'reply', 'hasReply', 'product', 'useDate']);
  assert(booking.items[0].useDate > booking.items[1].useDate);
  assert.equal((await request('/reviews/review-11')).stars, null);
  assert.deepEqual(await mutate('/reviews/review-01/reply-draft', undefined, { style: '친근하게', length: '짧게' }),
    { text: '방문해 주시고 소중한 후기를 남겨 주셔서 감사합니다.' });
  const alternativeDraft = await mutate('/reviews/review-01/reply-draft', undefined, { style: '격식 있게', length: '길게' });
  assert.deepEqual(alternativeDraft, { text: '방문해 주시고 소중한 후기를 남겨 주셔서 감사합니다.' });
  assert.equal((await request('/reviews/review-01')).reply, null);
  await mutate('/reviews/review-01/reply', undefined, { text: '고맙습니다.' }, 400);
  await mutate('/reviews/missing/reply', 'missing-review', { text: '고맙습니다.' }, 404);
  const duplicate = await Promise.all([
    mutate('/reviews/review-01/reply', 'reply-01', { text: '고맙습니다.' }),
    mutate('/reviews/review-01/reply', 'reply-01', { text: '고맙습니다.' }),
  ]);
  assert.equal(duplicate[0].reply, '고맙습니다.');
  assert.deepEqual(duplicate[0], duplicate[1]);
  assert.equal(received.length, 0);
  await mutate('/reviews/review-01/reply', 'reply-01', { text: '다른 요청이에요.' }, 409);
  await mutate('/reviews/review-01/reply', 'another-reply', { text: '다시 올려요.' }, 409);
  keys(await mutate('/reviews/review-01/reply', 'edit', { text: '방문해 주셔서 고맙습니다.' }, 200, 'PATCH'), Object.keys(review));
  const stats = await request('/review-statistics?period=day&to=2026-11-17');
  keys(stats, ['period', 'themes', 'topKeywords']);
  assert.deepEqual(stats.period, { unit: 'day', from: '2026-11-15', to: '2026-11-15' });
  assert.deepEqual(stats.themes.find((row) => row.theme === '운영'), { theme: '운영', positiveCount: 0, negativeCount: 1 });
  assert.deepEqual(stats.topKeywords.positive[0], {
    keyword: '고소한 라떼', count: 2, relatedReviews: [{ text: '라떼가 고소하고 매장이 조용해요.' }, { text: '라떼가 고소했어요.' }],
  });

  const news = await request('/place/news/news-01');
  keys(news, ['ref', 'title', 'text', 'video', 'pin']);
  keys(news.pin, ['from', 'to', 'order']);
  const newsInput = { title: '카페 이번 주 소식', text: '이번 주에도 카페에 놀러 오세요.' };
  await mutate('/place/news', 'foreign-video', { ...newsInput, video: 'outside-video' }, 404);
  await mutate('/place/news', 'long-pin', { ...newsInput, pin: { to: '2027-01-02', order: 1 } }, 400);
  for (let index = 0; index < 4; index += 1) {
    const posted = await mutate('/place/news', `news-${index}`, {
      ...newsInput, video: 'video-cafe-01', pin: { to: '2026-12-31', order: 1 },
    });
    assert.equal(posted.video, 'video-cafe-01');
  }
  await mutate('/place/news', 'pin-six', { ...newsInput, pin: { to: '2026-11-30', order: 1 } }, 409);
  const moved = await mutate('/place/news/news-01', 'move', { pin: { to: '2026-11-23', order: 1 } }, 200, 'PATCH');
  assert.equal(moved.pin.order, 1);
  await mutate('/place/news/news-01', 'delete-news', undefined, 204, 'DELETE');
  await request('/place/news/news-01', { status: 404 });

  const coupons = await request('/place/coupons');
  keys(coupons.items.find((coupon) => coupon.ref === 'coupon-01'), ['ref', 'type', 'name', 'benefit', 'audience', 'displayPeriod', 'quantity']);
  keys(coupons.items.find((coupon) => coupon.ref === 'coupon-03'), ['ref', 'type', 'name', 'benefit', 'audience']);
  const couponBody = { type: 'order', name: '주문 할인', benefit: { type: 'amount', value: 500 }, audience: 'all',
    displayPeriod: { from: '2026-11-17', to: '2026-11-18' }, quantity: 25 };
  await mutate('/place/coupons', 'benefit-overlap', { ...couponBody, audience: 'benefit-subscribers' }, 409);
  await mutate('/place/coupons', 'marketing-has-window', { ...couponBody, audience: 'marketing-message' }, 400);
  for (let index = 0; index < 8; index += 1) await mutate('/place/coupons', `coupon-create-${index}`, couponBody);
  await mutate('/place/coupons', 'coupon-overflow', couponBody, 409);
  await mutate('/place/coupons/coupon-01', 'delete-coupon', undefined, 204, 'DELETE');
  const issues = await request('/place/coupons/coupon-01/issues');
  keys(issues.items[0], ['ref', 'maskedNumber', 'issuedOn', 'expiresOn', 'used']);
  assert.equal(issues.items[0].expiresOn, '2026-11-24');
  assert.equal((await mutate('/place/coupon-issues/issue-01/usage', 'use', { used: true }, 200, 'PATCH')).used, true);
  await mutate('/place/coupon-issues/issue-02/usage', 'expired', { used: true }, 409, 'PATCH');

  const promotion = (await request('/order/promotions')).items[0];
  keys(promotion, ['ref', 'name', 'from', 'to', 'state', 'orderAmountPerStamp', 'coupons']);
  keys(promotion.coupons[0], ['stampCount', 'name', 'validDays', 'canCombine', 'canUseAlone']);
  assert.equal(promotion.state, 'active');
  await mutate('/order/promotions/promotion-01/extend', 'shorten', { to: '2026-11-19' }, 400);
  assert.equal((await mutate('/order/promotions/promotion-01/extend', 'extend', { to: '2026-11-26' })).to, '2026-11-26');
  assert.equal((await mutate('/order/promotions/promotion-01/end', 'end')).state, 'ended');
  await mutate('/order/promotions/promotion-01/extend', 'extend-ended', { to: '2026-11-27' }, 409);
  const upcoming = { name: '다음 주문 행사', from: '2026-11-18', to: '2026-11-19',
    orderAmountPerStamp: 3000, coupons: promotion.coupons };
  await mutate('/order/promotions', 'same-day', { ...upcoming, from: '2026-11-17' }, 400);
  await mutate('/order/promotions', 'discount-order', { ...upcoming, coupons: [{ ...promotion.coupons[0], amount: 1000 }] }, 400);
  assert.equal((await mutate('/order/promotions', 'next-day', upcoming)).state, 'upcoming');
  await mutate('/order/promotions', 'schedule-overlap', upcoming, 409);

  assert.deepEqual(await request('/membership/benefits'), { items: [] });
  await mutate('/membership/benefits/membership-01/visibility', 'unmatched', { visible: false }, 404, 'PATCH');
  await seedPersona(migration, [], { ...seed, accountId: otherAccount });
  await personaTransaction(migration, otherAccount, (client) => client.query(`
    INSERT INTO naver_virtual.pn05_membership_benefits
      (account_id,ref,provider,type,benefit,valid_days,visible,paused)
    VALUES ($1,'paid-01','페이히어','coupon','음료 증정',30,true,false),
      ($1,'dodo-01','도도포인트','coupon','음료 증정',30,true,NULL)
  `, [otherAccount]));
  const membershipRequest = { scopedAccount: otherAccount, token: otherToken };
  await request('/membership/benefits/paid-01/visibility',
    { ...membershipRequest, method: 'PATCH', body: { paused: true }, key: 'pause', status: 404 });
  const membership = await request('/membership/benefits', membershipRequest);
  const payhere = membership.items.find(item => item.ref === 'paid-01');
  keys(payhere, ['ref', 'provider', 'type', 'benefit', 'validDays', 'visible', 'paused']);
  assert.equal(payhere.paused, false);

  const consultations = await request('/talktalk/consultations?status=waiting&from=2026-11-17&to=2026-11-17');
  assert.deepEqual(consultations, { items: [
    { ref: 'consultation-01', status: 'waiting', messages: [{ text: '오늘 창가 자리가 있나요?' }] },
  ] });
  await request('/talktalk/consultations/consultation-hidden', { status: 404 });
  await request(fixturePath, { wire: true, method: 'POST', status: 204 });
  await request(fixturePath, { wire: true, method: 'POST', status: 204 });
  assert.deepEqual(received, [{ event: 'send', user: 'al-cafe-fixture-01',
    textContent: { text: '오늘 창가 자리가 있나요?', inputType: 'typing' } }]);
  const wireBody = { event: 'send', user: 'al-cafe-fixture-01', textContent: { text: '창가 좌석이 있어요.' } };
  const wireOptions = { method: 'POST', wire: true, authorization: wireToken, key: 'chat-reply' };
  assert.equal((await request(wirePath, { ...wireOptions, body: wireBody, authorization: 'wrong-token' })).resultCode, '01');
  assert.equal((await request(wirePath, { ...wireOptions, body: { ...wireBody, user: 'missing' } })).resultCode, '99');
  assert.deepEqual(await request(wirePath, { ...wireOptions, body: wireBody }), { success: true, resultCode: '00' });
  assert.deepEqual(await request(wirePath, { ...wireOptions, body: wireBody }), { success: true, resultCode: '00' });
  assert.deepEqual(received[1], { event: 'echo', echoedEvent: 'send', user: 'al-cafe-fixture-01', partner: 'cafe01',
    textContent: { text: '창가 좌석이 있어요.' } });
  assert.equal(received.length, 2);
  assert.deepEqual(await request('/talktalk/consultations/consultation-01'), consultations.items[0]);
  callbackStatus = 503;
  assert.deepEqual(await request(wirePath, { ...wireOptions, key: 'pending-echo', body: wireBody }), { success: true, resultCode: '00' });
  assert.deepEqual(await request(wirePath, { ...wireOptions, key: 'pending-echo', body: wireBody }), { success: true, resultCode: '00' });
  assert.equal(received.length, 3);
  await personaTransaction(runtime, account, async (client) => {
    const { rows } = await client.query("SELECT state FROM naver_virtual.pn06_webhook_events WHERE state = 'uncertain'");
    assert.equal(rows.length, 1);
  });

  assert.deepEqual(await request('/talktalk/marketing/audiences'), {
    items: [{ audience: 'benefit-subscribers' }, { audience: 'recent-visitor-reviewers' }],
    quota: { month: '2026-11', assigned: 18 },
  });
  const campaign = { audience: 'benefit-subscribers', title: '카페 소식', body: '오늘의 원두를 소개합니다.', couponRef: 'coupon-03' };
  await mutate(campaignPath, 'bad-attachment', { ...campaign, couponRef: 'coupon-02' }, 409);
  await Promise.all([mutate(campaignPath, 'campaign', campaign, 204), mutate(campaignPath, 'campaign', campaign, 204)]);
  assert.equal((await request('/talktalk/marketing/audiences')).quota.assigned, 18);
  await mutate('/place/coupons/coupon-03', 'delete-attached-coupon', undefined, 409, 'DELETE');
  await mutate(campaignPath, 'recent', { audience: 'recent-visitor-reviewers', title: '안숭잘부 카페', body: '다시 방문해 주세요.' }, 204);
  assert.equal((await request('/talktalk/marketing/audiences')).quota.assigned, 18);
  await personaTransaction(runtime, account, async client => {
    const { rows } = await client.query("SELECT ref FROM naver_virtual.pn07_campaigns WHERE month = '2026-11'");
    assert.equal(rows.length, 2);
  });

  await seedPersona(migration, capabilities, seed);
  await app.close();
  await start();
  assert.equal((await request('/reviews/review-01')).reply, '방문해 주셔서 고맙습니다.');
  await mutate(campaignPath, 'campaign', campaign, 204);
  assert.equal((await request('/talktalk/marketing/audiences')).quota.assigned, 18);
  await mutate('/reviews/review-01/reply', 'delete-reply', undefined, 204, 'DELETE');
  assert.equal((await request('/reviews/review-01')).hasReply, false);

  const freshSeed = createPersonaSeedContext(new Date('2026-12-01T01:00:00Z'));
  now = freshSeed.now;
  assert.deepEqual((await request('/talktalk/marketing/audiences')).quota, { month: '2026-12', assigned: 20 });
  await seedPersona(migration, capabilities, freshSeed);
  assert.deepEqual((await request('/review-statistics?period=day')).period, { unit: 'day', from: '2026-11-29', to: '2026-11-29' });
  assert.equal((await request('/talktalk/marketing/audiences')).quota.month, '2026-12');
  assert.equal((await request('/place/news/news-01')).pin.from, '2026-12-01');
  console.log('PN-P2 Compose proof passed: HTTP schemas, RLS, clock generations, replay, callbacks and source-specific lifecycle');
} finally {
  await app?.close();
  marketing.close();
  await Promise.all([admin.end(), migration.end(), runtime.end()]);
}
