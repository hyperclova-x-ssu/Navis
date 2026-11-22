import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { newPassword, normalizedLogin, verifyPassword } from '../../identity.ts';
import { uuidPattern } from '../../sessions.ts';
import { transaction } from '../../transaction.ts';
import { emitAccountEvent } from './outbox.ts';

export async function provisionOwner(pool: Pool, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid owner provisioning document');
  const { loginId: login, password, ownerName, storeId, storeName, businessDayStart = '00:00' } = input as Record<string, unknown>;
  const loginId = normalizedLogin(login);
  if (!loginId || typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 256
    || typeof ownerName !== 'string' || !ownerName.trim() || ownerName.length > 100
    || typeof storeName !== 'string' || !storeName.trim() || storeName.length > 100
    || typeof storeId !== 'string' || !new RegExp(uuidPattern).test(storeId)
    || typeof businessDayStart !== 'string' || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(businessDayStart)) {
    throw new Error('Invalid owner provisioning fields');
  }
  const store = storeId.toLowerCase();
  const candidate = await newPassword(password);
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('account:provision:' || $1, 0))", [loginId]);
    const { rows: [existing] } = await client.query<{ user_id: string; salt: Buffer; password_hash: Buffer }>(`
      SELECT user_id, salt, password_hash FROM account.credential WHERE login_id = $1
    `, [loginId]);
    const userId = existing?.user_id ?? randomUUID();
    if (existing) {
      if (!await verifyPassword(password, existing)) throw new Error('Owner credentials differ from the provisioned account');
    } else {
      await client.query('INSERT INTO account.app_user (user_id, email, name) VALUES ($1, $2, $3)', [userId, loginId, ownerName.trim()]);
      await client.query('INSERT INTO account.credential (login_id, user_id, salt, password_hash) VALUES ($1, $2, $3, $4)',
        [loginId, userId, candidate.salt, candidate.hash]);
    }
    const result = await client.query(`
      INSERT INTO account.store (store_id, display_name, business_type, payment_style, pos_start_tab, business_day_start,
        settings_revision, created_at, updated_at)
      VALUES ($1, $2, NULL, 'prepaid', 'order', $3::time, 1, statement_timestamp(), statement_timestamp())
      ON CONFLICT (store_id) DO NOTHING
    `, [store, storeName.trim(), businessDayStart]);
    if (!result.rowCount) {
      const member = await client.query("SELECT 1 FROM account.store_member WHERE store_id = $1 AND user_id = $2 AND role = 'owner'", [store, userId]);
      if (member.rowCount) return;
      throw new Error('Store is already provisioned');
    }
    await client.query(`
      INSERT INTO account.store_member (store_id, user_id, role, created_at, updated_at)
      VALUES ($1, $2, 'owner', statement_timestamp(), statement_timestamp())
    `, [store, userId]);
    await emitAccountEvent(client, 'account.store_changed.v1', store, { storeId: store, revision: 1 });
    await emitAccountEvent(client, 'account.store_membership_changed.v1', userId, { storeId: store, userId, role: 'owner' });
  });
}
