/** Test and dev host only (T-083g): the example catalog with extra photos on its first menu, to see a shop with more than 10 photos. The example data file is not changed. */
import { catalogForSource } from '../../../data/marketing/promo';

export function catalogWithPhotos(total: number) {
  const base = catalogForSource();
  const first = base.menus.find((m) => m.photoIds.length > 0);
  if (!first) return base;
  const extra = Array.from({ length: Math.max(0, total - first.photoIds.length) }, (_, i) => {
    const from = base.photos.find((p) => p.photoId === first.photoIds[i % first.photoIds.length])!;
    return { ...from, photoId: `${from.photoId}-extra-${i + 1}`, menuId: first.menuId, url: from.url };
  });
  return { ...base, menus: base.menus.map((m) => (m === first ? { ...m, photoIds: [...m.photoIds, ...extra.map((p) => p.photoId)] } : m)), photos: [...base.photos, ...extra] };
}
