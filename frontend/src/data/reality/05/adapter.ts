import { defineBinding, PortError, type CommandContext, type DomainAdapter, type PortReads } from '../00';
import { memberDate, projectMemberTables, type MemberAccountDto, type MemberDto, type MemberPassDto, type MemberProductDto, type MemberUseDto } from './dto';
import type { MemberAccountTxn } from '../../iteration7/accounts';

const item = (path: string, id: string) => `${path}/${encodeURIComponent(id)}`;
const customerPath = (ctx: CommandContext, memberId: string) => item('/customers', ctx.snapshot.tables.realMembers?.profiles[memberId]?.customerId ?? memberId);
const notesPath = (memberId: string) => `${item('/members', memberId)}/notes`;
const usesPath = (membershipId: string) => `${item('/memberships', membershipId)}/uses`;
const revision = (ctx: CommandContext, prefix: string, id: string) => {
  const value = ctx.revision(`${prefix}:${id}`);
  if (value === undefined) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
  return value;
};

const saved = 'data.management.notice.saved';
const deleted = 'data.management.notice.deleted';
const memberReceipt = { noticeKey: saved, receiptBase: '/members' } as const;

/** The service APIs page ledger and use history per parent. Bound parallel requests for a roster refresh. */
async function histories<T>(reads: PortReads, resource: string, paths: readonly string[], signal: AbortSignal) {
  const pages = [];
  for (let index = 0; index < paths.length; index += 8) {
    const batch = await Promise.all(paths.slice(index, index + 8).map(path => reads.all<T>({ resource, path, query: { limit: 200 } }, { signal })));
    pages.push(...batch);
  }
  return pages;
}

