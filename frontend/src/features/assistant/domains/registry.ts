import type { DetailRef, FeatureId, Locale, NoticeRequest, QueryCondition, RunState, RunStore } from '../../../contracts';
import type { DataCommand, DataCommandResult } from '../../../data/commands/types';
import type { DataSnapshot } from '../../../data/db/types';
import type { WidgetDataStore } from '../../../data/widget-data';
import type { RealDomain, RealPort } from '../../../data/reality/00';
import {
  AGENT_COMMAND_CATALOG, agentCommandPolicy, type AgentExtraReadTool, type AgentFact, type AgentMissingStatus,
  type AgentKnownCommand, type AgentReadArgs, type AgentReadProjection, type AgentRecordKind, type AgentRecordMatch,
  type AgentRefusal, type AgentSourceId, type AgentWireArgs,
} from '../../../../shared/navis-agent-schema.mjs';
import type { AgentHandoff, AgentTurnInput } from '../types';
import type { SnapshotFact } from '../snapshot';
import { menuAgentDomain as menuDomain } from './menu';
import { suppliersDomain } from './suppliers';
import { inventoryDomain } from './inventory';
import { bookingDomain } from './booking';
import { customDomain, withCustomPickup } from './custom'; // N13
import { calendarStaffDomain } from './calendar-staff'; // N10
import { moneyDomain } from './money'; // N11
// N12 member and credit adapter.
import { promotionDomain } from './promotion'; // N18
import { membersDomain } from './members';
import { manualsGrantsDomain } from './manuals-grants'; // N14
import { noticesDomain } from './notices'; // N15
import { couponsDomain, withExpiryStock } from './coupons'; // N16, D-326 stock lookup
import { repliesDomain } from './replies'; // N17
import { localDomain } from './local'; // N20
import { operationsDomain } from './operations'; // N19
import { settingsDomain } from './settings';
import { layoutDomain } from './layout';
// N21 ordered plans have a separate entry point from the single-turn routers.
import { multiDomain, type classifyMultiRequest } from './multi';

export type ConfirmationTier = 'normal' | 'extra-confirm';
export type SlotValue = string | number | boolean;
export type LocalSlot = SlotValue | null | readonly LocalSlot[] | { readonly [key: string]: LocalSlot };
export type LocalSlots = Readonly<Partial<Record<string, LocalSlot>>>;
export interface ResolvedRecord { readonly kind: AgentRecordKind; readonly id: string }
export type RecordTargets = ReadonlyMap<string, ResolvedRecord>;
export type SlotSchema = Readonly<Record<string, (value: unknown) => boolean>>;

export interface CommandContext {
  readonly snapshot: DataSnapshot;
  readonly proposalId: string;
  readonly idempotencyKey: string;
}

export type Preflight<Preview, Command extends DataCommand> =
  | { readonly kind: 'ready'; readonly command: Command; readonly preview: Preview; readonly tier?: ConfirmationTier }
  | { readonly kind: 'invalid' | 'unchanged' | 'busy' | 'conflict'; readonly field?: string; readonly messageKey?: string };

/** An adapter resolves private slots into a typed draft, then uses app handlers for preflight. */
export interface CommandAdapter<Command extends DataCommand = DataCommand, Draft = unknown, Preview = unknown> {
  readonly command: Command['type'];
  readonly featureId: FeatureId;
  readonly slots: SlotSchema;
  resolve(args: unknown, slots: LocalSlots, snapshot: DataSnapshot, targets: RecordTargets): Draft | undefined;
  preflight(draft: Draft, context: CommandContext): Preflight<Preview, Command>;
  undoToken(result: Extract<DataCommandResult, { ok: true }>): string | undefined;
}

export interface ScheduledNoticeReceipt {
  isCancellable(): boolean;
  cancel(): boolean;
}

type CommandRejection = Exclude<Preflight<unknown, DataCommand>, { kind: 'ready' }>;
export type RunActionOutcome = CommandRejection
  | { readonly kind: 'applied'; readonly notice?: NoticeRequest; readonly undo?: (run: RunStore) => boolean; readonly scheduledNotice?: ScheduledNoticeReceipt };
