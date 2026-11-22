import { expect, it } from 'vitest';
import { NaverAdapterError } from '../../naver/errors.ts';
import type { SensWire } from '../../../../workers/marketing-worker/naver/pn13-sens.ts';
import { createNoticeSmsWorker } from '../../../../workers/marketing-worker/notice/sms.ts';

const store = 'd85e9289-0b89-4e02-8eb7-3ce777285baa';
const dispatchId = '4b4b0f0a-0d3b-4bd5-9a3f-6f0b6f8a2c11';
const stale = '9a0d7c3e-5d5e-4f21-8b1c-9d0f4a2b6e33';

function harness(sendSms: SensWire['sendSms'], due: unknown[]) {
  const reports: { path: string; body: unknown }[] = [];
  const claims: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer worker-token');
    expect(url.pathname.startsWith('/internal/v1/marketing/notice-sms-dispatch/stores/' + store)).toBe(true);
    if (init?.method === 'GET' || !init?.method) return Response.json(due);
    if (url.pathname.endsWith('/claim')) {
      claims.push(url.pathname);
      return Response.json({ dispatchId, type: 'SMS', contentType: 'AD', content: '(광고) 가게\n소식\n무료수신거부', from: '01000000000',
        batches: [{ batch: 0, to: ['01000001000'] }, { batch: 1, to: ['01000001001'] }] });
    }
    reports.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  };
  const worker = createNoticeSmsWorker({ marketingUrl: new URL('http://marketing:3000'), token: 'worker-token', storeId: store,
    sens: { sendSms } as SensWire, fetcher, now: () => new Date('2026-11-23T01:00:00Z') });
  return { worker, reports, claims };
}

it('sends each claimed batch once, replays an unknown outcome with the same key and never resends a stale claim', async () => {
  const keys: string[] = [];
  let calls = 0;
  const { worker, reports, claims } = harness(async input => {
    keys.push(input.attemptKey!);
    expect(input).toMatchObject({ contentType: 'AD', type: 'SMS', from: '01000000000' });
    expect(input.reserveTime).toBeUndefined();
    calls++;
    if (calls === 1) return { requestId: 'RSLA-1', requestTime: '', statusCode: '202', statusName: 'success' };
    if (calls === 2) throw new DOMException('timeout', 'TimeoutError');
    return { requestId: 'RSLA-2', requestTime: '', statusCode: '202', statusName: 'success' };
  }, [{ dispatchId: stale, state: 'dispatching', pendingBatches: [3] }, { dispatchId, state: 'scheduled', pendingBatches: [] }]);
  await worker.step();
  expect(claims).toHaveLength(1);
  expect(keys).toEqual([`notice-sms:${dispatchId}:0`, `notice-sms:${dispatchId}:1`, `notice-sms:${dispatchId}:1`]);
  expect(reports.map(report => [report.path.split('/').at(-2), report.body])).toEqual([
    [stale, { batch: 3, state: 'unknown' }],
    [dispatchId, { batch: 0, state: 'accepted', providerId: 'RSLA-1' }],
    [dispatchId, { batch: 1, state: 'accepted', providerId: 'RSLA-2' }],
  ]);
});

it('reports a documented refusal as failed and a repeated unknown outcome as unknown', async () => {
  let calls = 0;
  const { worker, reports } = harness(async () => {
    calls++;
    if (calls === 1) throw new NaverAdapterError('REJECTED', { providerStatus: 400 });
    throw new NaverAdapterError('UNKNOWN_OUTCOME');
  }, [{ dispatchId, state: 'scheduled', pendingBatches: [] }]);
  await worker.step();
  expect(calls).toBe(3);
  expect(reports.map(report => report.body)).toEqual([{ batch: 0, state: 'failed' }, { batch: 1, state: 'unknown' }]);
});
