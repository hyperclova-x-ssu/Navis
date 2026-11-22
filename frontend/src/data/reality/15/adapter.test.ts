import { describe, expect, it } from 'vitest';
import { selectNotices } from '../../iteration7/notices/selectors';
import { readModel } from '../../widget-data';
import { reply } from '../00/testing';
import { closureId, ids, service } from './testing';

describe('inquiry and notice HTTP port (B15)', () => {
  it('reads inquiries, notices and the persona server views into the existing tables and keeps the full-store counts', async () => {
    const { store, port, state } = service();
    expect(await port.load('inbox')).toMatchObject({ status: 'ready', complete: true });
    const tables = store.getSnapshot().tables;
    expect(tables.inquiryThread.map(row => row.threadId)).toEqual([ids.review, ids.talk, ids.manual]);
    expect(tables.inquiryThread.find(row => row.threadId === ids.talk)).toMatchObject({ type: 'message', channelKey: 'data.channel.naverTalk', bodyRaw: '일요일에도 문 여나요?', status: 'waiting' });
    expect(tables.inquiryThread.find(row => row.threadId === ids.manual)?.channelKey).toBe('data.real.inbox.channel.manualMessage');
    const model = readModel(store.getSnapshot(), 'ai-response');
    expect(model.waitingCount).toBe(3);
    expect(model.threads.find(row => row.threadId === ids.talk)?.body).toEqual({ raw: '일요일에도 문 여나요?' });
    expect(tables.realInbox).toMatchObject({ waitingInquiries: 3, activeNotices: 2, authorNotification: '답글을 올리면 리뷰 작성자에게 알림이 가요.',
      reviews: { status: 'available' }, consultations: { status: 'available' }, audiences: { status: 'available', items: [{ audience: 'benefit-subscribers', count: 12 }] }, news: { status: 'available' } });
    expect(selectNotices(store.getSnapshot()).drafts.map(row => row.noticeId)).toEqual([ids.notice, ids.sms]);
    expect(state.log).toEqual([]);
  });

  it('keeps the record flow working when the persona NAVER server reads are unavailable', async () => {
    const { store, port, backend } = service();
    backend.on('GET', '/marketing/reviews', () => reply(503, { code: 'PROVIDER_UNAVAILABLE' }));
    backend.on('GET', '/marketing/place/news', () => reply(503, { code: 'PROVIDER_UNAVAILABLE' }));
    expect(await port.load('inbox')).toMatchObject({ status: 'ready' });
    expect(store.getSnapshot().tables.realInbox).toMatchObject({ reviews: { status: 'unavailable' }, news: { status: 'unavailable' }, consultations: { status: 'available' } });
    expect(store.getSnapshot().tables.inquiryThread).toHaveLength(3);
  });

  it('saves a reply draft with the server revision, then posts it only when the card is pressed, and re-reads in a new session', async () => {
    const { store, port, open, backend, state } = service();
    await port.load('inbox');
    const saved = await store.execute({ type: 'inquiry.saveDraft', threadId: ids.talk, body: '일요일은 쉬어요', revision: 1, idempotencyKey: 'draft-1' });
    expect(saved).toMatchObject({ ok: true, value: { resourceId: ids.talk, revision: 2 } });
    expect(backend.callsTo('PATCH', `/marketing/inquiries/${ids.talk}/draft`)[0]!.body).toEqual({ text: '일요일은 쉬어요', draftSource: 'owner', expectedRevision: 1 });
    expect(state.log).toEqual([]); // a draft never records an approval
    expect(store.getSnapshot().tables.inquiryThread.find(row => row.threadId === ids.talk)).toMatchObject({ status: 'draft-ready', replyDraft: { body: '일요일은 쉬어요' } });
    const sent = await store.execute({ type: 'inquiry.send', threadId: ids.talk, idempotencyKey: 'send-1' });
    expect(sent).toMatchObject({ ok: true, value: { state: 'saved' } });
    expect(state.log).toEqual(['approval:inquiry.post:press', 'action:inquiry.post']);
    const call = backend.callsTo('POST', `/marketing/inquiries/${ids.talk}/reply`)[0]!;
    expect(call.body).toMatchObject({ expectedRevision: 2, approvalId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(call.headers.get('idempotency-key')).toBe('send-1');
    const reopened = open();
    await reopened.port.load('inbox');
    expect(reopened.store.getSnapshot().tables.inquiryThread.find(row => row.threadId === ids.talk)).toMatchObject({ status: 'done', sentReplyBody: '일요일은 쉬어요' });
    expect(readModel(reopened.store.getSnapshot(), 'ai-response').waitingCount).toBe(2);
  });

  it('sends a double press once and refuses a draft that differs from the saved one before any approval is recorded', async () => {
    const { store, port, backend, state } = service();
    await port.load('inbox');
    await store.execute({ type: 'inquiry.saveDraft', threadId: ids.review, body: '감사합니다', revision: 1, idempotencyKey: 'draft-r' });
    expect(await store.execute({ type: 'inquiry.post', threadId: ids.review, body: '다른 내용', idempotencyKey: 'post-wrong' })).toMatchObject({ ok: false, reason: 'REPLY_BODY_MISMATCH', messageKey: 'data.real.inbox.error.REPLY_BODY_MISMATCH' });
    expect(state.log).toEqual([]);
    const post = { type: 'inquiry.post', threadId: ids.review, body: '감사합니다', idempotencyKey: 'post-r' } as const;
    const results = await Promise.all([store.execute(post), store.execute(post)]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(backend.callsTo('POST', `/marketing/inquiries/${ids.review}/reply`)).toHaveLength(1);
    expect(state.log.filter(line => line.startsWith('approval:'))).toHaveLength(1);
  });

  it('records a manual inquiry as an owner attestation instead of calling a provider reply', async () => {
    const { store, port, backend, state } = service();
    await port.load('inbox');
    await store.execute({ type: 'inquiry.saveDraft', threadId: ids.manual, body: '주차는 근처 공영주차장을 이용해 주세요', revision: 1, idempotencyKey: 'draft-m' });
    expect(await store.execute({ type: 'inquiry.send', threadId: ids.manual, idempotencyKey: 'send-m' })).toMatchObject({ ok: true, value: { state: 'recorded' } });
    expect(state.log).toEqual(['approval:inquiry.attest:press', 'action:inquiry.attest']);
    expect(backend.callsTo('POST', `/marketing/inquiries/${ids.manual}/reply`)).toHaveLength(0);
    expect(store.getSnapshot().tables.inquiryThread.find(row => row.threadId === ids.manual)?.real).toMatchObject({ replyState: 'recorded' });
  });

  it('creates a manual inquiry and shows the server text that rejects a phone number in a public reply', async () => {
    const { store, port } = service();
    await port.load('inbox');
    expect(await store.execute({ type: 'inquiry.create', kind: 'message', title: '단체 예약', body: '10명 가능한가요?', idempotencyKey: 'create-1' })).toMatchObject({ ok: true });
    expect(store.getSnapshot().tables.inquiryThread.find(row => row.bodyRaw === '10명 가능한가요?')).toMatchObject({ type: 'message', status: 'waiting' });
    expect(await store.execute({ type: 'inquiry.saveDraft', threadId: ids.review, body: '010-1234-5678로 연락 주세요', revision: 1, idempotencyKey: 'draft-bad' }))
      .toMatchObject({ ok: false, messageKey: 'data.real.inbox.error.REPLY_CONTAINS_CONTACT' });
  });

  it('deletes a review reply only after both confirmation steps are recorded', async () => {
    const { store, port, backend, state } = service();
    await port.load('inbox');
    await store.execute({ type: 'inquiry.saveDraft', threadId: ids.review, body: '감사합니다', revision: 1, idempotencyKey: 'draft-r' });
    await store.execute({ type: 'inquiry.post', threadId: ids.review, idempotencyKey: 'post-r' });
    state.log.length = 0;
    expect(await store.execute({ type: 'inquiry.deleteReply', threadId: ids.review, idempotencyKey: 'delete-r' })).toMatchObject({ ok: true });
    expect(state.log).toEqual(['approval:inquiry.deleteReply:press', 'approval:inquiry.deleteReply:confirm', 'action:inquiry.deleteReply']);
    expect(backend.callsTo('DELETE', `/marketing/inquiries/${ids.review}/reply`)[0]!.body).toMatchObject({ expectedRevision: 3 });
    expect(store.getSnapshot().tables.inquiryThread.find(row => row.threadId === ids.review)?.status).toBe('waiting');
  });

  it('creates and sends a notice draft, records the result, and counts it once in history', async () => {
    const { store, port, state } = service();
    await port.load('inbox');
    const created = await store.execute({ type: 'notice.saveDraft', kind: 'other', title: '신메뉴', body: '새 메뉴가 나왔어요', startDate: '2026-11-22', endDate: '2026-11-22', audience: 'all_contactable', groupIds: [], channel: 'talktalk', talkAudience: 'benefit-subscribers', idempotencyKey: 'n-1' });
    expect(created).toMatchObject({ ok: true, value: { resourceId: 'b3333333-3333-4333-8333-333333333333' } });
    const id = 'b3333333-3333-4333-8333-333333333333';
    expect(store.getSnapshot().tables.noticeDraft.find(row => row.noticeId === id)).toMatchObject({ channel: 'talktalk' });
    const talk = await store.execute({ type: 'notice.send', noticeId: id, draftRevision: 1, previewId: 'local', idempotencyKey: 'n-talk' });
    expect(talk).toMatchObject({ ok: true, value: { state: 'accepted' } });
    expect(state.log).toEqual(['approval:notice.send:press', 'action:notice.send']);
    const manual = await store.execute({ type: 'notice.send', noticeId: ids.notice, draftRevision: 1, previewId: 'local', idempotencyKey: 'n-send' });
    expect(manual).toMatchObject({ ok: true, value: { state: 'recorded' } });
    expect(state.log.slice(2)).toEqual(['approval:notice.attest:press', 'action:notice.attest']);
    const model = selectNotices(store.getSnapshot());
    expect(model.drafts.map(row => row.noticeId)).toEqual([ids.sms]);
    expect(model.sent.map(row => [row.noticeId, row.status, row.result]).sort()).toEqual([[id, 'sent', 'accepted'], [ids.notice, 'sent', 'recorded']].sort());
  });

  it('sends an SMS notice only as a reservation, and keeps it a draft when the SENS binding answers A6_DISABLED', async () => {
    const { store, port, backend, state } = service();
    await port.load('inbox');
    const calls = backend.calls.length;
    // SMS is a reservation only: without a time nothing is sent, not even the card press.
    expect(await store.execute({ type: 'notice.send', noticeId: ids.sms, draftRevision: 1, previewId: 'local', idempotencyKey: 'n-sms' })).toMatchObject({ ok: false, reason: 'SMS_SCHEDULE_REQUIRED' });
    expect(await store.execute({ type: 'notice.send', noticeId: ids.notice, draftRevision: 1, previewId: 'local', sendAt: '2026-11-22T08:00', idempotencyKey: 'n-late' })).toMatchObject({ ok: false, reason: 'SCHEDULE_UNAVAILABLE' });
    expect(backend.calls).toHaveLength(calls);
    expect(await store.execute({ type: 'notice.send', noticeId: ids.sms, draftRevision: 1, previewId: 'local', sendAt: '2026-11-21T15:00', idempotencyKey: 'n-sms-2' }))
      .toMatchObject({ ok: false, reason: 'A6_DISABLED', messageKey: 'data.real.inbox.error.A6_DISABLED' });
    expect(state.log).toEqual(['card:sms.schedule:press']);
    expect(store.getSnapshot().tables.noticeDraft.some(row => row.noticeId === ids.sms)).toBe(true);
  });

  it('asks for a fresh closure import when the calendar closure moved, and re-reads on a stale revision', async () => {
    const { store, port, backend } = service();
    store.hydrate({ calendarEvent: [{ eventId: closureId, revision: 3, kind: 'event', categoryId: 'store-operations', date: '2026-11-22', time: null, title: { raw: '임시 휴무' }, memo: { raw: '정비' }, storeClosure: { kind: 'temporary', endDate: '2026-11-22' } }] });
    await port.load('inbox');
    const result = await store.execute({ type: 'notice.importClosure', noticeId: ids.notice, eventId: closureId, idempotencyKey: 'import-1' });
    expect(result).toMatchObject({ ok: false, reason: 'CLOSURE_CHANGED', messageKey: 'data.notices.error.CLOSURE_CHANGED' });
    expect(backend.callsTo('PATCH', `/marketing/notices/${ids.notice}/draft`)[0]!.body).toMatchObject({ closure: { eventId: closureId, revision: 3 }, expectedRevision: 1 });
    backend.on('PATCH', /^\/marketing\/notices\/[^/]+\/draft$/, () => reply(409, { code: 'STALE_REVISION' }));
    const reads = backend.callsTo('GET', '/marketing/notices').length;
    expect(await store.execute({ type: 'notice.saveDraft', noticeId: ids.notice, kind: 'other', title: 'x', body: 'y', startDate: '2026-11-22', endDate: '2026-11-22', audience: 'all_contactable', groupIds: [], idempotencyKey: 'n-stale' }))
      .toMatchObject({ ok: false, reason: 'STALE_REVISION' });
    expect(backend.callsTo('GET', '/marketing/notices').length).toBeGreaterThan(reads);
  });

  it('deletes a notice draft after the second confirmation and undoes it from the visible receipt', async () => {
    const { store, port, state } = service();
    await port.load('inbox');
    const result = await store.execute({ type: 'notice.deleteDraft', noticeId: ids.notice, idempotencyKey: 'n-del' });
    expect(result).toMatchObject({ ok: true, undoToken: expect.stringMatching(/^real-undo:/) });
    expect(state.log).toEqual(['approval:notice.deleteDraft:press', 'approval:notice.deleteDraft:confirm', 'action:notice.deleteDraft']);
    expect(selectNotices(store.getSnapshot()).drafts.map(row => row.noticeId)).toEqual([ids.sms]);
    if (!result.ok || !result.undoToken) throw new Error('Expected an undoable receipt');
    expect(await port.undo(result.undoToken)).toMatchObject({ ok: true });
    expect(selectNotices(store.getSnapshot()).drafts.map(row => row.noticeId).sort()).toEqual([ids.notice, ids.sms].sort());
  });

  it('never records an approval or writes for a command the port rejects locally', async () => {
    const { store, port, backend, state } = service();
    await port.load('inbox');
    const writes = () => backend.calls.filter(call => call.method !== 'GET').length;
    expect(await store.execute({ type: 'inquiry.send', threadId: ids.talk, idempotencyKey: 'no-draft' })).toMatchObject({ ok: false, reason: 'DRAFT_REQUIRED' });
    expect(await store.execute({ type: 'reply.draft', threadId: ids.talk, idempotencyKey: 'gen' })).toMatchObject({ ok: false, reason: 'DRAFT_UNAVAILABLE' });
    expect(writes()).toBe(0);
    expect(state.log).toEqual([]);
  });
});
