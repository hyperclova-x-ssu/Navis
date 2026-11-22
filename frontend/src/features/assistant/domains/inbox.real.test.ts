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
import { createAssistantProvider } from '../provider';
import { selectVerifiedEvidence } from '../evidence';
import { navisTranslator } from '../messages';
import { gateUnreadable } from '../real-gate';
import { assistantDomains } from '../snapshot';
import { repliesDomain } from './replies';

/** HTTP builds: a Navis card runs the same service command as the widget, and only the owner's card press does it. */
async function setup(withUnreadableAuxiliaryDomains = false) {
  const env = service();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  run.actions.switchLayer('marketing');
  const runId = run.getState().runId;
  const store = createWidgetDataStore(undefined, { runId });
  const port = createRealPort({ store, fetch: env.backend.fetch, adapters: autoloadedAdapters(),
    source: domain => domain === 'inbox' || withUnreadableAuxiliaryDomains && (domain === 'members' || domain === 'staff') ? 'http' : 'fixture',
    sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  await port.load('inbox');
  const actions = createAgentActions(store, undefined, run);
  const card = (command: string, args: Record<string, unknown>, targets: ReadonlyMap<string, { kind: 'thread' | 'noticeDraft'; id: string }>, tier: 'normal' | 'extra-confirm', slots: Record<string, unknown>) => {
    const snapshot = store.getSnapshot();
    const prepared = actions.prepare({ command, args, snapshotRevision: snapshot.revision, proposalId: `wire-${command.replace(/\W/g, '-')}`, runId, layer: 'marketing', tier } as never, slots as never, snapshot, () => true, targets as never);
    if (prepared.kind !== 'proposal') throw new Error(`${command}: ${JSON.stringify(prepared)} ${JSON.stringify(store.getSnapshot().tables.integration)}`);
    return { ...prepared.proposal, store };
  };
  return { ...env, store, card, runId, run };
}
const writes = (backend: ReturnType<typeof service>['backend']) => backend.calls.filter(call => call.method !== 'GET');

it('summarizes the same ten reviews for list, display, recent and unread questions', async () => {
  const { store, run, backend, state } = await setup();
  state.inquiries = state.inquiries.filter(row => row.type !== 'review');
  const latest = [
    { text: '커피가 맛있어요\n둘째 줄은 생략해 주세요', stars: 5 },
    { text: '매장이 조용해요', stars: 4 },
    { text: '주문을 기다렸어요', stars: 2 },
  ];
  backend.on('GET', '/marketing/reviews', () => ({ items: Array.from({ length: 10 }, (_, index) => ({
    ref: `venue-${index}`, keywords: [], media: [], reply: null, hasReply: index >= 7,
    ...(latest[index] ?? { text: `앞서 받은 리뷰 ${index + 1}`, stars: 5 }),
  })) }));
  await store.real?.retry('inbox');
  const assistant = createAssistantProvider({ store, run, fetcher: async () => new Response(null, { status: 503 }) });
  const ask = (text: string) => assistant.ask({ text, layer: 'marketing', locale: 'ko', signal: new AbortController().signal });
  const previous = await ask('오늘 받은 문의 알려줘');
  const expected = '리뷰 10건 · 답변 대기 7건\n최근 네이버 리뷰 3건\n별점 5점 · “커피가 맛있어요”\n별점 4점 · “매장이 조용해요”\n별점 2점 · “주문을 기다렸어요”';
  const answers: string[] = [];
  for (const question of ['리뷰 뭐뭐있어?', '리뷰 보여줘', '최근 리뷰 알려줘', '안 읽은 리뷰 있어?']) {
    const reply = await ask(question);
    answers.push(reply.answer);
    expect(reply.proposalSession).toBeUndefined();
  }
  expect(answers).toEqual(Array.from({ length: 4 }, () => expected));
  expect(previous.answer).not.toBe(expected);
  expect(run.getState().overlay.type).toBe('none');
  expect(writes(backend)).toEqual([]);
});

it('distinguishes an empty W21 review list from a failed provider read', async () => {
  const { store, run, backend, state } = await setup();
  state.inquiries = state.inquiries.filter(row => row.type !== 'review');
  backend.on('GET', '/marketing/reviews', () => ({ items: [] }));
  await store.real?.retry('inbox');
  const assistant = createAssistantProvider({ store, run, fetcher: async () => new Response(null, { status: 503 }) });
  const ask = () => assistant.ask({ text: '리뷰 보여줘', layer: 'marketing', locale: 'ko', signal: new AbortController().signal });
  const empty = (await ask()).answer;
  backend.on('GET', '/marketing/reviews', () => ({ status: 503, body: { code: 'UNAVAILABLE' } }));
  await store.real?.retry('inbox');
  const failed = (await ask()).answer;
  expect({ empty, failed }).toEqual({ empty: '등록된 리뷰가 없어요', failed: '리뷰 목록을 불러오지 못했어요' });

  backend.on('GET', '/marketing/reviews', () => ({ items: [] }));
  await store.real?.retry('inbox');
  backend.on('GET', '/marketing/inquiries', () => ({ status: 503, body: { code: 'UNAVAILABLE' } }));
  expect(await store.real?.retry('inbox')).toMatchObject({ status: 'stale' });
  expect((await ask()).answer).toBe('리뷰 목록을 불러오지 못했어요');
  expect(writes(backend)).toEqual([]);
});

it('counts recorded reviews once and masks contact details in the first line', async () => {
  const { store, run, backend, state } = await setup();
  state.inquiries = state.inquiries.map(row => row.id === ids.manual
    ? { ...row, type: 'review', text: '또 방문했어요\n다음 줄' } : row);
  backend.on('GET', '/marketing/reviews', () => ({ items: [
    { ref: 'rv-1', text: '확인 연락 010-1234-5678\n비공개 다음 줄', stars: 3, hasReply: false },
    { ref: 'rv-2', text: '매장이 깨끗해요', stars: null, hasReply: true },
  ] }));
  await store.real?.retry('inbox');
  const assistant = createAssistantProvider({ store, run, fetcher: async () => new Response(null, { status: 503 }) });
  const result = await assistant.ask({ text: '후기 목록 좀 알려 줘', layer: 'marketing', locale: 'ko', signal: new AbortController().signal });
  expect(result.answer).toBe([
    '리뷰 3건 · 답변 대기 2건',
    '최근 네이버 리뷰 2건',
    '별점 3점 · “확인 연락 010-****-****”',
    '별점 없음 · “매장이 깨끗해요”',
    '최근 기록한 리뷰 1건',
    '별점 없음 · “또 방문했어요”',
  ].join('\n'));
  expect(writes(backend)).toEqual([]);
});

it('projects provider review totals and rating evidence', async () => {
  const { store, backend } = await setup();
  backend.on('GET', '/marketing/reviews', () => ({ items: [
    { ref: 'rv-1', text: '기다렸어요', stars: 2, hasReply: false },
    { ref: 'rv-2', text: '커피가 좋아요', stars: 5, hasReply: true },
    { ref: 'rv-3', text: '매장이 조용해요', stars: null, hasReply: false },
  ], averageStars: 3.5 }));
  await store.real?.retry('inbox');
  const projected = repliesDomain.projectWidget?.(store.getSnapshot(), 'ai-response', { kind: 'default' }, 'ko');
  expect(projected).toMatchObject({ facts: expect.arrayContaining([
    expect.objectContaining({ key: 'inquiry.reviews.total', value: 3, label: '네이버 리뷰', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) }),
    expect.objectContaining({ key: 'inquiry.reviews.waiting', value: 2, label: '답변 대기' }),
    expect.objectContaining({ key: 'inquiry.reviews.answered', value: 1, label: '답변함' }),
    expect.objectContaining({ key: 'inquiry.reviews.lowestWaiting', value: 2, display: expect.stringContaining('기다렸어요') }),
  ]) });
});

it('keeps W21 review wording and its read-only destination when chat transport fails', async () => {
  const { store, run, backend } = await setup();
  backend.on('GET', '/marketing/reviews', () => ({ items: [
    { ref: 'rv-1', text: '기다렸어요', stars: 2, hasReply: false },
    { ref: 'rv-2', text: '커피가 좋아요', stars: 5, hasReply: true },
  ] }));
  await store.real?.retry('inbox');
  const assistant = createAssistantProvider({ store, run, fetcher: async () => new Response(null, { status: 503 }) });
  const result = await assistant.ask({ text: '처리할 리뷰 답변이 남았어요?', layer: 'marketing', locale: 'ko', signal: new AbortController().signal });
  expect(result.answer).toContain('네이버 리뷰 2건');
  expect(result.answer).toContain('답변 대기 1건');
  if (result.turn?.kind !== 'read') throw new Error(result.answer);
  const reads = result.turn.evidence;
  expect(selectVerifiedEvidence(reads, reads.flatMap(row => row.tool === 'search_records' ? [] : row.facts.map(fact => ({ fact }))), navisTranslator('ko')))
    .toMatchObject([{ destination: { featureId: 'ai-response', view: 'review' }, openLabel: '메시지·리뷰 응대 열기' }]);
  expect(writes(backend)).toEqual([]);
});

it('uses a read-only service preview, then sends one grounded TalkTalk reply with the chosen coupon on the card press', async () => {
  const { backend, state, store, run } = await setup(true);
  const assistant = createAssistantProvider({ store, run, fetcher: async () => { throw new Error('A grounded reply card needs no chat-wire round trip'); } });
  const ask = (text: string) => assistant.ask({ text, layer: 'marketing', locale: 'ko', signal: new AbortController().signal });
  const reply = await ask('톡톡 영업시간 문의에 커피 쿠폰 붙여서 답장해줘');
  const session = reply.proposalSession;
  if (!session) throw new Error(reply.answer);
  const { preview, proposal } = session.getSnapshot();
  expect(preview).toMatchObject({ confirmLabel: '톡톡으로 보내기', fields: expect.arrayContaining([
    expect.objectContaining({ label: '답변 초안', after: expect.stringContaining('일요일 영업시간은 10:00~20:30입니다.') }),
    expect.objectContaining({ label: '붙인 쿠폰', after: expect.stringContaining('NAVIS10') }),
  ]) });
  const previewPath = `/marketing/inquiries/${ids.talk}/navis-draft-preview`;
  expect(writes(backend).map(call => call.path)).toEqual([previewPath]);
  await ask('보내 줘');
  expect(writes(backend).map(call => call.path)).toEqual([previewPath]);
  store.hydrate({ menuItem: [] });
  expect(store.getSnapshot().revision).toBeGreaterThan(proposal.snapshotRevision);
  expect(session.confirm(store, proposal.id)).toMatchObject({ pending: true });
  session.confirm(store, proposal.id);
  expect((await proposal.settled()).frame.outcome).toBe('applied');
  expect(state.inquiries.find(row => row.id === ids.talk)).toMatchObject({ status: 'done', reply: { text: expect.stringContaining('NAVIS10') } });
  expect(store.getSnapshot().tables.inquiryThread.find(row => row.threadId === ids.talk)?.status).toBe('done');
  const sent = backend.callsTo('POST', `/marketing/inquiries/${ids.talk}/reply`);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.headers.get('idempotency-key')).toBe(`talktalk-reply:${ids.talk}:2`);
});

