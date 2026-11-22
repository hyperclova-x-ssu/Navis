import { describe, expect, it } from 'vitest';
import manifest from '../../db/generated/manifest.json';
import { addDays, NOW, TODAY, TOMORROW, YESTERDAY } from '../../db/time';
import { createSeedTables } from '../../db/seed';
import { deepFreeze } from '../../db/freeze';
import {
  noticeHandlers, selectNotices, selectStoreClosures,
  selectShopGuidance, selectDraftClosureLink, type NoticeCommand, type NoticeSourceTables, type NoticePreviewView,
} from './index';

const closureDay = addDays(TODAY, 7);
const closureTitle = '11/24(화) 임시 휴무';
const closureBody = '매장 내부 정비로 하루 쉬어요';
const createClosure = () => ({
  eventId: 'closure-test', revision: 1, kind: 'event' as const, categoryId: 'store-operations' as const,
  date: closureDay, time: null, title: { raw: closureTitle }, memo: { raw: closureBody },
  storeClosure: { kind: 'temporary' as const, endDate: closureDay },
});
const fixture = (): NoticeSourceTables => ({
  ...createSeedTables(), calendarEvent: [createClosure()], noticePreview: [], noticeSent: [],
  noticeDraft: [{
    noticeId: 'notice-closure-1', kind: 'temporary_closure', title: closureTitle, body: closureBody,
    startDate: closureDay, endDate: closureDay, closureEventId: 'closure-test', closureRevision: 1,
    audience: 'all_contactable', groupIds: [], contentClass: 'informational', revision: 1,
  }],
});
let seq = 0;
function run(tables: NoticeSourceTables, command: NoticeCommand, now = NOW) {
  return noticeHandlers[command.type]({ tables, snapshot: { revision: 0, tables }, nextId: p => `${p}-test-${++seq}`, now }, command);
}
function preview(tables: NoticeSourceTables) {
  const outcome = run(tables, { type: 'notice.preview', noticeId: 'notice-closure-1', draftRevision: 1 });
  if (!outcome.ok) throw new Error(outcome.reason);
  return { tables: outcome.tables, value: outcome.value as NoticePreviewView };
}
function send(tables: NoticeSourceTables, previewId: string, key = 'send-1') {
  return run(tables, { type: 'notice.send', noticeId: 'notice-closure-1', draftRevision: 1, previewId, idempotencyKey: key });
}

