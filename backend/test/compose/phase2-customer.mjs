import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const { AbortSignal, fetch } = globalThis;
const backend = new URL('../../', import.meta.url);
const day = '2026-11-17';
const now = new Date(`${day}T06:45:00Z`);
const backendChecks = process.argv[2] === '--backend-checks';

// Separate disposable containers and networks let other Phase ② suites run concurrently.
const isolated = `
services:
  customer-check-db:
    extends: {file: compose.yaml, service: streams-test-db}
    networks: !override {customer-check-data: {aliases: [test-db]}}
  customer-check-redis:
    extends: {file: compose.yaml, service: streams-test-redis}
    networks: !override [customer-check-cache]
    ${backendChecks ? 'command: ["redis-server", "--save", "", "--appendonly", "no"]' : ''}
  customer-check-tools:
    extends: {file: compose.yaml, service: streams-tools}
    networks: !override [customer-check-data, customer-check-cache]
    environment:
      NAVIS_DB_HOST: customer-check-db
      NAVIS_REDIS_URL: redis://customer-check-redis:6379
    secrets:
      - {source: customer_check_migrate, target: customer_mig_password}
    volumes:
      - ./.secrets/test/db:/run/navis-test-db:ro
      - ./services:/app/backend/services:ro
      - ./packages:/app/backend/packages:ro
      - ./test:/app/backend/test:ro
      - ./gateway:/app/backend/gateway:ro
      - ../server:/app/server:ro
      - ../shared:/app/shared:ro
networks:
  customer-check-data: {internal: true}
  customer-check-cache: {internal: true}
secrets:
  customer_check_migrate: {file: ./.secrets/test/db/customer_mig_password}
`;

function compose(...args) {
  execFileSync('docker', [
    'compose', '--env-file', '/dev/null', '-p', 'navis-backend-local',
    '-f', 'compose.yaml', '-f', '-', ...args,
  ], {
    cwd: backend, input: isolated, stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, COMPOSE_IGNORE_ORPHANS: 'true' },
  });
}

if (process.argv[2] === '--inside') {
  await acceptance();
} else {
  const [, , mode] = process.argv;
  assert.ok(!mode || mode === '--backend-checks', 'Expected --backend-checks or no arguments');
  try {
    compose('up', '-d', '--no-deps', '--pull', 'never', '--wait', 'customer-check-db', 'customer-check-redis');
    compose('run', '--rm', '--no-deps', '--pull', 'never', 'customer-check-tools', 'npm', 'run', 'migrate', '--', 'pos');
    compose('run', '--rm', '--no-deps', '--pull', 'never', 'customer-check-tools', 'npm', 'run', 'migrate', '--', 'customer');
    compose('exec', '-T', 'customer-check-db', '/docker-entrypoint-initdb.d/20-stream-access.sh');
    if (backendChecks) {
      compose('run', '--rm', '--no-deps', '--pull', 'never',
        '-e', 'NAVIS_INSIGHT_TEST_REDIS_URL=redis://customer-check-redis:6379', 'customer-check-tools',
        'sh', '-ec', 'npm run typecheck && npm test');
    } else {
      compose('run', '--rm', '--no-deps', '--pull', 'never', 'customer-check-tools',
        'node', 'test/compose/phase2-customer.mjs', '--inside');
    }
  } finally {
    compose('rm', '-sf', 'customer-check-db', 'customer-check-redis');
  }
}

