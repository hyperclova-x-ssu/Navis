import { createClovaStudio } from '../../../../../../frontend/server/clova-studio.mjs';
import { createVirtualSensTransport, createSensWire } from '../../../../../workers/marketing-worker/naver/pn13-sens.ts';
import { createStudioPromoFetch } from '../../../../../workers/marketing-worker/naver/pn14-studio.ts';
import { createPromoObjectStore } from '../../../../../workers/marketing-worker/naver/pn16-objects.ts';
import { NaverAdapterError } from '../../errors.ts';
import { createNaverMarketing } from '../../index.ts';
import { reviewShape } from '../../pn03-reply.ts';
import { newsShape } from '../../pn04-news.ts';
import { couponIssueShape } from '../../pn05-coupons.ts';
import { fieldPaths, valuePaths } from '../../schema.ts';
import { OFFICIAL, outside } from '../official-fields.ts';
import { CAFE, FIXED_NOW, marketingProvider, OBJECTS, PERSONA_ORIGIN, SENDER, SERVICE_IDS, startMarketingReceiver, STORE_ID } from '../persona.ts';

/**
 * PN-A2 Compose proof: the `marketing` container calls the `naver-virtual` container (committed
 * provider + PostgreSQL) through PN-P0 over the internal network and receives its TalkTalk callback on
 * :3000. W wires are compared with the official field lists, P/O payloads with the contract allowlists.
 * Prints one JSON summary; exit code 1 on any failed check.
 */
const results: { check: string; ok: boolean; detail?: unknown }[] = [];
const assert = (condition: unknown, detail: unknown) => { if (!condition) throw Object.assign(new Error('assertion failed'), { detail }); };
const sameSet = (actual: string[], expected: readonly string[]) => JSON.stringify([...new Set(actual)].sort()) === JSON.stringify([...new Set(expected)].sort());
const failure = async (promise: Promise<unknown>) => {
  try { await promise; return 'resolved'; } catch (error) { return error instanceof NaverAdapterError ? error.code : String(error); }
};
async function check(name: string, run: () => Promise<unknown>) {
  try { results.push({ check: name, ok: true, detail: await run() }); }
  catch (error) {
    results.push({ check: name, ok: false, detail: (error as { detail?: unknown }).detail ?? (error instanceof NaverAdapterError ? `${error.code}:${error.detail ?? ''}` : String(error)) });
  }
}

const receiver = await startMarketingReceiver({ host: '0.0.0.0', port: 3000 });
const context = marketingProvider({ target: PERSONA_ORIGIN });
const naver = createNaverMarketing(context.provider, { clock: { now: () => FIXED_NOW }, cafeGrant: async () => ({ accessToken: CAFE.accessToken, boards: [CAFE] }) });
const lastBody = (prefix: string) => JSON.parse(context.guard.calls.filter(call => call.path.startsWith(prefix) && call.body).at(-1)!.body!);

await check('PN03 reply post → DB read-back → replay → conflict → second-confirmed delete', async () => {
  const posted = await naver.reply.post({ reviewRef: 'review-03', text: '창가 자리 마음에 드셨다니 기뻐요.', attemptKey: 'navis:proof-0001' });
  const replay = await naver.reply.post({ reviewRef: 'review-03', text: '창가 자리 마음에 드셨다니 기뻐요.', attemptKey: 'navis:proof-0001' });
  const conflict = await failure(naver.reply.post({ reviewRef: 'review-03', text: '바뀐 문장', attemptKey: 'navis:proof-0001' }));
  const review = await naver.reply.readReview('review-01');
  const removed = await naver.reply.remove({ reviewRef: 'review-03', attemptKey: 'navis:proof-0002', confirmation: 'confirmed-twice' });
  assert(posted.readBack === 'confirmed' && JSON.stringify(replay) === JSON.stringify(posted) && conflict === 'CONFLICT' && removed.readBack === 'confirmed', { posted, conflict, removed });
  assert(!outside(valuePaths(review), fieldPaths(reviewShape)).length, valuePaths(review));
  return { posted: posted.effect, conflict, removed: removed.effect, reviewFields: valuePaths(review) };
});

await check('PN04 news with owner video + notice, 45-day rule, delete', async () => {
  const created = await naver.news.create({ title: '연말 휴무 안내', text: '12월 31일은 하루 쉬어 갑니다.', video: 'video-cafe-01', pin: { to: '2026-11-30', order: 1 }, attemptKey: 'navis:proof-0101' });
  const tooLong = await failure(naver.news.create({ title: '연말 휴무 안내', text: '12월 31일은 하루 쉬어 갑니다.', pin: { to: '2027-01-01', order: 1 }, attemptKey: 'navis:proof-0102' }));
  const removed = await naver.news.remove({ ref: created.news.ref, attemptKey: 'navis:proof-0103', confirmation: 'confirmed-twice' });
  assert(created.readBack === 'confirmed' && sameSet(valuePaths(created.news), fieldPaths(newsShape)) && tooLong === 'INVALID_INPUT' && removed.readBack === 'confirmed', created);
  return { news: valuePaths(created.news), tooLong };
});

