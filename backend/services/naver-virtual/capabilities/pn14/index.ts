import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PersonaCapability } from '../../app.ts';
import type {
  StudioChatRequest, StudioContentPart, StudioFilter, StudioMessage, StudioObject, StudioResult, StudioTokenizeRequest, StudioTool,
} from '../../../../packages/naver/contracts/pn14/index.ts';

const ok = { code: '20000', message: 'OK' };
const invalid = { code: '40001', message: 'Invalid parameter' };
const roles = ['system', 'user', 'assistant', 'tool'];
const tokenizerFields = ['messages', 'tools', 'toolChoice', 'responseFormat'];
const chatFields = [...tokenizerFields, 'maxTokens', 'maxCompletionTokens', 'thinking',
  'topP', 'topK', 'temperature', 'repetitionPenalty', 'seed', 'stop', 'includeAiFilters'];
const lowRisk: StudioFilter[] = [
  { groupName: 'curse', name: 'discrimination', score: '2', result: 'OK' },
  { groupName: 'curse', name: 'insult', score: '2', result: 'OK' },
  { groupName: 'unsafeContents', name: 'sexualHarassment', score: '2', result: 'OK' },
];

function object(value: unknown): value is StudioObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: StudioObject, keys: readonly string[]) {
  return Object.keys(value).every(key => keys.includes(key));
}

function validPart(part: unknown): part is StudioContentPart {
  if (!object(part)) return false;
  if (part.type === 'text') return onlyKeys(part, ['type', 'text']) && typeof part.text === 'string';
  if (part.type !== 'image_url') return false;
  if (object(part.imageUrl)) {
    return onlyKeys(part, ['type', 'imageUrl']) && onlyKeys(part.imageUrl, ['url'])
      && typeof part.imageUrl.url === 'string'
      && /^https?:\/\/[^\s]+\.(?:bmp|png|jpe?g|webp)(?:\?[^\s]*)?$/i.test(part.imageUrl.url);
  }
  return object(part.dataUri) && onlyKeys(part, ['type', 'dataUri']) && onlyKeys(part.dataUri, ['data'])
    && typeof part.dataUri.data === 'string' && part.dataUri.data.length <= 28_000_050
    && /^data:image\/(bmp|png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(part.dataUri.data);
}

function validMessages(value: unknown): value is StudioMessage[] {
  if (!Array.isArray(value) || !value.length || value.length > 256) return false;
  let systems = 0;
  let images = 0;
  const pending = new Set<string>();
  for (const message of value) {
    if (!object(message) || !onlyKeys(message, ['role', 'content', 'toolCalls', 'toolCallId'])
      || typeof message.role !== 'string' || !roles.includes(message.role)) return false;
    if (message.role === 'system' && ++systems > 1) return false;
    if (typeof message.content !== 'string') {
      if (!Array.isArray(message.content) || !message.content.length || !message.content.every(validPart)) return false;
      const imageCount = message.content.filter(part => part.type === 'image_url').length;
      if (message.role !== 'user' && imageCount || imageCount > 1 || (images += imageCount) > 5) return false;
    }
    if (message.toolCalls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.toolCalls) || pending.size) return false;
      for (const call of message.toolCalls) {
        if (!object(call) || !onlyKeys(call, ['id', 'type', 'function']) || call.type !== 'function'
          || typeof call.id !== 'string' || !call.id || pending.has(call.id) || !object(call.function)
          || !onlyKeys(call.function, ['name', 'arguments']) || typeof call.function.name !== 'string'
          || !object(call.function.arguments)) return false;
        pending.add(call.id);
      }
    }
    if (message.role === 'tool') {
      if (typeof message.toolCallId !== 'string' || !pending.delete(message.toolCallId)) return false;
    } else if (message.toolCallId !== undefined || pending.size && message.toolCalls === undefined) {
      return false;
    }
  }
  return pending.size === 0;
}

function validTool(tool: unknown): tool is StudioTool {
  return object(tool) && onlyKeys(tool, ['type', 'function']) && tool.type === 'function'
    && object(tool.function) && onlyKeys(tool.function, ['name', 'description', 'parameters'])
    && typeof tool.function.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(tool.function.name)
    && typeof tool.function.description === 'string'
    && (tool.function.parameters === undefined || object(tool.function.parameters));
}

