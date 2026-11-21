// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { WidgetDataProvider, useWidgetView } from '../../data/react';
import { createWidgetDataStore } from '../../data/widget-data';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { createRunStore } from '../../state';
import { timePolicy } from '../../ui';
import { beginDashboard } from '../../app/test-session';
import { createAgentActions } from './agent-actions';
import { createProposalSession } from './navis-conversation';
import { createAssistantProvider } from './provider';
import { AgentReplyControls } from './proposal-card';
import { sseFrame } from './stream-fixture';

afterEach(cleanup);

const headers = { 'X-Navis-Protocol': 'agent-v1' };
const menuName = '동백 라테';
const text = `${menuName} 메뉴에 넣어줘`;
const clarification = {
  field: 'price', promptKey: 'menu.price',
  choices: [{ id: '4500', value: 4500 }, { id: '5000', value: 5000 }, { id: '5500', value: 5500 }, { id: 'manual' }],
};
const proposal = {
  command: 'menu.create', args: { name: { slot: 'name' }, category: 'drink', price: { slot: 'price' } },
  snapshotRevision: 0,
};
const respond = (...frames: string[]) => new Response(sseFrame('panels', { panels: [] }) + frames.join(''), { headers });

function MenuWidgetRead() {
  const view = useWidgetView('menu');
  return <p>{view.status === 'ready' && view.model.rows.some(row => row.price === 5500 && row.name && 'raw' in row.name && row.name.raw === menuName) ? '새 메뉴 표시됨' : '새 메뉴 없음'}</p>;
}

it('takes a verified price chip to a preview, then confirms and publishes the store notice', async () => {
  const store = createWidgetDataStore();
  const fetcher = vi.fn().mockResolvedValueOnce(respond(sseFrame('done', { outcome: 'clarify', clarification })))
    .mockResolvedValueOnce(respond(sseFrame('action_proposal', proposal), sseFrame('done', { outcome: 'proposal' })));
  const provider = createAssistantProvider({ store, fetcher });
  const ask = { text, signal: new AbortController().signal };
  const reply = await provider.ask(ask);
  const onContinue = vi.fn();
  const onNotice = vi.fn();
  const ui = (value: typeof reply) => <WidgetDataProvider store={store}><AgentReplyControls reply={value} onContinue={onContinue} onNotice={onNotice} /><MenuWidgetRead /></WidgetDataProvider>;
  const { rerender } = render(ui(reply));

  expect(screen.getByText('판매가는 얼마인가요?')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '5,500원' }));
  expect(onContinue).toHaveBeenCalledOnce();
  const confirmedPrice = onContinue.mock.calls[0][0];
  rerender(ui(await provider.ask({ ...ask, continuation: confirmedPrice })));

  expect(screen.getByText(menuName)).toBeTruthy();
  expect(screen.getByText('새 메뉴 없음')).toBeTruthy();
  const confirm = screen.getByRole('button', { name: '메뉴 추가하기' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(screen.getByText('새 메뉴 표시됨')).toBeTruthy();
  expect(onNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    kind: 'success', messageKey: 'data.management.notice.saved',
    undo: { target: 'data', token: expect.any(String) },
  }));
});

it('keeps the extra confirmation pending after a double-click and accepts a new keyboard press', async () => {
  const store = createWidgetDataStore();
  const fetcher = vi.fn().mockResolvedValue(respond(
    sseFrame('action_proposal', { ...proposal, tier: 'extra-confirm' }),
    sseFrame('done', { outcome: 'proposal' }),
  ));
  const provider = createAssistantProvider({ store, fetcher });
  const reply = await provider.ask({ text: `${menuName} 5500원 메뉴에 넣어줘`, signal: new AbortController().signal });
  const before = store.getSnapshot();
  const onNotice = vi.fn();
  const user = userEvent.setup();
  render(<WidgetDataProvider store={store}><AgentReplyControls reply={reply} onContinue={vi.fn()} onNotice={onNotice} /></WidgetDataProvider>);

  await user.dblClick(screen.getByRole('button', { name: '메뉴 추가하기' }));
  expect(store.getSnapshot()).toBe(before);
  expect(onNotice).not.toHaveBeenCalled();
  screen.getByRole('button', { name: '변경 한 번 더 확인하기' }).focus();
  await user.keyboard('{Enter}');
  expect(store.getSnapshot().revision).toBe(before.revision + 1);
  expect(onNotice).toHaveBeenCalledOnce();
});

it('publishes the simulated notice receipt in English on the existing confirm card', () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  run.actions.switchLayer('marketing');
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId });
  const before = store.getSnapshot();
  const draft = before.tables.noticeDraft[0];
  const handle = 'notice-card-fixture';
  const action = createAgentActions(store, undefined, run).prepare({ command: 'notice.send', proposalId: 'notice-card-en',
    args: { noticeId: { handle }, draftRevision: { slot: 'draftRevision' } }, snapshotRevision: before.revision,
    layer: 'marketing', tier: 'normal', runId: run.getState().runId }, { draftRevision: draft.revision, navisLocale: 'en' },
  before, () => true, new Map([[handle, { kind: 'noticeDraft', id: draft.noticeId }]]));
  expect(action.kind).toBe('proposal');
  if (action.kind !== 'proposal') return;
  const session = createProposalSession(action.proposal, undefined, () => true, () => {}, 'Send notice');
  const onNotice = vi.fn();
  render(<WidgetDataProvider store={store}><AgentReplyControls reply={{ answer: '', panels: [], locale: 'en', proposalSession: session }}
    onContinue={vi.fn()} onNotice={onNotice} /></WidgetDataProvider>);
  const confirm = screen.getByRole('button', { name: 'Apply change' });
  expect(store.getSnapshot()).toBe(before);
  fireEvent.click(confirm);
  expect(store.getSnapshot().tables.noticeSent).toMatchObject([{ noticeId: draft.noticeId, status: 'sent_example' }]);
  expect(onNotice).toHaveBeenCalledExactlyOnceWith({ kind: 'success', featureId: 'notice-send', messageKey: 'data.notice.sent' });
});
