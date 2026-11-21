import { randomUUID } from 'node:crypto';
import { dbPool } from '../../packages/db/index.ts';
import { connectStreams } from '../../packages/streams/index.ts';
import { createInventoryStockConsumer } from './stock-consumer.ts';

const pool = dbPool('inventory');
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
pool.on('error', () => console.error('Inventory stock database connection unavailable'));

try {
  const redis = await connectStreams('inventory');
  try {
    await createInventoryStockConsumer(pool, redis, `inventory-stock-${randomUUID()}`).run(stop.signal);
  } finally {
    redis.close();
  }
} finally {
  await pool.end();
}
