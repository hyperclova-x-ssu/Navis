import { PortError, type LoadContext } from '../00/port';

export const photoCatalogPath = '/marketing/photos';

export interface CatalogPhoto {
  readonly photoId: string;
  readonly menuId: string | null;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly contentUrl: string;
}

interface PhotoPage { readonly items: readonly CatalogPhoto[]; readonly nextCursor: string | null }

const bundledPhoto = /^\/menu-photos\/[a-z0-9_-]+\.(?:jpe?g|png|webp)$/i;
const photoId = /^[a-z0-9-]+$/i;

export function photoContentPath(storeId: string, contentUrl: string): string | undefined {
  const prefix = `/api/v1/stores/${encodeURIComponent(storeId)}`;
  if (!contentUrl.startsWith(prefix)) return undefined;
  const path = contentUrl.slice(prefix.length);
  if (/^\/marketing\/photos\/[a-z0-9-]+\/content$/i.test(path)) return path;
}

function validPhoto(photo: CatalogPhoto | null, storeId: string): boolean {
  return !!photo && typeof photo.photoId === 'string' && photoId.test(photo.photoId)
    && (typeof photo.menuId === 'string' || photo.menuId === null)
    && typeof photo.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(photo.sha256)
    && Number.isInteger(photo.width) && photo.width > 0 && Number.isInteger(photo.height) && photo.height > 0
    && typeof photo.contentUrl === 'string'
    && (bundledPhoto.test(photo.contentUrl) || photoContentPath(storeId, photo.contentUrl) === `${photoCatalogPath}/${photo.photoId}/content`);
}

/** Store-scoped list. A missing trial route leaves the existing account attachments available. */
export async function readPhotoCatalog({ reads, storeId, signal }: Pick<LoadContext, 'reads' | 'storeId' | 'signal'>): Promise<readonly CatalogPhoto[]> {
  const items: CatalogPhoto[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    let page: PhotoPage;
    try {
      page = await reads.one<PhotoPage>({ resource: 'marketing.photos', path: photoCatalogPath, query: { cursor } }, { signal });
    } catch (error) {
      if (!cursor && !signal.aborted && error instanceof PortError && error.status === 404) return [];
      throw error;
    }
    if (!Array.isArray(page?.items) || !page.items.every(photo => validPhoto(photo, storeId))
        || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor && !cursors.has(page.nextCursor))) {
      throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
    }
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor) cursors.add(cursor);
  } while (cursor && cursors.size < 20);
  if (cursor) throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
  return items;
}
