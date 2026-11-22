/** Data commands (DATA_MODEL 10.11, API-09 v4). Every command is synchronous and pure. */
import type { CalendarSource, Channel, DataText, Evidence, ExpenseCategory, ManualCategory, Material, Mood, Zone } from '../db/types';
import type { MarketingCommand } from '../marketing/types';
import { MARKETING_ONCE_COMMANDS } from '../marketing/commands';

import type { ManagementCommand } from './management-types';
import type { CalendarCategory } from '../db/management-types';
import type { NoticeCommand } from '../iteration7/notices';
import type { EnvironmentCommand } from '../iteration7/environment';
import type { CustomOrderCommand } from '../iteration7/custom-orders';
import type { StaffCommand } from '../iteration7/staff/types';
import type { MemberRealCommand } from '../reality/05/commands';
import type { MoneyRealCommand } from '../reality/09/commands';
import type { CustomRealCommand } from '../reality/08/commands';
import type { BookingRealCommand } from '../reality/06/commands';
import type { LocalRealCommand } from '../reality/13/commands';
import type { PromoRealCommand } from '../reality/16/commands';
import type { BriefingRealCommand } from '../reality/12/commands';
import type { InboxRealCommand } from '../reality/15/commands';
import type { TaxRealCommand } from '../reality/18/commands';
type LegacyDataCommand =
  // D-326 reversible single-record bookkeeping.
  | { readonly type: 'ledger.updateExpense'; readonly expenseId: string; readonly date?: string; readonly amount?: number; readonly category?: ExpenseCategory; readonly memo?: string; readonly idempotencyKey: string }
  | { readonly type: 'manuals.setPublished'; readonly manualId: string; readonly published: false; readonly idempotencyKey: string }
  // End D-326.
  | { readonly type: 'ledger.recordExpense'; readonly date: string; readonly category: ExpenseCategory; readonly amount: number; readonly evidence?: Evidence; readonly memo?: string; readonly supplierId?: string; readonly confirmDuplicate?: boolean }
  | { readonly type: 'ledger.confirmCandidate'; readonly expenseId: string }
  | { readonly type: 'tax.markChecked'; readonly refId: string }
  | { readonly type: 'tax.export'; readonly period: { readonly start: string; readonly end: string } }
  | { readonly type: 'grants.markReviewed'; readonly noticeId: string }
  | { readonly type: 'grants.syncNotices'; readonly region: string; readonly industry: string }
  | { readonly type: 'cctv.markPeakForReview'; readonly date: string; readonly hour: number }
  | { readonly type: 'memberships.useOnce'; readonly billId?:string; readonly allocationId?:string; readonly quantity?:number; readonly membershipId: string; readonly idempotencyKey: string }
  | { readonly type: 'memberships.cancelUse'; readonly idempotencyKey?:string; readonly useId: string }
  | { readonly type: 'booking.confirm'; readonly reservationId: string }
  | { readonly type: 'booking.propose'; readonly reservationId: string; readonly time: string }
  | { readonly type: 'booking.markNoShow'; readonly reservationId: string }
  | { readonly type: 'calendar.addEvent'; readonly storeClosure?: { readonly kind: 'regular' | 'temporary'; readonly endDate: string } | null; readonly categoryId?: CalendarCategory; readonly title: string; readonly date: string; readonly time?: string | null; readonly memo?: string; readonly dateIntent?: 'historical'; readonly confirmDuplicate?: boolean }
  | { readonly type: 'calendar.addTodo'; readonly title: string; readonly date?: string; readonly memo?: string; readonly dateIntent?: 'historical'; readonly confirmDuplicate?: boolean }
  | { readonly type: 'calendar.updateEvent'; readonly storeClosure?: { readonly kind: 'regular' | 'temporary'; readonly endDate: string } | null; readonly categoryId?: CalendarCategory; readonly eventId: string; readonly title?: string; readonly date?: string; readonly time?: string | null; readonly memo?: string | null; readonly dateIntent?: 'historical'; readonly confirmDuplicate?: boolean }
  | { readonly type: 'calendar.deleteEvent'; readonly eventId: string }
  | { readonly type: 'calendar.setSourceVisible'; readonly source: CalendarSource; readonly visible: boolean }
  | { readonly type: 'inventory.moveChannel'; readonly itemId: string; readonly from: Channel; readonly to: Channel; readonly qty: number }
  // REAL-PLAN F03: widget-only stock lots. Only an HTTP stock domain implements them; fixture mode answers REAL_ONLY. Not in the Navis command policy.
  | { readonly type: 'inventory.registerBatch'; readonly itemId: string; readonly quantity: number; readonly expiresOn: string; readonly idempotencyKey?: string }
  | { readonly type: 'inventory.discardBatch'; readonly batchId: string; readonly idempotencyKey?: string }
  | { readonly type: 'inventory.updateItem'; readonly itemId: string; readonly name?: string; readonly stock?: number; readonly threshold?: number }
  | { readonly type: 'suppliers.recordReceipt'; readonly polId: string; readonly qty: number; readonly idempotencyKey: string }
  | { readonly type: 'suppliers.changeDueDate'; readonly poId: string; readonly date: string }
  | { readonly type: 'hiring.saveDraft'; readonly days: readonly number[]; readonly start: string; readonly end: string; readonly tasks: readonly DataText[]; readonly hourlyWage: number; readonly contact: DataText }
  | { readonly type: 'hiring.markCopied' }
  | { readonly type: 'manuals.toggleStep'; readonly manualId: string; readonly stepNo: number; readonly checked?: boolean }
  | { readonly type: 'manuals.createDraftFromMemo'; readonly section?: 'handover' | 'store-info'; readonly cautions?: string; readonly memo: string; readonly idempotencyKey?: string }
  | { readonly type: 'manuals.saveDraft'; readonly section?: 'handover' | 'store-info'; readonly cautions?: string; readonly draftId: string; readonly title?: string; readonly steps?: readonly string[]; readonly category?: ManualCategory }
  | { readonly type: 'manuals.discardDraft'; readonly draftId: string }
  | { readonly type: 'interior.select'; readonly mood: Mood; readonly materials: readonly Material[] }
  | { readonly type: 'interior.saveMemo'; readonly memo: string }
  | { readonly type: 'floorPlan.saveDraftLayout'; readonly name?: string; readonly tables: readonly { readonly zone: Zone; readonly seats: number }[]; readonly aisleCm: number }
  | { readonly type: 'floorPlan.applyLayout'; readonly layoutId: string }
  | { readonly type: 'floorPlan.generateFromPhotos' }
  // N20 local-change transitions.
  | { readonly type: 'localChanges.acknowledge'; readonly changeId: string }
  | { readonly type: 'localChanges.unacknowledge'; readonly changeId: string }
  // End N20 local-change transitions.
  // N17 draft persistence and exact replies. The widget may mark an existing send without a body.
  | { readonly type: 'reply.draft'; readonly threadId: string; readonly idempotencyKey: string }
  | { readonly type: 'inquiry.saveDraft'; readonly threadId: string; readonly body: string; readonly revision: number; readonly idempotencyKey: string }
  | { readonly type: 'inquiry.send'; readonly threadId: string; readonly body?: string; readonly idempotencyKey: string; readonly previewVariant?: string }
  | { readonly type: 'inquiry.post'; readonly threadId: string; readonly body?: string; readonly idempotencyKey: string; readonly previewVariant?: string }
  | { readonly type: 'community.accept'; readonly offerId: string; readonly idempotencyKey?: string }
  | { readonly type: 'community.decline'; readonly offerId: string; readonly idempotencyKey?: string }
  | { readonly type: 'community.sendInterest'; readonly offerId: string; readonly idempotencyKey?: string }
  // End N17 commands.
  /** plan-2 marketing commands (DATA_MODEL 10.15.4, T-058). */
  | MarketingCommand;

