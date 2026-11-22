import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { validSmsNumber } from '../../../../../frontend/server/sens-sms.mjs';
import { inStore } from '../../transaction.ts';
import { classifyMembers, groupIds, type GroupId } from '../19/groups.ts';
import { businessDay, type Clock } from '../19/wire.ts';
import type { Owner, ScheduledSms } from './ports.ts';
import { NoticeError } from './wire.ts';

/**
 * Notice SMS recipient groups (FIX-GAP-B). An opaque `recipientGroupId` names one B19 semantic group of the store
 * (`churn-risk`, `first-visit`, `regular`). The mapping row is created when the owner picks the group and is stable
 * per store and group. Membership comes from the B19 classification at the moment of use; current SMS advertising
 * consent and phone numbers come from Customer B05 through its private Marketing read, never from the browser.
 */
export type RecipientGroup = { recipientGroupId: string; groupId: GroupId };

export async function ensureRecipientGroup(db: PoolClient, storeId: string, groupId: GroupId, now: Date): Promise<RecipientGroup> {
  await db.query(`INSERT INTO marketing.notice_recipient_group (store_id, recipient_group_id, group_id, created_at)
    VALUES ($1,$2,$3,$4) ON CONFLICT (store_id, group_id) DO NOTHING`, [storeId, randomUUID(), groupId, now]);
  const { rows: [row] } = await db.query<RecipientGroup>(`SELECT recipient_group_id AS "recipientGroupId", group_id AS "groupId"
    FROM marketing.notice_recipient_group WHERE store_id=$1 AND group_id=$2`, [storeId, groupId]);
  return row;
}

export async function recipientGroup(db: PoolClient, storeId: string, recipientGroupId: string) {
  const { rows: [row] } = await db.query<RecipientGroup>(`SELECT recipient_group_id AS "recipientGroupId", group_id AS "groupId"
    FROM marketing.notice_recipient_group WHERE store_id=$1 AND recipient_group_id=$2`, [storeId, recipientGroupId]);
  return row ?? null;
}

/** All three groups with their opaque ID (null until first picked) and the B19 member count for the business day. */
export async function listRecipientGroups(db: PoolClient, storeId: string, day: string) {
  const { rows } = await db.query<RecipientGroup>(`SELECT recipient_group_id AS "recipientGroupId", group_id AS "groupId"
    FROM marketing.notice_recipient_group WHERE store_id=$1`, [storeId]);
  const { customers } = await classifyMembers(db, storeId, day);
  return groupIds.map(groupId => ({ groupId, recipientGroupId: rows.find(row => row.groupId === groupId)?.recipientGroupId ?? null,
    memberCount: customers.filter(row => row.groupId === groupId).length }));
}

export function parseGroupId(value: unknown): GroupId {
  const found = groupIds.find(id => id === value);
  if (!found) throw new NoticeError(400, 'INVALID_RECIPIENT_GROUP');
  return found;
}

type CustomerResponse = { items?: { memberId?: unknown; phone?: unknown }[] };

/**
 * `ScheduledSms.recipients` backed by B19 + Customer. `readCustomer` is the composer's authenticated call to
 * `POST /internal/v1/customer/stores/{storeId}/sms-recipients` with the Marketing SMS-recipient credential.
 */
export function createNoticeRecipients(options: {
  pool: Pool;
  senderNumber: string;
  readCustomer(storeId: string, body: { memberIds: string[]; purpose: 'advertising' | 'informational' }): Promise<Response>;
  clock?: Clock;
  now?: () => Date;
}): ScheduledSms['recipients'] {
  if (!validSmsNumber(options.senderNumber)) throw new Error('A registered sender number is required');
  const clock = options.clock ?? { timezone: 'Asia/Seoul', dayStart: '05:00' };
  return async (scope: Owner, recipientGroupId: string, advertising: boolean) => {
    const at = (options.now ?? (() => new Date()))();
    const memberIds = await inStore(options.pool, scope.storeId, async db => {
      const group = await recipientGroup(db, scope.storeId, recipientGroupId);
      if (!group) return null;
      const { customers } = await classifyMembers(db, scope.storeId, businessDay(at, clock));
      return customers.filter(row => row.groupId === group.groupId).map(row => row.memberId).sort();
    });
    if (!memberIds) return null;
    if (!memberIds.length) return { from: options.senderNumber, to: [] };
    const response = await options.readCustomer(scope.storeId, { memberIds, purpose: advertising ? 'advertising' : 'informational' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new NoticeError(503, 'RECIPIENTS_UNAVAILABLE');
    }
    const body = await response.json() as CustomerResponse;
    const allowed = new Set(memberIds);
    const to = (Array.isArray(body.items) ? body.items : []).flatMap(item =>
      typeof item.memberId === 'string' && allowed.has(item.memberId) && validSmsNumber(item.phone) ? [item.phone as string] : []);
    return { from: options.senderNumber, to };
  };
}
