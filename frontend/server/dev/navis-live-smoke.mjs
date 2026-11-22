import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL, URL } from 'node:url';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { AGENT_ERROR_CODES, AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame } from '../../shared/navis-agent-schema.mjs';
import { createBridge } from '../bridge.mjs';

const businessDate = '2026-10-26';
const condition = { kind: 'default' };
const tokenFields = ['promptTokens', 'completionTokens', 'totalTokens'];
const metricsPrefix = ': navis-metrics ';
const maxCalls = 60;
const models = new Set(['HCX-005', 'HCX-007']);
const usage = 'Usage: node server/dev/navis-live-smoke.mjs --preview [--only id,id] [--max-provider-calls 1..60]';

const slot = slot => ({ slot });
const handle = handle => ({ handle });
const widget = (id, name, layer) => ({ id, name, layer, conditions: [condition] });
const fact = (key, value, unit, label, display) => ({ key, value, unit, label, display });

function read(featureId, name, key, value, unit, label, display, layer = 'management') {
  return {
    layer,
    intent: { kind: 'read', featureId, condition },
    catalog: [widget(featureId, name, layer)],
    snapshot: [{ featureId, condition, facts: [fact(key, value, unit, label, display)] }],
  };
}

function command(layer, featureId, name, command, args, projection = {}) {
  return { layer, catalog: [widget(featureId, name, layer)], intent: { kind: 'command', command, args }, ...projection };
}

function target(kind, querySlot, target, fields) {
  return { kind, querySlot, matches: [{ ...target, match: 'exact', fields }] };
}

function card(id, prompt, input, localValues) {
  const { command, args } = input.intent;
  return { id, prompt, input, expected: 'proposal', card: { command, args }, localValues };
}

function menuCreate(prompt) {
  const hasPrice = /\d+원/u.test(prompt);
  return { intent: { kind: 'menu.create', category: 'drink' }, slots: hasPrice ? ['name', 'price'] : ['name'],
    searches: [{ kind: 'menu', querySlot: 'name', matches: [] }] };
}

