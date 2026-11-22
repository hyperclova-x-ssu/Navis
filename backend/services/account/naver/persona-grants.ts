import type { NaverBinding } from '../../../packages/naver/config/index.ts';
import { createNaverTransport } from '../../../packages/naver/transport/index.ts';
import { createOwnerGrantResolver } from './oauth.ts';
import { json, object, text, type OwnerContext } from './wire.ts';

type Scope = 'calendar' | 'cafe';
const operation = 'pn11.fixture.owner-grant';

export function createPersonaOwnerGrants(options: {
  owner: OwnerContext;
  scopes: readonly Scope[];
  bindings: readonly Exclude<NaverBinding, { mode: 'live' }>[];
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  if (options.bindings.some(binding => !['fake', 'virtual'].includes(binding.mode)
    || binding.storeId !== options.owner.storeId || binding.operation !== operation)) {
    throw new Error('Expected a scoped synthetic owner grant binding');
  }
  const transport = createNaverTransport({ bindings: options.bindings });
  const read: Parameters<typeof createOwnerGrantResolver>[0] = async (ctx, scope) => {
    if (ctx.actorId !== options.owner.actorId || ctx.storeId !== options.owner.storeId ||
      scope === 'profile' || !options.scopes.includes(scope)) return;
    const startedAt = now();
    const response = transport.request(operation, ctx.storeId, '/partner-assumed/v1/fixture/owner-grants', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storeId: ctx.storeId, actorId: ctx.actorId, scope }),
    });
    const grant = object(await json(response));
    if (typeof grant.expiresIn !== 'number' || !Number.isSafeInteger(grant.expiresIn)
      || grant.expiresIn <= 0 || grant.expiresIn > 300) return;
    return { ...ctx, scope, accessToken: text(grant.accessToken), expiresAt: new Date(+startedAt + grant.expiresIn * 1000) };
  };
  return { read, resolve: createOwnerGrantResolver(read, now) };
}
