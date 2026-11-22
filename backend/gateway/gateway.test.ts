import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from './app.ts';

const store = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const sid = '44444444-4444-4444-8444-444444444444';
const requestId = 'a'.repeat(32);
const catalog = { items: [{ menuId: user, name: 'Tea', category: 'drink', price: 3100, saleStatus: 'selling' }] };
const claims = { sub: user, sid, store_id: store, role: 'owner' };
const key = await generateKeyPair('ES256');
const jwks = { keys: [{ ...await exportJWK(key.publicKey), kid: 'account-key', alg: 'ES256', use: 'sig' }] };

async function token(patch: JWTPayload = {}, kid = 'account-key', privateKey = key.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    ...claims, iss: 'navis-account', aud: 'navis-api', iat: now, exp: now + 600, ...patch,
  }).setProtectedHeader({ alg: 'ES256', kid }).sign(privateKey);
}

function setup(options: Partial<Parameters<typeof createGateway>[0]> = {}) {
  let authorization: () => Response = () => new Response(null, { status: 204 });
  let keys: () => Response = () => Response.json(jwks);
  let auth: () => Response = () => Response.json({ accessToken: 'browser-token', expiresIn: 600, storeId: store }, {
    headers: { 'set-cookie': 'navis_refresh=test; Path=/api/v1/auth; HttpOnly; SameSite=Strict' },
  });
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    switch (new URL(String(url)).pathname) {
      case '/internal/v1/auth/jwks': return keys();
      case '/internal/v1/auth/authorize': return authorization();
      case '/internal/v1/inventory/catalog': return Response.json(catalog);
      case `/internal/v1/inventory/stores/${store}/menu/${user}`:
        return Response.json({ resourceId: user, revision: 2, receiptId: sid, affectedSources: ['menu'] });
      case `/internal/v1/inventory/stores/${store}/place/menu`:
      case `/internal/v1/inventory/stores/${store}/approvals`:
      case `/internal/v1/inventory/stores/${store}/place/venue`:
      case `/internal/v1/inventory/stores/${store}/items/${user}/commerce-stock`:
      case `/internal/v1/inventory/stores/${store}/purchase-orders/${user}/supplier-message`:
      case `/internal/v1/inventory/stores/${store}/menu/${user}/place/preview`:
      case `/internal/v1/inventory/stores/${store}/menu/${user}/place/confirm`:
      case `/internal/v1/inventory/stores/${store}/place/venue/preview`:
      case `/internal/v1/inventory/stores/${store}/place/venue/confirm`:
      case `/internal/v1/inventory/stores/${store}/items/${user}/commerce-stock/preview`:
      case `/internal/v1/inventory/stores/${store}/items/${user}/commerce-stock/confirm`:
      case `/internal/v1/inventory/stores/${store}/purchase-orders/${user}/supplier-message/preview`:
      case `/internal/v1/inventory/stores/${store}/purchase-orders/${user}/supplier-message/confirm`:
        return Response.json({ items: [] });
      case `/internal/v1/inventory/stores/${store}/purchase-orders`:
      case `/internal/v1/inventory/stores/${store}/purchasing/receipts/${user}/undo`:
      case `/internal/v1/pos/stores/${store}/ledger`:
      case `/internal/v1/pos/stores/${store}/expense-candidates/${user}/confirm`:
        return Response.json({ resourceId: user, revision: 2 });
      case `/internal/v1/account/stores/${store}/boards`:
        return Response.json({ items: [], nextCursor: null, sourceRevision: 0 });
      case `/internal/v1/account/stores/${store}/profile`:
        return Response.json({ paymentStyle: 'postpaid', businessType: 'cafe', tableLayout: { tables: [] } });
      case `/internal/v1/account/stores/${store}/operating-clock`:
        return Response.json({ timezone: 'Asia/Seoul', businessDayStart: '04:30' });
      case `/internal/v1/customer/stores/${store}/calendar/exports`:
        return new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', {
          headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="navis-calendar.ics"' },
        });
      case `/internal/v1/customer/stores/${store}/customers`:
        return Response.json({ items: [], nextCursor: null, sourceRevision: 0 });
      case `/internal/v1/customer/stores/${store}/calendar/naver-approvals`:
      case `/internal/v1/customer/stores/${store}/approvals`:
      case `/internal/v1/customer/stores/${store}/calendar/events/${user}/naver`:
      case `/internal/v1/customer/stores/${store}/shifts/naver-works`:
      case `/internal/v1/customer/stores/${store}/shifts/${user}/naver-works`:
        return Response.json({ items: [] });
      case `/internal/v1/marketing/stores/${store}/approvals`:
      case `/internal/v1/marketing/stores/${store}/notice-recipient-groups`:
      case `/internal/v1/marketing/stores/${store}/community/cafe-boards`:
      case `/internal/v1/marketing/stores/${store}/community/cafe-posts`:
      case `/internal/v1/marketing/stores/${store}/reviews/${user}/navis-draft-preview`:
      case `/internal/v1/marketing/stores/${store}/notices/${user}/sms-reservation`:
      case `/internal/v1/marketing/stores/${store}/notices/${user}/cancel-sms`:
        return Response.json({ items: [] });
      case `/internal/v1/insight/stores/${store}/insight/table-links`:
      case `/internal/v1/insight/stores/${store}/insight/financial-center/recommendations`:
      case `/internal/v1/insight/stores/${store}/insight/financial-center/recommendations/notice_1`:
      case `/internal/v1/insight/stores/${store}/insight/review-insights`:
      case `/internal/v1/insight/stores/${store}/insight/channel-reports/search-ads`:
        return Response.json({ items: [] });
      case `/internal/v1/insight/stores/${store}/insight/manuals`:
        return Response.json({ code: 'DUPLICATE_MANUAL_TITLE' }, { status: 409 });
      case `/internal/v1/pos/stores/${store}/member-accounts`:
        return Response.json({ items: [], nextCursor: null, sourceRevision: 0 });
      case `/internal/v1/pos/stores/${store}/naver/orders`:
      case `/internal/v1/pos/stores/${store}/naver/orders/order_1~x`:
      case `/internal/v1/pos/stores/${store}/naver/orders/order_1~x/prepare`:
      case `/internal/v1/pos/stores/${store}/naver/orders/order_1~x/pickup`:
      case `/internal/v1/pos/stores/${store}/naver/npay/payments/payment_1`:
      case `/internal/v1/pos/stores/${store}/naver/npay/pay-histories/history_1`:
      case `/internal/v1/pos/stores/${store}/naver/smartstore/order-statuses`:
        return Response.json({ items: [] });
      case `/internal/v1/pos/stores/${store}/bills/${user}/orders`:
      case `/internal/v1/pos/stores/${store}/bills/${user}/move`:
      case `/internal/v1/pos/stores/${store}/bills/${user}/merge`:
      case `/internal/v1/pos/stores/${store}/bills/${user}/split`:
      case `/internal/v1/pos/stores/${store}/receipts/${user}/undo`:
      case `/internal/v1/pos/stores/${store}/custom-orders`:
      case `/internal/v1/pos/stores/${store}/custom-receipts/receipts/${user}/undo`:
        return Response.json({ resourceId: user, revision: 2 });
      case '/api/v1/auth/demo':
      case '/api/v1/auth/refresh': return auth();
      case `/internal/v1/insight/stores/${store}/navis/chat`:
        return new Response('event: done\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
      case '/api/navis/chat':
        return new Response('event: done\ndata: {}\n\n', {
          headers: { 'content-type': 'text/event-stream', 'x-navis-protocol': 'agent-v1' },
        });
      case '/api/navis/media/transcription': return Response.json({ text: '오늘 매출' });
      case '/api/navis/widget-drafts':
        return Response.json({}, { headers: { 'set-cookie': 'navis_demo_session=fixture; Path=/api/navis; HttpOnly' } });
      case '/api/promo/catalog': return Response.json({ photos: [{ photoId: 'one' }] });
      case '/readyz': return new Response(null, { status: 200 });
      default: throw new Error('Unexpected upstream');
    }
  });
  const app = createGateway({
    accountUrl: 'http://account:3000', inventoryUrl: 'http://inventory:3000',
    accountToken: 'account-workload', inventoryToken: 'inventory-workload', fetcher,
    phase3: { insightUrl: 'http://insight:3000', insightToken: 'insight-workload',
      marketingUrl: 'http://marketing:3000', marketingToken: 'marketing-read', smsToken: 'marketing-confirm' },
    browserApis: {
      origin: 'https://demo.example', navisUrl: 'http://insight-navis:8787',
      marketingUrl: 'http://marketing:3000', marketingToken: 'marketing-read',
    },
    browserPost: (url, headers, signal) => fetcher(url, { method: 'POST', headers, signal }),
    navisRequest: (url, options) => fetcher(url, options),
    logging: false,
    ...options,
  });
  closers.push(() => app.close());

  function read(accessToken: string, storeId = store, headers = {}) {
    return app.inject({
      method: 'GET', url: `/api/v1/inventory/catalog?storeId=${storeId}`,
      headers: { authorization: `Bearer ${accessToken}`, 'x-request-id': requestId, ...headers },
    });
  }
  const calls = () => fetcher.mock.calls.map(([url, init]) => ({
    url: String(url), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body,
  }));

  return {
    app, read, calls,
    setAuthorization: (response: () => Response) => { authorization = response; },
    setKeys: (response: () => Response) => { keys = response; },
    setAuth: (response: () => Response) => { auth = response; },
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(closers.splice(0).map(close => close()));
});

