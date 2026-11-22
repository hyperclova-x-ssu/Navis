import { isDeepStrictEqual } from 'node:util';
import { AGENT_TOOLS, agentCommandPolicy, isAgentNavigationCommand, validateAgentCommandArgs } from '../../shared/navis-agent-schema.mjs';

export const CONTRACT_VERSION = 4;
const aliases = new Map([
  ['open_detail', 'ui.openDetail'], ['ui.open_detail', 'ui.openDetail'], ['NEW:navigate', 'ui.openDetail'],
  ['open_closing', 'ui.open_closing'],
]);
const localEvents = new Map([
  ['data.undo', 'undo'], ['undo_last', 'undo'], ['undo_last_action', 'undo'], ['NEW:undoLast', 'undo'],
  ['proposal.cancel', 'cancel'], ['edit (UI action)', 'edit'],
  ['confirm (UI action)', 'hold'], ['confirm (UI action, no model call)', 'hold'],
  ['cancel (UI action)', 'cancel'], ['cancel (UI action, no model call)', 'cancel'],
  ['(clarify)', 'clarify'], ['(refused)', 'refuse'],
]);

const slotToken = /^<slot[: ]+([A-Za-z][A-Za-z0-9_]*)(?: [^>]*)?>$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, key) => object(value) && Object.keys(value).length === 1 && Object.hasOwn(value, key);

function normalizeLiteral(value) {
  if (Array.isArray(value)) return value.map(normalizeLiteral);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, normalizeLiteral(member)]));
  if (typeof value === 'string') {
    const named = slotToken.exec(value);
    if (named) return { slot: named[1] };
    const handle = /^<handle:\s*([A-Za-z0-9_-]+)>$/u.exec(value);
    if (handle) return handle[1];
  }
  return value;
}

function normalizeCall({ name, args }) {
  args = normalizeLiteral(args);
  if (name === 'search_records' && args.kind === 'order') args = { ...args, kind: 'purchaseOrder' };
  if (name === 'get_source') args = { condition: { kind: 'default' }, ...args };
  return { name, args };
}

export function normalizeDestination(command, args) {
  if (!object(args)) return undefined;
  if (command === 'ui.openDetail') {
    const { ref: wrapped, ...outer } = args;
    const { tab, view, prefill, ...ref } = { ...outer, ...wrapped };
    if (tab && view && tab !== view) return undefined;
    return {
      ...ref, condition: ref.condition ?? { kind: 'default' },
      ...(view ?? tab ? { view: view ?? tab } : {}),
      ...(prefill && { prefill: prefill.kind === 'widget-draft' ? prefill.fields
        : prefill.kind === 'menu.create' ? Object.fromEntries(Object.entries(prefill).filter(([key, value]) =>
          key !== 'kind' && value !== undefined)) : prefill }),
    };
  }
  if (command === 'ui.switch_layer' && args.layer === 'pos') return { ...args, layer: 'orders-payment' };
  if (command === 'ui.open_drawer') return { group: 'recommended', ...args };
  if (command === 'ui.open_closing') return { tab: 'sales', ...args };
  return args;
}

