// @vitest-environment node
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore, selectCustomCalendar, selectCustomOrderRead, selectCustomOrders } from '../../../data/widget-data';
import { getRegistry } from '../../../catalog';
import { beginDashboard } from '../../../app/test-session';
import { screenPresets } from '../../../layout';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { classifyNavigation, createNavisNavigation, prepareNavigationRequest } from '../../../screens/dashboard/navis-navigation';
import { applyAgentRunUndo } from '../agent-actions';
import { createAssistantProvider } from '../provider';
import { customDomain, customReceiptPrefill } from './custom';
import { projectAgentWidget } from '../snapshot';
import { createLegacyCustomOrderSeed } from '../../../data/iteration7/custom-orders/seed';
import { applyCustomMoney } from '../../../data/pos/projection';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest, type AgentRequest } from '../../../../shared/navis-agent-schema.mjs';
// @ts-expect-error The shared corpus loader is JavaScript.
import { evidence, readTrace } from '../../../../server/navis/scenario-fixtures.mjs';
// @ts-expect-error The in-process bridge is JavaScript.
import { createBridge } from '../../../../server/bridge.mjs';
// @ts-expect-error The native v3 fixture is JavaScript.
import { createNavisMenuHarness, navisAgentFakeFetch } from '../../../../server/fixtures/navis-eval-fake.mjs';

type Kind = 'answer' | 'clarify' | 'proposal' | 'refuse' | 'navigate' | 'multi';
interface CorpusRow {
  readonly id: string;
  readonly utterances: readonly string[];
  readonly expected: { readonly kind: Kind; readonly undo: string; readonly ask?: readonly string[]; readonly answer_must_contain?: readonly string[]; readonly tools: readonly { readonly name: string; readonly args?: Record<string, unknown> }[] };
}
interface TraceRow { readonly scenario_id: string; readonly slice_id: string; readonly required_slices: string }
const trace: TraceRow[] = readTrace();
const corpus = new Map((JSON.parse(evidence('MERGED.json')) as CorpusRow[]).map(row => [row.id, row]));
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json')) as Record<string, {
  readonly expected?: Partial<CorpusRow['expected']>;
  readonly variants?: Record<number, { readonly expected: Partial<CorpusRow['expected']> }>;
  readonly n13Cafe?: boolean;
}>;

// D-326 Q5 supersedes the overlay's widget-only pickup: a fully paid order is a card with a receipt undo.
const decided: Record<string, Partial<CorpusRow['expected']>> = {
  'S1-111': { kind: 'proposal', ask: [], answer_must_contain: [], undo: '되돌리기 restores the previous state.',
    tools: [{ name: 'propose_action', args: { command: 'customOrder.receive' } }] },
};
const scenarios = trace.filter(row => row.slice_id === 'N13').map(({ scenario_id }) => {
  const row = corpus.get(scenario_id)!;
  return { ...row, expected: { ...row.expected, ...overlay[scenario_id]?.expected, ...decided[scenario_id] } };
});

