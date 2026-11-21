// @vitest-environment node
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getRegistry } from '../../../catalog';
import { beginDashboard } from '../../../app/test-session';
import { addDays, TODAY } from '../../../data/db/time';
import { createWidgetDataStore, type DataSnapshot } from '../../../data/widget-data';
import { createInitialClosure } from '../../../data/iteration7/notices';
import { createLegacyNoticeSeed } from '../../../data/iteration7/notices/seed';
import { resolveNoticeRecipients } from '../../../data/iteration7/notices/recipients';
import { screenPresets } from '../../../layout';
import { classifyNavigation, createNavisNavigation, prepareNavigationRequest } from '../../../screens/dashboard/navis-navigation';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { applyAgentRunUndo } from '../agent-actions';
import { createAssistantProvider } from '../provider';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest } from '../../../../shared/navis-agent-schema.mjs';
// @ts-expect-error The shared corpus loader is JavaScript.
import { evidence, readTrace } from '../../../../server/navis/scenario-fixtures.mjs';
// @ts-expect-error The in-process bridge is JavaScript.
import { createBridge } from '../../../../server/bridge.mjs';
// @ts-expect-error The native v3 fixture is JavaScript.
import { createNavisMenuHarness, navisAgentFakeFetch } from '../../../../server/fixtures/navis-eval-fake.mjs';

interface Scenario {
  readonly id: string;
  readonly utterances: readonly string[];
  readonly expected: { readonly kind: string; readonly ask?: readonly string[]; readonly answer_must_contain?: readonly string[]; readonly tools: readonly { readonly name: string; readonly args?: { readonly command?: string } }[] };
}
const trace: { scenario_id: string; slice_id: string; required_slices: string }[] = readTrace();
const merged = new Map((JSON.parse(evidence('MERGED.json')) as Scenario[]).map(row => [row.id, row]));
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json')) as Record<string, {
  expected?: Partial<Scenario['expected']>;
  policyGap?: { expected?: Partial<Scenario['expected']> };
  variants?: Record<number, { expected: Partial<Scenario['expected']> }>;
  n15Historical?: boolean;
}>;
const scenarios = trace.filter(row => row.required_slices.split('|').includes('N15')).map(({ scenario_id, slice_id }) => {
  const row = merged.get(scenario_id)!;
  return { ...row, slice: slice_id, expected: { ...row.expected, ...overlay[scenario_id]?.expected, ...overlay[scenario_id]?.policyGap?.expected } };
});
const notice = createLegacyNoticeSeed().noticeDraft[0];
const closure = createInitialClosure();
const policyDate = addDays(TODAY, 1);

