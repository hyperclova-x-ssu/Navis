// @vitest-environment node
// D-331: an immediate send requested at night offers tomorrow at 08:00.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clock = vi.hoisted(() => ({ time: '22:30' }));

vi.mock('../../../pos/clock', () => ({
  POS_BUSINESS_DATE: '2026-11-17', POS_NOW_TIME: '22:30', get POS_NOW() { return `2026-11-17T${clock.time}`; },
  businessNow: () => `2026-11-17T${clock.time}`,
}));

import { createWidgetDataStore } from '../../../data/widget-data';
import { createLegacyNoticeSeed } from '../../../data/iteration7/notices/seed';
import { createAgentActions } from '../agent-actions';
import { createRunStore } from '../../../state';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { timePolicy } from '../../../ui';
import { beginDashboard } from '../../../app/test-session';
import { noticesDomain } from './notices';
import { navisTranslator } from '../messages';
import { createDomainRegistry } from './registry';

const domains = createDomainRegistry([noticesDomain]);
const notice = createLegacyNoticeSeed().noticeDraft[0];

function setup(body: string) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const store = createWidgetDataStore({ noticeDraft: [{ ...notice, closureEventId: null, closureRevision: null, startDate: '2026-11-18', endDate: '2026-11-18', body }] }, { runId: run.getState().runId });
  return { run, store };
}

