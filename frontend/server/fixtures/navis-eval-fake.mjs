import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';

// Deterministic fake upstream for the default evaluation; no network.
export function clovaMessageError(messages) {
  if (Array.isArray(messages) && messages.length === 2 && ['system', 'user'].every((role, index) => {
    const message = messages[index];
    return message?.role === role && typeof message.content === 'string' && message.content.trim() !== '';
  })) return null;
  return Response.json({ status: { code: '40001', message: 'Invalid parameter: messages' } }, { status: 400 });
}

export function createNavisEvalFake(fixture) {
  const frame = (event, data) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
  const facts = fixture.snapshot.flatMap(entry => entry.facts ?? []);
  const fact = facts.find(item => item.key === 'ledger.sales.net') ?? facts[0];
  const supplierFailures = new WeakSet();
  const widgetIds = new Map([
    ['재고 위젯 추가해줘', ['inventory-booking']],
    ['대시보드에 매출이랑 재고 올려줘', ['ledger', 'inventory-booking']],
    ['뭐 추가하면 좋아?', ['ledger', 'inventory-booking']],
    ['예약 패널 놔줘', ['voice-booking']],
  ]);
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const messageError = clovaMessageError(body?.messages);
    if (messageError) return messageError;
    const question = body.messages[1].content.split('\n')[0].slice('질문: '.length);
    let output;
    if (body.tools) {
      const candidates = fixture.catalog.filter(item => fixture.snapshot.some(source => source.featureId === item.id && source.facts?.length));
      const selected = widgetIds.get(question) ?? candidates.slice(0, 1).map(item => item.id);
      const panels = selected.flatMap(id => {
        const entry = candidates.find(item => item.id === id);
        return entry ? [{ featureId: id, condition: entry.conditions[0], reason: '현재 자료를 확인해요.', size: { width: 2, height: 1 } }] : [];
      });
      output = frame('result', { message: { role: 'assistant', content: '', toolCalls: [{ type: 'function', function: { name: 'select_panels', arguments: { panels } } }] }, finishReason: 'tool_calls' });
    } else {
      const out = /지시.*무시|시스템 프롬프트/u.test(question);
      const repair = body.messages[0].content.includes('자료에 있는 숫자와 위젯 이름이 들어간 문장만 쓰세요.');
      let text = out ? '[OUT]\n이 글은 보내면 안 돼요.' :
        `[IN] 앱 안내\n몇 가지 방법은 다음과 같습니다:\n1. 일반적인 조언이에요.\n이러한 방법을 참고해요.\n` +
        `현재 ${fact.label}은 ${fact.display}이며, 가게 자료에 기록된 표시값을 그대로 확인할 수 있어요.\n\n\n자료\n손익 위젯에서 현재 가게의 매출 자료를 확인할 수 있어요.`;
      const booking = facts.find(item => item.key === 'booking.today.count');
      const menu = facts.find(item => item.key === 'menu.cost');
      if (question === 'How much revenue did we make today?') text = `[IN]\nToday's revenue is ${fact.display}.`;
      if (question === '오늘 예약 몇 건이야?' && booking) text = `[OUT]\n 오늘 예약은 ${booking.display}이에요. 예약 위젯에서 확인해요.`;
      if (question === '이번 주 예약 몇 건 있어?') text = '[OUT]\n이번 주 전체 예약 건수 자료가 없어요. 예약 위젯에서 예약 일정을 확인해요.';
      if (question === '알바 급여는 얼마야?') text = '[OUT]\n 개별 알바 급여 자료는 없어요. 손익 위젯에서 기간별 인건비를 확인해요.';
      if (question === 'CCTV 상태 괜찮아?') text = '[IN]\nCCTV 상태 자료는 없어요. 네이버에서 검색해요. 다른 앱을 설치해요.';
      if ((question === '가격 올려도 될까?' || question === '신메뉴 아이디어 좀 줘') && menu) {
        text = `[IN]\n메뉴 추가는 관리 > 상품 > 메뉴 관리에서 할 수 있어요. ${menu.label} 원가는 **${menu.display}**이에요. 메뉴 위젯에서 원가를 확인해요.`;
      }
      if (question === '경쟁 카페는 어떻게 해?') text = '[IN]\n일반적인 사업 조언은 하지 않아요. SNS나 블로그를 쓰세요. 경쟁 카페 자료는 없어요. 손익 위젯에서 가게 매출을 확인해요.';
      if (question === '내일 손님 얼마나 와?') text = repair ? '[IN]\n내일 방문객 예측 자료가 없어요.' : '[IN]\n내일은 평소보다 더 붐빌 것 같아요.';
      if (question === '매출 올리는 법 알려줘') text = repair ? `[IN]\n오늘 매출은 ${fact.display}이에요. 손익 위젯에서 기간별 매출을 확인해요.` : '[IN]\n분위기를 개선하고 이벤트를 기획해요.';
      if (question === '재고 위젯 추가해줘') text = '[IN]\n재고 위젯 추가는 앱 내에서 직접 할 수 없습니다. 재고 위젯에서 보충 기준을 확인해요.';
      else if (widgetIds.has(question)) text = '[IN]\n분위기를 개선하고 이벤트를 기획해요.';
      if (question === '이번 주 들어올 물건 뭐야?') {
        if (!supplierFailures.has(options.signal)) { supplierFailures.add(options.signal); return new Response('', { status: 503 }); }
        const delivery = facts.find(item => item.key === 'suppliers.delivery');
        if (delivery) text = `[IN]\n${delivery.label}: ${delivery.display} 예정이에요. 발주 위젯에서 확인해요.`;
      }
      output = frame('token', { message: { role: 'assistant', content: text } }) + frame('result', { message: { role: 'assistant', content: text }, finishReason: 'stop' });
    }
    return new Response(output, { headers: { 'content-type': 'text/event-stream' } });
  };
}

