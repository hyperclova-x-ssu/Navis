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
import { controlledResponse } from '../../features/assistant/stream-fixture';
import { widgets as menuWidgets } from '../../features/widgets/mgmt-products';
import { screenPresets } from '../../layout';
import { createRunStore, selectCommonNotice, selectCommonNoticePresentation } from '../../state';
import { timePolicy } from '../../ui';
import { KitProviders } from '../../ui/test-utils';
import { DashboardScreen } from './DashboardScreen';

const menuName = '검은콩 라테';
const question = `${menuName} 메뉴에 넣어줘`;
const answer = '확인하면 메뉴에 추가할 수 있어요.';
const priceQuestion = '판매가는 얼마인가요?';
const cardTitle = /메뉴 추가$/u;
const flush = () => act(async () => {});

function bridgeStream() {
  const stream = controlledResponse({ [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL });
  return {
    response: stream.response,
    frame<K extends keyof AgentFrameData>(event: K, data: AgentFrameData[K]) { stream.frame(event, data); },
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
  let now = 0;
  const run = createRunStore({ screenPreset: preset, catalog: getRegistry('A'), time: timePolicy, clock: () => now, theme: 'light', reducedMotion });
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
  const input = screen.getByRole('textbox', { name: '질문하거나 요청해 주세요' });
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
  const advance = (ms: number) => act(() => { now += ms; run.actions.tick(); });
  return { run, store, streams, requests, send, rows, created, view, widgetCount, commits, sendProposal, preview, advance };
}

it('asks for a price, atomically reveals the proposal, and updates the menu widget through confirm and undo', async () => {
  const host = await mount(false);
  const count = host.rows().length;
  expect(host.widgetCount()).toHaveTextContent(String(count));
  host.send(question);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 330)); });
  host.streams[0].frame('status', { step: 'target_checked' });
  host.streams[0].frame('panels', { panels: [] });
  await flush();
  expect(screen.getByText('변경 내용을 확인하고 있어요', { selector: 'p' }).closest('[role="status"]')).toBeNull();
  expect(document.querySelector('[aria-live="polite"].ai-conversation__announcer')).toHaveTextContent('변경 내용을 확인하고 있어요');
  expect(screen.queryByText(priceQuestion)).toBeNull();

  host.streams[0].frame('done', { outcome: 'clarify', clarification: AGENT_PRICE_CLARIFICATION });
  await flush();
  expect(screen.getAllByText(priceQuestion)).toHaveLength(1);
  const choices = within(screen.getByRole('group', { name: priceQuestion }));
  expect(choices.getAllByRole('button').map(button => button.textContent)).toEqual(['4,500원', '5,000원', '5,500원', '직접 입력하기']);
  fireEvent.click(choices.getByRole('button', { name: '5,500원' }));
  expect(host.requests.map(request => request.slots)).toEqual([['name'], ['name', 'price']]);
  expect(JSON.stringify(host.requests)).not.toContain(menuName);
  // C-14 / M-16: the pick is kept as the owner's own bubble, and only the picked chip stays marked.
  expect([...host.view.container.querySelectorAll('[data-role="user"] .ai-conversation__answer')].map(node => node.textContent)).toEqual([question, '5,500원']);
  expect(choices.getAllByRole('button').map(button => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
    ['4,500원', 'false'], ['5,000원', 'false'], ['5,500원', 'true'], ['직접 입력하기', 'false'],
  ]);
  expect(choices.getAllByRole('button').every(button => button.getAttribute('aria-disabled') === 'true')).toBe(true);

  host.commits.length = 0;
  const stream = host.sendProposal(1);
  await flush();
  expect(document.querySelector('.ai-wait')).toBeNull();
  expect(screen.queryByText(answer)).toBeNull();
  expect(screen.queryByRole('region', { name: cardTitle })).toBeNull();
  stream.frame('done', { outcome: 'proposal' });
  await flush();

  const card = screen.getByRole('region', { name: cardTitle });
  const reveal = card.closest('.ai-conversation__reveal');
  expect(reveal).toHaveAttribute('data-fade', 'true');
  expect(card).toHaveAccessibleName(`${menuName} 메뉴 추가`);
  expect(reveal?.querySelector('.ai-conversation__answer')).toBeNull();
  expect(host.commits.find(commit => commit.answer || commit.proposal)).toEqual({ answer: false, proposal: true, waiting: false });
  expect(within(card).getByText('추가 전')).toHaveTextContent('추가 전 없음');
  expect(within(card).getByText('추가 후')).toBeInTheDocument();
  expect(Array.from(card.querySelectorAll('dl > div'), row => Array.from(row.children, cell => cell.textContent))).toEqual([
    ['메뉴 이름', menuName], ['판매가', '5,500원'], ['메뉴 수', `전 ${count} → 후 ${count + 1}`], ['분류', '음료'], ['메모', '없음'],
    ['판매 상태', '판매 중'], ['준비 시간', '3분'], ['판매 수', '0'], ['원가', '없음'],
    ['등록 재료', '없음'], ['옵션 그룹', '없음'], ['사진', '없음'],
  ]);
  expect(host.created()).toBeUndefined();

  const confirm = within(card).getByRole('button', { name: '메뉴 추가하기' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(host.created()).toMatchObject({ name: { raw: menuName }, category: 'beverage', price: 5500 });
  expect(host.widgetCount()).toHaveTextContent(String(count + 1));
  expect(selectCommonNotice(host.run.getState())).toMatchObject({ messageKey: 'data.management.notice.saved', undo: { target: 'data' } });
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(host.created()).toBeUndefined();
  expect(host.widgetCount()).toHaveTextContent(String(count));
  fireEvent.click(confirm);
  expect(host.created()).toBeUndefined();
});

