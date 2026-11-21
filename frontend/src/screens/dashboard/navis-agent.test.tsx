import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Profiler } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AGENT_PRICE_CLARIFICATION, AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentRequest, type AgentFrameData, type AgentRequest } from '../../../shared/navis-agent-schema.mjs';
import { CommonNotice } from '../../app/CommonNotice';
import { beginDashboard } from '../../app/test-session';
import { getRegistry } from '../../catalog';
import { createWidgetDataStore, selectMenus } from '../../data/widget-data';
import { sseFrame } from '../../features/assistant/stream-fixture';
import { widgets as menuWidgets } from '../../features/widgets/mgmt-products';
import { screenPresets } from '../../layout';
import { createRunStore, selectCommonNotice } from '../../state';
import { timePolicy } from '../../ui';
import { KitProviders } from '../../ui/test-utils';
import { DashboardScreen } from './DashboardScreen';

const menuName = '검은콩 라테';
const question = `${menuName} 메뉴에 넣어줘`;
const answer = '확인하면 메뉴에 추가할 수 있어요.';
const priceQuestion = '판매가는 얼마인가요?';
const cardTitle = '메뉴 추가';
const flush = () => act(async () => {});

function bridgeStream() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream', [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } }),
    frame<K extends keyof AgentFrameData>(event: K, data: AgentFrameData[K]) { writer.enqueue(encoder.encode(sseFrame(event, data))); },
  };
}

const runs: ReturnType<typeof createRunStore>[] = [];
afterEach(() => {
  cleanup();
  for (const run of runs.splice(0)) run.dispose();
  vi.unstubAllGlobals();
});

async function mount(reducedMotion = true) {
  const streams: ReturnType<typeof bridgeStream>[] = [];
  const requests: AgentRequest[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('/api/navis/chat');
    expect(new Headers(init.headers).get(AGENT_PROTOCOL_HEADER)).toBe(AGENT_PROTOCOL);
    const request: unknown = JSON.parse(init.body as string);
    if (!validateAgentRequest(request)) throw new Error('Invalid agent request');
    requests.push(request);
    const stream = bridgeStream();
    streams.push(stream);
    return stream.response;
  }));

  const preset = screenPresets.A;
  const run = createRunStore({ screenPreset: preset, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion });
  runs.push(run);
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  run.actions.applyLayoutIntent({ type: 'restore', panels: [{ featureId: 'menu', column: 0, row: 0, width: 1, height: 1 }] });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId });
  const commits: { answer: boolean; proposal: boolean; waiting: boolean }[] = [];
  const view = render(<KitProviders preset={preset} reducedMotion={reducedMotion} store={store} modules={menuWidgets}>
    <Profiler id="dashboard" onRender={() => commits.push({
      answer: !!document.querySelector('[data-role="assistant"] .ai-conversation__answer'),
      proposal: !!document.querySelector('[data-readonly="proposal"]'),
      waiting: !!document.querySelector('.ai-wait'),
    })}><DashboardScreen run={run} /></Profiler>
    <CommonNotice run={run} />
  </KitProviders>);
  await flush();
  // Isolate the smoke test from the dashboard's jsdom Worker startup notice.
  act(() => run.actions.clearNotice());
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  const input = screen.getByRole('textbox', { name: '자유롭게 질문해 주세요' });
  const send = (text: string) => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };
  const rows = () => selectMenus(store.getSnapshot(), {}).rows;
  const created = () => rows().find(row => row.name && 'raw' in row.name && row.name.raw === menuName);
  const widgetCount = () => view.container.querySelector('[data-slot="menu.metric.value"]');

  function sendProposal(index: number) {
    const stream = streams[index];
    stream.frame('status', { step: 'assembling' });
    stream.frame('text_delta', { delta: answer });
    stream.frame('panels', { panels: [] });
    stream.frame('action_proposal', {
      command: 'menu.create',
      args: { name: { slot: 'name' }, category: 'drink', price: { slot: 'price' } },
      snapshotRevision: requests[index].snapshotRevision,
    });
    return stream;
  }
  const preview = async () => {
    send(`${menuName} 5500원 메뉴에 넣어줘`);
    sendProposal(0).frame('done', { outcome: 'proposal' });
    await flush();
    return screen.getByRole('region', { name: cardTitle });
  };
  return { run, store, streams, requests, send, rows, created, view, widgetCount, commits, sendProposal, preview };
}

