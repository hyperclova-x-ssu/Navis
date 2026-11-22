import { getRegistration } from '../../catalog';
import type { CellSpan, DashboardLayerId, FeatureId, LayerId, Locale, QueryCondition, RunStore } from '../../contracts';
import { MENU_CATEGORIES } from '../../contracts';
import type { DataSnapshot } from '../../data/db/types';
import { REAL_DOMAINS, WIDGET_DOMAIN } from '../../data/reality/00/port';
import { stockDate } from '../../data/reality/03/stock-projection';
import { conditionKey, isDataWidgetId } from '../../data/conditions';
import { addDays, TODAY } from '../../data/db/time';
import type { WidgetDataStore } from '../../data/widget-data';
import { navisStreamMessages as copy, navisTranslator } from './messages';
import { menuAddAnswer, simpleReply } from './simple';
import { has, isDrawerQuestion, isPosQuestion, isDemandQuestion, matchWidget, norm, PAST_WORDS } from './question';
import {
  AGENT_PRICE_CLARIFICATION, AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, agentCommandPolicy, agentCommandRefs, agentFieldChoices, agentMissingField, isAgentNavigationCommand,
  validateAgentDraft, validateAgentFrame, validateAgentRequest, validateAgentToolArgs, type AgentDone, type AgentFrameData, type AgentHandoff as WireHandoff, type AgentReadProjection, type AgentRefusal, type AgentRequest, type AgentSearchProjection, type AgentWireArgs,
} from '../../../shared/navis-agent-schema.mjs';
import { gateUnreadable, unreadableWidget } from './real-gate';
import { classifyWidgetHandoff, commandWidgetHandoff, missingTaxEvidenceHandoff } from './widget-handoff';
import { createAgentActions, isMenuPrice, type AgentActionProposal, type LocalAgentProposal } from './agent-actions';
import { startMultiStepPlan, type MultiStepAttempt, type MultiStepRunner } from './multi-step';
import {
  assistantDomains, buildAgentRequest, buildAssistantContext, buildMenuAgentRequest, commandSnapshotEntry, conditionsOf, coveredWeekSales, createLookupScope, defaultStore, isMenuCreateRequest,
  normalizeFor, menuPriceFollowUp, orderedRead, rememberMenuPriceQuestion, parseMenuCreateInput, periodFollowUp, plainReadQuery, projectAgentSearch, projectAgentSource, projectAgentWidget, questionContext, readMenuCategory, readMenuName, readNavisCondition,
  storeFactSource, widgetStatusQuery, wireSearchPage, type AgentReadEvidence, type LocalMenuDraft, type LookupTokens, type MenuCreateInput, type WidgetFactSource,
} from './snapshot';
import { classifyNavisDirective, navisDirective, navisPayloadPrefix, navisScopeIssue, normalizeNavisInput, repairColloquial, parseMenuCategoryChoice, parseNavisDate, parseNavisMoney, parseNavisNumber, parseNavisQuantity, parseNavisTime, readNavisBulkRequest, readNavisContradiction, readNavisNoticeDate } from './navis-input';
import type { DomainLookup, DomainRegistry, DomainRoute, DomainTurnInput, LocalSlots, RecordTargets, ResolvedRecord, SlotValue } from './domains/registry';
import { selectChatReceiptNotice, selectCommonNotice } from '../../state';
import { timePolicy } from '../../ui/motion';
import { conversationMemory, conversationPrice, createProposalSession, followupBoardQuestion, menuRequestText, prepareConversationText, readConversationControl, readOrdinal, referencesMenuPrice, salesRead, type ProposalSession } from './navis-conversation';
import type { AgentSuggestion, AgentContinuation, AgentHandoff, AgentTurnInput, AskInput, AssistantProvider, AssistantReply, Candidate } from './types';
import { planToRoute, requestIntentPlan } from './classify';

export type { AskInput, AssistantProvider, AssistantReply, Candidate, CandidateSize, ReplyStatus } from './types';
export { buildAssistantContext } from './snapshot';
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status'> & Partial<Pick<Response, 'body' | 'headers' | 'json'>>>;
const MAX_PANELS = 22;
// D-262: aligned with the server answer cap; data values still come only from facts.
const MAX_ANSWER_LENGTH = 16384;
function cancelled(signal: AbortSignal) { if (signal.aborted) throw new DOMException('Request stopped', 'AbortError'); }

type RawOutput = { answer: string; panels: unknown[] };
export function parseModelOutput(value: unknown): RawOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid output');
  const output = value as Record<string, unknown>;
  if (typeof output.answer !== 'string' || !output.answer.trim() || output.answer.length > MAX_ANSWER_LENGTH || !Array.isArray(output.panels) || output.panels.length > MAX_PANELS) throw new Error('invalid output');
  return { answer: output.answer, panels: output.panels };
}

/** Keeps each valid candidate independently. A widget of the other layer is kept as `other-layer`. */
function validate(output: RawOutput, source: WidgetFactSource, layer: DashboardLayerId, signal: AbortSignal): Candidate[] {
  const panels: Candidate[] = [];
  for (const raw of output.panels) {
    cancelled(signal);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const registration = typeof item.featureId === 'string' ? getRegistration(item.featureId) : undefined;
    if (!registration || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1000) continue;
    const requested = (item.condition === undefined ? { kind: 'default' } : item.condition) as QueryCondition;
    const condition = normalizeFor(registration.id, requested);
    if (!condition) continue;
    const view = source.view(registration.id, condition);
    if (view.status !== 'ready' || !source.facts(view).length) continue;
    const size = item.size as Record<string, unknown> | undefined;
    const valid = (n: unknown): n is CellSpan => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 4;
    if (!valid(size?.width) || !valid(size?.height)) continue;
    panels.push({
      featureId: registration.id, condition, size: { width: size.width, height: size.height },
      reason: item.reason, preview: view, placement: registration.layer === layer ? 'current-layer' : 'other-layer',
    });
    if (panels.length === 3) break;
  }
  return panels;
}

export interface AssistantProviderOptions {
  /** The run's data store (the app shell passes it). Default: a seeded store. */
  readonly store?: WidgetDataStore;
  readonly run?: RunStore;
  readonly clock?: () => number;
  /** Test seam: where views and facts come from. */
  readonly source?: WidgetFactSource;
  readonly fetcher?: Fetcher;
  /** D-371 read-only intent plans from the model. On by default for the app's own fetch outside unit tests; a test, dev or replay fetcher turns it on explicitly. */
  readonly classify?: boolean;
  readonly timeoutMs?: number;
  readonly domains?: DomainRegistry;
}
/** Longest a question waits for the real-port loads before it goes on with an unread domain unavailable. */
const PRELOAD_WAIT_MS = 4_000;
class SimpleRequested extends Error {}
class OutOfScope extends Error {}

class StreamDeadline extends Error {}
class RequestFailed extends Error {}
/** The server answered that its free-text route is off (a live agent entry): the question gets the local guidance, not a retry. */
class LegacyRouteOff extends Error {}

export function shouldBypassNavisNavigation(text: string): boolean {
  const prepared = prepareConversationText(text);
  if (prepared.kind !== 'text') return true;
  return Boolean(classifyNavisDirective(prepared.text) || navisScopeIssue(prepared.text) || navisPayloadPrefix(prepared.text) || referencesMenuPrice(prepared.text) || readConversationControl(prepared.text)
    || isMenuCreateRequest(menuRequestText(text)) || Boolean(plainReadQuery(prepared.text, TODAY)));
}

/** Fixed Korean copy (D-329) for a read whose period the widget has no condition for. */
const PLAIN_READ_UNSUPPORTED = '이 기간은 앱에서 확인할 수 없어요. 위젯에 있는 기간으로 다시 물어봐 주세요.';
/** Fixed Korean questions (D-329) for a write that is too broad or contradicts itself: one thing is asked, nothing is changed. */
const CLARIFY_ONLY_COPY = {
  menuId: '메뉴는 하나씩 바꿀 수 있어요. 어떤 메뉴를 품절로 바꿀까요?',
  status: '품절과 판매 중 중에서 마지막 상태를 알려 주세요.',
  expenseId: '지출 후보는 하나씩 확인할 수 있어요. 어떤 후보를 확인할까요?',
} as const;
/** The choice that asks for the next page of at most five candidates (B22). Fixed Korean copy (D-329). */
const NEXT_PAGE = 'next-page';
const NEXT_PAGE_CHOICE: AgentSuggestion = { id: NEXT_PAGE, label: '다음 후보 보기' };

export function agentStatusLabel(frame: AgentFrameData['status']): string {
  if (frame.step === 'accepted') return copy.accepted;
  if (frame.step === 'assembling') return copy.assembling;
  if (frame.step === 'target_checked') return copy.targetChecked;
  const feature = frame.featureId && getRegistration(frame.featureId);
  const korean = navisTranslator('ko');
  return feature ? korean.t('navis.wait.topic', { name: korean.t(feature.nameKey) }) : copy.reading;
}

