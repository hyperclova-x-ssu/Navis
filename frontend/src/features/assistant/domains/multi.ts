import { validateAgentMultiPlan, type AgentIntent, type AgentMultiIntent, type AgentMultiPlan } from '../../../../shared/navis-agent-schema.mjs';
import type { DomainAdapter } from './registry';

type PlanScope = Pick<AgentMultiPlan, 'planId' | 'runId'>;
export interface MultiStepSelection<Local> {
  readonly intent: AgentIntent;
  readonly local: Local;
  /** Zero-based indices of earlier clauses the step needs to succeed. */
  readonly dependsOn?: readonly number[];
}
export interface LocalMultiPlan<Local> {
  readonly plan: AgentMultiPlan;
  readonly localByStep: ReadonlyMap<string, Local>;
}
type ClauseSelection<Local> = ({ readonly kind: 'step' } & MultiStepSelection<Local>)
  | { readonly kind: 'clarification' | 'refusal'; readonly reason: string; readonly field?: string };
type Classification<Local> =
  | { readonly kind: 'plan'; readonly value: LocalMultiPlan<Local> }
  | { readonly kind: 'clarification' | 'refusal'; readonly reason: string; readonly clause?: string; readonly field?: string };

const stepId = (index: number) => `step-${index + 1}`;

function selector(intent: AgentIntent): AgentMultiIntent | undefined {
  switch (intent.kind) {
    case 'read': return intent;
    case 'command': return { kind: 'command', command: intent.command };
    case 'menu.create': return { kind: 'command', command: 'menu.create' };
    case 'conversation': return undefined;
  }
}

export function planMultiRequest<Local>(scope: PlanScope, selections: readonly MultiStepSelection<Local>[]): LocalMultiPlan<Local> | undefined {
  const steps: AgentMultiPlan['steps'][number][] = [];
  const localByStep = new Map<string, Local>();
  for (const [index, selection] of selections.entries()) {
    const intent = selector(selection.intent);
    const { dependsOn } = selection;
    if (!intent || dependsOn?.some(parent => !Number.isInteger(parent) || parent < 0 || parent >= index)) return undefined;
    const id = stepId(index);
    steps.push({ id, intent, ...(dependsOn?.length ? { dependsOn: dependsOn.map(stepId) } : {}) });
    localByStep.set(id, selection.local);
  }

  const plan = { planId: scope.planId, runId: scope.runId, steps };
  if (!validateAgentMultiPlan(plan)) return undefined;
  return { plan: structuredClone(plan), localByStep };
}

const connective = new Map([
  ['알려주고', '알려줘'], ['보여주고', '보여줘'], ['바꾸고', '바꿔줘'], ['맞추고', '맞춰줘'],
  ['추가하고', '추가해줘'], ['처리하고', '처리해줘'], ['넣고', '넣어줘'], ['빼고', '빼줘'],
  ['보내고', '보내줘'], ['발송하고', '발송해줘'], ['열고', '열어줘'], ['로 하고', '로 해줘'],
]);

const quotedText = /"(?:\\.|[^"\\])*(?:"|$)|(?<![\p{L}\p{N}])'(?:\\.|[^'\\])*(?:'|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)/gu;
const delimiters = new RegExp(
  String.raw`(?<quote>${quotedText.source})|(?:^|(?<=\s))그리고(?=\s)|\band then\b|[;\n]+|,(?=\s)|(?<join>${[...connective.keys()].join('|')})(?=\s)|(?<list>이?랑)(?=\s)`,
  'giu',
);

function clausesOf(text: string, separateReadList: boolean): string[] {
  // A thousands separator has no following whitespace.
  const clauses: string[] = [];
  let start = 0;
  for (const match of text.matchAll(delimiters)) {
    const delimiter = match[0];
    if (match.groups?.quote || match.groups?.list && !separateReadList) continue;
    const ending = match.groups?.join ? connective.get(delimiter) ?? '' : '';
    const clause = (text.slice(start, match.index) + ending).trim();
    if (clause) clauses.push(clause);
    start = match.index + delimiter.length;
  }
  const last = text.slice(start).trim();
  if (last) clauses.push(last);
  return clauses;
}

const bulkMenuEdit = /(?:모든\s*메뉴|메뉴\s*(?:가격\s*)?(?:전부|모두|싹\s*다)).*(?:올려|내려|인상|인하|바꿔|수정|삭제|지워)/u;
const reverseStatus = /품절(?:\s*로|\s*처리)?\s*(?:로\s*)?(?:바꾸고|하고|했다가|처리하고)\s*(?:그리고\s*)?(?:(?:바로\s*)?취소|다시\s*판매)/u;

/** Classify selectors and local recipes only. The runner resolves a recipe when its step becomes active. */
export function classifyMultiRequest<Local>(
  scope: PlanScope,
  text: string,
  select: (clause: string, index: number, clauses: readonly string[]) => ClauseSelection<Local> | undefined,
): Classification<Local> | undefined {
  const policyText = text.replace(quotedText, ' ');
  if (bulkMenuEdit.test(policyText)) return { kind: 'refusal', reason: 'bulk_menu_edit' };
  if (reverseStatus.test(policyText)) return { kind: 'clarification', reason: 'contradictory_status', field: 'status' };
  const clauses = clausesOf(text, /(?:같이|한꺼번에|모두|전부|다)\s*(?:알려|보여)/u.test(policyText));
  if (clauses.length < 2) return undefined;
  if (clauses.length > 12) return { kind: 'refusal', reason: 'invalid_plan' };

  const selections: MultiStepSelection<Local>[] = [];
  for (const [index, clause] of clauses.entries()) {
    const selected = select(clause, index, clauses);
    if (!selected) return { kind: 'clarification', reason: 'unresolved_clause', clause };
    if (selected.kind !== 'step') return { ...selected, clause };
    selections.push(selected);
  }

  const value = planMultiRequest(scope, selections);
  return value ? { kind: 'plan', value } : { kind: 'refusal', reason: 'invalid_plan' };
}

export const multiDomain = {
  commands: [],
  reads: [],
  classifyMulti: classifyMultiRequest,
} satisfies DomainAdapter;