it('allows the four owner Insight reads and rejects provider writes at the gateway', async () => {
  const { app, calls } = setup({ phase3: undefined, insightRecords: { url: 'http://insight:3000', token: 'insight-records' } });
  const headers = { host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${await token()}` };
  for (const path of ['/financial-center/recommendations', '/financial-center/recommendations/notice_1',
    '/review-insights?unit=week', '/channel-reports/search-ads?date=2026-11-16']) {
    const url = `/api/v1/stores/${store}/insight${path}`;
    expect((await app.inject({ url, headers })).statusCode).toBe(200);
    expect(calls().at(-1)).toMatchObject({
      url: `http://insight:3000/internal/v1/insight/stores/${store}/insight${path}`,
      method: 'GET', headers: { authorization: 'Bearer insight-records', 'x-navis-business-day-start': '04:30' },
    });
    expect((await app.inject({ method: 'POST', url, headers, payload: {} })).statusCode).toBe(404);
  }
});

it('forwards owner Inventory publication and supplier cards and keeps dispatch private', async () => {
  const { app, calls } = setup({ phase3: undefined });
  const owner = { host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${await token()}` };
  const root = `/api/v1/stores/${store}/inventory`;
  const upstream = `http://inventory:3000/internal/v1/inventory/stores/${store}`;
  const venue = '/place/venue';
  const commerce = `/items/${user}/commerce-stock`;
  const supplier = `/purchase-orders/${user}/supplier-message`;
  for (const path of ['/place/menu', venue, commerce, supplier]) {
    expect((await app.inject({ url: root + path, headers: owner })).statusCode).toBe(200);
    expect(calls().at(-1)?.url).toBe(upstream + path);
  }
  expect((await app.inject({ url: root + '/approvals', method: 'POST', headers: owner,
    payload: { stage: 'press', operation: 'place.menu.publish', resourceId: user, expectedRevision: 1, previewId: sid } })).statusCode).toBe(200);
  expect(calls().at(-1)?.headers['x-navis-inventory-card-press']).toBeUndefined();
  for (const path of [`/menu/${user}/place`, venue, commerce, supplier]) {
    for (const stage of ['preview', 'confirm']) {
      const suffix = `${path}/${stage}`;
      const headers = { ...owner, 'idempotency-key': `card:${stage}`, 'x-navis-inventory-card-press': 'browser-spoof' };
      const payload = stage === 'confirm' ? { approvalId: user, previewId: sid, expectedRevision: 1 } : {};
      expect((await app.inject({ url: root + suffix, method: 'POST', headers, payload })).statusCode).toBe(200);
      expect(calls().at(-1)).toMatchObject({ url: upstream + suffix, method: 'POST',
        headers: { 'idempotency-key': `card:${stage}`, authorization: 'Bearer inventory-workload' } });
      expect(calls().at(-1)?.headers['x-navis-inventory-card-press']).toBeUndefined();
    }
  }
  const privatePath = `/supplier-dispatch/stores/${store}`;
  expect((await app.inject({ url: root + privatePath, headers: owner })).statusCode).toBe(404);
  expect((await app.inject({ url: root + `${privatePath}/${user}/claim`, headers: owner,
    method: 'POST', payload: {} })).statusCode).toBe(404);
});

it('routes NAVER orders, Npay and Smart Store to the owner POS workload', async () => {
  const { app, calls } = setup({ phase3: undefined, pos: { url: 'http://pos:3000', token: 'pos-workload' } });
  const headers = { host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${await token()}`,
    'idempotency-key': 'naver-order-card' };
  const root = `/api/v1/stores/${store}/pos/naver`;
  const upstream = `http://pos:3000/internal/v1/pos/stores/${store}/naver`;
  for (const path of ['/orders', '/orders/order_1~x', '/npay/payments/payment_1', '/npay/pay-histories/history_1']) {
    expect((await app.inject({ url: root + path, headers })).statusCode).toBe(200);
    expect(calls().at(-1)?.url).toBe(upstream + path);
  }
  for (const path of ['/orders/order_1~x/prepare', '/orders/order_1~x/pickup', '/smartstore/order-statuses']) {
    expect((await app.inject({ url: root + path, method: 'POST', headers, payload: {} })).statusCode).toBe(200);
    expect(calls().at(-1)).toMatchObject({ url: upstream + path, method: 'POST',
      headers: { 'idempotency-key': 'naver-order-card', authorization: 'Bearer pos-workload' } });
  }
  expect((await app.inject({ url: root + '/npay/payments/payment_1/cancel', method: 'POST', headers, payload: {} })).statusCode).toBe(404);
});

it('routes Calendar and Marketing card actions through owner credentials', async () => {
  const { app, calls } = setup({ phase3: undefined, customer: { url: 'http://customer:3000', token: 'customer-workload' },
    marketingRecords: { url: 'http://marketing:3000', token: 'marketing-read', localCommandToken: 'marketing-local' } });
  const headers = { host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${await token()}`,
    'idempotency-key': `navis:${sid}` };
  const root = `/api/v1/stores/${store}`;
  const cases = [
    ['POST', '/calendar/naver-approvals'], ['POST', '/approvals'],
    ['GET', `/calendar/events/${user}/naver`], ['POST', `/calendar/events/${user}/naver`],
    ['GET', '/shifts/naver-works'], ['POST', `/shifts/${user}/naver-works`],
    ['PATCH', `/shifts/${user}/naver-works`], ['DELETE', `/shifts/${user}/naver-works`],
    ['POST', '/marketing/approvals'], ['GET', '/marketing/community/cafe-boards'],
    ['GET', '/marketing/community/cafe-posts'], ['POST', '/marketing/community/cafe-posts'],
    ['POST', `/marketing/reviews/${user}/navis-draft-preview`], ['GET', `/marketing/notices/${user}/sms-reservation`],
    ['POST', `/marketing/notices/${user}/cancel-sms`],
  ] as const;
  for (const [method, path] of cases) {
    const marketing = path.startsWith('/marketing/');
    expect((await app.inject({ method, url: root + path, headers, ...(method !== 'GET' && { payload: {} }) })).statusCode).toBe(200);
    expect(calls().at(-1)).toMatchObject({ method, headers: { authorization: marketing ? 'Bearer marketing-read' : 'Bearer customer-workload' } });
  }
  const fixture = '/partner-assumed/v1/fixture/owner-grants';
  expect((await app.inject({ method: 'POST', url: root + fixture, headers, payload: {} })).statusCode).toBe(404);
});

it('routes owner notice groups without exposing worker claims or Customer consent reads', async () => {
  const { app, calls } = setup({ phase3: undefined, customer: { url: 'http://customer:3000', token: 'customer-workload' },
    marketingRecords: { url: 'http://marketing:3000', token: 'marketing-read' } });
  const headers = { host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${await token()}`,
    'idempotency-key': 'owner-notice-group' };
  const root = `/api/v1/stores/${store}`;
  for (const method of ['GET', 'POST'] as const) {
    expect((await app.inject({ method, url: root + '/marketing/notice-recipient-groups', headers,
      ...(method === 'POST' && { payload: { name: '가상 수신 그룹', memberIds: [user] } }) })).statusCode).toBe(200);
    expect(calls().at(-1)).toMatchObject({ method, headers: { authorization: 'Bearer marketing-read',
      'idempotency-key': 'owner-notice-group' } });
  }
  for (const secretPath of ['/internal/v1/marketing/notice-sms-dispatch/claim', root + '/sms-recipients']) {
    expect((await app.inject({ method: 'POST', url: secretPath, headers, payload: {} })).statusCode).toBe(404);
  }
});

it('forwards a scoped menu DELETE with its body and key only after live authorization', async () => {
  const { app, calls, setAuthorization } = setup();
  const headers = {
    host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${await token()}`,
    'idempotency-key': 'archive:request', 'x-navis-store-id': other,
  };
  const url = `/api/v1/stores/${store}/inventory/menu/${user}`;
  const payload = { expectedRevision: 1, confirmed: true };
  expect((await app.inject({ method: 'DELETE', url, headers, payload })).statusCode).toBe(200);
  expect(calls().at(-1)).toMatchObject({
    url: `http://inventory:3000/internal/v1/inventory/stores/${store}/menu/${user}`,
    method: 'DELETE', body: JSON.stringify(payload),
    headers: { 'idempotency-key': 'archive:request', 'x-navis-store-id': store, 'x-navis-user-id': user },
  });
  setAuthorization(() => new Response(null, { status: 401 }));
  expect((await app.inject({ method: 'DELETE', url, headers, payload })).statusCode).toBe(401);
  expect(calls().filter(call => call.method === 'DELETE')).toHaveLength(1);
});

it('allowlists account reads independently of fixture services and rejects cross-origin requests', async () => {
  const { app } = setup({ phase3: undefined });
  const url = `/api/v1/stores/${store}/boards`;
  const headers = { host: 'demo.example', 'sec-fetch-site': 'same-origin', authorization: `Bearer ${await token()}` };
  expect((await app.inject({ url, headers })).statusCode).toBe(200);
  expect((await app.inject({ url, headers: { ...headers, origin: 'https://other.example' } })).statusCode).toBe(403);
  expect((await app.inject({ url: `${url}/private`, headers })).statusCode).toBe(404);
});

it('exposes a calendar attachment through the owner gateway with the live store clock', async () => {
  const customer = { url: 'http://customer:3000', token: 'customer-workload' };
  const { app, calls, setAuthorization } = setup({ phase3: undefined, customer });
  const base = `/api/v1/stores/${store}`;
  const path = '/calendar/exports?startDate=2026-11-21&endDate=2026-11-22';
  const headers = { host: 'demo.example', 'sec-fetch-site': 'same-origin', authorization: `Bearer ${await token()}` };
  const response = await app.inject({ url: base + path, headers });
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
  expect(response.headers).toMatchObject({
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': 'attachment; filename="navis-calendar.ics"',
    'cache-control': 'no-store',
  });
  expect(calls().at(-1)).toMatchObject({
    url: `http://customer:3000/internal/v1/customer/stores/${store}${path}`,
    headers: {
      authorization: 'Bearer customer-workload', 'x-navis-store-id': store, 'x-navis-user-id': user,
      'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '04:30',
    },
  });
  expect((await app.inject({ url: base + '/calendar/exports/private', headers })).statusCode).toBe(404);
  setAuthorization(() => new Response(null, { status: 401 }));
  expect((await app.inject({ url: base + path, headers })).statusCode).toBe(401);
  expect(calls().filter(call => call.url.startsWith('http://customer:3000'))).toHaveLength(1);
});

it('routes owner membership data to the correct services without exposing member claims', async () => {
  const { app, calls } = setup({
    phase3: undefined, customer: { url: 'http://customer:3000', token: 'customer-workload' },
    pos: { url: 'http://pos:3000', token: 'pos-workload' },
  });
  const root = `/api/v1/stores/${store}`;
  const headers = { host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${await token()}` };
  expect((await app.inject({ url: root + '/customers?limit=10', headers })).statusCode).toBe(200);
  expect(calls().at(-1)).toMatchObject({
    url: `http://customer:3000/internal/v1/customer/stores/${store}/customers?limit=10`,
    headers: { authorization: 'Bearer customer-workload', 'x-navis-store-timezone': 'Asia/Seoul' },
  });
  expect((await app.inject({ url: root + '/pos/member-accounts', headers })).statusCode).toBe(200);
  expect(calls().at(-1)).toMatchObject({
    url: `http://pos:3000/internal/v1/pos/stores/${store}/member-accounts`, headers: { authorization: 'Bearer pos-workload' },
  });
  for (const path of [
    '/member-source', '/member-source/claims', '/pos/member-archive', '/pos/member-archive/undo',
    '/pos/member-uses/use', '/pos/member-uses/cancel',
  ]) {
    expect((await app.inject({ method: 'POST', url: root + path, headers, payload: {} })).statusCode).toBe(404);
  }
});

