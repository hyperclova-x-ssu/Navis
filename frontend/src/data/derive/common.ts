import { deepFreeze } from '../db/freeze';
import { isIsoDate } from '../db/time';
import type { DataSnapshot } from '../db/types';
import type { BaseUnit } from '../db/management-types';

export class DataQueryError extends Error {
  constructor(readonly code: 'VALIDATION' | 'NOT_FOUND', readonly field: string) { super(code); }
}
export function requireDate(date: string): void { if (!isIsoDate(date)) throw new DataQueryError('VALIDATION', 'date'); }
export function memoSelector<A, R>(keyOf: (args: A) => string, read: (s: DataSnapshot, args: A) => R): (s: DataSnapshot, args: A) => R {
  const snapshots = new WeakMap<DataSnapshot, Map<string, R>>();
  return (s, args) => {
    let cache = snapshots.get(s);
    if (!cache) snapshots.set(s, cache = new Map());
    const key = keyOf(args);
    if (cache.has(key)) return cache.get(key)!;
    const value = deepFreeze(read(s, args));
    cache.set(key, value);
    return value;
  };
}
export const unitFactor = (unit: string): number => unit === 'L' || unit === 'kg' ? 1_000 : 1;
export const unitDimension = (unit: string): string => ['L', 'mL'].includes(unit) ? 'volume' : ['kg', 'g'].includes(unit) ? 'mass' : unit;
export function toBase(quantity: number, unit: string): number | null {
  if (!['L', 'mL', 'kg', 'g', 'pcs'].includes(unit) || !Number.isFinite(quantity)) return null;
  const base = quantity * unitFactor(unit), rounded = Math.round(base);
  return Number.isSafeInteger(rounded) && Math.abs(base - rounded) < 1e-7 ? rounded : null;
}
export const fromBase = (quantity: number, unit: string): number => quantity / unitFactor(unit);
export const isBaseUnit = (unit: string): unit is BaseUnit => ['g', 'kg', 'mL', 'L', 'pcs'].includes(unit);
export const roundRate = (profit: number, total: number): number | null => total > 0 ? Math.round(profit / total * 1_000) / 10 : null;
