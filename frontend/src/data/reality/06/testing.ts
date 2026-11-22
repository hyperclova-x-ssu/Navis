/**
 * Test support (R1-F06): an in-memory booking service behind the F00 `fetch` stub, speaking the B06 wire (`.evidence/real/B06-booking-dto.md`).
 * It models only what the browser contract needs: filters, revisions, idempotent creates, the duplicate / Npay / stale refusals,
 * candidate acceptance and receipts with a six-second undo for local changes. Not imported by app code.
 */
import { fakeBackend, reply, type RecordedCall } from '../00/testing';
import type { BookingActions, BookingProductDto, CallDayDto, ChangeDto, PosTableDto, ReservationDto, SuggestionDto } from './dto';

export const asOf = '2026-11-21T09:00:00.000Z';
export const undoUntil = '2999-01-01T00:00:00.000Z';
const list = <T,>(items: readonly T[], sourceRevision: number) => ({ items, nextCursor: null, asOf, sourceRevision });

export const visit = (patch: Partial<ReservationDto> & Pick<ReservationDto, 'reservationId'>): ReservationDto => ({
  date: '2026-11-21', time: '18:00', partySize: 2, status: 'confirmed', source: 'direct', confirmedBy: 'person', callId: null, proposedTime: null,
  guestName: '김하나', phone: '010-1234-5678', request: null, memberId: null, tableId: null, assignmentMode: 'auto', revision: 1, sourceMetadata: null, ...patch,
});
/** The service's eligibility for a NAVER booking (B06 `naverVisit`): a confirmed or completed Npay booking is refundable, so it can be cancelled with refund terms; the provider has no inverse of a cancel. */
export const naverActions = (status: ReservationDto['status'], npayLinked: boolean): BookingActions => {
  const active = status === 'needs-check' || status === 'confirmed';
  const cancelRequiresRefund = (status === 'confirmed' || status === 'completed') && npayLinked;
  return { change: active && !npayLinked, confirm: status === 'needs-check', cancel: active || (status === 'completed' && cancelRequiresRefund), cancelRequiresRefund, cancelUndoable: false };
};
export const naver = (bookingNumber: string, patch: Partial<ReservationDto> = {}): ReservationDto => {
  const row = visit({
    reservationId: `naver-${bookingNumber}`, status: 'needs-check', guestName: '박○○', phone: '010-****-5678', partySize: null, confirmedBy: null,
    sourceMetadata: { kind: 'naver', bookingNumber, product: '저녁 코스', npayLinked: false }, ...patch,
  });
  return { ...row, actions: patch.actions === undefined ? naverActions(row.status, row.sourceMetadata?.npayLinked === true) : patch.actions };
};
export const candidate = (suggestionId: string, patch: Partial<SuggestionDto> = {}): SuggestionDto => ({
  suggestionId, callAt: '2026-11-21T08:40:00.000Z', date: '2026-11-21', time: '19:30', partySize: 4, phoneMasked: '010-****-4321', request: null,
  status: 'pending', reservationId: null, revision: 1, ...patch,
});

export interface BookingSeed {
  readonly reservations?: readonly ReservationDto[];
  readonly suggestions?: readonly SuggestionDto[];
  readonly calls?: readonly CallDayDto[];
  readonly changes?: readonly ChangeDto[];
  readonly products?: readonly BookingProductDto[];
  readonly tables?: readonly PosTableDto[];
}