await check('PN05 Place coupon, expired issue refusal, Order promotion end', async () => {
  const coupon = await naver.coupons.createPlaceCoupon({ coupon: { type: 'place', name: '오후 라떼 할인', benefit: { type: 'amount', value: 500 }, audience: 'all',
    displayPeriod: { from: '2026-11-18', to: '2026-11-30' }, quantity: 30 }, attemptKey: 'navis:proof-0201' });
  const used = await naver.coupons.setIssueUsage({ issueRef: 'issue-01', used: true, attemptKey: 'navis:proof-0202' });
  const expired = await failure(naver.coupons.setIssueUsage({ issueRef: 'issue-02', used: true, attemptKey: 'navis:proof-0203' }));
  const ended = await naver.coupons.endOrderPromotion({ ref: 'promotion-01', attemptKey: 'navis:proof-0204', confirmation: 'confirmed-twice' });
  assert(sameSet(valuePaths(used.issue), fieldPaths(couponIssueShape)) && expired === 'CONFLICT' && ended.promotion.state === 'ended', { used, expired, ended });
  return { coupon: valuePaths(coupon.coupon), expired, promotion: ended.promotion.state };
});

await check('PN06 consultations + chatbot reply (official fields) + persona echo callback to marketing', async () => {
  const waiting = await naver.talktalk.listConsultations({ status: 'waiting' });
  const sent = await naver.talktalk.sendReply({ user: 'al-cafe-fixture-01', text: '네, 창가 자리 있어요.', attemptKey: 'navis:proof-0301' });
  assert(waiting.items.length > 0 && sent.state === 'accepted' && !outside(valuePaths(lastBody('/chatbot/v1/event')), OFFICIAL.chatbotSend).length, waiting);
  for (let tries = 0; tries < 20 && !receiver.inbox.length; tries++) await new Promise(resolve => setTimeout(resolve, 100));
  assert(receiver.inbox.some(event => event.kind === 'echo'), receiver.inbox);
  return { inbox: receiver.inbox.map(event => event.kind) };
});

await check('PN07 audiences and one group send', async () => {
  const audiences = await naver.talktalkMarketing.audiences();
  const sent = await naver.talktalkMarketing.send({ audience: 'recent-visitor-reviewers', title: '겨울 메뉴', body: '유자 라떼가 나왔어요.', attemptKey: 'navis:proof-0401' });
  return { audiences, sent };
});

await check('PN10 search/trend/geocode within the official field lists', async () => {
  const fields: Record<string, string[]> = {};
  for (const channel of ['blog', 'cafearticle', 'local', 'news'] as const) {
    const { result } = await naver.search.search(channel, { query: '카페', display: channel === 'local' ? 5 : 10 });
    const paths = valuePaths(result);
    assert(sameSet(paths.filter(path => !path.includes('[]')), OFFICIAL.searchEnvelope)
      && !outside(paths.filter(path => path.startsWith('items[].')).map(path => path.slice(8)), OFFICIAL[channel]).length, paths);
    fields[channel] = paths;
  }
  const trend = await naver.search.trend({ request: { startDate: '2026-11-14', endDate: '2026-11-16', timeUnit: 'date', keywordGroups: [{ groupName: '라떼', keywords: ['카페라떼'] }] } });
  const geocode = await naver.search.geocode({ query: '서울특별시 동작구 상도동 999-12' });
  assert(!outside(valuePaths(trend.result), OFFICIAL.trend).length && !outside(valuePaths(geocode.result), OFFICIAL.geocode).length, { trend, geocode });
  return fields;
});

await check('PN12 owned clip publish and link read-back', async () => {
  const published = await naver.clips.publish({ media: 'fixture-cafe-promo', caption: '겨울 메뉴 영상', category: '음식', visibility: 'public', attemptKey: 'navis:proof-0501' });
  const read = await naver.clips.read(published.ref);
  assert(read.link === published.link && published.link, { published, read });
  return published;
});