function fixtureStore(id: string, runId: string) {
  if (overlay[id]?.n13Cafe) return createWidgetDataStore(undefined, { runId });
  const seed = createLegacyCustomOrderSeed();
  // Apply the authored preconditions as explicit rows on the current café business clock.
  const shift = (stamp: string) => stamp.replace('2026-10-26', '2026-11-17').replace('2026-10-27', '2026-11-18');
  const templates = seed.tables.customTemplate.map(template => id === 'S1-122' && template.templateId === 'CT-CAKE'
    ? { ...template, templateId: 'fixture-cake-template' } : template);
  const orders = seed.tables.customOrder.map(order => {
    const templateSnapshot = templates.find(template => template.name === order.templateSnapshot.name)!;
    return { ...order, templateId: templateSnapshot.templateId, templateSnapshot,
      desiredPickupAt: shift(order.desiredPickupAt), proposedPickupAt: order.proposedPickupAt && shift(order.proposedPickupAt),
      productionAt: order.productionAt && shift(order.productionAt),
      history: order.history.map(entry => ({ ...entry, at: shift(entry.at) })) };
  });
  const live = createWidgetDataStore().getSnapshot();
  const store = createWidgetDataStore({
    customOrder: orders, customTemplate: templates,
    reservation: [...live.tables.reservation.filter(row => row.kind === 'visit'), ...seed.tables.reservation.filter(row => row.kind === 'pickup').map(row => ({
      ...row, date: shift(row.date), updatedAt: shift(row.updatedAt),
    }))],
  // The canonical POS ledger carries the paid input, as the real dashboard does.
  }, { runId, pos: applyCustomMoney(live.pos!, { ...seed.money, settlements: seed.money.settlements.map(row => ({ ...row, at: shift(row.at) })),
    payments: seed.money.payments.map(row => ({ ...row, at: shift(row.at) })) }) });
  const dispatch = (command: Parameters<typeof store.dispatch>[0]) => {
    const result = store.dispatch(command);
    if (!result.ok) throw Error(`${id} fixture ${command.type}: ${result.messageKey}`);
    return result;
  };
  dispatch({
    type: 'members.update', memberId: 'M-0001', name: '김도현', phone: '01055552481',
  });
  if (['S1-104', 'S1-107', 'S1-110', 'S1-119'].includes(id)) dispatch({
    type: 'customOrder.recordDecision', customOrderId: 'CO-002', quoteRevision: 1, decision: 'approved',
    paymentTiming: id === 'S1-110' ? 'advance' : 'on_pickup', idempotencyKey: 'fixture-decision',
  });
  if (id === 'S1-113') dispatch({ type: 'customOrder.receive', customOrderId: 'CO-001', idempotencyKey: 'fixture-receive' });
  return store;
}