it.each([
  [`/bills/${user}/orders`, { expectedRevision: 1 }],
  [`/bills/${user}/move`, { expectedRevision: 1 }],
  [`/bills/${user}/merge`, { expectedRevision: 1 }],
  [`/bills/${user}/split`, { expectedRevision: 1 }],
  [`/receipts/${user}/undo`, {}],
] as const)('routes the owner POS command %s with its idempotency key', async (suffix, payload) => {
  const { app, calls, setAuthorization } = setup({
    phase3: undefined, pos: { url: 'http://pos:3000', token: 'pos-workload' },
  });
  const url = `/api/v1/stores/${store}/pos${suffix}`;
  const headers = {
    host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${await token()}`,
    'idempotency-key': 'postpaid-command',
  };
  expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(200);
  expect(calls().at(-1)).toMatchObject({
    url: `http://pos:3000/internal/v1/pos/stores/${store}${suffix}`,
    method: 'POST', body: JSON.stringify(payload),
    headers: {
      authorization: 'Bearer pos-workload', 'idempotency-key': 'postpaid-command',
      'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-user-id': user,
    },
  });
  setAuthorization(() => new Response(null, { status: 401 }));
  expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(401);
  expect(calls().filter(call => call.url.startsWith('http://pos:3000'))).toHaveLength(1);
});

