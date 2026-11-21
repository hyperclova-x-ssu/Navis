import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { demoIdentity } from './identity.ts';
import type { Role, SessionClaims, SigningKeys } from './keys.ts';
import { inStore } from './transaction.ts';

export const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
export const refreshCookieName = 'navis_refresh';
const refreshPattern = new RegExp(`^(${uuidPattern.slice(1, -1)})\\.[A-Za-z0-9_-]{43}$`);

function hash(token: string) {
  return createHash('sha256').update(token).digest();
}

export function refreshCredential(header: string | undefined) {
  const name = `${refreshCookieName}=`;
  const cookies = header?.split(';').map((part) => part.trim()).filter((part) => part.startsWith(name));
  if (cookies?.length !== 1) return null;
  const token = cookies[0].slice(name.length);
  const match = refreshPattern.exec(token);
  return match ? { storeId: match[1], tokenHash: hash(token) } : null;
}

interface CurrentSession {
  sid: string;
  user_id: string;
  expires_at: Date;
  role: Role;
}

async function issue(
  client: PoolClient,
  keys: SigningKeys,
  storeId: string,
  session: CurrentSession,
  previousHash?: Buffer,
) {
  const access = await keys.sign({ sid: session.sid, sub: session.user_id, store_id: storeId, role: session.role }, session.expires_at);
  if (!access) return null;
  const refresh = `${storeId}.${randomBytes(32).toString('base64url')}`;
  if (previousHash) {
    await client.query(`
      UPDATE account.refresh_token SET consumed_at = statement_timestamp()
      WHERE store_id = $1 AND token_hash = $2
    `, [storeId, previousHash]);
  }
  await client.query('INSERT INTO account.refresh_token (store_id, sid, token_hash) VALUES ($1, $2, $3)', [
    storeId, session.sid, hash(refresh),
  ]);
  return { access, refresh, sessionExpiry: session.expires_at };
}

export async function createDemoSession(pool: Pool, keys: SigningKeys) {
  const { storeId, userId } = demoIdentity;
  return inStore(pool, storeId, async (client) => {
    const sid = randomUUID();
    const inserted = await client.query<Pick<CurrentSession, 'sid' | 'user_id' | 'expires_at'>>(`
      INSERT INTO account.auth_session (store_id, sid, user_id)
      SELECT store_id, $3, user_id FROM account.store_member
      WHERE store_id = $1 AND user_id = $2 AND role = 'owner'
      RETURNING sid, user_id, expires_at
    `, [storeId, userId, sid]);
    const session = inserted.rows[0];
    return session ? issue(client, keys, storeId, { ...session, role: 'owner' }) : null;
  });
}

export async function rotateRefresh(pool: Pool, keys: SigningKeys, storeId: string, tokenHash: Buffer) {
  return inStore(pool, storeId, async (client) => {
    // The session row serializes family rotation. Read token state after taking the lock.
    const locked = await client.query(`
      SELECT s.sid FROM account.refresh_token t
      JOIN account.auth_session s USING (store_id, sid)
      WHERE t.store_id = $1 AND t.token_hash = $2
      FOR UPDATE OF s
    `, [storeId, tokenHash]);
    if (!locked.rowCount) return null;

    const result = await client.query<CurrentSession & { consumed_at: Date | null }>(`
      SELECT s.sid, s.user_id, s.expires_at, m.role, t.consumed_at
      FROM account.refresh_token t
      JOIN account.auth_session s USING (store_id, sid)
      JOIN account.store_member m USING (store_id, user_id)
      WHERE t.store_id = $1 AND t.token_hash = $2
        AND s.revoked_at IS NULL AND s.expires_at > statement_timestamp()
    `, [storeId, tokenHash]);
    const session = result.rows[0];
    if (!session) return null;
    if (session.consumed_at) {
      // Returning a denial commits the revocation before the caller receives 401.
      await client.query(`
        UPDATE account.auth_session SET revoked_at = statement_timestamp()
        WHERE store_id = $1 AND sid = $2
      `, [storeId, session.sid]);
      return null;
    }

    return issue(client, keys, storeId, session, tokenHash);
  });
}

export async function currentRole(pool: Pool, claims: SessionClaims): Promise<Role | undefined> {
  return inStore(pool, claims.store_id, async (client) => {
    const result = await client.query<{ role: Role }>(`
      SELECT m.role FROM account.auth_session s
      JOIN account.store_member m USING (store_id, user_id)
      WHERE s.store_id = $1 AND s.sid = $2 AND s.user_id = $3
        AND s.revoked_at IS NULL AND s.expires_at > statement_timestamp()
    `, [claims.store_id, claims.sid, claims.sub]);
    return result.rows[0]?.role;
  });
}
