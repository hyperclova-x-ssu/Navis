import {
  AGENT_MENU_EDIT_COMMANDS, agentCommandRefs, validateAgentToolArgs,
} from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

// The anchor's duplicate check is read-only.
export const menuCreateAdapter = {
  command: 'menu.create',
  lookups: () => [{ name: 'search_records', args: { kind: 'menu', querySlot: 'name' } }],
  prepare({ input, reads: [search] }) {
    if (!['ready', 'missing'].includes(search?.status) || search.nextCursor) return { outcome: 'refused', reason: 'unavailable' };
    if (search.matches.length) return { outcome: 'refused', reason: 'duplicate' };
    const category = input.intent.category ?? input.intent.args?.category;
    if (!category) return { outcome: 'clarify', field: 'category' };
    if (!input.slots.includes('price')) return { outcome: 'clarify', field: 'price' };
    return {
      outcome: 'ready',
      args: {
        name: { slot: 'name' }, category, price: { slot: 'price' },
        ...(input.slots.includes('memo') ? { memo: { slot: 'memo' } } : {}),
      },
    };
  },
};

const searchMenu = querySlot => ({ name: 'search_records', args: { kind: 'menu', querySlot } });
const refuse = reason => ({ outcome: 'refused', reason });
const clarify = field => ({ outcome: 'clarify', field });
const liveMenu = match => match.fields?.kind === 'menu' && ['selling', 'sold_out'].includes(match.fields.status);

function lookupPlan(command, { intent, slots, layer, searches }) {
  const { args = {}, querySlot = 'name' } = intent;
  if (layer === 'pos' || !slots.includes(querySlot)) return [];
  const lookups = [searchMenu(querySlot)];
  const nameSlot = args.patch?.name?.slot;
  if (command === 'menu.update' && nameSlot !== querySlot && slots.includes(nameSlot)) {
    lookups.push(searchMenu(nameSlot));
  }
  if (command === 'menu.setRecipe' && args.menuId) {
    const search = searches?.find(entry => entry.kind === 'menu' && entry.querySlot === querySlot && !entry.cursor);
    const { match } = resolveAgentTarget(search && { ...search, status: search.status ?? 'ready' });
    if (match && liveMenu(match) && match.handle === args.menuId.handle) {
      lookups.push({ name: 'get_recipe', args: { menuId: args.menuId } });
    }
  }
  return lookups;
}

export const menuEditAdapters = AGENT_MENU_EDIT_COMMANDS.map(command => ({
  command,
  lookups: input => lookupPlan(command, input),
  prepare({ input, reads: [search, detail] }) {
    const { args = {}, querySlot = 'name' } = input.intent;
    if (input.layer === 'pos') return refuse('out_of_scope');
    if (!input.slots.includes(querySlot)) return clarify('menuId');
    if (!['ready', 'missing'].includes(search?.status)) return refuse('unavailable');
    const { match, choices } = resolveAgentTarget(search);
    if (choices?.length) return { outcome: 'ambiguous', lookupIndex: 0, field: 'menuId' };
    if (!match || !liveMenu(match)) return refuse('invalid_target');
    if (!args.menuId) return clarify('menuId');
    if (args.menuId.handle !== match.handle) return refuse('invalid_target');

    if (!validateAgentToolArgs('propose_action', { command, args })
        || agentCommandRefs(command, args).some(ref => ref.slot && !input.slots.includes(ref.slot))) {
      return refuse('unsupported');
    }
    if (command === 'menu.update' && args.patch.name) {
      if (!['ready', 'missing'].includes(detail?.status) || detail.nextCursor) return refuse('unavailable');
      // Rename follows the canonical write guard. Similar names may coexist.
      if (detail.matches.some(candidate => candidate.match === 'exact' && candidate.handle !== match.handle)) {
        return refuse('duplicate');
      }
    }
    if (command === 'menu.setRecipe' && (!['ready', 'missing'].includes(detail?.status) || detail.truncated)) {
      return refuse('unavailable');
    }
    return { outcome: 'ready', args, ...(command === 'menu.delete' ? { tier: 'extra-confirm' } : {}) };
  },
}));