it.each([
  ['GET', 'inventory', '/purchase-orders?limit=10'],
  ['POST', 'inventory', `/purchasing/receipts/${user}/undo`],
  ['GET', 'pos', '/ledger?limit=10'],
  ['POST', 'pos', `/expense-candidates/${user}/confirm`],
  ['GET', 'pos', '/custom-orders?limit=10'],
  ['POST', 'pos', `/custom-receipts/receipts/${user}/undo`],
] as const)('forwards %s %s%s with the current store clock', async (method, service, suffix) => {
  const { app, calls, setAuthorization } = setup({ pos: { url: 'http://pos:3000', token: 'pos-workload' } });
  const root = `/api/v1/stores/${store}`;
  const url = `${root}/${service}${suffix}`;
  const headers = {
    host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${await token()}`,
    'idempotency-key': 'purchasing-finance-request', 'x-navis-store-timezone': 'UTC', 'x-navis-business-day-start': '00:00',
  };
  const input = { method, url, headers, ...(method === 'POST' && { payload: { confirmed: true } }) };
  expect((await app.inject(input)).statusCode).toBe(200);
  expect(calls().at(-1)).toMatchObject({
    url: `http://${service}:3000/internal/v1/${service}/stores/${store}${suffix}`,
    headers: {
      authorization: `Bearer ${service}-workload`, 'x-navis-store-id': store, 'x-navis-user-id': user,
      'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '04:30',
      ...(method === 'POST' && { 'idempotency-key': 'purchasing-finance-request' }),
    },
  });
  const privateUrl = `${root}/inventory/purchase-receipt-status/${user}`;
  expect((await app.inject({ url: privateUrl, headers })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: `${root}/files/${user}/custom-reference-photo-verify`, headers, payload: {} })).statusCode).toBe(404);
  setAuthorization(() => new Response(null, { status: 401 }));
  expect((await app.inject(input)).statusCode).toBe(401);
  expect(calls().filter(call => call.url.startsWith(`http://${service}:3000`))).toHaveLength(1);
});

