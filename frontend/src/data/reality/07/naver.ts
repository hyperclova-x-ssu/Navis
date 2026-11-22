/**
 * GAPUI-CAL (PN11, D-347) — one-way exports of Navis calendar and staff records to NAVER Calendar and the selected WORKS team calendar.
 * Wire: `backend/services/customer/reality/07/naver-wire.ts` and README "PN11 one-way exports". Every write is a card press: the owner's
 * press is first recorded at the issuer (`/calendar/naver-approvals`, adopted contract relay_e50b79d3c682), and the issued card UUID is
 * both the body `approvalId` and the `Idempotency-Key`. A WORKS delete is pressed and then confirmed. Typed or spoken text never gets here.
 * Navis stays the source: nothing is read back from NAVER into the calendar or the roster, and the ICS download is unchanged.
 */
import { addDays } from '../../db/time';
import { PortError, type PortRequest, type PortTransport } from '../00';
import type { StaffSchedule } from '../../iteration7/staff/types';

export type ExportOperation = 'calendar.add' | 'works.create' | 'works.update' | 'works.delete';

type ExportReceipt = { readonly resourceId: string; readonly receiptId: string; readonly revision: number; readonly sentAt: string };
export type CalendarPushReceipt = ExportReceipt & {
  readonly eventId: string; readonly processType: 'create' | 'modify'; readonly affectedSources: readonly ['calendar'];
};
export type WorksPushReceipt = ExportReceipt & {
  readonly scheduleId: string; readonly eventId: string; readonly operation: 'create' | 'update' | 'delete'; readonly affectedSources: readonly ['staff-schedule'];
};
export type ExportReceiptOf<T extends ExportOperation> = T extends 'calendar.add' ? CalendarPushReceipt : WorksPushReceipt;
export type WorksTime = { readonly date: string } | { readonly dateTime: string; readonly timeZone: 'Asia/Seoul' };
/** `sentAt` and `revision` come from the latest non-delete receipt (FIX-GAP-A); optional so an older customer build still lists the rows. */
export type WorksListItem = {
  readonly scheduleId: string; readonly eventId: string; readonly summary: string; readonly start: WorksTime; readonly end?: WorksTime;
  readonly sentAt?: string; readonly revision?: number;
};
export type WorksList = { readonly items: readonly WorksListItem[] };

/** One review card: what the owner is looking at, and the server approval once the primary button was pressed. */
export interface ExportCard {
  readonly operation: ExportOperation;
  readonly resourceId: string;
  /** Event revision for `calendar.add`, shift revision for WORKS. */
  readonly expectedRevision: number;
  /** Staff revision (the event summary carries the name); WORKS create and update only. */
  readonly expectedStaffRevision?: number;
  /** One per review, so a lost issuer answer replays instead of issuing twice. */
  readonly attemptKey: string;
  readonly approvalId?: string;
  readonly expiresAt?: string;
  readonly requiresConfirmation?: boolean;
  readonly confirmed?: true;
  /** The write left the browser with this approval: an unknown outcome is checked with the same key, never a new card. */
  readonly submitted?: true;
}

const approvals = '/calendar/naver-approvals';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'STORE_FORBIDDEN']);
const badResponse = (sent: boolean) => new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE', undefined, sent);
const item = (base: string, id: string) => `${base}/${encodeURIComponent(id)}`;

export const requiresSecondConfirmation = (operation: ExportOperation) => operation === 'works.delete';
const carriesStaff = (operation: ExportOperation) => operation === 'works.create' || operation === 'works.update';

export function exportApprovalExpired({ expiresAt }: Pick<ExportCard, 'expiresAt'>, now = Date.now()) {
  return expiresAt !== undefined && Date.parse(expiresAt) <= now;
}

/** The owner's press (`press`), or the second press of a delete (`confirm`, same approval). */
export async function issueExportApproval(transport: PortTransport, card: ExportCard, signal: AbortSignal) {
  const { operation, resourceId, expectedRevision, expectedStaffRevision, approvalId, attemptKey } = card;
  const stage = approvalId ? 'confirm' : 'press';
  const response = await transport.request<{ readonly approvalId?: unknown; readonly expiresAt?: unknown; readonly requiresConfirmation?: unknown }>({
    method: 'POST', path: approvals, signal, idempotencyKey: `${attemptKey}:${stage}`,
    body: {
      stage, operation, resourceId, expectedRevision,
      ...(carriesStaff(operation) && expectedStaffRevision !== undefined ? { expectedStaffRevision } : {}),
      ...(approvalId ? { approvalId } : {}),
    },
  });
  const issued = response?.approvalId;
  if (typeof issued !== 'string' || !uuid.test(issued) || (approvalId && issued !== approvalId)) throw badResponse(false);
  return {
    approvalId: issued,
    ...(typeof response.expiresAt === 'string' ? { expiresAt: response.expiresAt } : {}),
    requiresConfirmation: response.requiresConfirmation === true,
  };
}

