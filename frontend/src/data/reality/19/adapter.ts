/**
 * F19 · HTTP adapter of the marketing groups / performance / today reads (B19). Every route is an owner-only read:
 * there is no write command in this domain. The reach-out send stays `coupon.sendReachOut` (B14 issuance), so this
 * adapter registers no command binding and a missing one is never replaced by a local fake (see `use-reach-out.ts`).
 */
import type { DomainAdapter, PortReads } from '../00';
import {
  GROUP_IDS, marketingPath, parseChannelReports, parseGroupCustomer, parseGroups, parsePerformance, parseRecommendations,
  type ChannelReportsDto, type GroupCustomerDto, type GroupId, type GroupsSection, type RealGroupsSnapshot,
} from './dto';

const SESSION_CODES: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'STORE_FORBIDDEN', 'TOKEN_EXPIRED']);
const sessionLost = (reason: unknown): boolean => typeof reason === 'object' && reason !== null && 'code' in reason && SESSION_CODES.has(String((reason as { code: unknown }).code));

async function groupsSection(reads: PortReads, signal: AbortSignal) {
  const groups = parseGroups(await reads.one({ resource: 'marketing.groups', path: `${marketingPath}/groups` }, { signal }));
  const lists = await Promise.all(GROUP_IDS.map(async id => {
    const page = await reads.all<unknown>({ resource: `marketing.groups.${id}`, path: `${marketingPath}/groups/${id}/customers`, query: { limit: 200 } }, { signal });
    return [id, page.items.map(parseGroupCustomer), page.complete] as const;
  }));
  const customers: Record<GroupId, readonly GroupCustomerDto[]> = { 'churn-risk': [], 'first-visit': [], regular: [] };
  for (const [id, items] of lists) customers[id] = items;
  return { groups, customers, complete: lists.every(([, , complete]) => complete) };
}

const valueOf = <T,>(result: PromiseSettledResult<T>): T | null => (result.status === 'fulfilled' ? result.value : null);

const performance = async (reads: PortReads, signal: AbortSignal, period: 'this-month' | 'last-month') =>
  parsePerformance(await reads.one({ resource: `marketing.performance.${period}`, path: `${marketingPath}/performance`, query: { period } }, { signal }));

export const groupsAdapter: DomainAdapter = {
  domain: 'groups',
  // Re-read after a member, consent or sale change in another domain, and after promo files and drafts change (today's cells read them).
  sources: ['groups', 'customer-groups', 'marketing-performance', 'marketing-today', 'customers', 'members', 'pos.sales', 'pos.receipts',
    'promo-assets', 'promo-drafts', 'promo-publications', 'promo-jobs', 'inquiries', 'coupons', 'coupon-status'],
  tables: ['realGroups'],
  clear: () => ({ realGroups: undefined }),
  errorKeys: { STALE_REVISION: 'data.real.groups.staleRevision', RECIPIENT_NOT_ELIGIBLE: 'data.real.groups.notEligible' },
  async load({ reads, storeId, signal }) {
    const results = await Promise.allSettled([
      groupsSection(reads, signal),
      Promise.all([performance(reads, signal, 'this-month'), performance(reads, signal, 'last-month')]),
      reads.one({ resource: 'marketing.channel-reports', path: `${marketingPath}/channel-reports` }, { signal }).then(parseChannelReports),
      reads.one({ resource: 'marketing.recommendations', path: `${marketingPath}/recommendations` }, { signal }).then(parseRecommendations),
      reads.one({ resource: 'insight.search-ads', path: '/insight/channel-reports/search-ads' }, { signal }).then(value => parseChannelReports(value, true)),
    ]);
    const rejected = results.flatMap(result => (result.status === 'rejected' ? [result.reason as unknown] : []));
    // Losing the session ends access for every section; if every section failed the domain is in error (with a retry), never an empty store.
    const lost = rejected.find(sessionLost);
    if (lost !== undefined) throw lost;
    if (results.slice(0, 4).every(result => result.status === 'rejected')) throw rejected[0];
    const names: readonly GroupsSection[] = ['groups', 'performance', 'channels', 'today'];
    const failed = names.filter((_, index) => results[index].status === 'rejected');
    const [groups, perf, reports, today, ads] = [valueOf(results[0]), valueOf(results[1]), valueOf(results[2]), valueOf(results[3]), valueOf(results[4])] as const;
    const adsItems = ads?.items.filter(item => item.state === 'ready') ?? [];
    const envelope = reports ?? (adsItems.length ? ads : null);
    const channels: ChannelReportsDto | null = envelope && { ...envelope, items: [...(reports?.items ?? []), ...adsItems] };
    const snapshot: RealGroupsSnapshot = {
      storeId, groups: groups?.groups ?? null, customersComplete: groups?.complete ?? true,
      customers: groups?.customers ?? { 'churn-risk': [], 'first-visit': [], regular: [] },
      performance: { 'this-month': perf?.[0] ?? null, 'last-month': perf?.[1] ?? null }, channels, today, failed,
    };
    const stamps = [groups?.groups, perf?.[0], perf?.[1], channels, today].flatMap(part => (part ? [part.asOf] : []));
    return {
      tables: { realGroups: snapshot },
      asOf: stamps.sort().at(-1)!,
      sourceRevision: Math.max(0, groups?.groups.sourceRevision ?? 0, perf?.[0].sourceRevision ?? 0),
      complete: snapshot.customersComplete,
    };
  },
  commands: [],
};
