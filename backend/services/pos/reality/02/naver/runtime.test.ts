import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { bcrypt } from './bcrypt.ts';
import { createCommerceTokens, posNaverFromEnv } from './runtime.ts';

const directory = mkdtempSync(join(tmpdir(), 'pos-naver-'));
const files = {
  nvirtual_pos_token: 'virtual-pos-token', nvirtual_pay_id: 'pay-client', nvirtual_pay_secret: 'pay-secret', nvirtual_pay_chain: 'pay-chain',
  nvirtual_pos_commerce_id: 'commerce-client', nvirtual_pos_commerce_salt: '$2a$04$0123456789abcdef01234.',
};
for (const [name, value] of Object.entries(files)) writeFileSync(join(directory, name), value + '\n');
const storeId = 'c05409a6-f082-5964-a787-c1ed3184988b';
const env = {
  NAVIS_NAVER_VIRTUAL_STORE_ID: storeId, NAVIS_NAVER_VIRTUAL_ACCOUNT_ID: 'ansungjalbu-cafe', NAVIS_NAVER_VIRTUAL_ORIGIN: 'http://naver-virtual:3000',
  NAVIS_NAVER_VIRTUAL_TOKEN_FILE: join(directory, 'nvirtual_pos_token'), NAVIS_NAVER_VIRTUAL_PROVIDER_CREDENTIALS_DIR: directory,
};
const ctx = { storeId, actorId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' };
afterAll(() => rmSync(directory, { recursive: true }));

it('stays off without a NAVER account and refuses a partial configuration', () => {
  expect(posNaverFromEnv({})).toBeUndefined();
  expect(() => posNaverFromEnv({ ...env, NAVIS_NAVER_VIRTUAL_STORE_ID: 'cafe' })).toThrow('Incomplete');
  expect(() => posNaverFromEnv({ ...env, NAVIS_NAVER_VIRTUAL_PROVIDER_CREDENTIALS_DIR: '' })).toThrow('Incomplete');
});

it('binds only the POS operations with the virtual-server token, Npay merchant and Commerce authentication', async () => {
  const sent: Array<{ url: URL; method: string; headers: Headers; body: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body ? new TextDecoder().decode(init.body as Uint8Array) : '';
    sent.push({ url, method: init?.method ?? 'GET', headers, body });
    const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/partner-assumed/v1/orders') return reply([{ orderNumber: 'order-01', preparationMinutes: null, status: 'received' }]);
    if (url.pathname.startsWith('/naverpaysettle-payment/')) {
      return reply({ code: 'Success', body: { list: [], responseCount: 0, currentPage: 1, totalCount: 0, totalPageCount: 0 } });
    }
    if (url.pathname === '/external/v1/oauth2/token') return reply({ access_token: 'a'.repeat(43), expires_in: 10_800, token_type: 'Bearer' });
    return reply({ timestamp: 'now', traceId: 'trace', data: [] });
  };
  const naver = posNaverFromEnv(env, { fetcher })!.naver;
  expect(await naver.orders(ctx)).toEqual([{ orderNumber: 'order-01', preparationMinutes: null, status: 'received' }]);
  await naver.settlements(ctx, 'payment-id', 'PN09SETTLED01');
  await naver.commerceOrders(ctx, ['202611230001001']);
  await naver.commerceOrders(ctx, ['202611220001101']);
  expect(Object.keys(naver).sort()).toEqual(['commerceOrders', 'fulfillOrder', 'order', 'orders', 'settlements']);

  expect(sent.map(row => `${row.method} ${row.url.pathname}`)).toEqual([
    'GET /partner-assumed/v1/orders',
    'GET /naverpaysettle-payment/naverpaysettle/v1/settlements/by-case/payment-id/PN09SETTLED01',
    'POST /external/v1/oauth2/token',
    'POST /external/v1/pay-order/seller/product-orders/query',
    'POST /external/v1/pay-order/seller/product-orders/query',
  ]);
  for (const row of sent) {
    expect(row.headers.get('x-navis-naver-virtual-token')).toBe('virtual-pos-token');
    expect(row.headers.get('x-navis-naver-virtual-account')).toBe('ansungjalbu-cafe');
  }
  expect(sent[0].headers.has('x-naver-client-id')).toBe(false);
  expect(Object.fromEntries(['x-naver-client-id', 'x-naver-client-secret', 'x-naverpay-chain-id'].map(name => [name, sent[1].headers.get(name)])))
    .toEqual({ 'x-naver-client-id': 'pay-client', 'x-naver-client-secret': 'pay-secret', 'x-naverpay-chain-id': 'pay-chain' });
  const form = new URLSearchParams(sent[2].body);
  expect(Object.fromEntries(form)).toEqual({ client_id: 'commerce-client', timestamp: expect.stringMatching(/^\d+$/),
    grant_type: 'client_credentials', client_secret_sign: expect.any(String), type: 'SELF' });
  const signed = bcrypt(`commerce-client_${form.get('timestamp')}`, files.nvirtual_pos_commerce_salt);
  expect(Buffer.from(form.get('client_secret_sign')!, 'base64').toString()).toBe(signed);
  expect(sent.slice(3).map(row => row.headers.get('authorization'))).toEqual(['Bearer ' + 'a'.repeat(43), 'Bearer ' + 'a'.repeat(43)]);
  expect(JSON.parse(sent[3].body)).toEqual({ productOrderIds: ['202611230001001'] });
});

it('renews a Commerce token 30 minutes before expiry and shares one request', async () => {
  let clock = 0;
  let issued = 0;
  const tokens = createCommerceTokens(async () => ({ accessToken: `token-${++issued}`, expiresIn: 10_800 }), () => clock);
  expect(await Promise.all([tokens.token(ctx), tokens.token(ctx)])).toEqual(['token-1', 'token-1']);
  clock = (10_800 - 1_801) * 1_000;
  expect(await tokens.token(ctx)).toBe('token-1');
  clock = (10_800 - 1_800) * 1_000;
  expect(await tokens.token(ctx)).toBe('token-2');
  tokens.forget(storeId);
  expect(await tokens.token(ctx)).toBe('token-3');
});
