import { createMarketingProvider, NaverAdapterError, type MarketingBindingOptions } from '../../../services/marketing/naver/index.ts';
import { advertisingNight, createSensWire, type SensServiceIds, type SensWire } from '../naver/pn13-sens.ts';
import type { LiveSens, SensSettings } from '../naver/sens-live.ts';

/**
 * Scheduled owner notice SMS dispatcher (FIX-GAP-B, RV-GAP-B-3/5/6). Marketing keeps the schedule in its ledger.
 * At the scheduled minute this worker claims a due dispatch; Marketing re-checks consent, closure and the daytime
 * window right then and returns the current numbers in batches of at most 100. The worker sends each batch through
 * its own PN13 grant and reports the outcome. Numbers stay in memory for that one step and are never logged.
 */
export const noticeSmsOperations = ['pn13.sms.send'] as const;
const requestId = /^[A-Za-z0-9_-]{1,128}$/;
/** Documented refusals or local validation: nothing was sent for that batch. */
const definitive = new Set(['INVALID_INPUT', 'NOT_CONFIGURED', 'LIVE_NOT_APPROVED', 'FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED', 'REJECTED']);

type Due = { dispatchId: string; state: 'scheduled' | 'dispatching' | 'sent'; pendingBatches: number[];
  acceptedBatches?: { batch: number; providerId: string; size: number }[] };
type Claim = { dispatchId: string; type: 'SMS' | 'LMS'; contentType: 'AD'; content: string; from: string;
  providerLive?: boolean; batches: { batch: number; to: string[] }[] };
type Outcome = { state: 'accepted'; providerId: string; skipped?: number }
  | { state: 'not_sent'; skipped: number } | { state: 'failed' | 'unknown' | 'delivered' | 'delivery_failed' };

/** Virtual-only SENS wire scoped to the single PN13 send operation (live stays refused until A6). */
export function noticeSmsWire(binding: Omit<MarketingBindingOptions, 'mode' | 'operations'>, serviceIds: SensServiceIds) {
  const provider = createMarketingProvider({ ...binding, mode: 'virtual', operations: noticeSmsOperations });
  return createSensWire(provider, { serviceIds });
}

export function createNoticeSmsWorker(options: {
  marketingUrl: URL; token: string; storeId: string; sens: SensWire;
  fetcher?: typeof fetch; now?: () => Date;
  live?: LiveSens; readSettings?: (storeId: string) => Promise<SensSettings | null>;
}) {
  const root = '/internal/v1/marketing/notice-sms-dispatch/stores/' + options.storeId;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());

  async function request<T>(suffix = '', method = 'GET', body?: object): Promise<T> {
    const response = await fetcher(new URL(root + suffix, options.marketingUrl), {
      method, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { authorization: 'Bearer ' + options.token, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Notice SMS dispatch endpoint unavailable');
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  async function report(dispatchId: string, batch: number, outcome: Outcome) {
    const path = '/' + dispatchId + '/result';
    const body = { batch, ...outcome };
    try { await request(path, 'POST', body); }
    catch { await request(path, 'POST', body); }
  }

  async function send(claim: Claim, batch: Claim['batches'][number]): Promise<Outcome> {
    if (claim.providerLive) {
      if (!options.live || !options.readSettings || advertisingNight(now())) return { state: 'failed' };
      const settings = await options.readSettings(options.storeId).catch(() => null);
      if (!settings) return { state: 'failed' };
      try {
        const body = claim.content.split('\n').slice(1, -1).join('\n');
        const result = await options.live.sms({ settings, to: batch.to, body, advertising: true, approvedContent: claim.content,
          approval: { confirmed: true }, signal: AbortSignal.timeout(5000) });
        if (result.sentCount === 0) return { state: 'not_sent', skipped: result.skippedCount };
        return result.requestId && requestId.test(result.requestId)
          ? { state: 'accepted', providerId: result.requestId, skipped: result.skippedCount } : { state: 'unknown' };
      } catch (error) {
        return { state: error instanceof NaverAdapterError && definitive.has(error.code) ? 'failed' : 'unknown' };
      }
    }
    // The same attempt key makes the single retry a private idempotent replay on the virtual server.
    const attemptKey = `notice-sms:${claim.dispatchId}:${batch.batch}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (claim.contentType !== 'AD' || advertisingNight(now())) return { state: 'failed' };
        const result = await options.sens.sendSms({ type: claim.type, contentType: 'AD', from: claim.from, to: batch.to,
          content: claim.content, attemptKey, signal: AbortSignal.timeout(5000) });
        return requestId.test(result.requestId) ? { state: 'accepted', providerId: result.requestId } : { state: 'unknown' };
      } catch (error) {
        if (error instanceof NaverAdapterError && definitive.has(error.code)) return { state: 'failed' };
      }
    }
    return { state: 'unknown' };
  }

  async function step(signal?: AbortSignal) {
    const due = await request<Due[]>();
    let incomplete = false;
    for (const row of due) {
      signal?.throwIfAborted();
      try {
        if (row.state === 'sent') {
          if (!options.live) continue;
          for (const batch of row.acceptedBatches ?? []) {
            const state = await options.live.smsResult(batch.providerId, batch.size, signal);
            if (state) await report(row.dispatchId, batch.batch, { state: state === 'delivered' ? state : 'delivery_failed' });
          }
          continue;
        }
        if (row.state === 'dispatching') {
          // A claim older than two minutes lost its worker: never resend, leave it for reconciliation.
          for (const batch of row.pendingBatches) await report(row.dispatchId, batch, { state: 'unknown' });
          continue;
        }
        const claim = await request<Claim | null>('/' + row.dispatchId + '/claim', 'POST');
        if (!claim) continue;
        for (const batch of claim.batches) await report(claim.dispatchId, batch.batch, await send(claim, batch));
      } catch {
        incomplete = true;
      }
    }
    if (incomplete) throw new Error('One or more notice SMS dispatches need another step');
  }
  const couponRecipient = (memberId: string) =>
    request<{ phone: string | null }>('/coupon-recipient', 'POST', { memberId }).then(result => result.phone);
  return { step, couponRecipient };
}
