import type { Provider } from '../../../services/marketing/naver/binding.ts';
import { NaverAdapterError } from '../../../services/marketing/naver/errors.ts';
import type { ModelStage } from '../promo/providers.ts';

/**
 * PN14 promo client for the existing marketing-worker promo provider (W, CLOVA Studio v3, operation
 * `pn14.chat`). Contract: packages/naver/contracts/pn14 · persona capability pn14.
 *
 * `createFakePromoProvider({ naverFetch })` already builds the official v3 request through
 * `server/clova-studio.mjs`. This module supplies that `naverFetch`: it accepts only the promo modes,
 * sends the unchanged body through the PN-P0 binding (persona or A6-approved live, Bearer key added by
 * the binding) and returns the provider response untouched for the existing JSON/SSE parser and metering.
 *
 * Sources: https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3 (HCX-005 text/image,
 * `X-NCP-CLOVASTUDIO-REQUEST-ID`) · https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3-so
 * (HCX-007 Structured Outputs, `responseFormat`, `thinking.effort: none`, `maxCompletionTokens`).
 * Model output stays draft data; it never stands for a provider action result.
 */
const PATH = /^\/v3\/chat-completions\/(HCX-005|HCX-007)$/;
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;

type StudioBody = {
  messages?: unknown; responseFormat?: { type?: unknown; schema?: unknown }; thinking?: { effort?: unknown };
  maxCompletionTokens?: unknown; maxTokens?: unknown; tools?: unknown;
};

/** Validate one promo-stage request against its official mode. */
export function checkPromoRequest(stage: ModelStage, model: string, body: StudioBody) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new NaverAdapterError('INVALID_INPUT', { detail: 'messages' });
  if (body.tools !== undefined) throw new NaverAdapterError('INVALID_INPUT', { detail: 'tools' });
  if (stage === 'look') {
    // HCX-005 image analysis: JSON answer, no Structured Outputs or thinking in this mode.
    if (model !== 'HCX-005' || body.responseFormat !== undefined || body.thinking !== undefined || !Number.isSafeInteger(body.maxTokens)) {
      throw new NaverAdapterError('INVALID_INPUT', { detail: 'look' });
    }
    return;
  }
  // HCX-007 Structured Outputs for story and scene planning with reasoning disabled.
  if (model !== 'HCX-007' || body.responseFormat?.type !== 'json' || !body.responseFormat.schema || body.thinking?.effort !== 'none'
    || !Number.isSafeInteger(body.maxCompletionTokens) || body.maxTokens !== undefined) {
    throw new NaverAdapterError('INVALID_INPUT', { detail: stage });
  }
}

export function createStudioPromoFetch(provider: Provider) {
  return (stage: ModelStage, attemptId: string): typeof fetch => async (resource, init) => {
    const requested = new URL(resource instanceof Request ? resource.url : String(resource));
    const match = PATH.exec(requested.pathname);
    if (!match || requested.search || init?.method !== 'POST' || typeof init.body !== 'string' || Buffer.byteLength(init.body) > MAX_REQUEST_BYTES) {
      throw new NaverAdapterError('INVALID_INPUT', { detail: 'studio-request' });
    }
    let body: StudioBody;
    try { body = JSON.parse(init.body) as StudioBody; } catch { throw new NaverAdapterError('INVALID_INPUT', { detail: 'studio-body' }); }
    checkPromoRequest(stage, match[1], body);
    const accept = new Headers(init.headers).get('accept');
    if (accept !== 'application/json' && accept !== 'text/event-stream') throw new NaverAdapterError('INVALID_INPUT', { detail: 'accept' });
    const requestId = attemptId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (!requestId) throw new NaverAdapterError('INVALID_INPUT', { detail: 'attemptId' });
    // The transport supplies the bound Bearer key; the attempt-scoped key from the caller is dropped.
    return provider.transport.request('pn14.chat', provider.storeId, requested.pathname, {
      signal: init.signal ?? undefined, body: init.body,
      headers: { 'content-type': 'application/json', accept, 'x-ncp-clovastudio-request-id': requestId },
    });
  };
}
