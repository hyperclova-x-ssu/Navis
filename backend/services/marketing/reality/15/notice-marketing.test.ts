import { expect, it, vi } from 'vitest';
import { createVirtualNoticeMarketing } from './notice-marketing.ts';

it('binds a notice campaign to the virtual PN07 send route with the durable attempt key', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const provider = createVirtualNoticeMarketing({
    storeId: 'fixture-store', providerAccount: 'fixture-account', virtualOrigin: 'http://naver-virtual:3000',
    privateTokenFile: '/fixture/token', readCredential: () => 'synthetic-token', fetcher,
    now: () => new Date('2026-11-21T03:00:00Z'),
  });

  await expect(provider.campaign({
    effectId: 'receipt-1', audience: 'benefit-subscribers', title: '신메뉴', body: '새 메뉴가 나왔어요', couponRef: null,
  })).resolves.toEqual({ state: 'accepted' });
  const [[url, request]] = fetcher.mock.calls;
  expect(String(url)).toBe('http://naver-virtual:3000/partner-assumed/v1/talktalk/marketing/sends');
  expect(request?.method).toBe('POST');
  expect(new Headers(request?.headers).get('idempotency-key')).toBe('receipt-1');
  expect(JSON.parse(new TextDecoder().decode(request?.body as Uint8Array))).toEqual({
    audience: 'benefit-subscribers', title: '신메뉴', body: '새 메뉴가 나왔어요',
  });

  await expect(provider.talktalk.sendReply({ user: 'visitor', text: '답장', attemptKey: 'receipt-2' }))
    .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
