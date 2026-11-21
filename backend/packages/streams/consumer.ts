import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import type { EventProducer } from '../contracts/events.ts';
import { parseEnvelope, type StreamEnvelope } from './envelope.ts';
import type { RedisDelivery, RedisStreams } from './redis.ts';
import { backoffMs, schemaName, transact } from './transaction.ts';

export class PermanentStreamError extends Error {
  readonly code: string;

  constructor(code: string) {
    super('Permanent stream handler error');
    this.code = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'PERMANENT_HANDLER_FAILURE';
  }
}

export type StreamHandler = (db: PoolClient, event: StreamEnvelope) => Promise<void>;

interface ConsumerOptions {
  database: Pool;
  service: string;
  producer: EventProducer;
  group: string;
  name: string;
  redis: RedisStreams;
  handlers: Readonly<Record<string, StreamHandler>>;
  reclaimIdleMs?: number;
  /** Test seam for process termination after commit and before XACK. */
  afterCommit?: (event: StreamEnvelope) => void | Promise<void>;
}

interface InboxRow {
  status: 'retry' | 'quarantined' | 'applied' | 'ignored';
  attempts: number;
  store_seq: string;
  retry_due: boolean;
  reason: string | null;
}

type Decision = 'hold' | 'ack' | 'committed' | { reason: string };
const maxAttempts = 5;
const eventFamily = (eventType: string): string => eventType.slice(0, eventType.lastIndexOf('.'));

export class StreamConsumer {
  private readonly options: ConsumerOptions;
  private readonly inbox: string;
  private readonly checkpoint: string;
  private readonly families: ReadonlySet<string>;
  private cursor = '0-0';
  private epoch: string | null = null;

  constructor(options: ConsumerOptions) {
    this.options = options;
    const schema = schemaName(options.service);
    this.inbox = `${schema}.stream_inbox`;
    this.checkpoint = `${schema}.stream_checkpoint`;
    this.families = new Set(Object.keys(options.handlers).map(eventFamily));
  }

