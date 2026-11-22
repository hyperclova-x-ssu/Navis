// @vitest-environment node
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { beginDashboard } from '../../../app/test-session';
import { getRegistry } from '../../../catalog';
import { createWidgetDataStore, selectWidget } from '../../../data/widget-data';
import { screenPresets } from '../../../layout';
import { classifyNavigation, createNavisNavigation, prepareNavigationRequest } from '../../../screens/dashboard/navis-navigation';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { createAssistantProvider } from '../provider';
import { assistantDomains, projectAgentWidget } from '../snapshot';
import { manualsGrantsDomain } from './manuals-grants';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest } from '../../../../shared/navis-agent-schema.mjs';
// @ts-expect-error The in-process bridge is JavaScript.
import { createBridge } from '../../../../server/bridge.mjs';
// @ts-expect-error The native v3 fixture is JavaScript.
import { createNavisMenuHarness, navisAgentFakeFetch } from '../../../../server/fixtures/navis-eval-fake.mjs';
// @ts-expect-error The shared corpus loader is JavaScript.
import { evidence, readTrace } from '../../../../server/navis/scenario-fixtures.mjs';

const condition = { kind: 'default' } as const;
const cafe = () => createWidgetDataStore();
const opening = (store: ReturnType<typeof cafe>) => store.getSnapshot().tables.manual.find(row => row.category === 'opening')!;

