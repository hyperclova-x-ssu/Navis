/**
 * PAR-1 (D-384): the 플레이스 pages of the menu window with the example data. Over HTTP the window reads and updates the business listing and the Place menu
 * through the gateway; with the example data it talks to this in-memory listing instead, with the same requests, previews, approvals and receipts, so
 * both modes show the same button, form and card. It never reaches the network.
 */
import { useLayoutEffect, useMemo } from 'react';
import type { MenuItem, Venue } from '../../../../../backend/packages/naver/contracts/pn01/wire';
import type { PlaceMenuInput, PlaceMenuPreview, PlaceVenueInput, PlaceVenuePreview, PublicationPreview } from '../../../../../backend/services/inventory/reality/01/publication-dto';
import { useWidgetDataStore } from '../../../data/react';
import { seedCatalog } from '../../../data/db/generated/catalog';
import { PortError, type PortFiles, type PortRequest, type PortTransport, type RealPort } from '../../../data/reality/00/port';

export interface PlaceMenuSource { readonly menuId: string; readonly name: string; readonly price: number }
export interface MenuPlacePorts { readonly transport: PortTransport; readonly files: PortFiles }
interface ExamplePlace extends MenuPlacePorts { setMenus(menus: readonly PlaceMenuSource[]): void }

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const expiresAt = () => new Date(Date.now() + 10 * 60_000).toISOString();

function createExamplePlace(): ExamplePlace {
  let menus: readonly PlaceMenuSource[] = [];
  let venue: Venue = { name: seedCatalog.store.name, address: seedCatalog.store.address, phone: '02-000-0000', keywords: ['카페', '디저트'], photos: [] };
  let placeMenu: MenuItem[] | null = null;
  let revision = 1, counter = 0;
  const previews = new Map<string, { readonly kind: 'venue'; readonly patch: PlaceVenueInput } | { readonly kind: 'menu'; readonly current: MenuItem | null; readonly desired: MenuItem }>();
  const items = () => placeMenu ??= menus.map(({ name, price }) => ({ name, price }));
  const card = <T,>(diff: T) => ({ previewId: `example-preview-${++counter}`, expectedRevision: revision, inputHash: `example-${counter}`, diff, expiresAt: expiresAt() }) satisfies PublicationPreview<T>;
  const stale = (expected: unknown) => { if (expected !== revision) throw new PortError(409, 'CONFLICT', 'STALE_REVISION'); };

  const transport: PortTransport = {
    storeId: async () => seedCatalog.store.storeId,
    reset: () => undefined,
    async request<T>({ method, path, body }: PortRequest): Promise<T> {
      const input = (body as { input?: unknown } | undefined)?.input;
      if (method === 'GET' && path === '/inventory/place/venue') return clone(venue) as T;
      if (method === 'GET' && path === '/inventory/place/menu') return { items: clone(items()) } as T;
      if (method === 'POST' && path === '/inventory/place/venue/preview') {
        const draft = (input ?? {}) as PlaceVenueInput;
        const patch = Object.fromEntries((Object.keys(draft) as (keyof Venue)[]).filter(field => !same(draft[field], venue[field]) && draft[field] !== undefined).map(field => [field, draft[field]])) as PlaceVenueInput;
        if (!Object.keys(patch).length) throw new PortError(409, 'CONFLICT', 'NO_CHANGES');
        const next = card<PlaceVenuePreview>({ current: clone(venue), patch });
        previews.set(next.previewId, { kind: 'venue', patch });
        return next as T;
      }
      const menuPreview = /^\/inventory\/menu\/([^/]+)\/place\/preview$/.exec(path);
      if (method === 'POST' && menuPreview) {
        const source = menus.find(menu => menu.menuId === decodeURIComponent(menuPreview[1]!));
        if (!source) throw new PortError(404, 'NOT_FOUND');
        const desired: MenuItem = { name: source.name, price: source.price };
        const target = (input as PlaceMenuInput | undefined)?.currentName || desired.name;
        const current = items().find(item => item.name === target) ?? null;
        const patch = Object.fromEntries((['name', 'price'] as const).filter(field => !current || current[field] !== desired[field]).map(field => [field, desired[field]])) as Partial<MenuItem>;
        if (current && !Object.keys(patch).length) throw new PortError(409, 'CONFLICT', 'NO_CHANGES');
        const next = card<PlaceMenuPreview>({ revision, current: current ? { ...current } : null, desired, patch });
        previews.set(next.previewId, { kind: 'menu', current: current ? { ...current } : null, desired });
        return next as T;
      }
      if (method === 'POST' && path === '/inventory/approvals') {
        const press = body as { expectedRevision?: unknown; previewId?: string };
        stale(press.expectedRevision);
        if (!press.previewId || !previews.has(press.previewId)) throw new PortError(409, 'CONFLICT', 'PREVIEW_EXPIRED');
        return { approvalId: `example-approval-${++counter}`, expiresAt: expiresAt(), requiresConfirmation: false } as T;
      }
      const confirm = /^\/inventory\/(?:place\/venue|menu\/[^/]+\/place)\/confirm$/.exec(path);
      if (method === 'POST' && confirm) {
        const { previewId, expectedRevision } = body as { previewId: string; expectedRevision: unknown };
        stale(expectedRevision);
        const saved = previews.get(previewId);
        if (!saved) throw new PortError(409, 'CONFLICT', 'PREVIEW_EXPIRED');
        if (saved.kind === 'venue') venue = { ...venue, ...saved.patch } as Venue;
        else {
          const list = items();
          const at = saved.current ? list.findIndex(item => item.name === saved.current!.name) : -1;
          if (at >= 0) list[at] = { ...saved.desired }; else list.push({ ...saved.desired });
        }
        previews.delete(previewId);
        revision += 1;
        return { receiptId: `example-receipt-${++counter}` } as T;
      }
      throw new PortError(404, 'NOT_FOUND');
    },
  };
  const files: PortFiles = {
    upload: async ({ blob }) => ({ fileId: `example-photo-${++counter}`, contentType: blob.type || 'image/jpeg', size: blob.size, sha256: '' }),
    uploadDataUrl: async () => { throw new PortError(400, 'VALIDATION', 'FILE_INVALID'); },
    readUrl: async () => { throw new PortError(404, 'NOT_FOUND'); },
    revoke: async () => undefined,
  };
  return { transport, files, setMenus: next => { menus = next; } };
}

/** One example listing per data store, so a change survives closing and reopening the window like the other example edits. */
const places = new WeakMap<object, ExamplePlace>();

/**
 * The transport and files the 플레이스 pages use: the data port's own over HTTP, and with the example data the in-memory listing above, fed with the
 * menu rows the window shows (the Place menu starts as a copy of them, so a changed Navis price shows up as a change to publish).
 */
export function useMenuPlace(port: RealPort | undefined, menus: readonly PlaceMenuSource[]): MenuPlacePorts {
  const store = useWidgetDataStore();
  const example = useMemo(() => {
    let place = places.get(store);
    if (!place) { place = createExamplePlace(); places.set(store, place); }
    return place;
  }, [store]);
  useLayoutEffect(() => { example.setMenus(menus); }, [example, menus]);
  return useMemo(() => port ? { transport: port.transport, files: port.files } : example, [port, example]);
}
