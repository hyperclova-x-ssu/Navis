import { randomUUID } from 'node:crypto';
import type { DeliveryState } from '../../../services/marketing/sens/ledger.ts';
import type { FakeSensTransport, SensSend } from './transport.ts';

type Delivery = Exclude<DeliveryState, 'pending'>;
type FakeMode = 'accepted' | 'lose_after_acceptance' | 'unknown' | 'unknown_with_request_id';
type Receipt = { requestId: string; delivery?: Delivery };

export function createFakeSensTransport(options: {
  send?: (input: SensSend) => FakeMode;
  fenceUnknown?: () => boolean;
} = {}) {
  const receipts = new Map<string, Receipt>();
  const byRequest = new Map<string, Receipt>();
  const fenced = new Set<string>();
  let sendCount = 0;

  const transport: FakeSensTransport = {
    kind: 'fake',
    async send(input, signal) {
      signal.throwIfAborted();
      sendCount++;
      const { dispatchId } = input;
      if (fenced.has(dispatchId)) return { state: 'not_sent' };
      const prior = receipts.get(dispatchId);
      if (prior) return { state: 'accepted', ...prior };
      const mode = options.send?.(input) ?? 'accepted';
      if (mode === 'unknown') return { state: 'unknown' };
      const receipt = { requestId: `fake-${randomUUID()}` };
      receipts.set(dispatchId, receipt);
      byRequest.set(receipt.requestId, receipt);
      if (mode === 'lose_after_acceptance') throw new DOMException('Fake provider response timed out', 'TimeoutError');
      if (mode === 'unknown_with_request_id') return { state: 'unknown', requestId: receipt.requestId };
      return { state: 'accepted', ...receipt };
    },
    async reconcile({ dispatchId, requestId }, signal) {
      signal.throwIfAborted();
      const receipt = receipts.get(dispatchId);
      if (receipt && (!requestId || receipt.requestId === requestId)) return { state: 'accepted', ...receipt };
      if (!receipt && !requestId && (fenced.has(dispatchId) || options.fenceUnknown?.())) {
        fenced.add(dispatchId);
        return { state: 'not_sent' };
      }
      return { state: 'unknown' };
    },
  };

  return {
    ...transport,
    sendCount: () => sendCount,
    setDelivery(requestId: string, delivery: Delivery) {
      const receipt = byRequest.get(requestId);
      if (!receipt) throw new Error('Unknown fake provider receipt');
      receipt.delivery ??= delivery;
    },
  };
}