async function runUtterance(id: string, text: string) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const data = fixtureStore(id, run.getState().runId);
  const before = data.getSnapshot();
  const requests: AgentRequest[] = [];
  const calls: string[] = [];
  const bridge = createNavisMenuHarness((options: Parameters<typeof createBridge>[0]) =>
    createBridge({ ...options, agentMode: 'fixture', onDiagnostics() {} }), validateAgentFrame, navisAgentFakeFetch);
  const provider = createAssistantProvider({ store: data, run, fetcher: async (_url, options) => {
    const request: unknown = JSON.parse(String(options?.body));
    expect(validateAgentRequest(request)).toBe(true);
    if (!validateAgentRequest(request)) return new Response(null, { status: 422 });
    requests.push(request);
    const result = await bridge.run(request);
    calls.push(...result.calls.map((call: { name: string }) => call.name));
    return new Response(result.raw, { status: result.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
  } });
  const ask = (text: string) => provider.ask({ text, locale: 'ko', layer: 'management', signal: new AbortController().signal });
  try {
    const navigation = createNavisNavigation(run, { highlight() {}, closeChat() {} });
    const plan = classifyNavigation(text, run.getState(), before);
    const prepared = plan && prepareNavigationRequest(plan, run.getState(), navigation);
    let detail: Record<string, unknown> | undefined;
    const reply = prepared ? await provider.ask({ text, locale: 'ko', layer: 'management', signal: new AbortController().signal,
      agentTurn: prepared.agentTurn, onNavigation: action => { detail = prepared.resolve(action); } }) : await ask(text);
    expect(data.getSnapshot()).toBe(before);
    if (detail && plan?.command === 'ui.openDetail') expect(await navigation.execute(plan.command, detail)).toBe('opened');
    const screen = run.getState().overlay;
    const detailRef = screen.type === 'detail' ? screen.stack?.at(-1) : undefined;
    const actual: Kind = detailRef ? 'navigate' : reply.turn?.kind === 'proposal' ? 'proposal'
      : reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? 'clarify'
        : reply.turn?.kind === 'refusal' || reply.turn?.kind === 'handoff' ? 'refuse' : 'answer';
    return { actual, reply, detailRef, requests, calls, before, store: data, plan: plan?.command, navigation, run };
  } finally {
    bridge.close();
  }
}


describe('N13 café custom-order corpus', () => {
  it('accounts for every authored scenario and utterance', () => {
    expect(scenarios).toHaveLength(52);
    expect(scenarios.flatMap(row => row.utterances)).toHaveLength(156);
    expect(trace.filter(row => row.required_slices.split('|').includes('N13'))).toHaveLength(54);
  });

  it.each(scenarios)('$id checks the authored outcome across utterances', async row => {
    for (const [index, input] of row.utterances.entries()) {
      const { actual, reply, calls, before, store, detailRef, requests, plan, run } = await runUtterance(row.id, input);
      const override = overlay[row.id]?.variants?.[index + 1]?.expected;
      const reviewed = { ...row.expected, ...override, ...decided[row.id] };
      const expected = reviewed.kind;
      if (process.env.N13_OBSERVATIONS) appendFileSync(process.env.N13_OBSERVATIONS, JSON.stringify({
        id: row.id, input, actual, expected, answer: reply.answer, calls, plan,
        turn: reply.turn?.kind === 'refusal' ? reply.turn.reason : reply.turn && 'field' in reply.turn ? reply.turn.field : reply.turn?.kind,
        intent: requests.at(-1)?.intent,
      }) + '\n');
      expect.soft(actual, input).toBe(expected);
      expect(store.getSnapshot()).toBe(before);
      if (row.id === 'S1-083') {
        expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'answers', choices: [
          { id: 'one', label: '기본' }, { id: 'large', label: '크게' },
        ] });
        expect(reply.answer).toContain('크게(+5,000원)');
        expect(calls).toEqual([]);
      }
      if (overlay[row.id]?.expected?.ask && expected === 'clarify') {
        expect(reply.turn?.kind === 'clarification' && reply.turn.field, input).toBe(reviewed.ask?.[0]);
      }
      if (reviewed.tools[0]?.name === 'get_widget') {
        expect(calls.some(call => call === 'get_widget' || call === 'search_records'), input).toBe(true);
      }
      for (const part of reviewed.answer_must_contain ?? []) expect.soft(reply.answer, input).toContain(part);
      if (expected === 'navigate') {
        expect(detailRef?.featureId).toBe('custom-order');
        const target = row.expected.tools.find(tool => tool.name === 'open_detail')?.args;
        expect(detailRef?.view).toBe(target?.view);
        expect(detailRef?.itemId).toBe(target?.itemId);
      }
      if (reply.turn?.kind !== 'proposal') continue;
      const { proposal } = reply.turn;
      expect(proposal.command).toBe(row.expected.tools.find(tool => tool.name === 'propose_action')?.args?.command);
      expect(calls).toContain('propose_action');
      if (proposal.tier === 'extra-confirm') {
        expect(proposal.confirm(store).requiresExtraConfirmation).toBe(true);
        expect(store.getSnapshot()).toBe(before);
      }
      const receipt = proposal.confirm(store, proposal.id);
      expect(receipt.frame.outcome).toBe('applied');
      expect(proposal.confirm(store, proposal.id).frame).toEqual(receipt.frame);
      const applied = store.getSnapshot();
      expect(applied.revision).toBe(before.revision + 1);
      if (index === 0) {
        const read = selectCustomOrderRead(applied);
        const { orders, templates } = selectCustomOrders(read);
        const cookie = orders.find(order => order.customOrderId === 'CO-002');
        if (row.id === 'S1-081') {
          expect(orders.find(order => order.customOrderId === 'CO-003')).toMatchObject({
            stage: 'received', productLabel: '레터링 생크림 케이크 2호', quantity: 1,
            channel: 'phone', guest: { name: '박서연', phone: '01023456789' }, desiredPickupAt: '2026-11-18T15:00', pickup: null,
          });
        }
        if (row.id === 'S1-094') {
          expect(cookie).toMatchObject({ quoteAmount: 65000, quoteRevision: 2, customerDecision: 'pending' });
        }
        if (row.id === 'S1-099') {
          expect(cookie).toMatchObject({ stage: 'in_production', approvedQuoteRevision: 1, paymentTiming: 'on_pickup' });
          expect(selectCustomCalendar(read)).toEqual(expect.arrayContaining([
            expect.objectContaining({ reservationId: 'PICKUP-CO-002', date: '2026-11-18', time: '14:00', source: 'pickup' }),
          ]));
        }
        if (row.id === 'S1-119') {
          expect(cookie).toMatchObject({ stage: 'canceled', pickup: { status: 'canceled', reservationId: 'PICKUP-CO-002' } });
          expect(selectCustomCalendar(read).some(event => event.reservationId === 'PICKUP-CO-002')).toBe(false);
          expect(read.tables.reservation.filter(row => row.kind === 'visit')).toEqual(selectCustomOrderRead(before).tables.reservation.filter(row => row.kind === 'visit'));
        }
        if (row.id === 'S1-124') {
          expect(templates.some(template => template.templateId === 'CT-GIFT')).toBe(false);
          expect(cookie?.templateSnapshot.templateId).toBe('CT-GIFT');
        }
      }
      if (reviewed.undo.startsWith('되돌리기')) {
        expect(receipt.notice?.undo?.target).toBe('run');
        expect(receipt.undoToken).toBe(receipt.notice?.undo?.token);
        if (!receipt.notice?.undo) throw Error('Missing receipt undo');
        run.actions.showNotice(receipt.notice);
        expect(applyAgentRunUndo(run, store, receipt.notice.undo.token)).toBe(true);
        expect(applyAgentRunUndo(run, store, receipt.notice.undo.token)).toBe(false);
        expect(selectCustomOrders(selectCustomOrderRead(store.getSnapshot()))).toEqual(selectCustomOrders(selectCustomOrderRead(before)));
      } else expect(receipt.undoToken).toBeUndefined();
    }
  });

  it('grounds each pickup date in confirmed café reservations', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    const read = projectAgentWidget(snapshot, 'custom-order', { kind: 'default' }, 'ko');
    expect(read.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'pickup.today.count', value: 0, date: '2026-11-17' }),
      expect.objectContaining({ key: 'pickup.tomorrow.count', value: 1, date: '2026-11-18' }),
      expect.objectContaining({ key: 'pickup.next', value: '2026-11-18T10:30', date: '2026-11-18' }),
    ]));
  });
});


