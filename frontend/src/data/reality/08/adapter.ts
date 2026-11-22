/**
 * REAL-PLAN F08 — the `custom` domain on the F00 port: UI → api-gateway → POS service (B08) → its PostgreSQL DB.
 * Command names and arguments are the widget's and Navis' own (`customOrder.quote`, `pickup.reschedule` …); only the
 * implementation moves from the store to HTTP. Payments are RECORDED (the store's terminal or cash): no provider is called.
 */
import { defineBinding, PortError, type CommandContext, type CommandOf, type CommandRequest, type DomainAdapter } from '../00';
import type { CustomOrderCommand } from '../../iteration7/custom-orders/types';
import { customOrderKey, customPickupKey, customTemplateKey, projectCustom, type CustomOrderDto, type CustomPickupDto, type CustomTemplateDto } from './dto';

const pos = '/pos';
export const customTemplatesPath = `${pos}/custom-templates`;
export const customOrdersPath = `${pos}/custom-orders`;
export const customPickupsPath = `${pos}/custom-pickups`;
/** B08: `POST /pos/custom-receipts/receipts/:id/undo` — templates, a rescheduled pickup and an advance-paid pickup receipt. */
const receiptBase = `${pos}/custom-receipts`;
const changed = 'data.custom.notice.changed';
const common = { noticeKey: changed, receiptBase } as const;
const item = (base: string, id: string) => `${base}/${encodeURIComponent(id)}`;
const PAGE = 50;
/** Reference photos picked in the browser travel as data URLs until the account service stores them. */
export const REFERENCE_PHOTO_PURPOSE = 'custom-reference-photo';

function expected(context: CommandContext, key: string): number {
  const value = context.revision(key);
  if (value === undefined) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
  return value;
}

const without = (command: object, drop: readonly string[]) =>
  Object.fromEntries(Object.entries(command).filter(([name, value]) => value !== undefined && !drop.includes(name)));
const META = ['type', 'idempotencyKey', 'baseRevision', 'customOrderId', 'reversiblePickup'] as const;

/** Newly picked photos (data URLs) are stored once by content hash; ids that already exist stay as they are. */
async function photoIds(context: CommandContext, keys: readonly string[] | undefined): Promise<readonly string[] | undefined> {
  if (!keys) return undefined;
  const ids: string[] = [];
  for (const key of keys) ids.push(key.startsWith('data:') ? (await context.files.uploadDataUrl(REFERENCE_PHOTO_PURPOSE, key)).fileId : key);
  return ids;
}

function transition<T extends CustomOrderCommand['type']>(type: T, extra: (command: CommandOf<T>) => object = () => ({})) {
  return defineBinding({
    type, ...common,
    request: (command: CommandOf<T>, context: CommandContext): CommandRequest => {
      const { customOrderId } = command as unknown as { customOrderId: string };
      return { method: 'POST', path: `${item(customOrdersPath, customOrderId)}/transitions`, body: { type, ...extra(command) },
        expectedRevision: expected(context, customOrderKey(customOrderId)) };
    },
  });
}