export const membersAdapter: DomainAdapter = {
  domain: 'members',
  sources: ['customers', 'members', 'memberships', 'pos.member-accounts'],
  tables: ['realMembers', 'memberProfile', 'memberNote', 'membershipProduct', 'membership', 'membershipUse', 'marketing'],
  clear(snapshot) {
    return { realMembers: undefined, marketing: { ...snapshot.tables.marketing, mktCustomer: [], mktVisit: [] } };
  },
  errorKeys: {
    DUPLICATE_MEMBER_PHONE: 'data.management.error.MEMBER_PHONE_EXISTS',
    MEMBER_INVALID: 'data.management.error.MEMBER_INVALID',
    MEMBER_HAS_OPEN_BALANCE: 'data.management.error.MEMBER_HAS_OPEN_BALANCE',
    MEMBER_DELETE_BLOCKED: 'data.management.error.MEMBER_HAS_OPEN_BALANCE',
    NOTE_REQUIRED: 'data.management.error.NOTE_REQUIRED',
    POS_CONTEXT_REQUIRED: 'data.money.error.POS_CONTEXT_REQUIRED',
    MEMBERSHIP_POS_CONTEXT_REQUIRED: 'data.money.error.POS_CONTEXT_REQUIRED',
  },
  async load({ reads, snapshot, signal }) {
    const list = <T>(resource: string, path: string) => reads.all<T>({ resource, path, query: { limit: 200 } }, { signal });
    const [profiles, products, passes, accounts] = await Promise.all([
      list<MemberDto>('customers', '/customers'), list<MemberProductDto>('membership-products', '/membership-products'),
      list<MemberPassDto>('memberships', '/memberships'), list<MemberAccountDto>('pos.member-accounts', '/pos/member-accounts'),
    ]);
    const [entries, uses] = await Promise.all([
      histories<MemberAccountTxn & { readonly businessDate?: string }>(reads, 'pos.member-entries',
        accounts.items.filter(account => account.hasEntries !== false).map(account => memberEntriesPath(account.memberId)), signal),
      histories<MemberUseDto>(reads, 'membership-uses', passes.items.map(p => usesPath(p.membershipId)), signal),
    ]);
    const pages = [profiles, products, passes, accounts, ...entries, ...uses];
    const revisions = Object.fromEntries([
      ...profiles.items.flatMap(m => [[`member:${m.memberId}`, m.revision], ...m.notes.map(n => [`note:${n.noteId}`, n.revision])]),
      ...passes.items.map(p => [`membership:${p.membershipId}`, p.revision]),
    ]);
    const txns = entries.flatMap(page => page.items);
    return {
      tables: projectMemberTables({ profiles: Object.fromEntries(profiles.items.map(m => [m.memberId, m])), products: products.items,
        passes: passes.items, uses: uses.flatMap(page => page.items).sort((a, b) => a.usedAt.localeCompare(b.usedAt) || a.useId.localeCompare(b.useId)), entries: txns,
        accounts: Object.fromEntries(accounts.items.map(a => [a.memberId, a])),
        businessDates: Object.fromEntries(txns.filter(t => t.businessDate !== undefined).map(t => [t.txnId, t.businessDate!])),
        businessDate: memberDate(profiles.asOf) }, snapshot.tables.marketing),
      revisions, asOf: profiles.asOf, sourceRevision: Math.max(...pages.map(p => p.sourceRevision)), complete: pages.every(p => p.complete),
    };
  },
  commands: [
    defineBinding({ type: 'members.create', ...memberReceipt, request: ({ name, phone }) => ({ method: 'POST', path: '/customers', body: { name, phone } }) }),
    defineBinding({ type: 'members.update', ...memberReceipt, request: ({ memberId, name, phone }, ctx) => ({ method: 'PATCH',
      path: customerPath(ctx, memberId), body: { ...(name !== undefined ? { name } : {}), ...(phone !== undefined ? { phone } : {}) }, expectedRevision: revision(ctx, 'member', memberId) }) }),
    defineBinding({ type: 'members.setGrade', ...memberReceipt, request: ({ memberId, grade }, ctx) => ({ method: 'PATCH',
      path: customerPath(ctx, memberId), body: { grade }, expectedRevision: revision(ctx, 'member', memberId) }) }),
    defineBinding({ type: 'members.delete', ...memberReceipt, noticeKey: deleted, request: ({ memberId }, ctx) => ({ method: 'DELETE',
      path: customerPath(ctx, memberId), body: { confirmed: true }, expectedRevision: revision(ctx, 'member', memberId) }) }),
    defineBinding({ type: 'members.setConsent', ...memberReceipt, request: ({ memberId, contactAllowed, marketingAllowed }, ctx) => ({ method: 'PATCH',
      path: `${customerPath(ctx, memberId)}/consents`, body: { contactAllowed, marketingAllowed }, expectedRevision: revision(ctx, 'member', memberId) }) }),
    defineBinding({ type: 'members.addNote', ...memberReceipt, request: ({ memberId, body }, ctx) => ({ method: 'POST',
      path: notesPath(memberId), body: { body }, expectedRevision: revision(ctx, 'member', memberId) }) }),
    defineBinding({ type: 'members.updateNote', ...memberReceipt, request: ({ memberId, noteId, body }, ctx) => ({ method: 'PATCH',
      path: item(notesPath(memberId), noteId), body: { body }, expectedRevision: revision(ctx, 'note', noteId) }) }),
    defineBinding({ type: 'members.deleteNote', ...memberReceipt, noticeKey: deleted, request: ({ memberId, noteId }, ctx) => ({ method: 'DELETE',
      path: item(notesPath(memberId), noteId), expectedRevision: revision(ctx, 'note', noteId), body: { confirmed: true } }) }),
    defineBinding({ type: 'memberships.useOnce', noticeKey: saved, request: ({ membershipId, billId, allocationId, quantity }, ctx) => {
      if (!billId || !allocationId || quantity !== 1) throw new PortError(400, 'VALIDATION', 'POS_CONTEXT_REQUIRED');
      return { method: 'POST', path: usesPath(membershipId), body: { billId, allocationId, quantity }, expectedRevision: revision(ctx, 'membership', membershipId) };
    } }),
    defineBinding({ type: 'memberships.cancelUse', noticeKey: saved, request: ({ useId }, ctx) => {
      const use = ctx.snapshot.tables.realMembers?.uses.find(row => row.useId === useId);
      if (!use) throw new PortError(404, 'NOT_FOUND');
      return { method: 'POST', path: `${item(usesPath(use.membershipId), useId)}/cancel`, body: { confirmed: true } };
    } }),
    defineBinding({ type: 'memberAccounts.recordFunding', noticeKey: saved, request: ({ target, splits, terminal, expectedRevision }) => {
      const { memberId, ...funding } = target;
      return { method: 'POST', path: memberEntriesPath(memberId), body: { ...funding, splits, terminal }, expectedRevision };
    } }),
    defineBinding({ type: 'memberAccounts.recordRefund', noticeKey: saved, request: ({ fundingId, amount, confirmed, terminal, expectedRevision }) => ({
      method: 'POST', path: `${memberFundingPath(fundingId)}/refunds`, body: { amount, confirmed, terminal }, expectedRevision,
    }) }),
  ],
};

export const memberAccountPath = (memberId: string) => item('/pos/member-accounts', memberId);
export const memberEntriesPath = (memberId: string) => `${memberAccountPath(memberId)}/entries`;
export const memberFundingPath = (fundingId: string) => item('/pos/member-funding', fundingId);
