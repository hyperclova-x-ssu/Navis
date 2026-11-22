/**
 * REAL-PLAN F12 — the one briefing write. It exists only over HTTP: the fixture run keeps the briefing flag in the run
 * itself (`acknowledgeBriefing`). The Navis command policy keeps `ui.acknowledgeBriefing` unchanged; the card press and the
 * widget's confirm button both end here, with the same idempotency key per business day.
 */
export type BriefingRealCommand =
  | { readonly type: 'briefing.acknowledge'; readonly businessDay: string; readonly idempotencyKey?: string };
