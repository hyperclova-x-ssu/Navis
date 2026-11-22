import type { MessageParams } from '../../contracts';
import type { DataCommandResult, DataErrorCode } from './types';

type Translate<Key extends string> = (key: Key, params?: MessageParams) => string;
type Failure = Extract<DataCommandResult, { ok: false }>;
type FailureCopy = { readonly reason?: string; readonly next?: string; readonly unknownKey?: string };

const base = 'data.real.commandFailure';
const reasonPrefix = `${base}.reason.`;
const resultPrefix = `${base}.result.`;
export const commandFailureReasonKey = (code: DataErrorCode) => `${reasonPrefix}${code}`;
const genericKeys: ReadonlySet<string> = new Set(['data.real.error.GENERIC', 'data.real.error.VALIDATION']);
const keysWithGuidance: ReadonlySet<string> = new Set(['data.real.error.STALE_REVISION', 'data.real.error.SESSION_ENDED',
  'data.real.error.IDEMPOTENCY_MISMATCH', 'data.real.error.IDEMPOTENCY_CONFLICT']);

/** Widgets can show the whole fallback line directly. Navis uses the reason inside its own card copy. */
export function withWidgetFailureCopy(result: DataCommandResult): DataCommandResult {
  if (result.ok || !result.messageKey.startsWith(reasonPrefix)) return result;
  return { ...result, messageKey: `${resultPrefix}${result.messageKey.slice(reasonPrefix.length)}` };
}

/** Render the supplied domain copy in the existing error slot. Use an empty next step when the form already shows its action. */
export function commandFailureText<Key extends string>(translate: Translate<Key>, result: Failure, { reason, next, unknownKey }: FailureCopy = {}): string {
  const t = translate as Translate<string>;
  if (result.outcomeUnknown || result.reason === 'OUTCOME_UNKNOWN') return t(unknownKey ?? 'data.real.error.OUTCOME_UNKNOWN');

  const fallbackPrefix = [reasonPrefix, resultPrefix].find(prefix => result.messageKey.startsWith(prefix));
  const fallbackCode = fallbackPrefix ? result.messageKey.slice(fallbackPrefix.length) : result.code;
  const specificReason = reason ?? (fallbackPrefix || genericKeys.has(result.messageKey) ? '' : t(result.messageKey));
  const reasonText = specificReason || t(`${reasonPrefix}${fallbackCode}`);
  const nextText = next ?? (reason === undefined && keysWithGuidance.has(result.messageKey) ? '' : t(`${base}.next.${fallbackCode}`));
  return nextText ? t(`${base}.withNext`, { reason: reasonText.replace(/[.。]$/, ''), next: nextText }) : t(`${base}.withReason`, { reason: reasonText });
}
