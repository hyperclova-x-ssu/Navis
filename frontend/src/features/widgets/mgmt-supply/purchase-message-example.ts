import { PortError, type PortTransport } from '../../../data/reality/00/port';

type Channel = 'sms' | 'mail';
type Receipt = { receiptId: string; channel: Channel; state: 'blocked'; reason: 'NOT_SENT_TEST_MODE'; scheduledAt: null; providerMode: 'virtual' };
const receipts = new WeakMap<object, Map<string, Receipt[]>>();

/** The fixture uses the publication card's same press and confirmation flow with a local, unsent result. */
export function exampleSupplierTransport(scope: object, poId: string, supplierName: string, targets: Partial<Record<Channel, string>>, message: string): PortTransport {
  const orders = receipts.get(scope) ?? new Map<string, Receipt[]>();
  receipts.set(scope, orders);
  const path = `/inventory/purchase-orders/${encodeURIComponent(poId)}/supplier-message`;
  let preview: { previewId: string; channel: Channel } | undefined;
  let approvalId: string | undefined;
  const expiresAt = () => new Date(Date.now() + 10 * 60_000).toISOString();
  return {
    storeId: async () => 'fixture',
    reset: () => undefined,
    async request<T>({ method, path: requested, body }: Parameters<PortTransport['request']>[0]): Promise<T> {
      if (method === 'GET' && requested === path) return { items: orders.get(poId) ?? [] } as T;
      if (method === 'POST' && requested === `${path}/preview`) {
        const channel = (body as { input?: { channel?: Channel } })?.input?.channel;
        const target = channel && targets[channel];
        if (!channel || !target) throw new PortError(409, 'CONFLICT', 'SUPPLIER_CHANNEL_UNAVAILABLE');
        preview = { previewId: crypto.randomUUID(), channel };
        approvalId = undefined;
        return { previewId: preview.previewId, expectedRevision: 1, inputHash: preview.previewId, expiresAt: expiresAt(),
          diff: { supplierName, targetHint: `••••${target.slice(-4)}`, title: '발주 요청', body: message, scheduledAt: null } } as T;
      }
      if (method === 'POST' && requested === '/inventory/approvals' && preview && (body as { previewId?: string })?.previewId === preview.previewId) {
        approvalId = crypto.randomUUID();
        return { approvalId, expiresAt: expiresAt(), requiresConfirmation: false } as T;
      }
      if (method === 'POST' && requested === `${path}/confirm` && preview && approvalId && (body as { approvalId?: string })?.approvalId === approvalId) {
        const receipt = { receiptId: approvalId, channel: preview.channel, state: 'blocked', reason: 'NOT_SENT_TEST_MODE', scheduledAt: null, providerMode: 'virtual' } as const;
        orders.set(poId, [receipt, ...(orders.get(poId) ?? [])].slice(0, 20));
        preview = undefined;
        approvalId = undefined;
        return receipt as T;
      }
      throw new PortError(404, 'NOT_FOUND');
    },
  };
}
