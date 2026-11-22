/**
 * F08 test helper: a small in-memory B08 behind the F00 `fakeBackend`. It proves the wire the browser speaks (paths, bodies, revisions,
 * ids, refusals), not the service's own rules (B08's route tests cover those). Not shipped in the app bundle.
 */
import type { CustomOrder, CustomOrderPaymentView, CustomTemplate, RealMethod } from '../../iteration7/custom-orders';
import { fakeBackend, reply } from '../00/testing';
import type { CustomOrderDto, CustomPickupDto } from './dto';

export const PNG = 'data:image/png;base64,iVBORw0KGgo=';
export const asOf = '2026-11-21T06:00:00Z';
export const page = (items: readonly unknown[]) => ({ items, nextCursor: null, asOf, sourceRevision: items.length });
export const textField = { fieldId: 'note', label: '문구', input: 'text', required: true, options: [] } as const;
export const unpaid: CustomOrderPaymentView = { status: 'unpaid', amountSettled: 0, amountReturned: 0, realDeposits: 0, chargeApplied: 0, receivableAmount: 0 };

interface Allocation { readonly kind: 'method'; readonly method: RealMethod; readonly amount: number }
type Part = Allocation | { readonly kind: 'charge' | 'receivable'; readonly amount: number };
interface MemberAccount { charge: number; receivable: number; collected: boolean }

