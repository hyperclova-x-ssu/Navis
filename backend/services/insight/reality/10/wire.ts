import { InsightError, isUuid } from '../../scope.ts';

export function invalid(): never { throw new InsightError(400, 'INVALID_REQUEST'); }

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}

export function id(value: unknown) {
  if (!isUuid(value)) invalid();
  return value;
}

export function number(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid();
  return value;
}

export function revision(value: unknown) {
  const parsed = number(value, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(parsed)) invalid();
  return parsed;
}

export function instant(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid();
  const datePart = Date.parse(value.slice(0, 10));
  if (!Number.isFinite(datePart) || new Date(datePart).toISOString().slice(0, 10) !== value.slice(0, 10)
      || value.startsWith('0000') || Number(value.slice(11, 13)) >= 24) invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time)) invalid();
  return new Date(time);
}

export function pageQuery(value: unknown, fields: string[]) {
  const input = object(value, ['cursor', 'limit', ...fields]);
  const { limit = '50' } = input;
  if (typeof limit !== 'string' || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) invalid();
  return { limit: Number(limit), cursor: input.cursor, input };
}

export function period(input: Record<string, unknown>, now: Date) {
  const to = input.to === undefined ? now : instant(input.to);
  const from = input.from === undefined ? new Date(to.getTime() - 86_400_000) : instant(input.from);
  if (from >= to || to.getTime() - from.getTime() > 31 * 86_400_000) invalid();
  return { from, to };
}
