import type { CellSpan, DashboardLayerId, FeatureId, Locale, QueryCondition } from '../../contracts';
import type { WidgetView } from '../../data/widget-data';
import type { AgentExtraReadTool, AgentFrameData, AgentNavigationAction, AgentReadArgs, AgentReadProjection, AgentRecordKind, AgentRequest, AgentSearchProjection } from '../../../shared/navis-agent-schema.mjs';
import type { ProposalSession } from './navis-conversation';
import type { AgentActionProposal, LocalAgentProposal } from './agent-actions';
import type { LocalSlots, SlotValue } from './domains/registry';
import type { AgentReadEvidence } from './snapshot';

export interface CandidateSize { readonly width: CellSpan; readonly height: CellSpan }
/** `placement` says whether the widget lives in the layer the user is looking at (API-10 v4). */
export interface Candidate { readonly featureId: FeatureId; readonly condition: QueryCondition; readonly size: CandidateSize; readonly reason: string; readonly preview: WidgetView<unknown>; readonly placement: 'current-layer' | 'other-layer' }
export type ReplyStatus = 'stopped';
/** Compatibility with the dashboard's price controls. */
export type AgentClarification = {
  readonly field: 'price';
  readonly promptKey: 'menu.price';
  readonly choices: readonly ({ readonly id: 'manual' } | { readonly id: string; readonly value: number })[];
  readonly id: string;
  isCurrent(): boolean;
};
export type AgentContinuation = { readonly clarificationId: string } & (
  | { readonly price: number }
  | { readonly choiceId: string }
  | { readonly value: SlotValue }
);
export interface AgentSuggestion {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

export interface AgentHandoff {
  readonly featureId: string;
  readonly command?: string;
  readonly draft?: Readonly<Record<string, unknown>>;
}

export type AgentTurn =
  | { readonly kind: 'clarification' | 'ambiguity'; readonly id: string; readonly field: string; readonly choices: readonly AgentSuggestion[]; isCurrent(): boolean }
  | { readonly kind: 'refusal'; readonly reason: string; readonly alternative?: AgentHandoff }
  | { readonly kind: 'handoff'; readonly destination: AgentHandoff }
  | { readonly kind: 'proposal'; readonly proposal: LocalAgentProposal }
  | { readonly kind: 'read'; readonly evidence: readonly AgentReadEvidence[] };

/** Local, authorized intent and private values supplied by a client adapter. */
export interface AgentTurnInput {
  readonly intent: AgentRequest['intent'];
  readonly slots?: LocalSlots;
  readonly page?: number;
  readonly navigationReadings?: readonly AgentReadProjection[];
  readonly navigationSearches?: readonly AgentSearchProjection[];
  readonly lookup?: { readonly kind: AgentRecordKind; readonly querySlot: string };
  readonly reading?: { [Tool in AgentExtraReadTool]: { readonly tool: Tool; readonly args: AgentReadArgs[Tool] } }[AgentExtraReadTool];
}
/** `locale` is the language the bubble was written in; it never changes afterwards (AC-224). */
export interface AssistantReply {
  readonly answer: string;
  readonly panels: readonly Candidate[];
  readonly mode?: 'simple';
  readonly outOfScope?: boolean;
  readonly status?: ReplyStatus;
  readonly examples?: readonly string[];
  readonly locale?: Locale;
  readonly protocol?: 'agent-v1';
  readonly clarification?: AgentClarification;
  readonly proposal?: AgentActionProposal;
  readonly proposalSession?: ProposalSession;
  readonly localAction?: AgentFrameData['action_result'];
  readonly turn?: AgentTurn;
}
export interface HistoryItem { readonly role: 'user' | 'assistant'; readonly text: string }
export interface AskInput {
  readonly history?: readonly HistoryItem[];
  readonly text: string;
  readonly signal: AbortSignal;
  readonly locale?: Locale;
  readonly layer?: DashboardLayerId;
  readonly onTextDelta?: (delta: string) => void;
  readonly simpleSignal?: AbortSignal;
  readonly continuation?: AgentContinuation;
  readonly agentTurn?: AgentTurnInput;
  readonly onNavigation?: (action: AgentNavigationAction) => void;
  readonly onStatus?: (frame: AgentFrameData['status']) => void;
}
export interface AssistantProvider {
  ask(input: AskInput): Promise<AssistantReply>;
  /** Invalidates the pending write turn on close, layer change or run replacement. */
  discardAgentTurn?(): void;
}
