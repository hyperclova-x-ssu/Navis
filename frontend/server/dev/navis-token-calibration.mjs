import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { estimateTokens } from '../clova-studio.mjs';

const endpoint = 'https://clovastudio.stream.ntruss.com/v3/api-tools/chat-tokenize/';
const textMessages = [
  { role: 'system', content: '당신은 가상의 카페 데이터만 사용하는 Navis입니다.' },
  { role: 'user', content: '오늘 등록된 메뉴가 몇 개인지 알려줘.' },
];
// Synthetic 16×16 solid-color PNG. These samples contain no store or customer data.
// HCX-005 accepts dataUri.data only as a data URL: bare base64 returned HTTP 400 / 40001 on the GPU server (2026-11-21).
const syntheticPng = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPwnplKEmIY1TCqYfhqAADOiUkQ+vHcCQAAAABJRU5ErkJggg==';
const cases = [
  { mode: 'text', model: 'HCX-005', body: { messages: textMessages } },
  { mode: 'function_calling', model: 'HCX-005', body: {
    messages: textMessages,
    tools: [{ type: 'function', function: {
      name: 'get_widget', description: '가상의 위젯에서 등록된 메뉴 수를 조회합니다.',
      parameters: { type: 'object', properties: { featureId: { type: 'string', enum: ['menu'] } }, required: ['featureId'] },
    } }],
    toolChoice: { type: 'function', function: { name: 'get_widget' } },
  } },
  { mode: 'structured_output', model: 'HCX-007', body: {
    messages: [textMessages[0], { role: 'user', content: '예시 카페의 등록 메뉴 수는 7개예요.' }],
    responseFormat: { type: 'json', schema: {
      type: 'object', properties: { menuCount: { type: 'integer' } }, required: ['menuCount'], additionalProperties: false,
    } },
  } },
  { mode: 'image', model: 'HCX-005', body: {
    messages: [textMessages[0], { role: 'user', content: [
      { type: 'image_url', dataUri: { data: `data:image/png;base64,${syntheticPng}` } },
      { type: 'text', text: '가상 견본 이미지의 색을 한 단어로 알려줘.' },
    ] }],
  } },
];

export function navisTokenCalibrationPlan() {
  return cases.map(({ mode, model, body }) => ({
    mode, model, estimatedPromptTokens: estimateTokens(body), completionTokens: 0,
  }));
}

const KEY_NAME = 'CLOVASTUDIO_API_KEY';
const MAX_BODY_CHARS = 64 * 1024;
const pathFor = model => `/v3/api-tools/chat-tokenize/${model}`;

// Calibration failures carry key-free facts only: stage, status codes, key names and counts of things.
// Never request headers, the key, or response text values.
export class NavisCalibrationError extends Error {
  constructor(failures, { rows = [], requests = 0 } = {}) {
    super('Navis calibration failed');
    this.name = 'NavisCalibrationError';
    this.failures = failures;
    this.rows = rows;
    this.requests = requests;
  }
}

class ShapeProblem extends Error {
  constructor(reason, facts = {}) { super(reason); this.reason = reason; this.facts = facts; }
}

const keysOf = value => Array.isArray(value) ? `array(${value.length})`
  : value && typeof value === 'object' ? Object.keys(value).sort() : value === null ? 'null' : typeof value;
const safeText = (value, key) => {
  if (typeof value !== 'string') return null;
  const hidden = key ? value.split(key).join('[redacted]') : value;
  // eslint-disable-next-line no-control-regex
  return hidden.replace(/nv-[\w-]{8,}/gu, '[redacted]').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 200);
};
const providerFacts = (body, key) => {
  const status = body?.status ?? body;
  const code = status?.code;
  return {
    providerCode: typeof code === 'string' || typeof code === 'number' ? String(code).slice(0, 12) : null,
    providerMessage: safeText(status?.message, key),
  };
};

function count(part, where) {
  if (!Number.isSafeInteger(part?.count) || part.count < 0) {
    throw new ShapeProblem('count', { where, partKeys: keysOf(part), countType: typeof part?.count });
  }
  return part.count;
}

