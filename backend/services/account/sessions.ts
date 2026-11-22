import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { demoIdentity, verifyPassword } from './identity.ts';
import type { Role, SessionClaims, SigningKeys } from './keys.ts';
import { inStore, transaction } from './transaction.ts';

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
  return inStore(pool, storeId, client => startSession(client, keys, storeId, userId, 'owner'));
}

async function startSession(
  client: PoolClient, keys: SigningKeys, storeId: string, userId: string, role: Role, expiry?: Date,
) {
  const { rows: [session] } = await client.query<Pick<CurrentSession, 'sid' | 'user_id' | 'expires_at'>>(`
    INSERT INTO account.auth_session (store_id, sid, user_id, created_at, expires_at)
    SELECT store_id, $3, user_id, COALESCE($5::timestamptz - interval '8 hours', statement_timestamp()),
      COALESCE($5::timestamptz, statement_timestamp() + interval '8 hours')
    FROM account.store_member WHERE store_id = $1 AND user_id = $2 AND role = $4
    RETURNING sid, user_id, expires_at
  `, [storeId, userId, randomUUID(), role, expiry ?? null]);
  return session ? issue(client, keys, storeId, { ...session, role }) : null;
}

export async function login(pool: Pool, keys: SigningKeys, loginId: string, password: string) {
  const credential = await transaction(pool, async client => {
    await client.query("SELECT set_config('app.login_id', $1, true), set_config('statement_timeout', '2000', true)", [loginId]);
    const { rows: [row] } = await client.query<{ user_id: string; salt: Buffer; password_hash: Buffer }>(
      'SELECT user_id, salt, password_hash FROM account.credential WHERE login_id = $1', [loginId],
    );
    return row;
  });
  if (!await verifyPassword(password, credential) || !credential) return null;
  return transaction(pool, async client => {
    await client.query("SELECT set_config('app.user_id', $1, true), set_config('statement_timeout', '2000', true)", [credential.user_id]);
    const { rows: [member] } = await client.query<{ store_id: string; role: Role }>(`
      SELECT store_id, role FROM account.store_member
      WHERE user_id = $1 ORDER BY created_at, store_id LIMIT 1
    `, [credential.user_id]);
    if (!member) return null;
    await client.query("SELECT set_config('app.store_id', $1, true)", [member.store_id]);
    return startSession(client, keys, member.store_id, credential.user_id, member.role);
  });
}

export async function storesForSession(pool: Pool, claims: SessionClaims) {
  return inStore(pool, claims.store_id, async client => {
    if (await liveRole(client, claims) !== claims.role) return null;
    await client.query("SELECT set_config('app.user_id', $1, true)", [claims.sub]);
    const { rows } = await client.query<{ storeId: string; name: string; role: Role; current: boolean; revision: number }>(`
      SELECT s.store_id AS "storeId", s.display_name AS name, m.role, (s.store_id = $2) AS current, s.settings_revision AS revision
      FROM account.store_member m JOIN account.store s USING (store_id)
      WHERE m.user_id = $1 ORDER BY s.display_name, s.store_id
    `, [claims.sub, claims.store_id]);
    return { items: rows.map(({ revision: _revision, ...item }) => item), nextCursor: null,
      asOf: new Date().toISOString(), sourceRevision: rows.reduce((sum, row) => sum + row.revision, 0) };
  });
}

type RefreshCredential = NonNullable<ReturnType<typeof refreshCredential>>;

async function lockRefreshFamily(client: PoolClient, storeId: string, tokenHash: Buffer) {
  const locked = await client.query(`
    SELECT s.sid FROM account.refresh_token t
    JOIN account.auth_session s USING (store_id, sid)
    WHERE t.store_id = $1 AND t.token_hash = $2
    FOR UPDATE OF s
  `, [storeId, tokenHash]);
  return Boolean(locked.rowCount);
}

export async function changeStore(pool: Pool, keys: SigningKeys, claims: SessionClaims, credential: RefreshCredential, target: string) {
  if (credential.storeId !== claims.store_id) return { status: 401 } as const;
  return inStore(pool, claims.store_id, async client => {
    if (!await lockRefreshFamily(client, credential.storeId, credential.tokenHash)) return { status: 401 } as const;
    const { rows: [old] } = await client.query<{ expires_at: Date }>(`
      SELECT s.expires_at FROM account.auth_session s
      JOIN account.refresh_token t USING (store_id, sid)
      JOIN account.store_member m USING (store_id, user_id)
      WHERE s.store_id = $1 AND s.sid = $2 AND s.user_id = $3 AND t.token_hash = $4 AND m.role = $5
        AND s.revoked_at IS NULL AND s.expires_at > statement_timestamp() AND t.consumed_at IS NULL
    `, [claims.store_id, claims.sid, claims.sub, credential.tokenHash, claims.role]);
    if (!old) return { status: 401 } as const;
    if (target === claims.store_id) {
      const issued = await issue(client, keys, target, { sid: claims.sid, user_id: claims.sub, expires_at: old.expires_at, role: claims.role }, credential.tokenHash);
      return issued ? { status: 200, issued } as const : { status: 401 } as const;
    }
    await client.query("SELECT set_config('app.store_id', $1, true)", [target]);
    const { rows: [member] } = await client.query<{ role: Role }>(
      'SELECT role FROM account.store_member WHERE store_id = $1 AND user_id = $2', [target, claims.sub],
    );
    if (!member) return { status: 403 } as const;
    const issued = await startSession(client, keys, target, claims.sub, member.role, old.expires_at);
    if (!issued) return { status: 403 } as const;
    await client.query("SELECT set_config('app.store_id', $1, true)", [claims.store_id]);
    await client.query('UPDATE account.auth_session SET revoked_at = statement_timestamp() WHERE store_id = $1 AND sid = $2',
      [claims.store_id, claims.sid]);
    return { status: 200, issued } as const;
  });
}

export async function logout(pool: Pool, { storeId, tokenHash }: RefreshCredential) {
  await inStore(pool, storeId, client => client.query(`
    UPDATE account.auth_session s SET revoked_at = statement_timestamp()
    FROM account.refresh_token t
    WHERE s.store_id = $1 AND t.store_id = s.store_id AND t.sid = s.sid
      AND t.token_hash = $2 AND s.revoked_at IS NULL
  `, [storeId, tokenHash]));
}

export async function rotateRefresh(pool: Pool, keys: SigningKeys, storeId: string, tokenHash: Buffer) {
  return inStore(pool, storeId, async (client) => {
    // The session row serializes family rotation. Read token state after taking the lock.
    if (!await lockRefreshFamily(client, storeId, tokenHash)) return null;

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
  return inStore(pool, claims.store_id, client => liveRole(client, claims));
}

export async function liveRole(client: PoolClient, claims: SessionClaims, lock = false): Promise<Role | undefined> {
  const result = await client.query<{ role: Role }>(`
    SELECT m.role FROM account.auth_session s
    JOIN account.store_member m USING (store_id, user_id)
    WHERE s.store_id = $1 AND s.sid = $2 AND s.user_id = $3
      AND s.revoked_at IS NULL AND s.expires_at > statement_timestamp()
    ${lock ? 'FOR SHARE OF s' : ''}
  `, [claims.store_id, claims.sid, claims.sub]);
  return result.rows[0]?.role;
}