await check('PN13 SMS/AlimTalk/Brand/Mail: official request fields, 202, results, worker transport', async () => {
  const wire = createSensWire(context.provider, { serviceIds: SERVICE_IDS, clock: { now: () => FIXED_NOW } });
  const sms = await wire.sendSms({ type: 'SMS', contentType: 'COMM', from: SENDER.sms, to: ['01000000001'], content: '예약 확인 문자예요.' });
  assert(!outside(valuePaths(lastBody('/sms/')), OFFICIAL.smsRequest).length && sameSet(Object.keys(sms), OFFICIAL.smsAccepted), sms);
  const listed = await wire.listSms(sms.requestId);
  await wire.sendAlimTalk({ plusFriendId: '@ansungjalbu', templateCode: 'cafe-order', messages: [{ to: '01000000001', content: '주문 안내' }] });
  assert(!outside(valuePaths(lastBody('/alimtalk/')), OFFICIAL.alimtalkRequest).length, lastBody('/alimtalk/'));
  await wire.sendBrandText({ plusFriendId: '@ansungjalbu', targeting: 'I', messages: [{ to: '01000000001', content: '이번 주 소식' }] });
  assert(!outside(valuePaths(lastBody('/brandmessage/')), OFFICIAL.brandRequest).length, lastBody('/brandmessage/'));
  const mail = await wire.sendMail({ senderAddress: SENDER.mail, title: '원두 발주', body: '2kg 부탁드려요.', to: [{ address: 'supplier@example.test' }] });
  assert(!outside(valuePaths(lastBody('/mail/')), OFFICIAL.mailRequest).length, lastBody('/mail/'));
  const outcome = await createVirtualSensTransport(wire, 'virtual').send({ dispatchId: 'proof-1', senderNumber: SENDER.sms, number: '01000000002', body: '감사합니다.' }, new AbortController().signal);
  return { smsStatus: listed.messages[0]?.status, mailStatus: (await wire.getMailRequest(mail.requestId)).status, workerTransport: outcome.state };
});

await check('PN14 HCX-007 Structured Outputs through the bound Studio key', async () => {
  const studio = (createClovaStudio as unknown as (options: object) => { complete(options: object): AsyncIterable<unknown> })({
    apiKey: 'not-forwarded', baseUrl: 'https://promo-fixture.invalid', model: 'HCX-007', fetchImpl: createStudioPromoFetch(context.provider)('story', 'proof-attempt-1'),
  });
  let events = 0;
  for await (const event of studio.complete({ messages: [{ role: 'user', content: '유자 라떼 이야기' }], maxTokens: 256,
    responseFormat: { type: 'json', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } })) {
    assert(event !== undefined, 'Expected a Studio completion event');
    events++;
  }
  assert(events === 1, events);
  return { events };
});

await check('PN16 SigV4 PUT/GET/DELETE under the granted prefix', async () => {
  const store = createPromoObjectStore(context.provider, OBJECTS);
  const scope = { storeId: STORE_ID, artifactId: 'proof-video' };
  const put = await store.put(scope, new Uint8Array([1, 2, 3, 4]), 'video/mp4');
  const got = await store.get(scope, put.sha256);
  await store.remove(scope);
  assert(got.bytes.length === 4 && await failure(store.get(scope)) === 'NOT_FOUND', got);
  return { key: put.key };
});

await check('PN17 Café post to the permitted board only', async () => {
  const posted = await naver.cafe.post({ clubid: CAFE.clubid, menuid: CAFE.menuid, subject: '상도동 카페 연합 행사', text: '함께해요', attemptKey: 'navis:proof-0601' });
  const other = await failure(naver.cafe.post({ clubid: CAFE.clubid, menuid: '9', subject: 's', text: 't', attemptKey: 'navis:proof-0602' }));
  assert(posted.effect === 'cafe-article-posted' && other === 'FORBIDDEN', { posted, other });
  return posted;
});

await check('denied: wrong workload token and wrong provider account', async () => {
  const token = await failure(createNaverMarketing(marketingProvider({ target: PERSONA_ORIGIN, overrides: { '/run/secrets/persona/marketing-token': 'wrong-token-but-long-enough' } }).provider).news.list());
  const account = await failure(createNaverMarketing(marketingProvider({ target: PERSONA_ORIGIN, providerAccount: 'other-cafe' }).provider).news.list());
  assert(token === 'FORBIDDEN' && account === 'FORBIDDEN', { token, account });
  return { token, account };
});

await check('blocked internet destination from the marketing workload', async () => {
  const outcome = await fetch('https://naverapihub.apigw.ntruss.com/', { signal: AbortSignal.timeout(5_000) }).then(response => `status:${response.status}`, () => 'blocked');
  assert(outcome === 'blocked' && context.guard.blocked.length === 0, outcome);
  return { outcome, personaCalls: context.guard.calls.length };
});

await receiver.app.close();
const failed = results.filter(result => !result.ok);
console.log(JSON.stringify({ proof: 'PN-A2 marketing adapters → naver-virtual (committed provider) over Compose', clock: FIXED_NOW.toISOString(),
  passed: results.length - failed.length, failed: failed.length, results }));
process.exitCode = failed.length ? 1 : 0;
