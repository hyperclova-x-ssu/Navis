import { AGENT_COMMAND_CATALOG } from '../../shared/navis-agent-schema.mjs';
import { menuCreateAdapter, menuEditAdapters } from './menu.mjs';
import { navigationAdapters } from './navigation.mjs';
import { createAgentConversation } from './conversation.mjs';
import { inventoryAdapters } from './inventory.mjs';
import { bookingAdapters } from './booking.mjs';
import { settingsAdapters } from './settings.mjs';
import { layoutAdapters } from './layout.mjs';
import { supplierAdapters } from './suppliers.mjs';
import { calendarStaffAdapters } from './calendar-staff.mjs'; // N10
import { memberAdapters } from './members.mjs'; // N12
import { moneyAdapters } from './money.mjs'; // N11
import { noticeAdapters } from './notices.mjs'; // N15
import { customAdapters } from './custom.mjs'; // N13
import { manualsGrantsAdapters } from './manuals-grants.mjs'; // N14
import { localAdapters } from './local.mjs'; // N20
import { couponAdapters } from './coupons.mjs'; // N16
import { replyAdapters } from './replies.mjs'; // N17
import { operationAdapters } from './operations.mjs'; // N19
import { promotionAdapters } from './promotion.mjs'; // N18

/**
 * A domain registers one immutable entry per enabled command.
 * lookups(input) returns optional ordered { name, args } read calls. The
 * bridge authorizes these against the current projection and presents the
 * validated results in that same order to prepare({ input, reads }).
 * prepare is pure and synchronous. Its outcomes are ready (args, tier?),
 * clarify (field), ambiguous (search lookup index, field?), or refused
 * (reason). Ready args preserve the incoming draft. Target refs must be
 * present in the validated reads. The bridge checks policy and frames after
 * preparation. Adapters receive no dispatch, persistence or transport port.
 */
export function createAgentDomainRegistry(adapters = [menuCreateAdapter, ...menuEditAdapters, ...navigationAdapters, ...inventoryAdapters, ...bookingAdapters, ...layoutAdapters, ...supplierAdapters, ...settingsAdapters, ...moneyAdapters /* N11 */, ...memberAdapters /* N12 */, ...calendarStaffAdapters /* N10 */, ...noticeAdapters /* N15 */, ...customAdapters /* N13 */, ...manualsGrantsAdapters /* N14 */, ...localAdapters /* N20 */, ...couponAdapters /* N16 */, ...replyAdapters /* N17 */, ...operationAdapters /* N19 */, ...promotionAdapters /* N18 */]) {
  const commands = new Map();
  for (const adapter of adapters) {
    const command = adapter?.command;
    if (!Object.hasOwn(AGENT_COMMAND_CATALOG, command) || AGENT_COMMAND_CATALOG[command].policy !== 'propose'
      || typeof adapter.prepare !== 'function' || adapter.lookups !== undefined && typeof adapter.lookups !== 'function') {
      throw new TypeError('Invalid Navis domain adapter');
    }
    if (commands.has(command)) throw new TypeError(`Duplicate Navis command adapter: ${command}`);
    commands.set(command, Object.freeze({ ...adapter }));
  }
  return Object.freeze({ get: command => commands.get(command), createConversation: createAgentConversation });
}

export function resolveAgentTarget(search) {
  if (search?.status !== 'ready') return { choices: [] };
  const exact = search.matches.filter(match => match.match === 'exact');
  if (exact.length === 1 && !search.nextCursor) return { match: exact[0] };
  return { choices: exact.length ? exact : search.matches };
}
