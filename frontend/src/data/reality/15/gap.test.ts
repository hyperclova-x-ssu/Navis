/** GAPUI-MKT: PN13 SMS reservation and cancel through the owner-card issuer, review draft sources, and the history rows they leave. */
import { describe, expect, it } from 'vitest';
import { selectNotices } from '../../iteration7/notices/selectors';
import { createWidgetDataStore } from '../../widget-data';
import { createRealPort } from '../00';
import { fakeBackend } from '../00/testing';
import { readReviewInsights, reviewDraftPreview } from './adapter';
import { noticeHistoryRows } from './dto';
import { ids, notice, service } from './testing';

const writes = (backend: ReturnType<typeof service>['backend']) => backend.calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.path}`);

describe('F15 GAP · SMS reservation (PN13)', () => {
  it('presses the SMS card once, sends the reservation with its approval and reads back a scheduled history row, not a sent message', async () => {
    const { store, port, backend, state } = service({ sms: true });
    await port.load('inbox');
    const result = await store.execute({ type: 'notice.send', noticeId: ids.sms, draftRevision: 1, previewId: 'service', sendAt: '2026-11-21T15:00', idempotencyKey: 'sms-1' });
    expect(result).toMatchObject({ ok: true, value: { state: 'scheduled' } });
    expect(state.log).toEqual(['card:sms.schedule:press', 'action:notice.send']);
    expect(writes(backend)).toEqual(['POST /marketing/approvals', `POST /marketing/notices/${ids.sms}/send`]);
    const [press, send] = backend.calls.filter(call => call.method === 'POST');
    expect(press!.body).toEqual({ operation: 'sms.schedule', targetRef: ids.sms, command: { scheduledFor: '2026-11-21T15:00' }, expectedRevision: 1, stage: 'press' });
    expect(press!.headers.get('idempotency-key')).toBe('sms-1:press');
    expect(send!.body).toEqual({ expectedRevision: 1, approvalId: expect.stringMatching(/^c0000000-/), scheduledFor: '2026-11-21T15:00' });
    // The generic notice approval route can never grant SMS.
    expect(backend.callsTo('POST', '/marketing/notice-reply-approvals')).toHaveLength(0);
    // D-326: a pending schedule is a queue row, not a sent message (the same model the fixture and Navis facts use).
    const model = selectNotices(store.getSnapshot());
    expect(model.scheduled).toEqual([expect.objectContaining({ noticeId: ids.sms, status: 'scheduled', sendAt: '2026-11-21T15:00', sentAt: null })]);
    expect(model.sent.some(row => row.noticeId === ids.sms)).toBe(false);
  });

  it('cancels a reservation only with the press and the second confirmation, then leaves the history like the fixture cancel', async () => {
    const { store, port, backend, state } = service({ sms: true });
    await port.load('inbox');
    await store.execute({ type: 'notice.send', noticeId: ids.sms, draftRevision: 1, previewId: 'service', sendAt: '2026-11-21T15:00', idempotencyKey: 'sms-1' });
    state.log.length = 0;
    const cancel = await store.execute({ type: 'notice.cancelSchedule', sentId: ids.sms, idempotencyKey: 'sms-cancel' });
    expect(cancel).toMatchObject({ ok: true, noticeKey: 'data.notices.notice.scheduleCancelled' });
    expect(state.log).toEqual(['card:sms.cancel:press', 'card:sms.cancel:confirm', 'action:notice.cancelSms']);
    const body = backend.callsTo('POST', `/marketing/notices/${ids.sms}/cancel-sms`)[0]!.body as { approvalId: string; expectedRevision: number };
    expect(body).toEqual({ expectedRevision: 2, approvalId: expect.stringMatching(/^c0000000-/) });
    expect(store.getSnapshot().tables.noticeSent.some(row => row.noticeId === ids.sms)).toBe(false);
    // A second cancel of the same notice is refused before any card press.
    const before = backend.calls.length;
    expect(await store.execute({ type: 'notice.cancelSchedule', sentId: ids.sms, idempotencyKey: 'sms-cancel-2' })).toMatchObject({ ok: false, reason: 'SMS_NOT_CANCELABLE' });
    expect(backend.calls).toHaveLength(before);
  });

  it('maps scheduled and cancelled reservations into history rows the Navis facts read', () => {
    const scheduled = notice({ id: ids.sms, channel: 'sms', status: 'done', result: { state: 'scheduled', providerRef: 'r', scheduledFor: '2026-11-22T09:30' } });
    const canceled = notice({ id: ids.notice, channel: 'sms', status: 'done', result: { state: 'canceled', providerRef: 'r', scheduledFor: '2026-11-22T09:30' } });
    expect(noticeHistoryRows([scheduled, canceled])).toEqual([expect.objectContaining({ sentId: ids.sms, status: 'scheduled', sendAt: '2026-11-22T09:30', sentAt: null })]);
  });
});

describe('F15 GAP · review drafts (PN03/PN14) and review AI statistics', () => {
  it('saves the owner-edited text with the draft source it came from', async () => {
    const { store, port, backend } = service();
    await port.load('inbox');
    expect(await store.execute({ type: 'inquiry.saveDraft', threadId: ids.review, body: '고친 초안', revision: 1, draftSource: 'navis', idempotencyKey: 'd-1' })).toMatchObject({ ok: true });
    expect(backend.callsTo('PATCH', `/marketing/inquiries/${ids.review}/draft`)[0]!.body).toEqual({ text: '고친 초안', draftSource: 'navis', expectedRevision: 1 });
    expect(store.getSnapshot().tables.realInbox?.inquiries.find(row => row.id === ids.review)?.draft).toEqual({ text: '고친 초안', source: 'navis' });
    expect(await store.execute({ type: 'inquiry.saveDraft', threadId: ids.talk, body: '직접 쓴 초안', revision: 1, idempotencyKey: 'd-2' })).toMatchObject({ ok: true });
    expect(backend.callsTo('PATCH', `/marketing/inquiries/${ids.talk}/draft`)[0]!.body).toMatchObject({ draftSource: 'owner' });
  });

  it('reads the two previews from their own routes and the statistics from Insight, writing nothing', async () => {
    const backend = fakeBackend();
    backend.on('POST', /draft-preview$/, call => ({ text: call.path.includes('navis') ? 'N' : 'V', source: call.path.includes('navis') ? 'navis' : 'naver-ai' }));
    backend.on('GET', '/insight/review-insights', call => ({ unit: call.query.unit }));
    const port = createRealPort({ store: createWidgetDataStore(), fetch: backend.fetch, source: () => 'http', adapters: [] });
    expect(await reviewDraftPreview(port.transport, 'navis', 'rv/1')).toEqual({ text: 'N', source: 'navis' });
    expect(await reviewDraftPreview(port.transport, 'naver-ai', 'rv/1')).toEqual({ text: 'V', source: 'naver-ai' });
    expect(backend.calls.filter(call => call.method === 'POST').map(call => [call.path, call.body])).toEqual([
      ['/marketing/reviews/rv%2F1/navis-draft-preview', { style: '정중하게', length: '짧게' }],
      ['/marketing/reviews/rv%2F1/draft-preview', { style: '정중하게', length: '짧게' }],
    ]);
    expect(await readReviewInsights(port.reads, 'month')).toEqual({ unit: 'month' });
  });
});