export type RunPreflight<Preview> = CommandRejection | {
  readonly kind: 'ready';
  readonly preview: Preview;
  readonly tier?: ConfirmationTier;
  execute(run: RunStore, store?: WidgetDataStore): RunActionOutcome;
  /**
   * HTTP builds: the widget's own data command that the real port runs for this card. The card then stays pending until the service's
   * authoritative receipt (like a `CommandAdapter` card) and its undo is the receipt's, through the shared receipt path. `execute` stays the fixture path.
   */
  readonly realCommand?: DataCommand;
  readonly noticeKey?: string;
  afterCommit?(run: RunStore): void;
  /** A confirmed widget action that needs more than one authoritative command. */
  readonly realAction?: { readonly domain: RealDomain; readonly fingerprint: string;
    readonly bindings: readonly [DataCommand, ...DataCommand[]]; execute(store: WidgetDataStore): Promise<DataCommandResult> };
  readonly featureId?: FeatureId;
};

/** Prepare against the captured view. At execution, check the revision or fields the plan depends on. */
export interface RunCommandAdapter<Draft = unknown, Preview = unknown> {
  readonly command: AgentKnownCommand;
  readonly slots: SlotSchema;
  resolve(args: unknown, slots: LocalSlots, snapshot: DataSnapshot, targets: RecordTargets): Draft | undefined;
  preflight(draft: Draft, context: CommandContext & { readonly run: RunState; readonly deferLayoutNotice?: boolean }): RunPreflight<Preview>;
}

export interface RecordSearch {
  readonly snapshot: DataSnapshot;
  readonly locale: Locale;
  readonly query: string;
  readonly privateLookup: boolean;
  readonly command?: string;
  readonly querySlot?: string;
  /** Browser-local requested fact (B27: unitPrice, minimumQty, orderStep, leadDays, supplier, charge...). It never goes on the wire. */
  readonly aspect?: string;
}
export interface RecordAdapter {
  readonly kind: AgentRecordKind;
  readonly unavailable?: true;
  search(input: RecordSearch): readonly AgentRecordMatch[];
  resolve?(input: RecordSearch, handle: string): string | undefined;
  describe?(match: AgentRecordMatch, locale: Locale, input?: RecordSearch): string | undefined;
}

export interface ReadToolAdapter<Tool extends AgentExtraReadTool = AgentExtraReadTool> {
  readonly tool: Tool;
  read(snapshot: DataSnapshot, args: AgentReadArgs[Tool], locale: Locale, slots: LocalSlots, targets: RecordTargets, run?: RunState):
    { readonly facts: readonly AgentFact[] } | { readonly status: AgentMissingStatus };
}

export interface DomainAdapter {
  readonly commands: readonly CommandAdapter[];
  readonly runCommands?: readonly RunCommandAdapter[];
  readonly reads: readonly RecordAdapter[];
  readonly featureIds?: readonly FeatureId[];
  readonly tools?: readonly ReadToolAdapter[];
  readonly classifyMulti?: typeof classifyMultiRequest; // N21
  /** Domain-owned routing for requests that can be fulfilled inside chat before a widget handoff. */
  routeBeforeHandoff?(text: string, snapshot: DataSnapshot, locale: Locale, run?: RunState): DomainRoute | undefined;
  /** Explicit shell requests are resolved before widget-specific language. */
  routePresentation?(text: string, snapshot: DataSnapshot, locale: Locale, run?: RunState): DomainRoute | undefined;
  route?(text: string, snapshot: DataSnapshot, locale: Locale, run?: RunState): DomainRoute | undefined;
  projectWidget?(snapshot: DataSnapshot, featureId: FeatureId, condition: QueryCondition, locale: Locale):
    { readonly facts: readonly AgentFact[] } | { readonly status: AgentMissingStatus } | undefined;
  projectSource?(snapshot: DataSnapshot, sourceId: AgentSourceId, condition: QueryCondition, locale: Locale, run?: RunState):
    readonly AgentFact[] | undefined;
  navigation?(text: string, snapshot: DataSnapshot, locale: Locale): DomainDetail | null | undefined;
  handoff?(command: string, draft: Readonly<Record<string, unknown>>): DetailRef | undefined;
}

