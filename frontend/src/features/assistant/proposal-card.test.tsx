// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { WidgetDataProvider, useWidgetView } from '../../data/react';
import { createWidgetDataStore } from '../../data/widget-data';
import { addDays } from '../../data/db/time';
import { noticeBusinessNow } from '../../data/iteration7/notices/commands';
import { createLegacyNoticeSeed } from '../../data/iteration7/notices/seed';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { createRunStore, selectCommonNotice, selectCommonNoticePresentation } from '../../state';
import { timePolicy } from '../../ui';
import { beginDashboard } from '../../app/test-session';
import { createAgentActions } from './agent-actions';
import { createProposalSession } from './navis-conversation';
import { createAssistantProvider } from './provider';
import { AgentReplyControls, PendingCardLocator } from './proposal-card';
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
} as const;
const respond = (...frames: string[]) => new Response(sseFrame('panels', { panels: [] }) + frames.join(''), { headers });

function MenuWidgetRead() {
  const view = useWidgetView('menu');
  return <p>{view.status === 'ready' && view.model.rows.some(row => row.price === 5500 && row.name && 'raw' in row.name && row.name.raw === menuName) ? '새 메뉴 표시됨' : '새 메뉴 없음'}</p>;
}

it('shows the chat price error after an invalid preview attempt without applying a menu', async () => {
  const { controls, store } = menuCard();
  const before = store.getSnapshot();
  const user = userEvent.setup();
  render(controls());
  await user.click(screen.getByRole('button', { name: '변경 내용 고치기' }));
  const price = screen.getByRole('spinbutton', { name: '판매가' });
  await user.clear(price);
  await user.type(price, '0');
  await user.click(screen.getByRole('button', { name: '변경 내용 미리 보기' }));
  expect(screen.getByText('1원 이상을 숫자로 입력해 주세요')).toBeTruthy();
  expect(price.getAttribute('aria-invalid')).toBe('true');
  expect(store.getSnapshot()).toBe(before);
});

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

const staleReason = '지난 질문이라 더 고를 수 없어요';
const pressedOf = (group: HTMLElement) => within(group).getAllByRole('button').map(button => [button.textContent, button.getAttribute('aria-pressed'), button.getAttribute('aria-disabled') ?? (button.hasAttribute('disabled') ? 'true' : null)]);

it('marks only the picked price chip, locks the rest and remembers the pick after a remount (C-14, M-16)', () => {
  let current = true;
  const price = { id: 'price-1', field: 'price' as const, promptKey: 'menu.price' as const, isCurrent: () => current,
    choices: [{ id: '4500', value: 4500 }, { id: '5000', value: 5000 }, { id: '5500', value: 5500 }, { id: 'manual' as const }] };
  const reply = { answer: '', panels: [], protocol: 'agent-v1' as const, clarification: price };
  const onContinue = vi.fn();
  const ui = <WidgetDataProvider store={createWidgetDataStore()}><AgentReplyControls reply={reply} onContinue={onContinue} onNotice={vi.fn()} /></WidgetDataProvider>;
  const view = render(ui);
  const group = () => screen.getByRole('group', { name: '판매가는 얼마인가요?' });
  expect(pressedOf(group()).map(([, pressed]) => pressed)).toEqual(['false', 'false', 'false', 'false']);
  expect(screen.queryByText(staleReason)).toBeNull();

  fireEvent.click(within(group()).getByRole('button', { name: '5,000원' }));
  expect(onContinue).toHaveBeenCalledExactlyOnceWith({ clarificationId: 'price-1', price: 5000 });
  expect(pressedOf(group())).toEqual([['4,500원', 'false', 'true'], ['5,000원', 'true', 'true'], ['5,500원', 'false', 'true'], ['직접 입력하기', 'false', 'true']]);
  fireEvent.click(within(group()).getByRole('button', { name: '5,500원' }));
  expect(onContinue).toHaveBeenCalledOnce();
  // The group went stale after the pick (the continuation replaced it): the pick is still what the owner sees, with no "stale" reason.
  current = false;
  view.rerender(ui);
  expect(pressedOf(group()).map(([, pressed]) => pressed)).toEqual(['false', 'true', 'false', 'false']);
  expect(screen.queryByText(staleReason)).toBeNull();
  // Closing and reopening the chat remounts the controls; the pick is kept.
  view.unmount();
  render(ui);
  expect(pressedOf(group()).map(([, pressed]) => pressed)).toEqual(['false', 'true', 'false', 'false']);
  expect(screen.queryByText(staleReason)).toBeNull();
});