  async step(): Promise<number> {
    const { redis, producer, group, name, reclaimIdleMs = 1_000 } = this.options;
    const epoch = await redis.readyEpoch(producer);
    if (!epoch) return 0;
    if (epoch !== this.epoch) {
      this.cursor = '0-0';
      this.epoch = epoch;
    }

    const claimed = await redis.claim(producer, group, name, reclaimIdleMs, this.cursor);
    this.cursor = claimed.cursor;
    const fresh = await redis.read(producer, group, name);
    for (const delivery of [...claimed.messages, ...fresh]) {
      await this.deliver(delivery, epoch);
    }
    return claimed.messages.length + fresh.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (await this.step() > 0) {
          // A held gap can remain reclaimable while fresh deliveries keep arriving.
          await delay(25, undefined, { signal });
          continue;
        }
      } catch {
        if (!signal.aborted) console.error('Stream consumer iteration failed');
      }
      await delay(250, undefined, { signal }).catch(() => undefined);
    }
  }

  /** Reprocess the original retained head after repairing its handler or prerequisites. */
  async replay(scopeKey: string, eventId: string): Promise<boolean> {
    return transact(this.options.database, async db => {
      await this.enterScope(db, scopeKey);
      const { rows: [row] } = await db.query<{ envelope: unknown }>(`
        SELECT envelope FROM ${this.inbox}
        WHERE consumer_group = $1 AND event_id = $2 AND producer = $3 AND status = 'quarantined'`,
      [this.options.group, eventId, this.options.producer]);
      if (!row) return false;
      const event = parseEnvelope(row.envelope, this.options.producer);
      return (await this.apply(db, event, true)) === 'committed';
    });
  }

  private async deliver(delivery: RedisDelivery, epoch: string): Promise<void> {
    const { redis, producer, group, database, afterCommit } = this.options;
    let event: StreamEnvelope;
    try {
      event = parseEnvelope(JSON.parse(delivery.message.envelope), producer);
    } catch {
      // The authenticated relay validates before XADD. A corrupt transport entry has no trusted scope.
      console.error('Stream delivery has an invalid envelope');
      return;
    }

    const decision = await transact(database, async db => {
      await this.enterScope(db, event.scopeKey);
      return this.apply(db, event, false);
    });
    if (decision === 'hold') return;
    if (decision === 'committed') await afterCommit?.(event);
    if (typeof decision === 'object') await this.notify(event, decision.reason);
    await redis.ack(producer, group, epoch, delivery.id);
  }

  private async enterScope(db: PoolClient, scopeKey: string): Promise<void> {
    const { producer, group } = this.options;
    await db.query(`
      SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('navis:consumer'::text, $1::text, $2::text, $3::text)::text, 0)),
             set_config('app.stream_scope', $3, true)`, [group, producer, scopeKey]);
  }

  private async apply(db: PoolClient, event: StreamEnvelope, replay: boolean): Promise<Decision> {
    const { group, handlers } = this.options;
    const identity = [group, event.producer, event.scopeKey];
    const { rows: [checkpoint] } = await db.query<{ last_seq: string }>(
      `SELECT last_seq FROM ${this.checkpoint}
       WHERE consumer_group = $1 AND producer = $2 AND scope_key = $3`, identity,
    );
    const lastSeq = BigInt(checkpoint?.last_seq ?? '0');
    const seq = BigInt(event.storeSeq);
    if (seq <= lastSeq) return 'ack';
    if (seq !== lastSeq + 1n) return 'hold';

    const { rows: [saved] } = await db.query<InboxRow>(`
      SELECT status, attempts, store_seq, retry_at <= clock_timestamp() AS retry_due, reason
      FROM ${this.inbox} WHERE consumer_group = $1 AND event_id = $2`, [group, event.eventId]);
    if (saved && saved.store_seq !== event.storeSeq) throw new Error('Stream event ID reused for a different sequence');
    if (!replay && saved?.status === 'quarantined') return { reason: saved.reason ?? 'PERMANENT_HANDLER_FAILURE' };
    if (saved?.status === 'retry' && !saved.retry_due) return 'hold';

    const attempts = (saved?.attempts ?? 0) + 1;
    const handler = Object.hasOwn(handlers, event.eventType) ? handlers[event.eventType] : undefined;
    await db.query("SELECT set_config('app.store_id', $1, true)", [event.storeId ?? '']);
    await db.query('SAVEPOINT stream_handler');
    try {
      if (handler) await handler(db, event);
      else if (this.families.has(eventFamily(event.eventType))) {
        throw new PermanentStreamError('UNSUPPORTED_EVENT_VERSION');
      }
    } catch (error) {
      await db.query('ROLLBACK TO SAVEPOINT stream_handler');
      const reason = error instanceof PermanentStreamError ? error.code
        : attempts >= maxAttempts || replay ? 'RETRY_EXHAUSTED' : null;
      await this.save(db, event, attempts, reason ? 'quarantined' : 'retry', reason);
      return reason ? { reason } : 'hold';
    }
    await db.query('RELEASE SAVEPOINT stream_handler');

    await this.save(db, event, attempts, handler ? 'applied' : 'ignored', null);
    await db.query(`INSERT INTO ${this.checkpoint} (consumer_group, producer, scope_key, last_seq)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (consumer_group, producer, scope_key) DO UPDATE SET last_seq = EXCLUDED.last_seq`,
    [...identity, event.storeSeq]);
    return 'committed';
  }

  private async save(db: PoolClient, event: StreamEnvelope, attempts: number, status: InboxRow['status'], reason: string | null): Promise<void> {
    const retryMs = status === 'retry' ? backoffMs(attempts) : null;
    const envelope = status === 'quarantined' ? JSON.stringify(event) : null;
    await db.query(`INSERT INTO ${this.inbox}
      (consumer_group, producer, scope_key, store_seq, event_id, status, attempts, retry_at, reason, envelope)
      VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp() + $8 * interval '1 millisecond', $9, $10::jsonb)
      ON CONFLICT (consumer_group, event_id) DO UPDATE SET
        status = EXCLUDED.status, attempts = EXCLUDED.attempts, retry_at = EXCLUDED.retry_at,
        reason = EXCLUDED.reason, envelope = EXCLUDED.envelope`,
    [this.options.group, event.producer, event.scopeKey, event.storeSeq, event.eventId,
      status, attempts, retryMs, reason, envelope]);
  }

  private async notify(event: StreamEnvelope, reason: string): Promise<void> {
    const { database, redis, group } = this.options;
    await transact(database, async db => {
      await this.enterScope(db, event.scopeKey);
      const { rowCount } = await db.query(`UPDATE ${this.inbox} SET notified_at = clock_timestamp()
        WHERE consumer_group = $1 AND event_id = $2 AND status = 'quarantined' AND notified_at IS NULL`,
      [group, event.eventId]);
      if (rowCount) await redis.notice(group, event, reason);
    });
  }
}
