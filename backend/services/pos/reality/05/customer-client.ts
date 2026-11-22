import { PosError } from '../../wire.ts';

export type Product = { productId: string; name: string; kind: 'count' | 'period'; soldPrice: number;
  totalUses: number | null; validDays: number; dailyLimit: number | null; menuIds: string[]; revision: number };
export type Pass = { membershipId: string; memberId: string; startsOn: string; endsOn: string; usesLeft: number | null;
  status: string; terms: Product; revision: number };
export type Claim = { claimId: string; state: string; commandKey: string };
export type PassClaimInput = { actorId: string; memberId: string; membershipId: string;
  sourceVersion: number; requestKey: string; businessDate: string };
export interface MemberSource {
  member(storeId: string, memberId: string, businessDate: string, productId?: string, membershipId?: string, requestKey?: string):
    Promise<{ memberId: string; memberCode?: string; active: boolean; product: Product | null; pass?: Pass | null; revision?: number }>;
  memberCodes?(storeId: string, memberIds: string[]): Promise<ReadonlyMap<string, string>>;
}
export interface CustomerMemberClient extends MemberSource {
  archive(storeId: string, input: object, undo: boolean): Promise<object>;
  reserve(storeId: string, input: PassClaimInput): Promise<Claim>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function attachMemberCodes<Row extends { memberId: string | null }>(
  storeId: string, rows: Row[], customer?: MemberSource,
): Promise<(Row & { memberCode?: string })[]> {
  const ids = [...new Set(rows.flatMap(row => row.memberId ? [row.memberId] : []))];
  if (!ids.length || !customer?.memberCodes) return rows;
  const codes = await customer.memberCodes(storeId, ids);
  return rows.map(row => {
    const memberCode = row.memberId ? codes.get(row.memberId) : undefined;
    return memberCode ? { ...row, memberCode } : row;
  });
}

export function createCustomerMemberClient(origin: string, token: string, transport: typeof fetch = fetch): CustomerMemberClient {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid private customer origin');
  }
  async function request<T>(storeId: string, path: string, body: object): Promise<T> {
    let response: Response;
    let data: unknown;
    try {
      response = await transport(`${url.origin}/internal/v1/customer/stores/${storeId}${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-navis-store-id': storeId },
        body: JSON.stringify(body),
      });
      data = await response.json();
    } catch {
      throw new PosError(503, 'CUSTOMER_UNAVAILABLE');
    }
    if (!isRecord(data)) throw new PosError(503, 'CUSTOMER_UNAVAILABLE');
    if (!response.ok) {
      const status = response.status;
      if (![400, 404, 409].includes(status) || typeof data.reason !== 'string') throw new PosError(503, 'CUSTOMER_UNAVAILABLE');
      throw new PosError(status, data.reason, isRecord(data.details) ? data.details : undefined);
    }
    return data as T;
  }
  return {
    member: (storeId, memberId, businessDate, productId, membershipId, requestKey) =>
      request(storeId, '/member-source', { memberId, businessDate, productId, membershipId, requestKey }),
    async memberCodes(storeId, memberIds) {
      const result = await request<{ items: unknown }>(storeId, '/member-codes', { memberIds });
      if (!Array.isArray(result.items)) throw new PosError(503, 'CUSTOMER_UNAVAILABLE');
      const allowed = new Set(memberIds);
      const codes = new Map<string, string>();
      for (const row of result.items) {
        if (!isRecord(row) || typeof row.memberId !== 'string' || !allowed.delete(row.memberId)
          || typeof row.memberCode !== 'string' || !/^M-[0-9]{4,19}$/.test(row.memberCode)) {
          throw new PosError(503, 'CUSTOMER_UNAVAILABLE');
        }
        codes.set(row.memberId, row.memberCode);
      }
      return codes;
    },
    archive: (storeId, input, undo) => request(storeId, undo ? '/member-archive/undo' : '/member-archive', input),
    reserve: (storeId, input) => request(storeId, '/member-source/claims', input),
  };
}
