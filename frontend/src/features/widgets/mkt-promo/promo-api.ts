/**
 * T-083 browser client of the local promo service (API_CONTRACT v4.4, API-20~25·27). Same origin `/api/promo/*`;
 * `fetch` is read from `globalThis` at call time so tests can stub it. Every failure becomes a `PromoHttpError`
 * (status 0 = network), never an unhandled rejection.
 */
import type { PromoCatalogInput, PromoFailReason, PromoReferenceId, PromoStage, PromoStageState, PromoVideoInput, VideoConcept, VideoMood } from '../../../data/widget-data';

export const PROMO_API = '/api/promo';

export interface PromoJobResult {
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly sizeBytes: number;
  readonly fileUrl: string;
  readonly music: { readonly trackId: string; readonly title: string; readonly artist: string; readonly license: string };
  readonly fixCount?: number;
}
export interface PromoJob {
  readonly jobId: string;
  readonly status: 'queued' | 'running' | 'done' | 'failed';
  readonly stage: PromoStage;
  readonly stageState: PromoStageState;
  readonly lookCount?: number;
  readonly startedAt?: string;
  readonly stageStartedAt?: string;
  readonly failReason?: PromoFailReason | null;
  readonly result?: PromoJobResult | null;
  readonly retryOf?: string;
}
export interface EstimateCell { readonly photoCount: number; readonly seconds: number; readonly costUsd: number; readonly costKrw: number }
export interface EstimateModel {
  readonly version: number;
  readonly basis: string;
  readonly sampleCount: number;
  readonly fx: { readonly krwPerUsd: number; readonly checkedOn: string; readonly kind?: string };
  readonly table: Readonly<Record<string, readonly EstimateCell[]>>;
  readonly available?: Readonly<Record<string, boolean>>;
}
export interface PromoReference {
  readonly id: PromoReferenceId;
  readonly nameKey: string;
  readonly cardAspect: string;
  readonly posterUrl: string;
  readonly previewUrl: string;
  readonly preview?: { readonly durationSec: number; readonly width: number; readonly height: number; readonly fps: number; readonly hasAudio: boolean };
  readonly moods: readonly VideoMood[];
  readonly concepts: readonly VideoConcept[];
}
export interface ReferenceList { readonly referenceVersion: string; readonly references: readonly PromoReference[] }

export class PromoHttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly activeJobId?: string) { super(`${status} ${code}`); this.name = 'PromoHttpError'; }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await globalThis.fetch(`${PROMO_API}${path}`, { cache: 'no-store', ...init });
  } catch {
    throw new PromoHttpError(0, 'NETWORK');
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const b = (body ?? {}) as { code?: unknown; activeJobId?: unknown };
    throw new PromoHttpError(response.status, typeof b.code === 'string' ? b.code : 'UNAVAILABLE', typeof b.activeJobId === 'string' ? b.activeJobId : undefined);
  }
  if (body === null) throw new PromoHttpError(response.status, 'BAD_RESPONSE');
  return body as T;
}
const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const getCatalog = () => call<PromoCatalogInput>('/catalog');
export const getEstimateModel = () => call<EstimateModel>('/estimate-model');
export const getReferences = () => call<ReferenceList>('/references');
export const startJob = (idempotencyKey: string, input: PromoVideoInput) => post<PromoJob>('/jobs', { idempotencyKey, input });
export const getJob = (jobId: string) => call<PromoJob>(`/jobs/${encodeURIComponent(jobId)}`);
export const retryJob = (jobId: string, idempotencyKey: string) => post<PromoJob>(`/jobs/${encodeURIComponent(jobId)}/retry`, { idempotencyKey });
/** API-25 download address (`<a download>`): the server answers with `Content-Disposition: attachment`. */
export const downloadUrl = (fileUrl: string) => `${fileUrl}${fileUrl.includes('?') ? '&' : '?'}download=1`;

/** An idempotency key that matches API-22 (`[A-Za-z0-9_-]{8,64}`). */
export function newPromoKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.slice(0, 64);
}