it('previews the newest unanswered TalkTalk inquiry before asking which coupon to attach', async () => {
  const { backend, state, store, run } = await setup();
  const selected = state.inquiries.findIndex(row => row.id === ids.talk);
  state.inquiries[selected] = { ...state.inquiries[selected]!, updatedAt: '2026-11-21T03:02:00Z' };
  state.inquiries.push({ ...state.inquiries[selected]!, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    providerRef: 'tt-2', updatedAt: '2026-11-21T03:00:59Z' });
  state.inquiries.push({ ...state.inquiries[selected]!, id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    providerRef: 'tt-3', status: 'done', updatedAt: '2026-11-21T03:03:00Z' });
  const manual = state.inquiries.findIndex(row => row.id === ids.manual);
  state.inquiries[manual] = { ...state.inquiries[manual]!, updatedAt: '2026-11-21T03:04:00Z' };
  await store.real?.retry('inbox');
  const assistant = createAssistantProvider({ store, run });
  const input = { text: '방금 온 톡톡 문의에 쿠폰 붙여서 답장해줘', layer: 'marketing' as const, locale: 'ko' as const };
  const selection = await assistant.ask({ ...input, signal: new AbortController().signal });
  expect(selection.turn).toMatchObject({ kind: 'clarification', field: 'couponId', choices: [{ id: 'reply-coupon', label: '커피 쿠폰' }] });
  if (selection.turn?.kind !== 'clarification' || !selection.turn.choices?.[0]) throw Error(selection.answer);
  const result = await assistant.ask({ ...input, signal: new AbortController().signal,
    continuation: { clarificationId: selection.turn.id, choiceId: selection.turn.choices[0].id } });
  const preview = result.proposalSession?.getSnapshot().preview;
  expect(preview).toMatchObject({ confirmLabel: '톡톡으로 보내기', fields: expect.arrayContaining([
    expect.objectContaining({ label: '받는 사람', after: expect.stringContaining('네이버 톡톡') }),
    expect.objectContaining({ label: '붙인 쿠폰', after: expect.stringContaining('NAVIS10') }),
  ]) });
  expect(writes(backend).map(call => call.path)).toEqual([`/marketing/inquiries/${ids.talk}/navis-draft-preview`]);
});

