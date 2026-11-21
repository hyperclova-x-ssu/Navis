import pg, { type Pool, type PoolClient } from 'pg';
import type { EventProducer } from '../contracts/events.ts';
import { readSecret } from '../db/index.ts';
import { parseEnvelope, type StreamEnvelope } from './envelope.ts';
import type { RedisStreams } from './redis.ts';
import { backoffMs, schemaName, transact } from './transaction.ts';

export const localStreamGroups = {
  pos: ['inventory', 'customer'],
  inventory: ['pos'],
} as const;
export type RelayDatabase = 'pos' | 'inventory' | 'customer';

export function relayDbPool(database: RelayDatabase): Pool {
  const user = `${database}_relay`;
  const pool = new pg.Pool({
    host: process.env.NAVIS_DB_HOST ?? 'db',
    port: 5432, database, user,
    password: readSecret(`/run/secrets/${user}_password`),
    application_name: user, max: 4, connectionTimeoutMillis: 2_000, query_timeout: 5_000,
  });
  pool.on('error', () => console.error('Relay PostgreSQL connection unavailable'));
  return pool;
}

interface OutboxRow {
  event_id: string;
  producer: string;
  store_id: string | null;
  scope_key: string;
  store_seq: string;
  event_type: string;
  schema_version: number;
  aggregate_id: string;
  occurred_at: Date;
  payload: unknown;
  attempt_count: number;
}

const outboxColumns = `event_id, producer, store_id, scope_key, store_seq, event_type,
                       schema_version, aggregate_id, occurred_at, payload, attempt_count`;

function toEnvelope(row: OutboxRow, producer: EventProducer): StreamEnvelope {
  return parseEnvelope({
    eventId: row.event_id, producer: row.producer, storeId: row.store_id, scopeKey: row.scope_key,
    storeSeq: row.store_seq, eventType: row.event_type, schemaVersion: row.schema_version,
    aggregateId: row.aggregate_id, occurredAt: row.occurred_at.toISOString(), payload: row.payload,
  }, producer);
}

interface RelayOptions {
  producer: EventProducer;
  database: Pool;
  redis: RedisStreams;
  groups: readonly { name: RelayDatabase; database: Pool }[];
  /** Test seam for process termination after Redis has accepted the event. */
  afterAppend?: (event: StreamEnvelope) => void | Promise<void>;
}

export class OutboxRelay {
  private readonly options: RelayOptions;
  private readonly outbox: string;

  constructor(options: RelayOptions) {
    if (!options.groups.length) throw new Error('A relay requires at least one recovery group');
    this.options = options;
    this.outbox = `${schemaName(options.producer)}.outbox`;
  }

  async step(): Promise<'idle' | 'published' | 'retry' | 'rebuilt'> {
    const { database, redis, producer, afterAppend } = this.options;
    const result = await transact(database, async db => {
      await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('navis:stream:' || $1, 0))", [producer]);
      const epoch = await redis.readyEpoch(producer);
      if (!epoch) return 'rebuild' as const;

      const { rows: [row] } = await db.query<OutboxRow>(`
        SELECT ${outboxColumns} FROM ${this.outbox} o
        WHERE o.published_at IS NULL
          AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= clock_timestamp())
          AND NOT EXISTS (
            SELECT 1 FROM ${this.outbox} earlier
            WHERE earlier.scope_key = o.scope_key
              AND earlier.published_at IS NULL AND earlier.store_seq < o.store_seq
          )
        ORDER BY o.occurred_at, o.event_id
        LIMIT 1 FOR UPDATE OF o SKIP LOCKED
      `);
      if (!row) return 'idle' as const;

      let event: StreamEnvelope;
      try {
        event = toEnvelope(row, producer);
        if (!await redis.append(producer, epoch, event)) return 'rebuild' as const;
      } catch {
        await db.query(`UPDATE ${this.outbox}
          SET attempt_count = least(attempt_count, 2147483646) + 1,
              next_attempt_at = clock_timestamp() + $2 * interval '1 millisecond'
          WHERE event_id = $1`, [row.event_id, backoffMs(row.attempt_count + 1)]);
        return 'retry' as const;
      }
      await afterAppend?.(event);
      await db.query(`UPDATE ${this.outbox}
        SET published_at = clock_timestamp(), next_attempt_at = NULL WHERE event_id = $1`, [row.event_id]);
      return 'published' as const;
    });
    if (result !== 'rebuild') return result;
    await this.rebuild();
    return 'rebuilt';
  }

  private async rebuild(): Promise<void> {
    const { database, redis, producer, groups } = this.options;
    await transact(database, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('navis:stream:' || $1, 0))", [producer]);
      if (await redis.readyEpoch(producer)) return;

      const checkpoints = await Promise.all(groups.map(async ({ name, database: groupDb }) => {
        const { rows } = await groupDb.query<{ scope_key: string; last_seq: string }>(`
          SELECT scope_key, last_seq FROM ${schemaName(name)}.stream_checkpoint
          WHERE consumer_group = $1 AND producer = $2`, [name, producer]);
        return new Map(rows.map(row => [row.scope_key, BigInt(row.last_seq)]));
      }));
      const token = await redis.beginRebuild(producer, groups.map(group => group.name));
      await this.replayPublished(db, token, checkpoints);
      if (!await redis.finishRebuild(producer, token)) throw new Error('Redis changed during stream rebuild');
    });
  }

  private async replayPublished(db: PoolClient, token: string, checkpoints: ReadonlyMap<string, bigint>[]): Promise<void> {
    let afterScope = '';
    let afterSeq = '0';
    const { producer, redis } = this.options;
    for (;;) {
      const { rows } = await db.query<OutboxRow>(`
        SELECT ${outboxColumns} FROM ${this.outbox}
        WHERE published_at IS NOT NULL AND (scope_key, store_seq) > ($1, $2)
        ORDER BY scope_key, store_seq LIMIT 128`, [afterScope, afterSeq]);
      if (!rows.length) return;
      for (const row of rows) {
        const seq = BigInt(row.store_seq);
        if (checkpoints.some(group => seq > (group.get(row.scope_key) ?? 0n))) {
          if (!await redis.append(producer, token, toEnvelope(row, producer))) {
            throw new Error('Redis changed during stream rebuild');
          }
        }
      }
      const tail = rows.at(-1)!;
      afterScope = tail.scope_key;
      afterSeq = tail.store_seq;
    }
  }
}

export async function hasOutbox(database: Pool, producer: EventProducer): Promise<boolean> {
  const { rows: [row] } = await database.query<{ outbox: string | null }>('SELECT to_regclass($1) AS outbox', [
    `${schemaName(producer)}.outbox`,
  ]);
  return row.outbox !== null;
}