it('asks for a price, atomically reveals the proposal, and updates the menu widget through confirm and undo', async () => {
  const host = await mount(false);
  const count = host.rows().length;
  expect(host.widgetCount()).toHaveTextContent(String(count));
  host.send(question);
  host.streams[0].frame('status', { step: 'target_checked' });
  host.streams[0].frame('panels', { panels: [] });
  await flush();
  expect(screen.getByText('변경 내용을 확인하고 있어요').closest('[role="status"]')).toBeInTheDocument();
  expect(screen.queryByText(priceQuestion)).toBeNull();

  host.streams[0].frame('done', { outcome: 'clarify', clarification: AGENT_PRICE_CLARIFICATION });
  await flush();
  expect(screen.getAllByText(priceQuestion)).toHaveLength(1);
  const choices = within(screen.getByRole('group', { name: priceQuestion }));
  expect(choices.getAllByRole('button').map(button => button.textContent)).toEqual(['4,500원', '5,000원', '5,500원', '직접 입력']);
  fireEvent.click(choices.getByRole('button', { name: '5,500원' }));
  expect(host.requests.map(request => request.slots)).toEqual([['name'], ['name', 'price']]);
  expect(JSON.stringify(host.requests)).not.toContain(menuName);
  expect(host.view.container.querySelectorAll('[data-role="user"]')).toHaveLength(1);

  host.commits.length = 0;
  const stream = host.sendProposal(1);
  await flush();
  expect(screen.getByText('답을 정리하고 있어요')).toBeInTheDocument();
  expect(screen.queryByText(answer)).toBeNull();
  expect(screen.queryByRole('region', { name: cardTitle })).toBeNull();
  stream.frame('done', { outcome: 'proposal' });
  await flush();

  const card = screen.getByRole('region', { name: cardTitle });
  const reveal = card.closest('.ai-conversation__reveal');
  expect(reveal).toHaveAttribute('data-fade', 'true');
  expect(reveal?.querySelector('.ai-conversation__answer')).toHaveTextContent(answer);
  expect(host.commits[0]).toEqual({ answer: false, proposal: false, waiting: true });
  expect(host.commits.find(commit => commit.answer || commit.proposal)).toEqual({ answer: true, proposal: true, waiting: false });
  expect(host.commits.every(commit => commit.answer === commit.proposal)).toBe(true);
  expect(within(card).getByText('추가 전')).toHaveTextContent('추가 전 없음');
  expect(within(card).getByText('추가 후')).toBeInTheDocument();
  expect(Array.from(card.querySelectorAll('dl > div'), row => Array.from(row.children, cell => cell.textContent))).toEqual([
    ['메뉴 이름', menuName], ['판매가', '5,500원'], ['메뉴 수', `${count} → ${count + 1}`], ['분류', '음료'], ['메모', '없음'],
    ['판매 상태', '판매 중'], ['준비 시간', '3분'], ['판매 수', '0'], ['원가', '없음'],
    ['등록 재료', '없음'], ['옵션 그룹', '없음'], ['사진', '없음'],
  ]);
  expect(host.created()).toBeUndefined();

  const confirm = within(card).getByRole('button', { name: '메뉴 추가하기' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(host.created()).toMatchObject({ name: { raw: menuName }, category: 'drink', price: 5500 });
  expect(host.widgetCount()).toHaveTextContent(String(count + 1));
  expect(selectCommonNotice(host.run.getState())).toMatchObject({ messageKey: 'data.management.notice.saved', undo: { target: 'data' } });
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(host.created()).toBeUndefined();
  expect(host.widgetCount()).toHaveTextContent(String(count));
  fireEvent.click(confirm);
  expect(host.created()).toBeUndefined();
});

it('cancels a proposal under reduced motion without a data write or undo', async () => {
  const host = await mount();
  const before = host.store.getSnapshot();
  const card = await host.preview();
  expect(card.closest('.ai-conversation__reveal')).not.toHaveAttribute('data-fade');
  fireEvent.click(within(card).getByRole('button', { name: '변경 취소하기' }));
  expect(within(card).getByText('변경을 취소했어요')).toBeInTheDocument();
  fireEvent.click(within(card).getByRole('button', { name: '메뉴 추가하기' }));
  expect(host.store.getSnapshot()).toBe(before);
  expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
});

async function confirmRunChange(host: Awaited<ReturnType<typeof mount>>, text: string, command: 'layout.add_widget' | 'settings.set_text_scale') {
  host.send(text);
  const request = host.requests[0];
  expect(request?.intent).toMatchObject({ kind: 'command', command });
  if (request.intent.kind !== 'command') throw new Error('Expected a run command');
  host.streams[0].frame('panels', { panels: [] });
  host.streams[0].frame('action_proposal', {
    command, args: request.intent.args ?? {}, snapshotRevision: request.snapshotRevision,
    proposalId: 'run-change', runId: request.runId, layer: request.layer, page: request.page, tier: 'normal',
  });
  host.streams[0].frame('done', { outcome: 'proposal' });
  await flush();
  fireEvent.click(screen.getByRole('button', { name: '변경 적용하기' }));
}

it('shows one undo on the open board for a cross-board layout change', async () => {
  const host = await mount();
  const { management, marketing } = host.run.getState().boards;
  await confirmRunChange(host, '마케팅 보드에 진행 중인 쿠폰 위젯 추가해줘', 'layout.add_widget');
  expect(host.requests[0].intent).toMatchObject({ args: { layer: 'marketing', featureId: 'coupon-status' } });
  expect(host.run.getState().activeBoard).toBe('management');
  expect(host.run.getState().boards.management).toBe(management);
  expect(host.run.getState().boards.marketing.pages[0].panels).toEqual(expect.arrayContaining([
    expect.objectContaining({ featureId: 'coupon-status' }),
  ]));
  expect(selectCommonNotice(host.run.getState())).toMatchObject({ undo: { target: 'run' } });
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(host.run.getState().boards.marketing.pages).toEqual(marketing.pages);
  expect(host.run.getState().boards.management).toBe(management);
  expect(host.run.getState().activeBoard).toBe('management');
  expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
});

it('keeps a setting receipt available after a busy undo and an unrelated data write', async () => {
  const host = await mount();
  await confirmRunChange(host, '큰 글자로 해줘', 'settings.set_text_scale');
  expect(host.run.getState().textScale).toBe(125);
  const receipt = selectCommonNotice(host.run.getState())!;
  expect(receipt.undo?.target).toBe('run');
  const { runId, posUi } = host.run.getState();
  const approval = {
    status: 'pending' as const, attemptId: 'pending-test', runId,
    meta: { runId, idempotencyKey: 'pending-test' },
    cartId: 'test-cart', splits: [], quoteFingerprint: 'test-quote', payloadFingerprint: 'test-payload',
    closingGeneration: 0, scenario: 'normal' as const,
  };
  act(() => { expect(host.run.actions.setPosUi({ ...posUi, approval }, runId)).toBe(true); });
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(host.run.getState().textScale).toBe(125);
  expect(selectCommonNotice(host.run.getState())).toMatchObject({ id: receipt.id, undo: receipt.undo, expiresAt: receipt.expiresAt });

  act(() => {
    expect(host.run.actions.setPosUi(posUi, runId)).toBe(true);
    expect(host.store.dispatch({ type: 'menu.create', name: '동시에 추가한 메뉴', category: 'drink', price: 3000,
      idempotencyKey: 'unrelated-to-settings-undo' }).ok).toBe(true);
  });
  const dataAfterWrite = host.store.getSnapshot();
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(host.run.getState().textScale).toBe(100);
  expect(host.store.getSnapshot()).toBe(dataAfterWrite);
  expect(selectCommonNotice(host.run.getState())?.messageKey).toBe('data.notice.undone');
  expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
});

it('rejects an invalid edited price, then previews and saves the revised value', async () => {
  const host = await mount();
  const card = await host.preview();
  fireEvent.click(within(card).getByRole('button', { name: '변경 내용 고치기' }));
  const form = within(card).getByRole('form', { name: '변경 내용 고치기' });
  const price = within(form).getByRole('spinbutton', { name: '판매가' });
  fireEvent.change(price, { target: { value: '0' } });
  fireEvent.submit(form);
  expect(price).toHaveAttribute('aria-invalid', 'true');
  expect(within(form).getByText('1원 이상을 숫자로 입력해 주세요')).toBeInTheDocument();
  expect(host.created()).toBeUndefined();
  fireEvent.change(price, { target: { value: '6300' } });
  fireEvent.click(within(form).getByRole('button', { name: '변경 내용 미리 보기' }));
  expect(within(card).queryByRole('form')).toBeNull();
  expect(within(card).getByText('6,300원')).toBeInTheDocument();
  expect(host.created()).toBeUndefined();
  fireEvent.click(within(card).getByRole('button', { name: '메뉴 추가하기' }));
  expect(host.created()?.price).toBe(6300);
});

it('requires a new preview for stale widget data before confirming', async () => {
  const host = await mount();
  const count = host.rows().length;
  const card = await host.preview();
  act(() => {
    expect(host.store.dispatch({ type: 'menu.create', name: '동시에 추가한 메뉴', category: 'drink', price: 3000, idempotencyKey: 'concurrent-menu' }).ok).toBe(true);
  });
  fireEvent.click(within(card).getByRole('button', { name: '메뉴 추가하기' }));
  expect(within(card).getByText('데이터가 바뀌었어요. 변경 내용을 다시 확인해 주세요')).toBeInTheDocument();
  expect(host.created()).toBeUndefined();
  expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
  expect(within(card).getByText(`${count + 1} → ${count + 2}`)).toBeInTheDocument();
  expect(host.created()).toBeUndefined();
  fireEvent.click(within(card).getByRole('button', { name: '메뉴 추가하기' }));
  expect(host.created()?.price).toBe(5500);
});

it('discards a pending proposal when Navis closes, even if its history is reopened', async () => {
  const host = await mount();
  await host.preview();
  fireEvent.click(screen.getByRole('button', { name: 'Navis 닫기' }));
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  const confirm = within(screen.getByRole('region', { name: cardTitle })).getByRole('button', { name: '메뉴 추가하기' });
  expect(confirm).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(confirm);
  expect(host.created()).toBeUndefined();
});

it('N00 S1-023 previews the explicit dessert price and confirms the exact row', async () => {
  const host = await mount();
  host.send('메뉴에 마들렌 디저트를 3,000원에 넣어줘');
  const stream = host.streams[0];
  stream.frame('panels', { panels: [] });
  stream.frame('action_proposal', {
    command: 'menu.create', args: { name: { slot: 'name' }, price: { slot: 'price' }, category: 'dessert' },
    snapshotRevision: host.requests[0].snapshotRevision,
  });
  stream.frame('done', { outcome: 'proposal' });
  await flush();
  const card = screen.getByRole('region', { name: cardTitle });
  expect(within(card).getByText('마들렌')).toBeInTheDocument();
  expect(within(card).getByText('3,000원')).toBeInTheDocument();
  fireEvent.click(within(card).getByRole('button', { name: '메뉴 추가하기' }));
  expect(host.rows().at(-1)).toMatchObject({ name: { raw: '마들렌' }, category: 'dessert', price: 3000 });
});

it('N00 S8-005 refuses a duplicate without a card or store mutation', async () => {
  const host = await mount();
  const before = host.store.getSnapshot();
  host.send('아메리카노 메뉴에 4,500원에 등록해줘');
  expect(host.requests[0].searches[0].matches).toEqual([{ handle: expect.any(String), match: 'exact' }]);
  const stream = host.sendProposal(0);
  stream.frame('done', { outcome: 'proposal' });
  await flush();
  expect(screen.getByText('같거나 비슷한 이름의 메뉴가 있어요')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: cardTitle })).not.toBeInTheDocument();
  expect(host.store.getSnapshot()).toBe(before);
});