it('gives an old price question one reason line when a newer question made it inert (C-14)', () => {
  const onContinue = vi.fn();
  const old = { id: 'price-old', field: 'price' as const, promptKey: 'menu.price' as const, isCurrent: () => false,
    choices: [{ id: '4500', value: 4500 }, { id: 'manual' as const }] };
  render(<WidgetDataProvider store={createWidgetDataStore()}><AgentReplyControls reply={{ answer: '', panels: [], protocol: 'agent-v1', clarification: old }} onContinue={onContinue} onNotice={vi.fn()} /></WidgetDataProvider>);
  const group = screen.getByRole('group', { name: '판매가는 얼마인가요?' });
  expect(within(group).getByText(staleReason)).toBeTruthy();
  expect(pressedOf(group)).toEqual([['4,500원', 'false', 'true'], ['직접 입력하기', 'false', 'true']]);
  fireEvent.click(within(group).getByRole('button', { name: '4,500원' }));
  expect(onContinue).not.toHaveBeenCalled();
});

it('marks the picked choice among named choices and gives a stale group its reason (C-14, M-16)', () => {
  let current = true;
  const turn = { kind: 'ambiguity' as const, id: 'which-menu', field: 'target', isCurrent: () => current,
    choices: [{ id: 'a', label: '아메리카노', detail: '4,500원' }, { id: 'b', label: '카페라테', detail: '5,000원' }] };
  const reply = { answer: '', panels: [], protocol: 'agent-v1' as const, turn };
  const onContinue = vi.fn();
  const ui = <WidgetDataProvider store={createWidgetDataStore()}><AgentReplyControls reply={reply} onContinue={onContinue} onNotice={vi.fn()} /></WidgetDataProvider>;
  const view = render(ui);
  const group = () => screen.getByRole('group', { name: '선택할 항목' });
  expect(pressedOf(group()).map(([, pressed]) => pressed)).toEqual(['false', 'false']);
  fireEvent.click(within(group()).getByRole('button', { name: '카페라테 · 5,000원' }));
  expect(onContinue).toHaveBeenCalledExactlyOnceWith({ clarificationId: 'which-menu', choiceId: 'b' });
  expect(pressedOf(group())).toEqual([['아메리카노 · 4,500원', 'false', 'true'], ['카페라테 · 5,000원', 'true', 'true']]);
  current = false;
  view.rerender(ui);
  expect(pressedOf(group()).map(([, pressed]) => pressed)).toEqual(['false', 'true']);
  expect(screen.queryByText(staleReason)).toBeNull();
  view.unmount();

  // Never picked and already superseded: inert with the one-line reason.
  const stale = { ...turn, id: 'old-menu', isCurrent: () => false };
  render(<WidgetDataProvider store={createWidgetDataStore()}><AgentReplyControls reply={{ ...reply, turn: stale }} onContinue={onContinue} onNotice={vi.fn()} /></WidgetDataProvider>);
  expect(within(group()).getByText(staleReason)).toBeTruthy();
  expect(pressedOf(group()).map(([, pressed]) => pressed)).toEqual(['false', 'false']);
  fireEvent.click(within(group()).getByRole('button', { name: '아메리카노 · 4,500원' }));
  expect(onContinue).toHaveBeenCalledOnce();
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

it('shows Korean fixed controls and a sent receipt only after successful dispatch', () => {
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
    layer: run.getState().activeBoard, tier: 'normal', runId: run.getState().runId }, { draftRevision: draft.revision, navisLocale: 'en' },
  before, () => true, new Map([[handle, { kind: 'noticeDraft', id: draft.noticeId }]]));
  expect(action.kind).toBe('proposal');
  if (action.kind !== 'proposal') return;
  const session = createProposalSession(action.proposal, undefined, () => true, () => {}, 'Send notice');
  const onNotice = vi.fn();
  render(<WidgetDataProvider store={store}><AgentReplyControls reply={{ answer: '', panels: [], locale: 'en', proposalSession: session }}
    onContinue={vi.fn()} onNotice={onNotice} /></WidgetDataProvider>);
  const confirm = screen.getByRole('button', { name: '공지 보내기' });
  expect(store.getSnapshot()).toBe(before);
  fireEvent.click(confirm);
  expect(store.getSnapshot().tables.noticeSent).toMatchObject([{ noticeId: draft.noticeId, status: 'sent_example' }]);
  expect(screen.getByText('보냈어요')).toBeTruthy();
  expect(onNotice).toHaveBeenCalledExactlyOnceWith({ kind: 'success', featureId: 'notice-send', messageKey: 'data.notice.sent' });
});

