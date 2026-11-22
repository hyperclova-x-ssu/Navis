import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { inventoryQuantityInUnit } from './inventory.mjs';
import { resolveAgentTarget } from './registry.mjs';

const lookup = (kind, querySlot) => ({ name: 'search_records', args: { kind, querySlot } });
const suggestionWidget = () => ({ name: 'get_widget', args: { featureId: 'suppliers', condition: { kind: 'default' } } });
const clarify = field => ({ outcome: 'clarify', field });
const refuse = reason => ({ outcome: 'refused', reason });
const ready = args => ({ outcome: 'ready', args });
const openStatuses = ['scheduled', 'partial'];
const positive = value => Number.isFinite(value) && value > 0;
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const readable = search => ['ready', 'missing'].includes(search?.status);
const fieldsOf = match => match.fields ?? {};
const targets = Object.freeze({
  'suppliers.createPurchaseItem': ['stock', 'itemId'],
  'suppliers.updatePurchaseItem': ['purchaseItem', 'purchaseItemId'],
  'suppliers.deletePurchaseItem': ['purchaseItem', 'purchaseItemId'],
  'suppliers.createSupplier': ['supplier', 'name'],
  'suppliers.updateSupplier': ['supplier', 'supplierId'],
  'suppliers.deleteSupplier': ['supplier', 'supplierId'],
  'suppliers.createOrder': ['purchaseItem', 'purchaseItemId'],
  'suppliers.changeDueDate': ['purchaseOrder', 'poId'],
  'suppliers.cancelOrder': ['purchaseOrder', 'poId'],
  'suppliers.recordReceipt': ['purchaseOrderLine', 'polId'],
});

function purchaseQuantity(qty, sourceUnit, unit, basePerUnit) {
  const baseUnit = unit === 'L' ? 'mL' : unit === 'kg' ? 'g' : unit;
  const converted = sourceUnit === unit && basePerUnit !== undefined
    ? { value: qty } : inventoryQuantityInUnit(qty, sourceUnit, unit);
  if ('field' in converted) return clarify(converted.field === 'quantity' ? 'qty' : converted.field);
  const value = converted.value;
  if (!positive(value)) return clarify('qty');
  if (basePerUnit === undefined) {
    const base = inventoryQuantityInUnit(value, unit, baseUnit);
    return 'value' in base ? { qty: value, addedBase: base.value } : clarify('qty');
  }
  const base = value * basePerUnit;
  const addedBase = Math.round(base);
  return positive(basePerUnit) && Number.isSafeInteger(addedBase) && addedBase > 0 && Math.abs(base - addedBase) < 1e-7
    ? { qty: value, addedBase } : clarify('qty');
}

function isoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value ? day : undefined;
}

/** Unsaved calculation over a scoped purchase item. The caller localizes the facts. */
export function prepareSupplierEstimate({ item, qty, sourceUnit = item?.unit, businessDate, dueDate, hasOpenOrder = false }) {
  const baseDay = isoDay(businessDate);
  if (!baseDay || !item || !positive(item.minimumQty) || !positive(item.orderStep)
    || !positiveInteger(item.unitPrice) || !nonnegativeInteger(item.leadDays)) return refuse('unavailable');
  const quantity = purchaseQuantity(qty, sourceUnit, item.unit, item.basePerUnit);
  if (quantity.outcome) return quantity;
  if (quantity.qty < item.minimumQty) return clarify('minimumQty');
  const steps = quantity.qty / item.orderStep;
  if (!Number.isFinite(steps) || Math.abs(steps - Math.round(steps)) > 1e-9) return clarify('orderStep');

  if (dueDate === undefined) {
    baseDay.setUTCDate(baseDay.getUTCDate() + item.leadDays);
    if (!Number.isFinite(baseDay.getTime())) return clarify('dueDate');
    dueDate = baseDay.toISOString().split('T')[0];
  }
  if (!isoDay(dueDate)) return clarify('dueDate');
  if (dueDate < businessDate) return refuse('invalid_target');
  const total = Math.round(quantity.qty * item.unitPrice);
  if (!nonnegativeInteger(total)) return clarify('qty');
  return { outcome: 'ready', qty: quantity.qty, unit: item.unit, unitPrice: item.unitPrice, total, dueDate, hasOpenOrder };
}

/** The purchase line supplies the conversion and immutable price for the intake. */
export function prepareSupplierReceipt({ line, qty, sourceUnit = line?.unit }) {
  const issue = openOrderIssue(line ?? {}, true);
  if (issue) return issue;
  if (!nonnegativeInteger(line.unitPrice)) return refuse('unavailable');
  const quantity = purchaseQuantity(qty, sourceUnit, line.unit, line.basePerUnit);
  if (quantity.outcome) return quantity;
  if (quantity.qty < 1 || quantity.qty > line.remaining) return clarify('qty');
  const expenseCandidate = Math.round(quantity.qty * line.unitPrice);
  if (!nonnegativeInteger(expenseCandidate)) return clarify('qty');
  return { outcome: 'ready', ...quantity, remaining: line.remaining - quantity.qty, expenseCandidate };
}

function openOrderIssue(fields, receipt) {
  if (typeof fields.open !== 'boolean' || !fields.status || receipt && !Number.isFinite(fields.remaining)) return refuse('unavailable');
  if (!fields.open || !openStatuses.includes(fields.status) || receipt && fields.remaining < 1) return refuse('invalid_target');
  return undefined;
}