// Fixed utterances paired with their browser-side projections. The wire accepts
// typed intents and opaque slots, so neither utterances nor menu literals leave the script.
const readMenu = read('menu', '메뉴', 'menu.item.count', 7, 'item', '등록 메뉴', '7개');
const readAlerts = read('briefing', '브리핑', 'briefing.importantAlerts.count', 4, 'count', '중요 알림', '4건');
const readLocal = read('local-changes', '동네 변화', 'localChanges.open.count', 3, 'count', '확인하지 않은 동네 변화', '3건', 'marketing');
const noticeTime = '2026-10-27T08:00';
const itemId = handle('smoke-stock'), noticeId = handle('smoke-notice'), expenseId = handle('smoke-expense');
const videoId = handle('smoke-video'), threadId = handle('smoke-thread');
const cases = [
  { id: 'menu-read', prompt: '메뉴 몇 개 등록돼 있어?', input: readMenu, expected: 'reply', display: '7개' },
  { id: 'menu-create', prompt: '유자 에이드 5500원으로 메뉴에 추가해줘', input: menuCreate, expected: 'proposal',
    card: { command: 'menu.create', args: { category: 'drink', name: slot('name'), price: slot('price') } } },
  { id: 'menu-missing-price', prompt: '유자 에이드를 메뉴에 추가해줘', input: menuCreate, expected: 'clarify', field: 'price' },
  { id: 'unsupported', prompt: '화성 여행을 예약해줘', input: { intent: { kind: 'unsupported' } }, expected: 'refused', local: true },
  { id: 'panel-selection', prompt: '오늘 매출을 손익 위젯으로 보여줘',
    input: read('ledger', '손익', 'ledger.sales.net', 1284000, 'KRW', '오늘 매출', '128.4만 원'), expected: 'reply', panel: 'ledger' },
  { id: 'inventory-read', prompt: '보충이 필요한 재고가 몇 개야?',
    input: read('inventory-booking', '재고', 'inventory.restock.count', 3, 'item', '보충 필요', '3개'), expected: 'reply', display: '3개' },
  { id: 'booking-read', prompt: '오늘 예약 몇 건이야?',
    input: read('voice-booking', '예약', 'booking.today.count', 7, 'reservation', '오늘 예약', '7건'), expected: 'reply', display: '7건' },
  { id: 'cancel-stream', prompt: '등록된 메뉴 수를 알려줘', input: readMenu, expected: 'CANCELLED' },
  card('coupon-fixed-won', '바스크 치즈케이크 1,000원 할인 당일 소진 쿠폰 만들어줘',
    command('marketing', 'expiry-coupon', '당일 소진 쿠폰', 'coupon.createExpiry',
      { itemId, route: 'place_news', benefit: { kind: 'amount', value: slot('benefitValue') } }, {
        slots: ['itemQuery', 'benefitValue'],
        searches: [target('stock', 'itemQuery', itemId, { expiryEligible: true, expiryHandled: false })],
      }), { itemQuery: '바스크 치즈케이크', benefitValue: 1000 }),
  card('notice-night', '지금 밤 9시인데, 저장해 둔 임시 휴무 공지 보내줘',
    command('marketing', 'notice-send', '공지 발송', 'notice.send',
      { noticeId, draftRevision: slot('draftRevision'), sendAt: slot('sendAt') }, {
        slots: ['noticeQuery', 'draftRevision', 'sendAt'],
        searches: [target('noticeDraft', 'noticeQuery', noticeId,
          { kind: 'temporary_closure', revision: 1, businessTime: '21:00', sendAllowed: false, scheduleAllowed: true, closureLink: 'none', alreadySent: false })],
      }), { now: `${businessDate}T21:00`, noticeQuery: '임시 휴무', draftRevision: 1, sendAt: noticeTime }),
  card('expense-edit', '오늘 원두 매입 지출 금액을 42,000원으로 고쳐줘',
    command('management', 'ledger', '손익', 'ledger.updateExpense', { expenseId, amount: slot('amount') }, {
      slots: ['expenseQuery', 'amount'],
      searches: [target('expense', 'expenseQuery', expenseId, { date: businessDate, status: 'confirmed', closed: false })],
    }), { expenseQuery: '원두 매입', amount: 42000 }),
  { id: 'briefing-read', prompt: '오늘 브리핑의 중요 알림은 몇 건이야?', input: readAlerts, expected: 'reply', display: '4건', panel: 'briefing' },
  { id: 'local-changes-count', prompt: '오늘 예약 말고, 아직 확인 안 한 동네 변화는 몇 건이야?',
    input: { ...readLocal, catalog: [...readLocal.catalog, widget('voice-booking', '예약', 'management')],
      snapshot: [...readLocal.snapshot, ...read('voice-booking', '예약', 'booking.today.count', 7, 'reservation', '오늘 예약', '7건').snapshot] },
    expected: 'reply', display: '3건', panel: 'local-changes' },
  { id: 'cctv-live-availability', prompt: '지금 매장 입구 CCTV 실시간 화면 볼 수 있게 카메라 연결돼 있어?',
    input: read('customer-analysis', '고객 분석', 'cctv.camera.status', 'disconnected', '', '입구 카메라', '연결 끊김'),
    expected: 'reply', display: '연결 끊김', panel: 'customer-analysis' },
  card('promo-draft', '아메리카노 홍보 영상 초안은 따뜻한 분위기로 15초로 해줘',
    command('marketing', 'promo-video', 'AI 홍보 영상', 'promo.draft.set',
      { menuIds: slot('menuIds'), moods: slot('moods'), lengthSec: 15 }, { slots: ['menuIds', 'moods'] }),
    { menuIds: ['아메리카노'], moods: ['warm'] }),
  card('video-retry-failed', '실패한 아메리카노 홍보 영상 다시 만들어줘',
    command('marketing', 'promo-video', 'AI 홍보 영상', 'video.retry', { videoId }, {
      slots: ['videoQuery'], searches: [target('promoVideo', 'videoQuery', videoId, { status: 'failed' })],
      readings: [{ tool: 'get_promotion_preflight', args: { action: 'make' },
        facts: [fact('promo.video.busy', 0, 'count', '제작 중인 영상', '0건')] }],
    }), { videoQuery: '아메리카노 홍보 영상' }),
  // The browser does not authorize a retry target for a completed video.
  { id: 'video-retry-done', prompt: '완성된 아메리카노 홍보 영상 다시 만들어줘',
    input: command('marketing', 'promo-video', 'AI 홍보 영상', 'video.retry', {}),
    localValues: { videoStatus: 'done' }, expected: 'refused', local: true, refusal: 'widget_only',
    alternative: { featureId: 'promo-video', command: 'video.retry' } },
  card('review-reply-draft', '바스크 치즈케이크가 맛있다는 공개 리뷰에 답글 초안 만들어줘',
    command('marketing', 'ai-response', 'AI 답글', 'reply.draft', { threadId }, {
      slots: ['threadQuery'], searches: [target('thread', 'threadQuery', threadId,
        { type: 'review', isPublic: true, connected: true, status: 'waiting', revision: 1, canDraft: true })],
    }), { threadQuery: '바스크 치즈케이크 공개 리뷰' }),
  { id: 'expense-missing-amount', prompt: '오늘 원두값을 원재료비 지출로 기록해줘',
    input: command('management', 'ledger', '손익', 'ledger.recordExpense',
      { date: slot('date'), category: 'ingredients' }, { slots: ['date'] }),
    localValues: { date: businessDate }, expected: 'clarify', local: true, field: 'amount' },
  { id: 'pos-refund', prompt: '카드로 결제한 아메리카노 4,500원 환불해줘',
    input: { layer: 'pos', intent: { kind: 'command', command: 'pos.refund', args: { amount: slot('amount') } }, slots: ['amount'] },
    localValues: { amount: 4500 }, expected: 'refused', local: true, refusal: 'widget_only' },
];

