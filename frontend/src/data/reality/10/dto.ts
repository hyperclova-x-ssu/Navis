import type { EnvironmentReading, EnvironmentRange } from '../../iteration7/environment/types';
import type { PosTableDto } from '../02/dto';

export type MeasurementStatus = 'ok' | 'partial' | 'none';
export interface CameraDto {
  readonly cameraId: string;
  readonly zoneSetRevision: number;
  readonly lastObservedAt: string | null;
  readonly measurementStatus: MeasurementStatus;
  readonly deviceStatus: 'registered' | 'unavailable';
}
export interface ZonePoint { readonly x: number; readonly y: number }
export interface ZoneInput { readonly zoneId?: string; readonly label: string; readonly polygon: readonly ZonePoint[] }
export interface ZoneDto {
  readonly zoneId: string;
  readonly zoneVersionId: string;
  readonly cameraId: string;
  readonly zoneSetRevision: number;
  readonly label: string | null;
  readonly polygon: readonly ZonePoint[] | null;
  readonly linkRevision: number;
}
export interface TableLinkDto {
  readonly zoneId: string;
  readonly zoneVersionId: string;
  readonly cameraId: string;
  readonly zoneSetRevision: number;
  readonly tableId: string;
  readonly revision: number;
  readonly tableState: 'active' | 'archived';
}
export interface BucketDto {
  readonly cameraId: string;
  readonly bucketStart: string;
  readonly bucketMinutes: number;
  readonly zoneSetRevision: number;
  readonly observedUntil: string;
  readonly status: MeasurementStatus;
  readonly avgInStore: number | null;
  readonly maxInStore: number | null;
  readonly entries: readonly {
    readonly zoneId: string;
    readonly zoneVersionId: string;
    readonly occupiedSeconds: number;
    readonly finishedSessions: number;
    readonly finishedSecondsSum: number;
    readonly toClearEvents: number;
  }[];
}
export interface ReviewDto { readonly reviewId: string; readonly hour: number; readonly revision: number; readonly markedAt: string }
export interface ReadingDto extends EnvironmentReading { readonly readingId: string; readonly source: 'manual' }
export interface LimitsDto { readonly revision: number; readonly temperatureRange: EnvironmentRange; readonly humidityRange: EnvironmentRange }
export interface EnvironmentSummaryDto {
  readonly current: ReadingDto | null;
  readonly limits: LimitsDto;
  readonly alerts: readonly { readonly metric: 'temperatureC' | 'humidityPct'; readonly direction: 'below' | 'above'; readonly value: number; readonly range: EnvironmentRange; readonly readingId: string }[];
  readonly asOf: string;
  readonly sourceRevision: number;
}
export interface RealInsight {
  readonly date: string;
  readonly asOf: string;
  readonly cameras: readonly CameraDto[];
  readonly zones: readonly ZoneDto[];
  readonly links: readonly TableLinkDto[];
  readonly buckets: readonly BucketDto[];
  readonly reviews: readonly ReviewDto[];
  /** null when the POS table list could not be read completely. */
  readonly tables: readonly PosTableDto[] | null;
}
