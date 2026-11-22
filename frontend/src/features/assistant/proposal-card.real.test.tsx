// @vitest-environment jsdom
/** R1-F17: the card UI for a press that goes through the real data port: pending, confirmed, failed, unknown outcome, undo. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getRegistry } from '../../catalog';
import { beginDashboard } from '../../app/test-session';
import { WidgetDataProvider } from '../../data/react';
import { createRealPort, defineBinding, type DomainAdapter } from '../../data/reality/00';
import { fakeBackend, reply } from '../../data/reality/00/testing';
import { createWidgetDataStore } from '../../data/widget-data';
import { screenPresets } from '../../layout';
import { createRunStore } from '../../state';
import { timePolicy } from '../../ui';
import { createAgentActions } from './agent-actions';
import { createProposalSession } from './navis-conversation';
import { navisTranslator } from './messages';
import { createAssistantProvider } from './provider';
import { AgentReplyControls } from './proposal-card';
import { sseFrame } from './stream-fixture';
import { draft, frame, name, rig, undoUntil } from './real-card-rig';

afterEach(cleanup);

function runRig() {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  return { run, ...rig({ runId: run.getState().runId }) };
}

function show(t: ReturnType<typeof runRig>, options: { withRun?: boolean } = {}) {
  const card = t.create();
  const onApplied = vi.fn();
  const session = createProposalSession(card, card, () => true, onApplied, '메뉴');
  const onNotice = vi.fn((notice: Parameters<typeof t.run.actions.showNotice>[0]) => t.run.actions.showNotice(notice));
  const ui = <WidgetDataProvider store={t.store}><AgentReplyControls reply={{ answer: '', panels: [], proposalSession: session }}
    run={options.withRun ? t.run : undefined} onContinue={vi.fn()} onNotice={onNotice} /></WidgetDataProvider>;
  const view = render(ui);
  return { card, session, onNotice, view, approve: () => screen.getByRole('button', { name: '메뉴 추가하기' }) };
}

it('shows a pending card at once, sends one request for a double press, then the confirmed receipt', async () => {
  const t = runRig();
  const { card, approve, onNotice } = show(t);
  fireEvent.click(approve());
  fireEvent.click(approve());
  expect(screen.getByRole('region', { busy: true })).toBeTruthy();
  expect(within(screen.getByRole('region')).getByRole('status').textContent).toBe('처리하고 있어요');
  expect(approve().getAttribute('aria-disabled')).toBe('true');
  expect(onNotice).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByText('메뉴를 추가했어요')).toBeTruthy());
  expect(t.backend.callsTo('POST', '/inventory/menu')).toHaveLength(1);
  expect(onNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    kind: 'success', messageKey: 'data.management.notice.saved', undo: { target: 'data', token: 'real-undo:rc-1' },
  }));
  expect(card.getReceipt()?.frame.outcome).toBe('applied');
});

it('still publishes the receipt notice when the chat was closed while the press was in flight', async () => {
  const t = runRig();
  const { approve, onNotice, view } = show(t);
  fireEvent.click(approve());
  view.unmount();
  await waitFor(() => expect(onNotice).toHaveBeenCalledOnce());
  expect(onNotice.mock.calls[0][0]).toMatchObject({ undo: { token: 'real-undo:rc-1' } });
});

it('shows the domain reason on a rejected write and does not keep the card pressable', async () => {
  const t = rig({ failCreate: () => reply(400, { code: 'VALIDATION', reason: 'PRICE_INVALID', field: 'price' }) });
  const card = t.create();
  const session = createProposalSession(card, card, () => true, vi.fn(), '메뉴');
  render(<WidgetDataProvider store={t.store}><AgentReplyControls reply={{ answer: '', panels: [], proposalSession: session }} onContinue={vi.fn()} onNotice={vi.fn()} /></WidgetDataProvider>);
  fireEvent.click(screen.getByRole('button', { name: '메뉴 추가하기' }));
  await waitFor(() => expect(screen.getByRole('region').getAttribute('data-outcome')).toBe('invalid'));
  expect(within(screen.getByRole('region')).getByRole('status').textContent).toContain('실행하지 못했어요');
  expect(screen.queryByText('처리하고 있어요')).toBeNull();
});

it('asks to re-check an unknown outcome and resends under the same key', async () => {
  let lost = 3;
  const created = new Map<string, object>();
  const backend = fakeBackend();
  backend.on('POST', '/inventory/menu', call => {
    const key = call.headers.get('idempotency-key') ?? '';
    if (!created.has(key)) created.set(key, { resourceId: 'm-new', revision: 1, receiptId: 'rc-1', undoUntil, affectedSources: ['menu'], changed: true });
    if (lost-- > 0) throw new TypeError('network lost');
    return created.get(key);
  });
  const store = createWidgetDataStore(undefined, { runId: 'unknown-ui' });
  const adapter: DomainAdapter = { domain: 'menu', sources: ['menu'], tables: ['menuItem'], async load() { return { tables: {}, asOf: '2026-11-21T09:00:00.000Z', sourceRevision: 1, complete: true }; },
    commands: [defineBinding({ type: 'menu.create', receiptBase: '/inventory', noticeKey: 'data.management.notice.saved', request: c => ({ method: 'POST', path: '/inventory/menu', body: { name: c.name } }) })] };
  store.bindReal(createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [adapter], sleep: async () => {}, reconcileDelaysMs: [0, 0] }));
  const card = createAgentActions(store).propose(frame, draft, store.getSnapshot())!;
  const session = createProposalSession(card, card, () => true, vi.fn(), '메뉴');
  render(<WidgetDataProvider store={store}><AgentReplyControls reply={{ answer: '', panels: [], proposalSession: session }} onContinue={vi.fn()} onNotice={vi.fn()} /></WidgetDataProvider>);
  fireEvent.click(screen.getByRole('button', { name: '메뉴 추가하기' }));
  const recheck = await screen.findByRole('button', { name: '결과 다시 확인하기' });
  expect(screen.getByText('처리 결과를 아직 확인하지 못했어요')).toBeTruthy();
  fireEvent.click(recheck);
  fireEvent.click(recheck);
  await waitFor(() => expect(screen.getByText('메뉴를 추가했어요')).toBeTruthy());
  expect(new Set(backend.callsTo('POST', '/inventory/menu').map(call => call.headers.get('idempotency-key'))).size).toBe(1);
  expect(created.size).toBe(1);
});

it('undoes a real receipt as pending, then undone, from the receipt row', async () => {
  const t = runRig();
  const { approve } = show(t, { withRun: true });
  fireEvent.click(approve());
  const undo = await screen.findByRole('button', { name: '되돌리기' });
  fireEvent.click(undo);
  fireEvent.click(undo);
  const row = screen.getByRole('group', { name: /작업 결과/u });
  expect(row.getAttribute('data-receipt-status')).toBe('undoing');
  expect(within(row).getByRole('status').textContent).toBe('되돌리고 있어요');
  expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
  await waitFor(() => expect(screen.getByText('되돌렸어요')).toBeTruthy());
  expect(t.undoCalls()).toBe(1);
  expect(t.names()).not.toContain(name);
});

it('keeps the receipt and shows the reason when the server refuses the undo', async () => {
  const t = runRig();
  t.backend.on('POST', /^\/inventory\/receipts\/.+\/undo$/, () => reply(409, { code: 'CONFLICT', reason: 'UNDO_EXPIRED' }));
  const { approve } = show(t, { withRun: true });
  fireEvent.click(approve());
  fireEvent.click(await screen.findByRole('button', { name: '되돌리기' }));
  await waitFor(() => expect(screen.getByText('되돌리지 못했어요')).toBeTruthy());
  expect(screen.getByRole('group', { name: /작업 결과/u }).getAttribute('data-receipt-status')).not.toBe('undone');
  expect(t.names()).toContain(name);
});

it('treats typed words as nothing while a real press is in flight: only the card result counts', async () => {
  const t = runRig();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.backend.on('POST', '/inventory/menu', async () => {
    await gate;
    return { resourceId: 'm-new', revision: 1, receiptId: 'rc-1', undoUntil, affectedSources: ['menu'], changed: true };
  });
  const wire = { command: 'menu.create', args: { name: { slot: 'name' }, category: 'drink', price: { slot: 'price' } }, snapshotRevision: 0 };
  const stream = new Response(sseFrame('panels', { panels: [] }) + sseFrame('action_proposal', wire) + sseFrame('done', { outcome: 'proposal' }),
    { headers: { 'X-Navis-Protocol': 'agent-v1' } });
  const provider = createAssistantProvider({ store: t.store, run: t.run, fetcher: vi.fn().mockResolvedValue(stream) });
  const card = await provider.ask({ text: `${name} 5500원 메뉴에 넣어줘`, signal: new AbortController().signal });
  render(<WidgetDataProvider store={t.store}><AgentReplyControls reply={card} run={t.run} onContinue={vi.fn()} onNotice={t.run.actions.showNotice} /></WidgetDataProvider>);
  fireEvent.click(screen.getByRole('button', { name: '메뉴 추가하기' }));
  await waitFor(() => expect(screen.getByText('처리하고 있어요')).toBeTruthy());
  const busy = navisTranslator('ko').t('common.navis.agent.busy');
  for (const typed of ['응', '취소', '그만']) {
    const answer = (await provider.ask({ text: typed, signal: new AbortController().signal })).answer;
    expect([typed, answer]).toEqual([typed, busy]);
  }
  release();
  await waitFor(() => expect(screen.getByText('메뉴를 추가했어요')).toBeTruthy());
  expect(t.backend.callsTo('POST', '/inventory/menu')).toHaveLength(1);
});
