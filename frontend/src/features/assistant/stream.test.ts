import { cafeSnapshot, cafeTodayNet } from './__fixtures__/cafe';
import { createWidgetDataStore, selectMenus } from '../../data/widget-data';
import { navisTranslator } from './messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssistantProvider, parseModelOutput } from './provider';
import { controlledResponse, replyResponse, sseFrame } from './stream-fixture';

const todayDisplay = navisTranslator('ko').format.money(cafeTodayNet, 'compact');
const signal = () => new AbortController().signal;
const ledger = { featureId: 'ledger', size: { width: 1, height: 1 }, reason: '매출 확인' };
afterEach(() => vi.useRealTimers());

it('decodes split UTF-8 and multi-line SSE, publishing text immediately and candidates only at done', async () => {
  const wire = controlledResponse(), deltas: string[] = [];
  let settled = false;
  const pending = createAssistantProvider({ fetcher: async () => wire.response }).ask({ text: '매출', signal: signal(), onTextDelta: delta => deltas.push(delta) }).then(reply => { settled = true; return reply; });
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: text_delta\r\ndata: {"delta":\r\ndata: "오늘 매출 128.4만 원"}\r\n\r\n');
  for (const byte of bytes) wire.bytes(Uint8Array.of(byte));
  await vi.waitFor(() => expect(deltas.join('')).toBe('오늘 매출 128.4만 원'));
  wire.frame('panels', { panels: [ledger, { ...ledger, size: { width: 9, height: 1 } }, { ...ledger, featureId: 'demand' }] });
  await Promise.resolve(); expect(settled).toBe(false);
  wire.frame('done', {});
  const reply = await pending;
  expect(reply.answer).toBe(deltas.join('')); expect(reply.panels.map(p => p.featureId)).toEqual(['ledger']);
  expect(reply.mode).toBeUndefined(); expect(wire.cancelled).toBe(true);
});

it.each(['TIMEOUT', 'UNAVAILABLE', 'INVALID_OUTPUT', 'EOF'])('finishes received text and adds candidates after %s', async code => {
  const wire = controlledResponse();
  const pending = createAssistantProvider({ fetcher: async () => wire.response }).ask({ text: '매출', signal: signal() });
  wire.frame('text_delta', { delta: '받은 답' });
  if (code === 'EOF') wire.close(); else wire.frame('error', { code });
  expect(await pending).toMatchObject({ answer: '받은 답', panels: [expect.objectContaining({ featureId: 'ledger' })] });
  expect((await pending).status).toBeUndefined();
});

it('uses simple mode for unsolicited CANCELLED before text and aborts a blocked reader on explicit cancellation', async () => {
  const wire = controlledResponse(); wire.frame('error', { code: 'CANCELLED' });
  expect(await createAssistantProvider({ fetcher: async () => wire.response }).ask({ text: '매출', signal: signal() })).toMatchObject({ mode: 'simple', panels: [expect.objectContaining({ featureId: 'ledger' })] });
  const waiting = controlledResponse(), controller = new AbortController();
  const pending = createAssistantProvider({ fetcher: async () => waiting.response }).ask({ text: '매출', signal: controller.signal });
  await Promise.resolve(); controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(waiting.cancelled).toBe(true);
});

it('switches immediately to simple using its dedicated signal, once, and ignores late text', async () => {
  const wire = controlledResponse(), simple = new AbortController(), deltas: string[] = [];
  const pending = createAssistantProvider({ fetcher: async () => wire.response }).ask({ text: '매출', signal: signal(), simpleSignal: simple.signal, onTextDelta: d => deltas.push(d) });
  await Promise.resolve(); simple.abort(); simple.abort();
  expect(await pending).toMatchObject({ mode: 'simple', answer: expect.stringContaining(todayDisplay) });
  wire.frame('text_delta', { delta: '늦은 답' }); expect(deltas).toEqual([]);
});

