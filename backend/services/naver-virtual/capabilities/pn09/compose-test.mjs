import assert from 'node:assert/strict';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { URLSearchParams } from 'node:url';
import { Pool } from 'pg';
import { createPersonaApp } from '../../app.ts';
import { migratePersona } from '../../migrate.ts';
import { createPersonaSeedContext, seedPersona } from '../../seed.ts';
import { createPersonaCallback } from '../../../../packages/naver/transport/index.ts';
import { aiCallFixtureDispatchOperation, aiCallFixtureDispatchPath } from '../../../../packages/naver/contracts/pn08/wire.ts';
import { personaCapability as pn01 } from '../pn01/index.ts';
import { personaCapability as pn02 } from '../pn02/index.ts';
import { personaCapability as pn08 } from '../pn08/index.ts';
import { personaCapability as pn12 } from '../pn12/index.ts';
import { personaCapability as pn09 } from './index.ts';

const capabilities = [pn01, pn02, pn08, pn09, pn12];
const seed = createPersonaSeedContext();
const accountId = seed.accountId;
const token = createHash('sha256').update('pn-p1-compose-private-test-only').digest('hex');
const readToken = createHash('sha256').update('pn-p1-compose-read-test-only').digest('hex');
const operations = [
  'pn01.place.read', 'pn01.place.update', 'pn01.menu.read', 'pn01.menu.update', 'pn01.hours.read', 'pn01.hours.update',
  'pn02.bookings.list', 'pn02.bookings.read', 'pn02.bookings.change', 'pn02.bookings.confirm', 'pn02.bookings.cancel',
  'pn02.booking-products.list', 'pn02.orders.list', 'pn02.orders.read',
  'pn02.orders.prepare', 'pn02.orders.pickup', 'pn08.smartcall.settings', 'pn08.smartcall.calls', 'pn12.place',
  aiCallFixtureDispatchOperation, 'pn09.financial-center.list', 'pn09.financial-center.read', 'pn09.pay.approve', 'pn09.pay.cancel', 'pn09.pay.settlement',
];
const payCredentials = { clientId: 'compose-synthetic-client', clientSecret: 'compose-synthetic-credential', chainId: 'compose-synthetic-chain' };
const payHeaders = { 'x-naver-client-id': payCredentials.clientId, 'x-naver-client-secret': payCredentials.clientSecret, 'x-naverpay-chain-id': payCredentials.chainId };
const callbackToken = createHash('sha256').update('pn-p1-synthetic-aicall-callback').digest('hex');
const callbackPath = '/internal/naver-virtual/aicall/custom-condition/v2';
const connect = user => new Pool({ user, database: 'naver_virtual', host: 'db', connectionTimeoutMillis: 2000 });
const partnerPath = '/partner-assumed/v1';
const merchantPath = '/naverpay-partner/naverpay/payments';
const settlementPath = '/naverpaysettle-payment/naverpaysettle/v1/settlements/by-case';

async function serve() {
  const admin = connect('postgres');
  try {
    await admin.query(`
      DO $test$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='nvirtual_mig') THEN CREATE ROLE nvirtual_mig LOGIN; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='nvirtual_run') THEN CREATE ROLE nvirtual_run LOGIN; END IF;
      END $test$;
      CREATE SCHEMA IF NOT EXISTS naver_virtual AUTHORIZATION nvirtual_mig;
      GRANT USAGE ON SCHEMA naver_virtual TO nvirtual_run;
    `);
  } finally {
    await admin.end();
  }
  const migration = connect('nvirtual_mig');
  try {
    await migratePersona(migration, capabilities);
    await seedPersona(migration, capabilities, seed);
  } finally {
    await migration.end();
  }
  const pool = connect('nvirtual_run');
  const grants = [
    { workload: 'fixture-probe', token, accountId, operations, providerCredentials: {
      ...Object.fromEntries(operations.filter(operation => operation.startsWith('pn09.pay.')).map(operation => [operation, payCredentials])),
      [aiCallFixtureDispatchOperation]: { aicallCallbackToken: callbackToken },
    } },
    { workload: 'fixture-read', token: readToken, accountId, operations: ['pn01.place.read'] },
  ];
  const app = createPersonaApp({ pool, grants, capabilities, now: () => seed.now,
    callback: createPersonaCallback({ aicall: 'http://customer:3000' + callbackPath }),
  });
  await app.listen({ host: '0.0.0.0', port: 3000 });
}