function menuCard() {
  let now = 0;
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => now });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId });
  const menu = createAgentActions(store, undefined, run).propose(proposal, { name: menuName, category: 'drink', price: 5500 }, store.getSnapshot())!;
  const session = createProposalSession(menu, menu, () => true, () => {}, menuName);
  const controls = (visible = true) => <WidgetDataProvider store={store}>{visible && <AgentReplyControls run={run}
    reply={{ answer: '', panels: [], proposalSession: session }} onContinue={vi.fn()} onNotice={run.actions.showNotice} />}</WidgetDataProvider>;
  return { run, store, controls, session, advance: (ms: number) => act(() => { now += ms; run.actions.tick(); }) };
}

it('keeps the exact proposal after a confirmed busy failure until a fresh press succeeds (AC-1575)', () => {
  const { run, controls, store } = menuCard();
  const before = store.getSnapshot();
  const dispatch = vi.spyOn(store, 'dispatch').mockReturnValueOnce({
    ok: false, code: 'CONFLICT', reason: 'TRANSACTION_BUSY', messageKey: 'data.management.error.TRANSACTION_BUSY',
  });
  render(controls());
  const confirm = screen.getByRole('button', { name: '메뉴 추가하기' });
  fireEvent.click(confirm);
  expect(screen.getByText(/^실행하지 못했어요 · /u)).toBeTruthy();
  expect(screen.getByText(menuName)).toBeTruthy();
  expect(screen.queryByText('메뉴를 추가했어요')).toBeNull();
  expect(selectCommonNotice(run.getState())).toBeNull();
  expect(store.getSnapshot()).toBe(before);
  fireEvent.click(confirm, { detail: 2 });
  expect(dispatch).toHaveBeenCalledTimes(1);
  fireEvent.click(confirm);
  expect(screen.getByText('메뉴를 추가했어요')).toBeTruthy();
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it('keeps a failed Undo recorded when the shared deadline ends and the chat reopens (AC-1576)', () => {
  const { controls, store, advance } = menuCard();
  const { rerender } = render(controls());
  fireEvent.click(screen.getByRole('button', { name: '메뉴 추가하기' }));
  vi.spyOn(store, 'undo').mockReturnValueOnce({
    ok: false, code: 'CONFLICT', reason: 'TRANSACTION_BUSY', messageKey: 'data.management.error.TRANSACTION_BUSY',
  });
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(screen.getByText('되돌리지 못했어요').parentElement?.dataset.receiptStatus).toBe('applied');
  expect(screen.queryByText('되돌렸어요')).toBeNull();
  expect(screen.getByRole('button', { name: '되돌리기' })).toBeTruthy();
  rerender(controls(false));
  advance(timePolicy.undoMs + 1);
  rerender(controls());
  expect(screen.getByText('되돌리지 못했어요')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
});

it.each([
  { scheduled: false, actionLabel: '공지 보내기', noticeLabel: '발송 결과를 확인해 주세요' },
  { scheduled: true, actionLabel: '발송 예약하기', noticeLabel: '예약 결과를 확인해 주세요' },
])('locks an unconfirmed notice and offers only its history ($noticeLabel, AC-1577/AC-1578)', ({ scheduled, actionLabel, noticeLabel }) => {
  const { run, store: baseStore } = menuCard();
  const date = addDays(noticeBusinessNow(baseStore.getSnapshot()).slice(0, 10), 1);
  const original = baseStore.getSnapshot().tables.noticeDraft[0];
  const store = scheduled ? createWidgetDataStore({ noticeDraft: [{ ...original,
    closureEventId: null, closureRevision: null, startDate: date, endDate: date,
  }] }, { runId: run.getState().runId }) : baseStore;
  const before = store.getSnapshot();
  const draft = before.tables.noticeDraft[0];
  const handle = 'uncertain-notice';
  const args = { noticeId: { handle }, draftRevision: { slot: 'draftRevision' }, ...(scheduled ? { sendAt: { slot: 'sendAt' } } : {}) };
  // B24 (G-021) uses the chat's active board for the action frame so the send reaches AC-1577/AC-1578's receipt path.
  const result = createAgentActions(store, undefined, run).prepare({ command: 'notice.send', proposalId: handle, args,
    snapshotRevision: before.revision, tier: 'normal', layer: run.getState().activeBoard, runId: run.getState().runId },
  { draftRevision: draft.revision, ...(scheduled ? { sendAt: `${date}T14:00` } : {}) }, before, () => true,
  new Map([[handle, { kind: 'noticeDraft', id: draft.noticeId }]]));
  if (result.kind !== 'proposal') throw Error(result.kind);
  const dispatchOriginal = store.dispatch;
  const dispatch = vi.spyOn(store, 'dispatch').mockImplementation(command => {
    if (command.type === 'notice.send') throw Error('PRIVATE_TIMEOUT');
    return dispatchOriginal(command);
  });
  const session = createProposalSession(result.proposal, undefined, () => true, () => {}, draft.title);
  const openDetail = vi.fn(), onNotice = vi.fn();
  render(<WidgetDataProvider store={store}><AgentReplyControls run={run} reply={{ answer: '', panels: [], proposalSession: session }}
    onOpenDetail={openDetail} onContinue={vi.fn()} onNotice={onNotice} /></WidgetDataProvider>);
  const press = screen.getByRole('button', { name: actionLabel });
  fireEvent.click(press);
  fireEvent.click(press);
  expect(screen.getByText(noticeLabel)).toBeTruthy();
  expect(screen.queryByText(/보냈어요|예약했어요|PRIVATE_TIMEOUT/u)).toBeNull();
  expect(screen.queryByRole('button', { name: actionLabel })).toBeNull();
  expect(dispatch.mock.calls.filter(([command]) => command.type === 'notice.send')).toHaveLength(1);
  expect(onNotice).not.toHaveBeenCalled();
  const history = screen.getByRole('button', { name: /공지.*열기/u });
  fireEvent.click(history);
  expect(openDetail).toHaveBeenCalledExactlyOnceWith({ featureId: 'notice-send', view: scheduled ? 'scheduled' : 'history' }, history);
});

it('hands the Undo presentation to the toast with the original token and remaining time', () => {
  const { run, controls, advance } = menuCard();
  const { rerender } = render(controls());
  fireEvent.click(screen.getByRole('button', { name: '메뉴 추가하기' }));
  const receipt = screen.getByText('메뉴를 추가했어요').parentElement!;
  expect(document.activeElement).toBe(receipt);
  expect(within(receipt).getByRole('button', { name: '되돌리기' })).toBeTruthy();
  const notice = selectCommonNotice(run.getState())!;
  expect(notice.remainingMs).toBe(timePolicy.undoMs);
  expect(selectCommonNoticePresentation(run.getState())).toBeNull();
  advance(1900);
  rerender(controls(false));
  expect(selectCommonNoticePresentation(run.getState())).toMatchObject({ id: notice.id, undo: notice.undo, expiresAt: notice.expiresAt, remainingMs: 4100 });
  rerender(controls());
  expect(selectCommonNoticePresentation(run.getState())).toBeNull();
  advance(4100);
  expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
  expect(screen.getByText('메뉴를 추가했어요').parentElement?.dataset.receiptStatus).toBe('expired');
});

it('reverses from the receipt once and leaves an undone record when the notice changes', () => {
  const { run, controls, store } = menuCard();
  const before = store.getSnapshot();
  const { rerender } = render(controls());
  fireEvent.click(screen.getByRole('button', { name: '메뉴 추가하기' }));
  const undo = screen.getByRole('button', { name: '되돌리기' });
  fireEvent.click(undo);
  fireEvent.click(undo);
  expect(store.getSnapshot().revision).toBe(before.revision + 2);
  rerender(controls(false));
  act(() => run.actions.showNotice({ kind: 'complete', messageKey: 'data.notice.saved' }));
  rerender(controls());
  expect(screen.getByText('되돌렸어요').parentElement?.dataset.receiptStatus).toBe('undone');
  expect(selectCommonNoticePresentation(run.getState())?.messageKey).toBe('data.notice.saved');
});

it('retires the closed card and routes a fresh proposal only through its retry button', () => {
  const { session, run, store } = menuCard();
  const retry = vi.fn();
  const id = session.getSnapshot().proposal.id;
  render(<WidgetDataProvider store={store}><AgentReplyControls run={run}
    reply={{ answer: '', panels: [], proposalSession: session }} onContinue={vi.fn()} onNotice={run.actions.showNotice} onRepropose={retry} /></WidgetDataProvider>);
  act(() => { session.retireForClose(); });
  expect(session.confirm(store, id)).toBeUndefined();
  expect(screen.getByText('창을 닫아서 취소했어요')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '다시 제안 받기' }));
  expect(retry).toHaveBeenCalledOnce();
});

it('returns a stale second-step deletion to review, then deletes and restores once', () => {
  const { run, store } = menuCard();
  expect(store.dispatch({ type: 'menu.create', name: menuName, price: 5500, category: 'drink', idempotencyKey: 'delete-fixture' }).ok).toBe(true);
  const before = store.getSnapshot();
  const menu = before.tables.menuItem.find(row => row.name && 'raw' in row.name && row.name.raw === menuName)!;
  const handle = 'menu-delete';
  const action = createAgentActions(store, undefined, run).prepare({ command: 'menu.delete', proposalId: handle, args: { menuId: { handle } },
    snapshotRevision: before.revision, layer: 'management', tier: 'extra-confirm', runId: run.getState().runId }, {}, before,
  () => true, new Map([[handle, { kind: 'menu', id: menu.menuId }]]));
  if (action.kind !== 'proposal') throw Error(action.kind);
  const session = createProposalSession(action.proposal, undefined, () => true, () => {}, menuName);
  render(<WidgetDataProvider store={store}><AgentReplyControls run={run} reply={{ answer: '', panels: [], proposalSession: session }}
    onContinue={vi.fn()} onNotice={run.actions.showNotice} /></WidgetDataProvider>);
  fireEvent.click(screen.getByRole('button', { name: '삭제 내용 확인하기' }));
  const review = screen.getByRole('button', { name: '변경 취소하기' });
  const remove = screen.getByRole('button', { name: `${menuName} 지우기` });
  expect(document.activeElement).toBe(review);
  expect(review.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(fireEvent.keyDown(review, { key: 'Enter', repeat: true })).toBe(false);
  expect(fireEvent.mouseDown(screen.getByText(/메뉴를 지울까요/u), { detail: 2 })).toBe(false);
  fireEvent.click(remove, { detail: 2 });
  expect(store.getSnapshot()).toBe(before);
  fireEvent.keyDown(remove, { key: 'Escape' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '삭제 내용 확인하기' }));
  fireEvent.click(screen.getByRole('button', { name: '삭제 내용 확인하기' }));
  act(() => { expect(store.dispatch({ type: 'menu.create', name: '다른 메뉴', price: 5000, category: 'drink', idempotencyKey: 'stale-fixture' }).ok).toBe(true); });
  fireEvent.click(screen.getByRole('button', { name: `${menuName} 지우기` }));
  expect(session.getSnapshot().proposal.id).not.toBe(action.proposal.id);
  expect(screen.getByRole('button', { name: '삭제 내용 확인하기' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '삭제 내용 확인하기' }));
  fireEvent.click(screen.getByRole('button', { name: `${menuName} 지우기` }));
  const row = () => store.getSnapshot().tables.menuItem.find(item => item.menuId === menu.menuId);
  expect(row()?.deletedAt).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(row()?.deletedAt).toBeFalsy();
});

it('keeps the scheduled receipt on back and cancels once after a second press', () => {
  const { run, store: baseStore } = menuCard();
  const date = addDays(noticeBusinessNow(baseStore.getSnapshot()).slice(0, 10), 1);
  const original = createLegacyNoticeSeed().noticeDraft[0];
  const body = `내일은 쉬어요\n${'안내 문장 '.repeat(200)}이상이 공지 전문이에요.`;
  const store = createWidgetDataStore({ noticeDraft: [{ ...original, closureEventId: null, closureRevision: null,
    body, startDate: date, endDate: date }] }, { runId: run.getState().runId });
  const before = store.getSnapshot();
  const draft = before.tables.noticeDraft[0];
  const handle = 'schedule-fixture';
  const sendAt = `${date}T14:00`;
  // B24 (G-021) binds the frame to the chat board before the M-13/M-15 cancellation flow begins.
  const action = createAgentActions(store, undefined, run).prepare({ command: 'notice.send', proposalId: handle,
    args: { noticeId: { handle }, draftRevision: { slot: 'draftRevision' }, sendAt: { slot: 'sendAt' } },
    snapshotRevision: before.revision, layer: run.getState().activeBoard, tier: 'normal', runId: run.getState().runId },
  { draftRevision: draft.revision, sendAt }, before, () => true, new Map([[handle, { kind: 'noticeDraft', id: draft.noticeId }]]));
  if (action.kind !== 'proposal') throw Error(action.kind);
  const session = createProposalSession(action.proposal, undefined, () => true, () => {}, draft.title);
  render(<WidgetDataProvider store={store}><AgentReplyControls run={run} reply={{ answer: '', panels: [], proposalSession: session }}
    onContinue={vi.fn()} onNotice={run.actions.showNotice} /></WidgetDataProvider>);
  expect(screen.getByText('받는 사람')).toBeTruthy();
  expect(screen.getByText(/14:00/)).toBeTruthy();
  expect(screen.getByText(/공지 전문이에요/u).textContent).toContain(body);
  fireEvent.click(screen.getByRole('button', { name: '발송 예약하기' }));
  const scheduled = store.getSnapshot();
  expect(scheduled.tables.noticeSent).toMatchObject([{ noticeId: draft.noticeId, status: 'scheduled' }]);
  expect(screen.getByText('예약했어요')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '예약 취소하기' }));
  expect(store.getSnapshot()).toBe(scheduled);
  const back = screen.getByRole('button', { name: '변경 취소하기' });
  expect(document.activeElement).toBe(back);
  fireEvent.click(back);
  expect(screen.getByText('예약했어요')).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '예약 취소하기' }));
  expect(store.getSnapshot()).toBe(scheduled);

  fireEvent.click(screen.getByRole('button', { name: '예약 취소하기' }));
  const confirmCancel = screen.getByRole('button', { name: '예약 취소하기' });
  fireEvent.click(confirmCancel, { detail: 2 });
  expect(store.getSnapshot()).toBe(scheduled);
  fireEvent.click(confirmCancel);
  const cancelled = store.getSnapshot();
  expect(screen.getByText('예약을 취소했어요')).toBeTruthy();
  expect(cancelled.revision).toBe(scheduled.revision + 1);
  expect(cancelled.tables.noticeSent).toEqual(before.tables.noticeSent);
  fireEvent.click(confirmCancel);
  expect(store.getSnapshot()).toBe(cancelled);
});

it('locates the off-screen action row without activating the proposal', () => {
  const pressed = vi.fn();
  function Transcript() {
    const body = useRef<HTMLDivElement>(null);
    return <><div ref={body} aria-label="대화"><div data-navis-pending-action-row><button onClick={pressed}>실행</button></div></div>
      <PendingCardLocator transcript={body} /></>;
  }
  render(<Transcript />);
  const body = screen.getByLabelText('대화');
  const action = screen.getByRole('button', { name: '실행' });
  vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ height: 100, top: 0, bottom: 100 } as DOMRect);
  vi.spyOn(action.parentElement!, 'getBoundingClientRect').mockReturnValue({ height: 40, top: 90, bottom: 130 } as DOMRect);
  fireEvent.scroll(body);
  fireEvent.click(screen.getByRole('button', { name: '카드 보기' }));
  expect(document.activeElement).toBe(action);
  expect(pressed).not.toHaveBeenCalled();
});