/** Parse SSE lines incrementally: byte boundaries, CR/LF and data lines are independent of frames. */
async function readReplyStream(
  body: ReadableStream<Uint8Array>, signal: AbortSignal, onDelta: (delta: string) => void,
  onPanels: (panels: unknown[]) => void, onFirstText: () => void, agent?: Pick<AskInput, 'onStatus'>,
): Promise<RawOutput & { done?: AgentFrameData['done']; proposal?: AgentFrameData['action_proposal'] }> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', event = '', data: string[] = [], answer = '', panels: unknown[] | undefined, terminal = false, firstText = false, bytes = 0;
  let done: AgentFrameData['done'] | undefined, proposal: AgentFrameData['action_proposal'] | undefined;
  const statuses = new Set<string>();
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  function frame() {
    if (!event && !data.length) return;
    const kind = event, lines = data; event = ''; data = [];
    const optionalAgentFrame = agent && ['status', 'action_proposal', 'action_result'].includes(kind);
    let value: unknown;
    try { value = JSON.parse(lines.join('\n')); }
    catch (error) { if (optionalAgentFrame) return; throw error; }
    cancelled(signal);
    if (agent) {
      if (!validateAgentFrame(kind, value)) {
        if (optionalAgentFrame) return;
        throw new Error('invalid agent frame');
      }
      if (kind === 'status') {
        if (panels === undefined && validateAgentFrame('status', value)) {
          const key = `${value.step}:${value.featureId ?? ''}`;
          if (!statuses.has(key)) {
            statuses.add(key);
            agent.onStatus?.(value);
          }
        }
        return;
      }
      if (kind === 'action_proposal') {
        if (panels !== undefined && !proposal && validateAgentFrame('action_proposal', value)) proposal = value;
        return;
      }
      // Local confirmations own their receipts. A chat response has no pending confirmation to match.
      if (kind === 'action_result') return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid frame');
    const item = value as Record<string, unknown>;
    if (kind === 'text_delta') {
      if (panels !== undefined || typeof item.delta !== 'string' || answer.length + item.delta.length > MAX_ANSWER_LENGTH) throw new Error('invalid delta');
      answer += item.delta;
      if (!firstText && item.delta.trim()) {
        firstText = true;
        onFirstText();
      }
      onDelta(item.delta);
    } else if (kind === 'panels') {
      if (panels !== undefined || !Array.isArray(item.panels) || item.panels.length > MAX_PANELS) throw new Error('invalid panels');
      panels = item.panels; onPanels(panels);
    } else if (kind === 'done') {
      if (panels === undefined) throw new Error('incomplete answer');
      if (agent) {
        if (!validateAgentFrame('done', value)) throw new Error('invalid agent terminal');
        done = value;
      }
      terminal = true;
    } else if (kind === 'error') {
      if (item.code === 'OUT_OF_SCOPE' && !answer.trim()) throw new OutOfScope();
      if (item.code === 'TIMEOUT') throw new StreamDeadline();
      if (item.code === 'UNAVAILABLE' || item.code === 'INVALID_OUTPUT') throw new RequestFailed();
      throw new Error('stream failed');
    } else throw new Error('invalid event');
  }
  function consume(eof = false) {
    while (!terminal) {
      const index = buffer.search(/[\r\n]/u);
      if (index < 0 || !eof && buffer[index] === '\r' && index === buffer.length - 1) return;
      const line = buffer.slice(0, index), end = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(index + end);
      if (!line) { frame(); continue; }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
    }
  }
  try {
    cancelled(signal);
    while (!terminal) {
      const part = await reader.read().catch(() => { cancelled(signal); throw new RequestFailed(); });
      cancelled(signal);
      if (part.done) { buffer += decoder.decode(); consume(true); if (!terminal) throw new Error('incomplete stream'); break; }
      bytes += part.value.byteLength;
      if (bytes > 128 * 1024) throw new Error('large stream');
      buffer += decoder.decode(part.value, { stream: true }); consume();
    }
    return { answer, panels: panels!, done, proposal };
  } finally {
    signal.removeEventListener('abort', stop);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type WireProposal = AgentFrameData['action_proposal'];
type CommandIntent = Extract<AgentRequest['intent'], { kind: 'command' }>;
type ReadIntent = Extract<AgentRequest['intent'], { kind: 'read' }>;

function commandTurn(text: string, businessDate: string): AgentTurnInput | undefined {
  const normalized = normalizeNavisInput(text);
  const quote = /["“'‘]([^"”'’]+)["”'’]/gu;
  const quoted = [...normalized.matchAll(quote)][0]?.[1];
  const value = normalized.replace(quote, ' ');
  if (/(?:방법|어떻게|하지\s*마|말아)|\b(?:how|don't|do not)\b/u.test(value)) return undefined;
  const deliver = /(?:보내|발송|돌려|쏴|전송|게시|올려)|\b(?:send|publish|post)\b/iu;
  let command: CommandIntent['command'] | undefined;
  if (/(?:마감(?:해|하자|실행|취소)|\bclose (?:the )?day\b)/iu.test(value)) command = 'closing.closeDay';
  else if (/(?:결제|환불)\s*(?:해|처리|취소)|\b(?:refund|take payment)\b/iu.test(value)) command = /환불|refund/iu.test(value) ? 'pos.refund' : 'pos.payment';
  else if (/(?:영상|동영상|비디오).*(?:만들|생성|제작|다시)|\b(?:make|generate|retry)\b.*\bvideo\b/iu.test(value)) command = 'video.make';
  else if (deliver.test(value)) {
    if (/(?:문자|공지|알림|SMS|notice|message)/iu.test(value)) command = 'notice.send';
    else if (/(?:쿠폰|coupon)/iu.test(value)) command = 'coupon.sendReachOut';
    else if (/(?:답글|리뷰|reply|review)/iu.test(value)) command = 'inquiry.post';
  }
  if (!command) return undefined;
  const body = quoted && quoted.length <= 1000 ? quoted : undefined;
  const date = parseNavisDate(value, businessDate);
  const amount = parseNavisMoney(value);
  const args: Record<string, AgentWireArgs[string]> = {};
  const slots: Record<string, SlotValue> = {};
  function add(field: string, literal: SlotValue | undefined) {
    if (literal === undefined) return;
    args[field] = { slot: field };
    slots[field] = literal;
  }
  if (command === 'notice.send' || command === 'coupon.sendReachOut') add('body', body);
  if (command === 'notice.send' || command === 'closing.closeDay') {
    if (command === 'notice.send') {
      const draftDate = readNavisNoticeDate(value, businessDate);
      add('startDate', draftDate);
      add('endDate', draftDate);
    } else add('date', date);
  }
  if (command === 'pos.payment' || command === 'pos.refund') add('amount', isMenuPrice(amount) ? amount : undefined);
  if (command === 'video.make') {
    const seconds = /(?:^|\s)(10|15|20|30)\s*초/u.exec(value)?.[1];
    if (seconds) args.lengthSec = Number(seconds);
  }
  return { intent: { kind: 'command', command, args }, slots };
}

function menuReadTurn(text: string): AgentTurnInput | undefined {
  const value = normalizeNavisInput(text).replace(/[.!?。！？]+$/u, '');
  if (/^(?:우리\s*가게\s*)?(?:메뉴\s*(?:총\s*)?몇\s*개|메뉴\s*수)(?:\s*(?:등록돼\s*있어|예요|야|알려\s*줘|알려\s*주세요))?$/u.test(value)) {
    return { intent: { kind: 'read', featureId: 'menu', condition: { kind: 'default' } } };
  }
  const item = /^(.+?)\s*(?:얼마야|가격\s*(?:알려\s*(?:줘|주세요))?)$/u.exec(value)?.[1]?.trim();
  if (!item || item.length > 80 || /(?:메뉴|매출|주문|세금|원가|이익|마진|수익|월세|시재|홍보|입고|지난|저번|이번|오늘|어제|내일|일주일|요금|지출)/u.test(item)) return undefined;
  return { intent: { kind: 'read', recordKind: 'menu', querySlot: 'name' }, slots: { name: item } };
}

function widgetStatusRead(text: string, businessDate: string): DomainTurnInput | undefined {
  const status = widgetStatusQuery(text);
  if (!status) return undefined;
  const { featureId, factKeys } = status;
  const condition = readNavisCondition(featureId, text, businessDate);
  return condition ? { intent: { kind: 'read', featureId, condition }, factKeys } : undefined;
}

function localDraft(args: Record<string, unknown>, slots: LocalSlots, targets: RecordTargets): AgentHandoff['draft'] {
  const expand = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(expand);
    if ('slot' in value) return typeof value.slot === 'string' && Object.hasOwn(slots, value.slot) ? slots[value.slot] : undefined;
    if ('handle' in value) return typeof value.handle === 'string' ? targets.get(value.handle)?.id : undefined;
    return Object.fromEntries(Object.entries(value).map(([field, child]) => [field, expand(child)]).filter(([, child]) => child !== undefined));
  };
  return expand(args) as AgentHandoff['draft'];
}

function parseSlotValue(field: string, input: string, businessDate: string): SlotValue | undefined {
  const value = normalizeNavisInput(input);
  if (!value || value.length > 1000) return undefined;
  if (/price|amount|wage/i.test(field)) return parseNavisMoney(value);
  if (/date|dueOn|asOf/i.test(field)) return parseNavisDate(value, businessDate);
  if (/time|^(start|end)$/i.test(field)) return parseNavisTime(value);
  if (/^(qty|stock|quantity|threshold)$/i.test(field)) return parseNavisQuantity(value)?.value ?? parseNavisNumber(value);
  return value;
}

/** What an ordered plan's step lends to one turn: it binds the outgoing request, and it sees the terminal frames. */
interface StepHooks {
  project(body: AgentRequest): boolean;
  onTerminal(done: AgentDone, proposal?: AgentFrameData['action_proposal']): void;
}

/** One ordered plan for the chat of one run. Its runner decides every transition; this provider only runs the turns. */
interface Sequence {
  readonly runner: MultiStepRunner;
  readonly locals: ReadonlyMap<string, DomainTurnInput>;
  readonly input: AskInput;
  readonly total: number;
  /** A plan with a write waits for the owner's cards and is kept; a read-only plan finishes within its own ask. */
  readonly kept: boolean;
}

type PendingClarification = {
  readonly id: string;
  readonly isCurrent: () => boolean;
  readonly field: string;
  readonly choices?: readonly AgentSuggestion[];
  readonly rename?: (name: string, input: AskInput) => Promise<AssistantReply>;
  readonly resume: (value: AgentContinuation, input: AskInput) => Promise<AssistantReply> | undefined;
};

export function createAssistantProvider(options: AssistantProviderOptions = {}): AssistantProvider {
  const store = options.store ?? defaultStore();
  const source = options.source ?? storeFactSource(store);
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const classifyEnabled = options.classify ?? (options.fetcher === undefined && import.meta.env.MODE !== 'test');
  const domains = gateUnreadable(options.domains ?? assistantDomains, store);
  const run = options.run;
  const actions = createAgentActions(store, domains, run);
  const memory = conversationMemory();
  /** The menus the owner asked a price of, newest last, for "카페라떼는?" and "둘 중에 뭐가 더 비싸?". */
  const menuTrail: string[] = [];
  // One queryBinding and one set of random handles and cursors per lookup (B22). They never leave this provider's memory.
  const lookupScope = createLookupScope();
  const clock = options.clock ?? Date.now;
  let activeAgent: AbortController | undefined;
  let pending: PendingClarification | undefined;
  let proposal: ProposalSession | undefined;
  let sequence: Sequence | undefined;
  let generation = 0;
  let scope: LayerId | undefined;
  let lastSentence: string | undefined;
  let undo: { token: string; runId: string; label: string; command: string; expiresAt: number } | undefined;

  /** The real-port domains this run reads over HTTP. Empty for a fixture store, where nothing below runs. */
  const httpDomains = () => {
    const port = store.real;
    return port ? REAL_DOMAINS.filter(domain => port.mode(domain) === 'http') : [];
  };
  /**
   * F17: facts for a widget the owner has not opened yet. The port shares one request per domain and answers a loaded domain at once, so
   * this is cheap after the first call; a failed domain is tried again. A slow server does not hold the question: after the wait cap the
   * domain simply stays unavailable for this answer (see `gateUnreadable`).
   */
  function preloadFacts(): Promise<void> {
    const port = store.real, domains = httpDomains();
    if (!port || !domains.length) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<void>(resolve => { timer = setTimeout(resolve, PRELOAD_WAIT_MS); });
    const loaded = Promise.all(domains.map(domain => port.load(domain))).then(() => undefined, () => undefined);
    return Promise.race([loaded, capped]).finally(() => clearTimeout(timer));
  }

  function replacePending() {
    // The plan is dropped before its card is cancelled, so that receipt cannot start the next step.
    sequence = undefined;
    proposal?.cancel();
    generation++;
    proposal = undefined;
    pending = undefined;
  }

  function discardAgentTurn() {
    activeAgent?.abort();
    activeAgent = undefined;
    replacePending();
  }

  function registerProposal(reply: AssistantReply, local: LocalAgentProposal, menu?: AgentActionProposal): AssistantReply {
    const session: ProposalSession = createProposalSession(local, menu, () => !run || run.getState().layer !== 'orders-payment' && run.getState().edit.mode === 'view', (receipt, label) => {
      const after = session.getSnapshot().menu?.preview.after;
      memory.rememberCommand(local.command, label, after ? { name: after.name, category: after.category, price: after.price } : undefined);
      const runId = store.getSnapshot().runId;
      if (receipt.undoToken && runId) undo = { token: receipt.undoToken, label, command: local.command,
        expiresAt: receipt.notice?.undoUntil ?? clock() + timePolicy.undoMs, runId };
      else undo = undefined;
    }, menu ? tLabel(reply.locale) : local.command);
    proposal = session;
    return { ...reply, ...(menu ? { proposal: menu } : {}), proposalSession: session, turn: { kind: 'proposal', proposal: local } };
  }

  function tLabel(locale: Locale = 'ko') {
    return navisTranslator(locale).t('common.navis.agent.menuCreate');
  }

  function agentReply(locale: Locale): AssistantReply {
    return { answer: '', panels: [], locale, protocol: AGENT_PROTOCOL };
  }

  function menuClarification(input: AskInput, draft: MenuCreateInput, field: 'name' | 'price' | 'category', isTurnCurrent = () => true): AssistantReply {
    const locale = input.locale ?? 'ko';
    const tr = navisTranslator(locale);
    const id = crypto.randomUUID();
    const snapshot = store.getSnapshot();
    const isCurrent = () => pending?.id === id && isTurnCurrent()
      && store.getSnapshot().runId === snapshot.runId && store.getSnapshot().revision === snapshot.revision;
    pending = { id, field, isCurrent, rename(name, next) {
      replacePending();
      return askMenu(next, { ...draft, name, category: readMenuCategory(name) ?? draft.category });
    }, resume(continuation, next) {
      if (field === 'category') {
        const value = 'choiceId' in continuation ? continuation.choiceId : 'value' in continuation ? continuation.value : undefined;
        const category = typeof value === 'string' ? parseMenuCategoryChoice(value) : undefined;
        if (!category) return undefined;
        replacePending();
        return askMenu(next, { ...draft, category });
      }
      const selected = 'choiceId' in continuation && AGENT_PRICE_CLARIFICATION.choices.find(choice => choice.id === continuation.choiceId);
      const value = 'price' in continuation ? continuation.price : 'value' in continuation ? continuation.value
        : selected && 'value' in selected ? selected.value : undefined;
      if (field === 'name') {
        const name = typeof value === 'string' && readMenuName(value);
        if (!name) return undefined;
        replacePending();
        return askMenu(next, { ...draft, name, category: draft.category ?? readMenuCategory(name) });
      }
      const price = typeof value === 'string' ? conversationPrice(value) : value;
      if (!isMenuPrice(price)) return undefined;
      replacePending();
      return askMenu(next, { ...draft, price, invalidPrice: undefined });
    } };
    const priceChoices = AGENT_PRICE_CLARIFICATION.choices;
    const choices = field === 'price' ? priceChoices.map(choice => ({
      id: choice.id, label: 'value' in choice ? tr.format.money(choice.value, 'full') : tr.t('common.navis.agent.manualPrice'),
    })) : field === 'category' ? MENU_CATEGORIES.map(id => ({ id, label: tr.t(`common.navis.agent.${id}`) })) : [];
    return {
      ...agentReply(locale),
      answer: field === 'price' ? '' : tr.t(`common.navis.agent.${field}Question`),
      turn: { kind: 'clarification', id, field, isCurrent, choices },
      ...(field === 'price' ? { clarification: { ...AGENT_PRICE_CLARIFICATION, id, isCurrent } } : {}),
    };
  }

  function askMenu(input: AskInput, draft: MenuCreateInput | null): Promise<AssistantReply> {
    const { locale = 'ko', layer = 'management' } = input;
    const manual = { ...agentReply(locale), answer: navisTranslator(locale).t('common.navis.agent.manualRoute') };
    if (!draft || input.simpleSignal?.aborted) return Promise.resolve(manual);
    if (!draft.name) return Promise.resolve(menuClarification(input, draft, 'name'));
    if (draft.invalidPrice) return Promise.resolve(menuClarification(input, draft, 'price'));
    if (!draft.category) return Promise.resolve(menuClarification(input, draft, 'category'));
    const snapshot = store.getSnapshot();
    const completeDraft: LocalMenuDraft = { ...draft, name: draft.name, category: draft.category };
    const body = buildMenuAgentRequest(snapshot, completeDraft, locale, layer, domains,
      lookupScope.tokens({ runId: snapshot.runId ?? '', revision: snapshot.revision, kind: 'menu', querySlot: 'name', query: completeDraft.name }));
    return askAgent(input, snapshot, body, {}, { menu: completeDraft });
  }

  async function askAgent(
    input: AskInput, snapshot: DataSnapshot, body: AgentRequest | null, slots: LocalSlots,
    context: {
      readonly menu?: LocalMenuDraft;
      readonly evidence?: readonly AgentReadEvidence[];
      readonly turn?: AgentTurnInput;
      readonly targets?: RecordTargets;
      /** An ordered plan's step sees the server's terminal frame and its proposal frame exactly as they arrive (B23). */
      readonly onTerminal?: StepHooks['onTerminal'];
    } = {},
  ): Promise<AssistantReply> {
    const { locale = 'ko', layer = 'management', text, signal, simpleSignal, onTextDelta, onStatus, onTransportAck, onFirstText } = input;
    const tr = navisTranslator(locale);
    const reply = agentReply(locale);
    const draft = context.menu;
    const evidence = context.evidence;
    const read = (panels: readonly Candidate[], continuationInput?: AskInput, isCurrent?: () => boolean) =>
      groundedRead(reply, evidence ?? [], panels, continuationInput, isCurrent, undefined, context.turn, text);
    const manual = (): AssistantReply => ({ ...reply, answer: tr.t(draft ? 'common.navis.agent.manualRoute' : 'common.navis.agent.manualWidget') });
    if (!body || !validateAgentRequest(body)) return manual();
    if (simpleSignal?.aborted) return evidence ? read([]) : manual();

    const lifetime = new AbortController(), controller = new AbortController();
    activeAgent = lifetime;
    const startedAt = generation;
    const capturedRun = run?.getState();
    const hostLayer = capturedRun?.layer;
    const page = context.turn?.page ?? (run ? run.getState().boards[layer].currentPage + 1 : undefined);
    const isCurrent = () => startedAt === generation && !lifetime.signal.aborted && !signal.aborted
      && store.getSnapshot().runId === snapshot.runId && (!run || run.getState().runId === snapshot.runId
        && run.getState().activeBoard === layer && run.getState().layer === hostLayer
        && (page === undefined || page === run.getState().boards[layer].currentPage + 1));
    let pendingText = '';
    let interrupt!: (reason: Error) => void;
    const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
    const stop = () => { controller.abort(); interrupt(new DOMException('Request stopped', 'AbortError')); };
    const limit = () => { interrupt(new SimpleRequested()); controller.abort(); };
    const deadline = () => { interrupt(new StreamDeadline()); controller.abort(); };
    const firstTimer = setTimeout(deadline, 30000);
    const totalTimer = setTimeout(deadline, options.timeoutMs ?? 60000);
    signal.addEventListener('abort', stop, { once: true });
    lifetime.signal.addEventListener('abort', stop, { once: true });
    simpleSignal?.addEventListener('abort', limit, { once: true });

    try {
      let promoRetryLive = false;
      const request = fetcher('/api/navis/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL },
        body: JSON.stringify(body), signal: controller.signal,
      }).then(response => {
        if (controller.signal.aborted || !response.ok || response.headers?.get(AGENT_PROTOCOL_HEADER) !== AGENT_PROTOCOL) {
          void response.body?.cancel().catch(() => {});
          cancelled(controller.signal);
          return null;
        }
        if (!response.body) return null;
        promoRetryLive = response.headers.get('x-navis-agent-mode') === 'live';
        onTransportAck?.();
        return readReplyStream(response.body, controller.signal, delta => {
          pendingText += delta;
          const endings = [...pendingText.matchAll(/[.!?。！？](?=\s|$)/gu)];
          const last = endings.at(-1);
          if (last?.index === undefined) return;
          const end = last.index + 1;
          const complete = pendingText.slice(0, end);
          pendingText = pendingText.slice(end);
          onTextDelta?.(complete);
        }, () => {}, () => {
          clearTimeout(firstTimer);
          onFirstText?.();
        }, { onStatus });
      });
      const output = await Promise.race([request, interrupted]);
      cancelled(lifetime.signal);
      cancelled(signal);
      if (!output?.done) return evidence ? read([]) : manual();
      const done = output.done;
      context.onTerminal?.(done, output.proposal);
      if (done.outcome === 'navigate' && body.intent.kind === 'command' && isAgentNavigationCommand(body.intent.command)) {
        const action = done.navigation;
        if (action.command !== body.intent.command || action.runId !== body.runId || action.layer !== body.layer || action.page !== body.page ||
          action.snapshotRevision !== body.snapshotRevision || store.getSnapshot().revision !== body.snapshotRevision || !isCurrent()) return manual();
        input.onNavigation?.(action);
        return reply;
      }
      if (done.outcome === 'clarify' && !output.proposal && draft?.price === undefined
        && draft && done.clarification.field === 'price' && done.clarification.promptKey === 'menu.price') {
        return menuClarification(input, draft, 'price', isCurrent);
      }
      if (done.outcome === 'clarify' && !output.proposal && body.intent.kind === 'command' && body.intent.clarify
        && done.clarification.field === body.intent.clarify) {
        return clarifyOnly(input, snapshot, body.intent.clarify, context.turn, isCurrent);
      }
      if (done.outcome === 'clarify' && !output.proposal && body.intent.kind === 'command') {
        return genericClarification(input, snapshot, { ...context.turn, intent: body.intent, slots }, done.clarification, isCurrent) ?? manual();
      }
      if (done.outcome === 'proposal' && output.proposal && proposalScope(output.proposal, body, context.turn?.page)) {
        if (draft && output.proposal.command === 'menu.create' && isMenuPrice(draft.price)) {
          if (body.searches.some(search => search.kind === 'menu' && search.matches.length > 0)) return refusedReply(reply, 'duplicate');
          const { args } = output.proposal;
          const category = draft.category === 'beverage' && 'category' in args && args.category === 'drink' ? 'drink' : draft.category;
          const proposal = actions.propose(output.proposal, { ...draft, category, price: draft.price }, snapshot, isCurrent);
          if (proposal) return registerProposal(reply, proposal, proposal);
        } else if (body.intent.kind === 'command' && output.proposal.command === body.intent.command
          && sameArgs(output.proposal.args, body.intent.args ?? {})) {
          const outcome = actions.prepare(output.proposal, { ...slots, navisLocale: locale, promoRetryLive }, snapshot, isCurrent, context.targets, capturedRun);
          if (outcome.kind === 'proposal') return registerProposal(reply, outcome.proposal);
          return { ...reply, answer: tr.t(outcome.messageKey && tr.has(outcome.messageKey) ? outcome.messageKey : `common.navis.agent.${outcome.kind}`) };
        }
      }
      if (done.outcome === 'ambiguous' && evidence) return read([], input, isCurrent);
      if (done.outcome === 'reply') {
        const panels = validate(output, source, layer, signal).filter(panel => !evidence ||
          store.getSnapshot().revision === snapshot.revision && evidence.some(record => record.tool === 'get_widget'
            && record.status === 'ready' && record.args.featureId === panel.featureId && sameArgs(record.args.condition, panel.condition)));
        if (evidence) return read(panels, input, isCurrent);
        if (draft && (panels.length || output.answer.trim())) return { ...reply, answer: output.answer.trim(), panels };
      }
      if (done.outcome === 'refused') {
        const typed = done.refusal;
        // A model's own refusal leaves the read grounded in the facts; a typed policy decision is never replaced by them (B26).
        if (evidence && !typed) return read([], input, isCurrent);
        const alternative = typed?.alternative;
        const handoff = alternative && 'command' in alternative
          ? body.intent.kind === 'command' ? checkedHandoff(alternative, body.intent, slots, snapshot, context.targets) : undefined
          // A feature-level alternative is only the widget to open; it carries no draft and no command.
          : alternative && getRegistration(alternative.featureId) ? { featureId: alternative.featureId } : undefined;
        const refused = refusedReply(reply, typed?.reason ?? 'unsupported', handoff);
        // The server's fixed policy copy stands when it sent one; otherwise the standard copy for the reason.
        const copy = typed ? output.answer.trim() : '';
        return copy ? { ...refused, answer: copy } : refused;
      }
      if (done.outcome === 'handoff' && body.intent.kind === 'command') {
        const destination = checkedHandoff(done.handoff, body.intent, slots, snapshot, context.targets);
        if (destination) return { ...reply, answer: tr.t('common.navis.agent.manualWidget'), turn: { kind: 'handoff', destination } };
      }
      return manual();
    } catch (error) {
      cancelled(lifetime.signal);
      cancelled(signal);
      if (error instanceof StreamDeadline) {
        if (body.intent.kind === 'read' && evidence) return { ...read([]), mode: 'simple' };
        if (body.intent.kind === 'menu.create' ||
          body.intent.kind === 'command' && agentCommandPolicy(body.intent.command, body.intent.args).policy === 'propose') {
          return { ...reply, answer: copy.requestFailed, turn: { kind: 'refusal', reason: 'request_failed' } };
        }
      }
      return evidence ? read([]) : manual();
    } finally {
      controller.abort();
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      signal.removeEventListener('abort', stop);
      lifetime.signal.removeEventListener('abort', stop);
      if (activeAgent === lifetime) activeAgent = undefined;
      simpleSignal?.removeEventListener('abort', limit);
    }
  }

  function proposalScope(frame: WireProposal, body: AgentRequest, page: number | undefined): boolean {
    return (frame.runId === undefined || frame.runId === body.runId)
      && (frame.layer === undefined || frame.layer === body.layer)
      && (frame.page === undefined || frame.page === page);
  }

  function sameArgs(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    const pairs = Object.entries(left), target = Object.entries(right);
    return pairs.length === target.length && pairs.every(([key, value]) =>
      target.some(([name, expected]) => name === key && sameArgs(value, expected)));
  }

  function checkedHandoff(route: WireHandoff, intent: CommandIntent, slots: LocalSlots, snapshot: DataSnapshot, targets: RecordTargets = new Map()): AgentHandoff | undefined {
    if (route.command !== intent.command || route.featureId !== agentCommandPolicy(intent.command, intent.args).featureId
      || route.runId !== undefined && route.runId !== snapshot.runId
      || route.snapshotRevision !== undefined && route.snapshotRevision !== snapshot.revision
      || !validateAgentDraft(route.command, route.draft)) return undefined;
    if (!Object.entries(route.draft).every(([key, value]) => sameArgs(value, intent.args?.[key]))) return undefined;
    if (agentCommandRefs(route.command, route.draft).some(ref => {
      if (!('handle' in ref)) return false;
      const target = targets.get(ref.handle);
      return !target || !ref.kinds?.some(kind => kind === '*' || kind === target.kind);
    })) return undefined;
    return { featureId: route.featureId, command: route.command, draft: localDraft(route.draft, slots, targets) };
  }

  function refusedReply(reply: AssistantReply, reason: AgentRefusal['reason'], alternative?: AgentHandoff): AssistantReply {
    const tr = navisTranslator(reply.locale ?? 'ko');
    const copy = reason === 'duplicate' ? 'duplicateName' : reason === 'widget_only' ? 'widgetOnly'
      : reason === 'unavailable' ? 'manualWidget' : 'unsupported';
    return { ...reply, answer: tr.t(`common.navis.agent.${copy}`), turn: { kind: 'refusal', reason, ...(alternative ? { alternative } : {}) } };
  }

  function readProjection(snapshot: DataSnapshot, intent: ReadIntent, slots: LocalSlots, locale: Locale, turn: DomainTurnInput):
    { projection: Pick<AgentRequest, 'snapshot' | 'searches'>; evidence: AgentReadEvidence[]; intent?: ReadIntent } {
    const projection: Pick<AgentRequest, 'snapshot' | 'searches'> = { snapshot: [], searches: [] };
    /** One record lookup: its wire pages (the root page beside a continued one), its local evidence, and the tokens that name it. */
    const recordRead = (args: { readonly kind: AgentSearchProjection['kind']; readonly querySlot: string }, cursor?: string) => {
      const query = slots[args.querySlot];
      if (typeof query !== 'string') {
        const search = { ...args, matches: [], status: 'missing' as const };
        const evidence: AgentReadEvidence = { tool: 'search_records', args, status: 'missing', matches: [], display: new Map(), browse: turn.browse };
        return { pages: [search], evidence };
      }
      const tokens = lookupScope.tokens({ runId: snapshot.runId ?? '', revision: snapshot.revision, ...args, query });
      // B27's aspect stays in the reader's inputs: it is never part of the wire request.
      const root = projectAgentSearch(domains, snapshot, args, query, locale, false, undefined, turn.aspect);
      const search = cursor ? projectAgentSearch(domains, snapshot, { ...args, cursor }, query, locale, false, undefined, turn.aspect) : root;
      const status = search.status === 'unavailable' ? 'unavailable' : search.matches.length ? 'ready' : 'missing';
      const reader = domains.reader(args.kind);
      const display = new Map<string, string>();
      if (reader?.describe) for (const match of search.matches) {
        const label = reader.describe(match, locale, { snapshot, locale, query, privateLookup: false, querySlot: args.querySlot, ...(turn.aspect ? { aspect: turn.aspect } : {}) });
        if (label) display.set(match.handle, label);
      }
      const evidence: AgentReadEvidence = { tool: 'search_records', args, status, matches: search.matches, display, browse: turn.browse,
        ...(search.nextCursor ? { nextCursor: search.nextCursor } : {}) };
      // A page after the first needs the original root page beside it, and the request names the lookup it continues.
      return { pages: (cursor ? [root, search] : [search]).map(page => wireSearchPage(page, tokens)), evidence, tokens };
    };
    if (intent.recordKind && intent.querySlot) {
      const { pages, evidence, tokens } = recordRead({ kind: intent.recordKind, querySlot: intent.querySlot }, turn.cursor);
      return { projection: { ...projection, searches: pages }, evidence: [evidence],
        ...(turn.cursor && tokens ? { intent: { ...intent, queryBinding: tokens.binding, cursor: tokens.cursor(turn.cursor) } } : {}) };
    }
    const scoped = (projected: Extract<AgentReadEvidence, { tool: 'get_widget' | 'get_source' }>, part: Pick<DomainTurnInput, 'factKeys' | 'narrow'>) => {
      const keyed = part.factKeys ? projected.facts.filter(fact => part.factKeys!.includes(fact.key)) : projected.facts;
      const facts = (part.narrow ? part.narrow(keyed) : keyed).slice(0, 128);
      const read = { ...projected, facts, status: projected.status === 'ready' && !facts.length ? 'missing' as const : projected.status };
      const entry = { ...read.args, ...(read.status === 'ready' ? { facts: read.facts } : { status: read.status }),
        ...(read.tool === 'get_source' ? { candidateAllowed: false as const } : {}) };
      return { read, entry };
    };
    if (intent.reads) {
      // An ordered read list: each selected widget or source is projected on its own, in the compiled order.
      const entries = [], searches: AgentSearchProjection[] = [], evidence: AgentReadEvidence[] = [];
      for (const [index, selection] of intent.reads.entries()) {
        if (selection.name === 'search_records') {
          const lookup = recordRead({ kind: selection.args.kind as AgentSearchProjection['kind'], querySlot: selection.args.querySlot });
          searches.push(...lookup.pages);
          evidence.push(lookup.evidence);
          continue;
        }
        const condition: QueryCondition = selection.args.condition ?? { kind: 'default' };
        const projected = selection.name === 'get_widget' ? projectAgentWidget(snapshot, selection.args.featureId as FeatureId, condition, locale, domains)
          : projectAgentSource(snapshot, selection.args.sourceId, condition, locale, domains, run?.getState());
        const { read, entry } = scoped(projected, turn.readParts?.[index] ?? {});
        entries.push(entry);
        evidence.push(read);
      }
      return { projection: { ...projection, snapshot: entries, searches }, evidence };
    }
    const condition: QueryCondition = intent.condition ?? { kind: 'default' };
    const feature = intent.featureId && getRegistration(intent.featureId);
    const projected = feature ? projectAgentWidget(snapshot, feature.id, condition, locale, domains)
      : intent.sourceId ? projectAgentSource(snapshot, intent.sourceId, condition, locale, domains, run?.getState()) : undefined;
    if (!projected) return { projection, evidence: [] };
    const { read, entry } = scoped(projected, turn);
    return { projection: { ...projection, snapshot: [entry] }, evidence: [read] };
  }

  function groundedRead(
    reply: AssistantReply, evidence: readonly AgentReadEvidence[], panels: readonly Candidate[],
    input?: AskInput, isTurnCurrent = () => true, selectedId?: string, turn?: DomainTurnInput, question = '',
  ): AssistantReply {
    const tr = navisTranslator(reply.locale ?? 'ko');
    const asksForRestockItems = /(?:부족한|보충이 필요한)\s*(?:품목|재료|상품|거)/u.test(question);
    // A context read scopes and checks the answer (its widget and period); only the other reads put facts in the text.
    const contextOnly = new Set(turn?.readParts?.flatMap((part, index) => part.context ? [index] : []));
    const answer = evidence.flatMap((record, index) => {
      if (contextOnly.has(index)) return [];
      if (record.tool === 'search_records') return record.matches.filter(match => !selectedId || match.handle === selectedId)
        .flatMap(match => {
          const display = record.display?.get(match.handle);
          return display ? [display] : match.label && match.price !== undefined ? [`${match.label} ${tr.format.money(match.price, 'full')}`] : [];
        });
      return record.facts.map(fact => {
        if (fact.key === 'menu.count') return tr.t('common.navis.agent.menuCount', { count: typeof fact.value === 'number' ? tr.format.number(fact.value) : fact.display });
        if (fact.key === 'inventory.restock.count' && fact.value === 0 && asksForRestockItems) {
          return tr.t('navis.stock.noRestock');
        }
        if (/^calendar\.entry\.\d+$/u.test(fact.key)) return fact.source === 'staff-schedule' ? `${fact.label} · ${fact.display}` : fact.display;
        if (fact.key === 'ledger.candidates.empty') return fact.display;
        return `${fact.label} ${fact.display}`;
      });
    }).join('\n');
    const search = evidence.find(record => record.tool === 'search_records');
    const records = search?.matches.filter(match => !selectedId || selectedId === match.handle).flatMap(match => match.label ? [{
      id: match.handle, label: match.label,
      ...(match.price !== undefined ? { detail: tr.format.money(match.price, 'full') } : {}),
    }] : []) ?? [];
    if (search) memory.rememberRecords(records, store.getSnapshot().revision);
    if (!selectedId && search && !search.browse && search.matches.length > 1 && !proposal?.isPending() && !pending?.isCurrent()) {
      if (!records.length) return { ...reply, answer: tr.t('common.navis.noData'), turn: { kind: 'read', evidence } };
      // A page of five never hides the rest: the next page is one more choice, continued from the cursor this page issued.
      const more = turn && search.nextCursor ? search.nextCursor : undefined;
      const choices = [...records, ...(more ? [NEXT_PAGE_CHOICE] : [])];
      const id = crypto.randomUUID();
      const captured = store.getSnapshot();
      const isCurrent = () => pending?.id === id && isTurnCurrent() && store.getSnapshot() === captured;
      if (input) pending = { id, field: search.args.querySlot, choices, isCurrent, resume(continuation, next) {
        if (!('choiceId' in continuation) || !choices.some(choice => choice.id === continuation.choiceId)) return undefined;
        replacePending();
        if (more && turn && continuation.choiceId === NEXT_PAGE) return runAgentTurn(next, { ...turn, cursor: more });
        const picked = records.find(choice => choice.id === continuation.choiceId)!;
        const answer = groundedRead(agentReply(next.locale ?? reply.locale ?? 'ko'), evidence, [], undefined, undefined, picked.id);
        memory.rememberRead(answer, { intent: { kind: 'read', recordKind: search.args.kind, querySlot: search.args.querySlot }, slots: { [search.args.querySlot]: picked.label } });
        return Promise.resolve(answer);
      } };
      return { ...reply, answer: tr.t('common.navis.agent.chooseRecord'), turn: { kind: 'ambiguity', id, field: search.args.querySlot, choices, isCurrent } };
    }
    const unavailable = evidence.some(record => record.status === 'unsupported_period');
    const summarized = panels.map(panel => {
      const read = evidence.find(record => record.tool === 'get_widget' && record.status === 'ready'
        && record.args.featureId === panel.featureId && sameArgs(record.args.condition, panel.condition));
      if (!read || read.tool !== 'get_widget') return panel;
      const fact = read.facts.find(fact => fact.key === 'tax.unpaid.total')
        ?? read.facts.find(fact => typeof fact.value === 'number');
      return { ...panel, summary: fact ? { label: fact.label, display: fact.display } : null };
    });
    return { ...reply, answer: answer || tr.t(unavailable ? 'common.navis.agent.unsupportedPeriod' : 'common.navis.noData'),
      panels: summarized, turn: { kind: 'read', evidence } };
  }

  /** The server asked only what is missing (B20 clarify-only selector): which menu, which final status, or which expense candidate. */
  function clarifyOnly(input: AskInput, snapshot: DataSnapshot, field: 'menuId' | 'status' | 'expenseId', turn: DomainTurnInput | undefined,
    isTurnCurrent: () => boolean): AssistantReply {
    const locale = input.locale ?? 'ko';
    const id = crypto.randomUUID();
    const isCurrent = () => pending?.id === id && isTurnCurrent() && store.getSnapshot() === snapshot;
    const choices: readonly AgentSuggestion[] = field === 'status' ? [{ id: 'sold_out', label: '품절' }, { id: 'selling', label: '판매 중' }] : [];
    // Which menu and which expense are both a question about the target; the wire field name stays the server's.
    const asked = field === 'status' ? 'status' : 'target';
    pending = { id, field: asked, choices, isCurrent, resume(continuation, next) {
      const picked = 'choiceId' in continuation ? choices.find(choice => choice.id === continuation.choiceId)?.id
        : 'value' in continuation && typeof continuation.value === 'string' ? continuation.value.trim() : undefined;
      if (!picked) return undefined;
      if (field === 'status' && (picked === 'sold_out' || picked === 'selling') && turn?.slots?.name) {
        replacePending();
        return runAgentTurn(next, { intent: { kind: 'command', command: 'menu.setSaleStatus', querySlot: 'name', args: { status: picked } },
          slots: turn.slots, lookups: [{ kind: 'menu', querySlot: 'name', bind: ['menuId'] }] });
      }
      if (field === 'menuId') {
        const route = domains.route(`${picked} 품절로 바꿔줘`, store.getSnapshot(), next.locale ?? 'ko', 'menu', run?.getState());
        if (!route) return undefined;
        return applyDomainRoute(next, store.getSnapshot(), route);
      }
      return undefined;
    } };
    return { ...agentReply(locale), answer: CLARIFY_ONLY_COPY[field], turn: { kind: 'clarification', id, field: asked, choices, isCurrent } };
  }

  function genericClarification(
    input: AskInput, snapshot: DataSnapshot, turn: AgentTurnInput & { readonly intent: CommandIntent },
    frame: Extract<AgentFrameData['done'], { outcome: 'clarify' }>['clarification'], isTurnCurrent: () => boolean,
  ): AssistantReply | undefined {
    const { intent, slots = {} } = turn;
    const args = intent.args ?? {};
    const field = agentMissingField(intent.command, args, Object.keys(slots));
    if (!field || frame.field !== field || 'command' in frame && frame.command !== intent.command) return undefined;
    const tr = navisTranslator(input.locale ?? 'ko');
    const id = crypto.randomUUID();
    const isCurrent = () => pending?.id === id && isTurnCurrent() && store.getSnapshot() === snapshot;
    const allowed = agentFieldChoices(intent.command, field);
    const choices = frame.choices.flatMap<{ id: string; label: string; value?: SlotValue }>(choice => 'value' in choice
      ? allowed.some(value => value === choice.value) ? [{ id: choice.id, label: String(choice.value), value: choice.value }] : []
      : [{ id: choice.id, label: tr.t('common.navis.agent.manualPrice'), value: undefined }]);
    pending = { id, field, choices, isCurrent, resume(continuation, next) {
      const value = 'value' in continuation ? continuation.value : 'price' in continuation ? continuation.price
        : choices.find(choice => choice.id === continuation.choiceId)?.value;
      if (value === undefined) return undefined;
      const result = typeof value === 'string' ? parseSlotValue(field, value, snapshot.pos?.businessDate ?? TODAY) : value;
      if (result === undefined) return undefined;
      const prior = args[field];
      const ref = prior && typeof prior === 'object' && 'slot' in prior && typeof prior.slot === 'string' ? prior.slot : field;
      const updated = { ...args, [field]: allowed.length ? result : { slot: ref } };
      if (!validateAgentDraft(intent.command, updated)) return undefined;
      const validateSlot = domains.command(intent.command)?.slots[ref];
      if (!allowed.length && validateSlot && !validateSlot(result)) return undefined;
      replacePending();
      return runAgentTurn(next, { ...turn, intent: { ...intent, args: updated }, slots: { ...slots, ...(allowed.length ? {} : { [ref]: result }) } });
    } };
    return { ...agentReply(input.locale ?? 'ko'), answer: tr.t('common.navis.agent.fieldQuestion', { field }),
      turn: { kind: 'clarification', id, field, choices: choices.map(({ id, label }) => ({ id, label })), isCurrent } };
  }

  function bindReference(args: AgentWireArgs, [field, ...path]: readonly string[], handle: string): AgentWireArgs {
    if (!field) return args;
    const child = args[field];
    return { ...args, [field]: path.length ? bindReference(
      child && typeof child === 'object' ? child as AgentWireArgs : {}, path, handle,
    ) : { handle } };
  }

  function chooseTarget(input: AskInput, snapshot: DataSnapshot, turn: DomainTurnInput, lookup: DomainLookup,
    records: readonly AgentSuggestion[], nextCursor?: string): AssistantReply {
    const locale = input.locale ?? 'ko';
    const id = crypto.randomUUID(), version = generation;
    const choices = nextCursor ? [...records, NEXT_PAGE_CHOICE] : records;
    const isCurrent = () => pending?.id === id && version === generation && store.getSnapshot() === snapshot;
    pending = { id, field: lookup.querySlot, choices, isCurrent, resume(continuation, next) {
      if (!('choiceId' in continuation) || !choices.some(choice => choice.id === continuation.choiceId)) return undefined;
      const selected = continuation.choiceId;
      replacePending();
      // The next page continues from the cursor this page issued; a record choice pins that candidate.
      const patch = nextCursor && selected === NEXT_PAGE ? { cursor: nextCursor } : { selected };
      return runAgentTurn(next, { ...turn, lookups: turn.lookups?.map(item => item === lookup ? { ...item, ...patch } : item) });
    } };
    return { ...agentReply(locale), answer: navisTranslator(locale).t('common.navis.agent.chooseRecord'),
      turn: { kind: 'ambiguity', id, field: lookup.querySlot, choices, isCurrent } };
  }

  function applyDomainRoute(input: AskInput, snapshot: DataSnapshot, route: DomainRoute): Promise<AssistantReply> {
    const locale = input.locale ?? 'ko';
    if ('intent' in route) {
      if (route.intent.kind === 'read' && route.intent.recordKind === 'taxPayment' && route.onMissing) {
        const widget = missingTaxEvidenceHandoff(input.text);
        if (widget) {
          replacePending();
          return Promise.resolve(refusedReply(agentReply(locale), 'widget_only', widget));
        }
      }
      if (route.intent.kind !== 'read' && !(route.intent.kind === 'command' && isAgentNavigationCommand(route.intent.command))) replacePending();
      if (run?.getState().layer === 'orders-payment' && route.intent.kind === 'command' &&
        !isAgentNavigationCommand(route.intent.command) && agentCommandPolicy(route.intent.command, route.intent.args).policy === 'propose') {
        return Promise.resolve(localReply(input, 'manualWidget'));
      }
      return runAgentTurn(input, route);
    }
    const reply = agentReply(locale);
    const answered = route.kind === 'answer' ? route.answer : route.kind === 'refusal' ? route.answer : undefined;
    if (answered && DEAD_END.test(answered) && classifyEnabled && !classifiedInputs.has(input) && !input.agentTurn) {
      classifiedInputs.add(input);
      return planRouteFor(input).then(planned => planned ? applyDomainRoute(input, snapshot, planned) : applyDomainRoute(input, snapshot, route));
    }
    if (route.kind === 'answer') {
      if (route.cancelPending) replacePending();
      return Promise.resolve({ ...reply, answer: route.answer });
    }
    replacePending();
    if (route.kind === 'refusal') {
      const refusal = refusedReply(reply, route.reason, route.alternative);
      return Promise.resolve({ ...refusal, answer: route.answer ?? refusal.answer });
    }
    const id = crypto.randomUUID(), version = generation;
    const isCurrent = () => pending?.id === id && version === generation && store.getSnapshot() === snapshot;
    const choices = route.choices;
    pending = { id, field: route.field, isCurrent, resume(continuation, next) {
      const value = choices
        ? 'choiceId' in continuation && choices.find(choice => choice.id === continuation.choiceId)?.id
        : 'value' in continuation ? continuation.value
        : 'price' in continuation && route.field === 'price' && isMenuPrice(continuation.price) ? String(continuation.price) : undefined;
      if (typeof value !== 'string') return undefined;
      const routed = route.resume?.(value, run?.getState());
      return routed ? applyDomainRoute(next, snapshot, routed) : undefined;
    } };
    return Promise.resolve({ ...reply, answer: route.answer, turn: { kind: 'clarification', id, field: route.field, choices: choices ?? [], isCurrent } });
  }

  /**
   * D-371: a router-chosen read for a sentence with a comparison, ratio, trend, "why", superlative or slang marker may be the wrong read.
   * The model's read-only plan decides instead when it is usable; a plan that fails, is unsupported or is slow keeps the router's read.
   */
  function runAgentTurn(input: AskInput, requested: DomainTurnInput, hooks?: StepHooks): Promise<AssistantReply> {
    if (!contestedRead(input, requested)) return runAgentTurnNow(input, requested, hooks);
    classifiedInputs.add(input);
    return planRouteFor(input).then(planned => {
      if (planned && 'intent' in planned) return runAgentTurnNow(input, planned, hooks);
      if (planned?.kind === 'answer') return { ...agentReply(input.locale ?? 'ko'), answer: planned.answer };
      return runAgentTurnNow(input, requested, hooks);
    });
  }

  function runAgentTurnNow(input: AskInput, requested: DomainTurnInput, hooks?: StepHooks): Promise<AssistantReply> {
    const { locale = 'ko', layer = 'management' } = input;
    const snapshot = store.getSnapshot();
    // A routed read that needs a second source goes out as its ordered pair (B27).
    const turn = orderedRead(requested, stockDate(snapshot));
    let { intent } = turn;
    const { slots = {}, page, lookup } = turn;
    let { reading } = turn;
    if (intent.kind === 'command' && isAgentNavigationCommand(intent.command)) {
      const body = buildAgentRequest(snapshot, intent, locale, layer, Object.keys(slots),
        { snapshot: [], searches: turn.navigationSearches ?? [] });
      return askAgent(input, snapshot, body && { ...body, layer: run?.getState().layer === 'orders-payment' ? 'pos' : body.layer,
        ...(page !== undefined ? { page } : {}),
        ...(turn.navigationReadings || turn.additionalReadings ? { readings: [...turn.navigationReadings ?? [], ...turn.additionalReadings ?? []] } : {}) }, slots, { turn });
    }
    const targets = new Map<string, ResolvedRecord>();
    // The lookups' local pages, wired together after the loop so a candidate can name another lookup's candidate (a note's member).
    const lookupPages: { readonly page: AgentSearchProjection; readonly tokens: LookupTokens }[] = [];
    for (const targetLookup of turn.lookups ?? (lookup ? [lookup] : []) as readonly DomainLookup[]) {
      const { kind, querySlot, bind, readingBind, selected, cursor } = targetLookup;
      const query = slots[querySlot];
      if (typeof query !== 'string') continue;
      const command = intent.kind === 'command' ? intent.command : undefined;
      const args = { kind, querySlot };
      // The server sees this lookup only through its own queryBinding, random handles and random cursors (B22).
      const tokens = lookupScope.tokens({ runId: snapshot.runId ?? '', revision: snapshot.revision, kind, querySlot, query });
      const root = projectAgentSearch(domains, snapshot, args, query, locale, command !== undefined, command);
      const projected = cursor ? projectAgentSearch(domains, snapshot, { ...args, cursor }, query, locale, command !== undefined, command) : root;
      const matches = selected ? projected.matches.filter(match => match.handle === selected) : projected.matches;
      if ((bind || readingBind) && !selected && (matches.length > 1 || matches.length === 1 && matches[0].match !== 'exact')) {
        const visible = projectAgentSearch(domains, snapshot, cursor ? { ...args, cursor } : args, query, locale, false, command);
        const choices = matches.flatMap(match => {
          const visibleMatch = visible.matches.find(item => item.handle === match.handle);
          const detail = visibleMatch && domains.reader(kind)?.describe?.(visibleMatch, locale);
          return visibleMatch?.label ? [{ id: match.handle, label: visibleMatch.label, ...(detail ? { detail } : {}) }] : [];
        });
        if (choices.length) return Promise.resolve(chooseTarget(input, snapshot, turn, targetLookup, choices, projected.nextCursor));
      }
      const match = matches.length === 1 && (selected || matches[0].match === 'exact') ? matches[0] : undefined;
      if (match) {
        const id = domains.reader(kind)?.resolve?.({ snapshot, locale, query, privateLookup: command !== undefined, command, querySlot }, match.handle);
        if (id) {
          const wireHandle = tokens.handle(match.handle);
          targets.set(wireHandle, { kind, id });
          if (bind && intent.kind === 'command') intent = { ...intent, args: bindReference(intent.args ?? {}, bind, wireHandle) };
          const readPath = readingBind ?? (intent.kind === 'read' ? bind : undefined);
          if (readPath && reading) reading = { ...reading, args: bindReference(reading.args, readPath, wireHandle) } as typeof reading;
        }
      }
      if (selected) {
        // A pinned choice is sent as the one exact candidate of its lookup, with no cursor of its own.
        const first = Object.fromEntries(Object.entries(projected).filter(([field]) => field !== 'cursor' && field !== 'nextCursor')) as unknown as AgentSearchProjection;
        lookupPages.push({ page: { ...first, matches: match ? [{ ...match, match: 'exact' as const }] : matches }, tokens });
      } else lookupPages.push(...(cursor ? [root, projected] : [projected]).map(page => ({ page, tokens })));
    }
    const issued = new Map<string, string>();
    for (const { page, tokens } of lookupPages) for (const { handle } of page.matches) if (!issued.has(handle)) issued.set(handle, tokens.handle(handle));
    const searches = lookupPages.map(({ page, tokens }) => wireSearchPage(page, tokens, local => issued.get(local)));
    // A caller may pass args that already name an adapter handle: only the lookup's wire handle goes out.
    const rewire = <T,>(value: T): T => {
      if (Array.isArray(value)) return value.map(rewire) as T;
      if (!value || typeof value !== 'object') return value;
      const entries = Object.entries(value);
      if (entries.length === 1 && entries[0][0] === 'handle' && typeof entries[0][1] === 'string') return { handle: issued.get(entries[0][1]) ?? entries[0][1] } as T;
      return Object.fromEntries(entries.map(([field, child]) => [field, rewire(child)])) as T;
    };
    if (issued.size) {
      if (intent.kind === 'command' && intent.args) intent = { ...intent, args: rewire(intent.args) };
      if (reading) reading = { ...reading, args: rewire(reading.args) } as typeof reading;
    }
    if (intent.kind === 'command') {
      const policy = agentCommandPolicy(intent.command, intent.args);
      const local = intent.args && localDraft(intent.args, slots, targets);
      const widget = local && commandWidgetHandoff(snapshot, intent.command, local);
      if (widget) return Promise.resolve(refusedReply(agentReply(locale), 'widget_only', widget));
      if (policy.policy !== 'propose') {
        const alternative = policy.featureId && validateAgentDraft(intent.command, intent.args ?? {})
          ? checkedHandoff({ featureId: policy.featureId, command: intent.command, draft: intent.args ?? {} }, intent, slots, snapshot, targets)
          : undefined;
        if (policy.policy === 'handoff' && alternative) {
          const reply = agentReply(locale);
          return Promise.resolve({ ...reply, answer: navisTranslator(locale).t('common.navis.agent.manualWidget'), turn: { kind: 'handoff', destination: alternative } });
        }
        const refusal = refusedReply(agentReply(locale), 'widget_only', alternative);
        if (intent.command === 'video.make' || intent.command === 'video.retry') {
          const stats = simpleReply({ text: input.text, locale, layer, source });
          if (stats.panels.some(panel => panel.featureId === 'promo-video')) {
            return Promise.resolve({ ...refusal, answer: `${refusal.answer}\n${stats.answer}`, panels: stats.panels });
          }
        }
        return Promise.resolve(refusal);
      }
      if (agentCommandRefs(intent.command, intent.args ?? {}).some(ref => 'handle' in ref && !targets.has(ref.handle))) {
        return Promise.resolve(refusedReply(agentReply(locale), 'invalid_target'));
      }
    }
    const read = intent.kind === 'read' ? readProjection(snapshot, intent, slots, locale, turn) : undefined;
    const evidence: AgentReadEvidence[] = read?.evidence ?? [];
    const projection = read
      ? { ...read.projection, searches: [...read.projection.searches, ...searches] }
      : { snapshot: (intent.kind === 'command' ? [commandSnapshotEntry(snapshot, intent, locale, domains)] : []).filter(entry => entry !== undefined), searches };
    // A continued page names its lookup (queryBinding) and the cursor the previous page issued.
    const body = buildAgentRequest(snapshot, read?.intent ?? intent, locale, layer, Object.keys(slots), projection, domains);
    if (!body) return askAgent(input, snapshot, null, slots);
    const readings: AgentReadProjection[] = [...turn.additionalReadings ?? []];
    if (reading && (intent.kind === 'command' || intent.kind === 'read' && intent.tool === reading.tool) && validateAgentToolArgs(reading.tool, reading.args)) {
      const projected = domains.tool(reading.tool)?.read(snapshot, reading.args, locale, slots, targets, run?.getState()) ?? { status: 'unavailable' as const };
      const result = 'facts' in projected && turn.factKeys
        ? { facts: projected.facts.filter(fact => turn.factKeys!.includes(fact.key)) } : projected;
      readings.push({ ...reading, ...result });
      evidence.push({ ...reading, status: 'status' in result ? result.status : 'ready', facts: 'facts' in result ? result.facts : [] });
    }
    const sent = { ...body, ...(page !== undefined ? { page } : {}), ...(readings.length ? { readings } : {}) };
    // An ordered plan's step is bound to the very request that goes out; if the plan refuses it, nothing is sent.
    if (hooks && !hooks.project(sent)) return Promise.resolve(localReply(input, 'manualWidget'));
    return askAgent(input, snapshot, sent,
      slots, { ...(read ? { evidence } : {}), turn: { ...turn, intent, reading }, targets, onTerminal: hooks?.onTerminal }).then(reply => {
      const fallback = turn.onMissing;
      // A context read only scopes the answer; it never decides whether the owner's own fact was found.
      const asked = evidence.filter((_, index) => !turn.readParts?.[index]?.context);
      if (fallback && asked.length > 0 && asked.every(record => record.status === 'missing')) {
        return { ...(fallback.reason ? refusedReply(reply, fallback.reason, fallback.alternative) : reply), answer: fallback.answer };
      }
      if (turn.compare && reply.turn?.kind === 'read') {
        const values = turn.compare.map(key => evidence.flatMap(record => 'facts' in record ? record.facts : []).find(fact => fact.key === key)?.value);
        if (values.every(value => typeof value === 'number')) {
          return { ...reply, answer: `${reply.answer}\n${values[0] === values[1] ? '두 위젯의 매출이 같아요.' : '두 위젯의 매출이 달라요.'}` };
        }
      }
      if (intent.kind === 'read') {
        memory.rememberRead(reply, turn);
        if (reply.turn?.kind === 'read' && intent.recordKind === 'menu' && intent.querySlot && !turn.browse) {
          const query = slots[intent.querySlot];
          const search = evidence.find(record => record.tool === 'search_records');
          if (typeof query === 'string' && search) {
            const reader = domains.reader('menu');
            memory.rememberMenus(search.matches.flatMap(({ handle, match, label, fields }) => {
              if (match !== 'exact' || !label || fields?.kind === 'retail') return [];
              const id = reader?.resolve?.({ snapshot, locale, query, privateLookup: false, querySlot: intent.querySlot }, handle);
              return id ? [{ id, name: label }] : [];
            }));
          }
        }
      }
      return reply;
    });
  }

  /** A write too broad for one card, or one that contradicts itself, becomes a clarify-only request: the server asks, nothing is previewed. */
  function clarifyOnlyTurn(text: string, snapshot: DataSnapshot, locale: Locale): DomainTurnInput | undefined {
    const bulk = readNavisBulkRequest(text);
    if (bulk?.scope === 'menu') return { intent: { kind: 'command', command: 'menu.setSaleStatus', clarify: 'menuId' } };
    if (bulk?.scope === 'ledger-candidates') return { intent: { kind: 'command', command: 'ledger.confirmCandidate', clarify: 'expenseId' } };
    if (!readNavisContradiction(text)) return undefined;
    const name = /^(.+?)\s*(?:을|를|은|는)?\s*품절/u.exec(text)?.[1]?.trim();
    if (!name || !projectAgentSearch(domains, snapshot, { kind: 'menu', querySlot: 'name' }, name, locale, true, 'menu.setSaleStatus').matches.length) return undefined;
    return { intent: { kind: 'command', command: 'menu.setSaleStatus', clarify: 'status', querySlot: 'name' }, slots: { name },
      lookups: [{ kind: 'menu', querySlot: 'name' }] };
  }

  // ---- Ordered plans (B23). One runner per chat; it decides every step transition from terminals and card receipts. ----

  /** A bare comma or a list ("마진, 캘린더 치워") is one request; a plan needs a word that sequences: …하고, 그리고, ;, or a read list asked together. */
  const SEQUENCING = /(?:고|그리고|;|\band then\b)\s|(?:같이|한꺼번에|모두|전부|다)\s*(?:알려|보여)/u;
  /** The one comma form that is a plan: each part is, on its own, an instruction to change something ("아메리카노는 품절, 카페라테는 5,500원으로 바꿔줘"). */
  const WRITE_CLAUSE = /품절|가격|판매가|원으로|바꿔|올려|내려|추가|삭제|지워|취소|처리|보내|발송|등록/u;
  const isSequenced = (text: string) => {
    const bare = text.replace(/["“'‘][^"”'’]*["”'’]/gu, ' ');
    if (SEQUENCING.test(bare)) return true;
    const parts = bare.split(/,\s+/u).map(part => part.trim()).filter(Boolean);
    return parts.length >= 2 && parts.every(part => WRITE_CLAUSE.test(part));
  };

  function planSequence(input: AskInput, text: string, snapshot: DataSnapshot): Sequence | undefined {
    const { runId } = snapshot, { locale = 'ko' } = input;
    if (!runId || !isSequenced(text)) return undefined;
    const business = snapshot.pos?.businessDate ?? TODAY;
    const result = domains.classifyMulti({ planId: crypto.randomUUID(), runId }, text, clause => {
      const read = plainReadQuery(clause, business, stockDate(snapshot));
      const routed: DomainRoute | undefined = read && !read.unsupported
        ? { intent: read.intent, factKeys: read.factKeys, narrow: read.narrow, readParts: read.parts, compare: read.compare }
        : domains.route(clause, snapshot, locale, matchWidget(navisDirective(clause)), run?.getState());
      if (!routed || !('intent' in routed)) return undefined;
      const turn = routed.intent.kind === 'read' ? orderedRead(routed, stockDate(snapshot)) : routed;
      const { intent } = turn;
      // A step is a read, or a write the owner presses a card for. Navigation, layout and the other kinds keep their own single-turn paths.
      if (intent.kind === 'read' || intent.kind === 'command' && !isAgentNavigationCommand(intent.command)
        && agentCommandPolicy(intent.command, intent.args).policy === 'propose') return { kind: 'step' as const, intent, local: turn };
      return undefined;
    });
    if (result?.kind !== 'plan') return undefined;
    const { plan, localByStep } = result.value;
    return { runner: startMultiStepPlan(plan), locals: localByStep, input, total: plan.steps.length,
      kept: plan.steps.some(step => step.intent.kind === 'command') };
  }

  const stepNumber = (stepId: string) => Number(/\d+$/u.exec(stepId)?.[0] ?? 0);
  const withProgress = (reply: AssistantReply, stepId: string, total: number): AssistantReply => {
    const mark = `${stepNumber(stepId)}/${total}`;
    return { ...reply, answer: reply.answer ? `${mark} ${reply.answer}` : mark };
  };

  async function runStep(seq: Sequence, first: boolean): Promise<AssistantReply | undefined> {
    const state = seq.runner.getState();
    if (state.phase !== 'ready') return undefined;
    const { step } = state;
    const local = seq.locals.get(step.id);
    if (!local) { seq.runner.cancelStep(step.id); return undefined; }
    let attempt: MultiStepAttempt | undefined;
    let terminal: { readonly done: AgentDone; readonly proposal?: AgentFrameData['action_proposal'] } | undefined;
    // The first step answers the owner's own ask; the later ones are follow-ups with no stream callbacks of that ask.
    const input: AskInput = first ? seq.input : { ...seq.input, onStatus: undefined, onFirstText: undefined, onTransportAck: undefined, onTextDelta: undefined };
    const reply = await runAgentTurn(input, local, {
      project(body) { attempt = seq.runner.projectNext(() => ({ kind: 'request', request: body }))?.attempt; return attempt !== undefined; },
      onTerminal(done, proposal) { terminal = { done, proposal }; },
    });
    if (!attempt) {
      // The turn ended before a request left: a refusal, a handoff or a question. The runner learns it as such.
      const kind = reply.turn?.kind === 'refusal' ? 'refused' as const : reply.turn?.kind === 'handoff' ? 'handoff' as const
        : reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? 'clarify' as const : 'unavailable' as const;
      seq.runner.projectNext(() => ({ kind }));
      return withProgress(reply, step.id, seq.total);
    }
    if (terminal) seq.runner.recordTurn(attempt, terminal.done, terminal.proposal);
    else seq.runner.recordTurn(attempt, { code: 'UNAVAILABLE' });
    if (reply.proposalSession && reply.turn?.kind === 'proposal') {
      const card = reply.turn.proposal;
      const bound = seq.runner.bindCard(attempt, { id: card.id, command: card.command as never, snapshotRevision: card.snapshotRevision, tier: card.tier });
      if (bound) watchCard(seq, attempt, reply.proposalSession, card.id);
      else if (sequence === seq) sequence = undefined;
    }
    return withProgress(reply, step.id, seq.total);
  }

  /** The next step starts only from the actual receipt of the card bound to this step. */
  function watchCard(seq: Sequence, attempt: MultiStepAttempt, session: ProposalSession, cardId: string) {
    let seen: unknown;
    let refreshed = false;
    const stop = session.subscribe(() => {
      const state = session.getSnapshot();
      if (sequence !== seq || state.closed) { stop(); return; }
      if (state.proposal.id !== cardId && !refreshed) {
        // A stale card was refreshed for the owner. This step ends as a conflict; the fresh card stays, outside the plan.
        refreshed = true;
        stop();
        if (seq.runner.recordCard(attempt, { frame: { proposalId: cardId, outcome: 'conflict' } })) {
          const waiting = seq.runner.getState();
          if (waiting.phase === 'awaiting_input') seq.runner.cancelStep(waiting.step.id);
          void continueSequence(seq);
        }
        return;
      }
      const receipt = state.feedback;
      // A real press that is still on its way has no outcome to record yet; its authoritative receipt arrives as the next feedback.
      if (!receipt || receipt === seen || receipt.pending) return;
      seen = receipt;
      if (!seq.runner.recordCard(attempt, receipt, receipt.frame.outcome === 'applied' && Boolean(receipt.undoToken))) return;
      if (seq.runner.getState().phase === 'awaiting_card') return; // the extra confirmation was acknowledged, or the card is busy
      stop();
      void continueSequence(seq);
    });
  }

  async function advanceSequence(seq: Sequence, first: boolean): Promise<AssistantReply | undefined> {
    const replies: AssistantReply[] = [];
    for (;;) {
      if (seq.kept && sequence !== seq) break;
      const { phase } = seq.runner.getState();
      if (phase === 'complete') break;
      if (phase !== 'ready') break;
      const reply = await runStep(seq, first && replies.length === 0);
      if (!reply) break;
      replies.push(reply);
      // A read or a refusal has finished its step; a card or a question waits for the owner.
      if (seq.runner.getState().phase !== 'ready') break;
    }
    if (seq.runner.getState().phase === 'complete' && sequence === seq) sequence = undefined;
    if (replies.length < 2) return replies[0];
    const last = replies[replies.length - 1];
    const reads = replies.every(reply => reply.turn?.kind === 'read');
    return { ...last, answer: replies.map(reply => reply.answer).filter(Boolean).join('\n'), panels: replies.flatMap(reply => reply.panels),
      ...(reads ? { turn: { kind: 'read' as const, evidence: replies.flatMap(reply => reply.turn?.kind === 'read' ? reply.turn.evidence : []) } } : {}) };
  }

  async function continueSequence(seq: Sequence) {
    try {
      const reply = await advanceSequence(seq, false);
      if (reply && (!seq.kept || sequence === seq || seq.runner.getState().phase === 'complete')) seq.input.onFollowUp?.(reply);
    } catch {
      // The conversation moved on or closed while a step was in flight: nothing more is offered.
      if (sequence === seq) sequence = undefined;
    }
  }

  async function startSequence(seq: Sequence): Promise<AssistantReply> {
    if (seq.kept) { replacePending(); sequence = seq; }
    const reply = await advanceSequence(seq, true);
    return reply ?? localReply(seq.input, 'manualWidget');
  }

  function localReply(input: AskInput, key: string, params?: Readonly<Record<string, string | number>>): AssistantReply {
    const locale = input.locale ?? 'ko';
    return { ...agentReply(locale), answer: navisTranslator(locale).t(`common.navis.agent.${key}`, params) };
  }

  function clarificationReply(input: AskInput, key: string, field: string, choices: readonly AgentSuggestion[] = []): AssistantReply {
    const id = crypto.randomUUID();
    return { ...localReply(input, key, choices.length ? { names: choices.map(choice => [choice.label, choice.detail].filter(Boolean).join(' ')).join(' / ') } : undefined),
      turn: { kind: 'clarification', id, field, choices: [], isCurrent: () => false } };
  }

  function previousWeekChange(snapshot: DataSnapshot): string | undefined {
    const reads = [memory.lastRead(), memory.previousRead()];
    const net = (phrase: string) => {
      const expected = coveredWeekSales(phrase, snapshot.tables.realFinance)?.intent;
      if (expected?.kind !== 'read' || !expected.condition) return;
      const target = conditionKey(expected.condition);
      const evidence = reads.flatMap(read => read?.reply.turn?.kind === 'read' ? read.reply.turn.evidence : [])
        .find(read => read.tool === 'get_widget' && read.args.featureId === 'ledger' && conditionKey(read.args.condition) === target);
      return evidence && 'facts' in evidence ? evidence.facts.find(fact => fact.key === 'ledger.sales.net')?.value : undefined;
    };
    const current = net('이번 주 매출'), last = net('지난주 매출');
    if (typeof current !== 'number' || typeof last !== 'number') return;
    if (current === last) return '이번 주와 지난주 매출이 같아요.';
    const difference = navisTranslator('ko').format.money(Math.abs(current - last), 'full');
    return `이번 주 매출이 지난주보다 ${difference} ${current > last ? '더 많아요' : '더 적어요'}.`;
  }

  function referencedPrice(input: AskInput, snapshot: DataSnapshot, text: string): Promise<AssistantReply> {
    const locale = input.locale ?? 'ko';
    const target = { kind: 'menu', querySlot: 'name' } as const;
    const reader = domains.reader('menu');
    const lookup = (name: string) => {
      const exact = projectAgentSearch(domains, snapshot, target, name, locale).matches.filter(match => match.match === 'exact');
      return exact.length === 1 && exact[0].fields?.kind !== 'retail' ? exact[0] : undefined;
    };
    const withMenu = (name: string, price: number): DomainRoute => {
      const request = text.replace(/^(?:아까\s*)?(?:그\s*(?:거|메뉴)|말한\s*메뉴)/u, name);
      const route = domains.route(request, snapshot, locale, 'menu', run?.getState());
      if (route && !('intent' in route) && route.kind === 'clarification' && route.field === 'price') {
        const tr = navisTranslator('ko');
        return { ...route, answer: tr.t('navis.referencedMenuPrice', { name, price: tr.format.money(price, 'full') }) };
      }
      return route ?? { kind: 'refusal', reason: 'unsupported' };
    };
    const matches = memory.recentMenus().flatMap(([id, name]) => {
      const match = lookup(name);
      return match && reader?.resolve?.({ snapshot, locale, query: name, privateLookup: false, querySlot: 'name' }, match.handle) === id ? [match] : [];
    });
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match?.label && match.price !== undefined) return applyDomainRoute(input, snapshot, withMenu(match.label, match.price));
    return applyDomainRoute(input, snapshot, {
      kind: 'clarification', field: 'name', answer: navisTranslator('ko').t('common.navis.agent.chooseMenu'),
      resume(name) {
        const selected = lookup(name);
        return selected?.label && selected.price !== undefined ? withMenu(selected.label, selected.price) : undefined;
      },
    });
  }

  function undoInstruction(input: AskInput, command?: string, target?: string): AssistantReply {
    const last = undo?.runId === store.getSnapshot().runId ? undo : undefined;
    if (command && (last?.command !== command || target && !last.label.includes(target))) {
      return localReply(input, 'nothingToUndo');
    }
    const expired = () => ({ ...agentReply('ko'), answer: navisTranslator('ko').t('navis.undoExpired') });
    if (!run) return !last ? localReply(input, 'nothingToUndo')
      : clock() < last.expiresAt ? localReply(input, 'boardUndoTarget') : expired();

    const previousNotice = selectCommonNotice(run.getState());
    run.actions.tick();
    const state = run.getState();
    const notice = selectCommonNotice(state);
    if (notice?.undo && notice.remainingMs > 0 && (!command || notice.undo.token === last?.token)) {
      if (notice.chatReceipt) return {
        ...agentReply('ko'),
        answer: navisTranslator('ko').t(selectChatReceiptNotice(state) ? 'navis.undoReceipt' : 'common.navis.agent.boardUndoTarget'),
      };
      return localReply(input, 'boardUndoTarget');
    }
    if (last && (clock() >= last.expiresAt || previousNotice?.undo?.token === last.token && !notice)) return expired();
    if (!command && state.undo && !state.undo.consumed && state.notice?.undoToken === state.undo.token) return localReply(input, 'boardUndoTarget');
    return localReply(input, 'nothingToUndo');
  }

  function localAction(input: AskInput, control: NonNullable<ReturnType<typeof readConversationControl>>): AssistantReply | Promise<AssistantReply> {
    const session = proposal?.isPending() ? proposal : undefined;
    const clarification = pending?.isCurrent() ? pending : undefined;
    // F17: a card press is on its way to the server. Typed words neither confirm nor cancel it; the receipt is the only answer.
    if (!session && proposal?.getSnapshot().feedback?.pending
      && (control.kind === 'confirm' || control.kind === 'cancel' || control.kind === 'cancel-last' || control.kind === 'edit' || control.kind === 'hold')) {
      return localReply(input, 'busy');
    }
    switch (control.kind) {
      case 'confirm':
        if (session) return localReply(input, session.getSnapshot().edit ? 'finishProposalEdit' : 'confirmOnCard');
        return clarification ? localReply(input, clarification.field === 'price' ? 'priceQuestion' : 'pendingValue') : clarificationReply(input, 'nothingToConfirm', 'action');
      case 'cancel':
      case 'cancel-last': {
        if (session) {
          const receipt = session.cancel();
          return { ...agentReply(input.locale ?? 'ko'), localAction: receipt?.frame };
        }
        if (clarification) {
          replacePending();
          return localReply(input, 'cancelled');
        }
        return control.kind === 'cancel-last' ? undoInstruction(input) : localReply(input, 'nothingToConfirm');
      }
      case 'edit':
        if (session?.edit(control.field, control.price)) return agentReply(input.locale ?? 'ko');
        if (clarification?.field === 'price' && control.price !== undefined) {
          return clarification.resume({ clarificationId: clarification.id, price: control.price }, input) ?? localReply(input, 'priceQuestion');
        }
        return clarificationReply(input, 'nothingToEdit', 'action');
      case 'retarget':
        if (session) replacePending();
        if (control.query) return runAgentTurn(input, { intent: { kind: 'read', recordKind: 'menu', querySlot: 'name' }, slots: { name: control.query } });
        return clarificationReply(input, 'chooseMenu', 'name');
      case 'undo': return undoInstruction(input, control.command, control.target);
      case 'hold': return localReply(input, session ? 'stillPending' : 'pendingValue');
      case 'repeat-answer': {
        const remembered = memory.lastRead();
        if (remembered?.turn) return runAgentTurn(input, remembered.turn);
        if (remembered) return { ...agentReply(input.locale ?? 'ko'), answer: remembered.reply.answer, panels: remembered.reply.panels };
        return localReply(input, 'noPreviousTurn');
      }
      case 'repeat-command': {
        if (session || clarification) return localReply(input, session ? 'stillPending' : 'pendingValue');
        const last = memory.confirmed();
        if (last?.menu) {
          replacePending();
          return menuClarification(input, { category: last.menu.category, price: last.menu.price }, 'name');
        }
        return last ? clarificationReply(input, 'repeatTarget', 'name') : localReply(input, 'noPreviousTurn');
      }
    }
  }

  /** The model's read-only intent plan as a browser route, or undefined (D-371). Never throws: any failure keeps the router's own answer. */
  async function planRouteFor(input: AskInput): Promise<DomainRoute | undefined> {
    const { text, locale = 'ko', layer = 'management', signal } = input;
    if (!classifyEnabled || input.agentTurn || (layer !== 'management' && layer !== 'marketing')) return undefined;
    const snapshot = store.getSnapshot();
    const last = memory.lastRead()?.turn;
    const features = last?.intent.kind === 'read'
      ? [last.intent.featureId, ...(last.intent.reads ?? []).map(read => (read.args as { featureId?: string } | undefined)?.featureId)].filter((id): id is string => !!id) : [];
    const previousSentence = turnPrevious;
    const previous = previousSentence ? `${previousSentence}${features.length ? ` → ${[...new Set(features)].join(',')}` : ''}` : undefined;
    try {
      const plan = await requestIntentPlan({ fetcher, snapshot, locale, layer, text, previous, signal });
      cancelled(signal);
      const lastReads = last?.intent.kind === 'read'
        ? [...(last.intent.featureId ? [{ featureId: last.intent.featureId, condition: last.intent.condition ?? { kind: 'default' as const } }] : []),
          ...(last.intent.reads ?? []).flatMap(read => { const args = read.args as { featureId?: string; condition?: QueryCondition } | undefined; return args?.featureId && args.condition ? [{ featureId: args.featureId, condition: args.condition }] : []; })] : [];
      return plan ? planToRoute(plan, snapshot, locale, lastReads) : undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  /** A sentence the browser routers could not place: the model's plan, answered through the normal typed read (D-371). */
  async function classifiedReply(input: AskInput, snapshot: DataSnapshot): Promise<AssistantReply | undefined> {
    classifiedInputs.add(input);
    const route = await planRouteFor(input);
    return route ? applyDomainRoute(input, snapshot, route) : undefined;
  }

  const classifiedInputs = new WeakSet<AskInput>();
  let turnPrevious: string | undefined;
  /** Words that mark a question a fixed read tends to get wrong: comparisons, ratios, trends, reasons, superlatives, slang and typos. */
  const CONTESTED_WORDS = /비교|추이|흐름|퍼센트|비율|[%％]|몇\s*주|주별|월별|요일별|더\s*(?:많|적|비싸|싸)|가장\s*(?:많|적)|제일\s*(?:많이|적게|한가|바쁜|붐|비싼|싼)|늘었|줄었|왜\s|이유|원인|차이|합치면|빼면|그\s*중|아아|뜨아|알바|췩소|매츨|재곱|점심|저녁|하나\s*팔면|남아\?/u;
  const CURATED_COMPARISON = /같은\s*요일|전주\s*동요일|둘\s*차이|그럼\s*(?:이번|지난|저번)/u;
  const contestedRead = (input: AskInput, requested: DomainTurnInput): boolean =>
    classifyEnabled && !input.agentTurn && !input.continuation && !classifiedInputs.has(input) && requested.intent.kind === 'read'
    && CONTESTED_WORDS.test(input.text) && !CURATED_COMPARISON.test(input.text);
  /** Dead-end answers of the routers ("cannot show that period", "do that in the widget"): the model's plan may place the sentence instead. */
  const DEAD_END = /^(?:이 기간(?:은 앱에서 확인할 수 없|의 자료는 제공되지 않)|쿠폰 현황 패널에서 바꿀 수 있는|이 작업은 해당 기능 화면에서|요청에 맞는 답변 대기 항목이 없|등록된 품목이 없|카메라 5분 집계)/u;

  return {
    discardAgentTurn,
    preloadFacts,
    async ask(typed: AskInput): Promise<AssistantReply> {
      // A bare "그럼 지난주는?" or "카페라떼는?" becomes the full question it stands for, from what was just asked.
      const repaired = repairColloquial(typed.text);
      const followed = typed.agentTurn || typed.continuation ? undefined : periodFollowUp(repaired, memory.lastRead()?.turn) ?? menuPriceFollowUp(repaired, menuTrail);
      const asked = followed ?? repaired;
      if (!typed.agentTurn && !typed.continuation) rememberMenuPriceQuestion(asked, menuTrail);
      if (!typed.agentTurn && !typed.continuation) { turnPrevious = lastSentence; lastSentence = asked; }
      const input: AskInput = asked === typed.text ? typed : { ...typed, text: asked };
      const { text, history, signal, simpleSignal, onTextDelta, onTransportAck, onFirstText, locale = 'ko', layer = 'management', continuation } = input;
      cancelled(signal);
      // Real-port domains are read before this question looks at the snapshot (a fixture store skips this and stays synchronous).
      if (httpDomains().length) {
        await preloadFacts();
        cancelled(signal);
      }
      const snapshot = store.getSnapshot();
      if (memory.scope(snapshot.runId)) { discardAgentTurn(); undo = undefined; }
      const hostLayer = run?.getState().layer ?? layer;
      if (scope !== undefined && scope !== hostLayer) discardAgentTurn();
      scope = hostLayer;
      activeAgent?.abort();
      const prior = pending?.isCurrent() ? pending : undefined;
      if (continuation) {
        const conflict = localReply(input, 'conflict');
        return prior?.id === continuation.clarificationId ? prior.resume(continuation, input) ?? conflict : conflict;
      }
      const prepared = prepareConversationText(text);
      if (prepared.kind === 'tooLong') return { ...localReply(input, prepared.kind), turn: { kind: 'refusal', reason: 'input_limit' } };
      // The directive is classified before any widget, layout, continuation or menu-draft match (B26 policy).
      const directive = prepared.kind === 'text' ? classifyNavisDirective(prepared.text) : undefined;
      if (directive?.kind === 'refusal') {
        const legacy = navisTranslator('ko').t(directive.cause === 'externalLink' ? 'navis.externalLink' : 'navis.outOfScope');
        const alternative = directive.alternative && 'command' in directive.alternative
          ? { featureId: directive.alternative.featureId, command: directive.alternative.command, draft: directive.alternative.draft }
          : directive.alternative;
        return { ...agentReply(locale), answer: directive.answer ?? legacy,
          ...(directive.reason === 'out_of_scope' ? { outOfScope: true } : {}),
          turn: { kind: 'refusal', reason: directive.reason, ...(alternative ? { alternative } : {}) } };
      }
      const control = readConversationControl(text, proposal?.isPending());
      if (!input.agentTurn && (control?.kind === 'undo' || control?.kind === 'cancel-last'
        || control?.kind === 'confirm' && (!control.named || proposal?.isPending()))) {
        return localAction(input, control);
      }
      if (!input.agentTurn && prepared.kind === 'text') {
        const widget = classifyWidgetHandoff(prepared.text, snapshot);
        const feature = widget?.featureId;
        if (widget && feature && isDataWidgetId(feature) && store.real?.mode(WIDGET_DOMAIN[feature]) === 'http') {
          if (widget.step !== 'local-search-links' && (widget.step !== 'sms-status' || /취소|삭제/u.test(navisDirective(prepared.text)))) replacePending();
          return refusedReply(agentReply(locale), 'widget_only', widget);
        }
      }
      if (!input.agentTurn && prepared.kind === 'text') {
        const menuText = menuRequestText(text);
        const menuAnswer = menuAddAnswer(prepared.text, locale);
        if (menuAnswer) return { ...agentReply(locale), answer: menuAnswer };
        if (isMenuCreateRequest(menuText)) {
          replacePending();
          if (hostLayer === 'orders-payment') return localReply(input, 'manualRoute');
          return askMenu(input, parseMenuCreateInput(menuText));
        }
        if (referencesMenuPrice(prepared.text)) return referencedPrice(input, snapshot, prepared.text);
      }
      if (directive?.kind === 'answer' && !input.agentTurn) {
        // The typed read still runs (the reply widget's status); the fixed explanation replaces the raw rows in the answer.
        const read = await runAgentTurn(input, { intent: directive.intent });
        return { ...read, answer: directive.answer };
      }
      const clarifying = !input.agentTurn && prepared.kind === 'text' && hostLayer !== 'orders-payment' ? clarifyOnlyTurn(prepared.text, snapshot, locale) : undefined;
      if (clarifying) { replacePending(); return runAgentTurn(input, clarifying); }
      const week = !input.agentTurn && prepared.kind === 'text' ? coveredWeekSales(prepared.text, snapshot.tables.realFinance) : undefined;
      if (week) return runAgentTurn(input, week);
      const plainRead = !input.agentTurn && prepared.kind === 'text' ? plainReadQuery(prepared.text, snapshot.pos?.businessDate ?? TODAY, stockDate(snapshot)) : undefined;
      // The period list in an unsupported-period answer is Korean; other languages keep the localized no-data notice.
      const plain = plainRead?.unsupported?.answer && locale !== 'ko' ? undefined : plainRead;
      if (plain?.unsupported && classifyEnabled && !classifiedInputs.has(input) && !input.agentTurn) {
        // D-371: the fixed read cannot show that period; the model's plan may name a read that can.
        const planned = await classifiedReply(input, snapshot);
        if (planned) return planned;
        cancelled(signal);
      }
      if (plain?.unsupported) {
        const { featureId, condition } = plain.unsupported;
        return { ...agentReply(locale), answer: plain.unsupported.answer ?? PLAIN_READ_UNSUPPORTED,
          turn: { kind: 'read', evidence: [{ tool: 'get_widget', args: { featureId, condition }, status: 'unsupported_period', facts: [] }] } };
      }
      if (plain) return runAgentTurn(input, { intent: plain.intent, factKeys: plain.factKeys, narrow: plain.narrow, readParts: plain.parts, compare: plain.compare });
      // An ordered plan (B23): every clause becomes a read or a card-confirmed write, run one after another.
      const planned = !input.agentTurn && prepared.kind === 'text' ? planSequence(input, text.trim(), snapshot) : undefined;
      if (planned) return startSequence(planned);
      const matchedWidget = prepared.kind === 'text' ? matchWidget(navisDirective(prepared.text)) : undefined;
      if (!input.agentTurn && unreadableWidget(store, matchedWidget)) {
        return refusedReply(agentReply(locale), 'unavailable');
      }
      const domainRoute = !input.agentTurn && prepared.kind === 'text'
        ? domains.route(text.trim(), snapshot, locale, matchedWidget, run?.getState()) : undefined;
      if (domainRoute) return applyDomainRoute(input, snapshot, domainRoute);
      if (!input.agentTurn && prepared.kind === 'text' && navisPayloadPrefix(prepared.text)) return localReply(input, 'manualWidget');
      if (control && !input.agentTurn) return localAction(input, control);
      if (prior?.field === 'price' && prepared.kind === 'unclear') {
        const price = conversationPrice(text);
        if (price !== undefined) return prior.resume({ clarificationId: prior.id, price }, input) ?? localReply(input, 'priceQuestion');
      }
      if (prepared.kind !== 'text') return { ...localReply(input, prepared.kind),
        ...(prepared.kind === 'automation' ? { turn: { kind: 'refusal' as const, reason: 'unsupported' } } : {}) };

      const value = prepared.text;
      const agent = input.agentTurn ?? commandTurn(value, snapshot.pos?.businessDate ?? TODAY);
      if (agent) {
        if (agent.intent.kind !== 'read' && !(agent.intent.kind === 'command' && isAgentNavigationCommand(agent.intent.command))) replacePending();
        if (hostLayer === 'orders-payment' && agent.intent.kind === 'command' && !isAgentNavigationCommand(agent.intent.command)
          && agentCommandPolicy(agent.intent.command, agent.intent.args).policy === 'propose') return localReply(input, 'manualWidget');
        return runAgentTurn(input, agent);
      }
      if (followupBoardQuestion(value)) return clarificationReply(input, 'chooseWidget', 'feature');
      if (/(?:위젯|패널).*(?:되돌려|취소)|(?:방금|아까).*(?:위젯|패널).*빼/u.test(value)) {
        return localReply(input, run?.getState().undo ? 'boardUndoTarget' : 'boardEditTarget');
      }
      if (/(?:다크 모드|큰 글자|언어).*(?:되돌려|취소|원래대로)/u.test(value)) return clarificationReply(input, 'settingsUndo', 'setting');
      if (/^(?:(?:아까\s*)?(?:그|저)\s*(?:거|메뉴))\s*(?:(?:가격|판매가)(?:은|는|을)?(?:\s*알려\s*(?:줘|주세요))?|얼마(?:야|예요)?)[.?!。？！]*$/u.test(value)) {
        const choices = memory.records(snapshot);
        if (choices.length !== 1) return clarificationReply(input, choices.length ? 'chooseNamedMenu' : 'chooseMenu', 'name', choices);
        return runAgentTurn(input, { intent: { kind: 'read', recordKind: 'menu', querySlot: 'name' }, slots: { name: choices[0].label } });
      }
      const read = menuReadTurn(value);
      if (read) {
        const intent = read.intent;
        const querySlot = intent.kind === 'read' ? intent.querySlot : undefined;
        const query = querySlot ? read.slots?.[querySlot] : undefined;
        if (typeof query !== 'string' || projectAgentSearch(domains, snapshot, { kind: 'menu', querySlot: 'name' }, query, locale).matches.length || /가격/u.test(value)) {
          return runAgentTurn(input, read);
        }
      }
      const status = widgetStatusRead(value, snapshot.pos?.businessDate ?? TODAY);
      if (status) return runAgentTurn(input, status);
      const lastRead = memory.lastRead()?.turn;
      // "둘 차이가 얼마야?" after a read that did not leave two comparable values: ask which two to compare instead of guessing.
      if (memory.lastRead() && /^(?:그럼\s*|그러면\s*)?(?:둘|두\s*(?:개|값|기간)|서로|이거\s*랑\s*저거)(?:의|\s*사이)?\s*(?:차이|비교)(?:가|는|을|를)?\s*(?:얼마(?:야|예요)?|어때|알려\s*(?:줘|주세요)|해\s*줘)?[?？]?$/u.test(value)) {
        return { ...agentReply(locale), answer: previousWeekChange(snapshot) ?? '어떤 두 값을 비교할까요? 예를 들어 "어제랑 오늘 매출 비교해줘"처럼 말씀해 주세요.' };
      }
      if (lastRead?.intent.kind === 'read' && lastRead.intent.featureId === 'ledger' && /^(?:그럼\s*)?(?:어제(?:는|\s*매출은)?|昨天呢)(?:\s*얼마였어)?[?？]?$/.test(value)) {
        const date = addDays(snapshot.pos?.businessDate ?? TODAY, -1);
        return runAgentTurn(input, { intent: { kind: 'read', featureId: 'ledger', condition: { kind: 'dateRange', start: date, end: date } }, factKeys: ['ledger.sales.net'] });
      }
      const ledger = salesRead(value);
      if (ledger && !simpleSignal?.aborted && (proposal?.isPending() || prior || layer === 'management' && locale !== 'ko'
        || /벌었수꽈|얼마우꽈|됐드래|^(?:어 |음 |저기요 )|^(?:how|what|show)|^今天|^매출 매출/iu.test(value))) {
        return runAgentTurn(input, { intent: { kind: 'read', featureId: ledger, condition: { kind: 'default' } }, factKeys: ['ledger.sales.net'] });
      }
      const stock = /(?:재고는\s*어때|재고 부족한 거 알려줘)/u.test(value);
      if (stock || lastRead?.intent.kind === 'read' && lastRead.intent.featureId === 'inventory-booking' && /^(?:더 있어|다른 건|또 뭐 있어|나머지는)[?？]?$/u.test(value)) {
        return runAgentTurn(input, { intent: { kind: 'read', featureId: 'inventory-booking', condition: { kind: 'snapshot', asOf: stockDate(snapshot) } } });
      }
      if (prior) {
        const ordinal = readOrdinal(value);
        const choice = ordinal !== undefined ? prior.choices?.[ordinal]
          : prior.choices?.find(item => item.label === value && item.id !== 'manual');
        const renamed = /^(?:아\s+|아니\s+|이름\s*틀렸어\s+)(.+?)(?:로\s*해\s*줘|(?:이)?야)$/u.exec(value)?.[1];
        if (renamed && prior.rename) {
          const name = readMenuName(renamed);
          if (name) return prior.rename(name, input);
        }
        if (choice) return prior.resume({ clarificationId: prior.id, choiceId: choice.id }, input) ?? localReply(input, 'pendingValue');
        if (prior.field === 'price') {
          const price = conversationPrice(value);
          if (price !== undefined) return prior.resume({ clarificationId: prior.id, price }, input) ?? localReply(input, 'priceQuestion');
          if (/^(?:공짜|몰라|ᄆᄅ|얼마가\s*좋을까)[?？]?$/u.test(value)) return localReply(input, 'priceQuestion');
        } else if (!/[?？]|(?:알려|보여|몇|얼마|언제|어떻게|어때|무엇|어느|있어|없어|저장해|삭제해)/u.test(value)) {
          const resumed = prior.resume({ clarificationId: prior.id, value }, input);
          if (resumed) return resumed;
        }
      }
      if (/(?:그|저)\s*(?:거|메뉴).*(?:품절|가격)|아까\s*(?:말한|그).*메뉴.*가격/u.test(value)) {
        const choices = memory.records(snapshot);
        return clarificationReply(input, choices.length ? 'chooseNamedMenu' : 'chooseMenu', 'name', choices);
      }
      if (/(?:품절|가격).*(?:바꿔|처리|해줘|으로)|^(?:ᄋᄆᄅᄏᄂ|ᄏᄑᄅᄐ|ᄇᄂᄅᄅᄐ|아아|뜨아).*(?:품절|ᄑᄌ)/u.test(value)) {
        const alias = /^(?:아아|뜨아|아이스 아메리카노|ᄋᄆᄅᄏᄂ)/u.test(value) ? '아메리카노'
          : /^(?:ᄏᄑᄅᄐ)/u.test(value) ? '카페라테' : /^ᄇᄂᄅᄅᄐ/u.test(value) ? '바닐라라테' : undefined;
        if (alias) {
          const resolved = await runAgentTurn(input, { intent: { kind: 'read', recordKind: 'menu', querySlot: 'name' }, slots: { name: alias } });
          if (resolved.turn?.kind === 'read' && memory.records(snapshot).length) return clarificationReply(input, 'chooseNamedMenu', 'name', memory.records(snapshot));
          return clarificationReply(input, 'chooseMenu', 'name');
        }
        replacePending();
        return localReply(input, 'manualWidget');
      }
      if (/^(?:아까\s*(?:그|우리|말한)|방금 전 대화|맨 처음에 물어본)/u.test(value)
        || /^(?:그거|그건|그 일은)\s*어떻게\s*(?:됐어(?:요)?|됐나요|되었나요)[.?!？]*$/u.test(value)) {
        return memory.lastRead() ? clarificationReply(input, 'repeatTarget', 'reference') : localReply(input, 'noPreviousTurn');
      }
      if (proposal?.isPending() || prior) {
        const readsLikeQuestion = /[?？]$|(?:알려|보여|얼마|어때|몇|어떻게|무엇|언제|있어|없어|매출|현황)/u.test(value);
        if (!readsLikeQuestion) return proposal?.isPending() ? localReply(input, 'stillPending')
          : { ...agentReply(locale), answer: copy.pendingQuestion };
      }

      cancelled(signal);
      // D-371: no browser router placed this sentence. A read-only plan from the model may still turn it into typed reads.
      if (classifyEnabled && !input.agentTurn && prepared.kind === 'text' && !simpleSignal?.aborted && (layer === 'management' || layer === 'marketing')) {
        const planned = await classifiedReply(input, snapshot);
        if (planned) return planned;
        cancelled(signal);
      }
      const fallback = (transportFailed = false): AssistantReply => {
        if (isDrawerQuestion(text)) {
          const facts = source.readSource?.('pos') ?? [], value = (key: string) => facts.find(f => f.key === key)?.value;
          const expected = value('pos.cash.expected'), difference = value('pos.cash.difference');
          const tr = navisTranslator('ko'), amount = (n: number) => tr.format.money(n, 'full');
          const diff = typeof difference !== 'number' ? tr.t('data.pos.drawer.unconfirmed') : difference === 0 ? tr.t('navis.drawer.equal')
            : tr.t(difference < 0 ? 'navis.drawer.short' : 'navis.drawer.over', { amount: amount(Math.abs(difference)) });
          return { mode: 'simple', answer: typeof expected === 'number' ? tr.t('navis.drawer.answer', { amount: amount(expected), difference: diff }) : tr.t('common.navis.noData'), panels: [], locale };
        }
        const reply = simpleReply({ text, locale, layer, source });
        if (transportFailed && reply.examples?.length) {
          return { answer: copy.requestFailed, panels: [], turn: { kind: 'refusal', reason: 'request_failed' } };
        }
        rememberLegacyRead(reply);
        return reply;
      };
      const rememberLegacyRead = (reply: AssistantReply) => {
        if (ledger && reply.panels.some(panel => panel.featureId === ledger)) memory.rememberRead({ ...reply, turn: { kind: 'read', evidence: [] } },
          { intent: { kind: 'read', featureId: ledger, condition: { kind: 'default' } } });
      };
      const candidates = (output: RawOutput): Candidate[] => {
        if (isPosQuestion(text) || isDrawerQuestion(text) || isDemandQuestion(text) && questionContext(text).topics.size === 0) return [];
        const found = validate(output, source, layer, signal);
        if (found.length || !output.answer.trim()) return found;
        const local = simpleReply({ text, locale, layer, source }).panels;
        if (local.length) return validate({ answer: output.answer, panels: [...local] }, source, layer, signal);
        const menu = matchWidget(text) === 'menu' && !has(norm(text), PAST_WORDS) && !/\d{4}[-./]\d/u.test(text);
        const topics = isDemandQuestion(text) ? [...questionContext(text).topics] : menu ? ['menu' as const] : [];
        const tr = navisTranslator(locale);
        const topicCards = topics.map(featureId => {
          const registration = getRegistration(featureId)!;
          return { featureId, condition: conditionsOf(featureId)[0], size: { width: 1, height: 1 }, reason: tr.t('navis.simple.reason', { name: tr.t(registration.nameKey) }) };
        });
        return validate({ answer: output.answer, panels: topicCards }, source, layer, signal);
      };
      if (simpleSignal?.aborted) return fallback();
      const controller = new AbortController();
      let answer = '', receivedPanels: unknown[] = [], firstTimer: ReturnType<typeof setTimeout> | undefined, totalTimer: ReturnType<typeof setTimeout> | undefined;
      let interrupt!: (reason: Error) => void;
      const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
      const abort = () => { controller.abort(); interrupt(new DOMException('Request stopped', 'AbortError')); };
      const simple = () => { interrupt(new SimpleRequested()); controller.abort(); };
      signal.addEventListener('abort', abort, { once: true });
      simpleSignal?.addEventListener('abort', simple, { once: true });
      try {
        const context = buildAssistantContext({ source, locale, text, layer });
        let omit = false;
        const legacyHistory = history?.filter(item => {
          if (item.role === 'user') omit = isMenuCreateRequest(item.text) || Boolean(commandTurn(item.text, TODAY)) || Boolean(readConversationControl(item.text));
          return !omit;
        });
        cancelled(signal);
        const timeout = () => { interrupt(new StreamDeadline()); controller.abort(); };
        firstTimer = setTimeout(timeout, 30000);
        totalTimer = setTimeout(timeout, options.timeoutMs ?? 60000);
        const request = fetcher('/api/navis/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ text, locale, layer, ...context, ...(legacyHistory?.length ? { history: legacyHistory } : {}) }), signal: controller.signal,
        }).catch(error => {
          // Fetch reports a network failure with TypeError. Keep adapter and parsing errors in the local fallback.
          if (error instanceof TypeError) throw new RequestFailed();
          throw error;
        }).then(async response => {
          if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); cancelled(controller.signal); }
          if (!response.ok) {
            // A live agent entry that has the free-text route switched off says so; that is a decline, not a failed request.
            const reason = await response.json?.().then((value: { route?: unknown }) => value?.route, () => undefined);
            if (response.status === 503 && reason === 'legacy_off') throw new LegacyRouteOff();
            throw new RequestFailed();
          }
          if (!response.body) return { answer: '', panels: [] };
          onTransportAck?.();
          return readReplyStream(response.body, controller.signal, delta => {
            cancelled(controller.signal);
            answer += delta;
            onTextDelta?.(delta);
          }, panels => { receivedPanels = panels; }, () => {
            clearTimeout(firstTimer);
            onFirstText?.();
          });
        });
        const output = await Promise.race([request, interrupted]);
        cancelled(signal);
        const hasAnswer = Boolean(output.answer.trim());
        const panels = candidates(output);
        if (!hasAnswer && panels.length === 0) return fallback();
        const replyText = hasAnswer ? output.answer : navisTranslator(locale).t('common.navis.noData');
        const reply = { answer: replyText, panels, locale };
        rememberLegacyRead(reply);
        return reply;
      } catch (error) {
        cancelled(signal);
        if (error instanceof OutOfScope) {
          const tr = navisTranslator(locale);
          return { answer: tr.t('navis.outOfScope'), examples: [1, 2, 5].map(n => tr.t(`navis.example.${n}`)), panels: [], outOfScope: true, locale };
        }
        if (answer.trim()) return { answer, panels: candidates({ answer, panels: receivedPanels }), locale };
        return fallback(error instanceof RequestFailed || error instanceof StreamDeadline);
      } finally {
        controller.abort();
        clearTimeout(firstTimer); clearTimeout(totalTimer);
        signal.removeEventListener('abort', abort);
        simpleSignal?.removeEventListener('abort', simple);
      }
    },
  };
}
