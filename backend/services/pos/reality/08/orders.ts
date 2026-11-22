import { randomUUID } from 'node:crypto';
import type { CustomOrder, CustomReceipt } from '../../../../../frontend/src/data/iteration7/custom-orders/types.ts';
import { applyCommand, openDay, readCommand } from '../../ledger.ts';
import type { PosPreflight } from '../../preflight.ts';
import { fingerprint, integer, object, PosError, uuid, type PosTx } from '../../wire.ts';
import { currentDay, type FinanceTx } from '../09/input.ts';
import { choice, confirm, future, invalid, receipt, receiptFields, stages, stale, stamp,
  verifyMember, verifyPhotos, type OrderDependencies } from './input.ts';
import { active, approved, assertUniqueRequest, closePickup, insertOrder, orderReceipt, pickupFor,
  pickupStamp, readOrder, requestFingerprint, templateDetail, writeOrder, type Order } from './records.ts';
import { adjustRecognition, recognizeHandover } from './recognition.ts';
import { registerUndo, type UndoEffect } from './undo.ts';

type OrderCommand = ReturnType<typeof parseTransition>;

function parseTransition(body: unknown, pickup: boolean) {
  const common = ['type', 'expectedRevision'];
  // Select the exact allowed keys for the discriminated command before using any field.
  const { type } = object(body, [...common, 'quoteAmount', 'proposedPickupAt', 'productionAt',
    'quoteRevision', 'decision', 'paymentTiming', 'nextStage', 'confirmed', 'confirmedCorrectionQuoteId', 'date', 'time']);
  const keys = {
    'customOrder.quote': ['quoteAmount', 'proposedPickupAt', 'productionAt'],
    'customOrder.recordDecision': ['quoteRevision', 'decision', 'paymentTiming'],
    'customOrder.setStage': ['nextStage'],
    'customOrder.receive': ['confirmed'],
    'customOrder.cancel': ['confirmed', 'confirmedCorrectionQuoteId'],
    'pickup.reschedule': ['date', 'time'],
    'pickup.cancel': ['confirmed', 'confirmedCorrectionQuoteId'],
  } as const;
  const name = choice(type, Object.keys(keys) as (keyof typeof keys)[], 'type');
  if (name.startsWith('pickup.') !== pickup) return invalid('type');
  const input = object(body, [...common, ...keys[name]]);
  const expectedRevision = integer(input.expectedRevision, 1);
  const meta = { expectedRevision };
  switch (name) {
    case 'customOrder.quote':
      return { ...meta, type: name, quoteAmount: integer(input.quoteAmount, 1, Number.MAX_SAFE_INTEGER, 'INVALID_QUOTE_AMOUNT'),
        proposedPickupAt: stamp(input.proposedPickupAt, 'proposedPickupAt', true),
        productionAt: input.productionAt == null ? input.productionAt as undefined | null : stamp(input.productionAt, 'productionAt') };
    case 'customOrder.recordDecision':
      return { ...meta, type: name, quoteRevision: integer(input.quoteRevision, 1),
        decision: choice(input.decision, ['approved', 'rejected', 'revision_requested'], 'decision'),
        paymentTiming: choice(input.paymentTiming, ['advance', 'on_pickup'], 'paymentTiming') };
    case 'customOrder.setStage':
      return { ...meta, type: name, nextStage: choice(input.nextStage, stages, 'nextStage') };
    case 'pickup.reschedule':
      if (typeof input.date !== 'string' || typeof input.time !== 'string') return invalid('time');
      return { ...meta, type: name, scheduledAt: stamp(`${input.date}T${input.time}`, 'time', true) };
    default:
      confirm(input.confirmed);
      if (input.confirmedCorrectionQuoteId !== undefined && typeof input.confirmedCorrectionQuoteId !== 'string') {
        return invalid('confirmedCorrectionQuoteId');
      }
      return { ...meta, type: name, confirmedCorrectionQuoteId: input.confirmedCorrectionQuoteId };
  }
}

function createInput(body: unknown) {
  const { templateId: rawId, expectedRevision: rawRevision, ...input } = object(body, ['templateId', 'expectedRevision', ...receiptFields]);
  const templateId = uuid(rawId);
  const expectedRevision = rawRevision === undefined ? undefined : integer(rawRevision, 1);
  return { templateId, expectedRevision, input };
}

async function inspectCreate(tx: FinanceTx, command: ReturnType<typeof createInput>, readRevision?: number) {
  const { templateId, input, expectedRevision } = command;
  const templateSnapshot = await templateDetail(tx, templateId);
  const revision = expectedRevision ?? readRevision;
  if (revision !== undefined) stale(revision, templateSnapshot.revision);
  const entry = receipt(input, templateSnapshot.fields);
  future(tx, entry.desiredPickupAt, 'desiredPickupAt');
  await assertUniqueRequest(tx, requestFingerprint(templateId, entry));
  return { templateSnapshot, entry };
}

