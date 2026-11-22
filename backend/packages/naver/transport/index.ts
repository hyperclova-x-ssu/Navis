import { addAbortListener } from 'node:events';
import { readSecret } from '../../db/index.ts';
import {
  bindingOrigin, PERSONA_ACCOUNT_HEADER, PERSONA_TOKEN_HEADER, personaAccountPattern, personaOperationPattern,
  type NaverBinding, type NaverRequestScope,
} from '../config/index.ts';

const defaultRequestBytes = 2 * 1024 * 1024;
const defaultResponseBytes = 4 * 1024 * 1024;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const privateHeaders = [PERSONA_TOKEN_HEADER, PERSONA_ACCOUNT_HEADER, 'host', 'cookie', 'proxy-authorization'];

export type NaverRequestOptions = Pick<RequestInit, 'headers' | 'body' | 'signal'> & { approvalScope?: unknown };
export type PersonaCallback = (target: 'talktalk' | 'aicall', options: NaverRequestOptions) => Promise<Response>;

function boundedDuration(ms: number, signal?: AbortSignal | null): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([deadline, signal]) : deadline;
}

async function withAbort<T>(signal: AbortSignal, run: () => T | Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let subscription: ReturnType<typeof addAbortListener> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    subscription = addAbortListener(signal, () => reject(signal.reason));
  });
  try { return await Promise.race([run(), aborted]); } finally { subscription?.[Symbol.dispose](); }
}

function boundedBody(
  body: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal, kind: 'request' | 'response',
): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > limit) throw new Error(`NAVER ${kind} limit exceeded`);
      controller.enqueue(chunk);
    },
  }), { signal });
}

async function requestBody(body: BodyInit | null | undefined, headers: Headers, limit: number, signal: AbortSignal) {
  if (body == null) return undefined;
  const encoded = new Response(body);
  const contentType = encoded.headers.get('content-type');
  if (contentType && (!headers.has('content-type') || body instanceof FormData)) headers.set('content-type', contentType);
  return new Uint8Array(await new Response(boundedBody(encoded.body!, limit, signal, 'request')).arrayBuffer());
}

