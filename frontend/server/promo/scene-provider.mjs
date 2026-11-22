// Scene-stage providers (D-327 Q7). Stages 1–2 (photo look, story) stay NAVER; stage 3 (scene HTML) defaults to Claude.
//   claude     — the headless Claude CLI on the owner's signed-in plan (dev and the GPU-server demo). The default.
//   naver      — the HCX-007 scene pilot (hcx-runner.mjs), kept for comparison runs.
//   claude-api — the hosted Messages API, enabled with owner approval and a mounted key.
// This file is deployed with the server, so nothing here may import from dev/.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PromoError } from './errors.mjs';
import { createClaudeRunner } from './claude-runner.mjs';
import { validateSchema } from './schema.mjs';

// The owner never accepts paid usage credits (D-326 Q8). If the CLI ever offers them, nothing more is called.
const CREDITS = /usage credits|extra usage|switch to .{0,24}credits|add(?:itional)? credits|buy credits/i;
const MAX_WATCHED = 4 * 1024 * 1024;

/** A pay-per-token key or gateway would bill API credits instead of the signed-in plan, so the child never sees them. */
export const baselineEnv = env => Object.fromEntries(Object.entries(env).filter(([key]) => !/^ANTHROPIC_/.test(key)));

/** Reads only facts the baseline table needs from a stream-json run: the exact model id and a credits offer. */
export function inspectStream(stdout, stderr = '') {
  const info = { modelId: null, initModel: null, credits: CREDITS.test(stderr), cliDurationMs: null };
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'system' && event.subtype === 'init') info.initModel = typeof event.model === 'string' ? event.model : null;
    if (event.type === 'result') {
      const ids = Object.keys(event.modelUsage ?? {});
      if (ids.length) info.modelId = ids.join('+');
      if (Number.isFinite(event.duration_ms)) info.cliDurationMs = event.duration_ms;
    }
    if (event.type === 'rate_limit_event' && event.rate_limit_info?.isUsingOverage === true) info.credits = true;
    // Generated HTML lives in assistant turns and structured_output; only the CLI's own messages can offer credits.
    if (event.type !== 'assistant' && event.type !== 'user') {
      const own = { ...event, structured_output: undefined, result: event.is_error ? event.result : undefined };
      if (CREDITS.test(JSON.stringify(own))) info.credits = true;
    }
  }
  info.modelId ??= info.initModel;
  return info;
}

/** Keeps the first MAX_WATCHED bytes of a stream; the CLI's own notices are short and come early or last. */
function watcher(stream) {
  const chunks = []; let size = 0;
  stream?.on('data', chunk => { if (size < MAX_WATCHED) { chunks.push(Buffer.from(chunk)); size += chunk.length; } });
  return () => Buffer.concat(chunks).toString('utf8');
}

/**
 * The same headless CLI path the Claude baseline used (claude-runner.mjs), with its two safeguards:
 * no ANTHROPIC_* variable reaches the child, and a credits offer ends the call, discards its answer and
 * blocks every later call until the server restarts. Repairs and validators live in the pipeline, not here.
 */
export function createClaudeCliRunner({ command, model = 'sonnet', spawnProcess = spawn, env = process.env, retries, tempRoot } = {}) {
  let creditsOffered = false;
  const watchedSpawn = (cmd, args, options) => {
    if (creditsOffered) throw Object.assign(new Error('credits offered'), { code: 'CREDITS_OFFERED' });
    const child = spawnProcess(cmd, args, options);
    const stdout = watcher(child.stdout);
    const stderr = watcher(child.stderr);
    child.on?.('close', () => { if (inspectStream(stdout(), stderr()).credits) creditsOffered = true; });
    return child;
  };
  const inner = createClaudeRunner({ command, model, spawnProcess: watchedSpawn, env: baselineEnv(env), retries, tempRoot });
  const blocked = usage => Object.assign(new PromoError('AI_UNAVAILABLE', 'CLAUDE_CREDITS_OFFERED'), usage ? { usage } : {});
  return {
    model,
    get creditsOffered() { return creditsOffered; },
    async run(request) {
      if (creditsOffered) throw blocked();
      let result;
      try {
        result = await inner.run(request);
      } catch (error) {
        if (creditsOffered) throw blocked(error?.usage);
        throw error;
      }
      if (creditsOffered) throw blocked(result.usage);
      return result;
    },
  };
}

