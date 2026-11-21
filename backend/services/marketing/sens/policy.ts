import { createHmac } from 'node:crypto';
import { eucKrBytes, SMS_MAX_BYTES, validSmsNumber } from '../../../../frontend/server/sens-sms.mjs';
import { isUuid, sha256 } from '../promo/contracts.ts';

type OwnerScope = { storeId: string; actorId: string };
type SensCredentials = { serviceId: string; accessKey: string; secretKey: string; senderNumber: string };
type TestTarget = { number: string; consentSms: boolean };
type TestSettings = { enabled: boolean; credentials: SensCredentials; targets: ReadonlyMap<string, TestTarget> };
type ReplyDraft = { sampleId: string; sessionId: string; expiresAt: Date; approved: readonly string[] };

export interface SensPolicy {
  settingsForStore(storeId: string): Promise<TestSettings | null>;
  draftForOwner(scope: OwnerScope, draftId: string): Promise<ReplyDraft | null>;
}

export type { OwnerScope };
export type SensCard = {
  source: 'card';
  proposalId: string;
  snapshotRevision: number;
  input: { draftId: string; targetId: string; body: string };
};

const status = {
  BAD_REQUEST: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
  INVALID_REPLY: 422, RATE_LIMITED: 429, SEND_DISABLED: 503,
} as const;

export class SensError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof status, readonly retryAfter?: number) {
    super(code);
    this.status = status[code];
  }
}

export const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

export function confirmedCard(body: unknown, key: unknown): SensCard {
  if (!exactKeys(body, ['source', 'proposalId', 'snapshotRevision', 'input'])
    || body.source !== 'card' || !isUuid(body.proposalId) || key !== `navis:${body.proposalId}`
    || typeof body.snapshotRevision !== 'number' || !Number.isSafeInteger(body.snapshotRevision) || body.snapshotRevision < 0
    || !exactKeys(body.input, ['draftId', 'targetId', 'body']) || !identifier(body.input.draftId)
    || !identifier(body.input.targetId) || typeof body.input.body !== 'string') {
    throw new SensError('BAD_REQUEST');
  }
  const { source, proposalId, snapshotRevision, input: { draftId, targetId, body: reply } } = body;
  return { source, proposalId, snapshotRevision, input: { draftId, targetId, body: reply } };
}

export async function resolveTestTarget(policy: SensPolicy, storeId: string, alias: string) {
  const settings = await policy.settingsForStore(storeId);
  const credentials = settings?.credentials;
  if (settings?.enabled !== true || !credentials || typeof credentials.serviceId !== 'string'
    || !/^[A-Za-z0-9:_-]{1,180}$/.test(credentials.serviceId) || typeof credentials.accessKey !== 'string'
    || !/^[\x21-\x7e]+$/.test(credentials.accessKey) || typeof credentials.secretKey !== 'string'
    || !credentials.secretKey.trim() || !validSmsNumber(credentials.senderNumber)) {
    throw new SensError('SEND_DISABLED');
  }
  const target = settings.targets.get(alias);
  if (validSmsNumber(alias) || target?.consentSms !== true || !validSmsNumber(target.number)) {
    throw new SensError('FORBIDDEN');
  }
  const { number } = target;
  const { senderNumber, serviceId, accessKey, secretKey } = credentials;
  const routingHash = createHmac('sha256', secretKey)
    .update(JSON.stringify([storeId, alias, number, senderNumber, serviceId, accessKey])).digest('hex');
  return { number, senderNumber, routingHash };
}

export async function resolveReply(policy: SensPolicy, scope: OwnerScope, draftId: string) {
  const draft = await policy.draftForOwner(scope, draftId);
  if (!draft || !isUuid(draft.sessionId) || !identifier(draft.sampleId)
    || !Number.isFinite(draft.expiresAt.getTime()) || draft.expiresAt.getTime() <= Date.now()) {
    throw new SensError('NOT_FOUND');
  }
  const parts = draft.approved.filter(validReplyText);
  const approved = new Set(parts);
  for (const first of parts) {
    for (const second of parts) {
      const combined = `${first} ${second}`;
      if (first !== second && validReplyText(combined)) approved.add(combined);
    }
  }
  const replies = new Map(Array.from(approved, text => [sha256(text), text]));
  return { sampleId: draft.sampleId, sessionId: draft.sessionId, replies };
}

function validReplyText(body: string) {
  return !!body.trim() && !body.includes('\u0000') && eucKrBytes(body) <= SMS_MAX_BYTES;
}