it('asks which recent TalkTalk inquiry to use when two arrived within a minute', async () => {
  const { backend, state, store, run } = await setup();
  const selected = state.inquiries.findIndex(row => row.id === ids.talk);
  state.inquiries[selected] = { ...state.inquiries[selected]!, updatedAt: '2026-11-21T03:02:01Z' };
  state.inquiries.push({ ...state.inquiries[selected]!, id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', providerRef: 'tt-3',
    text: '환불이 되나요?\n추가 내용', updatedAt: '2026-11-21T03:01:02Z' });
  await store.real?.retry('inbox');
  const assistant = createAssistantProvider({ store, run });
  const result = await assistant.ask({ text: '최근 톡톡 문의에 쿠폰 붙여서 답장해줘', layer: 'marketing', locale: 'ko', signal: new AbortController().signal });
  expect(result.turn).toMatchObject({ kind: 'clarification', field: 'threadId', choices: [
    expect.objectContaining({ label: expect.stringMatching(/12:02.*일요일에도 문 여나요/u) }),
    expect.objectContaining({ label: expect.stringMatching(/12:01.*환불이 되나요\?$/u) }),
  ] });
  expect(result.proposalSession).toBeUndefined();
  expect(writes(backend)).toEqual([]);
});

it('does not assume that an unnamed recent TalkTalk inquiry matches the recipient in the request', async () => {
  const { backend, store, run } = await setup();
  const assistant = createAssistantProvider({ store, run });
  const result = await assistant.ask({ text: '이도현님의 최근 톡톡 문의에 쿠폰을 붙여 답장해줘', layer: 'marketing', locale: 'ko', signal: new AbortController().signal });
  expect(result.turn).toMatchObject({ kind: 'refusal', alternative: { featureId: 'ai-response', step: 'message-draft' } });
  expect(result.proposalSession).toBeUndefined();
  expect(writes(backend)).toEqual([]);
});

