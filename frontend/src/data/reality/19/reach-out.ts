/**
 * F19 · the consent check before a reach-out (D-347 I13, AC-1596/1598): `POST /marketing/groups/churn-risk/reach-out-check`.
 * It writes nothing. The send itself stays `coupon.sendReachOut` (B14 issuance, R2 SENS) behind an owner card press and is rechecked
 * at commit by the service. A browser that has no HTTP binding for that command must not fall back to the local fixture handler,
 * so the widget asks `useReachOutMode()` first.
 */
import { useMemo } from 'react';
import { PortError, type RealPort } from '../00';
import { useRealPort, useWidgetDataStore } from '../../react';
import { marketingPath, parseReachOutCheck } from './dto';

export type ReachOutCheck =
  | { readonly ok: true; readonly eligibleIds: readonly string[]; readonly blocked: readonly { readonly memberId: string; readonly reason: 'NOT_IN_GROUP' | 'NO_MARKETING_CONSENT' }[] }
  | { readonly ok: false; readonly reason: 'STALE_REVISION' | 'SESSION_ENDED' | 'UNAVAILABLE' };

const SESSION_CODES: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'STORE_FORBIDDEN', 'TOKEN_EXPIRED']);

/** The service checks at most this many recipients per request (`recipientIds` 1..200). */
const CHECK_LIMIT = 200;

/**
 * Asks the service which of these members may receive the marketing text right now, in requests of at most 200 against the same projection revision.
 * A stale projection revision (on any request) re-reads the groups and returns `STALE_REVISION`; the answers of the others are not used.
 */
export async function checkReachOut(port: RealPort, recipientIds: readonly string[], expectedSourceRevision?: number): Promise<ReachOutCheck> {
  const ids = [...new Set(recipientIds)];
  if (ids.length === 0) return { ok: true, eligibleIds: [], blocked: [] };
  try {
    const eligibleIds: string[] = [];
    const blocked: { memberId: string; reason: 'NOT_IN_GROUP' | 'NO_MARKETING_CONSENT' }[] = [];
    for (let start = 0; start < ids.length; start += CHECK_LIMIT) {
      const chunk = ids.slice(start, start + CHECK_LIMIT);
      const raw = await port.transport.request<unknown>({
        method: 'POST', path: `${marketingPath}/groups/churn-risk/reach-out-check`,
        body: { recipientIds: chunk, ...(expectedSourceRevision !== undefined ? { expectedSourceRevision } : {}) },
      });
      const dto = parseReachOutCheck(raw);
      // Never trust more than was asked: a member the service lists as eligible must be one we sent.
      const asked = new Set(chunk);
      if (dto.eligibleIds.some(id => !asked.has(id)) || dto.blocked.some(row => !asked.has(row.memberId))) throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
      eligibleIds.push(...dto.eligibleIds);
      blocked.push(...dto.blocked);
    }
    return { ok: true, eligibleIds, blocked };
  } catch (caught) {
    if (caught instanceof PortError) {
      if (caught.code === 'CONFLICT' && caught.reason === 'STALE_REVISION') { void port.retry('groups'); return { ok: false, reason: 'STALE_REVISION' }; }
      if (SESSION_CODES.has(caught.code)) return { ok: false, reason: 'SESSION_ENDED' };
    }
    return { ok: false, reason: 'UNAVAILABLE' };
  }
}

/** `check` is defined only when the groups domain runs over HTTP; it carries the projection revision the owner is looking at. */
export function useReachOutCheck(): ((recipientIds: readonly string[]) => Promise<ReachOutCheck>) | undefined {
  const port = useRealPort();
  const store = useWidgetDataStore();
  return useMemo(() => (port && port.mode('groups') === 'http'
    ? (recipientIds: readonly string[]) => checkReachOut(port, recipientIds, store.getSnapshot().tables.realGroups?.groups?.sourceRevision)
    : undefined), [port, store]);
}

/**
 * `http`: the groups domain reads the service. `sendOpen`: the reach-out send has an authoritative HTTP binding (B14). With `http` and no binding the send stays closed,
 * because the port would otherwise run the fixture handler and report a send that never happened.
 */
export function useReachOutMode(): { readonly http: boolean; readonly sendOpen: boolean } {
  const port = useRealPort();
  const http = !!port && port.mode('groups') === 'http';
  const sendOpen = !http || port!.route({ type: 'coupon.sendReachOut', recipientIds: [], idempotencyKey: 'probe' }) !== null;
  return { http, sendOpen };
}