async function replay(text: string, setup?: (store: ReturnType<typeof cafe>) => void) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'),
    time: timePolicy, theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId });
  setup?.(store);
  const before = store.getSnapshot();
  const calls: { name: string; args?: unknown }[] = [];
  const harness = createNavisMenuHarness((options: Parameters<typeof createBridge>[0]) =>
    createBridge({ ...options, agentMode: 'fake', onDiagnostics() {} }), validateAgentFrame, navisAgentFakeFetch);
  const provider = createAssistantProvider({ store, run, fetcher: async (_url, options) => {
    const request: unknown = JSON.parse(String(options?.body));
    if (!validateAgentRequest(request)) throw Error('Invalid N14 agent request');
    const result = await harness.run(request);
    calls.push(...result.calls);
    return new Response(result.raw, { status: result.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
  } });
  const ask = (value: string) => provider.ask({ text: value, locale: 'ko', layer: 'management', signal: new AbortController().signal });
  try {
    const navigation = createNavisNavigation(run, { highlight() {}, closeChat() {} });
    const plan = classifyNavigation(text, run.getState(), before);
    const prepared = plan && !plan.local && prepareNavigationRequest(plan, run.getState(), navigation);
    let detail: Record<string, unknown> | undefined = plan?.local ? plan.args : undefined;
    const reply = plan?.local ? { answer: '', turn: undefined } : prepared
      ? await provider.ask({ text, locale: 'ko', layer: 'management', signal: new AbortController().signal,
        agentTurn: prepared.agentTurn, onNavigation: action => { detail = prepared.resolve(action); } })
      : await ask(text);
    expect(store.getSnapshot()).toBe(before);
    if (detail && plan?.command === 'ui.openDetail') expect(await navigation.execute(plan.command, detail)).toBe('opened');
    const overlay = run.getState().overlay;
    const ref = overlay.type === 'detail' ? overlay.stack?.at(-1) : undefined;
    return { reply, calls, before, store, ask, ref };
  } finally {
    harness.close();
  }
}

function proposal(result: Awaited<ReturnType<typeof replay>>, command: string) {
  expect(result.reply.turn?.kind, result.reply.answer).toBe('proposal');
  if (result.reply.turn?.kind !== 'proposal') throw Error(command);
  expect(result.reply.turn.proposal.command).toBe(command);
  expect(result.calls.map(call => call.name)).toContain('propose_action');
  return result.reply.turn.proposal;
}

describe('N14 manuals and grants', () => {
  it.each([
    '배달 포장 매뉴얼 만들어줘 위생으로',
    '새 매뉴얼 하나 만들어줘 제목은 환불 처리',
    '매뉴얼 추가해줘 이름은 택배 받기',
  ])('S3-060 asks for the missing procedure in %s and keeps each supplied line', text => {
    const snapshot = cafe().getSnapshot();
    const first = manualsGrantsDomain.route?.(text, snapshot, 'ko');
    expect(first).toMatchObject({ kind: 'clarification', field: 'steps' });
    if (!first || !('kind' in first) || first.kind !== 'clarification') throw Error('Expected a steps question');
    const resumed = first.resume?.('송장 확인\n파손 확인');
    if (text.includes('위생')) {
      expect(resumed).toMatchObject({ intent: { command: 'manuals.create' }, slots: { steps: ['송장 확인', '파손 확인'] } });
    } else {
      expect(resumed).toMatchObject({ kind: 'clarification', field: 'category' });
    }
  });

  it('S3-061 recognizes an unclassified document with supplied steps', () => {
    expect(manualsGrantsDomain.route?.('택배받기 문서 만들어줘: 송장 → 파손', cafe().getSnapshot(), 'ko'))
      .toMatchObject({ kind: 'clarification', field: 'category' });
  });

  it('previews only the edited closing step and stores the owner’s exact wording', async () => {
    const result = await replay('마감 3번 단계 수정 -> 바닥 청소 + 음식물 쓰레기');
    const card = proposal(result, 'manuals.update');
    const id = result.before.tables.manual.find(row => row.category === 'closing')!.manualId;
    const steps = (snapshot: typeof result.before) => snapshot.tables.manualStep.filter(row => row.manualId === id);
    const session = 'proposalSession' in result.reply ? result.reply.proposalSession : undefined;
    expect(session?.getSnapshot().preview?.fields).toEqual([
      expect.objectContaining({ after: '바닥 청소 + 음식물 쓰레기' }),
    ]);
    const receipt = card.confirm(result.store);
    expect(receipt.frame.outcome).toBe('applied');
    const updated = steps(result.store.getSnapshot());
    expect(updated[2].body).toEqual({ raw: '바닥 청소 + 음식물 쓰레기' });
    expect(updated.filter(row => row.stepNo !== 3)).toEqual(steps(result.before).filter(row => row.stepNo !== 3));
    expect(receipt.undoToken && result.store.undo(receipt.undoToken).ok).toBe(true);
    expect(steps(result.store.getSnapshot())).toEqual(steps(result.before));
  });

  it('retains the named checklist and step number while asking for replacement text', () => {
    const snapshot = cafe().getSnapshot();
    const route = manualsGrantsDomain.route?.('마감 3단계 문구 바꿔줘', snapshot, 'ko');
    expect(route).toMatchObject({ kind: 'clarification', field: 'steps' });
    if (!route || !('kind' in route) || route.kind !== 'clarification') throw Error('Expected a step question');
    const resumed = route.resume?.('바닥 청소를 마쳐요');
    expect(resumed).toMatchObject({ intent: { command: 'manuals.update' } });
    if (!resumed || !('intent' in resumed)) throw Error('Expected an update intent');
    expect(resumed.slots?.steps).toHaveLength(5);
    expect((resumed.slots?.steps as readonly unknown[])[2]).toBe('바닥 청소를 마쳐요');
  });

  it('asks which unsaved memo draft to save and scopes the continuation to that draft', () => {
    const store = cafe();
    for (const memo of ['우유는 냉장고에 넣어요', '송장은 수령인이 확인해요']) {
      expect(store.dispatch({ type: 'manuals.createDraftFromMemo', memo }).ok).toBe(true);
    }
    const snapshot = store.getSnapshot();
    const route = manualsGrantsDomain.route?.('그 초안 저장해줘', snapshot, 'ko');
    const [first, second] = snapshot.tables.manualDraft;
    expect(route).toMatchObject({ kind: 'clarification', field: 'draftId', choices: [{ id: first.draftId }, { id: second.draftId }] });
    if (!route || !('kind' in route) || route.kind !== 'clarification') throw Error('Expected a draft choice');
    expect(route.resume?.(second.draftId)).toMatchObject({ intent: { command: 'manuals.saveDraft' }, slots: { name: second.draftId } });
    expect(store.getSnapshot()).toBe(snapshot);
  });

  it('reports a named manual already unpublished without offering a second write', async () => {
    const { reply, before, store, calls } = await replay('오픈 매뉴얼 게시 취소해줘', store => {
      const manual = opening(store);
      expect(store.dispatch({ type: 'manuals.setPublished', manualId: manual.manualId, published: false, idempotencyKey: 'unpublish' }).ok).toBe(true);
    });
    expect(reply.answer).toContain('이미');
    expect(reply.turn?.kind).not.toBe('proposal');
    expect(calls).toEqual([]);
    expect(store.getSnapshot()).toBe(before);
  });
  it('S3-044 reads actual café opening progress and keeps unsaved drafts private', async () => {
    const result = await replay('오픈 체크리스트 어디까지 했어?', store => {
      expect(store.dispatch({ type: 'manuals.createDraftFromMemo', memo: '숨겨진 메모' }).ok).toBe(true);
    });
    expect(result.calls.map(call => call.name)).toEqual(['get_widget']);
    expect(result.reply.answer).toContain('5단계 중 0단계');
    const projection = projectAgentWidget(result.before, 'manuals', condition, 'ko', assistantDomains);
    expect(projection.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: expect.stringContaining('progress'), value: 0 })]));
    expect(JSON.stringify(projection)).not.toContain('숨겨진 메모');
  });

  it('only marks an explicit checklist state on a card press and undoes it', async () => {
    const result = await replay('오픈 4번 했어');
    const card = proposal(result, 'manuals.toggleStep');
    await result.ask('응 해줘');
    expect(result.store.getSnapshot()).toBe(result.before);
    const receipt = card.confirm(result.store, card.id);
    expect(receipt.frame.outcome).toBe('applied');
    expect(result.store.getSnapshot().tables.checklistLog).toContainEqual(expect.objectContaining({ manualId: opening(result.store).manualId, stepNo: 4 }));
    expect(card.confirm(result.store, card.id).frame).toEqual(receipt.frame);
    expect(receipt.undoToken && result.store.undo(receipt.undoToken).ok).toBe(true);
    expect(result.store.getSnapshot().tables.checklistLog).toEqual(result.before.tables.checklistLog);
  });

  it('S3-077 creates a memo draft on confirmation and leaves public facts unchanged', async () => {
    const memo = '우유는 받자마자 냉장고에 넣고 먼저 온 것부터 쓴다';
    const result = await replay(`이 메모로 매뉴얼 초안 만들어줘: ${memo}`);
    const card = proposal(result, 'manuals.createDraftFromMemo');
    const receipt = card.confirm(result.store, card.id);
    expect(receipt.frame.outcome).toBe('applied');
    expect(result.store.getSnapshot().tables.manualDraft).toContainEqual(expect.objectContaining({ memo, status: 'draft', steps: [{ raw: memo }] }));
    expect(result.store.getSnapshot().tables.manual).toBe(result.before.tables.manual);
  });

  it('S3-080 requires a second confirmation to discard a saved local draft', async () => {
    const result = await replay('초안 버려줘', store => {
      expect(store.dispatch({ type: 'manuals.createDraftFromMemo', memo: '우유는 냉장고에 넣어요' }).ok).toBe(true);
    });
    const card = proposal(result, 'manuals.discardDraft');
    expect(card.confirm(result.store).requiresExtraConfirmation).toBe(true);
    expect(result.store.getSnapshot()).toBe(result.before);
    const receipt = card.confirm(result.store, card.id);
    expect(receipt.frame.outcome).toBe('applied');
    expect(receipt.undoToken && result.store.undo(receipt.undoToken).ok).toBe(true);
    expect(result.store.getSnapshot().tables.manualDraft).toEqual(result.before.tables.manualDraft);
  });

  it('S3-099 distinguishes empty café application history from a known retained status', async () => {
    const empty = await replay('내가 신청한 거 어떻게 됐어?');
    expect(empty.calls.map(call => call.name)).toEqual(['get_widget']);
    expect(empty.reply.answer).toContain('아직 신청한 사업이 없어요');
    const reviewing = await replay('지원 현황 알려줘', store => {
      const noticeId = store.getSnapshot().tables.grantNotice[0].noticeId;
      expect(store.dispatch({ type: 'grants.apply', noticeId, idempotencyKey: 'reviewing' }).ok).toBe(true);
      const applicationId = store.getSnapshot().tables.grantApplication[0].applicationId;
      expect(store.dispatch({ type: 'grants.updateApplication', applicationId, status: 'reviewing' }).ok).toBe(true);
    });
    expect(reviewing.reply.answer).toContain('서류 심사');
  });

  it('S3-121 opens the named current notice in the draft tab without applying', async () => {
    const body = '고효율 냉장 설비를 교체해요.';
    const result = await replay(`서울 소상공인 에너지 절감 지원 신청서 초안 써줘: ${body}`);
    expect(result.ref).toMatchObject({ featureId: 'grants', view: 'template', itemId: 'sample-grant-2', focus: 'action',
      prefill: { kind: 'widget-draft', fields: { body } } });
    expect(result.before.tables.grantApplication).toEqual([]);
  });

  it('opens the exact official notice and requests final eligibility from that source', async () => {
    const title = '동작구 소상공인 매장 개선 지원';
    const result = await replay(`${title} 공식 공고 열어줘`);
    expect(result.ref).toMatchObject({ featureId: 'grants', view: 'official', itemId: 'sample-grant-1' });
    expect(result.store.getSnapshot()).toBe(result.before);
    const eligibility = await replay(`${title} 받을 수 있어?`);
    expect(eligibility.reply.answer).toContain('최종 자격은 공식 공고에서 확인해요.');
    expect(eligibility.calls.map(call => call.name)).toEqual(['get_widget']);
  });

  it('prepares a manual document form with owner-supplied fields only', async () => {
    const result = await replay("인수인계 '배달 포장' 매뉴얼 만드는 화면 열어줘, 위생 분류. 1단계 용기 꺼내기, 2단계 닫기");
    expect(result.ref).toMatchObject({ featureId: 'manuals', view: 'handover', focus: 'action',
      prefill: { kind: 'widget-draft', fields: { title: '배달 포장', category: 'hygiene', section: 'handover', steps: ['용기 꺼내기', '닫기'] } } });
  });

  it('requires an extra confirmation to delete one checklist step', async () => {
    const result = await replay('오픈 4번 단계 지워줘');
    const card = proposal(result, 'manuals.update');
    expect(card.confirm(result.store).requiresExtraConfirmation).toBe(true);
    expect(result.store.getSnapshot()).toBe(result.before);
    const receipt = card.confirm(result.store, card.id);
    expect(receipt.frame.outcome).toBe('applied');
    const remaining = result.store.getSnapshot().tables.manualStep.filter(row => row.manualId === opening(result.store).manualId);
    expect(remaining.map(row => row.stepNo)).toEqual([1, 2, 3, 4]);
    expect(receipt.undoToken && result.store.undo(receipt.undoToken).ok).toBe(true);
    expect(result.store.getSnapshot().tables.manualStep).toEqual(result.before.tables.manualStep);
  });

  it('records a local application once and restores the candidate on undo', async () => {
    const result = await replay('동작구 소상공인 매장 개선 지원 신청했어');
    const card = proposal(result, 'grants.apply');
    const receipt = card.confirm(result.store, card.id);
    expect(receipt.frame.outcome).toBe('applied');
    expect(result.store.getSnapshot().tables.grantApplication).toContainEqual(expect.objectContaining({ noticeId: 'sample-grant-1', status: 'applied' }));
    const updated = selectWidget(result.store.getSnapshot(), 'grants', condition, 'normal');
    expect(updated.status === 'ready' && updated.model.candidateCount).toBe(1);
    expect(receipt.undoToken && result.store.undo(receipt.undoToken).ok).toBe(true);
    expect(result.store.getSnapshot().tables.grantApplication).toEqual(result.before.tables.grantApplication);
  });
});