it('keeps W21 widget reads and ordinary draft cards unavailable with unreadable auxiliary domains', async () => {
  const { store, run, runId } = await setup(true);
  const snapshot = store.getSnapshot();
  const gated = gateUnreadable(assistantDomains, store);
  expect(gated.projectWidget(snapshot, 'ai-response', { kind: 'default' }, 'ko')).toEqual({ status: 'unavailable' });
  const result = createAgentActions(store, gated, run).prepare({ command: 'inquiry.saveDraft', args: { threadId: { handle: 't1' }, body: { slot: 'body' }, revision: { slot: 'revision' } },
    snapshotRevision: snapshot.revision, proposalId: 'ordinary-inbox-draft', runId, layer: 'marketing', tier: 'normal' },
  { body: '직접 쓴 답변', revision: 1 }, snapshot, () => true, new Map([['t1', { kind: 'thread', id: ids.talk }]]));
  expect(result).toMatchObject({ kind: 'invalid', messageKey: 'data.real.error.SOURCE_UNAVAILABLE' });
});

it('requires choosing an inquiry before requesting a draft if more than one consultation matches', async () => {
  const { backend, state, store, run } = await setup();
  state.inquiries.push({ ...state.inquiries.find(row => row.id === ids.talk)!, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', providerRef: 'tt-2' });
  await store.real?.retry('inbox');
  const assistant = createAssistantProvider({ store, run, fetcher: async () => { throw new Error('Choosing an inquiry stays local'); } });
  const reply = await assistant.ask({ text: '일요일 영업시간 문의에 답장해줘', layer: 'marketing', locale: 'ko', signal: new AbortController().signal });
  expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'threadId', choices: [expect.anything(), expect.anything()] });
  expect(writes(backend)).toEqual([]);
});

