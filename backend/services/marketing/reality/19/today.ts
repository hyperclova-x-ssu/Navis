import type { AssetState, ExpiringLot, QuietSlot, ReplyQueue, TodaySources } from './ports.ts';
import { isRecord, optional, validDate, weekday, type ReadScope } from './wire.ts';

type Ref = { featureId: string; view?: string; itemId?: string; focus?: 'action' };
type Cell =
  | { slot: 'now'; kind: 'quiet-hours'; sourceFeatureId: 'slot-coupon'; params: { regulars: number };
    quietSlot: { slotId: string; date: string; weekday: number; startHour: number; endHour: number }; ref: Ref }
  | { slot: 'now'; kind: 'expiry'; sourceFeatureId: 'expiry-coupon'; params: { count: number; itemName: string }; ref: Ref }
  | { slot: 'today'; kind: 'replies'; sourceFeatureId: 'ai-response'; params: { count: number; drafted: number }; ref: Ref }
  | { slot: 'week'; kind: 'video'; sourceFeatureId: 'promo-video'; params: { photos: number }; ref: Ref };
type Source = 'coupons' | 'replies' | 'assets';

const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 160;
const hour = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 24;

function slots(value: QuietSlot[]) {
  if (!Array.isArray(value) || !value.every(row => isRecord(row) && id(row.slotId) && validDate(row.date) && hour(row.startHour)
    && hour(row.endHour) && row.startHour < row.endHour && count(row.regulars) && typeof row.handled === 'boolean')) throw new Error('slots');
  return value;
}
function lots(value: ExpiringLot[]) {
  if (!Array.isArray(value) || !value.every(row => isRecord(row) && id(row.lotId) && id(row.itemName) && count(row.quantity)
    && row.quantity > 0 && validDate(row.expiresOn) && typeof row.handled === 'boolean')) throw new Error('lots');
  return value;
}
function replies(value: ReplyQueue) {
  if (!isRecord(value) || !count(value.waiting) || !count(value.withDraft) || value.withDraft > value.waiting
    || (value.firstWaitingId !== null && !id(value.firstWaitingId)) || (value.firstDraftId !== null && !id(value.firstDraftId))) {
    throw new Error('replies');
  }
  return value;
}
function assets(value: AssetState) {
  if (!isRecord(value) || !count(value.eligiblePhotos) || !count(value.postedVideos)
    || (value.firstAssetId !== null && !id(value.firstAssetId))) throw new Error('assets');
  return value;
}

/**
 * Today's actions (F-47): now = a quiet slot (or a lot that must sell today), today = replies waiting, week = a video
 * from the owner's eligible photos. Order follows expiring opportunity > customer response > content. A handled
 * candidate is folded. Counts come only from each owner's port; a missing port is named in `missing`.
 */
export async function readToday(scope: ReadScope, sources: TodaySources = {}) {
  const { db, storeId, actorId, day, clock, at } = scope;
  const missing = new Set<Source>();
  const read = async <T>(source: Source, call: (() => Promise<T>) | undefined) => {
    if (!call) {
      missing.add(source);
      return null;
    }
    const result = await optional(db, call);
    if (!result.ok) missing.add(source);
    return result.ok ? result.value : null;
  };
  const slotRows = await read('coupons', sources.quietSlots && (async () => slots(await sources.quietSlots!(db, storeId, day, clock))));
  const lotRows = await read('coupons', sources.expiringLots && (async () => lots(await sources.expiringLots!(db, storeId, day, actorId, clock))));
  const queue = await read('replies', sources.replies && (async () => replies(await sources.replies!(db, storeId, day))));
  const media = await read('assets', sources.assets && (async () => assets(await sources.assets!(db, storeId, day, actorId))));

  const cells: Cell[] = [];
  const open = (slotRows ?? []).filter(row => !row.handled);
  const slot = open.find(row => row.regulars > 0) ?? open[0];
  const lot = (lotRows ?? []).find(row => !row.handled);
  if (slot) {
    cells.push({ slot: 'now', kind: 'quiet-hours', sourceFeatureId: 'slot-coupon', params: { regulars: slot.regulars },
      quietSlot: { slotId: slot.slotId, date: slot.date, weekday: weekday(slot.date), startHour: slot.startHour, endHour: slot.endHour },
      ref: { featureId: 'slot-coupon', view: 'send', itemId: slot.slotId, focus: 'action' } });
  } else if (lot) {
    cells.push({ slot: 'now', kind: 'expiry', sourceFeatureId: 'expiry-coupon', params: { count: lot.quantity, itemName: lot.itemName },
      ref: { featureId: 'expiry-coupon', itemId: lot.lotId, focus: 'action' } });
  }
  if (queue && queue.waiting > 0) {
    const itemId = queue.firstDraftId ?? queue.firstWaitingId;
    cells.push({ slot: 'today', kind: 'replies', sourceFeatureId: 'ai-response', params: { count: queue.waiting, drafted: queue.withDraft },
      ref: { featureId: 'ai-response', ...(itemId && { itemId }), focus: 'action' } });
  }
  if (media && media.eligiblePhotos > 0 && media.postedVideos === 0) {
    cells.push({ slot: 'week', kind: 'video', sourceFeatureId: 'promo-video', params: { photos: media.eligiblePhotos },
      ref: { featureId: 'promo-video', view: 'create', focus: 'action' } });
  }
  const first = cells[0]?.ref;
  return {
    asOf: at.toISOString(), businessDate: day,
    state: missing.size ? 'partial' : cells.length ? 'ready' : 'empty',
    missing: (['coupons', 'replies', 'assets'] as const).filter(source => missing.has(source)),
    cells, folded: (['now', 'today', 'week'] as const).filter(name => !cells.some(cell => cell.slot === name)),
    tapTarget: first ? { featureId: first.featureId, ...(first.view && { view: first.view }) } : null,
  };
}