async function inspectOperatingDay(tx: FinanceTx) {
  const day = await currentDay(tx);
  const { rows: [existing] } = await tx.db.query<{ status: string }>(`
    SELECT status FROM pos.business_day WHERE store_id=$1 AND business_date=$2`, [tx.storeId, day]);
  if (existing && existing.status !== 'open') throw new PosError(409, 'DAY_CLOSED');
  return day;
}

export async function prepareCreateOrder(scope: PosPreflight, deps: OrderDependencies, key: string, body: unknown) {
  const command = createInput(body);
  const snapshot = await scope.read(async tx => {
    if (await readCommand(tx, 'customOrder.create', key)) return;
    const day = await inspectOperatingDay(tx);
    return { day, ...await inspectCreate(tx, command) };
  });
  if (snapshot) {
    await verifyMember(scope, deps, snapshot.day, snapshot.entry.memberId);
    await verifyPhotos(scope, deps, snapshot.entry.referencePhotoKeys);
  }
  return (tx: FinanceTx) => applyCommand(tx, 'customOrder.create', key, command, async () => {
    const day = await openDay(tx);
    if (!snapshot || snapshot.day !== day) throw new PosError(409, 'STALE_REVISION');
    const { templateSnapshot, entry } = await inspectCreate(tx, command, snapshot.templateSnapshot.revision);
    const { templateId } = command;
    const initial = {
      customOrderId: randomUUID(), templateId, templateSnapshot, receipt: entry,
      stage: 'received', revision: 1, proposedPickupAt: null, productionAt: null, quoteAmount: null, quoteRevision: 0,
      approvedQuoteRevision: null, customerDecision: 'pending', paymentTiming: 'on_pickup', settlementId: null,
    } as const;
    const orderNo = await insertOrder(tx, initial);
    return orderReceipt({ ...initial, orderNo }, null);
  });
}

function updateInput(id: string, body: unknown) {
  const { expectedRevision: rawRevision, expectedQuoteRevision: rawQuote, ...patch } =
    object(body, ['expectedRevision', 'expectedQuoteRevision', ...receiptFields]);
  const expectedRevision = integer(rawRevision, 1);
  const expectedQuoteRevision = integer(rawQuote, 0);
  return { id, expectedRevision, expectedQuoteRevision, patch };
}

async function inspectUpdate(tx: FinanceTx, { id, expectedRevision, expectedQuoteRevision, patch }: ReturnType<typeof updateInput>) {
  const order = await readOrder(tx, id);
  stale(expectedRevision, order.revision);
  if (!active(order.stage)) throw new PosError(409, 'INVALID_STAGE_TRANSITION');
  if (expectedQuoteRevision !== order.quoteRevision) throw new PosError(409, 'QUOTE_CHANGED', { quoteRevision: order.quoteRevision });
  const inheritedClearedPhone = !('guest' in patch) && order.receipt.guest?.phone === '';
  const next = receipt({ ...order.receipt, ...patch }, order.templateSnapshot.fields, inheritedClearedPhone);
  future(tx, next.desiredPickupAt, 'desiredPickupAt', order.receipt.desiredPickupAt);
  const quoteFields: (keyof CustomReceipt)[] = ['answers', 'productLabel', 'options', 'quantity', 'memberId', 'guest', 'desiredPickupAt'];
  const invalidates = quoteFields.some(field => fingerprint(next[field]) !== fingerprint(order.receipt[field]));
  if (invalidates && order.amountSettled) throw new PosError(409, 'PAYMENT_REVERSAL_REQUIRED');
  const changed = fingerprint(next) !== fingerprint(order.receipt);
  if (changed) await assertUniqueRequest(tx, requestFingerprint(order.templateId, next), id);
  return { order, next, invalidates, changed };
}

export async function prepareUpdateOrder(scope: PosPreflight, deps: OrderDependencies, key: string, id: string, body: unknown) {
  const command = updateInput(id, body);
  const snapshot = await scope.read(async tx => {
    if (await readCommand(tx, 'customOrder.update', key)) return;
    const day = await inspectOperatingDay(tx);
    return { day, ...await inspectUpdate(tx, command) };
  });
  if (snapshot?.changed) {
    const { day, order, next } = snapshot;
    if (next.memberId !== order.receipt.memberId) await verifyMember(scope, deps, day, next.memberId);
    await verifyPhotos(scope, deps, next.referencePhotoKeys.filter(fileId => !order.receipt.referencePhotoKeys.includes(fileId)));
  }
  return (tx: FinanceTx) => applyCommand(tx, 'customOrder.update', key, command, async () => {
    const day = await openDay(tx);
    if (!snapshot || snapshot.day !== day) throw new PosError(409, 'STALE_REVISION');
    const { order, next, invalidates, changed } = await inspectUpdate(tx, command);
    if (!changed) return orderReceipt(order, order.pickup, false, undefined, false);
    return writeOrder(tx, order, { receipt: next, ...(invalidates && {
      stage: 'quote_pending', customerDecision: 'pending', approvedQuoteRevision: null, quoteRevision: order.quoteRevision + 1,
    }) }, { kind: 'updated', detail: 'receipt' }, invalidates ? closePickup(tx, order.pickup, 'canceled') : order.pickup);
  });
}