it('allows a first character at 3 seconds to finish at 40 seconds and preserves text at the 60 second safety cap', async () => {
  vi.useFakeTimers();
  const wire = controlledResponse();
  const pending = createAssistantProvider({ fetcher: async () => wire.response }).ask({ text: '매출', signal: signal() });
  await vi.advanceTimersByTimeAsync(3000); wire.frame('text_delta', { delta: '첫 글자' });
  await vi.advanceTimersByTimeAsync(37000); wire.frame('panels', { panels: [] }); wire.frame('done', {});
  expect(await pending).toMatchObject({ answer: '첫 글자', panels: [expect.objectContaining({ featureId: 'ledger' })] });
  const next = controlledResponse(); const stopped = createAssistantProvider({ fetcher: async () => next.response }).ask({ text: '매출', signal: signal() });
  next.frame('text_delta', { delta: '부분' }); await vi.advanceTimersByTimeAsync(60000);
  expect(await stopped).toMatchObject({ answer: '부분', panels: [expect.objectContaining({ featureId: 'ledger' })] });
  expect((await stopped).status).toBeUndefined();
});

it.each([
  sseFrame('panels', { panels: [] }) + sseFrame('text_delta', { delta: '잘못된 순서' }),
  sseFrame('text_delta', { delta: '   ' }) + sseFrame('panels', { panels: [] }) + sseFrame('done', {}),
  'event: text_delta\ndata: invalid\n\n',
  sseFrame('done', {}),
])('rejects malformed/empty/incomplete SSE without publishing unvalidated cards', async frames => {
  const reply = await createAssistantProvider({ fetcher: async () => new Response(frames) }).ask({ text: '매출', signal: signal() });
  expect(reply).toMatchObject({ mode: 'simple', panels: [expect.objectContaining({ featureId: 'ledger' })] });
});

it('does not expose source-only demand or POS candidates even if the server proposes a valid widget', async () => {
  for (const text of ['내일 손님 얼마나 와?', '누락 주문', '시재']) {
    const wire = controlledResponse(); wire.frame('text_delta', { delta: '자료를 확인했어요' }); wire.frame('panels', { panels: [ledger] }); wire.frame('done', {});
    const reply = await createAssistantProvider({ fetcher: async () => wire.response }).ask({ text, signal: signal() });
    expect(reply.mode).toBeUndefined(); expect(reply.panels).toEqual([]);
  }
});
it('does not count whitespace/heartbeats as first text and prevents callback delivery after abort-ignoring late fetch', async () => {
  vi.useFakeTimers();
  const wire = controlledResponse(); const pending = createAssistantProvider({ fetcher: async () => wire.response }).ask({ text: '매출', signal: signal() });
  wire.frame('text_delta', { delta: '   ' }); await vi.advanceTimersByTimeAsync(30000);
  expect(await pending).toMatchObject({ mode: 'simple', answer: expect.stringContaining(todayDisplay) });
  let resolve!: (response: Response) => void;
  const simple = new AbortController(), deltas: string[] = [];
  const late = createAssistantProvider({ fetcher: () => new Promise(r => { resolve = r; }) }).ask({ text: '매출', signal: signal(), simpleSignal: simple.signal, onTextDelta: d => deltas.push(d) });
  simple.abort(); expect(await late).toMatchObject({ mode: 'simple' });
  const response = controlledResponse(); response.frame('text_delta', { delta: '늦은 글' }); resolve(response.response); await vi.advanceTimersByTimeAsync(0);
  expect(deltas).toEqual([]);
});

it('accepts a complete answer beyond the former short-answer character cap', async () => {
  const answer = '가게 자료에 대한 설명입니다. '.repeat(600);
  expect(answer.length).toBeGreaterThan(8000);
  expect(parseModelOutput({ answer, panels: [] }).answer).toBe(answer);
  const wire = controlledResponse(); wire.frame('text_delta', { delta: answer }); wire.frame('panels', { panels: [] }); wire.frame('done', {});
  expect(await createAssistantProvider({ fetcher: async () => wire.response }).ask({ text: '매출', signal: signal() })).toMatchObject({ answer, panels: [expect.objectContaining({ featureId: 'ledger' })] });
});

