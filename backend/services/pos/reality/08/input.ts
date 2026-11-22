import type { CustomReceipt, CustomTemplateField } from '../../../../../frontend/src/data/iteration7/custom-orders/types.ts';
import { integer, object, PosError, uuid, type PosTx } from '../../wire.ts';
import { validDate } from '../02/terminal.ts';
import { timezone, type FinanceTx } from '../09/input.ts';
import type { MemberSource } from '../05/customer-client.ts';

export type VerifyReference = (scope: { storeId: string; actorId: string; fileId: string }) => Promise<boolean>;
export type OrderDependencies = { customer?: MemberSource; verifyReference?: VerifyReference };
export const stages = ['received', 'quote_pending', 'approval_pending', 'revision_requested', 'payment_pending',
  'in_production', 'production_complete', 'received_by_customer', 'canceled'] as const;
export const pickupStatuses = ['confirmed', 'completed', 'canceled'] as const;
const fieldInputs = ['text', 'single', 'multiple', 'datetime'] as const;
export const receiptFields = ['answers', 'channel', 'productLabel', 'options', 'quantity', 'request', 'referencePhotoKeys',
  'memberId', 'guest', 'desiredPickupAt'] as const;

export function invalid(field: string, reason = 'REQUIRED_FIELD'): never {
  const error = new PosError(400, reason);
  Object.assign(error.result, { field, messageKey: 'data.custom.error.' + reason });
  throw error;
}

export function stale(expectedRevision: number, revision: number) {
  if (expectedRevision !== revision) throw new PosError(409, 'STALE_REVISION', { revision });
}

export function confirm(value: unknown) {
  if (value !== true) throw new PosError(400, 'CONFIRMATION_REQUIRED');
}

export function text(value: unknown, field: string, max: number, empty = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) return invalid(field);
  return value.trim();
}

export function choice<C extends string>(value: unknown, options: readonly C[], field: string): C {
  return options.find(option => option === value) ?? invalid(field);
}

function array<T>(value: unknown, field: string, max: number, parse: (item: unknown) => T, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid(field);
  return value.map(parse);
}

export function stamp(value: unknown, field: string, halfHour = false): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    || !validDate(value.slice(0, 10)) || (halfHour && !['00', '30'].includes(value.slice(14)))) return invalid(field);
  return value;
}

export function future(tx: FinanceTx, value: string, field: string, previous?: string | null) {
  const current = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone(tx), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(tx.at).replace(' ', 'T');
  if (value !== previous && value < current) invalid(field, 'BOOKING_PAST');
}

function unique(ids: string[], field: string) {
  if (new Set(ids).size !== ids.length) invalid(field);
}

function identifier(value: unknown, field: string) {
  const id = text(value, field, 80);
  if (['__proto__', 'constructor', 'prototype'].includes(id)) return invalid(field);
  return id;
}

export function fields(value: unknown): CustomTemplateField[] {
  const result = array(value, 'fields', 30, entry => {
    const input = object(entry, ['fieldId', 'label', 'input', 'required', 'options']);
    const kind = choice(input.input, fieldInputs, 'fields');
    const required = input.required;
    if (typeof required !== 'boolean') return invalid('fields');
    const options = array(input.options, 'options', 40, entry => {
      const row = object(entry, ['optionId', 'label', 'extraAmount']);
      return { optionId: identifier(row.optionId, 'options'), label: text(row.label, 'options', 120), extraAmount: integer(row.extraAmount, 0) };
    }, kind === 'single' || kind === 'multiple' ? 1 : 0);
    unique(options.map(option => option.optionId), 'options');
    return { fieldId: identifier(input.fieldId, 'fields'), label: text(input.label, 'fields', 120), input: kind, required, options };
  }, 1);
  unique(result.map(field => field.fieldId), 'fields');
  return result;
}

function answers(value: unknown, fields: readonly CustomTemplateField[]): CustomReceipt['answers'] {
  const parsed = object(value, fields.map(field => field.fieldId));
  const entries = fields.flatMap(field => {
    const item = parsed[field.fieldId];
    if (item === undefined || item === '' || (Array.isArray(item) && !item.length)) {
      if (field.required) invalid('answers');
      return [];
    }
    const optionIds = field.options.map(option => option.optionId);
    const answer = field.input === 'multiple' ? array(item, 'answers', 40, value => choice(value, optionIds, 'answers'))
      : field.input === 'single' ? choice(item, optionIds, 'answers')
        : field.input === 'datetime' ? stamp(item, 'answers') : text(item, 'answers', 1000);
    if (Array.isArray(answer)) unique(answer, 'answers');
    return [[field.fieldId, answer] as const];
  });
  return Object.fromEntries(entries);
}