/** One service: build a session store per test with `bookingSession`, or call `backend.fetch` directly. */
export function bookingService(seed: BookingSeed = {}) {
  const backend = fakeBackend();
  const reservations = new Map((seed.reservations ?? []).map(row => [row.reservationId, structuredClone(row) as ReservationDto]));
  const suggestions = new Map((seed.suggestions ?? []).map(row => [row.suggestionId, structuredClone(row) as SuggestionDto]));
  const calls = [...(seed.calls ?? [])];
  const changes = [...(seed.changes ?? [])];
  const products = [...(seed.products ?? [])];
  const tables = [...(seed.tables ?? [])];
  const stored = new Map<string, unknown>();
  let sequence = 0, receiptSequence = 0, sourceRevision = 1;
  const undone: string[] = [];
  const receipts = new Map<string, { readonly before: ReservationDto | null; readonly id: string; readonly suggestion?: SuggestionDto }>();
  // `contradictoryUndo`: a (wrong) provider receipt that carries an undo deadline although the service says a NAVER cancel has no inverse.
  const control: { failList: boolean; naver: 'ready' | 'partial' | 'unavailable'; refuseCancel: boolean; contradictoryUndo: boolean } = { failList: false, naver: 'ready', refuseCancel: false, contradictoryUndo: false };

  const receipt = (resourceId: string, revision: number, local: boolean, key: string, before: ReservationDto | null, suggestion?: SuggestionDto, undoable?: false) => {
    const receiptId = `rc-${++receiptSequence}`;
    if (local) receipts.set(receiptId, { before, id: resourceId, ...(suggestion ? { suggestion } : {}) });
    sourceRevision++;
    const body = { resourceId, revision, receiptId, ...(local ? { undoUntil } : {}),
      affectedSources: ['voice-booking', 'reservations', 'members', 'calendar', 'briefing', 'pos.tables'], changed: true, ...(undoable === false ? { undoable } : {}) };
    stored.set(key, body);
    return body;
  };
  const once = (call: RecordedCall, make: () => unknown) => {
    const key = call.headers.get('idempotency-key') ?? `anon-${++sequence}`;
    return stored.get(key) ?? make();
  };
  const bump = (row: ReservationDto, patch: Partial<ReservationDto>) => {
    const merged = { ...row, ...patch, revision: row.revision + 1 } as ReservationDto;
    // the service recomputes a NAVER booking's eligibility from its new status
    const next: ReservationDto = merged.sourceMetadata && merged.actions ? { ...merged, actions: naverActions(merged.status, merged.sourceMetadata.npayLinked) } : merged;
    reservations.set(row.reservationId, next);
    return next;
  };

  backend.on('GET', '/reservations', call => {
    if (control.failList) return reply(503, { code: 'SERVICE_UNAVAILABLE' });
    const { startDate, endDate, date, status, q } = call.query;
    const rows = [...reservations.values()].filter(row =>
      (!date || row.date === date) && (!startDate || row.date >= startDate) && (!endDate || row.date <= endDate) && (!status || row.status === status)
      && (!q || (row.guestName ?? '').includes(q) || (row.sourceMetadata?.bookingNumber ?? '') === q));
    return { ...list(rows, sourceRevision), sourceStatus: { naver: control.naver } };
  });
  backend.on('GET', '/reservation-suggestions', call => list([...suggestions.values()].filter(row => !call.query.status || row.status === call.query.status), sourceRevision));
  backend.on('GET', '/call-records', () => ({ ...list(calls, sourceRevision), period: { startDate: calls[0]?.date ?? '2026-11-15', endDate: calls.at(-1)?.date ?? '2026-11-21' }, channels: ['네이버 검색'] }));
  // The POS service refuses a page size above 50 (INVALID_LIMIT), exactly as the real one does.
  backend.on('GET', '/pos/tables', call => Number(call.query.limit ?? 30) > 50 ? reply(400, { code: 'VALIDATION', reason: 'INVALID_LIMIT' }) : list(tables, sourceRevision));
  backend.on('GET', '/reservation-changes', () => list(changes, sourceRevision));
  backend.on('GET', '/booking-products', () => list(products, sourceRevision));

  backend.on('POST', '/reservations', call => once(call, () => {
    const body = call.body as { guest?: { name: string; phone?: string }; memberId?: string; date: string; time: string; partySize: number; request?: string | null; confirmDuplicate?: boolean };
    if (!Number.isInteger(body.partySize) || body.partySize < 1) return reply(400, { code: 'VALIDATION', reason: 'PARTY_INVALID', field: 'partySize' });
    const same = [...reservations.values()].find(row => row.date === body.date && row.time === body.time && row.guestName === body.guest?.name && row.status !== 'canceled');
    if (same && !body.confirmDuplicate) return reply(409, { code: 'CONFLICT', reason: 'BOOKING_DUPLICATE', field: 'time', details: { reservationId: same.reservationId, date: same.date, time: same.time, partySize: same.partySize } });
    const row = visit({ reservationId: `rv-${++sequence}`, date: body.date, time: body.time, partySize: body.partySize, guestName: body.guest?.name ?? null,
      phone: body.guest?.phone ?? null, memberId: body.memberId ?? null, request: body.request ?? null, confirmedBy: 'auto' });
    reservations.set(row.reservationId, row);
    changes.push({ changeId: `chg-${row.reservationId}`, reservationId: row.reservationId, at: asOf, kind: 'created' });
    return receipt(row.reservationId, row.revision, true, call.headers.get('idempotency-key') ?? '', null);
  }));

  backend.on('PATCH', /^\/reservations\/[^/]+$/u, call => once(call, () => {
    const id = decodeURIComponent(call.path.split('/')[2]);
    const row = reservations.get(id);
    if (!row) return reply(404, { code: 'NOT_FOUND' });
    const { patch, expectedRevision } = call.body as { patch: Partial<ReservationDto>; expectedRevision: number };
    if (row.sourceMetadata?.npayLinked) return reply(409, { code: 'CONFLICT', reason: 'NPAY_LINKED_BOOKING' });
    if (expectedRevision !== row.revision) return reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' });
    const next = bump(row, patch);
    return receipt(id, next.revision, !row.sourceMetadata, call.headers.get('idempotency-key') ?? '', row);
  }));

  backend.on('POST', /^\/reservations\/[^/]+\/transitions$/u, call => once(call, () => {
    const id = decodeURIComponent(call.path.split('/')[2]);
    const body = call.body as { type: string; time?: string; confirmed?: boolean; expectedRevision: number; cancelReason?: string; refund?: { type: string; value?: number } };
    const key = call.headers.get('idempotency-key') ?? '';
    const found = suggestions.get(id);
    if (found) {
      if (found.status !== 'pending' && !(found.status === 'proposed' && body.type === 'booking.declineSuggestion')) return reply(409, { code: 'CONFLICT', reason: 'BOOKING_TRANSITION' });
      if (body.expectedRevision !== found.revision) return reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' });
      if (body.type === 'booking.declineSuggestion') {
        if (body.confirmed !== true) return reply(400, { code: 'VALIDATION', reason: 'CONFIRMATION_REQUIRED' });
        suggestions.set(id, { ...found, status: 'declined', revision: found.revision + 1 });
        return receipt(id, found.revision + 1, false, key, null);
      }
      if (body.type === 'booking.propose') {
        suggestions.set(id, { ...found, status: 'proposed', proposedTime: body.time ?? null, revision: found.revision + 1 });
        return receipt(id, found.revision + 1, true, key, null, found);
      }
      if (body.type !== 'booking.confirm') return reply(409, { code: 'CONFLICT', reason: 'BOOKING_TRANSITION' });
      const made = visit({ reservationId: `rv-${++sequence}`, date: found.date, time: found.time, partySize: found.partySize, source: 'phone_ai', guestName: null,
        phone: found.phoneMasked, request: found.request ?? null, confirmedBy: 'person', tableId: 'T3' });
      reservations.set(made.reservationId, made);
      suggestions.set(id, { ...found, status: 'accepted', reservationId: made.reservationId, revision: found.revision + 1 });
      return receipt(made.reservationId, made.revision, false, key, null);
    }
    const row = reservations.get(id);
    if (!row) return reply(404, { code: 'NOT_FOUND' });
    if (body.expectedRevision !== row.revision) return reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' });
    const provider = !!row.sourceMetadata;
    const to = ({ 'booking.confirm': 'confirmed', 'booking.propose': 'proposed', 'booking.cancel': 'canceled', 'booking.markNoShow': 'no-show', 'booking.markCompleted': 'completed' } as Record<string, ReservationDto['status']>)[body.type];
    if (!to) return reply(400, { code: 'VALIDATION', reason: 'BOOKING_TRANSITION' });
    if (body.type === 'booking.cancel' && body.confirmed !== true) return reply(400, { code: 'VALIDATION', reason: 'CONFIRMATION_REQUIRED' });
    if ((to === 'confirmed' || to === 'proposed') && row.status !== 'needs-check') return reply(409, { code: 'CONFLICT', reason: 'BOOKING_TRANSITION' });
    if (row.sourceMetadata?.npayLinked && to === 'proposed') return reply(409, { code: 'CONFLICT', reason: 'NPAY_LINKED_BOOKING' });
    // B06 provider cancel: the reason is required; a confirmed or completed Npay booking also takes refund terms bounded by its payment amount, any other takes none;
    // a booking the service does not list as cancellable is a status refusal. A local booking takes no cancel reason or refund at all.
    if (body.type === 'booking.cancel') {
      if (!provider && (body.cancelReason !== undefined || body.refund !== undefined)) return reply(400, { code: 'VALIDATION', reason: 'INVALID_REQUEST' });
      if (provider) {
        const actions = row.actions ?? naverActions(row.status, row.sourceMetadata?.npayLinked === true);
        if (!actions.cancel) return reply(409, { code: 'CONFLICT', reason: 'BOOKING_TRANSITION' });
        if (!body.cancelReason?.trim()) return reply(400, { code: 'VALIDATION', reason: 'CANCEL_REASON_REQUIRED', field: 'cancelReason' });
        if (control.refuseCancel) return reply(409, { code: 'CONFLICT', reason: 'BOOKING_PROVIDER_REFUSED' });
        if (actions.cancelRequiresRefund && !body.refund) return reply(400, { code: 'VALIDATION', reason: 'REFUND_REQUIRED', field: 'refund' });
        const paid = row.sourceMetadata?.paymentAmount;
        const valid = !actions.cancelRequiresRefund ? !body.refund
          : body.refund!.type === 'full' ? true
          : body.refund!.type === 'rate' ? Number.isFinite(body.refund!.value) && body.refund!.value! >= 0 && body.refund!.value! <= 100
          : paid !== undefined && Number.isSafeInteger(body.refund!.value) && body.refund!.value! >= 0 && body.refund!.value! <= paid;
        if (!valid) return reply(400, { code: 'VALIDATION', reason: 'INVALID_REFUND_TERMS', field: 'refund' });
      }
    }
    const next = bump(row, { status: to, ...(to === 'proposed' ? { proposedTime: body.time ?? null } : {}), ...(to === 'confirmed' ? { confirmedBy: 'person' as const } : {}) });
    changes.push({ changeId: `chg-${++sequence}`, reservationId: id, at: asOf, kind: to === 'canceled' ? 'canceled' : 'status' });
    return receipt(id, next.revision, !provider || (control.contradictoryUndo && to === 'canceled'), key, row, undefined, provider && to === 'canceled' ? false : undefined);
  }));

  backend.on('POST', /^\/booking\/receipts\/[^/]+\/undo$/u, call => {
    const receiptId = call.path.split('/')[3];
    const found = receipts.get(receiptId);
    if (found?.suggestion) {
      undone.push(receiptId);
      const current = suggestions.get(found.id)!;
      suggestions.set(found.id, { ...found.suggestion, revision: current.revision + 1 });
      return { resourceId: found.id, revision: current.revision + 1, receiptId: `undo-${receiptId}`, affectedSources: ['voice-booking', 'reservations'], changed: true };
    }
    if (!found?.before) return reply(409, { code: 'CONFLICT', reason: 'UNDO_UNAVAILABLE' });
    undone.push(receiptId);
    const current = reservations.get(found.id)!;
    reservations.set(found.id, { ...found.before, revision: current.revision + 1 });
    return { resourceId: found.id, revision: current.revision + 1, receiptId: `undo-${receiptId}`, affectedSources: ['voice-booking', 'reservations'], changed: true };
  });

  return { backend, reservations, suggestions, undone, control, changes };
}
