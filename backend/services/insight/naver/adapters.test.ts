import { describe, expect, it, vi } from 'vitest';
import type { NaverTransport } from '../../account/naver/wire.ts';
import { createInsightNaver, searchAdsAuthorization } from './index.ts';

const storeId = '00000000-0000-4000-8000-000000000001';
const period = { startDate: '2026-11-15', endDate: '2026-11-15' };
const now = () => new Date('2026-11-17T06:45:00Z');
const adId = 'cmp-a001-01-000000000000001';
const receiptPath = '/custom/v1/1/test/document/receipt';

function setup(payload: unknown, headers?: HeadersInit) {
  const request = vi.fn<NaverTransport['request']>(async () => Response.json(payload, { headers }));
  return { request, adapters: createInsightNaver({ request }, { now, receiptPath }) };
}

describe('Insight NAVER adapters', () => {
  it('scopes booking review filters and strips undocumented identity and media metadata', async () => {
    const review = { ref: 'r1', text: '좋아요', keywords: [], media: [
      { type: 'photo', url: 'https://example.invalid/a', uploader: 'private' },
    ], stars: null, reply: null, hasReply: false };
    const { request, adapters } = setup({ items: [{ ...review, phone: 'private' }], averageStars: 5 });
    expect(await adapters.reviews(storeId, { scope: 'booking', hasReply: false, sort: 'use-date' })).toEqual({
      items: [{ ...review, media: [{ type: 'photo', url: 'https://example.invalid/a' }] }],
    });
    expect(request).toHaveBeenCalledWith('pn03.reviews.list', storeId,
      '/partner-assumed/v1/reviews?scope=booking&hasReply=false&sort=use-date', undefined);
  });

  it('preserves the provider review statistics period', async () => {
    const payload = { period: { unit: 'day', from: period.startDate, to: period.endDate }, themes: [],
      topKeywords: { positive: [], negative: [] } };
    const { adapters } = setup(payload);
    expect(await adapters.reviewStatistics(storeId, { period: 'day', to: '2026-11-17' })).toEqual(payload);
  });

  it('keeps SmartCall briefing on the provider period and drops individual calls', async () => {
    const daily = [{ date: period.startDate, totalCalls: 3, connectedCalls: 1, arsCalls: 1, missedCalls: 1,
      busyCalls: 0, averageDurationSeconds: null, callsAtLeastTenSeconds: 0 }];
    const { adapters } = setup({ period, daily, calls: [{ phone: 'private' }], channels: ['플레이스'] });
    expect(await adapters.smartCallSummary(storeId, period)).toMatchObject({ period, daily, channels: ['플레이스'] });
    expect(await adapters.smartCallSummary(storeId, period)).not.toHaveProperty('calls');
  });

  it('binds Financial Center detail to the private Link selector and never exposes arbitrary links', async () => {
    const payload = [{ title: '지원 공고', officialNoticeUrl: 'https://www.bizinfo.go.kr/example', score: 99 }];
    const { adapters } = setup(payload, { link: '</partner-assumed/v1/financial-center/recommendations/r1>; rel="item"' });
    expect((await adapters.recommendations(storeId)).items).toEqual([
      { ref: 'r1', title: payload[0].title, officialNoticeUrl: payload[0].officialNoticeUrl },
    ]);
    await expect(adapters.recommendation(storeId, '../other')).rejects.toThrow();
  });

  it('emits Place cards only with provider period and known measurement fields', async () => {
    const source = 'https://help.naver.com/service/30026/contents/20524?lang=ko&osType=COMMONOS';
    const { adapters } = setup({ source: 'https://example.invalid/untrusted', period, cards: [
      { metric: 'views', value: 0, changeRate: -25, sales: 1000 },
      { metric: 'revenue', value: 1000 },
    ] });
    expect(await adapters.channelReport(storeId, 'place', { date: period.startDate })).toEqual({
      source, period, cards: [{ metric: 'views', value: 0, changeRate: -25 }],
    });
  });

  it('selects exact Ads stat fields and preserves missing observations', async () => {
    const { request, adapters } = setup({ data: [{ id: adId, impCnt: 0, salesAmt: 300, convAmt: 900 }] });
    const result = await adapters.adsReport(storeId, adId, period);
    expect(result.cards).toEqual([{ metric: 'impressions', value: 0 }, { metric: 'cost', value: 300 }]);
    const query = new URL(request.mock.calls[0]?.[2] ?? '', 'http://stub.invalid').searchParams;
    expect(JSON.parse(query.get('fields')!)).toEqual(['impCnt', 'clkCnt', 'salesAmt']);
    expect(JSON.parse(query.get('timeRange')!)).toEqual({ since: period.startDate, until: period.endDate });
    expect(searchAdsAuthorization('1', 'key-id', now)('test-secret')).toMatchObject({
      'X-API-KEY': 'key-id', 'X-Customer': '1', 'X-Timestamp': String(+now()), 'X-Signature': expect.any(String),
    });
  });

  it('preserves official speech audio and OCR multipart on the existing media provider seam', async () => {
    const { request, adapters } = setup({ text: '지출 입력해줘', quota: 1 });
    const fetchMedia = adapters.mediaFetch(storeId);
    const bytes = new Uint8Array([1, 2]);
    await fetchMedia('https://clovaspeech-gw.ncloud.com/recog/v1/stt?lang=Kor', { method: 'POST', body: bytes });
    expect(request).toHaveBeenLastCalledWith('pn15.speech', storeId, '/recog/v1/stt?lang=Kor',
      expect.objectContaining({ body: bytes }));
    const form = new FormData();
    form.set('message', '{}');
    await fetchMedia('https://receipt-fixture.invalid/document/receipt', { method: 'POST', body: form });
    expect(request).toHaveBeenLastCalledWith('pn15.receipt', storeId, receiptPath, expect.objectContaining({ body: form }));
    await expect(fetchMedia('https://example.invalid/document/receipt', { method: 'POST' })).rejects.toThrow();
  });

  it('uses existing HCX-005 chat path and forwards the stream untouched', async () => {
    const request = vi.fn<NaverTransport['request']>(async () =>
      new Response('event: result\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const adapters = createInsightNaver({ request }, { now });
    const fetchStudio = adapters.studioFetch(storeId);
    const url = 'https://navis-agent.invalid/v3/chat-completions/HCX-005';
    const body = JSON.stringify({ messages: [{ role: 'user', content: '오늘 매출' }], maxTokens: 128 });
    const response = await fetchStudio(url, {
      method: 'POST', headers: { accept: 'text/event-stream', authorization: 'Bearer placeholder' }, body,
    });
    expect(await response.text()).toContain('event: result');
    expect(request).toHaveBeenCalledWith('pn14.chat', storeId, '/v3/chat-completions/HCX-005',
      expect.objectContaining({ body, headers: expect.any(Headers) }));
    expect(new Headers(request.mock.calls[0]?.[3]?.headers).has('authorization')).toBe(false);
    await expect(fetchStudio(url.replace('HCX-005', 'HCX-007'), { method: 'POST', body })).rejects.toThrow();
  });
});

it('rejects model tool calls and projects only editable draft text and usage', async () => {
  const result = { message: { role: 'assistant', content: '안녕하세요.' }, finishReason: 'stop',
    usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
  const status = { code: '20000' };
  const good = setup({ status, result });
  expect(await good.adapters.studioDraft(storeId, '공지 초안')).toEqual({
    text: '안녕하세요.', usage: { promptTokens: 5, completionTokens: 2, latencyMs: 0 },
  });
  const bad = setup({ status, result: { ...result, message: { ...result.message, toolCalls: [{}] } } });
  await expect(bad.adapters.studioDraft(storeId, '공지 초안')).rejects.toMatchObject({ status: 503 });
});

it('rejects out-of-period and cross-record provider results', async () => {
  const calls = setup({ period: { startDate: '2026-11-14', endDate: '2026-11-14' }, channels: [], daily: [] });
  await expect(calls.adapters.smartCallSummary(storeId, period)).rejects.toMatchObject({ status: 503 });
  const ads = setup({ data: [{ id: 'other-campaign', impCnt: 12 }] });
  await expect(ads.adapters.adsReport(storeId, adId, period, { grant: 'test-a6' })).rejects.toMatchObject({ status: 503 });
  expect(ads.request).toHaveBeenCalledWith('pn12.ads', storeId, expect.stringMatching(/^\/stats\?/),
    { approvalScope: { grant: 'test-a6' } });
});
