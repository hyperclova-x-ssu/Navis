import type { PromoCatalogInput, PromoFailReason, PromoStage, PromoStageState, PromoVideoInput } from '../../marketing/types';
import type { ListPage } from '../00';

export const promoPath = '/marketing/promo';
export const jobPath = (jobId: string) => `/promo/jobs/${encodeURIComponent(jobId)}`;
export const publishPath = (jobId: string, action: 'attest' | 'clip' | 'place-news') => `${promoPath}/jobs/${encodeURIComponent(jobId)}/${action}`;

export type PromoChannel = 'clip' | 'place-news';
export type PublicationChannel = PromoChannel | 'reels' | 'shorts';
export interface PromoAssetDto {
  readonly photoId: string;
  readonly menuId: string | null;
  readonly fileId: string | null;
  readonly url: string;
  readonly width: number;
  readonly height: number;
}
export interface PromoAssetsPage extends ListPage<PromoAssetDto> {
  readonly store: (PromoCatalogInput['store'] & { readonly sourceId?: string }) | null;
  readonly menus: PromoCatalogInput['menus'];
  readonly eligiblePhotoCount: number;
}
export interface PromoDraftDto {
  readonly draftId: string;
  readonly revision: number;
  readonly input: Partial<PromoVideoInput>;
  readonly jobId: string | null;
  readonly updatedAt: string;
}
export interface PromoPublicationDto {
  readonly publicationId: string;
  readonly jobId: string;
  readonly channel: PublicationChannel;
  readonly method: 'attestation' | 'provider';
  readonly state: 'pending' | 'published' | 'failed';
  readonly revision: number;
  readonly providerRef: string | null;
  readonly link: string | null;
  readonly createdAt: string;
  readonly videoUrl: string | null;
}
export interface PromoJobDto {
  readonly jobId: string;
  readonly status: 'queued' | 'running' | 'done' | 'failed';
  readonly stage: PromoStage;
  readonly stageState: PromoStageState;
  readonly startedAt?: string;
  readonly lookCount?: number;
  readonly failReason?: PromoFailReason | null;
  readonly result?: {
    readonly durationSec: number;
    readonly sizeBytes: number;
    readonly music: { readonly trackId: string; readonly title: string; readonly artist: string; readonly license: string } | null;
    readonly fileUrl?: string;
  } | null;
}
export interface PromoReadModel {
  readonly storeId: string;
  readonly assets: Pick<PromoAssetsPage, 'items' | 'store' | 'menus' | 'eligiblePhotoCount'>;
  readonly drafts: readonly PromoDraftDto[];
  readonly publications: readonly PromoPublicationDto[];
  readonly uploadTargets?: Readonly<Partial<Record<PublicationChannel, string>>>;
  readonly jobs: readonly PromoJobDto[];
}

declare module '../../db/types' {
  interface DataTables {
    readonly realPromo?: PromoReadModel;
  }
}

export function openDraft(model: PromoReadModel | undefined): PromoDraftDto | undefined {
  return model?.drafts.find(draft => !draft.jobId);
}

export function sameInput(patch: Partial<PromoVideoInput>, saved: Partial<PromoVideoInput>) {
  return Object.entries(patch).every(([key, value]) => JSON.stringify(value) === JSON.stringify(saved[key as keyof PromoVideoInput]));
}

export function isVideoInput(input: Partial<PromoVideoInput>): input is PromoVideoInput {
  return !!(input.menuIds && input.photoIds && input.moods && input.concepts && input.referenceId && input.lengthSec && input.locale && typeof input.memo === 'string');
}

export function safePostLink(value: string | null | undefined): string | undefined {
  if (!value || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Invalid URL. */ }
}

const postHosts: Readonly<Record<PromoChannel, readonly string[]>> = {
  clip: ['clip.naver.com', 'm.clip.naver.com', 'naver.me'],
  'place-news': ['place.naver.com', 'm.place.naver.com', 'naver.me'],
};

export function safeAttestationLink(value: string, channel: PromoChannel): string | undefined {
  const checked = value.length <= 500 && safePostLink(value);
  if (!checked) return undefined;
  const url = new URL(checked);
  if (checked.length <= 500 && !url.port && url.pathname !== '/' && postHosts[channel]?.includes(url.hostname)) return checked;
}
