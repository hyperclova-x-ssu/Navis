import { describe, expect, it, vi } from 'vitest';
import { createNaverDraftsClient, type NaverDraftTransport } from './naver-drafts';

const draft = { draftId: 'one', kind: 'reply', content: { body: '감사합니다.' }, sourceLabels: ['예시 원문'] };
const targets = { mode: 'fake', targets: [{ id: 'alias-1', label: '테스트 번호 1' }] };

describe('Naver widget draft client', () => {
  it('uses same-origin requests and sends precisely the confirmed body once per action', async () => {
    const transport = vi.fn<NaverDraftTransport>()
      .mockResolvedValueOnce(Response.json(draft))
      .mockResolvedValueOnce(Response.json(targets))
      .mockResolvedValueOnce(Response.json({ status: 'simulated', receiptId: 'r1' }))
      .mockResolvedValueOnce(Response.json({ status: 'accepted', receiptId: 'r2' }, { status: 202 }));
    const client = createNaverDraftsClient(transport);
    expect(await client.generate('ai-response', 'th-4')).toEqual({ status: 'draft', ...draft });
    expect(await client.getTargets()).toEqual({ status: 'targets', ...targets });
    const input = { draftId: 'one', targetId: 'alias-1', body: '  감사합니다.\n' };
    expect(await client.send(input)).toEqual({ status: 'simulated', receiptId: 'r1' });
    expect(await client.send(input)).toEqual({ status: 'accepted', receiptId: 'r2' });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(transport.mock.calls[0]).toEqual(['/api/navis/widget-drafts', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', cache: 'no-store', body: '{"widget":"ai-response","sampleId":"th-4"}',
    })]);
    expect(transport.mock.calls[1]).toEqual(['/api/navis/reply-test-targets', expect.objectContaining({ method: 'GET' })]);
    const sends = transport.mock.calls.slice(2);
    expect(sends[0]?.[0]).toBe('/api/navis/reply-test-send');
    expect(JSON.parse(sends[0]?.[1].body as string)).toEqual({ ...input, confirmed: true });
    const keys = sends.map(([, init]) => new Headers(init.headers).get('Idempotency-Key'));
    expect(keys[0]).toMatch(/^[a-z0-9-]+$/i);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it.each([
    [400, 'BAD_REQUEST'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [405, 'METHOD_NOT_ALLOWED'],
    [409, 'CONFLICT'], [413, 'PAYLOAD_TOO_LARGE'], [422, 'INVALID_REPLY'], [429, 'RATE_LIMITED'],
    [502, 'INVALID_OUTPUT'], [502, 'SEND_FAILED'], [503, 'UNAVAILABLE'], [503, 'SEND_DISABLED'],
    [504, 'TIMEOUT'], [504, 'SEND_UNKNOWN'],
  ] as const)('preserves %s %s without retrying', async (httpStatus, code) => {
    const transport = vi.fn<NaverDraftTransport>().mockResolvedValue(
      Response.json({ code }, { status: httpStatus, headers: httpStatus === 429 ? { 'Retry-After': '30' } : {} }),
    );
    expect(await createNaverDraftsClient(transport).generate('grants', 'g-smart')).toEqual({
      status: 'error', code, httpStatus, ...(httpStatus === 429 ? { retryAfterSeconds: 30 } : {}),
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('handles empty drafts, mode off, and rejects malformed or unrecognized replies', async () => {
    const transport = vi.fn<NaverDraftTransport>()
      .mockResolvedValueOnce(Response.json({ status: 'empty' }))
      .mockResolvedValueOnce(Response.json({ mode: 'off', targets: [] }))
      .mockResolvedValueOnce(Response.json({ ...draft, kind: 'manual' }))
      .mockResolvedValueOnce(Response.json({ status: 'accepted', receiptId: 'r' }))
      .mockRejectedValueOnce(new TypeError('network error'));
    const client = createNaverDraftsClient(transport);
    expect(await client.generate('ai-response', 'th-empty')).toEqual({ status: 'empty' });
    expect(await client.getTargets()).toEqual({ status: 'targets', mode: 'off', targets: [] });
    expect(await client.generate('manuals', 'mn-open')).toEqual({ status: 'error', code: 'INVALID_RESPONSE', httpStatus: 200 });
    expect(await client.send({ draftId: 'one', targetId: 'alias-1', body: '감사합니다.' })).toEqual({ status: 'error', code: 'INVALID_RESPONSE', httpStatus: 200 });
    expect(await client.getTargets()).toEqual({ status: 'error', code: 'TRANSPORT' });
    expect(transport).toHaveBeenCalledTimes(5);
  });
});