it('D-326 Q5 marks a fully paid pickup complete only by card and restores it from the receipt', async () => {
  const { reply, store, before, run } = await runUtterance('S1-111', 'CO-001 수령 완료 처리해줘');
  if (reply.turn?.kind !== 'proposal') throw Error(reply.answer);
  const { proposal } = reply.turn;
  expect(proposal.command).toBe('customOrder.receive');
  // Typed text never commits: nothing changed until the card is pressed.
  expect(store.getSnapshot()).toBe(before);
  const receipt = proposal.confirm(store, proposal.id);
  expect(receipt.frame.outcome).toBe('applied');
  expect(proposal.confirm(store, proposal.id).frame).toEqual(receipt.frame);
  expect(selectCustomOrders(selectCustomOrderRead(store.getSnapshot())).orders.find(order => order.customOrderId === 'CO-001')?.stage).toBe('received_by_customer');
  if (!receipt.notice?.undo) throw Error('Missing receipt undo');
  run.actions.showNotice(receipt.notice);
  expect(applyAgentRunUndo(run, store, receipt.notice.undo.token)).toBe(true);
  expect(selectCustomOrders(selectCustomOrderRead(store.getSnapshot()))).toEqual(selectCustomOrders(selectCustomOrderRead(before)));
});

it('D-326 Q5 keeps pay-at-pickup, refunds and cancel-with-refund in their own screens', async () => {
  // A pay-at-pickup order that is ready but unpaid goes to the payment screen, not a pickup card.
  const unpaid = fixtureStore('S1-119', 'd326-unpaid');
  expect(unpaid.dispatch({ type: 'customOrder.setStage', customOrderId: 'CO-002', nextStage: 'production_complete', idempotencyKey: 'd326-stage' }).ok).toBe(true);
  const turn = customDomain.route?.('CO-002 수령 완료 처리해줘', unpaid.getSnapshot(), 'ko');
  expect(turn).toMatchObject({ kind: 'refusal', reason: 'widget_only', alternative: {
    featureId: 'custom-order', command: 'customOrder.openPayment', draft: { customOrderId: 'CO-002' },
  } });
  expect(customDomain.handoff?.('customOrder.openPayment', { customOrderId: 'CO-002' })).toMatchObject({ view: 'payment', itemId: 'CO-002' });
  const refund = await runUtterance('S1-115', 'CO-001 주문 취소해줘 환불도');
  const refusal = refund.reply.turn;
  expect(refusal).toMatchObject({ kind: 'refusal', reason: 'widget_only', alternative: {
    featureId: 'custom-order', command: 'customOrder.openRefund', draft: { customOrderId: 'CO-001' },
  } });
  if (refusal?.kind !== 'refusal' || !refusal.alternative) throw Error('Missing scoped widget handoff');
  expect(await refund.navigation.handoff(refusal.alternative)).toBe('opened');
  expect(refund.run.getState().overlay).toMatchObject({ stack: [{ featureId: 'custom-order', itemId: 'CO-001', view: 'refund', focus: 'action' }] });
  expect(refund.store.getSnapshot()).toBe(refund.before);
});