export interface DomainLookup {
  readonly kind: AgentRecordKind;
  readonly querySlot: string;
  /** A path in the wire arguments that receives the selected opaque handle. */
  readonly bind?: readonly string[];
  readonly readingBind?: readonly string[];
  readonly selected?: string;
  /** The local cursor of the page being shown (B22). The wire cursor is minted per lookup and never equals it. */
  readonly cursor?: string;
}
export interface DomainTurnInput extends AgentTurnInput {
  readonly lookups?: readonly DomainLookup[];
  /** Browser-local requested fact forwarded to the reader's search and describe inputs (B27). */
  readonly aspect?: string;
  /** For a single record read: the local cursor of the page being continued (B22). */
  readonly cursor?: string;
  readonly factKeys?: readonly string[];
  /** Applied after `factKeys`: keeps the rows the question asks for (largest, lowest, empty or one item). */
  readonly narrow?: (facts: readonly SnapshotFact[]) => readonly SnapshotFact[];
  /** For an ordered read list: the facts each read keeps, by position in `intent.reads`. */
  readonly readParts?: readonly {
    readonly factKeys?: readonly string[]; readonly narrow?: (facts: readonly SnapshotFact[]) => readonly SnapshotFact[];
    /** The read scopes and checks the answer (its widget and period), but its facts stay out of the answer text. */
    readonly context?: true;
  }[];
  /** Two typed fact keys whose values the answer compares. */
  readonly compare?: readonly [string, string];
  readonly browse?: boolean;
  readonly additionalReadings?: readonly AgentReadProjection[];
  readonly onMissing?: { readonly answer: string; readonly reason?: AgentRefusal['reason']; readonly alternative?: AgentHandoff };
}
export type DomainRoute = ImmediateDomainRoute
  | { readonly kind: 'deferred'; resolve(context: { readonly snapshot: DataSnapshot; readonly port?: RealPort;
    readonly signal: AbortSignal }): Promise<ImmediateDomainRoute> };

type ImmediateDomainRoute = DomainTurnInput
  | { readonly kind: 'local-proposal'; readonly command: AgentKnownCommand; readonly args: AgentWireArgs; readonly slots: LocalSlots;
    readonly targets: RecordTargets; readonly alternative?: AgentHandoff }
  | {
    readonly kind: 'clarification'; readonly field: string; readonly answer: string;
    // D-325 historical confirmation uses a choice pressed on the card.
    readonly choices?: readonly { readonly id: string; readonly label: string }[];
    resume?(value: string, run?: RunState): DomainRoute | undefined;
  }
  | { readonly kind: 'refusal'; readonly reason: AgentRefusal['reason']; readonly answer?: string; readonly alternative?: AgentHandoff }
  | { readonly kind: 'answer'; readonly answer: string; readonly cancelPending?: true; readonly destination?: AgentHandoff;
    readonly readScope?: { readonly featureId: FeatureId; readonly condition: QueryCondition } };
export interface DomainDetail {
  readonly args: AgentWireArgs;
  readonly target?: ResolvedRecord;
  readonly querySlot?: string;
}

export const registeredDomains: readonly DomainAdapter[] = [
  menuDomain,
  suppliersDomain,
  withExpiryStock(inventoryDomain), // D-326 expiry eligibility on the stock lookup
  customDomain, // N13
  withCustomPickup(bookingDomain), // N13 pickup scope on the reservation reader
  calendarStaffDomain, // N10
  moneyDomain, // N11
  promotionDomain, // N18, ahead of N14, N12 and N16: its promo-window, customer-group and reach-out phrases would otherwise be read as manual, member or coupon text
  manualsGrantsDomain, // N14
  membersDomain, // N12
  noticesDomain, // N15
  couponsDomain, // N16
  repliesDomain, // N17
  localDomain, // N20
  operationsDomain, // N19
  settingsDomain,
  layoutDomain,
  multiDomain, // N21
];

