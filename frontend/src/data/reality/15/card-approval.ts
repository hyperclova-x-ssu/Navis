/**
 * The owner-card approval issuer of Marketing (CARD-AUTH, MKT-2 shape): `POST /marketing/approvals` for Café posts (PN17) and SMS
 * reservations (PN13). The press records the owner's card press; `confirm` records the second press of an extra-confirmation card.
 * An approval lasts 60 seconds and is consumed by the one write that carries its `approvalId` (in the body, or in the Café key `navis:<id>`).
 * Typed or spoken text never reaches this module: only a button handler or a card press calls it.
 */
import { PortError, type PortRequest } from '../00';

export const CARD_APPROVALS = '/marketing/approvals';

export type CardOperation = 'cafe.post' | 'sms.schedule' | 'sms.cancel';
export interface CardIntent {
  readonly operation: CardOperation;
  readonly targetRef: string;
  readonly command: Readonly<Record<string, unknown>>;
  readonly expectedRevision: number;
}
export interface CardApproval { readonly approvalId: string; readonly expiresAt?: string }

type Request = (request: PortRequest) => Promise<unknown>;

/** One stage of the owner's card. `attemptKey` keeps a resend of the same press from creating a second approval. */
export async function issueCardApproval(request: Request, intent: CardIntent, attemptKey: string, stage: 'press' | 'confirm', approvalId?: string, signal?: AbortSignal): Promise<CardApproval> {
  const response = await request({
    method: 'POST', path: CARD_APPROVALS, idempotencyKey: `${attemptKey}:${stage}`, ...(signal ? { signal } : {}),
    body: { ...intent, stage, ...(approvalId ? { approvalId } : {}) },
  }) as { readonly approvalId?: unknown; readonly expiresAt?: unknown } | null;
  if (!response || typeof response.approvalId !== 'string') throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
  if (approvalId && response.approvalId !== approvalId) throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
  return { approvalId: response.approvalId, ...(typeof response.expiresAt === 'string' ? { expiresAt: response.expiresAt } : {}) };
}

/** The approval has run out (60 seconds): the owner presses the card again. */
export const cardApprovalExpired = (approval: Pick<CardApproval, 'expiresAt'>, now = Date.now()) =>
  approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= now;