const zeroTokens = () => Object.fromEntries(tokenFields.map(field => [field, 0]));
const knownCount = value => Number.isSafeInteger(value) && value >= 0;
const addTokens = (totals, values) => { for (const field of tokenFields) totals[field] += values[field] ?? 0; };

export function parseArgs(args) {
  if (args[0] !== '--preview') throw new Error(usage);
  const known = cases.map(test => test.id);
  const options = { only: known, maxProviderCalls: maxCalls };
  const seen = new Set();
  for (let index = 1; index < args.length; index += 2) {
    const [flag, value] = args.slice(index, index + 2);
    if (seen.has(flag) || !value) throw new Error(usage);
    seen.add(flag);
    if (flag === '--only') {
      const ids = value.split(',');
      if (new Set(ids).size !== ids.length || ids.some(id => !known.includes(id))) throw new Error(usage);
      options.only = ids;
    } else if (flag === '--max-provider-calls' && /^[1-9]\d*$/u.test(value) && Number(value) <= maxCalls) {
      options.maxProviderCalls = Number(value);
    } else throw new Error(usage);
  }
  return options;
}

function providerStop({ httpStatus, providerCode }) {
  if ([401, 403].includes(httpStatus) || /^(?:401|403)\d{2}$/u.test(providerCode)) return 'PROVIDER_AUTH';
  if (httpStatus === 429 || /^429\d{2}$/u.test(providerCode)) return 'PROVIDER_QUOTA';
  return null;
}

export function createProviderBudget(maxProviderCalls, fetchImpl = globalThis.fetch) {
  if (!Number.isSafeInteger(maxProviderCalls) || maxProviderCalls < 1 || maxProviderCalls > maxCalls) throw new Error(usage);
  let calls = 0, stopReason = null;
  const countedRequests = new Set();
  const invalidReasons = new Map();
  return {
    get calls() { return calls; },
    get stopReason() { return stopReason; },
    get exhausted() { return calls >= maxProviderCalls; },
    fetch(url, options) {
      if (calls >= maxProviderCalls) stopReason ??= 'PROVIDER_CALL_CAP';
      if (stopReason) return Promise.resolve(new globalThis.Response(null, { status: 503 }));
      calls++;
      const requestId = options?.headers?.['X-NCP-CLOVASTUDIO-REQUEST-ID'];
      if (requestId) countedRequests.add(requestId);
      return fetchImpl(url, options);
    },
    counted: id => countedRequests.has(id),
    observe(metric) {
      if (metric.event === 'navis_agent_provider_call' && countedRequests.has(metric.requestId)) stopReason ??= providerStop(metric);
      if (metric.event === 'navis_agent_turn' && /^[a-z][a-z0-9_]{0,79}$/u.test(metric.invalidReason ?? '')) {
        invalidReasons.set(metric.correlationId, metric.invalidReason);
      }
    },
    invalidReason: id => invalidReasons.get(id) ?? null,
  };
}

export function expectationFailure(test, row, { proposal, panels = [], text = '', terminal }, model) {
  if (row.outcome !== test.expected) {
    return AGENT_ERROR_CODES.includes(row.outcome) || /^[A-Z_0-9]+$/u.test(row.outcome) ? row.outcome : 'WRONG_OUTCOME';
  }
  if (!row.model || !row.correlationId) return 'MISSING_DIAGNOSTICS';
  if (model && row.model !== model) return 'WRONG_MODEL';
  if (test.local ? row.providerCalls !== 0 : row.providerCalls === 0) return 'WRONG_PROVIDER_CALL_COUNT';
  if (row.unreportedCalls && test.expected !== 'CANCELLED') return 'MISSING_TOKEN_USAGE';
  if (!test.card ? proposal : proposal?.command !== test.card.command || !isDeepStrictEqual(proposal.args, test.card.args)
    || proposal.tier !== 'normal') return 'WRONG_CARD';
  if (test.panel && !panels.includes(test.panel)) return 'WRONG_PANEL';
  if (test.display && !text.includes(test.display)) return 'WRONG_FACT';
  if (test.field && terminal?.clarification?.field !== test.field) return 'WRONG_CLARIFICATION';
  if (test.refusal && terminal?.refusal?.reason !== test.refusal) return 'WRONG_REFUSAL';
  if (test.alternative) {
    const route = terminal?.handoff ?? terminal?.refusal?.alternative;
    if (route?.featureId !== test.alternative.featureId || route.command !== test.alternative.command) return 'WRONG_HANDOFF';
  }
  return null;
}