it('keeps the selected inquiry at the reply pane if the preview has no verifiable facts', async () => {
  const { backend, store, run } = await setup();
  const path = `/marketing/inquiries/${ids.talk}/navis-draft-preview`;
  backend.on('POST', path, () => ({ source: 'navis', text: '안녕하세요.', facts: [] }));
  const assistant = createAssistantProvider({ store, run });
  const reply = await assistant.ask({ text: '일요일 영업시간 문의에 답장해줘', layer: 'marketing', locale: 'ko', signal: new AbortController().signal });
  expect(reply.turn).toMatchObject({ kind: 'refusal', alternative: { featureId: 'ai-response', step: 'message-draft', itemId: ids.talk } });
  expect(reply.answer).toContain('답할 근거를 확인하지 못했어요');
  expect(writes(backend).map(call => call.path)).toEqual([path]);
});

it('leaves the inquiry untouched if the selected coupon expires before owner confirmation', async () => {
  const { backend, store, run } = await setup();
  const assistant = createAssistantProvider({ store, run });
  const reply = await assistant.ask({ text: '영업시간 문의에 커피 쿠폰 붙여서 답장해줘', layer: 'marketing', locale: 'ko', signal: new AbortController().signal });
  const session = reply.proposalSession;
  if (!session) throw new Error(reply.answer);
  const { proposal } = session.getSnapshot();
  backend.on('GET', '/marketing/coupons', () => ({ items: [], nextCursor: null, businessDate: '2026-11-29',
    asOf: '2026-11-29T02:00:00.000Z', sourceRevision: 2 }));
  session.confirm(store, proposal.id);
  expect((await proposal.settled()).frame.outcome).toBe('conflict');
  expect(writes(backend).map(call => call.path)).toEqual([`/marketing/inquiries/${ids.talk}/navis-draft-preview`]);
  expect(store.getSnapshot().tables.inquiryThread.find(row => row.threadId === ids.talk)?.status).toBe('waiting');
});

it('rejects an inbox revision change even when the previously previewed draft text still matches', async () => {
  const { backend, state, store, run } = await setup();
  const assistant = createAssistantProvider({ store, run });
  const reply = await assistant.ask({ text: '영업시간 문의에 답장해줘', layer: 'marketing', locale: 'ko', signal: new AbortController().signal });
  const session = reply.proposalSession;
  if (!session) throw new Error(reply.answer);
  const { proposal } = session.getSnapshot();
  const index = state.inquiries.findIndex(row => row.id === ids.talk);
  const inquiry = state.inquiries[index]!;
  state.inquiries[index] = { ...inquiry, revision: inquiry.revision + 1 };
  await store.real?.retry('inbox');
  expect(session.confirm(store, proposal.id)).toMatchObject({ frame: { outcome: 'conflict' } });
  expect(writes(backend).map(call => call.path)).toEqual([`/marketing/inquiries/${ids.talk}/navis-draft-preview`]);
});

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