export const customAdapter: DomainAdapter = {
  domain: 'custom',
  sources: ['custom-order', 'custom'],
  tables: ['customTemplate', 'customOrder', 'realCustom'],
  /** F00 scope reset: arrays are emptied by the port; the pickups and payment views live in one scoped object. */
  clear() { return { realCustom: undefined }; },
  errorKeys: {
    DUPLICATE_CUSTOM_ORDER: 'data.custom.error.DUPLICATE_CUSTOM_ORDER', QUOTE_REISSUE_REQUIRED: 'data.custom.error.QUOTE_REISSUE_REQUIRED',
    BOOKING_PAST: 'data.custom.error.BOOKING_PAST', REQUIRED_FIELD: 'data.custom.error.REQUIRED_FIELD', INVALID_QUOTE_AMOUNT: 'data.custom.error.INVALID_QUOTE_AMOUNT',
    APPROVAL_REQUIRED: 'data.custom.error.APPROVAL_REQUIRED', PAYMENT_REQUIRED: 'data.custom.error.PAYMENT_REQUIRED', QUOTE_CHANGED: 'data.custom.error.QUOTE_CHANGED',
    INVALID_STAGE_TRANSITION: 'data.custom.error.INVALID_STAGE_TRANSITION', PAYMENT_REVERSAL_REQUIRED: 'data.custom.error.PAYMENT_REVERSAL_REQUIRED',
    ALLOCATION_SUM_MISMATCH: 'data.custom.error.ALLOCATION_SUM_MISMATCH', REFUND_LIMIT: 'data.custom.error.REFUND_LIMIT', STALE_REVISION: 'data.custom.error.STALE_REVISION',
    MEMBER_REQUIRED: 'data.custom.error.MEMBER_REQUIRED', CHARGE_BALANCE_EXCEEDED: 'data.custom.error.CHARGE_BALANCE_EXCEEDED', CHARGE_LIMIT: 'data.custom.error.CHARGE_BALANCE_EXCEEDED',
    RECEIVABLE_LIMIT: 'data.custom.error.RECEIVABLE_LIMIT', RECEIVABLE_ALREADY_COLLECTED: 'data.custom.error.RECEIVABLE_ALREADY_COLLECTED',
    CONFIRMATION_REQUIRED: 'data.custom.error.CONFIRMATION_REQUIRED', MEMBER_NOT_FOUND: 'data.custom.error.MEMBER_NOT_FOUND',
    REFERENCE_PHOTO_NOT_FOUND: 'data.custom.error.REFERENCE_PHOTO_NOT_FOUND', PHOTO_SERVICE_UNAVAILABLE: 'data.custom.error.PHOTO_SERVICE_UNAVAILABLE',
    TERMINAL_RECORD_REQUIRED: 'data.custom.error.TERMINAL_RECORD_REQUIRED', TERMINAL_REFERENCE_EXISTS: 'data.custom.error.TERMINAL_REFERENCE_EXISTS',
    TERMINAL_TIME_INVALID: 'data.custom.error.TERMINAL_TIME_INVALID', DAY_CLOSED: 'data.custom.error.DAY_CLOSED', UNDO_UNAVAILABLE: 'data.error.undoUnavailable',
  },
  async load({ reads, signal }) {
    const list = <T>(resource: string, path: string) => reads.all<T>({ resource, path, query: { limit: PAGE } }, { signal });
    const [templates, orders, pickups] = await Promise.all([
      list<CustomTemplateDto>('pos.custom-templates', customTemplatesPath),
      list<CustomOrderDto>('pos.custom-orders', customOrdersPath),
      list<CustomPickupDto>('pos.custom-pickups', customPickupsPath),
    ]);
    const pages = [templates, orders, pickups];
    const asOf = pages.map(page => page.asOf).sort().at(-1)!;
    const { tables, revisions } = projectCustom({ templates: templates.items, orders: orders.items, pickups: pickups.items, asOf });
    return { tables, revisions, asOf, sourceRevision: Math.max(...pages.map(page => page.sourceRevision)), complete: pages.every(page => page.complete) };
  },
  commands: [
    defineBinding({ type: 'customTemplate.generate', ...common, request: ({ productKind, keywords }) => ({ method: 'POST', path: `${customTemplatesPath}/generate`, body: { productKind, keywords } }) }),
    defineBinding({ type: 'customTemplate.save', ...common, request: ({ templateId, name, fields }, context): CommandRequest => templateId
      ? { method: 'PATCH', path: item(customTemplatesPath, templateId), body: { name, fields }, expectedRevision: expected(context, customTemplateKey(templateId)) }
      : { method: 'POST', path: customTemplatesPath, body: { name, fields } } }),
    defineBinding({ type: 'customTemplate.delete', ...common, request: ({ templateId }, context) => ({ method: 'DELETE', path: item(customTemplatesPath, templateId),
      body: { confirmed: true }, expectedRevision: expected(context, customTemplateKey(templateId)) }) }),
    defineBinding({ type: 'customOrder.create', ...common, request: async (command, context): Promise<CommandRequest> => {
      const templateRevision = context.revision(customTemplateKey(command.templateId));
      const referencePhotoKeys = await photoIds(context, command.referencePhotoKeys);
      return { method: 'POST', path: customOrdersPath, body: { ...without(command, META), ...(referencePhotoKeys ? { referencePhotoKeys } : {}) },
        ...(templateRevision !== undefined ? { expectedRevision: templateRevision } : {}) };
    } }),
    defineBinding({ type: 'customOrder.update', ...common, request: async (command, context): Promise<CommandRequest> => {
      const referencePhotoKeys = await photoIds(context, command.referencePhotoKeys);
      return { method: 'PATCH', path: item(customOrdersPath, command.customOrderId), body: { ...without(command, META), ...(referencePhotoKeys ? { referencePhotoKeys } : {}) },
        expectedRevision: expected(context, customOrderKey(command.customOrderId)) };
    } }),
    transition('customOrder.quote', ({ quoteAmount, proposedPickupAt, productionAt }) => ({ quoteAmount, proposedPickupAt, ...(productionAt !== undefined ? { productionAt } : {}) })),
    transition('customOrder.recordDecision', ({ quoteRevision, decision, paymentTiming }) => ({ quoteRevision, decision, paymentTiming })),
    transition('customOrder.setStage', ({ nextStage }) => ({ nextStage })),
    transition('customOrder.receive', () => ({ confirmed: true })),
    transition('customOrder.cancel', () => ({ confirmed: true })),
    defineBinding({ type: 'pickup.reschedule', ...common, request: ({ reservationId, date, time }, context) => ({ method: 'POST', path: `${item(customPickupsPath, reservationId)}/transitions`,
      body: { type: 'pickup.reschedule', date, time }, expectedRevision: expected(context, customPickupKey(reservationId)) }) }),
    defineBinding({ type: 'pickup.cancel', ...common, request: ({ reservationId }, context) => ({ method: 'POST', path: `${item(customPickupsPath, reservationId)}/transitions`,
      body: { type: 'pickup.cancel', confirmed: true }, expectedRevision: expected(context, customPickupKey(reservationId)) }) }),
    /* Widget-only money records (B08 `/payments`, `/corrections`). A record the owner typed from the store's terminal slip. */
    // A payment funded entirely by the member's charge or receivable has no terminal record to protect: the service gives it the same short undo as any pickup move.
    defineBinding({ type: 'customOrder.recordPayment', receiptBase, noticeKey: 'data.custom.notice.paymentRecorded', request: ({ customOrderId, quoteId, allocations, terminal, expectedRevision }) => ({
      method: 'POST', path: `${item(customOrdersPath, customOrderId)}/payments`, body: { quoteId, allocations, ...(terminal ? { terminal } : {}) }, expectedRevision }) }),
    defineBinding({ type: 'customOrder.recordCorrection', noticeKey: 'data.custom.notice.correctionRecorded', request: ({ customOrderId, quoteId, kind, amount, terminal, expectedRevision }) => ({
      method: 'POST', path: `${item(customOrdersPath, customOrderId)}/corrections`, body: { quoteId, kind, confirmed: true, ...(amount !== undefined ? { amount } : {}), ...(terminal ? { terminal } : {}) }, expectedRevision }) }),
  ],
};