async function ask(endpoint, test, { model: expectedModel, budget }) {
  const started = performance.now();
  const callsBefore = budget?.calls ?? 0;
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort('TIMEOUT'), 32_000);
  const input = typeof test.input === 'function' ? test.input(test.prompt) : test.input;
  const row = { promptId: test.id, expected: test.expected, outcome: 'INCOMPLETE_STREAM', model: null, mode: null, correlationId: null,
    tokens: zeroTokens(), latencyMs: 0, retries: 0, providerCalls: 0, unreportedCalls: 0, providerErrors: [], incomplete: false, ok: false };
  let text = '', panels = [], proposal, terminal, reportedCalls = 0;
  try {
    const response = await globalThis.fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', origin: endpoint.origin, 'sec-fetch-site': 'same-origin',
        [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL, 'x-navis-diagnostics': '1' },
      body: JSON.stringify({ runId: randomUUID(), snapshotRevision: 0, locale: 'ko', layer: 'management', businessDate,
        catalog: [], snapshot: [], slots: [], searches: [], ...input }),
    });
    if (!response.ok) {
      row.outcome = response.status === 503 ? 'UNAVAILABLE' : `HTTP_${response.status}`;
      await response.body?.cancel();
      return row;
    }
    if (response.headers.get('x-navis-agent-mode') !== 'live') {
      row.outcome = 'LIVE_MODE_REQUIRED';
      await response.body?.cancel();
      return row;
    }
    row.mode = 'live';
    const model = response.headers.get('x-navis-agent-model') ?? '';
    if (/^(?:HCX|DASH)-[A-Za-z0-9-]{1,48}$/u.test(model)) row.model = model;
    const correlationId = response.headers.get('x-navis-correlation-id') ?? '';
    if (/^[0-9a-f-]{36}$/u.test(correlationId)) row.correlationId = correlationId;
    if (response.headers.get(AGENT_PROTOCOL_HEADER) !== AGENT_PROTOCOL || !response.body) return row;

    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '', bytes = 0;
    stream: for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 256 * 1024) throw new Error('Stream exceeds limit');
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        if (frame.startsWith(metricsPrefix)) {
          const metric = JSON.parse(frame.slice(metricsPrefix.length));
          if (metric.event !== 'navis_agent_provider_call' || metric.correlationId !== row.correlationId) continue;
          if (budget && !budget.counted(metric.requestId)) continue;
          row.providerCalls++;
          const stop = providerStop(metric);
          if (metric.retries === 1) row.retries++;
          const tokens = Object.fromEntries(tokenFields.map(field => [field, knownCount(metric[field]) ? metric[field] : null]));
          if (tokenFields.every(field => tokens[field] !== null)) reportedCalls++;
          addTokens(row.tokens, tokens);
          const httpStatus = knownCount(metric.httpStatus) && metric.httpStatus >= 400 ? metric.httpStatus : null;
          const providerCode = /^\d{5}$/u.test(metric.providerCode ?? '') ? metric.providerCode : null;
          if (httpStatus || providerCode) row.providerErrors.push({ httpStatus, providerCode });
          if (stop) {
            row.outcome = stop;
            controller.abort(stop);
            break stream;
          }
          continue;
        }
        if (frame.startsWith(':')) continue;
        const [eventLine, dataLine] = frame.split('\n');
        if (!eventLine?.startsWith('event: ') || !dataLine?.startsWith('data: ')) continue;
        const event = eventLine.slice(7);
        const data = JSON.parse(dataLine.slice(6));
        if (!validateAgentFrame(event, data)) throw new Error('Invalid Navis frame');
        if (event === 'status' && test.expected === 'CANCELLED' && data.step === 'read_started') {
          row.outcome = 'CANCELLED';
          controller.abort('CANCELLED');
          break stream;
        }
        if (event === 'text_delta') text += data.delta;
        if (event === 'panels') panels = data.panels.map(item => item.featureId);
        if (event === 'action_proposal') proposal = data;
        if (event === 'error') { row.outcome = data.code; break stream; }
        if (event === 'done') {
          row.outcome = data.outcome;
          terminal = data;
          break stream;
        }
      }
    }
  } catch {
    row.outcome = controller.signal.aborted ? controller.signal.reason : 'REQUEST_ERROR';
  } finally {
    clearTimeout(timeout);
    row.latencyMs = Math.round(performance.now() - started);
    if (budget) row.providerCalls = budget.calls - callsBefore;
    row.unreportedCalls = Math.max(0, row.providerCalls - reportedCalls);
    row.incomplete = row.unreportedCalls > 0 || row.outcome === 'INCOMPLETE_STREAM' || row.outcome === 'REQUEST_ERROR'
      || AGENT_ERROR_CODES.includes(row.outcome);
    row.failureKind = budget?.stopReason ?? expectationFailure(test, row, { proposal, panels, text, terminal }, expectedModel);
    row.invalidReason = budget?.invalidReason(row.correlationId) ?? null;
    row.ok = row.failureKind === null;
  }
  return row;
}

