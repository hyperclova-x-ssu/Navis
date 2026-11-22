/**
 * REAL-PLAN F12 — wire shapes of B12's `GET /insight/briefings` (backend/services/insight/reality/12, README there) and what the briefing domain keeps.
 *
 * The service names each source (`SOURCE_NAMES`) and gives it `{origin, state, period, data, asOf?, sourceRevision?}`. This file reads that envelope.
 * `data` stays opaque except for the two reads the plan names (B11 manuals/grants, B10 environment): a screen never turns an unknown `data` into
 * numbers, and an unknown `state` is shown as unavailable, never as ready.
 */
import { PortError } from '../00';

export type BriefingSourceState = 'ready' | 'partial' | 'unavailable' | 'not-connected';
const STATES: readonly BriefingSourceState[] = ['ready', 'partial', 'unavailable', 'not-connected'];

export const SOURCE_NAMES = [
  'sales', 'finance', 'closing', 'calendar', 'shifts', 'calendarProjections', 'stock', 'purchasing', 'pickups', 'reservations', 'environment', 'cctv',
  'manualsGrants', 'smartCall', 'reviewStatistics', 'local', 'reviews', 'notices', 'tax', 'channels', 'marketingToday', 'coupons',
] as const;
export type BriefingSourceName = typeof SOURCE_NAMES[number];

export interface BriefingPeriodDto { readonly from: string; readonly to: string }
export interface BriefingSourceDto {
  /** `pos`, `customer`, `inventory`, `insight`, `marketing`, or a NAVER-reported origin (`naver-smartcall`, `naver-smartplace`). */
  readonly origin: string;
  readonly state: BriefingSourceState;
  /** Inclusive ISO dates, or null for a current state without fixed date bounds. */
  readonly period: BriefingPeriodDto | null;
  readonly data: unknown;
  readonly asOf?: string;
  readonly sourceRevision?: string | number;
}
export interface BriefingAcknowledgementDto { readonly acknowledgedAt: string; readonly receiptId: string }
export interface BriefingDto {
  readonly businessDay: string;
  /** The business day the arrival card belongs to; null while the service has no authoritative weekly opening times (the current gate stays). */
  readonly arrivalDay: string | null;
  readonly asOf: string;
  readonly acknowledgement: BriefingAcknowledgementDto | null;
  readonly sources: Readonly<Record<string, BriefingSourceDto>>;
}

/** B11 `manualsGrants` data. */
export interface ManualsGrantsData { readonly openingChecked: number; readonly openingSteps: number; readonly upcomingGrantDeadlines: number }
/** B10 `environment` data (`{current, limits, alerts}`); only the alerts are read here. */
export interface EnvironmentData { readonly alerts: readonly unknown[] }

export interface BriefingSource {
  /** The name the service gave it. */
  readonly key: string;
  readonly origin: string;
  /** True for what NAVER itself reports (the persona sources): shown apart from Navis' own records and drafts. */
  readonly provider: boolean;
  readonly state: BriefingSourceState;
  readonly period: BriefingPeriodDto | null;
  readonly asOf: string | null;
  readonly sourceRevision: string | number | null;
  readonly data: unknown;
}
export interface RealBriefingSnapshot {
  readonly businessDay: string;
  readonly arrivalDay: string | null;
  readonly asOf: string;
  readonly sourceRevision: number;
  readonly acknowledgement: BriefingAcknowledgementDto | null;
  readonly sources: readonly BriefingSource[];
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const numeric = (value: string | number | null): number => { const n = typeof value === 'number' ? value : Number(value); return Number.isFinite(n) ? n : 0; };

function periodOf(value: unknown): BriefingPeriodDto | null {
  const period = value as Partial<BriefingPeriodDto> | null | undefined;
  return period && isDay(period.from) && isDay(period.to) ? { from: period.from, to: period.to } : null;
}

function sourceOf(key: string, dto: BriefingSourceDto): BriefingSource {
  const origin = text(dto.origin) ?? key;
  const revision = typeof dto.sourceRevision === 'number' && Number.isFinite(dto.sourceRevision) || typeof dto.sourceRevision === 'string' ? dto.sourceRevision : null;
  return {
    key, origin, provider: origin.toLowerCase().startsWith('naver'),
    state: STATES.includes(dto.state) ? dto.state : 'unavailable',
    period: periodOf(dto.period), asOf: text(dto.asOf) ?? null, sourceRevision: revision, data: dto.data ?? null,
  };
}

/** The service's answer → what the screens keep. A body that is not the envelope is a failed read, never an empty briefing. */
export function toBriefingSnapshot(dto: BriefingDto): RealBriefingSnapshot {
  const sources = dto?.sources;
  if (!dto || !isDay(dto.businessDay) || !text(dto.asOf) || !sources || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
  }
  const kept = Object.entries(sources).filter(([, source]) => source && typeof source === 'object').map(([key, source]) => sourceOf(key, source));
  const ack = dto.acknowledgement;
  return {
    businessDay: dto.businessDay,
    arrivalDay: isDay(dto.arrivalDay) ? dto.arrivalDay : null,
    asOf: dto.asOf,
    sourceRevision: Math.max(0, ...kept.map(source => numeric(source.sourceRevision))),
    acknowledgement: ack && text(ack.acknowledgedAt) && text(ack.receiptId) ? { acknowledgedAt: ack.acknowledgedAt, receiptId: ack.receiptId } : null,
    sources: kept,
  };
}

export const sourceNamed = (read: RealBriefingSnapshot | undefined, key: string): BriefingSource | undefined => read?.sources.find(source => source.key === key);
export const hasData = (source: BriefingSource | undefined): source is BriefingSource => !!source && (source.state === 'ready' || source.state === 'partial');

/** B11's briefing counts, when that source is ready or partial and carries them. */
export function manualsGrantsData(source: BriefingSource | undefined): ManualsGrantsData | null {
  const data = hasData(source) ? source.data as Partial<ManualsGrantsData> | null : null;
  return data && [data.openingChecked, data.openingSteps, data.upcomingGrantDeadlines].every(value => typeof value === 'number')
    ? { openingChecked: data.openingChecked!, openingSteps: data.openingSteps!, upcomingGrantDeadlines: data.upcomingGrantDeadlines! } : null;
}

/** B10's environment alerts, when that source is ready or partial and carries them. */
export function environmentData(source: BriefingSource | undefined): EnvironmentData | null {
  const data = hasData(source) ? source.data as Partial<EnvironmentData> | null : null;
  return data && Array.isArray(data.alerts) ? { alerts: data.alerts } : null;
}
