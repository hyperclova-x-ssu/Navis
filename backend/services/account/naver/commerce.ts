import { invalidWire, integer, json, object, ownerRequest, text, type NaverTransport, type OwnerContext } from './wire.ts';

type CommerceCredentials = { clientId: string; sign: (value: string) => Promise<string>; sellerAccountId?: string };

// https://apicenter.commerce.naver.com/docs/commerce-api/current/exchange-sellers-auth
export function createCommerceTokenExchange(transport: NaverTransport,
  credentials: (ctx: OwnerContext) => Promise<CommerceCredentials>, now = Date.now) {
  return async (ctx: OwnerContext) => {
    const { clientId, sign, sellerAccountId } = await credentials(ctx);
    const timestamp = String(now());
    const clientSecretSign = Buffer.from(await sign(clientId + '_' + timestamp)).toString('base64');
    const body = new URLSearchParams({ client_id: clientId, timestamp, grant_type: 'client_credentials',
      client_secret_sign: clientSecretSign, type: sellerAccountId ? 'SELLER' : 'SELF' });
    if (sellerAccountId) body.set('account_id', sellerAccountId);
    const row = object(await json(ownerRequest(transport, ctx)('pn16.commerce.token', '/external/v1/oauth2/token', {
      body, approvalScope: { actorId: ctx.actorId },
    })));
    if (row.token_type !== 'Bearer') return invalidWire();
    return { accessToken: text(row.access_token), expiresIn: integer(row.expires_in) };
  };
}
