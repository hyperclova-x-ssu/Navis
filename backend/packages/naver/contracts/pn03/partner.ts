import { createHash } from 'node:crypto';

export const partnerPrefix = '/partner-assumed/v1';
export const refPattern = /^[a-zA-Z0-9_-]{1,100}$/;

export function partnerError(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

export function fields(input: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    partnerError(400, '올바른 요청 형식이 필요해요.');
  }
  const data = input as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(data, key))
      || Object.keys(data).some((key) => !required.includes(key) && !optional.includes(key))) {
    partnerError(400, '지원되는 항목만 입력해 주세요.');
  }
  return data;
}

export function emptyBody(input: unknown) {
  if (input !== undefined) fields(input, []);
}

export function text(input: unknown, max: number, min = 1) {
  if (typeof input !== 'string' || input.includes('\0')) partnerError(400, '글자를 입력해 주세요.');
  const value = input.trim();
  const size = Array.from(value).length;
  if (size < min || size > max) partnerError(400, '입력 길이를 확인해 주세요.');
  return value;
}

export function oneOf<const T extends string>(input: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(input as T)) partnerError(400, '지원되는 값을 선택해 주세요.');
  return input as T;
}

export function integer(input: unknown, min: number, max: number) {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) {
    partnerError(400, '숫자 범위를 확인해 주세요.');
  }
  return input;
}

export function flag(input: unknown) {
  if (typeof input !== 'boolean') partnerError(400, '설정 값을 확인해 주세요.');
  return input;
}

export function ref(input: unknown) {
  if (typeof input !== 'string' || !refPattern.test(input)) partnerError(400, '대상을 확인해 주세요.');
  return input;
}

export function day(input: unknown) {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    partnerError(400, '날짜를 확인해 주세요.');
  }
  const date = new Date(input + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input || input.startsWith('0000')) {
    partnerError(400, '날짜를 확인해 주세요.');
  }
  return input;
}

const kstClock = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });
export const kstDay = (now: Date) => kstClock.format(now);
export function shiftDay(date: string, days: number) {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(input).sort().map((key) => [key, ordered(input[key])]));
}

export function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}

export function page(query: Record<string, unknown>) {
  function number(input: unknown, fallback: number, min: number, max: number) {
    if (input === undefined) return fallback;
    if (typeof input !== 'string' || !/^\d+$/.test(input)) partnerError(400, '페이지 범위를 확인해 주세요.');
    return integer(Number(input), min, max);
  }
  return [number(query.limit, 50, 1, 100), number(query.offset, 0, 0, 10000)] as const;
}
