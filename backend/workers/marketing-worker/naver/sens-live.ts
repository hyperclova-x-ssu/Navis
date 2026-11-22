import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { validSmsNumber } from '../../../../frontend/server/sens-sms.mjs';
import { createMarketingProvider, type OperationId } from '../../../services/marketing/naver/binding.ts';
import { NaverAdapterError } from '../../../services/marketing/naver/errors.ts';
import { configuredSensSettings, liveAdvertisingText, type SensSettings } from '../../../services/marketing/reality/15/sens-settings.ts';
import { requireSecondConfirmation } from '../../../services/marketing/naver/transport.ts';
import { smsMessageType } from '../../../services/marketing/sms-text.ts';
import { createSensWire, smsDelivery } from './pn13-sens.ts';

export type { SensSettings } from '../../../services/marketing/reality/15/sens-settings.ts';
type Approval = { confirmed: true };
type Send = { settings: SensSettings | null; approval: Approval; to: readonly string[]; body: string; signal?: AbortSignal };
type Outcome = { requestId?: string; sentCount: number; skippedCount: number };
type Delivery = 'delivered' | 'failed' | undefined;
const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;
const mailAddress = (value: string) => value.trim().replace(/@[^@]+$/, domain => domain.toLowerCase());
const phone = (value: string) => value.replace(/[ -]/g, '');
const smsId = /^ncp:sms:kr:[A-Za-z0-9:_-]{1,160}$/;
const mailId = /^ncp:mail:kr:[A-Za-z0-9:_-]{1,160}$/;
const credentialPath = 'mounted-ncp-sens-credentials';
export const liveSensRequested = (env: NodeJS.ProcessEnv = process.env) => env.NAVIS_NCP_SENS_PROVIDER === 'live';

export function loadLiveSens(env: NodeJS.ProcessEnv = process.env, read: (path: string) => string | undefined = path => readFileSync(path, 'utf8')) {
  const directory = env.NAVIS_NCP_SECRETS_DIR;
  if (!liveSensRequested(env) || !directory || !isAbsolute(directory)) return;
  const file = (name: string, limit = 1024) => {
    try {
      const value = read(join(directory, name))?.trim();
      return value && value.length <= limit ? value : undefined;
    } catch { return undefined; }
  };
  const accessKey = file('NCP_ACCESS_KEY');
  const secretKey = file('NCP_SECRET_KEY');
  const sms = file('NCP_SENS_SMS_SERVICE_ID');
  const senderNumber = phone(file('NCP_SENS_SENDER_NUMBER') ?? '');
  const allowed = file('NCP_SENS_TEST_RECIPIENTS', 16 * 1024)?.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!accessKey || !secretKey || !sms || !smsId.test(sms) || !validSmsNumber(senderNumber) || !allowed?.length
    || allowed.some(value => !validSmsNumber(phone(value)) && !email.test(value))) return;
  const mail = file('NCP_SENS_MAIL_SERVICE_ID');
  const senderAddress = file('NCP_SENS_MAIL_SENDER_ADDRESS');
  return {
    serviceIds: { sms, mail: mail && mailId.test(mail) && senderAddress && email.test(senderAddress) ? mail : undefined },
    senderNumber, senderAddress,
    smsRecipients: new Set(allowed.map(phone).filter(validSmsNumber)),
    mailRecipients: new Set(allowed.filter(value => email.test(value)).map(mailAddress)),
    credentials: () => JSON.stringify({ accessKey, secretKey }),
  };
}

function resultCache(now: () => Date) {
  const entries = new Map<string, { until: number; result: Promise<unknown> }>();
  return function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const time = +now();
    const entry = entries.get(key);
    if (entry && entry.until > time) return entry.result as Promise<T>;
    if (!entry && entries.size >= 256) entries.delete(entries.keys().next().value!);
    const pending = { until: time + 15_000, result: read() };
    entries.set(key, pending);
    return pending.result;
  };
}