function responseCounts(envelope, body) {
  const { result } = envelope ?? {};
  const resultKeys = keysOf(result);
  if (!Array.isArray(result?.messages)) throw new ShapeProblem('messages_missing', { resultKeys });
  if (result.messages.length !== body.messages.length) {
    throw new ShapeProblem('messages_length', { expected: body.messages.length, observed: result.messages.length, resultKeys });
  }
  let messageTokens = 0;
  for (const [index, message] of result.messages.entries()) {
    const expected = body.messages[index];
    const parts = Array.isArray(message?.content) ? message.content : [message?.content];
    const types = Array.isArray(expected.content) ? expected.content.map(part => part.type) : ['text'];
    if (message?.role !== expected.role) {
      throw new ShapeProblem('message_role', { where: `messages[${index}]`, expected: expected.role, observed: typeof message?.role === 'string' ? safeText(message.role) : typeof message?.role });
    }
    if (parts.length !== types.length || parts.some((part, i) => part?.type !== types[i])) {
      throw new ShapeProblem('content_types', { where: `messages[${index}]`, expectedTypes: types,
        observedTypes: parts.map(part => typeof part?.type === 'string' ? safeText(part.type) : keysOf(part)),
        contentKeys: keysOf(message?.content) });
    }
    for (const [i, part] of parts.entries()) messageTokens += count(part, `messages[${index}].content[${i}]`);
  }
  let toolTokens = 0;
  if (body.tools) {
    try { toolTokens = count(result.tools, 'tools'); } catch (error) {
      throw new ShapeProblem('tools_count', { toolsKeys: keysOf(result.tools), resultKeys, ...error.facts });
    }
  }
  let schemaTokens = 0;
  if (body.responseFormat) {
    try { schemaTokens = count(result.responseFormat, 'responseFormat'); } catch (error) {
      throw new ShapeProblem('schema_count', { schemaKeys: keysOf(result.responseFormat), resultKeys, ...error.facts });
    }
  }
  const tokenizedInputTokens = messageTokens + toolTokens + schemaTokens;
  if (!Number.isSafeInteger(tokenizedInputTokens)) throw new ShapeProblem('combined_count');
  return { messageTokens, toolTokens, schemaTokens, tokenizedInputTokens };
}

// Auth, rate-limit, server and connection failures repeat for every case, so they stop the run.
const repeats = failure => ['network', 'response'].includes(failure.stage) || [401, 403, 429].includes(failure.httpStatus) || failure.httpStatus >= 500
  || /^(401|403|429)/u.test(failure.providerCode ?? '');

async function callCase({ model, body }, key, fetchImpl) {
  const base = { endpointPath: pathFor(model) };
  let response;
  try {
    response = await fetchImpl(endpoint + model, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json',
        'X-NCP-CLOVASTUDIO-REQUEST-ID': randomUUID() },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    return { failure: { stage: 'network', ...base, errorName: String(error?.name ?? 'Error').slice(0, 40),
      errorCode: typeof code === 'string' ? code.slice(0, 40) : null } };
  }
  const contentType = safeText(response.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase() ?? null) ?? null;
  let parsed;
  try {
    const text = await response.text();
    parsed = text.length <= MAX_BODY_CHARS ? JSON.parse(text) : undefined;
  } catch { parsed = undefined; }
  if (!response.ok) {
    return { failure: { stage: 'http', ...base, httpStatus: response.status, contentType, ...providerFacts(parsed, key) } };
  }
  if (parsed === undefined) return { failure: { stage: 'response', ...base, httpStatus: response.status, contentType } };
  if (String(parsed?.status?.code) !== '20000') {
    return { failure: { stage: 'provider', ...base, httpStatus: response.status, ...providerFacts(parsed, key) } };
  }
  try { return { counts: responseCounts(parsed, body) }; } catch (error) {
    if (!(error instanceof ShapeProblem)) throw error;
    return { failure: { stage: 'shape', ...base, httpStatus: response.status, reason: error.reason, ...error.facts,
      ...(error.reason === 'messages_missing' || error.facts.resultKeys ? {} : { resultKeys: keysOf(parsed?.result) }) } };
  }
}

export async function calibrateNavisTokens({ apiKey, fetchImpl = globalThis.fetch } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new NavisCalibrationError([{ stage: 'config', missing: [KEY_NAME] }]);
  const rows = [];
  const failures = [];
  let requests = 0;
  const plan = navisTokenCalibrationPlan();
  for (const [index, item] of cases.entries()) {
    requests++;
    const { counts, failure } = await callCase(item, key, fetchImpl);
    if (counts) {
      rows.push({ ...plan[index], ...counts, estimateDelta: counts.tokenizedInputTokens - plan[index].estimatedPromptTokens });
      continue;
    }
    failures.push({ stage: failure.stage, mode: item.mode, model: item.model, ...failure });
    if (repeats(failure)) break;
  }
  if (failures.length) throw new NavisCalibrationError(failures, { rows, requests });
  return rows;
}

export function formatCalibrationFailure(error) {
  if (!(error instanceof NavisCalibrationError)) return `Navis calibration failed unexpectedly (${String(error?.name ?? 'Error').slice(0, 40)}).`;
  const first = error.failures[0];
  return [
    `Navis calibration failed at stage "${first.stage}" after ${error.requests} tokenize request(s).`,
    ...error.failures.map(failure => JSON.stringify(failure)),
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--plan') {
    console.log(JSON.stringify({ requests: cases.length, samples: navisTokenCalibrationPlan() }));
  } else if (args.length === 1 && args[0] === '--live') {
    try {
      const rows = await calibrateNavisTokens({ apiKey: process.env[KEY_NAME] });
      for (const row of rows) console.log(JSON.stringify(row));
      console.log(JSON.stringify({ requests: rows.length, completionTokens: 0,
        tokenizedInputTokens: rows.reduce((total, row) => total + row.tokenizedInputTokens, 0) }));
    } catch (error) {
      if (error instanceof NavisCalibrationError) for (const row of error.rows) console.log(JSON.stringify(row));
      console.error(formatCalibrationFailure(error));
      process.exitCode = 1;
    }
  } else {
    console.error('Usage: node server/dev/navis-token-calibration.mjs --plan | --live');
    process.exitCode = 1;
  }
}