export const CLAUDE_API_MODEL = 'claude-opus-5-5';
export const CAFE_PHOTO_ANALYSIS_MODEL = 'claude-sonnet-4-6';
export const promoClaudeApiModel = (env = process.env) =>
  env.NAVIS_PROMO_CLAUDE_MODEL?.trim() || env.NAVIS_PROMO_CLAUDE_API_MODEL?.trim() || CLAUDE_API_MODEL;
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
// The Messages API supports a subset of JSON Schema. The full validator still runs locally.
function apiSchema(schema) {
  const { type, enum: choices, required, additionalProperties, properties, items } = schema;
  return { type, enum: choices, required, additionalProperties,
    properties: properties && Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, apiSchema(value)])),
    items: items && apiSchema(items) };
}
const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function readPromoKey(path, fallback = '') {
  if (!path) return fallback.trim();
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

const visionTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function createClaudeApiRunner({ approved = false, apiKey = '', model = CLAUDE_API_MODEL,
  fetchImpl = globalThis.fetch, video = false } = {}) {
  return {
    model,
    available: approved === true && Boolean(apiKey),
    /** @param {{prompt: string, schema: object, timeoutMs?: number, signal?: AbortSignal, images?: {bytes: Uint8Array, mediaType: string}[], maxTokens?: number}} request */
    async run({ prompt, schema, timeoutMs = 180000, signal, images = [], maxTokens = video ? 28_000 : 16_384 }) {
      if (approved !== true) throw new PromoError('AI_UNAVAILABLE', 'CLAUDE_API_NOT_APPROVED');
      if (!apiKey) throw new PromoError('AI_UNAVAILABLE', 'CLAUDE_API_KEY_MISSING');
      if (signal?.aborted) throw new PromoError('AI_TIMEOUT');
      if (images.length > 1 || images.some(image => !visionTypes.has(image.mediaType)
          || !(image.bytes instanceof Uint8Array) || !image.bytes.length || image.bytes.length > 4 * 1024 * 1024)) {
        throw new PromoError('AI_BAD_OUTPUT');
      }
      const requestContent = images.length ? [
        { type: 'image', source: { type: 'base64', media_type: images[0].mediaType, data: Buffer.from(images[0].bytes).toString('base64') } },
        { type: 'text', text: prompt },
      ] : prompt;

      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const usage = { calls: 1, inputTokens: 0, outputTokens: 0 };
      let httpStatus = null;
      const fail = code => Object.assign(new PromoError(code), { usage, httpStatus });
      let body;
      try {
        const response = await fetchImpl(MESSAGES_URL, {
          method: 'POST',
          redirect: 'error',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model, max_tokens: maxTokens, messages: [{ role: 'user', content: requestContent }],
            output_config: {
              ...(video && model === CLAUDE_API_MODEL && { effort: 'low' }),
              format: { type: 'json_schema', schema: apiSchema(schema) },
            },
          }),
          signal: requestSignal,
        });
        httpStatus = response.status;
        if (!response.ok) {
          await response.body?.cancel();
          throw fail('AI_UNAVAILABLE');
        }
        body = await response.json();
      } catch (error) {
        if (error instanceof PromoError) throw error;
        // A missing response body can leave a billable attempt unresolved even if headers arrived.
        httpStatus = null;
        throw fail(requestSignal.aborted ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE');
      }

      usage.inputTokens = tokens(body?.usage?.input_tokens) + tokens(body?.usage?.cache_creation_input_tokens) + tokens(body?.usage?.cache_read_input_tokens);
      usage.outputTokens = tokens(body?.usage?.output_tokens);
      const content = Array.isArray(body?.content) && body.content.find(block => block?.type === 'text');
      let output;
      try { output = JSON.parse(content?.text); } catch { throw fail('AI_BAD_OUTPUT'); }
      const violations = validateSchema(schema, output);
      if (body.stop_reason !== 'end_turn' || violations.length) {
        const kinds = violations.map(violation => violation.split(': ').at(-1));
        throw Object.assign(fail('AI_BAD_OUTPUT'), {
          outputCheck: body.stop_reason === 'end_turn' ? [...new Set(kinds)] : ['incomplete_response'],
        });
      }
      return { output, usage };
    },
  };
}
