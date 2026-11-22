import { confirmation, date, object, revision, StockError, uuid } from '../03/wire.ts';

export class PurchaseError extends StockError {
  constructor(status: StockError['status'], reason: string, field?: string, readonly details?: Record<string, unknown>) {
    super(status, reason, field);
  }
}

export const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);

export function milliquantity(input: string | number): bigint {
  const [whole, fraction = ''] = String(input).split('.');
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
}

export function positiveQuantity(input: unknown, field: string, minimum = 0.001) {
  if (typeof input !== 'number' || input < minimum || !/^\d+(?:\.\d{1,3})?$/.test(String(input))
      || input > Number.MAX_SAFE_INTEGER) {
    throw new PurchaseError(400, field === 'qty' ? 'ORDER_QTY_INVALID' : 'PURCHASE_INVALID', field);
  }
  return input;
}

function int(input: unknown, field: string, maximum: number) {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > maximum) {
    throw new PurchaseError(400, 'PURCHASE_INVALID', field);
  }
  return input;
}

function supplierText(input: unknown, field: string, maximum: number, required: boolean) {
  if (required === false && (input === null || input === '')) return null;
  if (typeof input !== 'string' || (required && !input.trim()) || input.trim().length > maximum
      // eslint-disable-next-line no-control-regex -- Purchasing text must reject ASCII controls.
      || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new PurchaseError(400, 'SUPPLIER_INVALID', field);
  }
  return input.trim() || null;
}

export type SupplierFields = { name: string; contact: string | null; phone: string | null; memo: string | null };
export type TermsFields = { supplierId: string; minimumQty: number; orderStep: number; unitPrice: number; leadDays: number };

function supplierFields(input: Record<string, unknown>) {
  return {
    ...(input.name === undefined ? {} : { name: supplierText(input.name, 'name', 120, true)! }),
    ...(input.contact === undefined ? {} : { contact: supplierText(input.contact, 'contact', 120, false) }),
    ...(input.phone === undefined ? {} : { phone: supplierText(input.phone, 'phone', 60, false) }),
    ...(input.memo === undefined ? {} : { memo: supplierText(input.memo, 'memo', 500, false) }),
  };
}

function termsFields(input: Record<string, unknown>) {
  return {
    ...(input.supplierId === undefined ? {} : { supplierId: uuid(input.supplierId, 'supplierId') }),
    ...(input.minimumQty === undefined ? {} : { minimumQty: positiveQuantity(input.minimumQty, 'minimumQty') }),
    ...(input.orderStep === undefined ? {} : { orderStep: positiveQuantity(input.orderStep, 'orderStep') }),
    ...(input.unitPrice === undefined ? {} : { unitPrice: int(input.unitPrice, 'unitPrice', Number.MAX_SAFE_INTEGER) }),
    ...(input.leadDays === undefined ? {} : { leadDays: int(input.leadDays, 'leadDays', 3650) }),
  };
}

const supplierKeys = ['name', 'contact', 'phone', 'memo'];
const termsKeys = ['supplierId', 'minimumQty', 'orderStep', 'unitPrice', 'leadDays'];
export type Operation = 'create_supplier' | 'update_supplier' | 'archive_supplier' | 'create_terms' | 'update_terms'
  | 'archive_terms' | 'create_order' | 'change_due_date' | 'cancel_order' | 'receive' | 'undo';

export function parseCommand(operation: Operation, body: unknown, id?: string) {
  switch (operation) {
    case 'create_supplier': {
      const input = object(body, supplierKeys, true);
      const { name, contact, phone, memo } = supplierFields(input);
      if (!name) throw new PurchaseError(400, 'SUPPLIER_INVALID', 'name');
      return { operation, fields: { name, contact: contact ?? null, phone: phone ?? null, memo: memo ?? null } };
    }
    case 'update_supplier': {
      const input = object(body, [...supplierKeys, 'expectedRevision'], true);
      const fields = supplierFields(input);
      if (!Object.keys(fields).length) throw new PurchaseError(400, 'INVALID_REQUEST');
      return { operation, id: uuid(id, 'supplierId'), expected: revision(input.expectedRevision), fields };
    }
    case 'create_terms': {
      const input = object(body, [...termsKeys, 'itemId'], true);
      const fields = termsFields(input);
      for (const field of termsKeys) {
        if (input[field] === undefined) throw new PurchaseError(400, 'PURCHASE_INVALID', field);
      }
      return { operation, itemId: uuid(input.itemId, 'itemId'), fields: fields as TermsFields };
    }
    case 'update_terms': {
      const input = object(body, [...termsKeys, 'expectedRevision'], true);
      const fields = termsFields(input);
      if (!Object.keys(fields).length) throw new PurchaseError(400, 'INVALID_REQUEST');
      return { operation, id: uuid(id, 'purchaseItemId'), expected: revision(input.expectedRevision), fields };
    }
    case 'archive_supplier':
    case 'archive_terms':
    case 'cancel_order': {
      const input = object(body, ['expectedRevision', 'confirmed'], true);
      confirmation(input.confirmed);
      const fields = { archive_supplier: 'supplierId', archive_terms: 'purchaseItemId', cancel_order: 'poId' };
      return { operation, id: uuid(id, fields[operation]), expected: revision(input.expectedRevision) };
    }
    case 'create_order': {
      const input = object(body, ['purchaseItemId', 'qty', 'dueDate', 'suggestionItemId', 'confirmDuplicate', 'expectedRevision'], true);
      if (input.confirmDuplicate !== undefined && typeof input.confirmDuplicate !== 'boolean') {
        throw new PurchaseError(400, 'INVALID_REQUEST', 'confirmDuplicate');
      }
      return { operation, id: uuid(input.purchaseItemId, 'purchaseItemId'), expected: revision(input.expectedRevision),
        qty: positiveQuantity(input.qty, 'qty'), dueDate: input.dueDate === undefined ? null : date(input.dueDate, 'dueDate'),
        suggestionItemId: input.suggestionItemId === undefined ? null : uuid(input.suggestionItemId, 'suggestionItemId'),
        confirmDuplicate: input.confirmDuplicate === true };
    }
    case 'change_due_date': {
      const input = object(body, ['dueDate', 'expectedRevision'], true);
      return { operation, id: uuid(id, 'poId'), expected: revision(input.expectedRevision), dueDate: date(input.dueDate, 'dueDate') };
    }
    case 'receive': {
      const input = object(body, ['polId', 'qty', 'expectedRevision'], true);
      return { operation, id: uuid(id, 'poId'), polId: uuid(input.polId, 'polId'),
        qty: positiveQuantity(input.qty, 'qty', 1), expected: revision(input.expectedRevision) };
    }
    case 'undo':
      object(body, [], true);
      return { operation, id: uuid(id, 'receiptId') };
  }
}

export type Command = ReturnType<typeof parseCommand>;