it('N01 S8-004 asks for the name and previews the local price after the typed answer', async () => {
  const host = await mount();
  const before = host.store.getSnapshot();
  host.send('5,500원짜리 메뉴 하나 추가해줘');
  await flush();
  expect(host.requests).toHaveLength(0);
  expect(screen.getByText('추가할 메뉴 이름은 무엇인가요?')).toBeInTheDocument();
  host.send(menuName);
  host.sendProposal(0).frame('done', { outcome: 'proposal' });
  await flush();
  expect(within(screen.getByRole('region', { name: cardTitle })).getByText('5,500원')).toBeInTheDocument();
  expect(host.store.getSnapshot()).toBe(before);
});

it('keeps a pending card across reads and typed confirmations, then writes through the card and the undo button', async () => {
  const host = await mount();
  const before = host.store.getSnapshot();
  const count = host.rows().length;
  const card = await host.preview();
  host.send('메뉴 몇 개 등록돼 있어?');
  expect(screen.getByRole('region', { name: cardTitle })).toBe(card);
  expect(card).toHaveAttribute('data-agent-active', 'true');
  host.streams[1].frame('panels', { panels: [] });
  host.streams[1].frame('done', { outcome: 'reply' });
  await flush();
  expect(screen.getByText(`등록된 메뉴는 ${count}개예요`)).toBeInTheDocument();
  const confirm = within(card).getByRole('button', { name: '메뉴 추가하기' });
  for (const [index, text] of ['응', 'ㅇㅇ', '추가해'].entries()) {
    host.send(text);
    await flush();
    expect(host.store.getSnapshot()).toBe(before);
    expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByText('카드에서 확인해 주세요')).toHaveLength(index + 1);
  }
  confirm.focus();
  await userEvent.keyboard('{Enter}');
  fireEvent.click(confirm);
  expect(host.created()?.price).toBe(5500);
  const applied = host.store.getSnapshot();
  expect(applied.revision).toBe(before.revision + 1);
  host.send('되돌리기');
  await flush();
  expect(host.store.getSnapshot()).toBe(applied);
  expect(screen.getByText('알림에서 되돌리기를 눌러 주세요')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(host.created()).toBeUndefined();
  expect(host.requests).toHaveLength(2);
});

it('replaces a price by text, re-proposes after a stale confirm, and accepts typed cancellation', async () => {
  const host = await mount();
  const card = await host.preview();
  const before = host.store.getSnapshot();
  const count = host.rows().length;
  host.send('5,000원으로');
  await flush();
  expect(within(card).getByText('5,000원')).toBeInTheDocument();
  expect(host.store.getSnapshot()).toBe(before);
  act(() => { host.store.dispatch({ type: 'menu.create', name: '동시 추가', category: 'drink', price: 3000, idempotencyKey: 'n02-stale' }); });
  fireEvent.click(within(card).getByRole('button', { name: '메뉴 추가하기' }));
  expect(within(card).getByText('데이터가 바뀌었어요. 변경 내용을 다시 확인해 주세요')).toBeInTheDocument();
  expect(within(card).getByText(`${count + 1} → ${count + 2}`)).toBeInTheDocument();
  expect(host.created()).toBeUndefined();
  host.send('아니');
  await flush();
  expect(within(screen.getByRole('region', { name: cardTitle })).getByText('변경을 취소했어요')).toBeInTheDocument();
  expect(host.created()).toBeUndefined();
});
