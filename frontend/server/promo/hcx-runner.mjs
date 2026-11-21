import { PromoError } from './errors.mjs';
import { validateSchema } from './schema.mjs';

export const HCX_PROMO_MODEL = 'HCX-007';
export const HCX_PHOTO_MODEL = 'HCX-005';
export const STORY_MAX_TOKENS = 2048;
const LOOK_MAX_TOKENS = 1024;
const SCENE_MAX_TOKENS = 16384;
const MAX_IMAGE_BYTES = 20_000_000;
const SCHEMA_FIELDS = ['type', 'required', 'enum', 'minimum', 'maximum', 'minItems', 'maxItems'];

// The documented v3 subset omits pattern, additionalProperties and string length limits.
// The response is checked against the original schema below, including these constraints.
function structuredSchema(schema) {
  const mapped = {};
  for (const field of SCHEMA_FIELDS) {
    if (Object.hasOwn(schema, field)) mapped[field] = schema[field];
  }
  if (schema.properties) {
    mapped.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, structuredSchema(value)]));
  }
  if (schema.items) mapped.items = structuredSchema(schema.items);
  return mapped;
}

// A rejected reply is logged by kind only (never its text or a model-chosen key name), so a systematic failure can be told apart.
const word = value => typeof value === 'string' && /^[a-z_]{1,20}$/i.test(value) ? value : 'other';
const schemaProblem = problem => problem.replace(/^(.*)\.[^.\]]*: additional$/u, '$1: additional').replace(/[^\w$.[\]: -]/gu, '?').slice(0, 60);
// HCX-005 has no structured output and wraps its JSON in one markdown fence despite the prompt (PROMO-NEXT: 3/3 calls
// `json:fenced>ok`, 40/40 in the second pilot). A reply that is exactly one fenced block is unwrapped; anything else stays strict.
const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i;

// Downstream prompts and checks ignore these lists. HCX-005 sometimes returns entries longer than the schema allows.
function dropLongEntries(output, schema, field, { checkOriginalCount = true } = {}) {
  const entries = output?.[field];
  const rule = schema.properties?.[field];
  const limit = rule?.items?.maxLength;
  if (!Array.isArray(entries) || !Number.isInteger(limit)) return 0;
  if (checkOriginalCount && entries.length > rule.maxItems) return 0;
  const kept = entries.filter(entry => typeof entry !== 'string' || [...entry].length <= limit);
  output[field] = kept;
  return entries.length - kept.length;
}

// For a reply that is not strict JSON: would its outermost {...} pass the schema? Only the verdict is logged, never the text.
const salvage = (text, schema) => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let found;
  try { found = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined; } catch { /* not JSON either */ }
  if (found === undefined) return 'none';
  const problems = validateSchema(schema, found);
  return problems.length ? `schema:${problems.slice(0, 5).map(schemaProblem).join(',')}` : 'ok';
};
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// HCX-005 reads an image only as a data URL (`data:image/<type>;base64,...`); bare base64 gets HTTP 400 / 40001
// (PROMO-PILOT 39/39, TOKEN-CAL). The type comes from the file's own first bytes; the label is a fallback.
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
function imageType(bytes, label) {
  const at = (offset, text) => bytes.length >= offset + text.length && Buffer.from(bytes.subarray(offset, offset + text.length)).toString('latin1') === text;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif';
  return SUPPORTED_IMAGE_TYPES.has(label) ? label : null;
}