function validate(input: unknown, model: string, tokenize: boolean): input is StudioChatRequest {
  if (!object(input) || !onlyKeys(input, tokenize ? tokenizerFields : chatFields) || !validMessages(input.messages)) return false;
  const functionMode = input.tools !== undefined || input.toolChoice !== undefined
    || input.messages.some(message => message.role === 'tool' || message.toolCalls !== undefined);
  const structured = input.responseFormat !== undefined;
  if (functionMode && (model !== 'HCX-005' || structured || input.thinking !== undefined)) return false;
  if (model === 'HCX-007' && !structured) return false;
  if ((functionMode || structured) && input.messages.some(message => typeof message.content !== 'string')) return false;
  if (input.tools !== undefined && (!Array.isArray(input.tools) || !input.tools.length
    || input.tools.length > 128 || !input.tools.every(validTool)
    || new Set(input.tools.map(tool => tool.function.name)).size !== input.tools.length)) return false;
  const choice = input.toolChoice;
  if (choice !== undefined && choice !== 'auto' && choice !== 'none') {
    if (!object(choice) || !onlyKeys(choice, ['type', 'function']) || choice.type !== 'function'
      || !object(choice.function) || !onlyKeys(choice.function, ['name'])) return false;
    const name = choice.function.name;
    if (!Array.isArray(input.tools) || !input.tools.some(tool => tool.function.name === name)) return false;
  }
  if (structured && (model !== 'HCX-007' || !object(input.responseFormat) || !onlyKeys(input.responseFormat, ['type', 'schema'])
    || input.responseFormat.type !== 'json' || !object(input.responseFormat.schema)
    || input.responseFormat.schema.type !== 'object')) return false;
  if (structured && !tokenize && (!object(input.thinking) || !onlyKeys(input.thinking, ['effort']) || input.thinking.effort !== 'none')) return false;
  if (input.thinking !== undefined && !structured) return false;
  if (input.maxTokens !== undefined && model !== 'HCX-005' || input.maxCompletionTokens !== undefined && model !== 'HCX-007') return false;
  const outputLimit = input.maxTokens ?? input.maxCompletionTokens;
  if (outputLimit !== undefined && (typeof outputLimit !== 'number' || !Number.isInteger(outputLimit)
    || outputLimit < (functionMode ? 1024 : 1) || outputLimit > (structured ? 32_768 : 4096))) return false;
  const bounded = (value: unknown, minimum: number, maximum: number, integer = false) => value === undefined
    || typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
      && (!integer || Number.isInteger(value));
  return bounded(input.topP, Number.MIN_VALUE, 1) && bounded(input.topK, 0, 128, true)
    && bounded(input.temperature, 0, 1) && bounded(input.repetitionPenalty, Number.MIN_VALUE, 2)
    && bounded(input.seed, 0, 4_294_967_295, true)
    && (input.stop === undefined || Array.isArray(input.stop) && input.stop.every(stop => typeof stop === 'string' && stop.length))
    && (input.includeAiFilters === undefined || typeof input.includeAiFilters === 'boolean');
}

function example(schema: unknown, key: string, budget: { remaining: number; now: Date }): unknown {
  if (!object(schema) || --budget.remaining < 0) throw new Error('Invalid fixture schema');
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return example(schema.anyOf[0], key, budget);
  if (schema.type === 'object') {
    const props = object(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some(field => typeof field !== 'string' || !Object.hasOwn(props, field))) throw new Error('Missing property');
    return Object.fromEntries(Object.entries(props).map(([name, child]) => [name, example(child, name, budget)]));
  }
  if (schema.type === 'array') {
    const count = schema.minItems ?? (schema.maxItems === 0 ? 0 : 1);
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 32
      || typeof schema.maxItems === 'number' && count > schema.maxItems) throw new Error('Invalid item count');
    return Array.from({ length: count }, () => example(schema.items, key, budget));
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const min = typeof schema.minimum === 'number' ? schema.minimum : -Infinity;
    const max = typeof schema.maximum === 'number' ? schema.maximum : Infinity;
    let result = Math.min(Math.max(1, min), max);
    if (schema.type === 'integer') result = Math.floor(Math.min(Math.max(1, Math.ceil(min)), max));
    if (!Number.isFinite(result) || result < min || result > max) throw new Error('Invalid range');
    return result;
  }
  if (schema.type === 'boolean') return false;
  if (schema.type === 'null') return null;
  if (schema.type !== 'string') throw new Error('Unknown schema type');
  const local = new Date(budget.now.getTime() + 9 * 3_600_000).toISOString();
  const samples: Record<string, string> = {
    'date-time': budget.now.toISOString(), date: local.slice(0, 10), time: local.slice(11, 19), duration: 'PT1S',
    email: 'owner@example.test', hostname: 'example.test', ipv4: '192.0.2.1', ipv6: '2001:db8::1',
    uuid: '4b8f3045-6147-4b1a-808d-1ed2b73c8982',
  };
  return typeof schema.format === 'string' && Object.hasOwn(samples, schema.format) ? samples[schema.format]
    : key === 'location' ? '서울' : '안숭잘부 카페';
}

