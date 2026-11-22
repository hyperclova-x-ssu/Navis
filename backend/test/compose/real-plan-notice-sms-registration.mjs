import assert from 'node:assert/strict';
import { createCustomerApp } from '../../services/customer/app.ts';
import { createMarketingApp } from '../../services/marketing/app.ts';

const store = 'c05409a6-f082-5964-a787-c1ed3184988b';
const gatewayToken = 'synthetic-gateway';
const recipientToken = 'synthetic-recipient-reader';
const workerToken = 'synthetic-notice-worker';
const recipientUrl = `/internal/v1/customer/stores/${store}/sms-recipients`;
const workerUrl = `/internal/v1/marketing/notice-sms-dispatch/stores/${store}`;
const pool = { query() { throw new Error('Request reached the database before validation'); } };
const customer = createCustomerApp(pool, { gatewayToken, privateToken: 'synthetic-pos', pos: {}, smsRecipientToken: recipientToken });
const marketing = createMarketingApp(pool, undefined, undefined, {
  readToken: gatewayToken, notice: { smsWorkerToken: workerToken },
});
try {
  const request = (authorization, scope = store) => ({
    method: 'POST', url: recipientUrl, headers: { authorization: `Bearer ${authorization}`, 'x-navis-store-id': scope }, payload: {},
  });
  assert.equal((await customer.inject(request(gatewayToken))).statusCode, 401);
  assert.equal((await customer.inject(request('synthetic-pos'))).statusCode, 401);
  assert.equal((await customer.inject(request(recipientToken, crypto.randomUUID()))).statusCode, 403);
  assert.equal((await customer.inject(request(recipientToken))).statusCode, 400);
  assert.equal((await marketing.inject({ url: workerUrl, headers: { authorization: `Bearer ${gatewayToken}` } })).statusCode, 401);
  assert.throws(() => createCustomerApp(pool, { gatewayToken, pos: {}, smsRecipientToken: gatewayToken }), /distinct/);
  assert.throws(() => createMarketingApp(pool, undefined, undefined, {
    readToken: gatewayToken, notice: { smsWorkerToken: gatewayToken },
  }), /distinct/);
  console.info('PASS Customer recipient and Marketing dispatch route registrations enforce distinct workload credentials');
} finally {
  await Promise.all([customer.close(), marketing.close()]);
}
