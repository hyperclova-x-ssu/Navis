// The structural transport port matches packages/naver/transport without importing provider code.
export type NaverTransport = {
  request(operation: string, storeId: string, path: string, init?: {
    headers?: HeadersInit; body?: BodyInit; approvalScope?: unknown;
  }): Promise<Response>;
};
export type OwnerContext = { storeId: string; actorId: string };
// Construct only in the owning command after authenticating the owner and checking the
// pressed card, exact target, current revision, expiry and durable idempotency record.
export type OwnerApproval = { key: string; extraConfirmed?: true };

export class NaverError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function approval(value: OwnerApproval, destructive = false) {
  if (!value || !/^[A-Za-z0-9_:.~-]{1,160}$/.test(value.key) || (destructive && value.extraConfirmed !== true)) {
    throw new NaverError(403, 'OWNER_CONFIRMATION_REQUIRED');
  }
  return value.key;
}

export function commandHeaders(value: OwnerApproval, destructive = false) {
  return { 'Idempotency-Key': approval(value, destructive), 'content-type': 'application/json' };
}

export function query(fields: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.size ? '?' + params : '';
}

export function selector(value: string) {
  if (!/^[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,159}$/.test(value)) throw new NaverError(400, 'INVALID_NAVER_SELECTOR');
  return value;
}

export function invalidWire(): never { throw new NaverError(502, 'INVALID_NAVER_RESPONSE'); }

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidWire();
  return value as Record<string, unknown>;
}

export function text(v: unknown): string {
  return typeof v === 'string' ? v : invalidWire();
}
export function integer(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : invalidWire();
}
export function boolean(v: unknown): boolean {
  return typeof v === 'boolean' ? v : invalidWire();
}
export function list<T>(v: unknown, map: (entry: unknown) => T): T[] {
  return Array.isArray(v) ? v.map(map) : invalidWire();
}
export function choice<T extends string>(v: unknown, allowed: readonly T[]): T {
  return allowed.find(x => x === v) ?? invalidWire();
}

export async function checked(response: Response) {
  if (response.ok) return response;
  if (response.body) await response.body.cancel().catch(() => {});
  const status = [400, 403, 404, 409, 429].includes(response.status) ? response.status : 502;
  throw new NaverError(status, 'NAVER_OPERATION_FAILED');
}

export async function json(response: Promise<Response>) {
  const result = await checked(await response);
  try { return await result.json() as unknown; } catch { return invalidWire(); }
}

export function ownerRequest(transport: NaverTransport, context: OwnerContext) {
  return (operation: string, path: string, init?: Parameters<NaverTransport['request']>[3]) =>
    transport.request(operation, context.storeId, path, {
      ...init, approvalScope: init?.approvalScope ?? { actorId: context.actorId },
    });
}
