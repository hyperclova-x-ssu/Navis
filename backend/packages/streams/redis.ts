import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import type { EventProducer } from '../contracts/events.ts';
import { readSecret } from '../db/index.ts';
import { deadLetterKey, epochKey, parseEnvelope, streamKey, type StreamEnvelope } from './envelope.ts';

const appendAtEpoch = `
  if redis.call('GET', KEYS[1]) == ARGV[1] and redis.call('EXISTS', KEYS[2]) == 1 then
    return redis.call('XADD', KEYS[2], '*', 'envelope', ARGV[2])
  end
`;

export type RedisDelivery = { id: string; message: Record<string, string> };

export class RedisStreams {
  private readonly client: ReturnType<typeof redisClient>;

  constructor(client: ReturnType<typeof redisClient>) {
    this.client = client;
  }

  async readyEpoch(producer: EventProducer): Promise<string | null> {
    const epoch = await this.client.get(epochKey(producer));
    return epoch?.startsWith('ready:') && await this.client.exists(streamKey(producer)) ? epoch : null;
  }

  async beginRebuild(producer: EventProducer, groups: readonly string[]): Promise<string> {
    const token = `rebuilding:${randomUUID()}`;
    await this.client.eval(`
      redis.call('SET', KEYS[1], ARGV[1])
      redis.call('DEL', KEYS[2])
      for i = 2, #ARGV do
        redis.call('XGROUP', 'CREATE', KEYS[2], ARGV[i], '0', 'MKSTREAM')
      end
    `, { keys: [epochKey(producer), streamKey(producer)], arguments: [token, ...groups] });
    return token;
  }

  async append(producer: EventProducer, epoch: string, event: StreamEnvelope): Promise<boolean> {
    return await this.client.eval(appendAtEpoch, {
      keys: [epochKey(producer), streamKey(producer)], arguments: [epoch, JSON.stringify(event)],
    }) !== null;
  }

  async finishRebuild(producer: EventProducer, token: string): Promise<boolean> {
    const result = await this.client.eval(`
      if redis.call('GET', KEYS[1]) == ARGV[1] and redis.call('EXISTS', KEYS[2]) == 1 then
        redis.call('SET', KEYS[1], ARGV[2])
        return 1
      end
      return 0
    `, {
      keys: [epochKey(producer), streamKey(producer)],
      arguments: [token, token.replace('rebuilding:', 'ready:')],
    });
    return result === 1;
  }

  async read(producer: EventProducer, group: string, name: string): Promise<RedisDelivery[]> {
    const streams = await this.client.xReadGroup(group, name, { key: streamKey(producer), id: '>' }, { COUNT: 16 });
    return streams?.flatMap(stream => stream.messages) ?? [];
  }

  async claim(producer: EventProducer, group: string, name: string, idle: number, cursor: string) {
    const result = await this.client.xAutoClaim(streamKey(producer), group, name, idle, cursor, { COUNT: 16 });
    return { cursor: result.nextId, messages: result.messages.filter(message => message !== null) };
  }

  async ack(producer: EventProducer, group: string, epoch: string, id: string): Promise<void> {
    await this.client.eval(`
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('XACK', KEYS[2], ARGV[2], ARGV[3])
      end
    `, { keys: [epochKey(producer), streamKey(producer)], arguments: [epoch, group, id] });
  }

  async notice(group: string, event: StreamEnvelope, code: string): Promise<void> {
    await this.client.xAdd(deadLetterKey(group), '*', {
      eventId: event.eventId, producer: event.producer, scopeKey: event.scopeKey, storeSeq: event.storeSeq, code,
    });
  }

  async pending(producer: EventProducer, group: string): Promise<number> {
    return (await this.client.xPending(streamKey(producer), group)).pending;
  }

  async events(producer: EventProducer): Promise<StreamEnvelope[]> {
    const entries = await this.client.xRange(streamKey(producer), '-', '+');
    return entries?.map(entry => parseEnvelope(JSON.parse(entry.message.envelope), producer)) ?? [];
  }

  close(): void {
    this.client.destroy();
  }
}

type RedisIdentity = 'relay' | 'inventory' | 'customer' | 'pos';

function redisClient(identity: RedisIdentity) {
  return createClient({
    url: process.env.NAVIS_REDIS_URL ?? 'redis://redis:6379',
    username: identity,
    password: readSecret(`/run/secrets/${identity}_redis_password`),
    disableOfflineQueue: true,
    commandOptions: { timeout: 3_000 },
    socket: { connectTimeout: 2_000 },
  });
}

export async function connectStreams(identity: RedisIdentity): Promise<RedisStreams> {
  const client = redisClient(identity);
  client.on('error', () => console.error('Redis Streams connection unavailable'));
  await client.connect();
  return new RedisStreams(client);
}