it('names the widget hand-off button and ends it with the open arrow glyph (M-17)', async () => {
  const host = await mount();
  // An outbound draft is refused locally (no model call) and points at the widget that owns it.
  host.send('단골한테 "이번 주 휴무" 문자 보내줘');
  await flush();
  const reveal = document.querySelector('[data-role="assistant"] .ai-conversation__reveal') as HTMLElement;
  const open = within(reveal).getByRole('button', { name: /열기$/u });
  const glyph = open.querySelector('svg.ai-glyph');
  expect(glyph).not.toBeNull();
  expect(glyph).toHaveAttribute('aria-hidden', 'true');
  // The glyph is decoration: the accessible name stays the visible text, and the arrow comes after it.
  expect(open).toHaveAccessibleName(open.textContent!);
  expect(open.querySelector('.ui-press-surface')!.lastElementChild).toBe(glyph);
});

it('shows the second step of an ordered plan as its own message only after the first card has a receipt (B23)', async () => {
  const host = await mount();
  host.send('아메리카노 품절 처리하고 카페라테 가격 5,500원으로 올려줘');
  await flush();
  expect(host.requests).toHaveLength(1);
  const respond = async (index: number, proposalId: string) => {
    const request = host.requests[index];
    if (request.intent.kind !== 'command' || request.intent.command !== 'menu.setSaleStatus' && request.intent.command !== 'menu.update') throw new Error('Expected a menu write');
    const stream = host.streams[index];
    stream.frame('status', { step: 'assembling' });
    stream.frame('panels', { panels: [] });
    stream.frame('action_proposal', { command: request.intent.command, args: request.intent.args ?? {}, snapshotRevision: request.snapshotRevision,
      proposalId, runId: request.runId, layer: request.layer, page: request.page, tier: 'normal' } as AgentFrameData['action_proposal']);
    stream.frame('done', { outcome: 'proposal' });
    await flush();
  };
  const press = () => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-agent-active="true"] [data-navis-pending-action-row="true"]')];
    fireEvent.click(rows.at(-1)!.querySelector('button')!);
  };
  await respond(0, 'wire-1');
  expect(document.querySelector('[data-role="assistant"]')).toHaveTextContent('1/2');
  const before = host.store.getSnapshot();
  await flush();
  expect(host.requests).toHaveLength(1);
  expect(host.store.getSnapshot()).toBe(before);

  press();
  await flush();
  expect(host.requests).toHaveLength(2);
  expect(host.requests[1].snapshotRevision).toBe(host.store.getSnapshot().revision);
  expect(host.requests[1].intent).toMatchObject({ kind: 'command', command: 'menu.update' });
  await respond(1, 'wire-2');
  const assistant = [...document.querySelectorAll('[data-role="assistant"]')];
  expect(assistant).toHaveLength(2);
  expect(assistant[1]).toHaveTextContent('2/2');
  expect(host.requests).toHaveLength(2);
});

