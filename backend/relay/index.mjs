import { setTimeout as delay } from 'node:timers/promises';
import { dbPool } from '../packages/db/index.ts';
import { connectStreams } from '../packages/streams/index.ts';
import { hasOutbox, localStreamGroups, OutboxRelay, relayDbPool } from '../packages/streams/relay.ts';

const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());

const redis = await connectStreams('relay');
const phase3 = process.env.NAVIS_PHASE3_FIXTURES === '1';
const databases = {
  ...Object.fromEntries(['pos', 'inventory', 'customer'].map(name => [name, relayDbPool(name)])),
  insight: dbPool('insight', 'relay'),
  marketing: dbPool('marketing', 'relay'),
};
const groups = phase3 ? {
  ...localStreamGroups,
  inventory: [...localStreamGroups.inventory, 'marketing-supplier'],
  marketing: [...localStreamGroups.marketing, 'marketing-worker'],
} : localStreamGroups;
for (const database of [databases.insight, databases.marketing]) {
  database.on('error', () => console.error('Relay PostgreSQL connection unavailable'));
}
try {
  await Promise.all(Object.entries(groups).map(async ([producer, consumers]) => {
    const database = databases[producer];
    const relay = new OutboxRelay({
      producer, database, redis, groups: consumers.map(name => {
        const schema = name === 'marketing-worker' || name === 'marketing-supplier' ? 'marketing'
          : name === 'insight-tables' ? 'insight' : name;
        return { name, schema, database: databases[schema] };
      }),
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
