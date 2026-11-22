import { approvalFingerprint, cardApprovals } from '../../../../packages/approvals/index.ts';
import type { cafePostInput } from '../13/cafe.ts';
import type { Approval, Owner } from './ports.ts';

export const marketingCards = cardApprovals('marketing');

export function cafeBinding(owner: Owner, expectedRevision: number, input: ReturnType<typeof cafePostInput>) {
  return { ...owner, operation: 'cafe.post', targetRef: `${input.clubid}:${input.menuid}`, expectedRevision,
    fingerprint: approvalFingerprint(input), requiresConfirmation: true };
}

export function smsBinding(input: Approval) {
  const cancel = input.operation === 'notice.cancelSms';
  return { storeId: input.storeId, actorId: input.actorId, operation: cancel ? 'sms.cancel' : 'sms.schedule',
    targetRef: input.resourceId, expectedRevision: input.revision, fingerprint: input.fingerprint, requiresConfirmation: cancel };
}