// D-326's local card can undo a paid pickup. The widget uses the original command shape.
export type ReversiblePickupCommand = Extract<CustomOrderCommand, { type: 'customOrder.receive' }> & { readonly reversiblePickup: true };
export type DataCommand = (LegacyDataCommand | ManagementCommand | StaffCommand | NoticeCommand | EnvironmentCommand | CustomOrderCommand | ReversiblePickupCommand | MemberRealCommand | MoneyRealCommand | CustomRealCommand | BookingRealCommand | LocalRealCommand | BriefingRealCommand | PromoRealCommand | InboxRealCommand | TaxRealCommand) & { readonly baseRevision?: number };
export type DataCommandType = DataCommand['type'];
export type DataErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'PREVIEW_FAILURE';
export type DataCommandResult =
  | { readonly ok: true; readonly revision: number; readonly undoToken?: string; readonly noticeKey?: string; readonly params?: Readonly<Record<string, string | number>>; readonly duplicate?: boolean; readonly value?: unknown; /** HTTP domain: previewed locally, the server has not confirmed yet. */ readonly pending?: true }
  | { readonly ok: false; readonly code: DataErrorCode; readonly field?: string; readonly messageKey: string; readonly reason?: string; readonly details?: Readonly<Record<string, unknown>>; /** HTTP domain: the request may have reached the server; reconcile before resending (REAL-PLAN F00). */ readonly outcomeUnknown?: true };

/** Commands that must carry an idempotency key (applied at most once per key, AC-238). */
export const ONCE_COMMANDS: ReadonlySet<DataCommandType> = new Set<DataCommandType>([
  'memberships.useOnce', 'suppliers.recordReceipt', 'inquiry.send', 'inquiry.post', ...MARKETING_ONCE_COMMANDS,
  'reply.draft', 'inquiry.saveDraft', // N17
  'inquiry.create', 'inquiry.import', 'inquiry.editReply', 'inquiry.deleteReply', 'notice.deleteNews', // F15 (HTTP only)
]);
/** Widget whose sample state can affect a command (the dispatch hook fills `previewVariant`). */
export const PREVIEW_AWARE: Readonly<Partial<Record<DataCommandType, 'ai-response'>>> = { 'inquiry.send': 'ai-response', 'inquiry.post': 'ai-response' };
