import { invalidWire, json, NaverError, object, ownerRequest, query, text, type NaverTransport, type OwnerContext } from './wire.ts';

type LoginOptions = {
  credentials: (ctx: OwnerContext) => Promise<{ clientId: string; clientSecret: string; redirectUri: string }>;
  // Session storage atomically consumes a nonce scoped to the authenticated store and actor.
  consumeState: (ctx: OwnerContext, nonce: string) => Promise<boolean>;
};
type Scope = 'profile' | 'calendar' | 'cafe';
type Grant = { actorId: string; storeId: string; scope: Scope; accessToken: string; expiresAt: Date };

// https://developers.naver.com/docs/login/api/api.md
// https://developers.naver.com/docs/login/profile/profile.md
export function createNaverLogin(transport: NaverTransport, options: LoginOptions) {
  const authorizePath = '/oauth2.0/authorize';
  function authorizeQuery(clientId: string, redirectUri: string, state: string) {
    if (!state || state.length > 512) throw new NaverError(400, 'INVALID_OAUTH_STATE');
    return query({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state });
  }
  return {
    async browserAuthorizationUrl(ctx: OwnerContext, state: string) {
      const { clientId, redirectUri } = await options.credentials(ctx);
      return 'https://nid.naver.com' + authorizePath + authorizeQuery(clientId, redirectUri, state);
    },
    async authorizePersona(ctx: OwnerContext, state: string) {
      const config = await options.credentials(ctx);
      if (config.redirectUri !== 'https://navis.example.invalid/oauth/naver/callback') {
        throw new NaverError(403, 'PERSONA_REDIRECT_REQUIRED');
      }
      const response = await ownerRequest(transport, ctx)('pn11.authorize', authorizePath
        + authorizeQuery(config.clientId, config.redirectUri, state));
      const redirect = response.headers.get('location');
      await response.body?.cancel();
      if (response.status !== 302 || !redirect) return invalidWire();
      const target = new URL(redirect);
      if (target.origin + target.pathname !== config.redirectUri || target.searchParams.get('state') !== state) return invalidWire();
      return { code: text(target.searchParams.get('code')), state };
    },
    async exchange(ctx: OwnerContext, code: string, state: string) {
      if (!code || !state || !await options.consumeState(ctx, state)) throw new NaverError(403, 'INVALID_OAUTH_STATE');
      const { clientId, clientSecret } = await options.credentials(ctx);
      const row = object(await json(ownerRequest(transport, ctx)('pn11.token', '/oauth2.0/token', {
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code, state }),
        approvalScope: { actorId: ctx.actorId },
      })));
      const expiresIn = Number(row.expires_in);
      if (row.token_type !== 'bearer' || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) return invalidWire();
      return { accessToken: text(row.access_token), expiresIn,
        ...(row.refresh_token !== undefined && { refreshToken: text(row.refresh_token) }) };
    },
    async profile(ctx: OwnerContext) {
      const row = object(await json(ownerRequest(transport, ctx)('pn11.profile', '/v1/nid/me', {
        approvalScope: { actorId: ctx.actorId },
      })));
      if (row.resultcode !== '00') return invalidWire();
      return { id: text(object(row.response).id) };
    },
  };
}

// The scope comes from an authorized linkage record. A Login profile confers no store rights.
// https://developers.naver.com/docs/login/cafe-api/cafe-api.md
export function createOwnerGrantResolver(read: (ctx: OwnerContext, scope: Scope) => Promise<Grant | undefined>, now = () => new Date()) {
  return async (ctx: OwnerContext, scope: Scope) => {
    const grant = await read(ctx, scope);
    if (!grant || grant.actorId !== ctx.actorId || grant.storeId !== ctx.storeId || grant.scope !== scope
      || !(grant.expiresAt > now()) || !grant.accessToken || /\s/.test(grant.accessToken)) {
      throw new NaverError(403, 'NAVER_GRANT_REQUIRED');
    }
    return grant.accessToken;
  };
}
