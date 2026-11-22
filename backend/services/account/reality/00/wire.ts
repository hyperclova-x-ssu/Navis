import type { FastifyRequest } from 'fastify';
import type { SessionClaims } from '../../keys.ts';
import { uuidPattern } from '../../sessions.ts';

export const uuid = new RegExp(uuidPattern);
export const keyPattern = /^[A-Za-z0-9_:.~-]{1,160}$/;
export const maxAttachmentBytes = 4 * 1024 * 1024;

export class AccountError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly reason?: string;
  readonly field?: string;

  constructor(statusCode: number, code: string, reason?: string, field?: string) {
    super(reason ?? code);
    this.statusCode = statusCode;
    this.code = code;
    this.reason = reason;
    this.field = field;
  }
}

export const invalid = (field: string, reason = 'INVALID_REQUEST') => new AccountError(400, 'VALIDATION', reason, field);

export function actorFrom(request: FastifyRequest): SessionClaims {
  const { 'x-navis-store-id': store_id, 'x-navis-store-role': role, 'x-navis-user-id': sub, 'x-navis-session-id': sid } = request.headers;
  if (typeof store_id !== 'string' || !uuid.test(store_id) || typeof sub !== 'string' || !uuid.test(sub)
    || typeof sid !== 'string' || !uuid.test(sid) || (role !== 'owner' && role !== 'staff')) {
    throw new AccountError(403, 'STORE_FORBIDDEN');
  }
  return { store_id, sub, sid, role };
}

export function record(value: unknown, fields: readonly string[], field = 'body'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw invalid(field);
  }
  return value as Record<string, unknown>;
}

export function integer(value: unknown, low: number, high: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high) throw invalid(field);
  return value;
}

export function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9:_.-]{0,127}$/.test(value)) throw invalid(field);
  return value;
}

export function option<const T extends string>(value: unknown, options: readonly T[], field: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw invalid(field);
  return value as T;
}

export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalid(field);
  return value;
}

export function array<T>(value: unknown, min: number, max: number, field: string, item: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw invalid(field);
  return value.map(item);
}

export function unique<T>(values: T[], field: string): void {
  if (new Set(values).size !== values.length) throw invalid(field);
}

export function expectedRevision(value: unknown): number {
  return integer(value, 0, 2147483646, 'expectedRevision');
}
