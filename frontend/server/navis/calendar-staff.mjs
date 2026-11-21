import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { resolveAgentTarget } from './registry.mjs';

const deleteCommands = new Set(['calendar.deleteEvent', 'staff.deleteSchedule']);
const commands = [
  'calendar.addEvent', 'calendar.addTodo', 'calendar.updateEvent', 'calendar.deleteEvent',
  'calendar.setCategoryVisible', 'calendar.setSourceVisible',
  'staff.create', 'staff.update', 'staff.delete', 'staff.saveSchedule', 'staff.deleteSchedule', 'staff.moveHandoff',
];
const targets = {
  'calendar.updateEvent': [['eventId', 'event']],
  'calendar.deleteEvent': [['eventId', 'event']],
  'staff.update': [['staffId', 'staff']],
  'staff.saveSchedule': [['staffId', 'staff'], ['scheduleId', 'shift']],
  'staff.deleteSchedule': [['scheduleId', 'shift']],
};
const eventChanges = ['title', 'date', 'time', 'memo', 'categoryId', 'storeClosure'];
const clarify = field => ({ outcome: 'clarify', field });
const refuse = reason => ({ outcome: 'refused', reason });
const readable = read => ['ready', 'missing'].includes(read?.status);

function lookupsFor({ intent, searches = [], slots }) {
  const { command, args = {}, querySlot = 'name' } = intent;
  const targetReads = (targets[command] ?? []).flatMap(([field, kind]) => {
    if (!args[field]) return [];
    const candidates = [querySlot, field, 'name'];
    const slot = candidates.find(candidate => slots.includes(candidate) &&
      searches.some(search => search.kind === kind && search.querySlot === candidate && !search.cursor))
      ?? candidates.find(candidate => slots.includes(candidate));
    return [{ field, kind, querySlot: slot }];
  });
  if (command === 'staff.create' || command === 'staff.update') {
    const nameSlot = args.name?.slot;
    if (nameSlot && slots.includes(nameSlot) &&
      !targetReads.some(read => read.querySlot === nameSlot) &&
      searches.some(search => search.kind === 'staff' && search.querySlot === nameSlot && !search.cursor)) {
      targetReads.push({ field: 'name', kind: 'staff', querySlot: nameSlot });
    }
  }
  return targetReads;
}

function prepareCalendarStaff({ input, reads }, { allowClosureWrites, allowSingleDeletes }) {
  const { command, args = {} } = input.intent;
  if (!validateAgentToolArgs('propose_action', { command, args })) return clarify('change');
  // A historical choice stays private to the browser. Other slots cannot stand in for it.
  if (args.dateIntent && (args.dateIntent.slot !== 'dateIntent' || !input.slots.includes('dateIntent'))) return clarify('dateIntent');
  if (command === 'calendar.updateEvent' && !eventChanges.some(field => Object.hasOwn(args, field))) return clarify('change');

  const resolved = new Map();
  for (const [index, { field, querySlot }] of lookupsFor(input).entries()) {
    const read = reads[index];
    if (!querySlot || !readable(read)) return refuse('unavailable');
    if (field === 'name') {
      if (read.nextCursor) return refuse('unavailable');
      if (read.matches.some(match => match.match === 'exact' && match.handle !== args.staffId?.handle)) return refuse('duplicate');
      continue;
    }
    const { match, choices } = resolveAgentTarget(read);
    if (!match) return choices.length ? { outcome: 'ambiguous', lookupIndex: index, field } : refuse('invalid_target');
    if (match.handle !== args[field].handle) return refuse('invalid_target');
    resolved.set(field, match.fields ?? {});
  }

  const event = resolved.get('eventId');
  if (event && event.source !== 'direct') return refuse(event.source ? 'invalid_target' : 'unavailable');
  if (event && typeof event.closure !== 'boolean') return refuse('unavailable');
  const closureWrite = event?.closure || Object.hasOwn(args, 'storeClosure');
  if (closureWrite && !allowClosureWrites) return refuse('widget_only');
  if (deleteCommands.has(command) && !allowSingleDeletes) return refuse('widget_only');
  if (event?.closure && !Number.isSafeInteger(event.linkedDraftCount)) return refuse('unavailable');

  // The browser resolves private date/time slots and checks overlap, closure
  // drafts and exact before/after rows against the captured store snapshot.
  const shift = resolved.get('scheduleId');
  if (shift && !['work', 'off'].includes(shift.kind)) return refuse('unavailable');
  const clearsClosure = command === 'calendar.updateEvent' && event?.closure && args.storeClosure === null;
  const replacesWork = command === 'staff.saveSchedule' && args.kind === 'off' && shift?.kind === 'work';
  return { outcome: 'ready', args, ...(clearsClosure || replacesWork ? { tier: 'extra-confirm' } : {}) };
}

export function createCalendarStaffAdapters({ allowClosureWrites = true, allowSingleDeletes = true } = {}) {
  const policy = { allowClosureWrites: allowClosureWrites === true, allowSingleDeletes: allowSingleDeletes === true };
  return Object.freeze(commands.map(command => Object.freeze({
    command,
    // Deleting a staff profile can cascade to multiple shifts and remains widget-only.
    ...(command === 'staff.delete' ? { prepare: () => refuse('widget_only') } : {
      lookups(input) {
        return lookupsFor(input).flatMap(({ kind, querySlot }) => querySlot ? [{ name: 'search_records', args: { kind, querySlot } }] : []);
      },
      prepare: input => prepareCalendarStaff(input, policy),
    }),
  })));
}

export const calendarStaffAdapters = createCalendarStaffAdapters();
