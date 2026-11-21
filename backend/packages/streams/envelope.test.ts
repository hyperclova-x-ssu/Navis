import { describe, expect, it } from 'vitest';
import { parseEnvelope, streamKey } from './envelope.ts';

const storeId = '11111111-1111-4111-8111-111111111111';
const envelope = {
  eventId: '22222222-2222-4222-8222-222222222222',
  producer: 'pos',
  storeId,
  scopeKey: storeId,
  storeSeq: '9007199254740993',
  eventType: 'pos.sale_recognized.v1',
  schemaVersion: 1,
  aggregateId: '33333333-3333-4333-8333-333333333333',
  occurredAt: '2026-11-17T06:45:00.000Z',
  payload: {},
};

describe('stream envelope', () => {
  it('keeps decimal PostgreSQL sequences above the JavaScript safe integer range', () => {
    expect(parseEnvelope(envelope, 'pos').storeSeq).toBe('9007199254740993');
    expect(streamKey('pos')).toBe('navis.pos.0');
  });

  it.each([
    { storeSeq: 9007199254740993 }, { storeSeq: '092' }, { storeSeq: '9223372036854775808' },
    { storeSeq: '0' }, { scopeKey: 'other' }, { eventType: 'inventory.receipt_recorded.v1' },
    { schemaVersion: 2 }, { eventId: 'not-an-id' }, { payload: [] },
  ])('rejects mismatched or invalid envelope fields %j', (patch) => {
    expect(() => parseEnvelope({ ...envelope, ...patch }, 'pos')).toThrow('Invalid stream envelope');
  });

  it('does not accept an inventory envelope on the POS stream', () => {
    const receipt = { ...envelope, producer: 'inventory', eventType: 'inventory.receipt_recorded.v1' };
    expect(() => parseEnvelope(receipt, 'pos')).toThrow('Invalid stream envelope');
    expect(parseEnvelope(receipt, 'inventory').eventType).toBe(receipt.eventType);
  });
});
