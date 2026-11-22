import { describe, expect, it } from 'vitest';
import { createPortTransport } from '../reality/00';
import { fakeBackend, reply } from '../reality/00/testing';
import { createCommandAttemptKeys } from './attempt-keys';

describe('form command attempt keys', () => {
  it.each([
    ['stock', '/inventory/items', { sku: 'BREAD-1' }, { sku: 'BREAD-2' }],
    ['expiry', '/marketing/coupons/expiry', { batchId: 'batch-1' }, { batchId: 'batch-2' }],
  ])('records new %s submissions across sessions and replays the same attempt', async (prefix, path, first, second) => {
    const backend = fakeBackend();
    const receipts = new Map<string, { body: string; receiptId: string }>();
    backend.on('POST', path, ({ headers, body }) => {
      const key = headers.get('idempotency-key');
      if (!key) return reply(400, { code: 'INVALID_REQUEST' });
      const fingerprint = JSON.stringify(body);
      const saved = receipts.get(key);
      if (saved) return saved.body === fingerprint ? saved : reply(409, { code: 'CONFLICT', reason: 'IDEMPOTENCY_MISMATCH' });
      const created = { body: fingerprint, receiptId: `receipt-${receipts.size + 1}` };
      receipts.set(key, created);
      return reply(201, created);
    });

    const firstSession = createPortTransport(backend.fetch);
    const firstForm = createCommandAttemptKeys(prefix);
    const send = (transport: typeof firstSession, keyFor: typeof firstForm, body: typeof first) =>
      transport.request({ method: 'POST', path, body, idempotencyKey: keyFor(JSON.stringify(body)) });

    expect(backend.calls).toHaveLength(0);
    await expect(send(firstSession, firstForm, first)).resolves.toMatchObject({ receiptId: 'receipt-1' });
    await expect(send(firstSession, firstForm, first)).resolves.toMatchObject({ receiptId: 'receipt-1' });
    await expect(send(createPortTransport(backend.fetch), createCommandAttemptKeys(prefix), second)).resolves.toMatchObject({ receiptId: 'receipt-2' });
    await expect(send(firstSession, firstForm, second)).resolves.toMatchObject({ receiptId: 'receipt-3' });
    await expect(send(firstSession, firstForm, first)).resolves.toMatchObject({ receiptId: 'receipt-1' });
    expect(receipts.size).toBe(3);
  });
});
