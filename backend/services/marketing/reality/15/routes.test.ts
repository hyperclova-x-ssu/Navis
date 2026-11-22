import Fastify from 'fastify';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { NaverAdapterError } from '../../naver/errors.ts';
import { definitiveRejection } from './commands.ts';
import { registerNoticeReplyRoutes } from './routes.ts';
import { noticeSmsText } from './sms-dispatch.ts';
import { nightNoticeHint, NoticeError, noticeCommand, smsReservationTime } from './wire.ts';

const store = 'd85e9289-0b89-4e02-8eb7-3ce777285baa';
const actor = '84215fce-fb71-4cc3-b030-3019c6394e96';
const root = `/internal/v1/marketing/stores/${store}`;
const headers = { authorization: 'Bearer marketing-test', 'x-navis-store-id': store,
  'x-navis-user-id': actor, 'x-navis-store-role': 'owner', 'idempotency-key': 'test-approval' };

describe('marketing notice and reply boundaries', () => {
  it('previews a scoped TalkTalk inquiry with server facts and makes no record or send writes', async () => {
    const app = Fastify();
    const record = { source: 'talktalk', providerRef: 'tt-1', status: 'waiting', data: { type: 'message', text: null } };
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('marketing.reply_notice_record') ? [record] : [] }));
    const pool = { connect: async () => ({ query, release() {} }) } as unknown as Pool;
    const hours = '일요일 영업시간은 10:00~20:30입니다.';
    const storedFacts = [hours, '아메리카노 가격은 3,500원입니다.'];
    const facts = vi.fn(async () => storedFacts);
    const draft = vi.fn(async () => `안녕하세요.\n${hours}\n감사합니다.`);
    registerNoticeReplyRoutes(app, pool, { gatewayToken: 'marketing-test', talkTalkDraft: { facts, draft },
      provider: { mode: 'fake', consultation: async () => ({ ref: 'tt-1', status: 'waiting', messages: [{ text: '일요일에도 문 여나요?' }] }) } });
    const url = root + `/inquiries/${actor}/navis-draft-preview`;
    try {
      expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-navis-store-role': 'staff' }, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers, payload: { inquiry: 'Browser text' } })).statusCode).toBe(400);
      expect(query).not.toHaveBeenCalled();
      const response = await app.inject({ method: 'POST', url, headers, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ source: 'navis', text: `안녕하세요.\n${hours}\n감사합니다.`, facts: [hours] });
      expect(facts).toHaveBeenCalledWith(expect.objectContaining({ storeId: store, actorId: actor }));
      expect(draft).toHaveBeenCalledWith({ inquiry: '일요일에도 문 여나요?', facts: storedFacts });
      expect(query.mock.calls.every(([sql]) => !/\b(?:INSERT|UPDATE|DELETE)\b/u.test(sql))).toBe(true);
      draft.mockResolvedValueOnce('안녕하세요.\n감사합니다.');
      const ungrounded = await app.inject({ method: 'POST', url, headers, payload: {} });
      expect(ungrounded.statusCode).toBe(422);
      expect(ungrounded.json()).toEqual({ code: 'DRAFT_UNGROUNDED' });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['manual', 'message', '매장 주소가 궁금합니다.'],
    ['manual', 'review', '매장 주소 안내가 있으면 좋겠어요.'],
    ['review', 'review', '매장 주소를 알기 어렵네요.'],
  ])('previews a stored %s %s using its text and shop facts without a write', async (source, type, original) => {
    const app = Fastify();
    const record = { source, providerRef: source === 'review' ? 'review-1' : null, status: 'waiting', data: { type, text: original } };
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('marketing.reply_notice_record') ? [record] : [] }));
    const pool = { connect: async () => ({ query, release() {} }) } as unknown as Pool;
    const address = '매장 주소는 상도로 1입니다.';
    const facts = vi.fn(async () => [address]);
    const draft = vi.fn(async () => `안녕하세요.\n${address}\n감사합니다.`);
    const consultation = vi.fn();
    registerNoticeReplyRoutes(app, pool, { gatewayToken: 'marketing-test', talkTalkDraft: { facts, draft },
      provider: { mode: 'fake', consultation } });
    const url = root + `/inquiries/${actor}/navis-draft-preview`;
    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ source: 'navis', text: `안녕하세요.\n${address}\n감사합니다.`, facts: [address] });
      expect(draft).toHaveBeenCalledWith({ inquiry: original, facts: [address] });
      expect(consultation).not.toHaveBeenCalled();
      expect(query.mock.calls.every(([sql]) => !/\b(?:INSERT|UPDATE|DELETE)\b/u.test(sql))).toBe(true);
      record.status = 'done';
      expect((await app.inject({ method: 'POST', url, headers, payload: {} })).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('reads the provider original for an imported review without stored text', async () => {
    const app = Fastify();
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('marketing.reply_notice_record')
      ? [{ source: 'review', providerRef: 'review-1', status: 'waiting', data: { type: 'review', text: null } }] : [] }));
    const pool = { connect: async () => ({ query, release() {} }) } as unknown as Pool;
    const address = '매장 주소는 상도로 1입니다.';
    const facts = vi.fn(async () => [address]);
    const draft = vi.fn(async () => `안녕하세요.\n${address}\n감사합니다.`);
    const review = vi.fn(async () => ({ ref: 'review-1', text: '매장 주소를 알려 주세요. 010-1234-5678',
      stars: 3, keywords: [], media: [], reply: null, hasReply: false }));
    registerNoticeReplyRoutes(app, pool, { gatewayToken: 'marketing-test', talkTalkDraft: { facts, draft },
      provider: { mode: 'fake', review } });
    try {
      const url = root + `/inquiries/${actor}/navis-draft-preview`;
      const response = await app.inject({ method: 'POST', url, headers, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(review).toHaveBeenCalledWith({ storeId: store, actorId: actor }, 'review-1');
      expect(draft.mock.calls[0]).toEqual([{ inquiry: expect.stringContaining('매장 주소를 알려 주세요.'), facts: [address] }]);
      expect(JSON.stringify(draft.mock.calls)).not.toContain('010-1234-5678');
      expect(query.mock.calls.every(([sql]) => !/\b(?:INSERT|UPDATE|DELETE)\b/u.test(sql))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('loads scoped callback conversations from the inbox for both provider modes', async () => {
    const app = Fastify();
    const entries = [{ id: actor, status: 'waiting', inbound: '일요일에도 문 여나요?', reply: null,
      receivedAt: new Date('2026-11-22T05:30:00Z'), repliedAt: new Date('2026-11-22T05:30:00Z') }];
    const query = vi.fn(async (sql: string, _params?: unknown[]) => ({ rows: sql.includes('marketing.talktalk_inbox_candidate') ? entries : [] }));
    const pool = { connect: async () => ({ query, release() {} }) } as unknown as Pool;
    const consultation = vi.fn(async () => ({ ref: 'provider-ref', status: 'waiting', messages: [] }));
    registerNoticeReplyRoutes(app, pool, { gatewayToken: 'marketing-test', provider: { mode: 'virtual', consultation } });
    try {
      for (const [prefix, live] of [['inbox-', false], ['live-inbox-', true]] as const) {
        const ref = `${prefix}${actor}`;
        const url = `${root}/talktalk/consultations/${ref}`;
        const result = await app.inject({ url, headers });
        expect(result.statusCode).toBe(200);
        expect(result.json()).toMatchObject({ ref, status: 'waiting', messages: [{ text: entries[0].inbound, from: 'user' }] });
        expect(query.mock.calls.some(([sql, params]) => sql.includes('marketing.talktalk_inbox_candidate')
          && JSON.stringify(params) === JSON.stringify([store, actor, live]))).toBe(true);
      }
      expect(consultation).not.toHaveBeenCalled();
      expect((await app.inject({ url: `${root}/talktalk/consultations/provider-ref`, headers })).statusCode).toBe(200);
      expect(consultation).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("allows fake and virtual providers and rejects live mode at registration", async () => {
    const app = Fastify();
    const pool = {} as Pool;
    try {
      for (const mode of ['fake', 'virtual'] as const) {
        expect(() => registerNoticeReplyRoutes(app, pool, { gatewayToken: 'test', provider: { mode } })).not.toThrow();
      }
      expect(() => registerNoticeReplyRoutes(app, pool, { gatewayToken: 'test',
        provider: { mode: 'live' as 'fake' } })).toThrow();
    } finally {
      await app.close();
    }
  });

  it('rejects cross-store requests and unapproved outbound writes before touching storage', async () => {
    const app = Fastify();
    const pool = { connect() { throw new Error('unexpected DB access'); } } as unknown as Pool;
    registerNoticeReplyRoutes(app, pool, { gatewayToken: 'marketing-test' });
    try {
      expect((await app.inject({ url: root + '/inquiries', headers: { ...headers, 'x-navis-store-id': actor } })).statusCode).toBe(403);
      const response = await app.inject({ method: 'POST', url: root + '/notices/' + actor + '/send',
        headers, payload: { expectedRevision: 1, approvalId: store } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: 'CARD_REQUIRED' });
    } finally {
      await app.close();
    }
  });

  it('rejects arbitrary TalkTalk recipients and personal contact data in public replies', () => {
    expect(() => noticeCommand('notice.create', { title: '공지', text: '영업 안내', channel: 'talktalk',
      audience: 'arbitrary-user' })).toThrow('INVALID_AUDIENCE');
    expect(() => noticeCommand('inquiry.saveDraft', { expectedRevision: 1, text: '010-1234-5678' }, 'review'))
      .toThrow('REPLY_CONTAINS_CONTACT');
  });

  it('uses the next local calendar day at night even after midnight', () => {
    expect(nightNoticeHint(new Date('2026-11-21T15:10:00Z'))).toEqual({
      localTime: '2026-11-23T08:00', label: '내일 8시',
    });
    expect(nightNoticeHint(new Date('2026-11-21T23:00:00Z'))).toBeNull();
  });
});

it('keeps the NAVER and Navis review previews separate and checks the owner before generation', async () => {
  const app = Fastify();
  registerNoticeReplyRoutes(app, {} as Pool, { gatewayToken: 'marketing-test', provider: {
    mode: 'fake',
    review: async (_scope, ref) => ({ ref, text: '커피가 맛있어요', keywords: [], media: [], stars: 5,
      reply: null, hasReply: false }),
    reviewDraft: async () => ({ text: '네이버 초안' }),
    navisReviewDraft: async (_scope, input) => ({ text: input.reviewText + ' 감사합니다' }),
  } });
  try {
    const preview = (path: string, claims = headers) => app.inject({ method: 'POST',
      url: root + '/reviews/fixture/' + path, headers: claims, payload: { style: '정중하게', length: '짧게' } });
    expect((await preview('draft-preview')).json()).toEqual({ text: '네이버 초안', source: 'naver-ai' });
    expect((await preview('navis-draft-preview')).json()).toEqual({ text: '커피가 맛있어요 감사합니다', source: 'navis' });
    expect((await preview('navis-draft-preview', { ...headers, 'x-navis-store-role': 'staff' })).statusCode).toBe(403);
  } finally { await app.close(); }
});


it('accepts a D-331 next-day card and rejects advertising at night or stale schedule times', () => {
  const at = new Date('2026-11-21T15:10:00Z');
  expect(smsReservationTime('2026-11-23T08:00', at, true)).toEqual({ local: '2026-11-23T08:00', at: new Date('2026-11-22T23:00:00Z') });
  expect(() => smsReservationTime('2026-11-22T08:00', at, true)).toThrow('NOTICE_OUTSIDE_SEND_WINDOW');
  expect(() => smsReservationTime('2026-11-23T21:00', new Date('2026-11-23T00:00:00Z'), true))
    .toThrow('NOTICE_OUTSIDE_SEND_WINDOW');
});

it('bounds the scheduling horizon to 30 days and keeps the 10-minute lead (RV-GAP-B-3)', () => {
  const at = new Date('2026-11-22T06:00:00Z'); // 15:00 KST
  expect(() => smsReservationTime('2026-11-22T15:10', at, true)).toThrow('SMS_SCHEDULE_TOO_SOON');
  expect(smsReservationTime('2026-12-22T15:00', at, true).local).toBe('2026-12-22T15:00');
  expect(() => smsReservationTime('2026-12-22T15:01', at, true)).toThrow('SMS_SCHEDULE_TOO_FAR');
});

it('frames advertising SMS with the sender line and free opt-out and picks SMS or LMS by bytes (RV-GAP-B-2)', () => {
  const short = noticeSmsText({ text: '(광고) 새 소식' });
  expect(short).toEqual({ content: '(광고) 스토어사스 테스트 매장 (연락처: 테스트 전용)\n새 소식\n무료수신거부 테스트 전용',
    contentType: 'AD', type: 'SMS', bytes: 84 });
  expect(noticeSmsText({ text: '내일은 쉬어요. 모레 다시 만나요.' })).toMatchObject({ type: 'LMS' });
  expect(noticeSmsText({ text: '가'.repeat(1000) })).toMatchObject({ type: null, bytes: null });
  expect(noticeSmsText({ text: '이모지 ☕️' }).type).toBeNull();
});

it('treats only adapter outcomes known to have sent nothing as definitive rejections (RV-GAP-B-5)', () => {
  expect(definitiveRejection(new NaverAdapterError('INVALID_INPUT'))).toBe('PROVIDER_INVALID_INPUT');
  expect(definitiveRejection(new NaverAdapterError('REJECTED'))).toBe('PROVIDER_REJECTED');
  expect(definitiveRejection(new NaverAdapterError('UNKNOWN_OUTCOME'))).toBeNull();
  expect(definitiveRejection(new NaverAdapterError('CONTRACT_VIOLATION'))).toBeNull();
  expect(definitiveRejection(new DOMException('timeout', 'TimeoutError'))).toBeNull();
  expect(definitiveRejection(new NoticeError(409, 'CLOSURE_CHANGED'))).toBe('CLOSURE_CHANGED');
});