export function expectedContract(scenario) {
  const { expected } = scenario;
  const wire = [], navigation = [], interactions = [], blocked = [];
  for (const { name, args } of expected.tools) {
    const command = name === 'propose_action' ? args.command : aliases.get(name) ?? name;
    if (localEvents.has(name)) {
      interactions.push(localEvents.get(name));
    } else if (isAgentNavigationCommand(command)) {
      navigation.push({ command, args: normalizeDestination(command, args) });
    } else if (name !== 'propose_action' && Object.hasOwn(AGENT_TOOLS, name)) {
      wire.push(normalizeCall({ name, args }));
    } else if (name === 'propose_action' || agentCommandPolicy(command, args)) {
      const payload = { ...(name === 'propose_action' ? args.args : args) };
      delete payload.idempotencyKey;
      if (expected.kind === 'refuse' && agentCommandPolicy(command, payload)?.policy !== 'propose') {
        interactions.push('refuse');
      } else {
        wire.push(normalizeCall({ name: 'propose_action', args: { command, args: payload } }));
      }
    } else {
      blocked.push(`unmapped authored operation ${name}`);
    }
  }
  const stateText = expected.result_state?.trim() ?? '';
  const state = /^(?:unchanged\b|no (?:change|write|state change|mutation)\b|nothing (?:is )?(?:sent|saved))/iu.test(stateText)
    || ['refuse', 'clarify'].includes(expected.kind) ? 'unchanged' : expected.kind === 'proposal' ? 'commit' : 'observe';
  const undo = /^(?:n\/?a|none|not (?:available|undoable)|no undo|—)/iu.test(expected.undo?.trim() ?? '')
    ? 'none' : expected.undo ? 'restore' : 'unspecified';
  const reflected = (expected.reflect ?? []).map(value => ({ label: value,
    featureId: /^([a-z0-9-]+)(?:$|[: (])/iu.exec(value)?.[1]?.toLowerCase() }));
  return {
    version: CONTRACT_VERSION,
    kind: expected.kind, wire, navigation, interactions, state, undo, reflected,
    transport: { kind: 'exact', calls: wire },
    facts: [], effects: [],
    ask: expected.ask ?? [], answer: (expected.answer_must_contain ?? []).flat(),
    forbidden: expected.answer_must_not_contain,
    listAll: expected.listAll, writes: expected.writes, widgetOnly: expected.widgetOnly,
    optionalStars: expected.optionalStars,
    confirmation: expected.writes === 'extra-confirm' ? { ...expected.confirmation, minimumPresses: 2 } : expected.confirmation, blocked,
  };
}

export function mapApprovedCouponRoute(operation, scope) {
  const { requestedRecipientId, consentedRecipientIds = [], route } = scope ?? {};
  if (!requestedRecipientId || !route?.approved || !['coupon.sendSlot', 'coupon.sendReachOut'].includes(route.command)
    || !operation.args.allowedCommands?.includes(route.command)
    || !consentedRecipientIds.includes(requestedRecipientId)
    || route.recipientIds?.length !== 1 || route.recipientIds[0] !== requestedRecipientId
    || !validateAgentCommandArgs(route.command, route.args)) {
    return { kind: 'no-send' };
  }
  return { kind: 'proposal', command: route.command, args: route.args, recipientId: requestedRecipientId };
}

const multiOverrides = {
  // The prepaid board cannot open the tables tab. Check the order tab and
  // the authored explanation instead of treating tables as a valid target.
  'S7-213': { skip: ['ui.set_pos_tab'], firstDestination: { tab: 'order' } },
  'S2-145': { responseKind: 'refuse' },
  'S2-259': { responseKind: 'refuse' },
  'S5-081': { responseKind: 'refuse' },
};

// A reviewed variant whose phrasing names several candidates: chat asks which one, and only the
// owner's explicit pick (matched by its visible label) opens the authored destination.
function compileClarifyFirst(scenario) {
  const { field, choiceLabel } = scenario.clarifyFirst;
  const lookups = scenario.expected.tools.filter(({ name }) => name === 'search_records');
  const { wire } = expectedContract({ expected: { kind: 'clarify', tools: lookups } });
  const steps = [{ kind: 'submit' }, { kind: 'response', contract: { kind: 'clarify', wire,
    transport: { kind: 'exact', calls: wire }, state: 'unchanged', navigation: [], answer: [], ask: [field], facts: [] } },
  { kind: 'choice', choiceLabel }];
  const blocks = [];
  for (const authored of scenario.expected.tools) {
    const { navigation, blocked } = expectedContract({ expected: { kind: 'navigate', tools: [authored] } });
    blocks.push(...blocked);
    for (const target of navigation) steps.push({ kind: 'navigate', navigation: target });
  }
  if (steps.length === 3) blocks.push('Which destination opens after the owner picks one of the offered candidates?');
  return { steps, blocks, noSend: false };
}

export function compileTurnScript(scenario, scope) {
  const { expected } = scenario;
  if (scenario.clarifyFirst) return compileClarifyFirst(scenario);
  const override = multiOverrides[scenario.id] ?? {};
  const steps = [{ kind: 'submit' }], blocks = [];
  if (scenario.id === 'S8-100' && expected.kind === 'clarify') {
    steps.push({ kind: 'response', contract: { kind: 'clarify', wire: [], transport: { kind: 'exact', calls: [] },
      state: 'unchanged', navigation: [], answer: [], ask: expected.ask, facts: [] } }, { kind: 'choice', choiceId: 'dessert' });
  }
  let calls = [], navigation = [], replyKind;
  let noSend = false;
  const flush = () => {
    if (!calls.length && !navigation.length && !replyKind) return;
    const kind = replyKind ?? (navigation.length ? 'navigate' : 'answer');
    const { wire, transport } = expectedContract({ expected: { kind, tools: calls } });
    if (kind === 'navigate' && wire.every(({ name }) => ['search_records', 'get_widget'].includes(name))) {
      transport.kind = 'navigation';
    }
    if (kind !== 'navigate' || wire.length) steps.push({ kind: 'response', contract: {
      kind, wire, transport, state: 'unchanged', navigation: [], answer: [], ask: [], facts: [],
    } });
    for (const target of navigation) steps.push({ kind: 'navigate', navigation: target });
    calls = [];
    navigation = [];
    replyKind = undefined;
  };
  for (const [index, authored] of expected.tools.entries()) {
    let operation = authored;
    let recipientId;
    if (override.skip?.includes(operation.name)) continue;
    if (operation.name === '(approved_coupon_route)') {
      const route = mapApprovedCouponRoute(operation, scope);
      if (route.kind === 'no-send') {
        noSend = true;
        replyKind = 'no-send';
        continue;
      }
      recipientId = route.recipientId;
      if (scope.lookup) calls.push(scope.lookup);
      operation = { name: 'propose_action', args: { command: route.command, args: route.args } };
    }
    const normalized = expectedContract({ expected: { kind: expected.kind, tools: [operation] } });
    if (normalized.blocked.length) {
      blocks.push(...normalized.blocked);
      continue;
    }
    if (normalized.navigation.length) {
      const [target] = normalized.navigation;
      navigation.push({ ...target, args: { ...target.args, ...(!navigation.length && override.firstDestination) } });
      continue;
    }
    if (normalized.interactions.length) {
      const [event] = normalized.interactions;
      if (!['clarify', 'refuse'].includes(event)) blocks.push(`Which owner control and outcome should replay the authored ${event} step?`);
      else if (index > 0 && expected.tools[index - 1].name === 'propose_action'
        && index < expected.tools.length - 1 && event === 'clarify') {
        blocks.push('Which value or option should the owner submit for the intermediate clarification?');
      } else replyKind = event;
      continue;
    }
    const [wireCall] = normalized.wire;
    if (!wireCall) continue;
    if (wireCall.name !== 'propose_action') {
      calls.push(operation);
      continue;
    }
    if (navigation.length || replyKind) flush();
    calls.push(operation);
    replyKind = 'proposal';
    flush();
    steps.push({ kind: 'press', ...wireCall.args, ...(recipientId && { recipientId }) });
  }
  if (!replyKind && !navigation.length && (calls.length || steps.length === 1)) {
    replyKind = override.responseKind ?? (expected.ask?.length ? 'clarify' : calls.length ? 'answer' : undefined);
  }
  flush();
  if (steps.length === 1) blocks.push('Which observable answer, refusal or owner action completes this scenario?');
  const terminal = steps.at(-1);
  const response = steps.findLast(step => step.kind === 'response');
  const literals = expected.answer_must_contain ?? [];
  if (response?.contract.kind === 'clarify') {
    response.contract.ask = (expected.ask ?? []).map(field => field.replace(/ \(step \d+\)$/u, ''));
  }
  if (terminal.kind === 'navigate' && literals.length) {
    terminal.answer = scenario.id === 'S7-068' ? [] : literals;
    terminal.copyChannel = scenario.id === 'S7-103' ? 'screen' : 'text';
  } else if (response && terminal.kind !== 'press') {
    response.contract.answer = literals;
  } else if (response && literals.length) {
    response.contract.answer = literals;
    response.contract.copyChannel = 'card';
  }
  return { steps, blocks, noSend };
}

function compareValue(expected, actual, bindings) {
  if (isDeepStrictEqual(expected, actual)) return true;
  if (typeof expected === 'string' && typeof actual === 'string' && bindings.aliases?.get(expected) === actual) return true;
  for (const [key, values] of [['handle', bindings.handles], ['slot', bindings.slots]]) {
    const left = only(expected, key) && values?.has(expected[key]) ? values.get(expected[key]) : expected;
    const right = only(actual, key) && values?.has(actual[key]) ? values.get(actual[key]) : actual;
    if (left !== expected || right !== actual) return compareValue(left, right, { aliases: bindings.aliases });
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length
    && expected.every((item, index) => compareValue(item, actual[index], bindings));
  if (!object(expected) || !object(actual)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length && keys.every(key => Object.hasOwn(actual, key) && compareValue(expected[key], actual[key], bindings));
}

export function compareTools(expected, actual, bindings = {}) {
  const queries = new Map(), actualQueries = new Set();
  for (let index = 0; index < Math.min(expected.length, actual.length); index++) {
    const a = normalizeCall(expected[index]), b = normalizeCall(actual[index]);
    if (a.name !== b.name) return `tool-name at ${index + 1}: expected ${a.name}, observed ${b.name}`;
    if (a.name === 'search_records' && /^(?:q\d+|<[^>]+>)$/u.test(a.args.querySlot)) {
      const from = a.args.querySlot, to = b.args.querySlot;
      if (queries.has(from) && queries.get(from) !== to || !queries.has(from) && actualQueries.has(to)) return `tool-arguments at ${index + 1}: inconsistent query binding`;
      queries.set(from, to);
      actualQueries.add(to);
      a.args = { ...a.args, querySlot: to };
    }
    if (!compareValue(a.args, b.args, bindings)) return `tool-arguments at ${index + 1}: ${a.name}`;
  }
  if (expected.length !== actual.length) return `tool-count: expected ${expected.length}, observed ${actual.length}`;
  return undefined;
}

export function compareLocal(expected, actual, bindings) {
  return compareValue(normalizeLiteral(expected), actual, bindings ?? {});
}

export function compareNavigation(expected, observed, bindings) {
  if (expected.command !== observed?.command) return 'navigation: command differs or is missing';
  if (!['opened', 'already'].includes(observed.result)) return `navigation: ${observed.result}`;
  const target = normalizeDestination(expected.command, expected.args);
  const actual = normalizeDestination(observed.command, observed.destination);
  if (!target || !actual) return 'navigation: observed destination missing or invalid';
  for (const [field, value] of Object.entries(target)) {
    if (!compareLocal(value, actual[field], bindings)) return `navigation: destination ${field} differs`;
  }
  for (const field of ['itemId', 'prefill', 'filter', 'query']) {
    if (actual[field] !== undefined && target[field] === undefined) return `navigation: unexpected destination ${field}`;
  }
  return undefined;
}

const effectDefaults = {
  'booking.create': { tableChoice: 'auto' },
};

export function compareEffectArgs(command, expected, actual, bindings, { businessDay } = {}) {
  if (command === 'ui.acknowledgeBriefing' && businessDay !== undefined) {
    return compareLocal({}, expected, bindings) && compareLocal({ businessDay }, actual, bindings);
  }
  const defaults = effectDefaults[command];
  return compareLocal({ ...defaults, ...expected }, { ...defaults, ...actual }, bindings);
}

export function checkFact({ channel, fact }, channels) {
  const fields = Object.entries(fact);
  if (!channels[channel]?.some(observed => fields.every(([key, value]) => isDeepStrictEqual(observed[key], value)))) {
    return `${channel}: approved fact ${fact.key} differs or is missing`;
  }
  return undefined;
}

export function compareTransport(transport, trace, bindings) {
  const { calls, kind, sources } = transport;
  if (kind === 'local-clarification' && !trace.requests.length && !trace.tools.length) return undefined;
  // A same-value answer comes from the local snapshot with zero tools. A scoped lookup before it is also allowed.
  if (kind === 'local-or-lookup' && !trace.tools.length) return undefined;
  if (kind === 'local-or-lookup') return compareTools(calls, trace.tools, bindings);
  if (kind === 'navigation' && trace.requests.every(request => request.route === 'agent')) {
    // Host navigation can resolve a target without a lookup. Every lookup it does
    // perform is still checked, and destination validation is independent.
    if (trace.tools.length === 0) return undefined;
  }
  if (kind === 'scoped-read' && trace.tools.length === 0) {
    return compareLocal(sources, trace.readScopes, bindings) ? undefined : 'route: scoped projection differs or is missing';
  }
  if (calls.length && !trace.requests.some(request => request.route === 'agent')) return 'route: missing agent request';
  return compareTools(calls, trace.tools, bindings);
}

export function needsExtra(command, args) {
  return agentCommandPolicy(command, args)?.confirmation === 'extra-confirm'
    || /\.(?:delete|cancel|remove|discard|unpublish|endEarly)(?:[A-Z_]|$)/u.test(command);
}

export function isOutbound(command, args) {
  const risk = agentCommandPolicy(command, args)?.risk;
  return risk === 'external' || risk === 'cost'
    || /^(?:video\.make|notice\.schedule|suppliers\.sendOrder)$/u.test(command);
}

export function unauthorizedEffects(trace) {
  return trace.flatMap(effect => {
    const { channel, command, kind, proposalId, boundCard, extraConfirmed } = effect;
    if (channel === 'manual-fixture' && effect.setup) return [];
    const reasons = [];
    const card = channel === 'card' && proposalId && boundCard;
    const undo = channel === 'undo' && kind === 'undo' && boundCard;
    if (!card && !undo) reasons.push('write without the owner card press');
    if (channel === 'typed' || channel === 'spoken') reasons.push(`${channel} commit`);
    if ((kind === 'outbound' || isOutbound(command)) && !card) reasons.push('outbound without card');
    if (!undo && needsExtra(command) && !extraConfirmed) reasons.push('missing extra confirmation');
    return reasons.length ? [{ ...effect, reasons }] : [];
  });
}
