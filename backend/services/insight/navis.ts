import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Pool } from 'pg';
import { createBridge } from '../../../frontend/server/bridge.mjs';
import { navisAgentFakeFetch } from '../../../frontend/server/fixtures/navis-eval-fake.mjs';
import {
  AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentCommandArgs, validateAgentFrame, validateAgentRequest, validateAgentToolArgs,
  type AgentRequest, type AgentWireArgs,
} from '../../../frontend/shared/navis-agent-schema.mjs';
import type { PromoVideoInput } from '../../../frontend/src/data/marketing/types.ts';
import { promoCommand, saveProposal } from './actions.ts';
import { readSales } from './sales.ts';
import { InsightError, isUuid, type OwnerScope } from './scope.ts';
import { normalizeOutcome, recordUsage } from './usage.ts';

type StudioFetch = (url: string, init: { body: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
export type NavisProvider = {
  mode: 'fixture';
  fetch?: StudioFetch;
  fetchForOwner?: (scope: OwnerScope) => StudioFetch | undefined;
} | {
  mode: 'live';
  apiKey: string;
  baseUrl?: string;
  agentModel?: string;
  fetch?: StudioFetch;
};

type Turn = {
  scope: OwnerScope;
  outbound: Set<string>;
  writes: Promise<boolean>[];
};

type AttemptDiagnostic = {
  event: 'navis_agent_provider_call';
  requestId: string;
  correlationId: string;
  model: string;
  requestMode: string;
  outcome: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
};

function isAttempt(value: unknown): value is AttemptDiagnostic {
  return typeof value === 'object' && value !== null && 'event' in value && value.event === 'navis_agent_provider_call'
    && 'requestId' in value && isUuid(value.requestId);
}

function hasFields(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isPromoInput = (value: unknown): value is PromoVideoInput => validateAgentCommandArgs(promoCommand, value);

function readTurn(body: unknown): { input: AgentRequest; actionInput?: PromoVideoInput } {
  if (validateAgentRequest(body)) {
    if (body.intent.kind === 'command' && body.intent.command === promoCommand) throw new InsightError(400, 'BAD_REQUEST');
    return { input: body };
  }
  if (!hasFields(body) || Object.keys(body).length !== 2 || !validateAgentRequest(body.turn) || !hasFields(body.actionSlots)) {
    throw new InsightError(400, 'BAD_REQUEST');
  }
  const { turn: input, actionSlots } = body;
  const { intent } = input;
  if (input.layer !== 'marketing' || intent.kind !== 'command' || intent.command !== promoCommand
      || !validateAgentToolArgs('propose_action', { command: promoCommand, args: intent.args })) {
    throw new InsightError(400, 'BAD_REQUEST');
  }
  const used = new Set<string>();
  const actionInput = Object.fromEntries(Object.entries(intent.args ?? {}).map(([key, ref]) => {
    if (!ref || typeof ref !== 'object' || !('slot' in ref)) return [key, ref];
    const slot = ref.slot;
    if (typeof slot !== 'string' || !input.slots.includes(slot) || !Object.hasOwn(actionSlots, slot)) {
      throw new InsightError(400, 'BAD_REQUEST');
    }
    used.add(slot);
    return [key, actionSlots[slot]];
  }));
  if (used.size !== Object.keys(actionSlots).length || !isPromoInput(actionInput)) {
    throw new InsightError(400, 'BAD_REQUEST');
  }
  return { input, actionInput };
}

async function projectAgentInput(pool: Pool, storeId: string, input: AgentRequest): Promise<AgentRequest> {
  const scoped: AgentRequest = { ...input, snapshot: [], catalog: [], searches: [], readings: [], references: [] };
  const { intent } = input;
  if (intent.kind === 'conversation' && (intent.action === 'confirm' || intent.action === 'confirm_extra')) {
    return { ...scoped, intent: { kind: 'conversation', action: 'hold' } };
  }
  if (intent.kind === 'command' && intent.command === promoCommand && input.layer === 'marketing') return scoped;
  if (intent.kind !== 'read' || intent.sourceId !== 'pos') return { ...scoped, intent: { kind: 'unsupported' } };

  const condition = intent.condition ?? { kind: 'default' };
  const from = condition.kind === 'dateRange' ? condition.start : condition.kind === 'snapshot' ? condition.asOf : input.businessDate;
  const to = condition.kind === 'dateRange' ? condition.end : from;
  const { days } = await readSales(pool, storeId, from, to);
  const total = days.reduce((sum, day) => sum + BigInt(day.netSales), 0n);
  const value = Number(total);
  if (!Number.isSafeInteger(value)) throw new InsightError(503, 'SERVICE_UNAVAILABLE');
  const labels = { ko: '순매출', en: 'Net sales', 'zh-Hans': '净销售额', 'zh-Hant': '淨銷售額' };
  return { ...scoped, snapshot: [{
    sourceId: 'pos', candidateAllowed: false, condition,
    facts: days.length ? [{ key: 'ledger.sales.net', label: labels[input.locale ?? 'ko'], value, unit: 'KRW',
      display: new Intl.NumberFormat(input.locale ?? 'ko', { style: 'currency', currency: 'KRW' }).format(value),
      ...(from === to ? { date: from } : { start: from, end: to }) }] : [],
  }] };
}

export function createNavis(pool: Pool, provider: NavisProvider, now: () => Date, reportError: () => void) {
  const context = new AsyncLocalStorage<Turn>();
  const live = provider.mode === 'live';
  const providerFetch = provider.fetch ?? (live ? globalThis.fetch : navisAgentFakeFetch);
  const fetchForOwner = live ? undefined : provider.fetchForOwner;
  const bridgeOptions = {
    // Both transports use the bridge's scoped conversation and metering profile.
    agentMode: 'live',
    agentModel: live ? provider.agentModel : 'HCX-005',
    agentApiKey: live ? provider.apiKey : randomUUID(),
    baseUrl: live ? provider.baseUrl : 'https://navis-agent.invalid',
    fetchImpl(url: string, init: Parameters<StudioFetch>[1]) {
      const id = new Headers(init.headers).get('x-ncp-clovastudio-request-id');
      const turn = context.getStore();
      if (id) turn?.outbound.add(id);
      const scopedFetch = turn && fetchForOwner?.(turn.scope);
      return (scopedFetch ?? providerFetch)(url, init);
    },
    resolveAgentScope() {
      const turn = context.getStore();
      return turn && { storeId: turn.scope.storeId, sessionId: turn.scope.actorId };
    },
    agentAdapters: [{
      command: promoCommand,
      prepare({ input }: { input: { layer: string; intent: { args: AgentWireArgs } } }) {
        const { args } = input.intent;
        return input.layer === 'marketing' && validateAgentToolArgs('propose_action', { command: promoCommand, args })
          ? { outcome: 'ready', args } : { outcome: 'refused', reason: 'invalid_target' };
      },
    }],
    onDiagnostics(entry: unknown) {
      const turn = context.getStore();
      if (!turn || !isAttempt(entry) || !turn.outbound.delete(entry.requestId)) return;
      // Quota estimates and reservations stay in the bridge's pre-I/O limiter.
      turn.writes.push(recordUsage(pool, turn.scope.storeId, 'navis', {
        attemptId: entry.requestId, correlationId: entry.correlationId, model: entry.model, mode: entry.requestMode,
        outcome: normalizeOutcome(entry.outcome), latencyMs: Math.max(0, entry.latencyMs),
        inputTokens: entry.promptTokens, outputTokens: entry.completionTokens,
      }).then(() => true, () => { reportError(); return false; }));
    },
  };
  const bridge = createBridge(bridgeOptions);

  async function chat(raw: IncomingMessage, response: ServerResponse, scope: OwnerScope, body: unknown, begin: () => void) {
    if (raw.headers[AGENT_PROTOCOL_HEADER] !== AGENT_PROTOCOL) throw new InsightError(400, 'BAD_REQUEST');
    const { input: turnInput, actionInput } = readTurn(body);
    const input = await projectAgentInput(pool, scope.storeId, turnInput);
    begin();
    const turn: Turn = { scope, outbound: new Set(), writes: [] };
    const payload = Readable.from([Buffer.from(JSON.stringify(input))]);
    // HTTP auth is already verified by Insight. Adapt to the bridge's local
    // HTTP interface without passing original headers, diagnostics or cookies.
    const request = Object.assign(payload, {
      url: '/api/navis/chat', method: 'POST',
      headers: { host: '127.0.0.1:3000', 'content-type': 'application/json', [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL },
      socket: { localAddress: '127.0.0.1', localPort: 3000 },
    });
    Object.defineProperty(request, 'aborted', { get: () => raw.aborted || response.destroyed });
    const tail: string[] = [];
    const proxy = new Proxy(response, {
      get(target, prop) {
        if (prop === 'write') return (chunk: string) => {
          if (tail.length || /^event: (?:action_proposal|done)\n/.test(chunk)) {
            tail.push(chunk);
            return true;
          }
          return target.write(chunk);
        };
        // Control final delivery so an action card is visible only after commit.
        if (prop === 'end') return (chunk?: string) => { if (chunk) target.write(chunk); };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      await context.run(turn, () => bridge(request, proxy));
      if ((await Promise.all(turn.writes)).includes(false)) throw new Error('Navis metering failed');
      if (response.destroyed) return;
      const card = tail.find(chunk => chunk.startsWith('event: action_proposal\n'));
      if (card) {
        const proposal: unknown = JSON.parse(card.split('\n')[1].slice('data: '.length));
        if (!actionInput || !validateAgentFrame('action_proposal', proposal)) throw new Error('Invalid Navis proposal frame');
        await saveProposal(pool, scope, proposal, actionInput, now());
      }
      for (const chunk of tail) response.write(chunk);
    } catch {
      reportError();
      if (!response.destroyed) {
        if (response.headersSent) response.write('event: error\ndata: {"code":"UNAVAILABLE"}\n\n');
        else response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .write('{"code":"SERVICE_UNAVAILABLE"}');
      }
    } finally {
      if (!response.destroyed) response.end();
    }
  }
  return { chat, close: bridge.close };
}