export function receipt(input: Record<string, unknown>, templateFields: readonly CustomTemplateField[], allowClearedPhone = false): CustomReceipt {
  const memberId = input.memberId == null ? null : uuid(input.memberId);
  const guest = memberId ? null : object(input.guest, ['name', 'phone']);
  const phone = guest ? text(guest.phone, 'guest', 40, allowClearedPhone) : '';
  if (guest && !(allowClearedPhone && phone === '') && !/^0\d{9,10}$/.test(phoneDigits(phone))) invalid('guest', 'INVALID_PHONE');
  const referencePhotoKeys = array(input.referencePhotoKeys === undefined ? [] : input.referencePhotoKeys, 'referencePhotoKeys', 12, uuid);
  unique(referencePhotoKeys, 'referencePhotoKeys');
  return {
    answers: answers(input.answers, templateFields), productLabel: text(input.productLabel, 'productLabel', 120),
    options: array(input.options === undefined ? [] : input.options, 'options', 30, item => text(item, 'options', 120)),
    quantity: integer(input.quantity, 1, 9999), request: text(input.request === undefined ? '' : input.request, 'request', 3000, true),
    referencePhotoKeys, channel: choice(input.channel, ['phone', 'message', 'visit'], 'channel'), memberId,
    guest: guest ? { name: text(guest.name, 'guest', 120), phone } : null,
    desiredPickupAt: stamp(input.desiredPickupAt, 'desiredPickupAt'),
  };
}

const normalized = (value: string) => value.normalize('NFKC').replace(/[\s·・.,'"\-_()[\]{}]+/g, '').toLowerCase();
function phoneDigits(phone: string) {
  const formatted = phone.normalize('NFKC').trim();
  const digits = formatted.replace(/\D/g, '');
  const domestic = formatted.startsWith('+82') && /^82([1-9]\d{8,9})$/.exec(digits);
  return domestic ? '0' + domestic[1] : digits;
}

export function duplicateIdentity(templateId: string, receipt: CustomReceipt) {
  const { memberId, guest, productLabel, channel: _channel, ...retained } = receipt;
  return { ...retained, templateId, productLabel: normalized(productLabel), customer: memberId ??
    (guest && [normalized(guest.name), phoneDigits(guest.phone)]) };
}

export async function verifyMember(tx: Pick<PosTx, 'storeId'>, deps: OrderDependencies, day: string, memberId: string | null) {
  if (!memberId) return;
  if (!deps.customer) throw new PosError(503, 'CUSTOMER_UNAVAILABLE');
  const result = await deps.customer.member(tx.storeId, memberId, day);
  if (result.memberId !== memberId || !result.active) throw new PosError(404, 'MEMBER_NOT_FOUND');
}

export async function verifyPhotos(tx: Pick<PosTx, 'storeId' | 'actorId'>, deps: OrderDependencies, files: readonly string[]) {
  if (!files.length) return;
  const verify = deps.verifyReference;
  if (!verify) throw new PosError(503, 'PHOTO_SERVICE_UNAVAILABLE');
  const accepted = await Promise.all(files.map(fileId => verify({ storeId: tx.storeId, actorId: tx.actorId, fileId })));
  if (!accepted.every(Boolean)) throw new PosError(404, 'REFERENCE_PHOTO_NOT_FOUND');
}

export function createCustomReferenceVerifier(origin: string, token: string, transport: typeof fetch = fetch): VerifyReference {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !token) {
    throw new Error('Invalid private account origin or token');
  }
  return async ({ storeId, actorId, fileId }) => {
    const route = `/internal/v1/account/stores/${uuid(storeId)}/files/${uuid(fileId)}/custom-reference-photo-verify`;
    const result = await transport(url.origin + route, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-navis-store-id': storeId },
      body: JSON.stringify({ actorId: uuid(actorId) }),
    }).catch(() => { throw new PosError(503, 'PHOTO_SERVICE_UNAVAILABLE'); });
    if (result.status === 204) return true;
    if (result.status === 404) return false;
    throw new PosError(503, 'PHOTO_SERVICE_UNAVAILABLE');
  };
}
