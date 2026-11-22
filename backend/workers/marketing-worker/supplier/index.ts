import type { Pool } from 'pg';
import { PermanentStreamError, StreamConsumer } from '../../../packages/streams/consumer.ts';
import type { RedisStreams } from '../../../packages/streams/redis.ts';
import { createMarketingProvider, NaverAdapterError, type MarketingBindingOptions } from '../../../services/marketing/naver/index.ts';
import { createSensWire, smsDelivery, type SensServiceIds } from '../naver/pn13-sens.ts';
import type { LiveSens, SensSettings } from '../naver/sens-live.ts';

export const supplierConsumerGroup = 'marketing-supplier';
export const supplierRequested = 'inventory.supplier_message_requested.v1';
type Channel = 'sms' | 'mail';
type Pending = { receiptId: string; channel: Channel; state: 'ready' | 'dispatching' | 'accepted'; providerId: string | null; providerLive?: true };
type Claim = { channel: Channel; target: string; title: string; body: string; providerLive?: true };
type State = 'accepted' | 'delivered' | 'failed' | 'unknown' | 'blocked';
type Options = {
  inventoryUrl: URL; token: string;
  provider: Omit<MarketingBindingOptions, 'mode'> & { fetcher?: typeof fetch; readCredential?: (path: string) => string };
  serviceIds: SensServiceIds;
  senderNumber: string; senderAddress: string;
  database: Pool; redis: RedisStreams; name: string;
  live?: LiveSens; readSettings?: (storeId: string) => Promise<SensSettings | null>;
};

const identifier = /^[A-Za-z0-9_-]{1,100}$/;
const rejected = new Set(['INVALID_INPUT', 'NOT_CONFIGURED', 'FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED', 'REJECTED']);
const html = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');

export function createSupplierWorker(options: Options) {
  const storeId = options.provider.storeId;
  const provider = createMarketingProvider({ ...options.provider, mode: 'virtual',
    operations: ['pn13.sms.send', 'pn13.sms.list', 'pn13.mail.send', 'pn13.mail.request'] });
  const sens = createSensWire(provider, { serviceIds: options.serviceIds });
  const root = '/internal/v1/inventory/supplier-dispatch/stores/' + storeId;

  async function request<T>(suffix = '', method = 'GET', body?: object): Promise<T> {
    const response = await fetch(new URL(root + suffix, options.inventoryUrl), {
      method, redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { authorization: 'Bearer ' + options.token, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Supplier dispatch endpoint unavailable');
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  const consumer = new StreamConsumer({
    database: options.database, service: 'marketing', producer: 'inventory', group: supplierConsumerGroup,
    name: options.name, redis: options.redis,
    handlers: {
      [supplierRequested]: async (_db, event) => {
        if (event.payload.receiptId !== event.aggregateId
            || Object.keys(event.payload).length !== 1) throw new PermanentStreamError('INVALID_SUPPLIER_MESSAGE_EVENT');
        // Another store's request is not ours to send: acknowledge it without retry or DLQ (RV-GAP-B-7). Its own
        // binding (if any) runs in a separate worker. Only the receipt ID is read; amounts and suppliers are ignored.
        if (event.storeId !== storeId) return;
        await request('/' + event.aggregateId + '/ready', 'POST');
      },
    },
  });

  async function report(receiptId: string, state: State, providerId?: string, reason?: string) {
    const path = '/' + receiptId + '/result';
    const result = { state, providerId, reason };
    try { await request(path, 'POST', result); }
    catch { await request(path, 'POST', result); }
  }

  async function send(row: Pending, draft: Claim, signal: AbortSignal) {
    let providerId: string | undefined;
    try {
      if (draft.providerLive) {
        const live = options.live;
        const settings = await options.readSettings?.(storeId).catch(() => null);
        if (!live || !settings) return await report(row.receiptId, 'blocked', undefined, 'SMS_SETTINGS_REQUIRED');
        const base = { settings, to: [draft.target], approval: { confirmed: true as const },
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) };
        const result = draft.channel === 'sms'
          ? await live.sms({ ...base, body: draft.body, advertising: false })
          : await live.mail({ ...base, title: draft.title, body: html(draft.body) });
        if (!result.sentCount) return await report(row.receiptId, 'blocked', undefined, 'NOT_SENT_TEST_MODE');
        providerId = result.requestId;
      } else {
        const response = draft.channel === 'sms'
        ? await sens.sendSms({ type: 'LMS', contentType: 'COMM', from: options.senderNumber,
          to: [draft.target], content: draft.body, signal })
        : await sens.sendMail({ senderAddress: options.senderAddress, title: draft.title,
          body: html(draft.body), to: [{ address: draft.target }], signal });
        providerId = response.requestId;
      }
    } catch (error) {
      await report(row.receiptId, error instanceof NaverAdapterError && rejected.has(error.code) ? 'failed' : 'unknown');
      return;
    }
    await report(row.receiptId, providerId && identifier.test(providerId) ? 'accepted' : 'unknown', providerId);
  }

  async function reconcile(row: Pending, signal: AbortSignal) {
    if (!row.providerId) throw new Error('Supplier provider receipt missing');
    if (row.providerLive) {
      if (!options.live) return;
      const state = row.channel === 'sms' ? await options.live.smsResult(row.providerId, 1, signal)
        : await options.live.mailResult(row.providerId, signal);
      if (state) await report(row.receiptId, state);
      return;
    }
    if (row.channel === 'sms') {
      const result = await sens.listSms(row.providerId, signal);
      if (result.messages.length !== 1) return;
      const state = smsDelivery(result.messages[0]);
      if (state) await report(row.receiptId, state);
    } else {
      const result = await sens.getMailRequest(row.providerId, signal);
      if (result.status === 'COMPLETED' && result.sentCount === 1) await report(row.receiptId, 'delivered');
      if (['FAILED', 'PARTIAL_FAILED', 'CANCELED'].includes(result.status)) await report(row.receiptId, 'failed');
    }
  }

  async function step(signal: AbortSignal) {
    const pending = await request<Pending[]>();
    let incomplete = false;
    for (const row of pending) {
      signal.throwIfAborted();
      try {
        if (row.state === 'accepted') await reconcile(row, signal);
        else if (row.state === 'dispatching') await report(row.receiptId, 'unknown');
        else {
          const draft = await request<Claim | null>('/' + row.receiptId + '/claim', 'POST');
          if (draft) await send(row, draft, signal);
        }
      } catch {
        incomplete = true;
      }
    }
    if (incomplete) throw new Error('One or more supplier dispatches need reconciliation');
  }
  return { consumer, step };
}
