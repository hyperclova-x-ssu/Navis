import type { PoolClient } from 'pg';
import type { Clock } from './wire.ts';

/**
 * Read ports B19 composes. Each owner implements its port in its own slice and the composition layer injects it into
 * `registerGroupsPerformanceRoutes`. Same-DB ports run inside B19's store-scoped read transaction (RLS applies),
 * each behind a savepoint; a missing or failing port is reported in `missing`, never replaced by numbers.
 */
export type Period = { from: string; to: string };

/** B14 · one Navis coupon code. `activatedOn` is the business date counting started (issue or attested posting). */
export type CouponCodeFact = {
  codeId: string;
  couponId: string;
  couponName: string;
  /** Channel of the code, e.g. `sms`, `place_news`, `blog`, `clip`, `talktalk`. */
  route: string;
  /** Issued codes: individual recipients, or the public cap from attestation. */
  issued: number;
  activatedOn: string | null;
  status: 'active' | 'paused' | 'ended';
};

/** B14 · one POS redemption of a code, keyed by the POS settlement that applied it. */
export type RedemptionFact = {
  redemptionId: string;
  codeId: string;
  couponId: string;
  settlementId: string;
  memberId: string | null;
  businessDate: string;
  /** Discount the code applied, integer won. */
  discount: number;
  /** True once the POS correction of that settlement released the redemption. */
  reversed: boolean;
};

export interface CouponLedger {
  /** Codes whose counting started within the period (the issuance cohort). */
  codes(db: PoolClient, storeId: string, period: Period, at: { day: string; clock: Clock }): Promise<CouponCodeFact[]>;
  /** Every redemption of these codes up to and including `until`, reversed ones included. */
  redemptions(db: PoolClient, storeId: string, codeIds: readonly string[], until: string): Promise<RedemptionFact[]>;
}

/** PN12 owner-visible report, the shape of PN-A3 `createChannelReads(...).channelReport`. */
export type ReportPeriod = { startDate: string; endDate: string };
export type OwnerReport = {
  source: string;
  period: ReportPeriod;
  cards: { metric: string; value: number; changeRate?: number; period?: ReportPeriod }[];
};
export type ReportChannel = 'place' | 'blog' | 'clip';
export interface ChannelReportPort {
  channelReport(storeId: string, channel: ReportChannel, options: { date?: string; unit?: 'day' | 'week' }): Promise<OwnerReport>;
}

/** B14 · quiet-hour slot candidate within tomorrow + 6 days, with its eligible consented regulars. */
export type QuietSlot = { slotId: string; date: string; startHour: number; endHour: number; regulars: number; handled: boolean };
/** B14 · lot that must sell today (B03 lot), handled once its coupon was issued or the lot closed. */
export type ExpiringLot = { lotId: string; itemName: string; quantity: number; expiresOn: string; handled: boolean };
/** B15 · inquiries and reviews still waiting for an owner reply, and how many have a saved draft. */
export type ReplyQueue = { waiting: number; withDraft: number; firstWaitingId: string | null; firstDraftId: string | null };
/** B16 · owner-uploaded, rights-approved store photos and posted promo videos this week. */
export type AssetState = { eligiblePhotos: number; postedVideos: number; firstAssetId: string | null };

export interface TodaySources {
  quietSlots?(db: PoolClient, storeId: string, day: string, clock: Clock): Promise<QuietSlot[]>;
  expiringLots?(db: PoolClient, storeId: string, day: string, actorId: string, clock: Clock): Promise<ExpiringLot[]>;
  replies?(db: PoolClient, storeId: string, day: string): Promise<ReplyQueue>;
  assets?(db: PoolClient, storeId: string, day: string, actorId: string): Promise<AssetState>;
}
