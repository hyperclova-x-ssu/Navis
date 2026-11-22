import { randomUUID } from 'node:crypto';
import { dbPool } from '../../packages/db/index.ts';
import { connectStreams } from '../../packages/streams/index.ts';
import { createPosReceiptConsumer } from './consumer.ts';

const pool = dbPool('pos', 'worker');
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
pool.on('error', () => console.error('POS receipt database connection unavailable'));

try {
  const redis = await connectStreams('pos');
  try {
    await createPosReceiptConsumer(pool, redis, `pos-receipts-${randomUUID()}`).run(stop.signal);
  } finally {
    redis.close();
  }
} finally {
  await pool.end();
}