function checkTarget(read, wanted, lookupIndex, field) {
  if (!readable(read)) return { issue: refuse('unavailable') };
  const { match, choices } = resolveAgentTarget(read);
  if (!match) return { issue: choices.length ? { outcome: 'ambiguous', lookupIndex, field } : refuse('invalid_target') };
  if (match.handle !== wanted?.handle) return { issue: refuse('invalid_target') };
  return { fields: fieldsOf(match) };
}

function nameConflict(read, except) {
  if (!readable(read) || read.nextCursor) return refuse('unavailable');
  if (!read.matches.some(match => match.match === 'exact' && match.handle !== except)) return undefined;
  return except ? refuse('duplicate') : clarify('name');
}

function supplierLookups({ intent, slots }) {
  const { command, args = {}, querySlot = 'name' } = intent;
  if (!slots.includes(querySlot)) return [];
  const [kind] = targets[command];
  const lookups = [lookup(kind, querySlot)];
  if (command === 'suppliers.createPurchaseItem') lookups.push(lookup('purchaseItem', querySlot));
  if (command === 'suppliers.createPurchaseItem' || command === 'suppliers.updatePurchaseItem' && args.patch?.supplierId) {
    const supplierSlot = slots.includes('supplierId') ? 'supplierId' : slots.includes('supplier') ? 'supplier' : undefined;
    if (supplierSlot) lookups.push(lookup('supplier', supplierSlot));
  }
  if (command === 'suppliers.createOrder' && args.suggestionItemId) return [suggestionWidget(), ...lookups, lookup('stock', querySlot)];
  const nameSlot = args.patch?.name?.slot;
  if (command === 'suppliers.updateSupplier' && nameSlot !== querySlot && slots.includes(nameSlot)) {
    lookups.push(lookup('supplier', nameSlot));
  }
  return lookups;
}

function prepareSupplierCommand({ input: { intent, slots }, reads }) {
  const { command, args = {} } = intent;
  if (!validateAgentToolArgs('propose_action', { command, args })) return clarify('change');
  for (const [field, value] of Object.entries(args)) {
    if (value && typeof value === 'object' && 'slot' in value && (value.slot !== field || !slots.includes(value.slot))) return clarify(field);
  }
  if (Object.entries(args.patch ?? {}).some(([field, value]) => value?.slot &&
      (value.slot !== field || !slots.includes(value.slot)))) return clarify('patch');
  if (command === 'suppliers.createSupplier') return nameConflict(reads[0]) ?? ready(args);

  const [, field] = targets[command];
  const targetIndex = command === 'suppliers.createOrder' && args.suggestionItemId ? 1 : 0;
  const { fields, issue } = checkTarget(reads[targetIndex], args[field], targetIndex, field);
  if (issue) return issue;
  switch (command) {
    case 'suppliers.createPurchaseItem': {
      if (fields.kind !== 'ingredient' || !fields.unit) return refuse('invalid_target');
      if (!readable(reads[1]) || reads[1].nextCursor) return refuse('unavailable');
      if (reads[1].matches.some(match => match.match === 'exact')) return refuse('duplicate');
      return checkTarget(reads[2], args.supplierId, 2, 'supplierId').issue ?? ready(args);
    }
    case 'suppliers.updatePurchaseItem':
      return (args.patch.supplierId && checkTarget(reads[1], args.patch.supplierId, 1, 'supplierId').issue) || ready(args);
    case 'suppliers.deletePurchaseItem':
    case 'suppliers.deleteSupplier':
      return fields.referenced === false ? ready(args) : refuse(fields.referenced === true ? 'invalid_target' : 'unavailable');
    case 'suppliers.updateSupplier':
      return (args.patch.name ? nameConflict(reads[1], args.supplierId.handle) : undefined) ?? ready(args);
    case 'suppliers.createOrder': {
      if (!fields.unit || !positive(fields.minimumQty) || !positive(fields.orderStep)
        || !positiveInteger(fields.unitPrice) || !nonnegativeInteger(fields.leadDays)) return refuse('unavailable');
      if (!args.suggestionItemId) return ready(args);
      if (fields.suggested !== true) return refuse('invalid_target');
      const stockIndex = targetIndex + 1;
      const stock = checkTarget(reads[stockIndex], args.suggestionItemId, stockIndex, 'suggestionItemId');
      return stock.issue ?? (stock.fields.kind === 'ingredient' ? ready(args) : refuse('invalid_target'));
    }
    case 'suppliers.changeDueDate':
    case 'suppliers.cancelOrder':
      return openOrderIssue(fields, false) ?? ready(args);
    case 'suppliers.recordReceipt':
      return openOrderIssue(fields, true) ?? (fields.unit && nonnegativeInteger(fields.unitPrice) ? ready(args) : refuse('unavailable'));
  }
  return refuse('unsupported');
}

export function createSupplierAdapters({ allowLocalScheduling = true } = {}) {
  return Object.freeze(Object.keys(targets).map(command => Object.freeze({
    command,
    ...(command === 'suppliers.createOrder' && allowLocalScheduling !== true
      ? { prepare: () => refuse('widget_only') }
      : { lookups: supplierLookups, prepare: prepareSupplierCommand }),
  })));
}

export const supplierAdapters = createSupplierAdapters();
