import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

export const validKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_:.~-]{1,160}$/.test(value);

export type PosTx = { db: PoolClient; storeId: string; actorId: string; at: Date };
export type PaymentMethod = 'card' | 'easy_pay' | 'cash';
export type MethodSplit = { method: PaymentMethod; amount: number };
export const methods = ['card', 'easy_pay', 'cash'] as const;

export type PosFailure = {
  ok: false;
  code: 'VALIDATION' | 'CONFLICT' | 'NOT_FOUND' | 'PREVIEW_FAILURE';
  reason: string;
  messageKey: string;
  details?: Record<string, unknown>;
};

const messageKeys: Record<string, string> = {
  REQUIRED_OPTION: 'order.option.required',
  QTY_LIMIT: 'order.cart.quantityLimit',
  SOLD_OUT: 'order.menu.soldOut',
  ITEM_REMOVED: 'order.menu.removed',
  DAY_CLOSED: 'order.closed.reason',
  APPROVAL_FAILED: 'order.payment.failed',
  WHOLE_BILL_DISCOUNT: 'order.reversal.WHOLE_BILL_DISCOUNT',
  REFUND_LIMIT: 'order.reversal.REFUND_LIMIT',
  USE_REFUND: 'order.reversal.USE_REFUND',
  EMPTY_SELECTION: 'order.reversal.EMPTY_SELECTION',
};

export class PosError extends Error {
  readonly statusCode: number;
  readonly result: PosFailure;
  constructor(statusCode: number, reason: string, details?: Record<string, unknown>) {
    super(reason);
    this.statusCode = statusCode;
    const code = statusCode === 404 ? 'NOT_FOUND' : statusCode === 409 ? 'CONFLICT'
      : statusCode === 422 ? 'PREVIEW_FAILURE' : 'VALIDATION';
    this.result = { ok: false, code, reason, messageKey: messageKeys[reason] ?? 'run.session.conflict', ...(details ? { details } : {}) };
  }
}

export function applied<T>(value: T, transactionId: string) {
  return { ok: true, status: 'applied', transactionId, value } as const;
}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !keys.includes(key))) throw new PosError(400, 'INVALID_REQUEST');
  return value as Record<string, unknown>;
}

export function uuid(value: unknown): string {
  const id = typeof value === 'string' ? value.toLowerCase() : value;
  if (!isUuid(id)) throw new PosError(400, 'INVALID_REQUEST');
  return id;
}

export function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER, reason = 'INVALID_REQUEST'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new PosError(400, reason);
  }
  return value;
}

export function splits(value: unknown): MethodSplit[] {
  if (!Array.isArray(value) || !value.length || value.length > methods.length) {
    throw new PosError(400, 'INVALID_REQUEST');
  }
  const parsed = value.map((split) => {
    const input = object(split, ['method', 'amount']);
    const method = methods.find((allowed) => allowed === input.method);
    if (!method) throw new PosError(400, 'INVALID_REQUEST');
    return { method, amount: integer(input.amount, 1, Number.MAX_SAFE_INTEGER, 'INVALID_AMOUNT') };
  });
  if (new Set(parsed.map((row) => row.method)).size !== parsed.length) throw new PosError(400, 'INVALID_REQUEST');
  return parsed.sort((a, b) => methods.indexOf(a.method) - methods.indexOf(b.method));
}

export function fingerprint(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1));
  });
  return createHash('sha256').update(canonical).digest('hex');
}
