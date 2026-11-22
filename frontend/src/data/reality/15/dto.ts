/**
 * F15 (REAL-PLAN B15): inquiry, reply and notice-draft DTOs of the marketing service and their mapping onto the existing
 * `inquiryThread` / `noticeDraft` / `noticeSent` tables. Persona NAVER server (네이버 가상 서버) reads are FAKE until A6.
 * Contract: backend/services/marketing/reality/15/README.md + wire.ts.
 */
import type { InquiryThread } from '../../db/types';
import type { ImportRow } from '../../models/types';
import type { ListPage } from '../00';
import type { NoticeChannel, NoticeDraft, NoticeHistory, NoticeKind, NoticeScheduled, NoticeSent, NoticeTalkAudience, NoticeBusinessHours, NoticePin } from '../../iteration7/notices/types';

export type InquirySource = 'manual' | 'review' | 'talktalk';
export type ReplyState = 'recorded' | 'saved' | 'accepted';
export interface InquiryDto {
  readonly id: string;
  readonly type: 'review' | 'message';
  readonly source: InquirySource;
  readonly providerRef: string | null;
  readonly title: string | null;
  readonly text: string | null;
  readonly sourceUrl: string | null;
  readonly draft: { readonly text: string; readonly source: 'owner' | 'naver-ai' | 'navis' } | null;
  readonly reply: { readonly text: string; readonly state: ReplyState } | null;
  readonly status: 'waiting' | 'draft_ready' | 'done';
  readonly revision: number;
  readonly updatedAt: string;
  readonly authorNotification?: string;
}
export interface NoticeDto {
  readonly id: string;
  readonly revision: number;
  readonly status: 'draft' | 'done';
  readonly title: string;
  readonly text: string;
  readonly channel: NoticeChannel;
  readonly closure: { readonly eventId: string; readonly revision: number } | null;
  readonly audience: NoticeTalkAudience | null;
  readonly recipientGroupId: string | null;
  readonly couponRef: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly businessHours: readonly NoticeBusinessHours[] | null;
  readonly pin: NoticePin | null;
  /** `scheduled`/`canceled`: an SMS reservation (PN13). A scheduled send is not a delivered SMS; its live status is read separately. */
  readonly result: { readonly state: 'saved' | 'accepted' | 'recorded' | 'scheduled' | 'canceled'; readonly providerRef?: string; readonly scheduledFor?: string } | null;
  readonly updatedAt: string;
}
export interface NoticeSmsPreviewDto {
  readonly content: string;
  readonly contentType: 'AD';
  readonly type: 'SMS' | 'LMS' | null;
  readonly bytes: number | null;
  readonly recipientCount: number | null;
  readonly maxRecipients: number;
  readonly sendAllowed: boolean;
  readonly reasons: readonly string[];
}
/** `GET /notices/:id`: the saved draft and authoritative send facts. */
export interface NoticeDetailDto extends NoticeDto {
  readonly closureStatus?: 'none' | 'current' | 'changed' | 'unavailable';
  readonly nextSendWindow?: { readonly localTime: string; readonly label: string } | null;
  readonly smsEnabled?: boolean;
  readonly smsPreview?: NoticeSmsPreviewDto;
}
/** `GET /notices/:id/sms-reservation`: the provider's current reservation status (SENS), read again on each press. */
export type SmsReservationStatus = 'READY' | 'PROCESSING' | 'CANCELED' | 'FAIL' | 'DONE' | 'STALE' | 'SKIP';
export interface SmsReservationDto { readonly resourceId: string; readonly revision: number; readonly scheduledFor: string; readonly status: SmsReservationStatus }
export interface InboxPage<T> extends ListPage<T> { readonly waitingCount: number }

/* Provider reads (fake provider until A6): never required for the record flow. */
export interface ReviewDto {
  readonly ref: string; readonly text: string; readonly keywords: readonly string[];
  readonly media: readonly { readonly type: 'photo' | 'video'; readonly url: string }[];
  readonly stars: number | null; readonly reply: string | null; readonly hasReply: boolean;
  readonly product?: string; readonly useDate?: string;
}
export interface ReviewsDto { readonly items: readonly ReviewDto[]; readonly averageStars?: number | null; readonly authorNotification?: string }
export interface ConsultationDto { readonly ref: string; readonly status: string }
export interface ConsultationsDto { readonly items: readonly ConsultationDto[]; readonly nextCursor?: string | null }
export interface AudiencesDto { readonly items: readonly { readonly audience: NoticeTalkAudience; readonly count?: number }[]; /** PN07: the monthly allowance NAVER assigned. Its consumption unit is unconfirmed, so it is never shown as a remaining amount. */ readonly quota?: { readonly month: string; readonly assigned: number } }
export interface NewsDto { readonly items: readonly { readonly ref: string; readonly title: string | null; readonly text: string; readonly video: string | null; readonly pin: NoticePin | null }[] }
/** PN03 (`/draft-preview`) and PN14 HCX-005 (`/navis-draft-preview`): a preview only. Nothing is saved or posted until the owner saves the edited text. */
export type ReviewDraftSource = 'naver-ai' | 'navis';
export interface ReviewDraftPreviewDto { readonly text: string; readonly source: ReviewDraftSource }