describe('closure and notice domain', () => {
  it('imports closure facts without editing the calendar or accepting staff off rows', () => {
    const t = fixture();
    const closures = selectStoreClosures({ tables: t }, { start: TODAY, end: closureDay });
    expect(closures).toMatchObject([{ eventId: 'closure-test', revision: 1, startDate: closureDay, endDate: closureDay }]);
    const result = run(t, { type: 'notice.importClosure', eventId: 'closure-test', idempotencyKey: 'import' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables.calendarEvent).toBe(t.calendarEvent);
      expect(result.tables.noticeDraft.at(-1)).toMatchObject({ title: closureTitle, body: '매장 내부 정비로 하루 쉬어요', closureRevision: 1 });
    }
    expect(run(t, { type: 'notice.importClosure', eventId: 'staff-shift-5', idempotencyKey: 'off' })).toMatchObject({ ok: false, reason: 'UNKNOWN_CLOSURE' });
  });

  it('derives the cafe informational recipients and commits just one immutable fake send', () => {
    const original = deepFreeze(fixture());
    const p = preview(original);
    expect(p.value).toMatchObject({ recipientCount: manifest.counts.members, contentClass: 'informational', sendAllowed: true });
    expect(p.value).not.toHaveProperty('eligibleMemberIds');
    const result = send(p.tables, p.value.previewId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ status: 'sent_example', recipientCount: manifest.counts.members, sentAt: NOW });
    expect(result.tables.noticeSent).toHaveLength(1);
    expect(Object.isFrozen(result.tables.noticeSent[0])).toBe(true);
    expect(result.tables.marketing).toBe(original.marketing);
    expect(result.tables.memberProfile).toBe(original.memberProfile);
    expect(result.tables.payment).toBe(original.payment);
    const repeated = send(result.tables, p.value.previewId, 'another-click');
    expect(repeated.ok && repeated.tables).toBe(result.tables);
    expect(original.noticeSent).toHaveLength(0);
  });

  it('drops only a sent current closure reminder and restores it after revision or date changes', () => {
    const p = preview(fixture());
    expect(selectNotices({ tables: p.tables }).upcomingUnsentClosures).toHaveLength(1);
    const result = send(p.tables, p.value.previewId);
    if (!result.ok) throw new Error(result.reason);
    expect(selectNotices({ tables: result.tables }).upcomingUnsentClosures).toHaveLength(0);
    const changed = { ...result.tables, calendarEvent: [{ ...createClosure(), revision: 2, title: { raw: '변경한 휴무' } }] };
    expect(selectNotices({ tables: changed }).upcomingUnsentClosures).toHaveLength(1);
    expect(selectNotices({ tables: { ...changed, calendarEvent: [] } }).upcomingUnsentClosures).toHaveLength(0);
    expect(selectNotices({ tables: changed }, {}, YESTERDAY).upcomingUnsentClosures).toHaveLength(0);
    expect(selectNotices({ tables: changed }, {}, closureDay).upcomingUnsentClosures).toHaveLength(1);
    const moved = { ...result.tables, calendarEvent: [{ ...createClosure(), date: addDays(closureDay, -1) }] };
    expect(selectNotices({ tables: moved }).upcomingUnsentClosures).toHaveLength(1);
  });

  it('overlays date-specific closure guidance while retaining manual guidance', () => {
    const guidance = selectShopGuidance({ tables: fixture() }, { openingHours: '연중무휴' });
    expect(guidance.openingHours).toBe('연중무휴');
    expect(guidance.closures).toMatchObject([{ startDate: closureDay, body: '매장 내부 정비로 하루 쉬어요' }]);
  });

  it('classifies title and body and intersects current groups with contact and ad consent', () => {
    const t = fixture();
    const changed = run(t, { type: 'notice.saveDraft', noticeId: 'notice-closure-1', kind: 'temporary_closure', title: '아메리카노 10% 할인 쿠폰', body: '쉬는 날 안내', startDate: closureDay, endDate: closureDay, audience: 'group', groupIds: ['regular'] });
    if (!changed.ok) throw new Error(changed.reason);
    const p = run(changed.tables, { type: 'notice.preview', noticeId: 'notice-closure-1', draftRevision: 2 });
    if (!p.ok) throw new Error(p.reason);
    expect(p.value).toMatchObject({ recipientCount: 151, contentClass: 'promotional', sendAllowed: true, adMarker: true });
    expect((p.value as NoticePreviewView).renderedBody).toMatch(/^\(광고\)/);
    expect((p.value as NoticePreviewView).optOutText).not.toBe('');
    expect((p.value as NoticePreviewView).renderedBody).toContain((p.value as NoticePreviewView).optOutText);
  });

  it.each([
    ['07:59', false], ['08:00', true], ['20:59', true], ['21:00', false], ['23:30', false], ['03:00', false],
  ] as const)('applies the promotional notice night window at %s (allowed: %s)', (time, allowed) => {
    const t = fixture();
    const draft = t.noticeDraft[0];
    const tables = { ...t, noticeDraft: [{ ...draft, body: '할인 쿠폰' }] };
    const p = run(tables, { type: 'notice.preview', noticeId: draft.noticeId, draftRevision: 1 }, `${TODAY}T${time}`);
    expect(p.ok && p.value).toMatchObject({
      sendAllowed: allowed, contentClass: 'promotional', reasons: allowed ? [] : ['AD_NIGHT_RESTRICTED'],
    });
    if (!p.ok) throw new Error(p.reason);
    const result = run(p.tables, { type: 'notice.send', noticeId: draft.noticeId, draftRevision: 1, previewId: (p.value as NoticePreviewView).previewId, idempotencyKey: 'night' }, `${TODAY}T${time}`);
    expect(result).toMatchObject(allowed ? { ok: true } : { ok: false, reason: 'AD_NIGHT_RESTRICTED' });
  });

  it('refuses informational notices during the night window', () => {
    const p = preview(fixture());
    const result = run(p.tables, { type: 'notice.send', noticeId: 'notice-closure-1', draftRevision: 1, previewId: p.value.previewId, idempotencyKey: 'information' }, `${TODAY}T21:00`);
    expect(result).toMatchObject({ ok: false, reason: 'NIGHT_RESTRICTED' });
  });

  it('lists scheduled notices separately and rejects an immediate duplicate until cancellation', () => {
    const args = { noticeId: 'notice-closure-1', draftRevision: 1 };
    const sendAt = `${TOMORROW}T08:00`;
    const p = run(fixture(), { type: 'notice.preview', ...args, sendAt });
    if (!p.ok) throw Error(p.reason);
    const queued = run(p.tables, { type: 'notice.send', ...args, sendAt, previewId: (p.value as NoticePreviewView).previewId, idempotencyKey: 'scheduled' });
    if (!queued.ok) throw Error(queued.reason);
    const [row] = queued.tables.noticeSent;
    expect(selectNotices({ tables: queued.tables })).toMatchObject({ scheduled: [row], sent: [], unsentCount: 0 });
    const immediate = preview(queued.tables);
    expect(send(immediate.tables, immediate.value.previewId)).toMatchObject({ ok: false, reason: 'ALREADY_SCHEDULED' });
    expect(run(queued.tables, { type: 'notice.cancelSchedule', sentId: row.sentId, idempotencyKey: 'cancel' }, sendAt))
      .toMatchObject({ ok: false, reason: 'SCHEDULE_NOT_CANCELLABLE' });
    const cancelled = run(queued.tables, { type: 'notice.cancelSchedule', sentId: row.sentId, idempotencyKey: 'cancel' });
    expect(cancelled).toMatchObject({ ok: true, tables: { noticeSent: [], noticeDraft: queued.tables.noticeDraft } });
  });

  it('requires a fresh preview when recipients, contact, consent, group, closure or draft changes', () => {
    const p = preview(fixture());
    const t = p.tables;
    const mutations: NoticeSourceTables[] = [
      { ...t, marketing: { ...t.marketing, mktCustomer: t.marketing.mktCustomer.map((c, i) => i === 0 ? { ...c, phone: '' } : c) } },
      { ...t, marketing: { ...t.marketing, mktCustomer: t.marketing.mktCustomer.map((c, i) => i === 0 ? { ...c, phone: '01099998888' } : c) } },
      { ...t, calendarEvent: [{ ...createClosure(), revision: 2 }] },
      { ...t, calendarEvent: [] },
      { ...t, noticeDraft: [{ ...t.noticeDraft[0], body: '할인 쿠폰' }] },
      { ...t, noticeDraft: [{ ...t.noticeDraft[0], revision: 2 }] },
    ];
    for (const changed of mutations) expect(send(changed, p.value.previewId)).toMatchObject({ ok: false, reason: 'PREVIEW_STALE' });
    expect(run(p.tables, { type: 'notice.send', noticeId: 'notice-closure-1', draftRevision: 1, previewId: p.value.previewId, idempotencyKey: 'nextday' }, `${TOMORROW}T15:45`)).toMatchObject({ ok: false, reason: 'PREVIEW_STALE' });
    expect(t.noticeSent).toHaveLength(0);
  });

  it('revalidates ad consent and group rules after preview and blocks a daytime preview used after 21:00', () => {
    const t = fixture();
    const tables = { ...t, noticeDraft: [{ ...t.noticeDraft[0], body: '쿠폰', audience: 'group' as const, groupIds: ['regular' as const] }] };
    const p = preview(tables);
    const changed = { ...p.tables, marketing: { ...p.tables.marketing, mktCustomer: p.tables.marketing.mktCustomer.map(c => ({ ...c, consentSms: false })) } };
    expect(send(changed, p.value.previewId)).toMatchObject({ ok: false, reason: 'PREVIEW_STALE' });
    const groups = { ...p.tables, marketing: { ...p.tables.marketing, mktVisit: [] } };
    expect(send(groups, p.value.previewId)).toMatchObject({ ok: false, reason: 'PREVIEW_STALE' });
    expect(run(p.tables, { type: 'notice.send', noticeId: 'notice-closure-1', draftRevision: 1, previewId: p.value.previewId, idempotencyKey: 'night' }, `${TODAY}T21:00`)).toMatchObject({ ok: false, reason: 'AD_NIGHT_RESTRICTED' });
  });

  it('disables zero-recipient previews, preserves sent snapshots on delete and rejects stale inputs', () => {
    const t = fixture();
    const empty = { ...t, memberProfile: [] };
    expect(preview(empty).value).toMatchObject({ recipientCount: 0, sendAllowed: false, reasons: ['NO_RECIPIENTS'] });
    const p = preview(t), sent = send(p.tables, p.value.previewId);
    if (!sent.ok) throw new Error(sent.reason);
    const removed = run(sent.tables, { type: 'notice.deleteDraft', noticeId: 'notice-closure-1', idempotencyKey: 'delete' });
    expect(removed.ok && removed.undoable).toBe(true);
    if (removed.ok) {
      expect(removed.tables.noticeDraft).toHaveLength(0);
      expect(removed.tables.noticeSent).toBe(sent.tables.noticeSent);
    }
    expect(run(t, { type: 'notice.preview', noticeId: 'notice-closure-1', draftRevision: 0 })).toMatchObject({ ok: false, reason: 'PREVIEW_STALE' });
    expect(run(t, { type: 'notice.deleteDraft', noticeId: 'notice-closure-1', idempotencyKey: '' })).toMatchObject({ ok: false, reason: 'KEY_REQUIRED' });
  });

  it.each([
    [{ title: '' }, 'TITLE_REQUIRED'], [{ body: '' }, 'BODY_REQUIRED'],
    [{ startDate: '2026-02-30' }, 'INVALID_DATE_RANGE'], [{ endDate: '2026-10-01' }, 'INVALID_DATE_RANGE'],
    [{ audience: 'group', groupIds: ['unknown'] }, 'INVALID_GROUP'],
  ])('rejects invalid draft %j with zero writes', (patch, reason) => {
    const t = deepFreeze(fixture());
    const draft = t.noticeDraft[0];
    expect(run(t, { ...draft, ...patch, type: 'notice.saveDraft' } as NoticeCommand)).toMatchObject({ ok: false, reason });
    expect(t.noticeDraft[0].revision).toBe(1);
  });
  describe('GD-2 past dates and stale closure links', () => {
    const save = (t: NoticeSourceTables, patch: Partial<Extract<NoticeCommand, { type: 'notice.saveDraft' }>>, now = NOW) => {
      const d = t.noticeDraft[0];
      return run(t, { type: 'notice.saveDraft', kind: d.kind, title: d.title, body: d.body, startDate: d.startDate, endDate: d.endDate, audience: d.audience, groupIds: [...d.groupIds], idempotencyKey: `save-${++seq}`, ...patch }, now);
    };
    const moved = (t: NoticeSourceTables, patch: Partial<ReturnType<typeof createClosure>>): NoticeSourceTables => ({ ...t, calendarEvent: [{ ...createClosure(), ...patch }] });
    it('rejects a range that is already over and saves nothing, with the typed refusal shape', () => {
      const t = deepFreeze(fixture());
      const result = save(t, { noticeId: undefined, startDate: YESTERDAY, endDate: YESTERDAY });
      expect(result).toMatchObject({ ok: false, code: 'VALIDATION', reason: 'PAST_DATE', field: 'startDate', messageKey: 'data.notices.error.PAST_DATE' });
      expect(save(t, { noticeId: 'notice-closure-1', startDate: '2026-10-20', endDate: YESTERDAY })).toMatchObject({ ok: false, reason: 'PAST_DATE' });
    });
    it('still takes today, a range that runs through today and any later range', () => {
      const t = fixture();
      expect(save(t, { noticeId: undefined, startDate: TODAY, endDate: TODAY }).ok).toBe(true);
      expect(save(t, { noticeId: undefined, startDate: YESTERDAY, endDate: TOMORROW }).ok).toBe(true);
      expect(save(t, { noticeId: undefined, startDate: closureDay, endDate: addDays(closureDay, 1) }).ok).toBe(true);
    });
    it('rejects importing a closure that is already over', () => {
      const t = moved(fixture(), { date: '2026-10-20', storeClosure: { kind: 'temporary', endDate: '2026-10-21' } });
      expect(run(t, { type: 'notice.importClosure', eventId: 'closure-test', idempotencyKey: 'old' })).toMatchObject({ ok: false, reason: 'PAST_DATE' });
    });
    it('marks the draft stale when the closure is edited, and preview and send ask for a new import', () => {
      const t = fixture(), p = preview(t);
      expect(selectDraftClosureLink({ tables: t }, t.noticeDraft[0])).toBe('current');
      const changed = moved(p.tables, { revision: 2, title: { raw: `${closureTitle}(변경)` } });
      expect(selectNotices({ tables: changed }).closureLinks).toEqual({ 'notice-closure-1': 'changed' });
      const refusal = { ok: false, code: 'CONFLICT', reason: 'PREVIEW_STALE', field: 'closureEventId', messageKey: 'data.notices.error.CLOSURE_CHANGED', details: { noticeId: 'notice-closure-1', closureEventId: 'closure-test', changed: 'changed', reimport: true } };
      expect(run(changed, { type: 'notice.preview', noticeId: 'notice-closure-1', draftRevision: 1 })).toMatchObject(refusal);
      expect(send(changed, p.value.previewId)).toMatchObject(refusal);
    });
    it('keeps the draft stale through a re-save and clears it only by importing the closure again', () => {
      const changed = moved(fixture(), { revision: 2, title: { raw: '11/24 휴무(변경)' }, memo: { raw: '내용도 바뀌었어요' } });
      const resaved = save(changed, { noticeId: 'notice-closure-1' });
      expect(resaved.ok && selectDraftClosureLink({ tables: resaved.tables }, resaved.tables.noticeDraft[0])).toBe('changed');
      const imported = run(changed, { type: 'notice.importClosure', eventId: 'closure-test', noticeId: 'notice-closure-1', idempotencyKey: 'reimport' });
      if (!imported.ok) throw new Error(imported.reason);
      expect(imported.tables.noticeDraft[0]).toMatchObject({ title: '11/24 휴무(변경)', body: '내용도 바뀌었어요', closureRevision: 2, revision: 2 });
      expect(selectNotices({ tables: imported.tables }).closureLinks).toEqual({ 'notice-closure-1': 'current' });
      const fresh = run(imported.tables, { type: 'notice.preview', noticeId: 'notice-closure-1', draftRevision: 2 });
      expect(fresh).toMatchObject({ ok: true, value: { sendAllowed: true } });
    });
    it('tells a removed closure and edited draft dates apart from an edited closure', () => {
      const t = fixture();
      expect(run({ ...t, calendarEvent: [] }, { type: 'notice.preview', noticeId: 'notice-closure-1', draftRevision: 1 })).toMatchObject({ ok: false, reason: 'PREVIEW_STALE', messageKey: 'data.notices.error.CLOSURE_REMOVED', details: { changed: 'removed', reimport: false } });
      const edited = save(t, { noticeId: 'notice-closure-1', endDate: addDays(closureDay, 1) });
      if (!edited.ok) throw new Error(edited.reason);
      expect(run(edited.tables, { type: 'notice.preview', noticeId: 'notice-closure-1', draftRevision: 2 })).toMatchObject({ ok: false, reason: 'PREVIEW_STALE', messageKey: 'data.notices.error.CLOSURE_DATES_DIFFER', details: { changed: 'dates' } });
    });
    it('does not mark an unlinked draft, so a hand-written notice previews as before', () => {
      const t = fixture(), made = save(t, { noticeId: undefined, kind: 'other', title: '입구 안내', body: '옆문으로 들어와 주세요', startDate: TOMORROW, endDate: TOMORROW });
      if (!made.ok) throw new Error(made.reason);
      const { noticeId } = made.value as { noticeId: string };
      expect(selectNotices({ tables: made.tables }).closureLinks[noticeId]).toBe('none');
      expect(run(made.tables, { type: 'notice.preview', noticeId, draftRevision: 1 })).toMatchObject({ ok: true });
    });
  });
});