function count(value: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(value) / 4));
}

function tokenize(input: StudioTokenizeRequest) {
  return {
    messages: input.messages.map(message => ({
      role: message.role,
      content: typeof message.content === 'string'
        ? { type: 'text', text: message.content, count: count(message.content) }
        : message.content.map(part => ({ ...part, count: part.type === 'text' ? count(part.text) : 1478 })),
    })),
    ...(input.tools && { tools: { count: count(JSON.stringify(input.tools)) } }),
    ...(input.responseFormat && { responseFormat: { count: count(JSON.stringify(input.responseFormat)) } }),
  };
}

function reviewReplyDraft(prompt: unknown): string | undefined {
  const heading = '리뷰 답글 초안 작성\n';
  if (typeof prompt !== 'string' || !prompt.startsWith(heading) || prompt.length > 8000) return;
  let details: unknown;
  try { details = JSON.parse(prompt.slice(heading.length)); }
  catch { return; }
  if (!object(details) || typeof details.review !== 'string' || !details.review.trim() ||
      typeof details.style !== 'string' || typeof details.length !== 'string') return;
  const { review, rating, style, length } = details;
  const topics = [
    [/커피|라떼|아메리카노|에스프레소/u, '커피'],
    [/디저트|케이크|쿠키|빵/u, '디저트'],
    [/자리|좌석|창가|테이블/u, '좌석'],
    [/직원|응대|친절|서비스/u, '응대'],
    [/대기|기다|줄이|웨이팅/u, '대기 시간'],
    [/가격|비싸|저렴/u, '가격'],
  ] as const;
  const mentions = topics.filter(([pattern]) => pattern.test(review)).slice(0, 2).map(([, topic]) => topic);
  const warm = /친근|따뜻|다정/u.test(style);
  const reply = [warm ? '후기 남겨 주셔서 고마워요.' : '후기를 남겨 주셔서 감사합니다.'];
  if (mentions.length) reply.push(mentions.join(['좌석', '가격', '대기 시간'].includes(mentions[0]) ? '과 ' : '와 ')
    + '에 관해 남겨 주신 말씀을 읽었습니다.');
  if ((typeof rating === 'number' && rating >= 1 && rating <= 2) || /아쉬|불편|별로|실망/u.test(review)) {
    reply.push('이용에 아쉬움이 있으셨다니 죄송합니다.');
  }
  if (/자세|길게/u.test(length)) reply.push('시간을 내어 이용 소감을 전해 주셔서 감사합니다.');
  return reply.join(' ');
}

function completion(input: StudioChatRequest, now: Date, sse: boolean): StudioResult {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest();
  const seed = input.seed || digest.readUInt32BE(0) || 1;
  const choice = input.toolChoice;
  const selected = object(choice) ? input.tools?.find(tool => tool.function.name === choice.function.name)
    : choice !== 'none' && input.messages.at(-1)?.role === 'user'
      ? input.tools?.find(tool => tool.function.name === 'get_weather'
        && input.messages.some(message => message.role === 'user' && typeof message.content === 'string' && /날씨|weather/i.test(message.content)))
      : undefined;
  let content = '안숭잘부 카페에 관해 어떤 내용을 확인할까요?';
  let toolCalls: StudioResult['message']['toolCalls'];
  const budget = { remaining: 512, now };
  if (selected) {
    const { name, parameters } = selected.function;
    const arguments_ = parameters ? example({ ...parameters, type: 'object' }, '', budget) as StudioObject : {};
    toolCalls = [{ id: `call_${digest.toString('hex').slice(0, 24)}`, type: 'function',
      function: { name, arguments: arguments_ } }];
    content = '';
  } else if (input.responseFormat) {
    content = JSON.stringify(example(input.responseFormat.schema, '', budget));
  } else {
    const last = input.messages.at(-1);
    if (last?.role === 'user') content = reviewReplyDraft(last.content) ?? content;
    if (last?.role === 'tool') content = '요청하신 조회 결과를 확인했어요.';
    if (Array.isArray(last?.content)) {
      content = '안숭잘부 카페의 매장 사진입니다.';
      const text = last.content.find(part => part.type === 'text')?.text;
      const marker = '\nReturn only one JSON object matching this schema. Do not use markdown.\n';
      if (text?.includes(marker)) content = JSON.stringify(example(JSON.parse(text.split(marker).at(-1) ?? ''), '', budget));
    }
  }
  const stops = input.stop?.map(stop => content.indexOf(stop)).filter(index => index >= 0) ?? [];
  if (stops.length) content = content.slice(0, Math.min(...stops));
  const max = input.maxTokens ?? input.maxCompletionTokens;
  const limited = !toolCalls && max !== undefined && count(content) > max;
  if (limited) content = Buffer.from(content).subarray(0, max * 4).toString('utf8').replace(/\uFFFD$/, '');
  const promptTokens = count(JSON.stringify(input.messages)) + (input.tools ? count(JSON.stringify(input.tools)) : 0)
    + (input.responseFormat ? count(JSON.stringify(input.responseFormat)) : 0);
  const completionTokens = count(toolCalls ? JSON.stringify(toolCalls) : content);
  return {
    message: { role: 'assistant', content, ...(toolCalls && { toolCalls }) },
    finishReason: toolCalls ? 'tool_calls' : limited ? 'length' : 'stop',
    seed, created: sse ? Math.floor(now.getTime() / 1000) : now.getTime(),
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    ...(input.includeAiFilters && !input.tools && { aiFilter: lowRisk }),
  };
}

