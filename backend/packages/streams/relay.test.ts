import type { Pool } from 'pg';
import { expect, test, vi } from 'vitest';
import { RedisStreams } from './redis.ts';
import { OutboxRelay } from './relay.ts';

test('uses the configured checkpoint schema and preserves the group name during rebuild', async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  const producer = { connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const inventory = { query: vi.fn(async () => ({ rows: [] })) };
  const marketing = { query: vi.fn(async () => ({ rows: [] })) };
  const redis = {
    readyEpoch: vi.fn(async () => null), beginRebuild: vi.fn(async () => 'epoch'),
    finishRebuild: vi.fn(async () => true),
  };
  const relay = new OutboxRelay({
    producer: 'pos', database: producer, redis: redis as unknown as RedisStreams,
    groups: [
      { name: 'inventory', database: inventory as unknown as Pool },
      { name: 'marketing-worker', schema: 'marketing', database: marketing as unknown as Pool },
    ],
  });

  expect(await relay.step()).toBe('rebuilt');
  expect(inventory.query).toHaveBeenCalledWith(expect.stringContaining('FROM inventory.stream_checkpoint'), ['inventory', 'pos']);
  expect(marketing.query).toHaveBeenCalledWith(expect.stringContaining('FROM marketing.stream_checkpoint'), ['marketing-worker', 'pos']);
  expect(redis.readyEpoch).toHaveBeenCalledWith('pos', ['inventory', 'marketing-worker']);
  expect(redis.beginRebuild).toHaveBeenCalledWith('pos', ['inventory', 'marketing-worker']);
});

test('uses a new epoch when the configured consumer set changes', async () => {
  const get = vi.fn(async () => 'ready:old');
  const exists = vi.fn(async () => 1);
  const evalScript = vi.fn(async (_script: string, _input: { arguments: string[] }) => 1);
  const streams = new RedisStreams({ get, exists, eval: evalScript } as unknown as ConstructorParameters<typeof RedisStreams>[0]);

  expect(await streams.readyEpoch('inventory')).toBe('ready:old');
  expect(await streams.readyEpoch('inventory', ['pos', 'customer'])).toBeNull();

  const token = await streams.beginRebuild('inventory', ['customer', 'pos']);
  expect(await streams.finishRebuild('inventory', token)).toBe(true);
  const epoch = evalScript.mock.calls.at(-1)![1].arguments[1];
  get.mockResolvedValue(epoch);
  expect(await streams.readyEpoch('inventory', ['pos', 'customer'])).toBe(epoch);
  expect(await streams.readyEpoch('inventory', ['pos'])).toBeNull();
});
