import type { EventProducer } from '../contracts/events.ts';

export interface StreamEnvelope {
  readonly eventId: string;
  readonly producer: EventProducer;
  readonly storeId: string | null;
  readonly scopeKey: string;
  readonly storeSeq: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const scope = /^[a-zA-Z0-9:_-]{1,128}$/;
const maxSequence = 9223372036854775807n;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validAggregateId(eventType: string, aggregateId: string, storeId: string | null, payload: Record<string, unknown>) {
  if (eventType !== 'account.panel_changed.v1' && eventType !== 'account.widget_changed.v1') return uuid.test(aggregateId);
  if (storeId === null || payload.storeId !== storeId) return false;
  const { boardId, featureId } = payload;
  if (boardId !== 'management' && boardId !== 'marketing') return false;
  if (eventType === 'account.panel_changed.v1') return aggregateId === boardId;
  return aggregateId === featureId && /^[a-z][a-z0-9-]{0,79}$/.test(aggregateId);
}

export function parseEnvelope(value: unknown, expectedProducer: EventProducer): StreamEnvelope {
  if (isObject(value)) {
    const { eventId, producer, storeId, scopeKey, storeSeq, eventType, schemaVersion, aggregateId, occurredAt, payload } = value;
    if (producer === expectedProducer
      && typeof eventId === 'string' && uuid.test(eventId)
      && typeof scopeKey === 'string' && scope.test(scopeKey)
      && (storeId === null || (typeof storeId === 'string' && uuid.test(storeId) && storeId === scopeKey))
      && typeof storeSeq === 'string' && /^[1-9][0-9]{0,18}$/.test(storeSeq) && BigInt(storeSeq) <= maxSequence
      && typeof schemaVersion === 'number' && Number.isSafeInteger(schemaVersion) && schemaVersion > 0
      && typeof eventType === 'string' && eventType.startsWith(`${expectedProducer}.`)
      && /^[a-z]+\.[a-z][a-z0-9_]*\.v[1-9][0-9]*$/.test(eventType) && eventType.endsWith(`.v${schemaVersion}`)
      && typeof aggregateId === 'string'
      && typeof occurredAt === 'string' && Number.isFinite(Date.parse(occurredAt))
      && isObject(payload) && validAggregateId(eventType, aggregateId, storeId, payload)) {
      return { eventId, producer: expectedProducer, storeId, scopeKey, storeSeq, eventType, schemaVersion, aggregateId, occurredAt, payload };
    }
  }
  throw new Error('Invalid stream envelope');
}

export const streamKey = (producer: EventProducer): string => `navis.${producer}.0`;
export const epochKey = (producer: EventProducer): string => `${streamKey(producer)}.epoch`;
export const deadLetterKey = (group: string): string => `navis.dlq.${group}`;