it('routes Insight records with live owner clock and table mode while Phase 3 is disabled', async () => {
  const { app, calls, setAuthorization } = setup({
    phase3: undefined, insightRecords: { url: 'http://insight:3000', token: 'insight-records' },
  });
  const prefix = `/api/v1/stores/${store}/insight`;
  const headers = { host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${await token()}`,
    'x-navis-pos-tables-enabled': '0', 'idempotency-key': 'manual-owner-request' };
  expect((await app.inject({ url: prefix + '/table-links', headers })).statusCode).toBe(200);
  expect(calls().at(-1)).toMatchObject({ url: `http://insight:3000/internal/v1/insight/stores/${store}/insight/table-links`,
    headers: { 'x-navis-pos-tables-enabled': '1', 'x-navis-store-timezone': 'Asia/Seoul' } });
  const manual = { method: 'POST', url: prefix + '/manuals', headers, payload: { body: 'a'.repeat(150 * 1024) } } as const;
  const conflict = await app.inject(manual);
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toEqual({ code: 'DUPLICATE_MANUAL_TITLE', reason: 'DUPLICATE_MANUAL_TITLE' });
  expect(calls().at(-1)?.headers).toMatchObject({ 'idempotency-key': 'manual-owner-request', authorization: 'Bearer insight-records' });
  setAuthorization(() => new Response(null, { status: 401 }));
  expect((await app.inject(manual)).statusCode).toBe(401);
});

