import type { PosCommandMeta, PosCommandValue, PosFailure, PosPlanningResult, PosReadSnapshot, PosState, PosSuccess, PosUiState } from '../../contracts/pos';

export function freezePos<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezePos(child);
  }
  return value;
}
/** Canonical payloads do not include optimistic revision guards. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const posFailure = (reason: string, code: PosFailure['code'] = 'VALIDATION', details?: PosFailure['details']): PosFailure =>
  ({ ok: false, code, reason, messageKey: messageKeyFor(reason), ...(details ? { details } : {}) });
function messageKeyFor(reason: string): string {
  const keys: Record<string, string> = {
    REQUIRED_OPTION: 'order.option.required', QTY_LIMIT: 'order.cart.quantityLimit', TEXT_LIMIT: 'order.cart.noteLimit',
    SOLD_OUT: 'order.menu.soldOut', ITEM_REMOVED: 'order.menu.removed', EMPTY_CART: 'order.cart.empty',
    DATA_UNAVAILABLE: 'order.menu.loadError', DAY_CLOSED: 'order.closed.reason', APPROVAL_FAILED: 'order.payment.failed',
  };
  return keys[reason] ?? 'run.session.conflict';
}
export const money = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
export const quantity = (n: number): boolean => Number.isSafeInteger(n) && n >= 1 && n <= 99;
export const commandKey = (meta: PosCommandMeta, type: string): string => canonical([meta.runId, type, meta.idempotencyKey]);
export function checkMeta(read: PosReadSnapshot, meta: PosCommandMeta, type: string, payload: unknown): PosPlanningResult | null {
  if (meta.runId !== read.runId) return posFailure('STALE_RUN', 'CONFLICT');
  if (!meta.idempotencyKey) return posFailure('IDEMPOTENCY_KEY_REQUIRED');
  const entry = read.pos.commandLedger.find(e => e.key === commandKey(meta, type));
  if (entry) {
    if (entry.scenario !== read.scenario || entry.closingGeneration !== read.data.closingGeneration) return posFailure('STALE_REVISION', 'CONFLICT');
    if (entry.fingerprint !== canonical(payload)) return posFailure('IDEMPOTENCY_MISMATCH', 'CONFLICT');
    if (entry.undone) return posFailure('COMMAND_UNDONE', 'CONFLICT');
    return { ok: true, plan: { nextPos: read.pos, nextUi: read.posUi, result: { ...entry.result, duplicate: true } } };
  }
  if (meta.expectedPosRevision !== undefined && meta.expectedPosRevision !== read.posRevision || meta.expectedDataRevision !== undefined && meta.expectedDataRevision !== read.dataRevision) return posFailure('STALE_REVISION', 'CONFLICT');
  return null;
}
export function makePlan(read: PosReadSnapshot, nextPos: PosState, nextUi: PosUiState, value: PosCommandValue, meta: PosCommandMeta, type: string, payload: unknown, undoToken?: string): PosPlanningResult {
  const result: PosSuccess<PosCommandValue> = { ok: true, status: 'applied', posRevision: nextPos.revision, dataRevision: read.dataRevision + 1, value, ...(undoToken ? { undoToken } : {}) };
  const entry = { key: commandKey(meta, type), fingerprint: canonical(payload), scenario: read.scenario, closingGeneration: read.data.closingGeneration, result, undone: false };
  return { ok: true, plan: freezePos({ nextPos: { ...nextPos, commandLedger: [...nextPos.commandLedger, entry] }, nextUi, result }) };
}
export function unchanged(read: PosReadSnapshot, value: PosCommandValue): PosPlanningResult {
  return { ok: true, plan: { nextPos: read.pos, nextUi: read.posUi, result: { ok: true, status: 'unchanged', posRevision: read.posRevision, dataRevision: read.dataRevision, value } } };
}
