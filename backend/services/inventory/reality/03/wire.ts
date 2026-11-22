export class StockError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  readonly reason: string;
  readonly field?: string;
  constructor(status: StockError['status'], reason: string, field?: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
    this.field = field;
  }
}

export const isUuid = (input: unknown): input is string =>
  typeof input === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input);
export const keyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
export const units = { g: ['g', 1], kg: ['g', 1000], mL: ['mL', 1], L: ['mL', 1000], pcs: ['pcs', 1] } as const;
export type Unit = keyof typeof units;
export type Channel = 'store' | 'online';

export function uuid(input: unknown, field: string) {
  if (!isUuid(input)) throw new StockError(400, 'INVALID_REQUEST', field);
  return input.toLowerCase();
}

export function object(input: unknown, fields: string[], readOnly = false): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StockError(400, 'INVALID_REQUEST');
  const unknown = Object.keys(input).find(key => !fields.includes(key));
  if (unknown) throw new StockError(400, readOnly ? 'READ_ONLY_FIELD' : 'INVALID_REQUEST', unknown);
  return input as Record<string, unknown>;
}

export function text(input: unknown, field: string, maximum: number) {
  // eslint-disable-next-line no-control-regex -- Inventory labels must reject ASCII controls.
  if (typeof input !== 'string' || !input.trim() || input.trim().length > maximum || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new StockError(400, field === 'sku' ? 'SKU_REQUIRED' : 'NAME_REQUIRED', field);
  }
  return input.trim();
}

export function unit(input: unknown): Unit {
  if (typeof input !== 'string' || !Object.hasOwn(units, input)) throw new StockError(400, 'INVALID_REQUEST', 'unit');
  return input as Unit;
}

export function quantity(input: unknown, field: string) {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > Number.MAX_SAFE_INTEGER) {
    throw new StockError(400, 'NUMBER_INVALID', field);
  }
  return input;
}

export function base(input: number, inUnit: Unit, field: string) {
  const offset = input * units[inUnit][1];
  const rounded = Math.round(offset);
  if (!Number.isSafeInteger(rounded) || rounded / units[inUnit][1] !== input) {
    throw new StockError(400, 'UNIT_PRECISION', field);
  }
  return BigInt(rounded);
}

export function flag(input: unknown, field: string) {
  if (typeof input !== 'boolean') throw new StockError(400, 'INVALID_REQUEST', field);
  return input;
}

export function revision(input: unknown) {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1 || input > 2_147_483_647) {
    throw new StockError(400, 'INVALID_REQUEST', 'expectedRevision');
  }
  return input;
}

export function confirmation(input: unknown) {
  if (input !== true) throw new StockError(400, 'CONFIRMATION_REQUIRED', 'confirmed');
}

export function channel(input: unknown, field: string): Channel {
  if (input !== 'store' && input !== 'online') throw new StockError(400, 'INVALID_REQUEST', field);
  return input;
}

export function date(input: unknown, field: string) {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input) || input.startsWith('0000')) {
    throw new StockError(400, 'INVALID_REQUEST', field);
  }
  const parsed = new Date(input);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== input) {
    throw new StockError(400, 'INVALID_REQUEST', field);
  }
  return input;
}

export function pageInput(input: unknown, fields: string[]) {
  const { cursor, limit, ...filters } = object(input, ['limit', 'cursor', ...fields]);
  const size = limit === undefined ? 50 : typeof limit === 'string' && /^\d{1,3}$/.test(limit) ? Number(limit) : 0;
  if (size < 1 || size > 200) throw new StockError(400, 'INVALID_REQUEST', 'limit');
  return { limit: size, cursor: cursor === undefined ? null : uuid(cursor, 'cursor'), filters };
}
