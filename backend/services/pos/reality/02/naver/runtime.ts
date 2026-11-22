import { join } from 'node:path';
import { createCommerceTokenExchange } from '../../../../account/naver/commerce.ts';
import { readSecret } from '../../../../../packages/db/index.ts';
import type { NaverBinding, NaverRequestScope } from '../../../../../packages/naver/config/index.ts';
import { createNaverTransport } from '../../../../../packages/naver/transport/index.ts';
import { createPosNaver } from '../../../naver/index.ts';
import { isUuid } from '../../../wire.ts';
import { bcrypt } from '../../../../../packages/naver/commerce/bcrypt.ts';
import { createCommerceTokens } from '../../../../../packages/naver/commerce/tokens.ts';
import { virtualSigningClock } from '../../../../../packages/naver/config/clock.ts';

import type { PosNaverOptions } from './routes.ts';

export { createCommerceTokens };

const ref = '[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,159}';
// Only the operations this POS surface uses. Npay approve/cancel are not bound: the POS shows Npay read-only.
export const posNaverOperations = [
  ['pn02.orders.list', 'GET', 'P', new RegExp('^/partner-assumed/v1/orders$')],
  ['pn02.orders.read', 'GET', 'P', new RegExp(`^/partner-assumed/v1/orders/${ref}$`)],
  ['pn02.orders.prepare', 'POST', 'O', new RegExp(`^/partner-assumed/v1/orders/${ref}/prepare$`)],
  ['pn02.orders.pickup', 'POST', 'O', new RegExp(`^/partner-assumed/v1/orders/${ref}/pickup$`)],
  ['pn09.pay.settlement', 'GET', 'W',
    /^\/naverpaysettle-payment\/naverpaysettle\/v1\/settlements\/by-case\/(?:payment-id|pay-hist-id)\/[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,49}$/],
  ['pn16.commerce.token', 'POST', 'W', /^\/external\/v1\/oauth2\/token$/],
  ['pn16.commerce.orders.detail', 'POST', 'W', /^\/external\/v1\/pay-order\/seller\/product-orders\/query$/],
] as const;

function actorOf(scope: NaverRequestScope) {
  const actorId = (scope.approvalScope as { actorId?: unknown } | undefined)?.actorId;
  if (typeof actorId !== 'string') throw new Error('NAVER request lacks the owner context');
  return actorId;
}

/**
 * NAVER virtual server provider for the POS workload, from the Compose/Kubernetes environment. Returns undefined
 * when no NAVER account is configured for this deployment. Credential files are read at send time.
 */
export function posNaverFromEnv(env: NodeJS.ProcessEnv = process.env, { fetcher }: { fetcher?: typeof fetch } = {}): PosNaverOptions | undefined {
  const {
    NAVIS_NAVER_VIRTUAL_STORE_ID: storeId, NAVIS_NAVER_VIRTUAL_ACCOUNT_ID: providerAccount, NAVIS_NAVER_VIRTUAL_ORIGIN: origin,
    NAVIS_NAVER_VIRTUAL_TOKEN_FILE: privateTokenFile, NAVIS_NAVER_VIRTUAL_PROVIDER_CREDENTIALS_DIR: directory,
  } = env;
  if (!storeId && !providerAccount) return undefined;
  if (!isUuid(storeId) || !providerAccount || !origin || !privateTokenFile || !directory) {
    throw new Error('Incomplete private POS NAVER provider configuration');
  }
  const file = (name: string) => join(directory, name);
  const clock = virtualSigningClock(env);
  const now = () => +clock();
  const commerceId = file('nvirtual_pos_commerce_id');
  // The token exchange shares the transport whose Commerce binding asks it for a bearer at send time.
  const tokens = createCommerceTokens(createCommerceTokenExchange({
    request: (...args) => transport.request(...args),
  }, async () => {
    const salt = readSecret(file('nvirtual_pos_commerce_salt'));
    return { clientId: readSecret(commerceId), sign: async (value: string) => bcrypt(value, salt) };
  }, now), now);
  // https://docs.pay.naver.com/docs/common/authentication
  const npay = async (_scope: NaverRequestScope, clientId: string) => ({
    'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': readSecret(file('nvirtual_pay_secret')),
    'X-NaverPay-Chain-Id': readSecret(file('nvirtual_pay_chain')),
  });
  const commerce = async (scope: NaverRequestScope) => ({
    authorization: 'Bearer ' + await tokens.token({ storeId: scope.storeId, actorId: actorOf(scope) }),
  });
  const transport = createNaverTransport({ fetcher,
    bindings: posNaverOperations.map(([operation, method, grade, route]): NaverBinding => {
      const base = { operation, method, grade, route, storeId, providerAccount, mode: 'virtual' as const, origin, privateTokenFile,
        timeoutMs: 2_000 };
      if (operation === 'pn09.pay.settlement') return { ...base, credentialFile: file('nvirtual_pay_id'), authorize: npay };
      if (operation === 'pn16.commerce.orders.detail') return { ...base, credentialFile: commerceId, authorize: commerce };
      return base;
    }),
  });
  const naver = createPosNaver(transport);
  const { orders, order, fulfillOrder, settlements } = naver;
  return {
    storeId,
    // Npay approve/cancel stay unreachable from this surface.
    naver: {
      orders, order, fulfillOrder, settlements,
      async commerceOrders(ctx, ids) {
        try {
          return await naver.commerceOrders(ctx, ids);
        } catch (error) {
          tokens.forget(ctx.storeId);
          throw error;
        }
      },
    },
  };
}
