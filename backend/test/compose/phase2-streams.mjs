import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const project = 'navis-backend-local';
const backend = new URL('../../', import.meta.url);

function compose(...args) {
  return execFileSync('docker', [
    'compose', '--env-file', '/dev/null', '-p', project, '--profile', 'streams-test', ...args,
  ], { cwd: backend, encoding: 'utf8' });
}

if (!process.argv[2]) {
  try {
    compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'streams-test-db', 'streams-test-redis');
    compose('run', '--rm', '--pull', 'never', 'streams-tools', 'npm', 'run', 'migrate', '--', 'pos');
    // T-308 provides the domain migration. This disposable DB exercises its outbox grant contract.
    compose('exec', '-T', 'streams-test-db', 'psql', '-Xq', '-U', 'navis_bootstrap', '-d', 'inventory',
      '--set', 'ON_ERROR_STOP=1', '-c', `SET ROLE inventory_mig;
      CREATE TABLE inventory.outbox (
        event_id uuid PRIMARY KEY, producer text NOT NULL DEFAULT 'inventory', store_id uuid NOT NULL,
        scope_key text NOT NULL, store_seq bigint NOT NULL, event_type text NOT NULL,
        schema_version integer NOT NULL DEFAULT 1, aggregate_id uuid NOT NULL, occurred_at timestamptz NOT NULL,
        payload jsonb NOT NULL, published_at timestamptz, attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz, UNIQUE (scope_key, store_seq)
      );
      CREATE POLICY fixture_writer ON inventory.outbox TO inventory_mig
        USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)`);
    for (let pass = 0; pass < 2; pass++) {
      compose('exec', '-T', 'streams-test-db', '/docker-entrypoint-initdb.d/20-stream-access.sh');
    }
    const scopes = Array.from({ length: 4 }, () => randomUUID()).join(',');
    for (const phase of ['before-loss', 'after-loss']) {
      if (phase === 'after-loss') {
        compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'streams-test-redis');
      }
      const output = compose('run', '--rm', '--pull', 'never', 'streams-tools',
        'node', 'test/compose/phase2-streams.mjs', phase, scopes);
      process.stdout.write(output);
    }
  } finally {
    compose('rm', '-sf', 'streams-test-db', 'streams-test-redis');
  }
} else {
  await runInContainer(...process.argv.slice(2));
}

