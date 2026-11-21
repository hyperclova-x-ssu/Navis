export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type ClaimKind = 'reservation_first_order' | 'membership_use';
export type PosClaim = {
  claimId: string;
  commandKey: string;
  kind: ClaimKind;
  sourceId: string;
  sourceVersion: number;
};
export type SaleLink = { settlementId: string; billId: string; orderId: string };
export type PosOutcome =
  | { status: 'pending' | 'missing' | 'aborted' | 'rejected' }
  | { status: 'committed'; sale: SaleLink };

export interface PosClient {
  bind(storeId: string, claim: PosClaim): Promise<boolean>;
  outcome(storeId: string, commandKey: string): Promise<PosOutcome | null>;
  abort(storeId: string, claim: PosClaim): Promise<PosOutcome | null>;
}

function parseOutcome(body: unknown): PosOutcome | null {
  if (!isRecord(body)) return null;
  const { status, result } = body;
  if (status === 'pending' || status === 'missing') return result === null ? { status } : null;
  if (!isRecord(result)) return null;
  if (status === 'aborted' || status === 'rejected') {
    return result.ok === false && typeof result.reason === 'string' ? { status } : null;
  }
  if (status !== 'committed' || result.ok !== true || result.status !== 'applied' || !isRecord(result.value)) return null;
  const { settlementId, billId, orderIds, purpose, settled } = result.value;
  if (purpose !== 'sale' || settled !== true || !isUuid(settlementId) || !isUuid(billId)
    || !Array.isArray(orderIds) || orderIds.length !== 1 || !isUuid(orderIds[0])) return null;
  return { status, sale: { settlementId, billId, orderId: orderIds[0] } };
}

export function createPosClient(origin: string, token: string, transport: typeof fetch = fetch): PosClient {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid private POS origin');

  async function request(storeId: string, path: string, body?: object): Promise<unknown> {
    try {
      const response = await transport(`${base.origin}/internal/v1/pos/stores/${storeId}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'x-navis-store-id': storeId,
          ...(body && { 'content-type': 'application/json' }),
        },
        body: body && JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return await response.json();
      await response.body?.cancel();
    } catch {
      // A transport failure can leave a committed write on the POS side.
    }
    return null;
  }

  return {
    async bind(storeId, claim) {
      const body = await request(storeId, '/claims', {
        claimId: claim.claimId, commandKey: claim.commandKey, kind: claim.kind,
        sourceId: claim.sourceId, sourceVersion: claim.sourceVersion,
      });
      return isRecord(body) && body.claimId === claim.claimId && body.commandKey === claim.commandKey
        && body.kind === claim.kind && body.sourceId === claim.sourceId && body.sourceVersion === claim.sourceVersion;
    },
    async outcome(storeId, commandKey) {
      return parseOutcome(await request(storeId, `/outcomes/${encodeURIComponent(commandKey)}`));
    },
    async abort(storeId, claim) {
      return parseOutcome(await request(storeId, `/outcomes/${encodeURIComponent(claim.commandKey)}/abort`, { claimId: claim.claimId }));
    },
  };
}
