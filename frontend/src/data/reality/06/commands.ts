/**
 * HTTP-only booking action. The existing booking commands (`booking.create|update|confirm|propose|cancel|markNoShow|markCompleted`)
 * keep their names and arguments, so Navis cards follow automatically. Declining an AiCall candidate has no local equivalent
 * (a fixture phone row is cancelled instead), so only the booking domain implements it and it is not in the Navis command policy.
 */
export type BookingRealCommand =
  | { readonly type: 'booking.declineSuggestion'; readonly reservationId: string; readonly idempotencyKey?: string };