export function createHcxRunner({ stage = 'story', transport, retries = 1, beforeCall, onCall } = {}) {
  const look = stage === 'look';
  const model = look ? HCX_PHOTO_MODEL : HCX_PROMO_MODEL;
  const maxTokens = look ? LOOK_MAX_TOKENS : stage === 'scenes' ? SCENE_MAX_TOKENS : STORY_MAX_TOKENS;
  return {
    model,
    async run({ prompt, images, schema, timeoutMs = 120000, signal }) {
      const bytes = images?.[0]?.bytes;
      if (look ? (images?.length !== 1 || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) : images?.length) {
        throw new PromoError('AI_BAD_OUTPUT');
      }
      const mediaType = look ? imageType(bytes, images[0].mediaType) : null;
      if (look && !mediaType) throw new PromoError('AI_BAD_OUTPUT');
      if (!transport?.available) throw new PromoError('AI_UNAVAILABLE');

      const started = Date.now();
      const timeout = globalThis.AbortSignal.timeout(timeoutMs);
      const requestSignal = signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout;
      const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
      const content = look ? [
        { type: 'image_url', dataUri: { data: `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}` } },
        { type: 'text', text: `${prompt}\nReturn only one JSON object matching this schema. Do not use markdown.\n${JSON.stringify(schema)}` },
      ] : prompt;
      const request = {
        model,
        messages: [{ role: 'user', content }],
        maxTokens,
        ...(look ? { jsonResponse: true } : { responseFormat: { type: 'json', schema: structuredSchema(schema) } }),
        signal: requestSignal,
        retryRateLimit: false,
      };

      for (let attempt = 0; ; attempt++) {
        let callStarted;
        let result;
        let provider;
        let outcome = 'success';
        let schemaValid = null;
        let failure = null;
        let parse = null;
        let hintsDropped = 0;
        let itemsTrimmed = 0;
        let flavorsTrimmed = 0;
        try {
          for await (const event of transport.complete({
            ...request,
            onAttempt: () => {
              beforeCall?.();
              callStarted = Date.now();
              usage.calls++;
            },
            onProviderCall: onCall ? info => { provider = info; } : undefined,
          })) {
            if (event.event === 'result') result = event.data;
          }
          usage.inputTokens += tokenCount(result?.usage?.promptTokens) ?? 0;
          usage.outputTokens += tokenCount(result?.usage?.completionTokens) ?? 0;
          schemaValid = false;
          if (result?.finishReason !== 'stop' || result.message?.role !== 'assistant' || typeof result.message.content !== 'string') {
            failure = result?.finishReason !== 'stop' ? `finish:${word(result?.finishReason)}` : 'message';
            throw new PromoError('AI_BAD_OUTPUT');
          }
          let output;
          const fenced = look ? FENCE.exec(result.message.content.trim()) : null;
          try {
            output = JSON.parse(fenced ? fenced[1] : result.message.content);
            parse = fenced ? 'fenced' : 'json';
          } catch (error) {
            const text = result.message.content.trimStart();
            failure = `${text.startsWith('```') ? 'json:fenced' : text.startsWith('{') ? 'json:syntax' : 'json:prefix'}>${salvage(result.message.content, schema)}`;
            throw error;
          }
          if (look) {
            // Caption hints already apply maxItems after filtering. Items and flavors must also meet the original count limit.
            hintsDropped = dropLongEntries(output, schema, 'captionHints', { checkOriginalCount: false });
            itemsTrimmed = dropLongEntries(output, schema, 'items');
            flavorsTrimmed = dropLongEntries(output, schema, 'flavors');
          }
          const problems = validateSchema(schema, output);
          if (problems.length) {
            failure = `schema:${problems.slice(0, 5).map(schemaProblem).join(',')}`;
            throw new PromoError('AI_BAD_OUTPUT');
          }
          schemaValid = true;
          return { output, usage, durationMs: Date.now() - started };
        } catch (error) {
          if (error.code === 'PILOT_BUDGET_EXHAUSTED') throw Object.assign(error, { usage });
          let code = 'AI_UNAVAILABLE';
          if (requestSignal.aborted || error.name === 'AbortError') code = 'AI_TIMEOUT';
          else if (error instanceof SyntaxError || error.code === 'INVALID_OUTPUT' || error.code === 'AI_BAD_OUTPUT') code = 'AI_BAD_OUTPUT';
          outcome = code;
          if (code === 'AI_BAD_OUTPUT' && attempt < retries) continue;
          throw Object.assign(new PromoError(code), { usage });
        } finally {
          if (callStarted !== undefined && onCall) {
            const input = tokenCount(result?.usage?.promptTokens);
            const output = tokenCount(result?.usage?.completionTokens);
            onCall({
              model, retries: attempt, outcome, schemaValid, failure, parse, hintsDropped, itemsTrimmed, flavorsTrimmed,
              latencyMs: Date.now() - callStarted,
              httpStatus: provider?.httpStatus ?? null, providerCode: provider?.providerCode ?? null,
              tokens: { input, output, total: tokenCount(result?.usage?.totalTokens) ?? (input !== null && output !== null ? input + output : null) },
            });
          }
        }
      }
    },
  };
}