export function createLiveSens(config: NonNullable<ReturnType<typeof loadLiveSens>>, options: {
  storeId: string; now?: () => Date; fetcher?: typeof fetch;
}) {
  const now = options.now ?? (() => new Date());
  const liveApproval = Symbol();
  const operations: OperationId[] = ['pn13.sms.send', 'pn13.sms.list', 'pn13.sms.get', 'pn13.sms.reservation-status', 'pn13.sms.reservation-delete'];
  if (config.serviceIds.mail) operations.push('pn13.mail.send', 'pn13.mail.request');
  const provider = createMarketingProvider({
    mode: 'live', storeId: options.storeId, providerAccount: 'ncp-sens', operations, now, fetcher: options.fetcher,
    credentialFiles: { sens: credentialPath }, readCredential: config.credentials,
    approve: request => request.approvalScope === liveApproval,
  });
  const wire = createSensWire(provider, { serviceIds: config.serviceIds, clock: { now }, liveApproval });
  const cached = resultCache(now);
  function check(input: Send) {
    if (input.approval?.confirmed !== true) throw new NaverAdapterError('CONFIRMATION_REQUIRED');
    if (!configuredSensSettings(input.settings, config.senderNumber)) throw new NaverAdapterError('NOT_CONFIGURED');
    return input.settings;
  }
  function recipients(input: readonly string[], normalize: (value: string) => string, allowed: ReadonlySet<string>) {
    const unique = [...new Set(input.map(normalize))];
    const to = unique.filter(value => allowed.has(value));
    return { to, skippedCount: unique.length - to.length };
  }
  return {
    async sms(input: Send & { advertising: boolean; reserveTime?: string; approvedContent?: string }): Promise<Outcome> {
      const settings = check(input);
      const { to, skippedCount } = recipients(input.to, phone, config.smsRecipients);
      if (!to.length) return { sentCount: 0, skippedCount };
      const content = input.advertising ? liveAdvertisingText(input.body, settings) : input.body;
      if (input.approvedContent !== undefined && input.approvedContent !== content) throw new NaverAdapterError('NOT_CONFIGURED');
      const kind = smsMessageType(content);
      if (!kind) throw new NaverAdapterError('INVALID_INPUT');
      const result = await wire.sendSms({ from: config.senderNumber, type: kind.type, content,
        contentType: input.advertising ? 'AD' : 'COMM', to, signal: input.signal,
        ...(input.reserveTime && { reserveTime: input.reserveTime, reserveTimeZone: 'Asia/Seoul' as const }) });
      if (result.statusName !== 'success') throw new NaverAdapterError('CONTRACT_VIOLATION');
      return { requestId: result.requestId, sentCount: to.length, skippedCount };
    },
    async mail(input: Send & { title: string }): Promise<Outcome> {
      check(input);
      const { to, skippedCount } = recipients(input.to, mailAddress, config.mailRecipients);
      if (!to.length) return { sentCount: 0, skippedCount };
      if (!config.serviceIds.mail || !config.senderAddress) throw new NaverAdapterError('NOT_CONFIGURED');
      const result = await wire.sendMail({ senderAddress: config.senderAddress, to: to.map(address => ({ address })),
        title: input.title, body: input.body, signal: input.signal });
      if (result.requestCount !== to.length) throw new NaverAdapterError('CONTRACT_VIOLATION');
      return { requestId: result.requestId, sentCount: to.length, skippedCount };
    },
    smsResult(id: string, count: number, signal?: AbortSignal): Promise<Delivery> {
      return cached(`sms:${count}:${id}`, async () => {
        const { messages } = await wire.listSms(id, signal);
        const outcomes = messages.map(smsDelivery);
        if (outcomes.length !== count || outcomes.some(state => !state)) return;
        return outcomes.every(state => state === 'delivered') ? 'delivered' : 'failed';
      });
    },
    mailResult(id: string, signal?: AbortSignal): Promise<Delivery> {
      return cached('mail:' + id, async () => {
        const result = await wire.getMailRequest(id, signal);
        if (result.status === 'COMPLETED') return result.sentCount === result.requestCount ? 'delivered' : 'failed';
        if (['FAILED', 'PARTIAL_FAILED', 'CANCELED'].includes(result.status)) return 'failed';
      });
    },
    reservation: (id: string, signal?: AbortSignal) =>
      cached('reserved:' + id, async () => (await wire.reservationStatus(id, signal)).reserveStatus),
    async cancel(id: string, confirmation: unknown, signal?: AbortSignal) {
      requireSecondConfirmation(confirmation);
      await wire.cancelReservation(id, signal);
    },
  };
}

export type LiveSens = ReturnType<typeof createLiveSens>;