it('opens the existing receipt form with typed prefill and leaves the order table untouched', async () => {
  const { actual, detailRef, store, before } = await runUtterance('S1-079', '레터링 케이크 2호 1개 주문 접수하는 화면 열어줘');
  expect(actual).toBe('navigate');
  expect(detailRef && customReceiptPrefill(detailRef)).toEqual({ productLabel: '레터링 케이크 2호', quantity: 1 });
  expect(detailRef && customReceiptPrefill({ ...detailRef, view: 'templates' })).toBeUndefined();
  expect(store.getSnapshot()).toBe(before);
});

it('keeps a new guest separate when a member shares the name but has a different phone', async () => {
  const { reply, requests, store } = await runUtterance('S1-081',
    "케이크 주문 접수해줘. 김도현 손님 010-2345-6789, 레터링 생크림 케이크 2호 1개, 문구 '생일 축하해요', 크기 기본, 전화로 받았고 내일 오후 3시 픽업");
  expect(JSON.stringify(requests)).not.toMatch(/김도현|2345.?6789/u);
  if (reply.turn?.kind !== 'proposal') throw Error(reply.answer);
  expect(reply.turn.proposal.confirm(store).frame.outcome).toBe('applied');
  expect(selectCustomOrders(selectCustomOrderRead(store.getSnapshot())).orders.at(-1)).toMatchObject({
    memberId: null, guest: { name: '김도현', phone: '01023456789' },
  });
});

it('keeps the selected order and pickup date when the owner corrects only the requested time', () => {
  const store = fixtureStore('S1-117', 'pickup-time');
  const before = store.getSnapshot();
  const turn = customDomain.route?.('CO-001 픽업 5시 45분으로 바꿔줘', before, 'ko');
  if (!turn || !('kind' in turn) || turn.kind !== 'clarification') throw Error('Expected a time question');
  expect(turn.field).toBe('time');
  expect(turn.resume?.('오후 6시')).toMatchObject({
    intent: { command: 'pickup.reschedule' }, slots: { date: '2026-11-17', time: '18:00' },
  });
  expect(store.getSnapshot()).toBe(before);
});

it('keeps the entered quote amount and date when the owner corrects a non-half-hour time', () => {
  const store = fixtureStore('S1-097', 'quote-time');
  const before = store.getSnapshot();
  const turn = customDomain.route?.('CO-002 견적 65,000원 내일 오후 2시 15분 픽업으로 해줘', before, 'ko');
  if (!turn || !('kind' in turn) || turn.kind !== 'clarification') throw Error('Expected a time question');
  expect(turn.field).toBe('time');
  expect(turn.resume?.('2시 반')).toMatchObject({
    intent: { command: 'customOrder.quote' }, slots: { quoteAmount: 65000, proposedPickupAt: '2026-11-18T14:30' },
  });
  expect(store.getSnapshot()).toBe(before);
});