it('cancels a proposal under reduced motion without a data write or undo', async () => {
  const host = await mount();
  const before = host.store.getSnapshot();
  const card = await host.preview();
  expect(card.closest('.ai-conversation__reveal')).toHaveAttribute('data-fade', 'true');
  expect(card.closest('.ai-conversation')).toHaveAttribute('data-motion', 'reduced');
  const confirm = within(card).getByRole('button', { name: '메뉴 추가하기' });
  fireEvent.click(within(card).getByRole('button', { name: '변경 취소하기' }));
  expect(screen.getByText('변경을 취소했어요')).toBeInTheDocument();
  expect(card).not.toBeInTheDocument();
  fireEvent.click(confirm);
  expect(host.store.getSnapshot()).toBe(before);
  expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
});

async function previewRunChange(host: Awaited<ReturnType<typeof mount>>, text: string, command: 'layout.add_widget' | 'settings.set_text_scale') {
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
}

async function confirmTextScale(host: Awaited<ReturnType<typeof mount>>) {
  await previewRunChange(host, '큰 글자로 해줘', 'settings.set_text_scale');
  fireEvent.click(screen.getByRole('button', { name: '글자 크기 바꾸기' }));
}

it('shows one undo on the open board for a cross-board layout change', async () => {
  const host = await mount();
  const { management, marketing } = host.run.getState().boards;
  await previewRunChange(host, '마케팅 보드에 진행 중인 쿠폰 위젯 추가해줘', 'layout.add_widget');
  const confirm = screen.getByRole('button', { name: '패널 놓기' });
  expect(host.run.getState().boards.marketing).toBe(marketing);
  fireEvent.click(confirm);
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

it('expires the matching layout Undo without reviving its native toast (C-10)', async () => {
  const host = await mount();
  await previewRunChange(host, '세무관리 위젯 추가해줘', 'layout.add_widget');
  fireEvent.click(screen.getByRole('button', { name: '패널 놓기' }));
  expect(host.run.getState().panels.some(panel => panel.featureId === 'tax')).toBe(true);
  expect(screen.getByRole('button', { name: '되돌리기' })).toBeInTheDocument();
  host.advance(timePolicy.undoMs + 1);
  expect(screen.getByText('변경을 적용했어요')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '되돌리기' })).toBeNull();
  expect(host.run.getState().notice?.undoToken).toBeUndefined();
  expect(host.run.getState().boards.management.undo).toBeNull();
});

it('shows a failed Undo on the applied receipt and retains its authority during a busy attempt (AC-1576)', async () => {
  const host = await mount();
  await confirmTextScale(host);
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
  expect(screen.getByText('되돌리지 못했어요').closest('[data-receipt-status]')).toHaveAttribute('data-receipt-status', 'applied');
  expect(screen.queryByText('되돌렸어요')).toBeNull();
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
  expect(within(card).getByText((_, element) => element?.classList.contains('navis-change') === true && element.textContent === `전 ${count + 1} → 후 ${count + 2}`)).toBeInTheDocument();
  expect(host.created()).toBeUndefined();
  fireEvent.click(within(card).getByRole('button', { name: '메뉴 추가하기' }));
  expect(host.created()?.price).toBe(5500);
});

it('discards a pending proposal when Navis closes, even if its history is reopened', async () => {
  const host = await mount();
  await host.preview();
  fireEvent.click(screen.getByRole('button', { name: 'Navis 닫기' }));
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  expect(screen.queryByRole('button', { name: '메뉴 추가하기' })).toBeNull();
  expect(screen.getByText('창을 닫아서 취소했어요')).toBeInTheDocument();
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
  // The count is its own bold figure (M-05); the sentence is still whole.
  expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === `등록된 메뉴는 ${count}개예요`)).toBeInTheDocument();
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
  expect(screen.getByText('영수증의 되돌리기를 눌러 주세요')).toBeInTheDocument();
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
  expect(within(card).getByText((_, element) => element?.classList.contains('navis-change') === true && element.textContent === `전 ${count + 1} → 후 ${count + 2}`)).toBeInTheDocument();
  expect(host.created()).toBeUndefined();
  host.send('아니');
  await flush();
  expect(screen.getByText('변경을 취소했어요')).toBeInTheDocument();
  expect(host.created()).toBeUndefined();
});

