import { expect, it } from 'vitest';
import { beginDashboard } from '../../../app/test-session';
import { getRegistry } from '../../../catalog';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { ids, service } from '../../../data/reality/15/testing';
import { screenPresets } from '../../../layout';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { createAgentActions } from '../agent-actions';

/** HTTP builds: a Navis card runs the same service command as the widget, and only the owner's card press does it. */
async function setup() {
  const env = service();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  run.actions.switchLayer('marketing');
  const runId = run.getState().runId;
  const store = createWidgetDataStore(undefined, { runId });
  const port = createRealPort({ store, fetch: env.backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'inbox' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  await port.load('inbox');
  const actions = createAgentActions(store, undefined, run);
  const card = (command: string, args: Record<string, unknown>, targets: ReadonlyMap<string, { kind: 'thread' | 'noticeDraft'; id: string }>, tier: 'normal' | 'extra-confirm', slots: Record<string, unknown>) => {
    const snapshot = store.getSnapshot();
    const prepared = actions.prepare({ command, args, snapshotRevision: snapshot.revision, proposalId: `wire-${command.replace(/\W/g, '-')}`, runId, layer: 'marketing', tier } as never, slots as never, snapshot, () => true, targets as never);
    if (prepared.kind !== 'proposal') throw new Error(`${command}: ${JSON.stringify(prepared)} ${JSON.stringify(store.getSnapshot().tables.integration)}`);
    return { ...prepared.proposal, store };
  };
  return { ...env, store, card, runId };
}
const writes = (backend: ReturnType<typeof service>['backend']) => backend.calls.filter(call => call.method !== 'GET');

it('saves a reply draft and records the reply only on the card presses, with the card key as the idempotency key', async () => {
  const { backend, state, card, runId } = await setup();
  const targets = new Map([['t1', { kind: 'thread' as const, id: ids.talk }]]);
  const save = card('inquiry.saveDraft', { threadId: { handle: 't1' }, body: { slot: 'body' }, revision: { slot: 'revision' } }, targets, 'normal', { body: '일요일은 쉬어요', revision: 1 });
  expect(writes(backend)).toHaveLength(0);
  save.confirm(save.store);
  expect((await save.settled()).frame.outcome).toBe('applied');
  expect(backend.callsTo('PATCH', `/marketing/inquiries/${ids.talk}/draft`)[0]!.headers.get('idempotency-key')).toBe(`navis:${runId}:${save.id}`);
  const send = card('inquiry.send', { threadId: { handle: 't1' }, body: { slot: 'body' } }, targets, 'normal', { body: '일요일은 쉬어요' });
  expect(state.log).toEqual([]);
  send.confirm(send.store);
  expect((await send.settled()).frame.outcome).toBe('applied');
  expect(state.log).toEqual(['approval:inquiry.post:press', 'action:inquiry.post']);
});

it('deletes a notice draft only after the second card confirmation and records both steps', async () => {
  const { backend, state, card } = await setup();
  const proposal = card('notice.deleteDraft', { noticeId: { handle: 'n1' } }, new Map([['n1', { kind: 'noticeDraft', id: ids.notice }]]), 'extra-confirm', {});
  expect(proposal.tier).toBe('extra-confirm');
  proposal.confirm(proposal.store);
  expect(writes(backend)).toHaveLength(0);
  proposal.confirm(proposal.store, proposal.id);
  const receipt = await proposal.settled();
  expect(receipt.frame.outcome).toBe('applied');
  expect(receipt.undoToken).toMatch(/^real-undo:/);
  expect(state.log).toEqual(['approval:notice.deleteDraft:press', 'approval:notice.deleteDraft:confirm', 'action:notice.deleteDraft']);
});

it('sends a manual notice from the Navis card only on the press, never at preview', async () => {
  const { backend, state, card, store } = await setup();
  const draft = store.getSnapshot().tables.noticeDraft.find(row => row.noticeId === ids.notice)!;
  const proposal = card('notice.send', { noticeId: { handle: 'n1' }, draftRevision: { slot: 'draftRevision' } }, new Map([['n1', { kind: 'noticeDraft', id: ids.notice }]]), 'normal', { draftRevision: draft.revision });
  expect(writes(backend)).toHaveLength(0);
  expect(state.log).toEqual([]);
  proposal.confirm(proposal.store);
  expect((await proposal.settled()).frame.outcome).toBe('applied');
  expect(state.log).toEqual(['approval:notice.attest:press', 'action:notice.attest']);
});