interface Scenario {
  readonly id: string;
  readonly utterances: readonly string[];
  readonly expected: { readonly kind: string; readonly tools: readonly { name: string; args?: Record<string, unknown> }[]; readonly ask?: readonly string[]; readonly answer_must_contain?: readonly string[] };
}
const trace: { scenario_id: string; slice_id: string; required_slices: string }[] = readTrace();
const corpus = new Map((JSON.parse(evidence('MERGED.json')) as Scenario[]).map(row => [row.id, row]));
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json')) as Record<string, {
  expected?: Partial<Scenario['expected']>;
  variants?: Record<number, { expected: Partial<Scenario['expected']> }>;
}>;
const scenarios = trace.filter(row => row.slice_id === 'N14' || row.required_slices.split('|').includes('N14'))
  .map(({ scenario_id }) => {
    const row = corpus.get(scenario_id)!;
    return { ...row, expected: { ...row.expected, ...overlay[scenario_id]?.expected } };
  });

type Outcome = 'answer' | 'clarify' | 'proposal' | 'refuse' | 'navigate';
const alternateOutcomes: Record<string, readonly Outcome[]> = {
  'S3-055': ['clarify', 'clarify', 'clarify'], // N21 owns compound execution.
  'S3-059': ['proposal', 'clarify', 'proposal'], // Unstructured step prose needs a step boundary.
  'S3-071': ['proposal', 'clarify', 'proposal'], // Bare 9시 needs an unambiguous until time.
  'S3-072': ['proposal', 'proposal', 'refuse'], // D-326 Q3: one published manual comes down by a card; an absent manual still refuses.
  'S3-087': ['answer', 'answer', 'answer'], // Café has no checked steps to clear.
  'S3-088': ['answer', 'answer', 'answer'],
  'S3-089': ['answer', 'answer', 'answer'],
  'S3-130': ['clarify', 'clarify', 'clarify'],
  'S3-131': ['clarify', 'clarify', 'clarify'],
  'S3-132': ['clarify', 'clarify', 'clarify'],
};

