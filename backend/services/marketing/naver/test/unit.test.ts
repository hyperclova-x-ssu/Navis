import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createMarketingProvider, marketingBindings, sensSignature, signV4 } from '../binding.ts';
import { NaverAdapterError } from '../errors.ts';
import { createNaverMarketing, parseTalkTalkEvent, registerTalkTalkInbound, talkTalkInboundPath, type InboundEvent } from '../index.ts';
import { replyText } from '../pn03-reply.ts';
import { partnerOutcome } from '../transport.ts';

const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error instanceof NaverAdapterError ? error.code : `unexpected:${String(error)}`; }
  return 'resolved';
};
const base = { storeId: '7f0c0b3e-2a54-4d7e-9b1e-0f7cf1a00001', providerAccount: 'ansungjalbu-cafe' };

describe('bindings (PERSONA_NAVER §3, PN-P0 transport)', () => {
  it('refuses live P/O and live W without an A6 approval check', () => {
    expect(() => marketingBindings({ ...base, mode: 'live', operations: ['pn03.reply.create'], approve: () => true })).toThrow(/Live binding unavailable/);
    expect(() => marketingBindings({ ...base, mode: 'live', operations: ['pn10.blog'], credentialFiles: { 'api-key': '/k' } })).toThrow(/Live binding unavailable/);
    const [live] = marketingBindings({ ...base, mode: 'live', operations: ['pn10.blog'], credentialFiles: { 'api-key': '/k' }, approve: () => true });
    expect(live).toMatchObject({ mode: 'live', origin: 'https://naverapihub.apigw.ntruss.com', allowedOrigins: ['https://naverapihub.apigw.ntruss.com'] });
  });

  it('keeps A-3 on the in-process fake transport with zero sockets', async () => {
    const seen: string[] = [];
    const provider = createMarketingProvider({
      ...base, mode: 'fake', fakeOnly: true, operations: ['pn03.reply.create', 'pn03.reviews.get'],
      fakeHandler: request => {
        seen.push(`${request.method} ${request.url.pathname} ${request.headers.get('idempotency-key')}`);
        const review = { ref: 'review-03', text: '좋아요', keywords: [], media: [], stars: 5, reply: '감사합니다.', hasReply: true };
        return Response.json(review, { status: request.method === 'POST' ? 201 : 200 });
      },
    });
    const naver = createNaverMarketing(provider);
    expect(await naver.reply.post({ reviewRef: 'review-03', text: '감사합니다.', attemptKey: 'navis:fake-0001' }))
      .toEqual({ effect: 'reply-posted', reply: '감사합니다.', readBack: 'confirmed' });
    expect(seen).toEqual(['POST /partner-assumed/v1/reviews/review-03/reply navis:fake-0001', 'GET /partner-assumed/v1/reviews/review-03 null']);
    expect(() => createMarketingProvider({ ...base, mode: 'virtual', fakeOnly: true, privateTokenFile: '/t', operations: ['pn04.news.list'] })).toThrow();
    expect(await code(naver.news.list())).toBe('NOT_CONFIGURED');
  });

  it('rejects a provider field outside the allowlist in persona/fake mode', async () => {
    const provider = createMarketingProvider({
      ...base, mode: 'fake', operations: ['pn03.reviews.get'],
      fakeHandler: () => Response.json({ ref: 'review-01', text: 'x', keywords: [], media: [], stars: null, reply: null, hasReply: false, reviewerPhone: '01000000000' }),
    });
    expect(await createNaverMarketing(provider).reply.readReview('review-01').catch(error => error)).toMatchObject({ code: 'CONTRACT_VIOLATION', detail: '$.reviewerPhone' });
  });
});

describe('official signatures', () => {
  it('signs S3 requests like the AWS Signature V4 "GET Object" example', () => {
    const example = signV4({
      method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(example.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('signs SENS requests over "{METHOD} {path?query}\\n{timestamp}\\n{accessKey}"', () => {
    expect(sensSignature('POST', '/sms/v2/services/svc/messages', '1700000000000', 'AK', 'SK')).toBe('Csfz880Gun7Jk6si/ZChubnV5yixmY46mYAoyKHRXjM=');
  });
});

describe('owner input guards', () => {
  it('uses Navis copy for generic partner failures and keeps an uncertain write pending', () => {
    expect(() => partnerOutcome({ status: 409, headers: new Headers(), body: Buffer.from('{"message":"fixture-only prose"}') }, true))
      .toThrowError(expect.objectContaining({ code: 'CONFLICT', message: '현재 상태를 확인한 뒤 다시 시도해 주세요.' }));
    expect(() => partnerOutcome({ status: 502, headers: new Headers(), body: Buffer.from('<html>error</html>') }, true))
      .toThrowError(expect.objectContaining({ code: 'UNKNOWN_OUTCOME' }));
  });

  it('keeps personal details out of review replies (20545)', () => {
    expect(() => replyText('010-1234-5678로 연락 주세요')).toThrowError(expect.objectContaining({ detail: 'personal-details' }));
    expect(() => replyText('mail@example.com 으로')).toThrow();
    expect(replyText(' 감사합니다. ')).toBe('감사합니다.');
  });

  it('accepts the official TalkTalk send/echo events on the PN-P0 callback path and refuses invented fields', async () => {
    expect(parseTalkTalkEvent({ event: 'send', user: 'al-1', textContent: { text: '안녕하세요', inputType: 'typing' }, options: { mobile: true } }, true))
      .toMatchObject({ kind: 'inquiry', text: '안녕하세요' });
    expect(() => parseTalkTalkEvent({ event: 'send', user: 'al-1', textContent: { text: 'x' }, profile: { phone: '010' } }, true)).toThrow();
    const app = Fastify();
    const inbox: InboundEvent[] = [];
    const callbackToken = 'synthetic-unit-workload';
    registerTalkTalkInbound(app, { mode: 'virtual', callbackToken, onEvent: async event => { inbox.push(event); } });
    expect(talkTalkInboundPath).toBe('/internal/v1/naver/talktalk/webhook');
    const payload = { event: 'echo', echoedEvent: 'send', user: 'al-1', partner: 'cafe01', textContent: { text: '네', inputType: 'typing' } };
    const request = { method: 'POST' as const, url: talkTalkInboundPath, payload };
    expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject({ ...request, headers: { authorization: 'Bearer unrelated-chatbot-token' } })).statusCode).toBe(401);
    expect(inbox).toHaveLength(0);
    const headers = { authorization: `Bearer ${callbackToken}` };
    const ok = await app.inject({ ...request, headers });
    const bad = await app.inject({ ...request, headers, payload: { ...payload, extra: 1 } });
    expect([ok.statusCode, bad.statusCode]).toEqual([200, 400]);
    expect(inbox).toEqual([expect.objectContaining({ kind: 'echo', echoedEvent: 'send', text: '네' })]);
    expect(() => registerTalkTalkInbound(Fastify(), { mode: 'live', onEvent: async () => {} })).toThrow();
  });
});