export function transitionOrder(tx: PosTx, key: string, id: string, body: unknown, byPickup = false) {
  const command = parseTransition(body, byPickup);
  return applyCommand(tx, command.type, key, { id, ...command }, async () => {
    const day = await openDay(tx);
    const order = await readOrder(tx, id, byPickup);
    stale(command.expectedRevision, order.revision);
    if (command.type === 'customOrder.receive') return receive(tx, order, day, key);
    if (command.type === 'customOrder.cancel' || command.type === 'pickup.cancel') return cancel(tx, order, byPickup);
    if (!active(order.stage)) throw new PosError(409, 'INVALID_STAGE_TRANSITION');
    switch (command.type) {
      case 'customOrder.quote': return quote(tx, order, command);
      case 'customOrder.recordDecision': return decision(tx, order, command);
      case 'customOrder.setStage': return setStage(tx, order, command.nextStage);
      case 'pickup.reschedule': return reschedule(tx, order, command.scheduledAt, key);
    }
  });
}

function quote(tx: PosTx, order: Order, command: Extract<OrderCommand, { type: 'customOrder.quote' }>) {
  if (order.amountSettled) throw new PosError(409, 'PAYMENT_REVERSAL_REQUIRED');
  const previous = order.pickup?.status === 'confirmed' ? pickupStamp(order.pickup) : order.proposedPickupAt ?? order.receipt.desiredPickupAt;
  future(tx, command.proposedPickupAt, 'proposedPickupAt', previous);
  return writeOrder(tx, order, {
    quoteAmount: command.quoteAmount, proposedPickupAt: command.proposedPickupAt,
    productionAt: command.productionAt === undefined ? order.productionAt : command.productionAt,
    quoteRevision: order.quoteRevision + 1, stage: 'approval_pending', approvedQuoteRevision: null, customerDecision: 'pending',
  }, { kind: 'quoted', detail: String(command.quoteAmount) }, closePickup(tx, order.pickup, 'canceled'));
}

function decision(tx: PosTx, order: Order, command: Extract<OrderCommand, { type: 'customOrder.recordDecision' }>) {
  const { decision, paymentTiming } = command;
  if (command.quoteRevision !== order.quoteRevision) throw new PosError(409, 'QUOTE_CHANGED', { quoteRevision: order.quoteRevision });
  if (!order.quoteAmount || !order.proposedPickupAt) return invalid('proposedPickupAt');
  if (approved(order) && decision === 'approved' && paymentTiming === order.paymentTiming) {
    return orderReceipt(order, order.pickup, false, undefined, false);
  }
  if (order.amountSettled) throw new PosError(409, 'PAYMENT_REVERSAL_REQUIRED');
  if (!['approval_pending', 'revision_requested', 'quote_pending', 'payment_pending', 'in_production'].includes(order.stage)) {
    throw new PosError(409, 'INVALID_STAGE_TRANSITION');
  }
  if (decision !== 'approved') {
    return writeOrder(tx, order, { stage: decision === 'rejected' ? 'quote_pending' : 'revision_requested',
      approvedQuoteRevision: null, customerDecision: decision, paymentTiming },
    { kind: 'decision', detail: decision }, closePickup(tx, order.pickup, 'canceled'));
  }
  if (order.stage === 'revision_requested' || (order.stage === 'quote_pending' &&
    (!order.history.some(row => row.quoteRevision === order.quoteRevision && row.kind === 'quoted') ||
      order.history.some(row => row.quoteRevision === order.quoteRevision && row.kind === 'decision' && row.detail === 'revision_requested')))) {
    throw new PosError(409, 'QUOTE_REISSUE_REQUIRED');
  }
  const scheduled = order.pickup?.status === 'confirmed' ? pickupStamp(order.pickup) : order.proposedPickupAt;
  future(tx, scheduled, 'proposedPickupAt');
  const pickup = pickupFor(tx, order, scheduled, 'confirmed');
  return writeOrder(tx, order, { stage: paymentTiming === 'advance' ? 'payment_pending' : 'in_production',
    approvedQuoteRevision: order.quoteRevision, customerDecision: 'approved', paymentTiming }, { kind: 'decision', detail: decision }, pickup);
}

