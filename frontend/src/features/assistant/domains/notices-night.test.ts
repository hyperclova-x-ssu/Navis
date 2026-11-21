// @vitest-environment node
// D-326 Q6: at night a send is not sent now. The owner gets a card for the next 08:00 instead.
import { describe, expect, it, vi } from 'vitest';

// The mock clock is hoisted before every import, so the data layer and the adapter both see 22:30.
vi.mock('../../../pos/clock', () => ({
  POS_BUSINESS_DATE: '2026-11-17', POS_NOW_TIME: '22:30', POS_NOW: '2026-11-17T22:30', businessNow: () => '2026-11-17T22:30',
}));

import { createWidgetDataStore } from '../../../data/widget-data';
import { createLegacyNoticeSeed } from '../../../data/iteration7/notices/seed';
import { applyAgentRunUndo, createAgentActions } from '../agent-actions';
import { createRunStore } from '../../../state';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { timePolicy } from '../../../ui';
import { beginDashboard } from '../../../app/test-session';
import { noticesDomain } from './notices';
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

describe('D-326 night rule for notices', () => {
  it.each([['정보성', '내일은 쉬어요'], ['광고', '내일 아메리카노 50% 할인 쿠폰 드려요']])('offers a tomorrow 08:00 scheduled card for a %s notice instead of sending now', (_label, body) => {
    const { run, store } = setup(body);
    const snapshot = store.getSnapshot();
    const draft = snapshot.tables.noticeDraft[0];
    const route = noticesDomain.route?.(`${draft.title} 공지 지금 보내줘`, snapshot, 'ko');
    expect(route).toMatchObject({ intent: { command: 'notice.send' }, slots: { sendAt: '2026-11-18T08:00' } });
    if (!route || !('intent' in route) || route.intent.kind !== 'command') throw Error('Missing scheduled card route');
    const prepared = createAgentActions(store, domains, run).prepare({ proposalId: 'night', command: 'notice.send',
      args: { noticeId: { handle: 'n' }, draftRevision: { slot: 'draftRevision' }, sendAt: { slot: 'sendAt' } },
      runId: snapshot.runId!, snapshotRevision: snapshot.revision, layer: 'marketing', tier: 'normal' },
    { ...route.slots, draftRevision: draft.revision }, snapshot, undefined, new Map([['n', { kind: 'noticeDraft', id: draft.noticeId }]]));
    if (prepared.kind !== 'proposal') throw Error(prepared.kind);
    const { proposal } = prepared;
    expect((proposal.preview as { fields: { after: string }[] }).fields[0].after).toContain('08:00');
    // Nothing is sent or scheduled until the card is pressed.
    expect(store.getSnapshot()).toBe(snapshot);
    const receipt = proposal.confirm(store, proposal.id);
    expect(receipt.frame.outcome).toBe('applied');
    expect(store.getSnapshot().tables.noticeSent).toMatchObject([{ status: 'scheduled', sendAt: '2026-11-18T08:00' }]);
    if (!receipt.notice?.undo) throw Error('Missing receipt undo');
    run.actions.showNotice(receipt.notice);
    expect(applyAgentRunUndo(run, store, receipt.notice.undo.token)).toBe(true);
    expect(store.getSnapshot().tables.noticeSent).toEqual(snapshot.tables.noticeSent);
  });

  it('refuses a chosen schedule time inside the night window', () => {
    const { store } = setup('내일은 쉬어요');
    const snapshot = store.getSnapshot();
    const route = noticesDomain.route?.(`${snapshot.tables.noticeDraft[0].title} 공지 내일 밤 11시에 예약 발송해줘`, snapshot, 'ko');
    expect(route).toMatchObject({ kind: 'clarification', field: 'sendAt' });
  });
});
