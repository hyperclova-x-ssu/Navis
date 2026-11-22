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
  operating?: boolean;
  reservationBinding?: { actorId: string; tableId: string | null; expiresAt: string } | null;
};
export type SaleLink = { settlementId: string; billId: string; orderId: string };
export type FirstOrderLink = { billId: string; orderId: string; tableId: string | null };
export type PosOutcome =
  | { status: 'pending' | 'missing' | 'aborted' | 'rejected' }
  | { status: 'linked'; order: FirstOrderLink }
  | { status: 'committed'; sale: SaleLink };

export interface PosClient {
  bind(storeId: string, claim: PosClaim): Promise<boolean>;
  outcome(storeId: string, commandKey: string): Promise<PosOutcome | null>;
  abort(storeId: string, claim: PosClaim): Promise<PosOutcome | null>;
  memberArchive?(storeId: string, body: object, undo: boolean): Promise<PrivateMemberResponse | null>;
  useMemberPass?(storeId: string, body: object): Promise<PrivateMemberResponse | null>;
  cancelMemberUse?(storeId: string, body: object): Promise<PrivateMemberResponse | null>;
}
export type PrivateMemberResponse = { status: number; body: Record<string, unknown> };

function parseOutcome(body: unknown): PosOutcome | null {
  if (!isRecord(body)) return null;
  const { status, result } = body;
  if (status === 'pending' || status === 'missing') return result === null ? { status } : null;
  if (!isRecord(result)) return null;
  if (status === 'aborted' || status === 'rejected') {
    return result.ok === false && typeof result.reason === 'string' ? { status } : null;
  }
  if (status === 'linked') {
    const { billId, orderId, tableId } = result;
    return isUuid(billId) && isUuid(orderId) && (tableId === null || isUuid(tableId)) ? { status, order: { billId, orderId, tableId } } : null;
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

  async function memberCommand(storeId: string, path: string, body: object): Promise<PrivateMemberResponse | null> {
    try {
      const response = await transport(`${base.origin}/internal/v1/pos/stores/${storeId}${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-navis-store-id': storeId, 'content-type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(4500),
      });
      const json: unknown = await response.json();
      return isRecord(json) ? { status: response.status, body: json } : null;
    } catch {
      return null;
    }
  }

  return {
    async bind(storeId, claim) {
      if (claim.operating) return false;
      const body = await request(storeId, '/claims', {
        claimId: claim.claimId, commandKey: claim.commandKey, kind: claim.kind,
        sourceId: claim.sourceId, sourceVersion: claim.sourceVersion,
        ...(claim.reservationBinding && { reservationBinding: claim.reservationBinding }),
      });
      return isRecord(body) && body.claimId === claim.claimId && body.commandKey === claim.commandKey
        && body.kind === claim.kind && body.sourceId === claim.sourceId && body.sourceVersion === claim.sourceVersion
        && (!claim.reservationBinding || isRecord(body.reservationBinding) && body.reservationBinding.actorId === claim.reservationBinding.actorId
          && body.reservationBinding.tableId === claim.reservationBinding.tableId && body.reservationBinding.expiresAt === claim.reservationBinding.expiresAt);
    },
    async outcome(storeId, commandKey) {
      return parseOutcome(await request(storeId, `/outcomes/${encodeURIComponent(commandKey)}`));
    },
    async abort(storeId, claim) {
      return parseOutcome(await request(storeId, `/outcomes/${encodeURIComponent(claim.commandKey)}/abort`, { claimId: claim.claimId }));
    },
    memberArchive: (storeId, body, undo) => memberCommand(storeId, undo ? '/member-archive/undo' : '/member-archive', body),
    useMemberPass: (storeId, body) => memberCommand(storeId, '/member-uses/use', body),
    cancelMemberUse: (storeId, body) => memberCommand(storeId, '/member-uses/cancel', body),
  };
}