const unpatchedAnswerText: Record<string, string> = {
  'S3-057': '5단계까지',
  'S3-087': '이미',
  'S3-089': '백플러싱',
  'S3-126': '직접 신청',
};

describe('D-326 Q3 manual unpublish', () => {
  it('takes one published manual down only after the extra confirmation and the receipt undo republishes it', async () => {
    const result = await replay('오픈 매뉴얼 게시 취소해줘');
    const card = proposal(result, 'manuals.setPublished');
    const { store, before } = result;
    expect(card.tier).toBe('extra-confirm');
    expect(card.confirm(store).requiresExtraConfirmation).toBe(true);
    expect(store.getSnapshot()).toBe(before);
    const receipt = card.confirm(store, card.id);
    expect(receipt.frame.outcome).toBe('applied');
    const down = store.getSnapshot().tables.manual.filter(row => row.isPublished).length;
    expect(down).toBe(before.tables.manual.filter(row => row.isPublished).length - 1);
    expect(card.confirm(store, card.id).frame).toEqual(receipt.frame);
    expect(receipt.undoToken && store.undo(receipt.undoToken).ok).toBe(true);
    expect(store.getSnapshot().tables.manual).toEqual(before.tables.manual);
  });

  it('keeps several manuals and the store information document in the widget', async () => {
    for (const text of ['모든 매뉴얼 게시 취소해줘', '매장 정보 매뉴얼 게시 취소해줘']) {
      const { reply, store, before } = await replay(text);
      expect(reply.turn?.kind, text).not.toBe('proposal');
      expect(store.getSnapshot()).toBe(before);
    }
  });
});