describe('browser demo API gateway', () => {
  const site = { host: 'demo.example', 'sec-fetch-site': 'same-origin' };
  const post = { ...site, origin: 'https://demo.example' };

  it('proxies a browser chat stream without forwarding browser credentials or scope', async () => {
    const { app, calls } = setup();
    const response = await app.inject({
      method: 'POST', url: '/api/navis/chat', payload: { turn: 'fixture' },
      headers: { ...post, 'x-navis-protocol': 'agent-v1', 'x-navis-store-id': other,
        authorization: 'Basic edge-password', cookie: 'navis_gate=edge-only' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ 'x-navis-protocol': 'agent-v1', 'x-accel-buffering': 'no' });
    expect(response.body).toContain('event: done');
    expect(calls()).toMatchObject([{ url: 'http://insight-navis:8787/api/navis/chat', method: 'POST' }]);
    expect(calls()[0].headers).toEqual({
      host: site.host, 'sec-fetch-site': 'same-origin', origin: post.origin, 'x-request-id': expect.any(String),
      'content-type': 'application/json', 'x-navis-protocol': 'agent-v1',
    });
  });

  it('forwards bounded raw media and keeps the widget session cookie scoped to Insight', async () => {
    const { app, calls } = setup();
    const bytes = Buffer.from([0, 128, 255]);
    const media = await app.inject({
      method: 'POST', url: '/api/navis/media/transcription', headers: { ...post, 'content-type': 'audio/webm' }, payload: bytes,
    });
    expect(media.statusCode).toBe(200);
    expect(calls()[0].body).toEqual(new Uint8Array(bytes));
    const drafts = await app.inject({
      method: 'POST', url: '/api/navis/widget-drafts', payload: { widget: 'ai-response' },
      headers: { ...post, cookie: 'navis_gate=edge-only; navis_demo_session=fixture; other=private' },
    });
    expect(drafts.headers['set-cookie']).toEqual(['navis_demo_session=fixture; Path=/api/navis; HttpOnly']);
    expect(calls()[1].headers.cookie).toBe('navis_demo_session=fixture');
  });

  it('checks same-origin metadata and per-route body limits before contacting the workload', async () => {
    const { app, calls } = setup();
    for (const headers of [site, { ...post, host: 'other.example' }, { ...post, origin: 'https://other.example' },
      { ...post, 'sec-fetch-site': 'same-site' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/navis/chat', headers, payload: {} });
      expect(response.statusCode).toBe(403);
    }
    const tooLarge = await app.inject({
      method: 'POST', url: '/api/navis/widget-drafts', headers: post, payload: { text: 'a'.repeat(2048) },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toEqual({ code: 'PAYLOAD_TOO_LARGE' });
    expect(calls()).toEqual([]);
    const promo = await app.inject({ method: 'GET', url: '/api/promo/catalog', headers: site });
    expect(promo.statusCode).toBe(200);
    expect(calls()).toMatchObject([{ url: 'http://marketing:3000/api/promo/catalog', method: 'GET',
      headers: { authorization: 'Bearer marketing-read' } }]);
  });

  it('keeps gateway readiness independent of the browser Navis workload', async () => {
    const { app, calls } = setup();
    expect((await app.inject('/readyz')).statusCode).toBe(200);
    expect(calls().map(call => new URL(call.url).hostname).sort()).toEqual(['account', 'insight', 'inventory', 'marketing']);
  });
});

describe('catalog gateway', () => {
  it('forwards only verified store context and propagates the edge request ID', async () => {
    const { read, calls } = setup();
    const result = await read(await token(), store, {
      'x-navis-store-id': other, 'x-navis-store-role': 'staff', 'x-navis-session-id': other,
      'x-navis-workload-token': 'client-supplied', cookie: 'client=1',
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(catalog);
    expect(result.headers).toMatchObject({ 'cache-control': 'no-store', 'x-request-id': requestId });
    expect(calls()).toEqual([
      { url: 'http://account:3000/internal/v1/auth/jwks', method: 'GET', headers: {
        authorization: 'Bearer account-workload', 'x-request-id': requestId,
      }, body: undefined },
      { url: 'http://account:3000/internal/v1/auth/authorize', method: 'POST', headers: {
        authorization: 'Bearer account-workload', 'x-request-id': requestId, 'content-type': 'application/json',
      }, body: JSON.stringify(claims) },
      { url: `http://inventory:3000/internal/v1/inventory/catalog?storeId=${store}`, method: 'GET', headers: {
        authorization: 'Bearer inventory-workload', 'x-request-id': requestId, 'x-navis-store-id': store, 'x-navis-store-role': 'owner',
      }, body: undefined },
    ]);
  });

  it('validates the store query, requires a bearer, and keeps internal routes private', async () => {
    const { app, read, calls } = setup();
    for (const value of ['', 'not-a-uuid', `${store}&storeId=${store}`, `${store}&other=1`]) {
      const result = await read('unused', value);
      expect(result.statusCode).toBe(400);
      expect(result.json()).toEqual({ code: 'INVALID_REQUEST' });
      expect(result.headers['cache-control']).toBe('no-store');
    }
    const missing = await app.inject(`/api/v1/inventory/catalog?storeId=${store}`);
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect((await app.inject('/internal/v1/auth/jwks')).statusCode).toBe(404);
    expect(calls()).toEqual([]);
  });

  it.each([
    { iss: 'elsewhere' }, { aud: 'elsewhere' }, { sub: undefined }, { sub: 'not-a-uuid' },
    { sid: 'not-a-uuid' }, { store_id: 'not-a-uuid' }, { role: 'admin' },
    { iat: undefined }, { iat: 1.5 }, { exp: undefined },
    { exp: Math.floor(Date.now() / 1000) + 3600 },
  ])('rejects invalid JWT claims %o', async (patch) => {
    const { read, calls } = setup();
    const result = await read(await token(patch));
    expect(result.statusCode).toBe(401);
    expect(result.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(calls().every(call => call.url.endsWith('/jwks'))).toBe(true);
  });

  it('rejects unknown or absent keys and non-ES256 signatures', async () => {
    const { read, calls } = setup();
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'account-key' })
      .sign(new Uint8Array(32));
    const missingKid = await new SignJWT(claims).setProtectedHeader({ alg: 'ES256' }).sign(key.privateKey);
    for (const value of [hs, missingKid, await token({}, 'unknown')]) {
      const result = await read(value);
      expect(result.statusCode).toBe(401);
      expect(result.json()).toEqual({ code: 'UNAUTHENTICATED' });
    }
    expect(calls().map(call => new URL(call.url).pathname)).toEqual(['/internal/v1/auth/jwks']);
  });

  it('allows five seconds of future issuance without extending the 600-second lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { read } = setup();
    const now = Math.floor(Date.now() / 1000);
    expect((await read(await token({ iat: now + 5, exp: now + 605 }))).statusCode).toBe(200);
    for (const [iat, exp] of [[now + 6, now + 606], [now + 5, now + 606]]) {
      const result = await read(await token({ iat, exp }));
      expect(result.statusCode).toBe(401);
      expect(result.json()).toEqual({ code: 'UNAUTHENTICATED' });
    }
  });

  it('allows signed access until the expiration tolerance is exhausted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { read, calls } = setup();
    const exp = Math.floor(Date.now() / 1000) - 4;
    const access = await token({ iat: exp - 600, exp });
    expect((await read(access)).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 1000);
    const result = await read(access);
    expect(result.statusCode).toBe(401);
    expect(result.json()).toEqual({ code: 'TOKEN_EXPIRED' });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(calls().filter(call => call.url.endsWith('/authorize'))).toHaveLength(1);
  });

  it('refreshes the cached key set on rotation and expiry while authorizing every read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { read, calls, setKeys } = setup();
    const access = await token();
    expect((await read(access)).statusCode).toBe(200);
    expect((await read(access)).statusCode).toBe(200);
    expect(calls().filter(call => call.url.endsWith('/jwks'))).toHaveLength(1);

    const replacement = await generateKeyPair('ES256');
    const newVerifier = { ...await exportJWK(replacement.publicKey), kid: 'replacement', alg: 'ES256', use: 'sig' };
    setKeys(() => Response.json({ keys: [...jwks.keys, newVerifier] }));
    const rotated = await token({}, 'replacement', replacement.privateKey);
    expect((await read(rotated)).statusCode).toBe(200);
    expect((await read(access)).statusCode).toBe(200);
    expect(calls().filter(call => call.url.endsWith('/jwks'))).toHaveLength(2);

    vi.setSystemTime(Date.now() + 30_000);
    setKeys(() => Response.json({ keys: [newVerifier] }));
    const retired = await read(access);
    expect(retired.statusCode).toBe(401);
    expect(retired.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect((await read(rotated)).statusCode).toBe(200);
    expect(calls().filter(call => call.url.endsWith('/jwks'))).toHaveLength(3);
    expect(calls().filter(call => call.url.endsWith('/authorize'))).toHaveLength(5);
  });

  it('denies A/B store mismatches and staff reads even with spoofed owner headers', async () => {
    const { read, calls } = setup();
    for (const [access, requested] of [[await token(), other], [await token({ role: 'staff' }), store]]) {
      const result = await read(access, requested, { 'x-navis-store-id': requested, 'x-navis-store-role': 'owner' });
      expect(result.statusCode).toBe(403);
      expect(result.json()).toEqual({ code: 'STORE_FORBIDDEN' });
    }
    expect(calls().filter(call => call.url.includes('/authorize'))).toHaveLength(2);
    expect(calls().some(call => call.url.includes('inventory:3000'))).toBe(false);
  });

  it('asks account every time and fails closed on revocation, denial, and outage', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { read, calls, setAuthorization, setKeys } = setup();
    const access = await token();
    expect((await read(access)).statusCode).toBe(200);
    for (const [status, expected, code] of [
      [401, 401, 'UNAUTHENTICATED'], [403, 403, 'STORE_FORBIDDEN'], [503, 503, 'SERVICE_UNAVAILABLE'],
      [200, 503, 'SERVICE_UNAVAILABLE'],
    ] as const) {
      setAuthorization(() => Response.json({ code }, { status }));
      const result = await read(access);
      expect(result.statusCode).toBe(expected);
      expect(result.json()).toEqual({ code });
    }
    setAuthorization(() => { throw new DOMException('Timed out', 'TimeoutError'); });
    expect((await read(access)).json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
    vi.setSystemTime(Date.now() + 30_000);
    setKeys(() => new Response(null, { status: 503 }));
    expect((await read(access)).json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
    expect(calls().filter(call => call.url.includes('inventory:3000'))).toHaveLength(1);
  });
});

describe('browser auth proxy', () => {
  it('requires the edge proof for hosted demo and supplies its own assertion only on that route', async () => {
    const edgeProof = 'a'.repeat(64);
    const { app, calls } = setup({ hostedDemo: { origin: 'https://demo.example', edgeProof } });
    const headers = { host: 'demo.example', origin: 'https://demo.example', 'x-navis-demo-gate-verified': '1' };
    const demo = (extra = {}) => app.inject({ method: 'POST', url: '/api/v1/auth/demo', headers: { ...headers, ...extra } });

    expect((await demo()).statusCode).toBe(403);
    expect((await demo({ 'x-navis-edge-demo-proof': '1' })).statusCode).toBe(403);
    expect((await demo({ 'x-navis-edge-demo-proof': [edgeProof, edgeProof] })).statusCode).toBe(403);
    expect((await demo({ host: 'other.example', 'x-navis-edge-demo-proof': edgeProof })).statusCode).toBe(403);
    expect((await demo({ origin: 'https://other.example', 'x-navis-edge-demo-proof': edgeProof })).statusCode).toBe(403);
    expect(calls()).toHaveLength(0);

    expect((await demo({ 'x-navis-edge-demo-proof': edgeProof })).statusCode).toBe(200);
    expect(calls().at(-1)?.headers).toMatchObject({ authorization: 'Bearer account-workload', 'x-navis-demo-gate-verified': '1' });
    expect(calls().at(-1)?.headers['x-navis-edge-demo-proof']).toBeUndefined();

    const refresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { ...headers, 'x-navis-edge-demo-proof': edgeProof } });
    expect(refresh.statusCode).toBe(200);
    expect(calls().at(-1)?.headers['x-navis-demo-gate-verified']).toBeUndefined();
    expect(calls().at(-1)?.headers['x-navis-edge-demo-proof']).toBeUndefined();
  });

  it('proxies Host and Origin, plus Cookie only on refresh, and passes Set-Cookie back', async () => {
    const { app, calls, setAuth } = setup();
    const headers = {
      host: '127.0.0.1:18180', origin: 'http://127.0.0.1:18180', 'x-request-id': requestId,
      authorization: 'Bearer browser', cookie: 'navis_refresh=old', 'x-navis-store-id': other,
      'x-navis-edge-demo-proof': 'client', 'x-navis-demo-gate-verified': '1',
    };
    for (const endpoint of ['demo', 'refresh']) {
      const result = await app.inject({ method: 'POST', url: `/api/v1/auth/${endpoint}`, headers });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ accessToken: 'browser-token', expiresIn: 600, storeId: store });
      expect(result.headers).toMatchObject({
        'cache-control': 'no-store', 'x-request-id': requestId,
        'set-cookie': ['navis_refresh=test; Path=/api/v1/auth; HttpOnly; SameSite=Strict'],
      });
      expect(calls().at(-1)?.headers).toEqual({
        host: headers.host, origin: headers.origin, authorization: 'Bearer account-workload',
        'x-request-id': requestId, ...(endpoint === 'refresh' ? { cookie: headers.cookie } : {}),
      });
    }
    setAuth(() => Response.json({ code: 'NOT_FOUND' }, { status: 404 }));
    const absent = await app.inject({ method: 'POST', url: '/api/v1/auth/demo', headers });
    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toEqual({ code: 'NOT_FOUND' });
  });
});


describe('Phase ③ gateway', () => {
  const chat = `/api/v1/stores/${store}/navis/chat`;

  it('streams typed Navis output using only the verified owner and forwarded protocol', async () => {
    const { app, calls } = setup();
    const response = await app.inject({ method: 'POST', url: chat, payload: { turn: 'fixture' }, headers: {
      authorization: `Bearer ${await token()}`, 'x-navis-protocol': 'agent-v1',
      'x-navis-store-id': other, 'x-navis-user-id': other, 'x-navis-store-role': 'staff',
    } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: done');
    expect(calls().at(-1)).toMatchObject({
      headers: { authorization: 'Bearer insight-workload', 'x-navis-protocol': 'agent-v1',
        'x-navis-store-id': store, 'x-navis-user-id': user, 'x-navis-store-role': 'owner' },
    });
  });

  it('denies a different store and staff before contacting Insight', async () => {
    const { app, calls } = setup();
    for (const scope of [{ store_id: other }, { role: 'staff' }]) {
      const response = await app.inject({ method: 'POST', url: chat, payload: {}, headers: {
        authorization: `Bearer ${await token(scope)}`, 'x-navis-protocol': 'agent-v1',
      } });
      expect(response.statusCode).toBe(403);
    }
    expect(calls().every(call => new URL(call.url).hostname === 'account')).toBe(true);
  });
});
