import { withWidgetFailureCopy } from '../../data/commands/failure-copy';

/**
 * A widget that calls `store.execute` itself (W26 promo, the W21 inbox) receives the reason-only key the data layer gives Navis, which writes its
 * own card sentence around it. A widget shows the whole line, "실행하지 못했어요 · {이유}. {다음}" (the same line `useDataExecute` gives every
 * other widget). Keys that are not such a fallback are returned unchanged.
 */
export function widgetFailureKey(messageKey: string): string {
  const shown = withWidgetFailureCopy({ ok: false, code: 'CONFLICT', messageKey });
  return shown.ok ? messageKey : shown.messageKey;
}
