// Native CLOVA Studio v3 transport. Configuration is injected by the server only.
import { randomUUID } from 'node:crypto';

const MAX_OUTPUT = 128 * 1024;
const failure = code => Object.assign(new Error(code), { code });
const aborted = () => new DOMException('Cancelled', 'AbortError');
const REAL_CLOCK = { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const decodeJson = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

export const estimateTokens = value => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 3);

function aiFilterAllows(result) {
  const { aiFilter, message } = result;
  return (typeof message?.content !== 'string' || Array.from(message.content).length <= 500)
    && Array.isArray(aiFilter) && aiFilter.length > 0
    && aiFilter.every(item => item?.score === '2' && (item.result === undefined || item.result === 'OK'));
}

export class InvalidOutputError extends Error {
  constructor(reason) {
    super('INVALID_OUTPUT');
    this.code = 'INVALID_OUTPUT';
    this.reason = reason;
  }
}

function providerErrorCode(error) {
  const code = error?.status?.code ?? error?.code;
  if (typeof code !== 'string' && typeof code !== 'number') return null;
  const text = String(code);
  return /^\d{5}$/u.test(text) ? text : null;
}

function resetDelay(headers) {
  const delays = ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'retry-after'].flatMap(name => {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(headers.get(name)?.trim() ?? '');
    if (!match) return [];
    const ms = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]?.toLowerCase() ?? 's']);
    return Number.isFinite(ms) ? [Math.min(ms, 2147483647)] : [];
  });
  return delays.length ? Math.max(...delays) : 2000;
}
// Code 40009 ("Unsupported function", a 4xx in the CLOVA Studio docs) turns up now and then on requests that normally work. One retry before any text.
const unsupportedFunction = () => Object.assign(failure('UNAVAILABLE'), { transient: true });
const rateLimited = headers => Object.assign(failure('UNAVAILABLE'), { rateExceeded: true, delayMs: resetDelay(headers) });
function waitForReset(ms, signal, clock) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    let timer;
    const cleanup = () => { clock.clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(aborted()); };
    timer = clock.setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