/** Insight `GET /insight/review-insights` (GAP-INS): NAVER review AI statistics (two days behind) and the official venue average (≥ 10 raters). */
export type ReviewStatsUnit = 'day' | 'week' | 'month';
export interface ReviewKeywordDto { readonly keyword: string; readonly count: number; readonly relatedReviews?: readonly { readonly text: string }[] }
interface Sourced { readonly source: string; readonly sourceUrl: string }
export type ReviewStatisticsDto = (Sourced & {
  readonly state: 'ready';
  readonly period: { readonly unit: ReviewStatsUnit; readonly from: string; readonly to: string };
  readonly coverage: { readonly requestedTo: string; readonly dataThrough: string; readonly lagDays: number };
  readonly themes: readonly { readonly theme: string; readonly positiveCount: number; readonly negativeCount: number }[];
  readonly topKeywords: { readonly positive: readonly ReviewKeywordDto[]; readonly negative: readonly ReviewKeywordDto[] };
}) | (Sourced & { readonly state: 'unavailable' | 'not-connected' });
export interface AverageRatingDto extends Sourced { readonly state: 'shown' | 'hidden' | 'unavailable' | 'not-connected'; readonly value: number | null; readonly minimumReviewers: number }
export interface ReviewInsightsDto {
  readonly state: 'ready' | 'not-connected'; readonly asOf: string; readonly businessDate: string;
  readonly statistics: ReviewStatisticsDto; readonly averageRating: AverageRatingDto;
}
/** The average is shown only when the provider says so (10 or more raters and the owner's display setting on). */
export const shownAverage = (insights: ReviewInsightsDto | undefined): number | undefined =>
  insights?.averageRating.state === 'shown' && typeof insights.averageRating.value === 'number' ? insights.averageRating.value : undefined;

export type Provided<T> = ({ readonly status: 'available' } & T) | { readonly status: 'unavailable' };

export interface RealInbox {
  readonly storeId: string;
  readonly asOf: string;
  readonly inquiries: readonly InquiryDto[];
  readonly notices: readonly NoticeDto[];
  /** Full-store counts across pages (the same figures Marketing Today and Navis facts use). */
  readonly waitingInquiries: number;
  readonly activeNotices: number;
  readonly reviews: Provided<ReviewsDto>;
  readonly consultations: Provided<ConsultationsDto>;
  readonly audiences: Provided<AudiencesDto>;
  readonly news: Provided<NewsDto>;
  /** The server's own sentence about the reviewer being notified of a reply (shown as received, never invented). */
  readonly authorNotification: string | null;
}

declare module '../../db/types' {
  interface DataTables { readonly realInbox?: RealInbox }
}

const reviewImport = (row: ReviewDto): ImportRow => ({ importId: `import:review:${row.ref}`, source: 'review', providerRef: row.ref,
  type: 'review', channelKey: 'data.channel.naverReview', text: row.text, stars: row.stars });

function untrackedReviews(inbox: RealInbox): readonly ReviewDto[] {
  if (inbox.reviews.status !== 'available') return [];
  const tracked = new Set(inbox.inquiries.filter(row => row.source === 'review').map(row => row.providerRef));
  return inbox.reviews.items.filter(row => !tracked.has(row.ref));
}

export type AnsweredReviewImport = ImportRow & { readonly reply: string | null };

export function answeredReviewImports(inbox: RealInbox): AnsweredReviewImport[] {
  return untrackedReviews(inbox).filter(row => row.hasReply).map(row => ({ ...reviewImport(row), reply: row.reply }));
}

/** Untracked, visible provider items that count alongside waiting inquiry records. */
export function awaitingImports(inbox: RealInbox): ImportRow[] {
  const reviews = untrackedReviews(inbox).filter(row => !row.hasReply).map(reviewImport);
  const known = new Set(inbox.inquiries.filter(row => row.source === 'talktalk').map(row => row.providerRef));
  const talks = inbox.consultations.status === 'available'
    ? inbox.consultations.items.filter(row => !known.has(row.ref) && row.status !== 'blocked' && row.status !== 'spam' && row.status !== 'completed').map((row): ImportRow => ({
      importId: `import:talktalk:${row.ref}`, source: 'talktalk', providerRef: row.ref, type: 'message', channelKey: 'data.channel.naverTalk', text: null, stars: null }))
    : [];
  return [...talks, ...reviews];
}

