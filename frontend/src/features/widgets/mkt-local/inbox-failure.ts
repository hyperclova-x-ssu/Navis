import { widgetFailureKey } from '../failure-line';

type Translate = (key: string, params?: Record<string, string | number>) => string;
const inboxError = 'data.real.inbox.error.';
/** Refusals whose sentence names the reason but no next step. */
const reasonOnly: ReadonlySet<string> = new Set(['REPLY_ALREADY_RECORDED', 'REPLY_NOT_ALLOWED', 'CHANNEL_MISMATCH', 'PENDING_OR_USED_APPROVAL', 'INQUIRY_ALREADY_RECORDED',
  'NOTICE_ALREADY_COMPLETED', 'NEWS_NOT_PUBLISHED', 'AUDIENCE_UNAVAILABLE', 'QUOTA_EXHAUSTED', 'PROVIDER_UNAVAILABLE']);
/** Refusals whose sentence already ends with what to do. */
const withOwnNext: ReadonlySet<string> = new Set(['DRAFT_UNAVAILABLE', 'REPLY_BODY_MISMATCH', 'CARD_REQUIRED', 'APPROVAL_EXPIRED', 'APPROVAL_CONFLICT', 'DRAFT_REQUIRED',
  'MANUAL_ATTESTATION_REQUIRED', 'REVIEW_REPLY_CHANGED', 'UNAVAILABLE']);

/**
 * The line the inbox (W21) shows for a failed write: "실행하지 못했어요 · {이유}. {다음}" (gate r1a K9). The inbox's own refusal reasons keep their sentence as the
 * reason and take the shared next step when they have none; a state sentence (a send still being checked, sending not open) and a field message stay as they are.
 */
export function inboxFailureText(translate: Translate, messageKey: string): string {
  const reason = messageKey.startsWith(inboxError) ? messageKey.slice(inboxError.length) : undefined;
  if (reason && (reasonOnly.has(reason) || withOwnNext.has(reason))) {
    const text = translate(messageKey).replace(/[.。]$/, '');
    return reasonOnly.has(reason)
      ? translate('data.real.commandFailure.withNext', { reason: text, next: translate('data.real.commandFailure.next.CONFLICT') })
      : translate('data.real.commandFailure.withReason', { reason: text });
  }
  return translate(widgetFailureKey(messageKey));
}
