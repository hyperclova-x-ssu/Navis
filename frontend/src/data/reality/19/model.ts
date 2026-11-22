/**
 * F19 · extra facts a widget model carries only when it came from B19's HTTP reads (`model.real`, absent in fixture mode).
 * They let a widget say "not available yet" for a missing source instead of showing a number it does not have.
 */
import type { CouponOutcomeDto, GroupsDto, ReportChannel, TodaySource } from './dto';

export interface RealGroupsInfo {
  readonly asOf: string;
  readonly sourceRevision: number;
  readonly businessDate: string;
  readonly coverage: GroupsDto['coverage'];
}

export interface RealChannelCard { readonly metric: string; readonly value: number; readonly changeRate?: number; readonly period: { readonly start: string; readonly end: string } }
export interface RealChannel {
  readonly channel: ReportChannel;
  readonly state: 'ready' | 'unavailable';
  /** An https NAVER address of the official owner screen the figures come from. */
  readonly source: string;
  readonly period: { readonly start: string; readonly end: string } | null;
  readonly cards: readonly RealChannelCard[];
}

export interface RealPerformanceInfo {
  readonly asOf: string;
  readonly sourceRevision: number;
  /** The coupon ledger could not be read: every coupon figure is "not available yet", never 0. */
  readonly couponsMissing: boolean;
  readonly payment: CouponOutcomeDto['payment'] | null;
  readonly repeat: CouponOutcomeDto['repeat'] | null;
  /** null = the channel report call failed (distinct from a channel that answered "unavailable"). */
  readonly channels: readonly RealChannel[] | null;
  readonly paidByCoupon: Readonly<Record<string, number>>;
}

export type RealTodayMissing = readonly TodaySource[];