/** `2026-11-21T03:04:05.000Z` → the store's local wall time `2026-11-21T12:04` (Asia/Seoul, no daylight saving). */
export const localStamp = (iso: string): string => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 16);
export const channelKeyOf = (row: Pick<InquiryDto, 'source' | 'type'>): string =>
  row.source === 'talktalk' ? 'data.channel.naverTalk' : row.source === 'review' ? 'data.channel.naverReview'
    : row.type === 'review' ? 'data.real.inbox.channel.manualReview' : 'data.real.inbox.channel.manualMessage';

export function inquiryThread(row: InquiryDto, visibleReview?: ReviewDto): InquiryThread {
  const text = row.text ?? row.title ?? '';
  return {
    threadId: row.id, type: row.type, channelKey: channelKeyOf(row), isPublic: row.type === 'review', receivedAt: localStamp(row.updatedAt),
    status: row.status === 'done' ? 'done' : row.status === 'draft_ready' ? 'draft-ready' : 'waiting', needsPersonReason: null,
    bodyKey: '', draftKey: null, groundKeys: [], rating: visibleReview?.stars ?? null, sentiment: null, author: null, bodyRaw: text,
    ...(row.draft ? { replyDraft: { body: row.draft.text, sourceText: text, grounding: [], revision: row.revision, origin: row.draft.source === 'owner' ? 'edited' as const : 'generated' as const } } : {}),
    ...(row.reply ? { sentReplyBody: row.reply.text } : {}),
    real: { source: row.source, providerRef: row.providerRef, title: row.title, sourceUrl: row.sourceUrl, draftSource: row.draft?.source ?? null, replyState: row.reply?.state ?? null, revision: row.revision },
  };
}

const kindOf = (row: NoticeDto): NoticeKind => row.channel === 'place-hours' ? row.closure ? 'temporary_closure' : 'hours_change' : row.closure ? 'temporary_closure' : 'other';
export function noticeDraftRow(row: NoticeDto): NoticeDraft {
  const day = localStamp(row.updatedAt).slice(0, 10);
  return {
    noticeId: row.id, kind: kindOf(row), title: row.title, body: row.text, startDate: row.startDate ?? day, endDate: row.endDate ?? row.startDate ?? day,
    closureEventId: row.closure?.eventId ?? null, closureRevision: row.closure?.revision ?? null, audience: 'all_contactable', groupIds: [],
    contentClass: 'informational', revision: row.revision, channel: row.channel,
    ...(row.audience ? { talkAudience: row.audience } : {}), ...(row.couponRef ? { couponRef: row.couponRef } : {}),
    ...(row.recipientGroupId ? { recipientGroupId: row.recipientGroupId } : {}), ...(row.pin ? { pin: row.pin } : {}),
    ...(row.businessHours ? { businessHours: row.businessHours } : {}),
  };
}
/** Seoul local minute `YYYY-MM-DDTHH:mm`, the form B15 uses for `scheduledFor`. */
export const SMS_MINUTE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Completed notices as history rows. An SMS reservation is a `scheduled` queue row (not a sent message); a cancelled reservation leaves the
 * history like the fixture's `notice.cancelSchedule`. Everything else is a completed notice.
 */
export function noticeHistoryRows(rows: readonly NoticeDto[], closures: Parameters<typeof noticeSentRow>[1] = []): NoticeHistory[] {
  return rows.flatMap((row): NoticeHistory[] => {
    if (row.result?.state === 'canceled') return [];
    if (row.result?.state === 'scheduled' && row.result.scheduledFor) {
      const scheduled: NoticeScheduled = { ...noticeSentRow(row, closures), result: undefined, status: 'scheduled', sendAt: row.result.scheduledFor, sentAt: null };
      return [scheduled];
    }
    return [noticeSentRow(row, closures)];
  });
}

/** A completed notice: provider acceptance, a saved Place change, or the owner's record of a manual post. */
export function noticeSentRow(row: NoticeDto, closures: readonly { readonly eventId: string; readonly revision: number; readonly title: string; readonly body: string }[] = []): NoticeSent {
  const draft = noticeDraftRow(row);
  // The calendar closure this notice answered, at the revision it was sent: a later calendar change shows it as not announced again.
  const closure = row.closure ? closures.find(item => item.eventId === row.closure!.eventId && item.revision === row.closure!.revision) : undefined;
  return { ...draft, sentId: row.id, draftRevision: row.revision, recipientCount: 0, renderedBody: row.text, sentAt: localStamp(row.updatedAt),
    status: 'sent', closureTitle: closure?.title ?? null, closureBody: closure?.body ?? null, result: sentResult(row.result?.state), ...(row.result?.providerRef ? { providerRef: row.result.providerRef } : {}) };
}

const sentResult = (state: NonNullable<NoticeDto['result']>['state'] | undefined): 'saved' | 'accepted' | 'recorded' =>
  state === 'saved' || state === 'accepted' ? state : 'recorded';
