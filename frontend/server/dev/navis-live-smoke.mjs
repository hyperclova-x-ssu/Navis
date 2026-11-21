import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { AGENT_ERROR_CODES, AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame } from '../../shared/navis-agent-schema.mjs';

const businessDate = '2026-10-26';
const condition = { kind: 'default' };
const tokenFields = ['promptTokens', 'completionTokens', 'totalTokens'];
const metricsPrefix = ': navis-metrics ';
const usage = 'Usage: node server/dev/navis-live-smoke.mjs <running-server-url>';

function read(featureId, name, key, value, unit, label, display) {
  return {
    intent: { kind: 'read', featureId, condition },
    catalog: [{ id: featureId, name, layer: 'management', conditions: [condition] }],
    snapshot: [{ featureId, condition, facts: [{ key, value, unit, label, display }] }],
  };
}

function menuCreate(prompt) {
  const hasPrice = /\d+원/u.test(prompt);
  return { intent: { kind: 'menu.create', category: 'drink' }, slots: hasPrice ? ['name', 'price'] : ['name'],
    searches: [{ kind: 'menu', querySlot: 'name', matches: [] }] };
}

// Fixed utterances paired with their browser-side projections. The wire accepts
// typed intents and opaque slots, so neither utterances nor menu literals leave the script.
const readMenu = read('menu', '메뉴', 'menu.item.count', 7, 'item', '등록 메뉴', '7개');
const cases = [
  { id: 'menu-read', prompt: '메뉴 몇 개 등록돼 있어?', input: readMenu, expected: 'reply', display: '7개' },
  { id: 'menu-create', prompt: '유자 에이드 5500원으로 메뉴에 추가해줘', input: menuCreate, expected: 'proposal' },
  { id: 'menu-missing-price', prompt: '유자 에이드를 메뉴에 추가해줘', input: menuCreate, expected: 'clarify' },
  { id: 'unsupported', prompt: '화성 여행을 예약해줘', input: { intent: { kind: 'unsupported' } }, expected: 'refused' },
  { id: 'panel-selection', prompt: '오늘 매출을 손익 위젯으로 보여줘',
    input: read('ledger', '손익', 'ledger.sales.net', 1284000, 'KRW', '오늘 매출', '128.4만 원'), expected: 'reply', panel: 'ledger' },
  { id: 'inventory-read', prompt: '보충이 필요한 재고가 몇 개야?',
    input: read('inventory-booking', '재고', 'inventory.restock.count', 3, 'item', '보충 필요', '3개'), expected: 'reply', display: '3개' },
  { id: 'booking-read', prompt: '오늘 예약 몇 건이야?',
    input: read('voice-booking', '예약', 'booking.today.count', 7, 'reservation', '오늘 예약', '7건'), expected: 'reply', display: '7건' },
  { id: 'cancel-stream', prompt: '등록된 메뉴 수를 알려줘', input: readMenu, expected: 'CANCELLED' },
];

const zeroTokens = () => Object.fromEntries(tokenFields.map(field => [field, 0]));
const knownCount = value => Number.isSafeInteger(value) && value >= 0;
const addTokens = (totals, values) => { for (const field of tokenFields) totals[field] += values[field] ?? 0; };

async function ask(endpoint, test) {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('TIMEOUT'), 32_000);
  const input = typeof test.input === 'function' ? test.input(test.prompt) : test.input;
  const row = { promptId: test.id, outcome: 'INCOMPLETE_STREAM', model: null, mode: null, correlationId: null,
    tokens: zeroTokens(), latencyMs: 0, retries: 0, providerCalls: 0, incomplete: false, ok: false };
  let text = '', panel = false, proposal, priceQuestion = false, completeUsage = true;
  try {
    const response = await fetch(endpoint, {
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
          row.providerCalls++;
          if (metric.retries === 1) row.retries++;
          if (metric.outcome === 'success' || metric.outcome === 'length') {
            const tokens = Object.fromEntries(tokenFields.map(field => [field, knownCount(metric[field]) ? metric[field] : null]));
            completeUsage &&= tokenFields.every(field => tokens[field] !== null);
            addTokens(row.tokens, tokens);
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
        if (event === 'panels') panel = data.panels.some(item => item.featureId === test.panel);
        if (event === 'action_proposal') proposal = data;
        if (event === 'error') { row.outcome = data.code; break stream; }
        if (event === 'done') {
          row.outcome = data.outcome;
          priceQuestion = data.clarification?.field === 'price';
          break stream;
        }
      }
    }
  } catch {
    row.outcome = controller.signal.aborted ? controller.signal.reason : 'REQUEST_ERROR';
  } finally {
    clearTimeout(timeout);
    row.latencyMs = Math.round(performance.now() - started);
    row.incomplete = row.outcome === 'CANCELLED' || !completeUsage
      || ['INCOMPLETE_STREAM', 'REQUEST_ERROR', ...AGENT_ERROR_CODES].includes(row.outcome);
    row.ok = row.outcome === test.expected && Boolean(row.model && row.correlationId)
      && (test.expected === 'refused' ? row.providerCalls === 0 : row.providerCalls > 0 && completeUsage)
      && (!test.panel || panel) && (!test.display || text.includes(test.display))
      && (test.expected === 'proposal' ? proposal?.command === 'menu.create' && proposal.args.price.slot === 'price' : !proposal)
      && priceQuestion === (test.expected === 'clarify');
  }
  return row;
}

export async function runLiveSmoke(serverUrl, emit = row => process.stdout.write(`${JSON.stringify(row)}\n`), wait = delay) {
  const server = new URL(serverUrl);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) throw new Error(usage);
  const endpoint = new URL('/api/navis/chat', server);
  const totals = { kind: 'totals', calls: 0, passed: 0, incomplete: 0, providerCalls: 0,
    tokens: zeroTokens(), latencyMs: 0, retries: 0 };
  for (const test of cases) {
    // Let the first batch's reservations expire before sending the second batch.
    if (totals.calls === 4 && totals.providerCalls > 0) await wait(60_000);
    const row = await ask(endpoint, test);
    emit(row);
    totals.calls++;
    totals.passed += Number(row.ok);
    totals.incomplete += Number(row.incomplete);
    totals.providerCalls += row.providerCalls;
    totals.latencyMs += row.latencyMs;
    totals.retries += row.retries;
    addTokens(totals.tokens, row.tokens);
  }
  emit(totals);
  return totals.passed === totals.calls;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error(usage);
    if (!await runLiveSmoke(process.argv[2])) process.exitCode = 1;
  } catch {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 1;
  }
}