const routes: Readonly<Record<ExportOperation, (id: string) => Pick<PortRequest, 'method' | 'path'>>> = {
  'calendar.add': id => ({ method: 'POST', path: `${item('/calendar/events', id)}/naver` }),
  'works.create': id => ({ method: 'POST', path: `${item('/shifts', id)}/naver-works` }),
  'works.update': id => ({ method: 'PATCH', path: `${item('/shifts', id)}/naver-works` }),
  'works.delete': id => ({ method: 'DELETE', path: `${item('/shifts', id)}/naver-works` }),
};

function validReceipt(card: ExportCard, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<CalendarPushReceipt & WorksPushReceipt>;
  if (receipt.resourceId !== card.resourceId || receipt.receiptId !== card.approvalId || typeof receipt.sentAt !== 'string'
    || !Number.isFinite(Date.parse(receipt.sentAt)) || typeof receipt.revision !== 'number') return false;
  if (card.operation === 'calendar.add') return receipt.processType === 'create' || receipt.processType === 'modify';
  return receipt.scheduleId === card.resourceId && receipt.operation === card.operation.slice('works.'.length);
}

/** The export itself. Only reachable with an issued approval (and the recorded second press for a delete). */
export async function submitExport<T extends ExportOperation>(transport: PortTransport, card: ExportCard & { readonly operation: T }, signal: AbortSignal) {
  const { operation, resourceId, expectedRevision, expectedStaffRevision, approvalId } = card;
  if (!approvalId) throw new PortError(409, 'CONFLICT', 'CARD_REQUIRED');
  if (requiresSecondConfirmation(operation) && !card.confirmed) throw new PortError(409, 'CONFLICT', 'EXTRA_CONFIRMATION_REQUIRED');
  const receipt = await transport.request<ExportReceiptOf<T>>({
    ...routes[operation](resourceId), signal, idempotencyKey: approvalId,
    body: { approvalId, expectedRevision, ...(carriesStaff(operation) ? { expectedStaffRevision } : {}) },
  });
  if (!validReceipt(card, receipt)) throw badResponse(true);
  return receipt;
}

export function readCalendarExport(transport: PortTransport, eventId: string, signal: AbortSignal) {
  return transport.request<{ readonly receipt: CalendarPushReceipt | null }>({ method: 'GET', path: `${item('/calendar/events', eventId)}/naver`, signal });
}

/** The server accepts at most 31 days; the store runs on Seoul time (D-346), so the window is KST midnight to KST midnight. */
export function worksWindow(startDate: string, days = 31): readonly [string, string] {
  return [`${startDate}T00:00:00+09:00`, `${addDays(startDate, days)}T00:00:00+09:00`];
}

export function listWorksExports(transport: PortTransport, startDate: string, signal: AbortSignal) {
  const [fromDateTime, untilDateTime] = worksWindow(startDate);
  return transport.request<WorksList>({ method: 'GET', path: '/shifts/naver-works', query: { fromDateTime, untilDateTime }, signal });
}

/** What the server sends for a shift (`worksShiftEvent`): the remote copy is stale when any of it differs. Break minutes are not sent. */
export function worksExportChanged(sent: Pick<WorksListItem, 'summary' | 'start' | 'end'>, shift: StaffSchedule, staffName: string): boolean {
  const summary = `${staffName} ${shift.kind === 'off' ? '휴무' : '근무'}`;
  const at = (time: WorksTime | undefined) => !time ? '' : 'date' in time ? time.date : time.dateTime.slice(0, 16);
  const [start, end] = shift.start && shift.end
    ? [`${shift.date}T${shift.start}`, `${shift.date}T${shift.end}`]
    : [shift.date, addDays(shift.date, 1)];
  return sent.summary !== summary || at(sent.start) !== start || at(sent.end) !== end;
}

export type ExportOutcome = { readonly kind: 'unknown' } | { readonly kind: 'stale' } | { readonly kind: 'failed'; readonly reason: string };

/**
 * After the write left the browser, a network/5xx/unreadable answer is an unknown outcome: the card keeps its approval and checks again with the
 * same key. A stale revision needs a refreshed card. Anything else is a definite failure; the next press issues a new approval.
 */
export function exportOutcome(error: unknown, submitted: boolean): ExportOutcome {
  if (!(error instanceof PortError)) return { kind: 'failed', reason: 'UNKNOWN' };
  if (submitted && (error.outcomeUnknown || error.reason === 'NAVER_OUTCOME_PENDING')) return { kind: 'unknown' };
  if (error.reason === 'STALE_REVISION') return { kind: 'stale' };
  if (!error.reason && SESSION.has(error.code)) return { kind: 'failed', reason: 'SESSION_ENDED' };
  return { kind: 'failed', reason: error.reason ?? error.code };
}
