import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { record, menuPatch, venuePatch, type MenuItem, type Venue } from '../../../../packages/naver/contracts/pn01/wire.ts';
import type { createAccountNaver } from '../../../account/naver/index.ts';
import type { createInventoryNaver } from '../../naver/index.ts';
import { CardError, fingerprint } from './owner-card.ts';
import type { PlaceMenuInput, PlaceMenuPreview, PlaceVenueInput, PlaceVenuePreview } from './publication-dto.ts';
import { publicationHttp } from './publication-routes.ts';

type PlacePorts = {
  inventory: Pick<ReturnType<typeof createInventoryNaver>, 'menu' | 'publishMenu'>;
  account: Pick<ReturnType<typeof createAccountNaver>, 'venue' | 'updateVenue'>;
};

function differences<T extends object>(before: Partial<T>, desired: Partial<T>): Partial<T> {
  const keys = Object.keys(desired).sort() as Array<keyof T>;
  return Object.fromEntries(keys.filter(key => fingerprint([before[key]]) !== fingerprint([desired[key]]))
    .map(key => [key, desired[key]])) as Partial<T>;
}

export function registerPlacePublication(app: FastifyInstance, db: Pool, gatewayToken: string, ports: PlacePorts) {
  const http = publicationHttp(app, db, gatewayToken);
  http.route('GET', '/place/menu', async (_db, scope) => ({ items: await ports.inventory.menu(scope) }));
  http.route('GET', '/place/venue', async (_db, scope) => ports.account.venue(scope));

  http.external<PlaceMenuInput, PlaceMenuPreview, MenuItem & { revision: number }>({
    kind: 'place-menu', path: '/menu/:id/place',
    input(body) {
      if (!record(body) || Object.keys(body).some(key => key !== 'currentName')
          || (body.currentName !== undefined && !menuPatch({ name: body.currentName }))) {
        throw new CardError(400, 'INVALID_MENU_SELECTOR');
      }
      return { currentName: body.currentName as string | undefined };
    },
    async snapshot(client, scope, id) {
      const { rows: [local] } = await client.query<MenuItem & { revision: number }>(
        'SELECT name, price::double precision AS price, revision FROM inventory.menu_item WHERE store_id=$1 AND menu_id=$2 AND deleted_at IS NULL AND kind=$3',
        [scope.storeId, id, 'menu']);
      if (!local) throw new CardError(404, 'MENU_NOT_FOUND');
      return local;
    },
    async inspect(scope, { currentName }, { name, price, revision }) {
      const desired = { name, price };
      if (!menuPatch(desired)) throw new CardError(409, 'UNSUPPORTED_PLACE_MENU');
      const menu = await ports.inventory.menu(scope);
      const matching = menu.filter(item => item.name === (currentName ?? name));
      const current = matching[0] ?? null;
      if (matching.length > 1 || (currentName && currentName !== name && current && menu.some(item => item.name === name))) {
        throw new CardError(409, 'PLACE_MENU_NAME_CONFLICT');
      }
      const existing = current ?? menu.find(item => item.name === name && item.price === price);
      if (currentName && !existing) throw new CardError(409, 'PLACE_MENU_CHANGED');
      const patch = differences<MenuItem>(existing ?? {}, desired);
      return { expectedRevision: revision, view: { revision, current, desired, patch }, changed: Object.keys(patch).length > 0 };
    },
    async publish(scope, _input, { current, patch, desired, revision }, receiptId) {
      await ports.inventory.publishMenu(scope, { key: receiptId }, patch, current?.name);
      const actual = (await ports.inventory.menu(scope)).find(item => item.name === desired.name && item.price === desired.price);
      if (!actual) throw new CardError(502, 'PLACE_READ_BACK_FAILED');
      return { state: 'saved', revision, readBack: actual, affectedSources: ['place.menu'] };
    },
  });
  http.external<PlaceVenueInput, PlaceVenuePreview, null>({
    kind: 'place-venue', path: '/place/venue',
    input(body) {
      if (!venuePatch(body)) throw new CardError(400, 'INVALID_PLACE_FIELDS');
      return differences<Venue>({}, body);
    },
    async snapshot() { return null; },
    async inspect(scope, desired) {
      const current = await ports.account.venue(scope);
      const patch = differences(current, desired);
      return { expectedRevision: 0, view: { current, patch }, changed: Object.keys(patch).length > 0 };
    },
    async publish(scope, desired, { patch }, receiptId) {
      await ports.account.updateVenue(scope, { key: receiptId }, patch);
      const actual = await ports.account.venue(scope);
      if (Object.keys(differences(actual, desired)).length) throw new CardError(502, 'PLACE_READ_BACK_FAILED');
      return { state: 'saved', readBack: actual, affectedSources: ['place.venue'] };
    },
  });
}
