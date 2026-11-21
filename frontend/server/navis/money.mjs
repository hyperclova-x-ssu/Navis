import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

const refuse = reason => ({ outcome: 'refused', reason });
const scopedSearch = (kind, querySlot) => ({ name: 'search_records', args: { kind, querySlot } });
const targetFields = {
  'ledger.updateExpense': 'expenseId',
  'ledger.confirmCandidate': 'expenseId',
  'tax.updatePayment': 'taxPaymentId',
  'tax.deletePayment': 'taxPaymentId',
  'tax.markChecked': 'refId',
  'tax.setEvidence': 'taxPaymentId',
};

function lookupFor({ intent, slots, searches }, kinds, field) {
  const querySlot = intent.querySlot;
  const matching = searches.filter(search => !search.cursor && kinds.includes(search.kind)
    && slots.includes(search.querySlot) && (querySlot === undefined || search.querySlot === querySlot));
  if (matching.length === 1) return [scopedSearch(matching[0].kind, matching[0].querySlot)];
  // Disambiguate multiple local searches using only the handle on the current draft.
  const wanted = intent.args?.[field]?.handle;
  const bound = matching.filter(search => search.matches.some(match => match.handle === wanted));
  return bound.length === 1 ? [scopedSearch(bound[0].kind, bound[0].querySlot)] : [];
}

function readTarget(read, wanted, field) {
  if (!read || !['ready', 'missing'].includes(read.status)) return { issue: refuse('unavailable') };
  const { match, choices } = resolveAgentTarget(read);
  if (choices?.length) return { issue: { outcome: 'ambiguous', lookupIndex: 0, field } };
  if (!match || match.handle !== wanted) return { issue: refuse('invalid_target') };
  return { fields: match.fields ?? {} };
}

function eligibility(command, args, fields) {
  switch (command) {
    case 'ledger.updateExpense':
      if (fields.closed === true) return refuse('widget_only');
      if (fields.closed !== false || fields.status === undefined) return refuse('unavailable');
      return fields.status === 'confirmed' ? undefined : refuse('invalid_target');
    case 'ledger.confirmCandidate':
      return fields.status === 'candidate' ? undefined : refuse(fields.status ? 'invalid_target' : 'unavailable');
    case 'tax.markChecked':
      return fields.status === 'needs-check' ? undefined : refuse(fields.status ? 'invalid_target' : 'unavailable');
    case 'tax.deletePayment':
      return fields.status === 'unpaid' ? undefined : refuse(fields.status === 'paid' ? 'widget_only' : 'unavailable');
    case 'tax.setEvidence':
      return fields.evidence === undefined ? refuse('unavailable')
        : fields.evidence === args.evidence ? refuse('invalid_target') : undefined;
    case 'tax.updatePayment':
      return fields.status === undefined ? refuse('unavailable') : undefined;
  }
}

function moneyLookups(input) {
  const { command, args = {} } = input.intent;
  switch (command) {
    case 'ledger.recordExpense':
      return args.supplierId ? lookupFor(input, ['supplier'], 'supplierId') : [];
    case 'ledger.confirmCandidate':
      return lookupFor(input, ['candidate', 'expense'], 'expenseId');
    case 'ledger.updateExpense':
      return lookupFor(input, ['expense'], 'expenseId');
    case 'tax.createPayment':
      return input.slots.includes(args.taxType?.slot) ? [scopedSearch('taxPayment', args.taxType.slot)] : [];
    case 'tax.markChecked':
      return lookupFor(input, ['taxItem'], 'refId');
    default:
      return lookupFor(input, ['taxPayment'], 'taxPaymentId');
  }
}

function prepareMoneyCommand({ input: { intent }, reads }) {
  const { command, args = {} } = intent;
  if (!validateAgentToolArgs('propose_action', { command, args })) return { outcome: 'clarify', field: 'change' };
  if (command === 'ledger.recordExpense' && args.evidence === undefined) return { outcome: 'clarify', field: 'evidence' };
  if (command === 'tax.createPayment') {
    // The browser owns the amount/date behind the slots. The canonical local
    // handler compares the complete obligation before a card can execute.
    if (!['ready', 'missing'].includes(reads[0]?.status)) return refuse('unavailable');
  } else {
    const field = command === 'ledger.recordExpense' && args.supplierId ? 'supplierId' : targetFields[command];
    if (field) {
      const { fields, issue } = readTarget(reads[0], args[field]?.handle, field);
      const blocked = issue ?? eligibility(command, args, fields);
      if (blocked) return blocked;
    }
  }
  return { outcome: 'ready', args };
}

export function createMoneyAdapters({ allowExpenseEntry = true, allowTaxDelete = true } = {}) {
  const disabled = new Set([
    ...(allowExpenseEntry === true ? [] : ['ledger.recordExpense']),
    ...(allowTaxDelete === true ? [] : ['tax.deletePayment']),
  ]);
  return Object.freeze(['ledger.recordExpense', 'tax.createPayment', ...Object.keys(targetFields)]
    .map(command => Object.freeze({
      command,
      ...(disabled.has(command) ? { prepare: () => refuse('widget_only') }
        : { lookups: moneyLookups, prepare: prepareMoneyCommand }),
    })));
}

export const moneyAdapters = createMoneyAdapters();