function serveCustomerFixture() {
  let deliveries = 0;
  createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, callbackPath);
      assert.equal(request.headers.authorization, 'Bearer ' + callbackToken);
      assert.equal(++deliveries, 1);
      assert.match(request.headers['content-type'], /^application\/json/);
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      fields(body, ['userId', 'userKey', 'userVariables']);
      fields(body.userVariables, ['예약날짜_completed', '예약시간_completed', '예약인원_completed', '전화번호_completed']);
      for (const variable of Object.values(body.userVariables)) fields(variable, ['value', 'typ']);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ valid: 'reservationFailed' }));
    } catch {
      response.writeHead(400).end();
    }
  }).listen(3000, '0.0.0.0');
}

function fields(value, keys) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

async function request(path, status = 200, options = {}) {
  const response = await fetch('http://persona:3000' + path, {
    ...options, headers: { 'x-navis-naver-virtual-account': accountId, 'x-navis-naver-virtual-token': token, ...options.headers },
  });
  const raw = await response.text();
  assert.equal(response.status, status, path + ' ' + raw);
  return { body: raw && JSON.parse(raw), headers: response.headers };
}

function ownerWrite(method, key, payload) {
  return { method, headers: { 'idempotency-key': key, 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

function payWrite(key, body) {
  return { method: 'POST', headers: { ...payHeaders, 'x-naverpay-idempotency-key': key, 'content-type': 'application/x-www-form-urlencoded' }, body };
}

async function ready() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fetch('http://persona:3000/readyz', { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      // The service or the private name may be unavailable during startup.
    }
    await setTimeout(500);
  }
  throw new Error('Persona fixture did not become ready');
}

async function verify() {
  await ready();
  const venue = (await request(partnerPath + '/place')).body;
  fields(venue, ['name', 'address', 'keywords', 'phone', 'photos']);
  assert.equal(venue.name, '안숭잘부 카페');
  assert.equal((await request(partnerPath + '/place', 403, { headers: { 'x-navis-naver-virtual-account': 'other-cafe' } })).body, '');
  await request(partnerPath + '/bookings', 403, { headers: { 'x-navis-naver-virtual-token': readToken } });
  const runtime = connect('nvirtual_run');
  try {
    assert.equal((await runtime.query('SELECT account_id FROM naver_virtual.pn01_place')).rowCount, 0);
    await assert.rejects(runtime.query('DELETE FROM naver_virtual.pn01_place'), { code: '42501' });
  } finally {
    await runtime.end();
  }

  await request(partnerPath + '/place', 400, ownerWrite('PATCH', 'invalid-venue', { searchVisible: true }));
  const editedVenue = (await request(partnerPath + '/place', 200, ownerWrite('PATCH', 'venue', { keywords: ['원두', '카페'] }))).body;
  assert.deepEqual(editedVenue, { ...venue, keywords: ['원두', '카페'] });
  const menu = (await request(partnerPath + '/place/menu')).body;
  menu.forEach(row => fields(row, ['name', 'price']));
  const editMenu = ownerWrite('PATCH', 'menu', { price: 4400 });
  const menuPath = partnerPath + '/place/menu?name=' + encodeURIComponent('카페라떼');
  const editedMenu = (await request(menuPath, 200, editMenu)).body;
  assert.equal(editedMenu.find(item => item.name === '카페라떼').price, 4400);
  assert.deepEqual((await request(menuPath, 200, editMenu)).body, editedMenu);
  assert.equal((await request(menuPath, 409, ownerWrite('PATCH', 'menu', { price: 4900 }))).body.code, 'IDEMPOTENCY_CONFLICT');
  const hours = (await request(partnerPath + '/place/hours')).body;
  fields(hours, ['businessHours', 'holidayHours']);
  hours.businessHours.forEach(entry => fields(entry, ['day', 'open', 'close']));
  const holiday = { date: '2026-11-18', closed: true };
  const editedHours = (await request(partnerPath + '/place/hours', 200, ownerWrite('PATCH', 'hours', { holidayHours: [holiday] }))).body;
  assert.deepEqual(editedHours, { ...hours, holidayHours: [holiday] });

  const bookings = (await request(partnerPath + '/bookings')).body;
  const booking = bookings.find(item => item.bookingNumber === 'booking-01');
  fields(booking, ['bookingNumber', 'product', 'usageAt', 'maskedName', 'maskedPhone', 'status', 'npayLinked']);
  assert.match(booking.maskedPhone, /^010-\*{4}-0001$/);
  assert.equal((await request(partnerPath + '/bookings?name=' + encodeURIComponent('카페손님1'))).body.length, 1);
  assert.equal((await request(partnerPath + '/bookings?phone=01000000001')).body.length, 1);
  assert.equal((await request(partnerPath + '/bookings?date=2026-11-18')).body.length, 3);
  await request(aiCallFixtureDispatchPath, 403, { method: 'POST', headers: { 'x-navis-naver-virtual-token': readToken } });
  await request(aiCallFixtureDispatchPath, 204, { method: 'POST' });
  await request(aiCallFixtureDispatchPath, 204, { method: 'POST' });
  assert.deepEqual((await request(partnerPath + '/bookings')).body, bookings);
  const b = partnerPath + '/bookings/';
  const shift = { usageAt: '2026-11-19T15:30:00+09:00' };
  assert.equal((await request(b + 'booking-02', 409, ownerWrite('PATCH', 'npay-edit', shift))).body.code, 'CONFLICT');
  assert.equal((await request(b + 'booking-01', 200, ownerWrite('PATCH', 'pending-edit', shift))).body.usageAt, shift.usageAt);
  assert.equal((await request(b + 'booking-03', 200, ownerWrite('PATCH', 'edit', shift))).body.usageAt, shift.usageAt);
  const confirmation = ownerWrite('POST', 'booking-confirm', {});
  assert.equal((await request(b + 'booking-01/confirm', 200, confirmation)).body.status, 'confirmed');
  assert.equal((await request(b + 'booking-01/confirm', 200, confirmation)).body.status, 'confirmed');
  await request(b + 'booking-01/confirm', 409, ownerWrite('POST', 'booking-confirm-next', {}));
  const cancelReason = '매장 사정으로 예약을 취소합니다.';
  await request(b + 'booking-04/cancel', 409, ownerWrite('POST', 'completed-cancel', { cancelReason }));
  await request(b + 'booking-02/cancel', 400, ownerWrite('POST', 'missing-reason', {}));
  await request(b + 'booking-02/cancel', 400, ownerWrite('POST', 'missing-refund', { cancelReason }));
  assert.equal((await request(b + 'booking-02')).body.paymentAmount, 4500);
  await request(b + 'booking-02/cancel', 400, ownerWrite('POST', 'over-payment',
    { cancelReason, refund: { type: 'amount', value: 4501 } }));
  const report = (await request(partnerPath + '/reports/place?unit=week')).body;
  const reportCalls = (await request(partnerPath + '/smartcall/calls?' + new URLSearchParams(report.period))).body;
  const callCount = reportCalls.daily.reduce((sum, day) => sum + day.totalCalls, 0);
  assert.equal(report.cards.find(card => card.metric === 'smartCallCalls').value, callCount);
  assert.ok(callCount > 0);
  const paidCancel = ownerWrite('POST', 'paid-cancel', { cancelReason, refund: { type: 'amount', value: 4500 } });
  const cancelledPaidBooking = await request(b + 'booking-02/cancel', 200, paidCancel);
  assert.equal(cancelledPaidBooking.body.status, 'cancelled');
  assert.deepEqual((await request(b + 'booking-02/cancel', 200, paidCancel)).body, cancelledPaidBooking.body);
  await request(b + 'booking-02/cancel', 409, ownerWrite('POST', 'paid-cancel', { cancelReason, refund: { type: 'full' } }));
  await request(b + 'booking-02/cancel', 409, ownerWrite('POST', 'new-paid-cancel-key', { cancelReason, refund: { type: 'full' } }));
  await request(b + 'booking-03/cancel', 400, ownerWrite('POST', 'unexpected-refund', { cancelReason, refund: { type: 'full' } }));
  const cancelled = (await request(b + 'booking-03/cancel', 200, ownerWrite('POST', 'cancel-booking', { cancelReason }))).body;
  fields(cancelled, ['bookingNumber', 'product', 'usageAt', 'status', 'npayLinked']);
  assert.equal(cancelled.status, 'cancelled');
  await request(b + 'booking-04/payment-request', 404, ownerWrite('POST', 'after-use', {}));
  assert.deepEqual((await request(b + 'booking-04')).body, bookings.find(row => row.bookingNumber === 'booking-04'));
  const [product] = (await request(partnerPath + '/booking-products')).body;
  fields(product, ['name']);

  const orderPath = partnerPath + '/orders/order-01';
  (await request(partnerPath + '/orders')).body.forEach(row => fields(row, ['orderNumber', 'status', 'preparationMinutes']));
  await request(orderPath + '/pickup', 409, ownerWrite('POST', 'early-pickup', {}));
  assert.deepEqual((await request(orderPath + '/prepare', 200, ownerWrite('POST', 'prepare', { preparationMinutes: 5 }))).body,
    { orderNumber: 'order-01', status: 'preparing', preparationMinutes: 5 });
  await request(orderPath + '/pickup', 200, ownerWrite('POST', 'pickup', {}));
  await request(orderPath + '/prepare', 409, ownerWrite('POST', 'restart-prep', { preparationMinutes: 8 }));
  assert.deepEqual((await request(orderPath)).body, { orderNumber: 'order-01', status: 'picked-up', preparationMinutes: 5 });

  fields((await request(partnerPath + '/smartcall/settings')).body, ['number050']);
  for (const invalidPath of ['/smartcall/settings?extra=1', '/smartcall/calls',
    '/financial-center/recommendations?extra=1']) {
    assert.deepEqual((await request(partnerPath + invalidPath, 400)).body, { code: 'INVALID_REQUEST' });
  }
  const calls = (await request(partnerPath + '/smartcall/calls?startDate=2026-11-17&endDate=2026-11-17')).body;
  fields(calls, ['period', 'channels', 'daily']);
  assert.deepEqual(calls.period, { startDate: '2026-11-17', endDate: '2026-11-17' });
  assert.deepEqual(calls.daily, [{ date: '2026-11-17', totalCalls: 3, connectedCalls: 1, arsCalls: 1,
    missedCalls: 1, busyCalls: 0, averageDurationSeconds: 42, callsAtLeastTenSeconds: 1 }]);
  const recommendations = await request(partnerPath + '/financial-center/recommendations');
  fields(recommendations.body[0], ['title', 'startDate', 'endDate', 'status', 'officialNoticeUrl']);
  const link = recommendations.headers.get('link').match(/^<([^>]+)>; rel="item"$/)[1];
  const detail = (await request(link)).body;
  fields(detail, ['title', 'startDate', 'endDate', 'status', 'officialNoticeUrl', 'overview', 'eligibility', 'applicationMethod', 'documents']);
  assert.equal(detail.endDate, '2026-10-08');

  const approvalPath = merchantPath + '/v2.2/apply/payment';
  await request(approvalPath, 401, { ...payWrite('invalid-auth', 'paymentId=PN09BOOKED01'), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  await request(approvalPath, 400, payWrite('bad-approval', 'paymentId=PN09BOOKED01&totalPayAmount=1'));
  const cancellationPath = merchantPath + '/v1/cancel';
  const cancelForm = (amount, rest) => new URLSearchParams({ paymentId: 'PN09BOOKED01', cancelAmount: amount,
    cancelReason: '요청 취소', cancelRequester: 2, taxScopeAmount: amount, taxExScopeAmount: 0, doCompareRest: 1, expectedRestAmount: rest }).toString();
  const incompleteForm = await request(cancellationPath, 400, payWrite('cancel-incomplete', cancelForm(500, 3300).replace('&taxExScopeAmount=0', '')));
  assert.equal(incompleteForm.body.code, 'RequireParameter');
  await request(cancellationPath, 404, payWrite('cancel-before-approval', cancelForm(500, 3300)));
  const approval = await request(approvalPath, 200, payWrite('approve', 'paymentId=PN09BOOKED01'));
  fields(approval.body, ['code', 'message', 'body']);
  assert.equal(approval.body.code, 'Success');
  assert.equal(approval.headers.get('x-naverpay-idempotency-key'), 'approve');
  fields(approval.body.body, ['paymentId', 'detail']);
  const d = approval.body.body.detail;
  fields(d, ['paymentId', 'payHistId', 'merchantName', 'merchantId', 'merchantPayKey', 'merchantUserKey', 'admissionTypeCode',
    'admissionYmdt', 'tradeConfirmYmdt', 'admissionState', 'totalPayAmount', 'applyPayAmount', 'primaryPayAmount', 'npointPayAmount',
    'giftCardAmount', 'discountPayAmount', 'taxScopeAmount', 'taxExScopeAmount', 'environmentDepositAmount', 'primaryPayMeans',
    'cardCorpCode', 'cardNo', 'cardAuthNo', 'cardInstCount', 'usedCardPoint', 'bankCorpCode', 'bankAccountNo', 'productName',
    'settleExpected', 'settleExpectAmount', 'payCommissionAmount', 'merchantPayTransactionKey', 'userIdentifier',
    'extraDeduction', 'useCfmYmdt']);
  assert.deepEqual([d.admissionYmdt, d.totalPayAmount, d.settleExpected, d.settleExpectAmount, d.payCommissionAmount],
    ['20261117154500', 3800, false, 0, 0]);
  assert.equal(d.useCfmYmdt, '20261117');
  assert.deepEqual((await request(approvalPath, 409, payWrite('approve', 'paymentId=PN09BOOKED01'))).body, approval.body);
  const lookup = { headers: payHeaders };
  const newlyApproved = (await request(settlementPath + '/payment-id/PN09BOOKED01', 200, lookup)).body;
  assert.deepEqual(newlyApproved.body, { totalCount: 0, totalPageCount: 0, currentPage: 1, responseCount: 0, list: [] });
  const settled = (await request(settlementPath + '/payment-id/PN09SETTLED01', 200, lookup)).body;
  fields(settled.body, ['list', 'totalCount', 'totalPageCount', 'responseCount', 'currentPage']);
  const [settlement, settledCancel] = settled.body.list;
  fields(settlement, ['payDate', 'settleBasisDate', 'settleExpectDate', 'settleCompleteDate', 'paymentId', 'payHistId',
    'settleType', 'merchantPayKey', 'productName', 'paySettleAmount', 'totalCommissionAmount', 'totalPayCommissionAmount', 'settleExpectAmount']);
  assert.equal(settlement.settleExpectAmount, 2910);
  assert.equal(settlement.settleType, '정산');
  assert.equal(settledCancel.settleType, '정산 후 취소');
  assert.equal(settledCancel.settleExpectAmount, -485);
  assert.deepEqual((await request(settlementPath + '/pay-hist-id/' + settlement.payHistId, 200, lookup)).body.body.list, [settlement]);
  assert.deepEqual((await request(settlementPath + '/pay-hist-id/' + settledCancel.payHistId, 200, lookup)).body.body.list, [settledCancel]);
  assert.deepEqual((await request(settlementPath + '/payment-id/PN09SETTLED01?pageNumber=2', 200, lookup)).body.body,
    { list: [], currentPage: 2, responseCount: 0 });

  const otherOperation = await request(cancellationPath, 200, payWrite('approve', cancelForm(100, 100)));
  assert.equal(otherOperation.body.code, 'RestAmountDiff');
  const partialCancel = await request(cancellationPath, 200, payWrite('partial-cancel', cancelForm(500, 3300)));
  assert.equal(partialCancel.body.code, 'Success');
  fields(partialCancel.body.body, ['paymentId', 'payHistId', 'primaryPayMeans', 'primaryPayCancelAmount', 'primaryPayRestAmount',
    'npointCancelAmount', 'npointRestAmount', 'giftCardCancelAmount', 'giftCardRestAmount', 'discountCancelAmount', 'discountRestAmount',
    'taxScopeAmount', 'taxExScopeAmount', 'taxScopeRestAmount', 'taxExScopeRestAmount', 'environmentDepositAmount',
    'environmentDepositRestAmount', 'cancelYmdt', 'totalRestAmount', 'applyRestAmount']);
  assert.equal(partialCancel.body.body.totalRestAmount, 3300);
  assert.deepEqual((await request(cancellationPath, 409, payWrite('partial-cancel', cancelForm(500, 3300)))).body, partialCancel.body);
  assert.equal((await request(cancellationPath, 200, payWrite('stale-rest', cancelForm(100, 3700)))).body.code, 'RestAmountDiff');
  assert.equal((await request(cancellationPath, 200, payWrite('final-cancel', cancelForm(3300, 0)))).body.body.totalRestAmount, 0);
  assert.equal((await request(cancellationPath, 200, payWrite('after-full-cancel', cancelForm(1, 0)))).body.code, 'AlreadyCanceled');
  console.log('PN-P1 Compose schema and state checks passed');
}

async function verifyRestart() {
  await ready();
  assert.deepEqual((await request(partnerPath + '/place')).body.keywords, ['원두', '카페']);
  assert.equal((await request(partnerPath + '/bookings/booking-01')).body.status, 'confirmed');
  assert.equal((await request(partnerPath + '/orders/order-01')).body.status, 'picked-up');
  assert.equal((await request(merchantPath + '/v2.2/apply/payment', 409, payWrite('approve', 'paymentId=PN09BOOKED01'))).body.code, 'Success');
  console.log('PN-P1 provider restart and same-generation persistence passed');
}

async function verifyReseed() {
  await ready();
  // 01:10 KST is inside the previous café business day.
  const hosted = createPersonaSeedContext(new Date('2026-11-21T16:10:00Z'));
  assert.equal(hosted.cafe.end, '2026-11-22');
  assert.equal(hosted.cafe.businessDate, '2026-11-21');
  const migration = connect('nvirtual_mig');
  try {
    await seedPersona(migration, capabilities, hosted);
    assert.deepEqual((await request(partnerPath + '/place')).body.keywords, ['카페', '커피', '소금빵']);
    const booking = (await request(partnerPath + '/bookings/booking-01')).body;
    assert.equal(booking.usageAt, '2026-11-22T12:00:00+09:00');
    assert.equal(booking.status, 'requested');
    const calls = (await request(partnerPath + '/smartcall/calls?startDate=2026-11-22&endDate=2026-11-22')).body;
    assert.equal(calls.daily[0].totalCalls, 1);
    await migration.query("DELETE FROM naver_virtual.seed_revision WHERE account_id=$1 AND capability='pn02'", [accountId]);
    await request('/readyz', 503);
  } finally {
    await migration.end();
  }
  console.log('PN-P1 hosted generation dates and incomplete-seed readiness passed');
}

switch (process.argv[2]) {
  case 'serve': await serve(); break;
  case 'customer': serveCustomerFixture(); break;
  case 'verify': await verify(); break;
  case 'restart': await verifyRestart(); break;
  case 'reseed': await verifyReseed(); break;
  default: throw new Error('Unknown proof command');
}
