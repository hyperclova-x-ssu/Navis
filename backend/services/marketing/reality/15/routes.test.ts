import Fastify from 'fastify';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
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
