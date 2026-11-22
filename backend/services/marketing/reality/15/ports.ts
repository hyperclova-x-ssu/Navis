import type { SmsReservation } from '../../../../packages/naver/contracts/pn13/index.ts';
import type { PoolClient } from 'pg';
import type { Audience, BusinessHours, ClosureLink, NewsPin, Operation } from './wire.ts';

export type Owner = { storeId: string; actorId: string };
export type Closure = ClosureLink & { date: string; endDate: string };
export type Review = { ref: string; text: string; keywords: string[]; media: { type: 'photo' | 'video'; url: string }[];
  stars: number | null; reply: string | null; hasReply: boolean; product?: string; useDate?: string };
export type ReviewQuery = { view: 'venue' | 'booking'; product?: string; rating?: 1 | 2 | 3 | 4 | 5; hasReply?: boolean;
  sort?: 'use-date' };
export type Consultation = { ref: string; status: string; messages: { text: string | null; from?: 'user' | 'partner'; sentAt?: string }[] };
export type ConsultationQuery = { from: string; to: string; cursor?: string;
  status?: 'waiting' | 'in-progress' | 'on-hold' | 'completed' | 'blocked' | 'spam' };
export type News = { ref: string; title: string | null; text: string; video: string | null;
  pin: { from: string; to: string; order: number } | null };
export type ProviderResult = { state: 'saved' | 'accepted'; providerRef?: string };
type ProviderWrite = { effectId: string; ref: string; text: string };
export type FakeNoticeProvider = {
  mode: 'fake' | 'virtual';
  reviews?(scope: Owner, query: ReviewQuery): Promise<{ items: Review[]; averageStars?: number | null }>;
  review?(scope: Owner, ref: string): Promise<Review>;
  reviewStatistics?(scope: Owner, unit: 'day' | 'week' | 'month'): Promise<unknown>;
  reviewDraft?(scope: Owner, input: { ref: string; style: string; length: string }): Promise<{ text: string }>;
  navisReviewDraft?(scope: Owner, input: { reviewText: string; rating: number | null; style: string; length: string }): Promise<{ text: string }>;
  reviewReply?(scope: Owner, input: ProviderWrite & { operation: 'create' | 'edit' | 'delete' }): Promise<ProviderResult>;
  consultations?(scope: Owner, query: ConsultationQuery): Promise<{
    items: Pick<Consultation, 'ref' | 'status'>[]; nextCursor?: string | null }>;
  consultation?(scope: Owner, ref: string): Promise<Consultation>;
  talkTalkReply?(scope: Owner, input: ProviderWrite & { user?: string }): Promise<ProviderResult>;
  audiences?(scope: Owner): Promise<{ items: { audience: Audience }[];
    quota?: { month: string; assigned: number } }>;
  campaign?(scope: Owner, input: { effectId: string; audience: Audience; title: string; body: string;
    couponRef: string | null }): Promise<ProviderResult>;
  news?(scope: Owner): Promise<{ items: News[] }>;
  publishNews?(scope: Owner, input: { effectId: string; title: string; text: string; pin: NewsPin | null }): Promise<ProviderResult>;
  deleteNews?(scope: Owner, input: { effectId: string; ref: string }): Promise<ProviderResult>;
  hours?(scope: Owner): Promise<unknown>;
  publishClosure?(scope: Owner, input: { effectId: string; closure: Closure }): Promise<ProviderResult>;
  publishBusinessHours?(scope: Owner, input: { effectId: string; businessHours: BusinessHours[] }): Promise<ProviderResult>;
};

export type Approval = Owner & { approvalId: string; operation: Operation; resourceId: string;
  revision: number; fingerprint: string; secondConfirmation: boolean };

/**
 * `providerRef` is the Marketing dispatch ID (our ledger), not a SENS reservation. Only `scheduled` and `canceled`
 * come from owner cards; marketing-worker finishes a dispatch as `sent`, `skipped`, `failed` or `uncertain`.
 */
export type SmsState = 'scheduled' | 'canceled' | 'sent' | 'skipped' | 'failed' | 'uncertain';
export type SmsEffect = { state: SmsState; providerRef: string; scheduledFor: string; reason?: string };
/** SENS reservation status vocabulary, reused for the ledger status read. */
export type SmsStatus = SmsReservation['reserveStatus'];
export type ScheduledSms = {
  mode: 'fake' | 'virtual';
  /**
   * Resolve current SMS and advertising consent server-side. Never accept numbers from the browser. Called at the
   * press (count only) and again by the worker claim just before sending; numbers never leave memory.
   */
  recipients(scope: Owner, groupId: string, advertising: boolean): Promise<{ from: string; to: string[] } | null>;
};

export type NoticeReplyOptions = {
  liveTalkTalk?: { storeId: string; sendReply(user: string, text: string): Promise<ProviderResult> };
  scheduledSms?: ScheduledSms;
  /** Private marketing-worker credential for the notice SMS dispatch routes. Distinct from `gatewayToken`. */
  smsWorkerToken?: string;
  navisReviewDraft?: FakeNoticeProvider['navisReviewDraft'];
  gatewayToken: string;
  now?: () => Date;
  provider?: FakeNoticeProvider;
  readClosure?: (scope: Owner, id: string) => Promise<Closure | null>;
  /** Verify a server-issued card against scope, operation, target, revision and normalized command fingerprint. */
  verifyApproval?: (input: Approval, db: PoolClient) => Promise<boolean>;
};