function boundedResponse(response: Response, limit: number, signal: AbortSignal): Response {
  if (!response.body) return response;
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body.cancel().catch(() => {});
    throw new Error('NAVER response limit exceeded');
  }
  return new Response(boundedBody(response.body, limit, signal, 'response'), {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

function limits(binding: NaverBinding) {
  const timeout = binding.timeoutMs ?? 10_000;
  const request = binding.maxRequestBytes ?? defaultRequestBytes;
  const response = binding.maxResponseBytes ?? defaultResponseBytes;
  if (![timeout, request, response].every(value => Number.isSafeInteger(value) && value > 0)
    || timeout > 120_000 || Math.max(request, response) > 64 * 1024 * 1024) throw new Error('Invalid NAVER transport limits');
  return { timeout, request, response };
}

function operationUrl(origin: string, path: string, binding: NaverBinding): URL {
  // eslint-disable-next-line no-control-regex -- NAVER operation paths must reject ASCII controls.
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(path)) throw new Error('Invalid NAVER operation path');
  const url = new URL(path, origin);
  const partnerAssumed = url.pathname.startsWith('/partner-assumed/v1/');
  const fromPath = path.split('?')[0];
  const match = binding.route.exec(url.pathname);
  if (url.origin !== origin || url.pathname !== fromPath || match?.[0] !== url.pathname
    || /%(?:2e|2f|5c|00)/i.test(url.pathname)
    || (binding.mode !== 'live' && partnerAssumed !== (binding.grade !== 'W'))) {
    throw new Error('NAVER path is outside the operation binding');
  }
  return url;
}

function assertRedirect(response: Response, scope: NaverRequestScope, binding: NaverBinding): void {
  if (!redirectStatuses.has(response.status)) return;
  const location = response.headers.get('location');
  if (location && binding.allowRedirectResponse?.(new URL(location, scope.url))) return;
  void response.body?.cancel().catch(() => {});
  throw new Error('NAVER redirect response is outside the operation allowlist');
}

export function createNaverTransport(options: {
  bindings: readonly NaverBinding[];
  fakeOnly?: boolean;
  fetcher?: typeof fetch;
  readCredential?: (path: string) => string;
}) {
  const fetcher = options.fetcher ?? fetch;
  const readCredential = options.readCredential ?? readSecret;
  const entries = new Map<string, { binding: NaverBinding; origin: string; bounds: ReturnType<typeof limits> }>();
  for (const entry of options.bindings) {
    const binding = { ...entry, route: new RegExp(entry.route.source, entry.route.flags) };
    if (!personaOperationPattern.test(binding.operation) || !binding.storeId || binding.storeId.includes('\0')
      || !binding.providerAccount || binding.route.global || binding.route.sticky
      || (binding.mode === 'virtual' && !personaAccountPattern.test(binding.providerAccount))) {
      throw new Error('Invalid NAVER operation binding');
    }
    if (options.fakeOnly && binding.mode !== 'fake') throw new Error('This runtime requires fake NAVER bindings');
    const key = `${binding.operation}\0${binding.storeId}`;
    if (entries.has(key)) throw new Error('Duplicate NAVER operation binding');
    entries.set(key, { binding, origin: bindingOrigin(binding), bounds: limits(binding) });
  }

  return {
    async request(operation: string, storeId: string, path: string, init: NaverRequestOptions = {}): Promise<Response> {
      const entry = entries.get(`${operation}\0${storeId}`);
      if (!entry) throw new Error('No scoped NAVER operation binding');
      const { binding, origin, bounds } = entry;
      const url = operationUrl(origin, path, binding);
      const signal = boundedDuration(bounds.timeout, init.signal);
      const headers = new Headers(init.headers);
      if (privateHeaders.some(header => headers.has(header))) throw new Error('Reserved NAVER transport header');
      if (init.body != null && (binding.method === 'GET' || binding.method === 'HEAD')) throw new Error('Unexpected NAVER request body');
      const body = await requestBody(init.body, headers, bounds.request, signal);
      const scope: NaverRequestScope = {
        operation, storeId, providerAccount: binding.providerAccount, method: binding.method,
        url: new URL(url), headers: new Headers(headers), body: body?.slice(), approvalScope: init.approvalScope, signal,
      };
      if (binding.mode === 'live' && !(await withAbort(signal, () => binding.approve(scope)))) {
        throw new Error('NAVER operation lacks current A6 approval');
      }
      if (binding.mode === 'fake') {
        const response = await withAbort(signal, () => binding.handler(scope));
        assertRedirect(response, scope, binding);
        return boundedResponse(response, bounds.response, signal);
      }
      if (binding.credentialFile && binding.authorize) {
        const credential = readCredential(binding.credentialFile);
        const authorize = binding.authorize;
        const wireHeaders = new Headers(await withAbort(signal, () => authorize(scope, credential)));
        if (privateHeaders.some(header => wireHeaders.has(header))) throw new Error('Reserved NAVER transport header');
        wireHeaders.forEach((value, name) => headers.set(name, value));
      }
      if (binding.mode === 'virtual') {
        headers.set(PERSONA_TOKEN_HEADER, readCredential(binding.privateTokenFile));
        headers.set(PERSONA_ACCOUNT_HEADER, binding.providerAccount);
      }
      const response = await withAbort(signal, () => fetcher(url, { method: binding.method, headers, body, signal, redirect: 'manual' }));
      assertRedirect(response, scope, binding);
      return boundedResponse(response, bounds.response, signal);
    },
  };
}

const callbackDestinations = {
  talktalk: ['marketing', '/internal/v1/naver/talktalk/webhook'],
  aicall: ['customer', '/internal/naver-virtual/aicall/custom-condition/v2'],
} as const;

export function createPersonaCallback(
  endpoints: Partial<Record<keyof typeof callbackDestinations, string>>, fetcher: typeof fetch = fetch,
): PersonaCallback {
  for (const target of ['talktalk', 'aicall'] as const) {
    const endpoint = endpoints[target];
    if (!endpoint) continue;
    const [service, path] = callbackDestinations[target];
    const url = new URL(endpoint);
    const privateHost = new RegExp(`^${service}(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.svc(?:\\.cluster\\.local)?)?$`);
    if (!privateHost.test(url.hostname) || !['http:', 'https:'].includes(url.protocol)
      || (url.port !== '3000' && (url.port !== '' || url.protocol !== 'https:')) || endpoint !== url.origin + path) {
      throw new Error('Invalid private persona callback destination');
    }
  }
  const approved = { ...endpoints };
  return async (target, init) => {
    const endpoint = approved[target];
    if (!endpoint) throw new Error('Persona callback is unavailable');
    const signal = boundedDuration(5_000, init.signal);
    const headers = new Headers(init.headers);
    if (privateHeaders.some(header => headers.has(header))) throw new Error('Reserved persona callback header');
    const body = await requestBody(init.body, headers, 128 * 1024, signal);
    const response = await withAbort(signal, () => fetcher(endpoint, { method: 'POST', headers, body, signal, redirect: 'manual' }));
    if (redirectStatuses.has(response.status)) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Persona callback returned a redirect');
    }
    return boundedResponse(response, 128 * 1024, signal);
  };
}
