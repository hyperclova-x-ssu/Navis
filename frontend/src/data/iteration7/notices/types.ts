import type { CalendarEvent, DataTables } from '../../db/types';
import type { CustomerGroupId } from '../../marketing/types';
export interface ClosureCalendarEvent extends CalendarEvent {
  readonly revision?: number;
  readonly storeClosure?: { readonly kind: 'regular' | 'temporary'; readonly endDate: string } | null;
}
export interface StoreClosure {
  readonly eventId: string; readonly revision: number;
  readonly kind: 'regular' | 'temporary'; readonly title: string; readonly body: string;
  readonly startDate: string; readonly endDate: string;
}
export type NoticeKind = 'regular_closure' | 'temporary_closure' | 'hours_change' | 'other';
export type NoticeAudience = 'all_contactable' | 'group';
export type NoticeContentClass = 'informational' | 'promotional';
/** F15 (HTTP only): where an owner's notice goes. `manual` = the owner posts it themselves and records that. SMS needs A6 and cannot be sent yet. */
export type NoticeChannel = 'manual' | 'sms' | 'talktalk' | 'place-news' | 'place-hours';
export type NoticeTalkAudience = 'benefit-subscribers' | 'recent-visitor-reviewers';
export type NoticeBusinessHours = { readonly day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'; readonly open: string; readonly close: string };
export type NoticePin = { readonly from: string; readonly to: string; readonly order: number };
export interface NoticeDraft {
  readonly noticeId: string; readonly kind: NoticeKind; readonly title: string; readonly body: string;
  readonly startDate: string; readonly endDate: string; readonly closureEventId: string | null; readonly closureRevision: number | null;
  readonly audience: NoticeAudience; readonly groupIds: readonly CustomerGroupId[]; readonly contentClass: NoticeContentClass; readonly revision: number;
  /** F15 (HTTP only, absent in the fixture): the service record's channel and its channel-specific fields. */
  readonly channel?: NoticeChannel; readonly talkAudience?: NoticeTalkAudience; readonly couponRef?: string; readonly recipientGroupId?: string;
  readonly pin?: NoticePin; readonly businessHours?: readonly NoticeBusinessHours[];
}
export interface NoticePreviewView {
  readonly previewId: string; readonly draftRevision: number; readonly contentClass: NoticeContentClass;
  readonly recipientCount: number; readonly excludedCount: number; readonly renderedBody: string;
  readonly adMarker: boolean; readonly optOutText: string; readonly sendAllowed: boolean; readonly reasons: readonly string[];
}
/** Internal only: public command results must omit these recipient IDs and source signature. */
export interface NoticePreview extends NoticePreviewView {
  readonly draftId: string; readonly eligibleMemberIds: readonly string[]; readonly signature: string;
}
export interface NoticeSent extends NoticeDraft {
  readonly sentId: string; readonly draftRevision: number; readonly recipientCount: number;
  readonly renderedBody: string; readonly sentAt: string; readonly status: 'sent_example' | 'sent';
  readonly closureTitle: string | null; readonly closureBody: string | null;
  /** F15 (`sent`): provider acceptance, a saved Place change, or the owner's record of a manual post. */
  readonly result?: 'saved' | 'accepted' | 'recorded'; readonly providerRef?: string;
}
// D-326: a confirmed schedule is a queue record until a send completes.
export type NoticeScheduled = Omit<NoticeSent, 'sentAt' | 'status'> & {
  readonly status: 'scheduled';
  readonly sendAt: string;
  readonly sentAt: null;
};
export type NoticeHistory = NoticeSent | NoticeScheduled;
// End D-326.
export interface NoticeTables {
  readonly noticeDraft: readonly NoticeDraft[];
  readonly noticePreview: readonly NoticePreview[];
  readonly noticeSent: readonly NoticeHistory[];
}
export type NoticeSourceTables = Omit<DataTables, 'calendarEvent'> & NoticeTables & { readonly calendarEvent: readonly ClosureCalendarEvent[] };
export interface NoticesQuery { readonly period?: { readonly start: string; readonly end: string }; readonly groupIds?: readonly CustomerGroupId[] }
/** `none` = not linked; `current` = in step with its closure; the rest mean the draft must be imported again. */
export type ClosureLinkStatus = 'none' | 'current' | 'changed' | 'removed' | 'dates';
export interface NoticesModel {
  readonly drafts: readonly NoticeDraft[]; readonly sent: readonly NoticeSent[]; readonly scheduled: readonly NoticeScheduled[];
  /** Per draft id: is it still in step with its calendar closure (re-import when not). */
  readonly closureLinks: Readonly<Record<string, ClosureLinkStatus>>;
  readonly upcomingUnsentClosures: readonly StoreClosure[];
  readonly unsentCount: number; readonly sentCount: number; readonly nextClosure: StoreClosure | null;
}
export type NoticeCommand = (
  | { readonly type: 'notice.saveDraft'; readonly noticeId?: string; readonly kind: NoticeKind; readonly title: string; readonly body: string; readonly startDate: string; readonly endDate: string; readonly closureEventId?: string | null; readonly audience: NoticeAudience; readonly groupIds: readonly CustomerGroupId[]; readonly idempotencyKey?: string
      /** F15 (HTTP only): channel and its fields; Navis cards leave them out and keep the draft's channel (`manual` for a new one). */
      readonly channel?: NoticeChannel; readonly talkAudience?: NoticeTalkAudience; readonly couponRef?: string; readonly recipientGroupId?: string; readonly pin?: NoticePin; readonly businessHours?: readonly NoticeBusinessHours[] }
  | { readonly type: 'notice.importClosure'; readonly noticeId?: string; readonly eventId: string; readonly idempotencyKey: string }
  | { readonly type: 'notice.deleteDraft'; readonly noticeId: string; readonly idempotencyKey: string }
  // D-326: preview and send use the same optional schedule time.
  | { readonly type: 'notice.preview'; readonly noticeId: string; readonly draftRevision: number; readonly sendAt?: string }
  | { readonly type: 'notice.send'; readonly noticeId: string; readonly draftRevision: number; readonly previewId: string; readonly sendAt?: string; readonly idempotencyKey: string }
  | { readonly type: 'notice.cancelSchedule'; readonly sentId: string; readonly idempotencyKey: string }
  // End D-326.
) & { readonly baseRevision?: number };