it('gives IME and the open editor priority over stopping a read', async () => {
  const host = await mount();
  const card = await host.preview();
  fireEvent.click(within(card).getByRole('button', { name: '변경 내용 고치기' }));
  const editor = card.querySelector('form')!;
  const field = within(editor).getAllByRole('textbox')[0];
  host.send('메뉴 몇 개 등록돼 있어?');
  await flush();
  fireEvent.keyDown(field, { key: 'Escape', isComposing: true });
  expect(editor).toBeInTheDocument();
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(editor).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '답 멈추기' })).toBeInTheDocument();
  expect(host.created()).toBeUndefined();
});

it('returns from a destructive second step without writing or stopping the active read', async () => {
  const host = await mount();
  host.send('메뉴 위젯 빼줘');
  await flush();
  const { intent, snapshotRevision, runId, layer, page } = host.requests[0];
  expect(intent).toMatchObject({ kind: 'command', command: 'layout.remove_widget' });
  const stream = host.streams[0];
  stream.frame('panels', { panels: [] });
  if (intent.kind !== 'command' || !intent.args) throw new Error('Expected a layout command with arguments');
  stream.frame('action_proposal', { command: 'layout.remove_widget', args: intent.args, snapshotRevision,
    proposalId: 'layout-removal', runId, layer, page, tier: 'extra-confirm' });
  stream.frame('done', { outcome: 'proposal' });
  await flush();
  const first = screen.getByRole('button', { name: '삭제 내용 확인하기' });
  fireEvent.click(first);
  const final = screen.getByRole('button', { name: /지우기$/u });
  host.send('메뉴 몇 개 등록돼 있어?');
  await flush();
  fireEvent.keyDown(final, { key: 'Escape' });
  expect(screen.getByRole('button', { name: '삭제 내용 확인하기' })).toHaveFocus();
  expect(screen.getByRole('button', { name: '답 멈추기' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '삭제 내용 확인하기' }));
  expect(screen.getByRole('button', { name: /지우기$/u })).toBeInTheDocument();
  expect(host.run.getState().panels.some(panel => panel.featureId === 'menu')).toBe(true);
});

it('hands a closed receipt to the common toast and marks it undone on reopening', async () => {
  const host = await mount();
  const card = await host.preview();
  fireEvent.click(within(card).getByRole('button', { name: '메뉴 추가하기' }));
  const notice = selectCommonNotice(host.run.getState());
  expect(notice?.undo?.target).toBe('data');
  expect(selectCommonNoticePresentation(host.run.getState())).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Navis 닫기' }));
  expect(selectCommonNoticePresentation(host.run.getState())).toMatchObject({ id: notice?.id, undo: notice?.undo, expiresAt: notice?.expiresAt });
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(host.created()).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  expect(screen.getByText('되돌렸어요', { selector: '.navis-receipt span' })).toBeInTheDocument();
});

it('rechecks a retired proposal from its retry control using the current revision', async () => {
  const host = await mount();
  const card = await host.preview();
  fireEvent.click(screen.getByRole('button', { name: 'Navis 닫기' }));
  act(() => { host.store.dispatch({ type: 'menu.create', name: '재확인 전 추가한 메뉴', category: 'drink', price: 3000, idempotencyKey: 'before-reproposal' }); });
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  expect(card).not.toBeInTheDocument();
  expect(screen.getByText('창을 닫아서 취소했어요')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '다시 제안 받기' }));
  await flush();
  const request = host.requests.at(-1)!;
  expect(request.snapshotRevision).toBe(host.store.getSnapshot().revision);
  expect(request.intent).toMatchObject({ kind: 'menu.create' });
  expect(host.created()).toBeUndefined();
});