it('asks for a single order before starting a refund handoff', () => {
  const store = fixtureStore('S1-115', 'refund-target');
  const before = store.getSnapshot();
  const turn = customDomain.route?.('CO-001하고 CO-002 주문 환불해줘', before, 'ko');
  if (!turn || !('kind' in turn) || turn.kind !== 'clarification') throw Error('Expected a target question');
  expect(turn.field).toBe('name');
  expect(turn.resume?.('CO-001')).toMatchObject({ kind: 'refusal', reason: 'widget_only', alternative: {
    command: 'customOrder.openRefund', draft: { customOrderId: 'CO-001' },
  } });
  expect(store.getSnapshot()).toBe(before);
});

it('asks which order to cancel when the owner names two customers', () => {
  const store = fixtureStore('S1-114', 'multiple-customers');
  const before = store.getSnapshot();
  const turn = customDomain.route?.('김도현이랑 한○○ 주문 둘 다 취소해줘', before, 'ko');
  if (!turn || !('kind' in turn) || turn.kind !== 'clarification') throw Error('Expected a target question');
  expect(turn.field).toBe('name');
  expect(turn.resume?.('CO-003')).toBeUndefined();
  expect(turn.resume?.('CO-002')).toMatchObject({
    intent: { command: 'customOrder.cancel' }, slots: { name: 'CO-002' },
  });
  expect(store.getSnapshot()).toBe(before);
});

it('recognizes a single masked customer followed by a Korean particle', () => {
  const snapshot = fixtureStore('S1-114', 'masked-customer').getSnapshot();
  expect(customDomain.routePresentation?.('한○○도 주문 취소해줘', snapshot, 'ko')).toMatchObject({
    intent: { command: 'customOrder.cancel' }, slots: { name: 'CO-002' },
  });
});

it('asks for the guest name when only the channel precedes the entered contact', () => {
  const store = fixtureStore('S1-083', 'missing-guest-name');
  const before = store.getSnapshot();
  const turn = customDomain.route?.("레터링 케이크 1호 한 개 기본 문구 '축하해요' 내일 오후 3시 픽업 전화 010-2345-6789 주문 접수", before, 'ko');
  if (!turn || !('kind' in turn) || turn.kind !== 'clarification') throw Error('Expected a guest name question');
  expect(turn.field).toBe('guestName');
  expect(turn.resume?.('박서연')).toMatchObject({
    intent: { command: 'customOrder.create' }, slots: { guestName: '박서연', phone: '01023456789' },
  });
  expect(store.getSnapshot()).toBe(before);
});

it('does not arrange a different customer’s confirmed pickup when the named order and product disagree', () => {
  const store = fixtureStore('S1-116', 'pickup-owner');
  const before = store.getSnapshot();
  expect(customDomain.route?.('한○○ 케이크 픽업 6시로 미뤄줘', before, 'ko')).toMatchObject({
    kind: 'refusal', reason: 'invalid_target',
  });
  expect(store.getSnapshot()).toBe(before);
});

it('explains the approval and confirmed-pickup requirements without proposing a write', () => {
  const snapshot = fixtureStore('S1-106', 'approval-needed').getSnapshot();
  expect(customDomain.route?.('CO-002 제작 시작해줘', snapshot, 'ko')).toMatchObject({
    kind: 'refusal', answer: '손님 승인을 먼저 기록해 주세요.',
  });
  expect(customDomain.route?.('CO-002 픽업 내일 3시로 바꿔줘', snapshot, 'ko')).toMatchObject({
    kind: 'refusal', answer: '확정된 픽업이 없어요. 희망 픽업이나 견적을 바꿀 수 있어요.',
  });
});

it('keeps words about canceling a pickup inside the quoted order note', () => {
  const snapshot = fixtureStore('S1-090', 'quoted-order-note').getSnapshot();
  expect(customDomain.route?.("CO-001 요청사항에 '픽업 취소 후 다시 전화' 적어줘", snapshot, 'ko')).toMatchObject({
    intent: { command: 'customOrder.update' }, slots: { request: '픽업 취소 후 다시 전화' },
  });
});
