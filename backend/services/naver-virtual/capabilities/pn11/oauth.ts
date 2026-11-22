import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PersonaCapability } from '../../app.ts';
import type { NaverProfile, NaverToken } from '../../../../packages/naver/contracts/pn11/index.ts';

type Context = Parameters<PersonaCapability['register']>[1];
type Scope = 'profile' | 'calendar' | 'cafe';

const redirectUri = 'https://navis.example.invalid/oauth/naver/callback';
const lifetime = 3600;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const opaqueToken = () => randomBytes(32).toString('base64url');
export const bearerToken = (request: FastifyRequest) => /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1];

export async function oauthAccess(request: FastifyRequest, context: Context, scope: Scope) {
  const token = bearerToken(request);
  if (!token) return 'missing';
  return context.transaction(request, async (client) => {
    const result = await client.query<{ scopes: Scope[] }>(`
      SELECT scopes FROM naver_virtual.pn11_oauth
      WHERE account_id = $1 AND access_hash = $2 AND expires_at > $3
    `, [context.accountId(request), digest(token), context.now()]);
    const row = result.rows[0];
    return row ? (row.scopes.includes(scope) ? 'allowed' : 'forbidden') : 'invalid';
  });
}

function paramsFrom(input: unknown): Record<string, string> | undefined {
  if (typeof input !== 'object' || !input || Array.isArray(input)) return;
  if (!Object.values(input).every((value) => typeof value === 'string')) return;
  return input as Record<string, string>;
}

function loginError(reply: FastifyReply, error: string, error_description: string) {
  return reply.header('cache-control', 'no-store').send({ error, error_description });
}

