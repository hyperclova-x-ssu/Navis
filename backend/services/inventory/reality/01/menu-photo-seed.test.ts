import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { seedCatalog } from '../../../../../frontend/src/data/db/generated/catalog.ts';
import { createGateway } from '../../../../gateway/app.ts';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { createSeedContext } from '../../../../packages/db/seed-context.ts';
import { createAccountApp } from '../../../account/app.ts';
import { demoIdentity, newPassword } from '../../../account/identity.ts';
import { createSigningKeys } from '../../../account/keys.ts';
import { seed as seedAccount } from '../../../account/seed.ts';
import { createInventoryApp } from '../../app.ts';
import { seed as seedInventory } from '../../seed.ts';
import { seedCafeMenuPhotos } from './menu-photo-seed.ts';

it('serves every seeded café menu photo from Account after a new owner login', async () => {
  for (const service of ['account', 'inventory'] as const) {
    await runMigrations(service, fileURLToPath(new URL(`../../../${service}/migrations/`, import.meta.url)), 'test');
  }
  const accountSetup = dbPool('account', 'migrate', 'test');
  const inventorySetup = dbPool('inventory', 'migrate', 'test');
  const accountDb = dbPool('account', 'runtime', 'test');
  const inventoryDb = dbPool('inventory', 'runtime', 'test');
  const origin = 'http://127.0.0.1:18389';
  const accountToken = randomUUID();
  const inventoryToken = randomUUID();
  const posCatalogToken = randomUUID();
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256', privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  const account = createAccountApp({ pool: accountDb, gatewayToken: accountToken,
    keys: await createSigningKeys(privateKey), publicOrigin: origin, logging: false });
  const inventory = createInventoryApp(inventoryDb, inventoryToken, false, undefined, undefined, { posCatalogToken });
  const [accountUrl, inventoryUrl] = await Promise.all(
    [account, inventory].map(app => app.listen({ host: '127.0.0.1', port: 0 })),
  );
  const gateway = createGateway({ accountUrl, inventoryUrl, accountToken, inventoryToken, accountOrigin: origin, logging: false });
  try {
    const context = createSeedContext();
    await seedAccount(accountSetup, context);
    await seedCafeMenuPhotos(accountSetup);
    await seedCafeMenuPhotos(accountSetup);
    await seedInventory(inventorySetup, context);
    const loginId = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString('base64url');
    const { salt, hash } = await newPassword(password);
    await accountSetup.query(`
      INSERT INTO account.credential (login_id, user_id, salt, password_hash) VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id) DO UPDATE SET login_id = EXCLUDED.login_id, salt = EXCLUDED.salt, password_hash = EXCLUDED.password_hash
    `,
      [loginId, demoIdentity.userId, salt, hash]);
    const root = `/api/v1/stores/${demoIdentity.storeId}`;
    const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin' };
    const login = async () => {
      const result = await gateway.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password }, headers });
      expect(result.statusCode).toBe(200);
      return { ...headers, authorization: `Bearer ${result.json().accessToken}` };
    };
    const readMenu = (auth: Awaited<ReturnType<typeof login>>) =>
      gateway.inject({ method: 'GET', url: `${root}/inventory/menu?limit=25`, headers: auth });
    const first = await readMenu(await login());
    const auth = await login();
    const second = await readMenu(auth);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const { items } = second.json();
    expect(items).toEqual(first.json().items);
    expect(items).toHaveLength(24);
    expect(new Set(items.map((item: { photoFileId: string }) => item.photoFileId)).size).toBe(24);
    const posQuery = new URLSearchParams(seedCatalog.menu.map(menu => ['menuId', menu.dbId]));
    const pos = await inventory.inject({
      method: 'GET',
      url: `/internal/v1/inventory/stores/${demoIdentity.storeId}/catalog-snapshot?${posQuery}`,
      headers: {
        authorization: `Bearer ${posCatalogToken}`, 'x-navis-store-id': demoIdentity.storeId,
        'x-navis-store-role': 'owner', 'x-navis-user-id': demoIdentity.userId,
      },
    });
    expect(pos.statusCode).toBe(200);
    const posItems = pos.json().items;
    expect(posItems).toHaveLength(24);
    for (const menu of seedCatalog.menu) {
      const record = items.find((item: { menuId: string }) => item.menuId === menu.dbId);
      expect(record).toMatchObject({ photoFileId: expect.any(String), photoKey: null });
      expect(posItems).toContainEqual(expect.objectContaining({ menuId: menu.dbId, photoFileId: record.photoFileId }));
      const url = `${root}/files/${record.photoFileId}/content`;
      const photo = await gateway.inject({ method: 'GET', url, headers: auth });
      expect(photo.statusCode).toBe(200);
      expect(photo.headers['content-type']).toBe('image/jpeg');
      const expected = await readFile(new URL(`../../../../../frontend/public/menu-photos/cafe-${menu.menuId.slice(2)}-01.jpeg`, import.meta.url));
      expect(photo.rawPayload.equals(expected)).toBe(true);
    }
    expect((await gateway.inject({
      method: 'GET', url: `${root}/files/${items[0].photoFileId}/content`, headers,
    })).statusCode).toBe(401);
  } finally {
    await Promise.all([gateway.close(), account.close(), inventory.close()]);
    await Promise.all([accountSetup, inventorySetup, accountDb, inventoryDb].map(pool => pool.end()));
  }
}, 30_000);