export async function runLiveSmoke(serverUrl, emit = row => process.stdout.write(`${JSON.stringify(row)}\n`), wait = delay, options = {}) {
  const server = new URL(serverUrl);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) throw new Error(usage);
  const endpoint = new URL('/api/navis/chat', server);
  const selected = options.only ? options.only.map(id => cases.find(test => test.id === id)) : cases;
  const { budget, model } = options;
  const totals = { kind: 'totals', model: model ?? null, selected: selected.length, calls: 0, passed: 0, skipped: 0, incomplete: 0, providerCalls: 0,
    tokens: zeroTokens(), unreportedCalls: 0, latencyMs: 0, retries: 0, stopReason: null };
  for (const test of selected) {
    totals.stopReason ??= budget?.stopReason ?? (budget?.exhausted ? 'PROVIDER_CALL_CAP' : null);
    if (totals.stopReason) {
      emit({ promptId: test.id, expected: test.expected, outcome: 'SKIPPED', model, failureKind: totals.stopReason, ok: false });
      totals.skipped++;
      continue;
    }
    // Expire the live bridge's 60-second turn and token reservations in batches.
    if (totals.calls > 0 && totals.calls % 4 === 0) await wait(60_000);
    const row = await ask(endpoint, test, options);
    emit(row);
    totals.calls++;
    totals.passed += Number(row.ok);
    totals.incomplete += Number(row.incomplete);
    totals.providerCalls += row.providerCalls;
    totals.unreportedCalls += row.unreportedCalls;
    totals.latencyMs += row.latencyMs;
    totals.retries += row.retries;
    if (['PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_CALL_CAP'].includes(row.failureKind)) totals.stopReason = row.failureKind;
    addTokens(totals.tokens, row.tokens);
  }
  if (budget) totals.providerCalls = budget.calls;
  emit(totals);
  return totals.passed === selected.length;
}

export async function runPreview({ only, maxProviderCalls, bridgeOptions, emit, wait, fetchImpl }) {
  const { agentMode, agentModel } = bridgeOptions;
  if (agentMode !== 'live' || !models.has(agentModel)) throw new Error('NAVIS_AGENT_MODE=live and HCX-005 or HCX-007 are required');
  const budget = createProviderBudget(maxProviderCalls, fetchImpl);
  let ready = false;
  const bridge = createBridge({ ...bridgeOptions, fetchImpl: budget.fetch, onDiagnostics(metric) {
    if (metric.event === 'navis_agent_startup') ready = metric.outcome === 'ready';
    budget.observe(metric);
  } });
  const server = createServer(bridge);
  try {
    if (!ready) throw new Error('Navis live configuration unavailable');
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    return await runLiveSmoke(`http://127.0.0.1:${server.address().port}`, emit, wait, { only, model: agentModel, budget });
  } finally {
    bridge.close();
    server.close();
    server.closeAllConnections();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { NAVIS_AGENT_MODE: agentMode, NAVIS_AGENT_MODEL: agentModel, CLOVASTUDIO_API_KEY: apiKey, CLOVASTUDIO_BASE_URL: baseUrl } = process.env;
    if (!await runPreview({ ...options, bridgeOptions: { agentMode, agentModel, apiKey, baseUrl } })) process.exitCode = 1;
  } catch (error) {
    const safeMessage = [usage, 'NAVIS_AGENT_MODE=live and HCX-005 or HCX-007 are required', 'Navis live configuration unavailable'].includes(error?.message)
      ? error.message : 'Navis live preview or smoke run failed';
    process.stderr.write(`${safeMessage}\n`);
    process.exitCode = 1;
  }
}
