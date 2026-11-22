import type { NaverRequestOptions } from '../../../packages/naver/transport/index.ts';
import { InsightError, isDate } from '../scope.ts';

export type Transport = {
  request(operation: string, storeId: string, path: string, options?: NaverRequestOptions): Promise<Response>;
};

export function unavailable(): never {
  throw new InsightError(503, 'SERVICE_UNAVAILABLE');
}

export function invalid(): never {
  throw new InsightError(400, 'INVALID_REQUEST');
}

export type Period = { startDate: string; endDate: string };
export function validPeriod(value: Period) {
  return isDate(value.startDate) && isDate(value.endDate) && value.startDate <= value.endDate;
}

export function query(path: string, params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  return search.size ? path + '?' + search : path;
}

export const partner = '/partner-assumed/v1';
export function ref(value: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) invalid();
  return value;
}

export type ReadJson = ReturnType<typeof readJson>;
export function readJson(transport: Transport) {
  return async (operation: string, storeId: string, path: string, init?: NaverRequestOptions) => {
    try {
      const response = await transport.request(operation, storeId, path, init);
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw new InsightError(404, 'NOT_FOUND');
        unavailable();
      }
      const data: unknown = await response.json();
      return { data, headers: response.headers };
    } catch (error) {
      if (error instanceof InsightError) throw error;
      unavailable();
    }
  };
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
  return value as Record<string, unknown>;
}

export function items<T>(value: unknown, map: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) unavailable();
  return value.map(map);
}

export function string(value: unknown): string {
  if (typeof value !== 'string') unavailable();
  return value;
}

export function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) unavailable();
  return value;
}

export function date(value: unknown): string {
  if (!isDate(value)) unavailable();
  return value;
}

export function periodOf(value: unknown): Period {
  const row = object(value);
  const period = { startDate: date(row.startDate), endDate: date(row.endDate) };
  if (!validPeriod(period)) unavailable();
  return period;
}
