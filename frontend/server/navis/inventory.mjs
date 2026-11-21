import { validateAgentCommandArgs, validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

const commands = Object.freeze([
  'inventory.createItem', 'inventory.updateItem', 'inventory.moveChannel', 'inventory.deleteItem', 'inventory.setTracking',
]);
const units = Object.freeze({ pcs: ['pcs', 1], g: ['g', 1], kg: ['g', 1000], mL: ['mL', 1], L: ['mL', 1000] });
const isChannelBalance = value => Number.isSafeInteger(value) && value >= 0;
const clarify = field => ({ outcome: 'clarify', field });
const refuse = reason => ({ outcome: 'refused', reason });
const stockLookup = querySlot => ({ name: 'search_records', args: { kind: 'stock', querySlot } });

export function inventoryQuantityInUnit(value, source, target) {
  if (source === 'box') return { field: 'packSize' };
  if (!Object.hasOwn(units, source) || !Object.hasOwn(units, target) || units[source][0] !== units[target][0]) {
    return { field: 'unit' };
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { field: 'quantity' };
  const base = value * units[source][1];
  const rounded = Math.round(base);
  if (!Number.isSafeInteger(rounded) || Math.abs(base - rounded) >= 1e-7) return { field: 'quantity' };
  return { value: rounded / units[target][1] };
}

function targetIssue(command, target) {
  if (!target || !Object.hasOwn(units, target.unit) || !['ingredient', 'retail'].includes(target.kind)) return refuse('unavailable');
  if (command === 'inventory.moveChannel') {
    if (target.kind !== 'retail' || target.unit !== 'pcs') return refuse('invalid_target');
    if (!isChannelBalance(target.store) || !isChannelBalance(target.online)) return refuse('unavailable');
  } else if (target.kind !== 'ingredient') {
    return refuse('invalid_target');
  }
  if (command === 'inventory.deleteItem' && target.referenced !== false) {
    return refuse(target.referenced === true ? 'invalid_target' : 'unavailable');
  }
  return undefined;
}

function trackingFacts(flags, stock, threshold) {
  const needsRestock = flags.trackRestock && threshold !== null && stock <= threshold;
  const outOfStock = flags.trackRestock && stock === 0;
  return {
    trackRestock: flags.trackRestock, trackExpiry: flags.trackExpiry,
    needsRestock, outOfStock,
    status: flags.trackExpiry ? 'same-day' : outOfStock ? 'out-of-stock' : needsRestock ? 'restock' : 'sufficient',
  };
}

/** Preflight for expanded local values. Values and the resulting preview stay with the caller. */
export function prepareInventoryPreview(command, args, { target, occupiedSku, duplicateName } = {}) {
  if (!commands.includes(command)) return refuse('unsupported');
  if (!args || typeof args !== 'object' || Array.isArray(args)) return clarify('change');
  const create = command === 'inventory.createItem';
  const move = command === 'inventory.moveChannel';
  if (!create) {
    const issue = targetIssue(command, target);
    if (issue) return issue;
  }
  if (move) {
    if (!['store', 'online'].includes(args.from) || !['store', 'online'].includes(args.to) || args.from === args.to) {
      return clarify('direction');
    }
    if (!Number.isSafeInteger(args.qty) || args.qty <= 0 || args.qty > target[args.from]
      || !Number.isSafeInteger(target[args.to] + args.qty)) return clarify('qty');
  }
  if (create && !Object.hasOwn(units, args.unit)) return clarify('unit');
  for (const field of ['stock', 'threshold']) {
    if (!create && args[field] === undefined) continue;
    const unit = create ? args.unit : target.unit;
    if ('field' in inventoryQuantityInUnit(args[field], unit, unit)) return clarify(field);
  }
  if (create && (typeof args.sku !== 'string' || !args.sku.trim() || occupiedSku)) return clarify('sku');
  if ((create || args.name !== undefined) && (typeof args.name !== 'string' || !args.name.trim())) return clarify('name');
  if (duplicateName) return clarify(create ? 'duplicate' : 'name');
  if (command === 'inventory.updateItem' && args.name === undefined && args.stock === undefined && args.threshold === undefined) {
    return clarify('stock');
  }
  if (!validateAgentCommandArgs(command, args)) return clarify('change');
  if (move) {
    return {
      outcome: 'ready', before: { store: target.store, online: target.online },
      after: { [args.from]: target[args.from] - args.qty, [args.to]: target[args.to] + args.qty },
    };
  }
  if (command === 'inventory.setTracking') {
    if (![target.trackRestock, target.trackExpiry].every(value => typeof value === 'boolean')
      || !Number.isFinite(target.stock) || target.stock < 0
      || target.threshold !== null && (!Number.isFinite(target.threshold) || target.threshold < 0)) {
      return refuse('unavailable');
    }
    const before = trackingFacts(target, target.stock, target.threshold);
    const after = trackingFacts({ ...before, ...args }, target.stock, target.threshold);
    return after.trackRestock === before.trackRestock && after.trackExpiry === before.trackExpiry
      ? { outcome: 'unchanged' } : { outcome: 'ready', before, after };
  }
  if (command === 'inventory.updateItem' && (args.name === undefined || args.name.trim() === target.name)
    && (args.stock === undefined || args.stock === target.rawStock)
    && (args.threshold === undefined || args.threshold === target.threshold)) return { outcome: 'unchanged' };
  return { outcome: 'ready' };
}

function stockSearches({ intent, slots, searches = [] }) {
  const { command, args = {}, querySlot } = intent;
  const name = querySlot ?? 'name';
  if (!slots.includes(name)) return [];
  const lookups = [stockLookup(name)];
  if (command === 'inventory.createItem' && args.sku?.slot && args.sku.slot !== name
    && searches.some(search => search.kind === 'stock' && search.querySlot === args.sku.slot && !search.cursor)) {
    lookups.push(stockLookup(args.sku.slot));
  }
  return lookups;
}

function prepareStock({ input: { intent }, reads: [search, skuSearch] }) {
  const { command, args = {} } = intent;
  if (!search || !['ready', 'missing'].includes(search.status)) return refuse('unavailable');
  if (command === 'inventory.createItem') {
    if (skuSearch && (!['ready', 'missing'].includes(skuSearch.status) || skuSearch.nextCursor)) return refuse('unavailable');
    if (skuSearch?.matches.some(match => match.match === 'exact')) return clarify('sku');
    if (search.nextCursor || search.matches.some(match => match.match === 'exact')) return clarify('duplicate');
  } else {
    const { match, choices } = resolveAgentTarget(search);
    if (!match) return choices.length ? { outcome: 'ambiguous', lookupIndex: 0, field: 'itemId' } : refuse('invalid_target');
    if (match.handle !== args.itemId?.handle) return refuse('invalid_target');
    const issue = targetIssue(command, match.fields);
    if (issue) return issue;
    if (command === 'inventory.moveChannel') {
      if (args.from === args.to) return clarify('direction');
      if (match.fields[args.from] === 0 || match.fields[args.to] === Number.MAX_SAFE_INTEGER) return clarify('qty');
    }
  }
  if (!validateAgentToolArgs('propose_action', { command, args })) return clarify('change');
  return { outcome: 'ready', args };
}

export const inventoryAdapters = Object.freeze(commands.map(command => Object.freeze({
  command, lookups: stockSearches, prepare: prepareStock,
})));
