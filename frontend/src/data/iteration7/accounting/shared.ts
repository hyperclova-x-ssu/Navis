import type { PosCommandMeta } from '../../../contracts/pos';
import { canonical, freezePos, posFailure } from '../../../pos/domain/common';
import type { MoneyCompletion, MoneyEffects, MoneyPlan, MoneyRead, MoneyState } from './types';

export { canonical, freezePos };
export const methods = ['card', 'easy_pay', 'cash'] as const;
export const nonnegative = (n: number) => Number.isSafeInteger(n) && n >= 0;
export const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
export const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
export const addDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export const failure = posFailure;
export const emptyEffects = (): MoneyEffects => ({ settlements: [], payments: [], recognitions: [], accountTxns: [], memberships: [], uses: [], corrections: [], lineEffects: [] });
export const emptyMoneyState = (): MoneyState => ({ ...emptyEffects(), commands: [], attempt: null });
export function available(read: MoneyRead) {
  if (read.dayClosed) return failure('DAY_CLOSED', 'CONFLICT');
  if (read.scenario === 'error' || read.scenario === 'empty') return failure('DATA_UNAVAILABLE');
  return null;
}
export const operationKey = (read: MoneyRead, meta: PosCommandMeta) => canonical([read.runId, meta.idempotencyKey]);
export function guard(read: MoneyRead, meta: PosCommandMeta, payload: unknown): MoneyPlan | null {
  if (meta.runId !== read.runId) return failure('STALE_RUN', 'CONFLICT');
  if (!meta.idempotencyKey?.trim()) return failure('IDEMPOTENCY_KEY_REQUIRED');
  const prior = read.state.commands.find(c => c.key === operationKey(read, meta));
  if (prior) {
    if (prior.generation !== read.generation || prior.scenario !== read.scenario) return failure('STALE_REVISION', 'CONFLICT');
    if (prior.fingerprint !== canonical(payload)) return failure('IDEMPOTENCY_MISMATCH', 'CONFLICT');
    return { ok: true, nextState: read.state, effects: emptyEffects(), value: prior.value, changed: false, duplicate: true };
  }
  if (meta.expectedDataRevision !== undefined && meta.expectedDataRevision !== read.revision || meta.expectedPosRevision !== undefined && meta.expectedPosRevision !== read.revision) return failure('STALE_REVISION', 'CONFLICT');
  return available(read);
}
export function publish(read: MoneyRead, effects: MoneyEffects, value: MoneyCompletion, meta?: PosCommandMeta, payload?: unknown): MoneyPlan {
  const replace = <T>(old: readonly T[], next: readonly T[], key: (row: T) => string) => [...old.filter(o => !next.some(n => key(n) === key(o))), ...next];
  const nextState: MoneyState = { ...read.state,
    settlements: [...read.state.settlements, ...effects.settlements], payments: [...read.state.payments, ...effects.payments],
    recognitions: [...read.state.recognitions, ...effects.recognitions], accountTxns: [...read.state.accountTxns, ...effects.accountTxns],
    memberships: replace(read.state.memberships, effects.memberships, m => m.membershipId), uses: replace(read.state.uses, effects.uses, u => u.useId),
    corrections: [...read.state.corrections, ...effects.corrections], attempt: null,
    commands: meta ? [...read.state.commands, { key: operationKey(read, meta), fingerprint: canonical(payload), generation: read.generation, scenario: read.scenario, value }] : read.state.commands };
  return freezePos({ ok: true, nextState, effects, value, changed: Object.values(effects).some(rows => rows.length > 0) });
}
