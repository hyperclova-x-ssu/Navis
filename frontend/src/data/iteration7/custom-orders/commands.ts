import { clock, approved, emptyEffects, failure, fingerprint, guard, history, nonempty, positive, replaceOrder, success, validStamp, businessDate } from './shared';
import { customPaymentView, customPickup } from './selectors';
import { exampleTemplate } from './seed';
import { findDuplicateCustomOrder, pickupLinkConflicts } from '../../commands/custom-order-guard';
import type { CustomAnswers, CustomFailure, CustomOrder, CustomOrderCommand, CustomOrderRead, CustomOrderTables, CustomPlanResult, CustomReceipt, CustomTemplate, CustomTemplateField, PickupReservation } from './types';

function validFields(fields: readonly CustomTemplateField[]): boolean {
  if (!Array.isArray(fields) || !fields.length) return false;
  const ids = new Set<string>();
  return fields.every(f => {
    if (!f || !nonempty(f.fieldId) || ids.has(f.fieldId) || !nonempty(f.label) || !['text', 'single', 'multiple', 'datetime'].includes(f.input) || typeof f.required !== 'boolean' || !Array.isArray(f.options)) return false;
    ids.add(f.fieldId);
    const options = new Set<string>();
    if ((f.input === 'single' || f.input === 'multiple') && !f.options.length) return false;
    return f.options.every((o: CustomTemplateField['options'][number]) => {
      if (!o || !nonempty(o.optionId) || options.has(o.optionId) || !nonempty(o.label) || !Number.isSafeInteger(o.extraAmount) || o.extraAmount < 0) return false;
      options.add(o.optionId); return true;
    });
  });
}
function validAnswers(template: CustomTemplate, answers: CustomAnswers): boolean {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  if (Object.keys(answers).some(id => !template.fields.some(f => f.fieldId === id))) return false;
  return template.fields.every(f => {
    const value = answers[f.fieldId];
    const absent = value === undefined || value === '' || Array.isArray(value) && !value.length;
    if (absent) return !f.required;
    if (f.input === 'multiple') return Array.isArray(value) && new Set(value).size === value.length && value.every(id => f.options.some(o => o.optionId === id));
    if (typeof value !== 'string') return false;
    if (f.input === 'single') return f.options.some(o => o.optionId === value);
    return f.input === 'datetime' ? validStamp(value) : nonempty(value);
  });
}
const isPastPickup = (read: CustomOrderRead, stamp: string) => stamp < clock(read).slice(0, 16);

function receiptFailure(read: CustomOrderRead, template: CustomTemplate, receipt: CustomReceipt, previousPickupAt?: string): CustomFailure | null {
  if (!validAnswers(template, receipt.answers)) return failure('REQUIRED_FIELD', 'answers');
  if (!nonempty(receipt.productLabel) || !positive(receipt.quantity)) return failure('REQUIRED_FIELD', 'quantity');
  if (!['phone', 'message', 'visit'].includes(receipt.channel) || !validStamp(receipt.desiredPickupAt)) return failure('REQUIRED_FIELD', 'desiredPickupAt');
  if (receipt.desiredPickupAt !== previousPickupAt && isPastPickup(read, receipt.desiredPickupAt)) return failure('BOOKING_PAST', 'desiredPickupAt');
  if (![receipt.options, receipt.referencePhotoKeys].every(a => Array.isArray(a) && a.every(nonempty)) || typeof receipt.request !== 'string') return failure('REQUIRED_FIELD', 'options');
  if (receipt.memberId !== null) {
    if (!read.tables.member?.some(m => m.memberId === receipt.memberId)) return failure('NOT_FOUND', 'memberId', 'NOT_FOUND');
  } else if (!receipt.guest || !nonempty(receipt.guest.name) || !nonempty(receipt.guest.phone)) return failure('REQUIRED_FIELD', 'guest');
  return null;
}
function newId(read: CustomOrderRead, prefix: string): string {
  const ids = new Set([...read.tables.customOrder.map(o => o.customOrderId), ...read.tables.customTemplate.map(t => t.templateId), ...read.tables.customOrder.map(o => o.templateId)]);
  let n = 1;
  while (ids.has(`${prefix}-${String(n).padStart(3, '0')}`) || Object.values(read.tables.appliedKeys ?? {}).some(e => {
    const value = (e.result as { value?: { templateId?: string; customOrderId?: string } })?.value;
    return value?.templateId === `${prefix}-${String(n).padStart(3, '0')}` || value?.customOrderId === `${prefix}-${String(n).padStart(3, '0')}`;
  })) n++;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}