async function withSignal(operation, signal) {
  if (signal?.aborted) { void Promise.resolve(operation).catch(() => {}); throw aborted(); }
  if (!signal) return operation;
  let cancel;
  const stopped = new Promise((_, reject) => { cancel = () => reject(aborted()); signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([operation, stopped]); }
  finally { signal.removeEventListener('abort', cancel); }
}
function discard(body) {
  try { body?.cancel().catch(() => {}); } catch { /* Already locked/closed. */ }
}

export function createClovaStudio({ apiKey, baseUrl = 'https://clovastudio.stream.ntruss.com', model = 'HCX-005', fetchImpl = globalThis.fetch, clock = REAL_CLOCK } = {}) {
  let endpointBase;
  try {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || typeof model !== 'string' || !model.trim()) throw failure('UNAVAILABLE');
    endpointBase = `${base.href.replace(/\/+$/, '')}/v3/chat-completions/`;
  } catch { endpointBase = null; }
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const available = Boolean(key && endpointBase);

  async function* request({ messages, tools, toolChoice, maxTokens, responseFormat, temperature, seed, jsonResponse = false, model: requestModel = model, signal, onBytes, includeAiFilters,
    requestId, responseInfo }) {
    let reader;
    let cancelReader;
    let bytes = 0;
    const count = chunk => {
      bytes += chunk.byteLength;
      onBytes(chunk.byteLength);
      if (bytes > MAX_OUTPUT) throw new InvalidOutputError('provider_output_limit');
    };
    const openReader = body => {
      reader = body.getReader();
      cancelReader = () => { try { void reader.cancel().catch(() => {}); } catch {} };
      signal?.addEventListener('abort', cancelReader, { once: true });
      if (signal?.aborted) throw aborted();
    };
    const readBody = async body => {
      openReader(body);
      const chunks = [];
      for (;;) {
        const chunk = await withSignal(reader.read(), signal);
        if (signal?.aborted) throw aborted();
        if (chunk.done) break;
        count(chunk.value);
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks);
    };
    try {
      if (!available || typeof requestModel !== 'string' || !requestModel.trim()) throw failure('UNAVAILABLE');
      if (signal?.aborted) throw aborted();
      const structured = responseFormat !== undefined;
      const expectJson = structured || jsonResponse;
      const selectedModel = requestModel.trim();
      const endpoint = endpointBase + encodeURIComponent(selectedModel);
      const body = { messages };
      if (structured || selectedModel === 'HCX-007') body.maxCompletionTokens = maxTokens;
      else body.maxTokens = maxTokens;
      // HCX-007 defaults to low reasoning. Function calling requires it disabled explicitly.
      if (structured || selectedModel === 'HCX-007') body.thinking = { effort: 'none' };
      if (structured) body.responseFormat = responseFormat;
      if (structured && temperature !== undefined) body.temperature = temperature;
      if (structured && seed !== undefined) body.seed = seed;
      if (!structured && tools !== undefined) body.tools = tools;
      if (!structured && toolChoice !== undefined) body.toolChoice = toolChoice;
      if (includeAiFilters) body.includeAiFilters = true;
      const fetched = Promise.resolve(fetchImpl(endpoint, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: expectJson ? 'application/json' : 'text/event-stream',
          ...(requestId ? { 'X-NCP-CLOVASTUDIO-REQUEST-ID': requestId } : {}) },
        body: JSON.stringify(body), signal,
      })).then(response => { if (signal?.aborted) { discard(response.body); throw aborted(); } return response; });
      const response = await withSignal(fetched, signal);
      if (responseInfo) responseInfo.httpStatus = response.status;
      const sse = /^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '');
      const httpRateLimited = response.status === 429;
      if (!response.ok && (!httpRateLimited || !sse)) {
        if (!response.body || !httpRateLimited && !responseInfo) {
          discard(response.body);
          throw failure('UNAVAILABLE');
        }
        let bytes;
        try { bytes = await readBody(response.body); } catch (error) {
          if (httpRateLimited || signal?.aborted || error?.name === 'AbortError') throw error;
        }
        let code = null;
        if (bytes) {
          try { code = providerErrorCode(decodeJson(bytes)); } catch { /* The error body may omit a valid provider code. */ }
        }
        if (responseInfo) responseInfo.providerCode = code;
        if (httpRateLimited && code === '42901') throw rateLimited(response.headers);
        if (code === '40009') throw unsupportedFunction();
        throw failure('UNAVAILABLE');
      }
      if (expectJson) {
        if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '') || !response.body) {
          discard(response.body);
          throw new InvalidOutputError('provider_response_type');
        }
        const bytes = await readBody(response.body);
        let envelope;
        try { envelope = decodeJson(bytes); } catch { throw new InvalidOutputError('provider_response_json'); }
        if (envelope?.status?.code == null) throw new InvalidOutputError('provider_response_status');
        if (String(envelope.status.code) !== '20000') {
          if (responseInfo) responseInfo.providerCode = providerErrorCode(envelope);
          if (providerErrorCode(envelope) === '40009') throw unsupportedFunction();
          throw failure('UNAVAILABLE');
        }
        const result = envelope.result;
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new InvalidOutputError('provider_result_shape');
        yield { event: 'result', data: result };
        return;
      }
      if (!sse || !response.body) { discard(response.body); throw new InvalidOutputError('provider_response_type'); }
      openReader(response.body);
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = ''; let event = ''; let data = [];
      function line(value) {
        if (value === '') {
          const name = event; const raw = data.join('\n'); event = ''; data = [];
          if (!raw) { if (name && !['signal', 'ping'].includes(name)) throw new InvalidOutputError('provider_event_empty'); return null; }
          if (name === 'signal' || name === 'ping') return null;
          if (name === 'error') {
            let error;
            try { error = JSON.parse(raw); } catch { throw failure('UNAVAILABLE'); }
            const code = providerErrorCode(error);
            if (responseInfo) responseInfo.providerCode = code;
            if (code === '42901') throw rateLimited(response.headers);
            if (code === '40009') throw unsupportedFunction();
            throw failure('UNAVAILABLE');
          }
          if (name !== 'token' && name !== 'result') throw new InvalidOutputError('provider_event_type');
          let parsed;
          try { parsed = JSON.parse(raw); } catch { throw new InvalidOutputError('provider_event_json'); }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InvalidOutputError('provider_event_shape');
          return { event: name, data: parsed };
        }
        if (value.startsWith(':')) return null;
        const colon = value.indexOf(':');
        const field = colon < 0 ? value : value.slice(0, colon);
        let content = colon < 0 ? '' : value.slice(colon + 1);
        if (content.startsWith(' ')) content = content.slice(1);
        if (field === 'event') event = content;
        if (field === 'data') data.push(content);
        return null;
      }
      for (;;) {
        const chunk = await withSignal(reader.read(), signal);
        if (signal?.aborted) throw aborted();
        if (chunk.done) { buffer += decoder.decode(); break; }
        count(chunk.value);
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const match = /\r\n|\r|\n/.exec(buffer);
          if (!match || (match[0] === '\r' && match.index === buffer.length - 1)) break;
          const value = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          const parsed = line(value);
          if (parsed) yield parsed;
        }
      }
      // A trailing CR is a line ending; a frame still needs its blank delimiter.
      if (buffer === '\r') { buffer = ''; const parsed = line(''); if (parsed) yield parsed; }
      if (buffer || event || data.length) throw new InvalidOutputError('provider_event_incomplete');
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw aborted();
      if (error?.rateExceeded || error?.transient) throw error;
      if (error instanceof InvalidOutputError) throw error;
      if (error?.code === 'INVALID_OUTPUT' || error instanceof TypeError && reader) throw new InvalidOutputError('provider_body_read');
      throw failure('UNAVAILABLE');
    } finally {
      if (cancelReader) { signal?.removeEventListener('abort', cancelReader); cancelReader(); }
      try { reader?.releaseLock(); } catch { /* Pending reads settle through abort. */ }
    }
  }
  async function* complete({ onBytes = () => {}, onAttempt, onProviderCall, retryRateLimit = true, includeAiFilters = false, ...options }) {
    const filter = includeAiFilters
      && (options.responseFormat !== undefined || options.tools === undefined && options.toolChoice === undefined)
      && !options.messages.some(message => message.role === 'tool' || message.toolCalls !== undefined);
    let bytes = 0; let emitted = false;
    const count = size => {
      bytes += size;
      onBytes(size);
      if (bytes > MAX_OUTPUT) throw new InvalidOutputError('provider_output_limit');
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (options.signal?.aborted) throw aborted();
      onAttempt?.(attempt);
      const requestId = onProviderCall ? randomUUID() : undefined;
      const started = onProviderCall ? (clock.now?.() ?? performance.now()) : undefined;
      const responseInfo = onProviderCall ? { httpStatus: null, providerCode: null } : undefined;
      let usage, outcome = 'INVALID_OUTPUT', retryDelay;
      try {
        for await (const event of request({ ...options, onBytes: count, requestId, responseInfo, includeAiFilters: filter })) {
          emitted = true;
          if (event.event === 'result') {
            usage = event.data.usage;
            if (filter && !aiFilterAllows(event.data)) throw failure('AI_FILTER');
            outcome = event.data.finishReason === 'length' ? 'length' : 'success';
          } else if (filter) continue; // The documented SSE filter result arrives with the final event.
          yield event;
        }
      } catch (error) {
        outcome = error?.rateExceeded ? 'rate_limited' : error?.code === 'AI_FILTER' ? 'filtered'
          : error?.code === 'INVALID_OUTPUT' ? error.code : 'UNAVAILABLE';
        // `retryRateLimit` is true (wait for whatever reset the provider names), false, or the most milliseconds a short-budget caller can wait.
        if (retryRateLimit && error?.rateExceeded && attempt === 0 && !emitted && (retryRateLimit === true || error.delayMs <= retryRateLimit)) retryDelay = error.delayMs;
        else if (error?.transient && attempt === 0 && !emitted) retryDelay = 0;
        else if (error?.name === 'AbortError' || ['AI_FILTER', 'INVALID_OUTPUT'].includes(error?.code)) throw error;
        // A second 40009 in a row: the caller may carry on without this model call when the call was only a protocol step.
        else throw Object.assign(failure('UNAVAILABLE'), error?.transient ? { unsupportedFunction: true } : {});
      } finally {
        if (onProviderCall) {
          const { promptTokens, completionTokens, totalTokens } = usage ?? {};
          const stopped = options.signal?.aborted && !['success', 'length'].includes(outcome);
          try {
            onProviderCall({ requestId, promptTokens: tokenCount(promptTokens), completionTokens: tokenCount(completionTokens),
              totalTokens: tokenCount(totalTokens), latencyMs: Math.round((clock.now?.() ?? performance.now()) - started),
              retries: attempt, ...responseInfo,
              outcome: stopped ? (options.signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED') : outcome });
          } catch { /* Diagnostics cannot affect provider retries or response handling. */ }
        }
      }
      if (retryDelay === undefined) return;
      await waitForReset(retryDelay, options.signal, clock);
    }
  }
  return { available, complete };
}
