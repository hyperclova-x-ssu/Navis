import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClovaStudio } from '../../../../../frontend/server/clova-studio.mjs';
import { createVirtualSensTransport, createSensWire } from '../../../../workers/marketing-worker/naver/pn13-sens.ts';
import { createStudioPromoFetch } from '../../../../workers/marketing-worker/naver/pn14-studio.ts';
import { createPromoObjectStore } from '../../../../workers/marketing-worker/naver/pn16-objects.ts';
import { personaTransaction } from '../../../naver-virtual/db.ts';
import { NaverAdapterError } from '../errors.ts';
import { createNaverMarketing } from '../index.ts';
import { reviewShape } from '../pn03-reply.ts';
import { newsShape } from '../pn04-news.ts';
import { couponIssueShape, orderPromotionShape } from '../pn05-coupons.ts';
import { fieldPaths, valuePaths } from '../schema.ts';
import { OFFICIAL, outside } from './official-fields.ts';
import {
  ACCOUNT, CAFE, FIXED_NOW, marketingProvider, OBJECTS, preparePersonaDatabase, SENDER, SERVICE_IDS, startMarketingReceiver, startPersona,
  STORE_ID, TOKENS, WEBHOOK_URL,
} from './persona.ts';

/**
 * PN-A2 adapters against the committed naver-virtual provider and a disposable PostgreSQL.
 * Set PN_A2_DATABASE_URL to a superuser URL of an empty database (see README); skipped otherwise.
 */
const databaseUrl = process.env.PN_A2_DATABASE_URL;
const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error instanceof NaverAdapterError ? error.code : `unexpected:${String(error)}`; }
  return 'resolved';
};
const sorted = (values: string[]) => [...new Set(values)].sort();
const within = (actual: string[], official: readonly string[]) => expect(outside(actual, official)).toEqual([]);
const createStudio = createClovaStudio as unknown as (options: { apiKey: string; baseUrl: string; model: string; fetchImpl: typeof fetch }) =>
  { complete(options: Record<string, unknown>): AsyncIterable<unknown> };