// The agent mock goes through the native v3 SSE parser without a key or
// network access. It responds only to the filtered intent and tool results.
export async function navisAgentFakeFetch(_url, options) {
  const { messages, toolChoice } = JSON.parse(options.body);
  const { intent, slots, readings, activeBoard, preparedProposal, nextLookup, lookupIndex, toolHistory } = JSON.parse(messages[1].content);
  const transcript = toolHistory ?? messages;
  const readResult = transcript.at(-1).role === 'tool' ? JSON.parse(transcript.at(-1).content) : null;
  // N04 reads must observe the menu handle before using it in a scoped tool.
  const menuRead = intent.kind === 'read' && ['get_recipe', 'simulate_menu_price'].includes(intent.tool)
    ? readings?.find(reading => reading.tool === intent.tool) : undefined;
  const querySlot = intent.querySlot ?? (menuRead && slots.includes('name') ? 'name' : undefined);
  // N10 calendar/staff scoped reads use the selected period and optional exact record.
  const calendarStaffRead = intent.kind === 'read' && ['calendar', 'staff-schedule'].includes(intent.featureId);
  const calendarStaffTarget = calendarStaffRead && querySlot && ['event', 'staff', 'shift'].includes(intent.recordKind);
  // End N10 calendar/staff read scope.
  // N15 resolves stored draft handles before reading their pure preview.
  const noticeRead = intent.kind === 'read' && (intent.featureId === 'notice-send' || intent.tool === 'notice.preview');
  const noticePreview = noticeRead && intent.tool === 'notice.preview'
    ? readings?.find(reading => reading.tool === 'notice.preview') : undefined;
  const noticeLookup = noticePreview?.args.noticeId && slots.includes('noticeQuery')
    ? { kind: 'noticeDraft', querySlot: 'noticeQuery' }
    : noticeRead && querySlot && ['noticeDraft', 'noticeSent', 'event'].includes(intent.recordKind)
      ? { kind: intent.recordKind, querySlot } : undefined;
  // End N15 read scope.
  // N16 reads the stock handle before running its projected discount estimate.
  const couponRead = intent.kind === 'read' && ['slot-coupon', 'expiry-coupon', 'coupon-status'].includes(intent.featureId);
  const expiryCalculation = intent.kind === 'read' && intent.tool === 'calc_expiry_discount';
  const expiryReading = expiryCalculation ? readings?.find(reading => reading.tool === intent.tool) : undefined;
  const expiryQuery = [querySlot, 'itemQuery', 'stockQuery', 'name'].find(slot => slots.includes(slot));
  const couponLookup = couponRead && !intent.tool && querySlot && ['coupon', 'couponCode', 'slot'].includes(intent.recordKind);
  // End N16 read scope.
  // N17 reads exact reply or offer records inside the projected widget scope.
  const repliesRead = intent.kind === 'read' && ['ai-response', 'community'].includes(intent.featureId);
  const repliesLookup = repliesRead && querySlot && ['thread', 'offer'].includes(intent.recordKind);
  // End N17 read scope.
  const call = (name, args) => ({
    message: { role: 'assistant', content: '', toolCalls: [
      { id: options.headers?.['X-NCP-CLOVASTUDIO-REQUEST-ID'] ?? `fake-agent-${lookupIndex ?? messages.length}`,
        type: 'function', function: { name, arguments: args } },
    ] },
    finishReason: 'tool_calls',
  });
  let result;
  if (nextLookup && toolChoice?.function?.name === nextLookup.name) result = call(nextLookup.name, nextLookup.args);
  else if (intent.kind === 'read' && intent.reads) {
    const groups = new Map();
    for (const message of transcript.filter(message => message.role === 'tool')) {
      const refs = (JSON.parse(message.content).facts ?? []).map(fact => fact.ref);
      if (refs.length) groups.set(refs[0], refs);
    }
    const facts = [];
    let remaining = groups.size;
    for (const group of groups.values()) {
      // Keep one citation available for each later source under the reply limit.
      remaining--;
      facts.push(...group.slice(0, 12 - facts.length - remaining));
    }
    result = { message: { role: 'assistant', content: JSON.stringify({ outcome: 'reply', facts }) }, finishReason: 'stop' };
  }
  else if (toolChoice?.function?.name === 'search_records') result = call('search_records', { kind: 'menu', querySlot: 'name' });
  else if (toolChoice?.function?.name === 'propose_action') result = call('propose_action', preparedProposal ?? {
    command: 'menu.create',
    args: { name: { slot: 'name' }, category: intent.category, price: { slot: 'price' }, ...(slots.includes('memo') ? { memo: { slot: 'memo' } } : {}) },
  });
  else if (intent.kind === 'read' && intent.featureId === 'suppliers' && intent.recordKind === 'purchaseItem' && querySlot
    && (!readResult || readResult.matches?.some(match => match.match === 'exact'))) {
    result = readResult
      ? call('get_widget', { featureId: 'suppliers', condition: intent.condition ?? { kind: 'default' } })
      : call('search_records', { kind: 'purchaseItem', querySlot });
  }
  // N10 observes the record before reading its factual period projection.
  else if (calendarStaffTarget && (!readResult || readResult.matches?.some(match => match.match === 'exact'))) {
    result = readResult
      ? call('get_widget', { featureId: intent.featureId, condition: intent.condition ?? { kind: 'default' } })
      : call('search_records', { kind: intent.recordKind, querySlot });
  }
  // End N10 named calendar/staff reads.
  // N15 issues a preview tool only with its projected args and observed draft handle.
  else if (noticeLookup && !readResult) {
    result = call('search_records', noticeLookup);
  } else if (noticePreview && (!noticePreview.args.noticeId && !readResult
    || readResult?.matches?.some(match => match.handle === noticePreview.args.noticeId?.handle))) {
    result = call('notice.preview', noticePreview.args);
  } else if (noticeRead && !intent.tool && intent.featureId && readResult?.matches?.some(match => match.match === 'exact')) {
    result = call('get_widget', { featureId: intent.featureId, condition: intent.condition ?? { kind: 'default' } });
  }
  // End N15 notice reads.
  // N16 observes the requested record before citing its scoped projection.
  else if (expiryCalculation) {
    if (expiryReading && !readResult && expiryQuery) {
      result = call('search_records', { kind: 'stock', querySlot: expiryQuery });
    } else if (expiryReading && readResult?.matches?.some(match => match.handle === expiryReading.args.itemId.handle)) {
      result = call('calc_expiry_discount', expiryReading.args);
    }
  } else if (couponLookup && (!readResult || readResult.matches?.some(match => match.match === 'exact'))) {
    result = readResult
      ? call('get_widget', { featureId: intent.featureId, condition: intent.condition ?? { kind: 'default' } })
      : call('search_records', { kind: intent.recordKind, querySlot });
  }
  // End N16 scoped coupon reads.
  // N17 reads the selected widget first, then establishes any named record scope.
  else if (repliesLookup && readResult?.featureId === intent.featureId) {
    result = call('search_records', { kind: intent.recordKind, querySlot });
  }
  // End N17 reply and offer lookups.
  else if (!readResult && intent.kind === 'read' && (intent.featureId || intent.sourceId)) {
    result = intent.featureId
      ? call('get_widget', { featureId: intent.featureId, condition: intent.condition ?? { kind: 'default' } })
      : call('get_source', { sourceId: intent.sourceId, condition: intent.condition ?? { kind: 'default' } });
  } else if (!readResult && intent.kind === 'read' && (intent.recordKind || menuRead) && querySlot) {
    result = call('search_records', { kind: intent.recordKind ?? 'menu', querySlot });
  } else if (menuRead && readResult?.matches?.some(match => match.handle === (menuRead.args.menu ?? menuRead.args.menuId).handle)) {
    result = call(menuRead.tool, menuRead.args);
  } else if (!readResult && intent.kind === 'read' && intent.tool && !menuRead) {
    const projected = readings?.find(reading => reading.tool === intent.tool);
    if (projected) result = call(intent.tool, projected.args);
    else if (intent.tool === 'get_board') result = call(intent.tool, { layer: activeBoard });
    else if (intent.tool === 'get_ui_state' || intent.tool === 'get_closing_state') result = call(intent.tool, {});
  }
  // N20 cites the scoped sample, source and period facts from local intelligence.
  if (!result && intent.kind === 'read' && ['local-changes', 'trade-area', 'local-trends'].includes(intent.featureId)) {
    const facts = (readResult?.facts ?? []).slice(0, 12).map(fact => fact.ref);
    result = { message: { role: 'assistant', content: JSON.stringify({ outcome: 'reply', facts }) }, finishReason: 'stop' };
  }
  // End N20 local intelligence facts.
  // N17 cites the projected reply or offer facts after any scoped lookup.
  if (!result && repliesRead) {
    const widgetRead = messages.filter(message => message.role === 'tool')
      .map(message => JSON.parse(message.content)).find(output => output.featureId === intent.featureId);
    const facts = (widgetRead?.facts ?? []).slice(0, 12).map(fact => fact.ref);
    result = { message: { role: 'assistant', content: JSON.stringify({ outcome: 'reply', facts }) }, finishReason: 'stop' };
  }
  // End N17 fact citations.
  // N18 cites the selected promotion projection, including the bounded reference list.
  if (!result && intent.kind === 'read' && (
    ['promo-video', 'customer-groups', 'marketing-today'].includes(intent.featureId)
    || ['promo-estimate', 'promo-references'].includes(intent.sourceId)
  )) {
    const facts = (readResult?.facts ?? []).slice(0, 12).map(fact => fact.ref);
    result = { message: { role: 'assistant', content: JSON.stringify({ outcome: 'reply', facts }) }, finishReason: 'stop' };
  }
  // End N18 promotion reads.
  // N19 cites only the requested browser-projected operations facts.
  if (!result && intent.kind === 'read' && ['briefing', 'customer-analysis', 'store-environment'].includes(intent.featureId)) {
    const facts = (readResult?.facts ?? []).slice(0, 12).map(fact => fact.ref);
    result = { message: { role: 'assistant', content: JSON.stringify({ outcome: 'reply', facts }) }, finishReason: 'stop' };
  }
  // End N19 operations reads.
  if (!result) {
    const inventoryHistory = intent.kind === 'read' && intent.featureId === 'inventory-booking'
      && intent.condition?.kind === 'dateRange';
    const settingsRead = intent.kind === 'read' && ['get_ui_state', 'get_closing_state'].includes(intent.tool);
    const supplierRead = intent.kind === 'read' && intent.featureId === 'suppliers';
    // N11 ledger and tax list reads return their scoped rows.
    const moneyRead = intent.kind === 'read' && ['ledger', 'tax'].includes(intent.featureId);
    // End N11 ledger and tax list reads.
    // N12 member grades and credit history cite the scoped selector rows.
    const memberRead = intent.kind === 'read' && ['members', 'credit-receivable'].includes(intent.featureId);
    // End N12 member and credit reads.
    // N14 cites the scoped manual steps or grant details returned by the tool.
    const manualsGrantsRead = intent.kind === 'read' && ['manuals', 'grants'].includes(intent.featureId);
    // End N14 manuals and grant reads.
    const factLimit = memberRead || manualsGrantsRead ? 12 : menuRead || settingsRead || supplierRead || moneyRead || calendarStaffRead /* N10 */ || intent.tool === 'get_board' ? 12 : inventoryHistory ? 7 : 3;
    // N13 cites scoped order, pickup and template facts returned by the widget.
    const customRead = intent.kind === 'read' && intent.featureId === 'custom-order';
    const reply = intent.kind === 'menu.create' ? { outcome: 'clarify', field: 'price' }
      : { outcome: 'reply', facts: (readResult?.facts ?? []).map(fact => fact.ref).slice(0, customRead || couponRead || expiryCalculation ? 12 : factLimit) }; // N16 coupon facts.
    result = { message: { role: 'assistant', content: JSON.stringify(reply) }, finishReason: 'stop' };
  }
  return new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

/** A deterministic native-tool script for corpus tests. */
export function createNavisContractFake(calls, reply = { outcome: 'reply', facts: [] }) {
  const requests = [];
  async function fetchImpl(_url, options) {
    const request = JSON.parse(options.body);
    const index = requests.push(request) - 1;
    const call = calls[index];
    const result = call ? {
      message: { role: 'assistant', content: '', toolCalls: [{
        id: `fixture-${index}`, type: 'function', function: { name: call.name, arguments: call.args },
      }] },
      finishReason: 'tool_calls',
    } : { message: { role: 'assistant', content: JSON.stringify(reply) }, finishReason: 'stop' };
    return new Response(`event: result\ndata: ${JSON.stringify(result)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  return { fetchImpl, requests };
}

// N06 runs the agent bridge in process against explicitly scripted booking tool calls.
export async function runNavisBookingFixture(createBridge, validateAgentFrame, input, calls = [], reply) {
  const { fetchImpl, requests } = createNavisContractFake(calls, reply);
  const bridge = createBridge({ agentFetchImpl: fetchImpl });
  try {
    const req = Readable.from([Buffer.from(JSON.stringify(input))]);
    Object.assign(req, { method: 'POST', url: '/api/navis/chat', socket: { localAddress: '127.0.0.1', localPort: 5211 }, headers: {
      host: '127.0.0.1:5211', origin: 'http://127.0.0.1:5211', 'content-type': 'application/json', 'x-navis-protocol': 'agent-v1',
    } });
    let raw = '', status;
    const res = new Writable({ write(chunk, _encoding, next) { raw += chunk; next(); } });
    res.writeHead = code => { status = code; };
    const finished = new Promise(resolve => res.once('finish', resolve));
    await bridge(req, res);
    await finished;
    assert.equal(status, 200, raw);
    const frames = [...raw.matchAll(/event: ([^\n]+)\ndata: (.+)\n\n/gu)].map(([, event, data]) => ({ event, data: JSON.parse(data) }));
    assert.ok(frames.every(({ event, data }) => validateAgentFrame(event, data)), raw);
    assert.equal(frames.at(-1)?.event, 'done', raw);
    for (const [index, call] of calls.entries()) {
      const request = requests[index];
      assert.ok(request?.tools.some(tool => tool.function.name === call.name), `Missing booking tool at step ${index + 1}`);
    }
    return { frames, requests, done: frames.at(-1).data, proposal: frames.find(frame => frame.event === 'action_proposal')?.data,
      text: frames.filter(frame => frame.event === 'text_delta').map(frame => frame.data.delta).join('') };
  } finally {
    bridge.close();
  }
}

/** N04 exercises the same in-process agent endpoint with menu proposals enabled. */
export function createNavisMenuHarness(createBridge, validateAgentFrame, transport = navisAgentFakeFetch) {
  const calls = [];
  const bridge = createBridge({
    fetchImpl: () => assert.fail('N04 reached the legacy transport'),
    async agentFetchImpl(url, options) {
      const response = await transport(url, options);
      const event = (await response.clone().text()).split('\n').find(line => line.startsWith('data: '));
      const call = JSON.parse(event.slice(6)).message.toolCalls?.[0]?.function;
      if (call) calls.push({ name: call.name, args: call.arguments });
      return response;
    },
  });
  return {
    close: () => bridge.close(),
    async run(input) {
      const start = calls.length;
      const req = Readable.from([Buffer.from(JSON.stringify(input))]);
      Object.assign(req, { method: 'POST', url: '/api/navis/chat', socket: { localAddress: '127.0.0.1', localPort: 5211 }, headers: {
        host: '127.0.0.1:5211', origin: 'http://127.0.0.1:5211', 'content-type': 'application/json', 'x-navis-protocol': 'agent-v1',
      } });
      let raw = '', status;
      const res = new Writable({ write(chunk, _encoding, next) { raw += chunk; next(); } });
      res.writeHead = code => { status = code; };
      const finished = new Promise(resolve => res.once('finish', resolve));
      await bridge(req, res);
      await finished;
      if (status !== 200) return { status, raw, calls: calls.slice(start) };
      const frames = [...raw.matchAll(/event: ([^\n]+)\ndata: (.+)\n\n/gu)]
        .map(([, event, data]) => [event, JSON.parse(data)]);
      assert.ok(frames.every(([event, data]) => validateAgentFrame(event, data)), raw);
      assert.ok(['done', 'error'].includes(frames.at(-1)?.[0]), raw);
      return {
        status, calls: calls.slice(start), terminal: frames.at(-1)[1], raw,
        proposal: frames.find(([event]) => event === 'action_proposal')?.[1],
        answer: frames.filter(([event]) => event === 'text_delta').map(([, { delta }]) => delta).join(''),
      };
    },
  };
}

// N03 in-process HTTP fixture. Navigation and policy turns never call upstream.
export const defaultCondition = { kind: 'default' };
const { cutoff: { businessDate } } = JSON.parse(readFileSync(new URL('../../src/data/db/generated/manifest.json', import.meta.url), 'utf8'));
const catalog = [
  ['menu', 'management'], ['inventory-booking', 'management'], ['tax', 'management'],
  ['slot-coupon', 'marketing'], ['notice-send', 'marketing'], ['promo-video', 'marketing'],
].map(([id, layer]) => ({ id, layer, name: id, conditions: [defaultCondition] }));

export function navigationRequest(command, args, extra = {}) {
  return {
    runId: 'fixture-run', snapshotRevision: 7, layer: 'management', page: 1, businessDate,
    slots: [], catalog, snapshot: [], searches: [], intent: { kind: 'command', command, args }, ...extra,
  };
}

export function reading(tool, args, values) {
  return { tool, args, facts: Object.entries(values).map(([key, value]) => ({
    key, value: typeof value === 'boolean' ? Number(value) : value, unit: '', label: key, display: String(value),
  })) };
}

export function createNavisNavigationHarness(createBridge, validateAgentFrame, agentFetchImpl = () => assert.fail('navigation reached the upstream transport')) {
  const bridge = createBridge({ agentFetchImpl });
  return {
    close: () => bridge.close(),
    async run(input) {
      const req = Readable.from([Buffer.from(JSON.stringify(input))]);
      Object.assign(req, { method: 'POST', url: '/api/navis/chat', socket: { localAddress: '127.0.0.1', localPort: 5211 }, headers: {
        host: '127.0.0.1:5211', origin: 'http://127.0.0.1:5211', 'content-type': 'application/json', 'x-navis-protocol': 'agent-v1',
      } });
      let raw = '', status;
      const res = new Writable({ write(chunk, _encoding, next) { raw += chunk; next(); } });
      res.writeHead = code => { status = code; };
      const finished = new Promise(resolve => res.once('finish', resolve));
      await bridge(req, res);
      await finished;
      assert.equal(status, 200, raw);
      const frames = [...raw.matchAll(/event: ([^\n]+)\ndata: (.+)\n\n/gu)].map(([, event, data]) => ({ event, data: JSON.parse(data) }));
      assert.equal(frames.at(-1)?.event, 'done');
      assert.equal(frames.some(({ event }) => ['action_proposal', 'action_result'].includes(event)), false);
      assert.ok(frames.every(({ event, data }) => validateAgentFrame(event, data)));
      return frames.at(-1).data;
    },
  };
}
