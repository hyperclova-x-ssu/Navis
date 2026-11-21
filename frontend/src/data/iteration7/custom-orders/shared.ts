import { isIsoDate, isTime, NOW, TODAY } from '../../db/time';
import type { CustomCommandValue, CustomFailure, CustomMoneyEffects, CustomOrder, CustomOrderRead, CustomOrderTables, CustomPlanResult, CustomHistory } from './types';

export const clock = (read: CustomOrderRead) => read.now ?? NOW;
export const businessDate = (read: CustomOrderRead) => read.businessDate ?? TODAY;
export const emptyEffects = (): CustomMoneyEffects => ({ settlements: [], payments: [], recognitions: [], corrections: [] });
export const failure = (reason: string, field?: string, code: CustomFailure['code'] = 'VALIDATION', details?: CustomFailure['details']): CustomFailure => ({ ok: false, code, reason, ...(field ? { field } : {}), messageKey: `data.custom.error.${reason}`, ...(details ? { details } : {}) });
export const validStamp = (stamp: unknown, halfHour = false): stamp is string => typeof stamp === 'string' && stamp.length === 16 && stamp[10] === 'T' && isIsoDate(stamp.slice(0, 10)) && isTime(stamp.slice(11)) && (!halfHour || ['00', '30'].includes(stamp.slice(14)));
export const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
export const nonempty = (s: unknown): s is string => typeof s === 'string' && !!s.trim();
export function fingerprint(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter(k => object[k] !== undefined).map(k => `${JSON.stringify(k)}:${fingerprint(object[k])}`).join(',')}}`;
}
const ledgerKey = (type: string, key: string) => `custom:${type}:${key}`;
type Operation = { readonly type: string; readonly idempotencyKey?: string; readonly baseRevision?: number };
const commandFingerprint = (operation: Operation) => {
  const payload = Object.fromEntries(Object.entries(operation).filter(([key]) => key !== 'baseRevision'));
  return fingerprint(payload);
};
/** The shared run/day/attempt gate runs before these pure plans. Replay precedes stale revision validation. */
export function guard(read: CustomOrderRead, operation: Operation, keyRequired = true): CustomPlanResult | null {
  if (keyRequired && !nonempty(operation.idempotencyKey)) return failure('REQUIRED_FIELD', 'idempotencyKey');
  if (operation.idempotencyKey) {
    const record = read.tables.appliedKeys?.[ledgerKey(operation.type, operation.idempotencyKey)];
    if (record) {
      if (record.command !== commandFingerprint(operation)) return failure('IDEMPOTENCY_MISMATCH', 'idempotencyKey', 'CONFLICT');
      const saved = record.result as { value: CustomCommandValue; undoable: boolean };
      return { ok: true, tables: read.tables, moneyEffects: emptyEffects(), value: saved.value, undoable: saved.undoable, changed: false };
    }
  }
  if (operation.baseRevision !== undefined && operation.baseRevision !== read.revision) return failure('STALE_REVISION', 'baseRevision', 'CONFLICT');
  return null;
}
export function success(_read: CustomOrderRead, operation: Operation, tables: CustomOrderTables, value: CustomCommandValue, undoable = false, effects = emptyEffects(), changed = true): CustomPlanResult {
  const entry = operation.idempotencyKey && changed ? { [ledgerKey(operation.type, operation.idempotencyKey)]: { command: commandFingerprint(operation), result: { value, undoable } } } : null;
  return { ok: true, tables: entry ? { ...tables, appliedKeys: { ...tables.appliedKeys, ...entry } } : tables, value, undoable, moneyEffects: effects, changed };
}
export function history(read: CustomOrderRead, order: CustomOrder, kind: CustomHistory['kind'], detail: string, referenceId: string | null = null): CustomOrder {
  return { ...order, history: [...order.history, { historyId: `${order.customOrderId}:history:${order.history.length + 1}`, at: clock(read), kind, stage: order.stage, quoteRevision: order.quoteRevision, detail, referenceId }] };
}
export const replaceOrder = (tables: CustomOrderTables, row: CustomOrder): CustomOrderTables => ({ ...tables, customOrder: tables.customOrder.map(o => o.customOrderId === row.customOrderId ? row : o) });
export const approved = (order: CustomOrder) => order.customerDecision === 'approved' && order.approvedQuoteRevision === order.quoteRevision && positive(order.quoteAmount);
