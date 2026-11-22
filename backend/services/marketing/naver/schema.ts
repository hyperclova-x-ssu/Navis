import { NaverAdapterError, type AdapterCode } from './errors.ts';

/**
 * Field lists for official W wires and partner-assumed P/O contracts.
 *
 * `strict` rejects keys outside the list. Persona and fake bindings validate strictly so the
 * provider cannot invent fields (D-345). Live W bindings tolerate additional official keys and
 * the projection drops them.
 */
export type Shape =
  | { t: 'string'; max?: number; min?: number; pattern?: RegExp; values?: readonly string[] }
  | { t: 'int'; min?: number; max?: number }
  | { t: 'number' }
  | { t: 'bool' }
  | { t: 'array'; of: Shape; max?: number; min?: number }
  | { t: 'object'; fields: Readonly<Record<string, Field>> };
export type Field = Shape & { optional?: boolean; nullable?: boolean };

export const str = (options: Omit<Extract<Shape, { t: 'string' }>, 't'> = {}): Shape => ({ t: 'string', ...options });
export const int = (options: Omit<Extract<Shape, { t: 'int' }>, 't'> = {}): Shape => ({ t: 'int', ...options });
export const num = (): Shape => ({ t: 'number' });
export const bool = (): Shape => ({ t: 'bool' });
export const arr = (of: Shape, options: { max?: number; min?: number } = {}): Shape => ({ t: 'array', of, ...options });
export const obj = (fields: Record<string, Field>): Extract<Shape, { t: 'object' }> => ({ t: 'object', fields });
export const opt = <T extends Shape>(shape: T): Field => ({ ...shape, optional: true });
export const nul = <T extends Shape>(shape: T): Field => ({ ...shape, nullable: true });
export const oneOf = (values: readonly string[]): Shape => ({ t: 'string', values });

export const isoDate = str({ pattern: /^\d{4}-\d{2}-\d{2}$/ });
export const isoInstant = str({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/ });
/** Opaque local selector for one visible resource (PERSONA_NAVER §2 P/O). */
export const opaqueRef = str({ pattern: /^[A-Za-z0-9_-]{1,80}$/ });

type CheckOptions = { strict: boolean; code?: AdapterCode };

function fail(code: AdapterCode, path: string): never {
  throw new NaverAdapterError(code, { detail: path });
}

export function check(shape: Shape, value: unknown, options: CheckOptions, path = '$'): void {
  const code = options.code ?? 'CONTRACT_VIOLATION';
  switch (shape.t) {
    case 'string':
      if (typeof value !== 'string') fail(code, path);
      if (shape.min !== undefined && Array.from(value).length < shape.min) fail(code, path);
      if (shape.max !== undefined && Array.from(value).length > shape.max) fail(code, path);
      if (shape.pattern && !shape.pattern.test(value)) fail(code, path);
      if (shape.values && !shape.values.includes(value)) fail(code, path);
      return;
    case 'int':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(code, path);
      if (shape.min !== undefined && value < shape.min) fail(code, path);
      if (shape.max !== undefined && value > shape.max) fail(code, path);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(code, path);
      return;
    case 'bool':
      if (typeof value !== 'boolean') fail(code, path);
      return;
    case 'array':
      if (!Array.isArray(value)) fail(code, path);
      if (shape.max !== undefined && value.length > shape.max) fail(code, path);
      if (shape.min !== undefined && value.length < shape.min) fail(code, path);
      value.forEach((item, index) => check(shape.of, item, options, `${path}[${index}]`));
      return;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, path);
      const record = value as Record<string, unknown>;
      if (options.strict) {
        for (const key of Object.keys(record)) if (!Object.hasOwn(shape.fields, key)) fail(code, `${path}.${key}`);
      }
      for (const [key, field] of Object.entries(shape.fields)) {
        const present = Object.hasOwn(record, key) && record[key] !== undefined;
        if (!present) {
          if (!field.optional) fail(code, `${path}.${key}`);
          continue;
        }
        if (record[key] === null) {
          if (!field.nullable) fail(code, `${path}.${key}`);
          continue;
        }
        check(field, record[key], options, `${path}.${key}`);
      }
      return;
    }
  }
}

/** Validate and return a deep copy that keeps only the listed keys. */
export function project<T>(shape: Shape, value: unknown, options: CheckOptions): T {
  check(shape, value, options);
  return pick(shape, value) as T;
}

function pick(shape: Shape, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (shape.t === 'array') return (value as unknown[]).map(item => pick(shape.of, item));
  if (shape.t !== 'object') return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape.fields)) {
    if (Object.hasOwn(record, key) && record[key] !== undefined) result[key] = pick(field, record[key]);
  }
  return result;
}

/** Field paths of a shape, used by tests to compare a wire against its official field list. */
export function fieldPaths(shape: Shape, prefix = ''): string[] {
  if (shape.t === 'array') return fieldPaths(shape.of, `${prefix}[]`);
  if (shape.t !== 'object') return [];
  return Object.entries(shape.fields).flatMap(([key, field]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...fieldPaths(field, path)];
  });
}

/** Paths actually present in a value (arrays merged), for exact wire comparisons in tests. */
export function valuePaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap(item => valuePaths(item, `${prefix}[]`)))];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...valuePaths(item, path)];
  });
}