export function createDomainRegistry(adapters: readonly DomainAdapter[]) {
  const commands = new Map<string, CommandAdapter>();
  const runCommands = new Map<string, RunCommandAdapter>();
  const reads = new Map<AgentRecordKind, RecordAdapter>();
  const tools = new Map<AgentExtraReadTool, ReadToolAdapter>();
  for (const domain of adapters) {
    for (const adapter of domain.commands) {
      if (agentCommandPolicy(adapter.command)?.policy !== 'propose') throw new Error(`Unavailable Navis command: ${adapter.command}`);
      if (commands.has(adapter.command) || runCommands.has(adapter.command)) throw new Error(`Duplicate Navis command: ${adapter.command}`);
      commands.set(adapter.command, adapter);
    }
    for (const adapter of domain.runCommands ?? []) {
      if (AGENT_COMMAND_CATALOG[adapter.command]?.policy !== 'propose') throw new Error(`Unavailable Navis command: ${adapter.command}`);
      if (commands.has(adapter.command) || runCommands.has(adapter.command)) throw new Error(`Duplicate Navis command: ${adapter.command}`);
      runCommands.set(adapter.command, adapter);
    }
    for (const adapter of domain.reads) {
      if (reads.has(adapter.kind)) throw new Error(`Duplicate Navis reader: ${adapter.kind}`);
      reads.set(adapter.kind, adapter);
    }
    for (const adapter of domain.tools ?? []) {
      if (tools.has(adapter.tool)) throw new Error(`Duplicate Navis read tool: ${adapter.tool}`);
      tools.set(adapter.tool, adapter);
    }
  }
  function first<T>(select: (adapter: DomainAdapter) => T | undefined) {
    for (const adapter of adapters) {
      const selected = select(adapter);
      if (selected !== undefined) return selected;
    }
    return undefined;
  }
  const features = (domain: DomainAdapter) => domain.featureIds ?? domain.commands.map(adapter => adapter.featureId);
  // N21 compound classification runs separately from single-turn routing.
  const classifyMulti: typeof classifyMultiRequest = (scope, text, select) =>
    first(domain => domain.classifyMulti?.(scope, text, select));
  const sourceUnavailable: (source: AgentSourceId) => boolean = () => false;
  return {
    classifyMulti,
    command: (command: string) => commands.get(command),
    runCommand: (command: string) => runCommands.get(command),
    reader: (kind: AgentRecordKind) => reads.get(kind),
    tool: (tool: AgentExtraReadTool) => tools.get(tool),
    readFeatures: (tool: AgentExtraReadTool | undefined, kind: AgentRecordKind | undefined) =>
      first(domain => domain.tools?.some(adapter => adapter.tool === tool) || domain.reads.some(adapter => adapter.kind === kind)
        ? features(domain) : undefined) ?? [],
    routeBeforeHandoff: (text: string, snapshot: DataSnapshot, locale: Locale, run?: RunState) =>
      first(domain => domain.routeBeforeHandoff?.(text, snapshot, locale, run)),
    route(text: string, snapshot: DataSnapshot, locale: Locale, feature?: FeatureId | null, run?: RunState) {
      const preferred = feature ? adapters.find(domain => features(domain).includes(feature)) : undefined;
      return first(domain => domain.routePresentation?.(text, snapshot, locale, run)) ??
        preferred?.route?.(text, snapshot, locale, run) ??
        first(domain => domain === preferred ? undefined : domain.route?.(text, snapshot, locale, run));
    },
    projectWidget: (snapshot: DataSnapshot, featureId: FeatureId, condition: QueryCondition, locale: Locale) =>
      first(domain => domain.projectWidget?.(snapshot, featureId, condition, locale)),
    projectSource: (snapshot: DataSnapshot, sourceId: AgentSourceId, condition: QueryCondition, locale: Locale, run?: RunState) =>
      first(domain => domain.projectSource?.(snapshot, sourceId, condition, locale, run)),
    sourceUnavailable,
    navigation: (text: string, snapshot: DataSnapshot, locale: Locale) => first(domain => domain.navigation?.(text, snapshot, locale)),
    handoff: (command: string, draft: Readonly<Record<string, unknown>>) => first(domain => domain.handoff?.(command, draft)),
  };
}

export type DomainRegistry = ReturnType<typeof createDomainRegistry>;
