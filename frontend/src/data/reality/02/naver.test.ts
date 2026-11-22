import { expect, it } from 'vitest';
import { fakeBackend, reply } from '../00/testing';
import { createPortTransport } from '../00/transport';
import { createPosRemote } from './remote';

it('reconciles an uncertain NAVER prepare using the original key and revision', async () => {
  const backend = fakeBackend();
  const path = '/pos/naver/orders/N1/prepare';
  let sent = false;
  backend.on('POST', path, () => {
    if (sent) return { resourceId: 'N1', receiptId: 'r1', revision: 4, affectedSources: ['pos.naver-orders'] };
    sent = true;
    return reply(503, { reason: 'ORDER_PROVIDER_OUTCOME_UNKNOWN' });
  });
  const remote = createPosRemote({ transport: createPortTransport(backend.fetch), delaysMs: [0], sleep: async () => {} });
  const receipt = await remote.naver.transition('N1', { kind: 'prepare', preparationMinutes: 7 }, 3, 'prepare-1');
  expect(receipt.receiptId).toBe('r1');
  const calls = backend.callsTo('POST', path);
  expect(calls.map(call => call.body)).toEqual(Array(2).fill({ preparationMinutes: 7, expectedRevision: 3 }));
  expect(calls.map(call => call.headers.get('idempotency-key'))).toEqual(['prepare-1', 'prepare-1']);
});
