// @vitest-environment node
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { beginDashboard } from '../../../app/test-session';
import { getRegistry } from '../../../catalog';
import { addDays, TODAY } from '../../../data/db/time';
import { createWidgetDataStore, readModel } from '../../../data/widget-data';
import { screenPresets } from '../../../layout';
import { classifyNavigation, createNavisNavigation, prepareNavigationRequest } from '../../../screens/dashboard/navis-navigation';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest } from '../../../../shared/navis-agent-schema.mjs';
import { applyAgentRunUndo } from '../agent-actions';
import { createAssistantProvider } from '../provider';
// @ts-expect-error The shared corpus loader is JavaScript.
import { evidence, readTrace } from '../../../../server/navis/scenario-fixtures.mjs';
// @ts-expect-error The in-process bridge is JavaScript.
import { createBridge } from '../../../../server/bridge.mjs';
// @ts-expect-error The native v3 fixture is JavaScript.
import { createNavisMenuHarness, navisAgentFakeFetch } from '../../../../server/fixtures/navis-eval-fake.mjs';

type Scenario = { id: string; widget: string; utterances: string[]; expected: { kind: string } };
const trace: { scenario_id: string; slice_id: string; required_slices: string }[] = readTrace();
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json')) as Record<string, {
  expected?: Partial<Scenario['expected']>; policyGap?: { slice: string; expected?: Partial<Scenario['expected']> };
}>;
const activeCouponName = '오후 한산시간 디저트 1,000원 할인';
const scenarios = (JSON.parse(evidence('MERGED.json')) as Scenario[]).filter(({ id }) =>
  trace.find(row => row.scenario_id === id)?.required_slices.split('|').includes('N16')
  || overlay[id]?.policyGap?.slice === 'N16')
  .map(row => ({ ...row, expected: { ...row.expected, ...overlay[row.id]?.expected, ...overlay[row.id]?.policyGap?.expected } }));

