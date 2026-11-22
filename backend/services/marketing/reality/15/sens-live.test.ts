import { expect, it, vi } from 'vitest';
import { createLiveSens, loadLiveSens, type SensSettings } from '../../../../workers/marketing-worker/naver/sens-live.ts';

const now = () => new Date('2026-11-22T01:00:00Z');
const settings = { storeName: '테스트 가게', senderNumber: '01012345678', optOutNumber: '0801234567' } satisfies SensSettings;
const files: Record<string, string> = {
  NCP_ACCESS_KEY: 'fake-access', NCP_SECRET_KEY: 'fake-secret',
  NCP_SENS_SMS_SERVICE_ID: 'ncp:sms:kr:1:test', NCP_SENS_MAIL_SERVICE_ID: 'ncp:mail:kr:1:test',
  NCP_SENS_SENDER_NUMBER: settings.senderNumber,
  NCP_SENS_TEST_RECIPIENTS: '010-2345-6789\nowner@example.test',
  NCP_SENS_MAIL_SENDER_ADDRESS: 'sender@example.test',
};
const readFile = (path: string) => files[path.split('/').at(-1)!];
const env = { NAVIS_NCP_SENS_PROVIDER: 'live', NAVIS_NCP_SECRETS_DIR: '/fake' };
const accepted = { requestId: 'RSSA-fixture', requestTime: '2026-11-22T10:00:00.000', statusCode: '202', statusName: 'success' };
const approval = { confirmed: true as const };

it('starts off and requires the complete SMS credential set when opted in', () => {
  const read = vi.fn();
  expect(loadLiveSens({}, read)).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
  expect(loadLiveSens(env, () => undefined)).toBeUndefined();
});

it('filters the owner allowlist and signs the documented SMS reservation request', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(accepted, { status: 202 }));
  const sens = createLiveSens(loadLiveSens(env, readFile)!, { storeId: 'store', now, fetcher });
  await expect(sens.sms({ settings, approval, to: ['01023456789', '01034567890'], body: '공지입니다.',
    advertising: true, reserveTime: '2026-11-22 11:00' })).resolves.toMatchObject({ sentCount: 1, skippedCount: 1, requestId: 'RSSA-fixture' });
  const [url, init] = fetcher.mock.calls[0];
  expect(String(url)).toBe('https://sens.apigw.ntruss.com/sms/v2/services/ncp:sms:kr:1:test/messages');
  expect(new Headers(init?.headers).get('x-ncp-apigw-signature-v2')).toBe('nXkWNYgcR44deLoa4b9ZM/m7VeSe5fhOi8Pl7PE6wmk=');
  expect(new Headers(init?.headers).has('idempotency-key')).toBe(false);
  expect(JSON.parse(Buffer.from(init?.body as Uint8Array).toString())).toMatchObject({
    from: '01012345678', contentType: 'AD', countryCode: '82', content: '(광고) 테스트 가게\n공지입니다.\n무료수신거부 0801234567',
    reserveTime: '2026-11-22 11:00', reserveTimeZone: 'Asia/Seoul', messages: [{ to: '01023456789' }],
  });
});

it('makes zero network requests for unlisted recipients, absent settings or an unconfirmed cancellation', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const sens = createLiveSens(loadLiveSens(env, readFile)!, { storeId: 'store', now, fetcher });
  await expect(sens.sms({ settings, approval, to: ['01034567890'], body: '공지', advertising: true }))
    .resolves.toEqual({ sentCount: 0, skippedCount: 1 });
  await expect(sens.mail({ settings: null, approval, to: ['owner@example.test'], title: '발주', body: '본문' }))
    .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  await expect(sens.cancel('RSSA-fixture', 'confirmed')).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('sends individual mail only to allowed addresses and caches delivery reads', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ requestId: 'mail-1', requestCount: 1, createDateTime: now().toISOString() }, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ requestId: 'mail-1', requestCount: 1, createDateTime: now().toISOString(),
      status: 'COMPLETED', readyCount: 1, sentCount: 1, finishCount: 1, reservationDateTime: null, countsByStatus: [{ status: 'SENT', count: 1 }] }));
  const sens = createLiveSens(loadLiveSens(env, readFile)!, { storeId: 'store', now, fetcher });
  await expect(sens.mail({ settings, approval, to: ['owner@example.test', 'other@example.test'], title: '발주', body: '본문' }))
    .resolves.toMatchObject({ requestId: 'mail-1', skippedCount: 1 });
  expect(JSON.parse(Buffer.from(fetcher.mock.calls[0][1]?.body as Uint8Array).toString())).toMatchObject({
    senderAddress: 'sender@example.test', individual: true, advertising: false, recipients: [{ address: 'owner@example.test', type: 'TO' }],
  });
  await expect(sens.mailResult('mail-1')).resolves.toBe('delivered');
  await expect(sens.mailResult('mail-1')).resolves.toBe('delivered');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('queries and cancels the provider reservation using its request ID', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ reserveId: 'RSSA-fixture', reserveTimeZone: 'Asia/Seoul',
      reserveTime: '2026-11-22T11:00:00+09:00', reserveStatus: 'READY' }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const sens = createLiveSens(loadLiveSens(env, readFile)!, { storeId: 'store', now, fetcher });
  await expect(sens.reservation('RSSA-fixture')).resolves.toBe('READY');
  await sens.cancel('RSSA-fixture', 'confirmed-twice');
  expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
    ['https://sens.apigw.ntruss.com/sms/v2/services/ncp:sms:kr:1:test/reservations/RSSA-fixture/reserve-status', 'GET'],
    ['https://sens.apigw.ntruss.com/sms/v2/services/ncp:sms:kr:1:test/reservations/RSSA-fixture', 'DELETE'],
  ]);
});
