import type { Pool } from 'pg';
import manifest from '../../../frontend/src/data/db/generated/manifest.json' with { type: 'json' };
import { createSeedContext } from '../../packages/db/seed-context.ts';
import { demoIdentity } from './identity.ts';
import { transaction } from './transaction.ts';

// Mirrors inventory's synthetic comparison store. The café IDs come from the snapshot.
export const comparisonStoreId = '33123a19-6780-4d38-9bca-ce96efcf8559';
const comparisonOwnerId = '62001ca1-8761-5e9a-bd5e-e99fa4010279';

interface SeedUser {
  user_id: string;
  email: string;
  name: string;
  last_login_at: string | null;
}

interface SeedStore {
  store_id: string;
  display_name: string;
  business_type: string;
  payment_style: string;
  timezone: string;
  business_day_start: string;
  pos_start_tab: string;
  area_key: string | null;
  lat: number | null;
  lng: number | null;
  settings_revision: number;
  created_at: string;
  updated_at: string;
}

interface SeedMember {
  store_id: string;
  user_id: string;
  role: string;
  created_at: string;
  updated_at: string;
}

export async function seed(pool: Pool, { rows } = createSeedContext()): Promise<void> {
  // The JavaScript generator builds its row arrays dynamically.
  const [cafeUser]: SeedUser[] = rows.app_user;
  const [cafeStore]: SeedStore[] = rows.store;
  const [cafeMember]: SeedMember[] = rows.store_member;
  if (
    cafeStore.store_id !== demoIdentity.storeId ||
    cafeUser.user_id !== demoIdentity.userId ||
    cafeMember.store_id !== demoIdentity.storeId ||
    cafeMember.user_id !== demoIdentity.userId ||
    cafeMember.role !== 'owner' ||
    manifest.store.storeId !== demoIdentity.storeId
  ) throw new Error('Account seed identity differs from the SPA fixture');

  const fixtures = [
    { user: cafeUser, store: cafeStore, member: cafeMember },
    {
      user: { ...cafeUser, user_id: comparisonOwnerId, email: 'comparison-owner@example.invalid', name: '상도책방 사장님' },
      store: { ...cafeStore, store_id: comparisonStoreId, display_name: '상도책방' },
      member: { ...cafeMember, store_id: comparisonStoreId, user_id: comparisonOwnerId },
    },
  ];
  await transaction(pool, async (client) => {
    for (const { user, store, member } of fixtures) {
      await client.query(`
        INSERT INTO account.app_user (user_id, email, name, last_login_at)
        VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING
      `, [user.user_id, user.email, user.name, user.last_login_at]);
      await client.query(`
        INSERT INTO account.store
          (store_id, display_name, business_type, payment_style, timezone, business_day_start,
           pos_start_tab, area_key, lat, lng, settings_revision, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (store_id) DO NOTHING
      `, [
        store.store_id, store.display_name, store.business_type, store.payment_style, store.timezone,
        store.business_day_start, store.pos_start_tab, store.area_key, store.lat, store.lng,
        store.settings_revision, store.created_at, store.updated_at,
      ]);
      await client.query(`
        INSERT INTO account.store_member (store_id, user_id, role, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (store_id, user_id) DO NOTHING
      `, [member.store_id, member.user_id, member.role, member.created_at, member.updated_at]);
    }
  });
}
