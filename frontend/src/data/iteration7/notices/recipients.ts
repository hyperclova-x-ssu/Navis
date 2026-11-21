import { marketingCohorts } from '../../marketing/derive';
import type { NoticeDraft, NoticeSourceTables } from './types';

/** Same current cohort source used by customer-groups, never a copied member count. */
export function resolveNoticeRecipients(t: NoticeSourceTables, draft: NoticeDraft) {
  const customers = new Map(t.marketing.mktCustomer.filter(c => !c.deletedAt && c.variant === null).map(c => [c.customerId, c]));
  const groups = new Map(marketingCohorts(t.marketing).map(s => [s.customer.customerId, s.group]));
  const candidates = [...new Map(t.memberProfile.flatMap(p => {
    const c = customers.get(p.customerId), group = groups.get(p.customerId) ?? null;
    if (!c || draft.audience === 'group' && (!group || !draft.groupIds.includes(group))) return [];
    // The cafe snapshot carries a masked contact. The example send records member IDs.
    const contact = c.phone?.trim() ?? (c.phoneLast4 ? `masked:${c.phoneLast4}` : '');
    return [[p.memberId, { memberId: p.memberId, customerId: p.customerId, contact, consentSms: c.consentSms, group }] as const];
  })).values()].sort((a, b) => a.memberId.localeCompare(b.memberId));
  const eligible = candidates.filter(c => c.contact !== '' && (draft.contentClass === 'informational' || c.consentSms));
  return { eligibleMemberIds: eligible.map(c => c.memberId), recipientCount: eligible.length, excludedCount: candidates.length - eligible.length, source: candidates };
}