export function customService() {
  const backend = fakeBackend();
  const templates: CustomTemplate[] = [];
  const orders: CustomOrderDto[] = [];
  const pickups: CustomPickupDto[] = [];
  /** The linked members' accounts (B05) and what each order drew from them (B08-2). */
  const members = new Map<string, MemberAccount>();
  const used = new Map<string, { charge: number; receivable: number }>();
  const undoers = new Map<string, () => void>();
  const account = (memberId: string) => members.get(memberId)!;
  const paid = new Map<string, readonly Allocation[]>();
  const counters = new Map<string, number>();
  const id = (prefix: string) => { const next = (counters.get(prefix) ?? 0) + 1; counters.set(prefix, next); return `${prefix}-${next}`; };
  const receipt = (resourceId: string, revision: number, extra: object = {}) => ({ resourceId, revision, receiptId: id('receipt'), changed: true, affectedSources: ['custom-order', 'calendar'], ...extra });
  const order = (customOrderId: string) => orders.find(row => row.customOrderId === customOrderId)!;
  const bump = (row: CustomOrderDto, patch: Partial<CustomOrderDto>) => {
    const next = { ...row, ...patch, revision: row.revision + 1 };
    orders[orders.indexOf(row)] = next;
    for (const [index, pickup] of pickups.entries()) if (pickup.customOrderId === row.customOrderId) pickups[index] = { ...pickup, revision: next.revision };
    return next;
  };
  const stale = (row: CustomOrderDto, expectedRevision: unknown) => expectedRevision !== row.revision ? reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' }) : undefined;
  const remaining = (row: CustomOrderDto) => row.payment.amountSettled - row.payment.amountReturned;
  const returnsFor = (row: CustomOrderDto, amount: number) => {
    let left = amount;
    return (paid.get(row.customOrderId) ?? []).flatMap(part => { const back = Math.min(left, part.amount); left -= back; return back > 0 ? [{ method: part.method, amount: back }] : []; });
  };

  backend.on('GET', '/pos/custom-templates', () => page(templates));
  backend.on('GET', '/pos/custom-orders', () => page(orders));
  backend.on('GET', '/pos/custom-pickups', () => page(pickups));
  backend.on('POST', '/files', () => ({ fileId: 'photo-1' }));
  backend.on('PUT', '/files/photo-1/content', () => reply(204, null));
  backend.on('POST', '/files/photo-1/complete', () => ({ fileId: 'photo-1', contentType: 'image/png', size: 8, sha256: 'hash' }));
  const made = new Map<string, string>();
  const addTemplate = (name: string, fields: CustomTemplate['fields']) => {
    const row = { templateId: id('tpl'), name, revision: 1, fields, archivedAt: null };
    templates.push(row);
    const sent = receipt(row.templateId, 1, { templateId: row.templateId, undoUntil: '2999-01-01T00:00:00Z' });
    made.set(sent.receiptId, row.templateId);
    return sent;
  };
  backend.on('POST', '/pos/custom-templates', ({ body }) => {
    const { name, fields } = body as { name: string; fields: CustomTemplate['fields'] };
    return addTemplate(name, fields);
  });
  backend.on('POST', '/pos/custom-templates/generate', ({ body }) => addTemplate(`${(body as { productKind: string }).productKind} 주문서`, [textField]));
  backend.on('POST', /^\/pos\/custom-receipts\/receipts\/[^/]+\/undo$/, ({ path }) => {
    const receiptId = path.split('/')[4];
    const restore = undoers.get(receiptId);
    if (restore) { restore(); undoers.delete(receiptId); return receipt('undo', 2, { affectedSources: ['custom-order', 'pos.member-accounts'] }); }
    const templateId = made.get(receiptId);
    if (!templateId) return reply(409, { code: 'CONFLICT', reason: 'UNDO_UNAVAILABLE' });
    templates.splice(templates.findIndex(row => row.templateId === templateId), 1);
    return receipt('undo', 2);
  });
  backend.on('POST', '/pos/custom-orders', ({ body }) => {
    const input = body as Omit<CustomOrder, 'customOrderId'>;
    const template = templates.find(row => row.templateId === input.templateId)!;
    const customOrderId = id('order');
    const row: CustomOrderDto = { ...input, customOrderId, orderNo: orders.length + 1, templateRevision: template.revision, templateSnapshot: template, options: input.options ?? [],
      request: input.request ?? '', referencePhotoKeys: input.referencePhotoKeys ?? [], memberId: input.memberId ?? null, guest: input.guest ?? null,
      proposedPickupAt: null, productionAt: null, quoteAmount: null, quoteRevision: 0, customerDecision: 'pending', approvedQuoteRevision: null, stage: 'received',
      paymentTiming: 'on_pickup', pickupReservationId: null, settlementId: null, history: [], revision: 1, paymentId: null, pickup: null, confirmedPickupAt: null, payment: unpaid };
    orders.push(row);
    return receipt(customOrderId, 1, { customOrderId, orderNo: row.orderNo, stage: 'received' });
  });
  backend.on('POST', /^\/pos\/custom-orders\/[^/]+\/transitions$/, ({ path, body }) => {
    const row = order(path.split('/')[3]);
    const { type, ...args } = body as { type: string; expectedRevision: number } & Record<string, unknown>;
    const refused = stale(row, args.expectedRevision); if (refused) return refused;
    if ((type === 'customOrder.receive' || type === 'customOrder.cancel') && args.confirmed !== true) return reply(400, { code: 'VALIDATION', reason: 'CONFIRMATION_REQUIRED' });
    if (type === 'customOrder.quote') {
      const next = bump(row, { quoteAmount: args.quoteAmount as number, quoteRevision: row.quoteRevision + 1, proposedPickupAt: args.proposedPickupAt as string, stage: 'approval_pending' });
      return receipt(row.customOrderId, next.revision, { customOrderId: row.customOrderId, quoteRevision: next.quoteRevision, stage: next.stage });
    }
    if (type === 'customOrder.recordDecision') {
      const pickupReservationId = id('pickup');
      const next = bump(row, { customerDecision: 'approved', approvedQuoteRevision: row.quoteRevision, paymentTiming: args.paymentTiming as 'advance', pickupReservationId, stage: args.paymentTiming === 'advance' ? 'payment_pending' : 'in_production' });
      const [date, time] = row.proposedPickupAt!.split('T');
      const pickup: CustomPickupDto = { kind: 'pickup', reservationId: pickupReservationId, customOrderId: row.customOrderId, date, time, status: 'confirmed', updatedAt: asOf, revision: next.revision };
      pickups.push(pickup);
      orders[orders.indexOf(order(row.customOrderId))] = { ...order(row.customOrderId), pickup, confirmedPickupAt: row.proposedPickupAt };
      return receipt(row.customOrderId, next.revision, { customOrderId: row.customOrderId, pickupReservationId, stage: next.stage });
    }
    if (type === 'customOrder.setStage') {
      const next = bump(row, { stage: args.nextStage as 'in_production' });
      return receipt(row.customOrderId, next.revision, { customOrderId: row.customOrderId, stage: next.stage });
    }
    if (type === 'customOrder.cancel') {
      if (remaining(row) > 0) return reply(409, { code: 'CONFLICT', reason: 'PAYMENT_REVERSAL_REQUIRED' });
      const next = bump(row, { stage: 'canceled' });
      return receipt(row.customOrderId, next.revision, { customOrderId: row.customOrderId, stage: next.stage });
    }
    const next = bump(row, { stage: 'received_by_customer' });
    return receipt(row.customOrderId, next.revision, { customOrderId: row.customOrderId, stage: next.stage, recognitionId: 'recognition-1' });
  });
  const tender = (parts: readonly Part[]) => parts.filter((part): part is Allocation => part.kind === 'method');
  const valueOf = (parts: readonly Part[], kind: 'charge' | 'receivable') => parts.filter(part => part.kind === kind).reduce((sum, part) => sum + part.amount, 0);
  /** B08-2: member value needs a linked member; charge cannot exceed the balance. */
  const refuseValue = (row: CustomOrderDto, parts: readonly Part[]) => {
    if (!valueOf(parts, 'charge') && !valueOf(parts, 'receivable')) return undefined;
    if (!row.memberId || !members.has(row.memberId)) return 'MEMBER_REQUIRED';
    return valueOf(parts, 'charge') > account(row.memberId).charge ? 'CHARGE_BALANCE_EXCEEDED' : undefined;
  };
  const accountEffects = (row: CustomOrderDto, parts: readonly Part[]) => [
    ...(valueOf(parts, 'charge') ? [{ memberId: row.memberId!, account: 'charge', kind: 'use', amount: -valueOf(parts, 'charge') }] : []),
    ...(valueOf(parts, 'receivable') ? [{ memberId: row.memberId!, account: 'receivable', kind: 'sale', amount: valueOf(parts, 'receivable') }] : []),
  ];
  const issue = (reason: string) => ({ ok: false, code: 'VALIDATION', reason, messageKey: 'x' });
  backend.on('GET', /^\/pos\/member-accounts\/[^/]+$/, ({ path }) => {
    const memberId = path.split('/')[3];
    return { memberId, chargeBalance: account(memberId).charge, receivableBalance: account(memberId).receivable, revision: 1 };
  });
  backend.on('POST', /^\/pos\/custom-orders\/[^/]+\/settlement-quote$/, ({ path, body }) => {
    const row = order(path.split('/')[3]);
    const parts = (body as { allocations: Part[] }).allocations;
    const amountDue = Math.max(0, (row.quoteAmount ?? 0) - remaining(row));
    const total = parts.reduce((sum, part) => sum + part.amount, 0);
    const reason = refuseValue(row, parts) ?? (total !== amountDue || amountDue <= 0 ? 'ALLOCATION_SUM_MISMATCH' : undefined);
    return { quoteId: `quote-${row.revision}-${total}`, quoteRevision: row.revision, orderQuoteRevision: row.quoteRevision, target: { purpose: 'custom_order', customOrderId: row.customOrderId },
      amountDue, allocations: parts, realMethodSplits: tender(parts).map(({ method, amount }) => ({ method, amount })), discounts: [], recognitionEffects: [],
      accountEffects: reason ? [] : accountEffects(row, parts), membershipEffects: [], remaining: amountDue - total, canSubmit: !reason, issues: reason ? [issue(reason)] : [] };
  });
  backend.on('POST', /^\/pos\/custom-orders\/[^/]+\/payments$/, ({ path, body }) => {
    const row = order(path.split('/')[3]);
    const input = body as { allocations: Part[]; terminal?: { approvalNo?: string; receiptNo?: string; occurredAt: string }; expectedRevision: number };
    const refused = stale(row, input.expectedRevision); if (refused) return refused;
    const reason = refuseValue(row, input.allocations);
    if (reason) return reply(409, { code: 'CONFLICT', reason });
    if (tender(input.allocations).some(part => part.method !== 'cash') && !input.terminal) return reply(400, { code: 'VALIDATION', reason: 'TERMINAL_RECORD_REQUIRED', field: 'terminal' });
    const charge = valueOf(input.allocations, 'charge'), receivable = valueOf(input.allocations, 'receivable');
    const deposits = tender(input.allocations).reduce((sum, part) => sum + part.amount, 0);
    const before = { balance: row.memberId ? { ...members.get(row.memberId)! } : undefined, order: row };
    if (row.memberId && (charge || receivable)) { account(row.memberId).charge -= charge; account(row.memberId).receivable += receivable; }
    used.set(row.customOrderId, { charge, receivable });
    paid.set(row.customOrderId, tender(input.allocations));
    const pure = deposits === 0;
    const next = bump(row, { settlementId: 'settlement-1', paymentId: pure ? null : 'payment-1', stage: row.stage === 'payment_pending' ? 'in_production' : row.stage,
      payment: { ...unpaid, status: 'paid', amountSettled: row.quoteAmount!, realDeposits: deposits, chargeApplied: charge, receivableAmount: receivable } });
    const affectedSources = ['custom-order', 'pos.deposits', 'pos.ledger', ...(charge || receivable ? ['pos.member-accounts'] : [])];
    if (!pure) return receipt(row.customOrderId, next.revision, { customOrderId: row.customOrderId, settlementId: 'settlement-1', paymentId: 'payment-1', affectedSources });
    // A payment made only of member value: no tender, the receipt is the settlement, and it carries the short undo.
    const sent = { resourceId: row.customOrderId, revision: next.revision, receiptId: `settlement-${id('settlement')}`, changed: true, affectedSources, customOrderId: row.customOrderId,
      settlementId: 'settlement-1', paymentId: null, undoUntil: '2999-01-01T00:00:00Z' };
    undoers.set(sent.receiptId, () => {
      if (row.memberId && before.balance) members.set(row.memberId, before.balance);
      used.delete(row.customOrderId);
      bump(order(row.customOrderId), { settlementId: null, paymentId: null, stage: before.order.stage, payment: unpaid });
    });
    return sent;
  });
  backend.on('POST', /^\/pos\/custom-orders\/[^/]+\/reversal-quote$/, ({ path, body }) => {
    const row = order(path.split('/')[3]);
    const { kind, amount } = body as { kind: 'cancellation' | 'refund'; amount?: number };
    const available = remaining(row), value = amount ?? available;
    const drawn = used.get(row.customOrderId) ?? { charge: 0, receivable: 0 };
    const collected = drawn.receivable > 0 && !!row.memberId && account(row.memberId).collected;
    const reason = value <= 0 || value > available ? 'REFUND_LIMIT' : collected ? 'RECEIVABLE_ALREADY_COLLECTED' : undefined;
    const effects = reason || !row.memberId ? [] : [
      ...(drawn.charge ? [{ memberId: row.memberId, account: 'charge', kind: 'reversal', amount: drawn.charge, originalTxnId: 'txn-charge' }] : []),
      ...(drawn.receivable ? [{ memberId: row.memberId, account: 'receivable', kind: 'reversal', amount: -drawn.receivable, originalTxnId: 'txn-receivable' }] : []),
    ];
    return { quoteId: `reversal-${row.revision}-${value}`, quoteRevision: row.revision, customOrderId: row.customOrderId, settlementId: 'settlement-1', kind, amount: value, remainingRefundable: available,
      realMethodReturns: reason ? [] : returnsFor(row, Math.min(value, row.payment.realDeposits)), accountEffects: effects, recognitionEffects: [], canSubmit: !reason, issues: reason ? [issue(reason)] : [] };
  });
  backend.on('POST', /^\/pos\/custom-orders\/[^/]+\/corrections$/, ({ path, body }) => {
    const row = order(path.split('/')[3]);
    const input = body as { kind: 'cancellation' | 'refund'; amount?: number; confirmed?: boolean; terminal?: unknown; expectedRevision: number };
    const refused = stale(row, input.expectedRevision); if (refused) return refused;
    if (input.confirmed !== true) return reply(400, { code: 'VALIDATION', reason: 'CONFIRMATION_REQUIRED' });
    const value = input.amount ?? remaining(row);
    const drawn = used.get(row.customOrderId) ?? { charge: 0, receivable: 0 };
    if (row.memberId && drawn.receivable > 0 && account(row.memberId).collected) return reply(409, { code: 'CONFLICT', reason: 'RECEIVABLE_ALREADY_COLLECTED' });
    if (returnsFor(row, Math.min(value, row.payment.realDeposits)).some(part => part.method !== 'cash') && !input.terminal) return reply(400, { code: 'VALIDATION', reason: 'TERMINAL_RECORD_REQUIRED', field: 'terminal' });
    if (row.memberId && (drawn.charge || drawn.receivable)) { account(row.memberId).charge += drawn.charge; account(row.memberId).receivable -= drawn.receivable; used.delete(row.customOrderId); }
    const returned = row.payment.amountReturned + value;
    const next = bump(row, { stage: input.kind === 'cancellation' ? 'canceled' : row.stage,
      payment: { ...row.payment, status: input.kind === 'refund' ? 'refunded' : 'canceled', amountReturned: returned, realDeposits: Math.max(0, row.payment.realDeposits - value),
        chargeApplied: 0, receivableAmount: 0 } });
    if (input.kind === 'cancellation') for (const [index, pickup] of pickups.entries()) if (pickup.customOrderId === row.customOrderId) pickups[index] = { ...pickup, status: 'canceled' };
    return receipt(row.customOrderId, next.revision, { customOrderId: row.customOrderId, correctionId: 'correction-1', affectedSources: ['custom-order', 'pos.deposits', 'pos.ledger', 'pos.member-accounts'] });
  });
  backend.on('POST', /^\/pos\/custom-pickups\/[^/]+\/transitions$/, ({ path, body }) => {
    const pickup = pickups.find(row => row.reservationId === path.split('/')[3])!;
    const row = order(pickup.customOrderId);
    const input = body as { type: string; expectedRevision: number; date?: string; time?: string };
    const refused = stale(row, input.expectedRevision); if (refused) return refused;
    const next = bump(row, {});
    const index = pickups.findIndex(p => p.reservationId === pickup.reservationId);
    pickups[index] = { ...pickups[index], date: input.date ?? pickup.date, time: input.time ?? pickup.time };
    return receipt(row.customOrderId, next.revision, { customOrderId: row.customOrderId, pickupReservationId: pickup.reservationId });
  });
  return {
    backend, templates, orders, pickups,
    /** A linked member with a prepaid charge and/or a debt (B05). `collected` marks the debt as already paid back. */
    setMember: (memberId: string, value: { charge?: number; receivable?: number; collected?: boolean }) => { members.set(memberId, { charge: 0, receivable: 0, collected: false, ...value }); },
    member: (memberId: string) => ({ ...account(memberId) }),
  };
}
