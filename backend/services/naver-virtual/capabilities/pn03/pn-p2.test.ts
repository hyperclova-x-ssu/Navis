import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { validateInput } from '../../../../../frontend/server/promo/service.mjs';

const prefix = '/partner-assumed/v1';
const modules = import.meta.glob('../pn0[3-7]/index.ts', { eager: true });

describe('PN-P2 private endpoint contracts', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    const context = { providerCredential: () => 'synthetic-wire-token' };
    for (const entry of Object.values(modules)) {
      const { personaCapability } = entry as {
        personaCapability: { register(app: FastifyInstance, context: unknown): void };
      };
      app.register(async router => personaCapability.register(router, context));
    }
    await app.ready();
  });
  afterAll(async () => app.close());

  test.each([
    ['/reviews?scope=venue&rating=5', 400],
    ['/reviews?scope=booking&sort=reviewDate', 400],
    ['/review-statistics?period=hour', 400],
    ['/talktalk/consultations?status=delivered', 400],
    ['/talktalk/consultations?includeDeleted=true', 400],
  ])('rejects unsupported query %s', async (url, statusCode) => {
    const result = await app.inject({ url: prefix + url });
    expect(result.statusCode).toBe(statusCode);
  });

  test.each([
    ['POST', '/reviews/review-01/reply', { text: '고맙습니다.', smsAccepted: true }],
    ['POST', '/reviews/review-01/reply-draft', { style: '정중하게', length: '짧게', text: '임의 제안' }],
    ['DELETE', '/place/news/news-01', { scheduledAt: '2026-11-18T00:00:00Z' }],
    ['POST', '/place/news', { title: '카페 이번 주 소식', text: '이번 주에도 카페에 놀러 오세요.', video: 'https://example.test/a.mp4' }],
    ['POST', '/place/news', { text: '이번 주에도 카페에 놀러 오세요.' }],
    ['POST', '/place/news', { title: '짧다', text: '이번 주에도 카페에 놀러 오세요.' }],
    ['POST', '/place/coupons', { type: 'order', name: '쿠폰', menuId: 'latte' }],
    ['PATCH', '/place/coupon-issues/issue-01/usage', { used: true, phone: '01000000000' }],
    ['POST', '/order/promotions/promotion-01/end', { cancelIssuedCoupons: true }],
    ['POST', '/talktalk/marketing/sends', { audience: 'benefit-subscribers', title: '소식', body: '안내', push: true }],
    ['POST', '/talktalk/marketing/sends', { audience: 'benefit-subscribers', title: '소식', body: '안내', users: ['person'] }],
  ] as const)('rejects unsupported fields on %s %s', async (method, url, payload) => {
    const result = await app.inject({ method, url: prefix + url, payload });
    expect(result.statusCode).toBe(400);
  });

  test('keeps membership settings read-only in Persona', async () => {
    const result = await app.inject({
      method: 'PATCH', url: prefix + '/membership/benefits/membership-01/visibility', payload: { visible: false },
    });
    expect(result.statusCode).toBe(404);
  });

  test('restricts promo video input to owner catalog photos', () => {
    const photoIds = ['fin-01', 'fin-02', 'fin-03', 'fin-04', 'fin-05'];
    const catalog = { menus: [{ menuId: 'financier', photoIds }] };
    const references = { refs: new Map([['ref-1', {}]]) };
    const input = {
      menuIds: ['financier'], photoIds, moods: ['warm'], concepts: ['new-item'], memo: '',
      referenceId: 'ref-1', lengthSec: 10, locale: 'ko',
    };
    expect(validateInput(input, catalog, references)).toBeNull();
    expect(validateInput({ ...input, photoIds: [...photoIds.slice(1), 'data:image/png;base64,AAAA'] }, catalog, references))
      .toBe('photoIds');
    expect(validateInput({ ...input, photoIds: [...photoIds.slice(1), 'review-01'] }, catalog, references))
      .toBe('photoIds');
  });

  test('returns the official 01 envelope when TalkTalk Authorization is missing', async () => {
    const response = await app.inject({
      method: 'POST', url: '/chatbot/v1/event',
      payload: { event: 'send', user: 'synthetic-user', textContent: { text: '안녕하세요.' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: false, resultCode: '01', resultMessage: expect.any(String) });
  });

  test.each([
    '{',
    '{"event":"send","user":"synthetic-user","textContent":{"text":"안녕하세요.","inputType":"typing"}}',
    '{"event":"send","user":"synthetic-user","textContent":{"text":"안녕하세요."},"providerMessageId":"invented"}',
  ])('returns the official 02 envelope for invalid TalkTalk JSON', async (payload) => {
    const response = await app.inject({
      method: 'POST', url: '/chatbot/v1/event', payload,
      headers: { authorization: 'synthetic-wire-token', 'content-type': 'application/json;charset=UTF-8' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: false, resultCode: '02', resultMessage: expect.any(String) });
  });
});
