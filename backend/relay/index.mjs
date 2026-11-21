import { setTimeout as delay } from 'node:timers/promises';
import { connectStreams } from '../packages/streams/index.ts';
import { hasOutbox, localStreamGroups, OutboxRelay, relayDbPool } from '../packages/streams/relay.ts';

const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());

const redis = await connectStreams('relay');
const databases = Object.fromEntries(['pos', 'inventory', 'customer'].map(name => [name, relayDbPool(name)]));
try {
  await Promise.all(Object.entries(localStreamGroups).map(async ([producer, groups]) => {
    const database = databases[producer];
    const relay = new OutboxRelay({
      producer, database, redis, groups: groups.map(name => ({ name, database: databases[name] })),
    });
    while (!stop.signal.aborted) {
      let wait = 250;
      try {
        // An inventory producer becomes active once T-308's local migration is applied.
        if (await hasOutbox(database, producer)) {
          const result = await relay.step();
          if (result === 'published') continue;
          if (result === 'retry') console.error(`Outbox publish retry scheduled for ${producer}`);
        } else {
          wait = 1_000;
        }
      } catch {
        console.error(`Outbox relay iteration failed for ${producer}`);
        wait = 1_000;
      }
      await delay(wait, undefined, { signal: stop.signal }).catch(() => undefined);
    }
  }));
} finally {
  redis.close();
  await Promise.all(Object.values(databases).map(pool => pool.end()));
}
