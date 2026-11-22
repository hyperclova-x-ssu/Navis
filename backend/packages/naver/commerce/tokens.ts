type CommerceOwner = { storeId: string; actorId: string };

type Exchange = (ctx: CommerceOwner) => Promise<{ accessToken: string; expiresIn: number }>;

// Commerce tokens last 10,800 s; a request within 30 minutes of expiry is served by a replacement.
// https://apicenter.commerce.naver.com/docs/commerce-api/current/exchange-sellers-auth
export function createCommerceTokens(exchange: Exchange, now: () => number = Date.now) {
  const cache = new Map<string, { token: string; refreshAt: number }>();
  const inflight = new Map<string, Promise<string>>();
  return {
    async token(ctx: CommerceOwner) {
      const hit = cache.get(ctx.storeId);
      if (hit && now() < hit.refreshAt) return hit.token;
      let pending = inflight.get(ctx.storeId);
      if (!pending) {
        pending = exchange(ctx).then(({ accessToken, expiresIn }) => {
          cache.set(ctx.storeId, { token: accessToken, refreshAt: now() + Math.max(0, expiresIn - 1_800) * 1_000 });
          return accessToken;
        }).finally(() => inflight.delete(ctx.storeId));
        inflight.set(ctx.storeId, pending);
      }
      return pending;
    },
    forget(storeId: string) {
      cache.delete(storeId);
    },
  };
}