async function acceptance() {
  const { dbPool } = await import('../../packages/db/index.ts');
  const { runMigrations } = await import('../../packages/db/migrate.ts');
  const { connectStreams } = await import('../../packages/streams/index.ts');
  const { OutboxRelay, relayDbPool } = await import('../../packages/streams/relay.ts');
  const { createCustomerApp } = await import('../../services/customer/app.ts');
  const { createPosClient } = await import('../../services/customer/pos-client.ts');
  const { createCustomerConsumer } = await import('../../services/customer/consumer.ts');
  const { createPosApp } = await import('../../services/pos/app.ts');

  const migrations = fileURLToPath(new URL('../../services/customer/migrations/', import.meta.url));
  await runMigrations('customer', migrations);
  await runMigrations('customer', migrations, 'local', 'down');
  await runMigrations('customer', migrations);

  const pos = dbPool('pos');
  const setupPos = dbPool('pos', 'migrate');
  const customer = dbPool('customer');
  const setupCustomer = dbPool('customer', 'migrate');
  const relayPos = relayDbPool('pos');
  const relayCustomer = relayDbPool('customer');
  const relayInventory = relayDbPool('inventory');
  const relayRedis = await connectStreams('relay');
  const customerRedis = await connectStreams('customer');
  const [posOwner, customerOwner, posWorkload] = Array.from({ length: 3 }, () => randomBytes(32).toString('hex'));
  const actor = randomUUID();
  const store = randomUUID();
  const otherStore = randomUUID();
  const menu = randomUUID();
  let approve = true;
  let fault;
  let passed = 0;
  const posApp = createPosApp(pos, { gatewayToken: posOwner, customerToken: posWorkload, now: () => now,
    approve: () => approve, logging: false });
  const posUrl = await posApp.listen({ host: '127.0.0.1', port: 0 });
  const posClient = createPosClient(posUrl, posWorkload, async (url, init) => {
    if (fault === 'pos-down') throw new Error('Synthetic POS outage');
    const response = await fetch(url, init);
    if (fault === 'link-response-lost' && url.endsWith('/claims')) {
      await response.body.cancel();
      fault = undefined;
      throw new Error('Synthetic lost link response');
    }
    return response;
  });
  const customerApp = createCustomerApp(customer, { gatewayToken: customerOwner, pos: posClient,
    now: () => now, logging: false });
  const customerUrl = await customerApp.listen({ host: '127.0.0.1', port: 0 });
  const relay = new OutboxRelay({ producer: 'pos', database: relayPos, redis: relayRedis,
    groups: [{ name: 'inventory', database: relayInventory }, { name: 'customer', database: relayCustomer }] });
  const consumer = createCustomerConsumer(customer, customerRedis, 'customer-check', { reclaimIdleMs: 0 });

  async function scenario(name, fn) {
    await fn();
    process.stdout.write(`ok ${++passed} - ${name}\n`);
  }

  async function request(service, path, body, { key = randomUUID(), scope = store, loseResponse = false, ...extra } = {}) {
    const isPos = service === 'pos';
    const base = isPos ? posUrl : customerUrl;
    const result = await fetch(`${base}/internal/v1/${service}/stores/${scope}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${isPos ? posOwner : customerOwner}`, 'x-navis-store-id': scope,
        'x-navis-store-role': 'owner', 'x-navis-user-id': actor, 'idempotency-key': key,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (loseResponse) {
      assert.equal(result.status, 200);
      await result.body.cancel();
      throw new Error('Synthetic lost completion response');
    }
    return { status: result.status, body: await result.json() };
  }

  const bookingPath = (id) => `/reservations/${id}/first-order-claim`;
  const cancelPath = (id) => `/reservations/${id}/cancel`;
  const memberPath = (id) => `/memberships/${id}/use-claim`;
  const claimPath = (id) => `/claims/${id}`;
  const version = { sourceVersion: 1 };

  async function booking({ archived = false } = {}) {
    const id = randomUUID();
    await scoped(setupCustomer, store, db => db.query(
      'INSERT INTO customer.reservation (store_id, reservation_id, table_id, table_archived) VALUES ($1, $2, $3, $4)',
      [store, id, randomUUID(), archived],
    ));
    return id;
  }

  async function member() {
    const id = randomUUID();
    await scoped(setupCustomer, store, db => db.query(
      `INSERT INTO customer.membership (store_id, membership_id, starts_on, ends_on, uses_total, uses_left)
       VALUES ($1, $2, $3, $3, 1, 1)`, [store, id, day],
    ));
    return id;
  }

  async function value(dbPool, sql, params, scope = store) {
    return scoped(dbPool, scope, async db => (await db.query(sql, params)).rows[0]);
  }

  const reservation = id => value(customer, `
    SELECT status, version, first_order_id, first_bill_id FROM customer.reservation WHERE reservation_id = $1`, [id]);
  const uses = id => value(customer, 'SELECT uses_left FROM customer.membership WHERE membership_id = $1', [id]);

  async function begin(key, qty = 1) {
    const bill = await request('pos', '/bills', { type: 'dine_in', lines: [{ menuId: menu, qty }] });
    assert.equal(bill.status, 200);
    const started = await request('pos', '/approvals', {
      billId: bill.body.value.billId, quoteRevision: bill.body.value.quoteRevision,
      splits: [{ method: 'card', amount: 4500 * qty }],
    }, { key });
    return started;
  }

  async function finish(started, key, loseResponse = false) {
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const { attemptId, quoteFingerprint } = started.body.value;
    return request('pos', `/approvals/${attemptId}/finish`, { expectedQuoteFingerprint: quoteFingerprint }, { key, loseResponse });
  }

  async function returnOne(sale, kind = 'cancel') {
    const { paymentId } = sale.body.value;
    const original = await request('pos', `/payments/${paymentId}/receipt`);
    const [{ orderLineId }] = original.body.sourceSnapshot.lines;
    const quote = await request('pos', `/payments/${paymentId}/reversal-quote`, { kind, lines: [{ orderLineId, qty: 1 }] });
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.ok(quote.body.canSubmit, JSON.stringify(quote.body));
    const correction = await request('pos', '/corrections', { quoteToken: quote.body.quoteToken, confirmed: true });
    assert.equal(correction.status, 200, JSON.stringify(correction.body));
    return correction;
  }

  async function deliver(receiver = consumer) {
    for (let i = 0; i < 30; i++) {
      const published = await relay.step();
      const handled = await receiver.step();
      if (published === 'idle' && !handled) return;
    }
    assert.fail('Stream did not drain');
  }

  try {
    await scoped(setupPos, store, async db => {
      await db.query('INSERT INTO pos.store (store_id) VALUES ($1)', [store]);
      await db.query(`INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at)
        VALUES ($1, $2, '2026-11-16T20:00:00Z', '2026-11-17T20:00:00Z')`, [store, day]);
      await db.query('INSERT INTO pos.catalog_menu (store_id, menu_id, snapshot) VALUES ($1, $2, $3)', [store, menu, {
        name: 'Synthetic latte', basePrice: 4500, baseCost: 900, recipeVersion: 'fixture-v1', saleStatus: 'selling', groups: [],
      }]);
    });

    await scenario('rejects unauthenticated, cross-store, staff, stale and archived-table claims', async () => {
      const id = await booking();
      assert.equal((await request('customer', bookingPath(id), version, { authorization: 'Bearer wrong' })).status, 401);
      assert.equal((await request('customer', bookingPath(id), version, { 'x-navis-store-id': otherStore })).status, 403);
      assert.equal((await request('customer', bookingPath(id), version, { 'x-navis-store-role': 'staff' })).status, 403);
      assert.equal((await request('customer', bookingPath(id), version, { scope: otherStore })).status, 404);
      assert.equal((await request('customer', bookingPath(id), { sourceVersion: 2 })).status, 409);
      assert.equal((await request('customer', bookingPath(await booking({ archived: true })), version)).status, 409);
      const { rowCount } = await customer.query('SELECT 1 FROM customer.reservation');
      assert.equal(rowCount, 0);
      const { rows: [security] } = await customer.query(`
        SELECT count(*)::int AS tables, bool_and(relrowsecurity AND relforcerowsecurity) AS forced
        FROM pg_class WHERE oid IN ('customer.reservation'::regclass, 'customer.membership'::regclass,
          'customer.pos_claim'::regclass, 'customer.reservation_cancel_command'::regclass,
          'customer.membership_contribution'::regclass, 'customer.membership_correction'::regclass)
      `);
      assert.deepEqual(security, { tables: 6, forced: true });
      assert.equal(await value(customer, 'SELECT version FROM customer.reservation WHERE reservation_id = $1', [id],
        otherStore), undefined);
    });

    let firstClaim;
    let firstBooking;
    await scenario('two first-order contenders share one winner and retries keep the original claim', async () => {
      firstBooking = await booking();
      const keys = [randomUUID(), randomUUID()];
      const result = await Promise.all(keys.map(key => request('customer', bookingPath(firstBooking), version, { key })));
      assert.deepEqual(result.map(r => r.status).sort(), [202, 409]);
      const winner = result.findIndex(r => r.status === 202);
      firstClaim = result[winner].body;
      const retry = await request('customer', bookingPath(firstBooking), version, { key: keys[winner] });
      assert.deepEqual(retry.body, firstClaim);
      const conflict = await request('customer', bookingPath(await booking()), version, { key: keys[winner] });
      assert.equal(conflict.body.reason, 'IDEMPOTENCY_MISMATCH');
    });

    await scenario('booking cancellation and first-order acceptance cannot both succeed', async () => {
      const id = await booking();
      const [accept, cancel] = await Promise.all([
        request('customer', bookingPath(id), version), request('customer', cancelPath(id), version),
      ]);
      assert.ok((accept.status === 202 && cancel.status === 409) || (accept.status === 409 && cancel.status === 200));
      if (cancel.status === 200) {
        assert.equal((await reservation(id)).status, 'canceled');
      } else {
        assert.equal((await request('customer', claimPath(accept.body.claimId) + '/abort', {})).body.state, 'released');
        assert.equal((await request('customer', cancelPath(id), version)).status, 200);
      }
      assert.equal((await request('customer', bookingPath(id), version)).status, 409);
    });

    await scenario('POS outage and lost binding response hold the last use until a durable abort fences late approval',
      async () => {
        const id = await member();
        fault = 'pos-down';
        const reserved = await Promise.all([
          request('customer', memberPath(id), version), request('customer', memberPath(id), version),
        ]);
        assert.deepEqual(reserved.map(r => r.status).sort(), [202, 409]);
        const { claimId, commandKey, state } = reserved.find(r => r.status === 202).body;
        assert.equal(state, 'held');
        assert.equal(commandKey, undefined);
        assert.equal((await uses(id)).uses_left, 0);
        fault = 'link-response-lost';
        const lost = await request('customer', claimPath(claimId) + '/reconcile', {});
        assert.equal(lost.body.state, 'held');
        assert.equal(lost.body.commandKey, undefined);
        const reconciled = await request('customer', claimPath(claimId) + '/reconcile', {});
        assert.equal(reconciled.body.state, 'held');
        assert.equal(typeof reconciled.body.commandKey, 'string');
        const aborted = await request('customer', claimPath(claimId) + '/abort', {});
        assert.equal(aborted.body.state, 'released');
        assert.equal((await begin(reconciled.body.commandKey)).body.reason, 'COMMAND_ABORTED');
        assert.deepEqual((await request('customer', claimPath(claimId) + '/abort', {})).body, aborted.body);
        assert.equal((await uses(id)).uses_left, 1);
      });

    await scenario('a lost POS completion response reconciles the first order and survives event replay', async () => {
      const start = await begin(firstClaim.commandKey);
      await assert.rejects(finish(start, firstClaim.commandKey, true), /Synthetic lost completion response/);
      assert.equal((await reservation(firstBooking)).first_order_id, null);
      const outcome = await request('customer', claimPath(firstClaim.claimId) + '/reconcile', {});
      assert.equal(outcome.body.state, 'committed');
      const completed = await finish(start, firstClaim.commandKey);
      assert.equal(completed.status, 200, JSON.stringify(completed.body));
      const { orderIds, billId, settlementId } = completed.body.value;
      assert.equal(outcome.body.settlementId, settlementId);
      await deliver();
      assert.deepEqual(await reservation(firstBooking), {
        status: 'confirmed', version: 2, first_order_id: orderIds[0], first_bill_id: billId,
      });
      assert.equal((await request('customer', cancelPath(firstBooking), { sourceVersion: 2 })).status, 409);
      assert.equal((await request('customer', claimPath(firstClaim.claimId) + '/abort', {})).body.state, 'committed');
    });

    await scenario('a durable POS rejection releases the held use exactly once', async () => {
      const id = await member();
      const { body: claim } = await request('customer', memberPath(id), version);
      const started = await begin(claim.commandKey);
      approve = false;
      const declined = await finish(started, claim.commandKey);
      approve = true;
      assert.equal(declined.body.reason, 'APPROVAL_FAILED');
      assert.equal((await uses(id)).uses_left, 0);
      for (let retry = 0; retry < 2; retry++) {
        assert.equal((await request('customer', claimPath(claim.claimId) + '/reconcile', {})).body.state, 'released');
        assert.equal((await uses(id)).uses_left, 1);
      }
    });

    let restoredMembership;
    let restoringCorrection;
    await scenario('partial reversal retains the use and reclaim after commit restores it exactly once', async () => {
      const id = await member();
      const { body: claim } = await request('customer', memberPath(id), version);
      const sale = await finish(await begin(claim.commandKey, 2), claim.commandKey);
      assert.equal(sale.status, 200, JSON.stringify(sale.body));
      await deliver();
      assert.equal((await request('customer', claimPath(claim.claimId))).body.state, 'committed');
      await returnOne(sale);
      await deliver();
      assert.equal((await uses(id)).uses_left, 0);

      const correction = await returnOne(sale);
      const { correctionId } = correction.body.value;
      const crashed = createCustomerConsumer(customer, customerRedis, 'customer-before-ack', {
        reclaimIdleMs: 0,
        afterCommit(event) {
          if (event.payload.correctionId === correctionId) throw new Error('Synthetic pre-ACK crash');
        },
      });
      await assert.rejects(deliver(crashed), /Synthetic pre-ACK crash/);
      assert.ok(await customerRedis.pending('pos', 'customer'));
      const checkpoint = await checkpointForCorrection(customer, store, correctionId);
      assert.equal(checkpoint.status, 'applied');
      assert.equal(checkpoint.last_seq, checkpoint.store_seq);
      assert.equal((await uses(id)).uses_left, 1);
      await deliver();
      assert.equal(await customerRedis.pending('pos', 'customer'), 0);
      assert.equal((await uses(id)).uses_left, 1);
      assert.equal((await request('customer', claimPath(claim.claimId) + '/reconcile', {})).body.state, 'restored');
      restoredMembership = id;
      restoringCorrection = correctionId;
    });

    await scenario('a prepared-goods refund keeps its use and consumption checkpoint', async () => {
      const id = await member();
      const { body: claim } = await request('customer', memberPath(id), version);
      const sale = await finish(await begin(claim.commandKey), claim.commandKey);
      assert.equal(sale.status, 200, JSON.stringify(sale.body));
      await deliver();
      const prep = await request('pos', `/orders/${sale.body.value.orderIds[0]}/preparation`, { status: 'preparing' });
      assert.equal(prep.status, 200);
      const correction = await returnOne(sale, 'refund');
      await deliver();
      assert.equal((await checkpointForCorrection(customer, store, correction.body.value.correctionId)).status, 'applied');
      assert.equal((await uses(id)).uses_left, 0);
    });

    await scenario('a repeated correction with a new delivery identity has one business effect', async () => {
      const history = await relayRedis.events('pos');
      const original = history.find(event => event.aggregateId === restoringCorrection);
      assert.ok(original);
      const duplicate = { ...original, eventId: randomUUID(), storeSeq: String(BigInt(history.at(-1).storeSeq) + 1n) };
      const epoch = await relayRedis.readyEpoch('pos');
      assert.equal(await relayRedis.append('pos', epoch, duplicate), true);
      await deliver();
      assert.equal((await uses(restoredMembership)).uses_left, 1);
      assert.equal((await value(customer, 'SELECT status FROM customer.stream_inbox WHERE event_id = $1', [duplicate.eventId])).status,
        'applied');
      assert.equal((await value(customer, 'SELECT count(*)::int AS count FROM customer.membership_correction WHERE correction_id = $1',
        [restoringCorrection])).count, 1);
    });
  } finally {
    await Promise.all([posApp.close(), customerApp.close()]);
    await Promise.all([pos, setupPos, customer, setupCustomer, relayPos, relayCustomer, relayInventory].map(pool => pool.end()));
    relayRedis.close();
    customerRedis.close();
    process.stdout.write(`T-309 Compose scenarios passed: ${passed}\n`);
  }
}

async function scoped(pool, store, fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.store_id', $1, true), set_config('app.stream_scope', $1, true)", [store]);
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

async function checkpointForCorrection(pool, store, correctionId) {
  return scoped(pool, store, async db => {
    const { rows: [row] } = await db.query(`
      SELECT i.status, i.store_seq, c.last_seq
      FROM customer.membership_correction e
      JOIN customer.stream_inbox i USING (event_id)
      JOIN customer.stream_checkpoint c USING (consumer_group, producer, scope_key)
      WHERE e.correction_id = $1`, [correctionId]);
    return row;
  });
}
