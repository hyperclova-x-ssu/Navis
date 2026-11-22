import type { OperationId, Provider } from './binding.ts';
import { OPERATIONS } from './binding.ts';
import { NaverAdapterError } from './errors.ts';

/**
 * Calls through the PN-P0 scoped transport (`packages/naver/transport`). This module only maps the
 * HTTP result to Navis outcome codes; redirects, deadlines, size limits, persona headers and A6
 * approval are enforced by PN-P0. Bodies, credentials and provider payloads are never logged.
 */
export interface CallResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

function transportFailure(error: unknown, write: boolean): never {
  const message = error instanceof Error ? error.message : '';
  if (/^No scoped NAVER operation binding/.test(message)) throw new NaverAdapterError('NOT_CONFIGURED');
  if (/lacks current A6 approval/.test(message)) throw new NaverAdapterError('LIVE_NOT_APPROVED');
  if (/outside the operation binding|Invalid NAVER operation path|Unexpected NAVER request body|Reserved NAVER/.test(message)) {
    throw new NaverAdapterError('INVALID_INPUT', { detail: 'request' });
  }
  if (/redirect response/.test(message)) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: 'redirect' });
  // Network failure, deadline or limit after the request may have been sent.
  throw new NaverAdapterError(write ? 'UNKNOWN_OUTCOME' : 'UNAVAILABLE', { detail: 'transport' });
}

export async function call(provider: Provider, operation: OperationId, path: string,
  init: { headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal; approvalScope?: unknown } = {}): Promise<CallResult> {
  const write = OPERATIONS[operation].write;
  let response: Response;
  try {
    response = await provider.transport.request(operation, provider.storeId, path, {
      headers: init.headers, body: init.body as BodyInit | undefined, signal: init.signal, approvalScope: init.approvalScope,
    });
  } catch (error) {
    init.signal?.throwIfAborted();
    return transportFailure(error, write);
  }
  try {
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    return transportFailure(error, write);
  }
}

export function parseJson(result: CallResult): unknown {
  if (!result.body.length) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.body)); }
  catch { throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: 'json' }); }
}

/** Persona P/O error mapping: `{ code }` bodies, empty 401/403 from the PN-P0 grant check. */
export function partnerOutcome(result: CallResult, write: boolean): unknown {
  if (result.status >= 200 && result.status < 300) return parseJson(result);
  let json: unknown;
  try { json = parseJson(result); } catch { /* Status still identifies the outcome for a non-JSON failure. */ }
  const providerCode = json && typeof json === 'object' && typeof (json as { code?: unknown }).code === 'string'
    ? (json as { code: string }).code.slice(0, 64) : undefined;
  let code: ConstructorParameters<typeof NaverAdapterError>[0] = write ? 'UNKNOWN_OUTCOME' : 'UNAVAILABLE';
  let message = write ? '처리 결과를 아직 확인하지 못했어요.' : '지금은 정보를 불러올 수 없어요.';
  if (result.status === 404) {
    code = 'NOT_FOUND';
    message = '항목을 찾을 수 없어요.';
  } else if (result.status === 409 || result.status === 412) {
    code = 'CONFLICT';
    message = '현재 상태를 확인한 뒤 다시 시도해 주세요.';
  } else if (result.status === 401 || result.status === 403) {
    code = 'FORBIDDEN';
    message = '이 작업을 할 권한을 확인해 주세요.';
  } else if (result.status === 429) {
    code = 'RATE_LIMITED';
    message = '잠시 후 다시 시도해 주세요.';
  } else if (result.status >= 400 && result.status < 500) {
    code = 'REJECTED';
    message = '입력한 내용을 확인해 주세요.';
  }
  throw new NaverAdapterError(code, { providerStatus: result.status, providerCode, message });
}

export interface PartnerRequest {
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: object;
  /** Durable attempt key from the caller's ledger; required on every change (persona `Idempotency-Key`). */
  attemptKey?: string;
  signal?: AbortSignal;
}

export const attemptKeyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
export const PARTNER = '/partner-assumed/v1';

/** Partner-assumed P/O call; business payload is the per-row allowlist, metadata stays in headers. */
export async function partner(provider: Provider, operation: OperationId, request: PartnerRequest) {
  const write = OPERATIONS[operation].write;
  if (write && (!request.attemptKey || !attemptKeyPattern.test(request.attemptKey))) {
    throw new NaverAdapterError('INVALID_INPUT', { detail: 'attemptKey' });
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) search.set(key, String(value));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.attemptKey) headers['idempotency-key'] = request.attemptKey;
  if (request.json !== undefined) headers['content-type'] = 'application/json';
  const result = await call(provider, operation, PARTNER + request.path + (search.size ? `?${search}` : ''), {
    headers, body: request.json === undefined ? undefined : JSON.stringify(request.json), signal: request.signal,
  });
  return { result, json: partnerOutcome(result, write) };
}

export const segment = (value: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'ref' });
  return value;
};

/** Owner-supplied text guard; provider bounds are applied by callers where the provider documents them. */
export function ownerText(value: unknown, max: number, detail: string, min = 1): string {
  if (typeof value !== 'string' || value.includes('\u0000')) throw new NaverAdapterError('INVALID_INPUT', { detail });
  const size = Array.from(value.trim()).length;
  if (size < min || size > max) throw new NaverAdapterError('INVALID_INPUT', { detail });
  return value;
}

/** Second confirmation required for delete, cancel, end and unpublish (D-323, PERSONA_NAVER §3). */
export function requireSecondConfirmation(confirmation: unknown) {
  if (confirmation !== 'confirmed-twice') throw new NaverAdapterError('CONFIRMATION_REQUIRED');
}

/** KST calendar date for the injected clock (D-313 fixed test clock or D-346 real clock). */
export const seoulDate = (now: Date) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
export const shiftDate = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
