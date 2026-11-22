/**
 * REAL-PLAN F12 — the one place the owner's explicit acknowledgement is sent to the service.
 * The widget's confirm button and the Navis card (`ui.acknowledgeBriefing`) both end here; the key is fixed per business day, so a second
 * press, a card replay or a reload resends the same key and the service keeps one receipt (B12: concurrent acknowledgements and retries share the first).
 */
import type { WidgetDataStore } from '../../db/store';

/** B12 accepts 1–128 ASCII letters, digits or `_.:-`; the day is part of the key so a key is never reused for another day. */
export const ackKey = (businessDay: string): string => `briefing-ack:${businessDay}`;

export type AckOutcome =
  | { readonly ok: true; readonly recorded: boolean }
  | { readonly ok: false; readonly messageKey: string; readonly reason?: string };

/** True when this build reads the briefing over HTTP (the acknowledgement then lives on the service, not only in the run). */
export const briefingIsReal = (store: WidgetDataStore): boolean => store.real?.mode('briefing') === 'http';

/**
 * Records the acknowledgement of the service's current business day once. `null` in fixture builds (the run flag is the whole acknowledgement there).
 * A day that is already acknowledged on the service sends nothing. A day change on the service refreshes the read and fails, so the owner presses again.
 */
export async function recordBriefingAcknowledgement(store: WidgetDataStore): Promise<AckOutcome | null> {
  const port = store.real;
  if (!port || port.mode('briefing') !== 'http') return null;
  let read = store.getSnapshot().tables.realBriefing;
  if (!read) {
    const loaded = await port.load('briefing');
    read = store.getSnapshot().tables.realBriefing;
    if (!read) return { ok: false, messageKey: loaded.error ? 'data.real.error.SERVICE_UNAVAILABLE' : 'briefing.error.notRecorded' };
  }
  if (read.acknowledgement) return { ok: true, recorded: false };
  const result = await store.execute({ type: 'briefing.acknowledge', businessDay: read.businessDay, idempotencyKey: ackKey(read.businessDay) });
  if (!result.ok) {
    if (result.reason === 'BRIEFING_DAY_CHANGED') await port.retry('briefing');
    return { ok: false, messageKey: result.messageKey, reason: result.reason };
  }
  // The receipt names `briefing`, so the port already re-read it; a service that names something else still gets its read refreshed.
  if (!store.getSnapshot().tables.realBriefing?.acknowledgement) await port.retry('briefing');
  return { ok: true, recorded: true };
}