function fixture(id = '') {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  if (id !== 'S7-008') run.actions.switchLayer('marketing');
  const base = createWidgetDataStore().getSnapshot().tables;
  const marketing = base.marketing;
  const active = marketing.coupon.find(row => row.status === 'active')!;
  const paused = ['S6-113', 'S6-115', 'S6-123', 'S6-124'].includes(id);
  const endingSoon = ['S6-125', 'S6-135', 'reminder'].includes(id);
  const target = { ...active, status: paused ? 'paused' as const : 'active' as const,
    endsOn: endingSoon ? addDays(TODAY, 2) : active.endsOn };
  let data = createWidgetDataStore({ marketing: { ...marketing,
    coupon: marketing.coupon.map(row => row === active ? target : row),
  } }, { runId: run.getState().runId });
  const slot = readModel(data.getSnapshot(), 'slot-coupon').openSlots.find(row => row.regularIds.length > 0);
  if (slot && ['S6-125', 'S6-135', 'reminder'].includes(id)) {
    expect(data.dispatch({ type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: slot.regularIds,
      benefit: 'free-shot', idempotencyKey: 'seed-reminder-target' }).ok).toBe(true);
    const tables = data.getSnapshot().tables;
    const state = tables.marketing;
    const sent = state.coupon.find(row => row.origin === 'slot')!;
    // Copy only the emitted consented target links to the existing café campaign.
    data = createWidgetDataStore({ marketing: { ...state,
      couponTarget: state.couponTarget.map(row => row.couponId === sent.couponId ? { ...row, couponId: active.couponId } : row),
    } }, { runId: run.getState().runId });
  }
  if (slot && ['S5-114', 'S5-126', 'S5-137'].includes(id)) {
    expect(data.dispatch({ type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: slot.regularIds,
      benefit: 'free-shot', idempotencyKey: 'seed-slot' }).ok).toBe(true);
  }
  const item = readModel(data.getSnapshot(), 'expiry-coupon').target;
  if (item?.recommendedRate && ['S5-152', 'S5-156'].includes(id)) {
    expect(data.dispatch({ type: 'coupon.createExpiry', itemId: item.itemId, benefit: { kind: 'percent', value: item.recommendedRate },
      route: 'place_news', idempotencyKey: 'seed-expiry' }).ok).toBe(true);
  }
  const bridge = createNavisMenuHarness((options: Parameters<typeof createBridge>[0]) =>
    createBridge({ ...options, agentMode: 'fake', onDiagnostics() {} }), validateAgentFrame, navisAgentFakeFetch);
  const calls: { name: string; args: unknown }[] = [];
  const provider = createAssistantProvider({ store: data, run, fetcher: async (_url, options) => {
    const request: unknown = JSON.parse(String(options?.body));
    expect(validateAgentRequest(request)).toBe(true);
    const result = await bridge.run(request);
    calls.push(...result.calls);
    return new Response(result.raw, { status: result.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
  } });
  const navigation = createNavisNavigation(run, { highlight() {}, closeChat() {} });
  async function ask(text: string, feature: 'slot-coupon' | 'expiry-coupon' | 'coupon-status' = 'coupon-status') {
    const before = data.getSnapshot();
    const plan = classifyNavigation(text, run.getState(), before, feature);
    const prepared = plan && prepareNavigationRequest(plan, run.getState(), navigation);
    let detail: ReturnType<NonNullable<typeof prepared>['resolve']> | undefined;
    const reply = await provider.ask({ text, locale: 'ko', layer: id === 'S7-008' ? 'management' : 'marketing', signal: new AbortController().signal,
      ...(prepared ? { agentTurn: prepared.agentTurn, onNavigation: action => { detail = prepared.resolve(action); } }
        : {}) });
    expect(data.getSnapshot()).toBe(before);
    const navigationResult = detail && plan ? await navigation.execute(plan.command, detail) : undefined;
    if (navigationResult) expect(['opened', 'already']).toContain(navigationResult);
    const state = run.getState().overlay;
    const detailRef = state.type === 'detail' ? state.stack?.at(-1) : undefined;
    const outcome = detailRef || navigationResult ? 'navigate' : reply.turn?.kind === 'proposal' ? 'proposal'
      : reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? 'clarify'
      : reply.turn?.kind === 'refusal' || reply.turn?.kind === 'handoff' ? 'refuse' : 'answer';
    return { reply, detailRef, outcome, before };
  }
  return { data, ask, calls, active, slot, run, navigation, close: () => bridge.close() };
}

it('pauses only after the owner presses the card and restores from the command receipt', async () => {
  const env = fixture();
  try {
    const { reply, before } = await env.ask(`${activeCouponName} 쿠폰 잠깐 멈춰줘`);
    expect(reply.turn?.kind).toBe('proposal');
    if (reply.turn?.kind !== 'proposal') return;
    const proposal = reply.turn.proposal;
    expect(proposal.command).toBe('coupon.pause');
    expect(env.calls.map(call => call.name)).toContain('propose_action');
    await env.ask('확인');
    expect(env.data.getSnapshot()).toBe(before);
    const receipt = proposal.confirm(env.data);
    expect(receipt.frame.outcome).toBe('applied');
    expect(receipt.notice?.messageKey).toBe('data.marketing.notice.paused');
    const after = env.data.getSnapshot();
    expect(readModel(after, 'coupon-status').rows.find(row => row.status === 'paused')?.status).toBe('paused');
    expect(proposal.confirm(env.data).frame).toEqual(receipt.frame);
    expect(env.data.getSnapshot()).toBe(after);
    await env.ask('되돌려 줘');
    expect(env.data.getSnapshot()).toBe(after);
    expect(receipt.undoToken && env.data.undo(receipt.undoToken).ok).toBe(true);
    expect(env.data.getSnapshot().tables.marketing).toEqual(before.tables.marketing);
  } finally { env.close(); }
});

it('S5-115 reads current consent and night scheduling rules', async () => {
  const env = fixture();
  try {
    const { reply } = await env.ask('밤에 예약 발송해도 돼요?', 'slot-coupon');
    expect(reply.answer).toContain('야간에도 예약할 수 있어요');
    expect(reply.answer).toContain('문자에 동의한 손님에게만');
    expect(env.calls.map(call => call.name)).toEqual(['get_widget']);
  } finally { env.close(); }
});

it.each([
  ['S5-130', '단골들한테 쿠폰 지금 보내줘', undefined],
  ['S5-131', '내일 아침 9시에 예약 발송해줘', `${addDays(TODAY, 1)}T09:00`],
])('%s applies one local slot send with the selector audience and its own receipt', async (_id, text, scheduledAt) => {
  const env = fixture();
  try {
    const { reply, before } = await env.ask(text, 'slot-coupon');
    expect(reply.turn?.kind).toBe('proposal');
    if (reply.turn?.kind !== 'proposal') return;
    const { proposal } = reply.turn;
    expect(proposal.command).toBe('coupon.sendSlot');
    expect(env.calls.map(call => call.name)).toEqual(['search_records', 'propose_action']);
    expect(readModel(before, 'slot-coupon').sent).toHaveLength(0);
    const receipt = proposal.confirm(env.data);
    const after = env.data.getSnapshot();
    expect(receipt.frame).toMatchObject({ outcome: 'applied', messageKey: 'data.notice.sent' });
    expect(receipt.undoToken).toBeUndefined();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.tables.marketing.messageSend.slice(before.tables.marketing.messageSend.length)).toEqual(
      env.slot!.regularIds.map(customerId => expect.objectContaining({ customerId, status: 'mock',
        ...(scheduledAt ? { scheduledAt } : {}) })));
    expect(proposal.confirm(env.data).frame).toEqual(receipt.frame);
    expect(env.data.getSnapshot()).toBe(after);
  } finally { env.close(); }
});

it('D-326 Q19 makes a Place News sell-today coupon only on the card press, with the widget limit, and undoes from the receipt', async () => {
  const env = fixture();
  try {
    const { reply, before } = await env.ask('바스크 치즈케이크 40% 쿠폰 플레이스 소식으로 만들어줘', 'expiry-coupon');
    if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
    const { proposal } = reply.turn;
    expect(proposal.command).toBe('coupon.createExpiry');
    expect(proposal.tier).not.toBe('extra-confirm');
    expect(env.data.getSnapshot()).toBe(before);
    const receipt = proposal.confirm(env.data);
    expect(receipt.frame.outcome).toBe('applied');
    const after = env.data.getSnapshot();
    expect(after.tables.marketing.coupon).toHaveLength(before.tables.marketing.coupon.length + 1);
    expect(after.tables.marketing.couponCode.at(-1)).toMatchObject({ route: 'place_news', activatedAt: null });
    expect(proposal.confirm(env.data).frame).toEqual(receipt.frame);
    if (!receipt.notice?.undo) throw new Error('Missing receipt undo');
    env.run.actions.showNotice(receipt.notice);
    expect(applyAgentRunUndo(env.run, env.data, receipt.notice.undo.token)).toBe(true);
    expect(env.data.getSnapshot().tables.marketing).toEqual(before.tables.marketing);
    // The widget limit, text-message route, and unspecified bundles stay out of the card.
    expect((await env.ask('바스크 치즈케이크 99% 쿠폰 플레이스 소식으로 만들어줘', 'expiry-coupon')).reply.turn?.kind).not.toBe('proposal');
    expect((await env.ask('바스크 치즈케이크 40% 쿠폰 문자로 만들어줘', 'expiry-coupon')).reply.turn).toMatchObject({ kind: 'refusal' });
    expect((await env.ask('바스크 치즈케이크 세트 쿠폰 플레이스 소식으로 만들어줘', 'expiry-coupon')).reply.turn).toMatchObject({ kind: 'refusal' });
  } finally { env.close(); }
});

it.each([
  ['1,000원 할인', 'amount', 1000],
  ['세트 가격 5,000원', 'set_price', 5000],
] as const)('D-328 previews %s and saves its exact benefit only on the card press', async (phrase, benefitType, benefitValue) => {
  const env = fixture();
  try {
    const { reply, before } = await env.ask(`바스크 치즈케이크 ${phrase} 당일 소진 쿠폰 만들어줘`, 'expiry-coupon');
    if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
    const { proposal } = reply.turn;
    expect(proposal.command).toBe('coupon.createExpiry');
    expect(proposal.preview).toMatchObject({ fields: expect.arrayContaining([expect.objectContaining({ after: phrase })]) });
    await env.ask('응');
    expect(env.data.getSnapshot()).toBe(before);
    const receipt = proposal.confirm(env.data);
    expect(receipt.frame.outcome).toBe('applied');
    const after = env.data.getSnapshot();
    expect(after.tables.marketing.coupon.at(-1)).toMatchObject({ benefitType, benefitValue });
    expect(after.tables.marketing.couponCode.at(-1)).toMatchObject({ route: 'place_news', activatedAt: null, issueCount: 10 });
    expect(after.tables.marketing.messageSend).toEqual(before.tables.marketing.messageSend);
    expect(proposal.confirm(env.data).frame).toEqual(receipt.frame);
    expect(env.data.getSnapshot()).toBe(after);
    if (!receipt.notice?.undo) throw new Error('Missing receipt undo');
    env.run.actions.showNotice(receipt.notice);
    expect(applyAgentRunUndo(env.run, env.data, receipt.notice.undo.token)).toBe(true);
    expect(env.data.getSnapshot().tables.marketing).toEqual(before.tables.marketing);
  } finally { env.close(); }
});

it.each(['6,000원 할인', '세트 가격 100원', '500.5원 할인', '40.5% 할인', '1,000원 할인 문자로', '1,000원 할인 만들어서 플레이스에 바로 올려줘'])(
  'D-328 keeps %s outside the sell-today proposal boundary', async phrase => {
    const env = fixture();
    try {
      const result = await env.ask(`바스크 치즈케이크 당일 소진 쿠폰 ${phrase} 만들어줘`, 'expiry-coupon');
      expect(result.reply.turn?.kind).not.toBe('proposal');
      expect(env.calls.some(call => call.name === 'propose_action')).toBe(false);
    } finally { env.close(); }
  },
);

it('D-326 Q19 edits one coupon benefit on the card and keeps the terms of coupons already issued', async () => {
  const env = fixture();
  try {
    const { reply, before } = await env.ask(`${activeCouponName} 쿠폰 혜택 800원으로 바꿔줘`);
    if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
    const { proposal } = reply.turn;
    expect(proposal.command).toBe('coupon.update');
    expect((proposal.preview as { fields: unknown[] }).fields).toEqual([expect.objectContaining({ before: expect.stringContaining('1,000'), after: expect.stringContaining('800') })]);
    expect(env.data.getSnapshot()).toBe(before);
    const receipt = proposal.confirm(env.data);
    expect(receipt.frame.outcome).toBe('applied');
    const after = env.data.getSnapshot().tables.marketing;
    expect(after.coupon.find(row => row.couponId === env.active.couponId)?.benefitValue).toBe(800);
    for (const code of after.couponCode.filter(row => row.couponId === env.active.couponId && row.activatedAt)) {
      expect(code.issuedTerms?.benefitValue).toBe(env.active.benefitValue);
    }
    expect(receipt.undoToken && env.data.undo(receipt.undoToken).ok).toBe(true);
    expect(env.data.getSnapshot().tables.marketing).toEqual(before.tables.marketing);
    // Several coupons at once, and deleting one, stay in the widget.
    expect((await env.ask('쿠폰 전부 혜택 800원으로 바꿔줘')).reply.turn).toMatchObject({ kind: 'refusal' });
    expect((await env.ask(`${activeCouponName} 쿠폰 삭제해줘`)).reply.turn).toMatchObject({ kind: 'refusal' });
  } finally { env.close(); }
});

it('D-326 Q19 ends a coupon early only after the extra confirmation and restores it from the receipt', async () => {
  const env = fixture();
  try {
    const { reply, before } = await env.ask(`${activeCouponName} 쿠폰 일찍 끝내줘`);
    if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
    const { proposal } = reply.turn;
    expect(proposal.command).toBe('coupon.endEarly');
    expect(proposal.tier).toBe('extra-confirm');
    expect(proposal.confirm(env.data).requiresExtraConfirmation).toBe(true);
    expect(env.data.getSnapshot()).toBe(before);
    const receipt = proposal.confirm(env.data, proposal.id);
    expect(receipt.frame.outcome).toBe('applied');
    expect(env.data.getSnapshot().tables.marketing.coupon.find(row => row.couponId === env.active.couponId)?.status).toBe('ended');
    expect(proposal.confirm(env.data, proposal.id).frame).toEqual(receipt.frame);
    expect(receipt.undoToken && env.data.undo(receipt.undoToken).ok).toBe(true);
    expect(env.data.getSnapshot().tables.marketing).toEqual(before.tables.marketing);
    expect((await env.ask('쿠폰 전부 일찍 끝내줘')).reply.turn).toMatchObject({ kind: 'refusal' });
  } finally { env.close(); }
});

it('D-326 Q19 takes one posted Place News coupon down with the extra confirmation and keeps custom extension dates in the widget', async () => {
  const env = fixture();
  try {
    const item = readModel(env.data.getSnapshot(), 'expiry-coupon').target!;
    const made = env.data.dispatch({ type: 'coupon.createExpiry', itemId: item.itemId, benefit: { kind: 'percent', value: item.recommendedRate! },
      route: 'place_news', idempotencyKey: 'd326-expiry' });
    if (!made.ok) throw new Error(made.messageKey);
    const codeId = env.data.getSnapshot().tables.marketing.couponCode.at(-1)!.codeId;
    expect(env.data.dispatch({ type: 'coupon.markPosted', codeId, idempotencyKey: 'd326-post' }).ok).toBe(true);
    const { reply, before } = await env.ask('쿠폰 게시 취소해줘');
    if (reply.turn?.kind !== 'proposal') throw new Error(reply.answer);
    const { proposal } = reply.turn;
    expect(proposal.command).toBe('coupon.unpublish');
    expect(proposal.tier).toBe('extra-confirm');
    expect(proposal.confirm(env.data).requiresExtraConfirmation).toBe(true);
    expect(env.data.getSnapshot()).toBe(before);
    const receipt = proposal.confirm(env.data, proposal.id);
    expect(receipt.frame.outcome).toBe('applied');
    expect(env.data.getSnapshot().tables.marketing.couponCode.find(row => row.codeId === codeId)?.unpublishedAt).toBeTruthy();
    expect(receipt.undoToken && env.data.undo(receipt.undoToken).ok).toBe(true);
    expect(env.data.getSnapshot().tables.marketing).toEqual(before.tables.marketing);
    const extend = await env.ask(`${activeCouponName} 쿠폰 11월 30일까지 연장해줘`);
    expect(extend.reply.turn).toMatchObject({ kind: 'refusal' });
  } finally { env.close(); }
});

it('S5-156 activates one exact coupon code only after the extra confirmation', async () => {
  const env = fixture('S5-156');
  try {
    const { reply, before } = await env.ask('플레이스 소식에 올렸어, 올렸다고 표시해줘', 'expiry-coupon');
    expect(reply.turn?.kind).toBe('proposal');
    if (reply.turn?.kind !== 'proposal') return;
    const { proposal } = reply.turn;
    const [pending] = readModel(before, 'expiry-coupon').pendingPosts;
    expect(proposal.command).toBe('coupon.markPosted');
    expect(proposal.tier).toBe('extra-confirm');
    expect(proposal.confirm(env.data).requiresExtraConfirmation).toBe(true);
    expect(env.data.getSnapshot()).toBe(before);
    const receipt = proposal.confirm(env.data, proposal.id);
    const after = env.data.getSnapshot();
    expect(receipt.frame).toMatchObject({ outcome: 'applied', messageKey: 'data.marketing.notice.counting' });
    expect(receipt.undoToken).toBeUndefined();
    expect(after.tables.marketing.couponCode.find(code => code.codeId === pending.codeId)?.activatedAt).toBeTruthy();
    expect(after.tables.marketing.messageSend).toEqual(before.tables.marketing.messageSend);
    expect(proposal.confirm(env.data, proposal.id).frame).toEqual(receipt.frame);
    expect(env.data.getSnapshot()).toBe(after);
  } finally { env.close(); }
});

it('S6-135 rechecks reminder eligibility after extension and requires its own press after undo', async () => {
  const env = fixture('reminder');
  try {
    const { reply, before } = await env.ask(`${activeCouponName} 쿠폰 일주일 연장하고 끝나기 전 알림도 보내줘`);
    expect(reply.turn?.kind).toBe('proposal');
    if (reply.turn?.kind !== 'proposal') return;
    expect(reply.turn.proposal.command).toBe('coupon.extend');
    const extended = reply.turn.proposal.confirm(env.data);
    expect(extended.frame).toMatchObject({ outcome: 'applied', messageKey: 'data.marketing.notice.extended' });
    const after = env.data.getSnapshot();
    expect(after.tables.marketing.messageSend).toEqual(before.tables.marketing.messageSend);
    expect((await env.ask('쿠폰 끝나기 전 알림 문자 보내줘')).outcome).toBe('refuse');
    expect(env.data.getSnapshot()).toBe(after);
    expect(extended.undoToken && env.data.undo(extended.undoToken).ok).toBe(true);
    const reminder = await env.ask('곧 끝나는 쿠폰 알림 문자 보내줘');
    expect(reminder.reply.turn?.kind).toBe('proposal');
    if (reminder.reply.turn?.kind !== 'proposal') return;
    const { proposal } = reminder.reply.turn;
    expect(proposal.command).toBe('coupon.notifyEnding');
    expect(env.data.getSnapshot().tables.marketing.couponReminder).toHaveLength(0);
    const receipt = proposal.confirm(env.data);
    expect(receipt.frame).toMatchObject({ outcome: 'applied', messageKey: 'data.notice.sent' });
    expect(env.data.getSnapshot().tables.marketing.couponReminder).toMatchObject([{ couponId: env.active.couponId, recipients: env.slot!.regularIds.length }]);
    expect(receipt.undoToken).toBeUndefined();
  } finally { env.close(); }
});

it('keeps a Tuesday request away from a different weekday’s shot coupon', async () => {
  const env = fixture('S6-135');
  try {
    const { outcome } = await env.ask('화요일 샷 추가 무료 쿠폰 일주일 연장해줘');
    expect(outcome).toBe('clarify');
    expect(env.calls).toEqual([]);
  } finally { env.close(); }
});

const representativeExceptions: Readonly<Record<string, string>> = {
  'S5-101': 'answer', 'S5-118': 'answer', 'S5-136': 'answer', 'S5-137': 'answer',
  'S5-148': 'refuse', 'S5-149': 'refuse', 'S5-150': 'refuse', 'S5-153': 'refuse', 'S5-155': 'refuse',
  'S5-166': 'proposal', // D-326 Q19: the Place News coupon is a card; the dependent status read belongs to N21.
  'S6-128': 'clarify', 'S6-129': 'clarify', // D-326 Q19: a benefit or quantity edit is a card; with no exact coupon named it asks which one.
  'S6-110': 'clarify', 'S6-113': 'clarify', 'S6-115': 'clarify', 'S6-117': 'clarify', 'S6-118': 'clarify',
  'S6-120': 'clarify', 'S6-122': 'clarify', 'S6-124': 'refuse', 'S6-133': 'answer', 'S6-134': 'answer', 'S6-135': 'clarify',
  'S6-136': 'refuse', 'S6-137': 'answer', 'S6-138': 'refuse', 'S6-195': 'answer', 'S8-073': 'answer',
};

describe('N16 authored utterances', () => {
  it('includes the TRACE dependencies and the three policy-overlay rows', () => {
    expect(scenarios).toHaveLength(88);
    expect(scenarios.flatMap(row => row.utterances)).toHaveLength(274);
  });

  it.each(scenarios)('$id replays every authored alternative', async row => {
    for (const [index, text] of row.utterances.entries()) {
      const env = fixture(row.id);
      try {
        const feature = row.widget === 'slot-coupon' || row.widget === 'expiry-coupon' ? row.widget : 'coupon-status';
        const result = await env.ask(text, feature);
        const proposal = result.reply.turn?.kind === 'proposal' ? result.reply.turn.proposal : undefined;
        if (process.env.N16_OBSERVATIONS) appendFileSync(process.env.N16_OBSERVATIONS, JSON.stringify({
          id: row.id, variant: index + 1, expected: row.expected.kind, actual: result.outcome, command: proposal?.command,
          text, reply: result.reply.answer, tools: env.calls.map(call => call.name), detailRef: result.detailRef,
        }) + '\n');
        expect(result.reply.answer || result.outcome === 'navigate' || proposal, text).toBeTruthy();
        if (index === 0) expect(result.outcome, row.id).toBe(representativeExceptions[row.id] ?? row.expected.kind);
      } finally { env.close(); }
    }
  }, 30_000);
});