function fixture(id: string, { stale = false, historical = false } = {}) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  run.actions.switchLayer('marketing');
  const base = createWidgetDataStore().getSnapshot();
  const startDate = historical ? notice.startDate : policyDate;
  const title = historical ? notice.title : '11/18(수) 임시 휴무';
  const draft = { ...notice, title, startDate, endDate: startDate };
  const event = { ...closure, date: startDate, title: { raw: title }, revision: stale ? 2 : 1,
    storeClosure: { kind: 'temporary' as const, endDate: startDate } };
  const data = createWidgetDataStore({
    calendarEvent: [...base.tables.calendarEvent.filter(record => record.eventId !== closure.eventId), event],
    noticeDraft: id === 'S6-080' ? [] : id === 'S6-083' ? [draft, ...base.tables.noticeDraft] : [draft],
  }, { runId: run.getState().runId });
  if (['S6-053', 'S6-084', 'S6-088'].includes(id)) {
    const preview = data.dispatch({ type: 'notice.preview', noticeId: draft.noticeId, draftRevision: draft.revision });
    if (!preview.ok || !preview.value || typeof preview.value !== 'object' || !('previewId' in preview.value)
      || typeof preview.value.previewId !== 'string') throw Error(`Cannot seed preview for ${id}`);
    expect(data.dispatch({ type: 'notice.send', noticeId: draft.noticeId, draftRevision: draft.revision,
      previewId: preview.value.previewId, idempotencyKey: `seed-${id}` }).ok).toBe(true);
  }
  const calls: { name: string; args?: unknown }[] = [];
  const requests: unknown[] = [];
  const bridge = createNavisMenuHarness((options: Parameters<typeof createBridge>[0]) =>
    createBridge({ ...options, agentMode: 'fake', onDiagnostics() {} }), validateAgentFrame, navisAgentFakeFetch);
  const provider = createAssistantProvider({ store: data, run, fetcher: async (_url, options) => {
    const request: unknown = JSON.parse(String(options?.body));
    expect(validateAgentRequest(request)).toBe(true);
    requests.push(request);
    const result = await bridge.run(request);
    calls.push(...result.calls);
    return new Response(result.raw, { status: result.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
  } });
  const navigation = createNavisNavigation(run, { highlight() {}, closeChat() {} });
  async function ask(text: string) {
    const before = data.getSnapshot();
    const plan = classifyNavigation(text, run.getState(), before, 'notice-send');
    const prepared = plan && prepareNavigationRequest(plan, run.getState(), navigation);
    let detail: ReturnType<NonNullable<typeof prepared>['resolve']> | undefined;
    const reply = await provider.ask({ text, locale: 'ko', layer: 'marketing', signal: new AbortController().signal,
      ...(prepared ? { agentTurn: prepared.agentTurn, onNavigation: action => { detail = prepared.resolve(action); } } : {}) });
    expect(data.getSnapshot()).toBe(before);
    if (detail && plan) expect(await navigation.execute(plan.command, detail)).toBe('opened');
    const state = run.getState().overlay;
    const detailRef = state.type === 'detail' ? state.stack?.at(-1) : undefined;
    const outcome = detailRef ? 'navigate' : reply.turn?.kind === 'proposal' ? 'proposal'
      : reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? 'clarify'
        : reply.turn?.kind === 'refusal' || reply.turn?.kind === 'handoff' ? 'refuse' : 'answer';
    return { reply, detailRef, outcome, before };
  }
  return { data, ask, bridge, requests, calls, draft, run };
}
const noticeTables = ({ tables }: DataSnapshot) => ({ drafts: tables.noticeDraft, sent: tables.noticeSent, previews: tables.noticePreview });

describe('N15 notice contracts', () => {
  it('returns draft copy and audience from the same café snapshot through fake transport', async () => {
    const env = fixture('S6-054');
    try {
      expect((await env.ask('임시 저장한 공지 뭐 있어?')).reply.answer).toContain(env.draft.title);
      expect((await env.ask('휴무 공지 내용이 뭐였지?')).reply.answer).toContain(notice.body);
      const model = resolveNoticeRecipients(env.data.getSnapshot().tables, env.draft);
      expect((await env.ask('휴무 공지 미리보기')).reply.answer).toContain(`${model.recipientCount}명`);
      expect(env.calls.map(call => call.name)).toContain('notice.preview');
    } finally { env.bridge.close(); }
  });

  it('D-326 Q4 schedules one send at a chosen time on the card and the receipt undo cancels it before it goes out', async () => {
    const env = fixture('S6-087');
    try {
      const { reply, before } = await env.ask('내일 아침 9시에 휴무 공지 예약 발송해줘');
      if (reply.turn?.kind !== 'proposal') throw Error(reply.answer);
      const { proposal } = reply.turn;
      expect(proposal.command).toBe('notice.send');
      const sendAt = `${addDays(TODAY, 1)}T09:00`;
      const preview = proposal.preview as { fields: { label: string; after: string }[] };
      const recipients = resolveNoticeRecipients(before.tables, env.draft).recipientCount;
      expect(preview.fields[0].after).toContain('09:00');
      expect(preview.fields.some(field => field.after.includes(`${recipients}명`))).toBe(true);
      await env.ask('확인');
      expect(env.data.getSnapshot()).toBe(before);
      const receipt = proposal.confirm(env.data, proposal.id);
      expect(receipt.frame.outcome).toBe('applied');
      expect(env.data.getSnapshot().tables.noticeSent).toMatchObject([{ status: 'scheduled', sendAt, noticeId: notice.noticeId, recipientCount: recipients }]);
      expect(proposal.confirm(env.data, proposal.id).frame).toEqual(receipt.frame);
      if (!receipt.notice?.undo) throw Error('Missing receipt undo');
      env.run.actions.showNotice(receipt.notice);
      expect(applyAgentRunUndo(env.run, env.data, receipt.notice.undo.token)).toBe(true);
      expect(env.data.getSnapshot().tables.noticeSent).toEqual(before.tables.noticeSent);
      // Still blocked: no time asks for it, a time in the past is refused, and standing automation stays outside.
      expect((await env.ask('공지 예약해서 보내줘')).reply.turn).toMatchObject({ kind: 'clarification', field: 'sendAt' });
      expect((await env.ask('오늘 새벽 1시에 휴무 공지 예약 발송해줘')).reply.turn?.kind).not.toBe('proposal');
      expect((await env.ask('매주 월요일마다 휴무 공지 자동으로 보내줘')).reply.turn).toMatchObject({ kind: 'refusal' });
    } finally { env.bridge.close(); }
  });

  it('applies one simulated send on the card and leaves typed approval and undo inert', async () => {
    const env = fixture('S6-086');
    try {
      const { reply, before } = await env.ask('휴무 공지 지금 보내줘');
      expect(reply.turn?.kind).toBe('proposal');
      if (reply.turn?.kind !== 'proposal') return;
      const { proposal } = reply.turn;
      expect(proposal.command).toBe('notice.send');
      await env.ask('확인');
      expect(env.data.getSnapshot()).toBe(before);
      const receipt = proposal.confirm(env.data);
      expect(receipt.frame.outcome).toBe('applied');
      expect(receipt.notice?.messageKey).toBe('data.notice.sent');
      expect(receipt.undoToken).toBeUndefined();
      const after = env.data.getSnapshot();
      expect(after.tables.noticeSent).toMatchObject([{ status: 'sent_example', noticeId: notice.noticeId,
        recipientCount: resolveNoticeRecipients(before.tables, env.draft).recipientCount }]);
      expect(proposal.confirm(env.data).frame).toEqual(receipt.frame);
      expect(env.data.getSnapshot()).toBe(after);
      await env.ask('되돌려 줘');
      expect(env.data.getSnapshot()).toBe(after);
    } finally { env.bridge.close(); }
  });

  it('blocks stale closure sends and proposes re-import with receipt undo', async () => {
    const env = fixture('S6-079', { stale: true });
    try {
      const first = await env.ask('휴무 공지 지금 보내줘');
      expect(first.reply.answer).toMatch(/다시 가져/u);
      expect(first.outcome).toBe('refuse');
      const { reply, before } = await env.ask('휴무 공지 캘린더에서 다시 가져와줘');
      expect(reply.turn?.kind).toBe('proposal');
      if (reply.turn?.kind !== 'proposal') return;
      const receipt = reply.turn.proposal.confirm(env.data);
      expect(receipt.frame.outcome).toBe('applied');
      expect(env.data.getSnapshot().tables.noticeDraft[0].closureRevision).toBe(2);
      expect(receipt.undoToken && env.data.undo(receipt.undoToken).ok).toBe(true);
      expect(noticeTables(env.data.getSnapshot())).toEqual(noticeTables(before));
    } finally { env.bridge.close(); }
  });

  it('routes the draft editor and history without save or preview effects', async () => {
    const history = fixture('S6-090');
    const draft = fixture('S6-091');
    try {
      expect((await history.ask('보낸 기록 보여줘')).detailRef).toMatchObject({ featureId: 'notice-send', view: 'history' });
      expect((await draft.ask('임시 저장한 휴무 공지 열어줘')).detailRef).toMatchObject({ featureId: 'notice-send', itemId: notice.noticeId, view: 'drafts' });
    } finally { history.bridge.close(); draft.bridge.close(); }
  });

  it('routes typed text to an editable draft field without saving it', async () => {
    const env = fixture('S6-091');
    try {
      const result = await env.ask("공지 제목에 '주차 안내' 넣은 작성 화면 열어줘");
      expect(result.detailRef).toMatchObject({ featureId: 'notice-send', view: 'compose', focus: 'action',
        prefill: { kind: 'widget-draft', fields: { title: '주차 안내' } } });
      expect(env.data.getSnapshot()).toBe(result.before);
    } finally { env.bridge.close(); }
  });

  it('requires a fresh send card after the S6-092 body edit applies', async () => {
    const env = fixture('S6-092');
    try {
      const { reply } = await env.ask("휴무 공지 내용을 '재고 조사'로 고치고 바로 보내줘");
      expect(reply.turn?.kind).toBe('proposal');
      if (reply.turn?.kind !== 'proposal') return;
      expect(reply.turn.proposal.command).toBe('notice.saveDraft');
      expect(reply.turn.proposal.confirm(env.data).frame.outcome).toBe('applied');
      const updated = env.data.getSnapshot();
      expect(updated.tables.noticeDraft[0]).toMatchObject({ body: '재고 조사', revision: 2, closureEventId: closure.eventId });
      expect(updated.tables.noticeSent).toEqual([]);
      expect(updated.tables.noticePreview).toEqual([]);
      const send = await env.ask('휴무 공지 지금 보내줘');
      expect(send.reply.turn?.kind).toBe('proposal');
      if (send.reply.turn?.kind !== 'proposal') return;
      expect(send.reply.turn.proposal.command).toBe('notice.send');
      expect(send.reply.turn.proposal.confirm(env.data).frame.outcome).toBe('applied');
      expect(env.data.getSnapshot().tables.noticeSent[0]).toMatchObject({ body: '재고 조사', draftRevision: 2, status: 'sent_example' });
    } finally { env.bridge.close(); }
  });

  it('rejects a preflighted notice send after the draft revision changes', async () => {
    const env = fixture('S6-086');
    try {
      const { reply } = await env.ask('휴무 공지 지금 보내줘');
      expect(reply.turn?.kind).toBe('proposal');
      if (reply.turn?.kind !== 'proposal') return;
      const { noticeId, kind, title, startDate, endDate, audience, groupIds } = env.draft;
      expect(env.data.dispatch({ type: 'notice.saveDraft', noticeId, kind, title, body: '휴무 안내를 고쳤어요', startDate, endDate, audience, groupIds }).ok).toBe(true);
      const changed = env.data.getSnapshot();
      expect(reply.turn.proposal.confirm(env.data).frame.outcome).toBe('conflict');
      expect(env.data.getSnapshot()).toBe(changed);
      expect(changed.tables.noticePreview).toEqual([]);
      expect(changed.tables.noticeSent).toEqual([]);
    } finally { env.bridge.close(); }
  });
});

const dependencyOutcomes: Readonly<Record<string, string>> = {
  'S4-163': 'answer', // N20 returns the local read. N21 owns the dependent notice draft.
  'S6-092': 'clarify',
  'S6-093': 'refuse',
  'S6-094': 'answer',
};

// N15 R5 owns these alternate utterance gaps. The ledger records each expected behavior.
const alternateGaps: Readonly<Record<string, readonly number[]>> = {
  'S6-055': [3], 'S6-057': [3], 'S6-061': [3], 'S6-063': [2, 3],
  'S6-065': [2, 3], 'S6-066': [2], 'S6-071': [3], 'S6-079': [4], 'S6-080': [3],
  'S6-081': [3], 'S6-082': [4], 'S6-083': [3], 'S6-087': [3], 'S6-091': [3],
};

describe('N15 authored utterances', () => {
  it('includes every primary and dependent row assigned in TRACE', () => {
    expect(scenarios.filter(row => row.slice === 'N15')).toHaveLength(38);
    expect(scenarios.filter(row => row.slice !== 'N15')).toHaveLength(4);
    expect(scenarios.flatMap(row => row.utterances)).toHaveLength(132);
  });

  it.each(scenarios)('$id replays each authored utterance against its reviewed contract', async row => {
    for (const [index, utterance] of row.utterances.entries()) {
      const patch = overlay[row.id];
      const historical = patch?.n15Historical || ['S6-092', 'S6-094'].includes(row.id);
      const env = fixture(row.id, { historical });
      try {
        const result = await env.ask(utterance);
        const proposal = result.reply.turn?.kind === 'proposal' ? result.reply.turn.proposal : undefined;
        if (process.env.N15_OBSERVATIONS) appendFileSync(process.env.N15_OBSERVATIONS, JSON.stringify({
          id: row.id, variant: index + 1, expected: row.expected.kind, actual: result.outcome, utterance,
          command: proposal?.command, tools: env.calls.map(call => call.name), reply: result.reply.answer,
          field: result.reply.turn && 'field' in result.reply.turn ? result.reply.turn.field : undefined,
        }) + '\n');
        expect(result.reply.answer || result.detailRef || proposal, utterance).toBeTruthy();
        if (row.slice !== 'N15' && index !== 0) continue;
        // D-326 Q4: an exact time with a current draft is a scheduled card (covered by its own test).
        if (row.id === 'S6-087' && index === 0) { expect(proposal?.command).toBe('notice.send'); continue; }
        if (row.id === 'S6-087' && index === 1) {
          expect(result.reply.turn).toMatchObject({ kind: 'clarification', field: 'sendAt' });
          expect(env.data.getSnapshot()).toBe(result.before);
          continue;
        }
        if (alternateGaps[row.id]?.includes(index + 1)) {
          expect(env.data.getSnapshot()).toBe(result.before);
          expect(proposal).toBeUndefined();
          continue;
        }
        const reviewed = { ...row.expected, ...patch?.variants?.[index + 1]?.expected };
        expect(result.outcome, utterance).toBe(dependencyOutcomes[row.id] ?? reviewed.kind);
        if (patch?.expected && result.outcome === 'clarify' && reviewed.ask?.length) {
          expect(result.reply.turn && 'field' in result.reply.turn && result.reply.turn.field, utterance).toBe(reviewed.ask[0]);
        }
        for (const part of patch?.expected ? reviewed.answer_must_contain ?? [] : []) {
          expect(result.reply.answer, utterance).toContain(part);
        }
        if (proposal) {
          expect(proposal.command).toBe(reviewed.tools.find(tool => tool.name === 'propose_action')?.args?.command);
          expect(env.calls.map(call => call.name)).toContain('propose_action');
          if (proposal.tier === 'extra-confirm') {
            expect(proposal.confirm(env.data).requiresExtraConfirmation).toBe(true);
            expect(env.data.getSnapshot()).toBe(result.before);
          }
          const receipt = proposal.confirm(env.data, proposal.id);
          expect(receipt.frame.outcome).toBe('applied');
          const after = env.data.getSnapshot();
          expect(proposal.confirm(env.data, proposal.id).frame).toEqual(receipt.frame);
          expect(env.data.getSnapshot()).toBe(after);
          if (proposal.command === 'notice.send') {
            expect(after.tables.noticeSent).toHaveLength(result.before.tables.noticeSent.length + 1);
            expect(receipt.undoToken).toBeUndefined();
          } else {
            expect(after.tables.noticeSent).toEqual(result.before.tables.noticeSent);
            expect(receipt.undoToken && env.data.undo(receipt.undoToken).ok).toBe(true);
            expect(noticeTables(env.data.getSnapshot())).toEqual(noticeTables(result.before));
          }
        }
      } finally { env.bridge.close(); }
    }
  }, 15_000);
});
