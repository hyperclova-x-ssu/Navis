import type { WidgetDataStore } from '../../db/store';
import type { PromoVideoInput } from '../../marketing/types';
import { failure } from '../00';
import type { PromoChannel, PromoDraftDto } from './dto';

export type PromoRealCommand = (
  | { readonly type: 'promo.addPhoto'; readonly fileId: string; readonly menuId: string | null; readonly rightsConfirmed: true }
  | { readonly type: 'promo.saveDraft'; readonly draftId?: string; readonly expectedRevision?: number; readonly patch: Partial<PromoVideoInput> }
  | { readonly type: 'promo.publishPlaceNews'; readonly jobId: string; readonly text: string }
  | { readonly type: 'promo.publishClip'; readonly jobId: string; readonly description: string; readonly hashtags: readonly string[];
      readonly category: string; readonly visibility: 'public' | 'private'; readonly sponsored: boolean; readonly commentsAllowed: boolean }
  | { readonly type: 'promo.attestLink'; readonly jobId: string; readonly route: PromoChannel; readonly link: string }
) & { readonly idempotencyKey?: string };

export function saveDraftCommand(patch: Partial<PromoVideoInput>, draft?: PromoDraftDto, idempotencyKey?: string): PromoRealCommand {
  return { type: 'promo.saveDraft', patch, ...(draft && { draftId: draft.draftId, expectedRevision: draft.revision }), idempotencyKey };
}

export function executePromo(store: WidgetDataStore, command: PromoRealCommand) {
  if (store.real?.mode('promo') !== 'http') return Promise.resolve(failure('CONFLICT', 'SOURCE_UNAVAILABLE', 'data.real.error.SOURCE_UNAVAILABLE'));
  return store.execute(command);
}
