/** Test helpers for the F-50 promo commands (inputs, a finished result, a made-and-settled video). Not part of the app bundle. */
import type { WidgetDataStore } from '../widget-data';
import type { PromoVideoInput, PromoVideoResult } from './types';

export const JOB_ID = 'pj-0123456789ab';
export const RESULT: PromoVideoResult = {
  durationSec: 15, music: { trackId: 'music-1', title: 'Sample', artist: 'Someone', licenseLabel: 'CC0' }, fileUrl: `/api/promo/jobs/${JOB_ID}/video.mp4`, sizeBytes: 1_234_567, madeAt: '2026-10-26T10:00',
};
export const photoIdsOf = (store: WidgetDataStore, n = 5): string[] => store.getSnapshot().tables.marketing.promoPhoto.slice(0, n).map((p) => p.photoId);
export const inputOf = (store: WidgetDataStore, n = 5, extra: Partial<PromoVideoInput> = {}): PromoVideoInput => ({
  menuIds: ['financier'], photoIds: photoIdsOf(store, n), moods: ['warm'], concepts: ['review-roundup'], memo: '', referenceId: 'ref-1', lengthSec: 15, locale: 'ko', ...extra,
});
export function dispatchOk(store: WidgetDataStore, command: Parameters<WidgetDataStore['dispatch']>[0]) {
  const r = store.dispatch(command);
  if (!r.ok) throw new Error(`command failed: ${command.type} ${r.code} ${r.messageKey} ${r.field ?? ''}`);
  return r;
}
/** make → attachJob → settle done; returns the video id. */
export function makeDone(store: WidgetDataStore, key = 'mk', n = 5, extra: Partial<PromoVideoInput> = {}): string {
  const made = dispatchOk(store, { type: 'video.make', input: inputOf(store, n, extra), idempotencyKey: key });
  const videoId = (made.value as { videoId: string }).videoId;
  dispatchOk(store, { type: 'video.attachJob', videoId, jobId: JOB_ID });
  dispatchOk(store, { type: 'video.settle', videoId, outcome: { kind: 'done', result: RESULT } });
  return videoId;
}
