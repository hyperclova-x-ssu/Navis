import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readSecret } from '../../packages/db/index.ts';

const origin = 'http://naver-virtual:3000';
const booking = '/partner-assumed/v1/bookings/booking-01';
const customer = readSecret('/run/secrets/nvirtual_customer_token');
const pos = readSecret('/run/secrets/nvirtual_pos_token');

async function request(path, status, { token, account = 'ansungjalbu-cafe', key } = {}) {
  const response = await fetch(origin + path, {
    method: key ? 'POST' : 'GET',
    redirect: 'error', signal: AbortSignal.timeout(3000),
    headers: {
      ...(token && { 'x-navis-naver-virtual-account': account, 'x-navis-naver-virtual-token': token }),
      ...(key && { 'idempotency-key': key, 'content-type': 'application/json' }),
    },
    ...(key && { body: '{}' }),
  });
  assert.equal(response.status, status, `${path} status`);
  if (status === 200) return response.json();
  await response.body?.cancel();
}

assert.equal((await request('/readyz', 200)).status, 'ready');
assert.equal((await request('/healthz', 200)).status, 'ok');
if (process.argv.includes('--persisted')) {
  assert.equal((await request(booking, 200, { token: customer })).status, 'confirmed');
  console.info('PASS Persona kept the confirmed booking across seed retry and process restart');
} else {
  assert.equal((await request(booking, 200, { token: customer })).status, 'requested');
  await request(booking, 401);
  await request(booking, 403, { token: customer, account: 'other-cafe' });
  await request(booking, 403, { token: pos });
  const key = randomUUID();
  const confirmed = await request(`${booking}/confirm`, 200, { token: customer, key });
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(await request(`${booking}/confirm`, 200, { token: customer, key }), confirmed);
  console.info('PASS private Persona booking read, wrong account and workload denial, and same-key confirmation');
}