describe('D-331 night rule for notices', () => {
  beforeEach(() => {
    clock.time = '22:30';
  });

  // B24 (G-021) scopes action frames to the active chat board, independently of the notice widget's placement.
  it.each([['21:00', '내일은 쉬어요'], ['22:30', '내일 아메리카노 50% 할인 쿠폰 드려요'], ['00:00', '내일은 쉬어요'], ['07:59', '내일은 쉬어요']])('offers a tomorrow 08:00 scheduled card at %s', (time, body) => {
    clock.time = time;
    const { run, store } = setup(body);
    const snapshot = store.getSnapshot();
    const draft = snapshot.tables.noticeDraft[0];
    const route = noticesDomain.route?.(`${draft.title} 공지 지금 보내줘`, snapshot, 'ko');
    expect(route).toMatchObject({ intent: { command: 'notice.send' }, slots: { sendAt: '2026-11-18T08:00' } });
    if (!route || !('intent' in route) || route.intent.kind !== 'command') throw Error('Missing scheduled card route');
    const prepared = createAgentActions(store, domains, run).prepare({ proposalId: 'night', command: 'notice.send',
      args: { noticeId: { handle: 'n' }, draftRevision: { slot: 'draftRevision' }, sendAt: { slot: 'sendAt' } },
      runId: snapshot.runId!, snapshotRevision: snapshot.revision, layer: run.getState().activeBoard, tier: 'normal' },
    { ...route.slots, draftRevision: draft.revision }, snapshot, undefined, new Map([['n', { kind: 'noticeDraft', id: draft.noticeId }]]));
    if (prepared.kind !== 'proposal') throw Error(prepared.kind);
    const { proposal } = prepared;
    expect((proposal.preview as { fields: { after: string }[] }).fields[0].after).toBe('내일 8시');
    // Nothing is sent or scheduled until the card is pressed.
    expect(store.getSnapshot()).toBe(snapshot);
    const receipt = proposal.confirm(store, proposal.id);
    expect(receipt.frame.outcome).toBe('applied');
    expect(store.getSnapshot().tables.noticeSent).toMatchObject([{ status: 'scheduled', sendAt: '2026-11-18T08:00' }]);
    expect(receipt.notice?.params).toMatchObject({ sendTime: '내일 8시' });
    expect(proposal.confirm(store, proposal.id).frame).toEqual(receipt.frame);
    expect(store.getSnapshot().tables.noticeSent).toHaveLength(1);
    if (!receipt.scheduledNotice) throw Error('Missing receipt cancellation');
    run.actions.clearNotice();
    expect(store.dispatch({ ...draft, type: 'notice.saveDraft', title: '휴무 안내 수정' }).ok).toBe(true);
    expect(receipt.scheduledNotice.isCancellable()).toBe(true);
    expect(receipt.scheduledNotice.cancel()).toBe(true);
    expect(receipt.scheduledNotice.isCancellable()).toBe(false);
    expect(store.getSnapshot().tables.noticeSent).toEqual(snapshot.tables.noticeSent);
  });

  it.each(['내일은 쉬어요', '내일 아메리카노 50% 할인'])('blocks an unscheduled card at preflight for %s', body => {
    const { run, store } = setup(body);
    const snapshot = store.getSnapshot();
    const draft = snapshot.tables.noticeDraft[0];
    expect(createAgentActions(store, domains, run).prepare({ proposalId: 'night-now', command: 'notice.send',
      args: { noticeId: { handle: 'n' }, draftRevision: { slot: 'draftRevision' } },
      runId: snapshot.runId!, snapshotRevision: snapshot.revision, layer: run.getState().activeBoard, tier: 'normal' },
    { draftRevision: draft.revision }, snapshot, undefined, new Map([['n', { kind: 'noticeDraft', id: draft.noticeId }]])).kind).toBe('invalid');
    expect(store.getSnapshot()).toBe(snapshot);
  });

  it('claims a closure notice SMS reservation and asks for the send time', () => {
    const { store } = setup('내일은 쉬어요');
    const snapshot = store.getSnapshot();
    expect(noticesDomain.route?.('휴무 공지 문자 예약해줘', snapshot, 'ko'))
      .toMatchObject({ kind: 'clarification', field: 'sendAt' });
  });

  it('refuses a chosen schedule time inside the night window', () => {
    const { store } = setup('내일은 쉬어요');
    const snapshot = store.getSnapshot();
    const route = noticesDomain.route?.(`${snapshot.tables.noticeDraft[0].title} 공지 내일 밤 11시에 예약 발송해줘`, snapshot, 'ko');
    expect(route).toMatchObject({ kind: 'clarification', field: 'sendAt' });
  });

  it('keeps an explicit same-day choice at night separate from the automatic fallback', () => {
    clock.time = '03:00';
    const { store } = setup('내일은 쉬어요');
    const snapshot = store.getSnapshot();
    const route = noticesDomain.route?.('오늘 아침 8시에 공지 예약 발송해줘', snapshot, 'ko');
    expect(route).toMatchObject({ intent: { command: 'notice.send' }, slots: { sendAt: '2026-11-17T08:00' } });
  });

  it('opens the send-now window at 08:00', () => {
    clock.time = '08:00';
    const { store } = setup('내일은 쉬어요');
    const route = noticesDomain.route?.('공지 지금 보내줘', store.getSnapshot(), 'ko');
    expect(route).toMatchObject({ intent: { command: 'notice.send' } });
    expect(route && 'slots' in route && route.slots?.sendAt).toBeUndefined();
  });

  it('refuses a daytime proposal that dropped the requested schedule', () => {
    clock.time = '15:45';
    const { run, store } = setup('내일은 쉬어요');
    const snapshot = store.getSnapshot();
    const draft = snapshot.tables.noticeDraft[0];
    const prepared = createAgentActions(store, domains, run).prepare({ proposalId: 'dropped-schedule', command: 'notice.send',
      args: { noticeId: { handle: 'n' }, draftRevision: { slot: 'draftRevision' } },
      runId: snapshot.runId!, snapshotRevision: snapshot.revision, layer: run.getState().activeBoard, tier: 'normal' },
    { draftRevision: draft.revision, sendAt: '2026-11-18T08:00' }, snapshot, undefined,
    new Map([['n', { kind: 'noticeDraft', id: draft.noticeId }]]));
    expect(prepared.kind).toBe('invalid');
    expect(store.getSnapshot()).toBe(snapshot);
  });
});

it.each([
  ['en', 'Send scheduled', 'Choose a time in the future', 'Choose a time from 8 AM to before 9 PM'],
  ['zh-Hans', '已安排发送', '请选择未来的时间', '请选择早上8点至晚上9点前的时间'],
  ['zh-Hant', '已安排傳送', '請選擇未來的時間', '請選擇早上8點至晚上9點前的時間'],
  ['ko', '발송을 예약했어요', '지금보다 늦은 시간을 골라 주세요', '오전 8시부터 밤 9시 전까지 골라 주세요'],
] as const)('localizes scheduling feedback in %s', (locale, saved, future, night) => {
  const { t } = navisTranslator(locale);
  expect(t('data.notices.notice.scheduled')).toBe(saved);
  expect(t('data.notices.error.SCHEDULE_IN_FUTURE')).toBe(future);
  expect(t('data.notices.error.SCHEDULE_NIGHT_RESTRICTED')).toBe(night);
});