export function registerOAuth(app: FastifyInstance, context: Context) {
  app.post<{ Body: { storeId?: unknown; actorId?: unknown; scope?: unknown } }>('/partner-assumed/v1/fixture/owner-grants', {
    config: { personaOperation: 'pn11.fixture.owner-grant' }, bodyLimit: 2048,
  }, async (request, reply) => {
    const { storeId, actorId, scope } = request.body ?? {};
    const allowedStore = context.providerCredential(request, 'storeId');
    const allowedActor = context.providerCredential(request, 'actorId');
    const scopes = context.providerCredential(request, 'scopes')?.split(',');
    if (!allowedStore || !allowedActor || storeId !== allowedStore || actorId !== allowedActor ||
      (scope !== 'calendar' && scope !== 'cafe') || !scopes?.includes(scope)) {
      return reply.code(403).send();
    }
    const at = context.now();
    const expiresIn = 60;
    const token = opaqueToken();
    const account = context.accountId(request);
    await context.transaction(request, async client => {
      await client.query(`
        DELETE FROM naver_virtual.pn11_oauth
        WHERE account_id=$1 AND client_id='fixture-owner-grant' AND expires_at <= $2
      `, [account, at]);
      await client.query(`
        INSERT INTO naver_virtual.pn11_oauth
          (account_id, code_hash, state_hash, scopes, code_expires_at, client_id, access_hash, expires_at)
        VALUES ($1,$2,$3,ARRAY[$4::text],$5,'fixture-owner-grant',$2,$5)
      `, [account, digest(token), digest(opaqueToken()), scope, new Date(+at + expiresIn * 1000)]);
    });
    return reply.header('cache-control', 'no-store').send({ accessToken: token, expiresIn });
  });

  // https://developers.naver.com/docs/login/api/api.md
  app.get('/oauth2.0/authorize', { config: { personaOperation: 'pn11.authorize' } }, async (request, reply) => {
    const params = paramsFrom(request.query);
    const registeredClient = context.providerCredential(request, 'clientId');
    if (!params || params.redirect_uri !== redirectUri || !registeredClient || params.client_id !== registeredClient) {
      return reply.code(400).send({ error: 'invalid_request', error_description: 'Invalid client or redirect URI' });
    }
    const { response_type: responseType, state } = params;
    if (responseType !== 'code' || !state || state.length > 512 ||
        Object.keys(params).some(key => !['response_type', 'state', 'client_id', 'redirect_uri'].includes(key))) {
      return reply.code(400).send({ error: 'invalid_request', error_description: 'Invalid authorization request' });
    }
    const code = opaqueToken();
    await context.transaction(request, async (client) => {
      await client.query(`
        INSERT INTO naver_virtual.pn11_oauth (account_id, code_hash, state_hash, scopes, code_expires_at, client_id)
        VALUES ($1, $2, $3, ARRAY['profile','calendar'], $4, $5)
      `, [context.accountId(request), digest(code), digest(state), new Date(+context.now() + 300_000), registeredClient]);
    });
    const url = new URL(redirectUri);
    url.search = new URLSearchParams({ code, state }).toString();
    return reply.redirect(url.toString());
  });

  // https://developers.naver.com/docs/login/api/api.md
  app.route({
    method: ['GET', 'POST'], url: '/oauth2.0/token', config: { personaOperation: 'pn11.token' },
    async handler(request, reply) {
      if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
        return loginError(reply, 'invalid_request', 'Invalid token request');
      }
      const params = paramsFrom(request.method === 'GET' ? request.query : request.body);
      const registeredClient = context.providerCredential(request, 'clientId');
      const registeredSecret = context.providerCredential(request, 'clientSecret');
      if (!params || !registeredClient || !registeredSecret || params.client_id !== registeredClient ||
          params.client_secret !== registeredSecret) {
        return loginError(reply, 'invalid_client', 'Client authentication failed');
      }
      const { grant_type: grant, code, state, refresh_token } = params;
      if (Object.keys(params).some(key => !['grant_type', 'code', 'state', 'refresh_token', 'client_id', 'client_secret'].includes(key))) return loginError(reply, 'invalid_request', 'Invalid token request');
      const now = context.now();
      const expiresAt = new Date(+now + lifetime * 1000);
      const newAccess = opaqueToken();
      const newRefresh = opaqueToken();
      if (grant === 'authorization_code' && code && state && !refresh_token) {
        const exchanged = await context.transaction(request, async (client) => client.query(`
          UPDATE naver_virtual.pn11_oauth
          SET access_hash = $5, refresh_hash = $6, expires_at = $7
          WHERE account_id = $1 AND code_hash = $2 AND state_hash = $3
            AND code_expires_at > $4 AND access_hash IS NULL AND client_id = $8
        `, [context.accountId(request), digest(code), digest(state), now, digest(newAccess), digest(newRefresh), expiresAt, registeredClient]));
        if (!exchanged.rowCount) return loginError(reply, 'invalid_grant', 'Invalid or expired code');
        const token: NaverToken = { access_token: newAccess, refresh_token: newRefresh, token_type: 'bearer', expires_in: lifetime };
        return reply.header('cache-control', 'no-store').send(token);
      }
      if (grant === 'refresh_token' && refresh_token && !code && !state) {
        const refreshed = await context.transaction(request, async (client) => client.query(`
          UPDATE naver_virtual.pn11_oauth SET access_hash = $3, expires_at = $4
          WHERE account_id = $1 AND refresh_hash = $2 AND client_id = $5
        `, [context.accountId(request), digest(refresh_token), digest(newAccess), expiresAt, registeredClient]));
        if (!refreshed.rowCount) return loginError(reply, 'invalid_grant', 'Invalid refresh token');
        const token: NaverToken = { access_token: newAccess, token_type: 'bearer', expires_in: lifetime };
        return reply.header('cache-control', 'no-store').send(token);
      }
      return loginError(reply, 'invalid_request', 'Invalid grant parameters');
    },
  });

  // https://developers.naver.com/docs/login/api/api.md (Token revocation)
  app.post('/oauth2.0/revoke', { config: { personaOperation: 'pn11.token' } }, async (request, reply) => {
    const input = paramsFrom(request.body);
    if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded') || !input) {
      return loginError(reply.code(400), 'invalid_request', 'Invalid revocation request');
    }
    const { client_id, client_secret, token, token_type_hint = 'access_token', ...extra } = input;
    if (!token || !client_id || !client_secret || Object.keys(extra).length ||
        !['access_token', 'refresh_token'].includes(token_type_hint)) {
      return loginError(reply.code(400), 'invalid_request', 'Invalid revocation request');
    }
    if (client_id !== context.providerCredential(request, 'clientId') ||
        client_secret !== context.providerCredential(request, 'clientSecret')) {
      return loginError(reply.code(401), 'unauthorized_client', 'Client authentication failed');
    }
    const column = token_type_hint === 'access_token' ? 'access_hash' : 'refresh_hash';
    await context.transaction(request, async (client) => client.query(`
      DELETE FROM naver_virtual.pn11_oauth WHERE account_id = $1 AND client_id = $2 AND ${column} = $3
    `, [context.accountId(request), client_id, digest(token)]));
    return reply.header('cache-control', 'no-store').code(200).send();
  });

  // https://developers.naver.com/docs/login/profile/profile.md
  app.get('/v1/nid/me', { config: { personaOperation: 'pn11.profile' } }, async (request, reply) => {
    const access = await oauthAccess(request, context, 'profile');
    if (access === 'missing') return reply.code(401).send({ resultcode: '028', message: 'Authentication header not exists' });
    if (access === 'invalid') return reply.code(401).send({ resultcode: '024', message: 'Authentication failed' });
    if (access === 'forbidden') return reply.code(403).send({ resultcode: '403', message: 'Forbidden' });
    const result: NaverProfile = { resultcode: '00', message: 'success', response: {
      id: digest(`naver-login:${context.accountId(request)}`),
    } };
    return reply.header('cache-control', 'no-store').send(result);
  });
}