async function runInContainer(phase, scopes) {
  const { dbPool } = await import('../../packages/db/index.ts');
  const { recordReceiptExpenseCandidate } = await import('../../services/pos/expenses.ts');
  const { StreamConsumer, PermanentStreamError, connectStreams } = await import('../../packages/streams/index.ts');
  const { OutboxRelay, relayDbPool } = await import('../../packages/streams/relay.ts');
  const [a, b, c, d] = scopes.split(',');
  const pos = relayDbPool('pos');
  const customer = relayDbPool('customer');
  const inventory = relayDbPool('inventory');
  const runtime = dbPool('inventory');
  const customerRuntime = dbPool('customer');
  const posRuntime = dbPool('pos');
  const setup = dbPool('pos', 'migrate');
  const effects = dbPool('inventory', 'migrate');
  const relayRedis = await connectStreams('relay');
  const consumerRedis = await connectStreams('inventory');
  const receiptRedis = await connectStreams('pos');
  const receiptRelay = new OutboxRelay({
    producer: 'inventory', database: inventory, redis: relayRedis, groups: [{ name: 'pos', database: pos }],
  });
  const receipts = new StreamConsumer({
    database: posRuntime, service: 'pos', producer: 'inventory', group: 'pos',
    redis: receiptRedis, name: 'fixture-pos',
    handlers: {
      'inventory.receipt_recorded.v1': async (db, event) => { await recordReceiptExpenseCandidate(db, event); },
    },
  });
  const checkpointGroups = [{ name: 'inventory', database: inventory }, { name: 'customer', database: customer }];
  const createRelay = (afterAppend) => new OutboxRelay({
    producer: 'pos', database: pos, redis: relayRedis, groups: checkpointGroups, afterAppend,
  });
  const consumer = (options = {}) => new StreamConsumer({
    database: runtime, service: 'inventory', producer: 'pos', group: 'inventory',
    redis: consumerRedis, name: options.name ?? 'reclaimer', reclaimIdleMs: 0,
    handlers: {
      'pos.sale_recognized.v1': async (db, event) => {
        await db.query('INSERT INTO inventory.t307_stream_effect (store_id, event_id) VALUES ($1, $2)',
          [event.storeId, event.eventId]);
        if (!options.repaired && event.storeId === b) throw new PermanentStreamError('FIXTURE_RECIPE_MISSING');
        if (!options.repaired && event.storeId === d) throw new Error('fixture transient');
      },
    },
    afterCommit: options.afterCommit,
  });

  async function insert(storeId, count, eventType = 'pos.sale_recognized.v1') {
    return scoped(setup, storeId, async db => {
      await db.query('INSERT INTO pos.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [storeId]);
      const eventId = randomUUID();
      await db.query(`INSERT INTO pos.outbox
        (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
        VALUES ($1, $2, $2::uuid::text, $3, $4, $1, '2026-11-17T06:45:00Z', '{}')`,
      [eventId, storeId, count, eventType]);
      return eventId;
    });
  }

  async function state(scope) {
    return scoped(runtime, scope, async db => {
      const { rows: [checkpoint] } = await db.query(
        "SELECT last_seq FROM inventory.stream_checkpoint WHERE consumer_group = 'inventory' AND producer = 'pos'",
      );
      const { rows: [{ count }] } = await db.query(
        'SELECT count(*) FROM inventory.t307_stream_effect WHERE store_id = $1', [scope],
      );
      return [checkpoint?.last_seq ?? '0', Number(count)];
    });
  }

  async function quarantine(scope, eventId) {
    return scoped(runtime, scope, async db => {
      const { rows: [row] } = await db.query(
        'SELECT status, attempts, reason, envelope, notified_at FROM inventory.stream_inbox WHERE event_id = $1', [eventId],
      );
      return row;
    });
  }

  function crash(name, code) {
    const result = spawnSync(process.execPath, [new URL(import.meta.url).pathname, name, scopes], {
      stdio: 'inherit', timeout: 15_000,
    });
    assert.equal(result.status, code, `Expected the ${name} process to exit at the injected fault`);
  }

  async function publishAll(relay) {
    for (let iteration = 0; iteration < 100; iteration++) {
      if (await relay.step() === 'idle') return;
    }
    assert.fail('Relay did not reach idle');
  }

  const inFixture = (event) => [a, b, c, d].includes(event.scopeKey);
  try {
    if (phase === 'crash-publish') {
      await publishAll(createRelay(event => { if (event.scopeKey === a) process.exit(71); }));
      assert.fail('Crash after XADD was never reached');
    }
    if (phase === 'crash-consume') {
      await consumer({ name: 'crashed', afterCommit: event => {
        if (event.scopeKey === a) process.exit(72);
      } }).step();
      assert.fail('Crash after commit was never reached');
    }
    if (phase === 'before-loss') {
      await effects.query(`CREATE TABLE IF NOT EXISTS inventory.t307_stream_effect (
        store_id uuid NOT NULL, event_id uuid NOT NULL
      );
      GRANT SELECT, INSERT ON inventory.t307_stream_effect TO inventory_run`);

      const a1 = await insert(a, 1);
      crash('crash-publish', 71);
      const { rows: [unmarked] } = await pos.query('SELECT published_at FROM pos.outbox WHERE event_id = $1', [a1]);
      assert.equal(unmarked.published_at, null);
      assert.equal((await relayRedis.events('pos')).filter(e => e.eventId === a1).length, 1);
      await publishAll(createRelay());
      assert.equal((await relayRedis.events('pos')).filter(e => e.eventId === a1).length, 2);
      console.log('PASS: relay crash after XADD leaves the head unmarked and republishes the same ID');

      crash('crash-consume', 72);
      assert.deepEqual(await state(a), ['1', 1]);
      assert.equal(await consumerRedis.pending('pos', 'inventory'), 2);
      const runner = consumer();
      await runner.step();
      assert.equal(await consumerRedis.pending('pos', 'inventory'), 0);
      assert.deepEqual(await state(a), ['1', 1]);
      console.log('PASS: consumer crash after commit leaves a pending delivery that reclaim ACKs with one effect');

      const b1 = await insert(b, 1);
      const b2 = await insert(b, 2);
      const append = relayRedis.append.bind(relayRedis);
      relayRedis.append = async (producer, epoch, event) => {
        if (event.eventId === b1) throw new Error('fixture unavailable');
        return append(producer, epoch, event);
      };
      assert.equal(await createRelay().step(), 'retry');
      relayRedis.append = append;
      const { rows: [failedHead] } = await pos.query(
        'SELECT attempt_count, next_attempt_at FROM pos.outbox WHERE event_id = $1', [b1],
      );
      assert.equal(failedHead.attempt_count, 1);
      assert.ok(failedHead.next_attempt_at);
      await pos.query("UPDATE pos.outbox SET next_attempt_at = clock_timestamp() + interval '30 seconds' WHERE event_id = $1", [b1]);
      await insert(c, 1, 'pos.sale_corrected.v1'); // Explicitly ignored by the fixture handler.
      await insert(c, 2);
      const d1 = await insert(d, 1);
      await publishAll(createRelay());
      const published = await relayRedis.events('pos');
      assert.ok(published.some(event => event.scopeKey === c && event.storeSeq === '2'));
      assert.ok(published.every(event => event.eventId !== b1 && event.eventId !== b2));
      await pos.query('UPDATE pos.outbox SET next_attempt_at = NULL WHERE event_id = $1', [b1]);
      await publishAll(createRelay());
      console.log('PASS: a failed publish backs off its original head while an unrelated producer scope progresses');

      await runner.step();
      const bRecord = await quarantine(b, b1);
      assert.equal(bRecord.status, 'quarantined');
      assert.equal(bRecord.attempts, 1);
      assert.equal(bRecord.reason, 'FIXTURE_RECIPE_MISSING');
      assert.equal(bRecord.envelope.eventId, b1);
      assert.ok(bRecord.notified_at);
      assert.deepEqual(await state(b), ['0', 0]);
      assert.deepEqual(await state(c), ['2', 1]);
      assert.equal(await consumerRedis.pending('pos', 'inventory'), 2);
      console.log('PASS: a permanent failure durably holds its scope while an unrelated scope advances past an irrelevant type');

      for (let step = 0; step < 5; step++) {
        const record = await quarantine(d, d1);
        if (record.status === 'quarantined') break;
        const { rows: [retry] } = await scoped(runtime, d, db =>
          db.query('SELECT retry_at FROM inventory.stream_inbox WHERE event_id = $1', [d1]));
        await delay(Math.max(0, retry.retry_at.getTime() - Date.now()) + 20);
        await runner.step();
      }
      const exhausted = await quarantine(d, d1);
      assert.equal(exhausted.status, 'quarantined');
      assert.equal(exhausted.attempts, 5);
      assert.equal(exhausted.reason, 'RETRY_EXHAUSTED');
      assert.deepEqual(await state(d), ['0', 0]);
      console.log('PASS: transient failures stop after five attempts and failed effects roll back');

      const repaired = consumer({ repaired: true });
      assert.equal(await repaired.replay(b, b1), true);
      await repaired.step();
      assert.deepEqual(await state(b), ['2', 2]);
      console.log('PASS: durable replay repairs the original event ID and releases the held successor');

      // Record different group positions so rebuild must use the minimum for each scope.
      const customerRedis = await connectStreams('customer');
      try {
        const customerRunner = new StreamConsumer({
          database: customerRuntime, service: 'customer', producer: 'pos', group: 'customer',
          redis: customerRedis, name: 'fixture-customer',
          handlers: {
            'pos.sale_recognized.v1': async (_db, event) => {
              if (event.scopeKey !== a) throw new PermanentStreamError('FIXTURE_HELD');
            },
          },
        });
        await customerRunner.step();
      } finally {
        customerRedis.close();
      }

      const receiptId = randomUUID();
      await scoped(effects, a, db => db.query(`INSERT INTO inventory.outbox
        (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
        VALUES ($1, $2, $2::uuid::text, 1, 'inventory.receipt_recorded.v1', $3, now(), $4)`,
      [randomUUID(), a, receiptId, { receiptId, supplierId: randomUUID(), businessDate: '2026-11-17', amount: 3000 }]));
      await publishAll(receiptRelay);
      assert.equal(await receipts.step(), 1);
      const { rows: [expense] } = await scoped(posRuntime, a, db => db.query(
        'SELECT count(*) FROM pos.expense_candidate WHERE receipt_id = $1', [receiptId],
      ));
      assert.equal(expense.count, '1');
      assert.equal(await receiptRedis.pending('inventory', 'pos'), 0);
      console.log('PASS: inventory outbox grants allow receipt delivery into the POS transaction and checkpoint');
    }
    if (phase === 'after-loss') {
      assert.equal(await relayRedis.readyEpoch('pos'), null);
      await publishAll(createRelay());
      const replay = (await relayRedis.events('pos')).filter(inFixture);
      const { rows: retained } = await pos.query(
        'SELECT event_id, scope_key, store_seq FROM pos.outbox WHERE scope_key = ANY($1::text[]) ORDER BY scope_key, store_seq',
        [[a, b, c, d]],
      );
      const completedByBoth = new Map([[a, 1n], [c, 1n]]);
      assert.deepEqual(replay.map(event => event.eventId), retained
        .filter(row => BigInt(row.store_seq) > (completedByBoth.get(row.scope_key) ?? 0n))
        .map(row => row.event_id));
      const restarted = consumer({ repaired: true });
      for (let step = 0; step < 10; step++) await restarted.step();
      for (const [scope, expected] of [[a, ['1', 1]], [b, ['2', 2]], [c, ['2', 1]], [d, ['0', 0]]]) {
        assert.deepEqual(await state(scope), expected);
      }
      assert.equal(await consumerRedis.pending('pos', 'inventory'), 0);
      const { rows: [held] } = await pos.query('SELECT event_id FROM pos.outbox WHERE scope_key = $1', [d]);
      assert.equal((await quarantine(d, held.event_id)).status, 'quarantined');
      assert.equal(await restarted.replay(d, held.event_id), true);
      assert.deepEqual(await state(d), ['1', 1]);
      await publishAll(receiptRelay);
      assert.deepEqual(await relayRedis.events('inventory'), []);
      console.log('PASS: Redis loss rebuilds from the earliest required group checkpoint with original IDs and no duplicate effects');

      await assert.rejects(pos.query('SELECT * FROM pos.store'), error => error.code === '42501');
      await assert.rejects(pos.query('UPDATE pos.outbox SET payload = payload'), error => error.code === '42501');
      await assert.rejects(customer.query('SELECT * FROM customer.stream_inbox'), error => error.code === '42501');
      console.log('PASS: relay role cannot read domain data, change outbox payloads or read consumer quarantine bodies');
    }
  } finally {
    relayRedis.close();
    consumerRedis.close();
    receiptRedis.close();
    await Promise.all([pos, customer, inventory, runtime, customerRuntime, posRuntime, setup, effects].map(pool => pool.end()));
  }
}

async function scoped(pool, scope, action) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.store_id', $1, true), set_config('app.stream_scope', $1, true)", [scope]);
    const value = await action(db);
    await db.query('COMMIT');
    return value;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