describe('agent-v1 replies', () => {
  const headers = { 'X-Navis-Protocol': 'agent-v1' };
  const text = '동백 라테 메뉴에 넣어줘';
  const ask = () => ({ text, signal: new AbortController().signal });
  const price = {
    field: 'price', promptKey: 'menu.price', choices: [{ id: '4500', value: 4500 }, { id: '5000', value: 5000 }, { id: '5500', value: 5500 }, { id: 'manual' }],
  };
  const proposal = {
    command: 'menu.create', args: { name: { slot: 'name' }, category: 'drink', price: { slot: 'price' } }, snapshotRevision: 0,
  };
  const respond = (...frames: string[]) => new Response(frames.join(''), { headers });

  it('negotiates the agent protocol and keeps names and prices in the browser during clarification', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(respond(sseFrame('status', { step: 'accepted' }), sseFrame('panels', { panels: [] }),
        sseFrame('done', { outcome: 'clarify', clarification: price })))
      .mockResolvedValueOnce(respond(sseFrame('panels', { panels: [] }), sseFrame('action_proposal', proposal),
        sseFrame('done', { outcome: 'proposal' })));
    const provider = createAssistantProvider({ fetcher });
    const onStatus = vi.fn();
    const first = await provider.ask({ ...ask(), onStatus });
    expect(onStatus).toHaveBeenCalledExactlyOnceWith({ step: 'accepted' });
    expect(first.clarification?.choices).toEqual(price.choices);
    const second = await provider.ask({ ...ask(), continuation: { clarificationId: first.clarification!.id, price: 6730 } });
    expect(second.proposal?.preview.after).toMatchObject({ name: '동백 라테', price: 6730 });
    const [, request] = fetcher.mock.calls[1];
    expect(new Headers(request.headers).get('X-Navis-Protocol')).toBe('agent-v1');
    expect(JSON.parse(request.body)).toMatchObject({ slots: ['name', 'price'], snapshot: [], intent: { kind: 'menu.create', category: 'drink' } });
    expect(request.body).not.toMatch(/동백|6730/);
  });

  it('rejects a scoped proposal for a similar existing menu even when it carries a valid price', async () => {
    const store = createWidgetDataStore(undefined, { runId: 'near-duplicate-test' });
    const before = store.getSnapshot();
    const fetcher = vi.fn().mockResolvedValue(respond(
      sseFrame('panels', { panels: [] }), sseFrame('action_proposal', proposal),
      sseFrame('done', { outcome: 'proposal' }),
    ));
    const reply = await createAssistantProvider({ store, fetcher }).ask({
      ...ask(), text: '캬라멜 마키야또 5,500원에 메뉴에 넣어줘',
    });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).searches).toEqual([
      { kind: 'menu', querySlot: 'name', matches: [{ handle: expect.any(String), match: 'similar' }] },
    ]);
    expect(reply.turn).toMatchObject({ kind: 'refusal', reason: 'duplicate' });
    expect(reply.proposal).toBeUndefined();
    expect(store.getSnapshot()).toBe(before);
  });

  it('ignores invalid proposal and unsolicited action_result frames', async () => {
    const provider = createAssistantProvider({ fetcher: vi.fn().mockResolvedValue(respond(
      sseFrame('panels', { panels: [] }), sseFrame('action_proposal', { ...proposal, args: { ...proposal.args, price: 5500 } }),
      sseFrame('action_result', { proposalId: 'remote', outcome: 'applied', revision: 1 }),
      sseFrame('done', { outcome: 'proposal' }),
    )) });
    const reply = await provider.ask({ ...ask(), text: '메뉴에 동백 라테를 5,500원에 추가해줘' });
    expect(reply.proposal).toBeUndefined();
    expect(reply.clarification).toBeUndefined();
  });

  it('offers manual entry when the write endpoint does not negotiate agent-v1', async () => {
    const fetcher = vi.fn().mockResolvedValue(replyResponse({ answer: 'Legacy write answer', panels: [] }));
    const reply = await createAssistantProvider({ fetcher }).ask(ask());
    expect(reply.answer).toContain('메뉴 관리');
    expect(reply.proposal).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

it('asks for a real name and keeps the parsed price in the browser', async () => {
  const fetcher = vi.fn();
  const provider = createAssistantProvider({ fetcher });
  const reply = await provider.ask({ text: '5,500원짜리 메뉴 하나 추가해줘', signal: signal() });
  expect(reply.answer).toContain('이름');
  expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'name' });
  expect(reply.proposal).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it('asks again for a positive price when the user explicitly gives zero', async () => {
  const fetcher = vi.fn();
  const reply = await createAssistantProvider({ fetcher }).ask({ text: '메뉴에 쿠키 0원에 추가해줘', signal: signal() });
  expect(reply.clarification?.field).toBe('price');
  expect(reply.proposal).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it('keeps an outbound draft local and refuses without contacting the model', async () => {
  const fetcher = vi.fn();
  const reply = await createAssistantProvider({ fetcher }).ask({ text: '단골한테 "이번 주 휴무" 문자 보내줘', signal: signal() });
  expect(reply.turn).toMatchObject({ kind: 'refusal', reason: 'widget_only', alternative: {
    featureId: 'notice-send', command: 'notice.send', draft: { body: '이번 주 휴무' },
  } });
  expect(fetcher).not.toHaveBeenCalled();
});

it('grounds a menu-count answer and shows the exact typed read transcript', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response([
    sseFrame('text_delta', { delta: '99개예요.' }),
    sseFrame('panels', { panels: [] }),
    sseFrame('done', { outcome: 'reply' }),
  ].join(''), { headers: { 'X-Navis-Protocol': 'agent-v1' } }));
  const reply = await createAssistantProvider({ fetcher }).ask({ text: '메뉴 몇 개 등록돼 있어?', signal: signal() });
  const count = selectMenus(cafeSnapshot, {}).rows.length;
  expect(reply.answer).toContain(`${count}개`);
  expect(reply.answer).not.toContain('99');
  expect(reply.turn).toMatchObject({ kind: 'read', evidence: [{ tool: 'get_widget', args: { featureId: 'menu', condition: { kind: 'default' } }, status: 'ready' }] });
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
    intent: { kind: 'read', featureId: 'menu', condition: { kind: 'default' } },
    snapshot: [{ featureId: 'menu', facts: [expect.objectContaining({ key: 'menu.count', value: count })] }],
  });
});

