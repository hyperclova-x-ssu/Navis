import type { approvalInput } from '../../../../packages/approvals/index.ts';
import { cafeBinding, marketingCards, smsBinding } from './card-bindings.ts';
import { readSourceRevision } from '../13/revision.ts';
import { cafePostInput } from '../13/cafe.ts';
import { commandFingerprint } from './commands.ts';
import { get } from './records.ts';
import { noticeCommand, NoticeError, object, uuid } from './wire.ts';
import type { Owner } from './ports.ts';
import type { PoolClient } from 'pg';

export async function approveMarketingCard(db: PoolClient, owner: Owner, input: ReturnType<typeof approvalInput>, at: Date) {
  if (input.operation === 'cafe.post') {
    const command = cafePostInput(input.command);
    const binding = cafeBinding(owner, input.expectedRevision, command);
    if (input.targetRef !== undefined && input.targetRef !== binding.targetRef) throw new NoticeError(400, 'INVALID_REQUEST');
    if (await readSourceRevision(db, owner.storeId, 'community') !== input.expectedRevision) {
      throw new NoticeError(409, 'STALE_REVISION');
    }
    return marketingCards.issue(db, input, binding, at);
  }
  if (input.operation !== 'sms.schedule' && input.operation !== 'sms.cancel') throw new NoticeError(400, 'INVALID_REQUEST');
  const cancel = input.operation === 'sms.cancel';
  const operation = cancel ? 'notice.cancelSms' : 'notice.send';
  const resourceId = uuid(input.targetRef);
  const command = object(input.command, cancel ? [] : ['scheduledFor']);
  const parsed = noticeCommand(operation, { ...command, expectedRevision: input.expectedRevision,
    approvalId: input.approvalId ?? '00000000-0000-4000-8000-000000000000' });
  if (!cancel && !parsed.scheduledFor) throw new NoticeError(400, 'INVALID_SMS_SCHEDULE');
  const row = await get(db, owner.storeId, 'notice', resourceId);
  if (row.revision !== input.expectedRevision) throw new NoticeError(409, 'STALE_REVISION');
  if (!('channel' in row.data) || row.data.channel !== 'sms') throw new NoticeError(400, 'INVALID_SMS_SCHEDULE');
  return marketingCards.issue(db, input, smsBinding({ ...owner, resourceId, operation,
    revision: row.revision, fingerprint: commandFingerprint(operation, resourceId, parsed),
    approvalId: parsed.approvalId!, secondConfirmation: cancel }), at);
}