describe('N14 café corpus', () => {
  it.each(['카페라떼 우유 양 250으로', '카페라떼 우유 양 250 mL로 바꿔줘'])('keeps "%s" on the menu recipe card', async text => {
    const result = await replay(text);
    proposal(result, 'menu.setRecipe');
    const session = 'proposalSession' in result.reply ? result.reply.proposalSession : undefined;
    expect(session?.getSnapshot().preview?.fields).toContainEqual({ label: '목장 1등급 우유', before: '260 mL', after: '250 mL' });
    await result.ask('확인');
    expect(result.store.getSnapshot()).toBe(result.before);
  });

  it.each(scenarios)('$id replays each authored utterance', async row => {
    for (const [index, text] of row.utterances.entries()) {
      const result = await replay(text, ['S3-078', 'S3-080'].includes(row.id) ? store => {
        expect(store.dispatch({ type: 'manuals.createDraftFromMemo', memo: '우유는 냉장고에 넣어요' }).ok).toBe(true);
      } : undefined);
      const { reply, calls, ref, before, store } = result;
      const actual = ref ? 'navigate' : reply.turn?.kind === 'proposal' ? 'proposal'
        : reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? 'clarify'
          : reply.turn?.kind === 'refusal' || reply.turn?.kind === 'handoff' ? 'refuse' : 'answer';
      if (process.env.N14_OBSERVATIONS) appendFileSync(process.env.N14_OBSERVATIONS, JSON.stringify({
        id: row.id, variant: index + 1, expected: row.expected.kind, actual, calls: calls.map(call => call.name),
        answer: reply.answer, command: reply.turn?.kind === 'proposal' ? reply.turn.proposal.command : undefined,
        field: reply.turn && 'field' in reply.turn ? reply.turn.field : undefined, ref,
      }) + '\n');
      const patch = overlay[row.id];
      const reviewed = { ...row.expected, ...patch?.variants?.[index + 1]?.expected };
      const expected = alternateOutcomes[row.id]?.[index] ?? reviewed.kind;
      const label = `${row.id} variant ${index + 1}`;
      expect.soft(actual, label).toBe(expected);
      expect.soft(reply.answer || ref || reply.turn?.kind === 'proposal', label).toBeTruthy();
      expect.soft(store.getSnapshot()).toBe(before);
      const tools = calls.map(call => call.name);
      if (expected === 'answer') {
        const parts = patch?.expected ? reviewed.answer_must_contain ?? [] : [unpatchedAnswerText[row.id]].filter(Boolean);
        for (const part of parts) expect.soft(reply.answer, label).toContain(part);
        if (patch?.expected) expect.soft(tools, label).toEqual(reviewed.tools.map(tool => tool.name));
      }
      if (expected === 'clarify' && (patch?.variants?.[index + 1] || patch?.expected?.kind === 'clarify')) {
        expect.soft(reply.turn && 'field' in reply.turn && reply.turn.field, label).toBe(reviewed.ask?.[0]);
        if (row.id === 'S3-043') {
          for (const part of reviewed.answer_must_contain ?? []) expect.soft(reply.answer, label).toContain(part);
          expect.soft(tools, label).toEqual([]);
        }
      }
      if (expected === 'refuse' || expected === 'clarify' || expected === 'navigate') {
        expect.soft(tools, label).not.toContain('propose_action');
      }
      if (expected === 'proposal' && reply.turn?.kind === 'proposal') {
        const card = reply.turn.proposal;
        if (row.id === 'S3-072') {
          expect.soft(card.command, label).toBe('manuals.setPublished');
          expect.soft(card.tier, label).toBe('extra-confirm');
          continue;
        }
        const command = reviewed.tools.find(tool => tool.name === 'propose_action')?.args?.command;
        // N14 R5 owns the combined music and lights interpretation.
        if (row.id === 'S3-053' && index === 2) {
          expect.soft(card.command, label).toBe('manuals.toggleStep');
          continue;
        }
        expect.soft(card.command, label).toBe(command);
        expect.soft(tools, label).toEqual(command === 'manuals.createDraftFromMemo' ? ['propose_action'] : ['search_records', 'propose_action']);
        expect.soft(calls.at(-1)?.args, label).toMatchObject({ command });
        if (row.id === 'S3-068' || card.command === 'manuals.delete' || card.command === 'manuals.discardDraft') {
          expect.soft(card.confirm(store).requiresExtraConfirmation, label).toBe(true);
          expect.soft(store.getSnapshot(), label).toBe(before);
        }
        const receipt = card.confirm(store, card.id);
        expect.soft(receipt.frame.outcome, label).toBe('applied');
        expect.soft(store.getSnapshot().revision, label).toBe(before.revision + 1);
        expect.soft(receipt.undoToken && store.undo(receipt.undoToken).ok, label).toBe(true);
        const restored = store.getSnapshot().tables;
        expect.soft({ ...restored, commandLedger: before.tables.commandLedger }, label).toEqual(before.tables);
      }
      if (expected === 'navigate') {
        const view = row.id === 'S3-083' ? 'store-info' : row.id === 'S3-123' ? 'applications' : 'handover';
        expect.soft(ref, label).toMatchObject({ featureId: row.id === 'S3-123' ? 'grants' : 'manuals', view });
        if (row.id === 'S3-084') expect.soft(ref?.focus, label).toBe('action');
        if (row.id === 'S3-082' || row.id === 'S7-091') {
          expect.soft(ref?.itemId, label).toBe(before.tables.manual.find(row => row.category === 'closing')?.manualId);
        }
      }
    }
  });

  it('loads primary and joint slice contracts', () => {
    expect(trace.filter(row => row.slice_id === 'N14')).toHaveLength(73);
    expect(scenarios).toHaveLength(80);
    expect(scenarios.flatMap(row => row.utterances)).toHaveLength(244);
  });
});
