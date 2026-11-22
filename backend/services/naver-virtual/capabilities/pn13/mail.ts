import { randomUUID } from 'node:crypto';
import type { MailAcceptance, MailRequestResult } from '../../../../packages/naver/contracts/pn13/index.ts';
import type { Data, MessageRow, RequestRow } from './database.ts';
import { completionTime, kst, object, onlyKeys, strings } from './messages.ts';

const mailbox = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.(?:test|invalid|example)$/i;
const shortName = (value: unknown) => value === undefined || typeof value === 'string' && Buffer.byteLength(value) <= 69;

export function isoDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time : undefined;
}

function mailDate(time: Date) {
  return kst(time) + '+09:00';
}

export function mailDraft(body: unknown, sender: string | undefined, now: Date) {
  if (!object(body) || !onlyKeys(body, ['senderAddress', 'senderName', 'title', 'body', 'recipients', 'parameters',
    'individual', 'confirmAndSend', 'advertising', 'reservationDateTime'])
    || typeof body.senderAddress !== 'string' || !mailbox.test(body.senderAddress) || body.senderAddress !== sender
    || !shortName(body.senderName)
    || typeof body.title !== 'string' || Buffer.byteLength(body.title) > 500
    || typeof body.body !== 'string' || Buffer.byteLength(body.body) > 500_000
    || body.advertising !== undefined && body.advertising !== false
    || body.individual !== undefined && typeof body.individual !== 'boolean'
    || body.confirmAndSend !== undefined && typeof body.confirmAndSend !== 'boolean'
    || body.parameters !== undefined && !strings(body.parameters)
    || !Array.isArray(body.recipients) || !body.recipients.length || body.recipients.length > 100_000) return undefined;

  const scheduledAt = body.reservationDateTime === undefined ? null : isoDate(body.reservationDateTime);
  if (scheduledAt === undefined || scheduledAt && (scheduledAt <= now || scheduledAt.getTime() - now.getTime() > 30 * 86400_000)) return undefined;

  const recipients: { address: string; type: string; name: string | null; parameters: Record<string, string> }[] = [];
  const individual = body.individual ?? true;
  for (const entry of body.recipients) {
    if (!object(entry) || !onlyKeys(entry, ['address', 'name', 'type', 'parameters'])
      || typeof entry.address !== 'string' || entry.address.length > 254 || !mailbox.test(entry.address)
      || !shortName(entry.name) || (entry.parameters !== undefined && !strings(entry.parameters))) return undefined;
    const type = entry.type ?? 'TO';
    if (typeof type !== 'string' || !['TO', 'CC', 'BCC'].includes(type) || individual && type !== 'TO') return undefined;
    recipients.push({ address: entry.address, type, name: typeof entry.name === 'string' ? entry.name : null,
      parameters: body.parameters ?? entry.parameters ?? {} });
  }
  if (!recipients.some(entry => entry.type === 'TO')
    || ['CC', 'BCC'].some(type => recipients.filter(entry => entry.type === type).length > 30)) return undefined;

  const groups = individual ? recipients.map(entry => [entry]) : Array.from({ length: Math.ceil(recipients.length / 30) },
    (_, index) => recipients.slice(index * 30, (index + 1) * 30));
  const messages: { id: string; data: Data }[] = [];
  for (const group of groups) {
    const groupTitle = substitute(body.title, group[0].parameters);
    const groupBody = substitute(body.body, group[0].parameters);
    if (groupTitle === undefined || groupBody === undefined || Buffer.byteLength(groupTitle) > 500
      || Buffer.byteLength(groupBody) > 500_000
      || group.some(entry => substitute(body.title as string, entry.parameters) !== groupTitle
        || substitute(body.body as string, entry.parameters) !== groupBody)) return undefined;
    messages.push({ id: randomUUID(), data: {
      title: groupTitle, body: groupBody,
      recipients: group.map(({ address, name, type }) => ({ address, name, type })),
    } });
  }
  return {
    scheduledAt, messages, payload: {
      senderAddress: sender, senderName: body.senderName ?? null, confirmAndSend: body.confirmAndSend ?? false,
    },
  };
}

function substitute(template: string, values: Record<string, string>) {
  let missing = false;
  const text = template.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) missing = true;
    return values[key] ?? '';
  });
  return missing ? undefined : text;
}

export function mailAcceptance(row: RequestRow, count: number): MailAcceptance {
  return { requestId: row.request_id, requestCount: count, createDateTime: mailDate(row.accepted_at) };
}

