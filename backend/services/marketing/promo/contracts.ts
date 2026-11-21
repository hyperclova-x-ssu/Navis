import { createHash } from 'node:crypto';
import type { PromoCatalogInput, PromoVideoInput } from '../../../../frontend/src/data/marketing/types.ts';

export const stages = ['look', 'story', 'scenes', 'merge'] as const;
export type Stage = typeof stages[number];
export type CheckpointStage = Exclude<Stage, 'merge'>;
export type PromoInput = PromoVideoInput;
export type FileBinding = { resourceId: string; fileId: string };
export type CatalogSnapshot = {
  catalog: PromoCatalogInput;
  photos: Record<string, FileBinding>;
  exterior: { width: number; height: number };
};
export type FileScope = { storeId: string; resourceId: string };
export type ArtifactPurpose = 'promo_input' | 'promo_checkpoint' | 'promo_output';
export interface PromoArtifacts {
  put(scope: FileScope, identity: string, purpose: ArtifactPurpose, mime: string, bytes: Buffer, signal?: AbortSignal): Promise<string>;
  read(scope: FileScope, fileId: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: string }>;
}

export type PromoStatus = 'queued' | 'running' | 'done' | 'failed';
export interface PromoResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  music: { trackId: string; title: string; artist: string; license: 'CC0-1.0' } | null;
  fixCount: number;
}

export interface PromoJob {
  job_id: string;
  store_id: string;
  input: PromoInput;
  catalog_snapshot: CatalogSnapshot;
  status: PromoStatus;
  stage: Stage;
  started_at: Date;
  stage_started_at: Date;
  fail_reason: string | null;
  asset_id: string | null;
  result: PromoResult | null;
}

export const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const fingerprint = (value: unknown) => sha256(JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1));
}));
