import type { PublicationConfirm, PublicationPreview } from '../../../../../backend/services/inventory/reality/01/publication-dto';
import { PortError, type PortTransport } from '../00/port';

export type PublicationTarget = {
  path: string;
  readPath?: string;
  operation: 'place.menu.publish' | 'place.venue.publish' | 'commerce.stock.set' | 'supplier.message.send';
  resourceId: string;
};

export type PublicationApproval = {
  approvalId: string;
  expiresAt: string;
  requiresConfirmation: boolean;
};

export function publication<Input = unknown, View = unknown, Read = unknown, Receipt = unknown>(
  transport: PortTransport, { path, readPath = path, operation, resourceId }: PublicationTarget,
) {
  return {
    read: (signal?: AbortSignal) => transport.request<Read>({ method: 'GET', path: readPath, signal }),
    async preview(input: Input, signal?: AbortSignal): Promise<PublicationPreview<View>> {
      const card = await transport.request<PublicationPreview<View>>({
        method: 'POST', path: path + '/preview', body: { input }, signal,
      });
      if (typeof card?.previewId !== 'string' || !card.previewId || typeof card.inputHash !== 'string' || !card.inputHash
          || !Number.isSafeInteger(card.expectedRevision) || card.expectedRevision < 0
          || !Number.isFinite(Date.parse(card.expiresAt)) || !card.diff) {
        throw new PortError(502, 'SERVICE_UNAVAILABLE', 'INVALID_PREVIEW_RESPONSE');
      }
      return card;
    },
    async press({ expectedRevision, previewId }: PublicationPreview<View>, signal?: AbortSignal): Promise<PublicationApproval> {
      const approval = await transport.request<PublicationApproval>({
        method: 'POST', path: '/inventory/approvals',
        body: { stage: 'press', operation, resourceId, expectedRevision, previewId }, signal,
      });
      if (typeof approval?.approvalId !== 'string' || !approval.approvalId || !Number.isFinite(Date.parse(approval.expiresAt)) || typeof approval.requiresConfirmation !== 'boolean') {
        throw new PortError(502, 'SERVICE_UNAVAILABLE', 'INVALID_APPROVAL_RESPONSE');
      }
      return approval;
    },
    confirm({ previewId, expectedRevision }: PublicationPreview<View>, { approvalId }: PublicationApproval, signal?: AbortSignal) {
      const body: PublicationConfirm = { approvalId, expectedRevision, previewId };
      return transport.request<Receipt>({ method: 'POST', path: path + '/confirm', body, idempotencyKey: approvalId, signal });
    },
  };
}