it('offers only verified similar-menu choices', async () => {
  const choices = selectMenus(cafeSnapshot, {}).rows.flatMap((row, index) =>
    row.name && 'raw' in row.name && /라[떼테]/u.test(row.name.raw) ? [{ id: `menu-${index}`, label: row.name.raw }] : [],
  ).slice(0, 5);
  expect(choices).toHaveLength(5);
  const fetcher = vi.fn().mockResolvedValue(new Response([
    sseFrame('panels', { panels: [] }),
    sseFrame('done', { outcome: 'ambiguous', clarification: {
      field: 'name', promptKey: 'record.choose', recordKind: 'menu', querySlot: 'name',
      choices: [{ id: choices[0].id, handle: choices[0].id, label: '잘못된 이름' }, { id: 'invalid', handle: 'invalid' }],
    } }),
  ].join(''), { headers: { 'X-Navis-Protocol': 'agent-v1' } }));
  const reply = await createAssistantProvider({ fetcher }).ask({ text: '라테 얼마야?', signal: signal() });
  expect(reply.turn).toMatchObject({ kind: 'ambiguity', choices });
});

it('offers one authorized clarification and supplies the selected enum for a generic command', async () => {
  const headers = { 'X-Navis-Protocol': 'agent-v1' };
  const response = (done: unknown) => new Response(sseFrame('panels', { panels: [] }) + sseFrame('done', done), { headers });
  const fetcher = vi.fn().mockResolvedValueOnce(response({ outcome: 'clarify', clarification: {
    command: 'inventory.createItem', field: 'unit', promptKey: 'inventory.unit',
    choices: [{ id: 'bogus', value: 'bogus' }, { id: 'kg', value: 'kg' }],
  } })).mockResolvedValueOnce(response({ outcome: 'refused' }));
  const provider = createAssistantProvider({ fetcher });
  const intent = { kind: 'command', command: 'inventory.createItem', args: { sku: { slot: 'sku' }, name: { slot: 'name' } } } as const;
  const result = await provider.ask({
    text: '재료를 추가해줘', signal: signal(), agentTurn: { intent, slots: { sku: 'private-1', name: '비공개 재료' } },
  });
  expect(result.turn).toMatchObject({ kind: 'clarification', field: 'unit', choices: [{ id: 'kg', label: 'kg' }] });
  if (result.turn?.kind !== 'clarification') throw new Error('Clarification missing');
  await provider.ask({ text: '재료를 추가해줘', signal: signal(), continuation: { clarificationId: result.turn.id, choiceId: 'kg' } });
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ intent: { args: { unit: 'kg' } } });
  expect(fetcher.mock.calls[1][1].body).not.toMatch(/private-1|비공개 재료/);
});