function stream(result: StudioResult) {
  // Preserve the v3 token/result event distinction and never execute a proposed function.
  const tokens = result.message.toolCalls?.flatMap(({ id, type, function: tool }) => [
    { content: '', toolCalls: [{ id, type, function: { name: tool.name } }] },
    { content: '', toolCalls: [{ type, function: { partialJson: JSON.stringify(tool.arguments) } }] },
  ]) ?? [{ content: result.message.content }];
  const frame = (event: 'token' | 'result', data: unknown, index: number) =>
    `id: ${result.seed}-${index}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return Readable.from([
    ...tokens.map((token, index) => frame('token', {
      message: { role: 'assistant', ...token }, created: result.created, seed: result.seed,
      finishReason: null, usage: null,
    }, index)),
    frame('result', result, tokens.length),
  ]);
}

export const personaCapability: PersonaCapability = {
  id: 'pn14',
  register(app, context) {
    async function authorize(request: FastifyRequest, reply: FastifyReply) {
      const key = context.providerCredential(request, 'apiKey');
      const supplied = request.headers.authorization;
      if (!key || !supplied || Buffer.byteLength(supplied) !== Buffer.byteLength(`Bearer ${key}`)
        || !timingSafeEqual(Buffer.from(supplied), Buffer.from(`Bearer ${key}`))) {
        return reply.code(401).send({ status: { code: '40100', message: 'Unauthorized' } });
      }
    }
    type Lookup = { Params: { modelName: string } };
    const options = (operation: string) => ({
      bodyLimit: 50_000_000, config: { personaOperation: operation },
      onRequest: authorize,
      errorHandler(error: { statusCode?: number }, _request: FastifyRequest, reply: FastifyReply) {
        return reply.code(error.statusCode === 413 ? 413 : 400).send({ status: invalid });
      },
    });
    // Function, text/image and structured mode sources are in packages/naver/contracts/pn14.
    app.post<Lookup>('/v3/chat-completions/:modelName', options('pn14.chat'), (request, reply) => {
      if (!['HCX-005', 'HCX-007'].includes(request.params.modelName)) {
        return reply.code(404).send({ status: { code: '40400', message: 'Not found' } });
      }
      if (!validate(request.body, request.params.modelName, false)) return reply.code(400).send({ status: invalid });
      const sse = request.headers.accept?.split(',').some(type => type.trim() === 'text/event-stream') ?? false;
      let result: StudioResult;
      try {
        result = completion(request.body, context.now(), sse);
      } catch {
        return reply.code(400).send({ status: invalid });
      }
      if (sse) {
        return reply.type('text/event-stream').header('cache-control', 'no-cache').send(stream(result));
      }
      return { status: ok, result };
    });
    // https://api.ncloud-docs.com/docs/clovastudio-tokenizerhcxv3
    app.post<Lookup>('/v3/api-tools/chat-tokenize/:modelName', options('pn14.tokenize'), (request, reply) => {
      if (!['HCX-005', 'HCX-007'].includes(request.params.modelName)) {
        return reply.code(404).send({ status: { code: '40400', message: 'Not found' } });
      }
      if (!validate(request.body, request.params.modelName, true)) return reply.code(400).send({ status: invalid });
      return { status: ok, result: tokenize(request.body) };
    });
  },
};