describe.skipIf(!databaseUrl)('PN-A2 adapters → naver-virtual HTTP + DB', () => {
  let persona: Awaited<ReturnType<typeof startPersona>>;
  let receiver: Awaited<ReturnType<typeof startMarketingReceiver>>;
  let context: ReturnType<typeof marketingProvider>;
  let naver: ReturnType<typeof createNaverMarketing>;
  const lastBody = (prefix: string) => JSON.parse(context.guard.calls.filter(call => call.path.startsWith(prefix) && call.body).at(-1)!.body!);

  beforeAll(async () => {
    await preparePersonaDatabase(databaseUrl!);
    receiver = await startMarketingReceiver();
    const callbackFetcher: typeof fetch = (input, init) => {
      expect(String(input)).toBe(WEBHOOK_URL);
      return fetch(new URL('/internal/v1/naver/talktalk/webhook', receiver.address), init);
    };
    persona = await startPersona({ databaseUrl: databaseUrl!, callbackFetcher });
    context = marketingProvider({ target: persona.address });
    naver = createNaverMarketing(context.provider, {
      clock: { now: () => FIXED_NOW }, cafeGrant: async () => ({ accessToken: CAFE.accessToken, boards: [CAFE] }),
    });
  });
  afterAll(async () => {
    expect(context?.guard.blocked ?? []).toEqual([]);
    await persona?.close();
    await receiver?.app.close();
  });

  it('PN03 posts one reply on press, replays the same key, refuses a conflict and reads back from the DB', async () => {
    const first = await naver.reply.post({ reviewRef: 'review-03', text: '창가 자리 마음에 드셨다니 기뻐요.', attemptKey: 'navis:proof-0001' });
    expect(first).toEqual({ effect: 'reply-posted', reply: '창가 자리 마음에 드셨다니 기뻐요.', readBack: 'confirmed' });
    expect(await naver.reply.post({ reviewRef: 'review-03', text: '창가 자리 마음에 드셨다니 기뻐요.', attemptKey: 'navis:proof-0001' })).toEqual(first);
    expect(await naver.reply.post({ reviewRef: 'review-03', text: '다른 문장', attemptKey: 'navis:proof-0001' }).catch(error => error))
      .toMatchObject({ code: 'CONFLICT', providerCode: 'IDEMPOTENCY_CONFLICT' });
    await expect(naver.reply.post({ reviewRef: 'review-03', text: '또 다른 답글', attemptKey: 'navis:proof-0002' }))
      .rejects.toMatchObject({ code: 'CONFLICT', providerCode: 'CONFLICT' });
    await expect(naver.reply.readReview('missing-review')).rejects.toMatchObject({ code: 'NOT_FOUND', providerCode: 'NOT_FOUND' });
    const calls = context.guard.calls.length;
    expect(await code(naver.reply.update({ reviewRef: 'review-03', text: '010-1234-5678로 연락 주세요', attemptKey: 'navis:proof-0003' }))).toBe('INVALID_INPUT');
    expect(await code(naver.reply.remove({ reviewRef: 'review-03', attemptKey: 'navis:proof-0004', confirmation: true }))).toBe('CONFIRMATION_REQUIRED');
    expect(context.guard.calls.length).toBe(calls);
    const review = await naver.reply.readReview('review-01');
    expect(sorted(valuePaths(review))).toEqual(sorted(fieldPaths(reviewShape).filter(path => !['product', 'useDate'].includes(path))));
    expect((await naver.reply.update({ reviewRef: 'review-03', text: '다음에도 창가 자리 준비할게요.', attemptKey: 'navis:proof-0005' })).readBack).toBe('confirmed');
    expect(await naver.reply.remove({ reviewRef: 'review-03', attemptKey: 'navis:proof-0006', confirmation: 'confirmed-twice' }))
      .toEqual({ effect: 'reply-deleted', reply: null, readBack: 'confirmed' });
    expect((await naver.reply.draft({ reviewRef: 'review-05', style: '정중하게', length: '짧게' })).source).toBe('naver-ai');
  });

  it('PN04 publishes news with an owner video and notice, keeps 45 days, deletes on second confirmation', async () => {
    expect(await code(naver.news.create({ title: '연말 휴무 안내', text: '12월 31일은 하루 쉬어 갑니다.', pin: { to: '2027-01-01', order: 1 }, attemptKey: 'navis:news-0001' }))).toBe('INVALID_INPUT');
    const created = await naver.news.create({ title: '연말 휴무 안내', text: '12월 31일은 하루 쉬어 갑니다.', video: 'video-cafe-01',
      pin: { to: '2026-11-30', order: 1 }, attemptKey: 'navis:news-0002' });
    expect(created).toMatchObject({ effect: 'news-published', readBack: 'confirmed', news: { video: 'video-cafe-01', pin: { from: '2026-11-17', to: '2026-11-30', order: 1 } } });
    expect(sorted(valuePaths(created.news))).toEqual(sorted(fieldPaths(newsShape)));
    expect((await naver.news.update({ ref: created.news.ref, pin: null, attemptKey: 'navis:news-0003' })).news.pin).toBeNull();
    expect(await code(naver.news.remove({ ref: created.news.ref, attemptKey: 'navis:news-0004', confirmation: 'yes' }))).toBe('CONFIRMATION_REQUIRED');
    expect(await naver.news.remove({ ref: created.news.ref, attemptKey: 'navis:news-0005', confirmation: 'confirmed-twice' })).toEqual({ effect: 'news-deleted', readBack: 'confirmed' });
    expect((await naver.news.list()).items.some(item => item.ref === 'news-01')).toBe(true);
  });

  it('PN05 keeps Place coupon, issue usage, Order promotion and membership boundaries per product', async () => {
    const { coupons } = naver;
    expect(await code(coupons.createPlaceCoupon({ coupon: { type: 'place', name: '톡톡 쿠폰', benefit: { type: 'gift', item: '쿠키' }, audience: 'marketing-message',
      displayPeriod: { from: '2026-11-18', to: '2026-11-30' } }, attemptKey: 'navis:cpn-0001' }))).toBe('INVALID_INPUT');
    const created = await coupons.createPlaceCoupon({ coupon: { type: 'place', name: '오후 라떼 할인', benefit: { type: 'percent', value: 12.5 }, audience: 'all',
      displayPeriod: { from: '2026-11-16', to: '2026-11-30' }, quantity: 30 }, attemptKey: 'navis:cpn-0002' });
    expect(created.coupon).toMatchObject({ audience: 'all', benefit: { type: 'percent', value: 12.5 },
      displayPeriod: { from: '2026-11-16', to: '2026-11-30' }, quantity: 30 });
    const issues = await coupons.listCouponIssues({ couponRef: 'coupon-01' });
    expect(sorted(issues.items.flatMap(item => valuePaths(item)))).toEqual(sorted(fieldPaths(couponIssueShape)));
    expect((await coupons.setIssueUsage({ issueRef: 'issue-01', used: true, attemptKey: 'navis:use-0001' })).issue.used).toBe(true);
    expect(await code(coupons.setIssueUsage({ issueRef: 'issue-02', used: true, attemptKey: 'navis:use-0002' }))).toBe('CONFLICT');
    expect(await code(coupons.deletePlaceCoupon({ ref: created.coupon.ref, attemptKey: 'navis:cpn-0003', confirmation: undefined }))).toBe('CONFIRMATION_REQUIRED');
    expect(await coupons.deletePlaceCoupon({ ref: created.coupon.ref, attemptKey: 'navis:cpn-0004', confirmation: 'confirmed-twice' }))
      .toEqual({ effect: 'place-coupon-deleted', earlierDownloadsStayValid: true });

    const promotion = { name: '겨울 스탬프', from: '2026-11-17', to: '2026-12-20', orderAmountPerStamp: 5_000,
      coupons: [{ stampCount: 8, name: '라떼 1잔 무료', validDays: 60, canCombine: false, canUseAlone: true }] };
    expect(await code(coupons.createOrderPromotion({ promotion, attemptKey: 'navis:op-0001' }))).toBe('INVALID_INPUT');
    const scheduled = await coupons.createOrderPromotion({ promotion: { ...promotion, from: '2026-11-27' }, attemptKey: 'navis:op-0002' });
    expect(scheduled.promotion.state).toBe('upcoming');
    expect(sorted(valuePaths(scheduled.promotion))).toEqual(sorted(fieldPaths(orderPromotionShape).filter(path => !path.endsWith('instructions'))));
    expect((await coupons.extendOrderPromotion({ ref: 'promotion-01', to: '2026-11-26', attemptKey: 'navis:op-0003' })).promotion.to).toBe('2026-11-26');
    expect(await code(coupons.endOrderPromotion({ ref: 'promotion-01', attemptKey: 'navis:op-0004', confirmation: null }))).toBe('CONFIRMATION_REQUIRED');
    expect((await coupons.endOrderPromotion({ ref: 'promotion-01', attemptKey: 'navis:op-0005', confirmation: 'confirmed-twice' })).promotion.state).toBe('ended');
    expect(await coupons.listMembershipBenefits()).toEqual({ items: [] });
    const membershipWrite = await fetch(new URL('/partner-assumed/v1/membership/benefits/benefit-1/visibility', persona.address), {
      method: 'PATCH', headers: { 'x-navis-naver-virtual-token': TOKENS.marketing, 'x-navis-naver-virtual-account': 'ansungjalbu-cafe',
        'content-type': 'application/json' }, body: JSON.stringify({ visible: false }),
    });
    expect(membershipWrite.status).toBe(404);
  });

  it('PN06 reads retained consultations, replies through the chatbot wire and receives persona events on the marketing route', async () => {
    const waiting = await naver.talktalk.listConsultations({ status: 'waiting' });
    expect(waiting.items.map(item => item.ref)).toContain('consultation-01');
    expect((await naver.talktalk.getConsultation('consultation-02')).status).toBe('completed');
    const dispatch = await fetch(new URL('/internal/naver-virtual/v1/talktalk/webhook-fixtures/inbound-01/dispatch', persona.address), {
      method: 'POST', headers: { 'x-navis-naver-virtual-token': TOKENS.fixture, 'x-navis-naver-virtual-account': 'ansungjalbu-cafe' },
    });
    expect(dispatch.status).toBe(204);
    expect(receiver.inbox[0]).toMatchObject({ kind: 'inquiry', user: 'al-cafe-fixture-01', text: '오늘 창가 자리가 있나요?', inputType: 'typing' });
    expect(await naver.talktalk.sendReply({ user: 'al-cafe-fixture-01', text: '네, 창가 자리 있어요.', attemptKey: 'navis:tt-0001' })).toEqual({ state: 'accepted' });
    within(valuePaths(lastBody('/chatbot/v1/event')), OFFICIAL.chatbotSend);
    expect(receiver.inbox.at(-1)).toMatchObject({ kind: 'echo', text: '네, 창가 자리 있어요.', echoedEvent: 'send' });
    expect(await naver.talktalk.sendReply({ user: 'al-unknown-user', text: '안녕하세요' }).catch(error => error)).toMatchObject({ code: 'REJECTED', providerCode: '99' });
  });

  it('PN07 sends one provider group by day and keeps the Navis night policy', async () => {
    const audiences = await naver.talktalkMarketing.audiences();
    expect(audiences.items).toEqual([{ audience: 'benefit-subscribers' }, { audience: 'recent-visitor-reviewers' }]);
    expect(audiences.quota).toEqual({ month: '2026-11', assigned: 18 });
    const send = { audience: 'recent-visitor-reviewers', title: '겨울 메뉴', body: '유자 라떼가 나왔어요.', attemptKey: 'navis:tm-0001' } as const;
    expect(await naver.talktalkMarketing.send(send)).toEqual({ effect: 'talktalk-marketing-accepted', audience: 'recent-visitor-reviewers' });
    expect(await naver.talktalkMarketing.send(send)).toEqual({ effect: 'talktalk-marketing-accepted', audience: 'recent-visitor-reviewers' });
    await expect(persona.pool.query("SELECT count(*)::int AS count FROM naver_virtual.pn07_campaigns WHERE month = '2026-11'"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(personaTransaction(persona.pool, ACCOUNT, client => client.query(
      "SELECT count(*)::int AS count FROM naver_virtual.pn07_campaigns WHERE month = '2026-11'")))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    expect(await naver.talktalkMarketing.audiences()).toEqual(audiences);
    const night = createNaverMarketing(context.provider, { clock: { now: () => new Date('2026-11-17T13:30:00Z') } });
    const calls = context.guard.calls.length;
    expect(await night.talktalkMarketing.send({ audience: 'benefit-subscribers', title: '겨울 메뉴', body: '유자 라떼', attemptKey: 'navis:tm-0002' }).catch(error => error))
      .toMatchObject({ code: 'REJECTED', detail: 'night-window' });
    expect(context.guard.calls.length).toBe(calls);
  });

  it('PN17 accepts the official form without a private retry key and wraps the result in message', async () => {
    const response = await fetch(new URL(`/v1/cafe/${CAFE.clubid}/menu/${CAFE.menuid}/articles`, persona.address), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CAFE.accessToken}`, 'x-navis-naver-virtual-token': TOKENS.marketing,
        'x-navis-naver-virtual-account': 'ansungjalbu-cafe', 'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'subject=cafe+writing+test&content=This+is+cafe+writing+API+test.',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: expect.objectContaining({
      status: '200', result: expect.objectContaining({ articleId: expect.any(Number) }),
    }) });
  });

  it('PN10 search, trend and geocoding keep the exact official field lists', async () => {
    for (const channel of ['blog', 'cafearticle', 'local', 'news'] as const) {
      const { attribution, result } = await naver.search.search(channel, { query: '카페', display: channel === 'local' ? 5 : 10 });
      expect(attribution).toMatchObject({ provider: 'NAVER', operation: `pn10.${channel}`, use: 'display-only' });
      const paths = valuePaths(result);
      expect(sorted(paths.filter(path => !path.includes('[]')))).toEqual(sorted(OFFICIAL.searchEnvelope));
      within(paths.filter(path => path.startsWith('items[].')).map(path => path.slice(8)), OFFICIAL[channel]);
    }
    const trend = await naver.search.trend({ request: { startDate: '2026-11-14', endDate: '2026-11-16', timeUnit: 'date', keywordGroups: [{ groupName: '라떼', keywords: ['카페라떼'] }] } });
    within(valuePaths(trend.result), OFFICIAL.trend);
    const geocode = await naver.search.geocode({ query: '서울특별시 동작구 상도동 999-12' });
    within(valuePaths(geocode.result), OFFICIAL.geocode);
    const calls = context.guard.calls.length;
    expect(await code(naver.search.search('local', { query: '카페', display: 6 }))).toBe('INVALID_INPUT');
    expect(context.guard.calls.length).toBe(calls);
  });

  it('PN12 publishes an owned clip and reads its link', async () => {
    const published = await naver.clips.publish({ media: 'fixture-cafe-promo', caption: '겨울 메뉴 영상', category: '음식', tags: ['상도동카페'],
      visibility: 'public', attemptKey: 'navis:clip-0001' });
    expect(published).toMatchObject({ effect: 'clip-published', visibility: 'public', link: expect.stringMatching(/^https:\/\//) });
    expect(await naver.clips.read(published.ref)).toEqual({ ref: published.ref, link: published.link });
  });

  it('PN13 SENS products are accepted at 202 with official request fields; results and worker transport read back', async () => {
    const wire = createSensWire(context.provider, { serviceIds: SERVICE_IDS, clock: { now: () => FIXED_NOW } });
    const sms = await wire.sendSms({ type: 'SMS', contentType: 'COMM', from: SENDER.sms, to: ['01000000001'], content: '내일 오전 10시 단체석 준비했어요.' });
    expect(sorted(Object.keys(sms))).toEqual(sorted(OFFICIAL.smsAccepted));
    within(valuePaths(lastBody('/sms/')), OFFICIAL.smsRequest);
    const listed = await wire.listSms(sms.requestId);
    expect(listed.messages).toHaveLength(1);
    expect((await wire.getSms(listed.messages[0].messageId)).messages[0].to).toBe('01000000001');
    const alim = await wire.sendAlimTalk({ plusFriendId: '@ansungjalbu', templateCode: 'cafe-order', messages: [{ to: '01000000001', content: '주문 안내' }] });
    within(valuePaths(lastBody('/alimtalk/')), OFFICIAL.alimtalkRequest);
    expect((await wire.getAlimTalk(alim.messages![0].messageId)).requestStatusCode).toBe(alim.messages![0].requestStatusCode);
    const brand = await wire.sendBrandText({ plusFriendId: '@ansungjalbu', targeting: 'I', messages: [{ to: '01000000001', content: '이번 주 유자 라떼 소식' }] });
    within(valuePaths(lastBody('/brandmessage/')), OFFICIAL.brandRequest);
    expect((await wire.getBrand(brand.messages![0].messageId)).messageType).toBe('TEXT');
    const mail = await wire.sendMail({ senderAddress: SENDER.mail, title: '원두 발주', body: '에티오피아 2kg 부탁드려요.', to: [{ address: 'supplier@example.test' }] });
    within(valuePaths(lastBody('/mail/')), OFFICIAL.mailRequest);
    expect((await wire.getMailRequest(mail.requestId)).requestCount).toBe(1);
    const transport = createVirtualSensTransport(wire, 'virtual');
    const outcome = await transport.send({ dispatchId: 'd-1', senderNumber: SENDER.sms, number: '01000000002', body: '감사합니다.' }, new AbortController().signal);
    expect(outcome).toMatchObject({ state: 'accepted' });
    expect(await transport.reconcile({ dispatchId: 'd-2', requestId: null }, new AbortController().signal)).toEqual({ state: 'unknown' });
    const wrong = marketingProvider({ target: persona.address, overrides: { '/run/secrets/naver/sens.json': JSON.stringify({ accessKey: 'fixture-access', secretKey: 'wrong' }) } });
    expect(await code(createSensWire(wrong.provider, { serviceIds: SERVICE_IDS, clock: { now: () => FIXED_NOW } })
      .sendSms({ type: 'SMS', contentType: 'COMM', from: SENDER.sms, to: ['01000000001'], content: '테스트' }))).toBe('FORBIDDEN');
  });

  it('PN14 sends the existing HCX-007 Structured Outputs request with the bound key and returns the provider result', async () => {
    const studio = createStudio({ apiKey: 'attempt-key-not-sent', baseUrl: 'https://promo-fixture.invalid', model: 'HCX-007',
      fetchImpl: createStudioPromoFetch(context.provider)('story', 'attempt-7c1d') });
    const events: unknown[] = [];
    for await (const event of studio.complete({ messages: [{ role: 'system', content: '홍보 영상 이야기를 만들어 주세요.' }, { role: 'user', content: '유자 라떼' }],
      maxTokens: 512, responseFormat: { type: 'json', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } })) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'result' });
  });

  it('PN16 stores, reads and removes a promo object under the granted prefix with SigV4', async () => {
    const store = createPromoObjectStore(context.provider, OBJECTS);
    const scope = { storeId: STORE_ID, artifactId: 'job-1-video' };
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
    const put = await store.put(scope, bytes, 'video/mp4');
    expect(put.key).toBe(`marketing/${STORE_ID}/job-1-video`);
    expect(Buffer.from((await store.get(scope, put.sha256)).bytes)).toEqual(Buffer.from(bytes));
    expect(await store.remove(scope)).toEqual({ removed: true });
    expect(await code(store.get(scope))).toBe('NOT_FOUND');
    const wrong = marketingProvider({ target: persona.address, overrides: { '/run/secrets/naver/objects.json': JSON.stringify({ accessKeyId: 'FIXTUREACCESSKEY01', secretAccessKey: 'wrong' }) } });
    expect(await code(createPromoObjectStore(wrong.provider, OBJECTS).put(scope, bytes, 'video/mp4'))).toBe('FORBIDDEN');
  });

  it('PN17 posts text to the permitted Café board with the owner grant only', async () => {
    const posted = await naver.cafe.post({ clubid: CAFE.clubid, menuid: CAFE.menuid, subject: '상도동 카페 연합 겨울 행사', text: '12월 첫 주 <공동 스탬프>\n함께해요', attemptKey: 'navis:cafe-0001' })
      .catch((error: NaverAdapterError) => ({ code: error.code, providerStatus: error.providerStatus, providerCode: error.providerCode }));
    expect(posted).toMatchObject({ effect: 'cafe-article-posted', articleUrl: expect.stringMatching(/^https:\/\/cafe\.naver\.com\//) });
    expect(await naver.cafe.post({ clubid: CAFE.clubid, menuid: CAFE.menuid, subject: '상도동 카페 연합 겨울 행사',
      text: '12월 첫 주 <공동 스탬프>\n함께해요', attemptKey: 'navis:cafe-0001' })).toEqual(posted);
    const calls = context.guard.calls.length;
    expect(await code(naver.cafe.post({ clubid: CAFE.clubid, menuid: '2', subject: '제목', text: '본문', attemptKey: 'navis:cafe-0002' }))).toBe('FORBIDDEN');
    expect(context.guard.calls.length).toBe(calls);
  });

  it('refuses a wrong workload token or provider account at persona', async () => {
    const token = marketingProvider({ target: persona.address, overrides: { '/run/secrets/persona/marketing-token': 'wrong-token-but-long-enough' } });
    expect(await code(createNaverMarketing(token.provider).news.list())).toBe('FORBIDDEN');
    const account = marketingProvider({ target: persona.address, providerAccount: 'other-cafe' });
    expect(await code(createNaverMarketing(account.provider).news.list())).toBe('FORBIDDEN');
  });
});