export function cancelLinkedOrder(read: CustomOrderRead, order: CustomOrder): CustomOrderTables {
  const row = history(read, { ...order, stage: 'canceled' }, 'canceled', 'canceled', order.pickupReservationId);
  return { ...replaceOrder(read.tables, row), reservation: read.tables.reservation.map(r => r.kind === 'pickup' && r.customOrderId === order.customOrderId ? { ...r, status: 'canceled', updatedAt: clock(read) } : r) };
}

export function planCustomOrderCommand(read: CustomOrderRead, command: CustomOrderCommand): CustomPlanResult {
  if (!command || typeof command !== 'object') return failure('REQUIRED_FIELD', 'type');
  const keyRequired = command.type !== 'customOrder.update' && !(command.type === 'customTemplate.save' && command.templateId);
  const guarded = guard(read, command, !!keyRequired); if (guarded) return guarded;
  const t = read.tables;
  if (command.type === 'customTemplate.generate') {
    if (!nonempty(command.productKind) || typeof command.keywords !== 'string') return failure('REQUIRED_FIELD', 'productKind');
    const row = exampleTemplate(newId(read, 'CT'), `${command.productKind.trim()} 주문서`, command.keywords.trim());
    return success(read, command, { ...t, customTemplate: [...t.customTemplate, row] }, { templateId: row.templateId }, true);
  }
  if (command.type === 'customTemplate.save') {
    if (!nonempty(command.name) || !validFields(command.fields)) return failure('REQUIRED_FIELD', 'fields');
    const old = command.templateId ? t.customTemplate.find(r => r.templateId === command.templateId && r.archivedAt === null) : undefined;
    if (command.templateId && !old) return failure('NOT_FOUND', 'templateId', 'NOT_FOUND');
    const templateId = old?.templateId ?? newId(read, 'CT');
    const row: CustomTemplate = { templateId, name: command.name.trim(), fields: structuredClone(command.fields), revision: (old?.revision ?? 0) + 1, archivedAt: null };
    return success(read, command, { ...t, customTemplate: old ? t.customTemplate.map(r => r.templateId === templateId ? row : r) : [...t.customTemplate, row] }, { templateId }, true);
  }
  if (command.type === 'customTemplate.delete') {
    if (!t.customTemplate.some(r => r.templateId === command.templateId)) return failure('NOT_FOUND', 'templateId', 'NOT_FOUND');
    return success(read, command, { ...t, customTemplate: t.customTemplate.filter(r => r.templateId !== command.templateId) }, { templateId: command.templateId }, true);
  }
  if (command.type === 'customOrder.create') {
    const template = t.customTemplate.find(r => r.templateId === command.templateId && r.archivedAt === null);
    if (!template) return failure('NOT_FOUND', 'templateId', 'NOT_FOUND');
    const receipt: CustomReceipt = { answers: command.answers, channel: command.channel, productLabel: command.productLabel, options: command.options ?? [], quantity: command.quantity, request: command.request ?? '', referencePhotoKeys: command.referencePhotoKeys ?? [], desiredPickupAt: command.desiredPickupAt, memberId: command.memberId ?? null, guest: command.memberId ? null : command.guest ?? null };
    const invalid = receiptFailure(read, template, receipt); if (invalid) return invalid;
    const duplicate = findDuplicateCustomOrder(t.customOrder, receipt, template.templateId);
    if (duplicate) return failure('DUPLICATE_CUSTOM_ORDER', 'productLabel', 'CONFLICT', { customOrderId: duplicate.customOrderId });
    const customOrderId = newId(read, 'CO');
    const row = history(read, { ...structuredClone(receipt), customOrderId, templateId: template.templateId, templateRevision: template.revision, templateSnapshot: structuredClone(template), proposedPickupAt: null, productionAt: null,
      quoteAmount: null, quoteRevision: 0, customerDecision: 'pending', approvedQuoteRevision: null, stage: 'received', paymentTiming: 'on_pickup', pickupReservationId: null, settlementId: null, history: [] }, 'created', 'received');
    return success(read, command, { ...t, customOrder: [...t.customOrder, row] }, { customOrderId, stage: row.stage });
  }
  if (command.type === 'pickup.reschedule' || command.type === 'pickup.cancel') {
    const reservation = t.reservation.find(r => r.reservationId === command.reservationId);
    if (!reservation) return failure('NOT_FOUND', 'reservationId', 'NOT_FOUND');
    if (reservation.kind !== 'pickup') return failure('PICKUP_HAS_NO_TABLE', 'reservationId');
    const order = t.customOrder.find(o => o.customOrderId === reservation.customOrderId && o.pickupReservationId === reservation.reservationId);
    if (!order) return failure('NOT_FOUND', 'customOrderId', 'NOT_FOUND');
    if (pickupLinkConflicts(t.reservation, order.customOrderId, reservation.reservationId)) return failure('CONFLICT', 'reservationId', 'CONFLICT');
    if (command.type === 'pickup.cancel' && order.stage === 'canceled') return cancel(read, command, order);
    if (reservation.status !== 'confirmed' || !approved(order) || ['canceled', 'received_by_customer'].includes(order.stage)) return failure('INVALID_STAGE_TRANSITION', 'reservationId');
    if (command.type === 'pickup.cancel') return cancel(read, command, order);
    const stamp = `${command.date}T${command.time}`;
    if (!validStamp(stamp, true)) return failure('REQUIRED_FIELD', 'time');
    if ((command.date !== reservation.date || command.time !== reservation.time) && isPastPickup(read, stamp)) {
      return failure('BOOKING_PAST', command.date < clock(read).slice(0, 10) ? 'date' : 'time');
    }
    const pickup = { ...reservation, date: command.date, time: command.time, updatedAt: clock(read) };
    const tables = replaceOrder(t, history(read, order, 'rescheduled', `${command.date}T${command.time}`, reservation.reservationId));
    return success(read, command, { ...tables, reservation: t.reservation.map(r => r === reservation ? pickup : r) }, { customOrderId: order.customOrderId, reservationId: reservation.reservationId }, true);
  }
  const order = 'customOrderId' in command ? t.customOrder.find(o => o.customOrderId === command.customOrderId) : undefined;
  if (!order) return failure('NOT_FOUND', 'customOrderId', 'NOT_FOUND');
  const done = (row: CustomOrder, kind: Parameters<typeof history>[2], detail: string, tables = t) => success(read, command, replaceOrder(tables, history(read, row, kind, detail)), { customOrderId: row.customOrderId, stage: row.stage, quoteRevision: row.quoteRevision, pickupReservationId: row.pickupReservationId ?? undefined });
  if (command.type === 'customOrder.cancel') return cancel(read, command, order);
  if (command.type === 'customOrder.receive') {
    const prior = read.money.recognitions.find(r => r.sourceId === order.customOrderId && r.source === 'custom_pickup' && r.originalRecognitionId === null);
    if (order.stage === 'received_by_customer' && prior) return success(read, command, t, { customOrderId: order.customOrderId, recognitionId: prior.recognitionId, stage: order.stage }, false, emptyEffects(), false);
    if (!approved(order)) return failure('APPROVAL_REQUIRED');
    if (order.stage !== 'production_complete') return failure('INVALID_STAGE_TRANSITION', 'stage');
    const payment = customPaymentView(read, order);
    if (payment.amountSettled - payment.amountReturned !== order.quoteAmount) return failure('PAYMENT_REQUIRED');
    const pickup = customPickup(read, order);
    if (!pickup || pickup.status !== 'confirmed' || prior) return failure('INVALID_STAGE_TRANSITION', 'pickupReservationId');
    if (pickupLinkConflicts(t.reservation, order.customOrderId, pickup.reservationId)) return failure('CONFLICT', 'reservationId', 'CONFLICT');
    const recognitionId = `custom-received:${order.customOrderId}`;
    const tables = replaceOrder(t, history(read, { ...order, stage: 'received_by_customer' }, 'received', String(order.quoteAmount), recognitionId));
    return success(read, command, { ...tables, reservation: t.reservation.map(r => r === pickup ? { ...pickup, status: 'completed', updatedAt: clock(read) } : r) }, { customOrderId: order.customOrderId, recognitionId, stage: 'received_by_customer' }, false,
      { ...emptyEffects(), recognitions: [{ recognitionId, source: 'custom_pickup', sourceId: order.customOrderId, businessDate: businessDate(read), at: clock(read), amount: order.quoteAmount!, cost: null, settlementCategory: 'custom_pickup', originalRecognitionId: null }] });
  }
  if (order.stage === 'canceled' || order.stage === 'received_by_customer') return failure('INVALID_STAGE_TRANSITION', 'stage');
  if (command.type === 'customOrder.update') {
    if (command.expectedQuoteRevision !== order.quoteRevision) return failure('QUOTE_CHANGED', 'expectedQuoteRevision', 'CONFLICT');
    const editable = ['answers', 'productLabel', 'options', 'quantity', 'request', 'referencePhotoKeys', 'channel', 'memberId', 'guest', 'desiredPickupAt'] as const;
    const patch = Object.fromEntries(editable.filter(k => command[k] !== undefined).map(k => [k, command[k]]));
    const sensitive = editable.filter(k => !['request', 'referencePhotoKeys', 'channel'].includes(k)).some(k => command[k] !== undefined && fingerprint(command[k]) !== fingerprint(order[k]));
    if (sensitive && customPaymentView(read, order).amountSettled > 0) return failure('PAYMENT_REVERSAL_REQUIRED');
    let row: CustomOrder = { ...order, ...structuredClone(patch) };
    const invalid = receiptFailure(read, order.templateSnapshot, row, order.desiredPickupAt); if (invalid) return invalid;
    let tables = t;
    if (sensitive) {
      const duplicate = findDuplicateCustomOrder(t.customOrder, row, order.templateId, order.customOrderId);
      if (duplicate) return failure('DUPLICATE_CUSTOM_ORDER', 'productLabel', 'CONFLICT', { customOrderId: duplicate.customOrderId });
      row = { ...row, approvedQuoteRevision: null, customerDecision: 'pending', stage: 'quote_pending', quoteRevision: order.quoteRevision + 1 };
      tables = { ...t, reservation: t.reservation.map(r => r.kind === 'pickup' && r.customOrderId === order.customOrderId ? { ...r, status: 'canceled', updatedAt: clock(read) } : r) };
    }
    return done(row, 'updated', 'receipt', tables);
  }
  if (command.type === 'customOrder.quote') {
    if (!positive(command.quoteAmount)) return failure('INVALID_QUOTE_AMOUNT', 'quoteAmount');
    if (!validStamp(command.proposedPickupAt, true) || command.productionAt != null && !validStamp(command.productionAt)) return failure('REQUIRED_FIELD', 'proposedPickupAt');
    const currentPickupAt = customPickup(read, order);
    const previousPickupAt = currentPickupAt?.status === 'confirmed' ? `${currentPickupAt.date}T${currentPickupAt.time}` : order.proposedPickupAt ?? order.desiredPickupAt;
    if (command.proposedPickupAt !== previousPickupAt && isPastPickup(read, command.proposedPickupAt)) return failure('BOOKING_PAST', 'proposedPickupAt');
    if (customPaymentView(read, order).amountSettled > 0) return failure('PAYMENT_REVERSAL_REQUIRED');
    const tables = { ...t, reservation: t.reservation.map(r => r.kind === 'pickup' && r.customOrderId === order.customOrderId ? { ...r, status: 'canceled' as const, updatedAt: clock(read) } : r) };
    return done({ ...order, quoteAmount: command.quoteAmount, quoteRevision: order.quoteRevision + 1, proposedPickupAt: command.proposedPickupAt, productionAt: command.productionAt === undefined ? order.productionAt : command.productionAt, customerDecision: 'pending', approvedQuoteRevision: null, stage: 'approval_pending' }, 'quoted', String(command.quoteAmount), tables);
  }
  if (command.type === 'customOrder.recordDecision') {
    if (command.quoteRevision !== order.quoteRevision) return failure('QUOTE_CHANGED', 'quoteRevision', 'CONFLICT');
    if (!positive(order.quoteAmount) || !validStamp(order.proposedPickupAt, true)) return failure('REQUIRED_FIELD', 'proposedPickupAt');
    if (!['approved', 'rejected', 'revision_requested'].includes(command.decision) || !['advance', 'on_pickup'].includes(command.paymentTiming)) return failure('REQUIRED_FIELD', 'decision');
    if (approved(order) && command.decision === 'approved' && order.paymentTiming === command.paymentTiming) return success(read, command, t, { customOrderId: order.customOrderId, pickupReservationId: order.pickupReservationId ?? undefined, stage: order.stage, quoteRevision: order.quoteRevision }, false, emptyEffects(), false);
    if (customPaymentView(read, order).amountSettled > 0) return failure('PAYMENT_REVERSAL_REQUIRED');
    if (!['approval_pending', 'revision_requested', 'quote_pending', 'payment_pending', 'in_production'].includes(order.stage)) return failure('INVALID_STAGE_TRANSITION');
    const existing = t.reservation.find((r): r is PickupReservation => r.kind === 'pickup' && r.customOrderId === order.customOrderId);
    if (command.decision !== 'approved') {
      const tables = { ...t, reservation: t.reservation.map(r => r.kind === 'pickup' && r.customOrderId === order.customOrderId ? { ...r, status: 'canceled' as const, updatedAt: clock(read) } : r) };
      return done({ ...order, customerDecision: command.decision, approvedQuoteRevision: null, stage: command.decision === 'revision_requested' ? 'revision_requested' : 'quote_pending', paymentTiming: command.paymentTiming }, 'decision', command.decision, tables);
    }
    if (order.stage === 'revision_requested') return failure('QUOTE_REISSUE_REQUIRED', 'quoteRevision');
    if (order.stage === 'quote_pending') {
      const history = order.history.filter(entry => entry.quoteRevision === order.quoteRevision);
      const hasQuote = history.some(entry => entry.kind === 'quoted');
      const revisionRequested = history.some(entry => entry.kind === 'decision' && entry.detail === 'revision_requested');
      if (order.customerDecision === 'pending' || !hasQuote || revisionRequested) return failure('QUOTE_REISSUE_REQUIRED', 'quoteRevision');
    }
    if (isPastPickup(read, order.proposedPickupAt)) return failure('BOOKING_PAST', 'proposedPickupAt');
    const pickup: PickupReservation = { kind: 'pickup', reservationId: existing?.reservationId ?? `PICKUP-${order.customOrderId}`, customOrderId: order.customOrderId, date: order.proposedPickupAt!.slice(0, 10), time: order.proposedPickupAt!.slice(11), status: 'confirmed', updatedAt: clock(read) };
    if (pickupLinkConflicts(t.reservation, order.customOrderId, pickup.reservationId)) return failure('CONFLICT', 'reservationId', 'CONFLICT');
    const tables = { ...t, reservation: existing ? t.reservation.map(r => r === existing ? pickup : r) : [...t.reservation, pickup] };
    return done({ ...order, customerDecision: 'approved', approvedQuoteRevision: order.quoteRevision, paymentTiming: command.paymentTiming, pickupReservationId: pickup.reservationId, stage: command.paymentTiming === 'advance' ? 'payment_pending' : 'in_production' }, 'decision', 'approved', tables);
  }
  if (command.type === 'customOrder.setStage') {
    if (['in_production', 'production_complete'].includes(command.nextStage) && !approved(order)) return failure('APPROVAL_REQUIRED');
    if (command.nextStage === 'in_production' && order.paymentTiming === 'advance' && customPaymentView(read, order).amountSettled - customPaymentView(read, order).amountReturned !== order.quoteAmount) return failure('PAYMENT_REQUIRED');
    const valid = order.stage === 'received' && command.nextStage === 'quote_pending' || order.stage === 'payment_pending' && command.nextStage === 'in_production' || order.stage === 'in_production' && command.nextStage === 'production_complete';
    if (!valid) return failure('INVALID_STAGE_TRANSITION', 'nextStage');
    return done({ ...order, stage: command.nextStage }, 'stage', command.nextStage);
  }
  return failure('REQUIRED_FIELD', 'type');
}
function cancel(read: CustomOrderRead, command: CustomOrderCommand, order: CustomOrder): CustomPlanResult {
  if (order.stage === 'canceled') return success(read, command, read.tables, { customOrderId: order.customOrderId, stage: order.stage }, false, emptyEffects(), false);
  if (order.stage === 'received_by_customer') return failure('INVALID_STAGE_TRANSITION', 'stage');
  const payment = customPaymentView(read, order);
  if (payment.amountSettled - payment.amountReturned > 0) return failure('PAYMENT_REVERSAL_REQUIRED', 'confirmedCorrectionQuoteId');
  return success(read, command, cancelLinkedOrder(read, order), { customOrderId: order.customOrderId, pickupReservationId: order.pickupReservationId ?? undefined, stage: 'canceled' });
}