type Recipient = { address: string; name: string | null; type: string };

function mailState(row: MessageRow, now: Date) {
  const recipients = row.message.recipients as Recipient[];
  const failure = recipients.filter(entry => entry.address.toLowerCase().startsWith('undeliverable@')).length;
  const sent = recipients.length - failure;
  if (row.payload.confirmAndSend) return { status: 'READY' as const, recipients, sent: 0, completed: undefined };
  const completed = completionTime(row, now);
  if (!completed) return { status: 'RESERVED' as const, recipients, sent: 0, completed };
  const status = failure === 0 ? 'COMPLETED' as const : sent === 0 ? 'FAILED' as const : 'PARTIAL_FAILED' as const;
  return { status, recipients, completed, sent };
}

export function mailRequest(row: RequestRow, rows: MessageRow[], now: Date): MailRequestResult {
  const entries = rows.map(message => mailState(message, now));
  const ready = entries.filter(entry => entry.status === 'READY').length;
  const reserved = entries.filter(entry => entry.status === 'RESERVED').length;
  const completed = entries.filter(entry => entry.status === 'COMPLETED').length;
  const failed = entries.filter(entry => entry.status === 'FAILED').length;
  const partial = entries.filter(entry => entry.status === 'PARTIAL_FAILED').length;
  const statuses = [
    { status: 'READY' as const, count: ready }, { status: 'RESERVED' as const, count: reserved },
    { status: 'COMPLETED' as const, count: completed }, { status: 'FAILED' as const, count: failed + partial },
  ];
  const status = ready ? 'READY' : reserved ? 'RESERVED' : failed === entries.length ? 'FAILED'
    : failed || partial ? 'PARTIAL_FAILED' : 'COMPLETED';
  return { ...mailAcceptance(row, entries.length), status, readyCount: entries.length,
    sentCount: completed, finishCount: completed + partial + failed,
    reservationDateTime: row.scheduled_at ? mailDate(row.scheduled_at) : null,
    countsByStatus: statuses.filter(bucket => bucket.count > 0),
  };
}

export function mailResult(row: MessageRow, now: Date, detailed: boolean) {
  const state = mailState(row, now);
  const common = {
    requestId: row.request_id, mailId: row.message_id, createDateTime: mailDate(row.accepted_at),
    title: row.message.title, templateNo: null, templateName: null, status: state.status,
    senderAddress: row.payload.senderAddress, senderName: row.payload.senderName,
    sendDateTime: state.completed ? mailDate(state.completed) : null, advertising: false,
  };
  if (!detailed) return { ...common, representativeRecipient: state.recipients[0].address,
    recipientCount: state.recipients.length, sendType: row.scheduled_at ? 'RESERVED' : 'IMMEDIATE',
  };
  return {
    ...common, requesterIp: '192.0.2.1', reservationDateTime: row.scheduled_at ? mailDate(row.scheduled_at) : null,
    body: row.message.body, attachFiles: [],
    recipients: state.recipients.map(entry => {
      const failed = entry.address.toLowerCase().startsWith('undeliverable@');
      return { ...entry, received: false, receivedDateTime: null,
        status: !state.completed ? state.status : failed ? 'FAILED' : 'COMPLETED', retryCount: 0,
        ...(state.completed && { sendResultCode: failed ? 'RECIPIENT_ADDRESS_ERROR' : 'MAIL_SENT',
          sendResultMessage: failed ? '550 5.1.1 No such user' : 'Mail sent.' }),
      };
    }),
  };
}

export function mailListItem(row: RequestRow, rows: MessageRow[], now: Date) {
  const view = mailRequest(row, rows, now);
  const completed = ['COMPLETED', 'FAILED', 'PARTIAL_FAILED'].includes(view.status) ? completionTime(row, now) : undefined;
  return {
    requestId: view.requestId, createDateTime: view.createDateTime, status: view.status,
    templateNo: null, templateName: null, senderAddress: row.payload.senderAddress, senderName: row.payload.senderName,
    dispatchType: 'API', elapsedTime: completed ? '00:00:00.000' : null,
    sendDateTime: completed ? mailDate(completed) : null, reservationDateTime: view.reservationDateTime,
    requestCount: view.requestCount,
    recipientCount: rows.reduce((count, message) => count + (message.message.recipients as Recipient[]).length, 0),
  };
}