function setStage(tx: PosTx, order: Order, nextStage: CustomOrder['stage']) {
  if ((nextStage === 'in_production' || nextStage === 'production_complete') && !approved(order)) {
    throw new PosError(409, 'APPROVAL_REQUIRED');
  }
  if (nextStage === 'in_production' && order.paymentTiming === 'advance' && order.amountSettled - order.amountReturned !== order.quoteAmount) {
    throw new PosError(409, 'PAYMENT_REQUIRED');
  }
  const allowed = { received: 'quote_pending', payment_pending: 'in_production', in_production: 'production_complete' } as const;
  if (!(order.stage in allowed) || allowed[order.stage as keyof typeof allowed] !== nextStage) throw new PosError(409, 'INVALID_STAGE_TRANSITION');
  return writeOrder(tx, order, { stage: nextStage }, { kind: 'stage', detail: nextStage });
}

async function reschedule(tx: PosTx, order: Order, scheduled: string, key: string) {
  const previous = order.pickup;
  if (!approved(order) || previous?.status !== 'confirmed') throw new PosError(409, 'INVALID_STAGE_TRANSITION');
  const oldTime = pickupStamp(previous);
  if (scheduled === oldTime) return orderReceipt(order, previous, false, undefined, false);
  future(tx, scheduled, 'time');
  const result = await writeOrder(tx, order, {}, { kind: 'rescheduled', detail: scheduled, referenceId: previous.reservationId },
    pickupFor(tx, order, scheduled, 'confirmed'));
  return registerUndo(tx, result, 'pickup.reschedule', key, { kind: 'reschedule', customOrderId: order.customOrderId, revision: result.revision, previous });
}

function cancel(tx: PosTx, order: Order, byPickup: boolean) {
  if (order.stage === 'canceled') return orderReceipt(order, order.pickup, false, undefined, false);
  if (!active(order.stage) || (byPickup && order.pickup?.status !== 'confirmed')) throw new PosError(409, 'INVALID_STAGE_TRANSITION');
  if (order.amountSettled > order.amountReturned) throw new PosError(409, 'PAYMENT_REVERSAL_REQUIRED');
  return writeOrder(tx, order, { stage: 'canceled' }, { kind: 'canceled', detail: 'canceled' },
    closePickup(tx, order.pickup, 'canceled'));
}

async function receive(tx: PosTx, order: Order, day: string, key: string) {
  if (!approved(order)) throw new PosError(409, 'APPROVAL_REQUIRED');
  if (order.stage !== 'production_complete' || order.pickup?.status !== 'confirmed') throw new PosError(409, 'INVALID_STAGE_TRANSITION');
  if (order.amountSettled - order.amountReturned !== order.quoteAmount) throw new PosError(409, 'PAYMENT_REQUIRED');
  const recognitionId = await recognizeHandover(tx, order, day);
  const result = { ...await writeOrder(tx, order, { stage: 'received_by_customer' },
    { kind: 'received', detail: String(order.quoteAmount), referenceId: recognitionId }, closePickup(tx, order.pickup, 'completed'),
    { money: true, receiptId: recognitionId }), recognitionId };
  if (order.paymentTiming !== 'advance') return result;
  return registerUndo(tx, result, 'customOrder.receive', key,
    { kind: 'receive', customOrderId: order.customOrderId, revision: result.revision, businessDate: day });
}

export async function undoOrder(tx: PosTx, effect: Extract<UndoEffect, { kind: 'reschedule' | 'receive' }>) {
  const day = await openDay(tx);
  const order = await readOrder(tx, effect.customOrderId);
  if (!order.pickup || order.revision !== effect.revision) throw new PosError(409, 'UNDO_UNAVAILABLE');
  if (effect.kind === 'reschedule') {
    const scheduled = pickupStamp(effect.previous);
    future(tx, scheduled, 'time');
    return writeOrder(tx, order, {}, { kind: 'rescheduled', detail: scheduled, referenceId: order.pickup.reservationId },
      pickupFor(tx, order, scheduled, 'confirmed'));
  }
  if (!order.quoteAmount || day !== effect.businessDate || order.stage !== 'received_by_customer'
    || order.amountSettled - order.amountReturned !== order.quoteAmount) throw new PosError(409, 'UNDO_UNAVAILABLE');
  await assertUniqueRequest(tx, requestFingerprint(order.templateId, order.receipt), order.customOrderId);
  const recognitionId = await adjustRecognition(tx, order, { kind: 'undo', amount: -order.quoteAmount, day });
  return { ...await writeOrder(tx, order, { stage: 'production_complete' }, { kind: 'stage', detail: 'production_complete', referenceId: recognitionId },
    pickupFor(tx, order, pickupStamp(order.pickup), 'confirmed'), { money: true, receiptId: recognitionId }), recognitionId };
}
